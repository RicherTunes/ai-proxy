/**
 * Logs Controller Module
 *
 * Handles logs-related routes extracted from ProxyServer.
 * Provides endpoints for log viewing, audit log, and log management.
 *
 * TDD Phase: Green - Implementation to make tests pass
 */

'use strict';

/**
 * LogsController class for logs-related HTTP endpoints
 */
class LogsController {
    /**
     * @param {Object} options - Configuration options
     * @param {Object} options.logger - Logger instance
     * @param {Object} options.auditLog - AuditLog instance (RingBuffer)
     * @param {Object} options.adminAuth - AdminAuth instance (optional)
     * @param {Function} options.addAuditEntry - Function to add audit entry (optional)
     */
    constructor(options = {}) {
        this._logger = options.logger || null;
        this._auditLog = options.auditLog || null;
        this._adminAuth = options.adminAuth || null;
        this._addAuditEntry = options.addAuditEntry || null;
    }

    /**
     * Handle /logs endpoint
     * GET: Return application logs
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    handleLogs(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const limitParam = url.searchParams?.get('limit') || '100';
        const limit = Math.min(parseInt(limitParam, 10) || 100, 500);

        const logs = this._logger ? this._logger.getLogs(limit) : [];

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            count: logs.length,
            logs: logs
        }));
    }

    /**
     * Handle /audit-log endpoint
     * GET: Return security audit log
     * Requires admin auth in all modes (always sensitive)
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    handleAuditLog(req, res) {
        // Always require auth for audit log
        if (this._adminAuth && this._adminAuth.enabled) {
            const authResult = this._adminAuth.authenticate(req);
            if (!authResult.authenticated) {
                this._sendError(res, 401, authResult.error);
                return;
            }
        }

        const url = new URL(req.url, `http://${req.headers.host}`);
        const limitParam = url.searchParams?.get('limit') || '100';
        const limit = Math.min(parseInt(limitParam, 10) || 100, 1000);

        // Return most recent entries first
        const allEntries = this._auditLog ? this._auditLog.toArray() : [];
        const entries = allEntries.slice(-limit).reverse();

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            count: entries.length,
            total: this._auditLog ? this._auditLog.size : 0,
            entries
        }, null, 2));
    }

    /**
     * Handle /control/clear-logs endpoint
     * POST: Clear application logs
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    handleClearLogs(req, res) {
        if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed, use POST' }));
            return;
        }

        if (this._logger) {
            this._logger.clearLogs();
            this._logger.info('Logs cleared');
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'logs_cleared' }));
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
    LogsController
};
