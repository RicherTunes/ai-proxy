/**
 * Request Store Module Tests
 * Tests for storing failed requests for replay functionality
 */

const { RequestStore, STORABLE_ERRORS, SENSITIVE_HEADERS } = require('../lib/request-store');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('RequestStore', () => {
    let store;
    let testDir;
    let mockLogger;

    beforeEach(() => {
        // Create temp directory for test files
        testDir = path.join(os.tmpdir(), `temp-test-${Date.now()}`);
        if (!fs.existsSync(testDir)) {
            fs.mkdirSync(testDir, { recursive: true });
        }

        mockLogger = {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn()
        };

        store = new RequestStore({
            enabled: true,
            storeFile: 'test-requests.json',
            configDir: testDir,
            maxRequests: 100,
            ttlHours: 1,
            storeBodySizeLimit: 1024,  // 1KB for tests
            logger: mockLogger
        });
    });

    afterEach(async () => {
        await store.destroy();
        // Clean up test directory
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    describe('constructor', () => {
        test('should initialize with default options', async () => {
            const defaultStore = new RequestStore({});

            expect(defaultStore.enabled).toBe(true);
            expect(defaultStore.maxRequests).toBe(1000);
            expect(defaultStore.ttlHours).toBe(24);
            expect(defaultStore.requests).toBeInstanceOf(Map);
            expect(defaultStore._cleanupInterval).toBeDefined();

            await defaultStore.destroy();
        });

        test('should allow disabling via enabled option', async () => {
            const disabledStore = new RequestStore({ enabled: false });

            expect(disabledStore.enabled).toBe(false);

            await disabledStore.destroy();
        });

        test('should load existing store from disk', async () => {
            // Create an existing store file
            const existingData = {
                version: 1,
                savedAt: new Date().toISOString(),
                requests: [[
                    'req_test',
                    {
                        id: 'req_test',
                        storedAt: Date.now(),
                        expiresAt: Date.now() + 3600000,
                        method: 'POST',
                        url: '/v1/messages',
                        headers: {},
                        error: { type: 'timeout', message: 'timeout' },
                        replayCount: 0
                    }
                ]]
            };

            fs.writeFileSync(
                path.join(testDir, 'test-requests.json'),
                JSON.stringify(existingData)
            );

            const newStore = new RequestStore({
                enabled: true,
                storeFile: 'test-requests.json',
                configDir: testDir,
                maxRequests: 100
            });

            expect(newStore.requests.size).toBe(1);
            expect(newStore.requests.has('req_test')).toBe(true);

            await newStore.destroy();
        });
    });

    describe('STORABLE_ERRORS constant', () => {
        test('should include all expected error types', () => {
            expect(STORABLE_ERRORS).toContain('timeout');
            expect(STORABLE_ERRORS).toContain('server_error');
            expect(STORABLE_ERRORS).toContain('socket_hangup');
            expect(STORABLE_ERRORS).toContain('connection_refused');
            expect(STORABLE_ERRORS).toContain('broken_pipe');
            expect(STORABLE_ERRORS).toContain('connection_aborted');
            expect(STORABLE_ERRORS).toContain('stream_premature_close');
            expect(STORABLE_ERRORS).toContain('http_parse_error');
            expect(STORABLE_ERRORS).toHaveLength(8);
        });
    });

    describe('SENSITIVE_HEADERS constant', () => {
        test('should include all sensitive headers', () => {
            expect(SENSITIVE_HEADERS).toContain('authorization');
            expect(SENSITIVE_HEADERS).toContain('x-api-key');
            expect(SENSITIVE_HEADERS).toContain('x-admin-token');
            expect(SENSITIVE_HEADERS).toContain('cookie');
            expect(SENSITIVE_HEADERS).toContain('set-cookie');
            expect(SENSITIVE_HEADERS).toContain('x-forwarded-for');
            expect(SENSITIVE_HEADERS).toContain('x-real-ip');
        });
    });

    describe('shouldStore', () => {
        test('should return true for storable error types', () => {
            expect(store.shouldStore('timeout')).toBe(true);
            expect(store.shouldStore('server_error')).toBe(true);
            expect(store.shouldStore('socket_hangup')).toBe(true);
            expect(store.shouldStore('connection_refused')).toBe(true);
        });

        test('should return false for non-storable error types', () => {
            expect(store.shouldStore('auth_error')).toBe(false);
            expect(store.shouldStore('rate_limited')).toBe(false);
            expect(store.shouldStore('tls_error')).toBe(false);
            expect(store.shouldStore('unknown')).toBe(false);
        });

        test('should return false when disabled', async () => {
            const disabledStore = new RequestStore({ enabled: false });

            expect(disabledStore.shouldStore('timeout')).toBe(false);

            await disabledStore.destroy();
        });
    });

    describe('_generateId', () => {
        test('should generate unique IDs', () => {
            const id1 = store._generateId();
            const id2 = store._generateId();

            expect(id1).toMatch(/^req_\d+_[a-f0-9]{8}$/);
            expect(id2).toMatch(/^req_\d+_[a-f0-9]{8}$/);
            expect(id1).not.toBe(id2);
        });

        test('should include timestamp in ID', () => {
            const id = store._generateId();
            const timestamp = parseInt(id.split('_')[1]);

            expect(timestamp).toBeLessThanOrEqual(Date.now());
            expect(timestamp).toBeGreaterThan(Date.now() - 1000);
        });
    });

    describe('_sanitizeHeaders', () => {
        test('should strip sensitive headers', () => {
            const headers = {
                'content-type': 'application/json',
                'authorization': 'Bearer secret',
                'x-api-key': 'key123',
                'user-agent': 'test'
            };

            const sanitized = store._sanitizeHeaders(headers);

            expect(sanitized['content-type']).toBe('application/json');
            expect(sanitized['authorization']).toBeUndefined();
            expect(sanitized['x-api-key']).toBeUndefined();
            expect(sanitized['user-agent']).toBe('test');
        });

        test('should strip lowercase variants of sensitive headers', () => {
            const headers = {
                'authorization': 'Bearer secret',
                'Authorization': 'Bearer secret2',
                'X-API-KEY': 'key123',
                'x-api-key': 'key456'
            };

            const sanitized = store._sanitizeHeaders(headers);

            expect(sanitized['authorization']).toBeUndefined();
            expect(sanitized['Authorization']).toBeUndefined();
            expect(sanitized['X-API-KEY']).toBeUndefined();
            expect(sanitized['x-api-key']).toBeUndefined();
        });

        test('should strip x-admin-token header', () => {
            const headers = {
                'x-admin-token': 'admin-secret',
                'content-type': 'application/json'
            };

            const sanitized = store._sanitizeHeaders(headers);

            expect(sanitized['x-admin-token']).toBeUndefined();
            expect(sanitized['content-type']).toBe('application/json');
        });
    });

    describe('store', () => {
        test('should store a failed request', () => {
            const req = {
                method: 'POST',
                url: '/v1/messages',
                headers: { 'content-type': 'application/json' }
            };
            const body = Buffer.from('{"model":"claude-3"}');
            const error = 'Request timeout';
            const keyIndex = 0;

            const storeId = store.store('req_123', req, body, error, keyIndex, {
                errorType: 'timeout'
            });

            expect(storeId).toMatch(/^req_\d+_[a-f0-9]{8}$/);
            expect(store.requests.has(storeId)).toBe(true);
        });

        test('should store request body as base64', () => {
            const req = { method: 'POST', url: '/test', headers: {} };
            const body = Buffer.from('test data');
            const storeId = store.store('req_1', req, body, 'error', 0);

            const stored = store.requests.get(storeId);
            expect(stored.body).toBe(Buffer.from('test data').toString('base64'));
        });

        test('should truncate body over size limit', () => {
            const req = { method: 'POST', url: '/test', headers: {} };
            const largeBody = Buffer.alloc(2000);  // Over 1KB limit
            const storeId = store.store('req_1', req, largeBody, 'error', 0);

            const stored = store.requests.get(storeId);
            expect(stored.body).toBeNull();
            expect(stored.bodyTruncated).toBe(true);
            expect(stored.bodySize).toBe(2000);
        });

        test('should enforce max requests limit', async () => {
            const limitedStore = new RequestStore({
                enabled: true,
                storeFile: 'limit-test.json',
                configDir: testDir,
                maxRequests: 3
            });

            const req = { method: 'POST', url: '/test', headers: {} };
            const body = Buffer.from('data');

            limitedStore.store('req_1', req, body, 'error', 0);
            limitedStore.store('req_2', req, body, 'error', 0);
            limitedStore.store('req_3', req, body, 'error', 0);
            limitedStore.store('req_4', req, body, 'error', 0);

            // Should only have 3 most recent
            expect(limitedStore.requests.size).toBe(3);

            await limitedStore.destroy();
        });

        test('should return null when disabled', async () => {
            const disabledStore = new RequestStore({ enabled: false });

            const req = { method: 'POST', url: '/test', headers: {} };
            const storeId = disabledStore.store('req_1', req, Buffer.from('data'), 'error', 0);

            expect(storeId).toBeNull();

            await disabledStore.destroy();
        });

        test('should include metadata in stored request', () => {
            const req = { method: 'POST', url: '/test', headers: {} };
            const storeId = store.store('req_1', req, Buffer.from('data'), 'error', 1, {
                attempts: 3,
                latency: 5000,
                errorType: 'socket_hangup'
            });

            const stored = store.requests.get(storeId);
            expect(stored.attempts).toBe(3);
            expect(stored.latency).toBe(5000);
            expect(stored.error.type).toBe('socket_hangup');
            expect(stored.error.keyIndex).toBe(1);
        });

        test('should set expiration time based on TTL', async () => {
            const req = { method: 'POST', url: '/test', headers: {} };
            const ttlHours = 2;
            const customStore = new RequestStore({
                enabled: true,
                storeFile: 'ttl-test.json',
                configDir: testDir,
                ttlHours
            });

            const before = Date.now();
            const storeId = customStore.store('req_1', req, Buffer.from('data'), 'error', 0);
            const after = Date.now();

            const stored = customStore.requests.get(storeId);
            const expectedExpiry = before + (ttlHours * 60 * 60 * 1000);

            expect(stored.expiresAt).toBeGreaterThanOrEqual(expectedExpiry);
            expect(stored.expiresAt).toBeLessThanOrEqual(after + (ttlHours * 60 * 60 * 1000));

            await customStore.destroy();
        });
    });

    describe('get', () => {
        test('should retrieve stored request by ID', () => {
            const req = { method: 'POST', url: '/test', headers: {} };
            const storeId = store.store('req_1', req, Buffer.from('data'), 'error', 0);

            const retrieved = store.get(storeId);

            expect(retrieved).toBeDefined();
            expect(retrieved.id).toBe(storeId);
            expect(retrieved.originalRequestId).toBe('req_1');
            expect(retrieved.method).toBe('POST');
        });

        test('should return null for non-existent request', () => {
            const retrieved = store.get('nonexistent');

            expect(retrieved).toBeNull();
        });

        test('should return null for expired requests', async () => {
            const req = { method: 'POST', url: '/test', headers: {} };
            const expiredStore = new RequestStore({
                enabled: true,
                storeFile: 'expired-test.json',
                configDir: testDir,
                ttlHours: -1  // Already expired
            });

            const storeId = expiredStore.store('req_1', req, Buffer.from('data'), 'error', 0);
            const retrieved = expiredStore.get(storeId);

            expect(retrieved).toBeNull();

            await expiredStore.destroy();
        });

        test('should delete expired requests on retrieval', async () => {
            const expiredStore = new RequestStore({
                enabled: true,
                storeFile: 'expired-delete-test.json',
                configDir: testDir,
                ttlHours: -1
            });

            const req = { method: 'POST', url: '/test', headers: {} };
            const storeId = expiredStore.store('req_1', req, Buffer.from('data'), 'error', 0);

            expect(expiredStore.requests.has(storeId)).toBe(true);

            expiredStore.get(storeId);

            expect(expiredStore.requests.has(storeId)).toBe(false);

            await expiredStore.destroy();
        });
    });

    describe('list', () => {
        beforeEach(async () => {
            // Add some test requests with small delays to ensure distinct timestamps
            const req = { method: 'POST', url: '/test', headers: {} };
            store.store('req_1', req, Buffer.from('data1'), 'error1', 0, { errorType: 'timeout' });
            await new Promise(r => setTimeout(r, 10));
            store.store('req_2', req, Buffer.from('data2'), 'error2', 1, { errorType: 'socket_hangup' });
            await new Promise(r => setTimeout(r, 10));
            store.store('req_3', req, Buffer.from('data3'), 'error3', 0, { errorType: 'timeout' });
        });

        test('should list all requests', () => {
            const result = store.list();

            expect(result.items).toHaveLength(3);
            expect(result.total).toBe(3);
            expect(result.offset).toBe(0);
            expect(result.limit).toBe(50);
            expect(result.hasMore).toBe(false);
        });

        test('should support pagination', () => {
            const result = store.list(0, 2);

            expect(result.items).toHaveLength(2);
            expect(result.total).toBe(3);
            expect(result.hasMore).toBe(true);
        });

        test('should filter by error type', () => {
            const result = store.list(0, 10, { errorType: 'timeout' });

            expect(result.items).toHaveLength(2);
            expect(result.items.every(r => r.error.type === 'timeout')).toBe(true);
        });

        test('should filter by method', () => {
            store.store('req_4', { method: 'GET', url: '/test', headers: {} }, Buffer.from(''), 'error', 0);

            const result = store.list(0, 10, { method: 'GET' });

            expect(result.items).toHaveLength(1);
            expect(result.items[0].method).toBe('GET');
        });

        test('should filter by URL substring', () => {
            const result = store.list(0, 10, { url: '/test' });

            expect(result.items.length).toBeGreaterThan(0);
            expect(result.items.every(r => r.url.includes('/test'))).toBe(true);
        });

        test('should sort by stored time descending', () => {
            const result = store.list();

            // First item should be most recently stored
            expect(result.items[0].originalRequestId).toBe('req_3');
            expect(result.items[1].originalRequestId).toBe('req_2');
            expect(result.items[2].originalRequestId).toBe('req_1');
        });

        test('should exclude expired requests', async () => {
            const expiredStore = new RequestStore({
                enabled: true,
                storeFile: 'expired-list-test.json',
                configDir: testDir,
                ttlHours: -1
            });

            const req = { method: 'POST', url: '/test', headers: {} };
            expiredStore.store('req_expired', req, Buffer.from('data'), 'error', 0);

            const result = expiredStore.list();

            expect(result.items).toHaveLength(0);
            expect(result.total).toBe(0);

            await expiredStore.destroy();
        });

        test('should not include sensitive data in list results', () => {
            const result = store.list();

            for (const item of result.items) {
                expect(item.body).toBeUndefined();
                expect(item.headers).toBeUndefined();
            }
        });
    });

    describe('replay', () => {
        test('should return error if request not found', async () => {
            const result = await store.replay('nonexistent');

            expect(result.success).toBe(false);
            expect(result.error).toBe('Request not found or expired');
        });

        test('should return error if replay handler not configured', async () => {
            const req = { method: 'POST', url: '/test', headers: {} };
            const storeId = store.store('req_1', req, Buffer.from('data'), 'error', 0);

            const result = await store.replay(storeId);

            expect(result.success).toBe(false);
            expect(result.error).toBe('Replay handler not configured');
        });

        test('should call replay handler with request data', async () => {
            const onReplay = jest.fn().mockResolvedValue({ success: true, statusCode: 200 });
            const replayStore = new RequestStore({
                enabled: true,
                storeFile: 'replay-test.json',
                configDir: testDir,
                onReplay
            });

            const req = { method: 'POST', url: '/v1/messages', headers: { 'content-type': 'application/json' } };
            const body = Buffer.from('{"model":"claude"}');
            const storeId = replayStore.store('req_1', req, body, 'error', 0);

            const result = await replayStore.replay(storeId, 2);

            expect(onReplay).toHaveBeenCalledWith({
                method: 'POST',
                url: '/v1/messages',
                headers: { 'content-type': 'application/json' },
                body: body,
                targetKeyIndex: 2
            });
            expect(result.success).toBe(true);

            await replayStore.destroy();
        });

        test('should update replay tracking on success', async () => {
            const onReplay = jest.fn().mockResolvedValue({ success: true });
            const replayStore = new RequestStore({
                enabled: true,
                storeFile: 'replay-tracking-test.json',
                configDir: testDir,
                onReplay
            });

            const req = { method: 'POST', url: '/test', headers: {} };
            const storeId = replayStore.store('req_1', req, Buffer.from('data'), 'error', 0);

            expect(replayStore.requests.get(storeId).replayCount).toBe(0);

            await replayStore.replay(storeId);

            expect(replayStore.requests.get(storeId).replayCount).toBe(1);
            expect(replayStore.requests.get(storeId).lastReplayResult).toBe('success');

            await replayStore.destroy();
        });

        test('should update replay tracking on failure', async () => {
            const onReplay = jest.fn().mockResolvedValue({ success: false, error: 'failed' });
            const replayStore = new RequestStore({
                enabled: true,
                storeFile: 'replay-fail-test.json',
                configDir: testDir,
                onReplay
            });

            const req = { method: 'POST', url: '/test', headers: {} };
            const storeId = replayStore.store('req_1', req, Buffer.from('data'), 'error', 0);

            await replayStore.replay(storeId);

            expect(replayStore.requests.get(storeId).lastReplayResult).toBe('failed');

            await replayStore.destroy();
        });

        test('should handle replay handler exceptions', async () => {
            const onReplay = jest.fn().mockRejectedValue(new Error('Handler failed'));
            const replayStore = new RequestStore({
                enabled: true,
                storeFile: 'replay-exception-test.json',
                configDir: testDir,
                onReplay
            });

            const req = { method: 'POST', url: '/test', headers: {} };
            const storeId = replayStore.store('req_1', req, Buffer.from('data'), 'error', 0);

            const result = await replayStore.replay(storeId);

            expect(result.success).toBe(false);
            expect(result.error).toBe('Handler failed');

            await replayStore.destroy();
        });
    });

    describe('delete', () => {
        test('should delete stored request', () => {
            const req = { method: 'POST', url: '/test', headers: {} };
            const storeId = store.store('req_1', req, Buffer.from('data'), 'error', 0);

            expect(store.requests.has(storeId)).toBe(true);

            const deleted = store.delete(storeId);

            expect(deleted).toBe(true);
            expect(store.requests.has(storeId)).toBe(false);
        });

        test('should return false for non-existent request', () => {
            const deleted = store.delete('nonexistent');

            expect(deleted).toBe(false);
        });
    });

    describe('deleteMany', () => {
        test('should delete multiple requests', () => {
            const req = { method: 'POST', url: '/test', headers: {} };
            const id1 = store.store('req_1', req, Buffer.from('data'), 'error', 0);
            const id2 = store.store('req_2', req, Buffer.from('data'), 'error', 0);
            const id3 = store.store('req_3', req, Buffer.from('data'), 'error', 0);

            const deleted = store.deleteMany([id1, id3]);

            expect(deleted).toBe(2);
            expect(store.requests.has(id1)).toBe(false);
            expect(store.requests.has(id2)).toBe(true);
            expect(store.requests.has(id3)).toBe(false);
        });

        test('should return count of deleted requests', () => {
            const deleted = store.deleteMany(['nonexistent1', 'nonexistent2']);

            expect(deleted).toBe(0);
        });
    });

    describe('cleanup', () => {
        test('should remove expired requests', async () => {
            const shortLivedStore = new RequestStore({
                enabled: true,
                storeFile: 'cleanup-test.json',
                configDir: testDir,
                ttlHours: -1  // Already expired
            });

            const req = { method: 'POST', url: '/test', headers: {} };
            shortLivedStore.store('req_expired', req, Buffer.from('data'), 'error', 0);

            expect(shortLivedStore.requests.size).toBe(1);

            const removed = shortLivedStore.cleanup();

            expect(removed).toBe(1);
            expect(shortLivedStore.requests.size).toBe(0);

            await shortLivedStore.destroy();
        });

        test('should return 0 when no expired requests', () => {
            const removed = store.cleanup();

            expect(removed).toBe(0);
        });
    });

    describe('getStats', () => {
        test('should return store statistics', () => {
            const req = { method: 'POST', url: '/test', headers: {} };
            store.store('req_1', req, Buffer.from('data'), 'error', 0, { errorType: 'timeout' });
            store.store('req_2', req, Buffer.from('data'), 'error', 0, { errorType: 'timeout' });
            store.store('req_3', req, Buffer.from('data'), 'error', 0, { errorType: 'socket_hangup' });

            const stats = store.getStats();

            expect(stats.totalStored).toBe(3);
            expect(stats.expiredPending).toBe(0);
            expect(stats.replayedCount).toBe(0);
            expect(stats.byErrorType.timeout).toBe(2);
            expect(stats.byErrorType.socket_hangup).toBe(1);
            expect(stats.maxRequests).toBe(100);
            expect(stats.ttlHours).toBe(1);
        });

        test('should count replayed requests', () => {
            const req = { method: 'POST', url: '/test', headers: {} };
            const storeId = store.store('req_1', req, Buffer.from('data'), 'error', 0);

            // Simulate a replay
            store.requests.get(storeId).replayCount = 1;

            const stats = store.getStats();

            expect(stats.replayedCount).toBe(1);
        });

        test('should calculate total body size', () => {
            const req = { method: 'POST', url: '/test', headers: {} };
            store.store('req_1', req, Buffer.from('data123456'), 'error', 0);

            const stats = store.getStats();

            expect(stats.totalBodySize).toBe(10);  // "data123456" = 10 bytes base64
        });
    });

    describe('clear', () => {
        test('should clear all stored requests', () => {
            const req = { method: 'POST', url: '/test', headers: {} };
            store.store('req_1', req, Buffer.from('data'), 'error', 0);
            store.store('req_2', req, Buffer.from('data'), 'error', 0);

            expect(store.requests.size).toBe(2);

            store.clear();

            expect(store.requests.size).toBe(0);
        });
    });

    describe('destroy', () => {
        test('should clear cleanup interval', async () => {
            expect(store._cleanupInterval).toBeDefined();

            await store.destroy();

            expect(store._cleanupInterval).toBeNull();
        });
    });

    describe('_enforceLimit', () => {
        test('should remove oldest requests when over limit', async () => {
            const limitedStore = new RequestStore({
                enabled: true,
                storeFile: 'limit-enforce-test.json',
                configDir: testDir,
                maxRequests: 2
            });

            const req = { method: 'POST', url: '/test', headers: {} };

            // Add 3 requests (over limit of 2)
            limitedStore.store('req_1', req, Buffer.from('data'), 'error', 0);
            await new Promise(r => setTimeout(r, 10));  // Small delay to ensure different timestamps
            limitedStore.store('req_2', req, Buffer.from('data'), 'error', 0);
            await new Promise(r => setTimeout(r, 10));
            limitedStore.store('req_3', req, Buffer.from('data'), 'error', 0);

            // Should only have 2 most recent
            expect(limitedStore.requests.size).toBe(2);
            const remaining = Array.from(limitedStore.requests.values());
            expect(remaining.some(r => r.originalRequestId === 'req_3')).toBe(true);
            expect(remaining.some(r => r.originalRequestId === 'req_1')).toBe(false);

            await limitedStore.destroy();
        });
    });

    describe('encryption', () => {
        test('should encrypt body when encryption key provided', async () => {
            const encryptedStore = new RequestStore({
                enabled: true,
                storeFile: 'encrypt-test.json',
                configDir: testDir,
                encryptionKey: '32-byte-key-for-testing-encryption'
            });

            const req = { method: 'POST', url: '/test', headers: {} };
            const body = Buffer.from('sensitive data');
            const storeId = encryptedStore.store('req_1', req, body, 'error', 0);

            const stored = encryptedStore.requests.get(storeId);
            expect(stored.body).not.toContain('sensitive data');
            expect(stored.body).toMatch(/^[a-f0-9]+:[a-f0-9]+$/);  // IV:encrypted format

            await encryptedStore.destroy();
        });

        test('should decrypt body on retrieval', async () => {
            const encryptedStore = new RequestStore({
                enabled: true,
                storeFile: 'decrypt-test.json',
                configDir: testDir,
                encryptionKey: '32-byte-key-for-testing-encryption'
            });

            const req = { method: 'POST', url: '/test', headers: {} };
            const body = Buffer.from('sensitive data');
            const storeId = encryptedStore.store('req_1', req, body, 'error', 0);

            const retrieved = encryptedStore.get(storeId);

            const bodyText = Buffer.from(retrieved.body, 'base64').toString();
            expect(bodyText).toContain('sensitive data');

            await encryptedStore.destroy();
        });

        test('should handle decryption failure gracefully', async () => {
            const encryptedStore = new RequestStore({
                enabled: true,
                storeFile: 'decrypt-fail-test.json',
                configDir: testDir,
                encryptionKey: '32-byte-key-for-testing-encryption'
            });

            // Manually set invalid encrypted data
            encryptedStore.requests.set('req_invalid', {
                id: 'req_invalid',
                storedAt: Date.now(),
                expiresAt: Date.now() + 3600000,
                method: 'POST',
                url: '/test',
                headers: {},
                body: 'invalid:encrypted-data-format',
                error: { type: 'timeout', message: 'error' }
            });

            const retrieved = encryptedStore.get('req_invalid');

            // Should return as-is on decryption failure
            expect(retrieved.body).toBe('invalid:encrypted-data-format');

            await encryptedStore.destroy();
        });
    });
});
