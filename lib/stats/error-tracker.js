/**
 * Error Tracker Module
 *
 * Handles error categorization and tracking.
 * Extracted from StatsAggregator as part of the god class refactoring.
 *
 * TDD Phase: Green - Implementation to make tests pass
 */

'use strict';

/**
 * ErrorTracker class
 * Tracks various error types with categorization
 */
class ErrorTracker {
    /**
     * @param {Object} options - Configuration options
     * @param {Object} options.logger - Logger instance
     */
    constructor(options = {}) {
        this.logger = options.logger || null;

        this._reset();
    }

    /**
     * Reset internal state
     * @private
     */
    _reset() {
        this.errors = {
            timeouts: 0,
            socketHangups: 0,
            connectionRefused: 0,
            serverErrors: 0,
            dnsErrors: 0,
            tlsErrors: 0,
            clientDisconnects: 0,
            rateLimited: 0,
            authErrors: 0,
            brokenPipe: 0,
            connectionAborted: 0,
            streamPrematureClose: 0,
            httpParseError: 0,
            other: 0,
            totalRetries: 0,
            retriesSucceeded: 0
        };
    }

    /**
     * Log message if logger is available
     * @param {string} level - Log level
     * @param {string} message - Log message
     * @param {Object} context - Additional context
     * @private
     */
    _log(level, message, context = {}) {
        if (this.logger && typeof this.logger[level] === 'function') {
            this.logger[level](message, context);
        }
    }

    /**
     * Record error with categorization
     * @param {string} errorType - The type of error to record
     * @param {Object} errorDetails - Additional error details
     */
    recordError(errorType, errorDetails = null) {
        switch (errorType) {
            case 'timeout':
                this.errors.timeouts++;
                break;
            case 'socket_hangup':
                this.errors.socketHangups++;
                break;
            case 'connection_refused':
                this.errors.connectionRefused++;
                break;
            case 'server_error':
                this.errors.serverErrors++;
                break;
            case 'dns_error':
                this.errors.dnsErrors++;
                break;
            case 'tls_error':
                this.errors.tlsErrors++;
                break;
            case 'client_disconnect':
                this.errors.clientDisconnects++;
                break;
            case 'rate_limited':
                this.errors.rateLimited++;
                break;
            case 'auth_error':
                this.errors.authErrors++;
                break;
            case 'broken_pipe':
                this.errors.brokenPipe++;
                break;
            case 'connection_aborted':
                this.errors.connectionAborted++;
                break;
            case 'stream_premature_close':
                this.errors.streamPrematureClose++;
                break;
            case 'http_parse_error':
                this.errors.httpParseError++;
                break;
            default:
                this.errors.other++;
                // Log unrecognized error types for debugging
                if (errorDetails) {
                    this._log('debug', `Unrecognized error type: ${errorType}`, errorDetails);
                }
        }
    }

    /**
     * Record a retry attempt
     */
    recordRetry() {
        this.errors.totalRetries++;
    }

    /**
     * Record a successful retry (request succeeded after at least one failure)
     */
    recordRetrySuccess() {
        this.errors.retriesSucceeded++;
    }

    /**
     * Get error statistics
     * @returns {Object} Copy of error stats
     */
    getErrorStats() {
        return { ...this.errors };
    }

    /**
     * Reset error stats
     */
    resetErrors() {
        this._reset();
        this._log('info', 'Error stats reset');
    }
}

module.exports = {
    ErrorTracker
};
