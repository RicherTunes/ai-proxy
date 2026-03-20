'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Process Safety Tests
 *
 * TDD-driven: tests written FIRST, then code fixed to make them pass.
 * Targets unhandled rejection escalation, structured logging in process
 * handlers, bare console usage in production code, and logger.error context.
 */

const LIB_DIR = path.join(__dirname, '..', 'lib');
const ROOT_DIR = path.join(__dirname, '..');

/**
 * Extract a process.on handler block from source code.
 * Finds the opening brace and matches it to the closing `});` at the same indent level.
 */
function extractProcessHandler(content, eventName) {
    const marker = `process.on('${eventName}'`;
    const start = content.indexOf(marker);
    if (start === -1) return null;

    // Find the end by tracking brace depth from the opening `{`
    const openBrace = content.indexOf('{', start);
    if (openBrace === -1) return null;

    let depth = 0;
    for (let i = openBrace; i < content.length; i++) {
        if (content[i] === '{') depth++;
        else if (content[i] === '}') {
            depth--;
            if (depth === 0) {
                // Include the closing `});`
                return content.slice(start, i + 3);
            }
        }
    }
    return content.slice(start); // fallback
}

/** Recursively list all .js files under a directory */
function listJsFiles(dir) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...listJsFiles(fullPath));
        } else if (entry.name.endsWith('.js')) {
            results.push(fullPath);
        }
    }
    return results;
}

describe('Process Safety', () => {

    // ─── TEST 1: unhandledRejection handler has escalation counter ──────
    describe('Test 1: unhandledRejection handler has escalation counter', () => {
        test('proxy.js unhandledRejection handler should track rejection count and escalate after threshold', () => {
            const content = fs.readFileSync(path.join(ROOT_DIR, 'proxy.js'), 'utf8');

            // Extract the full unhandledRejection handler block
            const handlerBlock = extractProcessHandler(content, 'unhandledRejection');
            expect(handlerBlock).not.toBeNull();

            // Must track a count / counter of rejections
            const hasCounter = /rejectionCount|rejection_count|unhandledCount/i.test(handlerBlock)
                || /\+\+\s*\w*[Cc]ount|\w*[Cc]ount\s*\+\+|\w*[Cc]ount\s*\+=\s*1/.test(handlerBlock);
            expect(hasCounter).toBe(true);

            // Must have a threshold check that triggers escalation (exit or critical log)
            const hasThreshold = />=?\s*\d+|threshold|MAX_/i.test(handlerBlock);
            expect(hasThreshold).toBe(true);

            // Must call process.exit or logger.error/critical when threshold is exceeded
            const hasEscalation = /process\.exit|logger\.(error|fatal|critical)|CRITICAL/i.test(handlerBlock);
            expect(hasEscalation).toBe(true);
        });
    });

    // ─── TEST 2: unhandledRejection uses logger.error, not console.error ─
    describe('Test 2: unhandledRejection uses logger.error', () => {
        test('proxy.js unhandledRejection handler should use logger.error (not just console.error)', () => {
            const content = fs.readFileSync(path.join(ROOT_DIR, 'proxy.js'), 'utf8');

            // Extract the full unhandledRejection handler block
            const handlerBlock = extractProcessHandler(content, 'unhandledRejection');
            expect(handlerBlock).not.toBeNull();

            // Must use logger.error or log.error (structured logging) not just console.error
            // Accepts: logger.error(...), log.error(...), getProcessLogger()...log.error(...)
            expect(handlerBlock).toMatch(/(?:logger|log)\.error\(/);
        });
    });

    // ─── TEST 3: No bare console.log/console.error in lib/ production code
    describe('Test 3: No bare console usage in lib/ production code', () => {
        test('lib/ .js files should have minimal bare console.log/error/warn calls', () => {
            const jsFiles = listJsFiles(LIB_DIR);
            const violations = [];

            // These are the only console patterns we care about
            const consolePattern = /\bconsole\.(log|error|warn)\s*\(/;

            for (const filePath of jsFiles) {
                const content = fs.readFileSync(filePath, 'utf8');
                const lines = content.split('\n');

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    const trimmed = line.trim();

                    // Skip comment lines
                    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
                        continue;
                    }

                    if (consolePattern.test(trimmed)) {
                        violations.push({
                            file: path.relative(ROOT_DIR, filePath),
                            line: i + 1,
                            content: trimmed
                        });
                    }
                }
            }

            // Allow up to 3 bare console calls for pre-logger bootstrap code
            // (e.g., logger.js itself uses console as output backend).
            // Flag exact locations so they can be reviewed.
            if (violations.length > 3) {
                const details = violations.map(v =>
                    `  ${v.file}:${v.line} → ${v.content}`
                ).join('\n');
                throw new Error(
                    `Found ${violations.length} bare console calls in lib/ (max 3 allowed):\n${details}`
                );
            }
        });
    });

    // ─── TEST 4: All logger.error calls include context ──────────────────
    describe('Test 4: logger.error calls include context (not just bare strings)', () => {
        test('request-handler.js logger.error calls should include context objects', () => {
            const content = fs.readFileSync(path.join(LIB_DIR, 'request-handler.js'), 'utf8');
            const lines = content.split('\n');

            const errorCalls = [];
            const bareErrorCalls = [];

            for (let i = 0; i < lines.length; i++) {
                const trimmed = lines[i].trim();

                // Skip comments
                if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

                // Match logger.error or reqLogger?.error or reqLogger.error calls
                if (/(?:req)?[Ll]ogger\??\.error\(/.test(trimmed)) {
                    errorCalls.push({ line: i + 1, content: trimmed });

                    // A bare string call has just a string arg with no second argument
                    // e.g., logger.error('something') or logger.error(`something`)
                    // vs logger.error('something', { key: val })
                    //
                    // Check if the call has a context object { ... } argument.
                    // We look for a comma followed by { in the same or next line.
                    const combinedLine = trimmed + (lines[i + 1] ? ' ' + lines[i + 1].trim() : '');
                    const hasContext = /\.error\([^)]*,\s*\{/.test(combinedLine);
                    // Also accept if it's a template literal with embedded variables (provides context)
                    const hasTemplateContext = /\.error\(`[^`]*\$\{/.test(combinedLine);

                    if (!hasContext && !hasTemplateContext) {
                        bareErrorCalls.push({ line: i + 1, content: trimmed });
                    }
                }
            }

            // Must have some error calls to validate (sanity check)
            expect(errorCalls.length).toBeGreaterThan(0);

            // All logger.error calls should include context — allow zero bare calls
            if (bareErrorCalls.length > 0) {
                const details = bareErrorCalls.map(v =>
                    `  line ${v.line}: ${v.content}`
                ).join('\n');
                throw new Error(
                    `Found ${bareErrorCalls.length} logger.error calls without context object:\n${details}`
                );
            }
        });
    });
});
