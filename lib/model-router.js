'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./atomic-write');
const { normalizeModelRoutingConfig } = require('./model-router-normalizer');
const { DriftDetector } = require('./drift-detector');

// Bounded tier label set for Prometheus route labels (prevents cardinality explosion)
const VALID_TIER_LABELS = new Set(['light', 'medium', 'heavy']);

// GLM5-04: Bounded upgrade reason enum (prevents cardinality explosion)
const UPGRADE_REASONS = Object.freeze([
  'has_tools', 'has_vision', 'max_tokens',
  'message_count', 'system_length', 'other'
]);

// GLM5-06: Bounded fallback reason enum
const FALLBACK_REASONS = Object.freeze([
  'cooldown', 'at_capacity', 'penalized_429',
  'disabled', 'not_in_candidates', 'tier_exhausted',
  'downgrade_budget_exhausted', 'context_overflow'
]);

// TRUST-01: Decision trace type definitions for /model-routing/explain endpoint

/**
 * @typedef {Object} DecisionTrace
 * @property {string} requestId - Unique request identifier
 * @property {number} timestamp - Epoch timestamp (ms) of decision
 * @property {DecisionTraceInput} input - Request input data
 * @property {DecisionTraceClassification} classification - Classification details
 * @property {DecisionTraceModelSelection} modelSelection - Model selection details
 */

/**
 * @typedef {Object} DecisionTraceInput
 * @property {string} [model] - Requested model (from parsedBody.model)
 * @property {Array<{role: string, content: string|Array<{type: string, text?: string, image_url?: string}>}>} messages - Messages array (truncated in trace)
 * @property {number} [max_tokens] - Max tokens requested
 * @property {boolean} [stream] - Whether streaming requested
 */

/**
 * @typedef {Object} DecisionTraceClassification
 * @property {'heavy'|'medium'|'light'} tier - Assigned tier
 * @property {number} complexity - Complexity score (0-100, derived from features)
 * @property {'has_tools'|'has_vision'|'max_tokens'|'message_count'|'system_length'|'other'|null} upgradeTrigger - What triggered upgrade to heavy tier (if applicable)
 * @property {DecisionTraceThresholdComparison} thresholdComparison - Actual threshold values compared
 */

/**
 * @typedef {Object} DecisionTraceThresholdComparison
 * @property {boolean} hasTools - Whether tools present in request
 * @property {boolean} hasVision - Whether vision/images present in request
 * @property {number|null} maxTokens - Max tokens value from request
 * @property {number} messageCount - Number of messages in request
 * @property {number} systemLength - System prompt length in characters
 */

/**
 * @typedef {Object} DecisionTraceModelSelection
 * @property {'quality'|'throughput'|'balanced'|'pool'} strategy - Selection strategy used
 * @property {Array<DecisionTraceCandidate>} candidates - All candidates considered with scores
 * @property {string} selected - Selected model ID
 * @property {string} rationale - Human-readable explanation of selection
 */

/**
 * @typedef {Object} DecisionTraceCandidate
 * @property {string} modelId - Model identifier
 * @property {number} score - Selection score (0-1, higher is better)
 * @property {number} inFlight - Current in-flight requests for this model
 * @property {number} maxConcurrency - Max concurrent requests allowed
 * @property {boolean} isAvailable - Whether model is available (not cooled down)
 * @property {string} [reason] - Reason if unavailable (e.g., 'cooldown', 'at_capacity')
 */

/**
 * @typedef {Object} PoolSnapshot
 * @property {string} version - Snapshot schema version (currently "1.0")
 * @property {number} timestamp - Epoch timestamp (ms) when snapshot was captured
 * @property {Array<PoolSnapshotModel>} models - Array of model states
 */

/**
 * @typedef {Object} PoolSnapshotModel
 * @property {string} modelId - Model identifier
 * @property {'heavy'|'medium'|'light'} tier - Model tier
 * @property {number} inFlight - Current in-flight requests
 * @property {number} maxConcurrency - Max concurrent requests allowed
 * @property {boolean} isAvailable - Whether model is available (not cooled down)
 * @property {number} [cooldownUntil] - Epoch timestamp (ms) when cooldown expires
 */

/**
 * @typedef {Object} UnifiedDecisionTrace
 * @property {string} requestId - Unique request identifier for trace/logs/metrics linking
 * @property {number} timestamp - Epoch timestamp (ms) of decision
 * @property {DecisionTraceInput} input - Request input data
 * @property {DecisionTraceClassification} classification - Classification details
 * @property {DecisionTraceModelSelection} modelSelection - Model selection details
 * @property {RouterPoolState} [routerPool] - Router's view of pool (ARCH-04)
 * @property {KeyState} [key] - KeyManager's view of selected key (ARCH-04)
 */

/**
 * @typedef {Object} RouterPoolState
 * @property {string} modelId - Selected model identifier
 * @property {number} inFlight - Current in-flight requests for this model (router's view)
 * @property {number} max - Max concurrent requests allowed
 * @property {boolean} isAvailable - Whether router considers model available
 * @property {number|null} cooldownUntil - Epoch timestamp (ms) when cooldown expires, or null
 */

/**
 * @typedef {Object} KeyState
 * @property {number} index - Key index used for this request
 * @property {boolean} excluded - Whether KeyManager excluded this key
 * @property {string|null} reason - Exclusion reason if excluded, otherwise null
 * @property {string} state - Key state (available, excluded, rate_limited, etc.)
 */

/**
 * @typedef {Object} SimulationParams
 * @property {'decision'|'stateful'} mode - Simulation mode
 * @property {PoolSnapshot} [snapshot] - Required for stateful mode, rejected for decision mode
 */

/**
 * ModelRouter - Complexity-aware model routing for the GLM proxy.
 *
 * Pure logic module (no HTTP I/O).  Given an Anthropic /v1/messages body it
 * decides which GLM target model to forward the request to, based on:
 *   1. Per-request UI overrides
 *   2. Saved (persisted) overrides
 *   3. Rule-based matching (model glob, token thresholds, tool/vision flags)
 *   4. Heuristic classifier (heavy / medium / light)
 *   5. Default model fallback
 *
 * Cooldowns with exponential back-off are tracked per target model so that
 * rate-limited models can fail over to an alternate.
 */
