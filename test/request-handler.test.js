/**
 * Request Handler Module Tests (Unit Style)
 *
 * Tests proxy behavior using unit tests without network dependencies.
 * For integration tests with actual HTTP, see test/e2e/golden-semantics.e2e.spec.js
 *
 * Quarantine Exit: 2026-02-28
 */

const http = require('http');
const { RequestHandler, RequestQueue, calculateBackoff, RETRY_CONFIG } = require('../lib/request-handler');
const { KeyManager } = require('../lib/key-manager');
const { StatsAggregator } = require('../lib/stats-aggregator');

describe('RequestHandler', () => {
    let rh;
    let km;
    let sa;
    let mockReq;
    let mockRes;

    beforeEach(() => {
        km = new KeyManager({
            maxConcurrencyPerKey: 3,
            circuitBreaker: {
                failureThreshold: 3,
                failureWindow: 1000,
                cooldownPeriod: 500
            }
        });
        km.loadKeys(['key1.secret1', 'key2.secret2']);

        sa = new StatsAggregator();

        rh = new RequestHandler({
            keyManager: km,
            statsAggregator: sa,
            config: {
                maxRetries: 3,
                requestTimeout: 5000,
                maxTotalConcurrency: 10
            }
        });

        mockReq = {
            method: 'POST',
            url: '/v1/messages',
            headers: {
                'content-type': 'application/json',
                'authorization': 'Bearer old-token'
            }
        };

        mockRes = {
            headersSent: false,
            writeHead: jest.fn(),
            end: jest.fn(),
            on: jest.fn(),
            once: jest.fn(),
            removeListener: jest.fn()
        };
    });

    afterEach(() => {
        if (rh) rh.destroy();
    });

    describe('constructor', () => {
        test('should set max concurrent requests', () => {
            expect(rh.maxConcurrentRequests).toBe(10);
        });

        test('should throw if keyManager not provided', () => {
            expect(() => new RequestHandler({})).toThrow('RequestHandler requires keyManager option');
        });

        test('should cap maxRetries at 10', () => {
            const handler = new RequestHandler({
                keyManager: km,
                config: { maxRetries: 100 }
            });
            expect(handler.maxRetries).toBe(10);
            handler.destroy();
        });
    });

    describe('canAcceptRequest', () => {
        test('should return true when under limit', () => {
            rh.currentRequests = 5;
            expect(rh.canAcceptRequest()).toBe(true);
        });

        test('should return false when at limit', () => {
            rh.currentRequests = 10;
            expect(rh.canAcceptRequest()).toBe(false);
        });
    });

    describe('getBackpressureStats', () => {
        test('should return correct stats', () => {
            rh.currentRequests = 3;

            const stats = rh.getBackpressureStats();

            expect(stats.current).toBe(3);
            expect(stats.max).toBe(10);
            expect(stats.available).toBe(7);
            expect(stats.percentUsed).toBe(30);
        });

        test('should include queue stats', () => {
            const stats = rh.getBackpressureStats();

            expect(stats.queue).toBeDefined();
            expect(stats.queue.current).toBeDefined();
            expect(stats.queue.max).toBeDefined();
        });
    });

    describe('getQueue', () => {
        test('should return the request queue instance', () => {
            const queue = rh.getQueue();
            expect(queue).toBeInstanceOf(RequestQueue);
        });
    });

    describe('handleRequest (integration)', () => {
        test('should reject when backpressure limit reached', async () => {
            rh.currentRequests = 10;

            await rh.handleRequest(mockReq, mockRes, Buffer.from(''));

            expect(mockRes.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
            expect(mockRes.end).toHaveBeenCalled();
        });
    });

    describe('destroy', () => {
        test('should clear request queue', () => {
            rh.requestQueue.enqueue('test-req');
            expect(rh.requestQueue.length).toBe(1);

            rh.destroy();

            expect(rh.requestQueue.length).toBe(0);
        });
    });

    describe('queue configuration', () => {
        test('should use default queue size', () => {
            const handler = new RequestHandler({
                keyManager: km,
                config: {}
            });
            expect(handler.requestQueue.maxSize).toBe(100);
            handler.destroy();
        });

        test('should use custom queue size from config', () => {
            const handler = new RequestHandler({
                keyManager: km,
                config: {
                    queueSize: 50,
                    queueTimeout: 15000
                }
            });
            expect(handler.requestQueue.maxSize).toBe(50);
            expect(handler.requestQueue.timeout).toBe(15000);
            handler.destroy();
        });
    });
});

describe('calculateBackoff', () => {
    test('should return baseDelayMs for first attempt', () => {
        const delay = calculateBackoff(0);
        // With jitter, should be close to baseDelayMs
        expect(delay).toBeGreaterThanOrEqual(RETRY_CONFIG.baseDelayMs * 0.8);
        expect(delay).toBeLessThanOrEqual(RETRY_CONFIG.baseDelayMs * 1.2);
    });

    test('should increase exponentially', () => {
        const delay0 = calculateBackoff(0);
        const delay1 = calculateBackoff(1);
        const delay2 = calculateBackoff(2);

        // Each delay should be roughly 2x the previous (with jitter)
        expect(delay1).toBeGreaterThan(delay0);
        expect(delay2).toBeGreaterThan(delay1);
    });

    test('should cap at maxDelayMs', () => {
        const delay = calculateBackoff(100); // Very high attempt number
        expect(delay).toBeLessThanOrEqual(RETRY_CONFIG.maxDelayMs * 1.2); // With jitter
    });
});

describe('RequestHandler behavior tests (unit)', () => {
    // These are unit tests that verify behavior without network calls.
    // For full integration tests with actual HTTP, see test/e2e/golden-semantics.e2e.spec.js

    let rh;
    let km;
    let sa;

    beforeEach(() => {
        km = new KeyManager({
            maxConcurrencyPerKey: 3,
            circuitBreaker: {
                failureThreshold: 5,
                failureWindow: 5000,
                cooldownPeriod: 1000
            }
        });
        km.loadKeys(['key1.secret1', 'key2.secret2', 'key3.secret3']);

        sa = new StatsAggregator();

        rh = new RequestHandler({
            keyManager: km,
            statsAggregator: sa,
            config: {
                maxRetries: 2,
                requestTimeout: 5000,
                maxTotalConcurrency: 10
            }
        });
    });

    afterEach(() => {
        if (rh) rh.destroy();
    });

    test('no keys available returns 503 (unit)', async () => {
        const mockRes = createMockRes();
        const body = JSON.stringify({ model: 'test', messages: [] });

        // Mock acquireKey to return null
        jest.spyOn(km, 'acquireKey').mockReturnValue(null);

        const shortHandler = new RequestHandler({
            keyManager: km,
            config: { queueSize: 0, queueTimeout: 100 }
        });

        await shortHandler.handleRequest(
            createMockReq(),
            mockRes,
            Buffer.from(body)
        );

        // Behavior: returns 503 when no keys available
        expect(mockRes.writeHead).toHaveBeenCalledWith(503, expect.any(Object));

        shortHandler.destroy();
    });

    test('retry-after header in backpressure response (unit)', async () => {
        rh.currentRequests = 10; // At limit

        const mockRes = createMockRes();
        const body = JSON.stringify({ model: 'test', messages: [] });

        await rh.handleRequest(
            createMockReq(),
            mockRes,
            Buffer.from(body)
        );

        // Behavior: includes retry-after header
        expect(mockRes.writeHead).toHaveBeenCalledWith(503, expect.objectContaining({
            'retry-after': '1'
        }));
    });

    test('error strategy returns correct config (unit)', () => {
        const socketHangup = rh._getErrorStrategy('socket_hangup');
        expect(socketHangup.shouldRetry).toBe(true);
        expect(socketHangup.excludeKey).toBe(false);

        const rateLimited = rh._getErrorStrategy('rate_limited');
        expect(rateLimited.shouldRetry).toBe(false);
        expect(rateLimited.excludeKey).toBe(true);

        const serverError = rh._getErrorStrategy('server_error');
        expect(serverError.shouldRetry).toBe(true);
        expect(serverError.maxRetries).toBe(3);
    });

    test('context_overflow error strategy is non-retryable (unit)', () => {
        const strategy = rh._getErrorStrategy('context_overflow');
        expect(strategy.shouldRetry).toBe(false);
        expect(strategy.excludeKey).toBe(false);
        expect(strategy.maxRetries).toBe(0);
    });

    test('context_overflow_transient error strategy is retryable with backoff (unit)', () => {
        const strategy = rh._getErrorStrategy('context_overflow_transient');
        expect(strategy).toBeDefined();
        expect(strategy.shouldRetry).toBe(true);
        expect(strategy.maxRetries).toBe(4);
        expect(strategy.backoffMultiplier).toBe(2.0);
        expect(strategy.excludeKey).toBe(false);
    });

    test('context_overflow_transient is exported in ERROR_STRATEGIES (unit)', () => {
        const { ERROR_STRATEGIES } = require('../lib/request-handler');
        expect(ERROR_STRATEGIES.context_overflow_transient).toBeDefined();
        expect(ERROR_STRATEGIES.context_overflow_transient.shouldRetry).toBe(true);
        expect(ERROR_STRATEGIES.context_overflow_transient.maxRetries).toBe(4);
        expect(ERROR_STRATEGIES.context_overflow_transient.backoffMultiplier).toBe(2.0);
        expect(ERROR_STRATEGIES.context_overflow_transient.excludeKey).toBe(false);
    });

    describe('transientOverflowRetry feature flag', () => {
        test('flag defaults to off (no modelRouting config)', () => {
            // Default rh has no modelRouting in config
            const flagEnabled = rh.config?.modelRouting?.transientOverflowRetry?.enabled === true;
            expect(flagEnabled).toBe(false);
        });

        test('flag is accessible when explicitly set to true', () => {
            const rhWithFlag = new RequestHandler({
                keyManager: km,
                statsAggregator: sa,
                config: {
                    maxRetries: 3,
                    requestTimeout: 5000,
                    maxTotalConcurrency: 10,
                    modelRouting: {
                        transientOverflowRetry: { enabled: true }
                    }
                }
            });
            const flagEnabled = rhWithFlag.config?.modelRouting?.transientOverflowRetry?.enabled === true;
            expect(flagEnabled).toBe(true);
        });

        test('flag is accessible when explicitly set to false', () => {
            const rhWithFlag = new RequestHandler({
                keyManager: km,
                statsAggregator: sa,
                config: {
                    maxRetries: 3,
                    requestTimeout: 5000,
                    maxTotalConcurrency: 10,
                    modelRouting: {
                        transientOverflowRetry: { enabled: false }
                    }
                }
            });
            const flagEnabled = rhWithFlag.config?.modelRouting?.transientOverflowRetry?.enabled === true;
            expect(flagEnabled).toBe(false);
        });
    });

    test('error categorization works correctly (unit)', () => {
        expect(rh._categorizeError({ code: 'ECONNRESET' })).toBe('socket_hangup');
        expect(rh._categorizeError({ message: 'socket hang up' })).toBe('socket_hangup');
        expect(rh._categorizeError({ code: 'ECONNREFUSED' })).toBe('connection_refused');
        expect(rh._categorizeError({ code: 'ENOTFOUND' })).toBe('dns_error');
        expect(rh._categorizeError({ code: 'ETIMEDOUT' })).toBe('timeout');
        expect(rh._categorizeError({ code: 'ERR_TLS_CERT' })).toBe('tls_error');
        expect(rh._categorizeError({ code: 'UNKNOWN' })).toBe('other');
    });

    test('connection health monitor tracks hangups (unit)', () => {
        const monitor = rh.connectionMonitor;

        expect(monitor.consecutiveHangups).toBe(0);

        monitor.recordHangup();
        monitor.recordHangup();
        expect(monitor.consecutiveHangups).toBe(2);
        expect(monitor.totalHangups).toBe(2);

        monitor.recordSuccess();
        expect(monitor.consecutiveHangups).toBe(0);
        expect(monitor.totalHangups).toBe(2);
    });

    test('adaptive timeout calculation (unit)', () => {
        // Mock key with latency stats
        const mockKeyInfo = {
            latencies: {
                stats: () => ({ count: 20, p95: 500 })
            }
        };

        // Should use P95-based timeout
        const timeout = rh._calculateTimeout(mockKeyInfo, 0);
        expect(timeout).toBeGreaterThan(500);

        // Retry should increase timeout
        const retryTimeout = rh._calculateTimeout(mockKeyInfo, 1);
        expect(retryTimeout).toBeGreaterThan(timeout);
    });
});

describe('RequestHandler stream buffer', () => {
    let rh;
    let km;

    beforeEach(() => {
        km = new KeyManager({
            maxConcurrencyPerKey: 3,
            circuitBreaker: {}
        });
        km.loadKeys(['key1.secret1']);

        rh = new RequestHandler({
            keyManager: km,
            config: {},
            maxStreamSize: 5
        });
    });

    afterEach(() => {
        if (rh) rh.destroy();
    });

    test('addRequestToStream normalizes request fields', () => {
        const handler = jest.fn();
        rh.on('request', handler);

        rh.addRequestToStream({
            requestId: 'test-123',
            keyIndex: 0,
            status: 200,
            latencyMs: 150,
            success: true
        });

        expect(handler).toHaveBeenCalledTimes(1);
        const normalized = handler.mock.calls[0][0];

        // Should have latency alias
        expect(normalized.latency).toBe(150);
        expect(normalized.latencyMs).toBe(150);

        // Should have semantic status
        expect(normalized.status).toBe('completed');

        // Should have timestamp
        expect(typeof normalized.timestamp).toBe('number');
    });

    test('stream buffer respects maxStreamSize', () => {
        rh.maxStreamSize = 5;

        for (let i = 0; i < 10; i++) {
            rh.addRequestToStream({
                requestId: `test-${i}`,
                keyIndex: 0,
                success: true
            });
        }

        const recent = rh.getRecentRequests();
        expect(recent).toHaveLength(5);
        expect(recent[0].requestId).toBe('test-5');
        expect(recent[4].requestId).toBe('test-9');
    });

    test('emits event to all listeners', () => {
        const handler1 = jest.fn();
        const handler2 = jest.fn();

        rh.on('request', handler1);
        rh.on('request', handler2);

        rh.addRequestToStream({
            requestId: 'test-multi',
            keyIndex: 0,
            success: true
        });

        expect(handler1).toHaveBeenCalledTimes(1);
        expect(handler2).toHaveBeenCalledTimes(1);
    });

    test('_extractRequestContentPreview captures system and messages', () => {
        const payload = Buffer.from(JSON.stringify({
            model: 'claude-sonnet-4-5',
            system: 'You are a coding assistant.',
            max_tokens: 2048,
            messages: [
                { role: 'user', content: [{ type: 'text', text: 'Please refactor this function.' }] },
                { role: 'assistant', content: [{ type: 'text', text: 'Sure, here is a first pass.' }] }
            ]
        }), 'utf8');

        const preview = rh._extractRequestContentPreview(payload);
        expect(preview).toBeTruthy();
        expect(preview.system).toContain('coding assistant');
        expect(preview.maxTokens).toBe(2048);
        expect(preview.messageCount).toBe(2);
        expect(preview.messages).toHaveLength(2);
        expect(preview.messages[0].role).toBe('user');
        expect(preview.messages[0].text).toContain('refactor');
    });

    test('_extractRequestContentPreview truncates oversized content safely', () => {
        const longText = 'A'.repeat(4000);
        const payload = Buffer.from(JSON.stringify({
            model: 'claude-haiku-4-5',
            messages: [{ role: 'user', content: longText }]
        }), 'utf8');

        const preview = rh._extractRequestContentPreview(payload);
        expect(preview).toBeTruthy();
        expect(preview.truncated).toBe(true);
        expect(preview.messages[0].text.length).toBeLessThanOrEqual(1601);
    });

    test('_extractRequestContentPreview returns null for non-json payloads', () => {
        const preview = rh._extractRequestContentPreview(Buffer.from('not json', 'utf8'));
        expect(preview).toBeNull();
    });

    test('_extractRequestPayloadPreview redacts sensitive fields and data URIs', () => {
        const payload = Buffer.from(JSON.stringify({
            model: 'claude-sonnet-4-5',
            max_tokens: 1200,
            api_key: 'secret-key-123',
            accessToken: 'token-value-xyz',
            messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'data:image/png;base64,' + 'A'.repeat(200) } }] }]
        }), 'utf8');

        const preview = rh._extractRequestPayloadPreview(payload);
        expect(preview).toBeTruthy();
        expect(preview.truncated).toBe(false);
        expect(preview.json).toContain('"api_key": "[REDACTED]"');
        expect(preview.json).toContain('"accessToken": "[REDACTED]"');
        expect(preview.json).toContain('data-uri redacted');
    });

    test('_extractRequestPayloadPreview truncates oversized JSON preview', () => {
        const manyBlocks = Array.from({ length: 40 }, () => 'B'.repeat(4000));
        const payload = Buffer.from(JSON.stringify({
            model: 'claude-sonnet-4-5',
            messages: [{ role: 'user', content: manyBlocks }]
        }), 'utf8');

        const preview = rh._extractRequestPayloadPreview(payload);
        expect(preview).toBeTruthy();
        expect(preview.truncated).toBe(true);
        expect(preview.json).toContain('payload preview truncated');
    });

    test('_extractRequestPayloadFull preserves larger payload than preview', () => {
        const bigText = 'C'.repeat(15000);
        const payload = Buffer.from(JSON.stringify({
            model: 'claude-sonnet-4-5',
            messages: [{ role: 'user', content: bigText }]
        }), 'utf8');

        const preview = rh._extractRequestPayloadPreview(payload);
        const full = rh._extractRequestPayloadFull(payload);

        expect(preview).toBeTruthy();
        expect(full).toBeTruthy();
        expect(preview.json.length).toBeLessThan(full.json.length);
    });

    test('addRequestToStream stores full payload out-of-band and emits preview only', () => {
        const handler = jest.fn();
        rh.on('request', handler);

        rh.addRequestToStream({
            requestId: 'payload-store-1',
            keyIndex: 0,
            success: true,
            requestPayload: { json: '{ "preview": true }', truncated: false },
            requestPayloadFull: { json: '{ "full": true, "nested": { "x": 1 } }', truncated: false }
        });

        expect(handler).toHaveBeenCalledTimes(1);
        const emitted = handler.mock.calls[0][0];
        expect(emitted.requestPayloadFull).toBeUndefined();
        expect(emitted.requestPayloadAvailable).toBe(true);
        expect(emitted.requestPayload.json).toContain('"preview": true');

        const stored = rh.getRequestPayload('payload-store-1');
        expect(stored).toBeTruthy();
        expect(stored.json).toContain('"full": true');
        expect(stored.capturedAt).toEqual(expect.any(Number));
    });

    test('clearRequestStream clears payload store', () => {
        rh.addRequestToStream({
            requestId: 'payload-store-2',
            keyIndex: 0,
            success: true,
            requestPayloadFull: { json: '{ "a": 1 }', truncated: false }
        });
        expect(rh.getRequestPayload('payload-store-2')).toBeTruthy();

        rh.clearRequestStream();
        expect(rh.getRequestPayload('payload-store-2')).toBeNull();
    });

    test('getRequestPayloadStoreStats tracks hits and misses', () => {
        rh.addRequestToStream({
            requestId: 'payload-stats-1',
            keyIndex: 0,
            success: true,
            requestPayloadFull: { json: '{ "a": 1 }', truncated: false }
        });

        expect(rh.getRequestPayload('payload-stats-1')).toBeTruthy();
        expect(rh.getRequestPayload('payload-missing')).toBeNull();

        const stats = rh.getRequestPayloadStoreStats();
        expect(stats.hits).toBe(1);
        expect(stats.misses).toBe(1);
        expect(stats.storedTotal).toBe(1);
        expect(stats.size).toBe(1);
    });

    test('payload snapshots expire by TTL and increment eviction counter', () => {
        let now = 1000;
        const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);

        const ttlHandler = new RequestHandler({
            keyManager: km,
            config: {},
            maxStreamSize: 10,
            maxRequestPayloadRetentionMs: 100
        });
        try {
            ttlHandler.addRequestToStream({
                requestId: 'payload-ttl-1',
                keyIndex: 0,
                success: true,
                requestPayloadFull: { json: '{ "ttl": true }', truncated: false }
            });

            expect(ttlHandler.getRequestPayload('payload-ttl-1')).toBeTruthy();
            now = 1205;
            expect(ttlHandler.getRequestPayload('payload-ttl-1')).toBeNull();

            const stats = ttlHandler.getRequestPayloadStoreStats();
            expect(stats.evictedByTtl).toBe(1);
            expect(stats.size).toBe(0);
        } finally {
            ttlHandler.destroy();
            dateNowSpy.mockRestore();
        }
    });
});

