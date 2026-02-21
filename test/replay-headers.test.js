'use strict';

/**
 * Tests for replay header sanitization (Phase 2C)
 * Verifies that _executeReplay uses allowlist approach for headers.
 */

const crypto = require('crypto');

// We need to test _executeReplay in isolation. Since it uses https.request,
// we'll mock https and test the headers passed to it.
const https = require('https');

jest.mock('https');

const { ProxyServer } = require('../lib/proxy-server');

describe('Replay Header Sanitization', () => {
    let server;

    beforeEach(() => {
        jest.clearAllMocks();

        // Create a minimal proxy server instance
        server = Object.create(ProxyServer.prototype);
        server.config = {
            targetHost: 'api.example.com',
            targetBasePath: '/v1',
            adaptiveTimeout: { initialMs: 30000 }
        };
        server.keyManager = {
            getKeyByIndex: jest.fn().mockReturnValue({
                key: 'test-key-123',
                inFlight: 0
            }),
            acquireKey: jest.fn().mockReturnValue({
                key: 'test-key-456',
                inFlight: 0
            }),
            recordSuccess: jest.fn(),
            recordFailure: jest.fn()
        };
        server.requestHandler = {
            _categorizeError: jest.fn().mockReturnValue('unknown')
        };
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    function mockHttpsRequest(statusCode = 200, responseBody = '{}') {
        const mockReq = {
            on: jest.fn(),
            write: jest.fn(),
            end: jest.fn(),
            destroy: jest.fn()
        };

        https.request.mockImplementation((options, callback) => {
            // Simulate successful response
            process.nextTick(() => {
                const mockRes = {
                    statusCode,
                    on: jest.fn()
                };
                const dataHandler = {};
                mockRes.on.mockImplementation((event, handler) => {
                    dataHandler[event] = handler;
                });
                callback(mockRes);
                // Send response data
                if (dataHandler['data']) {
                    dataHandler['data'](Buffer.from(responseBody));
                }
                if (dataHandler['end']) {
                    dataHandler['end']();
                }
            });
            return mockReq;
        });

        return mockReq;
    }

    test('authorization, cookie, x-api-key absent from upstream headers', async () => {
        mockHttpsRequest();

        const request = {
            method: 'POST',
            url: '/messages',
            headers: {
                'content-type': 'application/json',
                'authorization': 'Bearer stolen-token',
                'cookie': 'session=abc123',
                'x-api-key': 'old-leaked-key',
                'x-forwarded-for': '10.0.0.1'
            },
            body: Buffer.from('{}').toString('base64'),
            targetKeyIndex: 0
        };

        await server._executeReplay(request);

        const callArgs = https.request.mock.calls[0][0];
        const headers = callArgs.headers;

        expect(headers['authorization']).toBeUndefined();
        expect(headers['cookie']).toBeUndefined();
        expect(headers['x-forwarded-for']).toBeUndefined();
        // x-api-key should be the PROXY's key, not the stored one
        expect(headers['x-api-key']).toBe('test-key-123');
    });

    test('connection header absent (not in allowlist)', async () => {
        mockHttpsRequest();

        const request = {
            method: 'POST',
            url: '/messages',
            headers: {
                'content-type': 'application/json',
                'connection': 'keep-alive',
                'transfer-encoding': 'chunked'
            },
            body: Buffer.from('{}').toString('base64'),
            targetKeyIndex: 0
        };

        await server._executeReplay(request);

        const callArgs = https.request.mock.calls[0][0];
        const headers = callArgs.headers;

        expect(headers['connection']).toBeUndefined();
        expect(headers['transfer-encoding']).toBeUndefined();
    });

    test('x-request-id is fresh UUID, not forwarded from stored request', async () => {
        mockHttpsRequest();

        const storedRequestId = 'old-request-id-12345';
        const request = {
            method: 'POST',
            url: '/messages',
            headers: {
                'content-type': 'application/json',
                'x-request-id': storedRequestId
            },
            body: Buffer.from('{}').toString('base64'),
            targetKeyIndex: 0
        };

        await server._executeReplay(request);

        const callArgs = https.request.mock.calls[0][0];
        const headers = callArgs.headers;

        expect(headers['x-request-id']).toBeDefined();
        expect(headers['x-request-id']).not.toBe(storedRequestId);
        // Should be a valid UUID or hex string
        expect(headers['x-request-id']).toMatch(/^[0-9a-f-]{32,36}$/);
    });

    test('content-type passes through, content-length matches body buffer length', async () => {
        mockHttpsRequest();

        const bodyContent = JSON.stringify({ model: 'claude-3', messages: [{ role: 'user', content: 'hello' }] });
        const base64Body = Buffer.from(bodyContent).toString('base64');

        const request = {
            method: 'POST',
            url: '/messages',
            headers: {
                'content-type': 'application/json',
                'accept': 'application/json'
            },
            body: base64Body,
            targetKeyIndex: 0
        };

        await server._executeReplay(request);

        const callArgs = https.request.mock.calls[0][0];
        const headers = callArgs.headers;

        expect(headers['content-type']).toBe('application/json');
        expect(headers['accept']).toBe('application/json');
        expect(headers['content-length']).toBe(String(Buffer.from(bodyContent).length));
    });

    test('host derived from config, not stored headers', async () => {
        mockHttpsRequest();

        const request = {
            method: 'POST',
            url: '/messages',
            headers: {
                'content-type': 'application/json',
                'host': 'evil.attacker.com'
            },
            body: Buffer.from('{}').toString('base64'),
            targetKeyIndex: 0
        };

        await server._executeReplay(request);

        const callArgs = https.request.mock.calls[0][0];

        expect(callArgs.hostname).toBe('api.example.com');
        expect(callArgs.headers['host']).toBe('api.example.com');
    });

    test('multi-value headers (string[]) joined with comma-space', async () => {
        mockHttpsRequest();

        const request = {
            method: 'POST',
            url: '/messages',
            headers: {
                'content-type': 'application/json',
                'accept-encoding': ['gzip', 'deflate', 'br']
            },
            body: Buffer.from('{}').toString('base64'),
            targetKeyIndex: 0
        };

        await server._executeReplay(request);

        const callArgs = https.request.mock.calls[0][0];
        const headers = callArgs.headers;

        expect(headers['accept-encoding']).toBe('gzip, deflate, br');
    });

    test('inFlight incremented for getKeyByIndex path', async () => {
        const keyInfo = { key: 'test-key', inFlight: 0 };
        server.keyManager.getKeyByIndex.mockReturnValue(keyInfo);
        mockHttpsRequest();

        const request = {
            method: 'POST',
            url: '/messages',
            headers: { 'content-type': 'application/json' },
            body: Buffer.from('{}').toString('base64'),
            targetKeyIndex: 0
        };

        await server._executeReplay(request);

        expect(keyInfo.inFlight).toBe(1);
    });

    test('inFlight NOT double-incremented for acquireKey path', async () => {
        const keyInfo = { key: 'test-key', inFlight: 5 };
        server.keyManager.acquireKey.mockReturnValue(keyInfo);
        mockHttpsRequest();

        const request = {
            method: 'POST',
            url: '/messages',
            headers: { 'content-type': 'application/json' },
            body: Buffer.from('{}').toString('base64')
            // No targetKeyIndex — uses acquireKey path
        };

        await server._executeReplay(request);

        // acquireKey increments inFlight internally, so we should NOT increment again
        expect(keyInfo.inFlight).toBe(5);
    });

    describe('Replay Slot Release', () => {
        test('releases router slot after successful replay', async () => {
            mockHttpsRequest(200, '{"ok":true}');

            const mockRouter = {
                selectModel: jest.fn().mockResolvedValue({ model: 'claude-sonnet-4-5-20250929' }),
                releaseModel: jest.fn()
            };
            server.modelRouter = mockRouter;

            const body = JSON.stringify({ model: 'claude-3-opus', messages: [{ role: 'user', content: 'test' }] });
            const request = {
                method: 'POST',
                url: '/messages',
                headers: { 'content-type': 'application/json' },
                body: Buffer.from(body).toString('base64'),
                targetKeyIndex: 0
            };

            await server._executeReplay(request);

            expect(mockRouter.selectModel).toHaveBeenCalled();
            expect(mockRouter.releaseModel).toHaveBeenCalledWith('claude-sonnet-4-5-20250929');
        });

        test('releases router slot after failed replay', async () => {
            mockHttpsRequest(500, '{"error":"internal"}');

            const mockRouter = {
                selectModel: jest.fn().mockResolvedValue({ model: 'claude-opus-4-20250514' }),
                releaseModel: jest.fn()
            };
            server.modelRouter = mockRouter;

            const body = JSON.stringify({ model: 'claude-3-opus', messages: [{ role: 'user', content: 'test' }] });
            const request = {
                method: 'POST',
                url: '/messages',
                headers: { 'content-type': 'application/json' },
                body: Buffer.from(body).toString('base64'),
                targetKeyIndex: 0
            };

            await server._executeReplay(request);

            expect(mockRouter.releaseModel).toHaveBeenCalledWith('claude-opus-4-20250514');
        });

        test('releases router slot on timeout', async () => {
            const mockReq = {
                on: jest.fn(),
                write: jest.fn(),
                end: jest.fn(),
                destroy: jest.fn()
            };

            https.request.mockImplementation((_options, _callback) => {
                // Trigger timeout handler
                process.nextTick(() => {
                    const timeoutHandler = mockReq.on.mock.calls.find(c => c[0] === 'timeout');
                    if (timeoutHandler) timeoutHandler[1]();
                });
                return mockReq;
            });

            const mockRouter = {
                selectModel: jest.fn().mockResolvedValue({ model: 'claude-sonnet-4-5-20250929' }),
                releaseModel: jest.fn()
            };
            server.modelRouter = mockRouter;

            const body = JSON.stringify({ model: 'claude-3-opus', messages: [{ role: 'user', content: 'test' }] });
            const request = {
                method: 'POST',
                url: '/messages',
                headers: { 'content-type': 'application/json' },
                body: Buffer.from(body).toString('base64'),
                targetKeyIndex: 0
            };

            await server._executeReplay(request);

            expect(mockRouter.releaseModel).toHaveBeenCalledWith('claude-sonnet-4-5-20250929');
        });

        test('releases router slot on network error', async () => {
            const mockReq = {
                on: jest.fn(),
                write: jest.fn(),
                end: jest.fn(),
                destroy: jest.fn()
            };

            https.request.mockImplementation((_options, _callback) => {
                // Trigger error handler
                process.nextTick(() => {
                    const errorHandler = mockReq.on.mock.calls.find(c => c[0] === 'error');
                    if (errorHandler) errorHandler[1](new Error('ECONNREFUSED'));
                });
                return mockReq;
            });

            const mockRouter = {
                selectModel: jest.fn().mockResolvedValue({ model: 'claude-opus-4-20250514' }),
                releaseModel: jest.fn()
            };
            server.modelRouter = mockRouter;

            const body = JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'test' }] });
            const request = {
                method: 'POST',
                url: '/messages',
                headers: { 'content-type': 'application/json' },
                body: Buffer.from(body).toString('base64'),
                targetKeyIndex: 0
            };

            await server._executeReplay(request);

            expect(mockRouter.releaseModel).toHaveBeenCalledWith('claude-opus-4-20250514');
        });

        test('no release when selectModel returns null', async () => {
            mockHttpsRequest(200, '{}');

            const mockRouter = {
                selectModel: jest.fn().mockResolvedValue(null),
                releaseModel: jest.fn()
            };
            server.modelRouter = mockRouter;

            const body = JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'test' }] });
            const request = {
                method: 'POST',
                url: '/messages',
                headers: { 'content-type': 'application/json' },
                body: Buffer.from(body).toString('base64'),
                targetKeyIndex: 0
            };

            await server._executeReplay(request);

            expect(mockRouter.releaseModel).not.toHaveBeenCalled();
        });
    });
});
