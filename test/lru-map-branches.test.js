'use strict';

const { LRUMap } = require('../lib/lru-map');

describe('LRUMap - Branch Coverage', () => {
    describe('eviction milestone logging', () => {
        test('should log on 100th eviction', () => {
            const mockLogger = { debug: jest.fn() };
            const map = new LRUMap(2, { logger: mockLogger });

            // Trigger exactly 100 evictions
            // With maxSize=2, we need to add 102 items total (first 2 fill the map, next 100 cause evictions)
            for (let i = 0; i < 102; i++) {
                map.set(`key-${i}`, i);
            }

            // Should have logged once at eviction #100
            expect(mockLogger.debug).toHaveBeenCalledWith('LRUMap eviction milestone', {
                evictions: 100,
                maxSize: 2
            });
            expect(mockLogger.debug).toHaveBeenCalledTimes(1);
        });

        test('should log on 200th eviction', () => {
            const mockLogger = { debug: jest.fn() };
            const map = new LRUMap(2, { logger: mockLogger });

            // Trigger 200 evictions
            for (let i = 0; i < 202; i++) {
                map.set(`key-${i}`, i);
            }

            // Should have logged twice (at 100 and 200)
            expect(mockLogger.debug).toHaveBeenCalledTimes(2);
            expect(mockLogger.debug).toHaveBeenNthCalledWith(1, 'LRUMap eviction milestone', {
                evictions: 100,
                maxSize: 2
            });
            expect(mockLogger.debug).toHaveBeenNthCalledWith(2, 'LRUMap eviction milestone', {
                evictions: 200,
                maxSize: 2
            });
        });

        test('should not log milestone without logger', () => {
            const map = new LRUMap(2); // No logger

            // Trigger 100 evictions - should not throw
            for (let i = 0; i < 102; i++) {
                map.set(`key-${i}`, i);
            }

            expect(map.getStats().evictions).toBe(100);
        });

        test('should not log for evictions not divisible by 100', () => {
            const mockLogger = { debug: jest.fn() };
            const map = new LRUMap(2, { logger: mockLogger });

            // Trigger exactly 99 evictions
            for (let i = 0; i < 101; i++) {
                map.set(`key-${i}`, i);
            }

            // Should not have logged (99 evictions)
            expect(mockLogger.debug).not.toHaveBeenCalled();
            expect(map.getStats().evictions).toBe(99);
        });
    });
});
