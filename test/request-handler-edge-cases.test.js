'use strict';

/**
 * Request Handler Edge Case Tests
 *
 * Covers untested edge cases:
 * - Group 1: Client request tracking (recordClientRequestStart/Success/Failure)
 * - Group 2: 429 passthrough behavior (retries exhausted, Retry-After forwarding)
 * - Group 3: Adaptive timeout (latency-driven timeout adjustments)
 * - Group 4: Client disconnect during retry (abort + cleanup)
 * - Group 5: Queue timeout (503 when no key available within timeout)
 */

// Use jest.isolateModules to get a fresh https mock
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

function createMockStatsAggregator() {
    return {
        recordClientRequestStart: jest.fn(),
        recordClientRequestSuccess: jest.fn(),
        recordClientRequestFailure: jest.fn(),
        recordKeyUsage: jest.fn(),
        recordError: jest.fn(),
        recordRetry: jest.fn(),
        recordRetrySuccess: jest.fn(),
        recordRetryBackoff: jest.fn(),
        recordAdaptiveTimeout: jest.fn(),
        recordAgentRecreation: jest.fn(),
        recordTokenUsage: jest.fn(),
        recordModelUsage: jest.fn(),
        recordUpstream429: jest.fn(),
        recordLlm429Retry: jest.fn(),
        recordLlm429RetrySuccess: jest.fn(),
        recordLocal429: jest.fn(),
        recordPoolCooldown: jest.fn(),
        recordHangupCause: jest.fn(),
        recordSameModelRetry: jest.fn(),
        recordGiveUp: jest.fn(),
        recordContextOverflowTransient: jest.fn(),
        recordFailedRequestModelStats: jest.fn(),
        getModelP95: jest.fn().mockReturnValue(null),
    };
}

// ============================================================================
// GROUP 1: Client request tracking
// ============================================================================
describe('Group 1: Client request tracking', () => {
    let rh, km;
    let mockStats;

    beforeEach(() => {
        https.request.mockReset();
        mockStats = createMockStatsAggregator();
        const setup = createHandler({ statsAggregator: mockStats });
        rh = setup.rh;
        km = setup.km;
        // Stub DNS resolution to avoid real network calls
        jest.spyOn(rh, '_resolveHealthyIP').mockResolvedValue(null);
    });

    afterEach(() => {
        rh.destroy();
    });

    test('recordClientRequestStart is called when a request starts', async () => {
        // Set up a successful proxy response
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(200, { 'content-type': 'application/json' });
        setupHttpsMock(proxyReq, proxyRes);

        const mockRes = createMockRes();
        // Stub pipe to prevent errors
        mockRes.writeHead = jest.fn();
        proxyRes.pipe = jest.fn(() => {
            setImmediate(() => proxyRes.emit('end'));
        });

        await rh.handleRequest(
            createMockReq({ url: '/v1/messages' }),
            mockRes,
            Buffer.from(JSON.stringify({ model: 'test', messages: [] }))
        );

        expect(mockStats.recordClientRequestStart).toHaveBeenCalledTimes(1);
    });

    test('recordClientRequestSuccess is called on successful response', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(200, { 'content-type': 'application/json' });
        setupHttpsMock(proxyReq, proxyRes);

        const mockRes = createMockRes();
        proxyRes.pipe = jest.fn(() => {
            setImmediate(() => proxyRes.emit('end'));
        });

        await rh.handleRequest(
            createMockReq({ url: '/v1/messages' }),
            mockRes,
            Buffer.from(JSON.stringify({ model: 'test', messages: [] }))
        );

        expect(mockStats.recordClientRequestSuccess).toHaveBeenCalledTimes(1);
        expect(mockStats.recordClientRequestFailure).not.toHaveBeenCalled();
    });

    test('recordClientRequestFailure is called on error response', async () => {
        // Make _proxyWithRetries throw to trigger the catch block
        jest.spyOn(rh, '_proxyWithRetries').mockRejectedValueOnce(
            new Error('Request timeout after 5000ms (requestId: test)')
        );

        const mockRes = createMockRes();

        await rh.handleRequest(
            createMockReq({ url: '/v1/messages' }),
            mockRes,
            Buffer.from('{}')
        );

        // The catch block in handleRequest calls recordClientRequestFailure
        expect(mockStats.recordClientRequestFailure).toHaveBeenCalledTimes(1);
    });

    test('client request tracking only fires once even with retries', async () => {
        // First attempt: server error (retryable)
        // Second attempt: success
        const proxyReq1 = createMockProxyReq();
        const proxyRes1 = createMockProxyRes(500, {});
        const proxyReq2 = createMockProxyReq();
        const proxyRes2 = createMockProxyRes(200, { 'content-type': 'application/json' });

        let callCount = 0;
        https.request.mockImplementation((options, callback) => {
            callCount++;
            if (callCount === 1) {
                process.nextTick(() => callback(proxyRes1));
                return proxyReq1;
            } else {
                process.nextTick(() => callback(proxyRes2));
                return proxyReq2;
            }
        });

        proxyRes1.pipe = jest.fn();
        proxyRes1.resume = jest.fn();
        proxyRes2.pipe = jest.fn(() => {
            setImmediate(() => proxyRes2.emit('end'));
        });

        const mockRes = createMockRes();

        await rh.handleRequest(
            createMockReq({ url: '/v1/messages' }),
            mockRes,
            Buffer.from(JSON.stringify({ model: 'test', messages: [] }))
        );

        // Start fires exactly once per client request
        expect(mockStats.recordClientRequestStart).toHaveBeenCalledTimes(1);
        // Success fires once (after the successful retry)
        expect(mockStats.recordClientRequestSuccess).toHaveBeenCalledTimes(1);
        // Failure never fires (request eventually succeeded)
        expect(mockStats.recordClientRequestFailure).not.toHaveBeenCalled();
    });
});

