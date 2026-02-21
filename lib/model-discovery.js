/**
 * Model Discovery Module
 * Provides centralized model information with caching and tier-based organization
 */

const path = require('path');
const fs = require('fs').promises;

// Known GLM models with metadata
// Source: https://z.ai/model-api and https://docs.z.ai/guides/overview/pricing
//
// availability: Which subscription plans can access this model
//   'coding_subscription' - Available on Z.AI Coding Plan subscription
//   'api_only'            - Requires separate API resource package (error 1113 on Coding Plan)
//   'invalid'             - Model ID does not exist in Z.AI API (error 1211)
//
// maxConcurrency: Per-account concurrent request limit (NOT per-key).
//   Stress-tested 2026-02-17. See docs/model-concurrency-findings.md for details.
//   Z.AI uses soft limits: sporadic 429s start ~10 concurrent, hard wall ~15-17.
const KNOWN_GLM_MODELS = [
  // ===== FLAGSHIP MODELS =====
  {
    id: 'glm-5',
    tier: 'HEAVY',
    displayName: 'GLM 5',
    description: 'Top-tier heavy model (limited concurrency), 200K context',
    contextLength: 200000,
    supportsStreaming: true,
    supportsVision: false,
    // TODO: Verify official pricing for GLM-5 from z.ai pricing docs.
    pricing: { input: 0.60, output: 2.20, cachedInput: 0.11 },
    maxConcurrency: 1,     // Not stress-tested at high levels yet
    availability: 'coding_subscription',
    type: 'chat',
    source: 'static',
    lastRefreshedAt: null
  },
  {
    id: 'glm-4.7',
    tier: 'HEAVY',
    displayName: 'GLM 4.7',
    description: 'Latest flagship model with maximum capability, 200K context',
    contextLength: 200000,
    supportsStreaming: true,
    supportsVision: false,
    pricing: { input: 0.60, output: 2.20, cachedInput: 0.11 },
    maxConcurrency: 10,    // Stress-tested: clean up to 9, soft limit at 10, burst to 15
    availability: 'coding_subscription',
    type: 'chat',
    source: 'static',
    lastRefreshedAt: null
  },
  {
    id: 'glm-4.6',
    tier: 'HEAVY',
    displayName: 'GLM 4.6',
    description: 'Advanced reasoning model, 200K context (vision via glm-4.6v)',
    contextLength: 200000,
    supportsStreaming: true,
    supportsVision: false,
    pricing: { input: 0.60, output: 2.20, cachedInput: 0.11 },
    maxConcurrency: 8,     // Stress-tested: clean up to 8 (higher not tested)
    availability: 'coding_subscription',
    type: 'chat',
    source: 'static',
    lastRefreshedAt: null
  },

  // ===== HIGH PERFORMANCE MODELS =====
  {
    id: 'glm-4.5-x',
    tier: 'HEAVY',
    displayName: 'GLM 4.5 X',
    description: 'Higher capability version — requires separate API resource package',
    contextLength: 128000,
    supportsStreaming: true,
    supportsVision: false,
    pricing: { input: 2.20, output: 8.90, cachedInput: 0.45 },
    maxConcurrency: 2,
    availability: 'api_only',  // Error 1113 on Coding Plan
    type: 'chat',
    source: 'static',
    lastRefreshedAt: null
  },

  // ===== BALANCED MODELS =====
  {
    id: 'glm-4.5',
    tier: 'MEDIUM',
    displayName: 'GLM 4.5',
    description: 'Standard model for general tasks',
    contextLength: 128000,
    supportsStreaming: true,
    supportsVision: true,
    pricing: { input: 0.60, output: 2.20, cachedInput: 0.11 },
    maxConcurrency: 10,    // Stress-tested: clean up to 8, keeping 10 as conservative estimate
    availability: 'coding_subscription',
    type: 'chat',
    source: 'static',
    lastRefreshedAt: null
  },
  {
    id: 'glm-4.5-air',
    tier: 'MEDIUM',
    displayName: 'GLM 4.5 Air',
    description: 'Lightweight, cost-effective, high concurrency',
    contextLength: 128000,
    supportsStreaming: true,
    supportsVision: false,
    pricing: { input: 0.20, output: 1.10, cachedInput: 0.03 },
    maxConcurrency: 10,    // Stress-tested: clean up to 9, soft limit at 10, burst to 15
    availability: 'coding_subscription',
    type: 'chat',
    source: 'static',
    lastRefreshedAt: null
  },
  {
    id: 'glm-4.5-airx',
    tier: 'MEDIUM',
    displayName: 'GLM 4.5 AirX',
    description: 'Extended Air model — requires separate API resource package',
    contextLength: 128000,
    supportsStreaming: true,
    supportsVision: false,
    pricing: { input: 0.20, output: 1.10, cachedInput: 0.03 },
    maxConcurrency: 2,
    availability: 'api_only',  // Error 1113 on Coding Plan
    type: 'chat',
    source: 'static',
    lastRefreshedAt: null
  },

  // ===== LIGHTWEIGHT / HIGH EFFICIENCY MODELS =====
  {
    id: 'glm-4.7-flashx',
    tier: 'LIGHT',
    displayName: 'GLM 4.7 FlashX',
    description: 'Ultra-lightweight, 30B params, 200K context — requires separate API resource package',
    contextLength: 200000,
    supportsStreaming: true,
    supportsVision: false,
    pricing: { input: 0.07, output: 0.40, cachedInput: 0.01 },
    maxConcurrency: 3,
    availability: 'api_only',  // Error 1113 on Coding Plan
    type: 'chat',
    source: 'static',
    lastRefreshedAt: null
  },
  {
    id: 'glm-4.7-flash',
    tier: 'LIGHT',
    displayName: 'GLM 4.7 Flash',
    description: 'FREE model - no cost for input/output, 200K context',
    contextLength: 200000,
    supportsStreaming: true,
    supportsVision: false,
    pricing: { input: 0, output: 0, cachedInput: 0 },
    maxConcurrency: 1,     // Free model, not stress-tested at high levels
    availability: 'coding_subscription',
    type: 'chat',
    source: 'static',
    lastRefreshedAt: null
  },
  {
    id: 'glm-4.5-flash',
    tier: 'LIGHT',
    displayName: 'GLM 4.5 Flash',
    description: 'FREE model - no cost for input/output',
    contextLength: 128000,
    supportsStreaming: true,
    supportsVision: false,
    pricing: { input: 0, output: 0, cachedInput: 0 },
    maxConcurrency: 2,     // Free model, not stress-tested at high levels
    availability: 'coding_subscription',
    type: 'chat',
    source: 'static',
    lastRefreshedAt: null
  },
  {
    id: 'glm-4.32b-0414-128k',
    tier: 'LIGHT',
    displayName: 'GLM-4 32B',
    description: 'Model ID not recognized by Z.AI API (error 1211)',
    contextLength: 128000,
    supportsStreaming: true,
    supportsVision: false,
    pricing: { input: 0.10, output: 0.10, cachedInput: 0.01 },
    maxConcurrency: 5,
    availability: 'invalid',   // Error 1211: Unknown Model
    type: 'chat',
    source: 'static',
    lastRefreshedAt: null
  },
  {
    id: 'glm-4-plus',
    tier: 'LIGHT',
    displayName: 'GLM 4 Plus',
    description: 'General purpose model — requires separate API resource package',
    contextLength: 128000,
    supportsStreaming: true,
    supportsVision: false,
    pricing: { input: 0.05, output: 0.05, cachedInput: 0.01 },
    maxConcurrency: 1,
    availability: 'api_only',  // Error 1113 on Coding Plan
    type: 'chat',
    source: 'static',
    lastRefreshedAt: null
  },

  // ===== VISION MODELS =====
  {
    id: 'glm-4.6v',
    tier: 'HEAVY',
    displayName: 'GLM 4.6V',
    description: 'Vision model with image understanding',
    contextLength: 128000,
    supportsStreaming: false,
    supportsVision: true,
    maxConcurrency: 10,
    availability: 'coding_subscription',
    type: 'vision',
    source: 'static',
    lastRefreshedAt: null
  },
  {
    id: 'glm-4.5v',
    tier: 'MEDIUM',
    displayName: 'GLM 4.5V',
    description: 'Vision model for image tasks, 64K context',
    contextLength: 64000,
    supportsStreaming: false,
    supportsVision: true,
    maxConcurrency: 10,
    availability: 'coding_subscription',
    type: 'vision',
    source: 'static',
    lastRefreshedAt: null
  },
  {
    id: 'glm-4.6v-flashx',
    tier: 'MEDIUM',
    displayName: 'GLM 4.6V FlashX',
    description: 'Fast vision model with 3 concurrent slots',
    contextLength: 128000,
    supportsStreaming: false,
    supportsVision: true,
    maxConcurrency: 3,
    availability: 'coding_subscription',
    type: 'vision',
    source: 'static',
    lastRefreshedAt: null
  },
  {
    id: 'glm-4.6v-flash',
    tier: 'LIGHT',
    displayName: 'GLM 4.6V Flash',
    description: 'Lightweight vision model',
    contextLength: 128000,
    supportsStreaming: false,
    supportsVision: true,
    maxConcurrency: 1,
    availability: 'coding_subscription',
    type: 'vision',
    source: 'static',
    lastRefreshedAt: null
  },

  // ===== OCR =====
  {
    id: 'glm-ocr',
    tier: 'LIGHT',
    displayName: 'GLM OCR',
    description: 'Optical character recognition',
    availability: 'coding_subscription',
    type: 'tool',
    source: 'static',
    lastRefreshedAt: null
  },

  // ===== IMAGE GENERATION =====
  {
    id: 'cogview-4',
    tier: 'MEDIUM',
    displayName: 'CogView 4',
    description: 'Image generation model',
    availability: 'coding_subscription',
    type: 'image',
    source: 'static',
    lastRefreshedAt: null
  },

  // ===== INVALID MODEL IDs (kept for reference, excluded from routing) =====
  {
    id: 'glm-flash',
    tier: 'FREE',
    displayName: 'GLM Flash (Free)',
    description: 'Model ID not recognized by Z.AI API (error 1211)',
    contextLength: 128000,
    supportsStreaming: true,
    pricing: { input: 0, output: 0, cachedInput: 0 },
    maxConcurrency: 5,
    availability: 'invalid',   // Error 1211: Unknown Model
    type: 'chat',
    source: 'static',
    lastRefreshedAt: null
  }
];

