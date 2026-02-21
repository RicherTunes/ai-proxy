/**
 * Compare Controller Module
 *
 * Handles compare-related routes extracted from ProxyServer.
 * Provides endpoints for key comparison functionality.
 *
 * TDD Phase: Green - Implementation to make tests pass
 */

'use strict';

/**
 * CompareController class for compare-related HTTP endpoints
 */
class CompareController {
    /**
     * @param {Object} options - Configuration options
     * @param {Object} options.keyManager - KeyManager instance
     */
    constructor(options = {}) {
        this._keyManager = options.keyManager || null;
    }

    /**
     * Handle /compare endpoint
     * GET: Compare key performance metrics
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    handleCompare(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const keysParam = url.searchParams?.get('keys');

        let keyIndices = null;
        if (keysParam) {
            keyIndices = keysParam.split(',').map(k => parseInt(k.trim(), 10)).filter(k => !isNaN(k));
        }

        const comparison = this._keyManager && this._keyManager.compareKeys
            ? this._keyManager.compareKeys(keyIndices)
            : { keys: keyIndices || ['all'], comparison: {}, details: [] };

        this._sendJson(res, 200, comparison);
    }

    /**
     * Helper to send JSON response
     * @param {Object} res - HTTP response
     * @param {number} status - HTTP status code
     * @param {Object} data - Response data
     */
    _sendJson(res, status, data) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
    }
}

module.exports = {
    CompareController
};
