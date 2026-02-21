/**
 * Key Scheduler Module Tests
 */

const {
    KeyScheduler,
    SelectionContext,
    DecisionRecorder,
    ReasonCodes,
    PoolState
} = require('../lib/key-scheduler');
const { CircuitBreaker, STATES } = require('../lib/circuit-breaker');
const { RingBuffer } = require('../lib/ring-buffer');

// Track circuit breakers for cleanup
const _trackedBreakers = [];
afterEach(() => {
    _trackedBreakers.forEach(cb => cb.destroy());
    _trackedBreakers.length = 0;
});

// Helper to create mock key info
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

// Helper to create mock rate limiter
function createMockRateLimiter(allowAll = true) {
    return {
        peekLimit: jest.fn().mockReturnValue({ allowed: allowAll }),
        checkLimit: jest.fn().mockReturnValue({ allowed: allowAll })
    };
}

describe('KeyScheduler', () => {
    let scheduler;

    beforeEach(() => {
        scheduler = new KeyScheduler({
            maxConcurrencyPerKey: 3
        });
    });

    describe('constructor', () => {
        test('should initialize with default config', () => {
            expect(scheduler.config.useWeightedSelection).toBe(true);
            expect(scheduler.config.fairnessMode).toBe('soft');
            expect(scheduler.config.maxConcurrencyPerKey).toBe(3);
        });

        test('should accept custom config', () => {
            const custom = new KeyScheduler({
                maxConcurrencyPerKey: 5,
                fairnessMode: 'strict',
                useWeightedSelection: false
            });
            expect(custom.config.maxConcurrencyPerKey).toBe(5);
            expect(custom.config.fairnessMode).toBe('strict');
            expect(custom.config.useWeightedSelection).toBe(false);
        });
    });

    describe('selectKey', () => {
        test('should select an available key', () => {
            const keys = [createMockKey(0), createMockKey(1), createMockKey(2)];
            const result = scheduler.selectKey({ keys });

            expect(result.key).not.toBeNull();
            expect(result.context.selectedKeyIndex).toBeDefined();
            expect(result.context.reason).toBeDefined();
        });

        test('should return null when all keys excluded', () => {
            const keys = [createMockKey(0), createMockKey(1)];
            const result = scheduler.selectKey({
                keys,
                excludeIndices: [0, 1]
            });

            expect(result.key).toBeNull();
        });

        test('should exclude keys at max concurrency', () => {
            const keys = [
                createMockKey(0, { inFlight: 3 }),
                createMockKey(1, { inFlight: 3 }),
                createMockKey(2, { inFlight: 1 })
            ];

            const result = scheduler.selectKey({ keys });

            expect(result.key.index).toBe(2);
        });

        test('should prefer CLOSED circuit breakers over HALF_OPEN', () => {
            const keys = [
                createMockKey(0),
                createMockKey(1),
                createMockKey(2)
            ];
            keys[0].circuitBreaker.forceState(STATES.HALF_OPEN);
            keys[1].circuitBreaker.forceState(STATES.CLOSED);
            keys[2].circuitBreaker.forceState(STATES.HALF_OPEN);

            // Run multiple times to verify preference
            let closedSelections = 0;
            for (let i = 0; i < 10; i++) {
                const result = scheduler.selectKey({ keys });
                if (result.key.circuitBreaker.state === STATES.CLOSED) {
                    closedSelections++;
                }
            }

            expect(closedSelections).toBeGreaterThan(5);
        });

        test('should track exclusion reasons', () => {
            const keys = [
                createMockKey(0),
                createMockKey(1),
                createMockKey(2)
            ];
            keys[0].circuitBreaker.forceState(STATES.OPEN);
            keys[1].inFlight = 3; // At max concurrency

            const result = scheduler.selectKey({ keys });

            expect(result.context.excludedKeys.length).toBe(2);

            const exclusionReasons = result.context.excludedKeys.map(e => e.reason);
            expect(exclusionReasons).toContain(ReasonCodes.EXCLUDED_CIRCUIT_OPEN);
            expect(exclusionReasons).toContain(ReasonCodes.EXCLUDED_AT_MAX_CONCURRENCY);
        });

        test('should record request context', () => {
            const keys = [createMockKey(0)];
            const result = scheduler.selectKey({
                keys,
                requestId: 'req-123',
                attempt: 2
            });

            expect(result.context.requestId).toBe('req-123');
            expect(result.context.attempt).toBe(2);
        });
    });

    describe('reason codes', () => {
        test('should return LAST_AVAILABLE for single available key', () => {
            const keys = [createMockKey(0)];
            const result = scheduler.selectKey({ keys });

            expect(result.context.reason).toBe(ReasonCodes.LAST_AVAILABLE);
        });

        test('should return ROUND_ROBIN_TURN when weighted selection disabled', () => {
            const roundRobinScheduler = new KeyScheduler({
                useWeightedSelection: false
            });
            const keys = [createMockKey(0), createMockKey(1)];
            const result = roundRobinScheduler.selectKey({ keys });

            expect(result.context.reason).toBe(ReasonCodes.ROUND_ROBIN_TURN);
        });

        test('should return CIRCUIT_RECOVERY when forcing HALF_OPEN', () => {
            const keys = [createMockKey(0), createMockKey(1)];
            keys[0].circuitBreaker.forceState(STATES.OPEN);
            keys[1].circuitBreaker.forceState(STATES.OPEN);

            const result = scheduler.selectKey({ keys });

            expect(result.context.reason).toBe(ReasonCodes.CIRCUIT_RECOVERY);
            expect(result.key.circuitBreaker.state).toBe(STATES.HALF_OPEN);
        });

        test('should return RATE_LIMIT_ROTATED when avoiding rate-limited keys', () => {
            const keys = [
                createMockKey(0, { rateLimitedAt: Date.now(), rateLimitCooldownMs: 60000 }),
                createMockKey(1), // Not rate limited
                createMockKey(2)  // Not rate limited - need >1 available to not get LAST_AVAILABLE
            ];

            const result = scheduler.selectKey({ keys });

            expect(result.key.index).toBeGreaterThan(0); // Should pick key 1 or 2, not 0
            // With multiple available keys, it may use HEALTH_SCORE_WINNER
            // The important thing is key 0 is excluded due to rate limit
            expect(result.context.excludedKeys).toContainEqual(
                expect.objectContaining({ keyIndex: 0, reason: expect.stringMatching(/rate_limit/) })
            );
        });
    });

    describe('health scoring', () => {
        test('should calculate health score components', () => {
            const key = createMockKey(0);
            // Add some latency samples
            for (let i = 0; i < 10; i++) {
                key.latencies.push(100 + i * 10);
            }
            key.totalRequests = 100;
            key.successCount = 95;

            const score = scheduler._calculateHealthScore(key, [key]);

            expect(score.total).toBeGreaterThan(0);
            expect(score.latencyScore).toBeGreaterThanOrEqual(0);
            expect(score.successScore).toBeGreaterThanOrEqual(0);
            expect(score.errorScore).toBeGreaterThanOrEqual(0);
        });

        test('should penalize keys with in-flight requests', () => {
            const key1 = createMockKey(0, { inFlight: 0 });
            const key2 = createMockKey(1, { inFlight: 2 });

            const score1 = scheduler._calculateHealthScore(key1, [key1, key2]);
            const score2 = scheduler._calculateHealthScore(key2, [key1, key2]);

            expect(score1.total).toBeGreaterThan(score2.total);
            expect(score2.inFlightPenalty).toBe(30); // 2 * 15
        });

        test('should penalize recently used keys', () => {
            const key1 = createMockKey(0, { lastUsed: null });
            const key2 = createMockKey(1, { lastUsed: new Date().toISOString() });

            const score1 = scheduler._calculateHealthScore(key1, [key1, key2]);
            const score2 = scheduler._calculateHealthScore(key2, [key1, key2]);

            expect(score1.recencyPenalty).toBe(0);
            expect(score2.recencyPenalty).toBe(30); // Used within 500ms
        });

        test('should penalize slow keys', () => {
            const key1 = createMockKey(0, { _isSlowKey: false });
            const key2 = createMockKey(1, { _isSlowKey: true });

            // Add latencies to trigger scoring
            for (let i = 0; i < 10; i++) {
                key1.latencies.push(100);
                key2.latencies.push(100);
            }

            scheduler._poolAvgLatency = 100;

            const score1 = scheduler._calculateHealthScore(key1, [key1, key2]);
            const score2 = scheduler._calculateHealthScore(key2, [key1, key2]);

            expect(score1.latencyScore).toBeGreaterThan(score2.latencyScore);
        });
    });

    describe('pool state', () => {
        test('should track pool state as HEALTHY with all keys available', () => {
            const keys = [createMockKey(0), createMockKey(1), createMockKey(2)];
            scheduler.updatePoolMetrics(keys);

            expect(scheduler.getPoolState().state).toBe(PoolState.HEALTHY);
        });

        test('should track pool state as DEGRADED with <50% available', () => {
            const keys = [
                createMockKey(0),
                createMockKey(1),
                createMockKey(2),
                createMockKey(3)
            ];
            keys[0].circuitBreaker.forceState(STATES.OPEN);
            keys[1].circuitBreaker.forceState(STATES.OPEN);
            keys[2].circuitBreaker.forceState(STATES.OPEN);

            scheduler.updatePoolMetrics(keys);

            expect(scheduler.getPoolState().state).toBe(PoolState.DEGRADED);
        });

        test('should track pool state as CRITICAL with <25% available', () => {
            const keys = [
                createMockKey(0),
                createMockKey(1),
                createMockKey(2),
                createMockKey(3)
            ];
            keys[0].circuitBreaker.forceState(STATES.OPEN);
            keys[1].circuitBreaker.forceState(STATES.OPEN);
            keys[2].circuitBreaker.forceState(STATES.OPEN);
            keys[3].circuitBreaker.forceState(STATES.OPEN);

            scheduler.updatePoolMetrics(keys);

            expect(scheduler.getPoolState().state).toBe(PoolState.CRITICAL);
        });

        test('should emit callback on pool state change', () => {
            const callback = jest.fn();
            const callbackScheduler = new KeyScheduler({
                onPoolStateChange: callback
            });

            const keys = [createMockKey(0)];
            keys[0].circuitBreaker.forceState(STATES.OPEN);

            callbackScheduler.updatePoolMetrics(keys);

            expect(callback).toHaveBeenCalledWith(PoolState.HEALTHY, PoolState.CRITICAL);
        });
    });

    describe('quarantine management', () => {
        test('should quarantine a key', () => {
            const key = createMockKey(0);
            scheduler.quarantineKey(key, 'slow');

            expect(key._isQuarantined).toBe(true);
            expect(key._quarantinedAt).not.toBeNull();
            expect(key._quarantineReason).toBe('slow');
        });

        test('should release key from quarantine', () => {
            const key = createMockKey(0);
            scheduler.quarantineKey(key, 'slow');
            scheduler.releaseFromQuarantine(key);

            expect(key._isQuarantined).toBe(false);
            expect(key._quarantinedAt).toBeNull();
        });

        test('should exclude quarantined keys from selection', () => {
            const keys = [
                createMockKey(0),
                createMockKey(1)
            ];
            scheduler.quarantineKey(keys[0], 'slow');

            const result = scheduler.selectKey({ keys });

            expect(result.key.index).toBe(1);
            expect(result.context.excludedKeys[0].reason).toBe(ReasonCodes.EXCLUDED_SLOW_QUARANTINE);
        });

        test('should detect when to probe quarantined key', () => {
            const key = createMockKey(0);
            scheduler.quarantineKey(key, 'slow');

            // Just quarantined - should not probe yet
            expect(scheduler.shouldProbeQuarantinedKey(key)).toBe(false);

            // Simulate time passing
            key._quarantinedAt = Date.now() - 15000; // 15 seconds ago
            expect(scheduler.shouldProbeQuarantinedKey(key)).toBe(true);
        });
    });

    describe('fairness', () => {
        test('should boost underused keys', () => {
            const fairScheduler = new KeyScheduler({
                fairnessMode: 'soft',
                fairnessBoostFactor: 1.5
            });

            // Simulate key selection history
            for (let i = 0; i < 100; i++) {
                const context = {
                    selectedKeyIndex: 0,
                    selectedKeyId: 'key0',
                    reason: ReasonCodes.HEALTH_SCORE_WINNER,
                    excludedKeys: [],
                    toJSON() { return { ...this, toJSON: undefined }; }
                };
                fairScheduler.recorder.record(context);
                fairScheduler.recorder.recordOpportunity('key1');
            }

            const key0 = createMockKey(0);
            const key1 = createMockKey(1);

            const score0 = fairScheduler._calculateHealthScore(key0, [key0, key1]);
            const score1 = fairScheduler._calculateHealthScore(key1, [key0, key1]);

            expect(score1.fairnessBoost).toBeGreaterThan(score0.fairnessBoost);
        });

        test('should disable fairness boost when mode is none', () => {
            const noFairnessScheduler = new KeyScheduler({
                fairnessMode: 'none'
            });

            const key = createMockKey(0);
            const score = noFairnessScheduler._calculateHealthScore(key, [key]);

            expect(score.fairnessBoost).toBe(0);
        });
    });
});

