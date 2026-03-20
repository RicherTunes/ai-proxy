/**
 * TDD tests for DecisionRecorder and KeyScheduler health-scoring internals.
 *
 * Covers:
 *   DecisionRecorder  — record, getRecentDecisions, recordOpportunity,
 *                        getReasonDistribution, getWhyNotStats,
 *                        getFairnessMetrics, Gini, max-history cap,
 *                        empty-log edge cases
 *   KeyScheduler (HealthScorer behaviour)
 *                     — _calculateHealthScore, _updateCachedScores,
 *                        _setPoolState transitions, score normalisation,
 *                        score with no data
 */

'use strict';

const {
    KeyScheduler,
    SelectionContext,
    DecisionRecorder,
    ReasonCodes,
    PoolState
} = require('../lib/key-scheduler');
const { CircuitBreaker, STATES } = require('../lib/circuit-breaker');
const { RingBuffer } = require('../lib/ring-buffer');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const _trackedBreakers = [];
const _trackedSchedulers = [];

afterEach(() => {
    _trackedBreakers.forEach(cb => cb.destroy());
    _trackedBreakers.length = 0;
    _trackedSchedulers.forEach(s => s.destroy());
    _trackedSchedulers.length = 0;
});

function createMockKey(index, overrides = {}) {
    const circuitBreaker = new CircuitBreaker();
    _trackedBreakers.push(circuitBreaker);
    return {
        index,
        key: `key${index}.secret`,
        keyId: `key${index}`,
        keyPrefix: `key${index}`.substring(0, 8),
        inFlight: 0,
        totalRequests: 0,
        successCount: 0,
        rateLimitedCount: 0,
        rateLimitedAt: null,
        rateLimitCooldownMs: 1000,
        latencies: new RingBuffer(100),
        lastUsed: null,
        lastSuccess: null,
        circuitBreaker,
        ...overrides
    };
}

function makeContext(overrides = {}) {
    const ctx = new SelectionContext();
    Object.assign(ctx, overrides);
    return ctx;
}

function createScheduler(opts = {}) {
    const s = new KeyScheduler(opts);
    _trackedSchedulers.push(s);
    return s;
}

// ===========================================================================
// DecisionRecorder
// ===========================================================================

