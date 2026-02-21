/**
 * Request Store Extended Tests
 * Targets uncovered lines: 312, 457, 480-481, 500-501, 566-568
 * Focus: body decode failure in replay, _flush error logging,
 *        _load error handling for corrupt files, getStats with expired entries,
 *        and destroy error path with throwOnError.
 */

const { RequestStore, STORABLE_ERRORS, SENSITIVE_HEADERS } = require('../lib/request-store');
const { atomicWrite } = require('../lib/atomic-write');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Mock atomicWrite for controlled failure tests
jest.mock('../lib/atomic-write', () => {
    const original = jest.requireActual('../lib/atomic-write');
    return {
        ...original,
        atomicWrite: jest.fn(original.atomicWrite)
    };
});

describe('RequestStore Extended Coverage', () => {
    let store;
    let tmpDir;
    let mockLogger;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-ext-'));
        mockLogger = {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn()
        };
        // Reset atomicWrite mock to use real implementation
        atomicWrite.mockImplementation(jest.requireActual('../lib/atomic-write').atomicWrite);
    });

    afterEach(async () => {
        if (store && !store._destroyed) {
            await store.destroy({ throwOnError: false });
        }
        try {
            const files = fs.readdirSync(tmpDir);
            for (const file of files) {
                fs.unlinkSync(path.join(tmpDir, file));
            }
            fs.rmdirSync(tmpDir);
        } catch (e) {
            // Ignore cleanup errors
        }
    });

    function createStore(opts = {}) {
        store = new RequestStore({
            enabled: true,
            configDir: tmpDir,
            storeFile: 'test-store.json',
            maxRequests: 100,
            logger: mockLogger,
            ...opts
        });
        return store;
    }

    function makeReq(url = '/test') {
        return {
            method: 'POST',
            url,
            headers: { 'content-type': 'application/json' }
        };
    }

    // ---------------------------------------------------------------
    // Line 312: replay() body decode failure
    // ---------------------------------------------------------------
    describe('replay body decode failure (line 312)', () => {
        it('should return error when body cannot be decoded from base64', async () => {
            const onReplay = jest.fn().mockResolvedValue({ success: true });
            const s = createStore({ onReplay });

            const req = makeReq('/v1/messages');
            const storeId = s.store('req_1', req, Buffer.from('test'), 'timeout', 0, {
                errorType: 'timeout'
            });

            // Set body to a non-string value that will make Buffer.from throw
            // Buffer.from(number, 'base64') throws TypeError
            const stored = s.requests.get(storeId);
            stored.body = { toString() { throw new TypeError('Cannot convert'); } };

            const result = await s.replay(storeId);

            expect(result.success).toBe(false);
            expect(result.error).toBe('Failed to decode request body');
        });

        it('should replay successfully when body is null', async () => {
            const onReplay = jest.fn().mockResolvedValue({ success: true, keyIndex: 0 });
            const s = createStore({ onReplay });

            const req = makeReq('/v1/messages');
            // Store with a large body that gets truncated (body becomes null)
            const largeBody = Buffer.alloc(s.storeBodySizeLimit + 100);
            const storeId = s.store('req_1', req, largeBody, 'timeout', 0, {
                errorType: 'timeout'
            });

            const result = await s.replay(storeId);

            expect(result.success).toBe(true);
            expect(onReplay).toHaveBeenCalledWith(
                expect.objectContaining({
                    body: null
                })
            );
        });
    });

    // ---------------------------------------------------------------
    // Line 457: _flush error logging
    // ---------------------------------------------------------------
    describe('_flush error logging (line 457)', () => {
        it('should log error when atomicWrite fails in _flush', async () => {
            const s = createStore();

            // Store a request and wait for initial flush to complete
            s.store('req_1', makeReq(), Buffer.from('data'), 'error', 0, {
                errorType: 'timeout'
            });

            if (s._writePromise) {
                await s._writePromise;
            }

            // Now make atomicWrite reject
            atomicWrite.mockRejectedValueOnce(new Error('Disk write failure'));

            // Trigger a new flush
            s._dirty = true;
            s._destroyed = false;
            await s._flush();

            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringContaining('Failed to save request store: Disk write failure'),
                undefined
            );
        });
    });

    // ---------------------------------------------------------------
    // Lines 480-481: _load error handling for corrupt file
    // ---------------------------------------------------------------
    describe('_load error handling for corrupt file (lines 480-481)', () => {
        it('should handle corrupt JSON file gracefully and reset requests', () => {
            // Write corrupt JSON to the store file
            const storePath = path.join(tmpDir, 'corrupt-store.json');
            fs.writeFileSync(storePath, '{ this is not valid JSON!!!');

            const s = new RequestStore({
                enabled: true,
                configDir: tmpDir,
                storeFile: 'corrupt-store.json',
                logger: mockLogger
            });
            store = s; // For cleanup

            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringContaining('Failed to load request store'),
                undefined
            );
            expect(s.requests).toBeInstanceOf(Map);
            expect(s.requests.size).toBe(0);
        });

        it('should handle file with invalid data structure gracefully', () => {
            const storePath = path.join(tmpDir, 'bad-data.json');
            // Valid JSON but data.requests will cause Map constructor to throw
            fs.writeFileSync(storePath, JSON.stringify({
                version: 1,
                requests: 'not-an-array'
            }));

            const s = new RequestStore({
                enabled: true,
                configDir: tmpDir,
                storeFile: 'bad-data.json',
                logger: mockLogger
            });
            store = s;

            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringContaining('Failed to load request store'),
                undefined
            );
            expect(s.requests).toBeInstanceOf(Map);
            expect(s.requests.size).toBe(0);
        });
    });

    // ---------------------------------------------------------------
    // Lines 500-501: getStats with expired entries
    // ---------------------------------------------------------------
    describe('getStats with expired entries (lines 500-501)', () => {
        it('should count expired entries separately in stats', () => {
            const s = createStore();

            // Add a normal (non-expired) request
            s.store('req_1', makeReq(), Buffer.from('data'), 'error', 0, {
                errorType: 'timeout'
            });

            // Manually inject an expired request
            s.requests.set('req_expired_1', {
                id: 'req_expired_1',
                storedAt: Date.now() - 100000,
                expiresAt: Date.now() - 50000, // Already expired
                method: 'POST',
                url: '/test',
                headers: {},
                body: null,
                bodySize: 100,
                error: { type: 'timeout', message: 'expired' },
                replayCount: 0
            });

            s.requests.set('req_expired_2', {
                id: 'req_expired_2',
                storedAt: Date.now() - 200000,
                expiresAt: Date.now() - 100000, // Already expired
                method: 'POST',
                url: '/test',
                headers: {},
                body: null,
                bodySize: 200,
                error: { type: 'server_error', message: 'expired' },
                replayCount: 1
            });

            const stats = s.getStats();

            expect(stats.expiredPending).toBe(2);
            expect(stats.totalStored).toBe(1); // 3 total - 2 expired = 1
            // Expired requests should NOT be counted in byErrorType
            expect(stats.byErrorType.timeout).toBe(1);
            expect(stats.byErrorType.server_error).toBeUndefined();
            // Expired request bodySize should NOT be counted
            expect(stats.totalBodySize).toBeGreaterThan(0);
            // Expired replayed requests should NOT be counted
            expect(stats.replayedCount).toBe(0);
        });

        it('should return correct stats when all entries are expired', () => {
            const s = createStore();

            s.requests.set('req_exp', {
                id: 'req_exp',
                storedAt: Date.now() - 100000,
                expiresAt: Date.now() - 1000,
                method: 'POST',
                url: '/test',
                headers: {},
                body: null,
                bodySize: 50,
                error: { type: 'timeout', message: 'old' },
                replayCount: 0
            });

            const stats = s.getStats();

            expect(stats.totalStored).toBe(0);
            expect(stats.expiredPending).toBe(1);
            expect(stats.totalBodySize).toBe(0);
            expect(stats.replayedCount).toBe(0);
            expect(Object.keys(stats.byErrorType).length).toBe(0);
        });
    });

    // ---------------------------------------------------------------
    // Lines 566-568: destroy() error path with throwOnError
    // ---------------------------------------------------------------
    describe('destroy error path with throwOnError (lines 566-568)', () => {
        it('should throw error during destroy when throwOnError is true (default)', async () => {
            const s = createStore();

            // Store something and wait for the flush to finish
            s.store('req_1', makeReq(), Buffer.from('data'), 'error', 0, {
                errorType: 'timeout'
            });

            if (s._writePromise) {
                await s._writePromise;
            }

            // Make atomicWrite reject for the destroy final flush
            atomicWrite.mockRejectedValue(new Error('Destroy write failure'));

            // Reset destroyed state and mark dirty so destroy does a final flush
            s._destroyed = false;
            s._dirty = true;

            await expect(s.destroy({ throwOnError: true }))
                .rejects.toThrow('Destroy write failure');

            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringContaining('Failed to flush on destroy: Destroy write failure'),
                undefined
            );
        });

        it('should not throw error during destroy when throwOnError is false', async () => {
            const s = createStore();

            s.store('req_1', makeReq(), Buffer.from('data'), 'error', 0, {
                errorType: 'timeout'
            });

            if (s._writePromise) {
                await s._writePromise;
            }

            atomicWrite.mockRejectedValue(new Error('Destroy write failure'));

            s._destroyed = false;
            s._dirty = true;

            await expect(s.destroy({ throwOnError: false }))
                .resolves.toBeUndefined();

            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringContaining('Failed to flush on destroy: Destroy write failure'),
                undefined
            );
        });

        it('should log and throw on destroy final flush failure by default', async () => {
            const s = createStore();

            if (s._writePromise) {
                await s._writePromise;
            }

            atomicWrite.mockRejectedValue(new Error('Final flush error'));

            s._destroyed = false;
            s._dirty = true;

            let threwError = false;
            try {
                await s.destroy(); // default throwOnError = true
            } catch (err) {
                threwError = true;
                expect(err.message).toBe('Final flush error');
            }

            expect(threwError).toBe(true);
        });
    });

    // ---------------------------------------------------------------
    // Additional branch coverage
    // ---------------------------------------------------------------
    describe('store with null body', () => {
        it('should handle null body gracefully', () => {
            const s = createStore();

            const storeId = s.store('req_1', makeReq(), null, 'error', 0, {
                errorType: 'timeout'
            });

            const stored = s.requests.get(storeId);
            expect(stored.body).toBeNull();
            expect(stored.bodySize).toBe(0);
            expect(stored.bodyTruncated).toBe(false);
        });
    });

    describe('replay with request deleted between get and update', () => {
        it('should handle missing request during replay tracking gracefully', async () => {
            const onReplay = jest.fn().mockImplementation(async (data) => {
                // Delete the request from the store during replay
                // to test the "if (storedRequest)" guard at line 327
                store.requests.clear();
                return { success: true };
            });

            const s = createStore({ onReplay });
            const req = makeReq();
            const storeId = s.store('req_1', req, Buffer.from('data'), 'error', 0, {
                errorType: 'timeout'
            });

            const result = await s.replay(storeId);

            // Should still return success even if request was cleared
            expect(result.success).toBe(true);
        });
    });

    describe('_load with nonexistent file', () => {
        it('should not error when store file does not exist', () => {
            // Create store with a file that does not exist - _load should handle gracefully
            const s = new RequestStore({
                enabled: true,
                configDir: tmpDir,
                storeFile: 'nonexistent-store.json',
                logger: mockLogger
            });
            store = s;

            expect(s.requests.size).toBe(0);
            // No error should have been logged for missing file
            expect(mockLogger.error).not.toHaveBeenCalled();
        });
    });

    describe('destroy waits for in-flight write', () => {
        it('should wait for _writePromise before final flush', async () => {
            const s = createStore();

            // Store to trigger a write
            s.store('req_1', makeReq(), Buffer.from('data'), 'error', 0, {
                errorType: 'timeout'
            });

            // Destroy should wait for the in-flight write
            await s.destroy();

            // Verify file was written
            const storePath = path.join(tmpDir, 'test-store.json');
            expect(fs.existsSync(storePath)).toBe(true);
            const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));
            expect(data.requests.length).toBe(1);
        });
    });
});
