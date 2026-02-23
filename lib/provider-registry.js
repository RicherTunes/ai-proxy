/**
 * Provider Registry Module
 *
 * Manages multi-provider configuration for the proxy.
 * Each provider defines target URL, auth scheme, and transformation rules.
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
  requestTransform: null,
  responseTransform: null,
  extraHeaders: {},
  costTier: 'free'
};

class ProviderRegistry {
  /**
   * @param {Object} [providersConfig] - Provider configuration map
   * @param {string} [defaultProviderName] - Name of the default provider
   */
  constructor(providersConfig, defaultProviderName) {
    this.providers = new Map();
    this.defaultProviderName = defaultProviderName || DEFAULT_PROVIDER_NAME;

    if (!providersConfig || Object.keys(providersConfig).length === 0) {
      // No providers configured — use built-in default
      this.providers.set(DEFAULT_PROVIDER_NAME, { ...DEFAULT_PROVIDER_CONFIG });
      this.defaultProviderName = DEFAULT_PROVIDER_NAME;
    } else {
      for (const [name, config] of Object.entries(providersConfig)) {
        this._validateAndAdd(name, config);
      }
      // If specified default not in config, use first provider
      if (!this.providers.has(this.defaultProviderName)) {
        this.defaultProviderName = this.providers.keys().next().value;
      }
    }
  }

  /**
   * Validate and add a provider config
   * @private
   */
  _validateAndAdd(name, config) {
    if (!config.targetHost) {
      throw new Error(`Provider '${name}' requires targetHost`);
    }
    const authScheme = config.authScheme || 'x-api-key';
    if (!VALID_AUTH_SCHEMES.includes(authScheme)) {
      throw new Error(
        `Provider '${name}' has invalid authScheme '${authScheme}'. ` +
        `Valid schemes: ${VALID_AUTH_SCHEMES.join(', ')}`
      );
    }
    const costTier = config.costTier || 'metered'; // Safe default
    if (!VALID_COST_TIERS.includes(costTier)) {
      throw new Error(
        `Provider '${name}' has invalid costTier '${costTier}'. ` +
        `Valid tiers: ${VALID_COST_TIERS.join(', ')}`
      );
    }
    this.providers.set(name, {
      targetHost: config.targetHost,
      targetBasePath: config.targetBasePath || '',
      targetProtocol: config.targetProtocol || 'https:',
      authScheme,
      requestTransform: config.requestTransform || null,
      responseTransform: config.responseTransform || null,
      extraHeaders: config.extraHeaders || {},
      costTier,
      ...(config.customAuthHeader ? { customAuthHeader: config.customAuthHeader } : {})
    });
  }

  /**
   * Get provider config by name
   * @param {string} name
   * @returns {Object|null}
   */
  getProvider(name) {
    return this.providers.get(name) || null;
  }

  /**
   * Get the default provider config
   * @returns {Object}
   */
  getDefaultProvider() {
    return this.providers.get(this.defaultProviderName);
  }

  /**
   * Get the default provider name
   * @returns {string}
   */
  getDefaultProviderName() {
    return this.defaultProviderName;
  }

  /**
   * Check if a provider is configured
   * @param {string} name
   * @returns {boolean}
   */
  hasProvider(name) {
    return this.providers.has(name);
  }

  /**
   * List all configured provider names
   * @returns {string[]}
   */
  listProviders() {
    return Array.from(this.providers.keys());
  }

  /**
   * Resolve the provider for a given model using the model mapping config.
   *
   * Model mapping entries can be:
   * - String: "glm-4.7" → uses default provider
   * - Object: { target: "glm-4.7", provider: "z.ai" } → uses specified provider
   *
   * Returns null if the model's provider is not configured (GUARD-02 safety).
   *
   * @param {string} model - The incoming model name
   * @param {Object} modelMapping - The modelMapping.models config object
   * @returns {{ providerName: string, targetModel: string } | null}
   */
  resolveProviderForModel(model, modelMapping) {
    if (!modelMapping || !modelMapping[model]) {
      // No mapping found — use default provider, pass model through
      return {
        providerName: this.defaultProviderName,
        targetModel: model
      };
    }

    const entry = modelMapping[model];

    // String entry: default provider
    if (typeof entry === 'string') {
      return {
        providerName: this.defaultProviderName,
        targetModel: entry
      };
    }

    // Object entry with explicit provider
    if (typeof entry === 'object' && entry.target) {
      const providerName = entry.provider || this.defaultProviderName;

      // GUARD-02: Reject if provider is not configured
      if (!this.hasProvider(providerName)) {
        return null;
      }

      return {
        providerName,
        targetModel: entry.target
      };
    }

    // Unrecognized format — use default
    return {
      providerName: this.defaultProviderName,
      targetModel: model
    };
  }

  /**
   * Format auth header for a provider.
   *
   * @param {string} providerName
   * @param {string} apiKey
   * @returns {{ headerName: string, headerValue: string } | null}
   */
  formatAuthHeader(providerName, apiKey) {
    const provider = this.getProvider(providerName);
    if (!provider) return null;

    switch (provider.authScheme) {
      case 'x-api-key':
        return { headerName: 'x-api-key', headerValue: apiKey };
      case 'bearer':
        return { headerName: 'authorization', headerValue: `Bearer ${apiKey}` };
      case 'custom':
        if (provider.customAuthHeader) {
          return {
            headerName: provider.customAuthHeader,
            headerValue: apiKey
          };
        }
        return { headerName: 'x-api-key', headerValue: apiKey };
      default:
        return null;
    }
  }
}

module.exports = { ProviderRegistry, DEFAULT_PROVIDER_NAME, DEFAULT_PROVIDER_CONFIG };
