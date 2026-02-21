'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { RequestStore } = require('../lib/request-store');

describe('RequestStore Async I/O', () => {
    let tmpDir;
    let store;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-async-'));
    });

    afterEach(async () => {
        if (store && !store._destroyed) {
            await store.destroy({ throwOnError: false });
        }
        // Clean up temp dir
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

    test('multiple rapid store() calls result in bounded writes', async () => {
        const s = createStore();

        // Rapidly store 10 requests
        for (let i = 0; i < 10; i++) {
            s.store(`req-${i}`, makeReq(`/test-${i}`), Buffer.from('{}'), 'timeout error', 0, { errorType: 'timeout' });
        }

        // Wait for writes to complete
        await s.destroy();

        // Verify all 10 are persisted
        const data = JSON.parse(fs.readFileSync(path.join(tmpDir, 'test-store.json'), 'utf8'));
        expect(data.requests.length).toBe(10);
    });

    test('destroy() flushes final state to disk', async () => {
        const s = createStore();

        s.store('req-1', makeReq(), Buffer.from('hello'), 'server error', 0, { errorType: 'server_error' });

        await s.destroy();

        // Verify file exists and contains the request
        const storePath = path.join(tmpDir, 'test-store.json');
        expect(fs.existsSync(storePath)).toBe(true);

        const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));
        expect(data.requests.length).toBe(1);
        expect(data.requests[0][1].originalRequestId).toBe('req-1');
    });

    test('destroy({ throwOnError: false }) does not throw', async () => {
        const s = createStore();
        // Make configDir invalid to trigger write error
        s.configDir = '/nonexistent/path/that/should/not/exist';
        s._dirty = true;

        // Should not throw
        await expect(s.destroy({ throwOnError: false })).resolves.toBeUndefined();
    });

    test('destroy() is idempotent', async () => {
        const s = createStore();

        s.store('req-1', makeReq(), Buffer.from('{}'), 'error', 0, { errorType: 'timeout' });

        await s.destroy();
        // Second call should be no-op
        await s.destroy();

        const data = JSON.parse(fs.readFileSync(path.join(tmpDir, 'test-store.json'), 'utf8'));
        expect(data.requests.length).toBe(1);
    });

    test('store after destroy is no-op for save', async () => {
        const s = createStore();

        s.store('req-1', makeReq(), Buffer.from('{}'), 'error', 0, { errorType: 'timeout' });
        await s.destroy();

        // Store after destroy - should still add to in-memory map but not write
        s.store('req-2', makeReq(), Buffer.from('{}'), 'error', 0, { errorType: 'timeout' });

        // The file should only have req-1
        const data = JSON.parse(fs.readFileSync(path.join(tmpDir, 'test-store.json'), 'utf8'));
        expect(data.requests.length).toBe(1);
    });

    test('concurrent store and read works correctly', async () => {
        const s = createStore();

        // Store and immediately read
        const id = s.store('req-1', makeReq(), Buffer.from('{"key":"value"}'), 'timeout', 0, { errorType: 'timeout' });
        const retrieved = s.get(id);

        expect(retrieved).not.toBeNull();
        expect(retrieved.method).toBe('POST');
        expect(retrieved.url).toBe('/test');

        await s.destroy();
    });
});
