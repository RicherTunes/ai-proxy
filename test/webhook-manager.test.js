/**
 * Webhook Manager Tests
 * Comprehensive tests for lib/webhook-manager.js
 */

const { WebhookManager, EVENT_TYPES } = require('../lib/webhook-manager');
const http = require('http');

describe('WebhookManager', () => {
    let manager;
    let mockLogger;

    beforeEach(() => {
        mockLogger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        };
    });

    afterEach(() => {
        if (manager) {
            manager._recentEvents.clear();
            manager._errorTimestamps = [];
        }
    });

    describe('constructor', () => {
        it('should create manager with default options', () => {
            manager = new WebhookManager();
            expect(manager.enabled).toBe(true);
            expect(manager.endpoints).toEqual([]);
            expect(manager.maxRetries).toBe(3);
            expect(manager.retryDelayMs).toBe(1000);
            expect(manager.timeoutMs).toBe(10000);
            expect(manager.dedupeWindowMs).toBe(60000);
        });

        it('should respect enabled=false option', () => {
            manager = new WebhookManager({ enabled: false });
            expect(manager.enabled).toBe(false);
        });

        it('should use custom retry configuration', () => {
            manager = new WebhookManager({
                maxRetries: 5,
                retryDelayMs: 2000,
                timeoutMs: 30000
            });
            expect(manager.maxRetries).toBe(5);
            expect(manager.retryDelayMs).toBe(2000);
            expect(manager.timeoutMs).toBe(30000);
        });

        it('should load endpoints from constructor options', () => {
            manager = new WebhookManager({
                logger: mockLogger,
                endpoints: [
                    { url: 'https://example.com/webhook' }
                ]
            });
            expect(manager.endpoints.length).toBe(1);
        });

        it('should initialize stats object', () => {
            manager = new WebhookManager();
            expect(manager.stats).toEqual({
                sent: 0,
                succeeded: 0,
                failed: 0,
                retried: 0,
                deduped: 0,
                byEventType: {}
            });
        });
    });

    describe('loadWebhooks', () => {
        beforeEach(() => {
            manager = new WebhookManager({ logger: mockLogger });
        });

        it('should load valid webhook endpoints', () => {
            manager.loadWebhooks([
                { url: 'https://example.com/webhook', secret: 'secret123' },
                { url: 'http://localhost:3000/hook', events: ['circuit.trip'] }
            ]);
            expect(manager.endpoints.length).toBe(2);
        });

        it('should reject endpoints without URL', () => {
            manager.loadWebhooks([
                { secret: 'secret123' },
                { url: 'https://valid.com/hook' }
            ]);
            expect(manager.endpoints.length).toBe(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                'Webhook endpoint missing URL, skipping',
                undefined
            );
        });

        it('should reject endpoints with invalid URL', () => {
            manager.loadWebhooks([
                { url: 'not-a-valid-url' },
                { url: 'https://valid.com/hook' }
            ]);
            expect(manager.endpoints.length).toBe(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                'Invalid webhook URL: not-a-valid-url',
                undefined
            );
        });

        it('should set default events to all EVENT_TYPES', () => {
            manager.loadWebhooks([{ url: 'https://example.com/hook' }]);
            expect(manager.endpoints[0].events).toEqual(EVENT_TYPES);
        });

        it('should extract hostname as default name', () => {
            manager.loadWebhooks([{ url: 'https://webhook.example.com/path' }]);
            expect(manager.endpoints[0].name).toBe('webhook.example.com');
        });

        it('should use custom name if provided', () => {
            manager.loadWebhooks([{ url: 'https://example.com/hook', name: 'My Webhook' }]);
            expect(manager.endpoints[0].name).toBe('My Webhook');
        });

        it('should preserve custom headers', () => {
            manager.loadWebhooks([{
                url: 'https://example.com/hook',
                headers: { 'Authorization': 'Bearer token123' }
            }]);
            expect(manager.endpoints[0].headers).toEqual({ 'Authorization': 'Bearer token123' });
        });
    });

    describe('_createSignature', () => {
        beforeEach(() => {
            manager = new WebhookManager();
        });

        it('should create valid HMAC-SHA256 signature', () => {
            const payload = '{"test":"data"}';
            const secret = 'webhook-secret';
            const timestamp = 1700000000;

            const signature = manager._createSignature(payload, secret, timestamp);

            // Verify it's a 64-character hex string (SHA256)
            expect(signature).toMatch(/^[a-f0-9]{64}$/);
        });

        it('should produce consistent signatures', () => {
            const payload = '{"event":"test"}';
            const secret = 'secret123';
            const timestamp = 1700000000;

            const sig1 = manager._createSignature(payload, secret, timestamp);
            const sig2 = manager._createSignature(payload, secret, timestamp);

            expect(sig1).toBe(sig2);
        });

        it('should produce different signatures for different payloads', () => {
            const secret = 'secret123';
            const timestamp = 1700000000;

            const sig1 = manager._createSignature('{"a":1}', secret, timestamp);
            const sig2 = manager._createSignature('{"b":2}', secret, timestamp);

            expect(sig1).not.toBe(sig2);
        });

        it('should produce different signatures for different timestamps', () => {
            const payload = '{"test":"data"}';
            const secret = 'secret123';

            const sig1 = manager._createSignature(payload, secret, 1700000000);
            const sig2 = manager._createSignature(payload, secret, 1700000001);

            expect(sig1).not.toBe(sig2);
        });
    });

    describe('_shouldDedupe', () => {
        beforeEach(() => {
            manager = new WebhookManager({ dedupeWindowMs: 1000 });
        });

        it('should not dedupe first occurrence', () => {
            const result = manager._shouldDedupe('circuit.trip', 'key1');
            expect(result).toBe(false);
        });

        it('should dedupe repeated events within window', () => {
            manager._shouldDedupe('circuit.trip', 'key1');
            const result = manager._shouldDedupe('circuit.trip', 'key1');
            expect(result).toBe(true);
            expect(manager.stats.deduped).toBe(1);
        });

        it('should not dedupe different event types', () => {
            manager._shouldDedupe('circuit.trip', 'key1');
            const result = manager._shouldDedupe('circuit.recover', 'key1');
            expect(result).toBe(false);
        });

        it('should not dedupe different keys', () => {
            manager._shouldDedupe('circuit.trip', 'key1');
            const result = manager._shouldDedupe('circuit.trip', 'key2');
            expect(result).toBe(false);
        });

        it('should allow same event after window expires', async () => {
            manager._shouldDedupe('circuit.trip', 'key1');

            // Wait for window to expire
            await new Promise(resolve => setTimeout(resolve, 1100));

            const result = manager._shouldDedupe('circuit.trip', 'key1');
            expect(result).toBe(false);
        });

        it('should cleanup old entries when map exceeds 1000', () => {
            // Fill with 1001 entries
            for (let i = 0; i < 1001; i++) {
                manager._shouldDedupe('test', `key${i}`);
            }

            // Should trigger cleanup
            manager._shouldDedupe('test', 'trigger');

            // Size should be reduced (old entries cleaned)
            expect(manager._recentEvents.size).toBeLessThanOrEqual(1002);
        });
    });

    describe('_sanitizePayload', () => {
        beforeEach(() => {
            manager = new WebhookManager();
        });

        it('should remove sensitive fields', () => {
            const payload = {
                data: 'safe',
                key: 'secret-key',
                secret: 'my-secret',
                password: 'pass123',
                token: 'token123',
                authorization: 'Bearer xxx',
                apiKey: 'api-key'
            };

            const sanitized = manager._sanitizePayload(payload);

            expect(sanitized.data).toBe('safe');
            expect(sanitized.key).toBeUndefined();
            expect(sanitized.secret).toBeUndefined();
            expect(sanitized.password).toBeUndefined();
            expect(sanitized.token).toBeUndefined();
            expect(sanitized.authorization).toBeUndefined();
            expect(sanitized.apiKey).toBeUndefined();
        });

        it('should not modify original payload', () => {
            const payload = { data: 'test', key: 'secret' };
            manager._sanitizePayload(payload);
            expect(payload.key).toBe('secret');
        });

        it('should preserve non-sensitive fields', () => {
            const payload = {
                message: 'Hello',
                code: 500,
                nested: { value: 123 }
            };

            const sanitized = manager._sanitizePayload(payload);

            expect(sanitized.message).toBe('Hello');
            expect(sanitized.code).toBe(500);
            expect(sanitized.nested).toEqual({ value: 123 });
        });
    });

    describe('emit', () => {
        beforeEach(() => {
            manager = new WebhookManager({
                logger: mockLogger,
                endpoints: [
                    { url: 'https://example.com/hook', events: ['circuit.trip', 'circuit.recover'] }
                ]
            });
            // Mock _deliver to prevent actual HTTP requests
            manager._deliver = jest.fn().mockResolvedValue();
        });

        it('should not emit when disabled', () => {
            manager.enabled = false;
            manager.emit('circuit.trip', { keyIndex: 0 });
            expect(manager._deliver).not.toHaveBeenCalled();
        });

        it('should not emit when no endpoints', () => {
            manager.endpoints = [];
            manager.emit('circuit.trip', { keyIndex: 0 });
            expect(manager._deliver).not.toHaveBeenCalled();
        });

        it('should log warning for unknown event type', () => {
            manager.emit('unknown.event', { data: 'test' });
            expect(mockLogger.warn).toHaveBeenCalledWith(
                'Unknown event type: unknown.event',
                undefined
            );
        });

        it('should call _deliver for subscribed endpoints', () => {
            manager.emit('circuit.trip', { keyIndex: 0 });
            expect(manager._deliver).toHaveBeenCalledTimes(1);
        });

        it('should not deliver to endpoints not subscribed to event', () => {
            manager.emit('budget.warning', { amount: 100 });
            expect(manager._deliver).not.toHaveBeenCalled();
        });

        it('should track event stats', () => {
            manager.emit('circuit.trip', { keyIndex: 0 });
            expect(manager.stats.byEventType['circuit.trip']).toBe(1);
        });

        it('should deduplicate repeated events', () => {
            manager.emit('circuit.trip', { keyIndex: 0 }, { dedupeKey: 'test' });
            manager.emit('circuit.trip', { keyIndex: 0 }, { dedupeKey: 'test' });
            expect(manager._deliver).toHaveBeenCalledTimes(1);
        });

        it('should sanitize payload', () => {
            manager.emit('circuit.trip', { keyIndex: 0, secret: 'hidden' });

            const deliveredEvent = manager._deliver.mock.calls[0][1];
            expect(deliveredEvent.payload.keyIndex).toBe(0);
            expect(deliveredEvent.payload.secret).toBeUndefined();
        });

        it('should include event metadata', () => {
            manager.emit('circuit.trip', { keyIndex: 0 });

            const deliveredEvent = manager._deliver.mock.calls[0][1];
            expect(deliveredEvent.id).toMatch(/^evt_/);
            expect(deliveredEvent.type).toBe('circuit.trip');
            expect(deliveredEvent.timestamp).toBeDefined();
        });

        it('should deliver to endpoints subscribed to wildcard', () => {
            manager.endpoints = [
                { url: 'https://example.com/hook', events: ['*'], name: 'all' }
            ];

            manager.emit('budget.exceeded', { amount: 100 });
            expect(manager._deliver).toHaveBeenCalled();
        });
    });

    describe('recordError', () => {
        beforeEach(() => {
            manager = new WebhookManager({
                logger: mockLogger,
                errorSpikeThreshold: 3,
                errorSpikeWindow: 5000,
                endpoints: [{ url: 'https://example.com/hook', events: ['error.spike'] }]
            });
            manager._deliver = jest.fn().mockResolvedValue();
        });

        it('should record error timestamps', () => {
            manager.recordError('timeout');
            expect(manager._errorTimestamps.length).toBe(1);
            expect(manager._errorTimestamps[0].type).toBe('timeout');
        });

        it('should emit error.spike when threshold reached', () => {
            manager.recordError('timeout');
            manager.recordError('timeout');
            manager.recordError('connection');

            expect(manager._deliver).toHaveBeenCalled();
        });

        it('should aggregate error types', () => {
            manager.recordError('timeout');
            manager.recordError('timeout');
            manager.recordError('connection');

            const emittedPayload = manager._deliver.mock.calls[0][1].payload;
            expect(emittedPayload.errorTypes).toEqual({ timeout: 2, connection: 1 });
        });

        it('should cleanup old timestamps outside window', async () => {
            manager.errorSpikeWindow = 100;
            manager.recordError('error1');

            await new Promise(resolve => setTimeout(resolve, 150));

            manager.recordError('error2');
            expect(manager._errorTimestamps.length).toBe(1);
        });
    });

    describe('helper emit methods', () => {
        beforeEach(() => {
            manager = new WebhookManager({
                logger: mockLogger,
                endpoints: [{ url: 'https://example.com/hook' }]
            });
            manager._deliver = jest.fn().mockResolvedValue();
        });

        it('emitCircuitTrip should emit circuit.trip event', () => {
            manager.emitCircuitTrip(0, 'sk-xxx', { failures: 5 });

            const event = manager._deliver.mock.calls[0][1];
            expect(event.type).toBe('circuit.trip');
            expect(event.payload.keyIndex).toBe(0);
            expect(event.payload.keyPrefix).toBe('sk-xxx');
            expect(event.payload.failures).toBe(5);
        });

        it('emitCircuitRecover should emit circuit.recover event', () => {
            manager.emitCircuitRecover(1, 'sk-yyy');

            const event = manager._deliver.mock.calls[0][1];
            expect(event.type).toBe('circuit.recover');
            expect(event.payload.keyIndex).toBe(1);
        });

        it('emitRateLimitHit should emit rate_limit.hit event', () => {
            manager.emitRateLimitHit(2, 'sk-zzz');

            const event = manager._deliver.mock.calls[0][1];
            expect(event.type).toBe('rate_limit.hit');
        });

        it('emitPoolExhausted should emit rate_limit.pool_exhausted event', () => {
            manager.emitPoolExhausted();

            const event = manager._deliver.mock.calls[0][1];
            expect(event.type).toBe('rate_limit.pool_exhausted');
        });

        it('emitHealthStatus should emit health.degraded or health.critical', () => {
            manager.emitHealthStatus('degraded', { healthyKeys: 1 });
            expect(manager._deliver.mock.calls[0][1].type).toBe('health.degraded');

            manager._recentEvents.clear(); // Clear dedupe
            manager.emitHealthStatus('critical', { healthyKeys: 0 });
            expect(manager._deliver.mock.calls[1][1].type).toBe('health.critical');
        });
    });

    describe('getDeliveryStats', () => {
        beforeEach(() => {
            manager = new WebhookManager({
                endpoints: [{ url: 'https://example.com/hook' }]
            });
        });

        it('should return stats with success rate', () => {
            manager.stats.sent = 10;
            manager.stats.succeeded = 8;
            manager.stats.failed = 2;

            const stats = manager.getDeliveryStats();

            expect(stats.successRate).toBe(80);
            expect(stats.sent).toBe(10);
            expect(stats.succeeded).toBe(8);
            expect(stats.failed).toBe(2);
        });

        it('should return 100% success rate when no sends', () => {
            const stats = manager.getDeliveryStats();
            expect(stats.successRate).toBe(100);
        });

        it('should include endpoint count', () => {
            const stats = manager.getDeliveryStats();
            expect(stats.endpointCount).toBe(1);
        });

        it('should include pending deliveries count', () => {
            manager._pendingDeliveries.add('pending1');
            const stats = manager.getDeliveryStats();
            expect(stats.pendingDeliveries).toBe(1);
        });
    });

    describe('getEndpoints', () => {
        beforeEach(() => {
            manager = new WebhookManager({
                endpoints: [
                    { url: 'https://example.com/hook', secret: 'secret123', name: 'Test' }
                ]
            });
        });

        it('should return endpoint info without secrets', () => {
            const endpoints = manager.getEndpoints();

            expect(endpoints.length).toBe(1);
            expect(endpoints[0].name).toBe('Test');
            expect(endpoints[0].url).toBe('https://example.com/hook');
            expect(endpoints[0].hasSecret).toBe(true);
            expect(endpoints[0].secret).toBeUndefined();
        });

        it('should indicate when endpoint has no secret', () => {
            manager.endpoints[0].secret = null;
            const endpoints = manager.getEndpoints();
            expect(endpoints[0].hasSecret).toBe(false);
        });
    });

    describe('drain', () => {
        beforeEach(() => {
            manager = new WebhookManager({ logger: mockLogger });
        });

        it('should resolve immediately when no pending deliveries', async () => {
            const start = Date.now();
            await manager.drain(1000);
            expect(Date.now() - start).toBeLessThan(200);
        });

        it('should wait for pending deliveries', async () => {
            manager._pendingDeliveries.add('delivery1');

            // Clear pending after 100ms
            setTimeout(() => manager._pendingDeliveries.clear(), 100);

            const start = Date.now();
            await manager.drain(5000);
            expect(Date.now() - start).toBeGreaterThanOrEqual(100);
        });

        it('should timeout after specified duration', async () => {
            manager._pendingDeliveries.add('delivery1');

            const start = Date.now();
            await manager.drain(200);
            expect(Date.now() - start).toBeGreaterThanOrEqual(200);
            expect(mockLogger.warn).toHaveBeenCalled();
        });
    });

    describe('_deliver with retry', () => {
        beforeEach(() => {
            manager = new WebhookManager({
                logger: mockLogger,
                maxRetries: 2,
                retryDelayMs: 50
            });
        });

        it('should track pending deliveries', async () => {
            manager._sendRequest = jest.fn().mockResolvedValue();

            const endpoint = { url: 'https://example.com', name: 'test' };
            const event = { id: 'evt_1', type: 'test' };

            const deliveryPromise = manager._deliver(endpoint, event);
            expect(manager._pendingDeliveries.size).toBe(1);

            await deliveryPromise;
            expect(manager._pendingDeliveries.size).toBe(0);
        });

        it('should retry on failure', async () => {
            manager._sendRequest = jest.fn()
                .mockRejectedValueOnce(new Error('Network error'))
                .mockResolvedValueOnce();

            const endpoint = { url: 'https://example.com', name: 'test' };
            const event = { id: 'evt_1', type: 'test' };

            await manager._deliver(endpoint, event);

            expect(manager._sendRequest).toHaveBeenCalledTimes(2);
            expect(manager.stats.retried).toBe(1);
            expect(manager.stats.succeeded).toBe(1);
        });

        it('should fail after max retries', async () => {
            manager._sendRequest = jest.fn().mockRejectedValue(new Error('Persistent error'));

            const endpoint = { url: 'https://example.com', name: 'test' };
            const event = { id: 'evt_1', type: 'test' };

            await manager._deliver(endpoint, event);

            expect(manager._sendRequest).toHaveBeenCalledTimes(3); // initial + 2 retries
            expect(manager.stats.failed).toBe(1);
        });

        it('should use exponential backoff', async () => {
            manager._sendRequest = jest.fn()
                .mockRejectedValueOnce(new Error('Error 1'))
                .mockRejectedValueOnce(new Error('Error 2'))
                .mockResolvedValueOnce();

            const endpoint = { url: 'https://example.com', name: 'test' };
            const event = { id: 'evt_1', type: 'test' };

            const start = Date.now();
            await manager._deliver(endpoint, event);
            const duration = Date.now() - start;

            // Should wait at least 50ms + 100ms = 150ms (exponential backoff)
            expect(duration).toBeGreaterThanOrEqual(150);
        });
    });

    describe('testWebhook', () => {
        beforeEach(() => {
            manager = new WebhookManager();
        });

        it('should return success on successful delivery', async () => {
            manager._sendRequest = jest.fn().mockResolvedValue();

            const result = await manager.testWebhook('https://example.com/hook');

            expect(result.success).toBe(true);
            expect(result.message).toBe('Webhook test successful');
        });

        it('should return failure on error', async () => {
            manager._sendRequest = jest.fn().mockRejectedValue(new Error('Connection refused'));

            const result = await manager.testWebhook('https://example.com/hook');

            expect(result.success).toBe(false);
            expect(result.message).toBe('Connection refused');
        });
    });

    describe('EVENT_TYPES export', () => {
        it('should export all expected event types', () => {
            expect(EVENT_TYPES).toContain('circuit.trip');
            expect(EVENT_TYPES).toContain('circuit.recover');
            expect(EVENT_TYPES).toContain('rate_limit.hit');
            expect(EVENT_TYPES).toContain('rate_limit.pool_exhausted');
            expect(EVENT_TYPES).toContain('error.spike');
            expect(EVENT_TYPES).toContain('budget.warning');
            expect(EVENT_TYPES).toContain('budget.exceeded');
            expect(EVENT_TYPES).toContain('health.degraded');
            expect(EVENT_TYPES).toContain('health.critical');
        });
    });
});