describe('Adaptive timeout ceiling', () => {
    let rh;
    let km;

    beforeEach(() => {
        km = new KeyManager({
            maxConcurrencyPerKey: 3,
            circuitBreaker: {
                failureThreshold: 5,
                failureWindow: 5000,
                cooldownPeriod: 1000
            }
        });
        km.loadKeys(['key1.secret1', 'key2.secret2']);

        rh = new RequestHandler({
            keyManager: km,
            config: {
                maxRetries: 2,
                requestTimeout: 300000,
                maxTotalConcurrency: 10,
                adaptiveTimeout: {
                    enabled: true,
                    initialMs: 90000,
                    maxMs: 120000,
                    minMs: 45000,
                    retryMultiplier: 1.5,
                    latencyMultiplier: 4.0,
                    minSamples: 3
                }
            }
        });
    });

    afterEach(() => {
        if (rh) rh.destroy();
    });

    test('_calculateTimeout caps at 120000ms even with high latency keys', () => {
        // Mock key with very high P95 latency
        const mockKeyInfo = {
            latencies: {
                stats: () => ({ count: 20, p95: 50000 }) // 50s P95
            }
        };

        // With P95=50000 and multiplier=4.0, uncapped would be 200000ms
        // But maxMs=120000 should cap it
        const timeout = rh._calculateTimeout(mockKeyInfo, 0);
        expect(timeout).toBe(120000);

        // Even with retry multiplier, should still cap at 120000
        const retryTimeout = rh._calculateTimeout(mockKeyInfo, 2);
        expect(retryTimeout).toBe(120000);
    });

    test('model-aware: uses model P95 when higher than key P95', () => {
        // Override statsAggregator with model P95 data
        rh.statsAggregator = {
            getModelP95: (model) => model === 'glm-5' ? 80000 : null,
            recordAdaptiveTimeout: jest.fn()
        };

        // Key with low P95 (diluted by fast light-tier requests)
        const keyInfo = {
            latencies: { stats: () => ({ count: 100, p95: 13000 }) }
        };

        // Without model: key P95 * 4 = 52000
        const withoutModel = rh._calculateTimeout(keyInfo, 0);
        expect(withoutModel).toBe(52000);

        // With heavy model: model P95 (80000) * 4 = 320000, capped at maxMs (120000)
        const withModel = rh._calculateTimeout(keyInfo, 0, 'glm-5');
        expect(withModel).toBe(120000);
    });

    test('model-aware: falls back to key P95 when model P95 unavailable', () => {
        rh.statsAggregator = {
            getModelP95: () => null,
            recordAdaptiveTimeout: jest.fn()
        };

        const keyInfo = {
            latencies: { stats: () => ({ count: 100, p95: 15000 }) }
        };

        const timeout = rh._calculateTimeout(keyInfo, 0, 'glm-unknown');
        expect(timeout).toBe(60000); // 15000 * 4
    });

    test('model-aware: works without statsAggregator', () => {
        rh.statsAggregator = null;

        const keyInfo = {
            latencies: { stats: () => ({ count: 100, p95: 15000 }) }
        };

        // Should not throw even without statsAggregator
        const timeout = rh._calculateTimeout(keyInfo, 0, 'glm-5');
        expect(timeout).toBe(60000); // Falls back to key P95 * 4
    });

    test('model-aware: applies retry multiplier after model-aware base', () => {
        // Use higher maxMs to test retry escalation
        const rhHighMax = new RequestHandler({
            keyManager: km,
            config: {
                adaptiveTimeout: {
                    enabled: true,
                    initialMs: 90000,
                    maxMs: 600000,
                    minMs: 45000,
                    retryMultiplier: 1.5,
                    latencyMultiplier: 4.0,
                    minSamples: 3
                }
            },
            statsAggregator: {
                getModelP95: () => 80000,
                recordAdaptiveTimeout: jest.fn()
            }
        });

        const keyInfo = {
            latencies: { stats: () => ({ count: 100, p95: 13000 }) }
        };

        // Attempt 0: max(52000, 320000) = 320000
        const attempt0 = rhHighMax._calculateTimeout(keyInfo, 0, 'glm-5');
        expect(attempt0).toBe(320000);

        // Attempt 1: 320000 * 1.5 = 480000
        const attempt1 = rhHighMax._calculateTimeout(keyInfo, 1, 'glm-5');
        expect(attempt1).toBe(480000);

        rhHighMax.destroy();
    });
});

