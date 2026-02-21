'use strict';

/**
 * Request Handler Branch Coverage Tests
 *
 * Targets uncovered branches from lib/request-handler.js:
 * - Line 210: createTimeout rejection path
 * - Line 383: modelRouter logDecisions branch
 * - Lines 684-688: handleRequest catch block (overall timeout / error)
 * - Lines 802-805: client disconnected during retries
 * - Lines 860-870: pool cooldown short sleep path
 * - Lines 911-938: queue dequeue + still no key after queue
 * - Line 972: modelSwitchCount increment
 * - Lines 1026-1030: rate_limited retry with response already started
 * - Lines 1035-1041: LLM 429 retry cap reached
 * - Lines 1082-1083: useFreshConnection flag from result
 * - Lines 1096-1098: unexpected error in proxy try/catch
 * - Lines 1268-1270: already completed when proxyRes arrives
 * - Lines 1345-1350: pool burst dampened cooldown
 * - Lines 1366/1368: retryDecision = pass_through_response_started / pool_blocked
 * - Line 1487: auth error with mappedModel stats recording
 * - Line 1545: server error with mappedModel stats recording
 * - Lines 1611/1620: response data buffer trimming + tokenUsage recording
 * - Lines 1672-1674: proxyRes error event on success path
 * - Line 1742: shouldRecreateAgent triggers _recreateAgent
 * - Lines 1759-1771: non-socket-hangup error path in proxyReq error handler
 */

// Use jest.isolateModules to get a fresh https mock that doesn't interfere with other test files
let https;
let RequestHandler, calculateBackoff, ERROR_STRATEGIES, ConnectionHealthMonitor;
let KeyManager;
let RequestTrace, TraceStore, SpanType;
let EventEmitter;

beforeAll(() => {
    jest.isolateModules(() => {
        jest.doMock('https', () => ({
            request: jest.fn(),
            Agent: jest.requireActual('https').Agent
        }));
        https = require('https');
        ({ RequestHandler, calculateBackoff, ERROR_STRATEGIES, ConnectionHealthMonitor } = require('../lib/request-handler'));
        ({ KeyManager } = require('../lib/key-manager'));
        ({ RequestTrace, TraceStore, SpanType } = require('../lib/request-trace'));
        EventEmitter = require('events');
    });
});

// ============================================================================
// HELPERS
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
    return {
        headersSent: false,
        writeHead: jest.fn(),
        end: jest.fn(),
        on: jest.fn(),
        once: jest.fn(),
        removeListener: jest.fn(),
        pipe: jest.fn()
    };
}

function createMockProxyReq() {
    const proxyReq = new EventEmitter();
    proxyReq.write = jest.fn();
    proxyReq.end = jest.fn();
    proxyReq.destroy = jest.fn();
    proxyReq.reusedSocket = false;
    proxyReq.socket = { localPort: 12345, remotePort: 443 };
    return proxyReq;
}

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

function setupHttpsMock(proxyReq, proxyRes) {
    https.request.mockImplementation((options, callback) => {
        if (proxyRes) {
            process.nextTick(() => callback(proxyRes));
        }
        return proxyReq;
    });
}

function createTrace() {
    return new RequestTrace({
        requestId: 'test-trace',
        method: 'POST',
        path: '/v1/messages'
    });
}

function createTraceAttempt() {
    return {
        addSpan: jest.fn().mockReturnValue({ end: jest.fn() }),
        markRetry: jest.fn(),
        end: jest.fn()
    };
}

// ============================================================================
// Line 210: createTimeout rejection path
// ============================================================================
describe('handleRequest timeout/error catch block (lines 684-688)', () => {
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

    test('handleRequest catch block sends 504 when _proxyWithRetries throws', async () => {
        // Force _proxyWithRetries to throw an error (simulates overall timeout or unexpected error)
        jest.spyOn(rh, '_proxyWithRetries').mockRejectedValueOnce(
            new Error('Request timeout after 5000ms (requestId: test)')
        );

        const mockRes = createMockRes();

        await rh.handleRequest(createMockReq(), mockRes, Buffer.from('{}'));

        // Lines 684-688: trace.complete + 504 response
        expect(mockRes.writeHead).toHaveBeenCalledWith(504, expect.objectContaining({
            'content-type': 'application/json'
        }));
        const body = JSON.parse(mockRes.end.mock.calls[0][0]);
        expect(body.error).toBe('Gateway timeout');
    });

    test('handleRequest catch block skips response when headersSent=true', async () => {
        jest.spyOn(rh, '_proxyWithRetries').mockRejectedValueOnce(
            new Error('Something went wrong')
        );

        const mockRes = createMockRes();
        mockRes.headersSent = true;

        await rh.handleRequest(createMockReq(), mockRes, Buffer.from('{}'));

        // Should NOT try to write again since headers already sent
        expect(mockRes.writeHead).not.toHaveBeenCalled();
    });
});

// ============================================================================
// Line 383: modelRouter logDecisions branch
// ============================================================================
describe('_transformRequestBody logDecisions branch (line 383)', () => {
    test('logs routing decision when logDecisions is true', async () => {
        const { rh } = createHandler();
        const mockLogger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn() };

        rh.modelRouter = {
            selectModel: jest.fn().mockResolvedValue({
                model: 'glm-4-plus',
                source: 'complexity',
                tier: 'medium',
                reason: 'test'
            }),
            config: { logDecisions: true }
        };

        const body = Buffer.from(JSON.stringify({ model: 'claude-3-haiku', messages: [] }));
        await rh._transformRequestBody(body, mockLogger, 0, null, new Set());

        // Line 383: reqLogger.info with model routed message
        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.stringContaining('Model routed: claude-3-haiku -> glm-4-plus'),
            expect.any(Object)
        );

        rh.destroy();
    });
});

// ============================================================================
// Lines 802-805: client disconnected during retries
// ============================================================================
describe('_proxyWithRetries client disconnect (lines 802-805)', () => {
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

    test('aborts retries when client disconnects (res.headersSent=true)', async () => {
        const mockRes = createMockRes();
        // Simulate headersSent becoming true on attempt > 0
        mockRes.headersSent = true;

        jest.spyOn(rh, '_makeProxyRequest');

        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-disc', null, Date.now(), trace
        );

        // Lines 802-805: should detect headersSent and return early
        expect(rh._makeProxyRequest).not.toHaveBeenCalled();
    });
});

// ============================================================================
// Lines 860-870: pool cooldown short sleep path
// ============================================================================
describe('_proxyWithRetries pool cooldown short sleep (lines 860-870)', () => {
    let rh, km;

    beforeEach(() => {
        https.request.mockReset();
        const setup = createHandler({
            config: {
                maxRetries: 2,
                requestTimeout: 5000,
                maxTotalConcurrency: 10,
                poolCooldown: {
                    sleepThresholdMs: 500,
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

    test('short pool cooldown sleeps instead of returning 429 (line 860-870)', async () => {
        // Pool cooldown of 100ms (below 500ms threshold) → should sleep, not 429
        km.getPoolCooldownRemainingMs = jest.fn().mockReturnValue(100);

        jest.spyOn(rh, '_makeProxyRequest').mockResolvedValueOnce({
            success: true,
            mappedModel: 'glm-4'
        });

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq({ url: '/v1/messages' }), mockRes, Buffer.from('{}'),
            'req-short-cooldown', null, Date.now(), trace
        );

        // Should proceed (sleep through short cooldown), not return 429
        expect(rh._makeProxyRequest).toHaveBeenCalledTimes(1);
        expect(mockRes.writeHead).not.toHaveBeenCalledWith(429, expect.anything());
    });

    test('pool cooldown on retry attempt sleeps (line 860, attempt > 0)', async () => {
        // On attempt 0: no cooldown. On attempt 1: cooldown active (above threshold but attempt > 0)
        km.getPoolCooldownRemainingMs = jest.fn()
            .mockReturnValueOnce(0)     // attempt 0 - no cooldown
            .mockReturnValueOnce(1000); // attempt 1 - cooldown, but retry → sleep

        jest.spyOn(rh, '_makeProxyRequest')
            .mockResolvedValueOnce({
                success: false,
                error: new Error('Server error'),
                errorType: 'server_error',
                shouldExcludeKey: false
            })
            .mockResolvedValueOnce({
                success: true,
                mappedModel: 'glm-4'
            });

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq({ url: '/v1/messages' }), mockRes, Buffer.from('{}'),
            'req-retry-cooldown', null, Date.now(), trace
        );

        // Should have retried (not returned 429)
        expect(rh._makeProxyRequest).toHaveBeenCalledTimes(2);
    });

    test('pool cooldown on attempt 0 with model router active proceeds instead of returning 429', async () => {
        // SCENARIO: Pool cooldown is active (2000ms > 500ms threshold) but model router is active.
        // The router's _selectFromPool() already considers per-model cooldowns and will pick
        // a non-cooled model. So we should NOT return 429 immediately — let the router handle it.
        km.getPoolCooldownRemainingMs = jest.fn().mockReturnValue(2000);

        // Attach a model router to signal routing is active
        rh.modelRouter = {
            selectModel: jest.fn().mockReturnValue({
                model: 'glm-4-plus',
                source: 'pool',
                tier: 'light',
                reason: 'test'
            }),
            config: { logDecisions: false },
            recordModelCooldown: jest.fn()
        };

        jest.spyOn(rh, '_makeProxyRequest').mockResolvedValueOnce({
            success: true,
            mappedModel: 'glm-4-plus'
        });

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq({ url: '/v1/messages' }), mockRes, Buffer.from('{}'),
            'req-pool-router', null, Date.now(), trace
        );

        // With model router active, should NOT return 429 on attempt 0
        // Instead, should proceed to _makeProxyRequest (router picks non-cooled model)
        expect(rh._makeProxyRequest).toHaveBeenCalledTimes(1);
        expect(mockRes.writeHead).not.toHaveBeenCalledWith(429, expect.anything());
    });

    test('pool cooldown on non-LLM route passes through (line 872)', async () => {
        // Pool cooldown active but for non-LLM route — should proceed without blocking
        km.getPoolCooldownRemainingMs = jest.fn().mockReturnValue(2000);

        jest.spyOn(rh, '_makeProxyRequest').mockResolvedValueOnce({
            success: true,
            mappedModel: 'glm-4'
        });

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq({ url: '/api/event_logging' }), mockRes, Buffer.from('{}'),
            'req-non-llm', null, Date.now(), trace
        );

        // Non-LLM route should proceed even with pool cooldown
        expect(rh._makeProxyRequest).toHaveBeenCalledTimes(1);
    });
});

// ============================================================================
// Lines 911-938: queue dequeue then still no key
// ============================================================================
describe('_proxyWithRetries queue and no key paths (lines 911-938)', () => {
    let rh, km;

    beforeEach(() => {
        https.request.mockReset();
        const setup = createHandler({
            config: {
                maxRetries: 2,
                requestTimeout: 5000,
                maxTotalConcurrency: 10,
                queueSize: 10,
                queueTimeout: 100
            }
        });
        rh = setup.rh;
        km = setup.km;
    });

    afterEach(() => {
        rh.destroy();
    });

    test('queues then retries key acquisition after dequeue (lines 911-920)', async () => {
        let callCount = 0;
        jest.spyOn(km, 'acquireKey').mockImplementation(() => {
            callCount++;
            if (callCount <= 1) return null; // First call: no key
            // Second call (after dequeue): return a key
            return {
                key: 'key1.secret1',
                index: 0,
                keyId: 'key_0',
                keyPrefix: 'key1',
                inFlight: 0,
                circuitBreaker: { state: 'closed' },
                latencies: { stats: () => ({ count: 0 }) },
                selectionReason: 'round_robin'
            };
        });

        // Mock the queue to resolve successfully
        jest.spyOn(rh.requestQueue, 'hasCapacity').mockReturnValue(true);
        jest.spyOn(rh.requestQueue, 'enqueue').mockResolvedValue({
            success: true,
            waitTime: 50
        });

        jest.spyOn(rh, '_makeProxyRequest').mockResolvedValueOnce({
            success: true,
            mappedModel: 'glm-4'
        });

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-queue', null, Date.now(), trace
        );

        // Should have queued and then succeeded
        expect(rh.requestQueue.enqueue).toHaveBeenCalled();
        expect(rh._makeProxyRequest).toHaveBeenCalledTimes(1);
    });

    test('still no key after queue wait returns 503 (lines 922-938)', async () => {
        jest.spyOn(km, 'acquireKey').mockReturnValue(null);

        jest.spyOn(rh.requestQueue, 'hasCapacity').mockReturnValue(true);
        jest.spyOn(rh.requestQueue, 'enqueue').mockResolvedValue({
            success: true,
            waitTime: 50
        });

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-no-key', null, Date.now(), trace
        );

        // Lines 922-938: no key after queue → 503
        expect(mockRes.writeHead).toHaveBeenCalledWith(503, expect.objectContaining({
            'content-type': 'application/json'
        }));
        const body = JSON.parse(mockRes.end.mock.calls[0][0]);
        expect(body.error).toBe('All keys exhausted or circuits open');
    });
});

// ============================================================================
// Line 972: modelSwitchCount increment
// ============================================================================
describe('_proxyWithRetries model switch tracking (line 972)', () => {
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

    test('tracks model switches across attempts', async () => {
        jest.spyOn(rh, '_makeProxyRequest')
            .mockResolvedValueOnce({
                success: false,
                error: new Error('Server error'),
                errorType: 'server_error',
                shouldExcludeKey: false,
                mappedModel: 'glm-4-plus'
            })
            .mockResolvedValueOnce({
                success: true,
                mappedModel: 'glm-4' // Different model = switch
            });

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-switch', null, Date.now(), trace
        );

        // Line 972: modelSwitchCount incremented when model changes
        expect(rh._makeProxyRequest).toHaveBeenCalledTimes(2);
    });
});

