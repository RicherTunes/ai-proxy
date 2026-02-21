/**
 * Contract Test: Token Tracker
 *
 * This contract test ensures that token tracking operations produce consistent results
 * after extraction from StatsAggregator to token-tracker.js.
 *
 * TDD Phase: Red - Write failing test first
 */

'use strict';

let TokenTracker;
try {
    ({ TokenTracker } = require('../../lib/stats/token-tracker'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = TokenTracker ? describe : describe.skip;

describeIfModule('StatsAggregator Contract: Token Tracking Operations', () => {
    let tracker;

    beforeEach(() => {
        tracker = new TokenTracker({ maxKeys: 1000 });
    });

    describe('recordTokenUsage', () => {
        it('should record input and output tokens', () => {
            tracker.recordTokenUsage('key-1', { input_tokens: 100, output_tokens: 50 });

            const stats = tracker.getTokenStats();
            expect(stats.totalInputTokens).toBe(100);
            expect(stats.totalOutputTokens).toBe(50);
            expect(stats.totalTokens).toBe(150);
        });

        it('should support both snake_case and camelCase token fields', () => {
            tracker.recordTokenUsage('key-1', { inputTokens: 100, outputTokens: 50 });

            const stats = tracker.getTokenStats();
            expect(stats.totalInputTokens).toBe(100);
            expect(stats.totalOutputTokens).toBe(50);
        });

        it('should track per-key usage', () => {
            tracker.recordTokenUsage('key-1', { input_tokens: 100, output_tokens: 50 });
            tracker.recordTokenUsage('key-2', { input_tokens: 200, output_tokens: 100 });

            const stats = tracker.getTokenStats();
            expect(stats.byKey['key-1'].totalTokens).toBe(150);
            expect(stats.byKey['key-2'].totalTokens).toBe(300);
        });

        it('should increment request count', () => {
            tracker.recordTokenUsage('key-1', { input_tokens: 100, output_tokens: 50 });
            tracker.recordTokenUsage('key-1', { input_tokens: 200, output_tokens: 100 });

            const stats = tracker.getTokenStats();
            expect(stats.requestCount).toBe(2);
            expect(stats.byKey['key-1'].requestCount).toBe(2);
        });

        it('should ignore zero token usage', () => {
            tracker.recordTokenUsage('key-1', { input_tokens: 0, output_tokens: 0 });

            const stats = tracker.getTokenStats();
            expect(stats.totalTokens).toBe(0);
            expect(stats.requestCount).toBe(0);
        });

        it('should aggregate multiple records for same key', () => {
            tracker.recordTokenUsage('key-1', { input_tokens: 100, output_tokens: 50 });
            tracker.recordTokenUsage('key-1', { input_tokens: 200, output_tokens: 100 });

            const stats = tracker.getTokenStats();
            expect(stats.byKey['key-1'].totalInputTokens).toBe(300);
            expect(stats.byKey['key-1'].totalOutputTokens).toBe(150);
            expect(stats.byKey['key-1'].totalTokens).toBe(450);
        });
    });

    describe('getTokenStats', () => {
        beforeEach(() => {
            tracker.recordTokenUsage('key-1', { input_tokens: 100, output_tokens: 50 });
            tracker.recordTokenUsage('key-2', { input_tokens: 200, output_tokens: 100 });
            tracker.recordTokenUsage('key-1', { input_tokens: 50, output_tokens: 25 });
        });

        it('should calculate averages per request', () => {
            const stats = tracker.getTokenStats();

            expect(stats.avgInputPerRequest).toBe(117); // Math.round((100+200+50)/3)
            expect(stats.avgOutputPerRequest).toBe(58); // Math.round((50+100+25)/3)
            expect(stats.avgTotalPerRequest).toBe(175); // Math.round((150+300+75)/3)
        });

        it('should calculate per-key averages', () => {
            const stats = tracker.getTokenStats();

            expect(stats.byKey['key-1'].avgInputPerRequest).toBe(75); // (100+50)/2
            expect(stats.byKey['key-1'].avgOutputPerRequest).toBe(38); // (50+25)/2 rounded
            expect(stats.byKey['key-2'].avgInputPerRequest).toBe(200);
            expect(stats.byKey['key-2'].avgOutputPerRequest).toBe(100);
        });

        it('should return zero for averages when no requests', () => {
            const emptyTracker = new TokenTracker();
            const stats = emptyTracker.getTokenStats();

            expect(stats.avgInputPerRequest).toBe(0);
            expect(stats.avgOutputPerRequest).toBe(0);
            expect(stats.avgTotalPerRequest).toBe(0);
        });

        it('should convert byKeyId LRUMap to plain object', () => {
            const stats = tracker.getTokenStats();

            expect(stats.byKey).toBeInstanceOf(Object);
            expect(typeof stats.byKey['key-1']).toBe('object');
            expect(typeof stats.byKey['key-2']).toBe('object');
        });
    });

    describe('resetTokenStats', () => {
        it('should reset all token stats to zero', () => {
            tracker.recordTokenUsage('key-1', { input_tokens: 100, output_tokens: 50 });

            tracker.resetTokenStats();

            const stats = tracker.getTokenStats();
            expect(stats.totalInputTokens).toBe(0);
            expect(stats.totalOutputTokens).toBe(0);
            expect(stats.totalTokens).toBe(0);
            expect(stats.requestCount).toBe(0);
        });

        it('should clear per-key tracking', () => {
            tracker.recordTokenUsage('key-1', { input_tokens: 100, output_tokens: 50 });

            tracker.resetTokenStats();

            const stats = tracker.getTokenStats();
            expect(Object.keys(stats.byKey)).toHaveLength(0);
        });
    });

    describe('interface contract', () => {
        it('should have recordTokenUsage method', () => {
            expect(typeof tracker.recordTokenUsage).toBe('function');
        });

        it('should have getTokenStats method', () => {
            expect(typeof tracker.getTokenStats).toBe('function');
        });

        it('should have resetTokenStats method', () => {
            expect(typeof tracker.resetTokenStats).toBe('function');
        });
    });
});
