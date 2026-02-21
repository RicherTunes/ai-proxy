/**
 * Rate Limiter Extended Tests
 * Covers uncovered lines 211-219 (updateSettings) and additional branch coverage
 */

const { TokenBucket, RateLimiter } = require('../lib/rate-limiter');

describe('RateLimiter - updateSettings (lines 211-219)', () => {
    test('should update requestsPerMinute when provided', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 60, burst: 10 });

        const result = limiter.updateSettings({ requestsPerMinute: 120 });

        expect(result.requestsPerMinute).toBe(120);
        expect(result.burst).toBe(10); // unchanged
        expect(limiter.requestsPerMinute).toBe(120);
    });

    test('should update burst when provided', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 60, burst: 10 });

        const result = limiter.updateSettings({ burst: 20 });

        expect(result.burst).toBe(20);
        expect(result.requestsPerMinute).toBe(60); // unchanged
        expect(limiter.burst).toBe(20);
    });

    test('should update both requestsPerMinute and burst simultaneously', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 60, burst: 10 });

        const result = limiter.updateSettings({ requestsPerMinute: 100, burst: 25 });

        expect(result.requestsPerMinute).toBe(100);
        expect(result.burst).toBe(25);
        expect(limiter.requestsPerMinute).toBe(100);
        expect(limiter.burst).toBe(25);
    });

    test('should clear all existing buckets after settings update', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 60, burst: 10 });

        // Create some buckets
        limiter.checkLimit('key1');
        limiter.checkLimit('key2');
        limiter.checkLimit('key3');
        expect(limiter.buckets.size).toBe(3);

        limiter.updateSettings({ requestsPerMinute: 120 });

        expect(limiter.buckets.size).toBe(0);
    });

    test('should not update requestsPerMinute when not provided', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 60, burst: 10 });

        const result = limiter.updateSettings({});

        expect(result.requestsPerMinute).toBe(60);
        expect(result.burst).toBe(10);
    });

    test('should still clear buckets even when no settings changed', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 60, burst: 10 });
        limiter.checkLimit('key1');
        expect(limiter.buckets.size).toBe(1);

        limiter.updateSettings({});

        expect(limiter.buckets.size).toBe(0);
    });

    test('should create new buckets with updated settings after update', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 10, burst: 0 });

        // Exhaust tokens with original settings
        for (let i = 0; i < 15; i++) {
            limiter.checkLimit('key1');
        }
        expect(limiter.checkLimit('key1').allowed).toBe(false);

        // Update to higher limit
        limiter.updateSettings({ requestsPerMinute: 1000, burst: 100 });

        // New bucket should have higher capacity
        const result = limiter.checkLimit('key1');
        expect(result.allowed).toBe(true);

        const stats = limiter.getKeyStats('key1');
        expect(stats.capacity).toBe(1000);
    });

    test('should handle setting requestsPerMinute to 0 after being positive', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 60, burst: 10 });
        limiter.checkLimit('key1');

        const result = limiter.updateSettings({ requestsPerMinute: 0 });

        expect(result.requestsPerMinute).toBe(0);
        expect(limiter.buckets.size).toBe(0);
    });

    test('should return current values in result object', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 60, burst: 10 });

        const result = limiter.updateSettings({ requestsPerMinute: 30 });

        expect(result).toEqual({ requestsPerMinute: 30, burst: 10 });
    });

    test('should not update requestsPerMinute when value is explicitly undefined', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 60, burst: 10 });

        const result = limiter.updateSettings({ requestsPerMinute: undefined });

        expect(result.requestsPerMinute).toBe(60);
    });

    test('should not update burst when value is explicitly undefined', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 60, burst: 10 });

        const result = limiter.updateSettings({ burst: undefined });

        expect(result.burst).toBe(10);
    });
});

describe('RateLimiter - peekLimit (additional branch coverage)', () => {
    test('should return allowed without consuming tokens', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 10, burst: 0 });

        const peekResult = limiter.peekLimit('key1');
        expect(peekResult.allowed).toBe(true);
        expect(peekResult.waitTime).toBe(0);

        // Peek again - should still be allowed (no token consumed)
        const peekResult2 = limiter.peekLimit('key1');
        expect(peekResult2.allowed).toBe(true);
    });

    test('should return not-allowed with waitTime when tokens exhausted', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 5, burst: 0 });

        // Exhaust all tokens via checkLimit (which consumes)
        for (let i = 0; i < 10; i++) {
            limiter.checkLimit('key1');
        }

        const peekResult = limiter.peekLimit('key1');
        expect(peekResult.allowed).toBe(false);
        expect(peekResult.waitTime).toBeGreaterThan(0);
    });

    test('should always allow when disabled', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 0 });

        const result = limiter.peekLimit('key1');
        expect(result.allowed).toBe(true);
        expect(result.waitTime).toBe(0);
    });
});

describe('RateLimiter - resetKey edge case', () => {
    test('should silently do nothing when resetting a non-existent key', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 60 });

        // Should not throw
        expect(() => limiter.resetKey('nonexistent')).not.toThrow();
        expect(limiter.buckets.has('nonexistent')).toBe(false);
    });
});
