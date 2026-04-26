'use strict';
/**
 * Model Discovery Module
 * Provides centralized model information with caching and tier-based organization.
 * Supports runtime model probing to discover new z.ai models without restart.
 */

const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const https = require('https');
const http = require('http');
const { EventEmitter } = require('events');
const { atomicWrite } = require('./atomic-write');

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
    // NOTE: Pricing sourced from z.ai docs as of 2026-03 — confirm on rate changes.
    pricing: { input: 0.60, output: 2.20, cachedInput: 0.11 },
    maxConcurrency: 2,     // Updated 2026-03-31 per https://z.ai/manage-apikey/rate-limits
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

// Maximum plausible concurrency value.  z.ai models have concurrent-request
// limits in the 1-20 range (hard wall ~15-17).  The x-ratelimit-limit header
// often carries RPM (requests-per-minute), which can be hundreds.  Any header
// value above this cap is almost certainly RPM, not concurrency.
const MAX_SANE_CONCURRENCY = 50;

// Candidate model IDs to probe for new releases (z.ai naming conventions)
// These are speculative — the probe will confirm which actually exist.
const CANDIDATE_MODEL_PATTERNS = [
  // GLM-5 variants (new generation)
  'glm-5-turbo', 'glm-5-flash', 'glm-5-air', 'glm-5v',
  // GLM-4.8 (future)
  'glm-4.8', 'glm-4.8-flash', 'glm-4.8-air',
  // GLM-4.7 variants not yet in registry
  'glm-4.7-air', 'glm-4.7-turbo',
  // GLM-4.6 variants
  'glm-4.6-flash', 'glm-4.6-air', 'glm-4.6-turbo',
];

/**
 * Infer model metadata from model ID naming patterns.
 * Used for newly discovered models that aren't in KNOWN_GLM_MODELS.
 * @param {string} modelId
 * @returns {Object} Inferred metadata
 */
function inferModelMetadata(modelId) {
  const now = new Date().toISOString();
  const meta = {
    id: modelId,
    tier: 'MEDIUM',
    displayName: modelId,
    description: 'Discovered via probe',
    contextLength: 128000,
    supportsStreaming: true,
    supportsVision: false,
    pricing: null,
    maxConcurrency: 1,     // Conservative default for unknown models; updated by RateLimitSync headers
    availability: 'coding_subscription',
    type: 'chat',
    source: 'probed',
    lastRefreshedAt: now,
    discoveredAt: now
  };

  // Parse display name: glm-5-turbo -> GLM 5 Turbo
  meta.displayName = modelId
    .replace(/^glm-/, 'GLM ')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/^Glm /, 'GLM ');

  // Infer tier and type from suffix
  const lower = modelId.toLowerCase();
  if (lower.endsWith('-flash') || lower.endsWith('-flashx')) {
    meta.tier = 'LIGHT';
    meta.pricing = { input: 0, output: 0, cachedInput: 0 };
    meta.description = 'Lightweight model (discovered via probe)';
  } else if (lower.endsWith('-air') || lower.endsWith('-airx')) {
    meta.tier = 'MEDIUM';
    meta.pricing = { input: 0.20, output: 1.10, cachedInput: 0.03 };
    meta.description = 'Balanced model (discovered via probe)';
  } else if (lower.endsWith('-turbo') || lower.endsWith('-x')) {
    meta.tier = 'HEAVY';
    meta.pricing = { input: 0.60, output: 2.20, cachedInput: 0.11 };
    meta.description = 'High-performance model (discovered via probe)';
  } else if (lower.endsWith('v')) {
    meta.type = 'vision';
    meta.supportsVision = true;
    meta.supportsStreaming = false;
    meta.description = 'Vision model (discovered via probe)';
  }

  // Infer version for context length
  if (lower.includes('glm-5') || lower.includes('glm-4.7') || lower.includes('glm-4.8')) {
    meta.contextLength = 200000;
  }

  return meta;
}

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

