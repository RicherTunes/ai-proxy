'use strict';

/**
 * Utility Edge-Case Tests
 *
 * Targeted TDD coverage for: backoff, lru-map, ring-buffer, redact.
 * Each test exercises a specific boundary or invariant not already
 * covered by the existing module-level test files.
 */

const { exponentialBackoff, DEFAULT_JITTER_FACTOR } = require('../lib/backoff');
const { LRUMap } = require('../lib/lru-map');
const { RingBuffer } = require('../lib/ring-buffer');
const { redactSensitiveData, REDACTED } = require('../lib/redact');

// ---------------------------------------------------------------------------
// Backoff  (lib/backoff.js)
// ---------------------------------------------------------------------------
describe('Backoff – edge cases', () => {
    // 1. Exponential growth with jitter stays within bounds
    test('exponential growth with jitter stays within theoretical bounds', () => {
        for (let attempt = 1; attempt <= 8; attempt++) {
            const baseMs = 200;
            const capMs = 100000; // high cap so we test growth, not cap
            const jitter = 0.3;

            for (let i = 0; i < 50; i++) {
                const result = exponentialBackoff({ baseMs, capMs, attempt, jitter });
                const raw = baseMs * Math.pow(2, attempt - 1);
                const lo = Math.round(raw - raw * jitter);
                const hi = Math.round(raw + raw * jitter);
                expect(result).toBeGreaterThanOrEqual(lo);
                expect(result).toBeLessThanOrEqual(hi);
            }
        }
    });

    // 2. Max backoff cap is respected
    test('result never exceeds capMs + jitter headroom', () => {
        const capMs = 3000;
        const jitter = 0.2;
        for (let i = 0; i < 200; i++) {
            const result = exponentialBackoff({ baseMs: 1000, capMs, attempt: 20, jitter });
            // raw is capped at 3000, jitter ±20% → max 3600
            expect(result).toBeLessThanOrEqual(Math.round(capMs * (1 + jitter)));
            expect(result).toBeGreaterThanOrEqual(Math.round(capMs * (1 - jitter)));
        }
    });

    // 3. Reset returns to initial delay (attempt=1 after many attempts)
    test('reset to attempt=1 returns to initial delay range', () => {
        const baseMs = 500;
        const capMs = 50000;
        // First take a high-attempt value
        const high = exponentialBackoff({ baseMs, capMs, attempt: 10, jitter: 0 });
        expect(high).toBeGreaterThan(baseMs);

        // Then "reset" by calling with attempt=1
        const reset = exponentialBackoff({ baseMs, capMs, attempt: 1, jitter: 0 });
        expect(reset).toBe(baseMs);
    });

    // 4. Custom base/multiplier/jitter work correctly
    test('custom base and jitter=0.5 produce wider spread', () => {
        const baseMs = 100;
        const capMs = 100000;
        const attempt = 3; // raw = 100 * 4 = 400
        const jitter = 0.5;
        const results = new Set();

        for (let i = 0; i < 200; i++) {
            const r = exponentialBackoff({ baseMs, capMs, attempt, jitter });
            results.add(r);
            expect(r).toBeGreaterThanOrEqual(200); // 400 - 200
            expect(r).toBeLessThanOrEqual(600);    // 400 + 200
        }
        // With 200 draws the set should have significant variety
        expect(results.size).toBeGreaterThan(1);
    });

    // 5. Zero jitter produces deterministic output
    test('zero jitter produces identical results across many calls', () => {
        const params = { baseMs: 750, capMs: 50000, attempt: 5, jitter: 0 };
        const expected = 750 * Math.pow(2, 4); // 12000
        for (let i = 0; i < 100; i++) {
            expect(exponentialBackoff(params)).toBe(expected);
        }
    });
});

