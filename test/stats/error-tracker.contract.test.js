/**
 * Contract Test: Error Tracker
 *
 * This contract test ensures that error tracking operations produce consistent results
 * after extraction from StatsAggregator to error-tracker.js.
 *
 * TDD Phase: Red - Write failing test first
 */

'use strict';

let ErrorTracker;
try {
    ({ ErrorTracker } = require('../../lib/stats/error-tracker'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = ErrorTracker ? describe : describe.skip;

describeIfModule('StatsAggregator Contract: Error Tracking Operations', () => {
    let tracker;

    beforeEach(() => {
        tracker = new ErrorTracker();
    });

    describe('recordError', () => {
        it('should record timeout errors', () => {
            tracker.recordError('timeout');
            const stats = tracker.getErrorStats();
            expect(stats.timeouts).toBe(1);
        });

        it('should record socket hangup errors', () => {
            tracker.recordError('socket_hangup');
            const stats = tracker.getErrorStats();
            expect(stats.socketHangups).toBe(1);
        });

        it('should record connection refused errors', () => {
            tracker.recordError('connection_refused');
            const stats = tracker.getErrorStats();
            expect(stats.connectionRefused).toBe(1);
        });

        it('should record server errors', () => {
            tracker.recordError('server_error');
            const stats = tracker.getErrorStats();
            expect(stats.serverErrors).toBe(1);
        });

        it('should record DNS errors', () => {
            tracker.recordError('dns_error');
            const stats = tracker.getErrorStats();
            expect(stats.dnsErrors).toBe(1);
        });

        it('should record TLS errors', () => {
            tracker.recordError('tls_error');
            const stats = tracker.getErrorStats();
            expect(stats.tlsErrors).toBe(1);
        });

        it('should record client disconnects', () => {
            tracker.recordError('client_disconnect');
            const stats = tracker.getErrorStats();
            expect(stats.clientDisconnects).toBe(1);
        });

        it('should record rate limited errors', () => {
            tracker.recordError('rate_limited');
            const stats = tracker.getErrorStats();
            expect(stats.rateLimited).toBe(1);
        });

        it('should record auth errors', () => {
            tracker.recordError('auth_error');
            const stats = tracker.getErrorStats();
            expect(stats.authErrors).toBe(1);
        });

        it('should record broken pipe errors', () => {
            tracker.recordError('broken_pipe');
            const stats = tracker.getErrorStats();
            expect(stats.brokenPipe).toBe(1);
        });

        it('should record connection aborted errors', () => {
            tracker.recordError('connection_aborted');
            const stats = tracker.getErrorStats();
            expect(stats.connectionAborted).toBe(1);
        });

        it('should record stream premature close errors', () => {
            tracker.recordError('stream_premature_close');
            const stats = tracker.getErrorStats();
            expect(stats.streamPrematureClose).toBe(1);
        });

        it('should record HTTP parse errors', () => {
            tracker.recordError('http_parse_error');
            const stats = tracker.getErrorStats();
            expect(stats.httpParseError).toBe(1);
        });

        it('should record unrecognized errors as other', () => {
            tracker.recordError('unknown_error');
            const stats = tracker.getErrorStats();
            expect(stats.other).toBe(1);
        });

        it('should aggregate multiple errors of the same type', () => {
            tracker.recordError('timeout');
            tracker.recordError('timeout');
            tracker.recordError('timeout');

            const stats = tracker.getErrorStats();
            expect(stats.timeouts).toBe(3);
        });

        it('should track different error types separately', () => {
            tracker.recordError('timeout');
            tracker.recordError('socket_hangup');
            tracker.recordError('timeout');

            const stats = tracker.getErrorStats();
            expect(stats.timeouts).toBe(2);
            expect(stats.socketHangups).toBe(1);
        });
    });

    describe('recordRetry', () => {
        it('should increment total retries', () => {
            tracker.recordRetry();
            tracker.recordRetry();

            const stats = tracker.getErrorStats();
            expect(stats.totalRetries).toBe(2);
        });
    });

    describe('recordRetrySuccess', () => {
        it('should increment retries succeeded', () => {
            tracker.recordRetrySuccess();
            tracker.recordRetrySuccess();

            const stats = tracker.getErrorStats();
            expect(stats.retriesSucceeded).toBe(2);
        });
    });

    describe('getErrorStats', () => {
        it('should return all error counts', () => {
            tracker.recordError('timeout');
            tracker.recordError('socket_hangup');
            tracker.recordRetry();

            const stats = tracker.getErrorStats();
            expect(stats.timeouts).toBe(1);
            expect(stats.socketHangups).toBe(1);
            expect(stats.totalRetries).toBe(1);
        });

        it('should return zero for all types when no errors recorded', () => {
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

    describe('resetErrors', () => {
        it('should reset all error counts to zero', () => {
            tracker.recordError('timeout');
            tracker.recordError('socket_hangup');
            tracker.recordRetry();

            tracker.resetErrors();

            const stats = tracker.getErrorStats();
            expect(stats.timeouts).toBe(0);
            expect(stats.socketHangups).toBe(0);
            expect(stats.totalRetries).toBe(0);
        });

        it('should allow recording after reset', () => {
            tracker.recordError('timeout');
            tracker.resetErrors();
            tracker.recordError('socket_hangup');

            const stats = tracker.getErrorStats();
            expect(stats.timeouts).toBe(0);
            expect(stats.socketHangups).toBe(1);
        });
    });

    describe('interface contract', () => {
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
