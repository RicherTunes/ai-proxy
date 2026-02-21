#!/usr/bin/env node
/**
 * Check Open Handles Script
 *
 * ARCH-08: CI job runs --detectOpenHandles and fails only on new leaks
 * Baseline allowlist ratchets down over time
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BASELINE_FILE = process.argv[2] || 'test-results/open-handles-baseline.json';
const OUTPUT_FILE = process.argv[3] || 'test-results/open-handles-report.json';

/**
 * Parse Jest --detectOpenHandles output
 * @param {string} logPath - Path to Jest log
 * @returns {Array} Detected handles
 */
function parseJestOutput(logPath) {
    if (!fs.existsSync(logPath)) {
        return [];
    }

    const content = fs.readFileSync(logPath, 'utf8');
    const handles = [];

    // Parse "Jest has detected X opened handle" lines
    const handleRegex = /Jest has detected \d+ opened handle(?:s)?([\s\S]*?)\n\n/g;
    let match;
    while ((match = handleRegex.exec(content)) !== null) {
        const handleText = match[1];
        handles.push({
            raw: handleText,
            // Try to identify test file from stack trace
            testFile: extractTestFile(handleText),
            // Try to identify handle type
            handleType: extractHandleType(handleText)
        });
    }

    return handles;
}

/**
 * Extract test file name from handle text
 */
function extractTestFile(text) {
    const testMatch = text.match(/at\s+(.*\.test\.js)/);
    return testMatch ? testMatch[1] : null;
}

/**
 * Extract handle type from text
 */
function extractHandleType(text) {
    if (text.includes('EventSource')) return 'EventSource';
    if (text.includes('Server') || text.includes('HTTP')) return 'Server';
    if (text.includes('Socket')) return 'Socket';
    if (text.includes('Timer') || text.includes('timeout')) return 'Timer';
    if (text.includes('File')) return 'File';
    return 'Unknown';
}

/**
 * Load baseline allowlist
 */
function loadBaseline(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content);
    } catch (err) {
        if (err.code === 'ENOENT') {
            console.warn(`Baseline file not found: ${filePath}`);
            return { version: '1.0', allowlist: [] };
        }
        throw err;
    }
}

/**
 * Check handles against baseline
 */
function checkHandles(handles, baseline) {
    const newHandles = [];

    for (const handle of handles) {
        // Check if handle matches any baseline entry
        const isAllowed = baseline.allowlist.some(entry => {
            // Exact test file match
            if (entry.testFile && handle.testFile === entry.testFile) {
                return true;
            }
            // Pattern match on handle type
            if (entry.handleType && handle.handleType === entry.handleType) {
                return true;
            }
            // Regex pattern match
            if (entry.pattern && new RegExp(entry.pattern).test(handle.raw)) {
                return true;
            }
            return false;
        });

        if (!isAllowed) {
            newHandles.push(handle);
        }
    }

    return newHandles;
}

/**
 * Generate report
 */
function generateReport(handles, newHandles) {
    return {
        version: '1.0',
        timestamp: new Date().toISOString(),
        summary: {
            total: handles.length,
            new: newHandles.length,
            baselineAllowed: handles.length - newHandles.length
        },
        newHandles: newHandles.map(h => ({
            testFile: h.testFile,
            handleType: h.handleType,
            excerpt: h.raw.substring(0, 200) + '...'
        }))
    };
}

// Main
const jestLog = 'test-results/detect-open-handles.log';
const baseline = loadBaseline(BASELINE_FILE);
const handles = parseJestOutput(jestLog);
const newHandles = checkHandles(handles, baseline);
const report = generateReport(handles, newHandles);

fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
fs.writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2));

console.log(JSON.stringify(report, null, 2));

// Exit with error if new handles found
if (newHandles.length > 0) {
    console.error(`\n❌ Found ${newHandles.length} new open handles not in baseline`);
    process.exit(1);
} else {
    console.log('\n✅ All open handles in baseline');
    process.exit(0);
}
