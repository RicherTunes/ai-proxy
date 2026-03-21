'use strict';

/**
 * Deep Branch Coverage Tests for lib/request-handler.js
 *
 * Targets uncovered branches catalogued in request-handler-branches.test.js:
 *
 * 1. Pool-burst dampened cooldown (lines ~2248-2258)
 *    — When pool-burst dampening triggers, the key gets a modified (dampened) cooldown.
 *
 * 2. pass_through_response_started retry decision (line ~2282)
 *    — When a response has already started streaming (headersSent=true), retries are skipped.
 *
 * 3. pool_blocked retry decision (line ~2283)
 *    — When the entire pool is blocked (all keys rate-limited), retry behavior changes.
 *
 * 4. useFreshConnection flag (lines ~1648-1649)
 *    — When the retry result says useFreshConnection=true, a fresh connection is established.
 *
 * 5. Overall timeout catch block (lines ~990-1001)
 *    — The request exceeds the total timeout (createTimeout fires).
 */

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

const {
    createMockReq,
    createMockRes,
    createMockProxyReq,
    createMockProxyRes,
    setupHttpsMock: _setupHttpsMock
} = require('./helpers/create-handler');

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

function setupHttpsMock(proxyReq, proxyRes) {
    _setupHttpsMock(https, proxyReq, proxyRes);
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

async function flushAsyncWork() {
    await new Promise(resolve => setImmediate(resolve));
}

// ============================================================================
// 1. Pool-burst dampened cooldown
//    Source: lines ~2248-2258 in _makeProxyRequest 429 handler
//    When pool429Count > 1 (pool burst) and < 3 (not persistent), the cooldown
//    is dampened: dampenedMs = max(computedRetryDelayMs, max(100, retryDelay * factor))
//    This test verifies the dampened cooldown value and the burstDampened flag.
// ============================================================================
describe('pool-burst dampened cooldown (deep)', () => {
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

    test('dampened cooldown is at least computedRetryDelayMs and uses burstDampeningFactor', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(429, { 'retry-after': '2' });

        setupHttpsMock(proxyReq, proxyRes);

        // Pool burst: pool429Count=2 (>1 = burst, <3 = transient)
        km.recordPoolRateLimitHit = jest.fn().mockReturnValue({
            pool429Count: 2,
            cooldownMs: 1500,
            wasAlreadyBlocked: false
        });
        km.recordRateLimit = jest.fn().mockReturnValue({});
        km.getPoolCooldownRemainingMs = jest.fn().mockReturnValue(0);

        const burstFactor = 0.3;
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
            config: {
                logDecisions: false,
                cooldown: { burstDampeningFactor: burstFactor, defaultMs: 5000 }
            }
        };

        const keyInfo = km.acquireKey();
        const mockRes = createMockRes();
        const body = Buffer.from(JSON.stringify({ model: 'claude-3-haiku', messages: [] }));

        await rh._makeProxyRequest(
            createMockReq({ url: '/v1/messages' }), mockRes, body, keyInfo,
            'req-burst-deep', null, Date.now(), 0,
            false, null, false, createTraceAttempt(), new Set()
        );

        // Verify burstDampened flag was passed
        expect(rh.modelRouter.recordModelCooldown).toHaveBeenCalledWith(
            'glm-4-plus',
            expect.any(Number),
            { burstDampened: true }
        );

        // The dampened cooldown should be >= computedRetryDelayMs
        // retryAfterMs = 2 * 1000 = 2000, so computedRetryDelayMs = 2000
        // dampenedMs = max(2000, max(100, round(2000 * 0.3))) = max(2000, max(100, 600)) = max(2000, 600) = 2000
        const actualDampenedMs = rh.modelRouter.recordModelCooldown.mock.calls[0][1];
        expect(actualDampenedMs).toBeGreaterThanOrEqual(2000);

        // The per-key cooldown should be dampened too (Math.min(1000, poolResult.cooldownMs))
        expect(km.recordRateLimit).toHaveBeenCalledWith(
            expect.anything(),
            Math.min(1000, 1500) // isPoolBurst → min(1000, cooldownMs)
        );
    });

    test('per-key cooldown uses Math.min(1000, cooldownMs) during pool burst', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(429, { 'retry-after': '3' });

        setupHttpsMock(proxyReq, proxyRes);

        // Pool burst with large cooldownMs
        km.recordPoolRateLimitHit = jest.fn().mockReturnValue({
            pool429Count: 2,
            cooldownMs: 5000, // Large cooldown
            wasAlreadyBlocked: false
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
            config: {
                logDecisions: false,
                cooldown: { burstDampeningFactor: 0.2, defaultMs: 5000 }
            }
        };

        const keyInfo = km.acquireKey();
        const body = Buffer.from(JSON.stringify({ model: 'claude-3-haiku', messages: [] }));

        await rh._makeProxyRequest(
            createMockReq({ url: '/v1/messages' }), createMockRes(), body, keyInfo,
            'req-burst-perkey', null, Date.now(), 0,
            false, null, false, createTraceAttempt(), new Set()
        );

        // isPoolBurst=true → perKeyCooldownMs = Math.min(1000, 5000) = 1000
        expect(km.recordRateLimit).toHaveBeenCalledWith(expect.anything(), 1000);
    });
});

