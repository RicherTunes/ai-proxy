/**
 * Pricing Loader Module
 *
 * Loads model pricing from external configuration file with fallback to defaults.
 * Provides validation, hash computation for change detection, and error handling.
 *
 * Features:
 * - Load from config/pricing.json
 * - Validate pricing structure
 * - Fallback to hardcoded defaults
 * - Compute hash for change detection
 * - Error handling with clear messages
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_PRICING_SOURCE_URL = 'https://docs.z.ai/guides/overview/pricing';

// Default pricing data - verified against docs.z.ai/guides/overview/pricing (Feb 2026)
const DEFAULT_PRICING = {
    version: '1.0.0',
    lastVerifiedAt: '2026-02-21',
    sourceUrl: DEFAULT_PRICING_SOURCE_URL,
    models: {
        // Claude models (Anthropic pricing via z.ai pass-through)
        'claude-opus-4-6': { inputTokenPer1M: 15.00, outputTokenPer1M: 75.00 },
        'claude-opus-4': { inputTokenPer1M: 15.00, outputTokenPer1M: 75.00 },
        'claude-sonnet-4-6': { inputTokenPer1M: 3.00, outputTokenPer1M: 15.00 },
        'claude-sonnet-4-5': { inputTokenPer1M: 3.00, outputTokenPer1M: 15.00 },
        'claude-haiku-4-5': { inputTokenPer1M: 0.80, outputTokenPer1M: 4.00 },
        'claude-haiku-4': { inputTokenPer1M: 0.80, outputTokenPer1M: 4.00 },
        'claude-opus-3': { inputTokenPer1M: 15.00, outputTokenPer1M: 75.00 },
        'claude-sonnet-3': { inputTokenPer1M: 3.00, outputTokenPer1M: 15.00 },
        'claude-haiku-3': { inputTokenPer1M: 0.25, outputTokenPer1M: 1.25 },
        // GLM Flagship tier (z.ai published pricing Feb 2026)
        'glm-5': { inputTokenPer1M: 1.00, outputTokenPer1M: 3.20 },
        'glm-5-code': { inputTokenPer1M: 1.20, outputTokenPer1M: 5.00 },
        'glm-4.5-x': { inputTokenPer1M: 2.20, outputTokenPer1M: 8.90 },
        // GLM Standard tier
        'glm-4.7': { inputTokenPer1M: 0.60, outputTokenPer1M: 2.20 },
        'glm-4.6': { inputTokenPer1M: 0.60, outputTokenPer1M: 2.20 },
        'glm-4.5': { inputTokenPer1M: 0.60, outputTokenPer1M: 2.20 },
        // GLM Lightweight/Air tier
        'glm-4.5-air': { inputTokenPer1M: 0.20, outputTokenPer1M: 1.10 },
        'glm-4.5-airx': { inputTokenPer1M: 1.10, outputTokenPer1M: 4.50 },
        // GLM Flash tier (free or ultra-low cost)
        'glm-4.7-flash': { inputTokenPer1M: 0.00, outputTokenPer1M: 0.00 },
        'glm-4.7-flashx': { inputTokenPer1M: 0.07, outputTokenPer1M: 0.40 },
        'glm-4.5-flash': { inputTokenPer1M: 0.00, outputTokenPer1M: 0.00 },
        // GLM Vision models
        'glm-4.5v': { inputTokenPer1M: 0.60, outputTokenPer1M: 1.80 },
        'glm-4.6v': { inputTokenPer1M: 0.30, outputTokenPer1M: 0.90 },
        'glm-4.6v-flashx': { inputTokenPer1M: 0.04, outputTokenPer1M: 0.40 },
        'glm-4.6v-flash': { inputTokenPer1M: 0.00, outputTokenPer1M: 0.00 },
        // GLM Open-source
        'glm-4-32b-0414-128k': { inputTokenPer1M: 0.10, outputTokenPer1M: 0.10 }
    }
};

/**
 * Get the default pricing object
 * @returns {Object} Default pricing with version, metadata, and models
 */
