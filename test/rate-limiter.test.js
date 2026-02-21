/**
 * Rate Limiter Module Tests
 */

const { TokenBucket, RateLimiter } = require('../lib/rate-limiter');

describe('TokenBucket', () => {
    describe('constructor', () => {
        test('should create bucket with default options', () => {
            const bucket = new TokenBucket();
            expect(bucket.capacity).toBe(60);
            expect(bucket.refillRate).toBe(1);
            expect(bucket.tokens).toBe(60);
        });

        test('should create bucket with custom options', () => {
            const bucket = new TokenBucket({
                capacity: 100,
                refillRate: 2,
                burst: 20
            });
            expect(bucket.capacity).toBe(100);
            expect(bucket.refillRate).toBe(2);
            expect(bucket.burst).toBe(20);
        });
    });

    describe('tryConsume', () => {
        test('should consume token when available', () => {
            const bucket = new TokenBucket({ capacity: 10 });
            expect(bucket.tryConsume()).toBe(true);
            // Use floor to handle time-based refill adding fractional tokens
            expect(Math.floor(bucket.tokens)).toBe(9);
        });

        test('should consume multiple tokens', () => {
            const bucket = new TokenBucket({ capacity: 10 });
            expect(bucket.tryConsume(5)).toBe(true);
            // Use floor to handle time-based refill adding fractional tokens
            expect(Math.floor(bucket.tokens)).toBe(5);
        });

        test('should fail when insufficient tokens', () => {
            const bucket = new TokenBucket({ capacity: 2 });
            bucket.tryConsume(2);
            expect(bucket.tryConsume()).toBe(false);
        });

        test('should refill tokens over time', async () => {
            const bucket = new TokenBucket({
                capacity: 10,
                refillRate: 10  // 10 tokens per second
            });
            bucket.tokens = 0;
            bucket.lastRefill = Date.now();

            await new Promise(resolve => setTimeout(resolve, 200));

            // Should have refilled ~2 tokens
            const result = bucket.tryConsume(1);
            expect(result).toBe(true);
        });

        test('should not exceed capacity plus burst', () => {
            const bucket = new TokenBucket({
                capacity: 10,
                burst: 5,
                refillRate: 100
            });
            bucket.tokens = 0;
            bucket.lastRefill = Date.now() - 10000; // 10 seconds ago

            bucket._refill();
            expect(bucket.tokens).toBe(15); // capacity + burst
        });
    });

    describe('getTokens', () => {
        test('should return current token count after refill', () => {
            const bucket = new TokenBucket({ capacity: 10 });
            // getTokens() calls _refill() first, so token count may be higher
            // than manually set value due to time-based refill
            const tokens = bucket.getTokens();
            expect(tokens).toBeLessThanOrEqual(10.01); // Allow tiny float precision overshoot
            expect(tokens).toBeGreaterThan(0);
        });
    });

    describe('getWaitTime', () => {
        test('should return 0 when tokens available', () => {
            const bucket = new TokenBucket({ capacity: 10 });
            expect(bucket.getWaitTime()).toBe(0);
        });

        test('should return wait time when no tokens', () => {
            const bucket = new TokenBucket({
                capacity: 10,
                refillRate: 2  // 2 per second = 0.5 seconds per token
            });
            bucket.tokens = 0;
            bucket.lastRefill = Date.now();

            const waitTime = bucket.getWaitTime();
            expect(waitTime).toBeGreaterThan(0);
            expect(waitTime).toBeLessThanOrEqual(1000);
        });
    });

    describe('reset', () => {
        test('should reset to full capacity', () => {
            const bucket = new TokenBucket({ capacity: 10 });
            bucket.tokens = 2;
            bucket.reset();
            expect(bucket.tokens).toBe(10);
        });
    });

    describe('getStats', () => {
        test('should return comprehensive stats', () => {
            const bucket = new TokenBucket({
                capacity: 10,
                refillRate: 2,
                burst: 5
            });

            const stats = bucket.getStats();

            expect(stats).toHaveProperty('tokens');
            expect(stats).toHaveProperty('capacity', 10);
            expect(stats).toHaveProperty('burst', 5);
            expect(stats).toHaveProperty('refillRate', 2);
            expect(stats).toHaveProperty('waitTime');
        });
    });
});

