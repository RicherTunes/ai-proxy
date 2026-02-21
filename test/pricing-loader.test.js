/**
 * Pricing Loader Module Tests
 *
 * Tests cover the pricing-loader module:
 * - Loading pricing from config/pricing.json
 * - Validation of pricing data structure
 * - Fallback to hardcoded defaults
 * - Hash computation for change detection
 * - Error handling for missing/invalid config
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// We'll test the pricing-loader module
// First, let's define what we expect it to export

describe('pricing-loader module', () => {
    let testDir;
    const originalDir = process.cwd();

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-loader-test-'));
    });

    afterEach(() => {
        try {
            const files = fs.readdirSync(testDir);
            for (const file of files) {
                fs.unlinkSync(path.join(testDir, file));
            }
            fs.rmdirSync(testDir);
        } catch (err) {
            // Ignore cleanup errors
        }
    });

    describe('module exports', () => {
        test('should export loadPricing function', () => {
            const { loadPricing } = require('../lib/pricing-loader');
            expect(loadPricing).toBeDefined();
            expect(typeof loadPricing).toBe('function');
        });

        test('should export getDefaultPricing function', () => {
            const { getDefaultPricing } = require('../lib/pricing-loader');
            expect(getDefaultPricing).toBeDefined();
            expect(typeof getDefaultPricing).toBe('function');
        });

        test('should export computePricingHash function', () => {
            const { computePricingHash } = require('../lib/pricing-loader');
            expect(computePricingHash).toBeDefined();
            expect(typeof computePricingHash).toBe('function');
        });

        test('should export validatePricing function', () => {
            const { validatePricing } = require('../lib/pricing-loader');
            expect(validatePricing).toBeDefined();
            expect(typeof validatePricing).toBe('function');
        });

        test('should export DEFAULT_PRICING_SOURCE_URL', () => {
            const { DEFAULT_PRICING_SOURCE_URL } = require('../lib/pricing-loader');
            expect(DEFAULT_PRICING_SOURCE_URL).toBeDefined();
            expect(DEFAULT_PRICING_SOURCE_URL).toBe('https://docs.z.ai/guides/overview/pricing');
        });
    });

    describe('getDefaultPricing', () => {
        test('should return pricing object with all required fields', () => {
            const { getDefaultPricing } = require('../lib/pricing-loader');
            const pricing = getDefaultPricing();

            expect(pricing.version).toBeDefined();
            expect(pricing.lastVerifiedAt).toBeDefined();
            expect(pricing.sourceUrl).toBeDefined();
            expect(pricing.models).toBeDefined();
            expect(typeof pricing.models).toBe('object');
        });

        test('should include GLM-5 flagship model pricing', () => {
            const { getDefaultPricing } = require('../lib/pricing-loader');
            const pricing = getDefaultPricing();

            expect(pricing.models['glm-5']).toBeDefined();
            expect(pricing.models['glm-5'].inputTokenPer1M).toBe(1.00);
            expect(pricing.models['glm-5'].outputTokenPer1M).toBe(3.20);
        });

        test('should include Claude models pricing', () => {
            const { getDefaultPricing } = require('../lib/pricing-loader');
            const pricing = getDefaultPricing();

            expect(pricing.models['claude-opus-4-6']).toBeDefined();
            expect(pricing.models['claude-sonnet-4-5']).toBeDefined();
            expect(pricing.models['claude-haiku-4-5']).toBeDefined();
        });

        test('should include GLM vision models', () => {
            const { getDefaultPricing } = require('../lib/pricing-loader');
            const pricing = getDefaultPricing();

            expect(pricing.models['glm-4.6v']).toBeDefined();
            expect(pricing.models['glm-4.5v']).toBeDefined();
        });

        test('should include free tier models with zero pricing', () => {
            const { getDefaultPricing } = require('../lib/pricing-loader');
            const pricing = getDefaultPricing();

            expect(pricing.models['glm-4.7-flash']).toBeDefined();
            expect(pricing.models['glm-4.7-flash'].inputTokenPer1M).toBe(0);
            expect(pricing.models['glm-4.7-flash'].outputTokenPer1M).toBe(0);
        });
    });

    describe('validatePricing', () => {
        test('should return valid for correct pricing structure', () => {
            const { validatePricing } = require('../lib/pricing-loader');
            const validPricing = {
                version: '1.0.0',
                lastVerifiedAt: '2026-02-21',
                sourceUrl: 'https://docs.z.ai/guides/overview/pricing',
                models: {
                    'glm-5': { inputTokenPer1M: 1.00, outputTokenPer1M: 3.20 }
                }
            };

            const result = validatePricing(validPricing);
            expect(result.valid).toBe(true);
            expect(result.errors).toEqual([]);
        });

        test('should return invalid when version is missing', () => {
            const { validatePricing } = require('../lib/pricing-loader');
            const invalidPricing = {
                lastVerifiedAt: '2026-02-21',
                sourceUrl: 'https://docs.z.ai/guides/overview/pricing',
                models: {}
            };

            const result = validatePricing(invalidPricing);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('version'))).toBe(true);
        });

        test('should return invalid when models is missing', () => {
            const { validatePricing } = require('../lib/pricing-loader');
            const invalidPricing = {
                version: '1.0.0',
                lastVerifiedAt: '2026-02-21',
                sourceUrl: 'https://docs.z.ai/guides/overview/pricing'
            };

            const result = validatePricing(invalidPricing);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('models'))).toBe(true);
        });

        test('should return invalid when model pricing has negative values', () => {
            const { validatePricing } = require('../lib/pricing-loader');
            const invalidPricing = {
                version: '1.0.0',
                lastVerifiedAt: '2026-02-21',
                sourceUrl: 'https://docs.z.ai/guides/overview/pricing',
                models: {
                    'glm-5': { inputTokenPer1M: -1.00, outputTokenPer1M: 3.20 }
                }
            };

            const result = validatePricing(invalidPricing);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('negative'))).toBe(true);
        });

        test('should return invalid when model pricing has non-numeric values', () => {
            const { validatePricing } = require('../lib/pricing-loader');
            const invalidPricing = {
                version: '1.0.0',
                lastVerifiedAt: '2026-02-21',
                sourceUrl: 'https://docs.z.ai/guides/overview/pricing',
                models: {
                    'glm-5': { inputTokenPer1M: 'free', outputTokenPer1M: 3.20 }
                }
            };

            const result = validatePricing(invalidPricing);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('number'))).toBe(true);
        });

        test('should return invalid when inputTokenPer1M is missing', () => {
            const { validatePricing } = require('../lib/pricing-loader');
            const invalidPricing = {
                version: '1.0.0',
                lastVerifiedAt: '2026-02-21',
                sourceUrl: 'https://docs.z.ai/guides/overview/pricing',
                models: {
                    'glm-5': { outputTokenPer1M: 3.20 }
                }
            };

            const result = validatePricing(invalidPricing);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('inputTokenPer1M'))).toBe(true);
        });

        test('should return invalid when outputTokenPer1M is missing', () => {
            const { validatePricing } = require('../lib/pricing-loader');
            const invalidPricing = {
                version: '1.0.0',
                lastVerifiedAt: '2026-02-21',
                sourceUrl: 'https://docs.z.ai/guides/overview/pricing',
                models: {
                    'glm-5': { inputTokenPer1M: 1.00 }
                }
            };

            const result = validatePricing(invalidPricing);
            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('outputTokenPer1M'))).toBe(true);
        });

        test('should accept null or undefined input', () => {
            const { validatePricing } = require('../lib/pricing-loader');

            const resultNull = validatePricing(null);
            expect(resultNull.valid).toBe(false);

            const resultUndefined = validatePricing(undefined);
            expect(resultUndefined.valid).toBe(false);
        });
    });

    describe('computePricingHash', () => {
        test('should return consistent hash for same pricing data', () => {
            const { computePricingHash, getDefaultPricing } = require('../lib/pricing-loader');
            const pricing = getDefaultPricing();

            const hash1 = computePricingHash(pricing);
            const hash2 = computePricingHash(pricing);

            expect(hash1).toBe(hash2);
            expect(typeof hash1).toBe('string');
            expect(hash1.length).toBeGreaterThan(0);
        });

        test('should return different hash for different pricing data', () => {
            const { computePricingHash, getDefaultPricing } = require('../lib/pricing-loader');
            const pricing1 = getDefaultPricing();
            const pricing2 = {
                ...pricing1,
                models: {
                    ...pricing1.models,
                    'glm-5': { inputTokenPer1M: 2.00, outputTokenPer1M: 6.40 }
                }
            };

            const hash1 = computePricingHash(pricing1);
            const hash2 = computePricingHash(pricing2);

            expect(hash1).not.toBe(hash2);
        });

        test('should only hash models, not metadata', () => {
            const { computePricingHash, getDefaultPricing } = require('../lib/pricing-loader');
            const pricing1 = getDefaultPricing();
            const pricing2 = {
                ...pricing1,
                lastVerifiedAt: '2026-01-01', // Different metadata
                version: '2.0.0'
            };

            const hash1 = computePricingHash(pricing1);
            const hash2 = computePricingHash(pricing2);

            // Same models should produce same hash regardless of metadata
            expect(hash1).toBe(hash2);
        });
    });

    describe('loadPricing', () => {
        test('should load pricing from valid config file', () => {
            const { loadPricing, getDefaultPricing } = require('../lib/pricing-loader');
            const defaultPricing = getDefaultPricing();

            // Write a valid pricing config
            const configPath = path.join(testDir, 'pricing.json');
            fs.writeFileSync(configPath, JSON.stringify(defaultPricing, null, 2));

            const result = loadPricing(configPath);

            expect(result.loaded).toBe(true);
            expect(result.pricing).toBeDefined();
            expect(result.pricing.models['glm-5'].inputTokenPer1M).toBe(1.00);
            expect(result.source).toBe('file');
        });

        test('should return defaults when file not found', () => {
            const { loadPricing, getDefaultPricing } = require('../lib/pricing-loader');

            const result = loadPricing('/nonexistent/path/pricing.json');

            expect(result.loaded).toBe(false);
            expect(result.pricing).toBeDefined();
            expect(result.source).toBe('defaults');
            expect(result.error).toContain('not found');
        });

        test('should return defaults and error for invalid JSON', () => {
            const { loadPricing, getDefaultPricing } = require('../lib/pricing-loader');

            const configPath = path.join(testDir, 'pricing.json');
            fs.writeFileSync(configPath, 'not valid json');

            const result = loadPricing(configPath);

            expect(result.loaded).toBe(false);
            expect(result.pricing).toBeDefined(); // Falls back to defaults
            expect(result.source).toBe('defaults');
            expect(result.error).toContain('parse');
        });

        test('should return defaults and error for invalid pricing structure', () => {
            const { loadPricing } = require('../lib/pricing-loader');

            const configPath = path.join(testDir, 'pricing.json');
            fs.writeFileSync(configPath, JSON.stringify({
                version: '1.0.0'
                // Missing models
            }));

            const result = loadPricing(configPath);

            expect(result.loaded).toBe(false);
            expect(result.pricing).toBeDefined(); // Falls back to defaults
            expect(result.source).toBe('defaults');
            expect(result.error).toContain('Validation');
        });

        test('should include config file metadata in result', () => {
            const { loadPricing, getDefaultPricing } = require('../lib/pricing-loader');
            const defaultPricing = getDefaultPricing();

            const configPath = path.join(testDir, 'pricing.json');
            fs.writeFileSync(configPath, JSON.stringify(defaultPricing, null, 2));

            const result = loadPricing(configPath);

            expect(result.configPath).toBe(configPath);
            expect(result.hash).toBeDefined();
        });
    });

    describe('integration with cost-tracker', () => {
        test('pricing-loader default pricing should match cost-tracker DEFAULT_MODEL_RATES', () => {
            const { getDefaultPricing } = require('../lib/pricing-loader');
            const { DEFAULT_MODEL_RATES } = require('../lib/cost-tracker');

            const loaderPricing = getDefaultPricing();

            // Check that all models in DEFAULT_MODEL_RATES are in loader pricing
            for (const [model, rates] of Object.entries(DEFAULT_MODEL_RATES)) {
                expect(loaderPricing.models[model]).toBeDefined();
                expect(loaderPricing.models[model].inputTokenPer1M).toBe(rates.inputTokenPer1M);
                expect(loaderPricing.models[model].outputTokenPer1M).toBe(rates.outputTokenPer1M);
            }
        });
    });
});
