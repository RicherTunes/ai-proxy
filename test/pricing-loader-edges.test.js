'use strict';
/**
 * Pricing Loader Edge-Case Tests
 *
 * Covers:
 * 1.  Default pricing correctness for known models
 * 2.  Loading pricing from a custom JSON file
 * 3.  Malformed pricing file falls back to defaults
 * 4.  Missing pricing file falls back to defaults
 * 5.  Token count x rate produces correct dollar amounts
 * 6.  Output rate >= input rate for all default models (cachedInput proxy)
 * 7.  Model prefix matching via CostTracker.getRatesByModel
 * 8.  Hot reload: changed file yields new pricing on next load
 * 9.  Edge: zero tokens produces $0 cost
 * 10. Edge: very large token counts don't produce NaN/Infinity
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
    getDefaultPricing,
    validatePricing,
    computePricingHash,
    loadPricing,
    DEFAULT_PRICING
} = require('../lib/pricing-loader');

const { CostTracker, DEFAULT_MODEL_RATES } = require('../lib/cost-tracker');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let testDir;

beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-edges-'));
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

function writePricingFile(dir, data) {
    const p = path.join(dir, 'pricing.json');
    fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    return p;
}

// ===========================================================================
// 1. Default pricing: Built-in pricing for known models is correct
// ===========================================================================
describe('1 - Default pricing correctness', () => {
    test('glm-5 flagship has expected rates', () => {
        const pricing = getDefaultPricing();
        expect(pricing.models['glm-5'].inputTokenPer1M).toBe(1.00);
        expect(pricing.models['glm-5'].outputTokenPer1M).toBe(3.20);
    });

    test('claude-opus-4-6 has expected rates', () => {
        const pricing = getDefaultPricing();
        expect(pricing.models['claude-opus-4-6'].inputTokenPer1M).toBe(15.00);
        expect(pricing.models['claude-opus-4-6'].outputTokenPer1M).toBe(75.00);
    });

    test('claude-haiku-3 is cheapest Claude model', () => {
        const pricing = getDefaultPricing();
        const haiku3 = pricing.models['claude-haiku-3'];
        expect(haiku3.inputTokenPer1M).toBe(0.25);
        expect(haiku3.outputTokenPer1M).toBe(1.25);
    });

    test('free-tier flash models have zero pricing', () => {
        const pricing = getDefaultPricing();
        for (const id of ['glm-4.7-flash', 'glm-4.5-flash', 'glm-4.6v-flash']) {
            expect(pricing.models[id].inputTokenPer1M).toBe(0);
            expect(pricing.models[id].outputTokenPer1M).toBe(0);
        }
    });

    test('getDefaultPricing returns a deep clone (mutations do not leak)', () => {
        const a = getDefaultPricing();
        a.models['glm-5'].inputTokenPer1M = 999;
        const b = getDefaultPricing();
        expect(b.models['glm-5'].inputTokenPer1M).toBe(1.00);
    });

    test('default pricing contains version and metadata', () => {
        const pricing = getDefaultPricing();
        expect(pricing.version).toBe('1.0.0');
        expect(pricing.lastVerifiedAt).toBeDefined();
        expect(pricing.sourceUrl).toContain('z.ai');
    });
});

// ===========================================================================
// 2. Custom pricing file: Loading pricing from custom JSON file works
// ===========================================================================
describe('2 - Custom pricing file', () => {
    test('loads custom model rates from a valid file', () => {
        const custom = {
            version: '2.0.0',
            lastVerifiedAt: '2026-03-01',
            sourceUrl: 'https://example.com',
            models: {
                'my-model': { inputTokenPer1M: 5.55, outputTokenPer1M: 11.11 }
            }
        };
        const filePath = writePricingFile(testDir, custom);
        const result = loadPricing(filePath);

        expect(result.loaded).toBe(true);
        expect(result.source).toBe('file');
        expect(result.pricing.models['my-model'].inputTokenPer1M).toBe(5.55);
        expect(result.error).toBeNull();
    });

    test('hash differs between default and custom pricing', () => {
        const custom = {
            version: '1.0.0',
            models: { 'x': { inputTokenPer1M: 0.01, outputTokenPer1M: 0.02 } }
        };
        const filePath = writePricingFile(testDir, custom);
        const customResult = loadPricing(filePath);
        const defaultHash = computePricingHash(getDefaultPricing());

        expect(customResult.hash).not.toBe(defaultHash);
    });

    test('accepts relative path resolved against cwd', () => {
        // loadPricing joins non-absolute paths with process.cwd()
        const custom = {
            version: '1.0.0',
            models: { 'rel-model': { inputTokenPer1M: 0.5, outputTokenPer1M: 1.0 } }
        };
        const absPath = writePricingFile(testDir, custom);

        // Temporarily change cwd to testDir so relative lookup works
        const origCwd = process.cwd();
        try {
            process.chdir(testDir);
            const result = loadPricing('pricing.json');
            expect(result.loaded).toBe(true);
            expect(result.pricing.models['rel-model']).toBeDefined();
        } finally {
            process.chdir(origCwd);
        }
    });
});

// ===========================================================================
// 3. Malformed pricing file: Corrupt file doesn't crash, falls back
// ===========================================================================
describe('3 - Malformed pricing file', () => {
    test('invalid JSON falls back to defaults without throwing', () => {
        const filePath = writePricingFile(testDir, '{{{not json');
        const result = loadPricing(filePath);

        expect(result.loaded).toBe(false);
        expect(result.source).toBe('defaults');
        expect(result.error).toMatch(/parse/i);
        expect(result.pricing.models['glm-5']).toBeDefined();
    });

    test('empty file falls back to defaults', () => {
        const filePath = writePricingFile(testDir, '');
        const result = loadPricing(filePath);

        expect(result.loaded).toBe(false);
        expect(result.source).toBe('defaults');
    });

    test('valid JSON but missing version field falls back', () => {
        const bad = { models: { 'a': { inputTokenPer1M: 1, outputTokenPer1M: 2 } } };
        const filePath = writePricingFile(testDir, bad);
        const result = loadPricing(filePath);

        expect(result.loaded).toBe(false);
        expect(result.error).toMatch(/version/i);
        expect(result.pricing.models['glm-5']).toBeDefined();
    });

    test('valid JSON but missing models field falls back', () => {
        const bad = { version: '1.0.0' };
        const filePath = writePricingFile(testDir, bad);
        const result = loadPricing(filePath);

        expect(result.loaded).toBe(false);
        expect(result.error).toMatch(/models/i);
    });

    test('model with negative rate fails validation', () => {
        const bad = {
            version: '1.0.0',
            models: { 'm': { inputTokenPer1M: -1, outputTokenPer1M: 2 } }
        };
        const filePath = writePricingFile(testDir, bad);
        const result = loadPricing(filePath);

        expect(result.loaded).toBe(false);
        expect(result.error).toMatch(/negative/i);
    });

    test('model with string rate fails validation', () => {
        const bad = {
            version: '1.0.0',
            models: { 'm': { inputTokenPer1M: 'free', outputTokenPer1M: 0 } }
        };
        const filePath = writePricingFile(testDir, bad);
        const result = loadPricing(filePath);

        expect(result.loaded).toBe(false);
        expect(result.error).toMatch(/number/i);
    });

    test('null config path returns defaults', () => {
        const result = loadPricing(null);
        expect(result.loaded).toBe(false);
        expect(result.source).toBe('defaults');
        expect(result.error).toMatch(/No config path/i);
    });
});

// ===========================================================================
// 4. Missing pricing file: No file uses built-in defaults
// ===========================================================================
describe('4 - Missing pricing file', () => {
    test('nonexistent path returns defaults with error message', () => {
        const result = loadPricing('/tmp/does-not-exist-9999/pricing.json');

        expect(result.loaded).toBe(false);
        expect(result.source).toBe('defaults');
        expect(result.error).toMatch(/not found/i);
        expect(result.pricing).toBeDefined();
        expect(Object.keys(result.pricing.models).length).toBeGreaterThan(0);
    });

    test('hash is still computed for fallback defaults', () => {
        const result = loadPricing('/nonexistent');
        expect(result.hash).toBeDefined();
        expect(result.hash.length).toBe(64); // SHA-256 hex
    });
});

// ===========================================================================
// 5. Price calculation: token count x rate produces correct dollar amounts
// ===========================================================================
describe('5 - Price calculation', () => {
    let tracker;

    beforeEach(() => {
        tracker = new CostTracker({ saveDebounceMs: 999999 });
    });

    test('1M input tokens of glm-5 costs exactly $1.00', () => {
        const cost = tracker.calculateCost(1_000_000, 0, 'glm-5');
        expect(cost).toBeCloseTo(1.00, 6);
    });

    test('1M output tokens of glm-5 costs exactly $3.20', () => {
        const cost = tracker.calculateCost(0, 1_000_000, 'glm-5');
        expect(cost).toBeCloseTo(3.20, 6);
    });

    test('mixed input/output for claude-opus-4-6', () => {
        // 500k input = $7.50, 200k output = $15.00 → total $22.50
        const cost = tracker.calculateCost(500_000, 200_000, 'claude-opus-4-6');
        expect(cost).toBeCloseTo(22.50, 4);
    });

    test('free tier model (glm-4.7-flash) always costs $0', () => {
        const cost = tracker.calculateCost(10_000_000, 10_000_000, 'glm-4.7-flash');
        expect(cost).toBe(0);
    });

    test('cost is rounded to 6 decimal places', () => {
        // 1 token of claude-haiku-3: input = 0.25/1M = 0.00000025
        const cost = tracker.calculateCost(1, 0, 'claude-haiku-3');
        // Should not have more than 6 decimal digits
        const decimalPart = cost.toString().split('.')[1] || '';
        expect(decimalPart.length).toBeLessThanOrEqual(6);
    });
});

// ===========================================================================
// 6. Cached input pricing: input rate relationships across models
// ===========================================================================
describe('6 - Input vs output rate relationships', () => {
    test('output rate >= input rate for every default model', () => {
        const pricing = getDefaultPricing();
        for (const [modelId, rates] of Object.entries(pricing.models)) {
            expect(rates.outputTokenPer1M).toBeGreaterThanOrEqual(rates.inputTokenPer1M);
        }
    });

    test('all default model rates are non-negative', () => {
        const pricing = getDefaultPricing();
        for (const [modelId, rates] of Object.entries(pricing.models)) {
            expect(rates.inputTokenPer1M).toBeGreaterThanOrEqual(0);
            expect(rates.outputTokenPer1M).toBeGreaterThanOrEqual(0);
        }
    });

    test('DEFAULT_MODEL_RATES in cost-tracker mirrors pricing-loader defaults', () => {
        const loaderModels = getDefaultPricing().models;
        for (const [model, rates] of Object.entries(DEFAULT_MODEL_RATES)) {
            expect(loaderModels[model]).toBeDefined();
            expect(loaderModels[model].inputTokenPer1M).toBe(rates.inputTokenPer1M);
            expect(loaderModels[model].outputTokenPer1M).toBe(rates.outputTokenPer1M);
        }
    });
});

// ===========================================================================
// 7. Model prefix matching: versioned model IDs match base pricing
// ===========================================================================
describe('7 - Model prefix matching', () => {
    let tracker;

    beforeEach(() => {
        tracker = new CostTracker({ saveDebounceMs: 999999 });
    });

    test('claude-sonnet-4-5-20250514 matches claude-sonnet-4-5 rates', () => {
        const base = tracker.getRatesByModel('claude-sonnet-4-5');
        const versioned = tracker.getRatesByModel('claude-sonnet-4-5-20250514');
        expect(versioned.inputTokenPer1M).toBe(base.inputTokenPer1M);
        expect(versioned.outputTokenPer1M).toBe(base.outputTokenPer1M);
    });

    test('claude-opus-4-6-20260115 matches claude-opus-4-6 rates', () => {
        const base = tracker.getRatesByModel('claude-opus-4-6');
        const versioned = tracker.getRatesByModel('claude-opus-4-6-20260115');
        expect(versioned.inputTokenPer1M).toBe(base.inputTokenPer1M);
        expect(versioned.outputTokenPer1M).toBe(base.outputTokenPer1M);
    });

    test('claude-haiku-4-5-20260101 matches claude-haiku-4-5 rates', () => {
        const base = tracker.getRatesByModel('claude-haiku-4-5');
        const versioned = tracker.getRatesByModel('claude-haiku-4-5-20260101');
        expect(versioned.inputTokenPer1M).toBe(base.inputTokenPer1M);
        expect(versioned.outputTokenPer1M).toBe(base.outputTokenPer1M);
    });

    test('completely unknown model falls back to generic default rates', () => {
        const rates = tracker.getRatesByModel('totally-unknown-model-xyz');
        // Should fall back to CostTracker default rates (Claude Sonnet 4.5)
        expect(rates.inputTokenPer1M).toBe(3.00);
        expect(rates.outputTokenPer1M).toBe(15.00);
    });

    test('null/undefined model returns default rates', () => {
        const ratesNull = tracker.getRatesByModel(null);
        const ratesUndef = tracker.getRatesByModel(undefined);
        expect(ratesNull.inputTokenPer1M).toBeDefined();
        expect(ratesUndef.inputTokenPer1M).toBeDefined();
    });

    test('case-insensitive lookup works for exact matches', () => {
        const upper = tracker.getRatesByModel('GLM-5');
        // getRatesByModel lowercases and checks; 'glm-5' should match
        expect(upper.inputTokenPer1M).toBe(1.00);
    });
});

// ===========================================================================
// 8. Hot reload: If pricing file changes, new pricing takes effect
// ===========================================================================
describe('8 - Hot reload', () => {
    test('loadPricing reads fresh data on each call', () => {
        const original = {
            version: '1.0.0',
            models: { 'test-model': { inputTokenPer1M: 1.00, outputTokenPer1M: 2.00 } }
        };
        const filePath = writePricingFile(testDir, original);

        const first = loadPricing(filePath);
        expect(first.loaded).toBe(true);
        expect(first.pricing.models['test-model'].inputTokenPer1M).toBe(1.00);

        // Update the file
        const updated = {
            version: '1.1.0',
            models: { 'test-model': { inputTokenPer1M: 9.99, outputTokenPer1M: 19.99 } }
        };
        fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));

        const second = loadPricing(filePath);
        expect(second.loaded).toBe(true);
        expect(second.pricing.models['test-model'].inputTokenPer1M).toBe(9.99);
        expect(second.pricing.models['test-model'].outputTokenPer1M).toBe(19.99);
    });

    test('hash changes when file content changes', () => {
        const v1 = {
            version: '1.0.0',
            models: { 'a': { inputTokenPer1M: 1, outputTokenPer1M: 2 } }
        };
        const filePath = writePricingFile(testDir, v1);
        const hash1 = loadPricing(filePath).hash;

        const v2 = {
            version: '1.0.0',
            models: { 'a': { inputTokenPer1M: 3, outputTokenPer1M: 4 } }
        };
        fs.writeFileSync(filePath, JSON.stringify(v2, null, 2));
        const hash2 = loadPricing(filePath).hash;

        expect(hash1).not.toBe(hash2);
    });

    test('if updated file becomes corrupt, falls back to defaults', () => {
        const valid = {
            version: '1.0.0',
            models: { 'ok': { inputTokenPer1M: 1, outputTokenPer1M: 2 } }
        };
        const filePath = writePricingFile(testDir, valid);
        expect(loadPricing(filePath).loaded).toBe(true);

        // Corrupt the file
        fs.writeFileSync(filePath, '<<<CORRUPT>>>');
        const result = loadPricing(filePath);
        expect(result.loaded).toBe(false);
        expect(result.source).toBe('defaults');
    });
});

// ===========================================================================
// 9. Edge: zero tokens produces $0 cost
// ===========================================================================
describe('9 - Zero tokens edge', () => {
    let tracker;

    beforeEach(() => {
        tracker = new CostTracker({ saveDebounceMs: 999999 });
    });

    test('calculateCost(0, 0) returns exactly 0', () => {
        const cost = tracker.calculateCost(0, 0, 'glm-5');
        expect(cost).toBe(0);
    });

    test('calculateCost(0, 0) returns 0 for expensive model too', () => {
        const cost = tracker.calculateCost(0, 0, 'claude-opus-4-6');
        expect(cost).toBe(0);
    });

    test('zero input with nonzero output still works', () => {
        const cost = tracker.calculateCost(0, 1_000_000, 'glm-5');
        expect(cost).toBeCloseTo(3.20, 6);
    });

    test('nonzero input with zero output still works', () => {
        const cost = tracker.calculateCost(1_000_000, 0, 'glm-5');
        expect(cost).toBeCloseTo(1.00, 6);
    });
});

// ===========================================================================
// 10. Edge: very large token counts don't produce NaN/Infinity
// ===========================================================================
describe('10 - Very large token counts', () => {
    let tracker;

    beforeEach(() => {
        tracker = new CostTracker({ saveDebounceMs: 999999 });
    });

    test('1 billion input tokens produces finite cost', () => {
        const cost = tracker.calculateCost(1_000_000_000, 0, 'claude-opus-4-6');
        expect(Number.isFinite(cost)).toBe(true);
        expect(cost).toBeGreaterThan(0);
        // 1B tokens * $15/1M = $15,000
        expect(cost).toBeCloseTo(15000, 0);
    });

    test('1 billion output tokens produces finite cost', () => {
        const cost = tracker.calculateCost(0, 1_000_000_000, 'claude-opus-4-6');
        expect(Number.isFinite(cost)).toBe(true);
        // 1B tokens * $75/1M = $75,000
        expect(cost).toBeCloseTo(75000, 0);
    });

    test('100 billion tokens in both directions is still finite', () => {
        const cost = tracker.calculateCost(100_000_000_000, 100_000_000_000, 'glm-5');
        expect(Number.isFinite(cost)).toBe(true);
        expect(Number.isNaN(cost)).toBe(false);
        // 100B input * $1/1M + 100B output * $3.20/1M = $100,000 + $320,000
        expect(cost).toBeCloseTo(420000, 0);
    });

    test('Number.MAX_SAFE_INTEGER tokens does not produce NaN', () => {
        const cost = tracker.calculateCost(Number.MAX_SAFE_INTEGER, 0, 'glm-5');
        expect(Number.isNaN(cost)).toBe(false);
        expect(Number.isFinite(cost)).toBe(true);
    });

    test('computePricingHash handles pricing with many models', () => {
        const pricing = getDefaultPricing();
        // Add 1000 synthetic models
        for (let i = 0; i < 1000; i++) {
            pricing.models[`synthetic-model-${i}`] = {
                inputTokenPer1M: i * 0.01,
                outputTokenPer1M: i * 0.02
            };
        }
        const hash = computePricingHash(pricing);
        expect(hash).toBeDefined();
        expect(hash.length).toBe(64);
    });
});
