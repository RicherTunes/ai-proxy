'use strict';

/**
 * Request Handler Proxy Tests
 *
 * Comprehensive tests for RequestHandler's proxy internals:
 * - _categorizeError (extended patterns)
 * - parseTokenUsage (SSE parsing)
 * - _transformRequestBody (model routing + override)
 * - _makeProxyRequest (header stripping, status codes, error events)
 * - _proxyWithRetries (retry loop, backoff, pool cooldown)
 * - Trace API delegation
 */

const https = require('https');
jest.mock('https');

const { RequestHandler, calculateBackoff, ERROR_STRATEGIES } = require('../lib/request-handler');
const { KeyManager } = require('../lib/key-manager');
const { TraceStore, RequestTrace, SpanType } = require('../lib/request-trace');
const EventEmitter = require('events');

// ============================================================================
// SHARED SETUP HELPERS
// ============================================================================

function createKeyManager(keys = ['key1.secret1', 'key2.secret2']) {
    const km = new KeyManager({
        maxConcurrencyPerKey: 5,
        circuitBreaker: {
            failureThreshold: 5,
            failureWindow: 5000,
            cooldownPeriod: 1000
        }
    });
    km.loadKeys(keys);
    return km;
}

function createHandler(overrides = {}) {
    const km = overrides.keyManager || createKeyManager();
    const rh = new RequestHandler({
        keyManager: km,
        config: {
            maxRetries: 2,
            requestTimeout: 5000,
            maxTotalConcurrency: 10,
            ...overrides.config
        },
        ...overrides
    });
    return { rh, km };
}

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
        // Make pipe work for streaming tests
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
        // Simulate piping: when pipe is called, schedule the 'end' event
        // This ensures all 'on' listeners are registered before 'end' fires
        setImmediate(() => proxyRes.emit('end'));
    });
    return proxyRes;
}

/**
 * Setup https.request mock that triggers callback with proxyRes on next tick
 */
function setupHttpsMock(proxyReq, proxyRes) {
    https.request.mockImplementation((options, callback) => {
        if (proxyRes) {
            process.nextTick(() => callback(proxyRes));
        }
        return proxyReq;
    });
}

// ============================================================================
// 1a. _categorizeError (extended patterns)
// ============================================================================

describe('_categorizeError (extended)', () => {
    let rh;

    beforeAll(() => {
        const setup = createHandler();
        rh = setup.rh;
    });

    afterAll(() => {
        rh.destroy();
    });

    // broken_pipe
    test('EPIPE -> broken_pipe', () => {
        expect(rh._categorizeError({ code: 'EPIPE' })).toBe('broken_pipe');
    });

    test('ERR_STREAM_WRITE_AFTER_END -> broken_pipe', () => {
        expect(rh._categorizeError({ code: 'ERR_STREAM_WRITE_AFTER_END' })).toBe('broken_pipe');
    });

    // connection_aborted
    test('ECONNABORTED -> connection_aborted', () => {
        expect(rh._categorizeError({ code: 'ECONNABORTED' })).toBe('connection_aborted');
    });

    // stream_premature_close
    test('ERR_STREAM_PREMATURE_CLOSE -> stream_premature_close', () => {
        expect(rh._categorizeError({ code: 'ERR_STREAM_PREMATURE_CLOSE' })).toBe('stream_premature_close');
    });

    test('premature close message -> stream_premature_close', () => {
        expect(rh._categorizeError({ code: '', message: 'premature close' })).toBe('stream_premature_close');
    });

    // http_parse_error
    test('HPE_INVALID_HEADER_TOKEN -> http_parse_error', () => {
        expect(rh._categorizeError({ code: 'HPE_INVALID_HEADER_TOKEN' })).toBe('http_parse_error');
    });

    test('Parse Error message -> http_parse_error', () => {
        expect(rh._categorizeError({ code: '', message: 'Parse Error' })).toBe('http_parse_error');
    });

    // dns_error (additional patterns)
    test('EAI_AGAIN -> dns_error', () => {
        expect(rh._categorizeError({ code: 'EAI_AGAIN' })).toBe('dns_error');
    });

    test('getaddrinfo message -> dns_error', () => {
        expect(rh._categorizeError({ code: '', message: 'getaddrinfo ENOTFOUND example.com' })).toBe('dns_error');
    });

    // connection_refused (network unreachable aliases)
    test('ENETUNREACH -> connection_refused', () => {
        expect(rh._categorizeError({ code: 'ENETUNREACH' })).toBe('connection_refused');
    });

    test('EHOSTUNREACH -> connection_refused', () => {
        expect(rh._categorizeError({ code: 'EHOSTUNREACH' })).toBe('connection_refused');
    });

    // tls_error (additional patterns)
    test('EPROTO -> tls_error', () => {
        expect(rh._categorizeError({ code: 'EPROTO' })).toBe('tls_error');
    });

    test('certificate message -> tls_error', () => {
        expect(rh._categorizeError({ code: '', message: 'certificate has expired' })).toBe('tls_error');
    });

    test('UNABLE_TO_VERIFY_LEAF_SIGNATURE -> tls_error', () => {
        expect(rh._categorizeError({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })).toBe('tls_error');
    });

    // rate_limited (via error message)
    test('429 in message -> rate_limited', () => {
        expect(rh._categorizeError({ code: '', message: 'Error 429: Too Many Requests' })).toBe('rate_limited');
    });

    test('rate limit in message -> rate_limited', () => {
        expect(rh._categorizeError({ code: '', message: 'rate limit exceeded' })).toBe('rate_limited');
    });
});

// ============================================================================
// 1b. parseTokenUsage
// ============================================================================

