'use strict';

const http = require('http');

/**
 * Shared HTTP request helper for E2E tests.
 *
 * Makes an HTTP request and returns a promise that resolves with
 * { statusCode, headers, body, json() }.
 *
 * @param {string} url  Full URL including port (e.g. http://127.0.0.1:3000/health)
 * @param {object} options  Standard http.request options plus optional `body` string.
 * @returns {Promise<{statusCode: number, headers: object, body: string, json: Function}>}
 */
function request(url, options = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        body: data,
                        json: () => JSON.parse(data)
                    });
                } catch (e) {
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        body: data,
                        json: () => null
                    });
                }
            });
        });
        req.on('error', reject);
        if (options.body) {
            req.write(options.body);
        }
        req.end();
    });
}

module.exports = { request };