describe('DecisionRecorder', () => {
    // -----------------------------------------------------------------------
    // 1. record() — stores decision with timestamp, reason, keyId
    // -----------------------------------------------------------------------
    test('record() stores decision with timestamp, reason, and keyId', () => {
        const recorder = new DecisionRecorder();
        const ctx = makeContext({
            selectedKeyIndex: 0,
            selectedKeyId: 'key0',
            reason: ReasonCodes.HEALTH_SCORE_WINNER,
            excludedKeys: []
        });

        recorder.record(ctx);

        const recent = recorder.getRecentDecisions(10);
        expect(recent).toHaveLength(1);
        expect(recent[0]).toMatchObject({
            selectedKeyId: 'key0',
            reason: ReasonCodes.HEALTH_SCORE_WINNER
        });
        expect(typeof recent[0].ts).toBe('number');
    });

    // -----------------------------------------------------------------------
    // 2. getRecentDecisions() — returns decisions within count, ordered
    // -----------------------------------------------------------------------
    test('getRecentDecisions() returns most recent N decisions in order', () => {
        const recorder = new DecisionRecorder();

        for (let i = 0; i < 5; i++) {
            const ctx = makeContext({
                selectedKeyIndex: i,
                selectedKeyId: `key${i}`,
                reason: ReasonCodes.ROUND_ROBIN_TURN,
                excludedKeys: []
            });
            recorder.record(ctx);
        }

        const recent = recorder.getRecentDecisions(3);
        expect(recent).toHaveLength(3);
        // Should be the last 3 decisions (indices 2, 3, 4)
        expect(recent[0].selectedKeyId).toBe('key2');
        expect(recent[1].selectedKeyId).toBe('key3');
        expect(recent[2].selectedKeyId).toBe('key4');
    });

    // -----------------------------------------------------------------------
    // 3. recordOpportunity() — tracks opportunities
    // -----------------------------------------------------------------------
    test('recordOpportunity() increments opportunity count for key', () => {
        const recorder = new DecisionRecorder();

        recorder.recordOpportunity('key0');
        recorder.recordOpportunity('key0');
        recorder.recordOpportunity('key1');

        expect(recorder.keyOpportunityCounts.key0).toBe(2);
        expect(recorder.keyOpportunityCounts.key1).toBe(1);
    });

    // -----------------------------------------------------------------------
    // 4. getReasonDistribution() — counts decisions by reason type
    // -----------------------------------------------------------------------
    test('getReasonDistribution() returns counts and percentages per reason', () => {
        const recorder = new DecisionRecorder();

        // 3 health_score_winner, 2 round_robin_turn
        for (let i = 0; i < 3; i++) {
            recorder.record(makeContext({
                selectedKeyIndex: 0,
                selectedKeyId: 'key0',
                reason: ReasonCodes.HEALTH_SCORE_WINNER,
                excludedKeys: []
            }));
        }
        for (let i = 0; i < 2; i++) {
            recorder.record(makeContext({
                selectedKeyIndex: 1,
                selectedKeyId: 'key1',
                reason: ReasonCodes.ROUND_ROBIN_TURN,
                excludedKeys: []
            }));
        }

        const dist = recorder.getReasonDistribution();
        expect(dist[ReasonCodes.HEALTH_SCORE_WINNER].count).toBe(3);
        expect(dist[ReasonCodes.ROUND_ROBIN_TURN].count).toBe(2);
        // 3/5 = 60%
        expect(dist[ReasonCodes.HEALTH_SCORE_WINNER].percentage).toBe(60);
        // 2/5 = 40%
        expect(dist[ReasonCodes.ROUND_ROBIN_TURN].percentage).toBe(40);
    });

    // -----------------------------------------------------------------------
    // 5. getWhyNotStats() — returns why keys were skipped
    // -----------------------------------------------------------------------
    test('getWhyNotStats() records exclusion reasons per key', () => {
        const recorder = new DecisionRecorder();

        recorder.record(makeContext({
            selectedKeyIndex: 0,
            selectedKeyId: 'key0',
            reason: ReasonCodes.LAST_AVAILABLE,
            excludedKeys: [
                { keyIndex: 1, keyId: 'key1', reason: ReasonCodes.EXCLUDED_CIRCUIT_OPEN },
                { keyIndex: 2, keyId: 'key2', reason: ReasonCodes.EXCLUDED_AT_MAX_CONCURRENCY }
            ]
        }));

        recorder.record(makeContext({
            selectedKeyIndex: 0,
            selectedKeyId: 'key0',
            reason: ReasonCodes.LAST_AVAILABLE,
            excludedKeys: [
                { keyIndex: 1, keyId: 'key1', reason: ReasonCodes.EXCLUDED_CIRCUIT_OPEN },
                { keyIndex: 2, keyId: 'key2', reason: ReasonCodes.EXCLUDED_RATE_LIMITED }
            ]
        }));

        const stats = recorder.getWhyNotStats();
        expect(stats.key1[ReasonCodes.EXCLUDED_CIRCUIT_OPEN]).toBe(2);
        expect(stats.key2[ReasonCodes.EXCLUDED_AT_MAX_CONCURRENCY]).toBe(1);
        expect(stats.key2[ReasonCodes.EXCLUDED_RATE_LIMITED]).toBe(1);
    });

    // -----------------------------------------------------------------------
    // 6. getFairnessMetrics() — computes selection distribution
    // -----------------------------------------------------------------------
    test('getFairnessMetrics() computes per-key shares and fairness score', () => {
        const recorder = new DecisionRecorder();

        // key0 selected 6 times, key1 selected 4 times
        for (let i = 0; i < 6; i++) {
            recorder.record(makeContext({
                selectedKeyIndex: 0,
                selectedKeyId: 'key0',
                reason: ReasonCodes.HEALTH_SCORE_WINNER,
                excludedKeys: []
            }));
        }
        for (let i = 0; i < 4; i++) {
            recorder.record(makeContext({
                selectedKeyIndex: 1,
                selectedKeyId: 'key1',
                reason: ReasonCodes.HEALTH_SCORE_WINNER,
                excludedKeys: []
            }));
        }

        const metrics = recorder.getFairnessMetrics();
        expect(metrics.totalSelections).toBe(10);
        expect(metrics.keyCount).toBe(2);
        expect(metrics.perKey.key0.selections).toBe(6);
        expect(metrics.perKey.key1.selections).toBe(4);
        expect(metrics.perKey.key0.shareOfTotal).toBe(60);
        expect(metrics.perKey.key1.shareOfTotal).toBe(40);
        // fairnessScore should be a number, somewhat high for mild skew
        expect(typeof metrics.fairnessScore).toBe('number');
        expect(metrics.fairnessScore).toBeGreaterThan(0);
    });

    // -----------------------------------------------------------------------
    // 7. Gini = 0 (approx.) for equal distribution
    // -----------------------------------------------------------------------
    test('fairnessScore is high (near 100) for equal distribution', () => {
        const recorder = new DecisionRecorder();

        // 4 keys, each selected 25 times
        for (let k = 0; k < 4; k++) {
            for (let i = 0; i < 25; i++) {
                recorder.record(makeContext({
                    selectedKeyIndex: k,
                    selectedKeyId: `key${k}`,
                    reason: ReasonCodes.HEALTH_SCORE_WINNER,
                    excludedKeys: []
                }));
            }
        }

        const metrics = recorder.getFairnessMetrics();
        // Perfect equality → each share is exactly 25% → deviation from expected (25) is 0
        // fairnessScore = max(0, 100 - 0) = 100
        expect(metrics.fairnessScore).toBe(100);
    });

    // -----------------------------------------------------------------------
    // 8. Gini = high (low fairnessScore) for skewed distribution
    // -----------------------------------------------------------------------
    test('fairnessScore is low for highly skewed distribution', () => {
        const recorder = new DecisionRecorder();

        // key0 selected 90 times, key1 selected 10 times
        for (let i = 0; i < 90; i++) {
            recorder.record(makeContext({
                selectedKeyIndex: 0,
                selectedKeyId: 'key0',
                reason: ReasonCodes.HEALTH_SCORE_WINNER,
                excludedKeys: []
            }));
        }
        for (let i = 0; i < 10; i++) {
            recorder.record(makeContext({
                selectedKeyIndex: 1,
                selectedKeyId: 'key1',
                reason: ReasonCodes.HEALTH_SCORE_WINNER,
                excludedKeys: []
            }));
        }

        const metrics = recorder.getFairnessMetrics();
        // key0 = 90%, key1 = 10%, expected each = 50%
        // deviations: |90-50|=40, |10-50|=40, avgDeviation=40
        // fairnessScore = max(0, 100 - 40*2) = 20
        expect(metrics.fairnessScore).toBeLessThanOrEqual(30);
    });

    // -----------------------------------------------------------------------
    // 9. Max history cap — old decisions evicted
    // -----------------------------------------------------------------------
    test('old decisions are evicted when history exceeds maxDecisions', () => {
        const recorder = new DecisionRecorder({ maxDecisions: 5 });

        for (let i = 0; i < 10; i++) {
            recorder.record(makeContext({
                selectedKeyIndex: i % 2,
                selectedKeyId: `key${i % 2}`,
                reason: ReasonCodes.ROUND_ROBIN_TURN,
                excludedKeys: []
            }));
        }

        // Ring buffer should only hold last 5
        const recent = recorder.getRecentDecisions(100);
        expect(recent.length).toBeLessThanOrEqual(5);
    });

    // -----------------------------------------------------------------------
    // 10. Empty log edge cases — sensible defaults
    // -----------------------------------------------------------------------
    test('all getters return sensible defaults on empty log', () => {
        const recorder = new DecisionRecorder();

        // getRecentDecisions
        expect(recorder.getRecentDecisions()).toEqual([]);

        // getReasonDistribution — should be empty (no non-zero counts)
        const dist = recorder.getReasonDistribution();
        expect(Object.keys(dist)).toHaveLength(0);

        // getWhyNotStats — empty
        expect(recorder.getWhyNotStats()).toEqual({});

        // getFairnessMetrics
        const fairness = recorder.getFairnessMetrics();
        expect(fairness.totalSelections).toBe(0);
        expect(fairness.keyCount).toBe(0);
        expect(typeof fairness.fairnessScore).toBe('number');
    });
});

