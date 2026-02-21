/**
 * Webhook Controller Module
 *
 * Handles webhook-related routes extracted from ProxyServer.
 * Provides endpoints for webhook management and testing.
 *
 * TDD Phase: Green - Implementation to make tests pass
 */

'use strict';

const parseJsonBody = require('../../body-parser').parseJsonBody;

/**
 * WebhookController class for webhook-related HTTP endpoints
 */
class WebhookController {
    /**
     * @param {Object} options - Configuration options
     * @param {Object} options.webhookManager - WebhookManager instance
     * @param {Function|Object} options.bodyParser - Function to parse JSON body or object with parseJsonBody method (optional)
     */
    constructor(options = {}) {
        this._webhookManager = options.webhookManager || null;
        // Handle both function-style and object-with-method-style bodyParser
        const providedParser = options.bodyParser || parseJsonBody;
        this._bodyParser = typeof providedParser === 'function' ? providedParser : providedParser.parseJsonBody;
    }

    /**
     * Handle /webhooks endpoint
     * GET: Return webhook endpoints and delivery stats
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    handleWebhooks(req, res) {
        if (!this._webhookManager) {
            this._sendError(res, 404, 'Webhooks not enabled');
            return;
        }

        this._sendJson(res, 200, {
            endpoints: this._webhookManager.getEndpoints(),
            stats: this._webhookManager.getDeliveryStats()
        });
    }

    /**
     * Handle /webhooks/test endpoint
     * POST: Test a webhook endpoint
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    async handleWebhookTest(req, res) {
        if (req.method !== 'POST') {
            this._sendError(res, 405, 'Method not allowed');
            return;
        }

        if (!this._webhookManager) {
            this._sendError(res, 404, 'Webhooks not enabled');
            return;
        }

        try {
            const { url } = await this._bodyParser(req);
            if (!url) {
                this._sendError(res, 400, 'URL required');
                return;
            }

            const result = await this._webhookManager.testWebhook(url);
            this._sendJson(res, result.success ? 200 : 400, result);
        } catch (e) {
            this._sendError(res, e.statusCode || 400, e.message || 'Invalid JSON body');
        }
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
    WebhookController
};