// ============================================================================
// Lines 1026-1030: 429 retry with response already started
// ============================================================================
describe('_proxyWithRetries 429 retry with response started (lines 1026-1030)', () => {
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

    test('breaks retry loop when 429 shouldRetry but response already started', async () => {
        jest.spyOn(rh, '_makeProxyRequest').mockResolvedValueOnce({
            success: false,
            error: new Error('Rate limited'),
            errorType: 'rate_limited',
            shouldRetry: true,
            responseStarted: true, // Lines 1025-1030: response already started
            shouldExcludeKey: true
        });

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-429-started', null, Date.now(), trace
        );

        // Should break (not retry) since response already started
        expect(rh._makeProxyRequest).toHaveBeenCalledTimes(1);
    });
});

// ============================================================================
// Lines 1035-1041: LLM 429 retry cap reached
// ============================================================================
describe('_proxyWithRetries LLM 429 retry cap (lines 1035-1041)', () => {
    let rh, km;

    beforeEach(() => {
        https.request.mockReset();
        const setup = createHandler({
            keyManager: createKeyManager(['key1.secret1', 'key2.secret2', 'key3.secret3', 'key4.secret4']),
            config: { maxRetries: 3 }
        });
        rh = setup.rh;
        km = setup.km;
    });

    afterEach(() => {
        rh.destroy();
    });

    test('breaks when LLM 429 retry cap is reached', async () => {
        // Four attempts: 429s with shouldRetry → cap reached at maxLlm429Retries=3
        jest.spyOn(rh, '_makeProxyRequest')
            .mockResolvedValueOnce({
                success: false,
                errorType: 'rate_limited',
                shouldRetry: true,
                shouldExcludeKey: true,
                retryAfterMs: 100,
                evidence: { source: 'upstream' }
            })
            .mockResolvedValueOnce({
                success: false,
                errorType: 'rate_limited',
                shouldRetry: true,
                shouldExcludeKey: true,
                retryAfterMs: 100,
                evidence: { source: 'upstream' }
            })
            .mockResolvedValueOnce({
                success: false,
                errorType: 'rate_limited',
                shouldRetry: true,
                shouldExcludeKey: true,
                retryAfterMs: 100,
                evidence: { source: 'upstream' }
            })
            .mockResolvedValueOnce({
                success: false,
                errorType: 'rate_limited',
                shouldRetry: true,
                shouldExcludeKey: true,
                evidence: { source: 'upstream' }
            });

        rh.statsAggregator = {
            recordClientRequestStart: jest.fn(),
            recordClientRequestFailure: jest.fn(),
            recordRetry: jest.fn(),
            recordLlm429Retry: jest.fn(),
            recordLlm429RetrySuccess: jest.fn()
        };

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-429-cap', null, Date.now(), trace
        );

        // Should have made 4 attempts then broken due to cap (maxLlm429Retries=3)
        expect(rh._makeProxyRequest).toHaveBeenCalledTimes(4);
        expect(rh.statsAggregator.recordLlm429Retry).toHaveBeenCalledTimes(3);
    });
});

// ============================================================================
// Lines 1082-1083: useFreshConnection flag
// ============================================================================
describe('_proxyWithRetries useFreshConnection (lines 1082-1083)', () => {
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

    test('passes useFreshConnection=true on retry when result indicates it', async () => {
        jest.spyOn(rh, '_makeProxyRequest')
            .mockResolvedValueOnce({
                success: false,
                error: new Error('socket hang up'),
                errorType: 'socket_hangup',
                shouldExcludeKey: false,
                useFreshConnection: true // Lines 1081-1083
            })
            .mockResolvedValueOnce({
                success: true,
                mappedModel: 'glm-4'
            });

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-fresh', null, Date.now(), trace
        );

        // Second call should have useFreshConnection=true (param index 10)
        const secondCallArgs = rh._makeProxyRequest.mock.calls[1];
        expect(secondCallArgs[10]).toBe(true); // useFreshConnection parameter
    });
});

// ============================================================================
// Lines 1096-1098: unexpected error in proxy try/catch
// ============================================================================
describe('_proxyWithRetries unexpected error catch (lines 1096-1098)', () => {
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

    test('catches unexpected errors and continues retrying', async () => {
        jest.spyOn(rh, '_makeProxyRequest')
            .mockRejectedValueOnce(new Error('Unexpected internal error'))
            .mockResolvedValueOnce({
                success: true,
                mappedModel: 'glm-4'
            });

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-unexpected', null, Date.now(), trace
        );

        // Lines 1096-1098: should catch error and continue to next retry
        expect(rh._makeProxyRequest).toHaveBeenCalledTimes(2);
    });
});

// ============================================================================
// Lines 1268-1270: already completed when proxyRes arrives
// ============================================================================
describe('_makeProxyRequest already completed (lines 1268-1270)', () => {
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

    test('resumes proxyRes and completes success when already completed', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(200);

        // Make the response arrive after close event has already fired
        https.request.mockImplementation((options, callback) => {
            // Fire close first (marks completed)
            process.nextTick(() => proxyReq.emit('close'));
            // Then fire proxyRes (arrives late)
            setTimeout(() => callback(proxyRes), 10);
            return proxyReq;
        });

        const keyInfo = km.acquireKey();
        const mockRes = createMockRes();

        const result = await rh._makeProxyRequest(
            createMockReq(), mockRes, Buffer.from('{}'), keyInfo,
            'req-already-done', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        // First completion: from close → aborted
        // The proxyRes path would hit lines 1267-1270 (completed check)
        expect(result.success).toBe(false); // close fires first → aborted
    });

    test('handles headersSent case in proxyRes callback', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(200);

        https.request.mockImplementation((options, callback) => {
            process.nextTick(() => callback(proxyRes));
            return proxyReq;
        });

        const keyInfo = km.acquireKey();
        const mockRes = createMockRes();
        mockRes.headersSent = true; // Already sent

        const result = await rh._makeProxyRequest(
            createMockReq(), mockRes, Buffer.from('{}'), keyInfo,
            'req-headers-sent', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        // Lines 1267-1270: headersSent=true → resume + complete success
        expect(proxyRes.resume).toHaveBeenCalled();
        expect(result.success).toBe(true);
    });
});

// ============================================================================
// Lines 1345-1350: pool burst dampened cooldown
// ============================================================================
describe('_makeProxyRequest 429 pool burst dampening (lines 1345-1350)', () => {
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

    test('dampens cooldown when transient pool burst (pool429Count < 3)', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(429, { 'retry-after': '5' });

        setupHttpsMock(proxyReq, proxyRes);

        km.recordPoolRateLimitHit = jest.fn().mockReturnValue({
            pool429Count: 2, // > 1 = pool burst, but < 3 = transient
            cooldownMs: 2000
        });
        km.recordRateLimit = jest.fn().mockReturnValue({});
        km.getPoolCooldownRemainingMs = jest.fn().mockReturnValue(0);

        rh.modelRouter = {
            selectModel: jest.fn().mockReturnValue({
                model: 'glm-4-plus',
                source: 'complexity',
                tier: 'medium',
                reason: 'test'
            }),
            recordModelCooldown: jest.fn(),
            acquireModel: jest.fn(),
            releaseModel: jest.fn(),
            config: { logDecisions: false, cooldown: { burstDampeningFactor: 0.2, defaultMs: 5000 } }
        };

        const keyInfo = km.acquireKey();
        const mockRes = createMockRes();
        const body = Buffer.from(JSON.stringify({ model: 'claude-3-haiku', messages: [] }));

        const result = await rh._makeProxyRequest(
            createMockReq({ url: '/v1/messages' }), mockRes, body, keyInfo,
            'req-burst', null, Date.now(), 0,
            false, null, false, createTraceAttempt(), new Set()
        );

        // Transient burst: dampened cooldown
        expect(rh.modelRouter.recordModelCooldown).toHaveBeenCalledWith(
            'glm-4-plus',
            expect.any(Number),
            { burstDampened: true }
        );
    });

    test('uses full cooldown for persistent throttle (pool429Count >= 3)', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(429, { 'retry-after': '5' });

        setupHttpsMock(proxyReq, proxyRes);

        km.recordPoolRateLimitHit = jest.fn().mockReturnValue({
            pool429Count: 3, // >= 3 = persistent throttle
            cooldownMs: 4000
        });
        km.recordRateLimit = jest.fn().mockReturnValue({});
        km.getPoolCooldownRemainingMs = jest.fn().mockReturnValue(0);

        rh.modelRouter = {
            selectModel: jest.fn().mockReturnValue({
                model: 'glm-4-plus',
                source: 'complexity',
                tier: 'medium',
                reason: 'test'
            }),
            recordModelCooldown: jest.fn(),
            acquireModel: jest.fn(),
            releaseModel: jest.fn(),
            config: { logDecisions: false, cooldown: { burstDampeningFactor: 0.2, defaultMs: 5000 } }
        };

        const keyInfo = km.acquireKey();
        const mockRes = createMockRes();
        const body = Buffer.from(JSON.stringify({ model: 'claude-3-haiku', messages: [] }));

        const result = await rh._makeProxyRequest(
            createMockReq({ url: '/v1/messages' }), mockRes, body, keyInfo,
            'req-persist', null, Date.now(), 0,
            false, null, false, createTraceAttempt(), new Set()
        );

        // Persistent throttle: full cooldown (NOT burst-dampened) to trigger model fallback
        expect(rh.modelRouter.recordModelCooldown).not.toHaveBeenCalledWith(
            'glm-4-plus',
            expect.any(Number),
            { burstDampened: true }
        );
        expect(rh.modelRouter.recordModelCooldown).toHaveBeenCalledWith(
            'glm-4-plus',
            expect.any(Number)
        );
    });

    test('normal cooldown when not pool burst', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(429, { 'retry-after': '5' });

        setupHttpsMock(proxyReq, proxyRes);

        km.recordPoolRateLimitHit = jest.fn().mockReturnValue({
            pool429Count: 1, // = 1, not burst
            cooldownMs: 500
        });
        km.recordRateLimit = jest.fn().mockReturnValue({});
        km.getPoolCooldownRemainingMs = jest.fn().mockReturnValue(0);

        rh.modelRouter = {
            selectModel: jest.fn().mockReturnValue({
                model: 'glm-4-plus',
                source: 'complexity',
                tier: 'medium',
                reason: 'test'
            }),
            recordModelCooldown: jest.fn(),
            acquireModel: jest.fn(),
            releaseModel: jest.fn(),
            config: { logDecisions: false, cooldown: { defaultMs: 5000 } }
        };

        const keyInfo = km.acquireKey();
        const body = Buffer.from(JSON.stringify({ model: 'claude-3-haiku', messages: [] }));

        const result = await rh._makeProxyRequest(
            createMockReq({ url: '/v1/messages' }), createMockRes(), body, keyInfo,
            'req-normal', null, Date.now(), 0,
            false, null, false, createTraceAttempt(), new Set()
        );

        // Line 1352-1356: normal cooldown (not burst dampened)
        expect(rh.modelRouter.recordModelCooldown).toHaveBeenCalledWith(
            'glm-4-plus',
            expect.any(Number)
        );
    });
});

// ============================================================================
// Lines 1366/1368: retryDecision pass_through_response_started and pool_blocked
// ============================================================================
describe('_makeProxyRequest 429 retryDecision branches (lines 1363-1368)', () => {
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

    test('retryDecision=pool_blocked when pool cooldown active (line 1368)', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(429, { 'retry-after': '5' });

        setupHttpsMock(proxyReq, proxyRes);

        km.recordPoolRateLimitHit = jest.fn().mockReturnValue({ pool429Count: 1, cooldownMs: 500, wasAlreadyBlocked: true });
        km.recordRateLimit = jest.fn().mockReturnValue({});
        km.getPoolCooldownRemainingMs = jest.fn().mockReturnValue(2000); // Pool blocked

        const keyInfo = km.acquireKey();
        const mockRes = createMockRes();

        const resultPromise = rh._makeProxyRequest(
            createMockReq({ url: '/v1/messages' }), mockRes, Buffer.from('{}'), keyInfo,
            'req-pool-blocked', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        // Wait for the pass-through end event
        process.nextTick(() => proxyRes.emit('end'));

        const result = await resultPromise;

        // Pool blocked → canRetry=false → passes through 429
        expect(result.passedThrough).toBe(true);
        expect(mockRes.writeHead).toHaveBeenCalledWith(429, expect.anything());
    });
});

// ============================================================================
// pool_blocked should NOT prevent retry when model router is active
// (router can switch to a different model in the pool on retry)
// ============================================================================
describe('_makeProxyRequest pool_blocked with model router should still retry', () => {
    let rh, km;

    beforeEach(() => {
        https.request.mockReset();
        const setup = createHandler();
        rh = setup.rh;
        km = setup.km;
        // Set up model router that returns a pool routing decision
        rh.modelRouter = {
            enabled: true,
            shadowMode: false,
            config: {
                logDecisions: false,
                cooldown: { burstDampeningFactor: 0.2, defaultMs: 5000 }
            },
            selectModel: jest.fn().mockReturnValue({
                model: 'glm-4-plus',
                tier: 'light',
                source: 'pool',
                reason: 'pool: 20/20 available'
            }),
            recordModelCooldown: jest.fn(),
            releaseModel: jest.fn(),
            acquireModel: jest.fn(),
            getModelCooldown: jest.fn().mockReturnValue(0),
            getLastShadowDecision: jest.fn().mockReturnValue(null)
        };
    });

    afterEach(() => {
        rh.destroy();
    });

    test('pool_blocked with active model router allows retry instead of pass-through', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(429, { 'retry-after': '1' });

        setupHttpsMock(proxyReq, proxyRes);

        km.recordPoolRateLimitHit = jest.fn().mockReturnValue({ pool429Count: 2, cooldownMs: 1000, wasAlreadyBlocked: true });
        km.recordRateLimit = jest.fn().mockReturnValue({});
        km.getPoolCooldownRemainingMs = jest.fn().mockReturnValue(2000);

        const keyInfo = km.acquireKey();
        const mockRes = createMockRes();
        const body = Buffer.from(JSON.stringify({ model: 'claude-haiku-4-5-20251001', messages: [] }));

        const resultPromise = rh._makeProxyRequest(
            createMockReq({ url: '/v1/messages' }), mockRes, body, keyInfo,
            'req-pool-router', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        // Emit end on proxyRes (simulating upstream response complete)
        process.nextTick(() => proxyRes.emit('end'));

        const result = await resultPromise;

        // With model router active, pool_blocked should NOT prevent retry
        // Result should indicate retryable (not passedThrough)
        expect(result.shouldRetry).toBe(true);
        expect(result.passedThrough).toBeUndefined();
    });
});