// ===========================================================================
// KeyScheduler — HealthScorer behaviour
// ===========================================================================

describe('KeyScheduler (HealthScorer)', () => {
    // -----------------------------------------------------------------------
    // 11. Score computation — healthy key with low latency gets high score
    // -----------------------------------------------------------------------
    test('healthy key with low latency gets a high score', () => {
        const scheduler = createScheduler();
        // Simulate pool avg latency
        scheduler._poolAvgLatency = 500;

        const key = createMockKey(0, {
            totalRequests: 100,
            successCount: 95,
            inFlight: 0,
            lastUsed: null
        });
        // Add latency samples (lower than pool avg)
        for (let i = 0; i < 10; i++) {
            key.latencies.push(300); // Below pool average of 500
        }

        const allKeys = [key];
        const score = scheduler._calculateHealthScore(key, allKeys);

        expect(score.total).toBeGreaterThanOrEqual(80);
        expect(score.latencyScore).toBe(40); // Full latency points (ratio 0.6 < 0.8)
        expect(score.successScore).toBeGreaterThanOrEqual(35); // 95% success rate * 40
    });

    // -----------------------------------------------------------------------
    // 12. Score with failures — key with recent failures gets lower score
    // -----------------------------------------------------------------------
    test('key with recent failures gets lower score', () => {
        const scheduler = createScheduler();
        scheduler._poolAvgLatency = 500;

        const key = createMockKey(0, {
            totalRequests: 100,
            successCount: 70,
            inFlight: 0,
            lastUsed: null
        });
        for (let i = 0; i < 10; i++) {
            key.latencies.push(400);
        }
        // Inject recent failures into the circuit breaker
        const now = Date.now();
        key.circuitBreaker.failureTimestamps = [
            now - 10000, now - 5000, now - 2000, now - 1000
        ];

        const allKeys = [key];
        const score = scheduler._calculateHealthScore(key, allKeys);

        // errorScore should be reduced: 20 - 4*5 = 0
        expect(score.errorScore).toBe(0);
        // Overall should be lower due to both success rate and error recency
        expect(score.total).toBeLessThan(80);
    });

    // -----------------------------------------------------------------------
    // 13. Score weights — changing weights affects scoring
    // -----------------------------------------------------------------------
    test('changing weight config affects scoring components', () => {
        const scheduler = createScheduler({
            healthScoreWeights: {
                latency: 10,
                successRate: 70,
                errorRecency: 20
            }
        });
        scheduler._poolAvgLatency = 500;

        const key = createMockKey(0, {
            totalRequests: 100,
            successCount: 100,
            inFlight: 0,
            lastUsed: null
        });
        for (let i = 0; i < 10; i++) {
            key.latencies.push(300);
        }

        const allKeys = [key];
        const score = scheduler._calculateHealthScore(key, allKeys);

        // latency weight is now 10 (not 40)
        expect(score.latencyScore).toBe(10);
        // success weight is now 70
        expect(score.successScore).toBe(70);
        // error recency weight is still 20
        expect(score.errorScore).toBe(20);
        // Total = 10 + 70 + 20 = 100
        expect(score.total).toBe(100);
    });

    // -----------------------------------------------------------------------
    // 14. _updateCachedScores timer fires and updates scores
    // -----------------------------------------------------------------------
    test('_updateCachedScores() populates the cache for all keys', () => {
        const scheduler = createScheduler();
        scheduler._poolAvgLatency = 500;

        const keys = [
            createMockKey(0, { totalRequests: 10, successCount: 10, inFlight: 0 }),
            createMockKey(1, { totalRequests: 10, successCount: 8, inFlight: 0 })
        ];
        for (const k of keys) {
            for (let i = 0; i < 10; i++) k.latencies.push(400);
        }

        scheduler._keysRef = keys;
        scheduler._updateCachedScores();

        // Both keys should be cached
        expect(scheduler._cachedScores.has('key0')).toBe(true);
        expect(scheduler._cachedScores.has('key1')).toBe(true);
        expect(scheduler._cachedScores.get('key0').score.total).toBeGreaterThan(0);
    });

    // -----------------------------------------------------------------------
    // 15. _setPoolState transitions tracked
    // -----------------------------------------------------------------------
    test('_setPoolState fires onPoolStateChange callback on transition', () => {
        const changeFn = jest.fn();
        const scheduler = createScheduler({ onPoolStateChange: changeFn });

        // Initial state is HEALTHY; transition to DEGRADED
        scheduler._setPoolState(PoolState.DEGRADED);
        expect(changeFn).toHaveBeenCalledWith(PoolState.HEALTHY, PoolState.DEGRADED);
        expect(scheduler._poolState).toBe(PoolState.DEGRADED);

        // Transition to CRITICAL
        scheduler._setPoolState(PoolState.CRITICAL);
        expect(changeFn).toHaveBeenCalledWith(PoolState.DEGRADED, PoolState.CRITICAL);

        // Same state — no callback
        changeFn.mockClear();
        scheduler._setPoolState(PoolState.CRITICAL);
        expect(changeFn).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // 16. Score normalization — scores between 0 and 100
    // -----------------------------------------------------------------------
    test('health scores are clamped to non-negative values', () => {
        const scheduler = createScheduler();
        scheduler._poolAvgLatency = 500;

        // Key with terrible metrics: high in-flight, slow, recent use
        const key = createMockKey(0, {
            totalRequests: 100,
            successCount: 10,  // 10% success
            inFlight: 5,       // heavy penalty: 5*15=75
            lastUsed: new Date().toISOString(),  // just used: -30
            _isSlowKey: true,
            _isQuarantined: true
        });
        for (let i = 0; i < 10; i++) {
            key.latencies.push(2000); // Very slow
        }
        // Many recent failures
        const now = Date.now();
        key.circuitBreaker.failureTimestamps = [
            now - 1000, now - 2000, now - 3000, now - 4000, now - 5000
        ];

        const allKeys = [key];
        const score = scheduler._calculateHealthScore(key, allKeys);

        // Total should be at minimum 0 (never negative) due to Math.max(0, ...)
        expect(score.total).toBeGreaterThanOrEqual(0);
    });

    // -----------------------------------------------------------------------
    // 17. Score with no data — new key gets default score
    // -----------------------------------------------------------------------
    test('new key with no history gets default (high) score', () => {
        const scheduler = createScheduler();
        // No pool latency data
        scheduler._poolAvgLatency = 0;

        const key = createMockKey(0, {
            totalRequests: 0,
            successCount: 0,
            inFlight: 0,
            lastUsed: null
        });
        // No latency samples

        const allKeys = [key];
        const score = scheduler._calculateHealthScore(key, allKeys);

        // With no data:
        //   latencyScore = full weight (40) because stats.count < 5
        //   successRate = 1.0 (default) → successScore = 40
        //   errorScore = 20 (no failures)
        //   recencyPenalty = 0 (never used)
        //   inFlightPenalty = 0
        // Total = 40 + 40 + 20 = 100
        expect(score.total).toBe(100);
        expect(score.latencyScore).toBe(40);
        expect(score.successScore).toBe(40);
        expect(score.errorScore).toBe(20);
    });

    // -----------------------------------------------------------------------
    // Bonus: startScoreUpdater / getCachedScore integration
    // -----------------------------------------------------------------------
    test('startScoreUpdater populates cache and getCachedScore returns it', () => {
        const scheduler = createScheduler({ scoreCacheTTL: 5000 });
        scheduler._poolAvgLatency = 500;

        const keys = [
            createMockKey(0, { totalRequests: 50, successCount: 50, inFlight: 0 })
        ];
        for (let i = 0; i < 10; i++) keys[0].latencies.push(400);

        scheduler.startScoreUpdater(keys);

        // Cache should be populated immediately
        const cached = scheduler.getCachedScore(keys[0], keys);
        expect(cached.total).toBeGreaterThan(0);

        // Cleanup interval
        scheduler.destroy();
    });

    // -----------------------------------------------------------------------
    // Bonus: pool state via updatePoolMetrics
    // -----------------------------------------------------------------------
    test('updatePoolMetrics sets pool state to CRITICAL when no keys available', () => {
        const changeFn = jest.fn();
        const scheduler = createScheduler({ onPoolStateChange: changeFn });

        // All keys have open circuit breakers
        const keys = [createMockKey(0), createMockKey(1)];
        keys[0].circuitBreaker.forceState(STATES.OPEN);
        keys[1].circuitBreaker.forceState(STATES.OPEN);

        scheduler.updatePoolMetrics(keys);

        expect(scheduler._poolState).toBe(PoolState.CRITICAL);
    });
});
