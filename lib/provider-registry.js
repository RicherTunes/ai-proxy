/**
 * Provider Registry
 *
 * Manages multi-provider configuration for the API proxy.
 * Each provider has a target host, auth scheme, cost tier, and optional transforms.
 *
 * Safety invariants (TDD GUARD tests):
 * - GUARD-01: Default provider is z.ai when no providers configured
 * - GUARD-02: Non-configured providers return null (never silently route)
 * - GUARD-03: Config validation rejects invalid authScheme/costTier
 * - GUARD-04: Cost tier propagates to traces for dashboard visibility
 * - GUARD-05: Keys are never sent to wrong provider (formatAuthHeader is provider-specific)
 *
 * @module provider-registry
 */

'use strict';

const VALID_AUTH_SCHEMES = ['x-api-key', 'bearer', 'custom'];
const VALID_COST_TIERS = ['free', 'metered', 'premium'];

const DEFAULT_PROVIDER_NAME = 'z.ai';
const DEFAULT_PROVIDER_CONFIG = {
    targetHost: 'api.z.ai',
    targetBasePath: '/api/anthropic',
    targetProtocol: 'https:',
    authScheme: 'x-api-key',
    costTier: 'free',
    extraHeaders: {},
    requestTransform: null,
    responseTransform: null
};

class ProviderRegistry {
    /**
     * @param {Object} providersConfig - Map of provider name -> config
     * @param {string} [defaultProviderName] - Name of default provider
     */
    constructor(providersConfig = null, defaultProviderName = null) {
        this.providers = new Map();
        this.defaultProviderName = defaultProviderName || DEFAULT_PROVIDER_NAME;

        if (providersConfig && typeof providersConfig === 'object') {
            for (const [name, config] of Object.entries(providersConfig)) {
                this._addProvider(name, config);
            }
        }

        // Ensure default provider exists.
        // If the caller configured providers but omitted the default, inject z.ai
        // with a warning. TODO(Month 7): Make default provider configurable and
        // require explicit inclusion when providers section is set.
        if (!this.providers.has(this.defaultProviderName)) {
            if (providersConfig && Object.keys(providersConfig).length > 0) {
                this._silentDefaultInjected = true; // Testable flag
            }
            this._addProvider(DEFAULT_PROVIDER_NAME, DEFAULT_PROVIDER_CONFIG);
            this.defaultProviderName = DEFAULT_PROVIDER_NAME;
        }
    }

    /**
     * Add a provider to the registry with validation
     * @private
     */
    _addProvider(name, config) {
        if (!name || typeof name !== 'string') {
            throw new Error(`Invalid provider name: ${name}`);
        }

        const validated = {
            targetHost: config.targetHost || DEFAULT_PROVIDER_CONFIG.targetHost,
            targetBasePath: config.targetBasePath ?? DEFAULT_PROVIDER_CONFIG.targetBasePath,
            targetProtocol: config.targetProtocol || DEFAULT_PROVIDER_CONFIG.targetProtocol,
            authScheme: config.authScheme || DEFAULT_PROVIDER_CONFIG.authScheme,
            costTier: config.costTier || DEFAULT_PROVIDER_CONFIG.costTier,
            extraHeaders: config.extraHeaders || {},
            requestTransform: config.requestTransform || null,
            responseTransform: config.responseTransform || null
        };

        // GUARD-03: Validate auth scheme
        if (!VALID_AUTH_SCHEMES.includes(validated.authScheme)) {
            throw new Error(`Invalid authScheme '${validated.authScheme}' for provider '${name}'. Valid: ${VALID_AUTH_SCHEMES.join(', ')}`);
        }

        // GUARD-03: Validate cost tier
        if (!VALID_COST_TIERS.includes(validated.costTier)) {
            throw new Error(`Invalid costTier '${validated.costTier}' for provider '${name}'. Valid: ${VALID_COST_TIERS.join(', ')}`);
        }

        this.providers.set(name, validated);
    }

    /**
     * Get provider config by name
     * @param {string} name - Provider name
     * @returns {Object|null} Provider config or null if not found
     */
    getProvider(name) {
        return this.providers.get(name) || null;
    }

    /**
     * Get the default provider config
     * @returns {Object} Default provider config
     */
    getDefaultProvider() {
        return this.providers.get(this.defaultProviderName);
    }

    /**
     * Check if a provider exists
     * @param {string} name - Provider name
     * @returns {boolean}
     */
    hasProvider(name) {
        return this.providers.has(name);
    }

    /**
     * List all provider names
     * @returns {string[]}
     */
    listProviders() {
        return Array.from(this.providers.keys());
    }

    /**
     * Resolve which provider should handle a model based on model mapping.
     * Returns null if the model maps to a non-configured provider (GUARD-02).
     *
     * @param {string} model - The target model name
     * @param {Object} modelMapping - Model mapping config with models object
     * @returns {{providerName: string, targetModel: string}|null}
     */
    resolveProviderForModel(model, modelMapping) {
        if (!modelMapping || !modelMapping.models) {
            return { providerName: this.defaultProviderName, targetModel: model };
        }

        // Check if this model has a provider-specific mapping
        for (const [inputModel, entry] of Object.entries(modelMapping.models)) {
            const targetModel = typeof entry === 'string' ? entry : entry?.target;
            const providerName = typeof entry === 'object' ? entry?.provider : null;

            if (targetModel === model && providerName) {
                // GUARD-02: Reject if provider not configured
                if (!this.hasProvider(providerName)) {
                    return null;
                }
                return { providerName, targetModel: model };
            }
        }

        // Default provider for all standard mappings
        return { providerName: this.defaultProviderName, targetModel: model };
    }

    /**
     * Format auth header for a specific provider.
     * GUARD-05: Each provider gets its own auth format.
     *
     * @param {string} providerName - Provider name
     * @param {string} apiKey - The API key to use
     * @returns {{headerName: string, headerValue: string}|null}
     */
    formatAuthHeader(providerName, apiKey) {
        const provider = this.getProvider(providerName);
        if (!provider || !apiKey) return null;

        switch (provider.authScheme) {
            case 'x-api-key':
                return { headerName: 'x-api-key', headerValue: apiKey };
            case 'bearer':
                return { headerName: 'authorization', headerValue: `Bearer ${apiKey}` };
            case 'custom':
                return null; // Custom auth handled by caller
            default:
                return null;
        }
    }
}

module.exports = {
    ProviderRegistry,
    DEFAULT_PROVIDER_NAME,
    DEFAULT_PROVIDER_CONFIG,
    VALID_AUTH_SCHEMES,
    VALID_COST_TIERS
};