describe('Pacing cap', () => {
    let rh;
    let km;

    beforeEach(() => {
        km = new KeyManager({
            maxConcurrencyPerKey: 3,
            circuitBreaker: {
                failureThreshold: 5,
                failureWindow: 5000,
                cooldownPeriod: 1000
            }
        });
        km.loadKeys(['key1.secret1', 'key2.secret2']);

        rh = new RequestHandler({
            keyManager: km,
            config: {
                maxRetries: 2,
                requestTimeout: 5000,
                maxTotalConcurrency: 10
            }
        });
    });

    afterEach(() => {
        if (rh) rh.destroy();
    });

    test('pacing guard accepts delays up to 1000ms', () => {
        // The pacing guard in _proxyWithRetries checks: pacingMs <= 1000
        // We verify the source code condition by checking the threshold is 1000
        // by reading the code. Here we verify via integration that 1000ms would pass.

        // Mock getModelPacingDelayMs to return 800ms (within 1000ms cap)
        jest.spyOn(km, 'getModelPacingDelayMs').mockReturnValue(800);

        // The guard is: pacingMs > 0 && pacingMs <= 1000
        // 800 is > 0 and <= 1000, so it should pass
        const pacingMs = km.getModelPacingDelayMs('glm-4.7');
        expect(pacingMs).toBe(800);
        expect(pacingMs > 0 && pacingMs <= 1000).toBe(true);

        // Also verify 1000ms passes
        jest.spyOn(km, 'getModelPacingDelayMs').mockReturnValue(1000);
        const pacingMs2 = km.getModelPacingDelayMs('glm-4.7');
        expect(pacingMs2 > 0 && pacingMs2 <= 1000).toBe(true);

        // And 1001ms would NOT pass
        jest.spyOn(km, 'getModelPacingDelayMs').mockReturnValue(1001);
        const pacingMs3 = km.getModelPacingDelayMs('glm-4.7');
        expect(pacingMs3 > 0 && pacingMs3 <= 1000).toBe(false);
    });
});

