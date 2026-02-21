/**
 * Contract Test: Pool Manager
 *
 * This contract test ensures that pool state management produces consistent results
 * after extraction from KeyManager to pool-manager.js.
 *
 * TDD Phase: Red - Write failing test first
 */

'use strict';

const { PoolManager } = require('../../lib/key-management/pool-manager');

describe('KeyManager Contract: Pool State Management', () => {
    describe('per-model pool isolation', () => {
        it('should isolate Model A cooldown from Model B', () => {
            const config = {
                baseMs: 500,
                capMs: 5000,
                decayMs: 10000
            };
            const manager = new PoolManager(config);

            // Set cooldown for Model A
            manager.setPoolCooldown('model-a', { count: 2 });

            // Model B should not be affected
            const cooldownA = manager.getPoolCooldownRemainingMs('model-a');
            const cooldownB = manager.getPoolCooldownRemainingMs('model-b');

            expect(cooldownA).toBeGreaterThan(0);
            expect(cooldownB).toBe(0);
        });

        it('should track pool state independently per model', () => {
            const manager = new PoolManager();

            // Record rate limit hit for model-a
            manager.recordPoolRateLimitHit('model-a');

            // Record rate limit hit for model-b
            manager.recordPoolRateLimitHit('model-b');

            const statsA = manager.getPoolState('model-a');
            const statsB = manager.getPoolState('model-b');

            expect(statsA.pool429Count).toBe(1);
            expect(statsB.pool429Count).toBe(1);
            expect(statsA.isRateLimited).toBe(true);
            expect(statsB.isRateLimited).toBe(true);
        });
    });

    describe('should handle global pool', () => {
        it('should return null model for global pool', () => {
            const manager = new PoolManager();

            const state = manager.getPoolState(null);

            expect(state).toHaveProperty('rateLimitedUntil');
            expect(state).toHaveProperty('count');
            expect(state).toHaveProperty('lastHitAt');
        });

        it('should set cooldown for global pool', () => {
            const manager = new PoolManager();

            manager.setPoolCooldown(null, { count: 1 });

            const cooldown = manager.getPoolCooldownRemainingMs(null);
            expect(cooldown).toBeGreaterThan(0);
        });
    });

    describe('exponential backoff with cap', () => {
        it('should apply exponential backoff', () => {
            const config = { baseMs: 500, capMs: 5000, decayMs: 10000 };
            const manager = new PoolManager(config);

            manager.recordPoolRateLimitHit('test-model');
            const cooldown1 = manager.getPoolCooldownRemainingMs('test-model');

            manager.recordPoolRateLimitHit('test-model');
            const cooldown2 = manager.getPoolCooldownRemainingMs('test-model');

            expect(cooldown2).toBeGreaterThan(cooldown1);
        });

        it('should cap cooldown at configured maximum', () => {
            const config = { baseMs: 500, capMs: 2000, decayMs: 10000 };
            const manager = new PoolManager(config);

            // Record enough hits to exceed cap
            for (let i = 0; i < 10; i++) {
                manager.recordPoolRateLimitHit('test-model');
            }

            const cooldown = manager.getPoolCooldownRemainingMs('test-model');
            // Account for ±15% jitter applied by setPoolCooldown
            expect(cooldown).toBeLessThanOrEqual(2300);
        });
    });

    describe('count decay', () => {
        it('should decay count after decayMs period', () => {
            const config = { baseMs: 500, capMs: 5000, decayMs: 100 };
            const manager = new PoolManager(config);

            manager.recordPoolRateLimitHit('test-model');
            expect(manager.getPoolState('test-model').pool429Count).toBe(1);

            // Wait for decay
            const deadline = Date.now() + 150;
            while (Date.now() < deadline) {
                // Small delay
            }

            manager.recordPoolRateLimitHit('test-model');
            // Count should have reset and started at 1 again
            expect(manager.getPoolState('test-model').pool429Count).toBe(1);
        });
    });

    describe('pacing delay from headers', () => {
        it('should set pacing delay when remaining is low', () => {
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

        it('should not set pacing when remaining is high', () => {
            const manager = new PoolManager();

            manager.recordRateLimitHeaders('test-model', {
                'x-ratelimit-remaining': '50'
            }, {
                remainingThreshold: 5,
                pacingDelayMs: 200
            });

            const pacing = manager.getModelPacingDelayMs('test-model');
            expect(pacing).toBe(0);
        });
    });
});