class ModelDiscovery extends EventEmitter {
  constructor(config = {}) {
    super();
    this.setMaxListeners(200);
    this.cache = new Map();
    this.cacheTTL = config.cacheTTL || DEFAULT_CACHE_TTL;
    this.configPath = config.configPath || path.join(process.cwd(), '.omc-config.json');
    this.customModels = [];
    this._metadataOverrides = new Map();

    // Probing infrastructure
    this._discoveredModels = new Map();
    this._probeState = { lastProbeAt: null, inProgress: false, lastResult: null };
    this._userCandidates = [];
    this._configDir = config.configDir || process.cwd();
    this._probeConfig = {
      delayMs: config.probeDelayMs || 200,
      timeoutMs: config.probeTimeoutMs || 10000
    };
    this._persistFile = config.persistFile || 'model-discovery-cache.json';
    this.logger = config.logger || null;

    // Load cached discoveries from disk (sync, no API calls)
    this._loadDiscoveryCache();
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
    const knownIds = new Set(KNOWN_GLM_MODELS.map(m => m.id));
    const customIds = new Set(this.customModels.map(m => m.id));

    // Merge: known + custom + discovered (deduplicated)
    const discoveredArr = [...this._discoveredModels.values()]
      .filter(m => !knownIds.has(m.id) && !customIds.has(m.id));
    let allModels = [...KNOWN_GLM_MODELS, ...this.customModels, ...discoveredArr];

    // Apply metadata overrides (from RateLimitSync live observations)
    if (this._metadataOverrides.size > 0) {
      allModels = allModels.map(m => {
        const overrides = this._metadataOverrides.get(m.id);
        return overrides ? { ...m, ...overrides } : m;
      });
    }

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
   * Update metadata for a known model (used by RateLimitSync to reflect live limits).
   * Overrides are applied on top of KNOWN_GLM_MODELS in getModels().
   * @param {string} modelId - The model identifier
   * @param {Object} overrides - Fields to override (e.g., { maxConcurrency, source, lastRefreshedAt })
   */
  updateModelMetadata(modelId, overrides) {
    if (!modelId || !overrides || typeof overrides !== 'object') return;
    const existing = this._metadataOverrides.get(modelId) || {};
    this._metadataOverrides.set(modelId, { ...existing, ...overrides });
    // Invalidate cache so next getModels() picks up the override
    this.cache.delete('all_models');
  }

  /**
   * Get current metadata overrides (for observability/debugging).
   * @returns {Object} Map of modelId -> override fields
   */
  getMetadataOverrides() {
    return Object.fromEntries(this._metadataOverrides);
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

  // ==================== Model Probing ====================

  /**
   * Get current probe state (for observability / GET /models/refresh).
   * @returns {Object}
   */
  getProbeState() {
    return {
      ...this._probeState,
      discoveredCount: this._discoveredModels.size,
      userCandidates: [...this._userCandidates],
      candidatePatterns: CANDIDATE_MODEL_PATTERNS.length
    };
  }

  /**
   * Add a user-defined candidate model ID to probe in future refreshes.
   * @param {string} modelId
   */
  addUserCandidate(modelId) {
    if (!modelId || typeof modelId !== 'string') return;
    const id = modelId.trim().toLowerCase();
    if (id && !this._userCandidates.includes(id)) {
      this._userCandidates.push(id);
      this._saveDiscoveryCache().catch(() => {});
    }
  }

  /**
   * Probe z.ai to discover and verify models.
   * Sends minimal max_tokens=1 requests to check model existence.
   *
   * @param {Object} options
   * @param {string} options.apiKey - z.ai API key
   * @param {string} options.targetHost - e.g. 'api.z.ai'
   * @param {string} options.targetBasePath - e.g. '/api/anthropic'
   * @param {string} [options.targetProtocol='https:'] - Protocol
   * @param {boolean} [options.probeKnown=true] - Probe known models
   * @param {boolean} [options.probeCandidates=true] - Probe candidate patterns
   * @param {string[]} [options.userCandidates=[]] - One-off model IDs to probe
   * @returns {Promise<Object>} Probe result summary
   */
  async probeModels(options = {}) {
    if (this._probeState.inProgress) {
      return { error: 'probe_already_running' };
    }

    const {
      apiKey,
      targetHost = 'api.z.ai',
      targetBasePath = '/api/anthropic',
      targetProtocol = 'https:',
      probeKnown = true,
      probeCandidates = true,
      userCandidates = []
    } = options;

    if (!apiKey) {
      return { error: 'no_api_key', message: 'An API key is required for probing' };
    }

    this._probeState.inProgress = true;
    const startTime = Date.now();
    const knownIds = new Set(KNOWN_GLM_MODELS.map(m => m.id));

    // Build probe list
    const probeList = [];
    if (probeKnown) {
      for (const m of KNOWN_GLM_MODELS) {
        // Only probe chat models (skip tool/image types)
        if (m.type === 'chat' || m.type === 'vision') {
          probeList.push({ modelId: m.id, isKnown: true });
        }
      }
    }
    if (probeCandidates) {
      for (const id of CANDIDATE_MODEL_PATTERNS) {
        if (!knownIds.has(id)) {
          probeList.push({ modelId: id, isKnown: false });
        }
      }
    }
    // User-submitted candidates (one-off + persisted)
    const allUserCandidates = [...new Set([...userCandidates, ...this._userCandidates])];
    for (const id of allUserCandidates) {
      const normalized = id.trim().toLowerCase();
      if (normalized && !knownIds.has(normalized) && !probeList.some(p => p.modelId === normalized)) {
        probeList.push({ modelId: normalized, isKnown: false });
        // Persist new user candidates
        if (!this._userCandidates.includes(normalized)) {
          this._userCandidates.push(normalized);
        }
      }
    }

    const results = { verified: [], discovered: [], unavailable: [], invalid: [], errors: [] };
    const knownModelStatus = {};

    this.emit('probe-status', {
      status: 'started',
      total: probeList.length,
      progress: 0,
      timestamp: Date.now()
    });

    // Probe each model with serialization delay
    for (let i = 0; i < probeList.length; i++) {
      const { modelId, isKnown } = probeList[i];
      try {
        const result = await this._probeModel(modelId, apiKey, targetHost, targetBasePath, targetProtocol);

        if (result.availability === 'coding_subscription' || result.availability === 'api_only') {
          if (isKnown) {
            results.verified.push(modelId);
            knownModelStatus[modelId] = {
              availability: result.availability,
              lastVerifiedAt: new Date().toISOString()
            };
          } else {
            // New model discovered!
            results.discovered.push(modelId);
            const meta = inferModelMetadata(modelId);
            meta.availability = result.availability;
            // Use concurrency from probe response header if available
            // (clamp to MAX_SANE_CONCURRENCY — the header often carries RPM, not concurrency)
            if (result.rateLimitConcurrency > 0 && result.rateLimitConcurrency <= MAX_SANE_CONCURRENCY) {
              meta.maxConcurrency = result.rateLimitConcurrency;
            }
            this._discoveredModels.set(modelId, meta);
          }
        } else if (result.availability === 'invalid') {
          results.invalid.push(modelId);
        } else {
          results.unavailable.push(modelId);
        }

        // Update known model availability if it changed
        if (isKnown) {
          const knownModel = KNOWN_GLM_MODELS.find(m => m.id === modelId);
          if (knownModel && knownModel.availability !== result.availability) {
            this.updateModelMetadata(modelId, {
              availability: result.availability,
              source: 'probed',
              lastRefreshedAt: new Date().toISOString()
            });
          }
        }
      } catch (err) {
        results.errors.push({ modelId, error: err.message });
        this.logger?.warn?.(`Probe failed for ${modelId}: ${err.message}`);
      }

      this.emit('probe-status', {
        status: 'probing',
        total: probeList.length,
        progress: i + 1,
        currentModel: modelId,
        timestamp: Date.now()
      });

      // Delay between probes to avoid rate limiting
      if (i < probeList.length - 1) {
        await new Promise(r => setTimeout(r, this._probeConfig.delayMs));
      }
    }

    const duration = Date.now() - startTime;
    const modelCountAfter = KNOWN_GLM_MODELS.length + this._discoveredModels.size;

    this._probeState = {
      lastProbeAt: new Date().toISOString(),
      inProgress: false,
      lastResult: {
        ...results,
        duration,
        probeCount: probeList.length,
        knownModelStatus
      }
    };

    // Invalidate cache so getModels() picks up new discoveries
    this.cache.delete('all_models');

    // Persist to disk
    await this._saveDiscoveryCache().catch(err => {
      this.logger?.warn?.(`Failed to save discovery cache: ${err.message}`);
    });

    this.emit('probe-status', {
      status: 'completed',
      total: probeList.length,
      progress: probeList.length,
      verified: results.verified.length,
      discovered: results.discovered.length,
      duration,
      timestamp: Date.now()
    });

    return {
      success: true,
      duration,
      results,
      modelCount: {
        before: KNOWN_GLM_MODELS.length,
        after: modelCountAfter
      },
      lastProbeAt: this._probeState.lastProbeAt
    };
  }

  /**
   * Probe a single model by sending a minimal chat request.
   * @param {string} modelId
   * @param {string} apiKey
   * @param {string} targetHost
   * @param {string} targetBasePath
   * @param {string} targetProtocol
   * @returns {Promise<{modelId: string, availability: string, responseTimeMs: number}>}
   */
  _probeModel(modelId, apiKey, targetHost, targetBasePath, targetProtocol) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const body = JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: false
      });