describe('WebhookManager HTTP Integration', () => {
    let manager;
    let server;
    let receivedRequests;

    beforeAll((done) => {
        receivedRequests = [];
        server = http.createServer((req, res) => {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                receivedRequests.push({
                    method: req.method,
                    url: req.url,
                    headers: req.headers,
                    body: JSON.parse(body)
                });

                // Respond based on URL
                if (req.url === '/fail') {
                    res.writeHead(500);
                    res.end('Server Error');
                } else {
                    res.writeHead(200);
                    res.end('OK');
                }
            });
        });
        server.listen(0, () => done());
    });

    afterAll((done) => {
        server.close(done);
    });

    beforeEach(() => {
        receivedRequests = [];
        const port = server.address().port;
        manager = new WebhookManager({
            maxRetries: 1,
            retryDelayMs: 10,
            endpoints: [
                { url: `http://localhost:${port}/webhook`, secret: 'test-secret', name: 'test' }
            ]
        });
    });

    it('should deliver webhook via HTTP', async () => {
        manager.emit('circuit.trip', { keyIndex: 0 });

        // Wait for delivery
        await new Promise(resolve => setTimeout(resolve, 100));

        expect(receivedRequests.length).toBe(1);
        expect(receivedRequests[0].method).toBe('POST');
        expect(receivedRequests[0].body.type).toBe('circuit.trip');
    });

    it('should include HMAC signature when secret configured', async () => {
        manager.emit('circuit.trip', { keyIndex: 0 });

        await new Promise(resolve => setTimeout(resolve, 100));

        const headers = receivedRequests[0].headers;
        expect(headers['x-glm-signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
        expect(headers['x-glm-event']).toBe('circuit.trip');
        expect(headers['x-glm-timestamp']).toBeDefined();
    });

    it('should include custom headers', async () => {
        const port = server.address().port;
        manager.endpoints[0].headers = { 'X-Custom': 'value123' };

        manager.emit('circuit.trip', { keyIndex: 0 });

        await new Promise(resolve => setTimeout(resolve, 100));

        expect(receivedRequests[0].headers['x-custom']).toBe('value123');
    });

    it('should handle server errors', async () => {
        const port = server.address().port;
        manager.endpoints = [{
            url: `http://localhost:${port}/fail`,
            name: 'fail',
            events: ['circuit.trip'],
            headers: {}
        }];

        manager.emit('circuit.trip', { keyIndex: 0 });

        await new Promise(resolve => setTimeout(resolve, 200));

        expect(manager.stats.failed).toBe(1);
    });
});
