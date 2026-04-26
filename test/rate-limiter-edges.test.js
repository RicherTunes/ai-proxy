/**
 * Rate Limiter Edge Case Tests
 * Covers: window boundaries, burst-then-silence, concurrent checks,
 * zero/negative config, high volume, getRemainingTokens accuracy,
 * multiple keys independence, and cleanup of expired entries.
 */

const { TokenBucket, RateLimiter } = require('../lib/rate-limiter');

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    jest.useRealTimers();
});

describe('Edge: Window boundary — requests at refill boundary', () => {
    test('request just before refill yields a token should be rejected, request just after should be allowed', () => {
        // capacity=1, refillRate=1 token/sec, burst=0
        const bucket = new TokenBucket({ capacity: 1, refillRate: 1, burst: 0 });

        // Consume the single token
        expect(bucket.tryConsume(1)).toBe(true);

        // Advance 999ms — not quite enough for a full token (0.999 tokens refilled)
        jest.advanceTimersByTime(999);
        expect(bucket.tryConsume(1)).toBe(false);

        // Advance 2 more ms (total 1001ms) — should now have >= 1 token
        jest.advanceTimersByTime(2);
        expect(bucket.tryConsume(1)).toBe(true);
    });

    test('RateLimiter checkLimit at exact refill boundary', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 60, burst: 0 });
        // refillRate = 60/60 = 1 token/sec, capacity = 60

        // Exhaust all 60 tokens
        for (let i = 0; i < 60; i++) {
            expect(limiter.checkLimit('client-a').allowed).toBe(true);
        }
        expect(limiter.checkLimit('client-a').allowed).toBe(false);

        // Advance exactly 1 second — refills 1 token
        jest.advanceTimersByTime(1000);
        expect(limiter.checkLimit('client-a').allowed).toBe(true);

        // Immediately after, no tokens left again
        expect(limiter.checkLimit('client-a').allowed).toBe(false);
    });
});

describe('Edge: Burst then silence — full budget restored after window', () => {
    test('exhaust all tokens, wait full refill period, verify full capacity restored', () => {
        const capacity = 20;
        const burst = 5;
        // refillRate = capacity/60 = 1/3 tokens/sec
        const bucket = new TokenBucket({ capacity, refillRate: capacity / 60, burst });

        // Drain completely (capacity + burst = 25 tokens)
        for (let i = 0; i < capacity + burst; i++) {
            bucket.tryConsume(1);
        }
        expect(bucket.tryConsume(1)).toBe(false);

        // To refill to capacity+burst=25 tokens at 1/3 tokens/sec, need 75 seconds
        // Wait 80 seconds to be safe — cap is capacity+burst=25
        jest.advanceTimersByTime(80000);
        const tokens = bucket.getTokens();
        expect(tokens).toBeCloseTo(capacity + burst, 0);
    });

    test('RateLimiter: exhaust key, wait, full budget available again', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 10, burst: 0 });

        // Exhaust
        for (let i = 0; i < 10; i++) {
            limiter.checkLimit('user1');
        }
        expect(limiter.checkLimit('user1').allowed).toBe(false);

        // Wait full minute (tokens refill at 10/60 per sec = 10 per 60s)
        jest.advanceTimersByTime(60000);

        // Should be able to consume 10 tokens again
        let allowed = 0;
        for (let i = 0; i < 10; i++) {
            if (limiter.checkLimit('user1').allowed) allowed++;
        }
        expect(allowed).toBe(10);
    });
});

