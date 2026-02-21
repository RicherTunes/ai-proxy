'use strict';

/**
 * Atomic Write Module Tests
 *
 * Tests atomic file writing behavior using property-based assertions.
 * Asserts on OUTCOME (file is valid, content is one of the candidates)
 * not on timing or order.
 *
 * Quarantine Exit: 2026-02-28
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { atomicWrite, atomicWriteSync } = require('../lib/atomic-write');

describe('atomicWrite', () => {
    let testDir;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-test-'));
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    describe('async', () => {
        it('writes a new file', async () => {
            const filePath = path.join(testDir, 'new-file.txt');
            await atomicWrite(filePath, 'hello world');

            expect(fs.existsSync(filePath)).toBe(true);
            expect(fs.readFileSync(filePath, 'utf8')).toBe('hello world');
        });

        it('overwrites an existing file atomically', async () => {
            const filePath = path.join(testDir, 'existing.txt');
            fs.writeFileSync(filePath, 'original content');

            await atomicWrite(filePath, 'new content');

            expect(fs.readFileSync(filePath, 'utf8')).toBe('new content');
        });

        it('creates parent directories if needed', async () => {
            const filePath = path.join(testDir, 'nested', 'dir', 'file.txt');
            await atomicWrite(filePath, 'nested content');

            expect(fs.existsSync(filePath)).toBe(true);
            expect(fs.readFileSync(filePath, 'utf8')).toBe('nested content');
        });

        it('writes Buffer data', async () => {
            const filePath = path.join(testDir, 'binary.bin');
            const data = Buffer.from([0x00, 0x01, 0x02, 0xFF]);
            await atomicWrite(filePath, data, { encoding: null });

            const result = fs.readFileSync(filePath);
            expect(result.equals(data)).toBe(true);
        });

        it('writes JSON objects correctly', async () => {
            const filePath = path.join(testDir, 'data.json');
            const obj = { foo: 'bar', num: 42 };
            await atomicWrite(filePath, JSON.stringify(obj, null, 2));

            const result = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            expect(result).toEqual(obj);
        });

        it('cleans up temp file on write error', async () => {
            // Create a directory where we can't write
            const readOnlyDir = path.join(testDir, 'readonly');
            fs.mkdirSync(readOnlyDir);

            // Skip this test on Windows where permissions work differently
            if (process.platform === 'win32') {
                return;
            }

            fs.chmodSync(readOnlyDir, 0o444);

            const filePath = path.join(readOnlyDir, 'subdir', 'file.txt');

            await expect(atomicWrite(filePath, 'test')).rejects.toThrow();

            // Check no temp files left behind (at dir level we can still list)
            fs.chmodSync(readOnlyDir, 0o755);
            const files = fs.readdirSync(readOnlyDir);
            const tmpFiles = files.filter(f => f.startsWith('.tmp-'));
            expect(tmpFiles.length).toBe(0);
        });

        /**
         * Property-based concurrent write test
         *
         * Property: After N concurrent writes complete, the file must:
         * 1. Exist and be valid JSON
         * 2. Contain exactly ONE of the N candidate payloads (atomicity)
         *
         * This test does NOT assert WHICH payload wins (that's timing-dependent).
         * It asserts that the final state is valid and atomic.
         *
         * Note: On Windows, atomic renames may fail with EPERM during concurrent
         * access. We use Promise.allSettled and assert on final state.
         */
        it('handles concurrent writes to same file (property-based)', async () => {
            const filePath = path.join(testDir, 'concurrent.json');
            const candidateCount = 10;

            // Create candidate payloads
            const candidates = Array.from({ length: candidateCount }, (_, i) => ({
                version: i,
                timestamp: Date.now() + i,
                data: `payload-${i}`
            }));

            // Write all concurrently - use allSettled to handle Windows EPERM
            const writes = candidates.map(payload =>
                atomicWrite(filePath, JSON.stringify(payload))
            );

            // Wait for all writes to complete (some may fail on Windows)
            const results = await Promise.allSettled(writes);
            const successes = results.filter(r => r.status === 'fulfilled');

            // Need at least one success
            expect(successes.length).toBeGreaterThan(0);

            // Property 1: File exists and is valid JSON
            expect(fs.existsSync(filePath)).toBe(true);
            const content = fs.readFileSync(filePath, 'utf8');
            let parsed;
            expect(() => { parsed = JSON.parse(content); }).not.toThrow();

            // Property 2: Content equals ONE of the candidate payloads
            const matchingCandidate = candidates.find(c =>
                c.version === parsed.version &&
                c.data === parsed.data
            );

            expect(matchingCandidate).toBeDefined();
        });

        /**
         * Stress test with many concurrent writers
         */
        it('handles high concurrency stress test (property-based)', async () => {
            const filePath = path.join(testDir, 'stress.json');
            const writerCount = 50;

            // Create candidate payloads
            const candidates = Array.from({ length: writerCount }, (_, i) => ({
                id: `writer-${i}`,
                seq: i,
                ts: Date.now() + i
            }));

            // Write all concurrently - use allSettled to handle Windows EPERM
            const writes = candidates.map(payload =>
                atomicWrite(filePath, JSON.stringify(payload))
            );

            const results = await Promise.allSettled(writes);
            const successes = results.filter(r => r.status === 'fulfilled');

            // Need at least one success
            expect(successes.length).toBeGreaterThan(0);

            // Property: File is valid JSON matching one candidate
            const content = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(content);

            const match = candidates.find(c => c.id === parsed.id && c.seq === parsed.seq);
            expect(match).toBeDefined();
        });

        /**
         * Test that concurrent writes don't corrupt each other
         */
        it('maintains data integrity under concurrent writes', async () => {
            const filePath = path.join(testDir, 'integrity.json');

            // Generate a large payload to increase chance of interleaving
            const createPayload = (id) => ({
                id,
                // Large data to increase write time
                data: 'x'.repeat(10000),
                checksum: id.toString()
            });

            const candidates = Array.from({ length: 20 }, (_, i) => createPayload(i));

            // Use allSettled to handle Windows EPERM
            const results = await Promise.allSettled(
                candidates.map(p => atomicWrite(filePath, JSON.stringify(p)))
            );
            const successes = results.filter(r => r.status === 'fulfilled');

            // Need at least one success
            expect(successes.length).toBeGreaterThan(0);

            // Verify file integrity
            const content = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(content);

            // Checksum should match id (proves no corruption/mixing)
            expect(parsed.checksum).toBe(parsed.id.toString());
            expect(parsed.data.length).toBe(10000);
        });
    });

    describe('sync', () => {
        it('writes a new file synchronously', () => {
            const filePath = path.join(testDir, 'sync-file.txt');
            atomicWriteSync(filePath, 'sync content');

            expect(fs.existsSync(filePath)).toBe(true);
            expect(fs.readFileSync(filePath, 'utf8')).toBe('sync content');
        });

        it('overwrites existing file synchronously', () => {
            const filePath = path.join(testDir, 'sync-existing.txt');
            fs.writeFileSync(filePath, 'old');

            atomicWriteSync(filePath, 'new');

            expect(fs.readFileSync(filePath, 'utf8')).toBe('new');
        });

        it('creates parent directories synchronously', () => {
            const filePath = path.join(testDir, 'sync', 'nested', 'file.txt');
            atomicWriteSync(filePath, 'nested sync');

            expect(fs.existsSync(filePath)).toBe(true);
        });

        it('cleans up temp file on sync write error', () => {
            const filePath = path.join(testDir, 'sync-write-fail.txt');

            // Mock writeFileSync to fail
            const originalWriteFileSync = fs.writeFileSync;
            fs.writeFileSync = jest.fn(() => {
                throw new Error('Simulated write failure');
            });

            expect(() => atomicWriteSync(filePath, 'test')).toThrow('Simulated write failure');

            // Restore
            fs.writeFileSync = originalWriteFileSync;

            // Check no temp files left behind
            const files = fs.readdirSync(testDir);
            const tmpFiles = files.filter(f => f.startsWith('.tmp-'));
            expect(tmpFiles.length).toBe(0);
        });

        it('handles sync rename failure with non-permission error', () => {
            const filePath = path.join(testDir, 'sync-rename-fail.txt');

            // Mock renameSync to fail with ENOSPC (not EPERM/EACCES)
            const originalRenameSync = fs.renameSync;
            fs.renameSync = jest.fn(() => {
                const err = new Error('No space left on device');
                err.code = 'ENOSPC';
                throw err;
            });

            expect(() => atomicWriteSync(filePath, 'test')).toThrow('No space left on device');

            // Restore
            fs.renameSync = originalRenameSync;
        });

        it('handles Windows fallback path synchronously', () => {
            const filePath = path.join(testDir, 'sync-windows.txt');
            fs.writeFileSync(filePath, 'original');

            // Mock renameSync to fail with EPERM (Windows-specific)
            const originalRenameSync = fs.renameSync;
            let renameCallCount = 0;
            fs.renameSync = jest.fn((src, dest) => {
                renameCallCount++;
                if (renameCallCount === 1) {
                    const err = new Error('Operation not permitted');
                    err.code = 'EPERM';
                    throw err;
                }
                // Second call succeeds (after unlink)
                originalRenameSync(src, dest);
            });

            atomicWriteSync(filePath, 'updated');

            // Restore
            fs.renameSync = originalRenameSync;

            expect(fs.readFileSync(filePath, 'utf8')).toBe('updated');
            expect(renameCallCount).toBe(2);
        });

        it('handles sync unlink failure with non-ENOENT error (lines 99-100)', () => {
            const filePath = path.join(testDir, 'sync-unlink-fail.txt');
            fs.writeFileSync(filePath, 'original');

            // Mock renameSync to fail with EPERM, then unlinkSync to fail with EACCES
            const originalRenameSync = fs.renameSync;
            const originalUnlinkSync = fs.unlinkSync;

            fs.renameSync = jest.fn(() => {
                const err = new Error('Operation not permitted');
                err.code = 'EPERM';
                throw err;
            });

            fs.unlinkSync = jest.fn(() => {
                const err = new Error('Access denied');
                err.code = 'EACCES';
                throw err;
            });

            expect(() => atomicWriteSync(filePath, 'updated')).toThrow('Access denied');

            // Restore
            fs.renameSync = originalRenameSync;
            fs.unlinkSync = originalUnlinkSync;
        });
    });

    describe('async error paths', () => {
        it('handles rename failure with non-permission error', async () => {
            const filePath = path.join(testDir, 'async-rename-fail.txt');

            // Mock fs.promises.rename to fail with ENOSPC (not EPERM/EACCES)
            const originalRename = fs.promises.rename;
            fs.promises.rename = jest.fn(async () => {
                const err = new Error('No space left on device');
                err.code = 'ENOSPC';
                throw err;
            });

            await expect(atomicWrite(filePath, 'test')).rejects.toThrow('No space left on device');

            // Restore
            fs.promises.rename = originalRename;

            // Check no temp files left behind
            const files = fs.readdirSync(testDir);
            const tmpFiles = files.filter(f => f.startsWith('.tmp-'));
            expect(tmpFiles.length).toBe(0);
        });

        it('handles Windows fallback path asynchronously', async () => {
            const filePath = path.join(testDir, 'async-windows.txt');
            await atomicWrite(filePath, 'original');

            // Mock rename to fail with EACCES (Windows-specific)
            const originalRename = fs.promises.rename;
            let renameCallCount = 0;
            fs.promises.rename = jest.fn(async (src, dest) => {
                renameCallCount++;
                if (renameCallCount === 1) {
                    const err = new Error('Access denied');
                    err.code = 'EACCES';
                    throw err;
                }
                // Second call succeeds (after unlink)
                await originalRename(src, dest);
            });

            await atomicWrite(filePath, 'updated');

            // Restore
            fs.promises.rename = originalRename;

            expect(fs.readFileSync(filePath, 'utf8')).toBe('updated');
            expect(renameCallCount).toBe(2);
        });

        it('handles unlink error on Windows fallback (non-ENOENT)', async () => {
            const filePath = path.join(testDir, 'async-unlink-fail.txt');
            await atomicWrite(filePath, 'original');

            // Mock rename to fail with EPERM, then unlink to fail with EACCES
            const originalRename = fs.promises.rename;
            const originalUnlink = fs.promises.unlink;

            fs.promises.rename = jest.fn(async () => {
                const err = new Error('Operation not permitted');
                err.code = 'EPERM';
                throw err;
            });

            fs.promises.unlink = jest.fn(async () => {
                const err = new Error('Access denied');
                err.code = 'EACCES';
                throw err;
            });

            await expect(atomicWrite(filePath, 'updated')).rejects.toThrow('Access denied');

            // Restore
            fs.promises.rename = originalRename;
            fs.promises.unlink = originalUnlink;
        });

        it('handles deeply nested directories', async () => {
            const filePath = path.join(testDir, 'a', 'b', 'c', 'd', 'e', 'file.txt');
            await atomicWrite(filePath, 'deeply nested');

            expect(fs.existsSync(filePath)).toBe(true);
            expect(fs.readFileSync(filePath, 'utf8')).toBe('deeply nested');
        });
    });
});
