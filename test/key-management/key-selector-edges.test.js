/**
 * Edge-case tests for KeySelector
 *
 * Covers: isWeightedSelectionEnabled, getHealthScoreWeights, selectKey when
 * all keys at capacity / all in cooldown, setConfig runtime update, getConfig snapshot.
 */

'use strict';

const { KeySelector } = require('../../lib/key-management/key-selector');

describe('key-selector edge cases', () => {
    // ---------------------------------------------------------------
    // 8. isWeightedSelectionEnabled — returns correct boolean
    // ---------------------------------------------------------------
    describe('isWeightedSelectionEnabled', () => {
        it('should return true when useWeightedSelection is true', () => {
            const selector = new KeySelector({
                config: { useWeightedSelection: true }
            });
            expect(selector.isWeightedSelectionEnabled()).toBe(true);
        });

        it('should return false when useWeightedSelection is false', () => {
            const selector = new KeySelector({
                config: { useWeightedSelection: false }
            });
            expect(selector.isWeightedSelectionEnabled()).toBe(false);
        });

        it('should return true with default config (no explicit config)', () => {
            const selector = new KeySelector({});
            expect(selector.isWeightedSelectionEnabled()).toBe(true);
        });

        it('should reflect runtime config change', () => {
            const selector = new KeySelector({
                config: { useWeightedSelection: true }
            });
            expect(selector.isWeightedSelectionEnabled()).toBe(true);

            selector.setConfig({ useWeightedSelection: false });
            expect(selector.isWeightedSelectionEnabled()).toBe(false);
        });
    });

    // ---------------------------------------------------------------
    // 9. getHealthScoreWeights — returns configured weights
    // ---------------------------------------------------------------
    describe('getHealthScoreWeights', () => {
        it('should return custom weights when configured', () => {
            const weights = { latency: 60, successRate: 25, errorRecency: 15 };
            const selector = new KeySelector({
                config: { healthScoreWeights: weights }
            });

            expect(selector.getHealthScoreWeights()).toEqual(weights);
        });

        it('should return default weights when using default config', () => {
            const selector = new KeySelector({});

            expect(selector.getHealthScoreWeights()).toEqual({
                latency: 40,
                successRate: 40,
                errorRecency: 20
            });
        });

        it('should reflect updated weights after setConfig', () => {
            const selector = new KeySelector({
                config: {
                    healthScoreWeights: { latency: 40, successRate: 40, errorRecency: 20 }
                }
            });

            const newWeights = { latency: 10, successRate: 80, errorRecency: 10 };
            selector.setConfig({ healthScoreWeights: newWeights });

            expect(selector.getHealthScoreWeights()).toEqual(newWeights);
        });
    });

    // ---------------------------------------------------------------
    // 10. selectKey edge: all keys at capacity — returns null
    // ---------------------------------------------------------------
    describe('selectKey edge: all keys at capacity', () => {
        it('should return null when selectKeyFn reports no available keys', () => {
            const selector = new KeySelector({
                selectKeyFn: () => null  // simulates all keys at maxConcurrency
            });

            const result = selector.selectKey();
            expect(result).toBeNull();
        });

        it('should return null even when excludeIndices is empty', () => {
            const selector = new KeySelector({
                selectKeyFn: (_exclude) => null
            });

            const result = selector.selectKey([]);
            expect(result).toBeNull();
        });

        it('should pass excludeIndices through when all at capacity', () => {
            const mockFn = jest.fn(() => null);
            const selector = new KeySelector({ selectKeyFn: mockFn });

            selector.selectKey([0, 1, 2]);
            expect(mockFn).toHaveBeenCalledWith([0, 1, 2]);
        });
    });

    // ---------------------------------------------------------------
    // 11. selectKey edge: all keys in cooldown — returns shortest cooldown
    // ---------------------------------------------------------------
    describe('selectKey edge: all keys in cooldown', () => {
        it('should return the key with shortest remaining cooldown', () => {
            const shortestCooldownKey = {
                keyId: 'key-short-cooldown',
                index: 2,
                cooldownRemainingMs: 5000
            };

            // selectKeyFn simulates returning the least-cooldown key
            const selector = new KeySelector({
                selectKeyFn: () => shortestCooldownKey
            });

            const result = selector.selectKey();
            expect(result).toEqual(shortestCooldownKey);
            expect(result.keyId).toBe('key-short-cooldown');
        });

        it('should return the key chosen by selectKeyFn even when all in cooldown', () => {
            const calls = [];
            const bestKey = { keyId: 'best-cooldown', index: 1, cooldownRemainingMs: 1000 };

            const selector = new KeySelector({
                selectKeyFn: (excludeIndices) => {
                    calls.push(excludeIndices);
                    return bestKey;
                }
            });

            const result = selector.selectKey([0]);
            expect(result).toBe(bestKey);
            expect(calls).toEqual([[0]]);
        });
    });

    // ---------------------------------------------------------------
    // 12. setConfig runtime update — changing config affects subsequent selections
    // ---------------------------------------------------------------
    describe('setConfig runtime update', () => {
        it('should update useWeightedSelection at runtime', () => {
            const selector = new KeySelector({
                config: { useWeightedSelection: true }
            });

            expect(selector.isWeightedSelectionEnabled()).toBe(true);

            selector.setConfig({ useWeightedSelection: false });

            expect(selector.isWeightedSelectionEnabled()).toBe(false);
        });

        it('should merge new config with existing config (not replace)', () => {
            const selector = new KeySelector({
                config: {
                    useWeightedSelection: true,
                    healthScoreWeights: { latency: 40, successRate: 40, errorRecency: 20 },
                    slowKeyThreshold: 2.0
                }
            });

            selector.setConfig({ slowKeyThreshold: 3.0 });

            const config = selector.getConfig();
            expect(config.useWeightedSelection).toBe(true);  // preserved
            expect(config.healthScoreWeights).toEqual({       // preserved
                latency: 40, successRate: 40, errorRecency: 20
            });
            expect(config.slowKeyThreshold).toBe(3.0);        // updated
        });

        it('should allow adding new config fields', () => {
            const selector = new KeySelector({
                config: { useWeightedSelection: true }
            });

            selector.setConfig({ customField: 'hello' });

            const config = selector.getConfig();
            expect(config.useWeightedSelection).toBe(true);
            expect(config.customField).toBe('hello');
        });

        it('should affect selectKeyFn behavior based on config when selectKeyFn reads config', () => {
            let currentConfig;
            const selector = new KeySelector({
                selectKeyFn: () => {
                    // Simulate reading config to decide behavior
                    currentConfig = selector.getConfig();
                    return currentConfig.useWeightedSelection
                        ? { keyId: 'weighted-pick', index: 0 }
                        : { keyId: 'round-robin-pick', index: 1 };
                },
                config: { useWeightedSelection: true }
            });

            let result = selector.selectKey();
            expect(result.keyId).toBe('weighted-pick');

            selector.setConfig({ useWeightedSelection: false });

            result = selector.selectKey();
            expect(result.keyId).toBe('round-robin-pick');
        });
    });

    // ---------------------------------------------------------------
    // 13. getConfig — returns current config snapshot
    // ---------------------------------------------------------------
    describe('getConfig', () => {
        it('should return full default config when none provided', () => {
            const selector = new KeySelector({});
            const config = selector.getConfig();

            expect(config).toEqual({
                useWeightedSelection: true,
                healthScoreWeights: { latency: 40, successRate: 40, errorRecency: 20 },
                slowKeyThreshold: 2.0,
                slowKeyCheckIntervalMs: 30000,
                slowKeyCooldownMs: 300000
            });
        });

        it('should return custom config as provided', () => {
            const custom = {
                useWeightedSelection: false,
                healthScoreWeights: { latency: 10, successRate: 80, errorRecency: 10 },
                slowKeyThreshold: 5.0
            };

            const selector = new KeySelector({ config: custom });
            expect(selector.getConfig()).toEqual(custom);
        });

        it('should return updated config after setConfig', () => {
            const selector = new KeySelector({
                config: { useWeightedSelection: true, slowKeyThreshold: 2.0 }
            });

            selector.setConfig({ slowKeyThreshold: 4.0, newProp: 'test' });

            const config = selector.getConfig();
            expect(config.useWeightedSelection).toBe(true);
            expect(config.slowKeyThreshold).toBe(4.0);
            expect(config.newProp).toBe('test');
        });

        it('should return the same reference (not a copy) so mutations are visible', () => {
            const selector = new KeySelector({
                config: { useWeightedSelection: true }
            });

            const config1 = selector.getConfig();
            const config2 = selector.getConfig();

            // getConfig returns the internal object reference
            expect(config1).toBe(config2);
        });
    });
});
