/**
 * RingBuffer Tests (merged from CircularBuffer)
 */

const { RingBuffer } = require('../lib/ring-buffer');

describe('RingBuffer', () => {
    describe('constructor', () => {
        test('should create buffer with specified capacity', () => {
            const buffer = new RingBuffer(100);
            expect(buffer.capacity).toBe(100);
            expect(buffer.length).toBe(0);
        });

        test('should create buffer with custom capacity', () => {
            const buffer = new RingBuffer(50);
            expect(buffer.capacity).toBe(50);
        });

        test('should throw for invalid capacity', () => {
            expect(() => new RingBuffer(0)).toThrow();
            expect(() => new RingBuffer(-1)).toThrow();
            expect(() => new RingBuffer(1.5)).toThrow();
        });
    });

    describe('push', () => {
        test('should add items to buffer', () => {
            const buffer = new RingBuffer(5);
            buffer.push(1);
            buffer.push(2);
            buffer.push(3);
            expect(buffer.length).toBe(3);
        });

        test('should overwrite oldest items when full', () => {
            const buffer = new RingBuffer(3);
            buffer.push(1);
            buffer.push(2);
            buffer.push(3);
            buffer.push(4); // Should overwrite 1
            buffer.push(5); // Should overwrite 2

            expect(buffer.length).toBe(3);
            expect(buffer.toArray()).toEqual([3, 4, 5]);
        });

        test('should be O(1) operation', () => {
            const buffer = new RingBuffer(10000);
            const start = Date.now();
            for (let i = 0; i < 100000; i++) {
                buffer.push(i);
            }
            const elapsed = Date.now() - start;
            // Should complete quickly (under 100ms for 100k operations)
            expect(elapsed).toBeLessThan(100);
        });
    });

    describe('toArray', () => {
        test('should return empty array for empty buffer', () => {
            const buffer = new RingBuffer(5);
            expect(buffer.toArray()).toEqual([]);
        });

        test('should return items in order (oldest to newest)', () => {
            const buffer = new RingBuffer(5);
            buffer.push(10);
            buffer.push(20);
            buffer.push(30);
            expect(buffer.toArray()).toEqual([10, 20, 30]);
        });

        test('should return items in order after wrap', () => {
            const buffer = new RingBuffer(3);
            buffer.push(1);
            buffer.push(2);
            buffer.push(3);
            buffer.push(4);
            buffer.push(5);
            expect(buffer.toArray()).toEqual([3, 4, 5]);
        });
    });

    describe('average', () => {
        test('should return null for empty buffer', () => {
            const buffer = new RingBuffer(5);
            expect(buffer.average()).toBeNull();
        });

        test('should calculate average correctly', () => {
            const buffer = new RingBuffer(5);
            buffer.push(10);
            buffer.push(20);
            buffer.push(30);
            expect(buffer.average()).toBe(20);
        });

        test('should calculate average after wrap', () => {
            const buffer = new RingBuffer(3);
            buffer.push(1);
            buffer.push(2);
            buffer.push(3);
            buffer.push(100); // Overwrites 1
            buffer.push(200); // Overwrites 2
            // Buffer now contains [3, 100, 200]
            expect(buffer.average()).toBe(101);
        });

        test('should round average to integer', () => {
            const buffer = new RingBuffer(3);
            buffer.push(1);
            buffer.push(2);
            buffer.push(3);
            // Average is 2 (exact)
            expect(buffer.average()).toBe(2);

            buffer.push(4); // [2, 3, 4] avg = 3
            expect(buffer.average()).toBe(3);
        });
    });

    describe('stats', () => {
        test('should return null stats for empty buffer', () => {
            const buffer = new RingBuffer(5);
            const stats = buffer.stats();
            expect(stats.count).toBe(0);
            expect(stats.avg).toBeNull();
            expect(stats.min).toBeNull();
            expect(stats.max).toBeNull();
        });

        test('should return correct statistics', () => {
            const buffer = new RingBuffer(10);
            buffer.push(100);
            buffer.push(200);
            buffer.push(300);
            buffer.push(400);
            buffer.push(500);

            const stats = buffer.stats();
            expect(stats.count).toBe(5);
            expect(stats.avg).toBe(300);
            expect(stats.min).toBe(100);
            expect(stats.max).toBe(500);
            expect(stats.p50).toBe(300);
        });

        test('should calculate percentiles using nearest-rank method', () => {
            const buffer = new RingBuffer(100);
            // Add values 1-100
            for (let i = 1; i <= 100; i++) {
                buffer.push(i);
            }

            const stats = buffer.stats();
            // nearest-rank: index = ceil(percentile * n) - 1
            // p50: ceil(0.5 * 100) - 1 = 49 -> values[49] = 50
            expect(stats.p50).toBe(50);
            // p95: ceil(0.95 * 100) - 1 = 94 -> values[94] = 95
            expect(stats.p95).toBe(95);
            // p99: ceil(0.99 * 100) - 1 = 98 -> values[98] = 99
            expect(stats.p99).toBe(99);
        });

        test('should calculate nearest-rank percentiles for small datasets', () => {
            const buffer = new RingBuffer(10);
            // Dataset: [10, 20, 30, 40, 50]
            buffer.push(10);
            buffer.push(20);
            buffer.push(30);
            buffer.push(40);
            buffer.push(50);

            const stats = buffer.stats();
            // n=5
            // p50: ceil(0.5 * 5) - 1 = 3 - 1 = 2 -> values[2] = 30
            expect(stats.p50).toBe(30);
            // p95: ceil(0.95 * 5) - 1 = 5 - 1 = 4 -> values[4] = 50
            expect(stats.p95).toBe(50);
            // p99: ceil(0.99 * 5) - 1 = 5 - 1 = 4 -> values[4] = 50
            expect(stats.p99).toBe(50);
        });

        test('should handle single-element dataset', () => {
            const buffer = new RingBuffer(5);
            buffer.push(42);

            const stats = buffer.stats();
            expect(stats.count).toBe(1);
            expect(stats.avg).toBe(42);
            expect(stats.min).toBe(42);
            expect(stats.max).toBe(42);
            // p50: ceil(0.5 * 1) - 1 = 1 - 1 = 0 -> values[0] = 42
            expect(stats.p50).toBe(42);
            expect(stats.p95).toBe(42);
            expect(stats.p99).toBe(42);
        });

        test('should calculate nearest-rank percentiles for 20-element dataset', () => {
            const buffer = new RingBuffer(20);
            // Values 1-20
            for (let i = 1; i <= 20; i++) {
                buffer.push(i);
            }

            const stats = buffer.stats();
            // n=20
            // p50: ceil(0.5 * 20) - 1 = 10 - 1 = 9 -> values[9] = 10
            expect(stats.p50).toBe(10);
            // p95: ceil(0.95 * 20) - 1 = 19 - 1 = 18 -> values[18] = 19
            expect(stats.p95).toBe(19);
            // p99: ceil(0.99 * 20) - 1 = 20 - 1 = 19 -> values[19] = 20
            expect(stats.p99).toBe(20);
        });
    });

    describe('clear', () => {
        test('should clear buffer', () => {
            const buffer = new RingBuffer(5);
            buffer.push(1);
            buffer.push(2);
            buffer.push(3);

            buffer.clear();

            expect(buffer.length).toBe(0);
            expect(buffer.toArray()).toEqual([]);
            expect(buffer.average()).toBeNull();
        });
    });

    describe('length', () => {
        test('should return current size', () => {
            const buffer = new RingBuffer(5);
            expect(buffer.length).toBe(0);

            buffer.push(1);
            expect(buffer.length).toBe(1);

            buffer.push(2);
            buffer.push(3);
            expect(buffer.length).toBe(3);
        });

        test('should not exceed capacity', () => {
            const buffer = new RingBuffer(3);
            buffer.push(1);
            buffer.push(2);
            buffer.push(3);
            buffer.push(4);
            buffer.push(5);

            expect(buffer.length).toBe(3);
        });
    });
});