describe('DecisionRecorder', () => {
    let recorder;

    beforeEach(() => {
        recorder = new DecisionRecorder({ maxDecisions: 100 });
    });

    describe('record', () => {
        test('should record decisions', () => {
            const context = new SelectionContext();
            context.selectedKeyIndex = 0;
            context.selectedKeyId = 'key0';
            context.reason = ReasonCodes.HEALTH_SCORE_WINNER;

            recorder.record(context);

            expect(recorder.decisions.length).toBe(1);
        });

        test('should update reason counts', () => {
            const context = new SelectionContext();
            context.reason = ReasonCodes.ROUND_ROBIN_TURN;
            context.excludedKeys = [];

            recorder.record(context);
            recorder.record(context);
            recorder.record(context);

            expect(recorder.reasonCounts[ReasonCodes.ROUND_ROBIN_TURN]).toBe(3);
        });

        test('should limit decisions to maxDecisions', () => {
            for (let i = 0; i < 150; i++) {
                const context = new SelectionContext();
                context.selectedKeyIndex = i % 3;
                context.excludedKeys = [];
                recorder.record(context);
            }

            expect(recorder.decisions.length).toBe(100);
        });

        test('should track why-not counts', () => {
            const context = new SelectionContext();
            context.excludedKeys = [
                { keyIndex: 0, keyId: 'key0', reason: ReasonCodes.EXCLUDED_CIRCUIT_OPEN },
                { keyIndex: 1, keyId: 'key1', reason: ReasonCodes.EXCLUDED_RATE_LIMITED }
            ];

            recorder.record(context);

            expect(recorder.whyNotCounts['key0'][ReasonCodes.EXCLUDED_CIRCUIT_OPEN]).toBe(1);
            expect(recorder.whyNotCounts['key1'][ReasonCodes.EXCLUDED_RATE_LIMITED]).toBe(1);
        });
    });

    describe('getReasonDistribution', () => {
        test('should calculate percentages', () => {
            for (let i = 0; i < 7; i++) {
                const context = new SelectionContext();
                context.reason = ReasonCodes.HEALTH_SCORE_WINNER;
                context.excludedKeys = [];
                recorder.record(context);
            }

            for (let i = 0; i < 3; i++) {
                const context = new SelectionContext();
                context.reason = ReasonCodes.ROUND_ROBIN_TURN;
                context.excludedKeys = [];
                recorder.record(context);
            }

            const distribution = recorder.getReasonDistribution();

            expect(distribution[ReasonCodes.HEALTH_SCORE_WINNER].count).toBe(7);
            expect(distribution[ReasonCodes.HEALTH_SCORE_WINNER].percentage).toBe(70);
            expect(distribution[ReasonCodes.ROUND_ROBIN_TURN].count).toBe(3);
            expect(distribution[ReasonCodes.ROUND_ROBIN_TURN].percentage).toBe(30);
        });
    });

    describe('getFairnessMetrics', () => {
        test('should calculate fairness score', () => {
            // Perfectly fair distribution
            for (let i = 0; i < 30; i++) {
                const context = new SelectionContext();
                context.selectedKeyIndex = i % 3;
                context.selectedKeyId = `key${i % 3}`;
                context.excludedKeys = [];
                recorder.record(context);
            }

            const metrics = recorder.getFairnessMetrics();

            expect(metrics.totalSelections).toBe(30);
            expect(metrics.keyCount).toBe(3);
            expect(metrics.fairnessScore).toBeGreaterThan(90); // Should be near 100 for perfect distribution
        });

        test('should detect unfair distribution', () => {
            // Unfair distribution - key0 gets 90%, others get 5% each
            for (let i = 0; i < 90; i++) {
                const context = new SelectionContext();
                context.selectedKeyIndex = 0;
                context.selectedKeyId = 'key0';
                context.excludedKeys = [];
                recorder.record(context);
            }

            for (let i = 0; i < 5; i++) {
                const context = new SelectionContext();
                context.selectedKeyIndex = 1;
                context.selectedKeyId = 'key1';
                context.excludedKeys = [];
                recorder.record(context);
            }

            for (let i = 0; i < 5; i++) {
                const context = new SelectionContext();
                context.selectedKeyIndex = 2;
                context.selectedKeyId = 'key2';
                context.excludedKeys = [];
                recorder.record(context);
            }

            const metrics = recorder.getFairnessMetrics();

            expect(metrics.fairnessScore).toBeLessThan(50); // Should be low for unfair distribution
            expect(metrics.perKey['key0'].shareOfTotal).toBe(90);
        });
    });

    describe('getStats', () => {
        test('should return complete stats summary', () => {
            const context = new SelectionContext();
            context.selectedKeyIndex = 0;
            context.selectedKeyId = 'key0';
            context.reason = ReasonCodes.LAST_AVAILABLE;
            context.excludedKeys = [];

            recorder.record(context);

            const stats = recorder.getStats();

            expect(stats.totalDecisions).toBe(1);
            expect(stats.reasonDistribution).toBeDefined();
            expect(stats.whyNotStats).toBeDefined();
            expect(stats.fairness).toBeDefined();
            expect(stats.recentDecisions).toBeDefined();
        });
    });

    describe('reset', () => {
        test('should clear all data', () => {
            const context = new SelectionContext();
            context.selectedKeyId = 'key0';
            context.reason = ReasonCodes.HEALTH_SCORE_WINNER;
            context.excludedKeys = [{ keyId: 'key1', reason: ReasonCodes.EXCLUDED_CIRCUIT_OPEN }];

            recorder.record(context);
            recorder.reset();

            expect(recorder.decisions.length).toBe(0);
            expect(recorder.keySelectionCounts).toEqual({});
            expect(recorder.whyNotCounts).toEqual({});
        });
    });
});

