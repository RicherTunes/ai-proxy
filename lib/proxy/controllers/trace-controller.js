/**
 * Trace Controller Module
 *
 * Handles trace-related routes extracted from ProxyServer.
 * Provides endpoints for request trace viewing and filtering.
 *
 * TDD Phase: Green - Implementation to make tests pass
 */

'use strict';

const { redactSensitiveData } = require('../../redact');

/**
 * TraceController class for trace-related HTTP endpoints
 */
class TraceController {
    /**
     * @param {Object} options - Configuration options
     * @param {Object} options.requestHandler - RequestHandler instance
     * @param {Function} options.redactSensitiveData - Function to redact sensitive data (optional)
     */
    constructor(options = {}) {
        this._requestHandler = options.requestHandler || null;
        this._redactSensitiveData = options.redactSensitiveData || redactSensitiveData;
    }

    /**
     * Handle /traces endpoint
     * GET: Return request traces with optional filtering
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    handleTraces(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);

        // Parse query parameters
        const filter = {};

        const successParam = url.searchParams.get('success');
        if (successParam !== null) {
            filter.success = successParam === 'true';
        }

        const modelParam = url.searchParams.get('model');
        if (modelParam) {
            filter.model = modelParam.trim();
        }

        const hasRetriesParam = url.searchParams.get('hasRetries');
        if (hasRetriesParam === 'true') {
            filter.hasRetries = true;
        }

        const minDurationParam = url.searchParams.get('minDuration');
        if (minDurationParam) {
            const minDuration = parseInt(minDurationParam, 10);
            if (!isNaN(minDuration)) {
                filter.minDuration = minDuration;
            }
        }

        const sinceParam = url.searchParams.get('since');
        if (sinceParam) {
            const since = parseInt(sinceParam, 10);
            if (!isNaN(since)) {
                filter.since = since;
            }
        }

        const limitParam = url.searchParams.get('limit');
        if (limitParam) {
            const limit = parseInt(limitParam, 10);
            if (!isNaN(limit)) {
                filter.limit = Math.min(Math.max(limit, 1), 1000);
            }
        }

        // Get traces - limit is not a "real" filter, it just controls the number returned
        const { limit } = filter;
        delete filter.limit;
        const hasFilters = Object.keys(filter).length > 0;
        const traces = this._requestHandler && (
            hasFilters
                ? this._requestHandler.queryTraces(filter)
                : this._requestHandler.getRecentTraces(limit || 100)
        ) || [];

        // Get store stats
        const stats = this._requestHandler ? this._requestHandler.getTraceStats() : {};

        const tracesResponse = {
            traces,
            stats,
            filter: hasFilters ? filter : null,
            timestamp: new Date().toISOString()
        };

        // Redact sensitive data before sending (traces may contain request details)
        const redactedResponse = this._redactSensitiveData(tracesResponse, {
            redactBodies: true,
            redactHeaders: true,
            bodyPreviewLength: 200
        });

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(redactedResponse, null, 2));
    }

    /**
     * Handle /traces/:traceId endpoint
     * Returns detailed trace for a specific trace or request ID
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     * @param {string} pathname - URL pathname
     */
    handleTraceById(req, res, pathname) {
        // Extract trace ID from path
        const match = pathname.match(/^\/traces\/([^/?]+)/);
        if (!match) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
            return;
        }

        const traceId = match[1];
        const trace = this._requestHandler ? this._requestHandler.getTrace(traceId) : null;

        if (!trace) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Trace not found',
                traceId,
                timestamp: new Date().toISOString()
            }));
            return;
        }

        const traceResponse = {
            trace,
            timestamp: new Date().toISOString()
        };

        // Redact sensitive data before sending
        const redactedResponse = this._redactSensitiveData(traceResponse, {
            redactBodies: true,
            redactHeaders: true,
            bodyPreviewLength: 200
        });

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(redactedResponse, null, 2));
    }
}

module.exports = {
    TraceController
};
