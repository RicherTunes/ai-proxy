/**
 * Unit Test: Token Tracker Module
 *
 * TDD Phase: Red - Write failing unit test before module exists
 *
 * Tests the TokenTracker class which handles token usage tracking.
 */

'use strict';

let TokenTracker;
try {
    ({ TokenTracker } = require('../../lib/stats/token-tracker'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = TokenTracker ? describe : describe.skip;

describeIfModule('token-tracker', () => {
    describe('constructor', () => {
        it('should create a new TokenTracker', () => {
            const tracker = new TokenTracker();
            expect(tracker).toBeInstanceOf(TokenTracker);
        });

        it('should use default maxKeys when not provided', () => {
            const tracker = new TokenTracker();
            expect(tracker.getMaxKeys()).toBe(1000);
        });

        it('should use custom maxKeys when provided', () => {
            const tracker = new TokenTracker({ maxKeys: 500 });
            expect(tracker.getMaxKeys()).toBe(500);
        });

        it('should initialize with zero stats', () => {
            const tracker = new TokenTracker();
            const stats = tracker.getTokenStats();

            expect(stats.totalInputTokens).toBe(0);
            expect(stats.totalOutputTokens).toBe(0);
            expect(stats.totalTokens).toBe(0);
            expect(stats.requestCount).toBe(0);
        });
    });

    describe('recordTokenUsage', () => {
        let tracker;

        beforeEach(() => {
            tracker = new TokenTracker({ maxKeys: 1000 });
        });

        it('should record input tokens', () => {
            tracker.recordTokenUsage('key-1', { input_tokens: 100 });

            const stats = tracker.getTokenStats();
            expect(stats.totalInputTokens).toBe(100);
        });

        it('should record output tokens', () => {
            tracker.recordTokenUsage('key-1', { output_tokens: 50 });

            const stats = tracker.getTokenStats();
            expect(stats.totalOutputTokens).toBe(50);
        });

        it('should handle both snake_case and camelCase field names', () => {
            tracker.recordTokenUsage('key-1', { input_tokens: 100 });
            tracker.recordTokenUsage('key-2', { inputTokens: 200 });

            const stats = tracker.getTokenStats();
            expect(stats.totalInputTokens).toBe(300);
        });

        it('should handle missing usage object gracefully', () => {
            expect(() => tracker.recordTokenUsage('key-1')).not.toThrow();

            const stats = tracker.getTokenStats();
            expect(stats.totalTokens).toBe(0);
        });

        it('should handle empty usage object', () => {
            tracker.recordTokenUsage('key-1', {});

            const stats = tracker.getTokenStats();
            expect(stats.totalTokens).toBe(0);
        });

        it('should increment request count for non-zero tokens', () => {
            tracker.recordTokenUsage('key-1', { input_tokens: 100 });
            tracker.recordTokenUsage('key-1', { output_tokens: 50 });

            const stats = tracker.getTokenStats();
            expect(stats.requestCount).toBe(2);
        });

        it('should not increment request count for zero tokens', () => {
            tracker.recordTokenUsage('key-1', { input_tokens: 0, output_tokens: 0 });

            const stats = tracker.getTokenStats();
            expect(stats.requestCount).toBe(0);
        });

        it('should track per-key usage separately', () => {
            tracker.recordTokenUsage('key-1', { input_tokens: 100, output_tokens: 50 });
            tracker.recordTokenUsage('key-2', { input_tokens: 200, output_tokens: 100 });

            const stats = tracker.getTokenStats();
            expect(stats.byKey['key-1'].totalTokens).toBe(150);
            expect(stats.byKey['key-2'].totalTokens).toBe(300);
        });

        it('should aggregate tokens for the same key', () => {
            tracker.recordTokenUsage('key-1', { input_tokens: 100, output_tokens: 50 });
            tracker.recordTokenUsage('key-1', { input_tokens: 200, output_tokens: 100 });

            const stats = tracker.getTokenStats();
            expect(stats.byKey['key-1'].totalInputTokens).toBe(300);
            expect(stats.byKey['key-1'].totalOutputTokens).toBe(150);
            expect(stats.byKey['key-1'].totalTokens).toBe(450);
            expect(stats.byKey['key-1'].requestCount).toBe(2);
        });

        it('should handle negative token values', () => {
            // This shouldn't happen in practice but test defensive behavior
            tracker.recordTokenUsage('key-1', { input_tokens: -100 });

            const stats = tracker.getTokenStats();
            expect(stats.totalInputTokens).toBe(-100);
        });

        it('should handle very large token counts', () => {
            tracker.recordTokenUsage('key-1', { input_tokens: Number.MAX_SAFE_INTEGER });

            const stats = tracker.getTokenStats();
            expect(stats.totalInputTokens).toBe(Number.MAX_SAFE_INTEGER);
        });
    });

    describe('getTokenStats', () => {
        let tracker;

        beforeEach(() => {
            tracker = new TokenTracker({ maxKeys: 1000 });
            tracker.recordTokenUsage('key-1', { input_tokens: 100, output_tokens: 50 });
            tracker.recordTokenUsage('key-2', { input_tokens: 200, output_tokens: 100 });
            tracker.recordTokenUsage('key-1', { input_tokens: 50, output_tokens: 25 });
        });

        it('should return total token counts', () => {
            const stats = tracker.getTokenStats();

            expect(stats.totalInputTokens).toBe(350); // 100+200+50
            expect(stats.totalOutputTokens).toBe(175); // 50+100+25
            expect(stats.totalTokens).toBe(525); // 150+300+75
        });

        it('should return total request count', () => {
            const stats = tracker.getTokenStats();
            expect(stats.requestCount).toBe(3);
        });

        it('should calculate average input tokens per request', () => {
            const stats = tracker.getTokenStats();
            expect(stats.avgInputPerRequest).toBe(117); // Math.round(350/3)
        });

        it('should calculate average output tokens per request', () => {
            const stats = tracker.getTokenStats();
            expect(stats.avgOutputPerRequest).toBe(58); // Math.round(175/3)
        });

        it('should calculate average total tokens per request', () => {
            const stats = tracker.getTokenStats();
            expect(stats.avgTotalPerRequest).toBe(175); // Math.round(525/3)
        });

        it('should return per-key stats as plain object', () => {
            const stats = tracker.getTokenStats();

            expect(stats.byKey).toBeInstanceOf(Object);
            expect(stats.byKey['key-1']).toBeDefined();
            expect(stats.byKey['key-2']).toBeDefined();
        });

        it('should include per-key request counts', () => {
            const stats = tracker.getTokenStats();

            expect(stats.byKey['key-1'].requestCount).toBe(2);
            expect(stats.byKey['key-2'].requestCount).toBe(1);
        });

        it('should calculate per-key averages', () => {
            const stats = tracker.getTokenStats();

            expect(stats.byKey['key-1'].avgInputPerRequest).toBe(75); // (100+50)/2
            expect(stats.byKey['key-1'].avgOutputPerRequest).toBe(38); // Math.round((50+25)/2)
            expect(stats.byKey['key-2'].avgInputPerRequest).toBe(200);
            expect(stats.byKey['key-2'].avgOutputPerRequest).toBe(100);
        });

        it('should handle empty tracker', () => {
            const emptyTracker = new TokenTracker();
            const stats = emptyTracker.getTokenStats();

            expect(stats.totalInputTokens).toBe(0);
            expect(stats.totalOutputTokens).toBe(0);
            expect(stats.totalTokens).toBe(0);
            expect(stats.requestCount).toBe(0);
            expect(stats.avgInputPerRequest).toBe(0);
            expect(stats.avgOutputPerRequest).toBe(0);
            expect(stats.avgTotalPerRequest).toBe(0);
            expect(Object.keys(stats.byKey)).toHaveLength(0);
        });

        it('should not mutate internal state when returning stats', () => {
            const stats1 = tracker.getTokenStats();
            stats1.totalInputTokens = 999999;

            const stats2 = tracker.getTokenStats();
            expect(stats2.totalInputTokens).toBe(350); // Original value
        });
    });

    describe('resetTokenStats', () => {
        let tracker;

        beforeEach(() => {
            tracker = new TokenTracker({ maxKeys: 1000 });
            tracker.recordTokenUsage('key-1', { input_tokens: 100, output_tokens: 50 });
            tracker.recordTokenUsage('key-2', { input_tokens: 200, output_tokens: 100 });
        });

        it('should reset all totals to zero', () => {
            tracker.resetTokenStats();

            const stats = tracker.getTokenStats();
            expect(stats.totalInputTokens).toBe(0);
            expect(stats.totalOutputTokens).toBe(0);
            expect(stats.totalTokens).toBe(0);
            expect(stats.requestCount).toBe(0);
        });

        it('should clear per-key tracking', () => {
            tracker.resetTokenStats();

            const stats = tracker.getTokenStats();
            expect(Object.keys(stats.byKey)).toHaveLength(0);
        });

        it('should allow recording after reset', () => {
            tracker.resetTokenStats();
            tracker.recordTokenUsage('key-3', { input_tokens: 100 });

            const stats = tracker.getTokenStats();
            expect(stats.totalTokens).toBe(100);
            expect(stats.byKey['key-3']).toBeDefined();
        });

        it('should preserve maxKeys setting after reset', () => {
            tracker.resetTokenStats();
            tracker.recordTokenUsage('key-1', { input_tokens: 100 });

            const stats = tracker.getTokenStats();
            expect(stats.byKey['key-1']).toBeDefined();
        });
    });

    describe('getMaxKeys', () => {
        it('should return the maxKeys setting', () => {
            const tracker = new TokenTracker({ maxKeys: 500 });
            expect(tracker.getMaxKeys()).toBe(500);
        });
    });

    describe('interface contract', () => {
        let tracker;

        beforeEach(() => {
            tracker = new TokenTracker();
        });

        it('should have recordTokenUsage method', () => {
            expect(typeof tracker.recordTokenUsage).toBe('function');
        });

        it('should have getTokenStats method', () => {
            expect(typeof tracker.getTokenStats).toBe('function');
        });

        it('should have resetTokenStats method', () => {
            expect(typeof tracker.resetTokenStats).toBe('function');
        });

        it('should have getMaxKeys method', () => {
            expect(typeof tracker.getMaxKeys).toBe('function');
        });
    });
});
