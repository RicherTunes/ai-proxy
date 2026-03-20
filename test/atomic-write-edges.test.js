'use strict';

/**
 * Atomic Write Edge-Case Tests
 *
 * Tests file I/O safety for atomicWrite:
 * 1. Basic JSON roundtrip
 * 2. Atomic — no partial writes (crash simulation)
 * 3. Concurrent writes — no corruption/interleaving
 * 4. Large file (10MB) integrity
 * 5. Permission error handling
 * 6. Directory creation for nested paths
 * 7. Unicode content (emoji, CJK, RTL)
 * 8. Empty/null content behavior
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { atomicWrite, atomicWriteSync } = require('../lib/atomic-write');

describe('atomicWrite edge cases', () => {
    let testDir;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-edges-'));
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    // ── 1. Basic JSON roundtrip ───────────────────────────────────────
    describe('1 - Basic roundtrip', () => {
        it('writes JSON and reads it back with exact match', async () => {
            const filePath = path.join(testDir, 'roundtrip.json');
            const payload = {
                name: 'test',
                version: 42,
                nested: { a: [1, 2, 3], b: true, c: null },
                tags: ['alpha', 'beta']
            };

            await atomicWrite(filePath, JSON.stringify(payload, null, 2));

            const raw = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(raw);
            expect(parsed).toEqual(payload);
        });

        it('roundtrips with atomicWriteSync as well', () => {
            const filePath = path.join(testDir, 'roundtrip-sync.json');
            const payload = { sync: true, value: 'hello' };

            atomicWriteSync(filePath, JSON.stringify(payload));

            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            expect(parsed).toEqual(payload);
        });
    });

    // ── 2. Atomic — no partial writes (crash simulation) ──────────────
    describe('2 - Atomic — no partial writes on crash', () => {
        it('original file is intact when temp file is deleted mid-write', async () => {
            const filePath = path.join(testDir, 'crash-safe.json');
            const originalData = { version: 'original', ok: true };
            fs.writeFileSync(filePath, JSON.stringify(originalData));

            // Intercept fs.promises.writeFile to simulate a crash:
            // after writing the temp file, delete it before rename completes.
            const origWriteFile = fs.promises.writeFile;
            const origRename = fs.promises.rename;

            let tempFilePath = null;

            fs.promises.writeFile = jest.fn(async (p, data, opts) => {
                await origWriteFile(p, data, opts);
                // Capture the temp file path (starts with .tmp-)
                if (path.basename(p).startsWith('.tmp-')) {
                    tempFilePath = p;
                }
            });

            fs.promises.rename = jest.fn(async () => {
                // Simulate crash: delete the temp file so rename fails
                if (tempFilePath && fs.existsSync(tempFilePath)) {
                    fs.unlinkSync(tempFilePath);
                }
                const err = new Error('Simulated crash - file not found');
                err.code = 'ENOENT';
                throw err;
            });

            // The write should fail because of the simulated crash
            await expect(
                atomicWrite(filePath, JSON.stringify({ version: 'new', ok: false }))
            ).rejects.toThrow();

            // Restore mocks
            fs.promises.writeFile = origWriteFile;
            fs.promises.rename = origRename;

            // Original file must still be intact
            const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            expect(content).toEqual(originalData);
        });
    });

    // ── 3. Concurrent writes — valid JSON, no corruption ──────────────
    describe('3 - Concurrent writes', () => {
        it('two simultaneous writes produce one valid JSON (not corrupted)', async () => {
            const filePath = path.join(testDir, 'concurrent.json');

            const payloadA = { writer: 'A', data: 'a'.repeat(5000) };
            const payloadB = { writer: 'B', data: 'b'.repeat(5000) };

            const results = await Promise.allSettled([
                atomicWrite(filePath, JSON.stringify(payloadA)),
                atomicWrite(filePath, JSON.stringify(payloadB))
            ]);

            // At least one must succeed
            const successes = results.filter(r => r.status === 'fulfilled');
            expect(successes.length).toBeGreaterThan(0);

            // File must be valid JSON
            const content = fs.readFileSync(filePath, 'utf8');
            let parsed;
            expect(() => { parsed = JSON.parse(content); }).not.toThrow();

            // Content must be exactly one of the two payloads
            const matchesA = parsed.writer === 'A' && parsed.data === 'a'.repeat(5000);
            const matchesB = parsed.writer === 'B' && parsed.data === 'b'.repeat(5000);
            expect(matchesA || matchesB).toBe(true);
        });

        it('five concurrent writes all produce valid file state', async () => {
            const filePath = path.join(testDir, 'concurrent-5.json');

            const payloads = Array.from({ length: 5 }, (_, i) => ({
                id: i,
                content: `payload-${i}`,
                pad: String(i).repeat(2000)
            }));

            const results = await Promise.allSettled(
                payloads.map(p => atomicWrite(filePath, JSON.stringify(p)))
            );

            const successes = results.filter(r => r.status === 'fulfilled');
            expect(successes.length).toBeGreaterThan(0);

            const content = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(content);

            // Must match exactly one payload (no interleaving)
            const match = payloads.find(p => p.id === parsed.id && p.content === parsed.content);
            expect(match).toBeDefined();
        });
    });

    // ── 4. Large file (10MB) integrity ────────────────────────────────
    describe('4 - Large file', () => {
        it('writes and reads back 10MB of JSON data with integrity', async () => {
            const filePath = path.join(testDir, 'large.json');

            // Generate ~10MB of JSON data
            const items = [];
            const targetBytes = 10 * 1024 * 1024;
            let totalBytes = 0;
            let i = 0;
            while (totalBytes < targetBytes) {
                const item = {
                    index: i,
                    data: `entry-${i}-${'x'.repeat(200)}`,
                    timestamp: Date.now() + i
                };
                items.push(item);
                totalBytes += JSON.stringify(item).length + 1; // +1 for comma
                i++;
            }

            const payload = { items, count: items.length, checksum: items.length.toString() };
            const json = JSON.stringify(payload);

            // Verify we actually have ~10MB
            expect(json.length).toBeGreaterThan(9 * 1024 * 1024);

            await atomicWrite(filePath, json);

            // Read back and verify
            const readBack = fs.readFileSync(filePath, 'utf8');
            expect(readBack.length).toBe(json.length);

            const parsed = JSON.parse(readBack);
            expect(parsed.count).toBe(items.length);
            expect(parsed.checksum).toBe(items.length.toString());
            expect(parsed.items.length).toBe(items.length);

            // Spot-check a few entries
            expect(parsed.items[0].index).toBe(0);
            expect(parsed.items[items.length - 1].index).toBe(items.length - 1);
        }, 30000); // 30s timeout for large file
    });

    // ── 5. Permission error handling ──────────────────────────────────
    describe('5 - Permission error handling', () => {
        it('throws an error when writing to a read-only directory (not silent failure)', async () => {
            if (process.platform === 'win32') {
                // On Windows, use icacls to deny write access
                const readOnlyDir = path.join(testDir, 'readonly-dir');
                fs.mkdirSync(readOnlyDir);
                const filePath = path.join(readOnlyDir, 'nope.json');

                // Create a mock that simulates EPERM on writeFile
                const origWriteFile = fs.promises.writeFile;
                fs.promises.writeFile = jest.fn(async () => {
                    const err = new Error('Permission denied');
                    err.code = 'EPERM';
                    throw err;
                });

                await expect(
                    atomicWrite(filePath, JSON.stringify({ test: true }))
                ).rejects.toThrow();

                fs.promises.writeFile = origWriteFile;
            } else {
                // Unix: use chmod
                const readOnlyDir = path.join(testDir, 'readonly-unix');
                fs.mkdirSync(readOnlyDir);
                fs.chmodSync(readOnlyDir, 0o444);

                const filePath = path.join(readOnlyDir, 'subdir', 'nope.json');

                await expect(
                    atomicWrite(filePath, JSON.stringify({ test: true }))
                ).rejects.toThrow();

                // Cleanup
                fs.chmodSync(readOnlyDir, 0o755);
            }
        });

        it('error is propagated, not swallowed silently', async () => {
            const origMkdir = fs.promises.mkdir;
            fs.promises.mkdir = jest.fn(async () => {
                const err = new Error('ENOSPC: no space left on device');
                err.code = 'ENOSPC';
                throw err;
            });

            const filePath = path.join(testDir, 'nospace', 'file.json');

            let threwError = false;
            try {
                await atomicWrite(filePath, 'data');
            } catch (err) {
                threwError = true;
                expect(err.code).toBe('ENOSPC');
            }

            fs.promises.mkdir = origMkdir;
            expect(threwError).toBe(true);
        });
    });

    // ── 6. Directory creation for nested paths ────────────────────────
    describe('6 - Directory creation', () => {
        it('creates parent directories for non-existent subdirectory path', async () => {
            const filePath = path.join(testDir, 'a', 'b', 'c', 'deep.json');

            // Directory should not exist
            expect(fs.existsSync(path.join(testDir, 'a'))).toBe(false);

            await atomicWrite(filePath, JSON.stringify({ deep: true }));

            // File and all parent directories should now exist
            expect(fs.existsSync(filePath)).toBe(true);
            expect(fs.existsSync(path.join(testDir, 'a', 'b', 'c'))).toBe(true);

            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            expect(parsed).toEqual({ deep: true });
        });

        it('works when directory already exists', async () => {
            const dir = path.join(testDir, 'existing-dir');
            fs.mkdirSync(dir, { recursive: true });

            const filePath = path.join(dir, 'file.json');
            await atomicWrite(filePath, JSON.stringify({ exists: true }));

            expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual({ exists: true });
        });
    });

    // ── 7. Unicode content (emoji, CJK, RTL) ─────────────────────────
    describe('7 - Unicode content', () => {
        it('roundtrips emoji content', async () => {
            const filePath = path.join(testDir, 'emoji.json');
            const payload = {
                status: 'complete',
                icons: ['check', 'rocket', 'fire', 'star'],
                message: 'All tests passed! Great work everyone.',
                emojis: '\u2705\uD83D\uDE80\uD83D\uDD25\u2B50\uD83C\uDF89\uD83D\uDCAF'
            };

            await atomicWrite(filePath, JSON.stringify(payload, null, 2));

            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            expect(parsed).toEqual(payload);
            expect(parsed.emojis).toBe('\u2705\uD83D\uDE80\uD83D\uDD25\u2B50\uD83C\uDF89\uD83D\uDCAF');
        });

        it('roundtrips CJK characters', async () => {
            const filePath = path.join(testDir, 'cjk.json');
            const payload = {
                chinese: '\u4F60\u597D\u4E16\u754C',
                japanese: '\u3053\u3093\u306B\u3061\u306F\u4E16\u754C',
                korean: '\uC548\uB155\uD558\uC138\uC694 \uC138\uACC4',
                mixed: '\u4F60\u597D \u3053\u3093\u306B\u3061\u306F \uC548\uB155\uD558\uC138\uC694'
            };

            await atomicWrite(filePath, JSON.stringify(payload, null, 2));

            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            expect(parsed).toEqual(payload);
        });

        it('roundtrips RTL (Arabic/Hebrew) characters', async () => {
            const filePath = path.join(testDir, 'rtl.json');
            const payload = {
                arabic: '\u0645\u0631\u062D\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645',
                hebrew: '\u05E9\u05DC\u05D5\u05DD \u05E2\u05D5\u05DC\u05DD',
                bidi: 'Hello \u0645\u0631\u062D\u0628\u0627 World \u05E9\u05DC\u05D5\u05DD'
            };

            await atomicWrite(filePath, JSON.stringify(payload, null, 2));

            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            expect(parsed).toEqual(payload);
        });

        it('roundtrips mixed Unicode with surrogate pairs', async () => {
            const filePath = path.join(testDir, 'surrogates.json');
            const payload = {
                // Mathematical symbols, musical notes, supplementary plane chars
                math: '\u{1D400}\u{1D401}\u{1D402}',  // Mathematical Bold A, B, C
                music: '\u{1D11E}',                     // Musical Symbol G Clef
                flags: '\uD83C\uDDFA\uD83C\uDDF8\uD83C\uDDEC\uD83C\uDDE7',  // US, GB flags
                zwj: '\uD83D\uDC68\u200D\uD83D\uDCBB'  // Man technologist (ZWJ sequence)
            };

            await atomicWrite(filePath, JSON.stringify(payload, null, 2));

            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            expect(parsed).toEqual(payload);
        });
    });

    // ── 8. Empty/null content ─────────────────────────────────────────
    describe('8 - Empty content', () => {
        it('writes empty string and reads it back', async () => {
            const filePath = path.join(testDir, 'empty.txt');

            await atomicWrite(filePath, '');

            const content = fs.readFileSync(filePath, 'utf8');
            expect(content).toBe('');
        });

        it('writes empty JSON object', async () => {
            const filePath = path.join(testDir, 'empty-obj.json');

            await atomicWrite(filePath, JSON.stringify({}));

            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            expect(parsed).toEqual({});
        });

        it('writes empty JSON array', async () => {
            const filePath = path.join(testDir, 'empty-arr.json');

            await atomicWrite(filePath, JSON.stringify([]));

            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            expect(parsed).toEqual([]);
        });

        it('writes "null" JSON value', async () => {
            const filePath = path.join(testDir, 'null.json');

            await atomicWrite(filePath, JSON.stringify(null));

            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            expect(parsed).toBeNull();
        });

        it('sync version handles empty string', () => {
            const filePath = path.join(testDir, 'empty-sync.txt');

            atomicWriteSync(filePath, '');

            expect(fs.readFileSync(filePath, 'utf8')).toBe('');
        });
    });
});