// ============================================================================
// 2. pass_through_response_started retry decision
//    Source: line ~2281-2282 in _makeProxyRequest 429 handler
//    When res.headersSent=true, canRetry is false, and retryDecision becomes
//    'pass_through_response_started'. The 429 response is piped to the client.
// ============================================================================
describe('pass_through_response_started retry decision (deep)', () => {
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

    test('headersSent=true prevents 429 retry at _proxyWithRetries level', async () => {
        // The pass_through_response_started path (line 2281) is reached when
        // _makeProxyRequest returns with shouldRetry=true but the response has
        // already started (responseStarted=true). The retry loop at _proxyWithRetries
        // then checks this (line 1562) and breaks out.
        jest.spyOn(rh, '_makeProxyRequest').mockResolvedValueOnce({
            success: false,
            error: new Error('Rate limited'),
            errorType: 'rate_limited',
            shouldRetry: true,
            responseStarted: false,  // First attempt: no response started
            shouldExcludeKey: true,
            retryAfterMs: 100,
            evidence: { source: 'upstream' }
        }).mockResolvedValueOnce({
            success: false,
            error: new Error('Rate limited'),
            errorType: 'rate_limited',
            shouldRetry: true,
            responseStarted: true,  // Second attempt: response already started
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
            'req-headers-sent', null, Date.now(), trace
        );

        // Should have made 2 attempts: first retry succeeds, second has response started → break
        expect(rh._makeProxyRequest).toHaveBeenCalledTimes(2);
        // First 429 counted as LLM retry
        expect(rh.statsAggregator.recordLlm429Retry).toHaveBeenCalledTimes(1);
    });

    test('headersSent=true on res prevents second retry in the loop', async () => {
        // When res.headersSent becomes true after first attempt fails,
        // _proxyWithRetries checks at line 1145 before retry and aborts.
        const mockRes = createMockRes();
        jest.spyOn(rh, '_makeProxyRequest').mockImplementation(async () => {
            // After first call, simulate that headers got sent
            mockRes.headersSent = true;
            return {
                success: false,
                error: new Error('Server error'),
                errorType: 'server_error',
                shouldExcludeKey: true
            };
        });

        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-headers-sent-retry', null, Date.now(), trace
        );

        // Only one attempt because headersSent=true is detected at line 1145
        // before the second retry
        expect(rh._makeProxyRequest).toHaveBeenCalledTimes(1);
    });

    test('responseStarted internal flag also triggers pass_through path', async () => {
        // This test verifies the behavior at the _proxyWithRetries level:
        // When _makeProxyRequest returns shouldRetry=true but responseStarted=true,
        // the retry loop should break.
        jest.spyOn(rh, '_makeProxyRequest').mockResolvedValueOnce({
            success: false,
            error: new Error('Rate limited'),
            errorType: 'rate_limited',
            shouldRetry: true,
            responseStarted: true,
            shouldExcludeKey: false
        });

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-response-started', null, Date.now(), trace
        );

        // Should only make one attempt (response started, cannot retry)
        expect(rh._makeProxyRequest).toHaveBeenCalledTimes(1);
    });
});

