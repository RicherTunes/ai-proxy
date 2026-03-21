'use strict';

/**
 * Request Store Coverage Tests
 * Targets uncovered lines: 40, 121, 300, 439, 496, 528, 567
 * Focus: constructor defaults, _encrypt without key, list with lastReplayAt,
 *        _enforceLimit oldestId branch, _load without requests property,
 *        getStats with falsy bodySize, destroy with null cleanupInterval
 */

const { RequestStore } = require('../lib/request-store');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('RequestStore Coverage Gap Tests', () => {
    let tmpDir;
    let stores;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-cov-'));
        stores = [];
    });

    afterEach(async () => {
        for (const s of stores) {
            if (!s._destroyed) {
                await s.destroy({ throwOnError: false });
            }
        }
        try {
            const files = fs.readdirSync(tmpDir);
            for (const f of files) fs.unlinkSync(path.join(tmpDir, f));
            fs.rmdirSync(tmpDir);
        } catch (_) { /* best-effort cleanup */ }
    });

    function createStore(opts = {}) {
        const s = new RequestStore({
            enabled: true,
            configDir: tmpDir,
            storeFile: `cov-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
            ...opts
        });
        stores.push(s);
        return s;
    }

    function makeReq(method = 'POST', url = '/v1/messages') {
        return { method, url, headers: { 'content-type': 'application/json' } };
    }

    // ---------------------------------------------------------------
    // Line 40: constructor with no arguments (default parameter)
    // ---------------------------------------------------------------
    describe('constructor with no arguments (line 40)', () => {
        it('should use default values when called with no options object', async () => {
            // Calling constructor with literally no arguments triggers the default parameter
            const s = new RequestStore();
            stores.push(s);

            // Verify defaults are applied
            expect(s.enabled).toBe(true);
            expect(s.maxRequests).toBe(1000);
            expect(s.ttlHours).toBe(24);
            expect(s.storeFile).toBe('failed-requests.json');
            expect(s.requests).toBeInstanceOf(Map);
            expect(s.encryptionKey).toBeNull();
            expect(s._derivedKey).toBeUndefined();
            expect(s._legacyKey).toBeUndefined();
        });
    });

    // ---------------------------------------------------------------
    // Line 121: _encrypt returns data unchanged when no encryption key
    // ---------------------------------------------------------------
    describe('_encrypt without encryption key (line 121)', () => {
        it('should return data unchanged when encryptionKey is null', () => {
            const s = createStore({ encryptionKey: null });

            const plaintext = 'sensitive payload';
            const result = s._encrypt(plaintext);

            // When no encryption key, _encrypt returns data as-is
            expect(result).toBe(plaintext);
        });

        it('should return data unchanged when encryptionKey is undefined', () => {
            const s = createStore();
            // encryptionKey defaults to null/undefined

            const plaintext = '{"model":"claude-3"}';
            const result = s._encrypt(plaintext);

            expect(result).toBe(plaintext);
        });
    });

    // ---------------------------------------------------------------
    // Line 300: list() with truthy lastReplayAt
    // ---------------------------------------------------------------
    describe('list with lastReplayAt set (line 300)', () => {
        it('should format lastReplayAt as ISO string when truthy', async () => {
            const s = createStore();

            const storeId = s.store('req_1', makeReq(), Buffer.from('data'), 'timeout', 0, {
                errorType: 'timeout'
            });

            // Manually set lastReplayAt to a truthy timestamp
            const replayTime = Date.now() - 5000;
            const stored = s.requests.get(storeId);
            stored.lastReplayAt = replayTime;

            const result = s.list();

            expect(result.items).toHaveLength(1);
            // lastReplayAt should be formatted as ISO string, not null
            expect(result.items[0].lastReplayAt).toBe(new Date(replayTime).toISOString());
        });

        it('should return null lastReplayAt when it is null', () => {
            const s = createStore();

            s.store('req_1', makeReq(), Buffer.from('data'), 'timeout', 0, {
                errorType: 'timeout'
            });

            const result = s.list();

            expect(result.items[0].lastReplayAt).toBeNull();
        });

        it('should handle lastReplayAt of 0 (falsy but numeric)', () => {
            const s = createStore();

            const storeId = s.store('req_1', makeReq(), Buffer.from('data'), 'timeout', 0, {
                errorType: 'timeout'
            });

            // Set lastReplayAt to 0 (falsy)
            const stored = s.requests.get(storeId);
            stored.lastReplayAt = 0;

            const result = s.list();

            // 0 is falsy, so should return null
            expect(result.items[0].lastReplayAt).toBeNull();
        });
    });

    // ---------------------------------------------------------------
    // Line 439: _enforceLimit with oldestId found
    // ---------------------------------------------------------------
    describe('_enforceLimit oldestId branch (line 439)', () => {
        it('should find and delete oldestId when over limit', async () => {
            const s = createStore({ maxRequests: 2 });

            // Add 3 requests with timestamps in order
            const id1 = s.store('req_1', makeReq(), Buffer.from('a'), 'err', 0, { errorType: 'timeout' });
            await new Promise(r => setTimeout(r, 5));
            const id2 = s.store('req_2', makeReq(), Buffer.from('b'), 'err', 0, { errorType: 'timeout' });
            await new Promise(r => setTimeout(r, 5));
            const id3 = s.store('req_3', makeReq(), Buffer.from('c'), 'err', 0, { errorType: 'timeout' });

            // Should only have 2 entries (oldest removed)
            expect(s.requests.size).toBe(2);

            // id1 (oldest) should be deleted
            expect(s.requests.has(id1)).toBe(false);
            expect(s.requests.has(id2)).toBe(true);
            expect(s.requests.has(id3)).toBe(true);
        });

        it('should handle exact boundary where size equals maxRequests', () => {
            const s = createStore({ maxRequests: 3 });

            s.store('req_1', makeReq(), Buffer.from('a'), 'err', 0, { errorType: 'timeout' });
            s.store('req_2', makeReq(), Buffer.from('b'), 'err', 0, { errorType: 'timeout' });
            s.store('req_3', makeReq(), Buffer.from('c'), 'err', 0, { errorType: 'timeout' });

            // At exact limit, no eviction should happen
            expect(s.requests.size).toBe(3);
        });
    });

    // ---------------------------------------------------------------
    // Line 496: _load with valid JSON but no requests property
    // ---------------------------------------------------------------
    describe('_load without requests property (line 496)', () => {
        it('should handle file with valid JSON but no requests property', () => {
            const storeFile = `no-req-${Date.now()}.json`;
            const storePath = path.join(tmpDir, storeFile);

            // Write JSON without a "requests" field
            fs.writeFileSync(storePath, JSON.stringify({
                version: 1,
                savedAt: new Date().toISOString()
                // No "requests" property
            }));

            const s = new RequestStore({
                enabled: true,
                configDir: tmpDir,
                storeFile
            });
            stores.push(s);

            // Should initialize empty map when no requests property
            expect(s.requests).toBeInstanceOf(Map);
            expect(s.requests.size).toBe(0);
        });

        it('should handle file with null requests property', () => {
            const storeFile = `null-req-${Date.now()}.json`;
            const storePath = path.join(tmpDir, storeFile);

            fs.writeFileSync(storePath, JSON.stringify({
                version: 1,
                requests: null
            }));

            const s = new RequestStore({
                enabled: true,
                configDir: tmpDir,
                storeFile
            });
            stores.push(s);

            // null is falsy, so if (data.requests) won't execute
            expect(s.requests).toBeInstanceOf(Map);
            expect(s.requests.size).toBe(0);
        });

        it('should handle file with empty requests array', () => {
            const storeFile = `empty-req-${Date.now()}.json`;
            const storePath = path.join(tmpDir, storeFile);

            fs.writeFileSync(storePath, JSON.stringify({
                version: 1,
                requests: []
            }));

            const s = new RequestStore({
                enabled: true,
                configDir: tmpDir,
                storeFile
            });
            stores.push(s);

            // Empty array is truthy, so it should be loaded
            expect(s.requests).toBeInstanceOf(Map);
            expect(s.requests.size).toBe(0);
        });
    });

    // ---------------------------------------------------------------
    // Line 528: getStats with falsy bodySize
    // ---------------------------------------------------------------
    describe('getStats with falsy bodySize (line 528)', () => {
        it('should handle request with bodySize of 0', () => {
            const s = createStore();

            s.store('req_1', makeReq(), null, 'timeout', 0, { errorType: 'timeout' });

            const stats = s.getStats();

            // bodySize of 0 should use || 0 fallback
            expect(stats.totalBodySize).toBe(0);
        });

        it('should handle request with undefined bodySize', () => {
            const s = createStore();

            const storeId = s.store('req_1', makeReq(), Buffer.from('data'), 'timeout', 0, {
                errorType: 'timeout'
            });

            // Manually set bodySize to undefined
            const stored = s.requests.get(storeId);
            stored.bodySize = undefined;

            const stats = s.getStats();

            // undefined || 0 = 0
            expect(stats.totalBodySize).toBe(0);
        });

        it('should handle request with null bodySize', () => {
            const s = createStore();

            const storeId = s.store('req_1', makeReq(), Buffer.from('data'), 'timeout', 0, {
                errorType: 'timeout'
            });

            // Manually set bodySize to null
            const stored = s.requests.get(storeId);
            stored.bodySize = null;

            const stats = s.getStats();

            // null || 0 = 0
            expect(stats.totalBodySize).toBe(0);
        });

        it('should sum multiple requests with mixed bodySizes', () => {
            const s = createStore();

            s.store('req_1', makeReq(), Buffer.from('abc'), 'timeout', 0, { errorType: 'timeout' }); // 3 bytes
            s.store('req_2', makeReq(), null, 'timeout', 0, { errorType: 'timeout' }); // 0 bytes

            const stats = s.getStats();

            // Should sum: 3 + 0 = 3
            expect(stats.totalBodySize).toBe(3);
        });
    });

    // ---------------------------------------------------------------
    // Line 567: destroy when _cleanupInterval is already null
    // ---------------------------------------------------------------
    describe('destroy with null cleanupInterval (line 567)', () => {
        it('should handle destroy when _cleanupInterval is already null', async () => {
            const s = createStore();

            // First destroy clears the interval
            await s.destroy();

            expect(s._cleanupInterval).toBeNull();

            // Manually reset destroyed to false to test the null interval branch
            s._destroyed = false;

            // Second destroy should handle null _cleanupInterval without error
            await s.destroy();

            // Should still be null (no error thrown)
            expect(s._cleanupInterval).toBeNull();
        });

        it('should skip clearInterval when _cleanupInterval is falsy', async () => {
            const s = createStore();

            // Manually set interval to null before destroy
            clearInterval(s._cleanupInterval);
            s._cleanupInterval = null;

            // Destroy should not throw when interval is already null
            await s.destroy();

            expect(s._destroyed).toBe(true);
        });

        it('should clear interval when _cleanupInterval is set', async () => {
            const s = createStore();

            // Interval should be set initially
            expect(s._cleanupInterval).not.toBeNull();

            await s.destroy();

            // After destroy, interval should be null
            expect(s._cleanupInterval).toBeNull();
        });
    });

    // ---------------------------------------------------------------
    // Additional edge cases for completeness
    // ---------------------------------------------------------------
    describe('additional edge cases', () => {
        it('should handle _decrypt without encryption key', () => {
            const s = createStore({ encryptionKey: null });

            const data = 'some-data-without-colon';
            const result = s._decrypt(data);

            // Without encryption key, returns as-is
            expect(result).toBe(data);
        });

        it('should handle _decrypt with colon but no encryption key', () => {
            const s = createStore({ encryptionKey: null });

            const data = 'ivhex:ciphertext';
            const result = s._decrypt(data);

            // Without encryption key, returns as-is (even with colon)
            expect(result).toBe(data);
        });

        it('should handle constructor with explicit undefined options', async () => {
            // Explicitly passing undefined should trigger default parameter
            const s = new RequestStore(undefined);
            stores.push(s);

            expect(s.enabled).toBe(true);
            expect(s.maxRequests).toBe(1000);
        });

        it('should handle constructor with explicit null options', async () => {
            // Passing null crashes because default params only apply for undefined, not null
            // This documents the behavior: null is not a valid constructor argument
            expect(() => new RequestStore(null)).toThrow();
        });
    });
});