describe('parseTokenUsage', () => {
    let rh;

    beforeAll(() => {
        const setup = createHandler();
        rh = setup.rh;
    });

    afterAll(() => {
        rh.destroy();
    });

    test('returns null for empty array', () => {
        expect(rh.parseTokenUsage([])).toBeNull();
    });

    test('returns null for non-array input (null, undefined, string)', () => {
        expect(rh.parseTokenUsage(null)).toBeNull();
        expect(rh.parseTokenUsage(undefined)).toBeNull();
        expect(rh.parseTokenUsage('not-an-array')).toBeNull();
    });

    test('returns null when no SSE data: lines found', () => {
        const chunk = Buffer.from('event: message_stop\n\n');
        expect(rh.parseTokenUsage([chunk])).toBeNull();
    });

    test('parses Anthropic SSE format with anthropic.usage', () => {
        const chunk = Buffer.from(
            'event: message_stop\ndata: {"type":"message_stop","anthropic":{"usage":{"input_tokens":100,"output_tokens":50}}}\n\n'
        );
        const result = rh.parseTokenUsage([chunk]);
        expect(result).toEqual({ input_tokens: 100, output_tokens: 50 });
    });

    test('parses direct SSE format with usage', () => {
        const chunk = Buffer.from(
            'data: {"type":"message_delta","usage":{"input_tokens":200,"output_tokens":75}}\n\n'
        );
        const result = rh.parseTokenUsage([chunk]);
        expect(result).toEqual({ input_tokens: 200, output_tokens: 75 });
    });

    test('skips data: [DONE] lines and parses subsequent data', () => {
        const chunk = Buffer.from(
            'data: [DONE]\ndata: {"usage":{"input_tokens":10,"output_tokens":20}}\n\n'
        );
        const result = rh.parseTokenUsage([chunk]);
        expect(result).toEqual({ input_tokens: 10, output_tokens: 20 });
    });

    test('returns null for malformed JSON in SSE data line', () => {
        const chunk = Buffer.from('data: {not valid json}\n\n');
        expect(rh.parseTokenUsage([chunk])).toBeNull();
    });
});

// ============================================================================
// 1c. _transformRequestBody
// ============================================================================

describe('_transformRequestBody', () => {
    let rh, km;

    beforeEach(() => {
        const setup = createHandler();
        rh = setup.rh;
        km = setup.km;
    });

    afterEach(() => {
        rh.destroy();
    });

    test('exists as a function on RequestHandler instances', () => {
        expect(typeof rh._transformRequestBody).toBe('function');
    });

    test('returns {body, null, null, null} when body is empty (0 bytes)', async () => {
        const body = Buffer.alloc(0);
        const result = await rh._transformRequestBody(body, null);
        expect(result.body).toBe(body);
        expect(result.originalModel).toBeNull();
        expect(result.mappedModel).toBeNull();
        expect(result.routingDecision).toBeNull();
    });

    test('returns {body, null, null, null} when body is not valid JSON', async () => {
        const body = Buffer.from('not-json');
        const result = await rh._transformRequestBody(body, null);
        expect(result.body).toBe(body);
        expect(result.originalModel).toBeNull();
        expect(result.mappedModel).toBeNull();
    });

    test('returns {body, null, null, null} when parsed JSON has no model field', async () => {
        const body = Buffer.from(JSON.stringify({ messages: [] }));
        const result = await rh._transformRequestBody(body, null);
        expect(result.body).toBe(body);
        expect(result.originalModel).toBeNull();
    });

    test('routes via modelRouter.selectModel when router set and returns non-null', async () => {
        rh.modelRouter = {
            selectModel: jest.fn().mockResolvedValue({
                model: 'glm-4-plus',
                source: 'complexity',
                tier: 'medium',
                reason: 'test'
            }),
            config: { logDecisions: false }
        };

        const body = Buffer.from(JSON.stringify({ model: 'claude-3-haiku', messages: [] }));
        const result = await rh._transformRequestBody(body, null, 0, null, new Set());

        expect(rh.modelRouter.selectModel).toHaveBeenCalled();
        expect(result.originalModel).toBe('claude-3-haiku');
        expect(result.mappedModel).toBe('glm-4-plus');
        expect(result.routingDecision).toBeTruthy();
        expect(result.routingDecision.source).toBe('complexity');

        // Verify the body was updated
        const parsed = JSON.parse(result.body.toString());
        expect(parsed.model).toBe('glm-4-plus');
    });

    test('returns original model when router returns null', async () => {
        rh.modelRouter = {
            selectModel: jest.fn().mockResolvedValue(null),
            config: { logDecisions: false }
        };

        const body = Buffer.from(JSON.stringify({ model: 'claude-3-haiku', messages: [] }));
        const result = await rh._transformRequestBody(body, null, 0);

        // Router returned null → returns original model unchanged
        expect(result.originalModel).toBe('claude-3-haiku');
        expect(result.mappedModel).toBe('claude-3-haiku');
        expect(result.routingDecision).toBeNull();
    });

    test('passes attemptedModels set to modelRouter.selectModel context', async () => {
        const attemptedModels = new Set(['glm-4-plus']);
        rh.modelRouter = {
            selectModel: jest.fn().mockResolvedValue({
                model: 'glm-4',
                source: 'fallback',
                tier: 'low',
                reason: 'previous model exhausted'
            }),
            config: { logDecisions: false }
        };

        const body = Buffer.from(JSON.stringify({ model: 'claude-3-haiku', messages: [] }));
        await rh._transformRequestBody(body, null, 0, null, attemptedModels);

        const callArgs = rh.modelRouter.selectModel.mock.calls[0][0];
        expect(callArgs.attemptedModels).toBe(attemptedModels);
    });

    test('x-model-override accepted when adminAuth not configured (current design)', async () => {
        rh.modelRouter = {
            selectModel: jest.fn().mockResolvedValue({
                model: 'overridden-model',
                source: 'override',
                tier: 'high',
                reason: 'user override'
            }),
            config: { logDecisions: false }
        };

        const req = createMockReq({
            headers: {
                'content-type': 'application/json',
                'x-model-override': 'custom-model'
            }
        });

        const body = Buffer.from(JSON.stringify({ model: 'claude-3-haiku', messages: [] }));
        await rh._transformRequestBody(body, null, 0, req);

        const callArgs = rh.modelRouter.selectModel.mock.calls[0][0];
        expect(callArgs.override).toBe('custom-model');
    });

    test('x-model-override accepted when adminAuth passes authentication', async () => {
        rh.modelRouter = {
            selectModel: jest.fn().mockResolvedValue({
                model: 'custom-model',
                source: 'override',
                tier: 'high',
                reason: 'admin override'
            }),
            config: { logDecisions: false }
        };
        rh.config.adminAuth = { enabled: true };
        rh.config._adminAuthInstance = {
            authenticate: jest.fn().mockReturnValue({ authenticated: true })
        };

        const req = createMockReq({
            headers: {
                'content-type': 'application/json',
                'x-model-override': 'custom-model'
            }
        });

        const body = Buffer.from(JSON.stringify({ model: 'claude-3-haiku', messages: [] }));
        await rh._transformRequestBody(body, null, 0, req);

        const callArgs = rh.modelRouter.selectModel.mock.calls[0][0];
        expect(callArgs.override).toBe('custom-model');
    });

    test('x-model-override rejected (override=null) when adminAuth fails', async () => {
        const mockAuthInstance = {
            authenticate: jest.fn().mockReturnValue({ authenticated: false })
        };
        rh.modelRouter = {
            selectModel: jest.fn().mockResolvedValue(null),
            config: { logDecisions: false, adminAuth: { enabled: true }, _adminAuthInstance: mockAuthInstance }
        };
        rh.config.adminAuth = { enabled: true };
        rh.config._adminAuthInstance = mockAuthInstance;

        const req = createMockReq({
            headers: {
                'content-type': 'application/json',
                'x-model-override': 'custom-model'
            }
        });

        const body = Buffer.from(JSON.stringify({ model: 'claude-3-haiku', messages: [] }));
        await rh._transformRequestBody(body, null, 0, req);

        const callArgs = rh.modelRouter.selectModel.mock.calls[0][0];
        expect(callArgs.override).toBeNull();
    });

    test('returns original model unchanged when no router set', async () => {
        rh.modelRouter = null;

        const body = Buffer.from(JSON.stringify({ model: 'claude-3-haiku', messages: [] }));
        const result = await rh._transformRequestBody(body, null, 0);

        expect(result.originalModel).toBe('claude-3-haiku');
        expect(result.mappedModel).toBe('claude-3-haiku');
        expect(result.body).toBe(body); // Same buffer, not re-serialized
    });
});

