/**
 * Webhook Manager Extended Tests
 * Targets uncovered lines: 139, 182, 307-308, 468-470
 * Focus: dedupe cleanup of expired entries, emit catch handler,
 *        request timeout in _sendRequest, and destroy() method.
 */

const { WebhookManager, EVENT_TYPES } = require('../lib/webhook-manager');
const http = require('http');

describe('WebhookManager Extended Coverage', () => {
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

    // ---------------------------------------------------------------
    // Line 139: _shouldDedupe cleanup path when entries ARE expired
    // ---------------------------------------------------------------
    describe('_shouldDedupe cleanup of expired entries (line 139)', () => {
        it('LRU evicts oldest entries when map exceeds 1000', () => {
            manager = new WebhookManager({ dedupeWindowMs: 50 });

            // Insert 999 entries (LRU cap is 1000)
            const now = Date.now();
            for (let i = 0; i < 999; i++) {
                manager._recentEvents.set(`old_event:key${i}`, now - 100);
            }

            // Trigger _shouldDedupe which adds one more entry → total = 1000 (at cap)
            manager._shouldDedupe('new.event', 'newkey');

            // LRU keeps entries at cap
            expect(manager._recentEvents.size).toBe(1000);
            expect(manager._recentEvents.has('new.event:newkey')).toBe(true);
        });

        it('LRU automatically evicts least-recently-used when over capacity', () => {
            manager = new WebhookManager({ dedupeWindowMs: 5000 });

            // Fill to capacity (1000 entries)
            const now = Date.now();
            for (let i = 0; i < 1000; i++) {
                manager._recentEvents.set(`fill:key${i}`, now);
            }
            expect(manager._recentEvents.size).toBe(1000);

            // Adding one more triggers LRU eviction of oldest
            manager._shouldDedupe('trigger.event', 'trigger');

            // Size stays at cap — LRU evicted the oldest entry
            expect(manager._recentEvents.size).toBe(1000);
            // Oldest entry (fill:key0) was evicted
            expect(manager._recentEvents.has('fill:key0')).toBe(false);
            // New entry exists
            expect(manager._recentEvents.has('trigger.event:trigger')).toBe(true);
        });

        it('should not clean up when map is at exactly 1000 entries', () => {
            manager = new WebhookManager({ dedupeWindowMs: 50 });

            const now = Date.now();
            // Fill exactly 999 entries (after _shouldDedupe adds one, total = 1000)
            for (let i = 0; i < 999; i++) {
                manager._recentEvents.set(`test:key${i}`, now - 100);
            }

            manager._shouldDedupe('new.event', 'key999');

            // 999 old + 1 new = 1000, should NOT trigger cleanup (only when > 1000)
            expect(manager._recentEvents.size).toBe(1000);
        });
    });

    // ---------------------------------------------------------------
    // Line 182: emit() catch handler when _deliver rejects
    // ---------------------------------------------------------------
    describe('emit catch handler for failed delivery (line 182)', () => {
        it('should log error when _deliver rejects', async () => {
            manager = new WebhookManager({
                logger: mockLogger,
                endpoints: [
                    { url: 'https://example.com/hook', events: ['circuit.trip'] }
                ]
            });

            // Make _deliver reject
            manager._deliver = jest.fn().mockRejectedValue(new Error('Delivery explosion'));

            manager.emit('circuit.trip', { keyIndex: 0 });

            // Wait for the promise rejection to be handled
            await new Promise(resolve => setTimeout(resolve, 50));

            expect(mockLogger.error).toHaveBeenCalledWith(
                'Webhook delivery failed: Delivery explosion',
                expect.objectContaining({
                    endpoint: expect.any(String),
                    eventType: 'circuit.trip'
                })
            );
        });

        it('should log error with correct endpoint name when _deliver rejects', async () => {
            manager = new WebhookManager({
                logger: mockLogger,
                endpoints: [
                    { url: 'https://myendpoint.io/hook', name: 'MyEndpoint', events: ['error.spike'] }
                ]
            });

            manager._deliver = jest.fn().mockRejectedValue(new Error('Connection failed'));

            manager.emit('error.spike', { count: 5 });

            await new Promise(resolve => setTimeout(resolve, 50));

            expect(mockLogger.error).toHaveBeenCalledWith(
                'Webhook delivery failed: Connection failed',
                expect.objectContaining({
                    endpoint: 'MyEndpoint',
                    eventType: 'error.spike'
                })
            );
        });
    });

    // ---------------------------------------------------------------
    // Lines 307-308: _sendRequest timeout handler
    // ---------------------------------------------------------------
    describe('_sendRequest timeout handling (lines 307-308)', () => {
        let server;
        let serverPort;

        beforeAll((done) => {
            // Create a server that never responds (simulates timeout)
            server = http.createServer((req, res) => {
                // Intentionally do NOT respond - let the request hang
            });
            server.listen(0, () => {
                serverPort = server.address().port;
                done();
            });
        });

        afterAll((done) => {
            server.close(done);
        });

        it('should reject with timeout error when request times out', async () => {
            manager = new WebhookManager({ timeoutMs: 100 });

            const endpoint = {
                url: `http://localhost:${serverPort}/hang`,
                secret: null,
                name: 'timeout-test',
                headers: {}
            };

            const event = {
                id: 'evt_timeout_test',
                type: 'circuit.trip',
                timestamp: new Date().toISOString(),
                payload: { test: true }
            };

            await expect(manager._sendRequest(endpoint, event))
                .rejects.toThrow('Request timeout');
        });

        it('should destroy the request on timeout', async () => {
            manager = new WebhookManager({ timeoutMs: 50 });

            const endpoint = {
                url: `http://localhost:${serverPort}/hang`,
                secret: null,
                name: 'destroy-test',
                headers: {}
            };

            const event = {
                id: 'evt_destroy_test',
                type: 'circuit.trip',
                timestamp: new Date().toISOString(),
                payload: {}
            };

            const start = Date.now();
            try {
                await manager._sendRequest(endpoint, event);
            } catch (err) {
                expect(err.message).toBe('Request timeout');
            }
            const elapsed = Date.now() - start;

            // Should have timed out roughly around the timeout value
            expect(elapsed).toBeGreaterThanOrEqual(40);
            expect(elapsed).toBeLessThan(3000);
        });
    });

    // ---------------------------------------------------------------
    // Lines 468-470: destroy() method
    // ---------------------------------------------------------------
    describe('destroy() method (lines 468-470)', () => {
        it('should set destroyed flag and disable the manager', async () => {
            manager = new WebhookManager({ logger: mockLogger });

            expect(manager.enabled).toBe(true);
            expect(manager.destroyed).toBeUndefined();

            await manager.destroy();

            expect(manager.destroyed).toBe(true);
            expect(manager.enabled).toBe(false);
        });

        it('should call drain during destroy', async () => {
            manager = new WebhookManager({ logger: mockLogger });
            const drainSpy = jest.spyOn(manager, 'drain').mockResolvedValue();

            await manager.destroy();

            expect(drainSpy).toHaveBeenCalled();
            drainSpy.mockRestore();
        });

        it('should not emit events after destroy', async () => {
            manager = new WebhookManager({
                logger: mockLogger,
                endpoints: [{ url: 'https://example.com/hook' }]
            });
            manager._deliver = jest.fn().mockResolvedValue();

            await manager.destroy();

            // After destroy, enabled=false, so emit should be a no-op
            manager.emit('circuit.trip', { keyIndex: 0 });
            expect(manager._deliver).not.toHaveBeenCalled();
        });

        it('should wait for pending deliveries during destroy', async () => {
            manager = new WebhookManager({ logger: mockLogger });

            // Simulate a pending delivery
            manager._pendingDeliveries.add('pending_1');

            // Clear it after 100ms
            setTimeout(() => manager._pendingDeliveries.clear(), 100);

            const start = Date.now();
            await manager.destroy();
            const elapsed = Date.now() - start;

            expect(elapsed).toBeGreaterThanOrEqual(90);
            expect(manager.destroyed).toBe(true);
        });
    });

    // ---------------------------------------------------------------
    // Additional edge cases to improve branch coverage
    // ---------------------------------------------------------------
    describe('emit with default dedupeKey from payload', () => {
        it('should generate dedupeKey from payload when not provided', () => {
            manager = new WebhookManager({
                logger: mockLogger,
                endpoints: [{ url: 'https://example.com/hook', events: ['circuit.trip'] }]
            });
            manager._deliver = jest.fn().mockResolvedValue();

            // Emit without options.dedupeKey - should use JSON.stringify(payload).substring(0,100)
            manager.emit('circuit.trip', { keyIndex: 0, data: 'test' });
            manager.emit('circuit.trip', { keyIndex: 0, data: 'test' });

            // Second call should be deduped
            expect(manager._deliver).toHaveBeenCalledTimes(1);
            expect(manager.stats.deduped).toBe(1);
        });
    });

    describe('_sendRequest with HMAC signature', () => {
        let server;
        let serverPort;
        let receivedHeaders;

        beforeAll((done) => {
            server = http.createServer((req, res) => {
                receivedHeaders = req.headers;
                res.writeHead(200);
                res.end('OK');
            });
            server.listen(0, () => {
                serverPort = server.address().port;
                done();
            });
        });

        afterAll((done) => {
            server.close(done);
        });

        it('should include HMAC signature header when secret is provided', async () => {
            manager = new WebhookManager({ timeoutMs: 5000 });

            const endpoint = {
                url: `http://localhost:${serverPort}/webhook`,
                secret: 'my-webhook-secret',
                name: 'signed-test',
                headers: {}
            };

            const event = {
                id: 'evt_sig_test',
                type: 'circuit.trip',
                timestamp: new Date().toISOString(),
                payload: { test: true }
            };

            await manager._sendRequest(endpoint, event);

            expect(receivedHeaders['x-glm-signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
        });
    });
});
