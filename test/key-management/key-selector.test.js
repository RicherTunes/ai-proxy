/**
 * Unit Test: Key Selector Module
 *
 * Tests the KeySelector interface class.
 */

'use strict';

const { KeySelector } = require('../../lib/key-management/key-selector');

describe('key-selector', () => {
    describe('constructor', () => {
        it('should create a new KeySelector', () => {
            const mockSelectKey = jest.fn(() => ({ keyId: 'test-key' }));
            const selector = new KeySelector({
                selectKeyFn: mockSelectKey,
                acquireKeyFn: jest.fn()
            });

            expect(selector).toBeInstanceOf(KeySelector);
        });

        it('should use provided config', () => {
            const config = {
                useWeightedSelection: false,
                healthScoreWeights: { latency: 50, successRate: 30, errorRecency: 20 }
            };
            const selector = new KeySelector({ config });

            expect(selector.getConfig()).toEqual(config);
        });

        it('should use default config when not provided', () => {
            const selector = new KeySelector({});

            expect(selector.getConfig().useWeightedSelection).toBe(true);
            expect(selector.getConfig().healthScoreWeights).toEqual({
                latency: 40,
                successRate: 40,
                errorRecency: 20
            });
        });
    });

    describe('selectKey', () => {
        it('should call selectKeyFn with excludeIndices', () => {
            const mockSelectKey = jest.fn(() => ({ keyId: 'test-key' }));
            const selector = new KeySelector({ selectKeyFn: mockSelectKey });

            const exclude = [0, 1];
            selector.selectKey(exclude);

            expect(mockSelectKey).toHaveBeenCalledWith(exclude);
        });

        it('should return result from selectKeyFn', () => {
            const expectedKey = { keyId: 'test-key', index: 0 };
            const mockSelectKey = jest.fn(() => expectedKey);
            const selector = new KeySelector({ selectKeyFn: mockSelectKey });

            const result = selector.selectKey();

            expect(result).toEqual(expectedKey);
        });

        it('should throw when selectKeyFn not provided', () => {
            const selector = new KeySelector({});

            expect(() => selector.selectKey()).toThrow('selectKeyFn not provided');
        });
    });

    describe('acquireKey', () => {
        it('should call acquireKeyFn with excludeIndices', async () => {
            const expectedKey = { keyId: 'test-key', index: 0 };
            const mockAcquireKey = jest.fn().mockResolvedValue(expectedKey);
            const selector = new KeySelector({ acquireKeyFn: mockAcquireKey });

            const exclude = [0, 1];
            const result = await selector.acquireKey(exclude);

            expect(mockAcquireKey).toHaveBeenCalledWith(exclude);
            expect(result).toEqual(expectedKey);
        });

        it('should throw when acquireKeyFn not provided', async () => {
            const selector = new KeySelector({});

            await expect(selector.acquireKey()).rejects.toThrow('acquireKeyFn not provided');
        });
    });

    describe('config management', () => {
        it('should update config with setConfig', () => {
            const selector = new KeySelector({
                config: { useWeightedSelection: true }
            });

            selector.setConfig({ useWeightedSelection: false });

            expect(selector.getConfig().useWeightedSelection).toBe(false);
        });

        it('should merge config with setConfig', () => {
            const selector = new KeySelector({
                config: {
                    useWeightedSelection: true,
                    healthScoreWeights: { latency: 40, successRate: 40, errorRecency: 20 }
                }
            });

            selector.setConfig({ useWeightedSelection: false });

            expect(selector.getConfig().useWeightedSelection).toBe(false);
            expect(selector.getConfig().healthScoreWeights).toEqual({
                latency: 40,
                successRate: 40,
                errorRecency: 20
            });
        });
    });

    describe('isWeightedSelectionEnabled', () => {
        it('should return true when weighted selection enabled', () => {
            const selector = new KeySelector({
                config: { useWeightedSelection: true }
            });

            expect(selector.isWeightedSelectionEnabled()).toBe(true);
        });

        it('should return false when weighted selection disabled', () => {
            const selector = new KeySelector({
                config: { useWeightedSelection: false }
            });

            expect(selector.isWeightedSelectionEnabled()).toBe(false);
        });
    });

    describe('getHealthScoreWeights', () => {
        it('should return health score weights', () => {
            const weights = { latency: 50, successRate: 30, errorRecency: 20 };
            const selector = new KeySelector({
                config: { healthScoreWeights: weights }
            });

            expect(selector.getHealthScoreWeights()).toEqual(weights);
        });
    });

    describe('interface contract', () => {
        it('should have selectKey method', () => {
            const selector = new KeySelector({ selectKeyFn: () => {} });
            expect(typeof selector.selectKey).toBe('function');
        });

        it('should have acquireKey method', () => {
            const selector = new KeySelector({ acquireKeyFn: () => {} });
            expect(typeof selector.acquireKey).toBe('function');
        });

        it('should have getConfig method', () => {
            const selector = new KeySelector({});
            expect(typeof selector.getConfig).toBe('function');
        });

        it('should have setConfig method', () => {
            const selector = new KeySelector({});
            expect(typeof selector.setConfig).toBe('function');
        });
    });
});