// ============================================================================
// 1d. _makeProxyRequest
// ============================================================================

describe('_makeProxyRequest', () => {
    let rh, km;

    beforeEach(() => {
        https.request.mockReset();
        const setup = createHandler();
        rh = setup.rh;
        km = setup.km;
    });

    afterEach(() => {
        rh.destroy();
    });

    function getKeyInfo() {
        return km.acquireKey();
    }

    function createTraceAttempt() {
        return {
            addSpan: jest.fn().mockReturnValue({ end: jest.fn() }),
            markRetry: jest.fn(),
            end: jest.fn()
        };
    }

    // -- Header stripping tests --

    test('final headers exclude authorization, x-api-key, x-admin-token, cookie', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(200);

        setupHttpsMock(proxyReq, proxyRes);

        const req = createMockReq({
            headers: {
                'content-type': 'application/json',
                'authorization': 'Bearer old-token',
                'x-api-key': 'old-key',
                'x-admin-token': 'admin-secret',
                'cookie': 'session=abc123'
            }
        });

        const keyInfo = getKeyInfo();
        const body = Buffer.from('{}');

        const result = await rh._makeProxyRequest(
            req, createMockRes(), body, keyInfo,
            'req-1', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        const callOptions = https.request.mock.calls[0][0];
        // Original client headers should be stripped
        expect(callOptions.headers['cookie']).toBeUndefined();
        expect(callOptions.headers['x-admin-token']).toBeUndefined();
        // New auth headers set from keyInfo
        expect(callOptions.headers['x-api-key']).toBe(keyInfo.key);
        expect(callOptions.headers['authorization']).toBe(`Bearer ${keyInfo.key}`);
    });

    test('final headers exclude hop-by-hop headers', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(200);
        setupHttpsMock(proxyReq, proxyRes);

        const req = createMockReq({
            headers: {
                'content-type': 'application/json',
                'transfer-encoding': 'chunked',
                'connection': 'keep-alive',
                'proxy-authorization': 'Basic abc',
                'upgrade': 'websocket',
                'te': 'trailers'
            }
        });

        const keyInfo = getKeyInfo();

        const result = await rh._makeProxyRequest(
            req, createMockRes(), Buffer.from('{}'), keyInfo,
            'req-2', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        const callOptions = https.request.mock.calls[0][0];
        expect(callOptions.headers['transfer-encoding']).toBeUndefined();
        expect(callOptions.headers['proxy-authorization']).toBeUndefined();
        expect(callOptions.headers['upgrade']).toBeUndefined();
        expect(callOptions.headers['te']).toBeUndefined();
    });

    test('final headers exclude custom headers listed in Connection header', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(200);
        setupHttpsMock(proxyReq, proxyRes);

        const req = createMockReq({
            headers: {
                'content-type': 'application/json',
                'connection': 'keep-alive, x-custom-hop',
                'x-custom-hop': 'should-be-removed'
            }
        });

        const keyInfo = getKeyInfo();

        const result = await rh._makeProxyRequest(
            req, createMockRes(), Buffer.from('{}'), keyInfo,
            'req-3', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        const callOptions = https.request.mock.calls[0][0];
        expect(callOptions.headers['x-custom-hop']).toBeUndefined();
    });

    test('final headers exclude x-proxy-* prefixed headers', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(200);
        setupHttpsMock(proxyReq, proxyRes);

        const req = createMockReq({
            headers: {
                'content-type': 'application/json',
                'x-proxy-rate-limit': 'pool',
                'x-proxy-retry-after-ms': '500'
            }
        });

        const keyInfo = getKeyInfo();

        const result = await rh._makeProxyRequest(
            req, createMockRes(), Buffer.from('{}'), keyInfo,
            'req-4', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        const callOptions = https.request.mock.calls[0][0];
        expect(callOptions.headers['x-proxy-rate-limit']).toBeUndefined();
        expect(callOptions.headers['x-proxy-retry-after-ms']).toBeUndefined();
    });

    test('final headers include host, x-api-key, authorization with key, x-request-id', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(200);
        setupHttpsMock(proxyReq, proxyRes);

        const req = createMockReq();
        const keyInfo = getKeyInfo();

        const result = await rh._makeProxyRequest(
            req, createMockRes(), Buffer.from('{}'), keyInfo,
            'req-id-abc', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        const callOptions = https.request.mock.calls[0][0];
        expect(callOptions.headers['host']).toBe('api.z.ai');
        expect(callOptions.headers['x-api-key']).toBe(keyInfo.key);
        expect(callOptions.headers['authorization']).toBe(`Bearer ${keyInfo.key}`);
        expect(callOptions.headers['x-request-id']).toBe('req-id-abc');
    });

    test('sets content-length from transformed body length', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(200);
        setupHttpsMock(proxyReq, proxyRes);

        const body = Buffer.from(JSON.stringify({ model: 'test', messages: ['hello'] }));
        const keyInfo = getKeyInfo();

        const result = await rh._makeProxyRequest(
            createMockReq(), createMockRes(), body, keyInfo,
            'req-5', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        const callOptions = https.request.mock.calls[0][0];
        expect(callOptions.headers['content-length']).toBe(body.length);
    });

    // -- Connection options --

    test('uses agent: false when useFreshConnection=true', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(200);
        setupHttpsMock(proxyReq, proxyRes);

        const keyInfo = getKeyInfo();

        const result = await rh._makeProxyRequest(
            createMockReq(), createMockRes(), Buffer.from('{}'), keyInfo,
            'req-fresh', null, Date.now(), 0,
            false, null, true, createTraceAttempt()
        );

        const callOptions = https.request.mock.calls[0][0];
        expect(callOptions.agent).toBe(false);
    });

    // -- Response status paths --

    test('200: resolves {success: true}, calls res.writeHead(200, ...)', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(200, { 'content-type': 'application/json' });
        setupHttpsMock(proxyReq, proxyRes);

        const mockRes = createMockRes();
        const keyInfo = getKeyInfo();

        const result = await rh._makeProxyRequest(
            createMockReq(), mockRes, Buffer.from('{}'), keyInfo,
            'req-200', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        expect(result.success).toBe(true);
        expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    });

    test('429 on /v1/messages: resolves {success:false, errorType:rate_limited, shouldRetry:true}', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(429, { 'retry-after': '5' });
        setupHttpsMock(proxyReq, proxyRes);

        // Need to mock pool-level tracking on keyManager
        km.recordPoolRateLimitHit = jest.fn().mockReturnValue({ pool429Count: 1, cooldownMs: 500 });
        km.recordRateLimit = jest.fn().mockReturnValue({});
        km.getPoolCooldownRemainingMs = jest.fn().mockReturnValue(0);

        const mockRes = createMockRes();
        const keyInfo = getKeyInfo();

        const result = await rh._makeProxyRequest(
            createMockReq({ url: '/v1/messages' }), mockRes, Buffer.from('{}'), keyInfo,
            'req-429', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        expect(result.success).toBe(false);
        expect(result.errorType).toBe('rate_limited');
        expect(result.shouldRetry).toBe(true);
        // Response should NOT be written to client (retry path)
        expect(mockRes.writeHead).not.toHaveBeenCalled();
    });

    test('429 on /api/event_logging: resolves {passedThrough:true}, calls res.writeHead(429, ...)', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(429, { 'content-type': 'application/json' });
        setupHttpsMock(proxyReq, proxyRes);

        km.recordPoolRateLimitHit = jest.fn().mockReturnValue({ pool429Count: 1, cooldownMs: 500 });
        km.recordRateLimit = jest.fn().mockReturnValue({});
        km.getPoolCooldownRemainingMs = jest.fn().mockReturnValue(0);

        const mockRes = createMockRes();
        const keyInfo = getKeyInfo();

        // For non-LLM route, the 429 is passed through — need to wait for proxyRes 'end'
        const resultPromise = rh._makeProxyRequest(
            createMockReq({ url: '/api/event_logging' }), mockRes, Buffer.from('{}'), keyInfo,
            'req-429-telem', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        // Emit end event to trigger the passthrough completion
        process.nextTick(() => proxyRes.emit('end'));

        const result = await resultPromise;

        expect(result.success).toBe(false);
        expect(result.passedThrough).toBe(true);
        expect(mockRes.writeHead).toHaveBeenCalledWith(429, expect.any(Object));
    });

    test('401: resolves {errorType: auth_error, shouldExcludeKey: true}', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(401);
        setupHttpsMock(proxyReq, proxyRes);

        km.recordFailure = jest.fn().mockReturnValue({});

        const keyInfo = getKeyInfo();

        const result = await rh._makeProxyRequest(
            createMockReq(), createMockRes(), Buffer.from('{}'), keyInfo,
            'req-401', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        expect(result.success).toBe(false);
        expect(result.errorType).toBe('auth_error');
        expect(result.shouldExcludeKey).toBe(true);
    });

    test('500: resolves {errorType: server_error, shouldExcludeKey: true}', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(500);
        setupHttpsMock(proxyReq, proxyRes);

        km.recordFailure = jest.fn().mockReturnValue({});

        const keyInfo = getKeyInfo();

        const result = await rh._makeProxyRequest(
            createMockReq(), createMockRes(), Buffer.from('{}'), keyInfo,
            'req-500', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        expect(result.success).toBe(false);
        expect(result.errorType).toBe('server_error');
        expect(result.shouldExcludeKey).toBe(true);
    });

    // -- Error events --

    test('timeout: resolves {errorType: timeout, isTimeout: true}', async () => {
        const proxyReq = createMockProxyReq();
        // Don't send proxyRes — trigger timeout instead
        https.request.mockImplementation((options, callback) => {
            process.nextTick(() => proxyReq.emit('timeout'));
            return proxyReq;
        });

        km.recordFailure = jest.fn().mockReturnValue({});

        const keyInfo = getKeyInfo();

        const result = await rh._makeProxyRequest(
            createMockReq(), createMockRes(), Buffer.from('{}'), keyInfo,
            'req-timeout', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        expect(result.success).toBe(false);
        expect(result.errorType).toBe('timeout');
        expect(result.error.isTimeout).toBe(true);
    });

    test('socket timeout enforcement: overrides Keep-Alive timeout on reused sockets', async () => {
        const proxyReq = createMockProxyReq();
        const mockSocket = {
            timeout: 5000, // Simulates Keep-Alive: timeout=5 from upstream
            setTimeout: jest.fn(function(ms) { this.timeout = ms; }),
            _httpMessage: proxyReq
        };

        https.request.mockImplementation((options, callback) => {
            // Emit socket event to trigger our timeout enforcement handler
            process.nextTick(() => {
                proxyReq.emit('socket', mockSocket);
                // After socket handler runs, verify timeout was corrected
                // Then trigger a normal response to complete the request
                const proxyRes = createMockProxyRes(200);
                callback(proxyRes);
            });
            return proxyReq;
        });

        const keyInfo = getKeyInfo();

        await rh._makeProxyRequest(
            createMockReq(), createMockRes(), Buffer.from('{}'), keyInfo,
            'req-socket-fix', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        // Socket.setTimeout should have been called with the adaptive timeout
        // (not the upstream's Keep-Alive timeout of 5000ms)
        expect(mockSocket.setTimeout).toHaveBeenCalled();
        const calledWith = mockSocket.setTimeout.mock.calls[0][0];
        expect(calledWith).toBeGreaterThanOrEqual(45000); // minMs from adaptive config
    });

    test('socket timeout enforcement: skips override when timeout already matches', async () => {
        const proxyReq = createMockProxyReq();
        // Calculate expected timeout for a fresh key (no samples → initialMs=90000)
        const expectedTimeout = 90000;
        const mockSocket = {
            timeout: expectedTimeout, // Already correct
            setTimeout: jest.fn(),
            _httpMessage: proxyReq
        };

        https.request.mockImplementation((options, callback) => {
            process.nextTick(() => {
                proxyReq.emit('socket', mockSocket);
                const proxyRes = createMockProxyRes(200);
                callback(proxyRes);
            });
            return proxyReq;
        });

        const keyInfo = getKeyInfo();

        await rh._makeProxyRequest(
            createMockReq(), createMockRes(), Buffer.from('{}'), keyInfo,
            'req-socket-match', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        // Socket.setTimeout should NOT have been called since timeout already matches
        expect(mockSocket.setTimeout).not.toHaveBeenCalled();
    });

    test('error ECONNRESET: resolves {errorType: socket_hangup}', async () => {
        const proxyReq = createMockProxyReq();
        https.request.mockImplementation((options, callback) => {
            process.nextTick(() => {
                const err = new Error('socket hang up');
                err.code = 'ECONNRESET';
                proxyReq.emit('error', err);
            });
            return proxyReq;
        });

        km.recordSocketHangup = jest.fn().mockReturnValue({});

        const keyInfo = getKeyInfo();

        const result = await rh._makeProxyRequest(
            createMockReq(), createMockRes(), Buffer.from('{}'), keyInfo,
            'req-reset', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        expect(result.success).toBe(false);
        expect(result.errorType).toBe('socket_hangup');
    });

    test('socket_hangup includes mappedModel so attemptedModels can exclude it on retry', async () => {
        // BUG FIX TEST: Socket hangup complete() was missing mappedModel in result.
        // Without mappedModel, the retry loop can't add the failed model to attemptedModels,
        // causing retries to pick the same model that just hung up.
        const proxyReq = createMockProxyReq();
        https.request.mockImplementation((options, callback) => {
            process.nextTick(() => {
                const err = new Error('socket hang up');
                err.code = 'ECONNRESET';
                proxyReq.emit('error', err);
            });
            return proxyReq;
        });

        km.recordSocketHangup = jest.fn().mockReturnValue({});

        // Set up model router so _transformRequestBody maps to a known model
        rh.modelRouter = {
            selectModel: jest.fn().mockResolvedValue({
                model: 'glm-4.7',
                source: 'pool',
                tier: 'heavy',
                reason: 'test'
            }),
            config: { logDecisions: false },
            acquireModel: jest.fn(),
            releaseModel: jest.fn()
        };

        const keyInfo = getKeyInfo();
        const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-6', messages: [] }));

        const result = await rh._makeProxyRequest(
            createMockReq(), createMockRes(), body, keyInfo,
            'req-hangup-model', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        expect(result.success).toBe(false);
        expect(result.errorType).toBe('socket_hangup');
        // CRITICAL: mappedModel must be present so retry loop can add it to attemptedModels
        expect(result.mappedModel).toBe('glm-4.7');
    });

    test('timeout includes mappedModel so attemptedModels can exclude it on retry', async () => {
        // Same bug as socket_hangup — timeout complete() also missing mappedModel
        const proxyReq = createMockProxyReq();
        https.request.mockImplementation((options, callback) => {
            // Emit timeout event on next tick to simulate socket timeout
            process.nextTick(() => proxyReq.emit('timeout'));
            return proxyReq;
        });

        // Set up model router
        rh.modelRouter = {
            selectModel: jest.fn().mockResolvedValue({
                model: 'glm-4.5',
                source: 'pool',
                tier: 'heavy',
                reason: 'test'
            }),
            config: { logDecisions: false },
            acquireModel: jest.fn(),
            releaseModel: jest.fn()
        };

        const keyInfo = getKeyInfo();
        const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-6', messages: [] }));

        const result = await rh._makeProxyRequest(
            createMockReq(), createMockRes(), body, keyInfo,
            'req-timeout-model', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        expect(result.success).toBe(false);
        expect(result.errorType).toBe('timeout');
        // CRITICAL: mappedModel must be present
        expect(result.mappedModel).toBe('glm-4.5');
    });

    test('proxyReq close before completion: resolves {errorType: aborted}', async () => {
        const proxyReq = createMockProxyReq();
        https.request.mockImplementation((options, callback) => {
            process.nextTick(() => proxyReq.emit('close'));
            return proxyReq;
        });

        const keyInfo = getKeyInfo();

        const result = await rh._makeProxyRequest(
            createMockReq(), createMockRes(), Buffer.from('{}'), keyInfo,
            'req-close', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        expect(result.success).toBe(false);
        expect(result.errorType).toBe('aborted');
    });

    // -- Early abort --

    test('clientDisconnected=true: destroys proxyReq immediately', async () => {
        const proxyReq = createMockProxyReq();
        https.request.mockImplementation((options, callback) => {
            return proxyReq;
        });

        const keyInfo = getKeyInfo();

        const result = await rh._makeProxyRequest(
            createMockReq(), createMockRes(), Buffer.from('{}'), keyInfo,
            'req-disc', null, Date.now(), 0,
            true, // clientDisconnected = true
            null, false, createTraceAttempt()
        );

        expect(proxyReq.destroy).toHaveBeenCalled();
        expect(result.success).toBe(false);
    });

    // -- Pool slot leak tests --

    test('model_at_capacity releases pool slot to prevent slot leak', async () => {
        // BUG FIX TEST: When isModelAtCapacity triggers, _makeProxyRequest does an early
        // return BEFORE the Promise/complete() wrapper. The pool slot acquired in
        // _selectFromPool() was never released via releaseModel(), causing a permanent
        // slot leak that cascades into more model_at_capacity rejections.
        // Note: pool-routed requests now skip the KM gate entirely, so this test uses
        // a non-pool source to verify the slot release behavior for failover routes.
        rh.modelRouter = {
            selectModel: jest.fn().mockResolvedValue({
                model: 'glm-4.7',
                source: 'failover',
                tier: 'heavy',
                reason: 'test',
                committed: true  // Committed decision → slot was acquired
            }),
            config: { logDecisions: false },
            acquireModel: jest.fn(),
            releaseModel: jest.fn()
        };

        // Make KeyManager say model is at capacity
        km.isModelAtCapacity = jest.fn().mockReturnValue(true);
        km.getModelInFlight = jest.fn().mockReturnValue(3);

        const keyInfo = getKeyInfo();
        const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-6', messages: [] }));

        const result = await rh._makeProxyRequest(
            createMockReq(), createMockRes(), body, keyInfo,
            'req-slot-leak', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        expect(result.success).toBe(false);
        expect(result.errorType).toBe('model_at_capacity');

        // CRITICAL: Pool slot MUST be released for committed decisions
        expect(rh.modelRouter.releaseModel).toHaveBeenCalledWith('glm-4.7');
    });

    // -- Dual concurrency gate fix tests --

    test('pool-routed requests go through uniform capacity gate (unified pipeline)', async () => {
        // UNIFIED PIPELINE: Router owns slot acquisition via commitDecision().
        // KM capacity gate applies uniformly to all requests (no pool bypass).
        rh.modelRouter = {
            selectModel: jest.fn().mockResolvedValue({
                model: 'glm-4.7',
                source: 'pool',  // Pool-routed
                tier: 'heavy',
                reason: 'test',
                committed: true
            }),
            config: { logDecisions: false },
            acquireModel: jest.fn(),
            releaseModel: jest.fn()
        };

        // KM says model is at capacity — should now block pool routes too
        km.isModelAtCapacity = jest.fn().mockReturnValue(true);
        km.getModelInFlight = jest.fn().mockReturnValue(3);

        const keyInfo = getKeyInfo();
        const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-6', messages: [] }));

        const result = await rh._makeProxyRequest(
            createMockReq(), createMockRes(), body, keyInfo,
            'req-pool-km-gate', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        // Should be blocked by KM gate (uniform enforcement)
        expect(result.success).toBe(false);
        expect(result.errorType).toBe('model_at_capacity');
        expect(km.isModelAtCapacity).toHaveBeenCalledWith('glm-4.7');
    });

    test('non-pool-routed requests still check isModelAtCapacity gate', async () => {
        // Failover/direct routes don't have pool gating, so KM gate is still needed
        rh.modelRouter = {
            selectModel: jest.fn().mockResolvedValue({
                model: 'glm-4.7',
                source: 'failover',  // NOT pool-routed
                tier: 'heavy',
                reason: 'test'
            }),
            config: { logDecisions: false },
            acquireModel: jest.fn(),
            releaseModel: jest.fn()
        };

        km.isModelAtCapacity = jest.fn().mockReturnValue(true);
        km.getModelInFlight = jest.fn().mockReturnValue(3);

        const keyInfo = getKeyInfo();
        const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-6', messages: [] }));

        const result = await rh._makeProxyRequest(
            createMockReq(), createMockRes(), body, keyInfo,
            'req-failover-km', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        // Should be blocked by KM gate
        expect(result.success).toBe(false);
        expect(result.errorType).toBe('model_at_capacity');
        expect(km.isModelAtCapacity).toHaveBeenCalledWith('glm-4.7');
    });

    test('model_at_capacity records error in statsAggregator', async () => {
        // model_at_capacity events were invisible in stats — never called recordError().
        // This caused the 425 blocked attempts to be untracked.
        rh.modelRouter = {
            selectModel: jest.fn().mockResolvedValue({
                model: 'glm-4.7',
                source: 'failover',  // Non-pool so KM gate is active
                tier: 'heavy',
                reason: 'test'
            }),
            config: { logDecisions: false },
            acquireModel: jest.fn(),
            releaseModel: jest.fn()
        };

        km.isModelAtCapacity = jest.fn().mockReturnValue(true);
        km.getModelInFlight = jest.fn().mockReturnValue(3);
        rh.statsAggregator = { recordError: jest.fn(), recordAdaptiveTimeout: jest.fn() };

        const keyInfo = getKeyInfo();
        const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-6', messages: [] }));

        await rh._makeProxyRequest(
            createMockReq(), createMockRes(), body, keyInfo,
            'req-mac-stats', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        // model_at_capacity MUST be recorded in stats
        expect(rh.statsAggregator.recordError).toHaveBeenCalledWith('model_at_capacity');
    });

    test('context_overflow pre-flight returns non-retryable error and releases key (no slot release)', async () => {
        // When selectModel detects context overflow, it returns committed=false
        // (no slot was acquired). The pre-flight check should NOT release model slot.
        rh.modelRouter = {
            selectModel: jest.fn().mockResolvedValue({
                model: 'glm-5',
                source: 'pool',
                tier: 'heavy',
                reason: 'test',
                committed: false,  // Not committed — no slot acquired
                contextOverflow: {
                    estimatedTokens: 220000,
                    modelContextLength: 128000,
                    overflowBy: 92000
                }
            }),
            config: { logDecisions: false },
            acquireModel: jest.fn(),
            releaseModel: jest.fn()
        };

        km.isModelAtCapacity = jest.fn().mockReturnValue(false);
        const releaseKeySpy = jest.spyOn(km, 'releaseKey');
        const acquireModelSlotSpy = jest.spyOn(km, 'acquireModelSlot');
        rh.statsAggregator = { recordError: jest.fn(), recordAdaptiveTimeout: jest.fn() };

        const keyInfo = getKeyInfo();
        const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-6', messages: [] }));

        const result = await rh._makeProxyRequest(
            createMockReq(), createMockRes(), body, keyInfo,
            'req-context-overflow', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        expect(result.success).toBe(false);
        expect(result.errorType).toBe('context_overflow');
        expect(result.shouldRetry).toBe(false);
        expect(result.shouldExcludeKey).toBe(false);
        expect(result.mappedModel).toBe('glm-5');
        expect(rh.statsAggregator.recordError).toHaveBeenCalledWith('context_overflow');
        expect(releaseKeySpy).toHaveBeenCalledWith(keyInfo);
        // CRITICAL: No slot release because decision was NOT committed (no slot acquired)
        expect(rh.modelRouter.releaseModel).not.toHaveBeenCalled();
        expect(acquireModelSlotSpy).not.toHaveBeenCalled();
        expect(https.request).not.toHaveBeenCalled();
    });

    test('context_overflow with committed=true decision still releases model slot', async () => {
        // Edge case: if somehow a committed decision has contextOverflow,
        // the slot WAS acquired and MUST be released.
        rh.modelRouter = {
            selectModel: jest.fn().mockResolvedValue({
                model: 'glm-5',
                source: 'pool',
                tier: 'heavy',
                reason: 'test',
                committed: true,
                contextOverflow: {
                    estimatedTokens: 220000,
                    modelContextLength: 128000,
                    overflowBy: 92000
                }
            }),
            config: { logDecisions: false },
            acquireModel: jest.fn(),
            releaseModel: jest.fn()
        };

        km.isModelAtCapacity = jest.fn().mockReturnValue(false);
        rh.statsAggregator = { recordError: jest.fn(), recordAdaptiveTimeout: jest.fn() };

        const keyInfo = getKeyInfo();
        const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-6', messages: [] }));

        const result = await rh._makeProxyRequest(
            createMockReq(), createMockRes(), body, keyInfo,
            'req-context-overflow-committed', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        expect(result.success).toBe(false);
        expect(result.errorType).toBe('context_overflow');
        // Committed decision: slot WAS acquired, so release it
        expect(rh.modelRouter.releaseModel).toHaveBeenCalledWith('glm-5');
    });

    test('contextOverflow + model_at_capacity yields 400 context_overflow (precedence)', async () => {
        // When BOTH conditions are true, context_overflow must win because
        // retrying an oversized request is pointless regardless of capacity.
        rh.modelRouter = {
            selectModel: jest.fn().mockResolvedValue({
                model: 'glm-5',
                source: 'pool',
                tier: 'heavy',
                reason: 'test',
                committed: false,  // Overflow → uncommitted
                contextOverflow: {
                    estimatedTokens: 220000,
                    modelContextLength: 128000,
                    overflowBy: 92000
                }
            }),
            config: { logDecisions: false },
            acquireModel: jest.fn(),
            releaseModel: jest.fn()
        };

        // Model is ALSO at capacity — should not matter
        km.isModelAtCapacity = jest.fn().mockReturnValue(true);
        km.getModelInFlight = jest.fn().mockReturnValue(5);
        rh.statsAggregator = { recordError: jest.fn(), recordAdaptiveTimeout: jest.fn() };

        const keyInfo = getKeyInfo();
        const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-6', messages: [] }));

        const result = await rh._makeProxyRequest(
            createMockReq(), createMockRes(), body, keyInfo,
            'req-overflow-plus-capacity', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        // Context overflow takes precedence — deterministic 400, no retry
        expect(result.success).toBe(false);
        expect(result.errorType).toBe('context_overflow');
        expect(result.shouldRetry).toBe(false);

        // model_at_capacity gate should NOT have fired
        expect(rh.statsAggregator.recordError).toHaveBeenCalledWith('context_overflow');
        expect(rh.statsAggregator.recordError).not.toHaveBeenCalledWith('model_at_capacity');

        // No slot release — decision was uncommitted
        expect(rh.modelRouter.releaseModel).not.toHaveBeenCalled();
        expect(https.request).not.toHaveBeenCalled();
    });

    test('model_at_capacity with uncommitted decision does not release model slot', async () => {
        // Edge case: if somehow an uncommitted decision reaches the capacity gate
        // (shouldn't happen with overflow precedence, but defense-in-depth).
        rh.modelRouter = {
            selectModel: jest.fn().mockResolvedValue({
                model: 'glm-5',
                source: 'failover',
                tier: 'heavy',
                reason: 'test',
                committed: false  // Uncommitted — no slot acquired
            }),
            config: { logDecisions: false },
            acquireModel: jest.fn(),
            releaseModel: jest.fn()
        };

        km.isModelAtCapacity = jest.fn().mockReturnValue(true);
        km.getModelInFlight = jest.fn().mockReturnValue(5);

        const keyInfo = getKeyInfo();
        const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-6', messages: [] }));

        const result = await rh._makeProxyRequest(
            createMockReq(), createMockRes(), body, keyInfo,
            'req-mac-uncommitted', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        expect(result.success).toBe(false);
        expect(result.errorType).toBe('model_at_capacity');
        // No slot was acquired, so no slot should be released
        expect(rh.modelRouter.releaseModel).not.toHaveBeenCalled();
    });
});

// ============================================================================
// 1e. _proxyWithRetries (high-value cases)
// ============================================================================

describe('_proxyWithRetries', () => {
    let rh, km;

    beforeEach(() => {
        https.request.mockReset();
        const setup = createHandler({
            config: {
                maxRetries: 2,
                requestTimeout: 5000,
                maxTotalConcurrency: 10,
                poolCooldown: {
                    sleepThresholdMs: 250,
                    retryJitterMs: 50,
                    maxCooldownMs: 5000
                }
            }
        });
        rh = setup.rh;
        km = setup.km;
    });

    afterEach(() => {
        rh.destroy();
    });

    function createTrace() {
        return new RequestTrace({
            requestId: 'test-trace',
            method: 'POST',
            path: '/v1/messages'
        });
    }

    test('first-attempt success: no retries, records clientRequestSuccess', async () => {
        jest.spyOn(rh, '_makeProxyRequest').mockResolvedValueOnce({
            success: true,
            mappedModel: 'glm-4'
        });

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-success', null, Date.now(), trace
        );

        expect(rh._makeProxyRequest).toHaveBeenCalledTimes(1);
        // res.writeHead should NOT have been called by retry loop (handled by _makeProxyRequest)
    });

    test('server_error then success: retries once, records retrySuccess', async () => {
        jest.spyOn(rh, '_makeProxyRequest')
            .mockResolvedValueOnce({
                success: false,
                error: new Error('Server error: 500'),
                errorType: 'server_error',
                shouldExcludeKey: true
            })
            .mockResolvedValueOnce({
                success: true,
                mappedModel: 'glm-4'
            });

        // Mock statsAggregator to verify retry tracking
        rh.statsAggregator = {
            recordClientRequestStart: jest.fn(),
            recordClientRequestSuccess: jest.fn(),
            recordClientRequestFailure: jest.fn(),
            recordRetry: jest.fn(),
            recordRetrySuccess: jest.fn()
        };

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-retry', null, Date.now(), trace
        );

        expect(rh._makeProxyRequest).toHaveBeenCalledTimes(2);
        expect(rh.statsAggregator.recordRetrySuccess).toHaveBeenCalled();
    });

    test('non-retryable error (tls_error): breaks immediately, returns 502', async () => {
        jest.spyOn(rh, '_makeProxyRequest').mockResolvedValueOnce({
            success: false,
            error: new Error('TLS handshake failed'),
            errorType: 'tls_error',
            shouldExcludeKey: true
        });

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-tls', null, Date.now(), trace
        );

        // Should break immediately — only 1 call
        expect(rh._makeProxyRequest).toHaveBeenCalledTimes(1);
        // Should send 502 to client
        expect(mockRes.writeHead).toHaveBeenCalledWith(502, expect.any(Object));
    });

    test('non-retryable context_overflow returns 400 Anthropic-style invalid_request_error', async () => {
        jest.spyOn(rh, '_makeProxyRequest').mockResolvedValueOnce({
            success: false,
            error: new Error('Request exceeds model context window'),
            errorType: 'context_overflow',
            shouldExcludeKey: false,
            shouldRetry: false,
            mappedModel: 'glm-5'
        });

        rh.statsAggregator = {
            recordClientRequestStart: jest.fn(),
            recordClientRequestSuccess: jest.fn(),
            recordClientRequestFailure: jest.fn(),
            recordRetry: jest.fn(),
            recordRetrySuccess: jest.fn()
        };

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-context-overflow-400', null, Date.now(), trace
        );

        expect(rh._makeProxyRequest).toHaveBeenCalledTimes(1);
        expect(mockRes.writeHead).toHaveBeenCalledWith(400, expect.objectContaining({
            'x-proxy-error': 'context_overflow'
        }));
        // No retry-after header — overflow is not transient
        const headers = mockRes.writeHead.mock.calls[0][1];
        expect(headers['retry-after']).toBeUndefined();
        const body = JSON.parse(mockRes.end.mock.calls[0][0]);
        expect(body.type).toBe('error');
        expect(body.error.type).toBe('invalid_request_error');
        expect(body.error.message).toContain('context window');
        // No retryAfter in body either
        expect(body.retryAfter).toBeUndefined();
        expect(body.requestId).toBe('req-context-overflow-400');
        expect(rh.statsAggregator.recordRetry).not.toHaveBeenCalled();
        expect(rh.statsAggregator.recordClientRequestFailure).toHaveBeenCalledTimes(1);
    });

    test('all retries exhausted: returns 502 with error details', async () => {
        // Use shouldExcludeKey: false to avoid running out of keys before retries exhaust
        jest.spyOn(rh, '_makeProxyRequest')
            .mockResolvedValue({
                success: false,
                error: new Error('Server error: 500'),
                errorType: 'server_error',
                shouldExcludeKey: false
            });

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-exhaust', null, Date.now(), trace
        );

        // maxRetries=2 → attempts 0, 1, 2 = 3 calls
        expect(rh._makeProxyRequest).toHaveBeenCalledTimes(3);
        expect(mockRes.writeHead).toHaveBeenCalledWith(502, expect.any(Object));

        // Verify error body
        const endBody = JSON.parse(mockRes.end.mock.calls[0][0]);
        expect(endBody.errorType).toBe('server_error');
        expect(endBody.requestId).toBe('req-exhaust');
    });

    test('pool cooldown > threshold on attempt 0 LLM route: returns local 429', async () => {
        // Mock pool cooldown active
        km.getPoolCooldownRemainingMs = jest.fn().mockReturnValue(1000);

        // Should not even attempt _makeProxyRequest
        jest.spyOn(rh, '_makeProxyRequest');

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq({ url: '/v1/messages' }), mockRes, Buffer.from('{}'),
            'req-pool', null, Date.now(), trace
        );

        // Should return local 429 without making any proxy request
        expect(rh._makeProxyRequest).not.toHaveBeenCalled();
        expect(mockRes.writeHead).toHaveBeenCalledWith(429, expect.objectContaining({
            'x-rate-limit-scope': 'pool'
        }));
    });

    test('aborted error type: exits loop immediately, records failure', async () => {
        jest.spyOn(rh, '_makeProxyRequest').mockResolvedValueOnce({
            success: false,
            error: new Error('Request aborted'),
            errorType: 'aborted'
        });

        rh.statsAggregator = {
            recordClientRequestStart: jest.fn(),
            recordClientRequestSuccess: jest.fn(),
            recordClientRequestFailure: jest.fn()
        };

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-abort', null, Date.now(), trace
        );

        expect(rh._makeProxyRequest).toHaveBeenCalledTimes(1);
        expect(rh.statsAggregator.recordClientRequestFailure).toHaveBeenCalled();
        // Should NOT send error response (client already disconnected)
        expect(mockRes.writeHead).not.toHaveBeenCalled();
    });
});

// ============================================================================
// 1f. Trace API delegation tests
// ============================================================================

describe('Trace API wrappers', () => {
    let rh;

    beforeEach(() => {
        const setup = createHandler();
        rh = setup.rh;
    });

    afterEach(() => {
        rh.destroy();
    });

    test('getTrace delegates to traceStore.get then getByRequestId', () => {
        // Store a trace first
        const trace = new RequestTrace({
            requestId: 'req-abc',
            method: 'POST',
            path: '/v1/messages'
        });
        trace.complete(true, 'success');
        rh.traceStore.store(trace);

        // Should find by requestId
        const found = rh.getTrace('req-abc');
        expect(found).toBeTruthy();
        expect(found.requestId).toBe('req-abc');
    });

    test('getRecentTraces delegates to traceStore.getRecent with count', () => {
        // Store some traces
        for (let i = 0; i < 5; i++) {
            const trace = new RequestTrace({
                requestId: `req-${i}`,
                method: 'POST',
                path: '/v1/messages'
            });
            trace.complete(true, 'success');
            rh.traceStore.store(trace);
        }

        const recent = rh.getRecentTraces(3);
        expect(recent.length).toBe(3);
    });

    test('getTraceStore returns the traceStore instance', () => {
        const store = rh.getTraceStore();
        expect(store).toBeInstanceOf(TraceStore);
    });
});