describe('Edge: Concurrent rate limit checks — atomic counting', () => {
    test('multiple synchronous isAllowed/checkLimit calls count correctly', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 5, burst: 0 });

        // Fire 10 synchronous checks — only first 5 should be allowed
        const results = [];
        for (let i = 0; i < 10; i++) {
            results.push(limiter.checkLimit('concurrent-key').allowed);
        }

        const allowedCount = results.filter(Boolean).length;
        const rejectedCount = results.filter(r => !r).length;

        expect(allowedCount).toBe(5);
        expect(rejectedCount).toBe(5);
    });

    test('Promise.all with synchronous checkLimit still counts atomically', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 3, burst: 0 });

        // Even though we wrap in Promise.all, checkLimit is synchronous
        // so results should be deterministic
        const promises = Array.from({ length: 6 }, () =>
            Promise.resolve(limiter.checkLimit('pkey'))
        );

        return Promise.all(promises).then(results => {
            const allowed = results.filter(r => r.allowed).length;
            expect(allowed).toBe(3);
        });
    });
});

describe('Edge: Zero and negative config values', () => {
    test('RateLimiter with requestsPerMinute=0 disables rate limiting', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 0 });
        expect(limiter.enabled).toBe(false);

        // All requests allowed when disabled
        for (let i = 0; i < 100; i++) {
            expect(limiter.checkLimit('any').allowed).toBe(true);
        }
    });

    test('TokenBucket with capacity=0 falls back to default capacity=60 (|| operator)', () => {
        // FINDING: The constructor uses `options.capacity || 60`, so capacity=0
        // is falsy and defaults to 60. Same for refillRate=0 → 1, burst=0 → 10.
        const bucket = new TokenBucket({ capacity: 0, refillRate: 0, burst: 0 });

        expect(bucket.capacity).toBe(60);  // 0 || 60
        expect(bucket.refillRate).toBe(1); // 0 || 1
        expect(bucket.burst).toBe(10);     // 0 || 10
        expect(bucket.tokens).toBe(60);

        // Behaves as a default bucket — consumes succeed
        expect(bucket.tryConsume(1)).toBe(true);
    });

    test('TokenBucket with explicit low capacity still works correctly', () => {
        // Use capacity=1 as the minimum meaningful value (since 0 defaults to 60)
        const bucket = new TokenBucket({ capacity: 1, refillRate: 1, burst: 0 });

        expect(bucket.capacity).toBe(1);
        expect(bucket.tryConsume(1)).toBe(true);
        expect(bucket.tryConsume(1)).toBe(false);

        // After 1 second, refills 1 token
        jest.advanceTimersByTime(1000);
        expect(bucket.tryConsume(1)).toBe(true);
    });

    test('RateLimiter with negative requestsPerMinute is treated as disabled', () => {
        const limiter = new RateLimiter({ requestsPerMinute: -10 });
        // requestsPerMinute || 60 → -10 is truthy, but enabled check is:
        // options.enabled !== false && (options.requestsPerMinute || 0) > 0
        // -10 > 0 is false → disabled
        expect(limiter.enabled).toBe(false);
        expect(limiter.checkLimit('key').allowed).toBe(true);
    });

    test('TokenBucket with negative refillRate does not add tokens', () => {
        const bucket = new TokenBucket({ capacity: 10, refillRate: -1, burst: 0 });

        bucket.tryConsume(5);
        const beforeRefill = bucket.tokens;

        jest.advanceTimersByTime(5000);
        bucket._refill();

        // With negative refill rate, tokens decrease or stay the same
        // _refill adds elapsed * refillRate which is negative
        expect(bucket.tokens).toBeLessThanOrEqual(beforeRefill);
    });
});

describe('Edge: Very high volume — 10000 requests with limit=5000', () => {
    test('exactly 5000 allowed out of 10000 with burst=0', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 5000, burst: 0 });

        let allowed = 0;
        for (let i = 0; i < 10000; i++) {
            if (limiter.checkLimit('high-volume').allowed) {
                allowed++;
            }
        }

        expect(allowed).toBe(5000);
    });

    test('TokenBucket with capacity=5000, burst=0 allows exactly 5000 consumes', () => {
        const bucket = new TokenBucket({ capacity: 5000, refillRate: 0, burst: 0 });

        let consumed = 0;
        for (let i = 0; i < 10000; i++) {
            if (bucket.tryConsume(1)) consumed++;
        }

        expect(consumed).toBe(5000);
    });
});