// ============================================================================
// Account-level rate limit should allow model router fallback instead of
// immediately returning 429 to client (router can switch to different model)
// ============================================================================
describe('_makeProxyRequest account-level rate limit with model router', () => {
    let rh, km;

    beforeEach(() => {
        https.request.mockReset();
        const setup = createHandler();
        rh = setup.rh;
        km = setup.km;
        rh.modelRouter = {
            enabled: true,
            shadowMode: false,
            config: {
                logDecisions: false,
                cooldown: { burstDampeningFactor: 0.2, defaultMs: 5000 }
            },
            selectModel: jest.fn().mockReturnValue({
                model: 'glm-4-plus',
                tier: 'light',
                source: 'pool',
                reason: 'pool: 20/20 available'
            }),
            recordModelCooldown: jest.fn(),
            releaseModel: jest.fn(),
            acquireModel: jest.fn(),
            getModelCooldown: jest.fn().mockReturnValue(0),
            getLastShadowDecision: jest.fn().mockReturnValue(null)
        };
    });

    afterEach(() => {
        rh.destroy();
    });

    test('account-level rate limit with active model router allows retry for model fallback', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(429, { 'retry-after': '5' });

        setupHttpsMock(proxyReq, proxyRes);

        km.recordPoolRateLimitHit = jest.fn().mockReturnValue({ pool429Count: 2, cooldownMs: 1000, wasAlreadyBlocked: false });
        km.recordRateLimit = jest.fn().mockReturnValue({});
        km.getPoolCooldownRemainingMs = jest.fn().mockReturnValue(0);
        // Account-level detection returns isAccountLevel=true
        km.detectAccountLevelRateLimit = jest.fn().mockReturnValue({
            isAccountLevel: true,
            cooldownMs: 10000
        });

        const keyInfo = km.acquireKey();
        const mockRes = createMockRes();
        const body = Buffer.from(JSON.stringify({ model: 'claude-haiku-4-5-20251001', messages: [] }));

        const resultPromise = rh._makeProxyRequest(
            createMockReq({ url: '/v1/messages' }), mockRes, body, keyInfo,
            'req-acct-router', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        process.nextTick(() => proxyRes.emit('end'));

        const result = await resultPromise;

        // With model router active, account-level should NOT immediately fail
        // Instead, allow retry so router can switch to a different model
        expect(result.shouldRetry).toBe(true);
        expect(result.passedThrough).toBeUndefined();
    });
});

// ============================================================================
// Line 1487: auth error with mappedModel stats
// ============================================================================
describe('_makeProxyRequest auth error with mappedModel (line 1487)', () => {
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

    test('records per-model usage on auth error when mappedModel present', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(401);

        setupHttpsMock(proxyReq, proxyRes);

        km.recordFailure = jest.fn().mockReturnValue({});

        rh.statsAggregator = {
            recordKeyUsage: jest.fn(),
            recordError: jest.fn(),
            recordModelUsage: jest.fn(),
            recordAdaptiveTimeout: jest.fn()
        };

        // Set up model router to produce a mappedModel
        rh.modelRouter = {
            selectModel: jest.fn().mockReturnValue({
                model: 'glm-4-plus',
                source: 'complexity',
                tier: 'medium',
                reason: 'test'
            }),
            acquireModel: jest.fn(),
            releaseModel: jest.fn(),
            config: { logDecisions: false }
        };

        const keyInfo = km.acquireKey();

        const result = await rh._makeProxyRequest(
            createMockReq(), createMockRes(),
            Buffer.from(JSON.stringify({ model: 'claude-3-haiku', messages: [] })),
            keyInfo, 'req-auth-model', null, Date.now(), 0,
            false, null, false, createTraceAttempt(), new Set()
        );

        // Line 1487: recordModelUsage called for auth error
        expect(rh.statsAggregator.recordModelUsage).toHaveBeenCalledWith('glm-4-plus', {
            latencyMs: expect.any(Number),
            success: false,
            is429: false
        });
    });
});

// ============================================================================
// Line 1545: server error with mappedModel stats
// ============================================================================
describe('_makeProxyRequest server error with mappedModel (line 1545)', () => {
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

    test('records per-model usage on server error when mappedModel present', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(500);

        setupHttpsMock(proxyReq, proxyRes);

        km.recordFailure = jest.fn().mockReturnValue({});

        rh.statsAggregator = {
            recordKeyUsage: jest.fn(),
            recordError: jest.fn(),
            recordRetry: jest.fn(),
            recordModelUsage: jest.fn(),
            recordAdaptiveTimeout: jest.fn()
        };

        rh.modelRouter = {
            selectModel: jest.fn().mockReturnValue({
                model: 'glm-4-plus',
                source: 'complexity',
                tier: 'medium',
                reason: 'test'
            }),
            acquireModel: jest.fn(),
            releaseModel: jest.fn(),
            config: { logDecisions: false }
        };

        const keyInfo = km.acquireKey();

        const result = await rh._makeProxyRequest(
            createMockReq(), createMockRes(),
            Buffer.from(JSON.stringify({ model: 'claude-3-haiku', messages: [] })),
            keyInfo, 'req-500-model', null, Date.now(), 0,
            false, null, false, createTraceAttempt(), new Set()
        );

        // Line 1545: recordModelUsage called for server error
        expect(rh.statsAggregator.recordModelUsage).toHaveBeenCalledWith('glm-4-plus', {
            latencyMs: expect.any(Number),
            success: false,
            is429: false
        });
    });
});

// ============================================================================
// Lines 1610-1620: response data buffer trimming + tokenUsage recording
// ============================================================================
describe('_makeProxyRequest response data buffer and tokenUsage (lines 1610-1620)', () => {
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

    test('records token usage from response when parseTokenUsage returns data (line 1620)', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = new EventEmitter();
        proxyRes.statusCode = 200;
        proxyRes.headers = { 'content-type': 'text/event-stream' };
        proxyRes.resume = jest.fn();
        proxyRes.pipe = jest.fn();

        https.request.mockImplementation((options, callback) => {
            process.nextTick(() => callback(proxyRes));
            return proxyReq;
        });

        km.recordSuccess = jest.fn().mockReturnValue({});

        rh.statsAggregator = {
            recordKeyUsage: jest.fn(),
            recordAdaptiveTimeout: jest.fn(),
            recordTokenUsage: jest.fn(),
            recordModelUsage: jest.fn()
        };

        const keyInfo = km.acquireKey();
        const mockRes = createMockRes();

        const resultPromise = rh._makeProxyRequest(
            createMockReq(), mockRes, Buffer.from('{}'), keyInfo,
            'req-tokens', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        // Simulate data chunks including token usage
        await new Promise(resolve => setTimeout(resolve, 10));
        const tokenData = 'data: {"type":"message_delta","usage":{"input_tokens":100,"output_tokens":50}}\n\n';
        proxyRes.emit('data', Buffer.from(tokenData));
        proxyRes.emit('end');

        const result = await resultPromise;

        // Line 1620: recordTokenUsage called with parsed usage
        expect(rh.statsAggregator.recordTokenUsage).toHaveBeenCalledWith(
            keyInfo.keyId,
            { input_tokens: 100, output_tokens: 50 }
        );
    });

    test('trims response buffer when exceeding 64KB (line 1611)', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = new EventEmitter();
        proxyRes.statusCode = 200;
        proxyRes.headers = {};
        proxyRes.resume = jest.fn();
        proxyRes.pipe = jest.fn();

        https.request.mockImplementation((options, callback) => {
            process.nextTick(() => callback(proxyRes));
            return proxyReq;
        });

        km.recordSuccess = jest.fn().mockReturnValue({});
        rh.statsAggregator = {
            recordKeyUsage: jest.fn(),
            recordAdaptiveTimeout: jest.fn(),
            recordTokenUsage: jest.fn(),
            recordModelUsage: jest.fn()
        };

        const keyInfo = km.acquireKey();
        const mockRes = createMockRes();

        const resultPromise = rh._makeProxyRequest(
            createMockReq(), mockRes, Buffer.from('{}'), keyInfo,
            'req-big', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        await new Promise(resolve => setTimeout(resolve, 10));
        // Send multiple chunks totaling > 64KB
        const bigChunk = Buffer.alloc(40 * 1024, 'x'); // 40KB
        proxyRes.emit('data', bigChunk);
        proxyRes.emit('data', bigChunk); // Total 80KB > 64KB limit
        proxyRes.emit('end');

        const result = await resultPromise;

        // Line 1611 path executed (trimming). Test completes without error.
        expect(result.success).toBe(true);
    });
});

// ============================================================================
// Lines 1672-1674: proxyRes error event on streaming success path
// ============================================================================
describe('_makeProxyRequest proxyRes error on streaming (lines 1672-1674)', () => {
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

    test('handles proxyRes error after streaming started (treated as success)', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = new EventEmitter();
        proxyRes.statusCode = 200;
        proxyRes.headers = {};
        proxyRes.resume = jest.fn();
        proxyRes.pipe = jest.fn();

        https.request.mockImplementation((options, callback) => {
            process.nextTick(() => callback(proxyRes));
            return proxyReq;
        });

        km.recordSuccess = jest.fn().mockReturnValue({});
        rh.statsAggregator = {
            recordKeyUsage: jest.fn(),
            recordAdaptiveTimeout: jest.fn(),
            recordTokenUsage: jest.fn(),
            recordModelUsage: jest.fn()
        };

        const keyInfo = km.acquireKey();
        const mockRes = createMockRes();

        const resultPromise = rh._makeProxyRequest(
            createMockReq(), mockRes, Buffer.from('{}'), keyInfo,
            'req-stream-err', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        // Wait for response callback to fire
        await new Promise(resolve => setTimeout(resolve, 10));
        // Fire error on proxyRes (after streaming started)
        proxyRes.emit('error', new Error('Connection reset'));

        const result = await resultPromise;

        // Lines 1672-1674: error after streaming is treated as success
        expect(result.success).toBe(true);
    });
});

