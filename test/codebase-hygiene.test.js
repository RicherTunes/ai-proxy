'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Codebase Hygiene Tests
 *
 * TDD-driven: tests written FIRST, then code fixed to make them pass.
 * Targets backup files, misplaced docs, var declarations, error response
 * format consistency, ASSET_VERSION determinism, and default fallback safety.
 */

const LIB_DIR = path.join(__dirname, '..', 'lib');
const CONTROLLERS_DIR = path.join(LIB_DIR, 'proxy', 'controllers');
const ROOT_DIR = path.join(__dirname, '..');

/** Recursively list all files under a directory */
function listFilesRecursive(dir) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...listFilesRecursive(fullPath));
        } else {
            results.push(fullPath);
        }
    }
    return results;
}

describe('Codebase Hygiene', () => {

    // ─── TEST 1: No .bak files in lib/ ───────────────────────────────────
    describe('Test 1: No .bak files in lib/', () => {
        test('lib/ should contain zero .bak files', () => {
            const allFiles = listFilesRecursive(LIB_DIR);
            const bakFiles = allFiles.filter(f => f.endsWith('.bak'));
            expect(bakFiles).toEqual([]);
        });
    });

    // ─── TEST 2: No markdown files in lib/ ───────────────────────────────
    describe('Test 2: No markdown files in lib/', () => {
        test('lib/ should contain zero .md files (planning docs belong in docs/)', () => {
            const allFiles = listFilesRecursive(LIB_DIR);
            const mdFiles = allFiles.filter(f => f.endsWith('.md'));
            expect(mdFiles).toEqual([]);
        });
    });

    // ─── TEST 3: No var declarations in strict-mode files ────────────────
    describe('Test 3: No var declarations in strict-mode files', () => {
        test('all strict-mode .js files in lib/ should use const/let, not var', () => {
            const allFiles = listFilesRecursive(LIB_DIR).filter(f => f.endsWith('.js'));
            const violations = [];

            for (const filePath of allFiles) {
                const content = fs.readFileSync(filePath, 'utf8');
                if (!content.includes("'use strict'") && !content.includes('"use strict"')) {
                    continue; // skip non-strict files
                }

                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    // Skip lines that are inside string literals or comments
                    const trimmed = line.trim();
                    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
                        continue;
                    }
                    // Match var declarations: "var " at word boundary, not inside strings
                    // Remove string content first to avoid false positives
                    const noStrings = line
                        .replace(/'[^']*'/g, '""')
                        .replace(/"[^"]*"/g, '""')
                        .replace(/`[^`]*`/g, '""');
                    if (/\bvar\s/.test(noStrings)) {
                        violations.push({
                            file: path.relative(ROOT_DIR, filePath),
                            line: i + 1,
                            content: trimmed
                        });
                    }
                }
            }

            expect(violations).toEqual([]);
        });
    });

    // ─── TEST 4: Consistent error response format in controllers ─────────
    describe('Test 4: Consistent JSON error responses in controllers', () => {
        test('all writeHead+end patterns in controllers should use JSON format', () => {
            const controllerFiles = fs.readdirSync(CONTROLLERS_DIR)
                .filter(f => f.endsWith('.js'))
                .map(f => ({
                    name: f,
                    path: path.join(CONTROLLERS_DIR, f),
                    content: fs.readFileSync(path.join(CONTROLLERS_DIR, f), 'utf8')
                }));

            const violations = [];

            for (const file of controllerFiles) {
                const lines = file.content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    // Look for res.end() calls that write a response body
                    const line = lines[i].trim();
                    if (/res\.end\(/.test(line) && !line.includes('JSON.stringify') && !line.includes('res.end()')) {
                        // Allow Prometheus text/plain endpoint and empty res.end()
                        // Check if the preceding writeHead uses text/plain (Prometheus)
                        const context = lines.slice(Math.max(0, i - 5), i + 1).join('\n');
                        if (context.includes('text/plain')) {
                            continue; // Prometheus metrics endpoint is intentionally text
                        }
                        violations.push({
                            file: file.name,
                            line: i + 1,
                            content: line
                        });
                    }
                }
            }

            expect(violations).toEqual([]);
        });
    });

    // ─── TEST 5: ASSET_VERSION is deterministic ──────────────────────────
    describe('Test 5: ASSET_VERSION is deterministic', () => {
        test('dashboard.js ASSET_VERSION should NOT use Date.now()', () => {
            const content = fs.readFileSync(path.join(LIB_DIR, 'dashboard.js'), 'utf8');
            // Find the ASSET_VERSION line
            const versionLine = content.split('\n').find(l => l.includes('ASSET_VERSION'));
            expect(versionLine).toBeDefined();
            expect(versionLine).not.toMatch(/Date\.now\(\)/);
        });
    });

    // ─── TEST 6: Default fallback endpoints are empty ────────────────────
    describe('Test 6: Default fallback endpoints are empty', () => {
        test('proxy-server.js upstream fallback default should be [] (empty array)', () => {
            const content = fs.readFileSync(path.join(LIB_DIR, 'proxy-server.js'), 'utf8');
            // Find the fallbacks line in UpstreamHealthMonitor construction
            const lines = content.split('\n');
            let foundFallbackLine = false;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes('upstreamFallbacks') && lines[i].includes('||')) {
                    foundFallbackLine = true;
                    // The default should be [] not a hardcoded endpoint
                    const defaultValue = lines[i].split('||')[1].trim();
                    expect(defaultValue).toMatch(/^\[(\s*)]/);
                    break;
                }
            }
            expect(foundFallbackLine).toBe(true);
        });

        test('upstream-health.js constructor fallback default should be [] (empty array)', () => {
            const content = fs.readFileSync(path.join(LIB_DIR, 'upstream-health.js'), 'utf8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes('this.fallbacks') && lines[i].includes('options.fallbacks')) {
                    // The default should be [] not a hardcoded endpoint array
                    const remainder = lines[i].split('||')[1];
                    expect(remainder.trim()).toMatch(/^\[(\s*)]/);
                    return;
                }
            }
            throw new Error('Could not find this.fallbacks assignment in upstream-health.js');
        });
    });

    // ─── TEST 7: .gitignore includes *.bak ───────────────────────────────
    describe('Test 7: .gitignore includes *.bak', () => {
        test('.gitignore should contain *.bak pattern', () => {
            const gitignore = fs.readFileSync(path.join(ROOT_DIR, '.gitignore'), 'utf8');
            const lines = gitignore.split('\n').map(l => l.trim());
            expect(lines).toContain('*.bak');
        });
    });
});