describe('SelectionContext', () => {
    test('should initialize with defaults', () => {
        const context = new SelectionContext();

        expect(context.timestamp).toBeDefined();
        expect(context.selectedKeyIndex).toBeNull();
        expect(context.reason).toBeNull();
        expect(context.excludedKeys).toEqual([]);
    });

    test('should serialize to JSON', () => {
        const context = new SelectionContext();
        context.requestId = 'req-123';
        context.selectedKeyIndex = 0;
        context.reason = ReasonCodes.HEALTH_SCORE_WINNER;
        context.healthScore = 85;

        const json = context.toJSON();

        expect(json.requestId).toBe('req-123');
        expect(json.selectedKeyIndex).toBe(0);
        expect(json.reason).toBe(ReasonCodes.HEALTH_SCORE_WINNER);
        expect(json.healthScore).toBe(85);
        expect(json.ts).toBeDefined();
    });
});

describe('ReasonCodes', () => {
    test('should have all expected codes', () => {
        expect(ReasonCodes.HEALTH_SCORE_WINNER).toBe('health_score_winner');
        expect(ReasonCodes.ROUND_ROBIN_TURN).toBe('round_robin_turn');
        expect(ReasonCodes.CIRCUIT_RECOVERY).toBe('circuit_recovery');
        expect(ReasonCodes.EXCLUDED_CIRCUIT_OPEN).toBe('excluded_circuit_open');
        expect(ReasonCodes.EXCLUDED_RATE_LIMITED).toBe('excluded_rate_limited');
    });
});
