/**
 * Requests Controller Module
 *
 * Handles request-related routes extracted from ProxyServer.
 * Provides endpoints for request history listing and search.
 *
 * TDD Phase: Green - Implementation to make tests pass
 */

'use strict';

/**
 * RequestsController class for request-related HTTP endpoints
 */
class RequestsController {
    /**
     * @param {Object} options - Configuration options
     * @param {Object} options.requestTraces - RequestTraceStore instance
     */
    constructor(options = {}) {
        this._requestTraces = options.requestTraces || null;
    }

    /**
     * Handle /requests endpoints
     * GET /requests - list recent requests
     * GET /requests/search - search requests with filters
     * GET /requests/:id - get specific request by traceId or requestId
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     * @param {string} pathname - URL pathname
     */
    handleRequests(req, res, pathname) {
        const url = new URL(req.url, `http://${req.headers.host}`);

        // GET /requests - list recent requests
        if (pathname === '/requests' && req.method === 'GET') {
            const limit = Math.min(Math.max(parseInt(url.searchParams?.get('limit') || '50', 10) || 50, 1), 500);
            const offset = Math.min(Math.max(parseInt(url.searchParams?.get('offset') || '0', 10) || 0, 0), 10000);

            const allRequests = this._requestTraces ? this._requestTraces.toArray() : [];
            const requests = allRequests.slice(-(limit + offset)).slice(0, limit);

            this._sendJson(res, 200, {
                requests,
                total: this._requestTraces ? this._requestTraces.size : 0,
                limit,
                offset
            });
            return;
        }

        // GET /requests/search
        if (pathname === '/requests/search' && req.method === 'GET') {
            const keyIndexParam = url.searchParams?.get('keyIndex');
            const status = url.searchParams?.get('status');
            const minLatencyParam = url.searchParams?.get('minLatency');

            let filtered = this._requestTraces ? this._requestTraces.toArray() : [];

            if (keyIndexParam !== null) {
                const ki = parseInt(keyIndexParam, 10);
                if (!isNaN(ki)) {
                    filtered = filtered.filter(r => r.keyIndex === ki);
                }
            }
            if (status) {
                filtered = filtered.filter(r => String(r.status) === status);
            }
            if (minLatencyParam) {
                const ml = parseInt(minLatencyParam, 10);
                if (!isNaN(ml)) {
                    filtered = filtered.filter(r => r.latencyMs >= ml);
                }
            }

            this._sendJson(res, 200, { requests: filtered.slice(-100) });
            return;
        }

        // GET /requests/:traceId
        const traceMatch = pathname.match(/^\/requests\/([^/]+)$/);
        if (traceMatch && req.method === 'GET') {
            const traceId = traceMatch[1];
            const allRequests = this._requestTraces ? this._requestTraces.toArray() : [];
            const trace = allRequests.find(r => r.traceId === traceId || r.requestId === traceId);

            if (!trace) {
                this._sendError(res, 404, 'Trace not found');
                return;
            }

            this._sendJson(res, 200, trace);
            return;
        }

        this._sendError(res, 404, 'Not found');
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
    RequestsController
};