// ============================================================================
// 3. pool_blocked retry decision
//    Source: lines ~2277-2284 in _makeProxyRequest 429 handler
//    When pool is blocked (wasAlreadyBlocked=true) and no model router
//    alternatives exist, poolBlocked=true, effectiveCanRetry=false.
//    The 429 is passed through to the client.
// ============================================================================
describe('pool_blocked retry decision (deep)', () => {
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

    test('pool blocked without model router passes 429 through', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(429, { 'retry-after': '10' });

        setupHttpsMock(proxyReq, proxyRes);

        // Pool already blocked before this 429
        km.recordPoolRateLimitHit = jest.fn().mockReturnValue({
            pool429Count: 4,
            cooldownMs: 8000,
            wasAlreadyBlocked: true
        });
        km.recordRateLimit = jest.fn().mockReturnValue({});
        km.getPoolCooldownRemainingMs = jest.fn().mockReturnValue(5000);

        // No model router → no alternatives → poolBlocked=true
        rh.modelRouter = null;

        const keyInfo = km.acquireKey();
        const mockRes = createMockRes();
        const body = Buffer.from(JSON.stringify({ model: 'claude-3-haiku', messages: [] }));

        const resultPromise = rh._makeProxyRequest(
            createMockReq({ url: '/v1/messages' }), mockRes, body, keyInfo,
            'req-pool-blocked', null, Date.now(), 0,
            false, null, false, createTraceAttempt(), new Set()
        );

        process.nextTick(() => proxyRes.emit('end'));

        const result = await resultPromise;

        // Pool blocked → passedThrough
        expect(result.passedThrough).toBe(true);
        expect(result.success).toBe(false);
        // Response should be written to client
        expect(mockRes.writeHead).toHaveBeenCalledWith(429, expect.anything());
    });

    test('pool blocked with model router allows retry (pool_blocked_router_retry)', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(429, { 'retry-after': '5' });

        setupHttpsMock(proxyReq, proxyRes);

        km.recordPoolRateLimitHit = jest.fn().mockReturnValue({
            pool429Count: 2,
            cooldownMs: 3000,
            wasAlreadyBlocked: true
        });
        km.recordRateLimit = jest.fn().mockReturnValue({});
        km.getPoolCooldownRemainingMs = jest.fn().mockReturnValue(2000);

        // Model router active → hasRouterAlternatives=true → poolBlocked=false
        rh.modelRouter = {
            selectModel: jest.fn().mockReturnValue({
                model: 'glm-4-plus',
                source: 'pool',
                tier: 'light',
                reason: 'pool routing'
            }),
            recordModelCooldown: jest.fn(),
            recordPool429: jest.fn(),
            acquireModel: jest.fn(),
            releaseModel: jest.fn(),
            config: {
                logDecisions: false,
                cooldown: { burstDampeningFactor: 0.2, defaultMs: 5000 }
            }
        };

        const keyInfo = km.acquireKey();
        const mockRes = createMockRes();
        const body = Buffer.from(JSON.stringify({ model: 'claude-haiku-4-5-20251001', messages: [] }));

        const resultPromise = rh._makeProxyRequest(
            createMockReq({ url: '/v1/messages' }), mockRes, body, keyInfo,
            'req-pool-router-retry', null, Date.now(), 0,
            false, null, false, createTraceAttempt(), new Set()
        );

        process.nextTick(() => proxyRes.emit('end'));

        const result = await resultPromise;

        // With model router: poolBlocked is overridden → retryable
        expect(result.shouldRetry).toBe(true);
        expect(result.passedThrough).toBeUndefined();
        // Response should NOT be written to client (retry expected)
        expect(mockRes.writeHead).not.toHaveBeenCalled();
    });

    test('pool blocked result includes evidence and errorType', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(429, {
            'retry-after': '3',
            'x-request-id': 'upstream-req-123'
        });

        setupHttpsMock(proxyReq, proxyRes);

        km.recordPoolRateLimitHit = jest.fn().mockReturnValue({
            pool429Count: 5,
            cooldownMs: 10000,
            wasAlreadyBlocked: true
        });
        km.recordRateLimit = jest.fn().mockReturnValue({});
        km.getPoolCooldownRemainingMs = jest.fn().mockReturnValue(8000);

        rh.modelRouter = null;

        const keyInfo = km.acquireKey();
        const mockRes = createMockRes();

        const resultPromise = rh._makeProxyRequest(
            createMockReq({ url: '/v1/messages' }), mockRes, Buffer.from('{}'), keyInfo,
            'req-pool-evidence', null, Date.now(), 0,
            false, null, false, createTraceAttempt()
        );

        process.nextTick(() => proxyRes.emit('end'));

        const result = await resultPromise;

        expect(result.errorType).toBe('rate_limited');
        expect(result.passedThrough).toBe(true);
    });
});

