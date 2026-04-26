/**
 * Coverage Test: KeySelector
 *
 * Surgical coverage fix for line 33: constructor default parameter.
 */

'use strict';

const { KeySelector } = require('../../lib/key-management/key-selector');

describe('key-selector coverage', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    // ---------------------------------------------------------------
    // Line 33: constructor(options = {}) — default parameter branch
    // ---------------------------------------------------------------
    describe('constructor default parameter', () => {
        it('should use default options when called with no arguments', () => {
            // Covers line 33: default parameter branch (options is undefined)
            const selector = new KeySelector();

            expect(selector).toBeInstanceOf(KeySelector);
            expect(selector.getConfig()).toEqual({
                useWeightedSelection: true,
                healthScoreWeights: { latency: 40, successRate: 40, errorRecency: 20 },
                slowKeyThreshold: 2.0,
                slowKeyCheckIntervalMs: 30000,
                slowKeyCooldownMs: 300000
            });
        });

        it('should have undefined selectKeyFn and acquireKeyFn when no options provided', () => {
            // Covers line 33: default parameter creates empty options object
            const selector = new KeySelector();

            expect(selector._selectKeyFn).toBeUndefined();
            expect(selector._acquireKeyFn).toBeUndefined();
        });

        it('should throw when selectKey called without selectKeyFn provided', () => {
            // Covers line 33: default parameter creates empty options, no selectKeyFn
            const selector = new KeySelector();

            expect(() => selector.selectKey()).toThrow('selectKeyFn not provided');
        });

        it('should throw when acquireKey called without acquireKeyFn provided', async () => {
            // Covers line 33: default parameter creates empty options, no acquireKeyFn
            const selector = new KeySelector();

            await expect(selector.acquireKey()).rejects.toThrow('acquireKeyFn not provided');
        });
    });
});