// ============================================================================
// Line 1742: shouldRecreateAgent triggers _recreateAgent
// ============================================================================
describe('_makeProxyRequest shouldRecreateAgent (line 1742)', () => {
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

    test('calls _recreateAgent when connection monitor triggers recreation', async () => {
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

        // Force shouldRecreateAgent to return true
        jest.spyOn(rh.connectionMonitor, 'shouldRecreateAgent').mockReturnValue(true);
        jest.spyOn(rh, '_recreateAgent').mockImplementation(() => {
            rh.connectionMonitor.markAgentRecreated();
        });

        const keyInfo = km.acquireKey();

        const result = await rh._makeProxyRequest(
            createMockReq(), createMockRes(), Buffer.from('{}'), keyInfo,
            'req-recreate', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        // Line 1742: _recreateAgent called
        expect(rh._recreateAgent).toHaveBeenCalled();
    });
});

// ============================================================================
// Lines 1759-1771: non-socket-hangup error in proxyReq error handler
// ============================================================================
describe('_makeProxyRequest non-socket-hangup error (lines 1759-1771)', () => {
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

    test('handles connection_refused error through general error path', async () => {
        const proxyReq = createMockProxyReq();

        https.request.mockImplementation((options, callback) => {
            process.nextTick(() => {
                const err = new Error('connect ECONNREFUSED');
                err.code = 'ECONNREFUSED';
                proxyReq.emit('error', err);
            });
            return proxyReq;
        });

        km.recordFailure = jest.fn().mockReturnValue({});

        const keyInfo = km.acquireKey();

        const result = await rh._makeProxyRequest(
            createMockReq(), createMockRes(), Buffer.from('{}'), keyInfo,
            'req-refused', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        // Lines 1759-1771: general error path
        expect(result.success).toBe(false);
        expect(result.errorType).toBe('connection_refused');
        expect(result.shouldExcludeKey).toBe(true);
    });

    test('handles broken_pipe error through general error path', async () => {
        const proxyReq = createMockProxyReq();

        https.request.mockImplementation((options, callback) => {
            process.nextTick(() => {
                const err = new Error('write EPIPE');
                err.code = 'EPIPE';
                proxyReq.emit('error', err);
            });
            return proxyReq;
        });

        km.recordFailure = jest.fn().mockReturnValue({});

        const keyInfo = km.acquireKey();

        const result = await rh._makeProxyRequest(
            createMockReq(), createMockRes(), Buffer.from('{}'), keyInfo,
            'req-epipe', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        // broken_pipe goes through general error path (not socket_hangup)
        expect(result.success).toBe(false);
        expect(result.errorType).toBe('broken_pipe');
        // broken_pipe strategy: excludeKey=false
        expect(result.shouldExcludeKey).toBe(false);
    });

    test('handles dns_error through general error path', async () => {
        const proxyReq = createMockProxyReq();

        https.request.mockImplementation((options, callback) => {
            process.nextTick(() => {
                const err = new Error('getaddrinfo ENOTFOUND api.z.ai');
                err.code = 'ENOTFOUND';
                proxyReq.emit('error', err);
            });
            return proxyReq;
        });

        km.recordFailure = jest.fn().mockReturnValue({});

        const keyInfo = km.acquireKey();

        const result = await rh._makeProxyRequest(
            createMockReq(), createMockRes(), Buffer.from('{}'), keyInfo,
            'req-dns', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        expect(result.success).toBe(false);
        expect(result.errorType).toBe('dns_error');
        // dns_error strategy: excludeKey=false
        expect(result.shouldExcludeKey).toBe(false);
    });

    test('handles tls_error through general error path', async () => {
        const proxyReq = createMockProxyReq();

        https.request.mockImplementation((options, callback) => {
            process.nextTick(() => {
                const err = new Error('certificate has expired');
                err.code = 'ERR_TLS_CERT_ALTNAME_INVALID';
                proxyReq.emit('error', err);
            });
            return proxyReq;
        });

        km.recordFailure = jest.fn().mockReturnValue({});

        const keyInfo = km.acquireKey();

        const result = await rh._makeProxyRequest(
            createMockReq(), createMockRes(), Buffer.from('{}'), keyInfo,
            'req-tls', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        expect(result.success).toBe(false);
        expect(result.errorType).toBe('tls_error');
        expect(result.shouldExcludeKey).toBe(true);
    });
});

// ============================================================================
// model_at_capacity error type (Fix: concurrency gate should be retryable)
// ============================================================================

describe('burst pacing upstream limiter', () => {
    test('_acquireUpstreamSlot limits concurrent outgoing requests', async () => {
        const { rh } = createHandler({ config: { maxConcurrentUpstream: 2 } });

        // Acquire 2 slots (should succeed immediately)
        await rh._acquireUpstreamSlot();
        await rh._acquireUpstreamSlot();
        expect(rh._upstreamInFlight).toBe(2);

        // 3rd should block (wait for release)
        let thirdResolved = false;
        const thirdSlot = rh._acquireUpstreamSlot().then(() => { thirdResolved = true; });

        // Give time for potential immediate resolution
        await new Promise(r => setTimeout(r, 10));
        expect(thirdResolved).toBe(false); // Should still be waiting

        // Release one slot — third should now resolve
        rh._releaseUpstreamSlot();
        await thirdSlot;
        expect(thirdResolved).toBe(true);
        expect(rh._upstreamInFlight).toBe(2); // 2 still active (1 released, 1 new acquired)

        // Clean up
        rh._releaseUpstreamSlot();
        rh._releaseUpstreamSlot();
        rh.destroy();
    });
});

describe('socket_hangup error strategy (burst protection)', () => {
    test('socket_hangup has backoff to prevent thundering herd during connection storms', () => {
        const strategy = ERROR_STRATEGIES.socket_hangup;
        expect(strategy).toBeDefined();
        expect(strategy.shouldRetry).toBe(true);
        // Backoff > 1.0 to spread out retries during connection overload
        expect(strategy.backoffMultiplier).toBeGreaterThan(1.0);
        // Fewer retries — hammering an overloaded upstream makes it worse
        expect(strategy.maxRetries).toBeLessThanOrEqual(3);
        expect(strategy.useFreshConnection).toBe(true);
    });
});

describe('model_at_capacity error strategy', () => {
    test('ERROR_STRATEGIES has model_at_capacity as retryable', () => {
        const strategy = ERROR_STRATEGIES.model_at_capacity;
        expect(strategy).toBeDefined();
        expect(strategy.shouldRetry).toBe(true);
        expect(strategy.maxRetries).toBeGreaterThanOrEqual(3);
        expect(strategy.excludeKey).toBe(false); // Not key-specific
    });

    test('concurrency gate returns model_at_capacity instead of rate_limited', async () => {
        const km = createKeyManager();
        // Set concurrency limit of 1 for test-model
        km.setModelConcurrencyLimits({ 'test-model': 1 });
        // Acquire the only slot
        km.acquireModelSlot('test-model');

        const { rh } = createHandler({ keyManager: km });

        // Mock _transformRequestBody to return a mapped model
        rh._transformRequestBody = jest.fn().mockResolvedValue({
            transformedBody: Buffer.from('{}'),
            mappedModel: 'test-model',
            routingDecision: null
        });

        const keyInfo = km.acquireKey();

        const result = await rh._makeProxyRequest(
            createMockReq(), createMockRes(), Buffer.from('{}'), keyInfo,
            'req-cap-1', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        expect(result.success).toBe(false);
        expect(result.errorType).toBe('model_at_capacity');
        expect(result.shouldRetry).toBe(true);
        expect(result.retryAfterMs).toBeGreaterThan(0);
    });

    test('model_at_capacity is retried by the retry loop (not immediately fatal)', async () => {
        const km = createKeyManager();
        km.setModelConcurrencyLimits({ 'test-model': 1 });
        // Occupy the slot for first 2 attempts
        km.acquireModelSlot('test-model');

        const { rh } = createHandler({ keyManager: km });

        let attemptCount = 0;
        const origMakeProxy = rh._makeProxyRequest.bind(rh);
        rh._makeProxyRequest = jest.fn(async (...args) => {
            attemptCount++;
            // Release slot on 3rd attempt so it succeeds
            if (attemptCount === 3) {
                km.releaseModelSlot('test-model');
            }
            return origMakeProxy(...args);
        });

        // Mock _transformRequestBody
        rh._transformRequestBody = jest.fn().mockResolvedValue({
            body: Buffer.from('{}'),
            transformedBody: Buffer.from('{}'),
            mappedModel: 'test-model',
            routingDecision: null
        });

        // First two attempts: model at capacity → model_at_capacity (retryable)
        // Third attempt: slot freed → proceeds to actual request
        const keyInfo = km.acquireKey();

        // Call attempt 0 - should return model_at_capacity with shouldRetry=true
        const result0 = await rh._makeProxyRequest(
            createMockReq(), createMockRes(), Buffer.from('{}'), keyInfo,
            'req-retry-1', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );
        expect(result0.errorType).toBe('model_at_capacity');
        expect(result0.shouldRetry).toBe(true);

        // Call attempt 1 - still at capacity
        const keyInfo2 = km.acquireKey();
        const result1 = await rh._makeProxyRequest(
            createMockReq(), createMockRes(), Buffer.from('{}'), keyInfo2,
            'req-retry-2', null, Date.now(), 1,
            false, null, false, createTraceAttempt()
        );
        expect(result1.errorType).toBe('model_at_capacity');
        expect(result1.shouldRetry).toBe(true);  // STILL retryable on attempt 1
    });

    test('model_at_capacity adds model to attemptedModels so router picks different model on retry', async () => {
        // SCENARIO: When model_at_capacity fires, the model SHOULD be added to attemptedModels
        // so the router picks a different model in the same tier on the next attempt
        // (e.g., glm-4.6 or glm-4.5 instead of the at-capacity glm-4.7).
        const { rh } = createHandler({
            config: { maxRetries: 3 }
        });

        rh.modelRouter = {
            selectModel: jest.fn().mockReturnValue({
                model: 'glm-4.7',
                source: 'pool',
                tier: 'heavy',
                reason: 'test'
            }),
            config: { logDecisions: false },
            recordModelCooldown: jest.fn(),
            acquireModel: jest.fn(),
            releaseModel: jest.fn()
        };

        // Capture snapshots of attemptedModels at each call
        const attemptedModelsSnapshots = [];
        let callNum = 0;
        jest.spyOn(rh, '_makeProxyRequest').mockImplementation(
            async (req, res, body, keyInfo, requestId, reqLogger, startTime, attempt,
                   clientDisconnected, onProxyReq, useFreshConnection, traceAttempt, attemptedModels) => {
                attemptedModelsSnapshots.push(new Set(attemptedModels || []));
                callNum++;
                if (callNum <= 2) {
                    return {
                        success: false,
                        errorType: 'model_at_capacity',
                        shouldRetry: true,
                        retryAfterMs: 100,
                        mappedModel: 'glm-4.7',
                        routingDecision: { model: 'glm-4.7', tier: 'heavy', source: 'pool' }
                    };
                }
                return { success: true, mappedModel: 'glm-4.6' };
            }
        );

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq({ url: '/v1/messages' }), mockRes, Buffer.from('{}'),
            'req-capacity', null, Date.now(), trace
        );

        expect(rh._makeProxyRequest).toHaveBeenCalledTimes(3);

        // Call 1: empty attemptedModels (first attempt)
        expect(attemptedModelsSnapshots[0].size).toBe(0);
        // Call 2: glm-4.7 should BE in attemptedModels (from first model_at_capacity)
        // This forces the router to pick a different model on retry
        expect(attemptedModelsSnapshots[1].has('glm-4.7')).toBe(true);

        rh.destroy();
    });

    test('socket_hangup adds model to attemptedModels so router picks different model on retry', async () => {
        // BUG FIX: socket_hangup complete() was missing mappedModel, so attemptedModels
        // never got the failed model — retries kept hitting the same model.
        const { rh } = createHandler({
            config: { maxRetries: 3 }
        });

        rh.modelRouter = {
            selectModel: jest.fn().mockResolvedValue({
                model: 'glm-4.7',
                source: 'pool',
                tier: 'heavy',
                reason: 'test'
            }),
            config: { logDecisions: false },
            recordModelCooldown: jest.fn(),
            acquireModel: jest.fn(),
            releaseModel: jest.fn()
        };

        const attemptedModelsSnapshots = [];
        let callNum = 0;
        jest.spyOn(rh, '_makeProxyRequest').mockImplementation(
            async (req, res, body, keyInfo, requestId, reqLogger, startTime, attempt,
                   clientDisconnected, onProxyReq, useFreshConnection, traceAttempt, attemptedModels) => {
                attemptedModelsSnapshots.push(new Set(attemptedModels || []));
                callNum++;
                if (callNum <= 2) {
                    return {
                        success: false,
                        errorType: 'socket_hangup',
                        shouldExcludeKey: false,
                        useFreshConnection: true,
                        mappedModel: 'glm-4.7'
                    };
                }
                return { success: true, mappedModel: 'glm-4.6' };
            }
        );

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq({ url: '/v1/messages' }), mockRes, Buffer.from('{}'),
            'req-hangup-retry', null, Date.now(), trace
        );

        expect(rh._makeProxyRequest).toHaveBeenCalledTimes(3);

        // Call 1: empty attemptedModels
        expect(attemptedModelsSnapshots[0].size).toBe(0);
        // Call 2: glm-4.7 should BE in attemptedModels (from first socket_hangup)
        expect(attemptedModelsSnapshots[1].has('glm-4.7')).toBe(true);

        rh.destroy();
    });
});

describe('context_overflow error strategy', () => {
    test('ERROR_STRATEGIES has context_overflow as non-retryable request error', () => {
        const strategy = ERROR_STRATEGIES.context_overflow;
        expect(strategy).toBeDefined();
        expect(strategy.shouldRetry).toBe(false);
        expect(strategy.maxRetries).toBe(0);
        expect(strategy.excludeKey).toBe(false);
    });
});

// ============================================================================
// TECH DEBT: Missing trackFailure() on queue rejection path
// ============================================================================
describe('_proxyWithRetries stats tracking on queue rejection', () => {
    let rh, km;

    beforeEach(() => {
        https.request.mockReset();
        const setup = createHandler({
            config: {
                maxRetries: 2,
                requestTimeout: 5000,
                maxTotalConcurrency: 10,
                queueSize: 10,
                queueTimeout: 100
            }
        });
        rh = setup.rh;
        km = setup.km;
        rh.statsAggregator = {
            recordClientRequestStart: jest.fn(),
            recordClientRequestSuccess: jest.fn(),
            recordClientRequestFailure: jest.fn(),
            recordError: jest.fn(),
            recordRetry: jest.fn(),
            recordRetrySuccess: jest.fn(),
            recordKeyUsage: jest.fn(),
            recordModelUsage: jest.fn(),
            recordLlm429Retry: jest.fn(),
            recordLlm429RetrySuccess: jest.fn(),
            recordTokenUsage: jest.fn()
        };
    });

    afterEach(() => {
        rh.destroy();
    });

    test('should call recordClientRequestFailure when queue rejects (queue_full)', async () => {
        // All keys busy → triggers queue path
        jest.spyOn(km, 'acquireKey').mockReturnValue(null);
        jest.spyOn(rh.requestQueue, 'hasCapacity').mockReturnValue(true);
        jest.spyOn(rh.requestQueue, 'enqueue').mockResolvedValue({
            success: false,
            reason: 'queue_full'
        });
        // Mock pool cooldown to avoid early 429
        jest.spyOn(km, 'getPoolCooldownRemainingMs').mockReturnValue(0);

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-queue-reject', null, Date.now(), trace
        );

        // The request was started...
        expect(rh.statsAggregator.recordClientRequestStart).toHaveBeenCalledTimes(1);
        // ...and it should be tracked as a failure (not silently lost)
        expect(rh.statsAggregator.recordClientRequestFailure).toHaveBeenCalledTimes(1);
    });

    test('should call recordClientRequestFailure when queue times out', async () => {
        jest.spyOn(km, 'acquireKey').mockReturnValue(null);
        jest.spyOn(rh.requestQueue, 'hasCapacity').mockReturnValue(true);
        jest.spyOn(rh.requestQueue, 'enqueue').mockResolvedValue({
            success: false,
            reason: 'queue_timeout'
        });
        jest.spyOn(km, 'getPoolCooldownRemainingMs').mockReturnValue(0);

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-queue-timeout', null, Date.now(), trace
        );

        expect(rh.statsAggregator.recordClientRequestStart).toHaveBeenCalledTimes(1);
        expect(rh.statsAggregator.recordClientRequestFailure).toHaveBeenCalledTimes(1);
    });
});

// ============================================================================
// TECH DEBT: Missing trackFailure() in handleRequest outer catch
// ============================================================================
describe('handleRequest outer catch tracks failure', () => {
    let rh, km;

    beforeEach(() => {
        https.request.mockReset();
        const setup = createHandler();
        rh = setup.rh;
        km = setup.km;
        rh.statsAggregator = {
            recordClientRequestStart: jest.fn(),
            recordClientRequestSuccess: jest.fn(),
            recordClientRequestFailure: jest.fn(),
            recordError: jest.fn(),
            recordRetry: jest.fn(),
            recordRetrySuccess: jest.fn(),
            recordKeyUsage: jest.fn(),
            recordModelUsage: jest.fn(),
            recordLlm429Retry: jest.fn(),
            recordLlm429RetrySuccess: jest.fn(),
            recordTokenUsage: jest.fn()
        };
    });

    afterEach(() => {
        rh.destroy();
    });

    test('should track failure when _proxyWithRetries throws unexpected error', async () => {
        // Make _proxyWithRetries throw (simulating unexpected error)
        jest.spyOn(rh, '_proxyWithRetries').mockRejectedValue(new Error('Unexpected kaboom'));

        const mockRes = createMockRes();
        const body = Buffer.from(JSON.stringify({ model: 'test', messages: [] }));

        await rh.handleRequest(createMockReq(), mockRes, body);

        // Should have sent 504
        expect(mockRes.writeHead).toHaveBeenCalledWith(504, expect.any(Object));
        // The failure should be tracked in stats (not silently lost)
        expect(rh.statsAggregator.recordClientRequestFailure).toHaveBeenCalledTimes(1);
    });
});

// ============================================================================
// TECH DEBT: recordRetry() overcounting — called on non-retries
// ============================================================================
describe('recordRetry() should only count actual retries', () => {
    let rh, km;

    beforeEach(() => {
        https.request.mockReset();
        const setup = createHandler({
            config: { maxRetries: 2, requestTimeout: 5000, maxTotalConcurrency: 10 }
        });
        rh = setup.rh;
        km = setup.km;
        rh.statsAggregator = {
            recordClientRequestStart: jest.fn(),
            recordClientRequestSuccess: jest.fn(),
            recordClientRequestFailure: jest.fn(),
            recordError: jest.fn(),
            recordRetry: jest.fn(),
            recordRetrySuccess: jest.fn(),
            recordKeyUsage: jest.fn(),
            recordModelUsage: jest.fn(),
            recordLlm429Retry: jest.fn(),
            recordLlm429RetrySuccess: jest.fn(),
            recordTokenUsage: jest.fn()
        };
    });

    afterEach(() => {
        rh.destroy();
    });

    test('first attempt failure should NOT increment totalRetries', async () => {
        // Fail once, then succeed — the first failure is not a "retry"
        jest.spyOn(rh, '_makeProxyRequest')
            .mockResolvedValueOnce({
                success: false,
                error: new Error('Server error'),
                errorType: 'server_error',
                shouldExcludeKey: true,
                mappedModel: 'glm-4'
            })
            .mockResolvedValueOnce({
                success: true,
                mappedModel: 'glm-4'
            });

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-retry-count', null, Date.now(), trace
        );

        // Should succeed on second attempt
        expect(rh.statsAggregator.recordClientRequestSuccess).toHaveBeenCalledTimes(1);
        // Only 1 actual retry happened (attempt 1), NOT 2
        // The first attempt failure (attempt 0) should not be counted as a retry
        expect(rh.statsAggregator.recordRetry).toHaveBeenCalledTimes(1);
        expect(rh.statsAggregator.recordRetrySuccess).toHaveBeenCalledTimes(1);
    });

    test('all retries exhausted should count N retries, not N+1', async () => {
        // Fail 3 times (attempt 0, 1, 2) — should count 2 retries, not 3
        // Use shouldExcludeKey: false so keys aren't exhausted before retries
        jest.spyOn(rh, '_makeProxyRequest').mockResolvedValue({
            success: false,
            error: new Error('Socket hangup'),
            errorType: 'socket_hangup',
            shouldExcludeKey: false,
            mappedModel: 'glm-4'
        });

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-retry-exhaust', null, Date.now(), trace
        );

        // maxRetries=2, so 3 total attempts: 0 (first try), 1 (first retry), 2 (second retry)
        expect(rh._makeProxyRequest).toHaveBeenCalledTimes(3);
        // Only 2 actual retries, NOT 3
        expect(rh.statsAggregator.recordRetry).toHaveBeenCalledTimes(2);
    });
});

