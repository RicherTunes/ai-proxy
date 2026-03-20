'use strict';

/**
 * Request Store Edge-Case Tests
 *
 * Covers:
 *  1. TTL expiry — stored requests expire and are auto-cleaned
 *  2. Max store size — oldest entries evicted when maxSize exceeded
 *  3. Concurrent store/get — rapid parallel operations don't corrupt data
 *  4. Search/filter — search by model, status, time range returns correct results
 *  5. Encryption toggle — enable/disable mid-flight, both forms accessible
 *  6. Body truncation — large bodies truncated at configured limit
 *  7. Timer cleanup — cleanup interval cleared on destroy
 *  8. Edge cases — requestId collision, null/undefined body, get nonexistent ID
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { RequestStore } = require('../lib/request-store');

describe('RequestStore Edge Cases', () => {
    let tmpDir;
    /** @type {RequestStore[]} */
    let stores;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-edges-'));
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
            storeFile: `edges-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
            maxRequests: 100,
            ttlHours: 1,
            storeBodySizeLimit: 1024,
            ...opts
        });
        stores.push(s);
        return s;
    }

    function makeReq(method = 'POST', url = '/v1/messages') {
        return { method, url, headers: { 'content-type': 'application/json' } };
    }

    // ================================================================
    // 1. TTL expiry
    // ================================================================
    describe('TTL expiry', () => {
        test('stored requests with past TTL are returned as null from get()', () => {
            const s = createStore({ ttlHours: -1 }); // already expired
            const id = s.store('req_1', makeReq(), Buffer.from('body'), 'timeout', 0, { errorType: 'timeout' });

            expect(id).not.toBeNull();
            expect(s.get(id)).toBeNull();
        });

        test('expired entries are removed from map on get()', () => {
            const s = createStore({ ttlHours: -1 });
            const id = s.store('req_1', makeReq(), Buffer.from('body'), 'timeout', 0, { errorType: 'timeout' });

            expect(s.requests.has(id)).toBe(true);
            s.get(id); // triggers expiry removal
            expect(s.requests.has(id)).toBe(false);
        });

        test('cleanup() removes all expired entries and returns count', () => {
            const s = createStore({ ttlHours: -1 });
            s.store('req_1', makeReq(), Buffer.from('a'), 'err', 0, { errorType: 'timeout' });
            s.store('req_2', makeReq(), Buffer.from('b'), 'err', 0, { errorType: 'timeout' });
            s.store('req_3', makeReq(), Buffer.from('c'), 'err', 0, { errorType: 'timeout' });

            expect(s.requests.size).toBe(3);
            const removed = s.cleanup();
            expect(removed).toBe(3);
            expect(s.requests.size).toBe(0);
        });

        test('cleanup() leaves non-expired entries intact', () => {
            const s = createStore({ ttlHours: 24 });
            s.store('req_fresh', makeReq(), Buffer.from('ok'), 'err', 0, { errorType: 'timeout' });

            // Manually insert an expired entry
            s.requests.set('req_old', {
                id: 'req_old',
                storedAt: Date.now() - 200000,
                expiresAt: Date.now() - 100000,
                method: 'POST',
                url: '/test',
                headers: {},
                body: null,
                bodySize: 0,
                error: { type: 'timeout', message: 'old' },
                replayCount: 0,
                lastReplayAt: null,
                lastReplayResult: null
            });

            expect(s.requests.size).toBe(2);
            const removed = s.cleanup();
            expect(removed).toBe(1);
            expect(s.requests.size).toBe(1);
            expect(s.requests.has('req_old')).toBe(false);
        });

        test('list() excludes expired entries', () => {
            const s = createStore({ ttlHours: 24 });
            s.store('req_alive', makeReq(), Buffer.from('ok'), 'err', 0, { errorType: 'timeout' });

            // Inject expired
            s.requests.set('req_dead', {
                id: 'req_dead',
                originalRequestId: 'orig_dead',
                storedAt: Date.now() - 200000,
                expiresAt: Date.now() - 1,
                method: 'POST',
                url: '/test',
                headers: {},
                body: null,
                bodySize: 0,
                bodyTruncated: false,
                error: { type: 'timeout', message: 'old' },
                replayCount: 0,
                lastReplayAt: null,
                lastReplayResult: null
            });

            const result = s.list();
            expect(result.total).toBe(1);
            expect(result.items[0].originalRequestId).toBe('req_alive');
        });

        test('getStats() counts expired entries in expiredPending', () => {
            const s = createStore({ ttlHours: 24 });
            s.store('req_live', makeReq(), Buffer.from('x'), 'err', 0, { errorType: 'timeout' });

            s.requests.set('req_exp', {
                id: 'req_exp',
                storedAt: Date.now() - 200000,
                expiresAt: Date.now() - 1,
                method: 'POST',
                url: '/test',
                headers: {},
                body: null,
                bodySize: 50,
                error: { type: 'server_error', message: 'old' },
                replayCount: 0
            });

            const stats = s.getStats();
            expect(stats.totalStored).toBe(1);
            expect(stats.expiredPending).toBe(1);
        });
    });

    // ================================================================
    // 1b. TTL exact boundary
    // ================================================================
    describe('TTL exact boundary', () => {
        test('item at exactly TTL ms is still valid (expiresAt uses strict >)', () => {
            jest.useFakeTimers();
            try {
                const ttlHours = 1;
                const ttlMs = ttlHours * 60 * 60 * 1000;
                const s = createStore({ ttlHours });

                const id = s.store('req_boundary', makeReq(), Buffer.from('data'), 'err', 0, { errorType: 'timeout' });
                const stored = s.requests.get(id);
                const expiresAt = stored.expiresAt;

                // Advance to exactly expiresAt — Date.now() === expiresAt
                // The get() check is: Date.now() > request.expiresAt
                // So at exactly the boundary, it should still be valid
                jest.setSystemTime(expiresAt);
                expect(s.get(id)).not.toBeNull();
            } finally {
                jest.useRealTimers();
            }
        });

        test('item 1ms past TTL is expired', () => {
            jest.useFakeTimers();
            try {
                const ttlHours = 1;
                const s = createStore({ ttlHours });

                const id = s.store('req_boundary', makeReq(), Buffer.from('data'), 'err', 0, { errorType: 'timeout' });
                const stored = s.requests.get(id);
                const expiresAt = stored.expiresAt;

                // Advance 1ms past expiresAt — Date.now() > request.expiresAt
                jest.setSystemTime(expiresAt + 1);
                expect(s.get(id)).toBeNull();
            } finally {
                jest.useRealTimers();
            }
        });
    });

    // ================================================================
    // 2. Max store size
    // ================================================================
    describe('Max store size', () => {
        test('store does not exceed maxRequests', () => {
            const s = createStore({ maxRequests: 3 });
            for (let i = 0; i < 10; i++) {
                s.store(`req_${i}`, makeReq(), Buffer.from(`data${i}`), 'err', 0, { errorType: 'timeout' });
            }
            expect(s.requests.size).toBe(3);
        });

        test('oldest entries are evicted first', async () => {
            const s = createStore({ maxRequests: 2 });

            s.store('req_first', makeReq(), Buffer.from('1'), 'err', 0, { errorType: 'timeout' });
            await new Promise(r => setTimeout(r, 5));
            s.store('req_second', makeReq(), Buffer.from('2'), 'err', 0, { errorType: 'timeout' });
            await new Promise(r => setTimeout(r, 5));
            s.store('req_third', makeReq(), Buffer.from('3'), 'err', 0, { errorType: 'timeout' });

            expect(s.requests.size).toBe(2);
            const remaining = Array.from(s.requests.values());
            const origIds = remaining.map(r => r.originalRequestId);
            expect(origIds).toContain('req_second');
            expect(origIds).toContain('req_third');
            expect(origIds).not.toContain('req_first');
        });

        test('maxRequests of 1 keeps only the latest entry', async () => {
            const s = createStore({ maxRequests: 1 });

            s.store('req_a', makeReq(), Buffer.from('a'), 'err', 0, { errorType: 'timeout' });
            await new Promise(r => setTimeout(r, 5));
            s.store('req_b', makeReq(), Buffer.from('b'), 'err', 0, { errorType: 'timeout' });

            expect(s.requests.size).toBe(1);
            const only = Array.from(s.requests.values())[0];
            expect(only.originalRequestId).toBe('req_b');
        });

        test('maxRequests of 0 evicts every entry immediately', () => {
            const s = createStore({ maxRequests: 0 });
            s.store('req_x', makeReq(), Buffer.from('x'), 'err', 0, { errorType: 'timeout' });
            expect(s.requests.size).toBe(0);
        });
    });

    // ================================================================
    // 3. Concurrent store/get
    // ================================================================
    describe('Concurrent store/get', () => {
        test('rapid sequential store + get operations preserve data integrity', () => {
            const s = createStore({ maxRequests: 500 });
            const ids = [];

            for (let i = 0; i < 100; i++) {
                const id = s.store(
                    `req_${i}`,
                    makeReq('POST', `/test/${i}`),
                    Buffer.from(`payload-${i}`),
                    'timeout',
                    0,
                    { errorType: 'timeout' }
                );
                ids.push(id);
            }

            // Every stored ID should be retrievable
            for (let i = 0; i < 100; i++) {
                const retrieved = s.get(ids[i]);
                expect(retrieved).not.toBeNull();
                expect(retrieved.originalRequestId).toBe(`req_${i}`);
                expect(retrieved.url).toBe(`/test/${i}`);
            }
        });

        test('interleaved store and delete operations do not corrupt map', () => {
            const s = createStore({ maxRequests: 500 });
            const ids = [];

            for (let i = 0; i < 50; i++) {
                const id = s.store(`req_${i}`, makeReq(), Buffer.from('d'), 'err', 0, { errorType: 'timeout' });
                ids.push(id);
            }

            // Delete every other entry
            for (let i = 0; i < 50; i += 2) {
                s.delete(ids[i]);
            }

            // Even-indexed should be gone, odd-indexed should remain
            for (let i = 0; i < 50; i++) {
                if (i % 2 === 0) {
                    expect(s.get(ids[i])).toBeNull();
                } else {
                    expect(s.get(ids[i])).not.toBeNull();
                }
            }
            expect(s.requests.size).toBe(25);
        });

        test('store during cleanup does not lose new entries', () => {
            const s = createStore({ ttlHours: 24 });

            // Add some entries that will NOT expire
            const freshId = s.store('req_fresh', makeReq(), Buffer.from('fresh'), 'err', 0, { errorType: 'timeout' });

            // Inject expired
            s.requests.set('req_expired', {
                id: 'req_expired',
                originalRequestId: 'orig_expired',
                storedAt: Date.now() - 200000,
                expiresAt: Date.now() - 1,
                method: 'POST',
                url: '/test',
                headers: {},
                body: null,
                bodySize: 0,
                error: { type: 'timeout', message: 'old' },
                replayCount: 0,
                lastReplayAt: null,
                lastReplayResult: null
            });

            s.cleanup();

            expect(s.get(freshId)).not.toBeNull();
            expect(s.requests.has('req_expired')).toBe(false);
        });

        test('parallel Promise.all store calls all succeed', async () => {
            const s = createStore({ maxRequests: 200 });
            const promises = [];

            for (let i = 0; i < 50; i++) {
                promises.push(
                    new Promise(resolve => {
                        const id = s.store(
                            `req_${i}`,
                            makeReq(),
                            Buffer.from(`p-${i}`),
                            'err',
                            0,
                            { errorType: 'timeout' }
                        );
                        resolve(id);
                    })
                );
            }

            const ids = await Promise.all(promises);
            expect(ids.filter(Boolean).length).toBe(50);
            expect(s.requests.size).toBe(50);
        });
    });

    // ================================================================
    // 4. Search/filter
    // ================================================================
    describe('Search/filter', () => {
        let s;

        beforeEach(async () => {
            s = createStore({ ttlHours: 24 });

            s.store('req_post_1', makeReq('POST', '/v1/messages'), Buffer.from('a'), 'timeout', 0, { errorType: 'timeout' });
            await new Promise(r => setTimeout(r, 5));
            s.store('req_get_1', makeReq('GET', '/v1/models'), Buffer.from('b'), 'server error', 1, { errorType: 'server_error' });
            await new Promise(r => setTimeout(r, 5));
            s.store('req_post_2', makeReq('POST', '/v1/completions'), Buffer.from('c'), 'hangup', 0, { errorType: 'socket_hangup' });
            await new Promise(r => setTimeout(r, 5));
            s.store('req_put_1', makeReq('PUT', '/v1/messages/123'), Buffer.from('d'), 'refused', 2, { errorType: 'connection_refused' });
        });

        test('filter by method returns only matching entries', () => {
            const result = s.list(0, 50, { method: 'POST' });
            expect(result.total).toBe(2);
            expect(result.items.every(r => r.method === 'POST')).toBe(true);
        });

        test('filter by errorType returns only matching entries', () => {
            const result = s.list(0, 50, { errorType: 'timeout' });
            expect(result.total).toBe(1);
            expect(result.items[0].error.type).toBe('timeout');
        });

        test('filter by URL substring', () => {
            const result = s.list(0, 50, { url: '/v1/messages' });
            expect(result.total).toBe(2); // /v1/messages and /v1/messages/123
            expect(result.items.every(r => r.url.includes('/v1/messages'))).toBe(true);
        });

        test('filter by URL returns empty when no match', () => {
            const result = s.list(0, 50, { url: '/v2/nonexistent' });
            expect(result.total).toBe(0);
            expect(result.items).toHaveLength(0);
        });

        test('combined method + URL filter narrows results', () => {
            // Only GET requests with /v1/models
            const result = s.list(0, 50, { method: 'GET', url: '/v1/models' });
            expect(result.total).toBe(1);
            expect(result.items[0].method).toBe('GET');
            expect(result.items[0].url).toContain('/v1/models');
        });

        test('combined errorType + method filter', () => {
            const result = s.list(0, 50, { errorType: 'timeout', method: 'POST' });
            expect(result.total).toBe(1);
        });

        test('pagination offset skips entries correctly', () => {
            const all = s.list(0, 50);
            expect(all.total).toBe(4);

            const page2 = s.list(2, 2);
            expect(page2.items).toHaveLength(2);
            expect(page2.hasMore).toBe(false);
            // Items are sorted newest-first, so offset 2 skips the 2 newest
            expect(page2.items[0].id).toBe(all.items[2].id);
            expect(page2.items[1].id).toBe(all.items[3].id);
        });

        test('pagination with limit 1 returns one entry at a time', () => {
            const p1 = s.list(0, 1);
            expect(p1.items).toHaveLength(1);
            expect(p1.hasMore).toBe(true);

            const p2 = s.list(1, 1);
            expect(p2.items).toHaveLength(1);
            expect(p2.hasMore).toBe(true);
            expect(p2.items[0].id).not.toBe(p1.items[0].id);
        });

        test('getStats() categorizes by errorType correctly', () => {
            const stats = s.getStats();
            expect(stats.byErrorType.timeout).toBe(1);
            expect(stats.byErrorType.server_error).toBe(1);
            expect(stats.byErrorType.socket_hangup).toBe(1);
            expect(stats.byErrorType.connection_refused).toBe(1);
            expect(stats.totalStored).toBe(4);
        });
    });

    // ================================================================
    // 5. Encryption toggle
    // ================================================================
    describe('Encryption toggle', () => {
        test('data stored without encryption is readable without key', () => {
            const s = createStore({ encryptionKey: null });
            const id = s.store('req_plain', makeReq(), Buffer.from('plain text'), 'err', 0, { errorType: 'timeout' });

            const retrieved = s.get(id);
            expect(retrieved).not.toBeNull();
            const decoded = Buffer.from(retrieved.body, 'base64').toString();
            expect(decoded).toBe('plain text');
        });

        test('data stored with encryption is encrypted in memory', () => {
            const s = createStore({ encryptionKey: 'my-secret-key' });
            const id = s.store('req_enc', makeReq(), Buffer.from('secret data'), 'err', 0, { errorType: 'timeout' });

            // Raw stored body should be encrypted (IV:ciphertext format)
            const raw = s.requests.get(id);
            expect(raw.body).toMatch(/^[a-f0-9]+:[a-f0-9]+$/);
            expect(raw.body).not.toContain('secret data');
        });

        test('encrypted data is decrypted on get()', () => {
            const s = createStore({ encryptionKey: 'my-secret-key' });
            const id = s.store('req_enc', makeReq(), Buffer.from('secret data'), 'err', 0, { errorType: 'timeout' });

            const retrieved = s.get(id);
            const decoded = Buffer.from(retrieved.body, 'base64').toString();
            expect(decoded).toBe('secret data');
        });

        test('switching from no-encryption to encryption: old unencrypted data still readable', () => {
            // Step 1: store without encryption
            const storeFile = `toggle-${Date.now()}.json`;
            const s1 = createStore({ encryptionKey: null, storeFile });
            const id = s1.store('req_plain', makeReq(), Buffer.from('open text'), 'err', 0, { errorType: 'timeout' });

            // Grab the raw body (plain base64)
            const rawBody = s1.requests.get(id).body;
            expect(rawBody).toBe(Buffer.from('open text').toString('base64'));

            // Step 2: create new store instance WITH encryption key but manually transfer the entry
            const s2 = createStore({ encryptionKey: 'new-key', storeFile: `toggle2-${Date.now()}.json` });

            // Copy the unencrypted entry into the encrypted store
            const entry = s1.requests.get(id);
            s2.requests.set(id, { ...entry });

            // get() should detect the body doesn't have IV:ciphertext format and _decrypt returns as-is
            const retrieved = s2.get(id);
            expect(retrieved).not.toBeNull();
            // Since _decrypt tries to split on ':', base64 without ':' is returned as-is
            // The body is plain base64 — still decodable
            const decoded = Buffer.from(retrieved.body, 'base64').toString();
            expect(decoded).toBe('open text');
        });

        test('switching from encryption to no-encryption: encrypted data returned as-is', () => {
            // Step 1: store with encryption
            const s1 = createStore({ encryptionKey: 'secret' });
            const id = s1.store('req_enc', makeReq(), Buffer.from('classified'), 'err', 0, { errorType: 'timeout' });

            const rawEncryptedBody = s1.requests.get(id).body;
            expect(rawEncryptedBody).toMatch(/^[a-f0-9]+:[a-f0-9]+$/);

            // Step 2: new store without encryption key — transfer the encrypted entry
            const s2 = createStore({ encryptionKey: null });
            const entry = s1.requests.get(id);
            s2.requests.set(id, { ...entry });

            // get() without encryptionKey returns body as-is (no decryption attempted)
            const retrieved = s2.get(id);
            expect(retrieved.body).toBe(rawEncryptedBody);
        });

        test('wrong encryption key falls back to returning data as-is', () => {
            const s1 = createStore({ encryptionKey: 'key-A' });
            const id = s1.store('req_enc', makeReq(), Buffer.from('data'), 'err', 0, { errorType: 'timeout' });
            const rawBody = s1.requests.get(id).body;

            // New store with different key
            const s2 = createStore({ encryptionKey: 'key-B' });
            const entry = s1.requests.get(id);
            s2.requests.set(id, { ...entry });

            const retrieved = s2.get(id);
            // Neither new key nor legacy key can decrypt — returned as-is
            expect(retrieved.body).toBe(rawBody);
        });
    });

    // ================================================================
    // 6. Body truncation
    // ================================================================
    describe('Body truncation', () => {
        test('body at exactly the size limit is stored', () => {
            const s = createStore({ storeBodySizeLimit: 100 });
            const exactBody = Buffer.alloc(100, 'x');
            const id = s.store('req_exact', makeReq(), exactBody, 'err', 0, { errorType: 'timeout' });

            const stored = s.requests.get(id);
            expect(stored.body).not.toBeNull();
            expect(stored.bodyTruncated).toBe(false);
            expect(stored.bodySize).toBe(100);
        });

        test('body one byte over the limit is truncated', () => {
            const s = createStore({ storeBodySizeLimit: 100 });
            const overBody = Buffer.alloc(101, 'x');
            const id = s.store('req_over', makeReq(), overBody, 'err', 0, { errorType: 'timeout' });

            const stored = s.requests.get(id);
            expect(stored.body).toBeNull();
            expect(stored.bodyTruncated).toBe(true);
            expect(stored.bodySize).toBe(101);
        });

        test('very large body is truncated and size is preserved', () => {
            const s = createStore({ storeBodySizeLimit: 512 });
            const hugeBody = Buffer.alloc(1024 * 1024, 'Z'); // 1 MB
            const id = s.store('req_huge', makeReq(), hugeBody, 'err', 0, { errorType: 'timeout' });

            const stored = s.requests.get(id);
            expect(stored.body).toBeNull();
            expect(stored.bodyTruncated).toBe(true);
            expect(stored.bodySize).toBe(1024 * 1024);
        });

        test('zero-length body is stored (not truncated)', () => {
            const s = createStore({ storeBodySizeLimit: 100 });
            const emptyBody = Buffer.alloc(0);
            const id = s.store('req_empty', makeReq(), emptyBody, 'err', 0, { errorType: 'timeout' });

            const stored = s.requests.get(id);
            // Buffer.alloc(0).length === 0, and 0 <= 100, but the condition is body && body.length <= limit
            // Buffer.alloc(0) is truthy but has length 0
            expect(stored.bodySize).toBe(0);
            expect(stored.bodyTruncated).toBe(false);
        });

        test('truncated body still allows replay with null body', async () => {
            const onReplay = jest.fn().mockResolvedValue({ success: true });
            const s = createStore({ storeBodySizeLimit: 10, onReplay });
            const bigBody = Buffer.alloc(100, 'x');
            const id = s.store('req_big', makeReq(), bigBody, 'err', 0, { errorType: 'timeout' });

            const result = await s.replay(id);
            expect(result.success).toBe(true);
            expect(onReplay).toHaveBeenCalledWith(expect.objectContaining({ body: null }));
        });

        test('storeBodySizeLimit of 0 truncates all bodies', () => {
            const s = createStore({ storeBodySizeLimit: 0 });
            const smallBody = Buffer.from('hi');
            const id = s.store('req_small', makeReq(), smallBody, 'err', 0, { errorType: 'timeout' });

            const stored = s.requests.get(id);
            expect(stored.body).toBeNull();
            expect(stored.bodyTruncated).toBe(true);
            expect(stored.bodySize).toBe(2);
        });
    });

    // ================================================================
    // 7. Timer cleanup
    // ================================================================
    describe('Timer cleanup', () => {
        test('cleanup interval is set on construction', () => {
            const s = createStore();
            expect(s._cleanupInterval).toBeDefined();
            expect(s._cleanupInterval).not.toBeNull();
        });

        test('cleanup interval is cleared on destroy', async () => {
            const s = createStore();
            expect(s._cleanupInterval).not.toBeNull();

            await s.destroy();

            expect(s._cleanupInterval).toBeNull();
        });

        test('cleanup interval is cleared even when destroy is called twice', async () => {
            const s = createStore();
            await s.destroy();
            expect(s._cleanupInterval).toBeNull();

            // Second call is idempotent
            await s.destroy();
            expect(s._cleanupInterval).toBeNull();
        });

        test('_destroyed flag is set after destroy', async () => {
            const s = createStore();
            expect(s._destroyed).toBe(false);

            await s.destroy();

            expect(s._destroyed).toBe(true);
        });

        test('_save becomes no-op after destroy (no new writes scheduled)', async () => {
            const s = createStore();
            s.store('req_1', makeReq(), Buffer.from('data'), 'err', 0, { errorType: 'timeout' });
            await s.destroy();

            // Clear dirty flag and try _save — should not create new write promise
            s._dirty = false;
            const oldPromise = s._writePromise;
            s._save();
            // _save sets _dirty true but returns early because _destroyed is true
            expect(s._dirty).toBe(true);
            // _writePromise should not have changed (no new flush scheduled)
            expect(s._writePromise).toBe(oldPromise);
        });
    });

    // ================================================================
    // 8. Edge cases
    // ================================================================
    describe('Edge cases', () => {
        test('get() with nonexistent ID returns null', () => {
            const s = createStore();
            expect(s.get('totally-fake-id')).toBeNull();
            expect(s.get('')).toBeNull();
            expect(s.get(undefined)).toBeNull();
        });

        test('delete() with nonexistent ID returns false', () => {
            const s = createStore();
            expect(s.delete('nope')).toBe(false);
        });

        test('store with null body sets bodySize 0 and bodyTruncated false', () => {
            const s = createStore();
            const id = s.store('req_null', makeReq(), null, 'err', 0, { errorType: 'timeout' });

            const stored = s.requests.get(id);
            expect(stored.body).toBeNull();
            expect(stored.bodySize).toBe(0);
            expect(stored.bodyTruncated).toBe(false);
        });

        test('store with undefined body sets bodySize 0 and bodyTruncated false', () => {
            const s = createStore();
            const id = s.store('req_undef', makeReq(), undefined, 'err', 0, { errorType: 'timeout' });

            const stored = s.requests.get(id);
            expect(stored.body).toBeNull();
            expect(stored.bodySize).toBe(0);
            expect(stored.bodyTruncated).toBe(false);
        });

        test('store with same originalRequestId creates separate entries', () => {
            const s = createStore();
            const id1 = s.store('req_dup', makeReq(), Buffer.from('first'), 'err', 0, { errorType: 'timeout' });
            const id2 = s.store('req_dup', makeReq(), Buffer.from('second'), 'err', 0, { errorType: 'timeout' });

            expect(id1).not.toBe(id2);
            expect(s.get(id1)).not.toBeNull();
            expect(s.get(id2)).not.toBeNull();
            expect(s.get(id1).originalRequestId).toBe('req_dup');
            expect(s.get(id2).originalRequestId).toBe('req_dup');
        });

        test('store with very long URL', () => {
            const s = createStore();
            const longUrl = '/v1/messages?' + 'x'.repeat(10000);
            const id = s.store('req_longurl', makeReq('POST', longUrl), Buffer.from('ok'), 'err', 0, { errorType: 'timeout' });

            const stored = s.requests.get(id);
            expect(stored.url).toBe(longUrl);
        });

        test('store with empty headers object', () => {
            const s = createStore();
            const id = s.store('req_nohdr', { method: 'POST', url: '/test', headers: {} }, Buffer.from('ok'), 'err', 0, { errorType: 'timeout' });

            const stored = s.requests.get(id);
            expect(stored.headers).toEqual({});
        });

        test('store returns null when store is disabled', () => {
            const s = createStore({ enabled: false });
            const id = s.store('req_disabled', makeReq(), Buffer.from('data'), 'err', 0, { errorType: 'timeout' });
            expect(id).toBeNull();
        });

        test('shouldStore returns false for unknown error type', () => {
            const s = createStore();
            expect(s.shouldStore('some_random_error')).toBe(false);
        });

        test('shouldStore returns false when disabled', () => {
            const s = createStore({ enabled: false });
            expect(s.shouldStore('timeout')).toBe(false);
        });

        test('clear() on empty store does not throw', () => {
            const s = createStore();
            expect(() => s.clear()).not.toThrow();
            expect(s.requests.size).toBe(0);
        });

        test('deleteMany with mix of valid and invalid IDs', () => {
            const s = createStore();
            const id1 = s.store('req_1', makeReq(), Buffer.from('a'), 'err', 0, { errorType: 'timeout' });
            s.store('req_2', makeReq(), Buffer.from('b'), 'err', 0, { errorType: 'timeout' });

            const deleted = s.deleteMany([id1, 'fake_id', 'another_fake']);
            expect(deleted).toBe(1);
        });

        test('list with offset beyond total returns empty items', () => {
            const s = createStore();
            s.store('req_1', makeReq(), Buffer.from('a'), 'err', 0, { errorType: 'timeout' });

            const result = s.list(100, 50);
            expect(result.items).toHaveLength(0);
            expect(result.total).toBe(1);
            expect(result.hasMore).toBe(false);
        });

        test('replay expired request returns not found', async () => {
            const s = createStore({ ttlHours: -1, onReplay: jest.fn() });
            const id = s.store('req_exp', makeReq(), Buffer.from('data'), 'err', 0, { errorType: 'timeout' });

            const result = await s.replay(id);
            expect(result.success).toBe(false);
            expect(result.error).toBe('Request not found or expired');
        });

        test('store with metadata defaults when metadata is omitted', () => {
            const s = createStore();
            const id = s.store('req_nometa', makeReq(), Buffer.from('ok'), 'error message', 0);

            const stored = s.requests.get(id);
            expect(stored.error.type).toBe('unknown');
            expect(stored.attempts).toBe(1);
            expect(stored.latency).toBeNull();
        });

        test('_generateId produces unique IDs across many calls', () => {
            const s = createStore();
            const ids = new Set();
            for (let i = 0; i < 1000; i++) {
                ids.add(s._generateId());
            }
            expect(ids.size).toBe(1000);
        });
    });
});
