'use strict';
/**
 * Request Handler Coverage Tests
 *
 * Target: lib/request-handler.js
 * Goal: Raise branch and function coverage to 98%+
 * Focus: Uncovered lines 238, 485-491, 521-522, 525-526, 537-538, 581, 602-603, 616, 663, 694-696, 823-825, 844-846
 */

const { RequestHandler } = require('../lib/request-handler');
const { KeyManager } = require('../lib/key-manager');
const { StatsAggregator } = require('../lib/stats-aggregator');
const dns = require('dns');

describe('RequestHandler Coverage Tests', () => {
    let rh;
    let km;
    let sa;
    let mockLogger;

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

        mockLogger = {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn()
        };

        rh = new RequestHandler({
            keyManager: km,
            statsAggregator: sa,
            logger: mockLogger,
            config: {
                maxRetries: 3,
                requestTimeout: 5000,
                maxTotalConcurrency: 10,
                requestPayload: {
                    maxEntries: 5,
                    retentionMs: 60000
                }
            }
        });
    });

    afterEach(() => {
        if (rh) rh.destroy();
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    // ========== _extractContentText UNCOVERED BRANCHES (lines 485-491) ==========

    describe('_extractContentText - object content shapes (lines 485-491)', () => {
        test('extracts text from content.input (line 485)', () => {
            const result = rh._extractContentText({ input: 'hello from input' });
            expect(result).toBe('hello from input');
        });

        test('extracts text from content.content string (line 486)', () => {
            const result = rh._extractContentText({ content: 'hello from content string' });
            expect(result).toBe('hello from content string');
        });

        test('extracts text from content.content array (line 487)', () => {
            const result = rh._extractContentText({
                content: ['first message', 'second message']
            });
            expect(result).toBe('first message\n\nsecond message');
        });

        test('extracts text from content.message (line 488)', () => {
            const result = rh._extractContentText({ message: 'hello from message' });
            expect(result).toBe('hello from message');
        });

        test('returns empty string for object with no recognized fields (line 489)', () => {
            const result = rh._extractContentText({ unknown: 'field', other: 123 });
            expect(result).toBe('');
        });

        test('returns empty string for unsupported type (line 491)', () => {
            const result = rh._extractContentText(12345);
            expect(result).toBe('');
        });

        test('returns empty string for function type', () => {
            const result = rh._extractContentText(() => {});
            expect(result).toBe('');
        });
    });

    // ========== _extractRequestContentPreview TRUNCATION BRANCHES (lines 521-522, 525-526, 537-538) ==========

    describe('_extractRequestContentPreview - truncation branches (lines 521-522, 525-526, 537-538)', () => {
        test('truncates when remaining chars <= 0 (lines 521-522)', () => {
            const largePayload = Buffer.from(JSON.stringify({
                system: 'System prompt',
                messages: Array.from({ length: 20 }, (_, i) => ({
                    role: 'user',
                    content: 'A'.repeat(2000) // Each message adds to total, exhausting the 12000 char budget
                }))
            }), 'utf8');

            const preview = rh._extractRequestContentPreview(largePayload);
            expect(preview).toBeTruthy();
            expect(preview.truncated).toBe(true);
            // Should stop before processing all messages
            expect(preview.messages.length).toBeLessThan(20);
        });

        test('truncates individual message when exceeding remaining chars (lines 525-526)', () => {
            const payload = Buffer.from(JSON.stringify({
                messages: [
                    { role: 'user', content: 'A'.repeat(10000) }, // First message uses most of budget
                    { role: 'assistant', content: 'B'.repeat(5000) } // Second message gets truncated
                ]
            }), 'utf8');

            const preview = rh._extractRequestContentPreview(payload);
            expect(preview).toBeTruthy();
            expect(preview.truncated).toBe(true);
            // Second message should be truncated to fit remaining budget
            expect(preview.messages.length).toBe(2);
            expect(preview.messages[1].text).toContain('…');
        });

        test('truncates when reaching max messages limit (lines 537-538)', () => {
            const payload = Buffer.from(JSON.stringify({
                messages: Array.from({ length: 20 }, (_, i) => ({
                    role: 'user',
                    content: `Message ${i}`
                }))
            }), 'utf8');

            const preview = rh._extractRequestContentPreview(payload);
            expect(preview).toBeTruthy();
            expect(preview.truncated).toBe(true);
            // MAX_PREVIEW_MESSAGES is 12
            expect(preview.messages.length).toBe(12);
            expect(preview.messageCount).toBe(20); // Original count preserved
        });
    });

    // ========== _sanitizePayload TRUNCATION BRANCHES (lines 581, 602-603, 616) ==========

    describe('_sanitizePayload - truncation branches (lines 581, 602-603, 616)', () => {
        test('truncates array exceeding maxArrayItems (line 581)', () => {
            const largeArray = Array.from({ length: 100 }, (_, i) => `item${i}`);
            const result = rh._sanitizePayload(largeArray, {
                maxArrayItems: 10,
                maxDepth: 10,
                maxStringChars: 100,
                maxObjectEntries: 100
            });

            expect(Array.isArray(result)).toBe(true);
            expect(result.length).toBe(11); // 10 items + truncation marker
            expect(result[10]).toContain('90 more items omitted');
        });

        test('truncates object exceeding maxObjectEntries (lines 602-603)', () => {
            const largeObject = {};
            for (let i = 0; i < 150; i++) {
                largeObject[`key${i}`] = `value${i}`;
            }

            const result = rh._sanitizePayload(largeObject, {
                maxObjectEntries: 50,
                maxDepth: 10,
                maxStringChars: 100,
                maxArrayItems: 100
            });

            expect(typeof result).toBe('object');
            expect(result.__truncatedKeys).toBe('100 keys omitted');
            expect(Object.keys(result).length).toBeLessThanOrEqual(51); // 50 entries + __truncatedKeys
        });

        test('returns unsupported type marker for unsupported type (line 616)', () => {
            const result = rh._sanitizePayload(Symbol('test'), {
                maxDepth: 10,
                maxStringChars: 100,
                maxArrayItems: 100,
                maxObjectEntries: 100
            });

            expect(result).toBe('[unsupported:symbol]');
        });

        test('handles bigint as unsupported type', () => {
            const result = rh._sanitizePayload(BigInt(12345), {
                maxDepth: 10,
                maxStringChars: 100,
                maxArrayItems: 100,
                maxObjectEntries: 100
            });

            expect(result).toBe('[unsupported:bigint]');
        });
    });

    // ========== _extractRequestPayloadFull TRUNCATION (line 663) ==========

    describe('_extractRequestPayloadFull - truncation (line 663)', () => {
        test('truncates payload exceeding maxChars (line 663)', () => {
            // Create a payload that will exceed 200000 characters when stringified
            // _sanitizePayloadForFull limits: maxArrayItems=200, maxStringChars=50000
            // After sanitization: 200 messages with 1200 chars each = ~240000+ chars in JSON
            const largePayload = {
                model: 'claude-sonnet-4-5',
                messages: Array.from({ length: 300 }, (_, i) => ({
                    role: 'user',
                    content: 'B'.repeat(1200) // Large enough to exceed 200000 after sanitization
                }))
            };

            const body = Buffer.from(JSON.stringify(largePayload), 'utf8');
            const result = rh._extractRequestPayloadFull(body);

            expect(result).toBeTruthy();
            expect(result.truncated).toBe(true);
            expect(result.json).toContain('full payload truncated');
            expect(result.json.length).toBeLessThanOrEqual(200100); // Max chars + truncation message
        });
    });

    // ========== _storeRequestPayload EVICTION (lines 694-696) ==========

    describe('_storeRequestPayload - eviction (lines 694-696)', () => {
        test('evicts oldest payload when exceeding maxRequestPayloads (lines 694-696)', () => {
            // Store payloads up to the limit (maxRequestPayloads = 5 from config)
            for (let i = 0; i < 5; i++) {
                rh._storeRequestPayload(`req${i}`, {
                    json: `{"id":${i}}`,
                    truncated: false
                });
            }

            expect(rh.requestPayloadStore.size).toBe(5);

            // Add one more - should evict oldest (req0)
            rh._storeRequestPayload('req5', {
                json: '{"id":5}',
                truncated: false
            });

            expect(rh.requestPayloadStore.size).toBe(5);
            expect(rh.requestPayloadStats.evictedBySize).toBe(1);
            expect(rh.requestPayloadStore.has('req0')).toBe(false);
            expect(rh.requestPayloadStore.has('req5')).toBe(true);
        });

        test('getRequestPayload returns null for non-existent requestId', () => {
            const result = rh.getRequestPayload('non-existent');
            expect(result).toBeNull();
            expect(rh.requestPayloadStats.misses).toBe(1);
        });

        test('getRequestPayload returns cached payload and records hit', () => {
            rh._storeRequestPayload('test-req', {
                json: '{"test":"data"}',
                truncated: false
            });

            const result = rh.getRequestPayload('test-req');
            expect(result).toBeTruthy();
            expect(result.json).toBe('{"test":"data"}');
            expect(rh.requestPayloadStats.hits).toBe(1);
        });

        test('_evictExpiredPayloads removes expired entries', () => {
            rh._storeRequestPayload('req1', { json: '{"id":1}', truncated: false });
            rh._storeRequestPayload('req2', { json: '{"id":2}', truncated: false });

            // Manually expire an entry
            const entry = rh.requestPayloadStore.get('req1');
            entry.expiresAt = Date.now() - 1000;

            rh._evictExpiredPayloads();

            expect(rh.requestPayloadStore.size).toBe(1);
            expect(rh.requestPayloadStore.has('req1')).toBe(false);
            expect(rh.requestPayloadStore.has('req2')).toBe(true);
            expect(rh.requestPayloadStats.evictedByTtl).toBe(1);
        });

        test('getRequestPayloadStoreStats returns current stats', () => {
            rh._storeRequestPayload('req1', { json: '{"id":1}', truncated: false });
            rh._storeRequestPayload('req2', { json: '{"id":2}', truncated: false });

            const stats = rh.getRequestPayloadStoreStats();

            expect(stats.size).toBe(2);
            expect(stats.maxEntries).toBe(5);
            expect(stats.storedTotal).toBe(2);
            expect(stats.hits).toBe(0);
            expect(stats.misses).toBe(0);
        });
    });

    // ========== IP HEALTH MANAGEMENT (lines 823-825, 844-846) ==========

    describe('_resolveHealthyIP - IP health management (lines 823-825)', () => {
        test('returns random IP when all IPs are marked bad (lines 823-825)', async () => {
            const dnsPromises = require('dns').promises;
            const mockDnsLookup = jest.spyOn(dnsPromises, 'resolve4').mockResolvedValue([
                '1.2.3.4',
                '5.6.7.8',
                '9.10.11.12'
            ]);

            // Initialize bad IPs
            rh._badIPs = new Set(['1.2.3.4', '5.6.7.8', '9.10.11.12']);

            const result = await rh._resolveHealthyIP('api.example.com');

            expect(result).toBeTruthy();
            expect(['1.2.3.4', '5.6.7.8', '9.10.11.12']).toContain(result);
            expect(mockLogger.info).toHaveBeenCalledWith(
                'All IPs marked bad, resetting',
                { hostname: 'api.example.com', ips: ['1.2.3.4', '5.6.7.8', '9.10.11.12'] }
            );
            expect(rh._badIPs.size).toBe(0); // Should be cleared

            mockDnsLookup.mockRestore();
        });

        test('returns healthy IP when some IPs are bad', async () => {
            const dnsPromises = require('dns').promises;
            const mockDnsLookup = jest.spyOn(dnsPromises, 'resolve4').mockResolvedValue([
                '1.2.3.4',
                '5.6.7.8',
                '9.10.11.12'
            ]);

            rh._badIPs = new Set(['1.2.3.4', '5.6.7.8']);

            const result = await rh._resolveHealthyIP('api.example.com');

            expect(result).toBe('9.10.11.12'); // Only healthy IP

            mockDnsLookup.mockRestore();
        });

        test('returns first IP when only one IP available', async () => {
            const dnsPromises = require('dns').promises;
            const mockDnsLookup = jest.spyOn(dnsPromises, 'resolve4').mockResolvedValue(['1.2.3.4']);

            const result = await rh._resolveHealthyIP('api.example.com');

            expect(result).toBe('1.2.3.4');

            mockDnsLookup.mockRestore();
        });

        test('returns null when DNS returns no IPs', async () => {
            const dnsPromises = require('dns').promises;
            const mockDnsLookup = jest.spyOn(dnsPromises, 'resolve4').mockResolvedValue([]);

            const result = await rh._resolveHealthyIP('api.example.com');

            expect(result).toBeNull();

            mockDnsLookup.mockRestore();
        });

        test('returns cached IP when within cache TTL', async () => {
            const dnsPromises = require('dns').promises;
            const mockDnsLookup = jest.spyOn(dnsPromises, 'resolve4').mockResolvedValue(['5.5.5.5']);

            // Pre-populate cache
            rh._healthyIPs = new Map();
            rh._healthyIPs.set('cached.example.com', {
                ips: ['1.1.1.1', '2.2.2.2'],
                lastCheck: Date.now()
            });

            const result = await rh._resolveHealthyIP('cached.example.com');

            // Should use cache, not call DNS
            expect(result).toBeTruthy();
            expect(['1.1.1.1', '2.2.2.2']).toContain(result);
            expect(mockDnsLookup).not.toHaveBeenCalled();

            mockDnsLookup.mockRestore();
        });
    });

    describe('_markIPBad - IP marking (lines 844-846)', () => {
        test('marks IP as bad and sets expiry timer (lines 844-846)', () => {
            jest.useFakeTimers();

            rh._markIPBad('1.2.3.4');

            expect(rh._badIPs.has('1.2.3.4')).toBe(true);
            expect(rh._badIPTimers.has('1.2.3.4')).toBe(true);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                'Marked IP as unhealthy',
                { ip: '1.2.3.4', totalBad: 1 }
            );

            // Fast-forward past the 60s expiry
            jest.advanceTimersByTime(61000);

            expect(rh._badIPs.has('1.2.3.4')).toBe(false);
            expect(rh._badIPTimers.has('1.2.3.4')).toBe(false);
            expect(mockLogger.info).toHaveBeenCalledWith(
                'IP health expired, re-allowing',
                { ip: '1.2.3.4' }
            );

            jest.useRealTimers();
        });

        test('replaces existing timer when marking same IP bad again', () => {
            jest.useFakeTimers();

            rh._markIPBad('1.2.3.4');
            const firstTimer = rh._badIPTimers.get('1.2.3.4');

            // Mark the same IP bad again
            rh._markIPBad('1.2.3.4');
            const secondTimer = rh._badIPTimers.get('1.2.3.4');

            expect(rh._badIPs.has('1.2.3.4')).toBe(true);
            expect(secondTimer).not.toBe(firstTimer);

            jest.useRealTimers();
        });

        test('does nothing when IP is null or undefined', () => {
            rh._markIPBad(null);
            rh._markIPBad(undefined);

            expect(rh._badIPs.size).toBe(0);
        });

        test('does nothing when _badIPs not initialized', () => {
            rh._badIPs = null;

            // Should not throw
            expect(() => rh._markIPBad('1.2.3.4')).not.toThrow();
        });
    });

    // ========== clearRequestStream ==========

    describe('clearRequestStream', () => {
        test('clears both stream and payload store', () => {
            rh.requestStream = [{ requestId: 'test1' }];
            rh.requestPayloadStore.set('test1', { json: '{}' });

            rh.clearRequestStream();

            expect(rh.requestStream).toEqual([]);
            expect(rh.requestPayloadStore.size).toBe(0);
        });
    });

    // ========== _sanitizePayloadForPreview and _sanitizePayloadForFull ==========

    describe('_sanitizePayloadForPreview and _sanitizePayloadForFull', () => {
        test('_sanitizePayloadForPreview uses preview defaults', () => {
            const largeArray = Array.from({ length: 100 }, (_, i) => `item${i}`);
            const result = rh._sanitizePayloadForPreview(largeArray);

            expect(Array.isArray(result)).toBe(true);
            // Preview defaults to maxArrayItems: 40
            expect(result.length).toBe(41); // 40 items + truncation marker
        });

        test('_sanitizePayloadForFull uses full defaults', () => {
            const largeArray = Array.from({ length: 250 }, (_, i) => `item${i}`);
            const result = rh._sanitizePayloadForFull(largeArray);

            expect(Array.isArray(result)).toBe(true);
            // Full defaults to maxArrayItems: 200
            expect(result.length).toBe(201); // 200 items + truncation marker
        });
    });

    // ========== getRecentRequests ==========

    describe('getRecentRequests', () => {
        test('returns empty array when stream is empty', () => {
            rh.requestStream = [];
            const result = rh.getRecentRequests();
            expect(result).toEqual([]);
        });

        test('returns last N requests from stream', () => {
            rh.requestStream = [
                { requestId: 'req1', data: 'first' },
                { requestId: 'req2', data: 'second' },
                { requestId: 'req3', data: 'third' },
                { requestId: 'req4', data: 'fourth' },
                { requestId: 'req5', data: 'fifth' }
            ];

            const result = rh.getRecentRequests(3);
            expect(result).toHaveLength(3);
            expect(result[0].requestId).toBe('req3');
            expect(result[2].requestId).toBe('req5');
        });

        test('defaults to 50 requests when count not specified', () => {
            for (let i = 0; i < 60; i++) {
                rh.requestStream.push({ requestId: `req${i}` });
            }

            const result = rh.getRecentRequests();
            expect(result).toHaveLength(50);
        });
    });

    // ========== _parseRequestBody edge cases ==========

    describe('_parseRequestBody edge cases', () => {
        test('returns null for non-buffer input', () => {
            expect(rh._parseRequestBody('not a buffer')).toBeNull();
            expect(rh._parseRequestBody(null)).toBeNull();
            expect(rh._parseRequestBody(undefined)).toBeNull();
            expect(rh._parseRequestBody(123)).toBeNull();
        });

        test('returns null for empty buffer', () => {
            expect(rh._parseRequestBody(Buffer.alloc(0))).toBeNull();
        });

        test('returns null for invalid JSON', () => {
            expect(rh._parseRequestBody(Buffer.from('not json', 'utf8'))).toBeNull();
        });

        test('parses valid JSON buffer', () => {
            const result = rh._parseRequestBody(Buffer.from('{"key":"value"}', 'utf8'));
            expect(result).toEqual({ key: 'value' });
        });
    });

    // ========== DESTROY METHOD (lines 2885-2886) ==========

    describe('destroy - upstream waiter cleanup (lines 2885-2886)', () => {
        test('drains upstream waiters when destroy is called', () => {
            // Add some mock waiters
            let waiter1Resolved = false;
            let waiter2Resolved = false;

            rh._upstreamWaiters.push(() => { waiter1Resolved = true; });
            rh._upstreamWaiters.push(() => { waiter2Resolved = true; });

            expect(rh._upstreamWaiters.length).toBe(2);

            rh.destroy();

            expect(waiter1Resolved).toBe(true);
            expect(waiter2Resolved).toBe(true);
            expect(rh._upstreamWaiters.length).toBe(0);
        });

        test('clears request queue and payload store on destroy', () => {
            rh.requestPayloadStore.set('test1', { json: '{}' });

            expect(rh.requestPayloadStore.size).toBe(1);

            rh.destroy();

            expect(rh.requestPayloadStore.size).toBe(0);
        });
    });

    // ========== getQueue method ==========

    describe('getQueue', () => {
        test('returns the request queue instance', () => {
            const queue = rh.getQueue();
            expect(queue).toBeTruthy();
            expect(queue).toBe(rh.requestQueue);
        });
    });

    // ========== getTrace and getRecentTraces ==========

    describe('getTrace and getRecentTraces', () => {
        test('getTrace returns null for non-existent trace', () => {
            const result = rh.getTrace('non-existent-trace-id');
            expect(result).toBeNull();
        });

        test('getRecentTraces returns array of traces', () => {
            const traces = rh.getRecentTraces(10);
            expect(Array.isArray(traces)).toBe(true);
        });

        test('getRecentTraces defaults to 50 when count not specified', () => {
            const traces = rh.getRecentTraces();
            expect(Array.isArray(traces)).toBe(true);
        });
    });

    // ========== ConnectionHealthMonitor stats ==========

    describe('ConnectionHealthMonitor', () => {
        test('getStats returns current health stats', () => {
            rh.connectionMonitor.recordHangup();
            rh.connectionMonitor.recordHangup();
            rh.connectionMonitor.recordSuccess(); // resets consecutive

            const stats = rh.connectionMonitor.getStats();

            expect(stats.consecutiveHangups).toBe(0);
            expect(stats.totalHangups).toBe(2);
            expect(stats.agentRecreationCount).toBe(0);
        });

        test('recordSuccess resets consecutive hangups', () => {
            rh.connectionMonitor.recordHangup();
            rh.connectionMonitor.recordHangup();
            expect(rh.connectionMonitor.consecutiveHangups).toBe(2);

            rh.connectionMonitor.recordSuccess();
            expect(rh.connectionMonitor.consecutiveHangups).toBe(0);
        });
    });

    // ========== RequestQueue instance ==========

    describe('RequestQueue integration', () => {
        test('requestQueue is initialized with correct config', () => {
            expect(rh.requestQueue).toBeTruthy();
            expect(rh.requestQueue.maxSize).toBe(100); // default from config
        });
    });
});