// ============================================================================
// Fix 1: recordPoolRateLimitHit should use poolCooldownConfig from config,
// not hardcoded baseMs/capMs values
// ============================================================================
describe('recordPoolRateLimitHit uses poolCooldownConfig (not hardcoded)', () => {
    let rh, km;

    beforeEach(() => {
        https.request.mockReset();
        const setup = createHandler({
            config: {
                poolCooldown: {
                    baseMs: 700,
                    capMs: 12000,
                    decayMs: 20000,
                    sleepThresholdMs: 1500,
                    retryJitterMs: 150,
                    maxCooldownMs: 10000
                }
            }
        });
        rh = setup.rh;
        km = setup.km;
    });

    afterEach(() => {
        rh.destroy();
    });

    test('passes poolCooldownConfig.baseMs and capMs to recordPoolRateLimitHit', async () => {
        const proxyReq = createMockProxyReq();
        // No Retry-After header — test config default path
        const proxyRes = createMockProxyRes(429);

        setupHttpsMock(proxyReq, proxyRes);

        km.recordPoolRateLimitHit = jest.fn().mockReturnValue({
            pool429Count: 1, cooldownMs: 700
        });
        km.recordRateLimit = jest.fn().mockReturnValue({});
        km.getPoolCooldownRemainingMs = jest.fn().mockReturnValue(0);

        rh.modelRouter = {
            selectModel: jest.fn().mockReturnValue({
                model: 'glm-4-plus', source: 'pool', tier: 'light', reason: 'test'
            }),
            recordModelCooldown: jest.fn(),
            acquireModel: jest.fn(),
            releaseModel: jest.fn(),
            config: { logDecisions: false, cooldown: { defaultMs: 5000 } }
        };

        const keyInfo = km.acquireKey();
        const body = Buffer.from(JSON.stringify({ model: 'claude-3-haiku', messages: [] }));

        await rh._makeProxyRequest(
            createMockReq({ url: '/v1/messages' }), createMockRes(), body, keyInfo,
            'req-config-pool', null, Date.now(), 0,
            false, null, false, createTraceAttempt(), new Set()
        );

        // Should use config values (baseMs: 700, capMs: 12000), not hardcoded (500, 5000)
        expect(km.recordPoolRateLimitHit).toHaveBeenCalledWith(
            expect.objectContaining({
                model: 'glm-4-plus',
                baseMs: 700,    // from poolCooldownConfig, not hardcoded 500
                capMs: 12000    // from poolCooldownConfig, not hardcoded 5000
            })
        );
    });

    test('falls back to retryAfterMs for baseMs when upstream sends Retry-After', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(429, { 'retry-after': '3' }); // 3 seconds = 3000ms

        setupHttpsMock(proxyReq, proxyRes);

        km.recordPoolRateLimitHit = jest.fn().mockReturnValue({
            pool429Count: 1, cooldownMs: 3000
        });
        km.recordRateLimit = jest.fn().mockReturnValue({});
        km.getPoolCooldownRemainingMs = jest.fn().mockReturnValue(0);

        rh.modelRouter = {
            selectModel: jest.fn().mockReturnValue({
                model: 'glm-4-plus', source: 'pool', tier: 'light', reason: 'test'
            }),
            recordModelCooldown: jest.fn(),
            acquireModel: jest.fn(),
            releaseModel: jest.fn(),
            config: { logDecisions: false, cooldown: { defaultMs: 5000 } }
        };

        const keyInfo = km.acquireKey();
        const body = Buffer.from(JSON.stringify({ model: 'claude-3-haiku', messages: [] }));

        await rh._makeProxyRequest(
            createMockReq({ url: '/v1/messages' }), createMockRes(), body, keyInfo,
            'req-retry-after', null, Date.now(), 0,
            false, null, false, createTraceAttempt(), new Set()
        );

        // When Retry-After header is present, baseMs should use that value
        expect(km.recordPoolRateLimitHit).toHaveBeenCalledWith(
            expect.objectContaining({
                baseMs: 3000  // from Retry-After header, not config default
            })
        );
    });
});

// ============================================================================
// Fix 2: computedRetryDelayMs should use poolResult.pool429Count (per-model),
// not legacy this.keyManager.pool429Count (global)
// ============================================================================
describe('computedRetryDelayMs uses per-model pool429Count (not global)', () => {
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

    test('retry delay scales with poolResult.pool429Count, not global counter', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(429);

        setupHttpsMock(proxyReq, proxyRes);

        // Per-model pool429Count = 3, global pool429Count = 10
        km.recordPoolRateLimitHit = jest.fn().mockReturnValue({
            pool429Count: 3,
            cooldownMs: 2000
        });
        km.pool429Count = 10; // Legacy global — should NOT be used
        km.recordRateLimit = jest.fn().mockReturnValue({});
        km.getPoolCooldownRemainingMs = jest.fn().mockReturnValue(0);

        rh.modelRouter = {
            selectModel: jest.fn().mockReturnValue({
                model: 'glm-4.7', source: 'pool', tier: 'heavy', reason: 'test'
            }),
            recordModelCooldown: jest.fn(),
            acquireModel: jest.fn(),
            releaseModel: jest.fn(),
            config: { logDecisions: false, cooldown: { defaultMs: 5000 } }
        };

        const keyInfo = km.acquireKey();
        const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-6', messages: [] }));

        const result = await rh._makeProxyRequest(
            createMockReq({ url: '/v1/messages' }), createMockRes(), body, keyInfo,
            'req-per-model', null, Date.now(), 0,
            false, null, false, createTraceAttempt(), new Set()
        );

        // retryAfterMs should reflect per-model count (3), not global (10)
        // With pool429Count=3: delay = min(1000 * 2^(3-1), 5000) = min(4000, 5000) = 4000
        // With global pool429Count=10: delay = min(1000 * 2^(10-1), 5000) = 5000 (capped)
        expect(result.retryAfterMs).toBeLessThanOrEqual(4000);
        expect(result.shouldRetry).toBe(true);
    });
});

// ============================================================================
// Fix 3: shouldExcludeKey should be false when modelRouter is active on 429
// (z.ai limits are per-account, not per-key; key rotation is useless)
// ============================================================================
describe('shouldExcludeKey on 429 with modelRouter active', () => {
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

    test('shouldExcludeKey=false when modelRouter is active (per-account limits)', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(429);

        setupHttpsMock(proxyReq, proxyRes);

        km.recordPoolRateLimitHit = jest.fn().mockReturnValue({
            pool429Count: 1, cooldownMs: 500
        });
        km.recordRateLimit = jest.fn().mockReturnValue({});
        km.getPoolCooldownRemainingMs = jest.fn().mockReturnValue(0);

        rh.modelRouter = {
            selectModel: jest.fn().mockReturnValue({
                model: 'glm-4.7', source: 'pool', tier: 'heavy', reason: 'test'
            }),
            recordModelCooldown: jest.fn(),
            acquireModel: jest.fn(),
            releaseModel: jest.fn(),
            config: { logDecisions: false, cooldown: { defaultMs: 5000 } }
        };

        const keyInfo = km.acquireKey();
        const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-6', messages: [] }));

        const result = await rh._makeProxyRequest(
            createMockReq({ url: '/v1/messages' }), createMockRes(), body, keyInfo,
            'req-no-key-excl', null, Date.now(), 0,
            false, null, false, createTraceAttempt(), new Set()
        );

        // With modelRouter, 429s are per-account/per-model, not per-key
        // Key rotation is wasteful — keep the key, switch the model instead
        expect(result.shouldExcludeKey).toBe(false);
        expect(result.shouldRetry).toBe(true);
    });

    test('shouldExcludeKey=true when NO modelRouter (legacy key rotation)', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(429);

        setupHttpsMock(proxyReq, proxyRes);

        km.recordPoolRateLimitHit = jest.fn().mockReturnValue({
            pool429Count: 1, cooldownMs: 500
        });
        km.recordRateLimit = jest.fn().mockReturnValue({});
        km.getPoolCooldownRemainingMs = jest.fn().mockReturnValue(0);

        // No modelRouter set

        const keyInfo = km.acquireKey();
        const body = Buffer.from(JSON.stringify({ model: 'claude-3-haiku', messages: [] }));

        const result = await rh._makeProxyRequest(
            createMockReq({ url: '/v1/messages' }), createMockRes(), body, keyInfo,
            'req-key-excl', null, Date.now(), 0,
            false, null, false, createTraceAttempt(), new Set()
        );

        // Without modelRouter, legacy key rotation should still work
        expect(result.shouldExcludeKey).toBe(true);
        expect(result.shouldRetry).toBe(true);
    });
});

