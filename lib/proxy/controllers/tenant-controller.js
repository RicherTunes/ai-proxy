/**
 * Tenant Controller Module
 *
 * Handles tenant-related routes extracted from ProxyServer.
 * Provides endpoints for multi-tenant management and statistics.
 *
 * TDD Phase: Green - Implementation to make tests pass
 */

'use strict';

const { sendJson, sendError } = require('./response-helpers');

/**
 * TenantController class for tenant-related HTTP endpoints
 */
class TenantController {
    /**
     * @param {Object} options - Configuration options
     * @param {Object} options.tenantManager - TenantManager instance
     * @param {Object} options.costTracker - CostTracker instance (optional)
     */
    constructor(options = {}) {
        this._tenantManager = options.tenantManager || null;
        this._costTracker = options.costTracker || null;
    }

    /**
     * Handle /tenants endpoint
     * GET: Return all tenant statistics
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    handleTenants(req, res) {
        if (!this._tenantManager) {
            this._sendError(res, 404, 'Multi-tenant not enabled');
            return;
        }

        this._sendJson(res, 200, this._tenantManager.getAllTenantStats());
    }

    /**
     * Handle /tenants/:tenantId/stats endpoint
     * Returns detailed statistics for a specific tenant
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     * @param {string} pathname - URL pathname
     */
    handleTenantStats(req, res, pathname) {
        if (!this._tenantManager) {
            this._sendError(res, 404, 'Multi-tenant not enabled');
            return;
        }

        const match = pathname.match(/^\/tenants\/([^/]+)\/stats$/);
        if (!match) {
            this._sendError(res, 404, 'Not found');
            return;
        }

        const tenantId = match[1];
        const stats = this._tenantManager.getTenantStats(tenantId);

        if (!stats) {
            this._sendError(res, 404, 'Tenant not found');
            return;
        }

        this._sendJson(res, 200, stats);
    }

    /**
     * Helper to send JSON response
     * @param {Object} res - HTTP response
     * @param {number} status - HTTP status code
     * @param {Object} data - Response data
     */
    _sendJson(res, status, data) {
        sendJson(res, status, data);
    }

    /**
     * Helper to send error response
     * @param {Object} res - HTTP response
     * @param {number} status - HTTP status code
     * @param {string} error - Error message
     */
    _sendError(res, status, error) {
        sendError(res, status, error);
    }
}

module.exports = {
    TenantController
};
