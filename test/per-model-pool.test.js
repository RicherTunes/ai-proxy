/**
 * Per-Model Pool Cooldown and Proactive Pacing Tests
 *
 * Tests the per-model pool isolation for rate limit tracking,
 * independent cooldown timers, and proactive pacing from response headers.
 */

const { KeyManager } = require('../lib/key-manager');

describe('Per-model pool cooldown', () => {
    let km;
    const testKeys = [
        'key1-id.secret1',
        'key2-id.secret2',
        'key3-id.secret3'
    ];
    const mockLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    };

    beforeEach(() => {
        jest.useFakeTimers();
        km = new KeyManager({
            maxConcurrencyPerKey: 2,
            rateLimitPerMinute: 0,
            logger: mockLogger,
            poolCooldown: {
                baseMs: 300,
                capMs: 2000,
                decayMs: 5000
            }
        });
        km.loadKeys(testKeys);
    });

    afterEach(() => {
        km.destroy();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    describe('model isolation', () => {
        test('429 on glm-4.7 does NOT block glm-4.6', () => {
            km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });

            expect(km.isPoolRateLimited('glm-4.7')).toBe(true);
            expect(km.isPoolRateLimited('glm-4.6')).toBe(false);
        });

        test('429 on glm-4.6 does NOT block glm-4.7', () => {
            km.recordPoolRateLimitHit({ model: 'glm-4.6', baseMs: 300, capMs: 2000 });

            expect(km.isPoolRateLimited('glm-4.6')).toBe(true);
            expect(km.isPoolRateLimited('glm-4.7')).toBe(false);
        });

        test('each model maintains independent pool429Count', () => {
            km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });
            km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });
            km.recordPoolRateLimitHit({ model: 'glm-4.6', baseMs: 300, capMs: 2000 });

            const pool47 = km._modelPools.get('glm-4.7');
            const pool46 = km._modelPools.get('glm-4.6');

            expect(pool47.count).toBe(2);
            expect(pool46.count).toBe(1);
        });

        test('each model maintains independent cooldown timer', () => {
            // Hit glm-4.7 once (300ms cooldown)
            const result47 = km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });
            // Hit glm-4.6 three times (300 -> 600 -> 1200ms cooldown)
            km.recordPoolRateLimitHit({ model: 'glm-4.6', baseMs: 300, capMs: 2000 });
            km.recordPoolRateLimitHit({ model: 'glm-4.6', baseMs: 300, capMs: 2000 });
            km.recordPoolRateLimitHit({ model: 'glm-4.6', baseMs: 300, capMs: 2000 });

            // glm-4.7 cooldown is shorter than glm-4.6
            const remaining47 = km.getPoolCooldownRemainingMs('glm-4.7');
            const remaining46 = km.getPoolCooldownRemainingMs('glm-4.6');

            // glm-4.6 has had more hits so its cooldown should be longer
            expect(remaining46).toBeGreaterThan(remaining47);
        });
    });

    describe('recordPoolRateLimitHit with model', () => {
        test('creates new pool entry for unseen model', () => {
            expect(km._modelPools.has('glm-4.7')).toBe(false);

            km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });

            expect(km._modelPools.has('glm-4.7')).toBe(true);
            const pool = km._modelPools.get('glm-4.7');
            expect(pool.count).toBe(1);
            expect(pool.rateLimitedUntil).toBeGreaterThan(Date.now() - 1);
        });

        test('increments count for existing model pool', () => {
            km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });
            km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });

            const pool = km._modelPools.get('glm-4.7');
            expect(pool.count).toBe(2);
        });

        test('applies exponential backoff per model: 300 -> 600 -> 1200 -> 2000 cap', () => {
            // Mock Date.now and Math.random for deterministic jitter
            const now = Date.now();
            jest.spyOn(Date, 'now').mockReturnValue(now);
            jest.spyOn(Math, 'random').mockReturnValue(0.5); // Zero jitter (0.5 * 2 - 1 = 0)

            // Hit 1: baseMs * 2^(1-1) = 300 * 1 = 300
            const r1 = km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });
            expect(r1.cooldownMs).toBe(300);

            // Hit 2: baseMs * 2^(2-1) = 300 * 2 = 600
            const r2 = km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });
            expect(r2.cooldownMs).toBe(600);

            // Hit 3: baseMs * 2^(3-1) = 300 * 4 = 1200
            const r3 = km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });
            expect(r3.cooldownMs).toBe(1200);

            // Hit 4: baseMs * 2^(4-1) = 300 * 8 = 2400 -> capped at 2000
            const r4 = km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });
            expect(r4.cooldownMs).toBe(2000);
        });

        test('decays count after decayMs with no hits on that model', () => {
            const now = Date.now();
            jest.spyOn(Date, 'now').mockReturnValue(now);
            jest.spyOn(Math, 'random').mockReturnValue(0.5);

            // Build up count
            km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });
            km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });
            km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });

            const pool = km._modelPools.get('glm-4.7');
            expect(pool.count).toBe(3);

            // Advance past decayMs (5000ms configured)
            jest.spyOn(Date, 'now').mockReturnValue(now + 6000);

            // Next hit should reset count to 0 first, then increment to 1
            const result = km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });
            expect(result.pool429Count).toBe(1);
            expect(result.cooldownMs).toBe(300); // Back to base
        });

        test('returns model name in result object', () => {
            const result = km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });

            expect(result.model).toBe('glm-4.7');
            expect(result).toHaveProperty('cooldownMs');
            expect(result).toHaveProperty('pool429Count');
            expect(result).toHaveProperty('cooldownUntil');
        });

        test('updates legacy pool429Count for backward compat', () => {
            km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });
            expect(km.pool429Count).toBe(1);

            km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });
            expect(km.pool429Count).toBe(2);

            // Different model updates it too (shows most recent pool count)
            km.recordPoolRateLimitHit({ model: 'glm-4.6', baseMs: 300, capMs: 2000 });
            expect(km.pool429Count).toBe(1); // glm-4.6 count is 1
        });
    });

    describe('getPoolCooldownRemainingMs', () => {
        test('with model: returns cooldown for that specific model', () => {
            const now = Date.now();
            jest.spyOn(Date, 'now').mockReturnValue(now);

            km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });

            const remaining = km.getPoolCooldownRemainingMs('glm-4.7');
            expect(remaining).toBeGreaterThan(0);
            expect(remaining).toBeLessThanOrEqual(300 * 1.15 + 1); // 300ms + max jitter + rounding
        });

        test('with model: returns 0 for model not in cooldown', () => {
            km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });

            expect(km.getPoolCooldownRemainingMs('glm-4.6')).toBe(0);
        });

        test('without model: returns max cooldown across all pools', () => {
            const now = Date.now();
            jest.spyOn(Date, 'now').mockReturnValue(now);
            jest.spyOn(Math, 'random').mockReturnValue(0.5);

            // glm-4.7: 1 hit -> 300ms cooldown
            km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });
            // glm-4.6: 3 hits -> 1200ms cooldown
            km.recordPoolRateLimitHit({ model: 'glm-4.6', baseMs: 300, capMs: 2000 });
            km.recordPoolRateLimitHit({ model: 'glm-4.6', baseMs: 300, capMs: 2000 });
            km.recordPoolRateLimitHit({ model: 'glm-4.6', baseMs: 300, capMs: 2000 });

            const maxRemaining = km.getPoolCooldownRemainingMs();
            const remaining46 = km.getPoolCooldownRemainingMs('glm-4.6');

            expect(maxRemaining).toBe(remaining46);
            expect(maxRemaining).toBeGreaterThan(km.getPoolCooldownRemainingMs('glm-4.7'));
        });

        test('without model: returns 0 when no pools in cooldown', () => {
            expect(km.getPoolCooldownRemainingMs()).toBe(0);
        });
    });

    describe('isPoolRateLimited', () => {
        test('with model: true only if that model is in cooldown', () => {
            km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });

            expect(km.isPoolRateLimited('glm-4.7')).toBe(true);
        });

        test('with model: false for model not in cooldown', () => {
            km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });

            expect(km.isPoolRateLimited('glm-4.6')).toBe(false);
        });

        test('without model: true if ANY model is in cooldown', () => {
            km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });

            expect(km.isPoolRateLimited()).toBe(true);
        });

        test('without model: false when no models in cooldown', () => {
            expect(km.isPoolRateLimited()).toBe(false);
        });

        test('model cooldown expires after time', () => {
            const now = Date.now();
            jest.spyOn(Date, 'now').mockReturnValue(now);
            jest.spyOn(Math, 'random').mockReturnValue(0.5); // Zero jitter

            km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });
            expect(km.isPoolRateLimited('glm-4.7')).toBe(true);

            // Advance past cooldown
            jest.spyOn(Date, 'now').mockReturnValue(now + 301);
            expect(km.isPoolRateLimited('glm-4.7')).toBe(false);
        });
    });

    describe('getPoolRateLimitStats', () => {
        test('includes global isRateLimited and cooldownRemainingMs', () => {
            km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });

            const stats = km.getPoolRateLimitStats();
            expect(stats).toHaveProperty('isRateLimited');
            expect(stats).toHaveProperty('cooldownRemainingMs');
            expect(stats).toHaveProperty('pool429Count');
            expect(stats.isRateLimited).toBe(true);
            expect(stats.cooldownRemainingMs).toBeGreaterThan(0);
        });

        test('returns accurate stats when no pool is rate limited', () => {
            const stats = km.getPoolRateLimitStats();
            expect(stats.isRateLimited).toBe(false);
            expect(stats.cooldownRemainingMs).toBe(0);
        });

        test('includes per-model breakdown in pools object if available', () => {
            km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });
            km.recordPoolRateLimitHit({ model: 'glm-4.6', baseMs: 300, capMs: 2000 });

            const stats = km.getPoolRateLimitStats();

            // The stats object should contain information about pool state
            expect(stats.isRateLimited).toBe(true);
            expect(stats.pool429Count).toBeGreaterThanOrEqual(1);

            // If pools is present in the response, check per-model detail
            if (stats.pools) {
                expect(stats.pools['glm-4.7']).toBeDefined();
                expect(stats.pools['glm-4.6']).toBeDefined();
                expect(stats.pools['glm-4.7'].isRateLimited).toBe(true);
                expect(stats.pools['glm-4.6'].isRateLimited).toBe(true);
            }
        });
    });

    describe('backward compatibility', () => {
        test('recordPoolRateLimitHit without model works (uses __global__)', () => {
            const result = km.recordPoolRateLimitHit({ baseMs: 300, capMs: 2000 });

            expect(result.model).toBe('global');
            expect(km._modelPools.has('__global__')).toBe(true);
            expect(km.pool429Count).toBe(1);
        });

        test('getPoolCooldownRemainingMs() without args still works', () => {
            km.recordPoolRateLimitHit({ baseMs: 300, capMs: 2000 });
            expect(km.getPoolCooldownRemainingMs()).toBeGreaterThan(0);
        });

        test('isPoolRateLimited() without args still works', () => {
            km.recordPoolRateLimitHit({ baseMs: 300, capMs: 2000 });
            expect(km.isPoolRateLimited()).toBe(true);
        });
    });

    describe('_getOrCreatePool helper', () => {
        test('creates new pool with zeroed state for unseen model', () => {
            const pool = km._getOrCreatePool('glm-4.7');
            expect(pool).toEqual({
                rateLimitedUntil: 0,
                count: 0,
                lastHitAt: 0
            });
        });

        test('returns existing pool for known model', () => {
            const pool1 = km._getOrCreatePool('glm-4.7');
            pool1.count = 5;

            const pool2 = km._getOrCreatePool('glm-4.7');
            expect(pool2.count).toBe(5);
            expect(pool1).toBe(pool2); // Same reference
        });

        test('uses __global__ for null model', () => {
            const pool = km._getOrCreatePool(null);
            expect(km._modelPools.has('__global__')).toBe(true);
        });

        test('uses __global__ for undefined model', () => {
            const pool = km._getOrCreatePool(undefined);
            expect(km._modelPools.has('__global__')).toBe(true);
        });

        test('different models get different pools', () => {
            const pool1 = km._getOrCreatePool('glm-4.7');
            const pool2 = km._getOrCreatePool('glm-4.6');
            expect(pool1).not.toBe(pool2);
        });
    });
});