// ---------------------------------------------------------------------------
// LRU Map  (lib/lru-map.js)
// ---------------------------------------------------------------------------
describe('LRUMap – edge cases', () => {
    // 6. Evicts least-recently-used when at capacity
    test('evicts LRU entry, not MRU, when at capacity', () => {
        const evicted = [];
        const map = new LRUMap(2, { onEvict: (k, v) => evicted.push(k) });

        map.set('a', 1); // order: a
        map.set('b', 2); // order: a, b
        map.set('c', 3); // evicts 'a', order: b, c

        expect(evicted).toEqual(['a']);
        expect(map.has('a')).toBe(false);
        expect(map.get('b')).toBe(2);
        expect(map.get('c')).toBe(3);
    });

    // 7. Get promotes entry to most-recently-used
    test('get promotes entry so it survives the next eviction', () => {
        const map = new LRUMap(3);
        map.set('x', 10);
        map.set('y', 20);
        map.set('z', 30);

        // Touch 'x' – should become MRU
        map.get('x');

        // Two inserts should evict 'y' then 'z', not 'x'
        map.set('w1', 40);
        map.set('w2', 50);

        expect(map.has('x')).toBe(true);
        expect(map.has('y')).toBe(false);
        expect(map.has('z')).toBe(false);
    });

    // 8. Set on existing key updates value and promotes
    test('set on existing key updates value and moves to MRU', () => {
        const map = new LRUMap(2);
        map.set('a', 1);
        map.set('b', 2);

        // Update 'a' – now MRU
        map.set('a', 100);
        expect(map.get('a')).toBe(100);

        // Inserting 'c' should evict 'b' (LRU), not 'a'
        map.set('c', 3);
        expect(map.has('a')).toBe(true);
        expect(map.has('b')).toBe(false);
        expect(map.size).toBe(2);
    });

    // 9. Delete removes entry and frees capacity
    test('delete frees capacity so next set does not evict', () => {
        const onEvict = jest.fn();
        const map = new LRUMap(2, { onEvict });

        map.set('a', 1);
        map.set('b', 2);

        map.delete('a');
        expect(map.size).toBe(1);

        map.set('c', 3); // capacity 2, size was 1 → no eviction
        expect(onEvict).not.toHaveBeenCalled();
        expect(map.size).toBe(2);
    });

    // 10. Clear empties everything
    test('clear resets size and makes all keys inaccessible', () => {
        const map = new LRUMap(5);
        for (let i = 0; i < 5; i++) map.set(`k${i}`, i);

        map.clear();

        expect(map.size).toBe(0);
        for (let i = 0; i < 5; i++) {
            expect(map.has(`k${i}`)).toBe(false);
            expect(map.get(`k${i}`)).toBeUndefined();
        }
        expect([...map.keys()]).toEqual([]);
    });

    // 11. Capacity of 1 works correctly
    test('capacity=1 always holds exactly the last inserted entry', () => {
        const evicted = [];
        const map = new LRUMap(1, { onEvict: (k) => evicted.push(k) });

        map.set('first', 1);
        expect(map.size).toBe(1);

        map.set('second', 2);
        expect(map.size).toBe(1);
        expect(map.has('first')).toBe(false);
        expect(map.get('second')).toBe(2);
        expect(evicted).toEqual(['first']);

        // Updating the single entry should NOT cause eviction
        map.set('second', 22);
        expect(map.size).toBe(1);
        expect(evicted).toEqual(['first']); // no new eviction
    });
});