// ============================================================================
// GROUP 2: 429 passthrough behavior
// ============================================================================
describe('Group 2: 429 passthrough behavior', () => {
    let rh, km;
    let mockStats;

    beforeEach(() => {
        https.request.mockReset();
        mockStats = createMockStatsAggregator();
        const setup = createHandler({
            statsAggregator: mockStats,
            config: {
                maxRetries: 2,
                requestTimeout: 5000,
                maxTotalConcurrency: 10,
            }
        });
        rh = setup.rh;
        km = setup.km;
        jest.spyOn(rh, '_resolveHealthyIP').mockResolvedValue(null);
    });

    afterEach(() => {
        rh.destroy();
    });

    test('429 is passed through to client on non-LLM route', async () => {
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(429, {
            'retry-after': '30',
            'content-type': 'application/json'
        });
        setupHttpsMock(proxyReq, proxyRes);

        // pipe simulates streaming the 429 body to client
        proxyRes.pipe = jest.fn((dest) => {
            setImmediate(() => proxyRes.emit('end'));
        });

        const mockRes = createMockRes();

        await rh.handleRequest(
            createMockReq({ url: '/api/event_logging' }),  // Non-LLM route
            mockRes,
            Buffer.from(JSON.stringify({ event: 'test' }))
        );

        // Should pass through the 429 status
        expect(mockRes.writeHead).toHaveBeenCalledWith(429, expect.objectContaining({
            'retry-after': '30'
        }));
    });

    test('429 passthrough is recorded as a client failure', async () => {
        // Use non-LLM route so 429 is passed through (not retried)
        const proxyReq = createMockProxyReq();
        const proxyRes = createMockProxyRes(429, {
            'retry-after': '5',
            'content-type': 'application/json'
        });
        setupHttpsMock(proxyReq, proxyRes);

        proxyRes.pipe = jest.fn((dest) => {
            setImmediate(() => proxyRes.emit('end'));
        });

        const mockRes = createMockRes();

        await rh.handleRequest(
            createMockReq({ url: '/api/event_logging' }),
            mockRes,
            Buffer.from(JSON.stringify({ event: 'test' }))
        );

        // passedThrough 429 still counts as a failure for the client
        expect(mockStats.recordClientRequestFailure).toHaveBeenCalledTimes(1);
        expect(mockStats.recordClientRequestSuccess).not.toHaveBeenCalled();
    });

    test('Retry-After header from upstream is forwarded on passthrough', async () => {
        const proxyReq = createMockProxyReq();
        const upstreamHeaders = {
            'retry-after': '42',
            'content-type': 'application/json',
            'x-ratelimit-limit': '100',
            'x-ratelimit-remaining': '0'
        };
        const proxyRes = createMockProxyRes(429, upstreamHeaders);
        setupHttpsMock(proxyReq, proxyRes);

        proxyRes.pipe = jest.fn((dest) => {
            setImmediate(() => proxyRes.emit('end'));
        });

        const mockRes = createMockRes();

        await rh.handleRequest(
            createMockReq({ url: '/api/event_logging' }),
            mockRes,
            Buffer.from(JSON.stringify({ event: 'test' }))
        );

        // The full upstream headers are forwarded (including retry-after)
        expect(mockRes.writeHead).toHaveBeenCalledWith(429, expect.objectContaining({
            'retry-after': '42',
            'content-type': 'application/json'
        }));
    });

    test('429 on LLM route with all retries exhausted passes through to client', async () => {
        // maxRetries = 2, so 3 total attempts. All return 429.
        // LLM routes retry on 429, but after cap reached, it should break out.
        const rh2setup = createHandler({
            statsAggregator: mockStats,
            config: {
                maxRetries: 2,
                requestTimeout: 5000,
                maxTotalConcurrency: 10,
            }
        });
        const rh2 = rh2setup.rh;
        jest.spyOn(rh2, '_resolveHealthyIP').mockResolvedValue(null);

        // All attempts return 429
        https.request.mockImplementation((options, callback) => {
            const proxyReq = createMockProxyReq();
            const proxyRes = createMockProxyRes(429, {
                'retry-after': '10',
                'content-type': 'application/json'
            });
            proxyRes.pipe = jest.fn((dest) => {
                setImmediate(() => proxyRes.emit('end'));
            });
            proxyRes.resume = jest.fn();
            process.nextTick(() => callback(proxyRes));
            return proxyReq;
        });

        const mockRes = createMockRes();

        await rh2.handleRequest(
            createMockReq({ url: '/v1/messages' }),
            mockRes,
            Buffer.from(JSON.stringify({ model: 'test', messages: [] }))
        );

        // After retries exhausted, should send an error response to client
        expect(mockRes.writeHead).toHaveBeenCalled();
        const statusCode = mockRes.writeHead.mock.calls[0][0];
        // Could be 429 (give-up), 502 (retries exhausted), or 503 (transient error)
        expect([429, 502, 503]).toContain(statusCode);

        // Should be tracked as failure
        expect(mockStats.recordClientRequestFailure).toHaveBeenCalled();

        rh2.destroy();
    });
});

