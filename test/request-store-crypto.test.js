/**
 * Request Store Crypto Tests
 * TDD tests for encryption key derivation hardening.
 *
 * The old code uses `encryptionKey.padEnd(32).slice(0, 32)` which is
 * cryptographically weak — short keys are padded with spaces, long keys
 * are silently truncated, and no key stretching is performed.
 *
 * The fix derives the key via SHA-256: crypto.createHash('sha256').update(key).digest()
 * This produces a uniform 32-byte key for any input length.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RequestStore } = require('../lib/request-store');

describe('RequestStore — encryption key derivation', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-crypto-'));
    });

    afterEach(() => {
        try {
            const files = fs.readdirSync(tmpDir);
            for (const f of files) fs.unlinkSync(path.join(tmpDir, f));
            fs.rmdirSync(tmpDir);
        } catch (_) { /* best-effort cleanup */ }
    });

    function makeStore(key) {
        return new RequestStore({
            enabled: true,
            storeFile: `crypto-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
            configDir: tmpDir,
            encryptionKey: key
        });
    }

    // --- Test 1: Key derivation produces 32-byte key ---
    test('derived key is exactly 32 bytes', async () => {
        const store = makeStore('mykey');
        try {
            expect(store._derivedKey).toBeInstanceOf(Buffer);
            expect(store._derivedKey.length).toBe(32);
        } finally {
            await store.destroy({ throwOnError: false });
        }
    });

    // --- Test 2: Key derivation uses SHA-256, not space-padding ---
    test('derived key is SHA-256 hash, not space-padded input', async () => {
        const store = makeStore('abc');
        try {
            const spacePadded = Buffer.from('abc'.padEnd(32).slice(0, 32), 'utf8');
            const sha256 = crypto.createHash('sha256').update('abc').digest();

            // Must NOT equal the old, weak derivation
            expect(store._derivedKey.equals(spacePadded)).toBe(false);

            // Must equal the proper SHA-256 derivation
            expect(store._derivedKey.equals(sha256)).toBe(true);
        } finally {
            await store.destroy({ throwOnError: false });
        }
    });

    // --- Test 3: Different keys produce different derived keys ---
    test('different input keys yield different derived keys', async () => {
        const store1 = makeStore('key1');
        const store2 = makeStore('key2');
        try {
            expect(store1._derivedKey.equals(store2._derivedKey)).toBe(false);
        } finally {
            await store1.destroy({ throwOnError: false });
            await store2.destroy({ throwOnError: false });
        }
    });

    // --- Test 4: Same key produces same derived key (deterministic) ---
    test('same input key always yields the same derived key', async () => {
        const store1 = makeStore('deterministic-test');
        const store2 = makeStore('deterministic-test');
        try {
            expect(store1._derivedKey.equals(store2._derivedKey)).toBe(true);
        } finally {
            await store1.destroy({ throwOnError: false });
            await store2.destroy({ throwOnError: false });
        }
    });

    // --- Test 5: Encrypt/decrypt roundtrip works after fix ---
    test('encrypt then decrypt roundtrip returns original data', async () => {
        const store = makeStore('roundtrip-key');
        try {
            const original = 'Hello, world! This is sensitive payload data.';
            const encrypted = store._encrypt(original);

            // Encrypted form should differ from original
            expect(encrypted).not.toBe(original);
            // Should contain IV:ciphertext format
            expect(encrypted).toMatch(/^[a-f0-9]{32}:[a-f0-9]+$/);

            const decrypted = store._decrypt(encrypted);
            expect(decrypted).toBe(original);
        } finally {
            await store.destroy({ throwOnError: false });
        }
    });

    // --- Test 6: Long keys (>32 chars) are properly handled ---
    test('long keys (>32 chars) encrypt/decrypt correctly', async () => {
        const longKey = 'a'.repeat(100);
        const store = makeStore(longKey);
        try {
            expect(store._derivedKey).toBeInstanceOf(Buffer);
            expect(store._derivedKey.length).toBe(32);

            const original = 'payload for long key test';
            const encrypted = store._encrypt(original);
            const decrypted = store._decrypt(encrypted);
            expect(decrypted).toBe(original);
        } finally {
            await store.destroy({ throwOnError: false });
        }
    });

    // --- Test 7: Full store/get roundtrip with encryption ---
    test('store then get roundtrip with encryption preserves body', async () => {
        const store = makeStore('full-roundtrip');
        try {
            const req = { method: 'POST', url: '/v1/messages', headers: { 'content-type': 'application/json' } };
            const bodyText = '{"model":"claude-3","prompt":"hello"}';
            const body = Buffer.from(bodyText);
            const storeId = store.store('req_rt', req, body, 'timeout', 0, { errorType: 'timeout' });

            const retrieved = store.get(storeId);
            const decoded = Buffer.from(retrieved.body, 'base64').toString('utf8');
            expect(decoded).toBe(bodyText);
        } finally {
            await store.destroy({ throwOnError: false });
        }
    });

    // --- Test 8: Migration — data encrypted with old key can still be read ---
    test('legacy data encrypted with padEnd key can be decrypted (migration path)', async () => {
        const rawKey = 'short';
        const store = makeStore(rawKey);
        try {
            // Simulate data encrypted with the OLD (padEnd) derivation
            const oldDerivedKey = rawKey.padEnd(32).slice(0, 32);
            const iv = crypto.randomBytes(16);
            const cipher = crypto.createCipheriv('aes-256-cbc', oldDerivedKey, iv);
            let legacyEncrypted = cipher.update('legacy-secret', 'utf8', 'hex');
            legacyEncrypted += cipher.final('hex');
            const legacyCiphertext = `${iv.toString('hex')}:${legacyEncrypted}`;

            // The store's _decrypt should still be able to handle this via fallback
            const decrypted = store._decrypt(legacyCiphertext);
            expect(decrypted).toBe('legacy-secret');
        } finally {
            await store.destroy({ throwOnError: false });
        }
    });

    // --- Test 9: _derivedKey is not set when no encryption key provided ---
    test('no _derivedKey when encryptionKey is null', async () => {
        const store = new RequestStore({
            enabled: true,
            storeFile: 'no-enc.json',
            configDir: tmpDir
        });
        try {
            expect(store._derivedKey).toBeUndefined();
        } finally {
            await store.destroy({ throwOnError: false });
        }
    });
});