// ---------------------------------------------------------------------------
// Ring Buffer  (lib/ring-buffer.js)
// ---------------------------------------------------------------------------
describe('RingBuffer – edge cases', () => {
    // 12. Push fills to capacity then overwrites oldest
    test('push fills to capacity then overwrites oldest in order', () => {
        const buf = new RingBuffer(4);

        buf.push('a');
        buf.push('b');
        buf.push('c');
        buf.push('d');
        expect(buf.isFull()).toBe(true);
        expect(buf.toArray()).toEqual(['a', 'b', 'c', 'd']);

        buf.push('e'); // overwrites 'a'
        expect(buf.toArray()).toEqual(['b', 'c', 'd', 'e']);

        buf.push('f'); // overwrites 'b'
        expect(buf.toArray()).toEqual(['c', 'd', 'e', 'f']);
    });

    // 13. Iteration returns items in insertion order
    test('iterator yields items oldest-to-newest after wrapping', () => {
        const buf = new RingBuffer(3);
        buf.push(10);
        buf.push(20);
        buf.push(30);
        buf.push(40); // overwrites 10

        const collected = [];
        for (const item of buf) {
            collected.push(item);
        }
        expect(collected).toEqual([20, 30, 40]);
    });

    // 14. toArray returns correct snapshot
    test('toArray returns a fresh array that is independent of the buffer', () => {
        const buf = new RingBuffer(3);
        buf.push(1);
        buf.push(2);

        const snap1 = buf.toArray();
        buf.push(3);
        buf.push(4); // overwrites 1

        const snap2 = buf.toArray();

        // snap1 should still reflect the state when it was taken
        expect(snap1).toEqual([1, 2]);
        expect(snap2).toEqual([2, 3, 4]);
    });

    // 15. Size never exceeds capacity
    test('size is clamped at capacity even after many pushes', () => {
        const cap = 5;
        const buf = new RingBuffer(cap);

        for (let i = 0; i < 1000; i++) {
            buf.push(i);
            expect(buf.size).toBeLessThanOrEqual(cap);
        }
        expect(buf.size).toBe(cap);
        expect(buf.length).toBe(cap);
    });

    // 16. Empty buffer returns empty array
    test('empty buffer: toArray, iterator, getRecent all return empty', () => {
        const buf = new RingBuffer(10);

        expect(buf.toArray()).toEqual([]);
        expect([...buf]).toEqual([]);
        expect(buf.getRecent(5)).toEqual([]);
        expect(buf.peek()).toBeUndefined();
        expect(buf.isEmpty()).toBe(true);
        expect(buf.size).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Redact  (lib/redact.js)
// ---------------------------------------------------------------------------
describe('Redact – edge cases', () => {
    // 17. Redacts API keys (sk-ant-xxx patterns)
    test('redacts sk-ant- prefixed API keys in string values', () => {
        const input = {
            info: 'key is sk-ant-api03-ABCDEFGHIJ1234567890abcdef'
        };
        const output = redactSensitiveData(input);

        expect(output.info).not.toContain('ABCDEFGHIJ1234567890abcdef');
        expect(output.info).toContain('sk-ant-api...');
    });

    // 18. Redacts Bearer tokens
    test('redacts Bearer tokens in non-authorization headers', () => {
        const input = {
            headers: {
                'x-forwarded-auth': 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.longtoken'
            }
        };
        const output = redactSensitiveData(input);

        // The header value starts with "Bearer ", so redactHeaders will trim
        expect(output.headers['x-forwarded-auth']).toMatch(/^Bearer .+\.\.\./);
        expect(output.headers['x-forwarded-auth']).not.toContain('longtoken');
    });

    // 19. Preserves non-sensitive fields
    test('preserves non-sensitive scalar fields unchanged', () => {
        const input = {
            status: 200,
            model: 'claude-3-opus',
            active: true,
            timestamp: '2025-01-15T12:00:00Z',
            count: 0
        };
        const output = redactSensitiveData(input);

        expect(output).toEqual(input);
    });

    // 20. Handles nested objects
    test('recursively redacts sensitive fields in deeply nested objects', () => {
        const input = {
            outer: {
                middle: {
                    inner: {
                        password: 'super-secret-password-value',
                        safeField: 'visible'
                    }
                }
            }
        };
        const output = redactSensitiveData(input);

        expect(output.outer.middle.inner.password).toContain('...');
        expect(output.outer.middle.inner.password).not.toContain('super-secret-password-value');
        expect(output.outer.middle.inner.safeField).toBe('visible');
    });

    // 21. Handles arrays
    test('redacts sensitive patterns inside arrays of mixed types', () => {
        const input = [
            'plain text',
            'contains sk-ant-api03-XYZXYZXYZXYZ1234',
            42,
            { token: 'some-long-token-value-here' },
            null
        ];
        const output = redactSensitiveData(input);

        // Plain text preserved
        expect(output[0]).toBe('plain text');
        // sk-ant pattern redacted
        expect(output[1]).not.toContain('XYZXYZXYZXYZ1234');
        expect(output[1]).toContain('...');
        // number preserved
        expect(output[2]).toBe(42);
        // sensitive field in object redacted
        expect(output[3].token).toContain('...');
        expect(output[3].token).not.toBe('some-long-token-value-here');
        // null preserved
        expect(output[4]).toBeNull();
    });

    // 22. Doesn't mutate original object
    test('original object is not mutated after redaction', () => {
        const inner = { secret: 'deep-secret-value-long', safe: 'ok' };
        const original = {
            apikey: 'my-api-key-value-long',
            data: [1, 2, 3],
            nested: inner,
            text: 'has sk-ant-api03-ABCDEFGHIJ in it'
        };

        // Capture original values
        const origApikey = original.apikey;
        const origSecret = original.nested.secret;
        const origText = original.text;
        const origData = [...original.data];

        const output = redactSensitiveData(original);

        // Output should be redacted
        expect(output.apikey).not.toBe(origApikey);
        expect(output.nested.secret).not.toBe(origSecret);

        // Original must be untouched
        expect(original.apikey).toBe(origApikey);
        expect(original.nested.secret).toBe(origSecret);
        expect(original.text).toBe(origText);
        expect(original.data).toEqual(origData);

        // Mutating output must not affect original
        output.nested.safe = 'CHANGED';
        expect(original.nested.safe).toBe('ok');
    });
});
