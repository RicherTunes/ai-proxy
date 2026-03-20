/**
 * Edge-case tests for TokenTracker
 *
 * Covers: accumulation, initialization, reset semantics, multi-key tracking,
 * very large token counts, zero tokens, and token summary aggregation.
 */

'use strict';

const { TokenTracker } = require('../../lib/stats/token-tracker');

describe('token-tracker edge cases', () => {
    // ---------------------------------------------------------------
    // 1. Accumulation path — same key recorded twice, cumulative totals
    // ---------------------------------------------------------------
    describe('accumulation path', () => {
        it('should accumulate input and output tokens across two calls for the same key', () => {
            const tracker = new TokenTracker();

            tracker.recordTokenUsage('key-A', { input_tokens: 100, output_tokens: 40 });
            tracker.recordTokenUsage('key-A', { input_tokens: 250, output_tokens: 60 });

            const stats = tracker.getTokenStats();

            // Global totals
            expect(stats.totalInputTokens).toBe(350);
            expect(stats.totalOutputTokens).toBe(100);
            expect(stats.totalTokens).toBe(450);
            expect(stats.requestCount).toBe(2);

            // Per-key totals
            const keyA = stats.byKey['key-A'];
            expect(keyA.totalInputTokens).toBe(350);
            expect(keyA.totalOutputTokens).toBe(100);
            expect(keyA.totalTokens).toBe(450);
            expect(keyA.requestCount).toBe(2);
        });

        it('should accumulate correctly across three calls', () => {
            const tracker = new TokenTracker();

            tracker.recordTokenUsage('key-B', { input_tokens: 10, output_tokens: 5 });
            tracker.recordTokenUsage('key-B', { input_tokens: 20, output_tokens: 10 });
            tracker.recordTokenUsage('key-B', { input_tokens: 30, output_tokens: 15 });

            const stats = tracker.getTokenStats();
            expect(stats.byKey['key-B'].totalInputTokens).toBe(60);
            expect(stats.byKey['key-B'].totalOutputTokens).toBe(30);
            expect(stats.byKey['key-B'].requestCount).toBe(3);
        });
    });

    // ---------------------------------------------------------------
    // 2. Initialization path — new key creates fresh entry
    // ---------------------------------------------------------------
    describe('initialization path', () => {
        it('should create a fresh per-key entry on first record', () => {
            const tracker = new TokenTracker();

            tracker.recordTokenUsage('brand-new-key', { input_tokens: 77, output_tokens: 33 });

            const stats = tracker.getTokenStats();
            const entry = stats.byKey['brand-new-key'];

            expect(entry).toBeDefined();
            expect(entry.totalInputTokens).toBe(77);
            expect(entry.totalOutputTokens).toBe(33);
            expect(entry.totalTokens).toBe(110);
            expect(entry.requestCount).toBe(1);
        });

        it('should not have entries for keys that were never recorded', () => {
            const tracker = new TokenTracker();

            tracker.recordTokenUsage('key-X', { input_tokens: 1, output_tokens: 1 });

            const stats = tracker.getTokenStats();
            expect(stats.byKey['key-Y']).toBeUndefined();
        });
    });

    // ---------------------------------------------------------------
    // 3. resetTokenStats — preserves maxKeys; reset when empty is no-op
    // ---------------------------------------------------------------
    describe('resetTokenStats edge cases', () => {
        it('should preserve maxKeys setting after reset', () => {
            const tracker = new TokenTracker({ maxKeys: 42 });
            tracker.recordTokenUsage('k', { input_tokens: 1, output_tokens: 1 });

            tracker.resetTokenStats();

            expect(tracker.getMaxKeys()).toBe(42);
        });

        it('should be a safe no-op when called on an already-empty tracker', () => {
            const tracker = new TokenTracker({ maxKeys: 200 });

            // No records yet — reset should not throw or corrupt state
            expect(() => tracker.resetTokenStats()).not.toThrow();

            const stats = tracker.getTokenStats();
            expect(stats.totalTokens).toBe(0);
            expect(stats.requestCount).toBe(0);
            expect(Object.keys(stats.byKey)).toHaveLength(0);
            expect(tracker.getMaxKeys()).toBe(200);
        });

        it('should allow normal recording after double-reset', () => {
            const tracker = new TokenTracker();
            tracker.recordTokenUsage('k1', { input_tokens: 10, output_tokens: 5 });

            tracker.resetTokenStats();
            tracker.resetTokenStats();

            tracker.recordTokenUsage('k2', { input_tokens: 20, output_tokens: 10 });
            const stats = tracker.getTokenStats();
            expect(stats.totalTokens).toBe(30);
            expect(stats.byKey['k2']).toBeDefined();
            expect(stats.byKey['k1']).toBeUndefined();
        });
    });

    // ---------------------------------------------------------------
    // 4. Multi-key tracking — 10 keys with different usage
    // ---------------------------------------------------------------
    describe('multi-key tracking', () => {
        it('should track 10 keys with per-key accuracy', () => {
            const tracker = new TokenTracker();
            const keyCount = 10;

            for (let i = 0; i < keyCount; i++) {
                // Each key gets unique input/output values
                tracker.recordTokenUsage(`key-${i}`, {
                    input_tokens: (i + 1) * 100,
                    output_tokens: (i + 1) * 50
                });
            }

            const stats = tracker.getTokenStats();

            // Verify each key independently
            for (let i = 0; i < keyCount; i++) {
                const entry = stats.byKey[`key-${i}`];
                expect(entry).toBeDefined();
                expect(entry.totalInputTokens).toBe((i + 1) * 100);
                expect(entry.totalOutputTokens).toBe((i + 1) * 50);
                expect(entry.totalTokens).toBe((i + 1) * 150);
                expect(entry.requestCount).toBe(1);
            }

            // Verify global totals
            // sum(1..10)*100 = 5500, sum(1..10)*50 = 2750
            expect(stats.totalInputTokens).toBe(5500);
            expect(stats.totalOutputTokens).toBe(2750);
            expect(stats.totalTokens).toBe(8250);
            expect(stats.requestCount).toBe(10);
        });
    });

    // ---------------------------------------------------------------
    // 5. Very large token counts — billions of tokens, no NaN/Infinity
    // ---------------------------------------------------------------
    describe('very large token counts', () => {
        it('should handle billion-level token counts without NaN or Infinity', () => {
            const tracker = new TokenTracker();
            const billion = 1_000_000_000;

            tracker.recordTokenUsage('big-key', {
                input_tokens: 5 * billion,
                output_tokens: 3 * billion
            });

            const stats = tracker.getTokenStats();
            expect(stats.totalInputTokens).toBe(5 * billion);
            expect(stats.totalOutputTokens).toBe(3 * billion);
            expect(stats.totalTokens).toBe(8 * billion);
            expect(Number.isFinite(stats.totalTokens)).toBe(true);
            expect(Number.isNaN(stats.totalTokens)).toBe(false);
        });

        it('should handle accumulation of large counts correctly', () => {
            const tracker = new TokenTracker();
            const large = 2_000_000_000;

            tracker.recordTokenUsage('big', { input_tokens: large, output_tokens: large });
            tracker.recordTokenUsage('big', { input_tokens: large, output_tokens: large });

            const stats = tracker.getTokenStats();
            expect(stats.totalInputTokens).toBe(4_000_000_000);
            expect(stats.totalOutputTokens).toBe(4_000_000_000);
            expect(stats.totalTokens).toBe(8_000_000_000);
            expect(Number.isFinite(stats.totalTokens)).toBe(true);
            expect(Number.isNaN(stats.avgTotalPerRequest)).toBe(false);
        });

        it('should compute averages without NaN for large counts', () => {
            const tracker = new TokenTracker();
            const large = 9_000_000_000;

            tracker.recordTokenUsage('k', { input_tokens: large, output_tokens: 1 });

            const stats = tracker.getTokenStats();
            expect(Number.isFinite(stats.avgInputPerRequest)).toBe(true);
            expect(Number.isFinite(stats.avgOutputPerRequest)).toBe(true);
            expect(Number.isFinite(stats.avgTotalPerRequest)).toBe(true);
        });
    });

    // ---------------------------------------------------------------
    // 6. Zero tokens — record (0, 0), observe early-return behavior
    // ---------------------------------------------------------------
    describe('zero tokens', () => {
        it('should not create entry when recording (0, 0) due to early return', () => {
            const tracker = new TokenTracker();

            tracker.recordTokenUsage('zero-key', { input_tokens: 0, output_tokens: 0 });

            const stats = tracker.getTokenStats();
            // The implementation early-returns when total === 0, so no entry is created
            expect(stats.byKey['zero-key']).toBeUndefined();
            expect(stats.requestCount).toBe(0);
            expect(stats.totalTokens).toBe(0);
        });

        it('should create entry when only input is non-zero', () => {
            const tracker = new TokenTracker();

            tracker.recordTokenUsage('partial-key', { input_tokens: 1, output_tokens: 0 });

            const stats = tracker.getTokenStats();
            expect(stats.byKey['partial-key']).toBeDefined();
            expect(stats.byKey['partial-key'].totalInputTokens).toBe(1);
            expect(stats.byKey['partial-key'].totalOutputTokens).toBe(0);
            expect(stats.requestCount).toBe(1);
        });

        it('should create entry when only output is non-zero', () => {
            const tracker = new TokenTracker();

            tracker.recordTokenUsage('output-only', { input_tokens: 0, output_tokens: 5 });

            const stats = tracker.getTokenStats();
            expect(stats.byKey['output-only']).toBeDefined();
            expect(stats.byKey['output-only'].totalOutputTokens).toBe(5);
        });
    });

    // ---------------------------------------------------------------
    // 7. Token summary — getTokenStats returns correct aggregated totals
    // ---------------------------------------------------------------
    describe('token summary aggregation', () => {
        it('should return correct aggregated totals across multiple keys', () => {
            const tracker = new TokenTracker();

            tracker.recordTokenUsage('alpha', { input_tokens: 100, output_tokens: 50 });
            tracker.recordTokenUsage('beta', { input_tokens: 200, output_tokens: 100 });
            tracker.recordTokenUsage('gamma', { input_tokens: 300, output_tokens: 150 });
            tracker.recordTokenUsage('alpha', { input_tokens: 50, output_tokens: 25 });

            const summary = tracker.getTokenStats();

            // Global aggregation
            expect(summary.totalInputTokens).toBe(650);   // 100+200+300+50
            expect(summary.totalOutputTokens).toBe(325);   // 50+100+150+25
            expect(summary.totalTokens).toBe(975);          // 650+325
            expect(summary.requestCount).toBe(4);

            // Averages
            expect(summary.avgInputPerRequest).toBe(Math.round(650 / 4));   // 163
            expect(summary.avgOutputPerRequest).toBe(Math.round(325 / 4));  // 81
            expect(summary.avgTotalPerRequest).toBe(Math.round(975 / 4));   // 244

            // Per-key breakdown
            expect(Object.keys(summary.byKey)).toHaveLength(3);

            expect(summary.byKey['alpha'].totalInputTokens).toBe(150);
            expect(summary.byKey['alpha'].totalOutputTokens).toBe(75);
            expect(summary.byKey['alpha'].requestCount).toBe(2);
            expect(summary.byKey['alpha'].avgInputPerRequest).toBe(75);
            expect(summary.byKey['alpha'].avgOutputPerRequest).toBe(38); // Math.round(75/2)

            expect(summary.byKey['beta'].totalInputTokens).toBe(200);
            expect(summary.byKey['beta'].totalOutputTokens).toBe(100);
            expect(summary.byKey['beta'].requestCount).toBe(1);

            expect(summary.byKey['gamma'].totalInputTokens).toBe(300);
            expect(summary.byKey['gamma'].totalOutputTokens).toBe(150);
            expect(summary.byKey['gamma'].requestCount).toBe(1);
        });

        it('should return empty byKey object when no usage recorded', () => {
            const tracker = new TokenTracker();
            const summary = tracker.getTokenStats();

            expect(summary.byKey).toEqual({});
            expect(summary.avgInputPerRequest).toBe(0);
            expect(summary.avgOutputPerRequest).toBe(0);
            expect(summary.avgTotalPerRequest).toBe(0);
        });
    });
});
