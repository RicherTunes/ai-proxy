/**
 * Retry Engine Module
 *
 * Interface for retry logic extracted from RequestHandler.
 *
 * This is currently a lightweight interface wrapper around the existing
 * _proxyWithRetries implementation. Full extraction is deferred because
 * retry logic requires fake timers tests (complex).
 *
 * Future work: Extract full retry loop logic here with proper tests.
 *
 * @module request/retry-engine
 */

'use strict';

/**
 * Retry Engine Class
 *
 * Provides an interface for executing requests with retry logic.
 * The actual implementation is delegated to the existing
 * RequestHandler._proxyWithRetries method.
 *
 * This interface allows us to:
 * 1. Keep a stable API while we incrementally refactor
 * 2. Add pre/post hooks in the future
 * 3. Switch implementations without changing callers
 *
 * @class
 */
class RetryEngine {
    /**
     * Create a new RetryEngine
     * @param {Object} options - Configuration options
     * @param {Function} options.executeFn - The function to execute with retries (typically _proxyWithRetries)
     * @param {Object} options.config - Retry configuration
     */
    constructor(options = {}) {
        this._executeFn = options.executeFn;
        this._config = options.config || {};
    }

    /**
     * Execute a request with retry logic
     *
     * This method currently delegates to the existing implementation.
     * In the future, this will contain the full retry loop logic.
     *
     * @param {Object} params - Execution parameters
     * @param {http.IncomingMessage} params.req - HTTP request
     * @param {http.ServerResponse} params.res - HTTP response
     * @param {Buffer} params.body - Request body
     * @param {string} params.requestId - Request ID
     * @param {Object} params.reqLogger - Request logger
     * @param {number} params.startTime - Request start timestamp
     * @param {Object} params.trace - Request trace
     * @returns {Promise<void>}
     */
    async execute(params) {
        if (!this._executeFn) {
            throw new Error('RetryEngine: executeFn not provided');
        }

        // Delegate to existing implementation
        return this._executeFn(
            params.req,
            params.res,
            params.body,
            params.requestId,
            params.reqLogger,
            params.startTime,
            params.trace
        );
    }

    /**
     * Get the retry configuration
     * @returns {Object} Retry configuration
     */
    getConfig() {
        return this._config;
    }

    /**
     * Update the retry configuration
     * @param {Object} config - New configuration
     */
    setConfig(config) {
        this._config = { ...this._config, ...config };
    }
}

module.exports = {
    RetryEngine
};
