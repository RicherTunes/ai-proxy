/**
 * Backoff Utility Tests
 * Tests exponential backoff with jitter for consistent behavior.
 */

const { exponentialBackoff, DEFAULT_JITTER_FACTOR } = require('../lib/backoff');

describe('exponentialBackoff', () => {
    test('attempt=1 returns approximately baseMs', () => {
        const results = [];
        for (let i = 0; i < 100; i++) {
            results.push(exponentialBackoff({ baseMs: 1000, capMs: 10000, attempt: 1 }));
        }
        const avg = results.reduce((a, b) => a + b, 0) / results.length;
        // With jitter, average should be close to baseMs
        expect(avg).toBeGreaterThan(800);
        expect(avg).toBeLessThan(1200);
    });

    test('attempt=2 doubles the base', () => {
        const results = [];
        for (let i = 0; i < 100; i++) {
            results.push(exponentialBackoff({ baseMs: 1000, capMs: 10000, attempt: 2 }));
        }
        const avg = results.reduce((a, b) => a + b, 0) / results.length;
        expect(avg).toBeGreaterThan(1600);
        expect(avg).toBeLessThan(2400);
    });

    test('attempt=4 yields 8x base (capped by capMs)', () => {
        const results = [];
        for (let i = 0; i < 100; i++) {
            results.push(exponentialBackoff({ baseMs: 1000, capMs: 10000, attempt: 4 }));
        }
        const avg = results.reduce((a, b) => a + b, 0) / results.length;
        // 1000 * 2^3 = 8000
        expect(avg).toBeGreaterThan(6400);
        expect(avg).toBeLessThan(9600);
    });

    test('respects capMs ceiling', () => {
        for (let i = 0; i < 50; i++) {
            const result = exponentialBackoff({ baseMs: 1000, capMs: 5000, attempt: 10 });
            // capMs=5000, jitter ±20% → max 6000
            expect(result).toBeLessThanOrEqual(6000);
        }
    });

    test('jitter=0 produces deterministic output', () => {
        const a = exponentialBackoff({ baseMs: 500, capMs: 5000, attempt: 3, jitter: 0 });
        const b = exponentialBackoff({ baseMs: 500, capMs: 5000, attempt: 3, jitter: 0 });
        // 500 * 2^2 = 2000, no jitter
        expect(a).toBe(2000);
        expect(b).toBe(2000);
    });

    test('jitter range is bounded by factor', () => {
        for (let i = 0; i < 200; i++) {
            const result = exponentialBackoff({ baseMs: 1000, capMs: 10000, attempt: 1, jitter: 0.2 });
            // base=1000, jitter ±20% → 800..1200
            expect(result).toBeGreaterThanOrEqual(800);
            expect(result).toBeLessThanOrEqual(1200);
        }
    });

    test('attempt=0 is clamped to 1', () => {
        const result = exponentialBackoff({ baseMs: 1000, capMs: 10000, attempt: 0, jitter: 0 });
        expect(result).toBe(1000);
    });

    test('negative attempt is clamped to 1', () => {
        const result = exponentialBackoff({ baseMs: 1000, capMs: 10000, attempt: -5, jitter: 0 });
        expect(result).toBe(1000);
    });

    test('returns integer (rounded)', () => {
        for (let i = 0; i < 50; i++) {
            const result = exponentialBackoff({ baseMs: 333, capMs: 9999, attempt: 2 });
            expect(Number.isInteger(result)).toBe(true);
        }
    });

    test('DEFAULT_JITTER_FACTOR is 0.2', () => {
        expect(DEFAULT_JITTER_FACTOR).toBe(0.2);
    });

    test('matches key-manager pattern: base=1000, cap=10000, attempt capped at 4', () => {
        // key-manager uses Math.min(rateLimitedCount, 4) as backoffFactor
        const result = exponentialBackoff({ baseMs: 1000, capMs: 10000, attempt: 4, jitter: 0 });
        // 1000 * 2^3 = 8000
        expect(result).toBe(8000);
    });

    test('matches pool-manager pattern: base=500, cap=5000', () => {
        const result = exponentialBackoff({ baseMs: 500, capMs: 5000, attempt: 3, jitter: 0 });
        // 500 * 2^2 = 2000
        expect(result).toBe(2000);
    });
});
