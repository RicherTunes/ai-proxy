'use strict';

const { PoolManager } = require('../lib/key-management/pool-manager');

describe('PoolManager edge cases', () => {
    // ---------------------------------------------------------------
    // 1. Pacing urgency formula
    // ---------------------------------------------------------------
    describe('pacing urgency formula', () => {
        it('urgency should be 1.0 when remaining=0', () => {
            const pm = new PoolManager();

            pm.recordRateLimitHeaders('m1', {
                'x-ratelimit-remaining': '0',
                'x-ratelimit-limit': '100'
            }, {
                remainingThreshold: 5,
                pacingDelayMs: 200
            });

            // urgency = 1 - (0 / max(5,1)) = 1.0
            // delay = round(200 * 1.0) = 200
            const state = pm.getPoolState('m1');
            expect(state.lastRateLimitRemaining).toBe(0);

            // The pacing delay should be the full pacingDelayMs (200ms)
            const pacing = pm.getModelPacingDelayMs('m1');
            // Allow a small margin for elapsed time between calls
            expect(pacing).toBeGreaterThan(0);
            expect(pacing).toBeLessThanOrEqual(200);
        });

        it('urgency should be 0 when remaining=threshold', () => {
            const pm = new PoolManager();

            pm.recordRateLimitHeaders('m1', {
                'x-ratelimit-remaining': '5',
                'x-ratelimit-limit': '100'
            }, {
                remainingThreshold: 5,
                pacingDelayMs: 200
            });

            // urgency = 1 - (5 / max(5,1)) = 0
            // delay = round(200 * 0) = 0
            const pacing = pm.getModelPacingDelayMs('m1');
            expect(pacing).toBe(0);
        });

        it('urgency should be 0.5 when remaining is halfway', () => {
            const pm = new PoolManager();

            pm.recordRateLimitHeaders('m1', {
                'x-ratelimit-remaining': '5',
                'x-ratelimit-limit': '100'
            }, {
                remainingThreshold: 10,
                pacingDelayMs: 200
            });

            // urgency = 1 - (5 / max(10,1)) = 0.5
            // delay = round(200 * 0.5) = 100
            const pacing = pm.getModelPacingDelayMs('m1');
            expect(pacing).toBeGreaterThan(0);
            expect(pacing).toBeLessThanOrEqual(100);
        });
    });

    // ---------------------------------------------------------------
    // 2. Pacing urgency with threshold=0  (division-by-zero guard)
    // ---------------------------------------------------------------
    describe('pacing urgency with threshold=0', () => {
        it('should not crash when remainingThreshold=0 and remaining=0', () => {
            const pm = new PoolManager();

            // The guard is Math.max(remainingThreshold, 1) which prevents /0
            expect(() => {
                pm.recordRateLimitHeaders('m1', {
                    'x-ratelimit-remaining': '0',
                    'x-ratelimit-limit': '10'
                }, {
                    remainingThreshold: 0,
                    pacingDelayMs: 200
                });
            }).not.toThrow();
        });

        it('should skip pacing when remaining > threshold=0', () => {
            const pm = new PoolManager();

            pm.recordRateLimitHeaders('m1', {
                'x-ratelimit-remaining': '3',
                'x-ratelimit-limit': '10'
            }, {
                remainingThreshold: 0,
                pacingDelayMs: 200
            });

            // remaining(3) > threshold(0), so no pacing
            const pacing = pm.getModelPacingDelayMs('m1');
            expect(pacing).toBe(0);
        });
    });

    // ---------------------------------------------------------------
    // 3. recordRateLimitHeaders with pacingUntil guard
    // ---------------------------------------------------------------
    describe('recordRateLimitHeaders pacingUntil guard', () => {
        it('should only update rateLimitedUntil if new pacingUntil > current', () => {
            const pm = new PoolManager();

            // First: force a long cooldown via rate-limit hit
            pm.recordPoolRateLimitHit('m1', { baseMs: 5000, capMs: 10000 });
            const stateBefore = pm.getPoolState('m1');
            expect(stateBefore.isRateLimited).toBe(true);

            const beforeCooldown = stateBefore.cooldownRemainingMs;

            // Now record headers with a small pacing delay — should NOT reduce cooldown
            pm.recordRateLimitHeaders('m1', {
                'x-ratelimit-remaining': '2'
            }, {
                remainingThreshold: 5,
                pacingDelayMs: 10  // only 10ms, far less than existing cooldown
            });

            const stateAfter = pm.getPoolState('m1');
            // Cooldown should remain at (roughly) the same level, not be reduced
            expect(stateAfter.cooldownRemainingMs).toBeGreaterThanOrEqual(beforeCooldown - 50);
        });

        it('should extend rateLimitedUntil if new pacingUntil > current', () => {
            const pm = new PoolManager();

            // Start with a tiny pacing delay
            pm.recordRateLimitHeaders('m1', {
                'x-ratelimit-remaining': '2'
            }, {
                remainingThreshold: 5,
                pacingDelayMs: 10
            });

            // Now apply a much larger pacing delay
            pm.recordRateLimitHeaders('m1', {
                'x-ratelimit-remaining': '0'
            }, {
                remainingThreshold: 5,
                pacingDelayMs: 5000
            });

            const pacing = pm.getModelPacingDelayMs('m1');
            expect(pacing).toBeGreaterThan(1000);
        });
    });

    // ---------------------------------------------------------------
    // 4. getPoolRateLimitStats with empty map
    // ---------------------------------------------------------------
    describe('getPoolRateLimitStats with empty map', () => {
        it('should return sensible defaults with no pools', () => {
            const pm = new PoolManager();
            const stats = pm.getPoolRateLimitStats();

            expect(stats).toHaveProperty('isRateLimited', false);
            expect(stats).toHaveProperty('cooldownRemainingMs', 0);
            expect(stats).toHaveProperty('pools');
            expect(Object.keys(stats.pools)).toHaveLength(0);
            // pool429Count with empty spread: Math.max(0, ...[]) = -Infinity becomes 0 via Math.max(0,...)
            // Actually Math.max(0, ...[]) === 0 in JS, so:
            expect(stats.pool429Count).toBe(0);
            expect(stats.lastPool429At).toBeNull();
            expect(stats.cooldownUntil).toBeNull();
        });
    });

    // ---------------------------------------------------------------
    // 5. getPoolRateLimitStats with single entry
    // ---------------------------------------------------------------
    describe('getPoolRateLimitStats with single entry', () => {
        it('should return correct min/max/avg for one pool', () => {
            const pm = new PoolManager({ baseMs: 500, capMs: 5000, decayMs: 10000 });

            pm.recordPoolRateLimitHit('only-model');

            const stats = pm.getPoolRateLimitStats();

            expect(stats.isRateLimited).toBe(true);
            expect(stats.cooldownRemainingMs).toBeGreaterThan(0);
            expect(stats.pool429Count).toBe(1);
            expect(stats.lastPool429At).not.toBeNull();
            expect(stats.cooldownUntil).not.toBeNull();

            // Pool detail
            const poolDetail = stats.pools['only-model'];
            expect(poolDetail).toBeDefined();
            expect(poolDetail.isRateLimited).toBe(true);
            expect(poolDetail.cooldownRemainingMs).toBeGreaterThan(0);
            expect(poolDetail.pool429Count).toBe(1);
        });
    });

    // ---------------------------------------------------------------
    // 6. Pool size tracking — adding/removing models
    // ---------------------------------------------------------------
    describe('pool size tracking', () => {
        it('adding models increases pool count', () => {
            const pm = new PoolManager();

            // No pools yet
            expect(pm.getPoolRateLimitStats().pools).toEqual({});

            pm.recordPoolRateLimitHit('model-a');
            expect(Object.keys(pm.getPoolRateLimitStats().pools)).toHaveLength(1);

            pm.recordPoolRateLimitHit('model-b');
            expect(Object.keys(pm.getPoolRateLimitStats().pools)).toHaveLength(2);

            pm.recordPoolRateLimitHit('model-c');
            expect(Object.keys(pm.getPoolRateLimitStats().pools)).toHaveLength(3);
        });

        it('getPoolState creates pool on demand and increments size', () => {
            const pm = new PoolManager();

            pm.getPoolState('new-model');
            const stats = pm.getPoolRateLimitStats();
            expect(Object.keys(stats.pools)).toHaveLength(1);
            expect(stats.pools['new-model']).toBeDefined();
        });

        it('recording for existing model does not increase pool count', () => {
            const pm = new PoolManager();

            pm.recordPoolRateLimitHit('same-model');
            pm.recordPoolRateLimitHit('same-model');
            pm.recordPoolRateLimitHit('same-model');

            expect(Object.keys(pm.getPoolRateLimitStats().pools)).toHaveLength(1);
        });
    });

    // ---------------------------------------------------------------
    // 7. Rate limit header parsing — valid / invalid values
    // ---------------------------------------------------------------
    describe('rate limit header parsing', () => {
        it('should handle valid integer remaining header', () => {
            const pm = new PoolManager();

            pm.recordRateLimitHeaders('m1', {
                'x-ratelimit-remaining': '3',
                'x-ratelimit-limit': '100',
                'x-ratelimit-reset': '60'
            }, { remainingThreshold: 5, pacingDelayMs: 200 });

            const state = pm.getPoolState('m1');
            expect(state.lastRateLimitRemaining).toBe(3);
            expect(state.lastRateLimitLimit).toBe(100);
            expect(state.lastRateLimitReset).toBe(60);
        });

        it('should ignore non-numeric remaining header (NaN)', () => {
            const pm = new PoolManager();

            pm.recordRateLimitHeaders('m1', {
                'x-ratelimit-remaining': 'abc'
            }, { remainingThreshold: 5, pacingDelayMs: 200 });

            // remaining is NaN → early return, so pool should have defaults
            const state = pm.getPoolState('m1');
            expect(state.lastRateLimitRemaining).toBeNull();
        });

        it('should return early when model is falsy', () => {
            const pm = new PoolManager();

            expect(() => {
                pm.recordRateLimitHeaders(null, { 'x-ratelimit-remaining': '3' });
            }).not.toThrow();

            expect(() => {
                pm.recordRateLimitHeaders('', { 'x-ratelimit-remaining': '3' });
            }).not.toThrow();
        });

        it('should return early when headers is falsy', () => {
            const pm = new PoolManager();

            expect(() => {
                pm.recordRateLimitHeaders('m1', null);
            }).not.toThrow();

            expect(() => {
                pm.recordRateLimitHeaders('m1', undefined);
            }).not.toThrow();
        });

        it('should set limit/reset to null when their headers are non-numeric', () => {
            const pm = new PoolManager();

            pm.recordRateLimitHeaders('m1', {
                'x-ratelimit-remaining': '2',
                'x-ratelimit-limit': 'bad',
                'x-ratelimit-reset': 'bad'
            }, { remainingThreshold: 5, pacingDelayMs: 200 });

            const state = pm.getPoolState('m1');
            expect(state.lastRateLimitRemaining).toBe(2);
            expect(state.lastRateLimitLimit).toBeNull();
            expect(state.lastRateLimitReset).toBeNull();
        });

        it('should handle missing optional headers gracefully', () => {
            const pm = new PoolManager();

            pm.recordRateLimitHeaders('m1', {
                'x-ratelimit-remaining': '1'
                // limit and reset missing
            }, { remainingThreshold: 5, pacingDelayMs: 200 });

            const state = pm.getPoolState('m1');
            expect(state.lastRateLimitRemaining).toBe(1);
            expect(state.lastRateLimitLimit).toBeNull();
            expect(state.lastRateLimitReset).toBeNull();
        });
    });
});