describe('Edge: getRemainingTokens accuracy', () => {
    test('after N requests, remaining = capacity - N (no time elapsed with fake timers)', () => {
        const capacity = 50;
        const bucket = new TokenBucket({ capacity, refillRate: 0, burst: 0 });

        for (let n = 1; n <= 10; n++) {
            bucket.tryConsume(1);
            const remaining = bucket.getTokens();
            expect(Math.round(remaining)).toBe(capacity - n);
        }
    });

    test('RateLimiter getKeyStats tokens decreases by 1 per checkLimit call', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 20, burst: 0 });

        // First call creates the bucket and consumes 1
        limiter.checkLimit('stats-key');
        const initialStats = limiter.getKeyStats('stats-key');
        const afterFirst = initialStats.tokens;

        // Consume 4 more
        for (let i = 0; i < 4; i++) {
            limiter.checkLimit('stats-key');
        }

        const laterStats = limiter.getKeyStats('stats-key');
        expect(laterStats.tokens).toBe(afterFirst - 4);
    });

    test('getTokens reflects refill after time advance', () => {
        const bucket = new TokenBucket({ capacity: 10, refillRate: 2, burst: 0 });

        bucket.tryConsume(10); // Drain all
        expect(bucket.getTokens()).toBeCloseTo(0, 0);

        jest.advanceTimersByTime(3000); // 3 seconds * 2 tokens/sec = 6 tokens
        expect(bucket.getTokens()).toBeCloseTo(6, 0);
    });
});

describe('Edge: Multiple keys/IPs — independent buckets', () => {
    test('exhausting one key does not affect another', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 5, burst: 0 });

        // Exhaust key-a
        for (let i = 0; i < 5; i++) {
            limiter.checkLimit('key-a');
        }
        expect(limiter.checkLimit('key-a').allowed).toBe(false);

        // key-b should be fully available
        for (let i = 0; i < 5; i++) {
            expect(limiter.checkLimit('key-b').allowed).toBe(true);
        }
        expect(limiter.checkLimit('key-b').allowed).toBe(false);

        // key-c untouched
        expect(limiter.checkLimit('key-c').allowed).toBe(true);
    });

    test('resetting one key does not affect others', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 3, burst: 0 });

        // Exhaust both
        for (let i = 0; i < 3; i++) {
            limiter.checkLimit('ip-1');
            limiter.checkLimit('ip-2');
        }

        expect(limiter.checkLimit('ip-1').allowed).toBe(false);
        expect(limiter.checkLimit('ip-2').allowed).toBe(false);

        limiter.resetKey('ip-1');
        expect(limiter.checkLimit('ip-1').allowed).toBe(true);
        expect(limiter.checkLimit('ip-2').allowed).toBe(false);
    });

    test('peekLimit on one key does not affect another key token count', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 5, burst: 0 });

        // Peek many times on key-x — should not consume
        for (let i = 0; i < 100; i++) {
            limiter.peekLimit('key-x');
        }

        // key-x should still have full capacity
        let allowed = 0;
        for (let i = 0; i < 5; i++) {
            if (limiter.checkLimit('key-x').allowed) allowed++;
        }
        expect(allowed).toBe(5);
    });

    test('many unique keys each get independent full capacity', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 2, burst: 0 });

        for (let k = 0; k < 50; k++) {
            const key = `user-${k}`;
            expect(limiter.checkLimit(key).allowed).toBe(true);
            expect(limiter.checkLimit(key).allowed).toBe(true);
            expect(limiter.checkLimit(key).allowed).toBe(false);
        }

        expect(limiter.buckets.size).toBe(50);
    });
});