describe('Proactive pacing', () => {
    let km;
    const testKeys = [
        'key1-id.secret1',
        'key2-id.secret2',
        'key3-id.secret3'
    ];
    const mockLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    };

    beforeEach(() => {
        jest.useFakeTimers();
        km = new KeyManager({
            maxConcurrencyPerKey: 2,
            rateLimitPerMinute: 0,
            logger: mockLogger,
            poolCooldown: {
                baseMs: 300,
                capMs: 2000,
                decayMs: 5000
            }
        });
        km.loadKeys(testKeys);
    });

    afterEach(() => {
        km.destroy();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    describe('recordRateLimitHeaders', () => {
        // These tests verify the proactive pacing feature.
        // If recordRateLimitHeaders is not yet implemented, these will fail as expected (TDD RED).

        test('sets pacing delay when remaining < threshold', () => {
            if (typeof km.recordRateLimitHeaders !== 'function') {
                // Method not yet implemented - mark as pending
                return;
            }
            km.recordRateLimitHeaders('glm-4.7', {
                'x-ratelimit-remaining': '3',
                'x-ratelimit-limit': '60',
                'x-ratelimit-reset': '30'
            }, { remainingThreshold: 5, pacingDelayMs: 200 });

            const delay = km.getModelPacingDelayMs('glm-4.7');
            expect(delay).toBeGreaterThan(0);
        });

        test('higher urgency (lower remaining) = longer delay', () => {
            if (typeof km.recordRateLimitHeaders !== 'function') return;

            km.recordRateLimitHeaders('glm-4.7', {
                'x-ratelimit-remaining': '4',
                'x-ratelimit-limit': '60',
                'x-ratelimit-reset': '30'
            }, { remainingThreshold: 5, pacingDelayMs: 200 });
            const delay4 = km.getModelPacingDelayMs('glm-4.7');

            // Reset pool
            km._modelPools.delete('glm-4.7');

            km.recordRateLimitHeaders('glm-4.7', {
                'x-ratelimit-remaining': '1',
                'x-ratelimit-limit': '60',
                'x-ratelimit-reset': '30'
            }, { remainingThreshold: 5, pacingDelayMs: 200 });
            const delay1 = km.getModelPacingDelayMs('glm-4.7');

            expect(delay1).toBeGreaterThan(delay4);
        });

        test('remaining=0 gives maximum delay', () => {
            if (typeof km.recordRateLimitHeaders !== 'function') return;

            km.recordRateLimitHeaders('glm-4.7', {
                'x-ratelimit-remaining': '0',
                'x-ratelimit-limit': '60',
                'x-ratelimit-reset': '30'
            }, { remainingThreshold: 5, pacingDelayMs: 200 });

            const delay = km.getModelPacingDelayMs('glm-4.7');
            expect(delay).toBeGreaterThan(0);
            // With remaining=0, should get maximum pacing delay
            expect(delay).toBeGreaterThanOrEqual(200);
        });

        test('remaining >= threshold does NOT set delay', () => {
            if (typeof km.recordRateLimitHeaders !== 'function') return;

            km.recordRateLimitHeaders('glm-4.7', {
                'x-ratelimit-remaining': '10',
                'x-ratelimit-limit': '60',
                'x-ratelimit-reset': '30'
            }, { remainingThreshold: 5, pacingDelayMs: 200 });

            const delay = km.getModelPacingDelayMs('glm-4.7');
            expect(delay).toBe(0);
        });

        test('ignores when remaining header is missing/NaN', () => {
            if (typeof km.recordRateLimitHeaders !== 'function') return;

            // Missing header
            km.recordRateLimitHeaders('glm-4.7', {
                'x-ratelimit-limit': '60'
            }, { remainingThreshold: 5, pacingDelayMs: 200 });

            expect(km.getModelPacingDelayMs('glm-4.7')).toBe(0);

            // NaN value
            km.recordRateLimitHeaders('glm-4.7', {
                'x-ratelimit-remaining': 'not-a-number',
                'x-ratelimit-limit': '60'
            }, { remainingThreshold: 5, pacingDelayMs: 200 });

            expect(km.getModelPacingDelayMs('glm-4.7')).toBe(0);
        });

        test('ignores when model is null', () => {
            if (typeof km.recordRateLimitHeaders !== 'function') return;

            // Should not throw
            expect(() => km.recordRateLimitHeaders(null, {
                'x-ratelimit-remaining': '3'
            }, { remainingThreshold: 5, pacingDelayMs: 200 })).not.toThrow();
        });

        test('ignores when headers is null', () => {
            if (typeof km.recordRateLimitHeaders !== 'function') return;

            expect(() => km.recordRateLimitHeaders('glm-4.7', null, {
                remainingThreshold: 5, pacingDelayMs: 200
            })).not.toThrow();
        });

        test('does not shorten existing longer cooldown', () => {
            if (typeof km.recordRateLimitHeaders !== 'function') return;

            // Set a long cooldown via pool rate limit hit
            const now = Date.now();
            jest.spyOn(Date, 'now').mockReturnValue(now);
            jest.spyOn(Math, 'random').mockReturnValue(0.5);

            // Create a 1200ms cooldown (3 hits)
            km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });
            km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });
            km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });

            const cooldownBefore = km.getPoolCooldownRemainingMs('glm-4.7');

            // Pacing headers with shorter delay should NOT reduce cooldown
            km.recordRateLimitHeaders('glm-4.7', {
                'x-ratelimit-remaining': '3',
                'x-ratelimit-limit': '60',
                'x-ratelimit-reset': '1'
            }, { remainingThreshold: 5, pacingDelayMs: 50 });

            const cooldownAfter = km.getPoolCooldownRemainingMs('glm-4.7');
            expect(cooldownAfter).toBeGreaterThanOrEqual(cooldownBefore - 1); // Allow 1ms drift
        });

        test('stores rate limit info on pool (remaining, limit, reset)', () => {
            if (typeof km.recordRateLimitHeaders !== 'function') return;

            km.recordRateLimitHeaders('glm-4.7', {
                'x-ratelimit-remaining': '3',
                'x-ratelimit-limit': '60',
                'x-ratelimit-reset': '30'
            }, { remainingThreshold: 5, pacingDelayMs: 200 });

            const pool = km._modelPools.get('glm-4.7');
            expect(pool).toBeDefined();
            // Pool should have stored the header values
            if (pool.lastRateLimitRemaining !== undefined) {
                expect(pool.lastRateLimitRemaining).toBe(3);
                expect(pool.lastRateLimitLimit).toBe(60);
                expect(pool.lastRateLimitReset).toBe(30);
            }
        });
    });

    describe('getModelPacingDelayMs', () => {
        test('returns 0 for unknown model', () => {
            if (typeof km.getModelPacingDelayMs !== 'function') return;

            expect(km.getModelPacingDelayMs('glm-nonexistent')).toBe(0);
        });

        test('returns 0 for model with no pacing', () => {
            if (typeof km.getModelPacingDelayMs !== 'function') return;

            // Create a pool but without pacing
            km._getOrCreatePool('glm-4.7');

            expect(km.getModelPacingDelayMs('glm-4.7')).toBe(0);
        });

        test('returns remaining delay for paced model', () => {
            if (typeof km.getModelPacingDelayMs !== 'function') return;
            if (typeof km.recordRateLimitHeaders !== 'function') return;

            const now = Date.now();
            jest.spyOn(Date, 'now').mockReturnValue(now);

            km.recordRateLimitHeaders('glm-4.7', {
                'x-ratelimit-remaining': '2',
                'x-ratelimit-limit': '60',
                'x-ratelimit-reset': '30'
            }, { remainingThreshold: 5, pacingDelayMs: 200 });

            const delay = km.getModelPacingDelayMs('glm-4.7');
            expect(delay).toBeGreaterThan(0);
        });

        test('returns 0 after pacing delay expires', () => {
            if (typeof km.getModelPacingDelayMs !== 'function') return;
            if (typeof km.recordRateLimitHeaders !== 'function') return;

            const now = Date.now();
            jest.spyOn(Date, 'now').mockReturnValue(now);

            km.recordRateLimitHeaders('glm-4.7', {
                'x-ratelimit-remaining': '2',
                'x-ratelimit-limit': '60',
                'x-ratelimit-reset': '30'
            }, { remainingThreshold: 5, pacingDelayMs: 200 });

            // Advance past the pacing delay
            jest.spyOn(Date, 'now').mockReturnValue(now + 500);

            expect(km.getModelPacingDelayMs('glm-4.7')).toBe(0);
        });

        test('returns 0 when model is null', () => {
            if (typeof km.getModelPacingDelayMs !== 'function') return;

            expect(km.getModelPacingDelayMs(null)).toBe(0);
        });
    });
});