// ============================================================================
// 4. useFreshConnection flag
//    Source: lines ~1648-1649 in _proxyWithRetries, lines ~2017-2020 in _makeProxyRequest
//    When socket_hangup returns useFreshConnection=true, the next retry attempt
//    should set agent=false (bypass connection pool).
// ============================================================================
describe('useFreshConnection flag (deep)', () => {
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

    test('useFreshConnection=true causes next retry to use agent=false', async () => {
        // First attempt: socket hangup with useFreshConnection=true
        // Second attempt: success
        jest.spyOn(rh, '_makeProxyRequest')
            .mockResolvedValueOnce({
                success: false,
                error: new Error('socket hang up'),
                errorType: 'socket_hangup',
                shouldExcludeKey: false,
                useFreshConnection: true
            })
            .mockResolvedValueOnce({
                success: true,
                mappedModel: 'glm-4'
            });

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-fresh-conn', null, Date.now(), trace
        );

        // Verify the second call had useFreshConnection=true (param index 10)
        expect(rh._makeProxyRequest).toHaveBeenCalledTimes(2);
        const secondCallArgs = rh._makeProxyRequest.mock.calls[1];
        expect(secondCallArgs[10]).toBe(true); // useFreshConnection parameter
    });

    test('useFreshConnection flag resets after use (not sticky)', async () => {
        // First attempt: socket hangup with useFreshConnection=true
        // Second attempt: another error without useFreshConnection
        // Third attempt: should NOT have useFreshConnection
        jest.spyOn(rh, '_makeProxyRequest')
            .mockResolvedValueOnce({
                success: false,
                error: new Error('socket hang up'),
                errorType: 'socket_hangup',
                shouldExcludeKey: false,
                useFreshConnection: true
            })
            .mockResolvedValueOnce({
                success: false,
                error: new Error('server error'),
                errorType: 'server_error',
                shouldExcludeKey: true
                // No useFreshConnection
            })
            .mockResolvedValueOnce({
                success: true,
                mappedModel: 'glm-4'
            });

        const mockRes = createMockRes();
        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq(), mockRes, Buffer.from('{}'),
            'req-fresh-reset', null, Date.now(), trace
        );

        expect(rh._makeProxyRequest).toHaveBeenCalledTimes(3);
        // Second call: useFreshConnection=true (from first failure)
        expect(rh._makeProxyRequest.mock.calls[1][10]).toBe(true);
        // Third call: useFreshConnection=false (reset after use)
        expect(rh._makeProxyRequest.mock.calls[2][10]).toBe(false);
    });

    test('useFreshConnection triggers agent=false in _makeProxyRequest', async () => {
        // Test at the _makeProxyRequest level: when useFreshConnection=true,
        // https.request should be called with agent: false
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(200, { 'content-type': 'application/json' });

        setupHttpsMock(proxyReq, proxyRes);

        const keyInfo = km.acquireKey();
        const mockRes = createMockRes();
        const body = Buffer.from(JSON.stringify({ model: 'claude-3-haiku', messages: [] }));

        const resultPromise = rh._makeProxyRequest(
            createMockReq({ url: '/v1/messages' }), mockRes, body, keyInfo,
            'req-fresh-agent', null, Date.now(), 0,
            false, null,
            true,  // useFreshConnection=true
            createTraceAttempt(), new Set()
        );

        await flushAsyncWork();
        const result = await resultPromise;

        // Verify https.request was called with agent: false
        expect(https.request).toHaveBeenCalled();
        const requestOptions = https.request.mock.calls[0][0];
        expect(requestOptions.agent).toBe(false);
    });
});

