/**
 * Named Constants Tests (TDD)
 *
 * Verifies that magic numbers across the codebase are extracted into
 * named constants at the top of each module.  This makes the code
 * self-documenting and easier to configure later.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LIB = path.join(__dirname, '..', 'lib');

function readSource(file) {
    return fs.readFileSync(path.join(LIB, file), 'utf8');
}

// ─── Test 1: request-handler.js content-preview named constants ────────────

describe('request-handler.js content-preview constants', () => {
    let src;

    beforeAll(() => {
        src = readSource('request-handler.js');
    });

    test('exports or defines MAX_PREVIEW_MESSAGES constant (12)', () => {
        expect(src).toMatch(/\bMAX_PREVIEW_MESSAGES\s*=\s*12\b/);
    });

    test('exports or defines MAX_CHARS_PER_MESSAGE constant (1600)', () => {
        expect(src).toMatch(/\bMAX_CHARS_PER_MESSAGE\s*=\s*1600\b/);
    });

    test('exports or defines MAX_PREVIEW_TOTAL_CHARS constant (12000)', () => {
        expect(src).toMatch(/\bMAX_PREVIEW_TOTAL_CHARS\s*=\s*12000\b/);
    });

    test('_extractRequestContentPreview uses named constants, not bare numbers', () => {
        // Locate the method definition (inside the class, not a call site)
        const fnStart = src.indexOf('_extractRequestContentPreview(body)');
        expect(fnStart).toBeGreaterThan(-1);

        // Grab a generous chunk of the method body
        const methodBody = src.slice(fnStart, fnStart + 1500);

        // Should NOT contain bare `= 12;`, `= 1600;`, `= 12000;`
        expect(methodBody).not.toMatch(/=\s*12\s*;/);
        expect(methodBody).not.toMatch(/=\s*1600\s*;/);
        expect(methodBody).not.toMatch(/=\s*12000\s*;/);

        // Should reference the named constants instead
        expect(methodBody).toMatch(/MAX_PREVIEW_MESSAGES/);
        expect(methodBody).toMatch(/MAX_CHARS_PER_MESSAGE/);
        expect(methodBody).toMatch(/MAX_PREVIEW_TOTAL_CHARS/);
    });
});

// ─── Test 2: proxy-server.js SSE keepalive named constant ──────────────────

describe('proxy-server.js SSE keepalive constant', () => {
    let src;

    beforeAll(() => {
        src = readSource('proxy-server.js');
    });

    test('defines SSE_KEEPALIVE_INTERVAL_MS constant (30000)', () => {
        expect(src).toMatch(/\bSSE_KEEPALIVE_INTERVAL_MS\s*=\s*30000\b/);
    });

    test('setInterval calls use the named constant, not bare 30000', () => {
        // The source should use SSE_KEEPALIVE_INTERVAL_MS in setInterval calls
        // and should NOT have bare `, 30000);` after a keepalive setInterval
        expect(src).toMatch(/SSE_KEEPALIVE_INTERVAL_MS/);

        // No bare 30000 should appear in keepalive-related setInterval calls
        // Find all lines with setInterval and a numeric interval
        const lines = src.split('\n');
        for (const line of lines) {
            if (line.includes('keepalive') && line.includes('setInterval')) {
                expect(line).not.toMatch(/30000/);
            }
        }

        // Positive: SSE_KEEPALIVE_INTERVAL_MS appears near setInterval
        const keepaliveUses = src.match(/},\s*SSE_KEEPALIVE_INTERVAL_MS\s*\)/g) || [];
        expect(keepaliveUses.length).toBeGreaterThanOrEqual(2);
    });
});

// ─── Test 3: upstream-health.js recovery thresholds named ──────────────────

describe('upstream-health.js recovery threshold constants', () => {
    let src;

    beforeAll(() => {
        src = readSource('upstream-health.js');
    });

    test('defines PRIMARY_RECOVERY_THRESHOLD constant (2)', () => {
        expect(src).toMatch(/\bPRIMARY_RECOVERY_THRESHOLD\s*=\s*2\b/);
    });

    test('defines FALLBACK_RECOVERY_THRESHOLD constant (5)', () => {
        expect(src).toMatch(/\bFALLBACK_RECOVERY_THRESHOLD\s*=\s*5\b/);
    });

    test('defines MIN_FAILOVER_AGE_MS constant (60000)', () => {
        expect(src).toMatch(/\bMIN_FAILOVER_AGE_MS\s*=\s*60000\b/);
    });

    test('_recordProbeResult uses named constants, not bare numbers', () => {
        // Find the actual method definition (not call sites)
        const fnStart = src.indexOf('async _recordProbeResult(');
        expect(fnStart).toBeGreaterThan(-1);

        const methodBody = src.slice(fnStart, fnStart + 2000);

        // Should reference the named constants
        expect(methodBody).toMatch(/PRIMARY_RECOVERY_THRESHOLD/);
        expect(methodBody).toMatch(/FALLBACK_RECOVERY_THRESHOLD/);
        expect(methodBody).toMatch(/MIN_FAILOVER_AGE_MS/);

        // Should NOT contain the bare ternary `? 2 : 5`
        expect(methodBody).not.toMatch(/\?\s*2\s*:\s*5/);
        // Should NOT contain bare `< 60000`
        expect(methodBody).not.toMatch(/<\s*60000/);
    });
});

// ─── Test 4: webhook-manager.js LRU dedup capacity named ──────────────────

describe('webhook-manager.js dedup capacity constant', () => {
    let src;

    beforeAll(() => {
        src = readSource('webhook-manager.js');
    });

    test('defines DEDUP_LRU_CAPACITY constant (1000)', () => {
        expect(src).toMatch(/\bDEDUP_LRU_CAPACITY\s*=\s*1000\b/);
    });

    test('LRUMap is constructed with named constant, not bare 1000', () => {
        // The LRUMap constructor should reference the constant
        const lruConstruction = src.match(/new\s+LRUMap\(\s*(\w+)\s*\)/);
        expect(lruConstruction).not.toBeNull();
        expect(lruConstruction[1]).toBe('DEDUP_LRU_CAPACITY');
    });
});

// ─── Test 5: cost-tracker.js limits named ──────────────────────────────────

describe('cost-tracker.js named constants', () => {
    let src;

    beforeAll(() => {
        src = readSource('cost-tracker.js');
    });

    test('defines MAX_STRING_LENGTH constant (256)', () => {
        expect(src).toMatch(/\bMAX_STRING_LENGTH\s*=\s*256\b/);
    });

    test('defines SLOW_SAVE_THRESHOLD_MS constant (100)', () => {
        expect(src).toMatch(/\bSLOW_SAVE_THRESHOLD_MS\s*=\s*100\b/);
    });

    test('MAX_STRING_LENGTH is already used in validation (pre-existing)', () => {
        // The validation method should reference MAX_STRING_LENGTH
        const fnStart = src.indexOf('_validateUsage(keyId');
        expect(fnStart).toBeGreaterThan(-1);

        const methodBody = src.slice(fnStart, fnStart + 1500);
        expect(methodBody).toMatch(/MAX_STRING_LENGTH/);
        // Should NOT contain bare `.slice(0, 256)` in the method
        expect(methodBody).not.toMatch(/\.slice\(0,\s*256\)/);
    });

    test('SLOW_SAVE_THRESHOLD_MS is used in save logic', () => {
        // Find the actual method definition
        const fnStart = src.indexOf('async _performSave()');
        expect(fnStart).toBeGreaterThan(-1);

        const methodBody = src.slice(fnStart, fnStart + 1500);
        expect(methodBody).toMatch(/SLOW_SAVE_THRESHOLD_MS/);
        // Should NOT contain bare `> 100` comparison for duration
        expect(methodBody).not.toMatch(/duration\s*>\s*100\b/);
    });
});