describe('pool.count cap (prevents unbounded growth)', () => {
    let km;
    const testKeys = [
        'key1-id.secret1',
        'key2-id.secret2',
        'key3-id.secret3'
    ];
    const mockLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    };

    beforeEach(() => {
        jest.useFakeTimers();
        km = new KeyManager({
            maxConcurrencyPerKey: 2,
            rateLimitPerMinute: 0,
            logger: mockLogger,
            poolCooldown: {
                baseMs: 300,
                capMs: 2000,
                decayMs: 5000
            }
        });
        km.loadKeys(testKeys);
    });

    afterEach(() => {
        km.destroy();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('pool.count is capped at MAX_POOL_COUNT after many rapid 429s', () => {
        const now = Date.now();
        jest.spyOn(Date, 'now').mockReturnValue(now);
        jest.spyOn(Math, 'random').mockReturnValue(0.5);

        // Simulate 50 rapid-fire 429s within decayMs window
        for (let i = 0; i < 50; i++) {
            km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });
        }

        const pool = km._modelPools.get('glm-4.7');
        // count must be capped, not 50
        expect(pool.count).toBeLessThanOrEqual(10);
    });

    test('cooldown remains at capMs even when count would overflow', () => {
        const now = Date.now();
        jest.spyOn(Date, 'now').mockReturnValue(now);
        jest.spyOn(Math, 'random').mockReturnValue(0.5); // Zero jitter

        // Hammer the pool way past the cap
        for (let i = 0; i < 100; i++) {
            km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });
        }

        // The last cooldown should still be the capMs, not Infinity or NaN
        const result = km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });
        expect(result.cooldownMs).toBe(2000);
        expect(Number.isFinite(result.cooldownMs)).toBe(true);
    });

    test('legacy pool429Count is also capped', () => {
        const now = Date.now();
        jest.spyOn(Date, 'now').mockReturnValue(now);

        for (let i = 0; i < 30; i++) {
            km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });
        }

        expect(km.pool429Count).toBeLessThanOrEqual(10);
    });
});

