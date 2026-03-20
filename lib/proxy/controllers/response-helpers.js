/**
 * Shared Response Helpers for Controllers
 *
 * Provides consistent JSON and error response formatting across all controllers.
 * All error responses include:
 * - Content-Type: application/json
 * - Cache-Control: no-store
 * - JSON body with { error: message } structure
 */

'use strict';

/**
 * Send a JSON response with standard headers.
 * @param {Object} res - HTTP response
 * @param {number} status - HTTP status code
 * @param {Object} data - Response data to serialize
 */
function sendJson(res, status, data) {
    if (res.headersSent) return;
    res.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store'
    });
    res.end(JSON.stringify(data));
}

/**
 * Send a JSON error response with standard headers.
 * @param {Object} res - HTTP response
 * @param {number} status - HTTP status code (4xx or 5xx)
 * @param {string} message - Error message
 */
function sendError(res, status, message) {
    sendJson(res, status, { error: message });
}

module.exports = {
    sendJson,
    sendError
};