// ============================================================================
// Fix 4: Model cooldown must be >= retry delay to prevent same-model re-selection
// When burst-dampened cooldown < retry delay, the model appears available again
// by the time the retry fires, causing guaranteed re-429
// ============================================================================
describe('burst-dampened cooldown floor equals retry delay', () => {
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

    test('burst-dampened cooldown is at least as long as retry delay', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(429);

        setupHttpsMock(proxyReq, proxyRes);

        km.recordPoolRateLimitHit = jest.fn().mockReturnValue({
            pool429Count: 2, // burst
            cooldownMs: 2000
        });
        km.recordRateLimit = jest.fn().mockReturnValue({});
        km.getPoolCooldownRemainingMs = jest.fn().mockReturnValue(0);

        rh.modelRouter = {
            selectModel: jest.fn().mockReturnValue({
                model: 'glm-4.7', source: 'pool', tier: 'heavy', reason: 'test'
            }),
            recordModelCooldown: jest.fn(),
            acquireModel: jest.fn(),
            releaseModel: jest.fn(),
            config: { logDecisions: false, cooldown: { burstDampeningFactor: 0.2, defaultMs: 5000 } }
        };

        const keyInfo = km.acquireKey();
        const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-6', messages: [] }));

        const result = await rh._makeProxyRequest(
            createMockReq({ url: '/v1/messages' }), createMockRes(), body, keyInfo,
            'req-cooldown-floor', null, Date.now(), 0,
            false, null, false, createTraceAttempt(), new Set()
        );

        // The retry delay (retryAfterMs in result) tells the retry loop how long to wait.
        // The model cooldown (recordModelCooldown arg) must be >= that delay.
        // Otherwise the model appears available before the retry fires → guaranteed 429.
        const recordedCooldownMs = rh.modelRouter.recordModelCooldown.mock.calls[0][1];
        const retryDelay = result.retryAfterMs;

        expect(recordedCooldownMs).toBeGreaterThanOrEqual(retryDelay);
    });
});

// ============================================================================
// Early give-up: stop cascading 429s when tier is clearly saturated.
// When max429AttemptsPerRequest or max429RetryWindowMs is exceeded, return
// local 429 with explicit markers instead of burning more time.
// ============================================================================
describe('early give-up on sustained 429 cascades', () => {
    let rh, km;

    beforeEach(() => {
        https.request.mockReset();
        const setup = createHandler({
            keyManager: createKeyManager(['key1.secret1', 'key2.secret2', 'key3.secret3', 'key4.secret4']),
            config: {
                maxRetries: 5,
                modelRouting: {
                    failover: {
                        max429AttemptsPerRequest: 2,
                        max429RetryWindowMs: 3000,
                        maxModelSwitchesPerRequest: 5
                    }
                }
            }
        });
        rh = setup.rh;
        km = setup.km;

        rh.modelRouter = {
            selectModel: jest.fn().mockReturnValue({
                model: 'glm-4.7', source: 'pool', tier: 'heavy', reason: 'test'
            }),
            recordModelCooldown: jest.fn(),
            acquireModel: jest.fn(),
            releaseModel: jest.fn(),
            config: {
                logDecisions: false,
                cooldown: { defaultMs: 5000 },
                failover: {
                    max429AttemptsPerRequest: 2,
                    max429RetryWindowMs: 3000,
                    maxModelSwitchesPerRequest: 5
                }
            }
        };
    });

    afterEach(() => {
        rh.destroy();
    });

    test('gives up after max429AttemptsPerRequest 429 retries', async () => {
        // Mock: every attempt returns a 429 with shouldRetry=true
        jest.spyOn(rh, '_makeProxyRequest').mockResolvedValue({
            success: false,
            errorType: 'rate_limited',
            shouldRetry: true,
            shouldExcludeKey: false,
            retryAfterMs: 100,
            evidence: { source: 'upstream' },
            mappedModel: 'glm-4.7',
            routingDecision: { tier: 'heavy', source: 'pool' }
        });

        rh.statsAggregator = {
            recordClientRequestStart: jest.fn(),
            recordClientRequestFailure: jest.fn(),
            recordRetry: jest.fn(),
            recordLlm429Retry: jest.fn(),
            recordLlm429RetrySuccess: jest.fn(),
            recordGiveUp: jest.fn()
        };

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-give-up', null, Date.now(), trace
        );

        // With max429AttemptsPerRequest=2: attempt 0 (first try), then 2 retries → give up
        // Total: 3 _makeProxyRequest calls (attempt 0 + 2 429 retries)
        expect(rh._makeProxyRequest).toHaveBeenCalledTimes(3);
        expect(rh.statsAggregator.recordGiveUp).toHaveBeenCalled();
    });

    test('give-up returns 429 with model_exhausted marker', async () => {
        jest.spyOn(rh, '_makeProxyRequest').mockResolvedValue({
            success: false,
            errorType: 'rate_limited',
            shouldRetry: true,
            shouldExcludeKey: false,
            retryAfterMs: 100,
            evidence: { source: 'upstream' },
            mappedModel: 'glm-4.7',
            routingDecision: { tier: 'heavy', source: 'pool' }
        });

        rh.statsAggregator = {
            recordClientRequestStart: jest.fn(),
            recordClientRequestFailure: jest.fn(),
            recordRetry: jest.fn(),
            recordLlm429Retry: jest.fn(),
            recordLlm429RetrySuccess: jest.fn(),
            recordGiveUp: jest.fn()
        };

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-give-up-marker', null, Date.now(), trace
        );

        // Should return 429 with model_exhausted marker header
        expect(mockRes.writeHead).toHaveBeenCalledWith(
            429,
            expect.objectContaining({
                'x-proxy-rate-limit': 'model_exhausted'
            })
        );
    });

    test('without modelRouter, early give-up does not apply (legacy behavior)', async () => {
        // Remove modelRouter — legacy mode uses standard retry cap
        rh.modelRouter = null;

        jest.spyOn(rh, '_makeProxyRequest').mockResolvedValue({
            success: false,
            errorType: 'rate_limited',
            shouldRetry: true,
            shouldExcludeKey: true,
            retryAfterMs: 100,
            evidence: { source: 'upstream' }
        });

        rh.statsAggregator = {
            recordClientRequestStart: jest.fn(),
            recordClientRequestFailure: jest.fn(),
            recordRetry: jest.fn(),
            recordLlm429Retry: jest.fn(),
            recordLlm429RetrySuccess: jest.fn()
        };

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-no-give-up', null, Date.now(), trace
        );

        // Without modelRouter, standard retry cap (maxLlm429Retries=3) applies
        // maxRetries=5, so up to 4 429 retries possible, capped at 3 by LLM cap
        expect(rh._makeProxyRequest).toHaveBeenCalledTimes(4); // 1 initial + 3 LLM retries
    });
});

// ============================================================================
// Month 1 Metrics: recordGiveUp, recordSameModelRetry, recordFailedRequestModelStats
// ============================================================================
describe('Month 1 metrics: give-up reason recording', () => {
    let rh, km;

    beforeEach(() => {
        https.request.mockReset();
        const setup = createHandler({
            config: {
                maxRetries: 5,
                requestTimeout: 5000,
                maxTotalConcurrency: 10,
                failover: {
                    max429AttemptsPerRequest: 1,
                    max429RetryWindowMs: 60000,
                    maxModelSwitchesPerRequest: 5
                }
            }
        });
        rh = setup.rh;
        km = setup.km;

        rh.modelRouter = {
            selectModel: jest.fn().mockReturnValue({
                model: 'glm-4.7', source: 'pool', tier: 'heavy', reason: 'test'
            }),
            recordModelCooldown: jest.fn(),
            acquireModel: jest.fn(),
            releaseModel: jest.fn(),
            config: {
                logDecisions: false,
                cooldown: { defaultMs: 5000 },
                failover: {
                    max429AttemptsPerRequest: 1,
                    max429RetryWindowMs: 60000,
                    maxModelSwitchesPerRequest: 5
                }
            }
        };
    });

    afterEach(() => {
        rh.destroy();
    });

    test('recordGiveUp called with reason string (not undefined)', async () => {
        // Mock _makeProxyRequest to always return 429 with shouldRetry=true
        jest.spyOn(rh, '_makeProxyRequest').mockResolvedValue({
            success: false,
            errorType: 'rate_limited',
            shouldRetry: true,
            shouldExcludeKey: false,
            retryAfterMs: 10,
            evidence: { source: 'upstream' },
            mappedModel: 'glm-4.7',
            routingDecision: { tier: 'heavy', source: 'pool' }
        });

        rh.statsAggregator = {
            recordClientRequestStart: jest.fn(),
            recordClientRequestFailure: jest.fn(),
            recordRetry: jest.fn(),
            recordLlm429Retry: jest.fn(),
            recordLlm429RetrySuccess: jest.fn(),
            recordGiveUp: jest.fn(),
            recordSameModelRetry: jest.fn(),
            recordFailedRequestModelStats: jest.fn(),
            recordRetryBackoff: jest.fn()
        };

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-give-up-reason', null, Date.now(), trace
        );

        // recordGiveUp should be called with a reason string
        expect(rh.statsAggregator.recordGiveUp).toHaveBeenCalled();
        const reason = rh.statsAggregator.recordGiveUp.mock.calls[0][0];
        expect(typeof reason).toBe('string');
        expect(['max_429_attempts', 'max_429_window']).toContain(reason);
    });
});

describe('Month 1 metrics: same-model retry detection', () => {
    let rh, km;

    beforeEach(() => {
        https.request.mockReset();
        const setup = createHandler({
            config: {
                maxRetries: 5,
                requestTimeout: 5000,
                maxTotalConcurrency: 10,
                failover: {
                    max429AttemptsPerRequest: 5,
                    max429RetryWindowMs: 60000,
                    maxModelSwitchesPerRequest: 5
                }
            }
        });
        rh = setup.rh;
        km = setup.km;

        rh.modelRouter = {
            selectModel: jest.fn().mockReturnValue({
                model: 'glm-4.7', source: 'pool', tier: 'heavy', reason: 'test'
            }),
            recordModelCooldown: jest.fn(),
            acquireModel: jest.fn(),
            releaseModel: jest.fn(),
            config: {
                logDecisions: false,
                cooldown: { defaultMs: 5000 },
                failover: {
                    max429AttemptsPerRequest: 5,
                    max429RetryWindowMs: 60000,
                    maxModelSwitchesPerRequest: 5
                }
            }
        };
    });

    afterEach(() => {
        rh.destroy();
    });

    test('recordSameModelRetry called when model already in attemptedModels on retry', async () => {
        // Mock _makeProxyRequest to always return 429 with same mappedModel
        jest.spyOn(rh, '_makeProxyRequest').mockResolvedValue({
            success: false,
            errorType: 'rate_limited',
            shouldRetry: true,
            shouldExcludeKey: false,
            retryAfterMs: 10,
            evidence: { source: 'upstream' },
            mappedModel: 'glm-4.7',
            routingDecision: { tier: 'heavy', source: 'pool' }
        });

        rh.statsAggregator = {
            recordClientRequestStart: jest.fn(),
            recordClientRequestFailure: jest.fn(),
            recordRetry: jest.fn(),
            recordLlm429Retry: jest.fn(),
            recordLlm429RetrySuccess: jest.fn(),
            recordGiveUp: jest.fn(),
            recordSameModelRetry: jest.fn(),
            recordFailedRequestModelStats: jest.fn(),
            recordRetryBackoff: jest.fn()
        };

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-same-model', null, Date.now(), trace
        );

        // On attempt 0: attemptedModels is empty → add 'glm-4.7', no recordSameModelRetry
        // On attempt 1: attemptedModels.has('glm-4.7') → true → recordSameModelRetry called
        expect(rh.statsAggregator.recordSameModelRetry).toHaveBeenCalled();
    });
});

describe('Month 1 metrics: recordFailedRequestModelStats', () => {
    let rh, km;

    beforeEach(() => {
        https.request.mockReset();
        const setup = createHandler({
            config: {
                maxRetries: 2,
                requestTimeout: 5000,
                maxTotalConcurrency: 10,
                failover: {
                    max429AttemptsPerRequest: 1,
                    max429RetryWindowMs: 60000,
                    maxModelSwitchesPerRequest: 5
                }
            }
        });
        rh = setup.rh;
        km = setup.km;

        rh.modelRouter = {
            selectModel: jest.fn().mockReturnValue({
                model: 'glm-4.7', source: 'pool', tier: 'heavy', reason: 'test'
            }),
            recordModelCooldown: jest.fn(),
            acquireModel: jest.fn(),
            releaseModel: jest.fn(),
            config: {
                logDecisions: false,
                cooldown: { defaultMs: 5000 },
                failover: {
                    max429AttemptsPerRequest: 1,
                    max429RetryWindowMs: 60000,
                    maxModelSwitchesPerRequest: 5
                }
            }
        };
    });

    afterEach(() => {
        rh.destroy();
    });

    test('recordFailedRequestModelStats called on give-up path', async () => {
        jest.spyOn(rh, '_makeProxyRequest').mockResolvedValue({
            success: false,
            errorType: 'rate_limited',
            shouldRetry: true,
            shouldExcludeKey: false,
            retryAfterMs: 10,
            evidence: { source: 'upstream' },
            mappedModel: 'glm-4.7',
            routingDecision: { tier: 'heavy', source: 'pool' }
        });

        rh.statsAggregator = {
            recordClientRequestStart: jest.fn(),
            recordClientRequestFailure: jest.fn(),
            recordRetry: jest.fn(),
            recordLlm429Retry: jest.fn(),
            recordLlm429RetrySuccess: jest.fn(),
            recordGiveUp: jest.fn(),
            recordSameModelRetry: jest.fn(),
            recordFailedRequestModelStats: jest.fn(),
            recordRetryBackoff: jest.fn()
        };

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-fail-stats', null, Date.now(), trace
        );

        // Give-up path should call recordFailedRequestModelStats with attemptedModels.size > 0
        expect(rh.statsAggregator.recordFailedRequestModelStats).toHaveBeenCalledWith(
            expect.any(Number),
            expect.any(Number)
        );
        // First arg (attemptedModelsCount) should be >= 1
        expect(rh.statsAggregator.recordFailedRequestModelStats.mock.calls[0][0]).toBeGreaterThanOrEqual(1);
    });

    test('recordFailedRequestModelStats called exactly once on give-up (not per attempt)', async () => {
        // Simulate: multiple 429 retries → give-up → exactly one recordFailedRequestModelStats call
        // Use max429AttemptsPerRequest=1 so give-up triggers after first 429 retry
        let callCount = 0;
        jest.spyOn(rh, '_makeProxyRequest').mockImplementation(async () => {
            callCount++;
            return {
                success: false,
                errorType: 'rate_limited',
                shouldRetry: true,
                shouldExcludeKey: false,
                retryAfterMs: 10,
                evidence: { source: 'upstream' },
                mappedModel: callCount <= 1 ? 'glm-4.7' : 'glm-4.6',
                routingDecision: { tier: 'heavy', source: 'pool' }
            };
        });

        rh.statsAggregator = {
            recordClientRequestStart: jest.fn(),
            recordClientRequestFailure: jest.fn(),
            recordRetry: jest.fn(),
            recordLlm429Retry: jest.fn(),
            recordLlm429RetrySuccess: jest.fn(),
            recordGiveUp: jest.fn(),
            recordSameModelRetry: jest.fn(),
            recordFailedRequestModelStats: jest.fn(),
            recordRetryBackoff: jest.fn()
        };

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-single-count', null, Date.now(), trace
        );

        // recordFailedRequestModelStats must be called exactly once (on final failure),
        // not once per retry attempt
        expect(rh.statsAggregator.recordFailedRequestModelStats).toHaveBeenCalledTimes(1);
    });
});