class ModelRouter {
    /**
     * Migrate v1 config to v2 config.
     * v1: { tiers: { heavy: { targetModel: 'x', fallbackModels: [...] } } }
     * v2: { tiers: { heavy: { models: ['x', ...], strategy: 'balanced' } }, version: '2.0' }
     *
     * Delegates to normalizeModelRoutingConfig for single source of truth.
     * @private
     */
    _migrateV1ToV2(config) {
        // Delegate to the normalizer - single source of truth for migration logic
        // NORM-01: All normalization paths use the same normalizer function
        return normalizeModelRoutingConfig(config, {
            logger: this._logger
        });
    }
    /**
     * @param {Object} config - The `modelRouting` config block
     * @param {Object} [options]
     * @param {string} [options.configDir]
     * @param {Object} [options.logger]
     * @param {boolean} [options.persistEnabled=true]
     * @param {Object} options.modelDiscovery - ModelDiscovery instance for async metadata lookup (required)
     */
    constructor(config, options = {}) {
        // Track whether v1 migration occurred for legacy flag in toJSON()
        const migrationResult = this._migrateV1ToV2(config);
        this._wasMigrated = migrationResult.migrated;
        this.config = { ...migrationResult.normalizedConfig };
        this._configDir = options.configDir || null;
        this._logger = options.logger || console;
        this._persistEnabled = options.persistEnabled !== undefined ? options.persistEnabled : true;

        this._overrides = new Map();
        this._cooldowns = new Map();
        this._lastShadowDecision = null;

        // Sliding window 429 counter (separate from cooldown entries)
        // Map<model, number[]> — arrays of timestamps when 429s occurred
        this._recentPool429s = new Map();

        // Pool strategy: in-flight count per model for load distribution
        this._inFlight = new Map();

        // Per-key concurrency multiplier: maxConcurrency values from model metadata
        // are per-key limits. With N API keys, global capacity = maxConcurrency * N.
        this._concurrencyMultiplier = options.concurrencyMultiplier || 1;

        // REQUIRE ModelDiscovery instance for canonical metadata source
        if (!options.modelDiscovery) {
            throw new Error('modelDiscovery option is required');
        }
        this._modelDiscovery = options.modelDiscovery;

        this._stats = {
            byTier: { light: 0, medium: 0, heavy: 0 },
            bySource: {
                override: 0,
                'saved-override': 0,
                rule: 0,
                classifier: 0,
                default: 0,
                failover: 0,
                pool: 0
            },
            byStrategy: { quality: 0, throughput: 0, balanced: 0, pool: 0 },
            shadowDecisions: 0,
            total: 0,
            burstDampenedTotal: 0,
            tierDowngradeTotal: 0,
            tierDowngradeShadow: 0,
            tierDowngradeByRoute: {},
            tierDowngradeShadowByRoute: {},
            // GLM5-04: Upgrade reason counters
            byUpgradeReason: Object.fromEntries(UPGRADE_REASONS.map(r => [r, 0])),
            // GLM5-05: Per-model selection counters (heavy tier only)
            byModel: {},
            // GLM5-06: Fallback reason counters
            byFallbackReason: Object.fromEntries(FALLBACK_REASONS.map(r => [r, 0])),
            // GLM5-07: Staged rollout counters
            glm5EligibleTotal: 0,
            glm5PreferenceApplied: 0,
            glm5PreferenceShadow: 0,
            // TRUST-03: Trace sampling counters
            traceSampledTotal: 0,
            traceSampledIncluded: 0,
            // Context overflow counters
            contextOverflowTotal: 0,
            contextOverflowByModel: {},
            contextOverflowByTier: {},
            contextOverflowByCause: { genuine: 0, transient_unavailable: 0 },
            // Cold-start warmup: failovers during first 60s after boot are expected
            failoverWarmupTotal: 0
        };

        // Track startup time for warmup metric gating
        this._startedAt = Date.now();
        this._warmupDurationMs = options.warmupDurationMs || 60000;

        // Validate tier config on construction
        this._validateTierOverlaps();

        // ARCH-03: Drift detection between Router and KeyManager
        this._driftDetector = new DriftDetector({
            metricsRegistry: options.metricsRegistry,
            logger: this._logger
        });

        // Load persisted overrides on construction
        if (this._persistEnabled && this._configDir) {
            try {
                const filePath = path.join(
                    this._configDir,
                    this.config.overridesFile || 'model-routing-overrides.json'
                );
                const raw = fs.readFileSync(filePath, 'utf8');
                const data = JSON.parse(raw);
                for (const [k, v] of Object.entries(data)) {
                    this._overrides.set(k, v);
                }
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    this._logger?.warn('Failed to load model routing overrides', { error: err.message });
                }
            }
        }
    }

    // ---------------------------------------------------------------
    // Config validation
    // ---------------------------------------------------------------

    /**
     * Warn if the same model appears in multiple tiers (target or fallback).
     * Cross-tier overlap causes contention: heavy retries steal medium/light capacity.
     * Warning only (not hard reject) to allow intentional overlap when needed.
     */
    _validateTierOverlaps() {
        const tiers = this.config.tiers;
        if (!tiers) return;

        // Build model -> [tier/role, ...] map with role context
        // Works with both v1 (targetModel/fallbackModels) and v2 (models[]) formats
        const modelToTierRoles = new Map();
        for (const [tierName, tierConfig] of Object.entries(tiers)) {
            if (!tierConfig) continue;
            // Use _getTargetModel which handles both v1 and v2 formats
            const targetModel = this._getTargetModel(tierConfig);
            if (targetModel) {
                if (!modelToTierRoles.has(targetModel)) modelToTierRoles.set(targetModel, []);
                modelToTierRoles.get(targetModel).push(`${tierName}/targetModel`);
            }
            // Track fallback models with index
            const fallbacks = this._resolveFallbackList(tierConfig);
            for (let i = 0; i < fallbacks.length; i++) {
                const fb = fallbacks[i];
                if (!fb) continue;
                // Skip if same as targetModel within same tier (just redundant config, not cross-tier overlap)
                if (fb === targetModel) continue;
                if (!modelToTierRoles.has(fb)) modelToTierRoles.set(fb, []);
                modelToTierRoles.get(fb).push(`${tierName}/fallbackModels[${i}]`);
            }
        }

        // Filter to cross-tier overlaps only (model appears in 2+ distinct tiers)
        const overlaps = new Map();
        for (const [model, tierRoles] of modelToTierRoles) {
            const distinctTiers = new Set(tierRoles.map(tr => tr.split('/')[0]));
            if (distinctTiers.size > 1) {
                overlaps.set(model, tierRoles);
            }
        }

        // Build deterministic hash to avoid re-warning on same config
        if (overlaps.size > 0) {
            const sorted = Array.from(overlaps.entries())
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([model, roles]) => [model, [...roles].sort()]);
            const hash = JSON.stringify(sorted);

            if (hash === this._lastTierOverlapHash) return;  // Same config, skip warning
            this._lastTierOverlapHash = hash;

            // Avoid repeated console spam in test/runtime paths that instantiate many routers
            // without a structured logger. Explicit loggers keep full warning behavior.
            const usesConsoleWarn =
                this._logger === console ||
                this._logger?.warn === console.warn;
            if (usesConsoleWarn) {
                if (process.env.JEST_WORKER_ID) return;
                if (!ModelRouter._consoleOverlapWarnHashes) {
                    ModelRouter._consoleOverlapWarnHashes = new Set();
                }
                if (ModelRouter._consoleOverlapWarnHashes.has(hash)) return;
                ModelRouter._consoleOverlapWarnHashes.add(hash);
                if (ModelRouter._consoleOverlapWarnHashes.size > 256) {
                    const oldest = ModelRouter._consoleOverlapWarnHashes.values().next().value;
                    ModelRouter._consoleOverlapWarnHashes.delete(oldest);
                }
            }

            for (const [model, tierRoles] of overlaps) {
                this._logger?.warn(
                    `Model ${model} appears in multiple tiers: [${tierRoles.join(', ')}]. ` +
                    `This may cause cross-tier contention under 429 pressure.`
                );
            }
        } else {
            this._lastTierOverlapHash = null;
        }
    }

    // ---------------------------------------------------------------
    // Public getters
    // ---------------------------------------------------------------

    /** Whether model routing is enabled at all. */
    get enabled() {
        return !!this.config.enabled;
    }

    /** Whether shadow mode is active (routing decisions logged but not applied). */
    get shadowMode() {
        return !!this.config.shadowMode;
    }

    // ---------------------------------------------------------------
    // Model metadata lookup (async ModelDiscovery + sync callback)
    // ---------------------------------------------------------------

    /**
     * Get model metadata from ModelDiscovery.
     * Async method that uses ModelDiscovery.getModel() for model metadata.
     *
     * @param {string} modelId - The model identifier
     * @returns {Promise<Object|null>} Model metadata or null if not found
     */
    async _getModelMetaAsync(modelId) {
        return await this._modelDiscovery.getModel(modelId);
    }

    // ---------------------------------------------------------------
    // Feature extraction
    // ---------------------------------------------------------------

    /**
     * Extract routing-relevant features from a parsed Anthropic /v1/messages body.
     *
     * @param {Object} parsed - The parsed request body
     * @returns {Object} Feature vector
     */
    extractFeatures(parsed) {
        return {
            model: parsed.model,
            maxTokens: parsed.max_tokens ?? null,
            messageCount: (parsed.messages || []).length,
            systemLength:
                typeof parsed.system === 'string'
                    ? parsed.system.length
                    : Array.isArray(parsed.system)
                        ? JSON.stringify(parsed.system).length
                        : 0,
            hasTools: Array.isArray(parsed.tools) && parsed.tools.length > 0,
            hasVision: (parsed.messages || []).some(
                m => Array.isArray(m.content) && m.content.some(c => c.type === 'image')
            ),
            stream: !!parsed.stream
        };
    }

    /**
     * Estimate total token usage for a request (input + output).
     * Uses a heuristic (~4 chars/token, ~260 tokens/image, 2% safety margin).
     * Used for context-window pre-flight gating to skip models that can't fit the request.
     *
     * Policy: Models with contextLength=0 or missing are ALLOWED (not gated).
     * Only models with a known, positive contextLength are checked.
     *
     * @param {Object} parsedBody - Parsed Anthropic request body
     * @returns {number} Estimated total tokens (input + output)
     */
    _estimateRequestTokens(parsedBody) {
        if (!parsedBody) return 0;

        const CHARS_PER_TOKEN = 4;
        const IMAGE_TOKEN_ESTIMATE = 260;
        // No safety margin: chars/4 already over-counts by ~1-2% for mixed
        // content, and JSON-heavy payloads (tool_use/tool_result) are further
        // corrected below with a JSON efficiency factor.  A false rejection
        // (blocking a valid request) is strictly worse than letting a borderline
        // request reach upstream — the error strategy handles 400s gracefully.
        const SAFETY_MARGIN = 1.0;

        let inputChars = 0;

        // System prompt (string or array of blocks)
        if (typeof parsedBody.system === 'string') {
            inputChars += parsedBody.system.length;
        } else if (Array.isArray(parsedBody.system)) {
            for (const block of parsedBody.system) {
                if (typeof block === 'string') inputChars += block.length;
                else if (block && typeof block.text === 'string') inputChars += block.text.length;
            }
        }

        // Messages
        if (Array.isArray(parsedBody.messages)) {
            for (const msg of parsedBody.messages) {
                if (typeof msg.content === 'string') {
                    inputChars += msg.content.length;
                } else if (Array.isArray(msg.content)) {
                    for (const block of msg.content) {
                        if (block.type === 'text' && typeof block.text === 'string') {
                            inputChars += block.text.length;
                        } else if (block.type === 'image') {
                            inputChars += IMAGE_TOKEN_ESTIMATE * CHARS_PER_TOKEN;
                        } else if (block.type === 'tool_use' || block.type === 'tool_result') {
                            // JSON structural chars ({, }, :, ", comma) tokenize ~18%
                            // more efficiently than plain text; 0.82 factor brings the
                            // effective ratio to ~4.9 chars/token for JSON blocks.
                            inputChars += Math.ceil(JSON.stringify(block).length * 0.82);
                        }
                    }
                }
                inputChars += 16; // Role + overhead per message
            }
        }

        // Tool definitions (JSON schema — same 0.82 efficiency factor as tool blocks)
        if (Array.isArray(parsedBody.tools) && parsedBody.tools.length > 0) {
            inputChars += Math.ceil(JSON.stringify(parsedBody.tools).length * 0.82);
        }

        const estimatedInputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN);
        const maxOutputTokens = parsedBody.max_tokens || 4096;
        return Math.ceil((estimatedInputTokens + maxOutputTokens) * SAFETY_MARGIN);
    }

    // ---------------------------------------------------------------
    // Glob matching helper
    // ---------------------------------------------------------------

    /**
     * Simple glob match (only `*` wildcards).
     * @private
     */
    _matchGlob(pattern, value) {
        const escaped = pattern
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*');
        return new RegExp(`^${escaped}$`).test(value);
    }

    /**
     * Resolve the effective fallback model list for a tier.
     * @private
     */
    _resolveFallbackList(tierConfig) {
        // v2: models[] exists (excluding position 0 which is the target)
        if (Array.isArray(tierConfig.models) && tierConfig.models.length > 1) {
            return tierConfig.models.slice(1);  // Exclude position 0
        }
        // v1: fallbackModels or failoverModel
        if (Array.isArray(tierConfig.fallbackModels) && tierConfig.fallbackModels.length > 0) {
            return tierConfig.fallbackModels;
        }
        if (tierConfig.failoverModel && typeof tierConfig.failoverModel === 'string') {
            return [tierConfig.failoverModel];
        }
        return [];
    }

    /**
     * Get the target model from a tier config.
     * Supports v2 (models[0]) and v1 (targetModel).
     * @private
     */
    _getTargetModel(tierConfig) {
        // v2: first model in models[]
        if (Array.isArray(tierConfig.models) && tierConfig.models.length > 0) {
            return tierConfig.models[0];
        }
        // v1: targetModel
        return tierConfig.targetModel;
    }

    // ---------------------------------------------------------------
    // Classification
    // ---------------------------------------------------------------

    /**
     * Classify a feature vector into a tier.
     *
     * @param {Object} features - Output of extractFeatures()
     * @returns {{ tier: string, reason: string } | null}
     */
    classify(features) {
        // 1. Rule-based matching (first match wins)
        const rules = this.config.rules || [];
        for (const rule of rules) {
            const match = rule.match || {};
            let allMatch = true;

            if (match.model !== undefined) {
                if (!this._matchGlob(match.model, features.model)) allMatch = false;
            }
            if (match.maxTokensGte !== undefined) {
                if (features.maxTokens === null) {
                    allMatch = false;
                } else if (features.maxTokens < match.maxTokensGte) {
                    allMatch = false;
                }
            }
            if (match.messageCountGte !== undefined) {
                if (features.messageCount < match.messageCountGte) allMatch = false;
            }
            if (match.hasTools !== undefined) {
                if (features.hasTools !== match.hasTools) allMatch = false;
            }
            if (match.hasVision !== undefined) {
                if (features.hasVision !== match.hasVision) allMatch = false;
            }

            if (allMatch) {
                return { tier: rule.tier, reason: 'rule: ' + JSON.stringify(rule.match) };
            }
        }

        // 2. Check if any tier uses 'always-route'
        const tiers = this.config.tiers || {};
        const hasAlwaysRoute = Object.values(tiers).some(
            t => t.clientModelPolicy === 'always-route'
        );

        if (hasAlwaysRoute) {
            // Heuristic classifier
            const classifier = this.config.classifier || {};
            const heavy = classifier.heavyThresholds || {};
            const light = classifier.lightThresholds || {};

            // Heavy checks (any one triggers heavy)
            if (features.maxTokens !== null && heavy.maxTokensGte !== undefined &&
                features.maxTokens >= heavy.maxTokensGte) {
                return { tier: 'heavy', reason: 'classifier: maxTokens >= ' + heavy.maxTokensGte };
            }
            if (heavy.messageCountGte !== undefined &&
                features.messageCount >= heavy.messageCountGte) {
                return { tier: 'heavy', reason: 'classifier: messageCount >= ' + heavy.messageCountGte };
            }
            if (heavy.hasTools === true && features.hasTools) {
                return { tier: 'heavy', reason: 'classifier: hasTools' };
            }
            if (heavy.hasVision === true && features.hasVision) {
                return { tier: 'heavy', reason: 'classifier: hasVision' };
            }
            if (heavy.systemLengthGte !== undefined &&
                features.systemLength >= heavy.systemLengthGte) {
                return { tier: 'heavy', reason: 'classifier: systemLength >= ' + heavy.systemLengthGte };
            }

            // Light checks (all applicable must be met)
            let allLightMet = true;
            let anyLightCondition = false;

            if (light.maxTokensLte !== undefined) {
                anyLightCondition = true;
                if (features.maxTokens !== null) {
                    if (features.maxTokens > light.maxTokensLte) allLightMet = false;
                }
                // maxTokens null: don't fail this condition (not applicable)
            }
            if (light.messageCountLte !== undefined) {
                anyLightCondition = true;
                if (features.messageCount > light.messageCountLte) allLightMet = false;
            }
            if (light.hasTools !== undefined) {
                anyLightCondition = true;
                if (features.hasTools !== light.hasTools) allLightMet = false;
            }
            if (light.hasVision !== undefined) {
                anyLightCondition = true;
                if (features.hasVision !== light.hasVision) allLightMet = false;
            }

            if (anyLightCondition && allLightMet) {
                return { tier: 'light', reason: 'classifier: all light thresholds met' };
            }

            // Default to medium
            return { tier: 'medium', reason: 'classifier: default medium' };
        }

        // 3. All tiers are rule-match-only → no match
        return null;
    }

    /**
     * Determine which threshold triggered a heavy-tier upgrade.
     * Returns a reason from UPGRADE_REASONS enum.
     * Uses complexityUpgrade.thresholds if set, else classifier.heavyThresholds.
     * @private
     * @param {Object} features - Feature vector from extractFeatures()
     * @returns {string} Reason from UPGRADE_REASONS enum
     */
    _classifyUpgradeReason(features) {
        const cfg = this.config.complexityUpgrade || {};

        // Check if upgrades are disabled
        if (cfg.enabled === false) return null;

        // Check if model family is allowed
        const allowed = cfg.allowedFamilies;
        if (Array.isArray(allowed) && allowed.length > 0) {
            const model = features.model || '';
            if (!allowed.some(f => model.includes(f))) return null;
        }

        const thresholds = cfg.thresholds
            || this.config.classifier?.heavyThresholds || {};

        if (features.hasTools && thresholds.hasTools) return 'has_tools';
        if (features.hasVision && thresholds.hasVision) return 'has_vision';
        if (features.maxTokens !== null && thresholds.maxTokensGte !== undefined
            && features.maxTokens >= thresholds.maxTokensGte) return 'max_tokens';
        if (thresholds.messageCountGte !== undefined
            && features.messageCount >= thresholds.messageCountGte) return 'message_count';
        if (thresholds.systemLengthGte !== undefined
            && features.systemLength >= thresholds.systemLengthGte) return 'system_length';
        return 'other';
    }

    // ---------------------------------------------------------------
    // Trace sampling (TRUST-03)
    // ---------------------------------------------------------------

    /**
     * Determine whether to sample a decision trace based on sampling rate.
     * TRUST-03: Controls SSE/log volume by sampling traces.
     *
     * @returns {boolean} True if trace should be included, false otherwise
     * @private
     */
    _shouldSampleTrace() {
        const rate = this.config.trace?.samplingRate ?? 10;

        // 0% = never sample, 100% = always sample
        if (rate <= 0) return false;
        if (rate >= 100) return true;

        return Math.random() * 100 < rate;
    }

    /**
     * Get the maximum trace payload size from config.
     * TRUST-01: Prevents oversized trace responses.
     *
     * Default: 100KB
     * Min: 10KB
     * Max: 1MB
     *
     * @returns {number} Maximum payload size in bytes
     * @private
     */
    _getMaxTracePayloadSize() {
        const configured = this.config.trace?.maxPayloadSize;
        const DEFAULT_MAX_TRACE_PAYLOAD = 100 * 1024; // 100KB
        const MIN_MAX_TRACE_PAYLOAD = 10 * 1024; // 10KB
        const MAX_MAX_TRACE_PAYLOAD = 1024 * 1024; // 1MB

        if (configured === undefined || configured === null) {
            return DEFAULT_MAX_TRACE_PAYLOAD;
        }

        // Clamp to valid range
        return Math.max(MIN_MAX_TRACE_PAYLOAD, Math.min(MAX_MAX_TRACE_PAYLOAD, configured));
    }

    /**
     * Truncate trace to fit within max payload size.
     * TRUST-01: Prevents oversized trace responses from causing issues.
     *
     * Truncation strategy (in order):
     * 1. Truncate message content (keep first 200 chars)
     * 2. Limit candidates to top 5
     * 3. Limit messages array to first 3
     *
     * @param {Object} trace - The trace object to truncate
     * @param {number} maxSize - Maximum payload size in bytes
     * @returns {Object} Truncated trace (or original if under limit)
     * @private
     */
    _truncateTrace(trace, maxSize) {
        const json = JSON.stringify(trace);
        if (json.length <= maxSize) {
            return trace;
        }

        // Create a shallow copy to mutate
        let truncated = { ...trace };
        const CONTENT_TRUNCATE_LENGTH = 200;
        const MAX_CANDIDATES = 5;
        const MAX_MESSAGES = 3;

        // 1. Truncate message content
        if (truncated.input && truncated.input.messages) {
            truncated.input = { ...truncated.input };
            truncated.input.messages = truncated.input.messages.map(m => {
                if (typeof m.content === 'string') {
                    return {
                        ...m,
                        content: m.content.length > CONTENT_TRUNCATE_LENGTH
                            ? m.content.slice(0, CONTENT_TRUNCATE_LENGTH) + '...'
                            : m.content
                    };
                }
                return m;
            });
        }

        // Recalculate size
        let currentSize = JSON.stringify(truncated).length;
        if (currentSize <= maxSize) {
            return truncated;
        }

        // 2. Limit candidates to top 5
        if (truncated.modelSelection && truncated.modelSelection.candidates) {
            truncated.modelSelection = { ...truncated.modelSelection };
            const originalCandidates = truncated.modelSelection.candidates;
            if (originalCandidates.length > MAX_CANDIDATES) {
                // Sort by score descending and keep top 5
                const sorted = [...originalCandidates].sort((a, b) => (b.score || 0) - (a.score || 0));
                truncated.modelSelection.candidates = sorted.slice(0, MAX_CANDIDATES);
                truncated.modelSelection.truncated = true;
            }
        }

        // Recalculate size
        currentSize = JSON.stringify(truncated).length;
        if (currentSize <= maxSize) {
            return truncated;
        }

        // 3. Limit messages array to first 3
        if (truncated.input && truncated.input.messages && truncated.input.messages.length > MAX_MESSAGES) {
            truncated.input.messages = truncated.input.messages.slice(0, MAX_MESSAGES);
            truncated.input.truncated = true;
        }

        // Final size check - if still over, mark as truncated
        currentSize = JSON.stringify(truncated).length;
        if (currentSize > maxSize) {
            truncated._warning = `Trace truncated (actual: ${currentSize} bytes, limit: ${maxSize} bytes)`;
        } else if (truncated.modelSelection?.truncated || truncated.input?.truncated) {
            truncated._truncated = true;
        }

        return truncated;
    }

    // ---------------------------------------------------------------
    // Decision trace helpers (TRUST-01)
    // ---------------------------------------------------------------

    /**
     * Calculate complexity score from features (0-100).
     * Higher values indicate more complex requests.
     * @private
     * @param {Object} features - Feature vector from extractFeatures()
     * @returns {number} Complexity score (0-100)
     */
    _calculateComplexity(features) {
        const thresholds = this.config.classifier?.heavyThresholds || {};
        let score = 0;

        // Max tokens contribution (0-30 points)
        if (features.maxTokens !== null && thresholds.maxTokensGte !== undefined) {
            const ratio = Math.min(1, features.maxTokens / Math.max(thresholds.maxTokensGte, 1));
            score += ratio * 30;
        }

        // Message count contribution (0-25 points)
        if (thresholds.messageCountGte !== undefined) {
            const ratio = Math.min(1, features.messageCount / Math.max(thresholds.messageCountGte, 1));
            score += ratio * 25;
        }

        // System length contribution (0-20 points)
        if (thresholds.systemLengthGte !== undefined) {
            const ratio = Math.min(1, features.systemLength / Math.max(thresholds.systemLengthGte, 1));
            score += ratio * 20;
        }

        // Tools bonus (15 points)
        if (features.hasTools && thresholds.hasTools) {
            score += 15;
        }

        // Vision bonus (10 points)
        if (features.hasVision && thresholds.hasVision) {
            score += 10;
        }

        return Math.min(100, Math.round(score));
    }

    /**
     * Generate human-readable rationale for model selection.
     * Explains why a specific model was selected over other candidates.
     * @private
     * @param {Object} selected - The selected candidate
     * @param {Array<Object>} candidates - All candidates considered
     * @param {string} strategy - Selection strategy used
     * @returns {string} Human-readable rationale
     */
    _generateSelectionRationale(selected, candidates, strategy) {
        const reasons = [];

        if (candidates.length > 1) {
            // Find the selected candidate in the list
            const selectedEntry = candidates.find(c => c.modelId === selected.model);
            const otherCandidates = candidates.filter(c => c.modelId !== selected.model);

            if (selectedEntry) {
                // Check if selected has highest score
                const maxScore = Math.max(...candidates.map(c => c.score || 0));
                if (selectedEntry.score >= maxScore - 0.01) {
                    reasons.push(`highest score (${selectedEntry.score.toFixed(2)})`);
                }

                // Check if selected has zero in-flight while others don't
                const othersWithInFlight = otherCandidates.filter(c => (c.inFlight || 0) > 0);
                if ((selectedEntry.inFlight || 0) === 0 && othersWithInFlight.length > 0) {
                    reasons.push('zero in-flight requests');
                }

                // Check if selected is available while others aren't
                const othersUnavailable = otherCandidates.filter(c => !c.isAvailable);
                if (selectedEntry.isAvailable && othersUnavailable.length > 0) {
                    reasons.push('currently available');
                }
            }
        }

        if (reasons.length > 0) {
            return `Selected ${selected.model}: ${reasons.join(', ')}`;
        }

        // Fallback to strategy-based rationale
        return `Selected ${selected.model} by ${strategy} strategy`;
    }

    /**
     * Build trace object for decision explainability.
     * ARCH-04: Unified trace payload with router and key state
     *
     * @private
     * @param {Object} context - Request context
     * @param {Object} features - Extracted features
     * @param {Object|null} classification - Classification result
     * @param {Object} decision - Final decision
     * @param {Array<Object>} [candidates] - Candidate models with scores
     * @param {Object} options - Build options
     * @param {boolean} options.includeRouterState - Include router pool state
     * @param {boolean} options.includeKeyState - Include key state
     * @returns {UnifiedDecisionTrace} Decision trace
     */
    async _buildTrace(context, features, classification, decision, candidates = [], options = {}) {
        const {
            includeRouterState = false,
            includeKeyState = false
        } = options;

        const parsedBody = context.parsedBody || {};

        // Build input (truncate messages for payload size)
        const messages = (parsedBody.messages || []).slice(0, 10);
        const input = {
            model: parsedBody.model,
            messages: messages,
            max_tokens: parsedBody.max_tokens,
            stream: parsedBody.stream
        };

        // Build classification
        const classificationTrace = {
            tier: decision.tier || 'unknown',
            complexity: this._calculateComplexity(features),
            upgradeTrigger: null,
            thresholdComparison: {
                hasTools: features.hasTools || false,
                hasVision: features.hasVision || false,
                maxTokens: features.maxTokens,
                messageCount: features.messageCount,
                systemLength: features.systemLength
            }
        };

        // Determine upgrade trigger for heavy tier
        if (decision.tier === 'heavy') {
            classificationTrace.upgradeTrigger = this._classifyUpgradeReason(features);
        }

        // Build model selection candidates array
        const traceCandidates = candidates.map(c => ({
            modelId: c.model,
            score: typeof c.score === 'number' ? c.score : (c.available > 0 ? 0.5 : 0),
            inFlight: c.inFlight || 0,
            maxConcurrency: c.maxConcurrency || 2,
            isAvailable: (c.available || 0) > 0,
            reason: c.reason || null
        }));

        // If no candidates from pool selection, add the selected model as a candidate
        if (traceCandidates.length === 0 && decision.model) {
            traceCandidates.push({
                modelId: decision.model,
                score: 1.0,
                inFlight: this._inFlight.get(decision.model) || 0,
                maxConcurrency: 2, // Default fallback
                isAvailable: true,
                reason: null
            });
        }

        // Generate human-readable rationale
        const strategy = decision.strategy || 'balanced';
        const rationale = decision.model
            ? this._generateSelectionRationale({ model: decision.model }, traceCandidates, strategy)
            : 'No selection made';

        const modelSelection = {
            strategy,
            candidates: traceCandidates,
            selected: decision.model || '',
            rationale
        };

        const trace = {
            requestId: context.requestId || this._generateRequestId(),
            timestamp: Date.now(),
            input,
            classification: classificationTrace,
            modelSelection
        };

        // ARCH-04: Add router pool state if requested
        if (includeRouterState && decision.model) {
            // Find selected model from candidates or create fallback
            // Note: candidates may have 'model' or 'modelId' property
            const selectedCandidate = traceCandidates.find(c => {
                const modelId = c.modelId || c.model;
                return modelId === decision.model;
            });
            const selectedModel = selectedCandidate || {
                modelId: decision.model,
                maxConcurrency: 2
            };
            const _traceStaticMax = selectedModel.maxConcurrency * this._concurrencyMultiplier;
            trace.routerPool = {
                modelId: decision.model,
                inFlight: this._inFlight.get(decision.model) || 0,
                max: this.adaptiveConcurrency?.getEffectiveConcurrency(decision.model) ?? _traceStaticMax,
                staticMax: _traceStaticMax,
                isAvailable: this.getModelCooldown(decision.model) === 0,
                cooldownUntil: this._cooldowns.has(decision.model) ? this._cooldowns.get(decision.model).cooldownUntil : null
            };
        }

        // ARCH-04: Add key state if requested
        if (includeKeyState && this._driftDetector && this._driftDetector._keyManager) {
            const keyIndex = decision.keyIndex || context.keyIndex;
            if (typeof keyIndex === 'number') {
                const keySnapshot = this._driftDetector._keyManager.getKeySnapshot(keyIndex);
                if (keySnapshot) {
                    trace.key = {
                        index: keyIndex,
                        excluded: keySnapshot.state === 'excluded',
                        reason: keySnapshot.excludedReason || null,
                        state: keySnapshot.state
                    };
                }
            }
        }

        // Apply payload size truncation
        return this._truncateTrace(trace, this._getMaxTracePayloadSize());
    }

    /**
     * Generate unique request ID for trace linking
     * ARCH-04: Enables linking across trace/logs/metrics
     * @private
     * @returns {string} Unique request ID
     */
    _generateRequestId() {
        return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    // ---------------------------------------------------------------
    // Admission hold peek (read-only)
    // ---------------------------------------------------------------

    /**
     * Peek whether this request should enter admission hold.
     * Uses full routing precedence (overrides → rules → classifier → downgrade).
     * No stats, no pool acquire — read-only check.
     * @param {Object} context - Same shape as selectModel context
     * @returns {{ tier: string, candidates: string[], minCooldownMs: number, allCooled: boolean } | null}
     */
    peekAdmissionHold(context) {
        if (!this.enabled || this.shadowMode) return null;

        // 1. Override check: if overrides would route, no tier involved → skip hold
        if (!context.skipOverrides) {
            if (context.override) return null;
            for (const key of [context.requestModel, '*']) {
                if (this._overrides.has(key)) return null;
            }
        }

        // 2. Classify tier via rules + classifier (no side effects)
        const features = this.extractFeatures(context.parsedBody);
        const classification = this.classify(features);
        if (!classification) return null;

        const tier = classification.tier;
        const tierConfig = this.config.tiers?.[tier];
        if (!tierConfig) return null;

        // 3. Gather candidates: target + fallbacks for the tier
        // Use _getTargetModel which handles both v1 (targetModel) and v2 (models[0]) formats
        const candidates = [this._getTargetModel(tierConfig), ...this._resolveFallbackList(tierConfig)]
            .filter(Boolean);

        // 4. If tier downgrade enabled, include downgrade candidates too
        //    (if a downgrade model is available, the request will be served — no hold needed)
        const failoverConfig = this.config.failover || {};
        if (failoverConfig.allowTierDowngrade) {
            const downgradeOrder = failoverConfig.downgradeOrder || ['medium', 'light'];
            const tierRank = { heavy: 2, medium: 1, light: 0 };
            for (const dt of downgradeOrder) {
                if ((tierRank[dt] ?? 0) >= (tierRank[tier] ?? 0)) continue; // only downgrade
                const dtConfig = this.config.tiers?.[dt];
                if (dtConfig) {
                    candidates.push(this._getTargetModel(dtConfig));
                    candidates.push(...this._resolveFallbackList(dtConfig));
                }
            }
        }

        const uniqueCandidates = [...new Set(candidates.filter(Boolean))];

        // 5. Check cooldowns — return null (no hold) if ANY candidate is available
        let minCooldown = Infinity;
        for (const model of uniqueCandidates) {
            const cd = this.getModelCooldown(model);
            if (cd === 0) return null;  // At least one candidate available
            if (cd < minCooldown) minCooldown = cd;
        }

        return {
            tier,
            candidates: uniqueCandidates,
            minCooldownMs: minCooldown === Infinity ? 0 : minCooldown,
            allCooled: true
        };
    }

    // ---------------------------------------------------------------
    // Model selection (main entry point)
    // ---------------------------------------------------------------

    /**
     * Select the GLM target model for a request.
     *
     * @param {Object} context
     * @param {Object} context.parsedBody - Parsed Anthropic request body
     * @param {string} context.requestModel - The model string from the request
     * @param {number} [context.keyIndex]
     * @param {string} [context.override] - Per-request UI override (header-based)
     * @param {boolean} [context.skipOverrides=false] - Skip per-request and saved overrides
     *   (use for replay requests to ensure only rules/classifier/default are evaluated)
     * @param {Set<string>} [context.attemptedModels] - Models already tried in this
     *   request lifecycle (for multi-fallback: skip these when selecting)
     * @param {boolean} [context.includeTrace=false] - Whether to include full trace in result
     * @returns {Promise<{ model: string, tier: string|null, reason: string, source: string, trace?: Object } | null>}
     */
    async selectModel(context) {
        // 1. Disabled → null
        if (!this.enabled) return null;

        // 2. Shadow mode: Run pure computation but return null (fall through to legacy)
        if (this.shadowMode) {
            const decision = await this.computeDecision(context);
            if (decision && decision.model) {
                this._lastShadowDecision = { ...decision, shadowMode: true };
                this._stats.shadowDecisions++;
            }
            return null;
        }

        // Single pipeline: always computeDecision → commitDecision
        const decision = await this.computeDecision(context);

        // No routable model → return null (backward compat with callers expecting null)
        if (!decision || !decision.model) return null;

        // Context overflow: record failure stats WITHOUT acquiring a slot.
        // No routing counters incremented — request will fail fast with 400.
        if (decision.contextOverflow) {
            return this.commitDecisionOverflow(decision);
        }

        // Commit: acquire slot + record stats (atomic, no TOCTOU)
        this.commitDecision(decision);

        // DRIFT-01: Validate routing decision BEFORE returning to caller
        // This detects Router/KeyManager disagreements at decision time
        if (decision && decision.model && this._driftDetector) {
            const routerState = {
                modelId: decision.model,
                tier: decision.tier,
                isAvailable: this.getModelCooldown(decision.model) === 0,
                inFlight: this._inFlight.get(decision.model) || 0,
                cooldownUntil: this._cooldowns.has(decision.model)
                    ? this._cooldowns.get(decision.model).cooldownUntil
                    : null
            };
            const keyIndex = decision.keyIndex || 0;
            const drifts = this._driftDetector.validateRoutingDecision(routerState, keyIndex);

            if (drifts.length > 0) {
                this._logger?.warn('Drift detected in routing decision', {
                    modelId: decision.model,
                    tier: decision.tier,
                    keyIndex,
                    driftCount: drifts.length
                });
            }
        }

        return decision;
    }

    /**
     * Compute a routing decision without side effects.
     * This method is pure and never mutates routing state, slots, or stats.
     * Side effects are deferred to commitDecision().
     *
     * TRUST-01: Now returns full trace for operator explainability.
     *
     * @param {Object} context
     * @param {Object} context.parsedBody - Parsed Anthropic request body
     * @param {string} context.requestModel - The model string from the request
     * @param {number} [context.keyIndex]
     * @param {string} [context.override] - Per-request UI override (header-based)
     * @param {boolean} [context.skipOverrides=false] - Skip per-request and saved overrides
     * @param {Set<string>} [context.attemptedModels] - Models already tried
     * @param {boolean} [context.includeTrace=false] - Whether to include full trace
     * @returns {Promise<Object>} Decision object with model, tier, strategy, source, reason, and optional trace
     */
    async computeDecision(context) {
        const decisionMeta = this._createDecisionMeta();

        // TRUST-03: Apply sampling to trace inclusion and track stats
        // TRUST-02: Bypass sampling for simulation modes
        const shouldTrace = context.includeTrace === true;
        const bypassSampling = context.bypassSampling === true;
        const dryRun = context.dryRun === true;
        const sampleDecision = shouldTrace && !bypassSampling ? this._shouldSampleTrace() : true;
        const includeTrace = shouldTrace && sampleDecision;

        // Track sampling deltas when trace was requested (applied only in commitDecision)
        if (shouldTrace && !dryRun) {
            decisionMeta.traceSampledTotal++;
            if (sampleDecision) {
                decisionMeta.traceSampledIncluded++;
            }
        }

        const features = this.extractFeatures(context.parsedBody);
        const classification = this.classify(features);
        const estimatedTokens = this._estimateRequestTokens(context.parsedBody);

        // 1. Disabled -> return disabled decision
        if (!this.enabled) {
            const decision = { model: null, tier: null, reason: 'disabled', source: 'none' };
            if (includeTrace) {
                decision.trace = await this._buildTrace(context, features, classification, decision, [], {
                    includeRouterState: false,
                    includeKeyState: false
                });
            }
            this._attachDecisionMeta(decision, decisionMeta);
            return decision;
        }

        // 2. Per-request UI override (highest priority)
        // Skipped when context.skipOverrides is true (e.g., replay requests)
        if (!context.skipOverrides && context.override) {
            const decision = {
                model: context.override,
                tier: null,
                strategy: null,
                reason: 'per-request override',
                source: 'override'
            };
            if (includeTrace) {
                decision.trace = await this._buildTrace(context, features, classification, decision, [], {
                    includeRouterState: false,
                    includeKeyState: false
                });
            }
            this._attachDecisionMeta(decision, decisionMeta);
            return decision;
        }

        // 3. Saved overrides (specific model key, then wildcard)
        // Skipped when context.skipOverrides is true (e.g., replay requests)
        if (!context.skipOverrides) {
            for (const key of [context.requestModel, '*']) {
                if (this._overrides.has(key)) {
                    const model = this._overrides.get(key);
                    const decision = {
                        model,
                        tier: null,
                        strategy: null,
                        reason: 'saved override for ' + key,
                        source: 'saved-override'
                    };
                    if (includeTrace) {
                        decision.trace = await this._buildTrace(context, features, classification, decision, [], {
                            includeRouterState: false,
                            includeKeyState: false
                        });
                    }
                    this._attachDecisionMeta(decision, decisionMeta);
                    return decision;
                }
            }
        }

        // 4. Tier resolved -> look up target model
        if (classification) {
            const tier = classification.tier;
            const tierConfig = this.config.tiers?.[tier];
            if (!tierConfig) {
                const decision = { model: null, tier, reason: 'tier not found', source: 'none' };
                if (includeTrace) {
                    decision.trace = await this._buildTrace(context, features, classification, decision, [], {
                        includeRouterState: false,
                        includeKeyState: false
                    });
                }
                this._attachDecisionMeta(decision, decisionMeta);
                return decision;
            }

            const attemptedModels = context.attemptedModels || new Set();
            const candidates = this._getCandidates(tierConfig);
            // Default to balanced for invalid strategies
            const VALID_STRATEGIES = new Set(['pool', 'quality', 'throughput', 'balanced']);
            const rawStrategy = tierConfig.strategy || 'balanced';
            const strategy = VALID_STRATEGIES.has(rawStrategy) ? rawStrategy : 'balanced';

            // POOL STRATEGY: distribute by available capacity (pure computation)
            // Always route through _computePoolSelection for v2 configs with models[]
            let scoringTable = null;
            let scoredCandidates = [];
            if (Array.isArray(tierConfig.models) && tierConfig.models.length > 0) {
                const deterministicRoll = dryRun
                    ? this._computeDeterministicRoll(context, features, tier, candidates)
                    : null;
                const poolResult = await this._computePoolSelection(
                    candidates,
                    attemptedModels,
                    tierConfig,
                    tier,
                    { dryRun, deterministicRoll, decisionMeta, estimatedTokens }
                );
                if (poolResult) {
                    scoringTable = poolResult.scoringTable;
                    scoredCandidates = scoringTable || [];
                    const decision = {
                        model: poolResult.model,
                        tier,
                        strategy,
                        reason: classification.reason + ' (' + poolResult.reason + ')',
                        source: rawStrategy === 'pool' ? 'pool' : (classification.reason.startsWith('rule') ? 'rule' : 'classifier'),
                        scoringTable
                    };
                    if (tier === 'heavy') {
                        decision.upgradeReason = this._classifyUpgradeReason(features);
                    }
                    if (includeTrace) {
                        decision.trace = await this._buildTrace(context, features, classification, decision, scoredCandidates, {
                            includeRouterState: true,
                            includeKeyState: this._driftDetector !== undefined
                        });
                    }
                    this._attachDecisionMeta(decision, decisionMeta);
                    return decision;
                }
                // Pool exhausted -> fall through to failover logic below
            }

            // Failover logic (pure - no slot acquisition)
            const maxSwitches = this.getEffectiveMaxSwitches(tier);
            const switchesSoFar = attemptedModels.size;
            const canSwitch = switchesSoFar < maxSwitches;

            const targetModel = this._getTargetModel(tierConfig);
            const targetCooldown = this.getModelCooldown(targetModel);
            const targetUnavailable = targetCooldown > 0 || attemptedModels.has(targetModel);

            let model;
            let source;
            let reason = classification.reason;

            if (targetUnavailable && canSwitch && candidates.length > 1) {
                // Try fallbacks in order — skip cooled and already-attempted
                const fallbacks = candidates.slice(1);  // Skip first (target)
                let foundFallback = false;
                for (const fb of fallbacks) {
                    if (attemptedModels.has(fb)) continue;
                    if (this.getModelCooldown(fb) > 0) continue;
                    // Context window pre-flight
                    if (estimatedTokens > 0) {
                        const fbMeta = await this._getModelMetaAsync(fb);
                        const fbContextLength = fbMeta?.contextLength || 0;
                        if (fbContextLength > 0 && estimatedTokens > fbContextLength) continue;
                    }
                    model = fb;
                    source = 'failover';
                    reason += ' (failover: ' + targetModel + ' unavailable)';
                    foundFallback = true;
                    break;
                }
                if (!foundFallback) {
                    // All fallbacks cooled/attempted — pick candidate with shortest cooldown
                    let bestModel = targetModel;
                    let shortestCooldown = Infinity;
                    for (const candidate of candidates) {
                        if (attemptedModels.has(candidate)) continue;
                        const cd = this.getModelCooldown(candidate);
                        // Context window pre-flight
                        if (estimatedTokens > 0) {
                            const candMeta = await this._getModelMetaAsync(candidate);
                            const candContextLength = candMeta?.contextLength || 0;
                            if (candContextLength > 0 && estimatedTokens > candContextLength) continue;
                        }
                        if (cd < shortestCooldown) {
                            shortestCooldown = cd;
                            bestModel = candidate;
                        }
                    }
                    model = bestModel;
                    source = classification.reason.startsWith('rule') ? 'rule' : 'classifier';
                    if (shortestCooldown > 0 && shortestCooldown < Infinity) {
                        reason += ' (warning: all candidates unavailable, least-cooldown: ' + model + ' ' + shortestCooldown + 'ms)';
                    } else {
                        reason += ' (warning: all candidates unavailable)';
                    }
                }
            } else if (targetUnavailable) {
                // Can't switch (cap reached or no fallbacks) — best effort
                model = targetModel;
                source = classification.reason.startsWith('rule') ? 'rule' : 'classifier';
                if (!canSwitch) {
                    reason += ' (warning: maxModelSwitchesPerRequest reached)';
                } else {
                    reason += ' (warning: targetModel cooled down, no fallback available)';
                }
            } else {
                // Normal routing — target available
                model = targetModel;
                source = classification.reason.startsWith('rule') ? 'rule' : 'classifier';
            }

            // TIER DOWNGRADE: When current tier is effectively exhausted, try a lower tier
            const tierExhausted = source !== 'pool' && source !== 'failover' &&
                reason.includes('warning:');
            if (tierExhausted) {
                const failover = this.config.failover || {};
                const downgradeOrder = failover.downgradeOrder || ['medium', 'light'];
                const allowDowngrade = failover.allowTierDowngrade === true;

                for (const downgradeTier of downgradeOrder) {
                    if (downgradeTier === tier) continue;
                    const downgradeTierConfig = this.config.tiers?.[downgradeTier];
                    if (!downgradeTierConfig) continue;

                    const downgradeCandidates = this._getCandidates(downgradeTierConfig)
                        .filter(m => !attemptedModels.has(m));

                    if (downgradeCandidates.length === 0) continue;

                    let downgradeModel = null;
                    for (const c of downgradeCandidates) {
                        if (this.getModelCooldown(c) <= 0) {
                            downgradeModel = c;
                            break;
                        }
                    }

                    if (downgradeModel) {
                        if (allowDowngrade) {
                            // ACTIVE DOWNGRADE: Use the lower tier model
                            const downgradeDecision = {
                                model: downgradeModel,
                                tier: downgradeTier,
                                strategy: downgradeTierConfig.strategy || 'balanced',
                                reason: classification.reason + ' (tier_downgrade: ' + tier + ' exhausted → ' + downgradeTier + ')',
                                source: 'tier_downgrade',
                                degradedFromTier: tier
                            };
                            if (includeTrace) {
                                downgradeDecision.trace = await this._buildTrace(context, features, classification, downgradeDecision, scoredCandidates, {
                                    includeRouterState: true,
                                    includeKeyState: this._driftDetector !== undefined
                                });
                            }
                            this._attachDecisionMeta(downgradeDecision, decisionMeta);
                            return downgradeDecision;
                        } else {
                            // SHADOW: Record what we would have done without actually downgrading
                            if (!dryRun) {
                                this._recordTierDowngradeShadowDelta(decisionMeta, tier, downgradeTier);
                            }
                            break;  // Only record one shadow event per request
                        }
                    }
                }
            }

            // Track upgrade reason for heavy tier
            const decision = { model, tier, strategy, reason, source };
            if (tier === 'heavy') {
                decision.upgradeReason = this._classifyUpgradeReason(features);
            }

            // Warn if selected model's context window is smaller than estimated request
            if (model && estimatedTokens > 0) {
                const selectedMeta = await this._getModelMetaAsync(model);
                const selectedContextLength = selectedMeta?.contextLength || 0;
                if (selectedContextLength > 0 && estimatedTokens > selectedContextLength) {
                    // Determine cause: check if any tier candidate with sufficient context
                    // was skipped for a transient reason (cooldown or at_capacity).
                    // SYNC: uses warm cache only (no await).
                    const tierCfg = this.config.tiers?.[tier];
                    const allCandidates = tierCfg ? this._getCandidates(tierCfg) : [];
                    let cause = 'genuine';

                    for (const cand of allCandidates) {
                        const candMeta = this._modelDiscovery.getModelCached?.(cand);
                        const candContext = candMeta?.contextLength;
                        // Skip unknown/missing contextLength — must not imply transient
                        if (!candContext || candContext <= 0) continue;
                        if (candContext < estimatedTokens) continue;
                        // Model has sufficient context — is it transiently unavailable?
                        const isCooled = this.getModelCooldown(cand) > 0;
                        const inFlight = this._inFlight.get(cand) || 0;
                        const _candStaticMax = (candMeta.maxConcurrency || 2) * this._concurrencyMultiplier;
                        const maxConc = this.adaptiveConcurrency?.getEffectiveConcurrency(cand) ?? _candStaticMax;
                        if (isCooled || inFlight >= maxConc) {
                            cause = 'transient_unavailable';
                            break;
                        }
                    }

                    decision.contextOverflow = {
                        estimatedTokens,
                        modelContextLength: selectedContextLength,
                        overflowBy: estimatedTokens - selectedContextLength,
                        cause
                    };
                    decision.reason += ' (warning: estimated ' + estimatedTokens + ' tokens exceeds model context ' + selectedContextLength + ')';
                }
            }

            if (includeTrace) {
                decision.trace = await this._buildTrace(context, features, classification, decision, scoredCandidates, {
                    includeRouterState: true,
                    includeKeyState: this._driftDetector !== undefined
                });
            }
            this._attachDecisionMeta(decision, decisionMeta);
            return decision;
        }

        // 5. Default model fallback
        if (this.config.defaultModel) {
            const decision = {
                model: this.config.defaultModel,
                tier: null,
                strategy: null,
                reason: 'default model',
                source: 'default'
            };
            if (includeTrace) {
                decision.trace = await this._buildTrace(context, features, classification, decision, [], {
                    includeRouterState: false,
                    includeKeyState: false
                });
            }
            this._attachDecisionMeta(decision, decisionMeta);
            return decision;
        }

        // 6. Nothing matched
        const decision = { model: null, tier: null, reason: 'no match', source: 'none' };
        if (includeTrace) {
            decision.trace = await this._buildTrace(context, features, classification, decision, [], {
                includeRouterState: false,
                includeKeyState: false
            });
        }
        this._attachDecisionMeta(decision, decisionMeta);
        return decision;
    }

    /**
     * Commit a decision: acquire model slot + record all routing stats.
     * This mutates state - must be called after computeDecision().
     * Separating computation from commitment enables shadow mode and explainability.
     *
     * @param {Object} decision - The decision from computeDecision()
     * @returns {Object} The committed decision with `committed: true`
     */
    commitDecision(decision) {
        if (!decision) return decision;
        if (decision.committed) return decision;

        const decisionMeta = this._consumeDecisionMeta(decision);
        if (decisionMeta) {
            this._stats.traceSampledTotal += decisionMeta.traceSampledTotal || 0;
            this._stats.traceSampledIncluded += decisionMeta.traceSampledIncluded || 0;
            this._stats.glm5EligibleTotal += decisionMeta.glm5EligibleTotal || 0;
            this._stats.glm5PreferenceApplied += decisionMeta.glm5PreferenceApplied || 0;
            this._stats.glm5PreferenceShadow += decisionMeta.glm5PreferenceShadow || 0;
            this._stats.tierDowngradeShadow += decisionMeta.tierDowngradeShadow || 0;

            if (decisionMeta.byFallbackReason) {
                for (const [reason, delta] of Object.entries(decisionMeta.byFallbackReason)) {
                    if (!delta) continue;
                    this._stats.byFallbackReason[reason] =
                        (this._stats.byFallbackReason[reason] || 0) + delta;
                }
            }

            if (decisionMeta.tierDowngradeShadowByRoute) {
                for (const [routeKey, delta] of Object.entries(decisionMeta.tierDowngradeShadowByRoute)) {
                    if (!delta) continue;
                    this._stats.tierDowngradeShadowByRoute[routeKey] =
                        (this._stats.tierDowngradeShadowByRoute[routeKey] || 0) + delta;
                }
            }
        }

        if (!decision.model) {
            return decision;
        }

        // 1. Acquire slot (atomic with decision)
        this.acquireModel(decision.model);

        // 2. Record all routing stats
        this._stats.total++;
        if (decision.tier) {
            this._stats.byTier[decision.tier] = (this._stats.byTier[decision.tier] || 0) + 1;
        }
        if (decision.source) {
            this._stats.bySource[decision.source] = (this._stats.bySource[decision.source] || 0) + 1;
            // Tag failovers during warmup window so operators can filter cold-start noise
            if (decision.source === 'failover' && (Date.now() - this._startedAt) < this._warmupDurationMs) {
                this._stats.failoverWarmupTotal++;
            }
        }
        if (decision.strategy) {
            this._stats.byStrategy[decision.strategy] = (this._stats.byStrategy[decision.strategy] || 0) + 1;
        }
        if (decision.model) {
            this._stats.byModel[decision.model] = (this._stats.byModel[decision.model] || 0) + 1;
        }
        if (decision.upgradeReason) {
            this._stats.byUpgradeReason[decision.upgradeReason] = (this._stats.byUpgradeReason[decision.upgradeReason] || 0) + 1;
        }
        if (decision.degradedFromTier) {
            this._stats.tierDowngradeTotal = (this._stats.tierDowngradeTotal || 0) + 1;
            if (decision.tier) {
                const routeKey = decision.degradedFromTier + '->' + decision.tier;
                this._stats.tierDowngradeByRoute[routeKey] = (this._stats.tierDowngradeByRoute[routeKey] || 0) + 1;
            }
        }

        decision.committed = true;
        return decision;
    }

    /**
     * Record a context overflow failure for a decision.
     * Counterpart to commitDecision() for the overflow path —
     * records overflow-specific stats and flushes decision meta
     * WITHOUT acquiring a slot or incrementing routing counters.
     *
     * @param {Object} decision - Decision from computeDecision() with contextOverflow
     * @returns {Object} The decision with committed=false
     */
    commitDecisionOverflow(decision) {
        if (!decision || !decision.contextOverflow) return decision;

        this._stats.contextOverflowTotal++;
        if (decision.model) {
            this._stats.contextOverflowByModel[decision.model] =
                (this._stats.contextOverflowByModel[decision.model] || 0) + 1;
        }
        if (decision.tier) {
            this._stats.contextOverflowByTier[decision.tier] =
                (this._stats.contextOverflowByTier[decision.tier] || 0) + 1;
        }
        const cause = decision.contextOverflow.cause;
        if (cause && cause in this._stats.contextOverflowByCause) {
            this._stats.contextOverflowByCause[cause]++;
        }

        // Flush decision meta (fallback reasons etc.) to stats
        const decisionMeta = this._consumeDecisionMeta(decision);
        if (decisionMeta && decisionMeta.byFallbackReason) {
            for (const [reason, delta] of Object.entries(decisionMeta.byFallbackReason)) {
                if (!delta) continue;
                this._stats.byFallbackReason[reason] =
                    (this._stats.byFallbackReason[reason] || 0) + delta;
            }
        }

        decision.committed = false;
        return decision;
    }

    /**
     * Set KeyManager for drift detection
     * Called during proxy initialization
     * @param {KeyManager} keyManager
     */
    setKeyManagerForDrift(keyManager) {
        this._driftDetector.setKeyManager(keyManager);
        this._driftDetector.setRouter(this);
    }

    /**
     * Explain a routing decision without side effects.
     * Returns the full decision with scoring table, cooldown reasons,
     * and classifier result for debugging and operator dashboards.
     *
     * TRUST-01: Full decision trace
     * ARCH-04: Unified trace with router and key state
     *
     * @param {Object} context - Same shape as selectModel/computeDecision context
     * @param {Object} options - Additional options
     * @param {boolean} [options.includeTrace=false] - Whether to include full trace payload
     * @param {Object} [options.migrationPreview] - Migration preview data
     * @returns {Promise<Object>} Explanation with optional trace
     */
    async explain(context, options = {}) {
        const includeTrace = options.includeTrace === true;

        // 1. Run pure decision computation (no stats, no slot acquisition)
        // Set includeTrace flag on context to capture trace in decision
        // dryRun: true prevents stat mutations from polluting production counters
        const explainContext = { ...context, includeTrace, dryRun: true };
        const decision = await this.computeDecision(explainContext);

        // 2. Extract features and classify for matchedRule and classifierResult
        const features = this.extractFeatures(context.parsedBody);
        const classification = this.classify(features);

        // 3. Determine matchedRule (the rule.match object that matched, or null)
        let matchedRule = null;
        let classifierResult = null;
        if (classification) {
            if (classification.reason.startsWith('rule:')) {
                // Extract the match object from the reason
                try {
                    matchedRule = JSON.parse(classification.reason.substring('rule: '.length));
                } catch (e) {
                    matchedRule = null;
                }
            } else if (classification.reason.startsWith('classifier:')) {
                classifierResult = {
                    tier: classification.tier,
                    reason: classification.reason
                };
            }
        }

        // 4. Get cooldown reasons for the resolved tier's candidates
        const cooldownReasons = [];
        if (decision.tier) {
            const tierConfig = this.config.tiers?.[decision.tier];
            if (tierConfig) {
                const candidates = this._getCandidates(tierConfig);
                for (const model of candidates) {
                    const remainingMs = this.getModelCooldown(model);
                    if (remainingMs > 0) {
                        const entry = this._cooldowns.get(model);
                        cooldownReasons.push({
                            model,
                            remainingMs,
                            count: entry?.count || 0,
                            burstDampened: entry?.lastBurstDampened || false
                        });
                    }
                }
            }
        }

        // 5. Build enriched response
        const result = {
            selectedModel: decision.model,
            tier: decision.tier,
            strategy: decision.strategy || null,
            reason: decision.reason,
            source: decision.source,
            matchedRule,
            classifierResult,
            cooldownReasons,
            scoringTable: decision.scoringTable || null,
            features,
            migrationPreview: options.migrationPreview || null
        };

        // 6. Add trace if requested and available
        if (includeTrace && decision.trace) {
            // ARCH-04: Rebuild with unified state if not already included
            if (!decision.trace.routerPool && decision.model) {
                // Need to rebuild with router state
                const rebuiltTrace = await this._buildTrace(
                    { ...context, includeTrace },
                    features,
                    classification,
                    decision,
                    decision.trace.modelSelection?.candidates || [],
                    { includeRouterState: true, includeKeyState: this._driftDetector !== undefined }
                );
                result.trace = rebuiltTrace;
            } else {
                result.trace = decision.trace;
            }
        }

        return result;
    }

    /**
     * Simulate routing decision in decision mode.
     * TRUST-02: Ignores live pool state, assumes all models healthy.
     *
     * Decision mode creates synthetic pool state where:
     * - All models have inFlight=0
     * - All models are available (no cooldown)
     * - No 429 penalties
     *
     * This allows operators to see "what would happen if everything was healthy"
     * without being affected by current transient conditions.
     *
     * @param {Object} context - Same shape as computeDecision context
     * @param {Object} options - Additional options
     * @param {boolean} [options.includeTrace=true] - Whether to include full decision trace
     * @returns {Promise<Object>} Decision result with synthetic pool state
     */
    async simulateDecisionMode(context, options = {}) {
        const includeTrace = options.includeTrace !== false;

        // Save original state
        const originalInFlight = this._inFlight;
        const originalCooldowns = this._cooldowns;
        const originalRecent429s = this._recentPool429s;

        // Create synthetic state: all models healthy
        this._inFlight = new Map();  // All inFlight = 0
        this._cooldowns = new Map();  // No cooldowns
        this._recentPool429s = new Map();  // No 429s

        try {
            // Compute decision with synthetic state, force include trace, bypass sampling
            // dryRun: true prevents stat mutations during simulation
            const decision = await this.computeDecision({ ...context, includeTrace: true, bypassSampling: true, dryRun: true });

            // Build enriched response similar to explain()
            const features = this.extractFeatures(context.parsedBody);
            const classification = this.classify(features);

            // Build synthetic cooldown reasons (all empty since no cooldowns)
            const cooldownReasons = [];

            // Determine matchedRule and classifierResult
            let matchedRule = null;
            let classifierResult = null;
            if (classification) {
                if (classification.reason.startsWith('rule:')) {
                    try {
                        matchedRule = JSON.parse(classification.reason.substring('rule: '.length));
                    } catch (e) {
                        matchedRule = null;
                    }
                } else if (classification.reason.startsWith('classifier:')) {
                    classifierResult = {
                        tier: classification.tier,
                        reason: classification.reason
                    };
                }
            }

            return {
                selectedModel: decision.model,
                tier: decision.tier,
                strategy: decision.strategy || null,
                reason: decision.reason,
                source: decision.source,
                mode: 'decision',
                matchedRule,
                classifierResult,
                cooldownReasons,
                scoringTable: decision.scoringTable || null,
                features,
                trace: decision.trace || null
            };
        } finally {
            // Restore original state (no side effects)
            this._inFlight = originalInFlight;
            this._cooldowns = originalCooldowns;
            this._recentPool429s = originalRecent429s;
        }
    }

    /**
     * Simulate routing decision in stateful mode.
     * TRUST-02: Uses provided snapshot to reconstruct pool state.
     *
     * Stateful mode accepts a PoolSnapshot captured at a point in time
     * and replays the decision as if the system were in that exact state.
     * This enables deterministic replay of specific scenarios.
     *
     * @param {Object} context - Same shape as computeDecision context
     * @param {PoolSnapshot} snapshot - Pool state snapshot
     * @param {Object} options - Additional options
     * @param {boolean} [options.includeTrace=true] - Whether to include full decision trace
     * @returns {Promise<Object>} Decision result with snapshot state
     */
    async simulateStatefulMode(context, snapshot, options = {}) {
        // Validate snapshot version
        if (!snapshot || snapshot.version !== '1.0') {
            throw new Error(`Unsupported snapshot version: ${snapshot?.version || 'missing'}. Supported: "1.0"`);
        }

        if (!Array.isArray(snapshot.models)) {
            throw new Error('Invalid snapshot: models array is required');
        }

        const includeTrace = options.includeTrace !== false;

        // Save original state
        const originalInFlight = this._inFlight;
        const originalCooldowns = this._cooldowns;
        const originalRecent429s = this._recentPool429s;

        try {
            // Reconstruct pool state from snapshot
            const syntheticInFlight = new Map();
            const syntheticCooldowns = new Map();

            const now = Date.now();
            for (const modelState of snapshot.models) {
                // Set in-flight count
                syntheticInFlight.set(modelState.modelId, modelState.inFlight);

                // Set cooldown if model unavailable
                if (!modelState.isAvailable && modelState.cooldownUntil) {
                    const remainingMs = Math.max(0, modelState.cooldownUntil - now);
                    if (remainingMs > 0) {
                        syntheticCooldowns.set(modelState.modelId, {
                            count: 1,  // Default count
                            until: modelState.cooldownUntil,
                            lastBurstDampened: false
                        });
                    }
                }
            }

            this._inFlight = syntheticInFlight;
            this._cooldowns = syntheticCooldowns;
            this._recentPool429s = new Map();  // No 429 history in snapshot

            // Compute decision with reconstructed state, force include trace, bypass sampling
            // dryRun: true prevents stat mutations during simulation
            const decision = await this.computeDecision({ ...context, includeTrace: true, bypassSampling: true, dryRun: true });

            // Build enriched response similar to explain()
            const features = this.extractFeatures(context.parsedBody);
            const classification = this.classify(features);

            // Build cooldown reasons from snapshot
            const cooldownReasons = [];
            if (decision.tier) {
                for (const modelState of snapshot.models) {
                    if (!modelState.isAvailable) {
                        const remainingMs = modelState.cooldownUntil
                            ? Math.max(0, modelState.cooldownUntil - now)
                            : 0;
                        if (remainingMs > 0) {
                            cooldownReasons.push({
                                model: modelState.modelId,
                                remainingMs,
                                count: 1,
                                burstDampened: false
                            });
                        }
                    }
                }
            }

            // Determine matchedRule and classifierResult
            let matchedRule = null;
            let classifierResult = null;
            if (classification) {
                if (classification.reason.startsWith('rule:')) {
                    try {
                        matchedRule = JSON.parse(classification.reason.substring('rule: '.length));
                    } catch (e) {
                        matchedRule = null;
                    }
                } else if (classification.reason.startsWith('classifier:')) {
                    classifierResult = {
                        tier: classification.tier,
                        reason: classification.reason
                    };
                }
            }

            return {
                selectedModel: decision.model,
                tier: decision.tier,
                strategy: decision.strategy || null,
                reason: decision.reason,
                source: decision.source,
                mode: 'stateful',
                snapshotTimestamp: snapshot.timestamp,
                matchedRule,
                classifierResult,
                cooldownReasons,
                scoringTable: decision.scoringTable || null,
                features,
                trace: decision.trace || null
            };
        } finally {
            // Restore original state (no side effects)
            this._inFlight = originalInFlight;
            this._cooldowns = originalCooldowns;
            this._recentPool429s = originalRecent429s;
        }
    }

    /**
     * Get the candidate models for a tier config.
     * Supports both v2 (models[]) and v1 (targetModel + fallbackModels).
     * @private
     * @param {Object} tierConfig - The tier configuration
     * @returns {string[]} Array of candidate models in order
     */
    _getCandidates(tierConfig) {
        // v2: models[] ordered array
        if (Array.isArray(tierConfig.models)) {
            return [...tierConfig.models];  // Return copy
        }
        // v1: targetModel + fallbackModels
        const candidates = [tierConfig.targetModel];
        const fallbacks = this._resolveFallbackList(tierConfig);
        if (fallbacks.length > 0) {
            candidates.push(...fallbacks);
        }
        return candidates.filter(Boolean);
    }

    /**
     * Produce a deterministic pseudo-random roll (0-100) for dry-run paths.
     * This keeps explain/simulate stable even when rollout logic is probabilistic.
     * @private
     * @param {Object} context
     * @param {Object} features
     * @param {string} tierName
     * @param {string[]} candidates
     * @returns {number}
     */
    _computeDeterministicRoll(context, features, tierName, candidates) {
        const seed = [
            context?.requestModel || '',
            features?.maxTokens ?? '',
            features?.messageCount ?? '',
            features?.systemLength ?? '',
            features?.hasTools ? 1 : 0,
            features?.hasVision ? 1 : 0,
            tierName || '',
            Array.isArray(candidates) ? candidates.join(',') : ''
        ].join('|');

        // FNV-1a 32-bit
        let hash = 2166136261;
        for (let i = 0; i < seed.length; i++) {
            hash ^= seed.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return ((hash >>> 0) % 10000) / 100;
    }

    /**
     * Create an accumulator for decision-time counter deltas.
     * These deltas are applied only in commitDecision().
     * @private
     * @returns {Object}
     */
    _createDecisionMeta() {
        return {
            traceSampledTotal: 0,
            traceSampledIncluded: 0,
            byFallbackReason: {
                not_in_candidates: 0,
                cooldown: 0,
                at_capacity: 0,
                tier_exhausted: 0
            },
            glm5EligibleTotal: 0,
            glm5PreferenceApplied: 0,
            glm5PreferenceShadow: 0,
            tierDowngradeShadow: 0,
            tierDowngradeShadowByRoute: {}
        };
    }

    /**
     * Attach non-enumerable commit metadata to a decision.
     * @private
     * @param {Object|null} decision
     * @param {Object} meta
     */
    _attachDecisionMeta(decision, meta) {
        if (!decision || !meta) return;
        Object.defineProperty(decision, '__commitMeta', {
            value: meta,
            enumerable: false,
            writable: true,
            configurable: true
        });
    }

    /**
     * Consume (read + detach) non-enumerable commit metadata from a decision.
     * @private
     * @param {Object|null} decision
     * @returns {Object|null}
     */
    _consumeDecisionMeta(decision) {
        if (!decision || !decision.__commitMeta) return null;
        const meta = decision.__commitMeta;
        delete decision.__commitMeta;
        return meta;
    }

    /**
     * Record fallback reason delta into decision metadata.
     * @private
     * @param {Object|null} decisionMeta
     * @param {string} reason
     */
    _recordFallbackReasonDelta(decisionMeta, reason) {
        if (!decisionMeta || !decisionMeta.byFallbackReason) return;
        decisionMeta.byFallbackReason[reason] = (decisionMeta.byFallbackReason[reason] || 0) + 1;
    }

    /**
     * Record shadow tier-downgrade delta into decision metadata.
     * @private
     * @param {Object|null} decisionMeta
     * @param {string} fromTier
     * @param {string} toTier
     */
    _recordTierDowngradeShadowDelta(decisionMeta, fromTier, toTier) {
        if (!decisionMeta) return;
        if (VALID_TIER_LABELS.has(fromTier) && VALID_TIER_LABELS.has(toTier)) {
            const routeKey = fromTier + '->' + toTier;
            decisionMeta.tierDowngradeShadowByRoute[routeKey] =
                (decisionMeta.tierDowngradeShadowByRoute[routeKey] || 0) + 1;
        }
        decisionMeta.tierDowngradeShadow++;
    }

    /**
     * Apply GLM-5 preference logic for staged rollout.
     * Called from _computePoolSelection after scoring, before final sort.
     *
     * - enabled=false: score=-Infinity (never selected unless explicit override)
     * - preferencePercent=0: shadow counter only (no score modification)
     * - preferencePercent=N: N% chance of boosting glm-5 score to Infinity
     *
     * Shadow counter ALWAYS increments for eligible requests (even at 0%).
     * @private
     */
    _applyGlm5Preference(tierName, candidates, scored, options) {
        if (tierName !== 'heavy') return scored;

        const glm5Config = this.config.glm5 || {};
        const enabled = glm5Config.enabled !== false;  // default true
        const percent = Math.max(0, Math.min(100, glm5Config.preferencePercent ?? 0));
        const glm5Model = 'glm-5';  // Could be config-driven: glm5Config.modelId || 'glm-5'
        const dryRun = options && options.dryRun;
        const decisionMeta = options && options.decisionMeta;

        // Check if glm-5 is in scored candidates (not just in the original candidates list)
        const glm5Entry = scored.find(s => s.model === glm5Model);
        if (!glm5Entry) return scored;

        // Disabled: score=-Infinity (stays visible but never wins selection)
        if (!enabled) {
            glm5Entry.score = -Infinity;
            glm5Entry.disabled = true;
            return scored;
        }

        // Always count eligibility (the whole point of shadow mode)
        if (!dryRun && decisionMeta) decisionMeta.glm5EligibleTotal++;

        const roll = Number.isFinite(options?.deterministicRoll)
            ? options.deterministicRoll
            : Math.random() * 100;
        if (roll < percent) {
            // ACTIVE: Boost glm-5 to guaranteed selection
            glm5Entry.score = Infinity;
            glm5Entry.position = -1;  // Wins in quality sort too
            if (!dryRun && decisionMeta) decisionMeta.glm5PreferenceApplied++;
        } else {
            // SHADOW: Record what would have happened without modifying scores
            if (!dryRun && decisionMeta) decisionMeta.glm5PreferenceShadow++;
        }

        return scored;
    }

    /**
     * Compute pool selection without mutating state.
     * Pure function - returns decision without acquiring slots.
     * @private
     * @param {string[]} candidates - Models to choose from
     * @param {Set<string>} attemptedModels - Models already tried
     * @param {Object} tierConfig - Tier configuration with strategy
     * @param {string} tierName - Tier name (e.g., 'heavy', 'medium', 'light')
     * @returns {Promise<Object|null>} Decision with scoring table
     */
    async _computePoolSelection(candidates, attemptedModels, tierConfig, tierName, options) {
        const dryRun = options && options.dryRun;
        const decisionMeta = options && options.decisionMeta;
        // Build scored array with position tracking
        const scored = [];
        for (let i = 0; i < candidates.length; i++) {
            const model = candidates[i];
            if (attemptedModels.has(model)) {
                if (!dryRun) this._recordFallbackReasonDelta(decisionMeta, 'not_in_candidates');
                continue;
            }
            if (this.getModelCooldown(model) > 0) {
                if (!dryRun) this._recordFallbackReasonDelta(decisionMeta, 'cooldown');
                continue;
            }

            const meta = await this._getModelMetaAsync(model);
            const _staticMax = (meta?.maxConcurrency || 2) * this._concurrencyMultiplier;
            const maxConcurrency = this.adaptiveConcurrency?.getEffectiveConcurrency(model) ?? _staticMax;
            const inFlight = this._inFlight.get(model) || 0;
            const available = maxConcurrency - inFlight;

            if (available <= 0) {
                if (!dryRun) this._recordFallbackReasonDelta(decisionMeta, 'at_capacity');
                continue;
            }

            // Context window pre-flight: skip models that can't fit this request
            const estimatedTokens = options && options.estimatedTokens;
            if (estimatedTokens > 0) {
                const contextLength = meta?.contextLength || 0;
                if (contextLength > 0 && estimatedTokens > contextLength) {
                    if (!dryRun) this._recordFallbackReasonDelta(decisionMeta, 'context_overflow');
                    continue;
                }
            }

            const costPerMillion = (meta?.pricing?.input || 0) + (meta?.pricing?.output || 0);
            const penaltyConfig = this.config.pool429Penalty || {};
            const hitCount = (penaltyConfig.enabled !== false)
                ? this.getPool429Count(model)
                : 0;

            scored.push({
                model,
                position: i,  // Track position for quality/balanced strategies
                available,
                maxConcurrency,
                costPerMillion,
                hitCount,
                inFlight
            });
        }

        // Apply GLM-5 preference (GLM5-07: staged rollout)
        // Must happen AFTER scoring array is built, BEFORE tier exhausted check and strategy sort
        this._applyGlm5Preference(tierName, candidates, scored, {
            dryRun,
            deterministicRoll: options?.deterministicRoll,
            decisionMeta
        });

        // Track tier exhausted if no candidates scored
        if (scored.length === 0) {
            if (!dryRun) this._recordFallbackReasonDelta(decisionMeta, 'tier_exhausted');
            return null;
        }

        const strategy = tierConfig?.strategy || 'balanced';
        let pick;

        switch (strategy) {
            case 'quality':
                // Sort by position ascending (first in list wins)
                scored.sort((a, b) => a.position - b.position);
                pick = scored[0];
                break;

            case 'throughput':
                // Original scoring: maximize weighted availability
                for (const s of scored) {
                    const penaltyWeight = (this.config.pool429Penalty || {}).penaltyWeight || 0.5;
                    const weight = 1 / (1 + s.hitCount * penaltyWeight);
                    s.score = s.available * weight;
                }
                // NORM-07: Add model name as final tiebreaker for deterministic ordering
                scored.sort((a, b) =>
                    b.score - a.score ||
                    a.costPerMillion - b.costPerMillion ||
                    b.maxConcurrency - a.maxConcurrency ||
                    a.model.localeCompare(b.model)
                );
                pick = scored[0];
                break;

            case 'balanced':
                // Weighted blend: 0.6 position, 0.4 capacity
                const maxPos = Math.max(...scored.map(s => s.position));
                for (const s of scored) {
                    const positionScore = 1 - (s.position / (maxPos + 1));  // 0.0 to 1.0
                    const capacityScore = s.available / s.maxConcurrency;  // 0.0 to 1.0
                    s.score = 0.6 * positionScore + 0.4 * capacityScore;
                }
                // NORM-07: Add model name as final tiebreaker for deterministic ordering
                scored.sort((a, b) => b.score - a.score || a.costPerMillion - b.costPerMillion || a.model.localeCompare(b.model));
                pick = scored[0];
                break;

            case 'pool':
                // Legacy pool strategy (same as throughput for backward compat)
                for (const s of scored) {
                    const penaltyWeight = (this.config.pool429Penalty || {}).penaltyWeight || 0.5;
                    const weight = 1 / (1 + s.hitCount * penaltyWeight);
                    s.score = s.available * weight;
                }
                // NORM-07: Add model name as final tiebreaker for deterministic ordering
                scored.sort((a, b) =>
                    b.score - a.score ||
                    a.costPerMillion - b.costPerMillion ||
                    b.maxConcurrency - a.maxConcurrency ||
                    a.model.localeCompare(b.model)
                );
                pick = scored[0];
                break;

            default:
                // Invalid strategy - default to balanced
                const maxPosD = Math.max(...scored.map(s => s.position));
                for (const s of scored) {
                    const positionScore = 1 - (s.position / (maxPosD + 1));
                    const capacityScore = s.available / s.maxConcurrency;
                    s.score = 0.6 * positionScore + 0.4 * capacityScore;
                }
                // NORM-07: Add model name as final tiebreaker for deterministic ordering
                scored.sort((a, b) => b.score - a.score || a.costPerMillion - b.costPerMillion || a.model.localeCompare(b.model));
                pick = scored[0];
        }

        return {
            model: pick.model,
            reason: strategy + ': ' + pick.available + '/' + pick.maxConcurrency + ' available' +
                    (scored.length > 1 ? ' (' + scored.length + ' candidates)' : ''),
            scoringTable: scored.map(s => ({
                model: s.model,
                position: s.position,
                score: s.score,
                available: s.available,
                maxConcurrency: s.maxConcurrency,
                cost: s.costPerMillion,
                hitCount: s.hitCount,
                selected: s.model === pick.model
            }))
        };
    }

    /**
     * Internal model selection logic (shared between normal and shadow mode).
     * Async to support pool strategy with ModelDiscovery.
     * @deprecated Use selectModel() which now always uses computeDecision() + commitDecision().
     * @private
     */
    async _selectModelInternal(context) {
        // 2. Per-request UI override (highest priority)
        // Skipped when context.skipOverrides is true (e.g., replay requests)
        if (!context.skipOverrides && context.override) {
            this._stats.bySource.override++;
            this._stats.total++;
            return {
                model: context.override,
                tier: null,
                reason: 'per-request override',
                source: 'override'
            };
        }

        // 3. Saved overrides (specific model key, then wildcard)
        // Skipped when context.skipOverrides is true (e.g., replay requests)
        if (!context.skipOverrides) {
            for (const key of [context.requestModel, '*']) {
                if (this._overrides.has(key)) {
                    const model = this._overrides.get(key);
                    this._stats.bySource['saved-override']++;
                    this._stats.total++;
                    return {
                        model,
                        tier: null,
                        reason: 'saved override for ' + key,
                        source: 'saved-override'
                    };
                }
            }
        }

        // 4. Feature extraction + classification
        const features = this.extractFeatures(context.parsedBody);
        const classification = this.classify(features);
        const estimatedTokens = this._estimateRequestTokens(context.parsedBody);

        // 5. Tier resolved → look up target model
        if (classification) {
            const tier = classification.tier;
            const tierConfig = this.config.tiers?.[tier];

            if (tierConfig) {
                const fallbacks = this._resolveFallbackList(tierConfig);
                const attemptedModels = context.attemptedModels || new Set();
                const targetModel = this._getTargetModel(tierConfig);

                // V2 CONFIGS: Use _computePoolSelection for models[] array
                // This handles pool, quality, throughput, balanced strategies uniformly
                if (Array.isArray(tierConfig.models) && tierConfig.models.length > 0) {
                    const candidates = [...new Set([...tierConfig.models, ...fallbacks])];
                    const poolResult = await this._computePoolSelection(candidates, attemptedModels, tierConfig, tier, { estimatedTokens });
                    if (poolResult) {
                        // Atomically acquire the slot to prevent TOCTOU race
                        this.acquireModel(poolResult.model);

                        this._stats.byTier[tier] = (this._stats.byTier[tier] || 0) + 1;

                        // Determine source based on strategy and classification origin
                        // Pool strategy: source is 'pool' regardless of rule/classifier origin
                        // Other strategies: source based on classification origin (rule vs classifier)
                        const isPoolStrategy = (tierConfig.strategy || 'balanced') === 'pool';
                        const source = isPoolStrategy ? 'pool' :
                            (classification.reason.startsWith('rule') ? 'rule' : 'classifier');
                        this._stats.bySource[source] = (this._stats.bySource[source] || 0) + 1;
                        this._stats.byStrategy[tierConfig.strategy || 'balanced'] =
                            (this._stats.byStrategy[tierConfig.strategy || 'balanced'] || 0) + 1;
                        this._stats.total++;

                        // Track upgrade reason for heavy tier (GLM5-04)
                        if (tier === 'heavy') {
                            const reason = this._classifyUpgradeReason(features);
                            this._stats.byUpgradeReason[reason] = (this._stats.byUpgradeReason[reason] || 0) + 1;
                        }

                        // Track per-model selection for heavy tier (GLM5-05)
                        if (tier === 'heavy' && poolResult.model) {
                            this._stats.byModel[poolResult.model] = (this._stats.byModel[poolResult.model] || 0) + 1;
                        }

                        return {
                            model: poolResult.model,
                            tier,
                            strategy: tierConfig.strategy || 'balanced',
                            reason: classification.reason + ' (' + poolResult.reason + ')',
                            source,
                            scoringTable: poolResult.scoringTable
                        };
                    }
                    // Pool exhausted → fall through to failover logic below
                }

                // LEGACY POOL STRATEGY (v1 only): distribute by available capacity
                if (tierConfig.strategy === 'pool') {
                    const candidates = [...new Set([targetModel, ...fallbacks])];
                    const selected = await this._selectFromPool(candidates, attemptedModels);
                    if (selected) {
                        this._stats.byTier[tier] = (this._stats.byTier[tier] || 0) + 1;
                        this._stats.bySource.pool = (this._stats.bySource.pool || 0) + 1;
                        this._stats.byStrategy.pool = (this._stats.byStrategy.pool || 0) + 1;
                        this._stats.total++;

                        // Track upgrade reason for heavy tier (GLM5-04)
                        if (tier === 'heavy') {
                            const reason = this._classifyUpgradeReason(features);
                            this._stats.byUpgradeReason[reason] = (this._stats.byUpgradeReason[reason] || 0) + 1;
                        }

                        // Track per-model selection for heavy tier (GLM5-05)
                        if (tier === 'heavy' && selected.model) {
                            this._stats.byModel[selected.model] = (this._stats.byModel[selected.model] || 0) + 1;
                        }

                        return {
                            model: selected.model,
                            tier,
                            reason: classification.reason + ' (' + selected.reason + ')',
                            source: 'pool'
                        };
                    }
                    // Pool exhausted → fall through to failover logic below
                }

                const maxSwitches = this.getEffectiveMaxSwitches(tier);
                const switchesSoFar = attemptedModels.size;  // models already tried = switches made
                const canSwitch = switchesSoFar < maxSwitches;

                const targetCooldown = this.getModelCooldown(targetModel);
                const targetUnavailable = targetCooldown > 0 || attemptedModels.has(targetModel);

                let model;
                let source;
                let reason = classification.reason;

                if (targetUnavailable && canSwitch && fallbacks.length > 0) {
                    // Try fallbacks in order — skip cooled and already-attempted
                    let foundFallback = false;
                    for (const fb of fallbacks) {
                        if (attemptedModels.has(fb)) continue;
                        if (this.getModelCooldown(fb) > 0) continue;
                        model = fb;
                        source = 'failover';
                        reason += ' (failover: ' + targetModel + ' unavailable)';
                        foundFallback = true;
                        break;
                    }
                    if (!foundFallback) {
                        // All fallbacks cooled/attempted — pick the candidate with shortest cooldown
                        // This gives the best chance of succeeding after the backoff sleep
                        const allCandidates = [targetModel, ...fallbacks];
                        let bestModel = targetModel;
                        let shortestCooldown = Infinity;
                        for (const candidate of allCandidates) {
                            if (attemptedModels.has(candidate)) continue;
                            const cd = this.getModelCooldown(candidate);
                            if (cd < shortestCooldown) {
                                shortestCooldown = cd;
                                bestModel = candidate;
                            }
                        }
                        model = bestModel;
                        source = classification.reason.startsWith('rule') ? 'rule' : 'classifier';
                        if (shortestCooldown > 0 && shortestCooldown < Infinity) {
                            reason += ' (warning: all candidates unavailable, least-cooldown: ' + model + ' ' + shortestCooldown + 'ms)';
                        } else {
                            reason += ' (warning: all candidates unavailable)';
                        }
                    }
                } else if (targetUnavailable) {
                    // Can't switch (cap reached or no fallbacks) — best effort
                    model = targetModel;
                    source = classification.reason.startsWith('rule') ? 'rule' : 'classifier';
                    if (!canSwitch) {
                        reason += ' (warning: maxModelSwitchesPerRequest reached)';
                    } else {
                        reason += ' (warning: targetModel cooled down, no fallback available)';
                    }
                } else {
                    // Normal routing — target available
                    model = targetModel;
                    source = classification.reason.startsWith('rule') ? 'rule' : 'classifier';
                }

                // TIER DOWNGRADE: When current tier is effectively exhausted
                // (all candidates attempted or in cooldown), try a lower tier.
                const tierExhausted = source !== 'pool' && source !== 'failover' &&
                    reason.includes('warning:');
                if (tierExhausted) {
                    const failover = this.config.failover || {};
                    const downgradeOrder = failover.downgradeOrder || ['medium', 'light'];
                    const maxDowngrades = failover.maxTierDowngradesPerRequest ?? 1;
                    const tierDowngrades = context._tierDowngrades || 0;
                    const allowDowngrade = failover.allowTierDowngrade === true;

                    // Try each tier in downgrade order
                    for (const downgradeTier of downgradeOrder) {
                        if (downgradeTier === tier) continue;  // Skip same tier
                        const downgradeTierConfig = this.config.tiers?.[downgradeTier];
                        if (!downgradeTierConfig) continue;

                        // Try pool selection in the downgrade tier
                        const downgradeTargetModel = this._getTargetModel(downgradeTierConfig);
                        const downgradeCandidates = [
                            downgradeTargetModel,
                            ...(this._resolveFallbackList(downgradeTierConfig))
                        ].filter(m => !attemptedModels.has(m));

                        if (downgradeCandidates.length === 0) continue;

                        // Check if any candidate is available (not in cooldown)
                        let downgradeModel = null;
                        if (downgradeTierConfig.strategy === 'pool') {
                            const selected = await this._selectFromPool(downgradeCandidates, attemptedModels);
                            if (selected) downgradeModel = selected.model;
                        } else {
                            for (const c of downgradeCandidates) {
                                if (this.getModelCooldown(c) <= 0) {
                                    downgradeModel = c;
                                    break;
                                }
                            }
                        }

                        if (downgradeModel) {
                            if (allowDowngrade && tierDowngrades < maxDowngrades) {
                                // ACTIVE DOWNGRADE: Use the lower tier model
                                this._stats.tierDowngradeTotal++;
                                if (VALID_TIER_LABELS.has(tier) && VALID_TIER_LABELS.has(downgradeTier)) {
                                    const routeKey = `${tier}->${downgradeTier}`;
                                    this._stats.tierDowngradeByRoute[routeKey] = (this._stats.tierDowngradeByRoute[routeKey] || 0) + 1;
                                }
                                this._stats.bySource.tier_downgrade = (this._stats.bySource.tier_downgrade || 0) + 1;
                                this._stats.byTier[downgradeTier] = (this._stats.byTier[downgradeTier] || 0) + 1;
                                const downgradeStrategy = downgradeTierConfig.strategy || 'balanced';
                                if (this._stats.byStrategy.hasOwnProperty(downgradeStrategy)) {
                                    this._stats.byStrategy[downgradeStrategy]++;
                                }
                                this._stats.total++;
                                return {
                                    model: downgradeModel,
                                    tier: downgradeTier,
                                    reason: classification.reason + ' (tier_downgrade: ' + tier + ' exhausted → ' + downgradeTier + ')',
                                    source: 'tier_downgrade',
                                    degradedFromTier: tier
                                };
                            } else {
                                // SHADOW MODE: Log what we would have done, but don't actually downgrade
                                if (VALID_TIER_LABELS.has(tier) && VALID_TIER_LABELS.has(downgradeTier)) {
                                    const shadowRouteKey = `${tier}->${downgradeTier}`;
                                    this._stats.tierDowngradeShadowByRoute[shadowRouteKey] = (this._stats.tierDowngradeShadowByRoute[shadowRouteKey] || 0) + 1;
                                }
                                this._stats.tierDowngradeShadow++;
                                break;  // Only record one shadow event per request
                            }
                        }
                    }
                }

                this._stats.byTier[tier] = (this._stats.byTier[tier] || 0) + 1;
                this._stats.bySource[source] = (this._stats.bySource[source] || 0) + 1;
                const strategy = tierConfig.strategy || 'balanced';
                if (this._stats.byStrategy.hasOwnProperty(strategy)) {
                    this._stats.byStrategy[strategy]++;
                }
                this._stats.total++;

                // Track upgrade reason for heavy tier (GLM5-04)
                if (tier === 'heavy' && (source === 'classifier' || source === 'rule' || source === 'pool')) {
                    const reason = this._classifyUpgradeReason(features);
                    this._stats.byUpgradeReason[reason] = (this._stats.byUpgradeReason[reason] || 0) + 1;
                }

                // Track per-model selection for heavy tier (GLM5-05)
                if (tier === 'heavy' && model) {
                    this._stats.byModel[model] = (this._stats.byModel[model] || 0) + 1;
                }

                return { model, tier, reason, source };
            }
        }

        // 6. Default model fallback
        if (this.config.defaultModel) {
            this._stats.bySource.default++;
            this._stats.total++;
            return {
                model: this.config.defaultModel,
                tier: null,
                reason: 'default model',
                source: 'default'
            };
        }

        // 7. Nothing matched → caller falls through to legacy
        return null;
    }

    // ---------------------------------------------------------------
    // Cooldown management
    // ---------------------------------------------------------------

    /**
     * Record that a model hit a rate limit / error requiring cooldown.
     *
     * @param {string} model
     * @param {number} retryAfterMs - The retry-after value from the upstream
     */
    recordModelCooldown(model, retryAfterMs, options = {}) {
        const cooldownConfig = this.config.cooldown || {};
        const backoffMultiplier = cooldownConfig.backoffMultiplier || 2;
        const maxMs = cooldownConfig.maxMs || 30000;
        const maxEntries = cooldownConfig.maxCooldownEntries || 50;

        // Evict oldest entry if at capacity and this is a new model
        if (!this._cooldowns.has(model) && this._cooldowns.size >= maxEntries) {
            let oldestKey = null;
            let oldestHit = Infinity;
            for (const [k, v] of this._cooldowns) {
                if (v.lastHit < oldestHit) {
                    oldestHit = v.lastHit;
                    oldestKey = k;
                }
            }
            if (oldestKey) this._cooldowns.delete(oldestKey);
        }

        const entry = this._cooldowns.get(model) || { count: 0, cooldownUntil: 0, lastHit: 0, lastBurstDampened: false };

        if (options.burstDampened) {
            // Pool burst: skip count increment to prevent backoff escalation
            entry.lastBurstDampened = true;
            this._stats.burstDampenedTotal++;
        } else {
            entry.count++;
            entry.lastBurstDampened = false;
        }

        const cooldownMs = Math.min(
            retryAfterMs * Math.pow(backoffMultiplier, Math.max(0, entry.count - 1)),
            maxMs
        );
        // Never shorten existing cooldown
        entry.cooldownUntil = Math.max(entry.cooldownUntil, Date.now() + cooldownMs);
        entry.lastHit = Date.now();

        this._cooldowns.set(model, entry);
    }

    /**
     * Get remaining cooldown time for a model (0 = not cooled down).
     *
     * @param {string} model
     * @returns {number} Remaining milliseconds
     */
    getModelCooldown(model) {
        const entry = this._cooldowns.get(model);
        if (!entry) return 0;

        const cooldownConfig = this.config.cooldown || {};
        const decayMs = cooldownConfig.decayMs || 60000;

        if (Date.now() - entry.lastHit > decayMs) {
            this._cooldowns.delete(model);
            return 0;
        }

        return Math.max(0, entry.cooldownUntil - Date.now());
    }

    /**
     * Record a 429 hit for pool penalty scoring.
     * Unlike recordModelCooldown, this always increments (even burst-dampened).
     * @param {string} model
     */
    recordPool429(model) {
        const config = this.config.pool429Penalty || {};
        if (config.enabled === false) return;

        // Bound the map: evict the model whose most recent 429 is oldest (least active)
        const maxModels = config.maxModels || 50;
        if (!this._recentPool429s.has(model) && this._recentPool429s.size >= maxModels) {
            let evictKey = null;
            let oldestLastHit = Infinity;
            for (const [k, v] of this._recentPool429s) {
                const lastHit = v.length > 0 ? v[v.length - 1] : 0;
                if (lastHit < oldestLastHit) {
                    oldestLastHit = lastHit;
                    evictKey = k;
                }
            }
            if (evictKey) this._recentPool429s.delete(evictKey);
        }

        const timestamps = this._recentPool429s.get(model) || [];
        timestamps.push(Date.now());
        this._recentPool429s.set(model, timestamps);
    }

    /**
     * Get the 429 count within the sliding window for pool penalty scoring.
     * Prunes expired entries on read.
     * @param {string} model
     * @returns {number}
     */
    getPool429Count(model) {
        const config = this.config.pool429Penalty || {};
        const windowMs = config.windowMs || 120000;
        const maxHits = config.maxPenaltyHits || 20;

        const timestamps = this._recentPool429s.get(model);
        if (!timestamps || timestamps.length === 0) return 0;

        // Prune expired entries
        const cutoff = Date.now() - windowMs;
        const valid = timestamps.filter(t => t > cutoff);

        if (valid.length === 0) {
            this._recentPool429s.delete(model);
            return 0;
        }

        // Cap stored timestamps to maxHits to bound per-model memory
        const bounded = valid.length > maxHits ? valid.slice(-maxHits) : valid;
        this._recentPool429s.set(model, bounded);
        return bounded.length;
    }

    /**
     * Get pool 429 penalty stats for observability.
     * Includes per-model hit count, last-seen timestamp, and decay ETA
     * so operators can diagnose oscillation patterns in /stats output.
     *
     * NOTE: Oscillation risk — a model penalised heavily will shed traffic,
     * its 429 count will decay, and it re-enters the pool at lower priority.
     * If it then gets hammered again the cycle repeats.  If oscillation is
     * observed, consider increasing windowMs or adding admission-hold logic
     * (a minimum cool-off period before a model regains full weight).
     *
     * @returns {Object}
     */
    getPool429PenaltyStats() {
        const config = this.config.pool429Penalty || {};
        const windowMs = config.windowMs || 120000;
        const now = Date.now();
        const byModel = {};
        for (const [model, timestamps] of this._recentPool429s) {
            const count = this.getPool429Count(model);
            if (count === 0) continue;
            const refreshed = this._recentPool429s.get(model) || [];
            const lastSeen = refreshed.length > 0 ? refreshed[refreshed.length - 1] : 0;
            const oldest = refreshed.length > 0 ? refreshed[0] : 0;
            byModel[model] = {
                hits: count,
                lastSeenMs: lastSeen ? now - lastSeen : null,
                decayEtaMs: oldest ? Math.max(0, (oldest + windowMs) - now) : 0,
            };
        }
        return {
            enabled: config.enabled !== false,
            windowMs,
            trackedModels: Object.keys(byModel).length,
            byModel,
        };
    }

    /**
     * Get the effective max switches for a tier, clamped to candidates - 1.
     * Centralises the read so the runtime can never exceed available models.
     *
     * @param {string} tierName
     * @returns {number} Effective max switches (>= 0)
     */
    getEffectiveMaxSwitches(tierName) {
        const configured = this.config.failover?.maxModelSwitchesPerRequest ?? 1;
        const tierConfig = this.config.tiers?.[tierName];
        if (!tierConfig) return configured;

        const targetModel = this._getTargetModel(tierConfig);
        const fallbacks = this._resolveFallbackList(tierConfig);
        const uniqueCandidates = new Set([targetModel, ...fallbacks].filter(Boolean));
        // The code uses attemptedModels.size < maxSwitches as the gate,
        // so the budget equals the total number of unique candidates.
        return Math.min(configured, uniqueCandidates.size);
    }

    /**
     * Get the next available fallback model for a tier.
     *
     * @param {Object} options
     * @param {string} options.tier - The tier name
     * @param {Set<string>} [options.attemptedModels] - Models already tried
     * @returns {string|null} Next available model, or null if exhausted
     */
    getNextFallback({ tier, attemptedModels = new Set() }) {
        if (!this.enabled) return null;

        const maxSwitches = this.getEffectiveMaxSwitches(tier);
        if (attemptedModels.size > maxSwitches) return null;

        const tierConfig = this.config.tiers?.[tier];
        if (!tierConfig) return null;

        const targetModel = this._getTargetModel(tierConfig);
        const fallbacks = this._resolveFallbackList(tierConfig);
        const candidates = [targetModel, ...fallbacks];

        // First pass: find a model not attempted and not cooled
        for (const model of candidates) {
            if (attemptedModels.has(model)) continue;
            if (this.getModelCooldown(model) > 0) continue;
            return model;
        }

        // Second pass: find any model not attempted (even if cooled — best effort)
        for (const model of candidates) {
            if (!attemptedModels.has(model)) return model;
        }

        return null;
    }

    // ---------------------------------------------------------------
    // Pool strategy (load-balanced selection)
    // ---------------------------------------------------------------

    /**
     * Select the least-loaded model from a pool of candidates.
     * Async method to support ModelDiscovery metadata lookup.
     * @private
     * @param {string[]} candidates - Models to choose from
     * @param {Set<string>} attemptedModels - Models already tried
     * @returns {Promise<{ model: string, reason: string } | null>}
     */
    async _selectFromPool(candidates, attemptedModels) {
        const scored = [];
        for (const model of candidates) {
            if (attemptedModels.has(model)) {
                // GLM5-06: Track models skipped because they were already attempted
                this._stats.byFallbackReason.not_in_candidates =
                    (this._stats.byFallbackReason.not_in_candidates || 0) + 1;
                continue;
            }
            if (this.getModelCooldown(model) > 0) {
                // GLM5-06: Track models skipped due to cooldown
                this._stats.byFallbackReason.cooldown =
                    (this._stats.byFallbackReason.cooldown || 0) + 1;
                continue;
            }

            const meta = await this._getModelMetaAsync(model);
            const _poolStaticMax = (meta?.maxConcurrency || 2) * this._concurrencyMultiplier;
            const maxConcurrency = this.adaptiveConcurrency?.getEffectiveConcurrency(model) ?? _poolStaticMax;
            const inFlight = this._inFlight.get(model) || 0;
            const available = maxConcurrency - inFlight;

            if (available <= 0) {
                // GLM5-06: Track models skipped due to being at capacity
                this._stats.byFallbackReason.at_capacity =
                    (this._stats.byFallbackReason.at_capacity || 0) + 1;
                continue;
            }

            const costPerMillion = (meta?.pricing?.input || 0) + (meta?.pricing?.output || 0);

            // 429-aware scoring: penalize models with high rate-limit hit counts.
            // Uses sliding window counter (independent of cooldown entries).
            const penaltyConfig = this.config.pool429Penalty || {};
            const hitCount = (penaltyConfig.enabled !== false) ? this.getPool429Count(model) : 0;
            const penaltyWeight = penaltyConfig.penaltyWeight || 0.5;
            const weight = 1 / (1 + hitCount * penaltyWeight);
            const score = available * weight;

            scored.push({ model, available, maxConcurrency, costPerMillion, hitCount, score });
        }

        // GLM5-06: Track tier exhaustion when no candidates scored
        if (scored.length === 0) {
            this._stats.byFallbackReason.tier_exhausted =
                (this._stats.byFallbackReason.tier_exhausted || 0) + 1;
            return null;
        }

        // Sort: highest weighted score first, break ties by lower cost, then higher capacity
        scored.sort((a, b) =>
            b.score - a.score ||
            a.costPerMillion - b.costPerMillion ||
            b.maxConcurrency - a.maxConcurrency
        );

        const pick = scored[0];

        // Atomically acquire the slot to prevent TOCTOU race:
        // Without this, concurrent requests all see the same available count
        // and all pick the same model before any of them call acquireModel().
        this.acquireModel(pick.model);

        return {
            model: pick.model,
            reason: 'pool: ' + pick.available + '/' + pick.maxConcurrency + ' available' +
                    (scored.length > 1 ? ' (' + scored.length + ' candidates)' : '')
        };
    }

    /**
     * Acquire a pool slot for a model (increment in-flight count).
     * Call this when a request starts using a model.
     * @param {string} model
     */
    acquireModel(model) {
        if (!model) return;
        this._inFlight.set(model, (this._inFlight.get(model) || 0) + 1);
    }

    /**
     * Release a pool slot for a model (decrement in-flight count).
     * Call this when a request completes or fails.
     * @param {string} model
     */
    releaseModel(model) {
        if (!model) return;
        const count = this._inFlight.get(model) || 0;
        if (count > 1) {
            this._inFlight.set(model, count - 1);
        } else {
            this._inFlight.delete(model);
        }
    }

    /**
     * Get pool status for all tiers with strategy: 'pool'.
     * Async method to support ModelDiscovery metadata lookup.
     * @returns {Promise<Object>} Per-tier pool utilization data
     */
    async getPoolStatus() {
        const result = {};
        for (const [tier, cfg] of Object.entries(this.config.tiers || {})) {
            if (cfg.strategy !== 'pool') continue;
            const targetModel = this._getTargetModel(cfg);
            const candidates = [...new Set([targetModel, ...this._resolveFallbackList(cfg)])];
            result[tier] = await Promise.all(candidates.map(async model => {
                const meta = await this._getModelMetaAsync(model);
                const staticMaxConc = (meta?.maxConcurrency || 2) * this._concurrencyMultiplier;
                const maxConc = this.adaptiveConcurrency?.getEffectiveConcurrency(model) ?? staticMaxConc;
                const inFlight = this._inFlight.get(model) || 0;
                const cooldownMs = this.getModelCooldown(model);
                return {
                    model,
                    inFlight,
                    maxConcurrency: maxConc,
                    staticMaxConcurrency: staticMaxConc,
                    cooldownMs,
                    available: Math.max(0, maxConc - inFlight)
                };
            }));
        }
        return result;
    }

    /**
     * Get a formal pool status snapshot with ModelPoolSnapshot schema.
     * Async method to support ModelDiscovery metadata lookup.
     *
     * @returns {Promise<ModelPoolSnapshot>} Formal schema snapshot with:
     *   - schemaVersion: 1
     *   - ts: timestamp
     *   - pools: object with tier names as keys
     *   - Each pool entry: model, inFlight, maxConcurrency, available,
     *     recent429 (null), latencyP95 (null), errorRate (null), cost
     */
    async getModelPoolSnapshot() {
        const pools = {};
        for (const [tier, cfg] of Object.entries(this.config.tiers || {})) {
            const candidates = this._getCandidates(cfg);
            pools[tier] = await Promise.all(candidates.map(async model => {
                const meta = await this._getModelMetaAsync(model);
                const staticMaxConc = (meta?.maxConcurrency || 2) * this._concurrencyMultiplier;
                const maxConc = this.adaptiveConcurrency?.getEffectiveConcurrency(model) ?? staticMaxConc;
                const inFlight = this._inFlight.get(model) || 0;

                return {
                    model,
                    inFlight,
                    maxConcurrency: maxConc,
                    staticMaxConcurrency: staticMaxConc,
                    available: Math.max(0, maxConc - inFlight),
                    recent429: null,  // TODO: Track recent 429s
                    latencyP95: null,  // TODO: Track latency
                    errorRate: null,   // TODO: Track error rate
                    cost: (meta?.pricing?.input || 0) + (meta?.pricing?.output || 0)
                };
            }));
        }

        return {
            schemaVersion: 1,
            ts: Date.now(),
            pools
        };
    }

    // ---------------------------------------------------------------
    // ARCH-01: Snapshot Interfaces for Drift Detection
    // ---------------------------------------------------------------

    /**
     * Get snapshot of a single model pool state
     * ARCH-01: Shared getModelPoolSnapshot(modelId) interface formalized
     *
     * @param {string} modelId - Model identifier
     * @returns {Promise<Object|null>} PoolSnapshotModel object or null if model unknown
     */
    async getModelPoolSnapshotById(modelId) {
        // Get model metadata from discovery
        const model = await this._modelDiscovery.getMetadata(modelId);
        if (!model) {
            return null;
        }

        // Find which tier this model belongs to
        let tier = null;
        for (const [tierName, tierConfig] of Object.entries(this.config.tiers || {})) {
            const candidates = this._getCandidates(tierConfig);
            if (candidates.includes(modelId)) {
                tier = tierName;
                break;
            }
        }

        // Build snapshot following PoolSnapshotSchema
        const _snapStaticMax = (model.maxConcurrency || 2) * this._concurrencyMultiplier;
        return {
            version: '1.0',  // PoolSnapshotSchema.VERSION
            modelId,
            tier,
            inFlight: this._inFlight.get(modelId) || 0,
            maxConcurrency: this.adaptiveConcurrency?.getEffectiveConcurrency(modelId) ?? _snapStaticMax,
            staticMaxConcurrency: _snapStaticMax,
            isAvailable: this.getModelCooldown(modelId) === 0,
            cooldownUntil: this._cooldowns.has(modelId) ? this._cooldowns.get(modelId).cooldownUntil : null
        };
    }

    /**
     * Get snapshots for all models in a tier
     * @param {'light'|'medium'|'heavy'} tier - Tier name
     * @returns {Promise<Array<Object>>} Array of PoolSnapshotModel objects
     */
    async getTierSnapshot(tier) {
        const tierConfig = this.config.tiers?.[tier];
        if (!tierConfig) {
            return [];
        }

        const models = this._getCandidates(tierConfig);
        const snapshots = [];

        for (const modelId of models) {
            const snapshot = await this.getModelPoolSnapshotById(modelId);
            if (snapshot !== null) {
                snapshots.push(snapshot);
            }
        }

        return snapshots;
    }

    /**
     * Get snapshot of entire model pool (all tiers)
     * Follows PoolSnapshotSchema v1.0 structure
     * @returns {Promise<Object>} PoolSnapshot with version, timestamp, models array
     */
    async getPoolSnapshotAll() {
        const allModels = [];

        for (const tier of ['light', 'medium', 'heavy']) {
            const tierSnapshot = await this.getTierSnapshot(tier);
            allModels.push(...tierSnapshot);
        }

        return {
            version: '1.0',  // PoolSnapshotSchema.VERSION
            timestamp: Date.now(),
            models: allModels
        };
    }

    // ---------------------------------------------------------------
    // Override management
    // ---------------------------------------------------------------

    /**
     * Set a routing override for a given client model key.
     *
     * @param {string} key - Client model string or '*'
     * @param {string} model - Target GLM model
     */
    setOverride(key, model) {
        const maxOverrides = this.config.maxOverrides || 100;
        if (!this._overrides.has(key) && this._overrides.size >= maxOverrides) {
            this._logger.warn?.('[ModelRouter] Override limit reached (' + maxOverrides + '), rejecting key: ' + key);
            return false;
        }
        this._overrides.set(key, model);
        if (this._persistEnabled) {
            this._persistOverrides();
        }
        return true;
    }

    /**
     * Clear a routing override.
     *
     * @param {string} key
     */
    clearOverride(key) {
        this._overrides.delete(key);
        if (this._persistEnabled) {
            this._persistOverrides();
        }
    }

    /** Get all current overrides as a plain object. */
    getOverrides() {
        return Object.fromEntries(this._overrides);
    }

    // ---------------------------------------------------------------
    // Introspection
    // ---------------------------------------------------------------

    /**
     * Get all active cooldowns as a plain object.
     *
     * @returns {Object.<string, { remainingMs: number, count: number }>}
     */
    getCooldowns() {
        const result = {};
        for (const [model, entry] of this._cooldowns) {
            const remaining = this.getModelCooldown(model);
            if (remaining > 0) {
                result[model] = { remainingMs: remaining, count: entry.count, burstDampened: entry.lastBurstDampened || false };
            }
        }
        return result;
    }

    /** Get a copy of routing stats. */
    getStats() {
        return {
            byTier: { ...this._stats.byTier },
            bySource: { ...this._stats.bySource },
            byStrategy: { ...this._stats.byStrategy },
            shadowDecisions: this._stats.shadowDecisions,
            total: this._stats.total,
            burstDampenedTotal: this._stats.burstDampenedTotal,
            tierDowngradeTotal: this._stats.tierDowngradeTotal,
            tierDowngradeShadow: this._stats.tierDowngradeShadow,
            tierDowngradeByRoute: { ...this._stats.tierDowngradeByRoute },
            tierDowngradeShadowByRoute: { ...this._stats.tierDowngradeShadowByRoute },
            // GLM5-04: Upgrade reason counters
            byUpgradeReason: { ...this._stats.byUpgradeReason },
            // GLM5-05: Per-model selection counters (heavy tier only)
            byModel: { ...this._stats.byModel },
            // GLM5-06: Fallback reason counters
            byFallbackReason: { ...this._stats.byFallbackReason },
            // GLM5-07: Staged rollout counters
            glm5EligibleTotal: this._stats.glm5EligibleTotal,
            glm5PreferenceApplied: this._stats.glm5PreferenceApplied,
            glm5PreferenceShadow: this._stats.glm5PreferenceShadow,
            // TRUST-03: Trace sampling counters
            traceSampledTotal: this._stats.traceSampledTotal,
            traceSampledIncluded: this._stats.traceSampledIncluded,
            // Context overflow counters
            contextOverflowTotal: this._stats.contextOverflowTotal,
            contextOverflowByModel: { ...this._stats.contextOverflowByModel },
            contextOverflowByTier: { ...this._stats.contextOverflowByTier },
            contextOverflowByCause: { ...this._stats.contextOverflowByCause },
            // GLM5-05: Heavy models list for Prometheus labels (bounded)
            heavyModels: this.config.tiers?.heavy?.models || [],
            // Cold-start warmup gating
            failoverWarmupTotal: this._stats.failoverWarmupTotal,
            isWarmingUp: (Date.now() - this._startedAt) < this._warmupDurationMs
        };
    }

    // ---------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------

    /**
     * Get the last shadow routing decision (when shadow mode was active).
     * @returns {Object|null} Last shadow decision with shadowMode: true flag
     */
    getLastShadowDecision() {
        return this._lastShadowDecision;
    }

    /** Reset all transient state (overrides, cooldowns, stats, in-flight). */
    reset() {
        this._overrides.clear();
        this._cooldowns.clear();
        this._inFlight.clear();
        this._recentPool429s.clear();
        this._lastShadowDecision = null;
        this._stats = {
            byTier: { light: 0, medium: 0, heavy: 0 },
            bySource: {
                override: 0,
                'saved-override': 0,
                rule: 0,
                classifier: 0,
                default: 0,
                failover: 0,
                pool: 0
            },
            byStrategy: { quality: 0, throughput: 0, balanced: 0, pool: 0 },
            shadowDecisions: 0,
            total: 0,
            burstDampenedTotal: 0,
            tierDowngradeTotal: 0,
            tierDowngradeShadow: 0,
            tierDowngradeByRoute: {},
            tierDowngradeShadowByRoute: {},
            // GLM5-04: Upgrade reason counters
            byUpgradeReason: Object.fromEntries(UPGRADE_REASONS.map(r => [r, 0])),
            // GLM5-05: Per-model selection counters (heavy tier only)
            byModel: {},
            // GLM5-06: Fallback reason counters
            byFallbackReason: Object.fromEntries(FALLBACK_REASONS.map(r => [r, 0])),
            // GLM5-07: Staged rollout counters
            glm5EligibleTotal: 0,
            glm5PreferenceApplied: 0,
            glm5PreferenceShadow: 0,
            // Context overflow counters
            contextOverflowTotal: 0,
            contextOverflowByModel: {},
            contextOverflowByTier: {},
            contextOverflowByCause: { genuine: 0, transient_unavailable: 0 }
        };
        if (this._persistEnabled) {
            this._persistOverrides();
        }
    }

    /**
     * Hot-update the config without losing cooldown / override state.
     *
     * @param {Object} config
     */
    updateConfig(config) {
        this.config = { ...config };
        this._validateTierOverlaps();
    }

    // ---------------------------------------------------------------
    // Serialisation
    // ---------------------------------------------------------------

    /** Return a full state snapshot suitable for JSON. */
    toJSON() {
        // NORM-04: Ensure tiers output only includes models[] at top level
        // After normalization, all tiers are v2 format with models[] array
        // No v1 fields (targetModel, fallbackModels, failoverModel) remain in memory
        const processedTiers = {};

        if (this.config.tiers) {
            for (const [tierName, tierConfig] of Object.entries(this.config.tiers)) {
                if (!tierConfig || typeof tierConfig !== 'object') {
                    processedTiers[tierName] = tierConfig;
                    continue;
                }

                // Build v2-compliant tier output
                const processedTier = {
                    strategy: tierConfig.strategy || 'balanced'
                };

                // Always add models array (v2 format)
                if (Array.isArray(tierConfig.models)) {
                    processedTier.models = [...tierConfig.models];
                } else {
                    processedTier.models = [];
                }

                // Copy other v2-compatible fields
                if (tierConfig.label !== undefined) {
                    processedTier.label = tierConfig.label;
                }
                if (tierConfig.clientModelPolicy !== undefined) {
                    processedTier.clientModelPolicy = tierConfig.clientModelPolicy;
                }

                processedTiers[tierName] = processedTier;
            }
        }

        return {
            shadowMode: this.shadowMode,
            enabled: this.enabled,
            config: {
                tiers: processedTiers,
                rules: this.config.rules,
                classifier: this.config.classifier,
                cooldown: this.config.cooldown,
                failover: this.config.failover,
                defaultModel: this.config.defaultModel,
                logDecisions: this.config.logDecisions,
                persistConfigEdits: this.config.persistConfigEdits || false,
                pool429Penalty: this.config.pool429Penalty || {},
                glm5: this.config.glm5 || {},
                complexityUpgrade: this.config.complexityUpgrade || {}
            },
            // NORM-04: Include legacy indicator if config was migrated from v1
            ...(this._wasMigrated ? { legacy: true } : {}),
            effectiveMaxSwitches: Object.keys(this.config.tiers || {}).reduce((acc, t) => {
                acc[t] = this.getEffectiveMaxSwitches(t);
                return acc;
            }, {}),
            overrides: this.getOverrides(),
            cooldowns: this.getCooldowns(),
            pool429Penalty: this.getPool429PenaltyStats(),
            stats: this.getStats()
            // Note: pools excluded because getPoolStatus() is async
            // Use toJSONWithPools() for async version with pool data
        };
    }

    /** Return full state snapshot with async pool data included. */
    async toJSONWithPools() {
        return {
            ...this.toJSON(),
            pools: await this.getPoolStatus()
        };
    }

    // ---------------------------------------------------------------
    // Static validation
    // ---------------------------------------------------------------

    /**
     * Validate a config update payload from the API.
     * Returns { valid: true } or { valid: false, error: string }.
     *
     * @param {Object} updates - The update payload
     * @returns {{ valid: boolean, error?: string }}
     */
    static validateConfig(updates) {
        if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
            return { valid: false, error: 'Config update must be a non-null object' };
        }

        const warnings = [];

        const EDITABLE_KEYS = new Set([
            'enabled', 'defaultModel', 'tiers', 'rules',
            'classifier', 'cooldown', 'logDecisions', 'version', 'failover',
            'shadowMode', 'glm5', 'complexityUpgrade'
        ]);
        const META_KEYS = new Set([
            'persistConfigEdits', 'configFile', 'overridesFile', 'maxOverrides'
        ]);

        for (const key of Object.keys(updates)) {
            if (META_KEYS.has(key)) {
                return { valid: false, error: `"${key}" is not runtime-editable` };
            }
            if (!EDITABLE_KEYS.has(key)) {
                return { valid: false, error: `Unknown config key: "${key}"` };
            }
        }

        // Type checks
        if ('enabled' in updates && typeof updates.enabled !== 'boolean') {
            return { valid: false, error: '"enabled" must be a boolean' };
        }
        if ('shadowMode' in updates && typeof updates.shadowMode !== 'boolean') {
            return { valid: false, error: '"shadowMode" must be a boolean' };
        }
        if ('defaultModel' in updates && updates.defaultModel !== null && typeof updates.defaultModel !== 'string') {
            return { valid: false, error: '"defaultModel" must be a string or null' };
        }
        if ('logDecisions' in updates && typeof updates.logDecisions !== 'boolean') {
            return { valid: false, error: '"logDecisions" must be a boolean' };
        }
        if ('version' in updates && typeof updates.version !== 'string') {
            return { valid: false, error: '"version" must be a string' };
        }
        if ('tiers' in updates) {
            if (typeof updates.tiers !== 'object' || updates.tiers === null || Array.isArray(updates.tiers)) {
                return { valid: false, error: '"tiers" must be an object' };
            }
            const VALID_TIERS = new Set(['light', 'medium', 'heavy']);
            const version = typeof updates.version === 'string' ? updates.version.trim() : '';
            const isV2 = /^2(?:\.|$)/.test(version);

            for (const [tierName, tierConfig] of Object.entries(updates.tiers)) {
                if (!VALID_TIERS.has(tierName)) {
                    return { valid: false, error: `Unknown tier: "${tierName}"` };
                }
                if (typeof tierConfig !== 'object' || tierConfig === null) {
                    return { valid: false, error: `Tier "${tierName}" must be an object` };
                }

                // v2: models[] required
                if (isV2) {
                    if (!Array.isArray(tierConfig.models)) {
                        return { valid: false, error: `Tier "${tierName}" requires a "models" array` };
                    }
                    if (tierConfig.models.length === 0) {
                        return { valid: false, error: `Tier "${tierName}".models must not be empty` };
                    }
                    if (tierConfig.models.length > 10) {
                        return { valid: false, error: `Tier "${tierName}".models exceeds max length of 10` };
                    }
                    for (let j = 0; j < tierConfig.models.length; j++) {
                        if (typeof tierConfig.models[j] !== 'string') {
                            return { valid: false, error: `Tier "${tierName}".models[${j}] must be a string` };
                        }
                    }
                } else {
                    // v1: targetModel required
                    if (!tierConfig.targetModel || typeof tierConfig.targetModel !== 'string') {
                        return { valid: false, error: `Tier "${tierName}" requires a "targetModel" string` };
                    }
                }

                // strategy validation (v1: failover|pool, v2: quality|throughput|balanced|pool)
                if (tierConfig.strategy !== undefined) {
                    const validStrategies = isV2
                        ? ['quality', 'throughput', 'balanced', 'pool']
                        : ['failover', 'pool'];
                    if (!validStrategies.includes(tierConfig.strategy)) {
                        return { valid: false, error: `Tier "${tierName}".strategy must be one of: ${validStrategies.join(', ')}` };
                    }
                }

                // label validation (v2 only, optional)
                if (tierConfig.label !== undefined && typeof tierConfig.label !== 'string') {
                    return { valid: false, error: `Tier "${tierName}".label must be a string` };
                }

                // clientModelPolicy validation (both versions)
                if (tierConfig.clientModelPolicy !== undefined) {
                    if (!['rule-match-only', 'always-route'].includes(tierConfig.clientModelPolicy)) {
                        return { valid: false, error: `Tier "${tierName}".clientModelPolicy must be "rule-match-only" or "always-route"` };
                    }
                }

                // fallbackModels validation (v1 only, for backward compat)
                if (!isV2 && tierConfig.fallbackModels !== undefined) {
                    if (!Array.isArray(tierConfig.fallbackModels)) {
                        return { valid: false, error: `Tier "${tierName}".fallbackModels must be an array` };
                    }
                    if (tierConfig.fallbackModels.length > 10) {
                        return { valid: false, error: `Tier "${tierName}".fallbackModels exceeds max length of 10` };
                    }
                    for (let j = 0; j < tierConfig.fallbackModels.length; j++) {
                        if (typeof tierConfig.fallbackModels[j] !== 'string') {
                            return { valid: false, error: `Tier "${tierName}".fallbackModels[${j}] must be a string` };
                        }
                    }
                }
            }
        }
        if ('rules' in updates) {
            if (!Array.isArray(updates.rules)) {
                return { valid: false, error: '"rules" must be an array' };
            }
            for (let i = 0; i < updates.rules.length; i++) {
                const rule = updates.rules[i];
                if (!rule || typeof rule !== 'object') {
                    return { valid: false, error: `rules[${i}] must be an object` };
                }
                if (!rule.tier || typeof rule.tier !== 'string') {
                    return { valid: false, error: `rules[${i}] requires a "tier" string` };
                }
            }
        }
        if ('classifier' in updates) {
            if (typeof updates.classifier !== 'object' || updates.classifier === null || Array.isArray(updates.classifier)) {
                return { valid: false, error: '"classifier" must be an object' };
            }
        }
        if ('cooldown' in updates) {
            if (typeof updates.cooldown !== 'object' || updates.cooldown === null || Array.isArray(updates.cooldown)) {
                return { valid: false, error: '"cooldown" must be an object' };
            }
            const numericKeys = ['defaultMs', 'maxMs', 'decayMs', 'backoffMultiplier', 'maxCooldownEntries', 'burstDampeningFactor'];
            for (const k of numericKeys) {
                if (k in updates.cooldown && typeof updates.cooldown[k] !== 'number') {
                    return { valid: false, error: `cooldown.${k} must be a number` };
                }
            }
            if ('burstDampeningFactor' in updates.cooldown) {
                const f = updates.cooldown.burstDampeningFactor;
                if (f < 0 || f > 1) return { valid: false, error: 'cooldown.burstDampeningFactor must be between 0 and 1' };
            }
        }
        if ('failover' in updates) {
            if (typeof updates.failover !== 'object' || updates.failover === null || Array.isArray(updates.failover)) {
                return { valid: false, error: '"failover" must be an object' };
            }
            if ('maxModelSwitchesPerRequest' in updates.failover && typeof updates.failover.maxModelSwitchesPerRequest !== 'number') {
                return { valid: false, error: 'failover.maxModelSwitchesPerRequest must be a number' };
            }
        }

        // VALIDATE-01: Warn on duplicate models across tiers
        if ('tiers' in updates) {
            const modelToTiers = new Map();  // model -> Set of tiers
            const duplicates = new Set();

            for (const [tierName, tierConfig] of Object.entries(updates.tiers)) {
                const models = this._getModelsFromConfig(tierConfig);
                for (const model of models) {
                    if (!modelToTiers.has(model)) {
                        modelToTiers.set(model, new Set());
                    }
                    const tiers = modelToTiers.get(model);
                    if (tiers.size > 0) {
                        duplicates.add(model);
                    }
                    tiers.add(tierName);
                }
            }

            if (duplicates.size > 0) {
                const duplicateList = Array.from(duplicates).sort().join(', ');
                warnings.push(
                    `[ModelRouter] Models appear in multiple tiers (shared-pool semantics): ${duplicateList}`
                );
            }
        }

        // VALIDATE-03: Warn when maxModelSwitchesPerRequest > models.length
        // This is a ceiling — runtime uses min(maxSwitches, available).
        // Converted from error to warning: the default config may exceed this
        // for small tiers, and the runtime handles it gracefully.
        if ('failover' in updates && 'maxModelSwitchesPerRequest' in updates.failover) {
            const maxSwitches = updates.failover.maxModelSwitchesPerRequest;
            if ('tiers' in updates) {
                for (const [tierName, tierConfig] of Object.entries(updates.tiers)) {
                    const models = this._getModelsFromConfig(tierConfig);
                    if (maxSwitches > models.length) {
                        warnings.push(
                            `failover.maxModelSwitchesPerRequest (${maxSwitches}) exceeds tier "${tierName}" models.length (${models.length})`
                        );
                    }
                }
            }
        }

        // Validate catch-all rule or defaultModel exists (when rules are present)
        const hasRules = 'rules' in updates && updates.rules.length > 0;
        const hasCatchAll = hasRules &&
            updates.rules.some((rule) => rule.match?.model === '*');
        const hasDefaultModel = 'defaultModel' in updates && updates.defaultModel;

        // Only require catch-all or defaultModel if rules are defined
        // (otherwise the config is valid but won't match anything)
        if (hasRules && !hasCatchAll && !hasDefaultModel) {
            return {
                valid: false,
                error: 'Config must have either a catch-all rule (match.model: "*") or a defaultModel'
            };
        }

        // Validate glm5 config (Phase 08)
        if ('glm5' in updates) {
            if (typeof updates.glm5 !== 'object' || updates.glm5 === null || Array.isArray(updates.glm5)) {
                return { valid: false, error: '"glm5" must be an object' };
            }
            if ('enabled' in updates.glm5 && typeof updates.glm5.enabled !== 'boolean') {
                return { valid: false, error: '"glm5.enabled" must be a boolean' };
            }
            if ('preferencePercent' in updates.glm5) {
                const pct = updates.glm5.preferencePercent;
                if (typeof pct !== 'number' || !Number.isInteger(pct) || pct < 0 || pct > 100) {
                    return { valid: false, error: '"glm5.preferencePercent" must be an integer between 0 and 100' };
                }
            }
        }

        // Validate complexityUpgrade config (Phase 08)
        if ('complexityUpgrade' in updates) {
            if (typeof updates.complexityUpgrade !== 'object' || updates.complexityUpgrade === null || Array.isArray(updates.complexityUpgrade)) {
                return { valid: false, error: '"complexityUpgrade" must be an object' };
            }
            if ('enabled' in updates.complexityUpgrade && typeof updates.complexityUpgrade.enabled !== 'boolean') {
                return { valid: false, error: '"complexityUpgrade.enabled" must be a boolean' };
            }
            if ('allowedFamilies' in updates.complexityUpgrade) {
                if (!Array.isArray(updates.complexityUpgrade.allowedFamilies)) {
                    return { valid: false, error: '"complexityUpgrade.allowedFamilies" must be an array' };
                }
                for (let i = 0; i < updates.complexityUpgrade.allowedFamilies.length; i++) {
                    if (typeof updates.complexityUpgrade.allowedFamilies[i] !== 'string') {
                        return { valid: false, error: `"complexityUpgrade.allowedFamilies[${i}]" must be a string` };
                    }
                }
            }
            if ('thresholds' in updates.complexityUpgrade) {
                const t = updates.complexityUpgrade.thresholds;
                if (typeof t !== 'object' || t === null || Array.isArray(t)) {
                    return { valid: false, error: '"complexityUpgrade.thresholds" must be an object' };
                }
                if ('maxTokensGte' in t && (typeof t.maxTokensGte !== 'number' || t.maxTokensGte < 0)) {
                    return { valid: false, error: '"complexityUpgrade.thresholds.maxTokensGte" must be a non-negative number' };
                }
                if ('messageCountGte' in t && (typeof t.messageCountGte !== 'number' || t.messageCountGte < 0)) {
                    return { valid: false, error: '"complexityUpgrade.thresholds.messageCountGte" must be a non-negative number' };
                }
                if ('systemLengthGte' in t && (typeof t.systemLengthGte !== 'number' || t.systemLengthGte < 0)) {
                    return { valid: false, error: '"complexityUpgrade.thresholds.systemLengthGte" must be a non-negative number' };
                }
                if ('hasTools' in t && typeof t.hasTools !== 'boolean') {
                    return { valid: false, error: '"complexityUpgrade.thresholds.hasTools" must be a boolean' };
                }
                if ('hasVision' in t && typeof t.hasVision !== 'boolean') {
                    return { valid: false, error: '"complexityUpgrade.thresholds.hasVision" must be a boolean' };
                }
            }
        }

        const result = { valid: true };
        if (warnings.length > 0) result.warnings = warnings;
        return result;
    }

    /**
     * Extract models array from tier config (handles v1 and v2).
     * @private
     * @static
     * @param {Object} tierConfig - Tier configuration object
     * @returns {string[]} Array of model IDs
     */
    static _getModelsFromConfig(tierConfig) {
        if (Array.isArray(tierConfig.models)) {
            return tierConfig.models;  // v2
        }
        // v1: targetModel + fallbackModels
        const models = [];
        if (tierConfig.targetModel) {
            models.push(tierConfig.targetModel);
        }
        if (Array.isArray(tierConfig.fallbackModels)) {
            models.push(...tierConfig.fallbackModels);
        }
        if (tierConfig.failoverModel) {
            models.push(tierConfig.failoverModel);
        }
        return models;
    }

    // ---------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------

    /** @private */
    async _persistOverrides() {
        if (!this._persistEnabled || !this._configDir) return;
        const filePath = path.join(
            this._configDir,
            this.config.overridesFile || 'model-routing-overrides.json'
        );
        try {
            await atomicWrite(filePath, JSON.stringify(Object.fromEntries(this._overrides), null, 2));
        } catch (err) {
            this._logger.warn?.('[ModelRouter] Failed to persist overrides:', err.message);
        }
    }
}

module.exports = { ModelRouter, UPGRADE_REASONS, FALLBACK_REASONS };