// Default cache TTL: 5 minutes
const DEFAULT_CACHE_TTL = 5 * 60 * 1000;

// Short name aliases for Claude models (for config convenience)
// Users can write "sonnet-4.5" instead of "claude-sonnet-4-5-20250929"
const CLAUDE_MODEL_ALIASES = {
  // Claude 4.5 models
  'sonnet-4.5': 'claude-sonnet-4-5-20250929',
  'opus-4.5': 'claude-opus-4-5-20250929',
  'haiku-4.5': 'claude-haiku-4-5-20250929',

  // Claude 4.6 models
  'sonnet-4.6': 'claude-sonnet-4-6-20250929',
  'opus-4.6': 'claude-opus-4-6',
  'haiku-4.6': 'claude-haiku-4-6-20250929',

  // Future GLM-5 aliases (prepare for glm-5 drop)
  'glm-5': 'glm-5',  // Will resolve to actual model when available
  'opus-5': 'claude-opus-5',  // Future-proof
  'sonnet-5': 'claude-sonnet-5',  // Future-proof
};

/**
 * Resolve a short model alias to its full canonical name
 * @param {string} modelOrAlias - Model ID or short alias
 * @returns {string} The canonical model name
 */
function resolveModelAlias(modelOrAlias) {
  // If it's already a full name or doesn't match known aliases, return as-is
  if (!modelOrAlias || modelOrAlias.startsWith('claude-') || modelOrAlias.startsWith('glm-')) {
    return modelOrAlias;
  }
  // Look up in aliases map
  return CLAUDE_MODEL_ALIASES[modelOrAlias] || modelOrAlias;
}