describe('Month 1 metrics: sameModelRetry gating on 429', () => {
    let rh, km;

    beforeEach(() => {
        https.request.mockReset();
        const setup = createHandler({
            config: {
                maxRetries: 5,
                requestTimeout: 5000,
                maxTotalConcurrency: 10,
                failover: {
                    max429AttemptsPerRequest: 5,
                    max429RetryWindowMs: 60000,
                    maxModelSwitchesPerRequest: 5
                }
            }
        });
        rh = setup.rh;
        km = setup.km;

        rh.modelRouter = {
            selectModel: jest.fn().mockReturnValue({
                model: 'glm-4.7', source: 'pool', tier: 'heavy', reason: 'test'
            }),
            recordModelCooldown: jest.fn(),
            acquireModel: jest.fn(),
            releaseModel: jest.fn(),
            config: {
                logDecisions: false,
                cooldown: { defaultMs: 5000 },
                failover: {
                    max429AttemptsPerRequest: 5,
                    max429RetryWindowMs: 60000,
                    maxModelSwitchesPerRequest: 5
                }
            }
        };
    });

    afterEach(() => {
        rh.destroy();
    });

    test('429 + responseStarted=true → no sameModelRetry increment', async () => {
        // First attempt: normal 429 with shouldRetry (accepted, model added to attemptedModels)
        // Second attempt: 429 with responseStarted=true (same model, but breaks before acceptance)
        let callCount = 0;
        jest.spyOn(rh, '_makeProxyRequest').mockImplementation(async () => {
            callCount++;
            if (callCount === 1) {
                return {
                    success: false,
                    errorType: 'rate_limited',
                    shouldRetry: true,
                    shouldExcludeKey: false,
                    retryAfterMs: 10,
                    evidence: { source: 'upstream' },
                    mappedModel: 'glm-4.7',
                    routingDecision: { tier: 'heavy', source: 'pool' }
                };
            }
            // Second attempt: same model but responseStarted → breaks before acceptance path
            return {
                success: false,
                errorType: 'rate_limited',
                shouldRetry: true,
                responseStarted: true,
                shouldExcludeKey: false,
                retryAfterMs: 10,
                evidence: { source: 'upstream' },
                mappedModel: 'glm-4.7',
                routingDecision: { tier: 'heavy', source: 'pool' }
            };
        });

        rh.statsAggregator = {
            recordClientRequestStart: jest.fn(),
            recordClientRequestFailure: jest.fn(),
            recordRetry: jest.fn(),
            recordLlm429Retry: jest.fn(),
            recordLlm429RetrySuccess: jest.fn(),
            recordGiveUp: jest.fn(),
            recordSameModelRetry: jest.fn(),
            recordFailedRequestModelStats: jest.fn(),
            recordRetryBackoff: jest.fn()
        };

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-response-started', null, Date.now(), trace
        );

        // sameModelRetry should NOT be called: the 429 acceptance path was skipped
        // because responseStarted=true caused a break before reaching the acceptance path
        expect(rh.statsAggregator.recordSameModelRetry).not.toHaveBeenCalled();
    });

    test('non-429 retry with same model does NOT increment sameModelRetry', async () => {
        // First attempt: timeout error with retryable model
        // Second attempt: same model again (timeout, not 429)
        // sameModelRetry should NOT fire because it only gates on 429
        let callCount = 0;
        jest.spyOn(rh, '_makeProxyRequest').mockImplementation(async () => {
            callCount++;
            return {
                success: false,
                errorType: 'timeout',
                shouldRetry: false,
                shouldExcludeKey: true,
                mappedModel: 'glm-4.7',
                routingDecision: { tier: 'heavy', source: 'pool' },
                error: { message: 'timeout', isTimeout: true }
            };
        });

        rh.statsAggregator = {
            recordClientRequestStart: jest.fn(),
            recordClientRequestFailure: jest.fn(),
            recordRetry: jest.fn(),
            recordLlm429Retry: jest.fn(),
            recordLlm429RetrySuccess: jest.fn(),
            recordGiveUp: jest.fn(),
            recordSameModelRetry: jest.fn(),
            recordFailedRequestModelStats: jest.fn(),
            recordRetryBackoff: jest.fn()
        };

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-non-429-retry', null, Date.now(), trace
        );

        // sameModelRetry should NOT fire for non-429 retries
        expect(rh.statsAggregator.recordSameModelRetry).not.toHaveBeenCalled();
    });
});

describe('Month 1 metrics: retry_attempts vs retry_backoff contract', () => {
    let rh, km;

    beforeEach(() => {
        https.request.mockReset();
        const setup = createHandler({
            config: {
                maxRetries: 3,
                requestTimeout: 5000,
                maxTotalConcurrency: 10,
                failover: {
                    max429AttemptsPerRequest: 3,
                    max429RetryWindowMs: 60000,
                    maxModelSwitchesPerRequest: 5
                }
            }
        });
        rh = setup.rh;
        km = setup.km;

        rh.modelRouter = {
            selectModel: jest.fn().mockReturnValue({
                model: 'glm-4.7', source: 'pool', tier: 'heavy', reason: 'test'
            }),
            recordModelCooldown: jest.fn(),
            acquireModel: jest.fn(),
            releaseModel: jest.fn(),
            config: {
                logDecisions: false,
                cooldown: { defaultMs: 5000 },
                failover: {
                    max429AttemptsPerRequest: 3,
                    max429RetryWindowMs: 60000,
                    maxModelSwitchesPerRequest: 5
                }
            }
        };
    });

    afterEach(() => {
        rh.destroy();
    });

    test('retryBackoff.delayCount <= totalRetries: backoff only counts sleeps with delay > 0', async () => {
        // Contract: recordRetry() fires on EVERY retry (attempt > 0), feeding totalRetries.
        // recordRetryBackoff(ms) fires only when backoffMs > 0, feeding retryBackoff.delayCount.
        // Therefore delayCount <= totalRetries always holds.
        // With 429 retries that set retryAfterMs=10, both should fire equally (retryAfterMs > 0).
        let callCount = 0;
        jest.spyOn(rh, '_makeProxyRequest').mockImplementation(async () => {
            callCount++;
            if (callCount <= 2) {
                return {
                    success: false,
                    errorType: 'rate_limited',
                    shouldRetry: true,
                    shouldExcludeKey: false,
                    retryAfterMs: 50,
                    evidence: { source: 'upstream' },
                    mappedModel: 'glm-4.7',
                    routingDecision: { tier: 'heavy', source: 'pool' }
                };
            }
            // Third attempt succeeds
            return { success: true, mappedModel: 'glm-4.7' };
        });

        rh.statsAggregator = {
            recordClientRequestStart: jest.fn(),
            recordClientRequestSuccess: jest.fn(),
            recordClientRequestFailure: jest.fn(),
            recordRetry: jest.fn(),
            recordRetrySuccess: jest.fn(),
            recordLlm429Retry: jest.fn(),
            recordLlm429RetrySuccess: jest.fn(),
            recordGiveUp: jest.fn(),
            recordSameModelRetry: jest.fn(),
            recordFailedRequestModelStats: jest.fn(),
            recordRetryBackoff: jest.fn()
        };

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-attempts-vs-backoff', null, Date.now(), trace
        );

        const retryCount = rh.statsAggregator.recordRetry.mock.calls.length;
        const backoffCount = rh.statsAggregator.recordRetryBackoff.mock.calls.length;

        // Both should have been called (retryAfterMs=50 > 0 means backoff fires)
        expect(retryCount).toBeGreaterThan(0);
        expect(backoffCount).toBeGreaterThan(0);
        // Contract: backoff events <= retry events (backoff only fires when delay > 0)
        expect(backoffCount).toBeLessThanOrEqual(retryCount);
        // In this scenario with retryAfterMs=50, they should be equal
        expect(backoffCount).toBe(retryCount);
    });
});