// ============================================================================
// 5. Overall timeout catch block
//    Source: lines ~984-1001 in handleRequest
//    When the request exceeds the total timeout (createTimeout fires before
//    _proxyWithRetries completes), the catch block sends a 504 response.
// ============================================================================
describe('overall timeout catch block (deep)', () => {
    test('very short timeout triggers 504 Gateway timeout', async () => {
        // Use a very short real timeout. The overallTimeout formula is:
        // requestTimeout + (maxRetries * retryConfig.maxDelayMs) + 10000
        // We override retryConfig.maxDelayMs to 0 and use requestTimeout=1 to get
        // overallTimeout = 1 + 0 + 10000 = 10001ms — still too slow.
        //
        // Instead, mock _proxyWithRetries to reject with a timeout error (same pattern
        // as existing test at line 137, but with createTimeout's exact error format).
        const { rh } = createHandler({
            config: {
                maxRetries: 0,
                requestTimeout: 5000,
                maxTotalConcurrency: 10
            }
        });
        jest.spyOn(rh, '_resolveHealthyIP').mockResolvedValue(null);
        jest.spyOn(rh, '_acquireUpstreamSlot').mockResolvedValue();
        jest.spyOn(rh, '_releaseUpstreamSlot').mockImplementation(() => {});

        // Simulate the timeout race winning: _proxyWithRetries promise races against
        // createTimeout promise. When timeout fires, the catch block runs.
        jest.spyOn(rh, '_proxyWithRetries').mockRejectedValueOnce(
            new Error('Request timeout after 15001ms (requestId: test-timeout)')
        );

        const mockRes = createMockRes();

        await rh.handleRequest(createMockReq(), mockRes, Buffer.from('{}'));

        // Lines 993-1001: catch block sends 504
        expect(mockRes.writeHead).toHaveBeenCalledWith(504, expect.objectContaining({
            'content-type': 'application/json'
        }));
        const responseBody = JSON.parse(mockRes.end.mock.calls[0][0]);
        expect(responseBody.error).toBe('Gateway timeout');
        expect(responseBody.message).toBe('Request processing failed');
        expect(responseBody.requestId).toBeDefined();

        rh.destroy();
    });

    test('timeout catch block skips response when headers already sent', async () => {
        const { rh } = createHandler({
            config: {
                maxRetries: 0,
                requestTimeout: 5000,
                maxTotalConcurrency: 10
            }
        });
        jest.spyOn(rh, '_resolveHealthyIP').mockResolvedValue(null);
        jest.spyOn(rh, '_acquireUpstreamSlot').mockResolvedValue();
        jest.spyOn(rh, '_releaseUpstreamSlot').mockImplementation(() => {});

        jest.spyOn(rh, '_proxyWithRetries').mockRejectedValueOnce(
            new Error('Request timeout after 15001ms (requestId: test-timeout)')
        );

        const mockRes = createMockRes();
        mockRes.headersSent = true;

        await rh.handleRequest(createMockReq(), mockRes, Buffer.from('{}'));

        // Should NOT write headers since already sent
        expect(mockRes.writeHead).not.toHaveBeenCalled();

        rh.destroy();
    });

    test('timeout records client request failure when not already tracked', async () => {
        const statsAggregator = {
            recordClientRequestStart: jest.fn(),
            recordClientRequestFailure: jest.fn(),
            recordClientRequestSuccess: jest.fn()
        };

        const { rh } = createHandler({
            config: {
                maxRetries: 0,
                requestTimeout: 5000,
                maxTotalConcurrency: 10
            },
            statsAggregator
        });
        jest.spyOn(rh, '_resolveHealthyIP').mockResolvedValue(null);
        jest.spyOn(rh, '_acquireUpstreamSlot').mockResolvedValue();
        jest.spyOn(rh, '_releaseUpstreamSlot').mockImplementation(() => {});

        jest.spyOn(rh, '_proxyWithRetries').mockRejectedValueOnce(
            new Error('Request timeout after 15001ms (requestId: test-timeout)')
        );

        const mockRes = createMockRes();

        await rh.handleRequest(createMockReq(), mockRes, Buffer.from('{}'));

        // The catch block should track failure when trace._clientTracked is false
        expect(statsAggregator.recordClientRequestFailure).toHaveBeenCalled();

        rh.destroy();
    });
});

// ============================================================================
// Regression: Full test suite sanity check
// ============================================================================
describe('regression sanity checks', () => {
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

    test('successful request through _makeProxyRequest completes normally', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(200, { 'content-type': 'application/json' });

        setupHttpsMock(proxyReq, proxyRes);

        const keyInfo = km.acquireKey();
        const mockRes = createMockRes();
        const body = Buffer.from(JSON.stringify({ model: 'claude-3-haiku', messages: [] }));

        const result = await rh._makeProxyRequest(
            createMockReq({ url: '/v1/messages' }), mockRes, body, keyInfo,
            'req-success', null, Date.now(), 0,
            false, null, false, createTraceAttempt(), new Set()
        );

        expect(result.success).toBe(true);
        expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.anything());
    });

    test('non-429 error flows through standard error path', async () => {
        const proxyReq = createMockProxyReq();
        // No proxyRes — we will emit an error on the proxyReq instead
        https.request.mockImplementation((options, callback) => {
            // Schedule error emission after the handler has set up its event listeners
            // (which happens synchronously after https.request returns)
            setImmediate(() => {
                const err = new Error('connect ECONNREFUSED');
                err.code = 'ECONNREFUSED';
                proxyReq.emit('error', err);
            });
            return proxyReq;
        });

        const keyInfo = km.acquireKey();
        const mockRes = createMockRes();
        const body = Buffer.from(JSON.stringify({ model: 'claude-3-haiku', messages: [] }));

        const result = await rh._makeProxyRequest(
            createMockReq({ url: '/v1/messages' }), mockRes, body, keyInfo,
            'req-error', null, Date.now(), 0,
            false, null, false, createTraceAttempt(), new Set()
        );

        expect(result.success).toBe(false);
        expect(result.errorType).toBe('connection_refused');
    });
});
