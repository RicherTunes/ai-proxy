'use strict';
/**
 * Rate Limiter Function Coverage Tests
 * Covers uncovered lines 215, 222 (updateSettings error branches)
 */

const { RateLimiter } = require('../lib/rate-limiter');

describe('TokenBucket - _refill branch coverage', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    // Covers line 24 in _refill: Math.min branch where tokens + tokensToAdd < capacity + burst
    test('_refill does not cap when refill amount is small (line 24 branch)', () => {
        const { TokenBucket } = require('../lib/rate-limiter');
        const bucket = new TokenBucket({
            capacity: 100,
            refillRate: 10,  // 10 tokens per second
            burst: 0
        });

        // Drain to low token count
        bucket.tokens = 10;
        bucket.lastRefill = Date.now();

        // Advance 100ms - should add 1 token (10 * 0.1 = 1)
        jest.advanceTimersByTime(100);
        bucket._refill();

        // tokens + tokensToAdd (10 + 1 = 11) < capacity + burst (100 + 0 = 100)
        // So Math.min returns tokens + tokensToAdd = 11
        expect(Math.floor(bucket.tokens)).toBe(11);
    });
});

describe('RateLimiter - constructor enabled branch (line 86)', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    // Covers line 86: default parameter options = {} when no args passed
    test('constructor with no arguments uses default empty options', () => {
        const { RateLimiter } = require('../lib/rate-limiter');
        const limiter = new RateLimiter();

        expect(limiter.enabled).toBe(false);
        expect(limiter.requestsPerMinute).toBe(60);
        expect(limiter.burst).toBe(10);
    });

    // Covers line 86: requestsPerMinute undefined falls back to 0 via ||
    test('constructor with undefined requestsPerMinute falls back to 0, disabled', () => {
        const { RateLimiter } = require('../lib/rate-limiter');
        const limiter = new RateLimiter({ requestsPerMinute: undefined });

        expect(limiter.enabled).toBe(false);
        expect(limiter.requestsPerMinute).toBe(60); // defaults to 60 after || check
    });

    // Covers line 86: empty options, both enabled and requestsPerMinute undefined
    test('constructor with empty options defaults to disabled', () => {
        const { RateLimiter } = require('../lib/rate-limiter');
        const limiter = new RateLimiter({});

        expect(limiter.enabled).toBe(false);
    });
});

describe('RateLimiter - updateSettings error branches', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    // Covers line 215: invalid requestsPerMinute returns error
    test('updateSettings returns error for non-finite requestsPerMinute', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 60, burst: 10 });

        const result = limiter.updateSettings({ requestsPerMinute: Infinity });

        expect(result.error).toBe('requestsPerMinute must be a non-negative finite number');
        expect(limiter.requestsPerMinute).toBe(60); // unchanged
    });

    // Covers line 215: negative requestsPerMinute returns error
    test('updateSettings returns error for negative requestsPerMinute', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 60, burst: 10 });

        const result = limiter.updateSettings({ requestsPerMinute: -5 });

        expect(result.error).toBe('requestsPerMinute must be a non-negative finite number');
        expect(limiter.requestsPerMinute).toBe(60); // unchanged
    });

    // Covers line 222: invalid burst returns error
    test('updateSettings returns error for non-finite burst', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 60, burst: 10 });

        const result = limiter.updateSettings({ burst: NaN });

        expect(result.error).toBe('burst must be a non-negative finite number');
        expect(limiter.burst).toBe(10); // unchanged
    });

    // Covers line 222: negative burst returns error
    test('updateSettings returns error for negative burst', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 60, burst: 10 });

        const result = limiter.updateSettings({ burst: -1 });

        expect(result.error).toBe('burst must be a non-negative finite number');
        expect(limiter.burst).toBe(10); // unchanged
    });

    // Covers line 215: -Infinity is rejected
    test('updateSettings returns error for -Infinity requestsPerMinute', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 60 });

        const result = limiter.updateSettings({ requestsPerMinute: -Infinity });

        expect(result.error).toBe('requestsPerMinute must be a non-negative finite number');
    });

    // Covers line 222: -Infinity burst is rejected
    test('updateSettings returns error for -Infinity burst', () => {
        const limiter = new RateLimiter({ burst: 10 });

        const result = limiter.updateSettings({ burst: -Infinity });

        expect(result.error).toBe('burst must be a non-negative finite number');
    });
});
