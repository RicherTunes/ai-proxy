'use strict';

const { LRUMap } = require('../lib/lru-map');

describe('LRUMap - Constructor Default Parameters', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    // Covers line 12: constructor(maxSize = 1000, options = {}) default for maxSize
    test('constructor with no arguments uses default maxSize of 1000', () => {
        const map = new LRUMap(); // No arguments - tests default parameters

        // Verify maxSize is 1000 by filling to capacity and triggering eviction
        for (let i = 0; i < 1000; i++) {
            map.set(`key-${i}`, i);
        }

        expect(map.size).toBe(1000);

        // Adding one more should trigger eviction
        map.set('overflow', -1);
        expect(map.size).toBe(1000);
        expect(map.has('key-0')).toBe(false); // First key evicted
        expect(map.get('overflow')).toBe(-1);

        const stats = map.getStats();
        expect(stats.maxSize).toBe(1000);
        expect(stats.evictions).toBe(1);
    });

    // Covers line 12: options = {} default parameter
    test('constructor with only maxSize uses empty options default', () => {
        const map = new LRUMap(5); // maxSize provided, options uses default {}

        // Should work without logger or onEvict
        map.set('a', 1);
        map.set('b', 2);
        expect(map.get('a')).toBe(1);
        expect(map.size).toBe(2);

        // Trigger evictions - should not throw when logger is null
        for (let i = 0; i < 100; i++) {
            map.set(`key-${i}`, i);
        }

        const stats = map.getStats();
        // 2 initial + 100 added = 102 total, capacity 5, so 97 evictions
        expect(stats.evictions).toBe(97);
        expect(stats.maxSize).toBe(5);
    });
});
