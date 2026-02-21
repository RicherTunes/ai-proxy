/**
 * Key Manager Extended Tests
 * Covers uncovered lines: 53,171-172,215-246,279,307-308,342-346,396,
 * 486-490,571-574,785-959,1012-1022,1038-1050,1068-1069,1094-1131
 */

const { KeyManager } = require('../lib/key-manager');
const { STATES } = require('../lib/circuit-breaker');

describe('KeyManager - Extended Coverage', () => {
    let km;

    afterEach(() => {
        if (km) {
            km.destroy();
            km = null;
        }
    });

    /**
     * Helper: create a KeyManager with sensible defaults for testing.
     * Disables weighted selection by default so round-robin is deterministic.
     */
    function createKm(overrides = {}) {
        const instance = new KeyManager({
            maxConcurrencyPerKey: 2,
            circuitBreaker: {
                failureThreshold: 3,
                failureWindow: 60000,
                cooldownPeriod: 500
            },
            rateLimitPerMinute: 0,
            keySelection: {
                useWeightedSelection: false,
                slowKeyThreshold: 2.0,
                slowKeyCheckIntervalMs: 30000,
                slowKeyCooldownMs: 300000
            },
            ...overrides
        });
        return instance;
    }

    // =========================================================================
    // 1. consumeRateLimit (lines 306-308)
    // =========================================================================
    describe('consumeRateLimit', () => {
        test('returns true when rate limit not exhausted', () => {
            km = new KeyManager({
                maxConcurrencyPerKey: 5,
                rateLimitPerMinute: 10,
                rateLimitBurst: 0
            });
            km.loadKeys(['key1.secret1']);

            const keyInfo = km.keys[0];
            const result = km.consumeRateLimit(keyInfo);
            expect(result).toBe(true);
        });

        test('returns false when rate limit exhausted', () => {
            km = new KeyManager({
                maxConcurrencyPerKey: 5,
                rateLimitPerMinute: 2,
                rateLimitBurst: 0
            });
            km.loadKeys(['key1.secret1']);

            const keyInfo = km.keys[0];
            // Consume all available tokens
            km.consumeRateLimit(keyInfo);
            km.consumeRateLimit(keyInfo);

            // Third should be exhausted
            const result = km.consumeRateLimit(keyInfo);
            expect(result).toBe(false);
        });
    });

    // =========================================================================
    // 2. compareKeys (lines 783-960)
    // =========================================================================
    describe('compareKeys', () => {
        test('returns error when no valid key indices', () => {
            km = createKm();
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            const result = km.compareKeys([99, 100]);
            expect(result.error).toBe('No valid keys to compare');
            expect(result.keys).toEqual([]);
        });

        test('returns comparison for 2+ keys with normalized scores and overall score', () => {
            km = createKm();
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            // Populate latency data for key 0 (fast)
            const key0 = km.keys[0];
            key0.inFlight = 1;
            key0.totalRequests = 20;
            key0.successCount = 20;
            for (let i = 0; i < 20; i++) {
                km.recordSuccess(key0, 200);
            }

            // Populate latency data for key 1 (slow)
            const key1 = km.keys[1];
            key1.inFlight = 1;
            key1.totalRequests = 20;
            key1.successCount = 20;
            for (let i = 0; i < 20; i++) {
                km.recordSuccess(key1, 1500);
            }

            const result = km.compareKeys([0, 1]);

            expect(result.keys).toHaveLength(2);
            expect(result.bestKey).toBeDefined();
            expect(result.comparedAt).toBeDefined();
            expect(result.insights).toBeDefined();

            // Each key should have normalized scores
            for (const k of result.keys) {
                expect(k.normalized).toHaveProperty('performance');
                expect(k.normalized).toHaveProperty('reliability');
                expect(k.normalized).toHaveProperty('stability');
                expect(k.normalized).toHaveProperty('rateLimitRisk');
                expect(typeof k.overallScore).toBe('number');
            }
        });

        test('returns insights for performance gap', () => {
            km = createKm();
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            // Key 0: very fast
            for (let i = 0; i < 20; i++) {
                km.recordSuccess(km.keys[0], 100);
            }
            km.keys[0].totalRequests = 20;
            km.keys[0].successCount = 20;

            // Key 1: very slow (10x slower to guarantee >30 performance gap)
            for (let i = 0; i < 20; i++) {
                km.recordSuccess(km.keys[1], 5000);
            }
            km.keys[1].totalRequests = 20;
            km.keys[1].successCount = 20;

            const result = km.compareKeys([0, 1]);
            const perfInsights = result.insights.filter(i => i.category === 'performance');
            expect(perfInsights.length).toBeGreaterThanOrEqual(1);
            expect(perfInsights[0].type).toBe('warning');
            expect(perfInsights[0].data).toHaveProperty('bestLatency');
            expect(perfInsights[0].data).toHaveProperty('worstLatency');
        });

        test('returns insights for unreliable keys (success rate < 95%)', () => {
            km = createKm();
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            // Populate latency data first (recordSuccess increments successCount)
            for (let i = 0; i < 20; i++) km.recordSuccess(km.keys[0], 300);
            for (let i = 0; i < 20; i++) km.recordSuccess(km.keys[1], 300);

            // Now override counts to simulate unreliable key 1
            // compareKeys uses: successRate = successCount / (totalRequests - inFlight)
            // Key 0: reliable (100%)
            km.keys[0].totalRequests = 100;
            km.keys[0].successCount = 100;

            // Key 1: unreliable (90% success rate)
            km.keys[1].totalRequests = 100;
            km.keys[1].successCount = 90;

            const result = km.compareKeys([0, 1]);
            const reliabilityInsights = result.insights.filter(i => i.category === 'reliability');
            expect(reliabilityInsights.length).toBe(1);
            expect(reliabilityInsights[0].type).toBe('warning');
            expect(reliabilityInsights[0].message).toContain('success rate below 95%');
        });

        test('returns recommendation insight when score gap > 20', () => {
            km = createKm();
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            // Key 0: excellent (fast, reliable)
            km.keys[0].totalRequests = 50;
            km.keys[0].successCount = 50;
            for (let i = 0; i < 20; i++) km.recordSuccess(km.keys[0], 100);

            // Key 1: poor (slow, unreliable, rate limited)
            km.keys[1].totalRequests = 50;
            km.keys[1].successCount = 30;
            km.keys[1].rateLimitedCount = 10;
            for (let i = 0; i < 20; i++) km.recordSuccess(km.keys[1], 5000);

            const result = km.compareKeys([0, 1]);
            const recommendations = result.insights.filter(i => i.type === 'recommendation');
            expect(recommendations.length).toBe(1);
            expect(recommendations[0].category).toBe('optimization');
            expect(recommendations[0].message).toContain('Consider prioritizing');
        });

        test('defaults to all keys when keyIndices is null', () => {
            km = createKm();
            km.loadKeys(['key1.secret1', 'key2.secret2', 'key3.secret3']);

            // Add some latency data
            for (const key of km.keys) {
                for (let i = 0; i < 10; i++) km.recordSuccess(key, 300);
            }

            const result = km.compareKeys(null);
            expect(result.keys).toHaveLength(3);
        });

        test('handles single key comparison (no comparison insights)', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);
            for (let i = 0; i < 10; i++) km.recordSuccess(km.keys[0], 300);

            const result = km.compareKeys([0]);
            expect(result.keys).toHaveLength(1);
            // With only 1 key, insight says "Need at least 2 keys for comparison insights"
            expect(result.insights[0].type).toBe('info');
            expect(result.insights[0].message).toContain('at least 2 keys');
        });
    });

    // =========================================================================
    // 3. forceCircuitState (lines 1011-1022)
    // =========================================================================
    describe('forceCircuitState', () => {
        test('forces state to OPEN and returns result', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            const result = km.forceCircuitState(0, 'OPEN');
            expect(result.index).toBe(0);
            expect(result.newState).toBe('OPEN');
            expect(result.keyPrefix).toBeDefined();
            expect(km.keys[0].circuitBreaker.state).toBe(STATES.OPEN);
        });

        test('forces state to HALF_OPEN', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            const result = km.forceCircuitState(0, 'HALF_OPEN');
            expect(result.newState).toBe('HALF_OPEN');
        });

        test('throws for invalid key index', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            expect(() => km.forceCircuitState(99, 'OPEN'))
                .toThrow('Invalid key index: 99');
        });

        test('throws for invalid state string', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            expect(() => km.forceCircuitState(0, 'INVALID_STATE'))
                .toThrow('Invalid state: INVALID_STATE');
        });
    });

    // =========================================================================
    // 4. getLatencyHistogram / getKeyLatencyHistogram (lines 1037-1050)
    // =========================================================================
    describe('getLatencyHistogram', () => {
        test('returns histogram data', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            // Record some latency data
            for (let i = 0; i < 10; i++) {
                km.recordSuccess(km.keys[0], 500 + i * 100);
            }

            const histogram = km.getLatencyHistogram('all');
            expect(histogram).toHaveProperty('timeRange', 'all');
            expect(histogram).toHaveProperty('buckets');
            expect(histogram).toHaveProperty('stats');
            expect(histogram.stats.count).toBe(10);
        });
    });

    describe('getKeyLatencyHistogram', () => {
        test('returns histogram data for valid key index', () => {
            km = createKm();
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            for (let i = 0; i < 5; i++) {
                km.recordSuccess(km.keys[0], 300);
            }

            // Key histograms are indexed by insertion order in the aggregator
            const histogram = km.getKeyLatencyHistogram(0, 'all');
            expect(histogram).not.toBeNull();
            expect(histogram).toHaveProperty('timeRange', 'all');
            expect(histogram).toHaveProperty('buckets');
        });

        test('returns null for invalid key index', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            const result = km.getKeyLatencyHistogram(99);
            expect(result).toBeNull();
        });
    });

    // =========================================================================
    // 5. getSchedulerStats (lines 1057-1086)
    // =========================================================================
    describe('getSchedulerStats', () => {
        test('returns pool state, reason distribution, fairness, and config', () => {
            km = createKm();
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            // Generate some activity so scheduler has data
            const k = km.acquireKey();
            if (k) km.recordSuccess(k, 200);

            const stats = km.getSchedulerStats();
            expect(stats).toHaveProperty('poolState');
            expect(stats.poolState).toHaveProperty('state');
            expect(stats.poolState).toHaveProperty('lastChange');
            expect(stats.poolState).toHaveProperty('avgLatency');

            expect(stats).toHaveProperty('reasonDistribution');
            expect(stats).toHaveProperty('fairness');
            expect(stats).toHaveProperty('config');
            expect(stats.config).toHaveProperty('useWeightedSelection');
            expect(stats.config).toHaveProperty('fairnessMode');
            expect(stats.config).toHaveProperty('maxConcurrencyPerKey');

            expect(stats).toHaveProperty('whyNotByKey');
            expect(stats).toHaveProperty('totalDecisions');
        });

        test('includes whyNot defaults for all keys', () => {
            km = createKm();
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            const stats = km.getSchedulerStats();
            // Should have an entry for each key
            expect(Object.keys(stats.whyNotByKey)).toHaveLength(2);
            for (const keyId of Object.keys(stats.whyNotByKey)) {
                const whyNot = stats.whyNotByKey[keyId];
                expect(whyNot).toHaveProperty('excluded_circuit_open');
                expect(whyNot).toHaveProperty('excluded_rate_limited');
                expect(whyNot).toHaveProperty('excluded_at_max_concurrency');
                expect(whyNot).toHaveProperty('excluded_slow_quarantine');
            }
        });
    });

    // =========================================================================
    // 6. recordSelection (lines 1093-1109)
    // =========================================================================
    describe('recordSelection', () => {
        test('records decision context to scheduler', () => {
            km = createKm();
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            km.recordSelection({
                requestId: 'req-123',
                attempt: 0,
                keyIndex: 0,
                keyId: 'key1',
                reason: 'health_score_winner',
                healthScore: 85,
                excludedKeys: [],
                competingKeys: 2
            });

            const stats = km.getSchedulerStats();
            expect(stats.totalDecisions).toBeGreaterThanOrEqual(1);
        });

        test('records with excluded keys and defaults', () => {
            km = createKm();
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            km.recordSelection({
                requestId: 'req-456',
                keyIndex: 1,
                keyId: 'key2',
                reason: 'weighted_random',
                healthScore: 70,
                excludedKeys: [{ keyIndex: 0, keyId: 'key1', reason: 'excluded_circuit_open' }]
            });

            const stats = km.getSchedulerStats();
            expect(stats.totalDecisions).toBeGreaterThanOrEqual(1);
        });
    });

    // =========================================================================
    // 7. quarantineKey / releaseFromQuarantine (lines 1117-1132)
    // =========================================================================
    describe('quarantineKey and releaseFromQuarantine', () => {
        test('quarantines a key (check _isQuarantined flag via getStats)', () => {
            km = createKm();
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            km.quarantineKey(0, 'slow_response');

            const stats = km.getStats();
            expect(stats[0].selectionStats.isQuarantined).toBe(true);
            expect(stats[0].selectionStats.quarantineReason).toBe('slow_response');
        });

        test('releases from quarantine', () => {
            km = createKm();
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            km.quarantineKey(0, 'slow');
            expect(km.keys[0]._isQuarantined).toBe(true);

            km.releaseFromQuarantine(0);

            const stats = km.getStats();
            expect(stats[0].selectionStats.isQuarantined).toBe(false);
            expect(stats[0].selectionStats.quarantineReason).toBeNull();
        });

        test('handles invalid key index gracefully (no throw)', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            // Should not throw for out-of-bounds index
            expect(() => km.quarantineKey(99, 'test')).not.toThrow();
            expect(() => km.releaseFromQuarantine(99)).not.toThrow();
        });
    });

    // =========================================================================
    // 8. getPoolState (lines 1139-1141)
    // =========================================================================
    describe('getPoolState', () => {
        test('returns pool state object', () => {
            km = createKm();
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            const poolState = km.getPoolState();
            expect(poolState).toHaveProperty('state');
            expect(poolState).toHaveProperty('lastChange');
            expect(poolState).toHaveProperty('avgLatency');
            expect(['healthy', 'degraded', 'critical']).toContain(poolState.state);
        });
    });

    // =========================================================================
    // 9. destroy (lines 1147-1155)
    // =========================================================================
    describe('destroy', () => {
        test('clears intervals and scheduler', () => {
            km = new KeyManager({
                maxConcurrencyPerKey: 2,
                keySelection: {
                    useWeightedSelection: true,
                    slowKeyCheckIntervalMs: 100000,
                    slowKeyThreshold: 2.0,
                    slowKeyCooldownMs: 300000
                }
            });
            km.loadKeys(['key1.secret1']);

            // Before destroy, interval should exist
            expect(km._slowKeyCheckInterval).not.toBeNull();

            km.destroy();

            expect(km._slowKeyCheckInterval).toBeNull();
            // Scheduler should also be cleaned up
            expect(km.scheduler._scoreUpdateInterval).toBeNull();

            // Prevent afterEach from calling destroy again
            km = null;
        });

        test('destroy is safe to call when no intervals exist', () => {
            km = createKm({ keySelection: { useWeightedSelection: false } });
            km.loadKeys(['key1.secret1']);

            // useWeightedSelection is false, so no slow key check interval
            expect(km._slowKeyCheckInterval).toBeUndefined();

            // Should not throw
            expect(() => km.destroy()).not.toThrow();
            km = null;
        });
    });

    // =========================================================================
    // 10. _checkForSlowKeys (lines 214-252)
    // =========================================================================
    describe('_checkForSlowKeys', () => {
        test('marks key as slow when ratio exceeds threshold', () => {
            km = createKm({
                keySelection: {
                    useWeightedSelection: false,
                    slowKeyThreshold: 2.0,
                    slowKeyCheckIntervalMs: 999999,
                    slowKeyCooldownMs: 300000
                }
            });
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            // Key 0: fast (populates ~200ms p50)
            for (let i = 0; i < 20; i++) {
                km.recordSuccess(km.keys[0], 200);
            }

            // Key 1: very slow (populates ~2000ms p50)
            // Pool average will be ~1100ms, so ratio for key1 = 2000/1100 ~= 1.82
            // We need ratio >= 2.0, so make key1 even slower
            for (let i = 0; i < 20; i++) {
                km.recordSuccess(km.keys[1], 5000);
            }

            // Pool average = (200 + 5000) / 2 = 2600
            // Key 1 ratio = 5000 / 2600 ~= 1.92 ... still not >= 2.0
            // Make key0 latency lower to increase the ratio
            // Let's use 100ms vs 5000ms -> pool avg = 2550, ratio = 5000/2550 ~= 1.96
            // Use 50ms vs 5000ms -> pool avg = 2525, ratio = 5000/2525 ~= 1.98
            // Use 50ms vs 10000ms -> pool avg = 5025, ratio = 10000/5025 ~= 1.99
            // Just lower threshold or make gap bigger

            // Reset and use a lower threshold for testability
            km.destroy();
            km = createKm({
                keySelection: {
                    useWeightedSelection: false,
                    slowKeyThreshold: 1.5,
                    slowKeyCheckIntervalMs: 999999,
                    slowKeyCooldownMs: 300000
                }
            });
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            for (let i = 0; i < 20; i++) km.recordSuccess(km.keys[0], 200);
            for (let i = 0; i < 20; i++) km.recordSuccess(km.keys[1], 2000);

            // Pool avg = (200 + 2000) / 2 = 1100
            // Key 1 ratio = 2000/1100 = 1.818 >= 1.5 -> should be slow
            km._checkForSlowKeys();

            expect(km.keys[1]._isSlowKey).toBe(true);
            expect(km.keys[0]._isSlowKey).toBeFalsy();
        });

        test('recovers key when ratio drops below threshold * 0.8', () => {
            km = createKm({
                keySelection: {
                    useWeightedSelection: false,
                    slowKeyThreshold: 1.5,
                    slowKeyCheckIntervalMs: 999999,
                    slowKeyCooldownMs: 300000
                }
            });
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            // First, make key1 slow
            for (let i = 0; i < 20; i++) km.recordSuccess(km.keys[0], 200);
            for (let i = 0; i < 20; i++) km.recordSuccess(km.keys[1], 2000);

            km._checkForSlowKeys();
            expect(km.keys[1]._isSlowKey).toBe(true);

            // Now make key1's latency drop significantly
            // We need to push enough fast values to replace the slow ones in the RingBuffer
            for (let i = 0; i < 100; i++) {
                km.recordSuccess(km.keys[1], 200);
            }

            // Now pool avg ~ (200+200)/2 = 200, ratio = 200/200 = 1.0 < 1.5*0.8=1.2
            km._checkForSlowKeys();

            expect(km.keys[1]._isSlowKey).toBe(false);
        });

        test('does nothing when pool average latency is 0', () => {
            km = createKm();
            km.loadKeys(['key1.secret1', 'key2.secret2']);
            // No latency data recorded yet

            km._checkForSlowKeys();

            expect(km.keys[0]._isSlowKey).toBeFalsy();
            expect(km.keys[1]._isSlowKey).toBeFalsy();
        });
    });

    // =========================================================================
    // 11. getPoolCooldownRemainingMs / isPoolRateLimited / getPoolRateLimitStats
    //     (lines 645-671)
    // =========================================================================
    describe('pool rate limit methods', () => {
        test('getPoolCooldownRemainingMs returns 0 when not rate limited', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            expect(km.getPoolCooldownRemainingMs()).toBe(0);
        });

        test('getPoolCooldownRemainingMs returns remaining ms after recordPoolRateLimitHit', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            km.recordPoolRateLimitHit({ baseMs: 5000, capMs: 10000 });

            const remaining = km.getPoolCooldownRemainingMs();
            expect(remaining).toBeGreaterThan(0);
            expect(remaining).toBeLessThanOrEqual(6000); // 5000 + jitter
        });

        test('isPoolRateLimited returns true during cooldown', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            expect(km.isPoolRateLimited()).toBe(false);

            km.recordPoolRateLimitHit({ baseMs: 5000, capMs: 10000 });

            expect(km.isPoolRateLimited()).toBe(true);
        });

        test('getPoolRateLimitStats returns complete status', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            km.recordPoolRateLimitHit();

            const stats = km.getPoolRateLimitStats();
            expect(stats).toHaveProperty('isRateLimited');
            expect(stats).toHaveProperty('cooldownRemainingMs');
            expect(stats).toHaveProperty('pool429Count');
            expect(stats).toHaveProperty('lastPool429At');
            expect(stats).toHaveProperty('cooldownUntil');
            expect(stats.isRateLimited).toBe(true);
            expect(stats.pool429Count).toBe(1);
            expect(stats.lastPool429At).not.toBeNull();
            expect(stats.cooldownUntil).not.toBeNull();
        });

        test('getPoolRateLimitStats returns clean state when no rate limits', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            const stats = km.getPoolRateLimitStats();
            expect(stats.isRateLimited).toBe(false);
            expect(stats.cooldownRemainingMs).toBe(0);
            expect(stats.pool429Count).toBe(0);
        });
    });

    // =========================================================================
    // 12. getBestKey all-at-capacity path (lines 341-346)
    // =========================================================================
    describe('getBestKey all-at-capacity', () => {
        test('returns null when all keys at maxConcurrencyPerKey', () => {
            km = createKm({ maxConcurrencyPerKey: 2 });
            km.loadKeys(['key1.secret1', 'key2.secret2', 'key3.secret3']);

            // Set all keys to max concurrency
            km.keys[0].inFlight = 2;
            km.keys[1].inFlight = 2;
            km.keys[2].inFlight = 2;

            const result = km.getBestKey();
            expect(result).toBeNull();
        });

        test('returns a key when at least one is under capacity', () => {
            km = createKm({ maxConcurrencyPerKey: 2 });
            km.loadKeys(['key1.secret1', 'key2.secret2', 'key3.secret3']);

            km.keys[0].inFlight = 2;
            km.keys[1].inFlight = 2;
            km.keys[2].inFlight = 1;  // Under capacity

            const result = km.getBestKey();
            expect(result).not.toBeNull();
            expect(result.index).toBe(2);
        });
    });

    // =========================================================================
    // 13. Adaptive rate limit cooldown (lines 571-574)
    // =========================================================================
    describe('recordRateLimit adaptive cooldown', () => {
        test('uses exponential backoff without Retry-After header', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            const key = km.keys[0];

            // First 429 - base cooldown ~1000ms (with jitter)
            km.recordRateLimit(key);
            const firstCooldown = key.rateLimitCooldownMs;
            expect(firstCooldown).toBeGreaterThan(0);
            expect(firstCooldown).toBeLessThanOrEqual(1400); // 1000 + jitter

            // Second 429 - should increase
            km.recordRateLimit(key);
            const secondCooldown = key.rateLimitCooldownMs;
            expect(secondCooldown).toBeGreaterThan(firstCooldown * 0.5); // At least some increase accounting for jitter

            // Third 429 - should increase further
            km.recordRateLimit(key);
            const thirdCooldown = key.rateLimitCooldownMs;
            // rateLimitedCount is now 3, backoffFactor = min(3, 4) = 3, base * 2^2 = 4000
            expect(thirdCooldown).toBeGreaterThan(2000);
        });

        test('caps cooldown at 10000ms', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            const key = km.keys[0];

            // Fire many 429s to hit the cap
            for (let i = 0; i < 10; i++) {
                km.recordRateLimit(key);
            }

            // Should be capped at 10000 + jitter
            expect(key.rateLimitCooldownMs).toBeLessThanOrEqual(12000);
        });
    });

    // =========================================================================
    // 14. reloadKeys onStateChange callback coverage (lines 171-172)
    // =========================================================================
    describe('reloadKeys with new key circuit breaker callback', () => {
        test('triggers onKeyStateChange for newly added keys', () => {
            const stateChangeCb = jest.fn();
            km = new KeyManager({
                maxConcurrencyPerKey: 2,
                circuitBreaker: {
                    failureThreshold: 2,
                    failureWindow: 60000
                },
                onKeyStateChange: stateChangeCb
            });
            km.loadKeys(['key1.secret1']);

            // Reload with a new key
            km.reloadKeys(['key1.secret1', 'key2.secret2']);

            // Trip the circuit breaker on the new key to trigger onStateChange
            const newKey = km.getKeyById('key2');
            km.recordFailure(newKey, 'test');
            km.recordFailure(newKey, 'test');

            expect(stateChangeCb).toHaveBeenCalled();
        });
    });

    // =========================================================================
    // 15. _weightedRandomSelect fallback to first key (line 279)
    //     and getBestKey fallback return (line 396)
    // =========================================================================
    describe('_weightedRandomSelect edge cases', () => {
        test('returns first key as fallback for single scored key', () => {
            km = createKm({
                keySelection: {
                    useWeightedSelection: true,
                    slowKeyThreshold: 2.0,
                    slowKeyCheckIntervalMs: 999999,
                    slowKeyCooldownMs: 300000
                }
            });
            km.loadKeys(['key1.secret1']);

            const scoredKeys = [{
                key: km.keys[0],
                score: { total: 80 }
            }];

            const result = km._weightedRandomSelect(scoredKeys);
            expect(result).toBe(km.keys[0]);
        });

        test('returns null for empty scored keys', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            const result = km._weightedRandomSelect([]);
            expect(result).toBeNull();
        });
    });

    // =========================================================================
    // 16. acquireKey max attempts exhausted (lines 486-490)
    // =========================================================================
    describe('acquireKey max attempts exhausted', () => {
        test('returns null when all keys rate-limit exhausted during acquisition', () => {
            km = new KeyManager({
                maxConcurrencyPerKey: 10,
                rateLimitPerMinute: 1,
                rateLimitBurst: 0
            });
            km.loadKeys(['key1.secret1']);

            // First acquire consumes the one token
            const first = km.acquireKey();
            expect(first).not.toBeNull();
            km.recordSuccess(first, 100);

            // Second acquire should fail - rate limit exhausted and only 1 key
            const second = km.acquireKey();
            expect(second).toBeNull();
        });
    });

    // =========================================================================
    // 17. Slow key check interval trigger (line 53)
    // =========================================================================
    describe('slow key check interval', () => {
        test('creates interval when weighted selection is enabled', () => {
            km = new KeyManager({
                maxConcurrencyPerKey: 2,
                keySelection: {
                    useWeightedSelection: true,
                    slowKeyCheckIntervalMs: 100000,
                    slowKeyThreshold: 2.0,
                    slowKeyCooldownMs: 300000
                }
            });
            km.loadKeys(['key1.secret1']);

            expect(km._slowKeyCheckInterval).toBeDefined();
            expect(km._slowKeyCheckInterval).not.toBeNull();
        });

        test('does not create interval when weighted selection is disabled', () => {
            km = createKm({
                keySelection: {
                    useWeightedSelection: false,
                    slowKeyCheckIntervalMs: 100000,
                    slowKeyThreshold: 2.0,
                    slowKeyCooldownMs: 300000
                }
            });
            km.loadKeys(['key1.secret1']);

            expect(km._slowKeyCheckInterval).toBeUndefined();
        });
    });
});
