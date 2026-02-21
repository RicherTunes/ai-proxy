/**
 * History Controller Module
 *
 * Handles history-related routes extracted from ProxyServer.
 * Provides endpoints for request history viewing.
 *
 * TDD Phase: Green - Implementation to make tests pass
 */

'use strict';

/**
 * HistoryController class for history-related HTTP endpoints
 */
class HistoryController {
    /**
     * @param {Object} options - Configuration options
     * @param {Object} options.historyTracker - HistoryTracker instance
     */
    constructor(options = {}) {
        this._historyTracker = options.historyTracker || null;
    }

    /**
     * Handle /history endpoint
     * GET: Return request history
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    handleHistory(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const minutesParam = url.searchParams?.get('minutes') || '15';
        const minutes = Math.min(parseInt(minutesParam, 10) || 15, 10080); // 7 days max

        const history = this._historyTracker
            ? this._historyTracker.getHistory(minutes)
            : { requests: [], timeRange: { minutes } };

        res.writeHead(200, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            'pragma': 'no-cache',
            'expires': '0'
        });
        res.end(JSON.stringify(history));
    }
}

module.exports = {
    HistoryController
};