class ModelDiscovery {
  constructor(config = {}) {
    this.cache = new Map();
    this.cacheTTL = config.cacheTTL || DEFAULT_CACHE_TTL;
    this.configPath = config.configPath || path.join(process.cwd(), '.omc-config.json');
    this.customModels = [];
  }

  /**
   * Load custom models from configuration file
   */
  async loadCustomModels() {
    try {
      const configContent = await fs.readFile(this.configPath, 'utf-8');
      const config = JSON.parse(configContent);

      if (config.customModels && Array.isArray(config.customModels)) {
        this.customModels = config.customModels;
      }
    } catch (error) {
      // Config file not found or invalid - use empty custom models
      if (error.code !== 'ENOENT') {
        this.logger?.warn?.('Failed to load custom models config', { error: error.message });
      }
      this.customModels = [];
    }
  }

  /**
   * Get all available models (known + custom)
   * @returns {Promise<Array>} Array of model objects
   */
  async getModels() {
    const cacheKey = 'all_models';

    // Check cache
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.cacheTTL) {
        return cached.data;
      }
    }

    // Load custom models and combine with known models
    await this.loadCustomModels();
    const allModels = [...KNOWN_GLM_MODELS, ...this.customModels];

    // Cache the result
    this.cache.set(cacheKey, {
      data: allModels,
      timestamp: Date.now()
    });

    return allModels;
  }

  /**
   * Get a specific model by ID
   * @param {string} modelId - The model identifier
   * @returns {Promise<Object|null>} Model object or null if not found
   */
  async getModel(modelId) {
    const models = await this.getModels();
    return models.find(m => m.id === modelId) || null;
  }

  /**
   * Get models filtered by tier
   * @param {string} tier - Tier level (HEAVY, MEDIUM, LIGHT, FREE)
   * @returns {Promise<Array>} Array of models in the specified tier
   */
  async getModelsByTier(tier) {
    const models = await this.getModels();
    return models.filter(m => m.tier === tier);
  }

  /**
   * Export models in a format suitable for frontend consumption
   * @returns {Promise<Object>} Frontend-friendly model data
   */
  async exportForFrontend() {
    const models = await this.getModels();

    return {
      models: models.map(m => ({
        id: m.id,
        name: m.displayName || m.id,
        tier: m.tier,
        description: m.description,
        contextLength: m.contextLength,
        supportsStreaming: m.supportsStreaming,
        supportsVision: m.supportsVision || false,
        pricing: m.pricing || null,
        maxConcurrency: m.maxConcurrency || 5,
        availability: m.availability || 'coding_subscription',
        type: m.type || 'chat',
        source: m.source || 'static',
        lastRefreshedAt: m.lastRefreshedAt || null
      })),
      tiers: {
        HEAVY: models.filter(m => m.tier === 'HEAVY').map(m => m.id),
        MEDIUM: models.filter(m => m.tier === 'MEDIUM').map(m => m.id),
        LIGHT: models.filter(m => m.tier === 'LIGHT').map(m => m.id),
        FREE: models.filter(m => m.tier === 'FREE').map(m => m.id)
      },
      defaultModel: 'glm-4.6',
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Sync lookup from already-populated cache (hot path, no I/O).
   * Returns null if cache is empty or expired.
   * @param {string} modelId
   * @returns {Object|null}
   */
  getModelCached(modelId) {
    const cached = this.cache.get('all_models');
    if (!cached || (Date.now() - cached.timestamp >= this.cacheTTL)) return null;
    return cached.data.find(m => m.id === modelId) || null;
  }

  /**
   * Clear the cache
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache stats
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
      ttl: this.cacheTTL
    };
  }
}

module.exports = {
  ModelDiscovery,
  KNOWN_GLM_MODELS,
  CLAUDE_MODEL_ALIASES,
  resolveModelAlias
};
