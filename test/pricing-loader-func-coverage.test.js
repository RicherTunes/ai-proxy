'use strict';
/**
 * Pricing Loader Function Coverage Tests
 *
 * Covers uncovered branches from pricing-loader.js:
 * - Line 99-100: rates must be an object (with continue)
 * - Line 112: outputTokenPer1M cannot be negative
 * - Line 129: computePricingHash with null/undefined/no-models
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
    validatePricing,
    computePricingHash,
    loadPricing,
    getDefaultPricing
} = require('../lib/pricing-loader');

let testDir;

beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-func-coverage-'));
});

afterEach(() => {
    try {
        const entries = fs.readdirSync(testDir);
        for (const e of entries) {
            fs.unlinkSync(path.join(testDir, e));
        }
        fs.rmdirSync(testDir);
    } catch (_) { /* cleanup best-effort */ }
});

function writePricingFile(data) {
    const p = path.join(testDir, 'pricing.json');
    fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    return p;
}

// ===========================================================================
// Covers line 99-100: rates must be an object with continue
// ===========================================================================
describe('validatePricing - rates not an object', () => {
    // Covers line 99-100: when model rates is null/primitive, not object
    test('rejects when model rates is null', () => {
        const pricing = {
            version: '1.0.0',
            models: {
                'bad-model': null
            }
        };
        const result = validatePricing(pricing);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('rates must be an object'))).toBe(true);
    });

    // Covers line 99-100: rates as number triggers continue
    test('rejects when model rates is a number', () => {
        const pricing = {
            version: '1.0.0',
            models: {
                'numeric-rates': 42
            }
        };
        const result = validatePricing(pricing);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('rates must be an object'))).toBe(true);
    });

    // Covers line 99-100: rates as string triggers continue
    test('rejects when model rates is a string', () => {
        const pricing = {
            version: '1.0.0',
            models: {
                'string-rates': 'expensive'
            }
        };
        const result = validatePricing(pricing);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('rates must be an object'))).toBe(true);
    });

    // Covers line 99-100: rates as array (typeof === 'object' but invalid)
    test('rejects when model rates is an array (not plain object)', () => {
        const pricing = {
            version: '1.0.0',
            models: {
                'array-rates': [1, 2, 3]
            }
        };
        const result = validatePricing(pricing);
        // Array passes typeof === 'object' but then fails on missing properties
        expect(result.valid).toBe(false);
    });
});

// ===========================================================================
// Covers line 112: outputTokenPer1M cannot be negative
// ===========================================================================
describe('validatePricing - negative outputTokenPer1M', () => {
    // Covers line 112: outputTokenPer1M < 0 error branch
    test('rejects when outputTokenPer1M is negative', () => {
        const pricing = {
            version: '1.0.0',
            models: {
                'neg-output': { inputTokenPer1M: 1.00, outputTokenPer1M: -5.00 }
            }
        };
        const result = validatePricing(pricing);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('outputTokenPer1M cannot be negative'))).toBe(true);
    });

    // Covers line 112: both tokens negative
    test('rejects when both input and output are negative', () => {
        const pricing = {
            version: '1.0.0',
            models: {
                'both-neg': { inputTokenPer1M: -1.00, outputTokenPer1M: -2.00 }
            }
        };
        const result = validatePricing(pricing);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('inputTokenPer1M cannot be negative'))).toBe(true);
        expect(result.errors.some(e => e.includes('outputTokenPer1M cannot be negative'))).toBe(true);
    });
});

// ===========================================================================
// Covers line 129: computePricingHash early return for null/no-models
// ===========================================================================
describe('computePricingHash - null/undefined/empty input', () => {
    // Covers line 129: null pricing returns empty string
    test('returns empty string for null pricing', () => {
        const hash = computePricingHash(null);
        expect(hash).toBe('');
    });

    // Covers line 129: undefined pricing returns empty string
    test('returns empty string for undefined pricing', () => {
        const hash = computePricingHash(undefined);
        expect(hash).toBe('');
    });

    // Covers line 129: pricing without models returns empty string
    test('returns empty string for pricing without models', () => {
        const hash = computePricingHash({ version: '1.0.0' });
        expect(hash).toBe('');
    });

    // Covers line 129: pricing with null models returns empty string
    test('returns empty string for pricing with null models', () => {
        const hash = computePricingHash({ version: '1.0.0', models: null });
        expect(hash).toBe('');
    });

    // Covers line 129: pricing with empty models object returns valid hash
    test('returns valid hash for empty models object', () => {
        const hash = computePricingHash({ version: '1.0.0', models: {} });
        expect(hash).toBeDefined();
        expect(hash.length).toBe(64); // SHA-256 hex
    });
});

// ===========================================================================
// Integration: loadPricing propagates validation errors for these cases
// ===========================================================================
describe('loadPricing - validation of edge cases from file', () => {
    // Covers line 99-100 via loadPricing file path
    test('file with null model rates fails validation', () => {
        const filePath = writePricingFile({
            version: '1.0.0',
            models: { 'bad': null }
        });
        const result = loadPricing(filePath);
        expect(result.loaded).toBe(false);
        expect(result.error).toMatch(/rates must be an object/i);
    });

    // Covers line 112 via loadPricing file path
    test('file with negative outputTokenPer1M fails validation', () => {
        const filePath = writePricingFile({
            version: '1.0.0',
            models: { 'neg': { inputTokenPer1M: 1, outputTokenPer1M: -10 } }
        });
        const result = loadPricing(filePath);
        expect(result.loaded).toBe(false);
        expect(result.error).toMatch(/outputTokenPer1M cannot be negative/i);
    });
});