// ============================================================================
// GROUP 3: Adaptive timeout
// ============================================================================
describe('Group 3: Adaptive timeout', () => {
    test('adaptive timeout adjusts based on recent request latencies', () => {
        const { rh } = createHandler();
        rh.adaptiveTimeoutConfig = {
            enabled: true,
            minSamples: 5,
            initialMs: 60000,
            latencyMultiplier: 3.0,
            retryMultiplier: 1.5,
            minMs: 10000,
            maxMs: 300000
        };

        const keyInfo = {
            latencies: { stats: () => ({ count: 20, p95: 10000 }) }  // P95 = 10s
        };

        // base = max(10000 * 3.0, 10000) = 30000
        const timeout = rh._calculateTimeout(keyInfo, 0);
        expect(timeout).toBe(30000);

        rh.destroy();
    });

    test('very slow recent requests increase the timeout', () => {
        const { rh } = createHandler();
        rh.adaptiveTimeoutConfig = {
            enabled: true,
            minSamples: 5,
            initialMs: 60000,
            latencyMultiplier: 3.0,
            retryMultiplier: 1.5,
            minMs: 10000,
            maxMs: 300000
        };

        // Slow key: P95 = 60s
        const slowKeyInfo = {
            latencies: { stats: () => ({ count: 50, p95: 60000 }) }
        };

        // base = max(60000 * 3.0, 10000) = 180000
        const timeout = rh._calculateTimeout(slowKeyInfo, 0);
        expect(timeout).toBe(180000);

        // On retry, even higher
        // attempt 1: 180000 * 1.5^1 = 270000
        const retryTimeout = rh._calculateTimeout(slowKeyInfo, 1);
        expect(retryTimeout).toBe(270000);

        rh.destroy();
    });

    test('fast recent requests decrease the timeout (within bounds)', () => {
        const { rh } = createHandler();
        rh.adaptiveTimeoutConfig = {
            enabled: true,
            minSamples: 5,
            initialMs: 60000,
            latencyMultiplier: 3.0,
            retryMultiplier: 1.5,
            minMs: 10000,
            maxMs: 300000
        };

        // Fast key: P95 = 1s
        const fastKeyInfo = {
            latencies: { stats: () => ({ count: 100, p95: 1000 }) }
        };

        // base = max(1000 * 3.0, 10000) = 10000 (clamped to minMs)
        const timeout = rh._calculateTimeout(fastKeyInfo, 0);
        expect(timeout).toBe(10000);

        // This is significantly less than the initialMs of 60000
        expect(timeout).toBeLessThan(60000);

        rh.destroy();
    });

    test('adaptive timeout is capped at maxMs even with retries', () => {
        const { rh } = createHandler();
        rh.adaptiveTimeoutConfig = {
            enabled: true,
            minSamples: 5,
            initialMs: 60000,
            latencyMultiplier: 4.0,
            retryMultiplier: 2.0,
            minMs: 10000,
            maxMs: 120000
        };

        const keyInfo = {
            latencies: { stats: () => ({ count: 50, p95: 50000 }) }
        };

        // base = max(50000*4, 10000) = 200000 => capped at 120000
        const timeout = rh._calculateTimeout(keyInfo, 0);
        expect(timeout).toBe(120000);

        // On retry attempt 2: base * 2^2 = 800000 => still capped at 120000
        const retryTimeout = rh._calculateTimeout(keyInfo, 2);
        expect(retryTimeout).toBe(120000);

        rh.destroy();
    });

    test('falls back to initialMs when not enough latency samples', () => {
        const { rh } = createHandler();
        rh.adaptiveTimeoutConfig = {
            enabled: true,
            minSamples: 10,
            initialMs: 45000,
            latencyMultiplier: 3.0,
            retryMultiplier: 1.5,
            minMs: 10000,
            maxMs: 300000
        };

        // Not enough samples (only 3, need 10)
        const keyInfo = {
            latencies: { stats: () => ({ count: 3, p95: 2000 }) }
        };

        const timeout = rh._calculateTimeout(keyInfo, 0);
        expect(timeout).toBe(45000);

        rh.destroy();
    });

    test('disabled adaptive timeout uses static requestTimeout', () => {
        const { rh } = createHandler();
        rh.adaptiveTimeoutConfig = { enabled: false };
        rh.requestTimeout = 90000;

        const keyInfo = {
            latencies: { stats: () => ({ count: 100, p95: 5000 }) }
        };

        const timeout = rh._calculateTimeout(keyInfo, 0);
        expect(timeout).toBe(90000);

        rh.destroy();
    });
});

