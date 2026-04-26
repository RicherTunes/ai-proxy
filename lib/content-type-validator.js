'use strict';

/**
 * Content-Type Validation Helper
 *
 * Validates that POST/PUT requests to controller endpoints carry
 * an appropriate JSON Content-Type. Returns 415 Unsupported Media Type
 * when the Content-Type is present but not application/json.
 *
 * Rules:
 * - Missing Content-Type header is ALLOWED (empty body / action-only POST).
 * - "application/json" (with optional params like charset) is ALLOWED.
 * - Any other Content-Type value is REJECTED with 415.
 */

/**
 * Check whether a request has an acceptable Content-Type for JSON endpoints.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {boolean} true if acceptable, false if should be rejected with 415
 */
function requireJsonContentType(req) {
    const ct = (req.headers['content-type'] || '').toLowerCase().trim();

    // No Content-Type header — allow (empty body or action-only POST)
    if (ct === '') return true;

    // Must start with application/json (allows "; charset=utf-8" suffix)
    return ct.startsWith('application/json');
}

/**
 * Middleware-style guard.  Call at the top of any POST/PUT handler that
 * expects a JSON body.  If Content-Type is invalid the response is ended
 * with 415 and the function returns `true` (meaning "handled / rejected").
 *
 * Usage:
 *   if (rejectNonJsonContentType(req, res)) return;
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {boolean} true if the request was rejected (caller should return)
 */
function rejectNonJsonContentType(req, res) {
    if (requireJsonContentType(req)) return false;

    res.writeHead(415, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
        error: 'Unsupported Media Type',
        message: 'Content-Type must be application/json'
    }));
    return true;
}

module.exports = { requireJsonContentType, rejectNonJsonContentType };
