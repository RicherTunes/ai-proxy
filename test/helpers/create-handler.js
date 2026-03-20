'use strict';

const EventEmitter = require('events');

/**
 * Shared test-factory helpers for RequestHandler unit tests.
 *
 * Both request-handler-proxy.test.js and request-handler-branches.test.js
 * used identical copies of these helpers.  This module is the single source
 * of truth so the two test files stay in sync.
 *
 * NOTE: createKeyManager and createHandler are NOT exported here because
 * both consuming test files need to use their own module references
 * (jest.mock / jest.isolateModules give different `https`, `RequestHandler`,
 * and `KeyManager` instances).  Only the mock-object factories are shared.
 */

function createMockReq(overrides = {}) {
    return {
        method: 'POST',
        url: '/v1/messages',
        headers: {
            'content-type': 'application/json',
            'host': 'localhost:3000',
            ...overrides.headers
        },
        ...overrides
    };
}

function createMockRes() {
    const res = {
        headersSent: false,
        writeHead: jest.fn(),
        end: jest.fn(),
        on: jest.fn(),
        once: jest.fn(),
        removeListener: jest.fn(),
        pipe: jest.fn()
    };
    return res;
}

/**
 * Create a mock proxyReq EventEmitter that behaves like http.ClientRequest
 */
function createMockProxyReq() {
    const proxyReq = new EventEmitter();
    proxyReq.write = jest.fn();
    proxyReq.end = jest.fn();
    proxyReq.destroy = jest.fn();
    proxyReq.reusedSocket = false;
    proxyReq.socket = { localPort: 12345, remotePort: 443 };
    return proxyReq;
}

/**
 * Create a mock proxyRes EventEmitter that behaves like http.IncomingMessage
 */
function createMockProxyRes(statusCode = 200, headers = {}) {
    const proxyRes = new EventEmitter();
    proxyRes.statusCode = statusCode;
    proxyRes.headers = headers;
    proxyRes.resume = jest.fn();
    proxyRes.pipe = jest.fn((dest) => {
        setImmediate(() => proxyRes.emit('end'));
    });
    return proxyRes;
}

/**
 * Setup https.request mock that triggers callback with proxyRes on next tick.
 * Callers must pass in their own `https` reference (may be globally mocked or
 * obtained via jest.isolateModules).
 */
function setupHttpsMock(https, proxyReq, proxyRes) {
    https.request.mockImplementation((options, callback) => {
        if (proxyRes) {
            process.nextTick(() => callback(proxyRes));
        }
        return proxyReq;
    });
}

module.exports = {
    createMockReq,
    createMockRes,
    createMockProxyReq,
    createMockProxyRes,
    setupHttpsMock
};
