'use strict';

const { RingBuffer } = require('../lib/ring-buffer');

describe('RingBuffer', () => {
    describe('constructor', () => {
        it('creates buffer with specified capacity', () => {
            const buffer = new RingBuffer(5);
            expect(buffer.capacity).toBe(5);
            expect(buffer.length).toBe(0);
        });

        it('throws on invalid capacity', () => {
            expect(() => new RingBuffer(0)).toThrow('positive integer');
            expect(() => new RingBuffer(-1)).toThrow('positive integer');
            expect(() => new RingBuffer(1.5)).toThrow('positive integer');
            expect(() => new RingBuffer('5')).toThrow('positive integer');
        });
    });

    describe('push', () => {
        it('adds items to empty buffer', () => {
            const buffer = new RingBuffer(5);
            buffer.push(1);
            buffer.push(2);
            buffer.push(3);

            expect(buffer.length).toBe(3);
            expect(buffer.toArray()).toEqual([1, 2, 3]);
        });

        it('overwrites oldest when at capacity', () => {
            const buffer = new RingBuffer(3);
            buffer.push(1);
            buffer.push(2);
            buffer.push(3);
            buffer.push(4);  // Overwrites 1

            expect(buffer.length).toBe(3);
            expect(buffer.toArray()).toEqual([2, 3, 4]);
        });

        it('handles continuous overwrites', () => {
            const buffer = new RingBuffer(3);
            for (let i = 1; i <= 10; i++) {
                buffer.push(i);
            }

            expect(buffer.length).toBe(3);
            expect(buffer.toArray()).toEqual([8, 9, 10]);
        });

        it('handles single-capacity buffer', () => {
            const buffer = new RingBuffer(1);
            buffer.push('a');
            expect(buffer.toArray()).toEqual(['a']);

            buffer.push('b');
            expect(buffer.toArray()).toEqual(['b']);
        });
    });

    describe('toArray', () => {
        it('returns empty array for empty buffer', () => {
            const buffer = new RingBuffer(5);
            expect(buffer.toArray()).toEqual([]);
        });

        it('returns items in insertion order (oldest first)', () => {
            const buffer = new RingBuffer(5);
            buffer.push('a');
            buffer.push('b');
            buffer.push('c');

            expect(buffer.toArray()).toEqual(['a', 'b', 'c']);
        });

        it('maintains order after wrapping', () => {
            const buffer = new RingBuffer(3);
            buffer.push('a');
            buffer.push('b');
            buffer.push('c');
            buffer.push('d');
            buffer.push('e');

            // Oldest to newest: c, d, e (a and b were overwritten)
            expect(buffer.toArray()).toEqual(['c', 'd', 'e']);
        });
    });

    describe('getRecent', () => {
        it('returns empty array for empty buffer', () => {
            const buffer = new RingBuffer(5);
            expect(buffer.getRecent(3)).toEqual([]);
        });

        it('returns items in reverse chronological order (newest first)', () => {
            const buffer = new RingBuffer(5);
            buffer.push(1);
            buffer.push(2);
            buffer.push(3);

            expect(buffer.getRecent(2)).toEqual([3, 2]);
            expect(buffer.getRecent(3)).toEqual([3, 2, 1]);
        });

        it('handles request for more items than available', () => {
            const buffer = new RingBuffer(5);
            buffer.push(1);
            buffer.push(2);

            expect(buffer.getRecent(10)).toEqual([2, 1]);
        });

        it('works correctly after wrapping', () => {
            const buffer = new RingBuffer(3);
            buffer.push(1);
            buffer.push(2);
            buffer.push(3);
            buffer.push(4);
            buffer.push(5);

            // Buffer now has [3, 4, 5], newest is 5
            expect(buffer.getRecent(2)).toEqual([5, 4]);
            expect(buffer.getRecent(3)).toEqual([5, 4, 3]);
        });

        it('returns empty for count <= 0', () => {
            const buffer = new RingBuffer(5);
            buffer.push(1);
            expect(buffer.getRecent(0)).toEqual([]);
            expect(buffer.getRecent(-1)).toEqual([]);
        });
    });

    describe('get', () => {
        it('returns item at index (0 = oldest)', () => {
            const buffer = new RingBuffer(5);
            buffer.push('a');
            buffer.push('b');
            buffer.push('c');

            expect(buffer.get(0)).toBe('a');
            expect(buffer.get(1)).toBe('b');
            expect(buffer.get(2)).toBe('c');
        });

        it('returns undefined for out of bounds', () => {
            const buffer = new RingBuffer(5);
            buffer.push('a');

            expect(buffer.get(-1)).toBeUndefined();
            expect(buffer.get(1)).toBeUndefined();
            expect(buffer.get(100)).toBeUndefined();
        });

        it('works correctly after wrapping', () => {
            const buffer = new RingBuffer(3);
            buffer.push(1);
            buffer.push(2);
            buffer.push(3);
            buffer.push(4);  // Overwrites 1

            expect(buffer.get(0)).toBe(2);  // Oldest is now 2
            expect(buffer.get(1)).toBe(3);
            expect(buffer.get(2)).toBe(4);  // Newest
        });
    });

    describe('peek', () => {
        it('returns most recent item', () => {
            const buffer = new RingBuffer(5);
            buffer.push(1);
            buffer.push(2);
            buffer.push(3);

            expect(buffer.peek()).toBe(3);
        });

        it('returns undefined for empty buffer', () => {
            const buffer = new RingBuffer(5);
            expect(buffer.peek()).toBeUndefined();
        });

        it('works after wrapping', () => {
            const buffer = new RingBuffer(3);
            buffer.push(1);
            buffer.push(2);
            buffer.push(3);
            buffer.push(4);

            expect(buffer.peek()).toBe(4);
        });
    });

    describe('clear', () => {
        it('removes all items', () => {
            const buffer = new RingBuffer(5);
            buffer.push(1);
            buffer.push(2);
            buffer.push(3);

            buffer.clear();

            expect(buffer.length).toBe(0);
            expect(buffer.isEmpty()).toBe(true);
            expect(buffer.toArray()).toEqual([]);
        });

        it('allows reuse after clear', () => {
            const buffer = new RingBuffer(3);
            buffer.push(1);
            buffer.push(2);
            buffer.push(3);
            buffer.clear();

            buffer.push('a');
            buffer.push('b');

            expect(buffer.toArray()).toEqual(['a', 'b']);
        });
    });

    describe('isEmpty and isFull', () => {
        it('isEmpty returns true for empty buffer', () => {
            const buffer = new RingBuffer(5);
            expect(buffer.isEmpty()).toBe(true);

            buffer.push(1);
            expect(buffer.isEmpty()).toBe(false);
        });

        it('isFull returns true when at capacity', () => {
            const buffer = new RingBuffer(3);
            expect(buffer.isFull()).toBe(false);

            buffer.push(1);
            buffer.push(2);
            expect(buffer.isFull()).toBe(false);

            buffer.push(3);
            expect(buffer.isFull()).toBe(true);

            buffer.push(4);  // Still full after overwrite
            expect(buffer.isFull()).toBe(true);
        });
    });

    describe('iterator', () => {
        it('iterates from oldest to newest', () => {
            const buffer = new RingBuffer(5);
            buffer.push('a');
            buffer.push('b');
            buffer.push('c');

            const items = [...buffer];
            expect(items).toEqual(['a', 'b', 'c']);
        });

        it('works with for...of loop', () => {
            const buffer = new RingBuffer(3);
            buffer.push(1);
            buffer.push(2);
            buffer.push(3);
            buffer.push(4);

            const items = [];
            for (const item of buffer) {
                items.push(item);
            }
            expect(items).toEqual([2, 3, 4]);
        });

        it('yields nothing for empty buffer', () => {
            const buffer = new RingBuffer(5);
            expect([...buffer]).toEqual([]);
        });
    });

    describe('use cases', () => {
        it('works as latency sample buffer', () => {
            const samples = new RingBuffer(100);

            // Simulate adding latency measurements
            for (let i = 0; i < 150; i++) {
                samples.push(Math.random() * 1000);
            }

            expect(samples.length).toBe(100);

            // Calculate percentiles from samples
            const sorted = samples.toArray().sort((a, b) => a - b);
            const p50 = sorted[Math.floor(sorted.length * 0.5)];
            const p95 = sorted[Math.floor(sorted.length * 0.95)];

            expect(typeof p50).toBe('number');
            expect(typeof p95).toBe('number');
            expect(p95).toBeGreaterThanOrEqual(p50);
        });

        it('works as request log buffer', () => {
            const requests = new RingBuffer(1000);

            // Simulate logging requests
            for (let i = 0; i < 2000; i++) {
                requests.push({
                    id: i,
                    timestamp: Date.now(),
                    path: '/api/test',
                    status: 200
                });
            }

            expect(requests.length).toBe(1000);

            // Get recent 10 requests
            const recent = requests.getRecent(10);
            expect(recent.length).toBe(10);
            expect(recent[0].id).toBe(1999);  // Most recent
            expect(recent[9].id).toBe(1990);
        });
    });
});