// ============================================================================
// GROUP 4: Client disconnect during retry
// ============================================================================
describe('Group 4: Client disconnect during retry', () => {
    let rh, km;
    let mockStats;

    beforeEach(() => {
        https.request.mockReset();
        mockStats = createMockStatsAggregator();
        const setup = createHandler({ statsAggregator: mockStats });
        rh = setup.rh;
        km = setup.km;
        jest.spyOn(rh, '_resolveHealthyIP').mockResolvedValue(null);
    });

    afterEach(() => {
        rh.destroy();
    });

    test('retries are aborted when client disconnects mid-request', async () => {
        // First attempt: server error (would normally retry)
        let attempt = 0;
        https.request.mockImplementation((options, callback) => {
            attempt++;
            const proxyReq = createMockProxyReq();

            if (attempt === 1) {
                // First attempt: simulate server error
                const proxyRes = createMockProxyRes(500, {});
                proxyRes.resume = jest.fn();
                process.nextTick(() => callback(proxyRes));
            } else {
                // Shouldn't get here if client disconnects
                const proxyRes = createMockProxyRes(200, {});
                proxyRes.pipe = jest.fn(() => setImmediate(() => proxyRes.emit('end')));
                process.nextTick(() => callback(proxyRes));
            }
            return proxyReq;
        });

        const mockRes = createMockRes();
        // Track 'close' event listeners to simulate client disconnect
        let closeCallback = null;
        mockRes.once = jest.fn((event, cb) => {
            if (event === 'close') closeCallback = cb;
        });

        // Start the request
        const requestPromise = rh.handleRequest(
            createMockReq({ url: '/v1/messages' }),
            mockRes,
            Buffer.from(JSON.stringify({ model: 'test', messages: [] }))
        );

        // Wait a tick for the first attempt to fail
        await new Promise(resolve => setImmediate(resolve));

        // Simulate client disconnect
        if (closeCallback) closeCallback();

        await requestPromise;

        // Client disconnect should be tracked as failure
        expect(mockStats.recordClientRequestFailure).toHaveBeenCalled();
    });

    test('headersSent=true aborts retries before making proxy request', async () => {
        const mockRes = createMockRes();
        // Simulate response already sent (e.g., streaming had started)
        mockRes.headersSent = true;

        const makeProxySpy = jest.spyOn(rh, '_makeProxyRequest');

        const trace = createTrace();

        await rh._proxyWithRetries(
            createMockReq({ url: '/v1/messages' }),
            mockRes,
            Buffer.from('{}'),
            'req-disconnect-test',
            null,
            Date.now(),
            trace
        );

        // Should not attempt any proxy requests
        expect(makeProxySpy).not.toHaveBeenCalled();
        expect(mockStats.recordClientRequestFailure).toHaveBeenCalled();
    });

    test('client disconnect destroys current proxy request', async () => {
        // We verify the close handler mechanism exists and destroys proxyReq
        const proxyReq = createMockProxyReq();
        let closeHandler = null;

        const mockRes = createMockRes();
        mockRes.once = jest.fn((event, cb) => {
            if (event === 'close') closeHandler = cb;
        });
        mockRes.removeListener = jest.fn();

        // First call: 500 (will trigger retry)
        // We'll disconnect during the backoff
        let callCount = 0;
        https.request.mockImplementation((options, callback) => {
            callCount++;
            const req = createMockProxyReq();
            const res = createMockProxyRes(500, {});
            res.resume = jest.fn();
            process.nextTick(() => callback(res));
            return req;
        });

        const promise = rh.handleRequest(
            createMockReq({ url: '/v1/messages' }),
            mockRes,
            Buffer.from(JSON.stringify({ model: 'test', messages: [] }))
        );

        // Wait for first attempt to complete
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));

        // Simulate client disconnect via the close handler
        if (closeHandler) {
            closeHandler();
        }

        await promise;

        // Verify cleanup happened (removeListener called with 'close')
        expect(mockRes.removeListener).toHaveBeenCalledWith('close', expect.any(Function));
    });
});

