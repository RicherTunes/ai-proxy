/**
 * Keys Controller Module
 *
 * Handles key-related routes extracted from ProxyServer.
 * Provides endpoints for key statistics and latency monitoring.
 *
 * TDD Phase: Green - Implementation to make tests pass
 */

'use strict';

const { redactSensitiveData } = require('../../redact');

/**
 * KeysController class for key-related HTTP endpoints
 */
class KeysController {
    /**
     * @param {Object} options - Configuration options
     * @param {Object} options.keyManager - KeyManager instance
     * @param {Function} options.redactSensitiveData - Function to redact sensitive data (optional)
     */
    constructor(options = {}) {
        this._keyManager = options.keyManager || null;
        this._redactSensitiveData = options.redactSensitiveData || redactSensitiveData;
    }

    /**
     * Handle /debug/keys endpoint
     * GET: Return key statistics with scheduler info
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    handleDebugKeys(req, res) {
        const keys = this._keyManager ? this._keyManager.getStats() : [];
        const schedulerStats = this._keyManager && this._keyManager.getSchedulerStats ? this._keyManager.getSchedulerStats() : null;

        const detailed = keys.map(k => ({
            ...k,
            // Add scheduler info if available
            scheduler: schedulerStats ? {
                selectionCount: schedulerStats.perKeyStats?.[k.index]?.selectionCount,
                lastSelected: schedulerStats.perKeyStats?.[k.index]?.lastSelected
            } : null
        }));

        const keysData = {
            timestamp: new Date().toISOString(),
            count: detailed.length,
            keys: detailed,
            scheduler: schedulerStats
        };

        // Redact sensitive data before sending
        const redactedKeysData = this._redactSensitiveData(keysData, {
            redactBodies: true,
            redactHeaders: true,
            bodyPreviewLength: 200
        });

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(redactedKeysData, null, 2));
    }

    /**
     * Handle /stats/latency-histogram/:keyIndex endpoint
     * Returns latency histogram for a specific key
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     * @param {string} pathname - URL pathname
     */
    handleKeyLatencyHistogram(req, res, pathname) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const match = pathname.match(/^\/stats\/latency-histogram\/(\d+)$/);

        if (!match) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid key index' }));
            return;
        }

        const keyIndex = parseInt(match[1], 10);
        const keyCount = this._keyManager && this._keyManager.keys ? this._keyManager.keys.length : 0;

        if (isNaN(keyIndex) || keyIndex < 0 || keyIndex >= keyCount) {
            this._sendError(res, 400, 'Invalid key index');
            return;
        }

        const timeRange = url.searchParams?.get('range') || '15m';

        const histogram = this._keyManager && this._keyManager.getKeyLatencyHistogram
            ? this._keyManager.getKeyLatencyHistogram(keyIndex, timeRange)
            : null;

        if (!histogram) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Key not found' }));
            return;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(histogram, null, 2));
    }

    /**
     * Helper to send error response
     * @param {Object} res - HTTP response
     * @param {number} status - HTTP status code
     * @param {string} error - Error message
     */
    _sendError(res, status, error) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error }));
    }
}

module.exports = {
    KeysController
};
