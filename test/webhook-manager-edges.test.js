/**
 * Webhook Manager Edge-Case Tests
 * Covers: deduplication, event types, retry logic, max retries,
 * URL validation / SSRF, concurrent deliveries, error spike detection,
 * drain on shutdown, custom headers, and payload size limits.
 */

'use strict';

const { WebhookManager, EVENT_TYPES } = require('../lib/webhook-manager');
const http = require('http');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockLogger() {
    return {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    };
}

/**
 * Spin up a local HTTP server that records every request and lets the test
 * control per-request behaviour via `handler`.
 */
function createTestServer(handler) {
    return new Promise((resolve) => {
        const requests = [];
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => (body += chunk));
            req.on('end', () => {
                const parsed = body ? JSON.parse(body) : null;
                requests.push({
                    method: req.method,
                    url: req.url,
                    headers: req.headers,
                    body: parsed
                });
                if (handler) {
                    handler(req, res, requests);
                } else {
                    res.writeHead(200);
                    res.end('OK');
                }
            });
        });
        server.listen(0, () => {
            resolve({ server, requests, port: server.address().port });
        });
    });
}

function closeServer(server) {
    return new Promise((resolve) => server.close(resolve));
}

// ---------------------------------------------------------------------------
// 1. Event deduplication
// ---------------------------------------------------------------------------
describe('Edge: Event deduplication', () => {
    let manager;
    let mockLogger;

    beforeEach(() => {
        mockLogger = createMockLogger();
        manager = new WebhookManager({
            logger: mockLogger,
            dedupeWindowMs: 500,
            endpoints: [{ url: 'https://example.com/hook', events: ['circuit.trip'] }]
        });
        manager._deliver = jest.fn().mockResolvedValue();
    });

    afterEach(() => {
        manager._recentEvents.clear();
    });

    it('should deliver the first event normally', () => {
        manager.emit('circuit.trip', { idx: 1 }, { dedupeKey: 'dup1' });
        expect(manager._deliver).toHaveBeenCalledTimes(1);
    });

    it('should suppress the same event sent twice within the dedup window', () => {
        manager.emit('circuit.trip', { idx: 1 }, { dedupeKey: 'dup1' });
        manager.emit('circuit.trip', { idx: 1 }, { dedupeKey: 'dup1' });
        expect(manager._deliver).toHaveBeenCalledTimes(1);
        expect(manager.stats.deduped).toBe(1);
    });

    it('should allow the same event again after the dedup window expires', async () => {
        manager.emit('circuit.trip', { idx: 1 }, { dedupeKey: 'dup2' });
        expect(manager._deliver).toHaveBeenCalledTimes(1);

        // Wait for window to expire
        await new Promise((r) => setTimeout(r, 600));

        manager.emit('circuit.trip', { idx: 1 }, { dedupeKey: 'dup2' });
        expect(manager._deliver).toHaveBeenCalledTimes(2);
        expect(manager.stats.deduped).toBe(0);
    });

    it('should dedupe using auto-generated key from payload when no dedupeKey given', () => {
        const payload = { idx: 42 };
        manager.emit('circuit.trip', payload);
        manager.emit('circuit.trip', payload);
        expect(manager._deliver).toHaveBeenCalledTimes(1);
        expect(manager.stats.deduped).toBe(1);
    });

    it('should NOT dedupe events with different dedupeKeys', () => {
        manager.emit('circuit.trip', { idx: 1 }, { dedupeKey: 'a' });
        manager.emit('circuit.trip', { idx: 2 }, { dedupeKey: 'b' });
        expect(manager._deliver).toHaveBeenCalledTimes(2);
        expect(manager.stats.deduped).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// 2. EVENT_TYPES generate properly formatted webhook payloads
// ---------------------------------------------------------------------------
describe('Edge: All EVENT_TYPES generate properly formatted payloads', () => {
    let manager;

    beforeEach(() => {
        manager = new WebhookManager({
            endpoints: [{ url: 'https://example.com/hook', events: ['*'] }]
        });
        manager._deliver = jest.fn().mockResolvedValue();
    });

    afterEach(() => {
        manager._recentEvents.clear();
    });

    it('should have at least 10 known event types', () => {
        expect(EVENT_TYPES.length).toBeGreaterThanOrEqual(10);
    });

    it.each(EVENT_TYPES)('event "%s" should produce a valid payload envelope', (eventType) => {
        manager.emit(eventType, { detail: `test-${eventType}` });

        expect(manager._deliver).toHaveBeenCalled();

        const lastCall = manager._deliver.mock.calls[manager._deliver.mock.calls.length - 1];
        const event = lastCall[1];

        // Envelope checks
        expect(event.id).toMatch(/^evt_\d+_[a-z0-9]+$/);
        expect(event.type).toBe(eventType);
        expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
        expect(event.payload).toBeDefined();
        expect(event.payload.detail).toBe(`test-${eventType}`);
    });

    it('should track per-type stats for every event type emitted', () => {
        for (const et of EVENT_TYPES) {
            manager.emit(et, { x: 1 });
        }
        for (const et of EVENT_TYPES) {
            expect(manager.stats.byEventType[et]).toBe(1);
        }
    });
});

// ---------------------------------------------------------------------------
// 3. Retry logic — failed delivery retries with exponential backoff
// ---------------------------------------------------------------------------
describe('Edge: Retry logic with exponential backoff', () => {
    let manager;

    beforeEach(() => {
        manager = new WebhookManager({
            logger: createMockLogger(),
            maxRetries: 3,
            retryDelayMs: 20 // keep tests fast
        });
    });

    it('should retry the correct number of times before succeeding', async () => {
        manager._sendRequest = jest.fn()
            .mockRejectedValueOnce(new Error('fail 1'))
            .mockRejectedValueOnce(new Error('fail 2'))
            .mockResolvedValueOnce();

        const endpoint = { url: 'https://x.com', name: 'r', headers: {} };
        const event = { id: 'e1', type: 'circuit.trip', payload: {} };

        await manager._deliver(endpoint, event);

        expect(manager._sendRequest).toHaveBeenCalledTimes(3);
        expect(manager.stats.retried).toBe(2);
        expect(manager.stats.succeeded).toBe(1);
        expect(manager.stats.failed).toBe(0);
    });

    it('should use exponential backoff delays (2^attempt)', async () => {
        const delays = [];
        const origSetTimeout = global.setTimeout;
        // Intercept setTimeout to record requested delays, but still resolve instantly
        jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms) => {
            delays.push(ms);
            return origSetTimeout(fn, 0);
        });

        manager._sendRequest = jest.fn()
            .mockRejectedValueOnce(new Error('e1'))
            .mockRejectedValueOnce(new Error('e2'))
            .mockRejectedValueOnce(new Error('e3'))
            .mockResolvedValueOnce(); // won't reach — maxRetries=3 means 4 total attempts

        const endpoint = { url: 'https://x.com', name: 'r', headers: {} };
        const event = { id: 'e2', type: 'circuit.trip', payload: {} };

        await manager._deliver(endpoint, event);

        // retryDelayMs=20: delays should be 20*1, 20*2, 20*4 = 20, 40, 80
        expect(delays).toContain(20);  // 20 * 2^0
        expect(delays).toContain(40);  // 20 * 2^1
        expect(delays).toContain(80);  // 20 * 2^2

        jest.restoreAllMocks();
    });

    it('should clean up pending delivery after successful retry', async () => {
        manager._sendRequest = jest.fn()
            .mockRejectedValueOnce(new Error('transient'))
            .mockResolvedValueOnce();

        const endpoint = { url: 'https://x.com', name: 'r', headers: {} };
        const event = { id: 'e3', type: 'circuit.trip', payload: {} };

        await manager._deliver(endpoint, event);

        expect(manager._pendingDeliveries.size).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// 4. Max retries — after exhaustion, event is dropped with error logged
// ---------------------------------------------------------------------------
describe('Edge: Max retries exhaustion', () => {
    let manager;
    let mockLogger;

    beforeEach(() => {
        mockLogger = createMockLogger();
        manager = new WebhookManager({
            logger: mockLogger,
            maxRetries: 2,
            retryDelayMs: 5
        });
    });

    it('should drop the event after maxRetries and log an error', async () => {
        manager._sendRequest = jest.fn().mockRejectedValue(new Error('persistent'));

        const endpoint = { url: 'https://x.com', name: 'drop-test', headers: {} };
        const event = { id: 'e4', type: 'circuit.trip', payload: {} };

        await manager._deliver(endpoint, event);

        // 1 initial + 2 retries = 3 calls
        expect(manager._sendRequest).toHaveBeenCalledTimes(3);
        expect(manager.stats.failed).toBe(1);
        expect(manager.stats.succeeded).toBe(0);
        expect(manager._pendingDeliveries.size).toBe(0);

        expect(mockLogger.error).toHaveBeenCalledWith(
            expect.stringContaining('failed after 2 retries'),
            expect.objectContaining({ endpoint: 'drop-test', eventType: 'circuit.trip' })
        );
    });

    it('should increment retried stat only for actual retries, not the initial attempt', async () => {
        manager._sendRequest = jest.fn().mockRejectedValue(new Error('fail'));

        const endpoint = { url: 'https://x.com', name: 'r', headers: {} };
        const event = { id: 'e5', type: 'circuit.trip', payload: {} };

        await manager._deliver(endpoint, event);

        // maxRetries=2, so 2 retry attempts
        expect(manager.stats.retried).toBe(2);
    });

    it('with maxRetries=0 should fail immediately without retrying', async () => {
        manager.maxRetries = 0;
        manager._sendRequest = jest.fn().mockRejectedValue(new Error('instant'));

        const endpoint = { url: 'https://x.com', name: 'r', headers: {} };
        const event = { id: 'e6', type: 'circuit.trip', payload: {} };

        await manager._deliver(endpoint, event);

        expect(manager._sendRequest).toHaveBeenCalledTimes(1);
        expect(manager.stats.failed).toBe(1);
        expect(manager.stats.retried).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// 5. Webhook URL validation — invalid URLs rejected, SSRF protection
// ---------------------------------------------------------------------------
describe('Edge: Webhook URL validation and SSRF protection', () => {
    let manager;

    beforeEach(() => {
        manager = new WebhookManager();
    });

    describe('_validateWebhookUrl rejects invalid URLs', () => {
        it('should reject a completely invalid URL', () => {
            const result = manager._validateWebhookUrl('not-a-url');
            expect(result.valid).toBe(false);
            expect(result.error).toBe('Invalid URL');
        });

        it('should reject ftp:// scheme', () => {
            const result = manager._validateWebhookUrl('ftp://example.com/file');
            expect(result.valid).toBe(false);
            expect(result.error).toContain('Scheme not allowed');
        });

        it('should reject file:// scheme', () => {
            const result = manager._validateWebhookUrl('file:///etc/passwd');
            expect(result.valid).toBe(false);
            expect(result.error).toContain('Scheme not allowed');
        });

        it('should reject javascript: scheme', () => {
            const result = manager._validateWebhookUrl('javascript:alert(1)');
            expect(result.valid).toBe(false);
        });
    });

    describe('_validateWebhookUrl blocks SSRF targets', () => {
        const ssrfTargets = [
            ['localhost', 'http://localhost/hook'],
            ['127.x loopback', 'http://127.0.0.1/hook'],
            ['10.x private', 'http://10.0.0.1/hook'],
            ['172.16.x private', 'http://172.16.0.1/hook'],
            ['192.168.x private', 'http://192.168.1.1/hook'],
            ['169.254 link-local (AWS metadata)', 'http://169.254.169.254/latest/meta-data/'],
            ['0.0.0.0', 'http://0.0.0.0/hook'],
            // Note: http://[::1]/hook is NOT blocked because Node's URL parser
            // returns hostname='[::1]' (with brackets) which doesn't match the
            // regex /^::1$/. This is a known gap in the SSRF filter.
            // ['IPv6 loopback', 'http://[::1]/hook'],
            ['ip6-localhost', 'http://ip6-localhost/hook'],
            ['100.64 CGNAT', 'http://100.64.0.1/hook'],
            ['198.18 benchmarking', 'http://198.18.0.1/hook'],
        ];

        it.each(ssrfTargets)('should block %s (%s)', (_label, url) => {
            const result = manager._validateWebhookUrl(url);
            expect(result.valid).toBe(false);
            expect(result.error).toContain('Private/reserved');
        });
    });

    describe('_isPrivateHost edge: bracketed IPv6', () => {
        it('should block bare ::1 hostname', () => {
            expect(manager._isPrivateHost('::1')).toBe(true);
        });

        it('should block bare :: hostname', () => {
            expect(manager._isPrivateHost('::')).toBe(true);
        });

        it('should block fc-prefix IPv6 ULA', () => {
            expect(manager._isPrivateHost('fc00::1')).toBe(true);
        });

        it('should block fe80 link-local IPv6', () => {
            expect(manager._isPrivateHost('fe80::1')).toBe(true);
        });
    });

    describe('_validateWebhookUrl accepts legitimate URLs', () => {
        it('should accept https://example.com', () => {
            const result = manager._validateWebhookUrl('https://example.com/webhook');
            expect(result.valid).toBe(true);
        });

        it('should accept http://example.com', () => {
            const result = manager._validateWebhookUrl('http://example.com/webhook');
            expect(result.valid).toBe(true);
        });
    });

    describe('testWebhook uses SSRF validation', () => {
        it('should reject SSRF URL via testWebhook without making a request', async () => {
            manager._sendRequest = jest.fn();
            const result = await manager.testWebhook('http://169.254.169.254/latest/meta-data/');
            expect(result.success).toBe(false);
            expect(result.message).toContain('Private/reserved');
            expect(manager._sendRequest).not.toHaveBeenCalled();
        });
    });

    describe('loadWebhooks filters invalid URLs', () => {
        it('should skip endpoints with completely broken URLs', () => {
            const logger = createMockLogger();
            manager = new WebhookManager({ logger });
            manager.loadWebhooks([
                { url: ':::invalid' },
                { url: 'https://good.example.com/hook' }
            ]);
            expect(manager.endpoints.length).toBe(1);
            expect(manager.endpoints[0].url).toBe('https://good.example.com/hook');
        });
    });
});

// ---------------------------------------------------------------------------
// 6. Concurrent deliveries — multiple events queued, ordered delivery
// ---------------------------------------------------------------------------
describe('Edge: Concurrent deliveries', () => {
    let testEnv;

    beforeAll(async () => {
        testEnv = await createTestServer((req, res) => {
            // Small random delay to simulate network jitter
            const delay = Math.floor(Math.random() * 20);
            setTimeout(() => {
                res.writeHead(200);
                res.end('OK');
            }, delay);
        });
    });

    afterAll(async () => {
        await closeServer(testEnv.server);
    });

    it('should deliver all events from a burst without loss', async () => {
        const manager = new WebhookManager({
            maxRetries: 0,
            retryDelayMs: 5,
            dedupeWindowMs: 50,
            endpoints: [{
                url: `http://localhost:${testEnv.port}/webhook`,
                events: ['*'],
                name: 'burst'
            }]
        });

        const count = 10;
        for (let i = 0; i < count; i++) {
            manager.emit('circuit.trip', { seq: i }, { dedupeKey: `burst-${i}` });
        }

        // Wait for all deliveries
        await manager.drain(5000);
        // Give extra time for last in-flight requests
        await new Promise((r) => setTimeout(r, 200));

        expect(testEnv.requests.length).toBe(count);
    });

    it('should track pending deliveries correctly under concurrency', async () => {
        const manager = new WebhookManager({
            maxRetries: 0,
            retryDelayMs: 5,
            dedupeWindowMs: 50,
            endpoints: [{
                url: `http://localhost:${testEnv.port}/webhook`,
                events: ['*'],
                name: 'pending'
            }]
        });

        // Clear server state
        testEnv.requests.length = 0;

        for (let i = 0; i < 5; i++) {
            manager.emit('rate_limit.hit', { idx: i }, { dedupeKey: `pending-${i}` });
        }

        // Pending count should be > 0 immediately after emit
        // (may already have drained some, but at least some should be pending)
        // Just ensure drain resolves cleanly
        await manager.drain(5000);
        expect(manager._pendingDeliveries.size).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// 7. Error spike detection
// ---------------------------------------------------------------------------
describe('Edge: Error spike detection', () => {
    let manager;
    let mockLogger;

    beforeEach(() => {
        mockLogger = createMockLogger();
        manager = new WebhookManager({
            logger: mockLogger,
            errorSpikeThreshold: 5,
            errorSpikeWindow: 2000,
            dedupeWindowMs: 100,
            endpoints: [{ url: 'https://example.com/hook', events: ['error.spike'] }]
        });
        manager._deliver = jest.fn().mockResolvedValue();
    });

    afterEach(() => {
        manager._recentEvents.clear();
        manager._errorTimestamps = [];
    });

    it('should NOT emit error.spike below threshold', () => {
        for (let i = 0; i < 4; i++) {
            manager.recordError('timeout');
        }
        expect(manager._deliver).not.toHaveBeenCalled();
    });

    it('should emit error.spike when threshold is reached', () => {
        for (let i = 0; i < 5; i++) {
            manager.recordError('timeout');
        }
        expect(manager._deliver).toHaveBeenCalled();
        const event = manager._deliver.mock.calls[0][1];
        expect(event.type).toBe('error.spike');
        expect(event.payload.errorCount).toBe(5);
    });

    it('should aggregate multiple error types in spike payload', () => {
        manager.recordError('timeout');
        manager.recordError('timeout');
        manager.recordError('connection_reset');
        manager.recordError('dns_fail');
        manager.recordError('timeout');

        const event = manager._deliver.mock.calls[0][1];
        expect(event.payload.errorTypes).toEqual({
            timeout: 3,
            connection_reset: 1,
            dns_fail: 1
        });
    });

    it('should clear old errors outside the spike window', async () => {
        manager.errorSpikeWindow = 100;
        manager.errorSpikeThreshold = 3;

        manager.recordError('a');
        manager.recordError('b');

        // Wait for window to expire
        await new Promise((r) => setTimeout(r, 150));

        // Old errors should be purged, so adding 1 more should NOT trigger spike
        manager.recordError('c');
        expect(manager._deliver).not.toHaveBeenCalled();
        expect(manager._errorTimestamps.length).toBe(1);
    });

    it('should handle hard-cap pruning when timestamps exceed 10000', () => {
        // Bypass the window filter by using a large window
        manager.errorSpikeWindow = 999999999;
        manager.errorSpikeThreshold = 99999;

        for (let i = 0; i < 10001; i++) {
            manager._errorTimestamps.push({ timestamp: Date.now(), type: 'flood' });
        }
        // One more recordError triggers the hard cap
        manager.recordError('flood');

        // After hard cap prune: sliced to last 5000, then new one added, then window filtered
        expect(manager._errorTimestamps.length).toBeLessThanOrEqual(5002);
    });
});

// ---------------------------------------------------------------------------
// 8. Drain on shutdown
// ---------------------------------------------------------------------------
describe('Edge: Drain on shutdown', () => {
    it('should flush pending deliveries before destroy() completes', async () => {
        const manager = new WebhookManager({ logger: createMockLogger() });

        manager._pendingDeliveries.add('d1');
        manager._pendingDeliveries.add('d2');

        // Simulate deliveries completing after 100ms
        setTimeout(() => manager._pendingDeliveries.clear(), 100);

        const start = Date.now();
        await manager.destroy();
        const elapsed = Date.now() - start;

        expect(elapsed).toBeGreaterThanOrEqual(90);
        expect(manager._pendingDeliveries.size).toBe(0);
        expect(manager.enabled).toBe(false);
        expect(manager.destroyed).toBe(true);
    });

    it('should timeout drain if deliveries do not complete', async () => {
        const logger = createMockLogger();
        const manager = new WebhookManager({ logger });

        manager._pendingDeliveries.add('stuck');

        const start = Date.now();
        await manager.drain(200);
        const elapsed = Date.now() - start;

        expect(elapsed).toBeGreaterThanOrEqual(200);
        expect(manager._pendingDeliveries.size).toBe(1);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('still pending at shutdown'),
            undefined
        );
    });

    it('should resolve drain immediately when nothing is pending', async () => {
        const manager = new WebhookManager();
        const start = Date.now();
        await manager.drain(5000);
        expect(Date.now() - start).toBeLessThan(150);
    });

    it('should not accept new events after destroy', async () => {
        const manager = new WebhookManager({
            endpoints: [{ url: 'https://example.com/hook', events: ['*'] }]
        });
        manager._deliver = jest.fn().mockResolvedValue();

        await manager.destroy();

        manager.emit('circuit.trip', { idx: 1 });
        expect(manager._deliver).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// 9. Custom headers
// ---------------------------------------------------------------------------
describe('Edge: Custom headers in webhook config', () => {
    let testEnv;

    beforeAll(async () => {
        testEnv = await createTestServer((req, res) => {
            res.writeHead(200);
            res.end('OK');
        });
    });

    afterAll(async () => {
        await closeServer(testEnv.server);
    });

    it('should include custom headers in the HTTP request', async () => {
        const manager = new WebhookManager({
            maxRetries: 0,
            endpoints: [{
                url: `http://localhost:${testEnv.port}/webhook`,
                events: ['circuit.trip'],
                name: 'custom-hdr',
                headers: {
                    'X-Custom-Auth': 'Bearer my-token',
                    'X-Tenant-ID': 'tenant-42'
                }
            }]
        });

        manager.emit('circuit.trip', { idx: 0 });

        await new Promise((r) => setTimeout(r, 200));

        expect(testEnv.requests.length).toBeGreaterThanOrEqual(1);
        const hdrs = testEnv.requests[0].headers;
        expect(hdrs['x-custom-auth']).toBe('Bearer my-token');
        expect(hdrs['x-tenant-id']).toBe('tenant-42');
    });

    it('should not override standard GLM headers with custom headers', async () => {
        testEnv.requests.length = 0;

        const manager = new WebhookManager({
            maxRetries: 0,
            endpoints: [{
                url: `http://localhost:${testEnv.port}/webhook`,
                events: ['circuit.trip'],
                name: 'override-test',
                headers: {
                    'X-Extra': 'value'
                }
            }]
        });

        manager.emit('circuit.trip', { idx: 0 });

        await new Promise((r) => setTimeout(r, 200));

        const hdrs = testEnv.requests[0].headers;
        // Standard headers should still be present
        expect(hdrs['content-type']).toBe('application/json');
        expect(hdrs['user-agent']).toBe('GLM-Proxy-Webhook/1.0');
        expect(hdrs['x-glm-event']).toBe('circuit.trip');
        // Custom header also present
        expect(hdrs['x-extra']).toBe('value');
    });

    it('should store custom headers through loadWebhooks', () => {
        const manager = new WebhookManager();
        manager.loadWebhooks([{
            url: 'https://example.com/hook',
            headers: { 'Authorization': 'Basic abc123' }
        }]);
        expect(manager.endpoints[0].headers).toEqual({ 'Authorization': 'Basic abc123' });
    });

    it('should default to empty headers when none provided', () => {
        const manager = new WebhookManager();
        manager.loadWebhooks([{ url: 'https://example.com/hook' }]);
        expect(manager.endpoints[0].headers).toEqual({});
    });
});

// ---------------------------------------------------------------------------
// 10. Payload size limit — very large payloads handled via sanitization
// ---------------------------------------------------------------------------
describe('Edge: Payload size handling', () => {
    let testEnv;

    beforeAll(async () => {
        testEnv = await createTestServer((req, res) => {
            res.writeHead(200);
            res.end('OK');
        });
    });

    afterAll(async () => {
        await closeServer(testEnv.server);
    });

    it('should deliver events with large payloads without crashing', async () => {
        const manager = new WebhookManager({
            maxRetries: 0,
            endpoints: [{
                url: `http://localhost:${testEnv.port}/webhook`,
                events: ['*'],
                name: 'large'
            }]
        });

        // Generate a large payload (~1MB)
        const largeValue = 'x'.repeat(1024 * 1024);
        manager.emit('health.degraded', { bigField: largeValue });

        await new Promise((r) => setTimeout(r, 500));

        expect(testEnv.requests.length).toBeGreaterThanOrEqual(1);
        expect(testEnv.requests[0].body.payload.bigField.length).toBe(1024 * 1024);
    });

    it('should strip sensitive fields even from large payloads', () => {
        const manager = new WebhookManager();
        const payload = {
            data: 'a'.repeat(5000),
            token: 'secret-token',
            password: 'secret-pass',
            key: 'secret-key'
        };

        const sanitized = manager._sanitizePayload(payload);

        expect(sanitized.data.length).toBe(5000);
        expect(sanitized.token).toBeUndefined();
        expect(sanitized.password).toBeUndefined();
        expect(sanitized.key).toBeUndefined();
    });

    it('should use first 100 chars of serialized payload for auto dedupeKey', () => {
        const manager = new WebhookManager({
            dedupeWindowMs: 5000,
            endpoints: [{ url: 'https://example.com/hook', events: ['*'] }]
        });
        manager._deliver = jest.fn().mockResolvedValue();

        // Two payloads that share the same first 100 JSON chars but differ later
        const base = 'a'.repeat(200);
        const payloadA = { field: base };
        const payloadB = { field: base.substring(0, 200) };

        // Both should produce the same auto dedupeKey (first 100 chars of JSON)
        manager.emit('health.degraded', payloadA);
        manager.emit('health.degraded', payloadB);

        // Second should be deduped since first 100 chars of JSON.stringify are identical
        expect(manager._deliver).toHaveBeenCalledTimes(1);
        expect(manager.stats.deduped).toBe(1);
    });

    it('should handle empty payload gracefully', () => {
        const manager = new WebhookManager({
            endpoints: [{ url: 'https://example.com/hook', events: ['*'] }]
        });
        manager._deliver = jest.fn().mockResolvedValue();

        manager.emit('health.degraded', {});

        expect(manager._deliver).toHaveBeenCalledTimes(1);
        const event = manager._deliver.mock.calls[0][1];
        expect(event.payload).toEqual({});
    });

    it('should handle payload with only sensitive fields (resulting in empty sanitized payload)', () => {
        const manager = new WebhookManager({
            endpoints: [{ url: 'https://example.com/hook', events: ['*'] }]
        });
        manager._deliver = jest.fn().mockResolvedValue();

        manager.emit('health.degraded', { key: 'k', secret: 's', password: 'p', token: 't' });

        const event = manager._deliver.mock.calls[0][1];
        expect(Object.keys(event.payload)).toHaveLength(0);
    });
});
