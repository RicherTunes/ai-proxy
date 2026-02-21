/**
 * Error Classifier Module
 *
 * Pure function for categorizing errors from HTTP requests.
 * Extracted from RequestHandler for better testability and reusability.
 *
 * Error Categories:
 * - socket_hangup: ECONNRESET, "socket hang up"
 * - broken_pipe: EPIPE, ERR_STREAM_WRITE_AFTER_END
 * - connection_aborted: ECONNABORTED
 * - stream_premature_close: ERR_STREAM_PREMATURE_CLOSE
 * - http_parse_error: HPE_* codes, "Parse Error"
 * - connection_refused: ECONNREFUSED, ENETUNREACH, EHOSTUNREACH
 * - dns_error: ENOTFOUND, EAI_AGAIN, getaddrinfo
 * - tls_error: ERR_TLS_*, certificate, SSL, TLS
 * - timeout: ETIMEDOUT, "timeout"
 * - rate_limited: 429, "rate limit"
 * - other: fallback for unknown errors
 *
 * @module request/error-classifier
 */

'use strict';

/**
 * Categorize an error for better stats tracking and retry strategy selection.
 *
 * This is a pure function with no side effects, making it easy to test
 * and reuse across different contexts.
 *
 * @param {Error|null|undefined} err - The error to categorize
 * @returns {string} Error category (one of the defined categories)
 */
function categorizeError(err) {
    // Handle null/undefined gracefully
    if (!err) {
        return 'other';
    }

    const code = err.code || '';
    const message = err.message || '';

    // Socket/connection issues (not key-related)
    if (code === 'ECONNRESET' || message.includes('socket hang up')) {
        return 'socket_hangup';
    }

    // Broken pipe - write to a closed connection (transient, like socket_hangup)
    if (code === 'EPIPE' || code === 'ERR_STREAM_WRITE_AFTER_END') {
        return 'broken_pipe';
    }

    // Connection aborted mid-transfer
    if (code === 'ECONNABORTED') {
        return 'connection_aborted';
    }

    // Stream closed prematurely (response truncated)
    if (code === 'ERR_STREAM_PREMATURE_CLOSE' || message.includes('premature close')) {
        return 'stream_premature_close';
    }

    // HTTP parser errors (corrupted/malformed upstream responses)
    if (code.startsWith('HPE_') || message.includes('Parse Error')) {
        return 'http_parse_error';
    }

    // Connection refused
    if (code === 'ECONNREFUSED') {
        return 'connection_refused';
    }

    // DNS resolution failures
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || message.includes('getaddrinfo')) {
        return 'dns_error';
    }

    // TLS/SSL errors
    if (code.startsWith('ERR_TLS') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
        code === 'EPROTO' ||
        message.includes('certificate') || message.includes('SSL') || message.includes('TLS')) {
        return 'tls_error';
    }

    // Network unreachable
    if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') {
        return 'connection_refused';
    }

    // Timeout (should be caught elsewhere, but just in case)
    if (code === 'ETIMEDOUT' || message.includes('timeout')) {
        return 'timeout';
    }

    // Rate limiting (429 errors from upstream)
    if (message.includes('429') || message.includes('rate limit')) {
        return 'rate_limited';
    }

    return 'other';
}

module.exports = {
    categorizeError
};