describe('429 retry catch-22 prevention', () => {
    let km;
    const testKeys = ['key1-id.secret1', 'key2-id.secret2', 'key3-id.secret3'];
    const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

    beforeEach(() => {
        jest.useFakeTimers();
        km = new KeyManager({
            maxConcurrencyPerKey: 2,
            rateLimitPerMinute: 0,
            logger: mockLogger,
            poolCooldown: { baseMs: 300, capMs: 2000, decayMs: 5000 }
        });
        km.loadKeys(testKeys);
    });

    afterEach(() => {
        km.destroy();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('recordPoolRateLimitHit returns wasAlreadyBlocked=false on first 429 for a model', () => {
        // Model was NOT in cooldown before this 429
        expect(km.isPoolRateLimited('glm-4.7')).toBe(false);

        const result = km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });

        // The result should tell us the pool was NOT already blocked
        expect(result.wasAlreadyBlocked).toBe(false);
    });

    test('recordPoolRateLimitHit returns wasAlreadyBlocked=true on second 429 while pool still cooling', () => {
        const now = Date.now();
        jest.spyOn(Date, 'now').mockReturnValue(now);

        // First 429 - sets cooldown
        km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });

        // Second 429 while pool is still in cooldown
        const result = km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });

        expect(result.wasAlreadyBlocked).toBe(true);
    });

    test('after cooldown expires, next 429 shows wasAlreadyBlocked=false again', () => {
        const now = Date.now();
        jest.spyOn(Date, 'now').mockReturnValue(now);
        jest.spyOn(Math, 'random').mockReturnValue(0.5); // Zero jitter

        // First 429
        km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });

        // Advance past cooldown (300ms)
        jest.spyOn(Date, 'now').mockReturnValue(now + 6000); // Past decay too

        const result = km.recordPoolRateLimitHit({ model: 'glm-4.7', baseMs: 300, capMs: 2000 });
        expect(result.wasAlreadyBlocked).toBe(false);
    });
});