function getDefaultPricing() {
    return JSON.parse(JSON.stringify(DEFAULT_PRICING));
}

/**
 * Validate pricing structure
 * @param {Object} pricing - Pricing object to validate
 * @returns {Object} Validation result { valid: boolean, errors: string[] }
 */
function validatePricing(pricing) {
    const errors = [];

    if (!pricing || typeof pricing !== 'object') {
        return { valid: false, errors: ['Pricing must be an object'] };
    }

    // Check required top-level fields
    if (!pricing.version || typeof pricing.version !== 'string') {
        errors.push('version is required and must be a string');
    }

    if (!pricing.models || typeof pricing.models !== 'object') {
        errors.push('models is required and must be an object');
    }

    if (errors.length > 0) {
        return { valid: false, errors };
    }

    // Validate each model's pricing
    for (const [modelId, rates] of Object.entries(pricing.models)) {
        if (!rates || typeof rates !== 'object') {
            errors.push(`${modelId}: rates must be an object`);
            continue;
        }

        if (typeof rates.inputTokenPer1M !== 'number') {
            errors.push(`${modelId}: inputTokenPer1M must be a number`);
        } else if (rates.inputTokenPer1M < 0) {
            errors.push(`${modelId}: inputTokenPer1M cannot be negative`);
        }

        if (typeof rates.outputTokenPer1M !== 'number') {
            errors.push(`${modelId}: outputTokenPer1M must be a number`);
        } else if (rates.outputTokenPer1M < 0) {
            errors.push(`${modelId}: outputTokenPer1M cannot be negative`);
        }
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Compute hash of pricing models only (ignores metadata like version, date)
 * @param {Object} pricing - Pricing object
 * @returns {string} SHA256 hash of the models data
 */
function computePricingHash(pricing) {
    if (!pricing || !pricing.models) {
        return '';
    }

    // Sort models by ID and stringify for consistent hash
    const sortedModels = Object.keys(pricing.models)
        .sort()
        .reduce((acc, key) => {
            acc[key] = pricing.models[key];
            return acc;
        }, {});

    const hashInput = JSON.stringify(sortedModels);
    return crypto.createHash('sha256').update(hashInput).digest('hex');
}

/**
 * Load pricing from config file
 * @param {string} configPath - Path to pricing config file
 * @returns {Object} Load result { loaded, pricing, source, error, hash, configPath }
 */
function loadPricing(configPath) {
    const result = {
        loaded: false,
        pricing: getDefaultPricing(),
        source: 'defaults',
        error: null,
        hash: null,
        configPath
    };

    if (!configPath) {
        result.error = 'No config path provided';
        result.hash = computePricingHash(result.pricing);
        return result;
    }

    let fullPath = configPath;
    if (!path.isAbsolute(configPath)) {
        fullPath = path.join(process.cwd(), configPath);
    }

    try {
        if (!fs.existsSync(fullPath)) {
            result.error = `Config file not found: ${fullPath}`;
            result.hash = computePricingHash(result.pricing);
            return result;
        }

        const content = fs.readFileSync(fullPath, 'utf8');
        const parsed = JSON.parse(content);

        const validation = validatePricing(parsed);
        if (!validation.valid) {
            result.error = `Validation failed: ${validation.errors.join(', ')}`;
            result.hash = computePricingHash(result.pricing);
            return result;
        }

        result.pricing = parsed;
        result.loaded = true;
        result.source = 'file';
        result.hash = computePricingHash(parsed);

    } catch (err) {
        if (err instanceof SyntaxError) {
            result.error = `Failed to parse JSON: ${err.message}`;
        } else {
            result.error = `Failed to load pricing: ${err.message}`;
        }
        result.hash = computePricingHash(result.pricing);
    }

    return result;
}

module.exports = {
    DEFAULT_PRICING_SOURCE_URL,
    DEFAULT_PRICING,
    getDefaultPricing,
    validatePricing,
    computePricingHash,
    loadPricing
};
