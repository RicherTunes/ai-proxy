/**
 * Coverage Test: PoolManager
 *
 * Surgical coverage tests for lib/key-management/pool-manager.js
 * Target lines: 99-100, 128, 158
 */

'use strict';

const { PoolManager } = require('../../lib/key-management/pool-manager');

describe('PoolManager coverage gaps', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    describe('setPoolCooldown default options', () => {
        it('should use default options when called with no options arg', () => {
            // Covers line 99-100: setPoolCooldown(model, options = {})
            // When options is undefined, it defaults to {}
            const manager = new PoolManager({ baseMs: 500, capMs: 5000 });

            // Call with only model, no options argument
            manager.setPoolCooldown('test-model');

            const remaining = manager.getPoolCooldownRemainingMs('test-model');
            // Should use default count=1, baseMs=500 from config
            expect(remaining).toBeGreaterThan(0);
            expect(remaining).toBeLessThan(600); // 500 + jitter
        });
    });

    describe('recordPoolRateLimitHit default model', () => {
        it('should use default model=null and return global when called with no args', () => {
            // Covers line 128: recordPoolRateLimitHit(model = null, options = {})
            // Covers line 158: model: model || 'global' returns 'global' when model is null
            const manager = new PoolManager();

            // Call with no arguments - model defaults to null
            const result = manager.recordPoolRateLimitHit();

            expect(result.model).toBe('global');
            expect(result.pool429Count).toBe(1);
            expect(result.cooldownMs).toBeGreaterThan(0);

            // Verify global pool state
            const state = manager.getPoolState(null);
            expect(state.pool429Count).toBe(1);
            expect(state.isRateLimited).toBe(true);
        });
    });
});
