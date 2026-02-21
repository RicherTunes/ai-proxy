/**
 * Unit Test: Pool Manager Module
 *
 * TDD Phase: Red - Write failing unit test before module exists
 *
 * Tests the PoolManager class which handles pool state and cooldown management.
 */

'use strict';

const { PoolManager } = require('../../lib/key-management/pool-manager');

describe('pool-manager', () => {
    describe('constructor', () => {
        it('should create a new PoolManager with defaults', () => {
            const manager = new PoolManager();
            expect(manager).toBeInstanceOf(PoolManager);
        });

        it('should use provided config', () => {
            const config = { baseMs: 1000, capMs: 10000, decayMs: 5000 };
            const manager = new PoolManager(config);
            expect(manager.config).toEqual(config);
        });

        it('should initialize with empty pools', () => {
            const manager = new PoolManager();
            const stats = manager.getPoolRateLimitStats();
            expect(Object.keys(stats.pools)).toHaveLength(0);
        });
    });

    describe('get or create pool', () => {
        it('should create new pool for model', () => {
            const manager = new PoolManager();
            const state = manager.getPoolState('test-model');

            expect(state).toEqual(expect.objectContaining({
                rateLimitedUntil: expect.any(Number),
                count: 0,
                lastHitAt: 0
            }));
        });

        it('should return existing pool state', () => {
            const manager = new PoolManager();
            const state1 = manager.getPoolState('test-model');
            manager.setPoolCooldown('test-model', { count: 1 });
            const state2 = manager.getPoolState('test-model');

            expect(state1.count).toBe(0);
            expect(state2.count).toBe(1);
        });

        it('should use global pool key when model is null', () => {
            const manager = new PoolManager();
            const state = manager.getPoolState(null);

            expect(state).toHaveProperty('rateLimitedUntil');
            expect(state).toHaveProperty('count');
            expect(state).toHaveProperty('lastHitAt');
        });
    });

    describe('recordPoolRateLimitHit', () => {
        it('should increment pool count on first hit', () => {
            const manager = new PoolManager();
            manager.recordPoolRateLimitHit('test-model');

            const state = manager.getPoolState('test-model');
            expect(state.pool429Count).toBe(1);
        });

        it('should increment count on subsequent hits', () => {
            const manager = new PoolManager();
            manager.recordPoolRateLimitHit('test-model');
            manager.recordPoolRateLimitHit('test-model');

            const state = manager.getPoolState('test-model');
            expect(state.pool429Count).toBe(2);
        });

        it('should set rateLimitedUntil with exponential backoff', () => {
            const config = { baseMs: 500, capMs: 5000, decayMs: 10000 };
            const manager = new PoolManager(config);

            manager.recordPoolRateLimitHit('test-model');
            const cooldown1 = manager.getPoolCooldownRemainingMs('test-model');

            manager.recordPoolRateLimitHit('test-model');
            const cooldown2 = manager.getPoolCooldownRemainingMs('test-model');

            expect(cooldown2).toBeGreaterThan(cooldown1);
        });

        it('should cap cooldown at capMs', () => {
            const config = { baseMs: 500, capMs: 1000, decayMs: 10000 };
            const manager = new PoolManager(config);

            // Record many hits
            for (let i = 0; i < 10; i++) {
                manager.recordPoolRateLimitHit('test-model');
            }

            const cooldown = manager.getPoolCooldownRemainingMs('test-model');
            // Account for ±15% jitter applied by setPoolCooldown
            expect(cooldown).toBeLessThanOrEqual(1150);
        });

        it('should use provided options overrides', () => {
            const config = { baseMs: 500, capMs: 5000, decayMs: 10000 };
            const manager = new PoolManager(config);

            manager.recordPoolRateLimitHit('test-model', {
                baseMs: 200,
                capMs: 1000
            });

            const cooldown = manager.getPoolCooldownRemainingMs('test-model');
            // Account for ±15% jitter applied by setPoolCooldown
            expect(cooldown).toBeLessThanOrEqual(1150);
            expect(cooldown).toBeGreaterThan(0);
        });

        it('should return cooldown info', () => {
            const manager = new PoolManager();
            const result = manager.recordPoolRateLimitHit('test-model');

            expect(result).toHaveProperty('cooldownMs');
            expect(result).toHaveProperty('pool429Count');
            expect(result).toHaveProperty('cooldownUntil');
            expect(result).toHaveProperty('model');
        });
    });

    describe('getPoolCooldownRemainingMs', () => {
        it('should return 0 when pool not rate limited', () => {
            const manager = new PoolManager();
            const remaining = manager.getPoolCooldownRemainingMs('test-model');
            expect(remaining).toBe(0);
        });

        it('should return remaining cooldown for specific model', () => {
            const manager = new PoolManager();
            manager.setPoolCooldown('test-model', { count: 1 });

            const remaining = manager.getPoolCooldownRemainingMs('test-model');
            expect(remaining).toBeGreaterThan(0);
        });

        it('should return max cooldown when no model specified', () => {
            const manager = new PoolManager();
            manager.setPoolCooldown('model-a', { count: 1, baseMs: 1000 });
            manager.setPoolCooldown('model-b', { count: 1, baseMs: 500 });

            const remaining = manager.getPoolCooldownRemainingMs();
            expect(remaining).toBeGreaterThan(0);
        });

        it('should return 0 when model not found', () => {
            const manager = new PoolManager();
            const remaining = manager.getPoolCooldownRemainingMs('nonexistent');
            expect(remaining).toBe(0);
        });
    });

    describe('isPoolRateLimited', () => {
        it('should return false when not rate limited', () => {
            const manager = new PoolManager();
            expect(manager.isPoolRateLimited('test-model')).toBe(false);
        });

        it('should return true when in cooldown', () => {
            const manager = new PoolManager();
            manager.setPoolCooldown('test-model', { count: 1 });
            expect(manager.isPoolRateLimited('test-model')).toBe(true);
        });

        it('should return true if ANY pool is rate limited (no model)', () => {
            const manager = new PoolManager();
            manager.setPoolCooldown('model-a', { count: 1 });
            expect(manager.isPoolRateLimited()).toBe(true);
        });

        it('should return false when no pools rate limited (no model)', () => {
            const manager = new PoolManager();
            expect(manager.isPoolRateLimited()).toBe(false);
        });
    });

    describe('getPoolRateLimitStats', () => {
        it('should return stats for all pools', () => {
            const manager = new PoolManager();
            manager.recordPoolRateLimitHit('model-a');
            manager.recordPoolRateLimitHit('model-b');

            const stats = manager.getPoolRateLimitStats();

            expect(stats).toHaveProperty('isRateLimited');
            expect(stats).toHaveProperty('cooldownRemainingMs');
            expect(stats).toHaveProperty('pools');
            expect(stats.pools).toHaveProperty('model-a');
            expect(stats.pools).toHaveProperty('model-b');
        });

        it('should include pool details in stats', () => {
            const manager = new PoolManager();
            manager.recordPoolRateLimitHit('test-model');

            const stats = manager.getPoolRateLimitStats();
            const poolStats = stats.pools['test-model'];

            expect(poolStats).toHaveProperty('isRateLimited');
            expect(poolStats).toHaveProperty('cooldownRemainingMs');
            expect(poolStats).toHaveProperty('pool429Count');
        });
    });

    describe('recordRateLimitHeaders', () => {
        it('should do nothing when headers missing', () => {
            const manager = new PoolManager();
            manager.recordRateLimitHeaders('test-model', null);
            const state = manager.getPoolState('test-model');
            expect(state.rateLimitedUntil).toBe(0);
        });

        it('should do nothing when remaining is NaN', () => {
            const manager = new PoolManager();
            manager.recordRateLimitHeaders('test-model', {
                'x-ratelimit-remaining': 'invalid'
            });
            const state = manager.getPoolState('test-model');
            expect(state.rateLimitedUntil).toBe(0);
        });

        it('should set pacing delay when remaining <= threshold', () => {
            const manager = new PoolManager();
            manager.recordRateLimitHeaders('test-model', {
                'x-ratelimit-remaining': '3'
            }, {
                remainingThreshold: 5,
                pacingDelayMs: 200
            });

            const pacing = manager.getModelPacingDelayMs('test-model');
            expect(pacing).toBeGreaterThan(0);
        });

        it('should store rate limit info', () => {
            const manager = new PoolManager();
            manager.recordRateLimitHeaders('test-model', {
                'x-ratelimit-remaining': '5',
                'x-ratelimit-limit': '100',
                'x-ratelimit-reset': '60'
            });

            const state = manager.getPoolState('test-model');
            expect(state.lastRateLimitRemaining).toBe(5);
            expect(state.lastRateLimitLimit).toBe(100);
            expect(state.lastRateLimitReset).toBe(60);
        });

        it('should not extend existing cooldown if pacing is shorter', () => {
            const manager = new PoolManager();
            // First set a long cooldown
            manager.setPoolCooldown('test-model', { count: 5, baseMs: 5000 });

            // Then try to set a shorter pacing delay
            manager.recordRateLimitHeaders('test-model', {
                'x-ratelimit-remaining': '1'
            }, {
                remainingThreshold: 5,
                pacingDelayMs: 100
            });

            const newCooldown = manager.getPoolCooldownRemainingMs('test-model');
            // Cooldown should still be close to the original 5000ms (minus jitter and elapsed time)
            // The pacing delay of 100ms should NOT override the longer 5000ms cooldown
            expect(newCooldown).toBeGreaterThan(4000); // Should still have most of the original cooldown
            expect(newCooldown).toBeLessThan(6000); // Should not exceed original + jitter
        });
    });

    describe('getModelPacingDelayMs', () => {
        it('should return 0 when model not found', () => {
            const manager = new PoolManager();
            expect(manager.getModelPacingDelayMs('nonexistent')).toBe(0);
        });

        it('should return 0 when no model specified', () => {
            const manager = new PoolManager();
            expect(manager.getModelPacingDelayMs()).toBe(0);
        });

        it('should return remaining pacing delay', () => {
            const manager = new PoolManager();
            manager.recordRateLimitHeaders('test-model', {
                'x-ratelimit-remaining': '1'
            }, {
                remainingThreshold: 5,
                pacingDelayMs: 500
            });

            const pacing = manager.getModelPacingDelayMs('test-model');
            expect(pacing).toBeGreaterThan(0);
            expect(pacing).toBeLessThanOrEqual(500);
        });
    });

    describe('setPoolCooldown', () => {
        it('should set cooldown for pool', () => {
            const manager = new PoolManager();
            manager.setPoolCooldown('test-model', { count: 1, baseMs: 1000 });

            const remaining = manager.getPoolCooldownRemainingMs('test-model');
            expect(remaining).toBeGreaterThan(0);
            // Account for ±15% jitter applied by setPoolCooldown
            expect(remaining).toBeLessThanOrEqual(1150);
        });

        it('should support custom baseMs', () => {
            const manager = new PoolManager();
            manager.setPoolCooldown('test-model', { count: 1, baseMs: 2000 });

            const remaining = manager.getPoolCooldownRemainingMs('test-model');
            expect(remaining).toBeGreaterThan(0);
            // Account for ±15% jitter applied by setPoolCooldown
            expect(remaining).toBeLessThanOrEqual(2300);
        });
    });

    describe('decay behavior', () => {
        it('should reset count after decay period', (done) => {
            const config = { baseMs: 500, capMs: 5000, decayMs: 50 };
            const manager = new PoolManager(config);

            manager.recordPoolRateLimitHit('test-model');
            expect(manager.getPoolState('test-model').pool429Count).toBe(1);

            // Wait for decay
            setTimeout(() => {
                manager.recordPoolRateLimitHit('test-model');
                const state = manager.getPoolState('test-model');
                expect(state.pool429Count).toBe(1);
                done();
            }, 60);
        });
    });

    describe('per-model isolation contract', () => {
        it('should ensure Model A cooldown does NOT block Model B', () => {
            const manager = new PoolManager();

            // Set cooldown for Model A
            manager.setPoolCooldown('model-a', { count: 1 });

            // Model B should be available
            expect(manager.isPoolRateLimited('model-a')).toBe(true);
            expect(manager.isPoolRateLimited('model-b')).toBe(false);
        });

        it('should track counts independently per model', () => {
            const manager = new PoolManager();

            manager.recordPoolRateLimitHit('model-a');
            manager.recordPoolRateLimitHit('model-a');
            manager.recordPoolRateLimitHit('model-b');

            expect(manager.getPoolState('model-a').pool429Count).toBe(2);
            expect(manager.getPoolState('model-b').pool429Count).toBe(1);
        });
    });

    describe('pool.count cap', () => {
        it('should cap pool.count at MAX_POOL_COUNT after many rapid hits', () => {
            const manager = new PoolManager({ baseMs: 100, capMs: 1000, decayMs: 5000 });

            for (let i = 0; i < 50; i++) {
                manager.recordPoolRateLimitHit('model-a');
            }

            const state = manager.getPoolState('model-a');
            expect(state.pool429Count).toBeLessThanOrEqual(10);
        });

        it('should still produce finite cooldownMs even after many hits', () => {
            const manager = new PoolManager({ baseMs: 100, capMs: 1000, decayMs: 5000 });
            jest.spyOn(Math, 'random').mockReturnValue(0.5);

            let lastResult;
            for (let i = 0; i < 100; i++) {
                lastResult = manager.recordPoolRateLimitHit('model-a');
            }

            expect(Number.isFinite(lastResult.cooldownMs)).toBe(true);
            expect(lastResult.cooldownMs).toBeLessThanOrEqual(1000 * 1.15 + 1);
        });
    });
});