describe('Edge: Cleanup of expired entries — garbage collection', () => {
    test('expired buckets are removed by cleanup', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 60, burst: 10 });

        limiter.checkLimit('old-key');
        limiter.checkLimit('new-key');

        expect(limiter.buckets.size).toBe(2);

        // Simulate old-key being stale (2 hours ago)
        limiter.buckets.get('old-key').lastRefill = Date.now() - 7200000;

        limiter.cleanup(3600000); // maxAge = 1 hour

        expect(limiter.buckets.has('old-key')).toBe(false);
        expect(limiter.buckets.has('new-key')).toBe(true);
        expect(limiter.buckets.size).toBe(1);
    });

    test('cleanup with custom maxAge removes only entries older than threshold', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 60, burst: 0 });

        limiter.checkLimit('a');
        limiter.checkLimit('b');
        limiter.checkLimit('c');

        // a: 10 minutes old, b: 3 minutes old, c: fresh
        limiter.buckets.get('a').lastRefill = Date.now() - 600000;
        limiter.buckets.get('b').lastRefill = Date.now() - 180000;

        // maxAge = 5 minutes → only 'a' is stale
        limiter.cleanup(300000);

        expect(limiter.buckets.has('a')).toBe(false);
        expect(limiter.buckets.has('b')).toBe(true);
        expect(limiter.buckets.has('c')).toBe(true);
    });

    test('cleanup with default maxAge (1 hour) keeps recent entries', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 60, burst: 0 });

        limiter.checkLimit('recent');
        limiter.checkLimit('ancient');

        limiter.buckets.get('ancient').lastRefill = Date.now() - 7200000; // 2 hours

        limiter.cleanup(); // default 1 hour

        expect(limiter.buckets.has('recent')).toBe(true);
        expect(limiter.buckets.has('ancient')).toBe(false);
    });

    test('cleanup on empty limiter does not throw', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 60, burst: 0 });
        expect(() => limiter.cleanup()).not.toThrow();
        expect(limiter.buckets.size).toBe(0);
    });

    test('after cleanup, new requests to cleaned key get fresh bucket', () => {
        const limiter = new RateLimiter({ requestsPerMinute: 5, burst: 0 });

        // Use up 3 of 5 tokens for 'user'
        limiter.checkLimit('user');
        limiter.checkLimit('user');
        limiter.checkLimit('user');

        // Make it stale and clean up
        limiter.buckets.get('user').lastRefill = Date.now() - 7200000;
        limiter.cleanup(3600000);

        expect(limiter.buckets.has('user')).toBe(false);

        // New request creates fresh bucket with full capacity
        expect(limiter.checkLimit('user').allowed).toBe(true);
        const stats = limiter.getKeyStats('user');
        // Fresh bucket: capacity=5, just consumed 1, so tokens ~= 4
        expect(stats.tokens).toBe(4);
    });
});

describe('Edge: Additional TokenBucket boundary cases', () => {
    test('tryConsume with tokens=0 always succeeds', () => {
        const bucket = new TokenBucket({ capacity: 1, refillRate: 0, burst: 0 });
        bucket.tryConsume(1); // drain
        // Consuming 0 should succeed even with 0 tokens
        expect(bucket.tryConsume(0)).toBe(true);
    });

    test('getWaitTime returns correct ms when partially refilled', () => {
        const bucket = new TokenBucket({ capacity: 10, refillRate: 2, burst: 0 });
        bucket.tokens = 0;
        bucket.lastRefill = Date.now();

        // Need 1 token at 2/sec → 500ms
        const wait = bucket.getWaitTime();
        expect(wait).toBe(500);
    });

    test('burst capacity allows temporary overshoot above capacity', () => {
        const bucket = new TokenBucket({ capacity: 5, refillRate: 100, burst: 10 });
        bucket.tokens = 0;
        bucket.lastRefill = Date.now() - 10000; // 10 seconds ago

        bucket._refill();
        // Capped at capacity + burst = 15
        expect(bucket.tokens).toBe(15);

        // Should consume up to 15
        let consumed = 0;
        while (bucket.tryConsume(1)) consumed++;
        expect(consumed).toBe(15);
    });

    test('reset sets tokens to capacity, not capacity + burst', () => {
        const bucket = new TokenBucket({ capacity: 10, refillRate: 1, burst: 20 });
        bucket.tokens = 0;
        bucket.reset();
        expect(bucket.tokens).toBe(10);
    });
});
