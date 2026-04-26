'use strict';

// Coverage test for lib/stats/token-tracker.js
// Target: Push branch coverage from 87.5% to 100%
// Uncovered line 55: this.logger[level](message)
// Uncovered lines 117-120: stats.requestCount > 0 false branch (edge case)

const { TokenTracker } = require('../../lib/stats/token-tracker');

describe('token-tracker coverage', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('_log method', () => {
        // Covers line 55: actual logger invocation when logger[level] is a function
        it('should call logger[level] when logger has a valid function method', () => {
            const mockInfo = jest.fn();
            const logger = { info: mockInfo };
            const tracker = new TokenTracker({ logger });

            // resetTokenStats calls _log('info', 'Token stats reset')
            tracker.resetTokenStats();

            expect(mockInfo).toHaveBeenCalledWith('Token stats reset');
        });
    });

    describe('getTokenStats per-key averages', () => {
        // Covers lines 117-120: stats.requestCount > 0 false branch
        // This branch handles the edge case where a key entry exists but has no recorded requests.
        // While this cannot occur through normal API usage, we test it to ensure defensive coding.
        it('should return zero averages for keys with requestCount === 0', () => {
            const tracker = new TokenTracker({});

            // Directly inject an entry with requestCount: 0 to test the defensive branch
            tracker.tokens.byKeyId.set('orphan-key', {
                totalInputTokens: 0,
                totalOutputTokens: 0,
                totalTokens: 0,
                requestCount: 0
            });

            const stats = tracker.getTokenStats();

            expect(stats.byKey['orphan-key']).toEqual({
                totalInputTokens: 0,
                totalOutputTokens: 0,
                totalTokens: 0,
                requestCount: 0,
                avgInputPerRequest: 0,
                avgOutputPerRequest: 0
            });
        });
    });
});
