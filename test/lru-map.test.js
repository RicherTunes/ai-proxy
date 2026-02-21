'use strict';

const { LRUMap } = require('../lib/lru-map');

describe('LRUMap', () => {
    describe('basic operations', () => {
        test('set and get', () => {
            const map = new LRUMap(10);
            map.set('a', 1);
            map.set('b', 2);
            expect(map.get('a')).toBe(1);
            expect(map.get('b')).toBe(2);
        });

        test('has', () => {
            const map = new LRUMap(10);
            map.set('a', 1);
            expect(map.has('a')).toBe(true);
            expect(map.has('b')).toBe(false);
        });

        test('delete', () => {
            const map = new LRUMap(10);
            map.set('a', 1);
            expect(map.delete('a')).toBe(true);
            expect(map.has('a')).toBe(false);
            expect(map.delete('nonexistent')).toBe(false);
        });

        test('clear', () => {
            const map = new LRUMap(10);
            map.set('a', 1);
            map.set('b', 2);
            map.clear();
            expect(map.size).toBe(0);
            expect(map.get('a')).toBeUndefined();
        });

        test('size', () => {
            const map = new LRUMap(10);
            expect(map.size).toBe(0);
            map.set('a', 1);
            expect(map.size).toBe(1);
            map.set('b', 2);
            expect(map.size).toBe(2);
            map.delete('a');
            expect(map.size).toBe(1);
        });

        test('get returns undefined for missing key', () => {
            const map = new LRUMap(10);
            expect(map.get('nonexistent')).toBeUndefined();
        });

        test('set overwrites existing key', () => {
            const map = new LRUMap(10);
            map.set('a', 1);
            map.set('a', 2);
            expect(map.get('a')).toBe(2);
            expect(map.size).toBe(1);
        });
    });

    describe('LRU eviction', () => {
        test('evicts oldest entry when over capacity', () => {
            const map = new LRUMap(3);
            map.set('a', 1);
            map.set('b', 2);
            map.set('c', 3);
            map.set('d', 4); // should evict 'a'

            expect(map.has('a')).toBe(false);
            expect(map.has('b')).toBe(true);
            expect(map.has('c')).toBe(true);
            expect(map.has('d')).toBe(true);
            expect(map.size).toBe(3);
        });

        test('get() refreshes entry position (prevents eviction)', () => {
            const map = new LRUMap(3);
            map.set('a', 1);
            map.set('b', 2);
            map.set('c', 3);

            // Access 'a' to make it recently used
            map.get('a');

            map.set('d', 4); // should evict 'b' (oldest unused), not 'a'

            expect(map.has('a')).toBe(true);
            expect(map.has('b')).toBe(false);
            expect(map.has('c')).toBe(true);
            expect(map.has('d')).toBe(true);
        });

        test('set() with existing key refreshes position', () => {
            const map = new LRUMap(3);
            map.set('a', 1);
            map.set('b', 2);
            map.set('c', 3);

            // Update 'a' to refresh its position
            map.set('a', 10);

            map.set('d', 4); // should evict 'b', not 'a'

            expect(map.has('a')).toBe(true);
            expect(map.get('a')).toBe(10);
            expect(map.has('b')).toBe(false);
        });

        test('eviction order follows LRU policy', () => {
            const evicted = [];
            const map = new LRUMap(3, {
                onEvict: (key, value) => evicted.push({ key, value })
            });

            map.set('a', 1);
            map.set('b', 2);
            map.set('c', 3);
            map.set('d', 4); // evicts a
            map.set('e', 5); // evicts b

            expect(evicted).toEqual([
                { key: 'a', value: 1 },
                { key: 'b', value: 2 }
            ]);
        });
    });

    describe('onEvict callback', () => {
        test('called with key and value on eviction', () => {
            const evicted = [];
            const map = new LRUMap(2, {
                onEvict: (key, value) => evicted.push({ key, value })
            });

            map.set('a', 'alpha');
            map.set('b', 'beta');
            map.set('c', 'charlie'); // evicts 'a'

            expect(evicted).toEqual([{ key: 'a', value: 'alpha' }]);
        });

        test('not called when no eviction needed', () => {
            const onEvict = jest.fn();
            const map = new LRUMap(10, { onEvict });

            map.set('a', 1);
            map.set('b', 2);

            expect(onEvict).not.toHaveBeenCalled();
        });
    });

    describe('getStats', () => {
        test('reports correct stats', () => {
            const map = new LRUMap(3);
            map.set('a', 1);
            map.set('b', 2);
            map.set('c', 3);

            let stats = map.getStats();
            expect(stats.size).toBe(3);
            expect(stats.maxSize).toBe(3);
            expect(stats.evictions).toBe(0);

            map.set('d', 4); // evict 'a'

            stats = map.getStats();
            expect(stats.size).toBe(3);
            expect(stats.evictions).toBe(1);
        });
    });

    describe('iteration', () => {
        test('keys()', () => {
            const map = new LRUMap(10);
            map.set('a', 1);
            map.set('b', 2);
            expect([...map.keys()]).toEqual(['a', 'b']);
        });

        test('values()', () => {
            const map = new LRUMap(10);
            map.set('a', 1);
            map.set('b', 2);
            expect([...map.values()]).toEqual([1, 2]);
        });

        test('entries()', () => {
            const map = new LRUMap(10);
            map.set('a', 1);
            map.set('b', 2);
            expect([...map.entries()]).toEqual([['a', 1], ['b', 2]]);
        });

        test('forEach', () => {
            const map = new LRUMap(10);
            map.set('a', 1);
            map.set('b', 2);
            const result = [];
            map.forEach((value, key) => result.push({ key, value }));
            expect(result).toEqual([
                { key: 'a', value: 1 },
                { key: 'b', value: 2 }
            ]);
        });

        test('Symbol.iterator', () => {
            const map = new LRUMap(10);
            map.set('a', 1);
            map.set('b', 2);
            const result = [...map];
            expect(result).toEqual([['a', 1], ['b', 2]]);
        });
    });

    describe('capacity edge cases', () => {
        test('capacity of 1', () => {
            const map = new LRUMap(1);
            map.set('a', 1);
            expect(map.get('a')).toBe(1);
            map.set('b', 2); // evicts 'a'
            expect(map.has('a')).toBe(false);
            expect(map.get('b')).toBe(2);
            expect(map.size).toBe(1);
        });

        test('large capacity', () => {
            const map = new LRUMap(10000);
            for (let i = 0; i < 10000; i++) {
                map.set(`key-${i}`, i);
            }
            expect(map.size).toBe(10000);
            map.set('overflow', -1);
            expect(map.size).toBe(10000);
            expect(map.has('key-0')).toBe(false); // first one evicted
        });
    });
});