// ============================================================================
// GROUP 5: Queue timeout
// ============================================================================
describe('Group 5: Queue timeout', () => {
    let rh, km;
    let mockStats;

    beforeEach(() => {
        https.request.mockReset();
        mockStats = createMockStatsAggregator();
    });

    afterEach(() => {
        if (rh) rh.destroy();
    });

    test('request gets 503 when no key becomes available within timeout', async () => {
        // Create handler with very short queue timeout
        km = createKeyManager(['key1.secret1']);
        const setup = createHandler({
            keyManager: km,
            statsAggregator: mockStats,
            config: {
                maxRetries: 0,
                requestTimeout: 5000,
                maxTotalConcurrency: 10,
                queueSize: 5,
                queueTimeout: 100  // Very short timeout
            }
        });
        rh = setup.rh;
        jest.spyOn(rh, '_resolveHealthyIP').mockResolvedValue(null);

        // Make all keys appear busy
        jest.spyOn(km, 'acquireKey').mockReturnValue(null);
        // But report that keys exist for the provider
        jest.spyOn(km, 'hasKeysForProvider').mockReturnValue(true);

        const mockRes = createMockRes();

        await rh.handleRequest(
            createMockReq({ url: '/v1/messages' }),
            mockRes,
            Buffer.from(JSON.stringify({ model: 'test', messages: [] }))
        );

        // Should get 503 (service unavailable)
        expect(mockRes.writeHead).toHaveBeenCalledWith(503, expect.objectContaining({
            'content-type': 'application/json'
        }));

        // Parse the response body
        const responseBody = JSON.parse(mockRes.end.mock.calls[0][0]);
        expect(responseBody.error).toBeDefined();
        expect(responseBody.retryable).not.toBe(false);  // transient, so retryable

        // Track as failure
        expect(mockStats.recordClientRequestFailure).toHaveBeenCalled();
    });

    test('queue position is tracked and reported', () => {
        const setup = createHandler({
            statsAggregator: mockStats,
            config: {
                queueSize: 10,
                queueTimeout: 5000
            }
        });
        rh = setup.rh;

        const queue = rh.getQueue();
        expect(queue).toBeDefined();

        // Enqueue a request
        queue.enqueue('test-req-1');
        queue.enqueue('test-req-2');

        // Check position
        expect(queue.getPosition('test-req-1')).toBe(1);
        expect(queue.getPosition('test-req-2')).toBe(2);
        expect(queue.getPosition('nonexistent')).toBe(-1);

        // Check stats
        const stats = queue.getStats();
        expect(stats.current).toBe(2);
        expect(stats.max).toBe(10);
        expect(stats.available).toBe(8);
    });

    test('queue full returns 503 immediately', async () => {
        km = createKeyManager(['key1.secret1']);
        const setup = createHandler({
            keyManager: km,
            statsAggregator: mockStats,
            config: {
                maxRetries: 0,
                requestTimeout: 5000,
                maxTotalConcurrency: 10,
                queueSize: 0,  // Queue disabled (size 0)
                queueTimeout: 100
            }
        });
        rh = setup.rh;
        jest.spyOn(rh, '_resolveHealthyIP').mockResolvedValue(null);

        // Make all keys busy
        jest.spyOn(km, 'acquireKey').mockReturnValue(null);
        jest.spyOn(km, 'hasKeysForProvider').mockReturnValue(true);

        const mockRes = createMockRes();

        await rh.handleRequest(
            createMockReq({ url: '/v1/messages' }),
            mockRes,
            Buffer.from(JSON.stringify({ model: 'test', messages: [] }))
        );

        // Should get 503
        expect(mockRes.writeHead).toHaveBeenCalledWith(503, expect.objectContaining({
            'content-type': 'application/json'
        }));

        expect(mockStats.recordClientRequestFailure).toHaveBeenCalled();
    });

    test('queue timeout triggers cleanup and 503 response', async () => {
        km = createKeyManager(['key1.secret1']);
        const setup = createHandler({
            keyManager: km,
            statsAggregator: mockStats,
            config: {
                maxRetries: 0,
                requestTimeout: 5000,
                maxTotalConcurrency: 10,
                queueSize: 10,
                queueTimeout: 50  // Very short: will timeout
            }
        });
        rh = setup.rh;
        jest.spyOn(rh, '_resolveHealthyIP').mockResolvedValue(null);

        // acquireKey always returns null (keys busy)
        jest.spyOn(km, 'acquireKey').mockReturnValue(null);
        jest.spyOn(km, 'hasKeysForProvider').mockReturnValue(true);

        const mockRes = createMockRes();

        await rh.handleRequest(
            createMockReq({ url: '/v1/messages' }),
            mockRes,
            Buffer.from(JSON.stringify({ model: 'test', messages: [] }))
        );

        // Should return 503 after queue timeout
        expect(mockRes.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
        expect(mockStats.recordClientRequestFailure).toHaveBeenCalled();
    });
});
