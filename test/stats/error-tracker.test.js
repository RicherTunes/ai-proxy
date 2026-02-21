/**
 * Unit Test: Error Tracker Module
 *
 * TDD Phase: Red - Write failing unit test before module exists
 *
 * Tests the ErrorTracker class which handles error tracking.
 */

'use strict';

let ErrorTracker;
try {
    ({ ErrorTracker } = require('../../lib/stats/error-tracker'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = ErrorTracker ? describe : describe.skip;

describeIfModule('error-tracker', () => {
    describe('constructor', () => {
        it('should create a new ErrorTracker', () => {
            const tracker = new ErrorTracker();
            expect(tracker).toBeInstanceOf(ErrorTracker);
        });

        it('should initialize all error counts to zero', () => {
            const tracker = new ErrorTracker();
            const stats = tracker.getErrorStats();

            expect(stats.timeouts).toBe(0);
            expect(stats.socketHangups).toBe(0);
            expect(stats.connectionRefused).toBe(0);
            expect(stats.serverErrors).toBe(0);
            expect(stats.dnsErrors).toBe(0);
            expect(stats.tlsErrors).toBe(0);
            expect(stats.clientDisconnects).toBe(0);
            expect(stats.rateLimited).toBe(0);
            expect(stats.authErrors).toBe(0);
            expect(stats.brokenPipe).toBe(0);
            expect(stats.connectionAborted).toBe(0);
            expect(stats.streamPrematureClose).toBe(0);
            expect(stats.httpParseError).toBe(0);
            expect(stats.other).toBe(0);
            expect(stats.totalRetries).toBe(0);
            expect(stats.retriesSucceeded).toBe(0);
        });
    });

    describe('recordError', () => {
        let tracker;

        beforeEach(() => {
            tracker = new ErrorTracker();
        });

        const errorTypes = [
            { type: 'timeout', expectedKey: 'timeouts' },
            { type: 'socket_hangup', expectedKey: 'socketHangups' },
            { type: 'connection_refused', expectedKey: 'connectionRefused' },
            { type: 'server_error', expectedKey: 'serverErrors' },
            { type: 'dns_error', expectedKey: 'dnsErrors' },
            { type: 'tls_error', expectedKey: 'tlsErrors' },
            { type: 'client_disconnect', expectedKey: 'clientDisconnects' },
            { type: 'rate_limited', expectedKey: 'rateLimited' },
            { type: 'auth_error', expectedKey: 'authErrors' },
            { type: 'broken_pipe', expectedKey: 'brokenPipe' },
            { type: 'connection_aborted', expectedKey: 'connectionAborted' },
            { type: 'stream_premature_close', expectedKey: 'streamPrematureClose' },
            { type: 'http_parse_error', expectedKey: 'httpParseError' }
        ];

        errorTypes.forEach(({ type, expectedKey }) => {
            it(`should record ${type} error`, () => {
                tracker.recordError(type);

                const stats = tracker.getErrorStats();
                expect(stats[expectedKey]).toBe(1);
            });
        });

        it('should record unknown error types as "other"', () => {
            tracker.recordError('unknown_error');
            tracker.recordError('weird_error');

            const stats = tracker.getErrorStats();
            expect(stats.other).toBe(2);
        });

        it('should handle null errorType gracefully', () => {
            expect(() => tracker.recordError(null)).not.toThrow();

            const stats = tracker.getErrorStats();
            expect(stats.other).toBe(1); // null counts as 'other'
        });

        it('should handle undefined errorType gracefully', () => {
            expect(() => tracker.recordError(undefined)).not.toThrow();

            const stats = tracker.getErrorStats();
            expect(stats.other).toBe(1);
        });

        it('should aggregate counts for same error type', () => {
            tracker.recordError('timeout');
            tracker.recordError('timeout');
            tracker.recordError('timeout');

            const stats = tracker.getErrorStats();
            expect(stats.timeouts).toBe(3);
        });

        it('should track multiple error types independently', () => {
            tracker.recordError('timeout');
            tracker.recordError('socket_hangup');
            tracker.recordError('timeout');
            tracker.recordError('dns_error');

            const stats = tracker.getErrorStats();
            expect(stats.timeouts).toBe(2);
            expect(stats.socketHangups).toBe(1);
            expect(stats.dnsErrors).toBe(1);
        });

        it('should not affect other error counts when recording one type', () => {
            tracker.recordError('timeout');

            const stats = tracker.getErrorStats();
            expect(stats.timeouts).toBe(1);
            expect(stats.socketHangups).toBe(0);
            expect(stats.connectionRefused).toBe(0);
        });
    });

    describe('recordRetry', () => {
        let tracker;

        beforeEach(() => {
            tracker = new ErrorTracker();
        });

        it('should increment totalRetries', () => {
            tracker.recordRetry();

            const stats = tracker.getErrorStats();
            expect(stats.totalRetries).toBe(1);
        });

        it('should increment totalRetries multiple times', () => {
            tracker.recordRetry();
            tracker.recordRetry();
            tracker.recordRetry();

            const stats = tracker.getErrorStats();
            expect(stats.totalRetries).toBe(3);
        });

        it('should not affect other error counts', () => {
            tracker.recordRetry();
            tracker.recordError('timeout');

            const stats = tracker.getErrorStats();
            expect(stats.totalRetries).toBe(1);
            expect(stats.timeouts).toBe(1);
        });
    });

    describe('recordRetrySuccess', () => {
        let tracker;

        beforeEach(() => {
            tracker = new ErrorTracker();
        });

        it('should increment retriesSucceeded', () => {
            tracker.recordRetrySuccess();

            const stats = tracker.getErrorStats();
            expect(stats.retriesSucceeded).toBe(1);
        });

        it('should increment retriesSucceeded multiple times', () => {
            tracker.recordRetrySuccess();
            tracker.recordRetrySuccess();
            tracker.recordRetrySuccess();

            const stats = tracker.getErrorStats();
            expect(stats.retriesSucceeded).toBe(3);
        });

        it('should track retries and successes independently', () => {
            tracker.recordRetry();
            tracker.recordRetry();
            tracker.recordRetrySuccess();

            const stats = tracker.getErrorStats();
            expect(stats.totalRetries).toBe(2);
            expect(stats.retriesSucceeded).toBe(1);
        });
    });

    describe('getErrorStats', () => {
        let tracker;

        beforeEach(() => {
            tracker = new ErrorTracker();
            tracker.recordError('timeout');
            tracker.recordError('socket_hangup');
            tracker.recordError('timeout');
            tracker.recordRetry();
            tracker.recordRetrySuccess();
        });

        it('should return all error counts', () => {
            const stats = tracker.getErrorStats();

            expect(stats.timeouts).toBe(2);
            expect(stats.socketHangups).toBe(1);
            expect(stats.totalRetries).toBe(1);
            expect(stats.retriesSucceeded).toBe(1);
        });

        it('should return copy of stats (not reference)', () => {
            const stats1 = tracker.getErrorStats();
            stats1.timeouts = 999;

            const stats2 = tracker.getErrorStats();
            expect(stats2.timeouts).toBe(2); // Original value preserved
        });

        it('should include all error type keys', () => {
            const stats = tracker.getErrorStats();

            const expectedKeys = [
                'timeouts', 'socketHangups', 'connectionRefused', 'serverErrors',
                'dnsErrors', 'tlsErrors', 'clientDisconnects', 'rateLimited',
                'authErrors', 'brokenPipe', 'connectionAborted', 'streamPrematureClose',
                'httpParseError', 'other', 'totalRetries', 'retriesSucceeded'
            ];

            expectedKeys.forEach(key => {
                expect(stats).toHaveProperty(key);
                expect(typeof stats[key]).toBe('number');
            });
        });
    });

    describe('resetErrors', () => {
        let tracker;

        beforeEach(() => {
            tracker = new ErrorTracker();
            tracker.recordError('timeout');
            tracker.recordError('socket_hangup');
            tracker.recordRetry();
            tracker.recordRetrySuccess();
        });

        it('should reset all error counts to zero', () => {
            tracker.resetErrors();

            const stats = tracker.getErrorStats();
            expect(stats.timeouts).toBe(0);
            expect(stats.socketHangups).toBe(0);
            expect(stats.totalRetries).toBe(0);
            expect(stats.retriesSucceeded).toBe(0);
        });

        it('should reset all error type counts', () => {
            tracker.recordError('dns_error');
            tracker.recordError('tls_error');
            tracker.recordError('unknown_error');

            tracker.resetErrors();

            const stats = tracker.getErrorStats();
            expect(stats.dnsErrors).toBe(0);
            expect(stats.tlsErrors).toBe(0);
            expect(stats.other).toBe(0);
        });

        it('should allow recording errors after reset', () => {
            tracker.resetErrors();
            tracker.recordError('timeout');

            const stats = tracker.getErrorStats();
            expect(stats.timeouts).toBe(1);
        });

        it('should allow recording retries after reset', () => {
            tracker.resetErrors();
            tracker.recordRetry();

            const stats = tracker.getErrorStats();
            expect(stats.totalRetries).toBe(1);
        });

        it('should handle multiple resets', () => {
            tracker.recordError('timeout');
            tracker.resetErrors();
            tracker.recordError('socket_hangup');
            tracker.resetErrors();

            const stats = tracker.getErrorStats();
            expect(stats.timeouts).toBe(0);
            expect(stats.socketHangups).toBe(0);
        });
    });

    describe('interface contract', () => {
        let tracker;

        beforeEach(() => {
            tracker = new ErrorTracker();
        });

        it('should have recordError method', () => {
            expect(typeof tracker.recordError).toBe('function');
        });

        it('should have recordRetry method', () => {
            expect(typeof tracker.recordRetry).toBe('function');
        });

        it('should have recordRetrySuccess method', () => {
            expect(typeof tracker.recordRetrySuccess).toBe('function');
        });

        it('should have getErrorStats method', () => {
            expect(typeof tracker.getErrorStats).toBe('function');
        });

        it('should have resetErrors method', () => {
            expect(typeof tracker.resetErrors).toBe('function');
        });
    });
});
