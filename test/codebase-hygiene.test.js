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

const { execSync } = require('child_process');

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

    // ─── TEST 8: All lib/*.js files have 'use strict' ───────────────────
    describe('Test 8: All top-level lib/*.js files have use strict', () => {
        test('every .js file in lib/ (not subdirs) should have use strict in first 5 lines', () => {
            const topLevelFiles = fs.readdirSync(LIB_DIR)
                .filter(f => f.endsWith('.js'));

            // index.js is a re-export file, exempt from strict requirement
            const exemptions = ['index.js'];
            const filesToCheck = topLevelFiles.filter(f => !exemptions.includes(f));
            const violations = [];

            for (const fileName of filesToCheck) {
                const filePath = path.join(LIB_DIR, fileName);
                const content = fs.readFileSync(filePath, 'utf8');
                const first5Lines = content.split('\n').slice(0, 5).join('\n');
                if (!first5Lines.includes("'use strict'") && !first5Lines.includes('"use strict"')) {
                    violations.push(fileName);
                }
            }

            expect(violations).toEqual([]);
        });
    });

    // ─── TEST 9: package.json has engines field ──────────────────────────
    describe('Test 9: package.json has engines field', () => {
        test('package.json should specify engines.node >= 18', () => {
            const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
            expect(pkg.engines).toBeDefined();
            expect(pkg.engines.node).toBeDefined();
            expect(pkg.engines.node).toMatch(/>=\s*18/);
        });
    });

    // ─── TEST 10: .gitignore includes test temp files ────────────────────
    describe('Test 10: .gitignore includes test temp files', () => {
        test('.gitignore should have pattern for test/__temp_* files', () => {
            const gitignore = fs.readFileSync(path.join(ROOT_DIR, '.gitignore'), 'utf8');
            const lines = gitignore.split('\n').map(l => l.trim());
            // Accept either test/__temp_* or __temp_*
            const hasPattern = lines.some(l =>
                l === 'test/__temp_*' || l === '__temp_*' || l === 'test/__temp_*.*'
            );
            expect(hasPattern).toBe(true);
        });
    });

    // ─── TEST 11: No stale TODO comments with past dates ───────────────
    describe('Test 11b: No stale TODO comments with past dates', () => {
        test('lib/*.js should have no TODO comments referencing past dates like "Month 7", "2024", "2025"', () => {
            const allFiles = listFilesRecursive(LIB_DIR).filter(f => f.endsWith('.js'));
            const violations = [];

            // Match TODO comments containing stale date references
            const staleDatePattern = /TODO.*(?:Month\s+\d|2024|2025)/i;

            for (const filePath of allFiles) {
                const content = fs.readFileSync(filePath, 'utf8');
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (staleDatePattern.test(line)) {
                        violations.push({
                            file: path.relative(ROOT_DIR, filePath),
                            line: i + 1,
                            content: line.trim()
                        });
                    }
                }
            }

            expect(violations).toEqual([]);
        });
    });

    // ─── TEST 12: No TODO with unverified pricing ────────────────────────
    describe('Test 12: No TODO about unverified pricing in model-discovery.js', () => {
        test('model-discovery.js should not have TODO comments about unverified pricing', () => {
            const content = fs.readFileSync(path.join(LIB_DIR, 'model-discovery.js'), 'utf8');
            const lines = content.split('\n');
            const violations = [];

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (/TODO.*(?:verify|unverified).*pric/i.test(line)) {
                    violations.push({
                        file: 'lib/model-discovery.js',
                        line: i + 1,
                        content: line.trim()
                    });
                }
            }

            expect(violations).toEqual([]);
        });
    });

    // ─── TEST 13: .depcheckrc exists ─────────────────────────────────────
    describe('Test 13: .depcheckrc exists', () => {
        test('.depcheckrc file should exist at repo root', () => {
            const depcheckrcPath = path.join(ROOT_DIR, '.depcheckrc');
            expect(fs.existsSync(depcheckrcPath)).toBe(true);
        });
    });

    // ─── TEST 14: No test artifacts in lib/ ────────────────────────────────
    describe('Test 14: No test artifacts in lib/', () => {
        test('lib/ should contain only .js files tracked in git (no .json artifacts, no .bak)', () => {
            const tracked = execSync(
                'git ls-files -- "lib/"',
                { cwd: ROOT_DIR, encoding: 'utf8' }
            ).trim();
            const files = tracked ? tracked.split('\n') : [];
            const nonJsFiles = files.filter(f => !f.endsWith('.js'));
            expect(nonJsFiles).toEqual([]);
        });
    });

    // ─── TEST 15: No temporary test directories tracked in git ─────────────
    describe('Test 15: No temporary test directories tracked in git', () => {
        test('no test/int-smoke-*, test/__temp_*, or test/proxy-test-* files should be tracked', () => {
            // Use git ls-tree HEAD to check what's actually committed (not staged state)
            let tracked = '';
            try {
                tracked = execSync(
                    'git ls-tree -r --name-only HEAD -- test/',
                    { cwd: ROOT_DIR, encoding: 'utf8' }
                ).trim();
            } catch (e) { /* empty repo or no HEAD */ }
            const files = tracked ? tracked.split('\n').filter(f =>
                f.match(/^test\/(int-smoke-|__temp_|proxy-test-)/)
            ) : [];
            expect(files).toEqual([]);
        });
    });

    // ─── TEST 16: No wildcard dependency versions ──────────────────────────
    describe('Test 16: No wildcard dependency versions', () => {
        test('all deps and devDeps should use exact or caret versions (no * or latest)', () => {
            const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
            const violations = [];

            for (const section of ['dependencies', 'devDependencies']) {
                const deps = pkg[section] || {};
                for (const [name, version] of Object.entries(deps)) {
                    if (version === '*' || version === 'latest') {
                        violations.push({ name, version, section });
                    }
                }
            }

            expect(violations).toEqual([]);
        });
    });

    // ─── TEST 17: License field exists ─────────────────────────────────────
    describe('Test 17: License field exists in package.json', () => {
        test('package.json should have a license field', () => {
            const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
            expect(pkg.license).toBeDefined();
            expect(typeof pkg.license).toBe('string');
            expect(pkg.license.length).toBeGreaterThan(0);
        });
    });

    // ─── TEST 11: No commented-out code blocks in lib/ ──────────────────
    describe('Test 11: No commented-out code blocks in lib/', () => {
        test('lib/ should have fewer than 5 blocks of 3+ consecutive commented code lines', () => {
            const allFiles = listFilesRecursive(LIB_DIR).filter(f => f.endsWith('.js'));
            const blocks = [];

            // Patterns that indicate a commented line is actual dead code, not documentation.
            // Require strong code signals: assignment statements, function calls,
            // control flow keywords at line start, or semicolons at end.
            // Exclude documentation patterns: threshold explanations (ratio < 0.8),
            // config examples (['*']), and inline annotations (NORM-04, GLM5-03).
            const codeStatementPattern = /^\s*(const|let|var|if|else|for|while|return|function|class|try|catch|throw|await|module\.exports|require\(|this\.|[a-zA-Z_]\w*\s*[=(])/;
            const trailingCodePattern = /;\s*$/;
            const isCodeLine = (body) => {
                // Skip lines that look like threshold/example documentation
                // e.g., "ratio < 0.8 → full points", "['*'] - allow all"
                if (/→|->|example|default|config|option|recommended|production/i.test(body)) return false;
                // Skip annotation-style comments (NORM-04, GLM5-02, etc.)
                if (/^[A-Z]+-\d+/.test(body)) return false;
                return codeStatementPattern.test(body) || trailingCodePattern.test(body);
            };

            for (const filePath of allFiles) {
                const content = fs.readFileSync(filePath, 'utf8');
                const lines = content.split('\n');

                let consecutiveCodeComments = [];

                for (let i = 0; i < lines.length; i++) {
                    const trimmed = lines[i].trim();

                    // Is this a single-line comment that looks like code?
                    if (trimmed.startsWith('//') && !trimmed.startsWith('///')) {
                        const commentBody = trimmed.slice(2).trim();

                        // Skip JSDoc-style, section dividers, TODO/FIXME, and short prose
                        if (commentBody.startsWith('─') || commentBody.startsWith('===')
                            || commentBody.startsWith('---') || commentBody.startsWith('***')
                            || /^(TODO|FIXME|NOTE|HACK|XXX|WARN|BUG|PERF|SAFETY|IMPORTANT)/i.test(commentBody)
                            || commentBody.length < 5) {
                            // Break the streak
                            if (consecutiveCodeComments.length >= 3) {
                                blocks.push({
                                    file: path.relative(ROOT_DIR, filePath),
                                    startLine: consecutiveCodeComments[0].line,
                                    endLine: consecutiveCodeComments[consecutiveCodeComments.length - 1].line,
                                    count: consecutiveCodeComments.length,
                                    preview: consecutiveCodeComments[0].content
                                });
                            }
                            consecutiveCodeComments = [];
                            continue;
                        }

                        if (isCodeLine(commentBody)) {
                            consecutiveCodeComments.push({ line: i + 1, content: trimmed });
                        } else {
                            // Prose comment breaks the streak
                            if (consecutiveCodeComments.length >= 3) {
                                blocks.push({
                                    file: path.relative(ROOT_DIR, filePath),
                                    startLine: consecutiveCodeComments[0].line,
                                    endLine: consecutiveCodeComments[consecutiveCodeComments.length - 1].line,
                                    count: consecutiveCodeComments.length,
                                    preview: consecutiveCodeComments[0].content
                                });
                            }
                            consecutiveCodeComments = [];
                        }
                    } else {
                        // Non-comment line breaks the streak
                        if (consecutiveCodeComments.length >= 3) {
                            blocks.push({
                                file: path.relative(ROOT_DIR, filePath),
                                startLine: consecutiveCodeComments[0].line,
                                endLine: consecutiveCodeComments[consecutiveCodeComments.length - 1].line,
                                count: consecutiveCodeComments.length,
                                preview: consecutiveCodeComments[0].content
                            });
                        }
                        consecutiveCodeComments = [];
                    }
                }

                // Check tail
                if (consecutiveCodeComments.length >= 3) {
                    blocks.push({
                        file: path.relative(ROOT_DIR, filePath),
                        startLine: consecutiveCodeComments[0].line,
                        endLine: consecutiveCodeComments[consecutiveCodeComments.length - 1].line,
                        count: consecutiveCodeComments.length,
                        preview: consecutiveCodeComments[0].content
                    });
                }
            }

            if (blocks.length >= 5) {
                const details = blocks.map(b =>
                    `  ${b.file}:${b.startLine}-${b.endLine} (${b.count} lines) → ${b.preview}`
                ).join('\n');
                throw new Error(
                    `Found ${blocks.length} commented-out code blocks in lib/ (max 4 allowed):\n${details}`
                );
            }
        });
    });
});