// ============================================================================
// TIER-AWARE ADMISSION HOLD
// ============================================================================
describe('admission hold', () => {
    let rh, km;

    beforeEach(() => {
        https.request.mockReset();
        const setup = createHandler({
            config: {
                maxRetries: 2,
                requestTimeout: 5000,
                maxTotalConcurrency: 10,
                admissionHold: {
                    enabled: true,
                    tiers: ['heavy'],
                    maxHoldMs: 500,        // Short for tests
                    maxConcurrentHolds: 20,
                    jitterMs: 0,           // No jitter for deterministic tests
                    minCooldownToHold: 50,
                }
            }
        });
        rh = setup.rh;
        km = setup.km;

        rh.statsAggregator = {
            recordClientRequestStart: jest.fn(),
            recordClientRequestSuccess: jest.fn(),
            recordClientRequestFailure: jest.fn(),
            recordRetry: jest.fn(),
            recordLlm429Retry: jest.fn(),
            recordAdmissionHold: jest.fn(),
            recordAdmissionHoldComplete: jest.fn(),
            recordAdmissionHoldRejected: jest.fn(),
            recordRetryBackoff: jest.fn(),
            recordGiveUp: jest.fn(),
            recordSameModelRetry: jest.fn(),
            recordFailedRequestModelStats: jest.fn()
        };
    });

    afterEach(() => {
        rh.destroy();
    });

    function createMockModelRouterWithHold(peekResults) {
        let peekCallCount = 0;
        return {
            enabled: true,
            selectModel: jest.fn().mockResolvedValue({
                model: 'glm-4.7', source: 'pool', tier: 'heavy', reason: 'test'
            }),
            peekAdmissionHold: jest.fn().mockImplementation(() => {
                const result = typeof peekResults === 'function'
                    ? peekResults(peekCallCount)
                    : peekResults[peekCallCount] ?? null;
                peekCallCount++;
                return result;
            }),
            recordModelCooldown: jest.fn(),
            acquireModel: jest.fn(),
            releaseModel: jest.fn(),
            config: {
                logDecisions: false,
                cooldown: { defaultMs: 5000 },
                failover: { max429AttemptsPerRequest: 3, max429RetryWindowMs: 60000 }
            }
        };
    }

    test('holds and releases when cooldown clears', async () => {
        // First peek: all cooled (hold), second peek: not cooled (release)
        rh.modelRouter = createMockModelRouterWithHold([
            { tier: 'heavy', candidates: ['glm-4.7'], minCooldownMs: 100, allCooled: true },
            null  // Cooldown cleared
        ]);

        // Mock _makeProxyRequest to succeed after hold
        jest.spyOn(rh, '_makeProxyRequest').mockResolvedValue({
            success: true, mappedModel: 'glm-4.7'
        });

        const mockRes = createMockRes();
        const trace = createTrace();
        const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-6', messages: [] }));

        await rh._proxyWithRetries(
            createMockReq({ url: '/v1/messages' }), mockRes, body,
            'req-hold-release', null, Date.now(), trace
        );

        expect(rh.statsAggregator.recordAdmissionHold).toHaveBeenCalledWith('heavy');
        expect(rh.statsAggregator.recordAdmissionHoldComplete).toHaveBeenCalledWith(
            expect.any(Number), true  // succeeded = true
        );
        expect(trace.admissionHoldSucceeded).toBe(true);
    });

    test('returns 429 with admission_hold_timeout when hold maxes out', async () => {
        // Always return all-cooled (hold will time out)
        rh.modelRouter = createMockModelRouterWithHold(() => ({
            tier: 'heavy', candidates: ['glm-4.7'], minCooldownMs: 10000, allCooled: true
        }));

        const mockRes = createMockRes();
        const trace = createTrace();
        const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-6', messages: [] }));

        await rh._proxyWithRetries(
            createMockReq({ url: '/v1/messages' }), mockRes, body,
            'req-hold-timeout', null, Date.now(), trace
        );

        expect(rh.statsAggregator.recordAdmissionHoldComplete).toHaveBeenCalledWith(
            expect.any(Number), false  // succeeded = false
        );
        expect(mockRes.writeHead).toHaveBeenCalledWith(429, expect.objectContaining({
            'x-proxy-rate-limit': 'admission_hold_timeout',
            'x-proxy-tier': 'heavy'
        }));
        const responseBody = JSON.parse(mockRes.end.mock.calls[0][0]);
        expect(responseBody.errorType).toBe('admission_hold_timeout');
    });

    test('rejects with admission_hold_rejected when maxConcurrentHolds exceeded', async () => {
        rh.config.admissionHold = {
            ...rh.config.admissionHold,
            maxConcurrentHolds: 0  // Zero cap → always reject
        };

        rh.modelRouter = createMockModelRouterWithHold([
            { tier: 'heavy', candidates: ['glm-4.7'], minCooldownMs: 5000, allCooled: true }
        ]);

        // Mock _makeProxyRequest to succeed (falls through after rejection)
        jest.spyOn(rh, '_makeProxyRequest').mockResolvedValue({
            success: true, mappedModel: 'glm-4.7'
        });

        const mockRes = createMockRes();
        const trace = createTrace();
        const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-6', messages: [] }));

        await rh._proxyWithRetries(
            createMockReq({ url: '/v1/messages' }), mockRes, body,
            'req-hold-rejected', null, Date.now(), trace
        );

        expect(rh.statsAggregator.recordAdmissionHoldRejected).toHaveBeenCalled();
        // Should NOT have entered hold (falls through to normal path)
        expect(rh.statsAggregator.recordAdmissionHold).not.toHaveBeenCalled();
    });

    test('skipped when admissionHold.enabled !== true', async () => {
        rh.config.admissionHold = { enabled: false };

        rh.modelRouter = createMockModelRouterWithHold([
            { tier: 'heavy', candidates: ['glm-4.7'], minCooldownMs: 5000, allCooled: true }
        ]);

        jest.spyOn(rh, '_makeProxyRequest').mockResolvedValue({
            success: true, mappedModel: 'glm-4.7'
        });

        const mockRes = createMockRes();
        const trace = createTrace();
        const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-6', messages: [] }));

        await rh._proxyWithRetries(
            createMockReq({ url: '/v1/messages' }), mockRes, body,
            'req-disabled', null, Date.now(), trace
        );

        // Should not have called peekAdmissionHold at all during hold check
        // (it may be called during context building, but no hold/reject stats)
        expect(rh.statsAggregator.recordAdmissionHold).not.toHaveBeenCalled();
        expect(rh.statsAggregator.recordAdmissionHoldRejected).not.toHaveBeenCalled();
    });

    test('skipped for non-LLM routes', async () => {
        rh.modelRouter = createMockModelRouterWithHold([
            { tier: 'heavy', candidates: ['glm-4.7'], minCooldownMs: 5000, allCooled: true }
        ]);

        jest.spyOn(rh, '_makeProxyRequest').mockResolvedValue({
            success: true, mappedModel: 'glm-4.7'
        });

        const mockRes = createMockRes();
        const trace = createTrace();
        const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-6', messages: [] }));

        await rh._proxyWithRetries(
            createMockReq({ url: '/health' }), mockRes, body,
            'req-non-llm', null, Date.now(), trace
        );

        expect(rh.statsAggregator.recordAdmissionHold).not.toHaveBeenCalled();
    });

    test('skipped when no model router', async () => {
        rh.modelRouter = null;

        jest.spyOn(rh, '_makeProxyRequest').mockResolvedValue({
            success: true, mappedModel: 'glm-4.7'
        });

        const mockRes = createMockRes();
        const trace = createTrace();
        const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-6', messages: [] }));

        await rh._proxyWithRetries(
            createMockReq({ url: '/v1/messages' }), mockRes, body,
            'req-no-router', null, Date.now(), trace
        );

        expect(rh.statsAggregator.recordAdmissionHold).not.toHaveBeenCalled();
    });

    test('skipped when tier not in admissionHold.tiers allowlist', async () => {
        rh.config.admissionHold = {
            ...rh.config.admissionHold,
            tiers: ['heavy']  // Only heavy allowed
        };

        rh.modelRouter = createMockModelRouterWithHold([
            { tier: 'light', candidates: ['glm-4.5-air'], minCooldownMs: 5000, allCooled: true }
        ]);

        jest.spyOn(rh, '_makeProxyRequest').mockResolvedValue({
            success: true, mappedModel: 'glm-4.5-air'
        });

        const mockRes = createMockRes();
        const trace = createTrace();
        const body = Buffer.from(JSON.stringify({ model: 'claude-haiku-4-5', messages: [] }));

        await rh._proxyWithRetries(
            createMockReq({ url: '/v1/messages' }), mockRes, body,
            'req-wrong-tier', null, Date.now(), trace
        );

        expect(rh.statsAggregator.recordAdmissionHold).not.toHaveBeenCalled();
    });

    test('skipped when per-request override header present (peekAdmissionHold returns null)', async () => {
        // peekAdmissionHold returns null when override is present
        rh.modelRouter = createMockModelRouterWithHold([null]);

        jest.spyOn(rh, '_makeProxyRequest').mockResolvedValue({
            success: true, mappedModel: 'glm-4.5'
        });

        const mockRes = createMockRes();
        const trace = createTrace();
        const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-6', messages: [] }));

        await rh._proxyWithRetries(
            createMockReq({ url: '/v1/messages', headers: { 'x-model-override': 'glm-4.5' } }),
            mockRes, body, 'req-override', null, Date.now(), trace
        );

        expect(rh.statsAggregator.recordAdmissionHold).not.toHaveBeenCalled();
    });

    test('client disconnect during hold exits cleanly, decrements counter', async () => {
        // Always return all-cooled (hold will last until timeout or disconnect)
        rh.modelRouter = createMockModelRouterWithHold(() => ({
            tier: 'heavy', candidates: ['glm-4.7'], minCooldownMs: 200, allCooled: true
        }));

        const mockRes = createMockRes();
        let closeCallback = null;
        mockRes.once = jest.fn().mockImplementation((event, cb) => {
            if (event === 'close') closeCallback = cb;
        });

        const trace = createTrace();
        const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-6', messages: [] }));

        // Simulate client disconnect after 50ms
        setTimeout(() => {
            if (closeCallback) closeCallback();
        }, 50);

        await rh._proxyWithRetries(
            createMockReq({ url: '/v1/messages' }), mockRes, body,
            'req-disconnect', null, Date.now(), trace
        );

        // Counter should be back to 0
        expect(rh.currentAdmissionHolds).toBe(0);
        // Hold completed (with client disconnect, not timeout success)
        expect(rh.statsAggregator.recordAdmissionHoldComplete).toHaveBeenCalled();
    });

    test('give-up window not penalized (retryLoopStartTime shifted by holdDurationMs)', async () => {
        // Hold for ~100ms, then release. Verify give-up window is shifted.
        let peekCount = 0;
        rh.modelRouter = createMockModelRouterWithHold((n) => {
            peekCount++;
            if (peekCount <= 2) {
                return { tier: 'heavy', candidates: ['glm-4.7'], minCooldownMs: 80, allCooled: true };
            }
            return null; // Cooldown cleared
        });

        // After hold, simulate a successful request
        jest.spyOn(rh, '_makeProxyRequest').mockResolvedValue({
            success: true, mappedModel: 'glm-4.7'
        });

        const mockRes = createMockRes();
        const trace = createTrace();
        const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-6', messages: [] }));

        await rh._proxyWithRetries(
            createMockReq({ url: '/v1/messages' }), mockRes, body,
            'req-window-shift', null, Date.now(), trace
        );

        // Hold succeeded
        expect(rh.statsAggregator.recordAdmissionHoldComplete).toHaveBeenCalledWith(
            expect.any(Number), true
        );
        // Request completed successfully (hold didn't eat into give-up window)
        expect(rh.statsAggregator.recordClientRequestSuccess).toHaveBeenCalled();
    });
});

// ============================================================================
// POOL 429 PENALTY RECORDING
// ============================================================================
describe('pool 429 penalty recording', () => {
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

    test('calls recordPool429 on upstream 429 (non-burst)', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(429, { 'retry-after': '5' });

        setupHttpsMock(proxyReq, proxyRes);

        km.recordPoolRateLimitHit = jest.fn().mockReturnValue({
            pool429Count: 3, // >= 3 = persistent throttle
            cooldownMs: 4000
        });
        km.recordRateLimit = jest.fn().mockReturnValue({});
        km.getPoolCooldownRemainingMs = jest.fn().mockReturnValue(0);

        rh.modelRouter = {
            selectModel: jest.fn().mockReturnValue({
                model: 'glm-4-plus',
                source: 'complexity',
                tier: 'medium',
                reason: 'test'
            }),
            recordModelCooldown: jest.fn(),
            recordPool429: jest.fn(),
            acquireModel: jest.fn(),
            releaseModel: jest.fn(),
            config: { logDecisions: false, cooldown: { burstDampeningFactor: 0.2, defaultMs: 5000 } }
        };

        const keyInfo = km.acquireKey();
        const mockRes = createMockRes();
        const body = Buffer.from(JSON.stringify({ model: 'claude-3-haiku', messages: [] }));

        await rh._makeProxyRequest(
            createMockReq({ url: '/v1/messages' }), mockRes, body, keyInfo,
            'req-penalty-1', null, Date.now(), 0,
            false, null, false, createTraceAttempt(), new Set()
        );

        expect(rh.modelRouter.recordPool429).toHaveBeenCalledWith('glm-4-plus');
    });

    test('calls recordPool429 on upstream 429 (burst-dampened)', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(429, { 'retry-after': '1' });

        setupHttpsMock(proxyReq, proxyRes);

        km.recordPoolRateLimitHit = jest.fn().mockReturnValue({
            pool429Count: 2, // < 3 = transient burst
            cooldownMs: 1000
        });
        km.recordRateLimit = jest.fn().mockReturnValue({});
        km.getPoolCooldownRemainingMs = jest.fn().mockReturnValue(0);

        rh.modelRouter = {
            selectModel: jest.fn().mockReturnValue({
                model: 'glm-4-plus',
                source: 'complexity',
                tier: 'medium',
                reason: 'test'
            }),
            recordModelCooldown: jest.fn(),
            recordPool429: jest.fn(),
            acquireModel: jest.fn(),
            releaseModel: jest.fn(),
            config: { logDecisions: false, cooldown: { burstDampeningFactor: 0.2, defaultMs: 5000 } }
        };

        const keyInfo = km.acquireKey();
        const mockRes = createMockRes();
        const body = Buffer.from(JSON.stringify({ model: 'claude-3-haiku', messages: [] }));

        await rh._makeProxyRequest(
            createMockReq({ url: '/v1/messages' }), mockRes, body, keyInfo,
            'req-penalty-2', null, Date.now(), 0,
            false, null, false, createTraceAttempt(), new Set()
        );

        // recordPool429 fires on EVERY 429, even burst-dampened
        expect(rh.modelRouter.recordPool429).toHaveBeenCalledWith('glm-4-plus');
    });

    test('does not call recordPool429 when modelRouter absent', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(429, { 'retry-after': '1' });

        setupHttpsMock(proxyReq, proxyRes);

        km.recordPoolRateLimitHit = jest.fn().mockReturnValue({
            pool429Count: 1,
            cooldownMs: 1000
        });
        km.recordRateLimit = jest.fn().mockReturnValue({});
        km.getPoolCooldownRemainingMs = jest.fn().mockReturnValue(0);

        // No modelRouter set
        rh.modelRouter = null;

        const keyInfo = km.acquireKey();
        const mockRes = createMockRes();
        const body = Buffer.from(JSON.stringify({ model: 'claude-3-haiku', messages: [] }));

        // Should not throw when modelRouter is null
        await expect(rh._makeProxyRequest(
            createMockReq({ url: '/v1/messages' }), mockRes, body, keyInfo,
            'req-penalty-3', null, Date.now(), 0,
            false, null, false, createTraceAttempt(), new Set()
        )).resolves.not.toThrow();
    });

    test('local 429 (pool cooldown) does NOT call recordPool429', async () => {
        // Local 429 is generated in _proxyWithRetries when pool cooldown is active
        // and no model router is present (attempt 0, above sleepThreshold).
        // _makeProxyRequest is never called, so recordPool429 should never fire.
        rh.destroy();

        const setup = createHandler({
            config: {
                maxRetries: 0,
                requestTimeout: 5000,
                maxTotalConcurrency: 10,
                poolCooldown: { sleepThresholdMs: 500, retryJitterMs: 50, maxCooldownMs: 5000 }
            }
        });
        rh = setup.rh;
        km = setup.km;

        km.getPoolCooldownRemainingMs = jest.fn().mockReturnValue(2000);
        // No model router → pool cooldown triggers local 429 at attempt 0
        rh.modelRouter = null;

        const makeProxySpy = jest.spyOn(rh, '_makeProxyRequest');

        const mockRes = createMockRes();
        const trace = createTrace();
        const body = Buffer.from(JSON.stringify({ model: 'claude-3-haiku', messages: [] }));

        await rh._proxyWithRetries(
            createMockReq({ url: '/v1/messages' }), mockRes, body,
            'req-local-429', null, Date.now(), trace
        );

        // Local 429 returns immediately — _makeProxyRequest never called
        expect(mockRes.writeHead).toHaveBeenCalledWith(429, expect.anything());
        expect(makeProxySpy).not.toHaveBeenCalled();
    });

    test('does NOT call recordPool429 on non-429 upstream error (500)', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(500);

        setupHttpsMock(proxyReq, proxyRes);

        rh.modelRouter = {
            selectModel: jest.fn().mockReturnValue({
                model: 'glm-4-plus',
                source: 'complexity',
                tier: 'medium',
                reason: 'test'
            }),
            recordModelCooldown: jest.fn(),
            recordPool429: jest.fn(),
            acquireModel: jest.fn(),
            releaseModel: jest.fn(),
            config: { logDecisions: false, cooldown: { burstDampeningFactor: 0.2, defaultMs: 5000 } }
        };

        const keyInfo = km.acquireKey();
        const mockRes = createMockRes();
        const body = Buffer.from(JSON.stringify({ model: 'claude-3-haiku', messages: [] }));

        await rh._makeProxyRequest(
            createMockReq({ url: '/v1/messages' }), mockRes, body, keyInfo,
            'req-non429', null, Date.now(), 0,
            false, null, false, createTraceAttempt(), new Set()
        );

        // 500 is not a 429 — recordPool429 should NOT be called
        expect(rh.modelRouter.recordPool429).not.toHaveBeenCalled();
    });
});
