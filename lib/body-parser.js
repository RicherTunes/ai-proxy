'use strict';

/**
 * Body Parser Utility
 * Centralized request body parsing with size limits and error handling.
 * Replaces 12+ inline `req.on('data')` patterns in proxy-server.js.
 */

const DEFAULT_MAX_SIZE = 1 * 1024 * 1024; // 1MB

/**
 * Parse a request body as a UTF-8 string.
 * @param {http.IncomingMessage} req - HTTP request
 * @param {Object} opts - { maxSize: number (bytes, default 1MB) }
 * @returns {Promise<string>} Raw body string
 * @throws {{ statusCode: number, message: string }} On error
 */
function parseRawBody(req, opts = {}) {
    const maxSize = opts.maxSize ?? DEFAULT_MAX_SIZE;

    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;

        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxSize) {
                req.destroy();
                reject({ statusCode: 413, message: 'Payload too large' });
                return;
            }
            chunks.push(chunk);
        });

        req.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));

        req.once('error', () => reject({ statusCode: 400, message: 'Request aborted' }));
        req.once('aborted', () => reject({ statusCode: 400, message: 'Request aborted' }));
    });
}

/**
 * Parse a request body as JSON.
 * @param {http.IncomingMessage} req - HTTP request
 * @param {Object} opts - { maxSize: number, allowEmpty: boolean }
 * @returns {Promise<Object>} Parsed JSON object
 * @throws {{ statusCode: number, message: string }} On error
 */
async function parseJsonBody(req, opts = {}) {
    const { allowEmpty = true, ...rawOpts } = opts;

    const body = await parseRawBody(req, rawOpts);

    if (!body && allowEmpty) return {};

    try {
        return JSON.parse(body);
    } catch (e) {
        throw { statusCode: 400, message: 'Invalid JSON body' };
    }
}

module.exports = { parseJsonBody, parseRawBody, DEFAULT_MAX_SIZE };