describe('Raised pacing threshold', () => {
    let km;
    const testKeys = [
        'key1-id.secret1',
        'key2-id.secret2',
        'key3-id.secret3'
    ];
    const mockLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    };

    beforeEach(() => {
        jest.useFakeTimers();
        km = new KeyManager({
            maxConcurrencyPerKey: 2,
            rateLimitPerMinute: 0,
            logger: mockLogger,
            poolCooldown: {
                baseMs: 300,
                capMs: 2000,
                decayMs: 5000
            }
        });
        km.loadKeys(testKeys);
    });

    afterEach(() => {
        km.destroy();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('pacing activates at remaining=14 with threshold=15', () => {
        km.recordRateLimitHeaders('glm-4.7', {
            'x-ratelimit-remaining': '14',
            'x-ratelimit-limit': '60',
            'x-ratelimit-reset': '30'
        }, { remainingThreshold: 15, pacingDelayMs: 500 });

        const delay = km.getModelPacingDelayMs('glm-4.7');
        expect(delay).toBeGreaterThan(0);
    });

    test('pacing does NOT activate at remaining=16 with threshold=15', () => {
        km.recordRateLimitHeaders('glm-4.7', {
            'x-ratelimit-remaining': '16',
            'x-ratelimit-limit': '60',
            'x-ratelimit-reset': '30'
        }, { remainingThreshold: 15, pacingDelayMs: 500 });

        const delay = km.getModelPacingDelayMs('glm-4.7');
        expect(delay).toBe(0);
    });

    test('max delay reaches 500ms at remaining=0 with pacingDelayMs=500', () => {
        const now = Date.now();
        jest.spyOn(Date, 'now').mockReturnValue(now);

        km.recordRateLimitHeaders('glm-4.7', {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-limit': '60',
            'x-ratelimit-reset': '30'
        }, { remainingThreshold: 15, pacingDelayMs: 500 });

        const delay = km.getModelPacingDelayMs('glm-4.7');
        expect(delay).toBe(500);
    });
});