      const isHttps = targetProtocol === 'https:';
      const transport = isHttps ? https : http;

      const reqOptions = {
        hostname: targetHost,
        port: isHttps ? 443 : 80,
        path: `${targetBasePath}/v1/messages`,
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'content-length': Buffer.byteLength(body)
        },
        timeout: this._probeConfig.timeoutMs
      };

      const req = transport.request(reqOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const responseTimeMs = Date.now() - startTime;

          // Capture rate limit concurrency from response header (if present)
          const rlHeader = res.headers['x-ratelimit-limit'] || res.headers['x-ratelimit-limit-requests'];
          const rateLimitConcurrency = rlHeader ? parseInt(rlHeader, 10) : 0;

          const base = { modelId, responseTimeMs, rateLimitConcurrency: rateLimitConcurrency || 0 };

          try {
            const json = JSON.parse(data);

            // z.ai wraps errors in JSON body with code field
            if (json.error && json.error.type) {
              // Standard Anthropic error format
              if (data.includes('1211') || (json.error.message && json.error.message.includes('Unknown Model'))) {
                return resolve({ ...base, availability: 'invalid' });
              }
              if (data.includes('1113')) {
                return resolve({ ...base, availability: 'api_only' });
              }
              // Other error (auth, rate limit, etc.)
              return resolve({ ...base, availability: 'error', error: json.error.message });
            }

            // z.ai native error format (code in top-level response)
            if (json.code === 1211) {
              return resolve({ ...base, availability: 'invalid' });
            }
            if (json.code === 1113) {
              return resolve({ ...base, availability: 'api_only' });
            }
            if (json.code && json.code !== 200 && json.code !== 0) {
              return resolve({ ...base, availability: 'error', error: json.msg || `code ${json.code}` });
            }

            // Success — model exists and is accessible
            resolve({ ...base, availability: 'coding_subscription' });
          } catch {
            // Non-JSON response
            if (res.statusCode === 200) {
              resolve({ ...base, availability: 'coding_subscription' });
            } else if (res.statusCode === 404) {
              resolve({ ...base, availability: 'invalid' });
            } else {
              resolve({ ...base, availability: 'error', error: `HTTP ${res.statusCode}` });
            }
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Probe timeout for ${modelId} (${this._probeConfig.timeoutMs}ms)`));
      });

      req.on('error', (err) => {
        reject(new Error(`Probe network error for ${modelId}: ${err.message}`));
      });

      req.write(body);
      req.end();
    });
  }

  // ==================== Persistence ====================

  /**
   * Load discovery cache from disk (sync, called in constructor).
   * Populates _discoveredModels and _userCandidates.
   */
  _loadDiscoveryCache() {
    try {
      const filePath = path.join(this._configDir, this._persistFile);
      const data = fsSync.readFileSync(filePath, 'utf-8');
      const cache = JSON.parse(data);

      if (cache.version !== 1) return;

      // Load discovered models
      if (cache.discoveredModels && typeof cache.discoveredModels === 'object') {
        for (const [id, meta] of Object.entries(cache.discoveredModels)) {
          this._discoveredModels.set(id, meta);
        }
      }

      // Load user candidates
      if (Array.isArray(cache.userCandidates)) {
        this._userCandidates = cache.userCandidates;
      }

      // Restore metadata overrides (live concurrency adjustments, availability changes, etc.)
      if (cache.metadataOverrides && typeof cache.metadataOverrides === 'object') {
        for (const [id, overrides] of Object.entries(cache.metadataOverrides)) {
          if (overrides && typeof overrides === 'object') {
            // Sanitize: clamp or strip maxConcurrency above the sanity cap
            // (guards against poisoned caches from the RPM-as-concurrency bug)
            if (overrides.maxConcurrency > MAX_SANE_CONCURRENCY) {
              delete overrides.maxConcurrency;
            }
            this._metadataOverrides.set(id, overrides);
          }
        }
      }

      // Restore last probe state
      if (cache.lastProbeAt) {
        this._probeState.lastProbeAt = cache.lastProbeAt;
      }
      if (cache.lastResult) {
        this._probeState.lastResult = cache.lastResult;
      }
    } catch {
      // File doesn't exist or is invalid — start fresh
    }
  }

  /**
   * Save discovery cache to disk (async, fire-and-forget safe).
   */
  async _saveDiscoveryCache() {
    const filePath = path.join(this._configDir, this._persistFile);
    const data = {
      version: 1,
      savedAt: Date.now(),
      lastProbeAt: this._probeState.lastProbeAt,
      lastResult: this._probeState.lastResult,
      discoveredModels: Object.fromEntries(this._discoveredModels),
      userCandidates: this._userCandidates,
      metadataOverrides: Object.fromEntries(this._metadataOverrides)
    };
    await atomicWrite(filePath, JSON.stringify(data, null, 2));
  }
}

module.exports = {
  ModelDiscovery,
  KNOWN_GLM_MODELS,
  CANDIDATE_MODEL_PATTERNS,
  CLAUDE_MODEL_ALIASES,
  MAX_SANE_CONCURRENCY,
  resolveModelAlias,
  inferModelMetadata
};