describe('RateLimiter', () => {
    describe('constructor', () => {
        test('should be disabled when requestsPerMinute is 0', () => {
            const limiter = new RateLimiter({ requestsPerMinute: 0 });
            expect(limiter.enabled).toBe(false);
        });

        test('should be enabled when requestsPerMinute > 0', () => {
            const limiter = new RateLimiter({ requestsPerMinute: 60 });
            expect(limiter.enabled).toBe(true);
        });

        test('should be disabled when enabled is false', () => {
            const limiter = new RateLimiter({
                requestsPerMinute: 60,
                enabled: false
            });
            expect(limiter.enabled).toBe(false);
        });
    });

    describe('checkLimit', () => {
        test('should always allow when disabled', () => {
            const limiter = new RateLimiter({ requestsPerMinute: 0 });
            const result = limiter.checkLimit('key1');
            expect(result.allowed).toBe(true);
            expect(result.waitTime).toBe(0);
        });

        test('should allow requests within limit', () => {
            const limiter = new RateLimiter({ requestsPerMinute: 60, burst: 10 });

            for (let i = 0; i < 10; i++) {
                const result = limiter.checkLimit('key1');
                expect(result.allowed).toBe(true);
            }
        });

        test('should create separate buckets per key', () => {
            const limiter = new RateLimiter({ requestsPerMinute: 60, burst: 5 });

            // Exhaust key1
            for (let i = 0; i < 70; i++) {
                limiter.checkLimit('key1');
            }

            // key2 should still be available
            const result = limiter.checkLimit('key2');
            expect(result.allowed).toBe(true);
        });

        test('should reject when over limit', () => {
            const limiter = new RateLimiter({ requestsPerMinute: 10, burst: 0 });

            // Exhaust tokens
            for (let i = 0; i < 15; i++) {
                limiter.checkLimit('key1');
            }

            const result = limiter.checkLimit('key1');
            expect(result.allowed).toBe(false);
            expect(result.waitTime).toBeGreaterThan(0);
        });
    });

    describe('getKeyStats', () => {
        test('should return enabled:false when disabled', () => {
            const limiter = new RateLimiter({ requestsPerMinute: 0 });
            const stats = limiter.getKeyStats('key1');
            expect(stats.enabled).toBe(false);
        });

        test('should return bucket stats when enabled', () => {
            const limiter = new RateLimiter({ requestsPerMinute: 60 });
            limiter.checkLimit('key1'); // Create bucket

            const stats = limiter.getKeyStats('key1');
            expect(stats.enabled).toBe(true);
            expect(stats).toHaveProperty('tokens');
            expect(stats).toHaveProperty('capacity');
        });
    });

    describe('getAllStats', () => {
        test('should return stats for all keys', () => {
            const limiter = new RateLimiter({ requestsPerMinute: 60 });
            limiter.checkLimit('key1');
            limiter.checkLimit('key2');

            const stats = limiter.getAllStats();

            expect(stats.enabled).toBe(true);
            expect(stats.requestsPerMinute).toBe(60);
            expect(Object.keys(stats.keys)).toHaveLength(2);
            expect(stats.keys).toHaveProperty('key1');
            expect(stats.keys).toHaveProperty('key2');
        });
    });

    describe('resetKey', () => {
        test('should reset specific key', () => {
            const limiter = new RateLimiter({ requestsPerMinute: 10, burst: 0 });

            // Exhaust key1
            for (let i = 0; i < 15; i++) {
                limiter.checkLimit('key1');
            }

            expect(limiter.checkLimit('key1').allowed).toBe(false);

            limiter.resetKey('key1');

            expect(limiter.checkLimit('key1').allowed).toBe(true);
        });

        test('should not affect other keys', () => {
            const limiter = new RateLimiter({ requestsPerMinute: 10, burst: 0 });

            // Exhaust both keys
            for (let i = 0; i < 15; i++) {
                limiter.checkLimit('key1');
                limiter.checkLimit('key2');
            }

            limiter.resetKey('key1');

            expect(limiter.checkLimit('key1').allowed).toBe(true);
            expect(limiter.checkLimit('key2').allowed).toBe(false);
        });
    });

    describe('resetAll', () => {
        test('should reset all keys', () => {
            const limiter = new RateLimiter({ requestsPerMinute: 10, burst: 0 });

            // Exhaust both keys
            for (let i = 0; i < 15; i++) {
                limiter.checkLimit('key1');
                limiter.checkLimit('key2');
            }

            limiter.resetAll();

            expect(limiter.checkLimit('key1').allowed).toBe(true);
            expect(limiter.checkLimit('key2').allowed).toBe(true);
        });
    });

    describe('cleanup', () => {
        test('should remove stale buckets', () => {
            const limiter = new RateLimiter({ requestsPerMinute: 60 });
            limiter.checkLimit('key1');
            limiter.checkLimit('key2');

            // Make key1 stale
            limiter.buckets.get('key1').lastRefill = Date.now() - 4000000;

            limiter.cleanup(3600000); // 1 hour max age

            expect(limiter.buckets.has('key1')).toBe(false);
            expect(limiter.buckets.has('key2')).toBe(true);
        });
    });
});
