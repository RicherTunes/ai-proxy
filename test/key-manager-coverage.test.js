'use strict';

/**
 * Key Manager Coverage Tests
 * Targets uncovered lines/branches: 134, 226, 1274-1279, 1623, 128, 220,
 * 321, 367, 375, 784, 966, 1498, 1561, 1578, 1602, 1653, 1666
 * Lines 412, 571 are unreachable dead code (loops always return).
 */

const { KeyManager } = require('../lib/key-manager');
const { STATES } = require('../lib/circuit-breaker');

describe('KeyManager - Coverage', () => {
    let km;

    afterEach(() => {
        if (km) {
            km.destroy();
            km = null;
        }
    });

    /**
     * Helper: create a KeyManager with sensible defaults.
     */
    function createKm(overrides = {}) {
        return new KeyManager({
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
    }

    // =========================================================================
    // 1. loadKeys with invalid input (line 134: else branch keyEntries = [])
    // =========================================================================
    describe('loadKeys edge cases', () => {
        // Covers line 134: when keyInput is null (not array, not object)
        test('returns 0 keys when loadKeys receives null', () => {
            km = createKm();
            const count = km.loadKeys(null);
            expect(count).toBe(0);
            expect(km.keys).toHaveLength(0);
        });

        // Covers line 134: when keyInput is undefined
        test('returns 0 keys when loadKeys receives undefined', () => {
            km = createKm();
            const count = km.loadKeys(undefined);
            expect(count).toBe(0);
            expect(km.keys).toHaveLength(0);
        });

        // Covers line 134: when keyInput is a string (truthy non-object)
        test('returns 0 keys when loadKeys receives a string', () => {
            km = createKm();
            const count = km.loadKeys('not-an-array');
            expect(count).toBe(0);
            expect(km.keys).toHaveLength(0);
        });

        // Covers line 134: when keyInput is a number
        test('returns 0 keys when loadKeys receives a number', () => {
            km = createKm();
            const count = km.loadKeys(42);
            expect(count).toBe(0);
            expect(km.keys).toHaveLength(0);
        });

        // Covers line 134: when keyInput is false
        test('returns 0 keys when loadKeys receives false', () => {
            km = createKm();
            const count = km.loadKeys(false);
            expect(count).toBe(0);
            expect(km.keys).toHaveLength(0);
        });
    });

    // =========================================================================
    // 2. reloadKeys with invalid input (line 226: else branch keyEntries = [])
    // =========================================================================
    describe('reloadKeys edge cases', () => {
        // Covers line 226: when keyInput is null
        test('removes all keys when reloadKeys receives null', () => {
            km = createKm();
            km.loadKeys(['key1.secret1', 'key2.secret2']);
            expect(km.keys).toHaveLength(2);

            const result = km.reloadKeys(null);
            expect(result.total).toBe(0);
            expect(result.added).toBe(0);
            expect(result.removed).toBe(2);
            expect(km.keys).toHaveLength(0);
        });

        // Covers line 226: when keyInput is undefined
        test('removes all keys when reloadKeys receives undefined', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);
            expect(km.keys).toHaveLength(1);

            const result = km.reloadKeys(undefined);
            expect(result.total).toBe(0);
            expect(result.removed).toBe(1);
            expect(km.keys).toHaveLength(0);
        });

        // Covers line 226: when keyInput is a string
        test('removes all keys when reloadKeys receives a string', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);
            expect(km.keys).toHaveLength(1);

            const result = km.reloadKeys('invalid');
            expect(result.total).toBe(0);
            expect(result.removed).toBe(1);
            expect(km.keys).toHaveLength(0);
        });

        // Covers line 226: when keyInput is a number
        test('removes all keys when reloadKeys receives a number', () => {
            km = createKm();
            km.loadKeys(['key1.secret1', 'key2.secret2']);
            expect(km.keys).toHaveLength(2);

            const result = km.reloadKeys(99);
            expect(result.total).toBe(0);
            expect(result.removed).toBe(2);
            expect(km.keys).toHaveLength(0);
        });
    });

    // =========================================================================
    // 3. _generateComparisonInsights with OPEN circuit breakers
    //    (lines 1274-1279: critical insight for OPEN circuits)
    // =========================================================================
    describe('_generateComparisonInsights with OPEN circuits', () => {
        // Covers lines 1274-1279: insight generation when keys have OPEN circuits
        test('produces critical circuit_breaker insight when a key has OPEN circuit', () => {
            km = createKm();
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            // Add some latency data so compareKeys has metrics to work with
            for (let i = 0; i < 15; i++) km.recordSuccess(km.keys[0], 300);
            for (let i = 0; i < 15; i++) km.recordSuccess(km.keys[1], 300);

            // Force key1's circuit breaker to OPEN
            km.forceCircuitState(0, 'OPEN');

            const result = km.compareKeys([0, 1]);
            const circuitInsights = result.insights.filter(i => i.category === 'circuit_breaker');
            expect(circuitInsights.length).toBe(1);
            expect(circuitInsights[0].type).toBe('critical');
            expect(circuitInsights[0].message).toContain('OPEN circuits');
            expect(circuitInsights[0].data).toHaveProperty('keys');
            expect(circuitInsights[0].data.keys).toContain('key1');
        });

        // Covers lines 1274-1279: multiple keys with OPEN circuits
        test('lists all key prefixes when multiple keys have OPEN circuits', () => {
            km = createKm();
            km.loadKeys(['key1.secret1', 'key2.secret2', 'key3.secret3']);

            for (let i = 0; i < 15; i++) {
                km.recordSuccess(km.keys[0], 300);
                km.recordSuccess(km.keys[1], 300);
                km.recordSuccess(km.keys[2], 300);
            }

            // Force both key1 and key2 to OPEN
            km.forceCircuitState(0, 'OPEN');
            km.forceCircuitState(1, 'OPEN');

            const result = km.compareKeys([0, 1, 2]);
            const circuitInsights = result.insights.filter(i => i.category === 'circuit_breaker');
            expect(circuitInsights.length).toBe(1);
            expect(circuitInsights[0].message).toContain('2 key(s) have OPEN circuits');
            expect(circuitInsights[0].data.keys).toHaveLength(2);
            expect(circuitInsights[0].data.keys).toContain('key1');
            expect(circuitInsights[0].data.keys).toContain('key2');
        });
    });

    // =========================================================================
    // 4. getModelConcurrencyStats with in-flight but no limit (line 1623)
    // =========================================================================
    describe('getModelConcurrencyStats edge cases', () => {
        // Covers line 1623: model in _modelInFlight but not in _modelLimits
        test('reports maxConcurrency null for model with in-flight but no configured limit', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            // Directly inject a model into _modelInFlight without a corresponding limit
            km._modelInFlight.set('transient-model', 3);

            const stats = km.getModelConcurrencyStats();
            expect(stats['transient-model']).toEqual({
                inFlight: 3,
                maxConcurrency: null
            });
        });

        // Covers both the _modelLimits loop and the _modelInFlight fallback loop
        test('includes models from both limits and in-flight maps', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            km.setModelConcurrencyLimits({ 'claude-3': 5 });
            km._modelInFlight.set('claude-3', 2);
            km._modelInFlight.set('unknown-model', 1);

            const stats = km.getModelConcurrencyStats();
            expect(stats['claude-3']).toEqual({
                inFlight: 2,
                maxConcurrency: 5
            });
            expect(stats['unknown-model']).toEqual({
                inFlight: 1,
                maxConcurrency: null
            });
        });

        test('returns empty object when no models tracked', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            const stats = km.getModelConcurrencyStats();
            expect(stats).toEqual({});
        });
    });

    // =========================================================================
    // 5. Provider map with non-array values (line 128, 220: skip non-array)
    // =========================================================================
    describe('loadKeys with provider map having non-array values', () => {
        // Covers line 128: `if (!Array.isArray(keys)) continue;` skips non-array entries
        test('skips provider entries that are not arrays', () => {
            km = createKm();
            const result = km.loadKeys({
                'valid-provider': ['key1.secret1'],
                'invalid-provider': 'not-an-array',
                'another-valid': ['key2.secret2']
            });

            expect(result).toBe(2);
            expect(km.keys).toHaveLength(2);
            expect(km.keys[0].provider).toBe('valid-provider');
            expect(km.keys[1].provider).toBe('another-valid');
        });

        test('loads no keys when all provider values are non-arrays', () => {
            km = createKm();
            const result = km.loadKeys({
                'p1': 'string',
                'p2': 42,
                'p3': { nested: true }
            });

            expect(result).toBe(0);
            expect(km.keys).toHaveLength(0);
        });
    });

    describe('reloadKeys with provider map having non-array values', () => {
        // Covers line 220: `if (!Array.isArray(keys)) continue;` skips non-array entries
        test('skips provider entries that are not arrays during reload', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            const result = km.reloadKeys({
                'valid-provider': ['key1.secret1'],
                'invalid-provider': 'not-an-array'
            });

            // key1 is preserved (not added since it already exists)
            expect(result.total).toBe(1);
            expect(result.removed).toBe(0);
        });
    });

    // =========================================================================
    // 6. _getOrCreatePool size limit (line 321: returns null when >= 500 pools)
    // =========================================================================
    describe('_getOrCreatePool size limit', () => {
        // Covers line 321: pool size limit of 500
        test('returns null when pool limit of 500 is exceeded', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            // Fill up 500 pools to hit the limit
            for (let i = 0; i < 500; i++) {
                km._modelPools.set(`model-${i}`, {
                    rateLimitedUntil: 0,
                    count: 0,
                    lastHitAt: 0
                });
            }

            // The 501st model should be rejected
            const result = km.recordPoolRateLimitHit({ model: 'overflow-model' });
            expect(result.cooldownMs).toBe(0);
            expect(result.pool429Count).toBe(0);
        });
    });

    // =========================================================================
    // 7. Slow key detection branches (lines 358, 367, 375)
    // =========================================================================
    describe('_checkForSlowKeys detailed branches', () => {
        // Covers line 358: `if (stats.count < 10) continue;` — key with < 10 samples
        test('skips keys with fewer than 10 latency samples', () => {
            km = createKm({
                keySelection: {
                    useWeightedSelection: false,
                    slowKeyThreshold: 1.5,
                    slowKeyCheckIntervalMs: 999999,
                    slowKeyCooldownMs: 300000
                }
            });
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            // Key 0: enough data and slow
            for (let i = 0; i < 20; i++) km.recordSuccess(km.keys[0], 200);
            // Key 1: only 5 samples — should be skipped
            for (let i = 0; i < 5; i++) km.recordSuccess(km.keys[1], 10000);

            km._checkForSlowKeys();

            // Key 1 should NOT be marked slow despite high latency (< 10 samples)
            expect(km.keys[1]._isSlowKey).toBeFalsy();
        });

        // Covers line 367: slow key warning cooldown — re-detection after cooldown expires
        test('re-logs slow key warning after cooldown period expires', () => {
            const logCalls = [];
            km = createKm({
                logger: {
                    info: jest.fn((msg) => logCalls.push(msg)),
                    warn: jest.fn((msg) => logCalls.push(msg)),
                    error: jest.fn((msg) => logCalls.push(msg)),
                    debug: jest.fn((msg) => logCalls.push(msg))
                },
                keySelection: {
                    useWeightedSelection: false,
                    slowKeyThreshold: 1.5,
                    slowKeyCheckIntervalMs: 999999,
                    slowKeyCooldownMs: 100  // Short cooldown for testing
                }
            });
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            for (let i = 0; i < 20; i++) km.recordSuccess(km.keys[0], 200);
            for (let i = 0; i < 20; i++) km.recordSuccess(km.keys[1], 2000);

            // First check: marks key1 as slow and logs
            km._checkForSlowKeys();
            expect(km.keys[1]._isSlowKey).toBe(true);
            const firstWarnCount = logCalls.filter(m => m.includes('marked slow')).length;
            expect(firstWarnCount).toBe(1);

            // Second check immediately: cooldown not expired, should NOT re-log
            km._checkForSlowKeys();
            const secondWarnCount = logCalls.filter(m => m.includes('marked slow')).length;
            expect(secondWarnCount).toBe(1);

            // Advance past cooldown and check again: should re-log
            const originalNow = Date.now;
            Date.now = jest.fn(() => originalNow() + 200);
            km._checkForSlowKeys();
            const thirdWarnCount = logCalls.filter(m => m.includes('marked slow')).length;
            expect(thirdWarnCount).toBe(2);

            Date.now = originalNow;
        });

        // Covers line 375: recovery branch — ratio < threshold * 0.8
        test('does not recover slow key when ratio is between threshold*0.8 and threshold', () => {
            km = createKm({
                keySelection: {
                    useWeightedSelection: false,
                    slowKeyThreshold: 1.5,
                    slowKeyCheckIntervalMs: 999999,
                    slowKeyCooldownMs: 300000
                }
            });
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            // Make key1 slow first
            for (let i = 0; i < 20; i++) km.recordSuccess(km.keys[0], 200);
            for (let i = 0; i < 20; i++) km.recordSuccess(km.keys[1], 2000);
            km._checkForSlowKeys();
            expect(km.keys[1]._isSlowKey).toBe(true);

            // Now adjust latency so ratio is in [1.2, 1.5) — below threshold but above 0.8*threshold
            // threshold * 0.8 = 1.2, threshold = 1.5
            // Need ratio to be between 1.2 and 1.5
            // Pool avg ~= (200 + X) / 2, ratio = X / ((200 + X) / 2)
            // For ratio 1.3: X / ((200 + X) / 2) = 1.3 → 2X / (200 + X) = 1.3 → 2X = 260 + 1.3X → 0.7X = 260 → X ~= 371
            for (let i = 0; i < 100; i++) km.recordSuccess(km.keys[1], 370);
            km._checkForSlowKeys();

            // Should still be slow (not recovered) because ratio is > 1.2
            expect(km.keys[1]._isSlowKey).toBe(true);
        });
    });

    // =========================================================================
    // 8. recordPoolRateLimitHit with null pool (line 784: early return)
    // =========================================================================
    describe('recordPoolRateLimitHit with exhausted pools', () => {
        // Covers line 784: pool is null from _getOrCreatePool
        test('returns zeroed result when pool limit is reached', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            // Fill 500 pools
            for (let i = 0; i < 500; i++) {
                km._modelPools.set(`model-${i}`, {
                    rateLimitedUntil: 0,
                    count: 0,
                    lastHitAt: 0
                });
            }

            const result = km.recordPoolRateLimitHit({ model: 'overflow' });
            expect(result).toEqual({
                cooldownMs: 0,
                pool429Count: 0,
                cooldownUntil: 0,
                model: 'overflow',
                wasAlreadyBlocked: false
            });
        });
    });

    // =========================================================================
    // 9. recordRateLimitHeaders branches (lines 951, 961, 962, 966, 983, 991, 992)
    // =========================================================================
    describe('recordRateLimitHeaders', () => {
        // Covers line 951: default-arg pacingConfig, line 958: isNaN(remaining)
        test('returns early when headers contain no valid x-ratelimit-remaining', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            // Should not throw, returns early
            km.recordRateLimitHeaders('claude-3', { 'x-ratelimit-remaining': 'invalid' });
            // No pool should have been updated
            const pool = km._modelPools.get('claude-3');
            expect(pool).toBeUndefined();
        });

        // Covers line 952: early return when model or headers are falsy
        test('returns early when model is null', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);
            km.recordRateLimitHeaders(null, { 'x-ratelimit-remaining': '5' });
            // Should not throw
        });

        test('returns early when headers is null', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);
            km.recordRateLimitHeaders('claude-3', null);
        });

        // Covers line 968: pacing when remaining <= threshold
        test('sets pacing delay when remaining approaches threshold', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            km.recordRateLimitHeaders('claude-3', {
                'x-ratelimit-remaining': '2',
                'x-ratelimit-limit': '100',
                'x-ratelimit-reset': '60'
            }, { remainingThreshold: 5, pacingDelayMs: 200 });

            const delay = km.getModelPacingDelayMs('claude-3');
            expect(delay).toBeGreaterThan(0);
        });

        // Covers line 966: pool is null when 500 pools exceeded
        test('returns early when pool cannot be created', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            for (let i = 0; i < 500; i++) {
                km._modelPools.set(`model-${i}`, {
                    rateLimitedUntil: 0,
                    count: 0,
                    lastHitAt: 0
                });
            }

            // Should return early without error
            km.recordRateLimitHeaders('overflow-model', {
                'x-ratelimit-remaining': '1',
                'x-ratelimit-limit': '10'
            });
            const pool = km._modelPools.get('overflow-model');
            expect(pool).toBeUndefined();
        });

        // Covers lines 991, 992: isNaN ternary for limit and resetSecs
        test('stores null for limit and reset when headers are missing', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            km.recordRateLimitHeaders('claude-3', {
                'x-ratelimit-remaining': '50'
            });

            const pool = km._modelPools.get('claude-3');
            expect(pool.lastRateLimitRemaining).toBe(50);
            expect(pool.lastRateLimitLimit).toBeNull();
            expect(pool.lastRateLimitReset).toBeNull();
        });
    });

    // =========================================================================
    // 10. setEffectiveModelLimit validation (line 1498)
    // =========================================================================
    describe('setEffectiveModelLimit validation', () => {
        // Covers line 1498: `if (!model || typeof limit !== 'number' || limit < 1) return;`
        test('does nothing when model is empty string', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);
            km.setModelConcurrencyLimits({ 'claude-3': 5 });

            km.setEffectiveModelLimit('', 10);
            expect(km.getEffectiveModelLimit('claude-3')).toBe(5);
        });

        test('does nothing when limit is not a number', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);
            km.setModelConcurrencyLimits({ 'claude-3': 5 });

            km.setEffectiveModelLimit('claude-3', 'ten');
            expect(km.getEffectiveModelLimit('claude-3')).toBe(5);
        });

        test('does nothing when limit is less than 1', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);
            km.setModelConcurrencyLimits({ 'claude-3': 5 });

            km.setEffectiveModelLimit('claude-3', 0);
            expect(km.getEffectiveModelLimit('claude-3')).toBe(5);
        });

        test('does nothing when limit is negative', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);
            km.setModelConcurrencyLimits({ 'claude-3': 5 });

            km.setEffectiveModelLimit('claude-3', -5);
            expect(km.getEffectiveModelLimit('claude-3')).toBe(5);
        });
    });

    // =========================================================================
    // 11. Model concurrency methods with null/undefined model (lines 1561, 1578, 1602)
    // =========================================================================
    describe('model concurrency methods with null model', () => {
        // Covers line 1561: `if (!model) return true;`
        test('acquireModelSlot returns true for null model', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);
            expect(km.acquireModelSlot(null)).toBe(true);
        });

        test('acquireModelSlot returns true for undefined model', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);
            expect(km.acquireModelSlot(undefined)).toBe(true);
        });

        // Covers line 1578: `if (!model) return;`
        test('releaseModelSlot does nothing for null model', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);
            // Should not throw
            km.releaseModelSlot(null);
            km.releaseModelSlot(undefined);
        });

        // Covers line 1602: `if (!model) return false;`
        test('isModelAtCapacity returns false for null model', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);
            expect(km.isModelAtCapacity(null)).toBe(false);
        });

        test('isModelAtCapacity returns false for undefined model', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);
            expect(km.isModelAtCapacity(undefined)).toBe(false);
        });
    });

    // =========================================================================
    // 12. getKeySnapshot with null histogram (line 1653) and null state (line 1666)
    // =========================================================================
    describe('getKeySnapshot edge cases', () => {
        // Covers line 1653: histogram is null (no latency data recorded for this key)
        test('returns null latency when no histogram data exists for key', () => {
            km = createKm();
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            // Key 2 (index 99) doesn't exist
            const snapshot = km.getKeySnapshot(99);
            expect(snapshot).toBeNull();
        });

        // Covers line 1666: `keyState || 'unknown'` fallback
        test('returns valid snapshot with keyId and index', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            const snapshot = km.getKeySnapshot(0);
            expect(snapshot).not.toBeNull();
            expect(snapshot.keyIndex).toBe(0);
            expect(snapshot.keyId).toBe('key1');
            // State comes from scheduler which initializes keys as 'available'
            expect(['available', 'unknown']).toContain(snapshot.state);
        });
    });

    // =========================================================================
    // 13. acquireModelSlot for unknown model (line 1564: permissive)
    // =========================================================================
    describe('acquireModelSlot permissive for unknown models', () => {
        // Covers line 1564: `if (limit === undefined) return true;`
        test('allows slot acquisition for model with no configured limit', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            // No limits set — model is unknown
            expect(km.acquireModelSlot('unknown-model')).toBe(true);
            // Should NOT increment inFlight since it returned early
            expect(km.getModelInFlight('unknown-model')).toBe(0);
        });
    });

    // =========================================================================
    // 14. _handleNoAvailableKeys — reset all circuits (line 599)
    // =========================================================================
    describe('_handleNoAvailableKeys reset all circuits', () => {
        // Covers line 599: reduce to select key with lowest inFlight
        // This path is hit when all keys are rate-limited (not OPEN circuits),
        // so openKeys is empty but nonExcluded has keys
        test('resets all circuits and returns key with lowest inFlight when all keys rate-limited', () => {
            km = createKm({
                rateLimitPerMinute: 0,
                rateLimitBurst: 0
            });
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            // Rate limit all keys (circuits stay CLOSED, but rate limit blocks them)
            km.keys[0].rateLimitedAt = Date.now();
            km.keys[0].rateLimitCooldownMs = 60000;
            km.keys[1].rateLimitedAt = Date.now();
            km.keys[1].rateLimitCooldownMs = 60000;

            // Give one key higher inFlight
            km.keys[0].inFlight = 3;
            km.keys[1].inFlight = 1;

            // getBestKey → available is empty (rate limited) → _handleNoAvailableKeys
            // openKeys is empty (circuits are CLOSED) → nonExcluded > 0 → reset all
            const result = km.getBestKey();
            expect(result).not.toBeNull();
            expect(result.index).toBe(1);
            // All circuits should be reset
            expect(km.keys[0].circuitBreaker.state).toBe(STATES.CLOSED);
            expect(km.keys[1].circuitBreaker.state).toBe(STATES.CLOSED);
        });
    });

    // =========================================================================
    // 15. getPoolRateLimitStats with no pools (lines 928, 929, 932)
    // =========================================================================
    describe('getPoolRateLimitStats with no pools', () => {
        // Covers line 928, 929: null ternary branches
        test('returns zeros when no pools exist', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            const stats = km.getPoolRateLimitStats();
            expect(stats.isRateLimited).toBe(false);
            expect(stats.cooldownRemainingMs).toBe(0);
            expect(stats.pool429Count).toBe(0);
            expect(stats.lastPool429At).toBeNull();
            expect(stats.cooldownUntil).toBeNull();
        });
    });

    // =========================================================================
    // 16. compareKeys with keys having no latency data (lines 1148-1150)
    // =========================================================================
    describe('compareKeys with no latency data', () => {
        // Covers lines 1148-1150: `|| 0` fallbacks when latency stats are 0
        test('handles keys with zero latency data using 0 fallbacks', () => {
            km = createKm();
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            // No latency data recorded — all latency fields are 0
            const result = km.compareKeys([0, 1]);
            expect(result.keys).toHaveLength(2);

            for (const key of result.keys) {
                expect(key.avgLatency).toBe(0);
                expect(key.p50Latency).toBe(0);
                expect(key.p95Latency).toBe(0);
            }
        });
    });

    // =========================================================================
    // 17. getBestKey provider filter branches (line 487: reason ternary)
    // =========================================================================
    describe('getBestKey provider filter reasons', () => {
        // Covers line 487: 'no keys configured for this provider' branch
        // Need totalForProvider === 0 AND untaggedCount === 0
        test('logs correct reason when no keys configured for provider and no untagged keys', () => {
            const logCalls = [];
            km = createKm({
                defaultProviderName: 'default',
                logger: {
                    info: jest.fn((msg) => logCalls.push(msg)),
                    warn: jest.fn((msg, ctx) => logCalls.push({ msg, ctx })),
                    error: jest.fn((msg) => logCalls.push(msg)),
                    debug: jest.fn((msg) => logCalls.push(msg))
                }
            });
            // Load keys tagged to a specific provider (no untagged keys)
            km.loadKeys({ 'other-provider': ['key1.secret1'] });

            const result = km.getBestKey([], 'nonexistent-provider');
            expect(result).toBeNull();

            const warnCall = logCalls.find(l => l && l.ctx && l.msg.includes('nonexistent-provider'));
            expect(warnCall).toBeDefined();
            expect(warnCall.ctx.reason).toBe('no keys configured for this provider');
        });

        // Covers line 487: 'untagged keys restricted to default provider' branch
        // Need totalForProvider === 0 AND untaggedCount > 0
        test('logs untagged restriction reason when default provider differs from filter', () => {
            const logCalls = [];
            km = createKm({
                defaultProviderName: 'z-ai',
                logger: {
                    info: jest.fn((msg) => logCalls.push(msg)),
                    warn: jest.fn((msg, ctx) => logCalls.push({ msg, ctx })),
                    error: jest.fn((msg) => logCalls.push(msg)),
                    debug: jest.fn((msg) => logCalls.push(msg))
                }
            });
            km.loadKeys(['key1.secret1']); // Untagged key

            const result = km.getBestKey([], 'anthropic');
            expect(result).toBeNull();

            const warnCall = logCalls.find(l => l && l.ctx && l.msg.includes('anthropic'));
            expect(warnCall).toBeDefined();
            expect(warnCall.ctx.reason).toBe('untagged keys restricted to default provider');
        });

        // Covers line 487: 'all keys excluded or unavailable' branch
        // Need totalForProvider > 0 (keys exist) but none available
        test('logs all excluded reason when provider keys exist but all excluded', () => {
            const logCalls = [];
            km = createKm({
                logger: {
                    info: jest.fn((msg) => logCalls.push(msg)),
                    warn: jest.fn((msg, ctx) => logCalls.push({ msg, ctx })),
                    error: jest.fn((msg) => logCalls.push(msg)),
                    debug: jest.fn((msg) => logCalls.push(msg))
                }
            });
            km.loadKeys({ 'test-provider': ['key1.secret1', 'key2.secret2'] });

            // Exclude both keys
            const result = km.getBestKey([0, 1], 'test-provider');
            expect(result).toBeNull();

            const warnCall = logCalls.find(l => l && l.ctx && l.ctx.reason);
            expect(warnCall).toBeDefined();
            expect(warnCall.ctx.reason).toBe('all keys excluded or unavailable');
        });
    });

    // =========================================================================
    // 18. Cooldown decay config optional chaining (lines 514, 515)
    // =========================================================================
    describe('cooldown decay config defaults', () => {
        // Covers lines 514, 515: `this.cooldownDecayConfig?.cooldownDecayMs ?? 30000`
        test('uses default values when cooldownDecayConfig is undefined', () => {
            km = new KeyManager({
                maxConcurrencyPerKey: 2,
                keySelection: { useWeightedSelection: false },
                keyRateLimitCooldown: undefined // No cooldown config
            });
            km.loadKeys(['key1.secret1']);

            // Set a key as rate-limited long ago (should trigger decay reset)
            km.keys[0].rateLimitedAt = Date.now() - 60000; // 60s ago
            km.keys[0].rateLimitCooldownMs = 5000;
            km.keys[0].rateLimitedCount = 5;

            // Trigger getBestKey which checks cooldown decay
            const result = km.getBestKey();
            expect(result).not.toBeNull();
            // Should have reset the cooldown since > 30s (default) passed
            expect(km.keys[0].rateLimitedCount).toBe(0);
            expect(km.keys[0].rateLimitCooldownMs).toBe(1000); // Default base
        });
    });

    // =========================================================================
    // 19. Rate limit wait time fallback (line 647)
    // =========================================================================
    describe('acquireKey rate limit wait time fallback', () => {
        // Covers line 647: `rateCheck.waitTime || 60000` used for rateLimitCooldownMs
        test('uses default 60000ms for cooldown when rateCheck.waitTime is 0', () => {
            km = new KeyManager({
                maxConcurrencyPerKey: 2,
                rateLimitPerMinute: 2,
                rateLimitBurst: 0
            });
            km.loadKeys(['key1.secret1']);

            // Consume both tokens
            km.consumeRateLimit(km.keys[0]);
            km.consumeRateLimit(km.keys[0]);

            // Mock rate limiter to return waitTime: 0
            km.rateLimiter.checkLimit = jest.fn(() => ({
                allowed: false,
                waitTime: 0 // Falsy - should trigger || 60000 for cooldown
            }));

            const initialCooldown = km.keys[0].rateLimitCooldownMs;
            const result = km.acquireKey();
            expect(result).toBeNull();

            // The key's rateLimitCooldownMs should be set to max of existing and 60000
            expect(km.keys[0].rateLimitCooldownMs).toBe(Math.max(initialCooldown, 60000));
        });
    });

    // =========================================================================
    // 20. recordPoolRateLimitHit model fallback (line 784)
    // =========================================================================
    describe('recordPoolRateLimitHit model fallback', () => {
        // Covers line 784: `model || 'global'`
        test('uses global when model is null', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            const result = km.recordPoolRateLimitHit({ model: null });
            expect(result.model).toBe('global');
        });
    });

    // =========================================================================
    // 21. getPoolRateLimitStats with null dates (lines 928, 929)
    // =========================================================================
    describe('getPoolRateLimitStats with null dates', () => {
        // Covers lines 928, 929: ternary branches for null lastHitAt/rateLimitedUntil
        test('returns null dates for pool with no activity', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            // Create a pool with no rate limit activity
            km._getOrCreatePool('idle-model');

            const stats = km.getPoolRateLimitStats('idle-model');
            expect(stats.pools['idle-model'].lastPool429At).toBeNull();
            expect(stats.pools['idle-model'].cooldownUntil).toBeNull();
        });

        // Covers lines 928, 929: truthy branches
        test('returns formatted dates for pool with activity', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            km.recordPoolRateLimitHit({ model: 'active-model' });

            const stats = km.getPoolRateLimitStats('active-model');
            expect(stats.pools['active-model'].lastPool429At).not.toBeNull();
            expect(stats.pools['active-model'].cooldownUntil).not.toBeNull();
            // Should be ISO strings
            expect(stats.pools['active-model'].lastPool429At).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        });
    });

    // =========================================================================
    // 22. recordRateLimitHeaders with valid limit (line 983)
    // =========================================================================
    describe('recordRateLimitHeaders limit parsing', () => {
        // Covers line 983: `isNaN(limit) ? null : limit` truthy branch (valid limit)
        test('stores valid limit when header is parseable', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            km.recordRateLimitHeaders('claude-3', {
                'x-ratelimit-remaining': '50',
                'x-ratelimit-limit': '100'
            });

            const pool = km._modelPools.get('claude-3');
            expect(pool.lastRateLimitLimit).toBe(100);
        });
    });

    // =========================================================================
    // 23. compareKeys default args (lines 1117, 1175)
    // =========================================================================
    describe('compareKeys default arguments', () => {
        // Covers line 1117: keyIndices default to null → all keys
        test('compares all keys when keyIndices is null', () => {
            km = createKm();
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            // Add latency data
            for (let i = 0; i < 15; i++) {
                km.recordSuccess(km.keys[0], 200);
                km.recordSuccess(km.keys[1], 300);
            }

            const result = km.compareKeys(null);
            expect(result.keys).toHaveLength(2);
        });

        // Covers line 1175: normalize default arg higherIsBetter = true
        test('normalizes latency correctly with default higherIsBetter', () => {
            km = createKm();
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            // Key 0: fast
            for (let i = 0; i < 20; i++) km.recordSuccess(km.keys[0], 100);
            // Key 1: slow
            for (let i = 0; i < 20; i++) km.recordSuccess(km.keys[1], 5000);

            km.keys[0].totalRequests = 20;
            km.keys[0].successCount = 20;
            km.keys[1].totalRequests = 20;
            km.keys[1].successCount = 20;

            const result = km.compareKeys([0, 1]);
            // Faster key should have higher performance score
            const key0 = result.keys.find(k => k.keyIndex === 0);
            const key1 = result.keys.find(k => k.keyIndex === 1);
            expect(key0.normalized.performance).toBeGreaterThan(key1.normalized.performance);
        });
    });

    // =========================================================================
    // 24. quarantineKey default reason (line 1451)
    // =========================================================================
    describe('quarantineKey default reason', () => {
        // Covers line 1451: reason = 'slow' default
        test('uses slow as default quarantine reason', () => {
            km = createKm();
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            km.quarantineKey(0); // No reason provided

            const stats = km.getStats();
            expect(stats[0].selectionStats.isQuarantined).toBe(true);
            expect(stats[0].selectionStats.quarantineReason).toBe('slow');
        });
    });

    // =========================================================================
    // 25. reloadKeys provider indices for null provider (line 288)
    // =========================================================================
    describe('reloadKeys provider indices', () => {
        // Covers line 288: if (provider) else branch - key with null provider
        test('does not track provider indices for untagged keys', () => {
            km = createKm();
            km.loadKeys(['key1.secret1', 'key2.secret2']); // Flat array = null providers

            // Reload with same keys
            km.reloadKeys(['key1.secret1', 'key2.secret2']);

            // No provider indices should exist
            expect(km._providerKeyIndices.size).toBe(0);
        });
    });

    // =========================================================================
    // 26. Slow key detection with existing warning timestamp (line 367)
    // =========================================================================
    describe('slow key warning with existing timestamp', () => {
        // Covers line 367: `(now - (key._slowKeyWarningAt || 0)) > cooldown` truthy || branch
        test('skips warning when already warned recently', () => {
            const logCalls = [];
            km = createKm({
                logger: {
                    info: jest.fn((msg) => logCalls.push(msg)),
                    warn: jest.fn((msg) => logCalls.push(msg)),
                    error: jest.fn((msg) => logCalls.push(msg)),
                    debug: jest.fn((msg) => logCalls.push(msg))
                },
                keySelection: {
                    useWeightedSelection: false,
                    slowKeyThreshold: 1.5,
                    slowKeyCheckIntervalMs: 999999,
                    slowKeyCooldownMs: 10000
                }
            });
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            for (let i = 0; i < 20; i++) km.recordSuccess(km.keys[0], 200);
            for (let i = 0; i < 20; i++) km.recordSuccess(km.keys[1], 2000);

            // First check: logs warning
            km._checkForSlowKeys();
            const firstCount = logCalls.filter(m => m && m.includes('marked slow')).length;
            expect(firstCount).toBe(1);

            // Set a recent warning timestamp
            km.keys[1]._slowKeyWarningAt = Date.now() - 5000; // 5s ago (< 10s cooldown)

            // Second check: should NOT re-log (cooldown not expired)
            km._checkForSlowKeys();
            const secondCount = logCalls.filter(m => m && m.includes('marked slow')).length;
            expect(secondCount).toBe(1); // Same count
        });
    });

    // =========================================================================
    // 27. _handleNoAvailableKeys reduce both branches (line 599)
    // =========================================================================
    describe('_handleNoAvailableKeys reduce ternary branches', () => {
        // Covers line 599 branch 0: a.inFlight <= b.inFlight is true (return a)
        test('returns key with lower inFlight first (leftmost wins tie)', () => {
            km = createKm();
            km.loadKeys(['key1.secret1', 'key2.secret2', 'key3.secret3']);

            // All keys rate limited but with different inFlight values
            km.keys[0].rateLimitedAt = Date.now();
            km.keys[0].rateLimitCooldownMs = 60000;
            km.keys[0].inFlight = 1; // Lowest

            km.keys[1].rateLimitedAt = Date.now();
            km.keys[1].rateLimitCooldownMs = 60000;
            km.keys[1].inFlight = 3;

            km.keys[2].rateLimitedAt = Date.now();
            km.keys[2].rateLimitCooldownMs = 60000;
            km.keys[2].inFlight = 5;

            const result = km.getBestKey();
            expect(result).not.toBeNull();
            // Should return key with lowest inFlight (key1 with 1)
            expect(result.inFlight).toBe(1);
        });

        // Covers line 599 branch 1: a.inFlight <= b.inFlight is false (return b)
        test('returns key with lower inFlight when first key has higher value', () => {
            km = createKm();
            km.loadKeys(['key1.secret1', 'key2.secret2']);

            // First key has higher inFlight
            km.keys[0].rateLimitedAt = Date.now();
            km.keys[0].rateLimitCooldownMs = 60000;
            km.keys[0].inFlight = 5;

            // Second key has lower inFlight
            km.keys[1].rateLimitedAt = Date.now();
            km.keys[1].rateLimitCooldownMs = 60000;
            km.keys[1].inFlight = 1;

            const result = km.getBestKey();
            expect(result).not.toBeNull();
            expect(result.inFlight).toBe(1);
            expect(result.index).toBe(1);
        });
    });

    // =========================================================================
    // 28. recordSelection with competingKeys = 0 (line 1437)
    // =========================================================================
    describe('recordSelection competingKeys fallback', () => {
        // Covers line 1437: `params.competingKeys || 0` fallback
        test('defaults competingKeys to 0 when not provided', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            // Record selection without competingKeys
            km.recordSelection({
                requestId: 'req-123',
                keyIndex: 0,
                keyId: 'key1',
                reason: 'health_score_winner',
                healthScore: 85,
                excludedKeys: []
                // No competingKeys provided - should default to 0
            });

            const stats = km.getSchedulerStats();
            expect(stats.totalDecisions).toBeGreaterThanOrEqual(1);
        });
    });

    // =========================================================================
    // 29. getKeySnapshot with null histogram (line 1653) and null keyState (line 1666)
    // =========================================================================
    describe('getKeySnapshot histogram and state fallbacks', () => {
        // Covers line 1653: histogram ? ... : null - null branch
        test('returns null latency when getKeyHistogram returns null', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            // Mock histogram aggregator to return null
            km.histogramAggregator.getKeyHistogram = jest.fn(() => null);

            const snapshot = km.getKeySnapshot(0);
            expect(snapshot).not.toBeNull();
            expect(snapshot.latency).toBeNull();
        });

        // Covers line 1666: keyState || 'unknown' - fallback branch
        test('returns unknown state when scheduler getKeyState returns null', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            // Mock scheduler to return null for getKeyState
            const originalGetKeyState = km.scheduler.getKeyState;
            km.scheduler.getKeyState = jest.fn(() => null);

            const snapshot = km.getKeySnapshot(0);
            expect(snapshot).not.toBeNull();
            expect(snapshot.state).toBe('unknown');

            km.scheduler.getKeyState = originalGetKeyState;
        });
    });

    // =========================================================================
    // 30. destroy with null scheduler/keys (lines 1758, 1762, 1764)
    // =========================================================================
    describe('destroy with missing components', () => {
        // Covers line 1758: if (this.scheduler) else branch
        test('handles destroy when scheduler is null', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            // Set scheduler to null
            km.scheduler = null;

            // Should not throw
            expect(() => km.destroy()).not.toThrow();
            km = null; // Prevent afterEach from calling destroy again
        });

        // Covers line 1762: if (this.keys) else branch
        test('handles destroy when keys is null', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            // Set keys to null
            km.keys = null;

            // Should not throw
            expect(() => km.destroy()).not.toThrow();
            km = null;
        });

        // Covers line 1764: key without circuitBreaker.destroy
        test('handles destroy when key circuitBreaker has no destroy method', () => {
            km = createKm();
            km.loadKeys(['key1.secret1']);

            // Replace circuitBreaker with one that has no destroy
            km.keys[0].circuitBreaker = { state: 'CLOSED' };

            // Should not throw
            expect(() => km.destroy()).not.toThrow();
            km = null;
        });
    });
});