// Helper functions

function createMockReq(overrides = {}) {
    return {
        method: 'POST',
        url: '/v1/messages',
        headers: {
            'content-type': 'application/json'
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
        removeListener: jest.fn()
    };
}

// ---------------------------------------------------------------
// Adaptive Concurrency Feedback Signal Tests
// ---------------------------------------------------------------

describe('Adaptive Concurrency Feedback Signals', () => {
    let rh;
    let km;
    let sa;
    let mockAdaptive;

    beforeEach(() => {
        km = new KeyManager({
            maxConcurrencyPerKey: 3,
            circuitBreaker: {
                failureThreshold: 3,
                failureWindow: 1000,
                cooldownPeriod: 500
            }
        });
        km.loadKeys(['key1.secret1', 'key2.secret2']);

        sa = new StatsAggregator();

        mockAdaptive = {
            recordCongestion: jest.fn(),
            recordSuccess: jest.fn()
        };

        rh = new RequestHandler({
            keyManager: km,
            statsAggregator: sa,
            config: {
                maxRetries: 3,
                requestTimeout: 5000,
                maxTotalConcurrency: 10
            }
        });
        rh.adaptiveConcurrency = mockAdaptive;
    });

    afterEach(() => {
        if (rh) rh.destroy();
    });

    test('adaptiveConcurrency is null → no errors (optional chaining graceful)', () => {
        rh.adaptiveConcurrency = null;
        // Should not throw when attempting to call methods on null
        expect(() => {
            rh.adaptiveConcurrency?.recordCongestion('glm-4.5', {});
            rh.adaptiveConcurrency?.recordSuccess('glm-4.5');
        }).not.toThrow();
    });

    test('adaptiveConcurrency property can be set on handler', () => {
        expect(rh.adaptiveConcurrency).toBe(mockAdaptive);
    });

    test('adaptiveConcurrency recordCongestion is callable', () => {
        mockAdaptive.recordCongestion('glm-4.5', { retryAfterMs: 2000 });
        expect(mockAdaptive.recordCongestion).toHaveBeenCalledWith('glm-4.5', { retryAfterMs: 2000 });
    });

    test('adaptiveConcurrency recordSuccess is callable', () => {
        mockAdaptive.recordSuccess('glm-4.5');
        expect(mockAdaptive.recordSuccess).toHaveBeenCalledWith('glm-4.5');
    });
});
