/**
 * Key Scheduler Module
 *
 * Handles key selection with explainable decisions, fairness tracking,
 * and pluggable selection strategies.
 *
 * Extracted from KeyManager to separate concerns:
 * - KeyManager: Key state (inFlight, latencies, circuit breakers)
 * - KeyScheduler: Selection logic (which key to use and why)
 */

'use strict';

const { STATES } = require('./circuit-breaker');
const { RingBuffer } = require('./ring-buffer');

// =============================================================================
// REASON CODES - Standardized decision explanations
// =============================================================================

const ReasonCodes = {
    // Primary selection reasons
    HEALTH_SCORE_WINNER: 'health_score_winner',      // Won weighted selection
    ROUND_ROBIN_TURN: 'round_robin_turn',            // Round-robin fallback
    LAST_AVAILABLE: 'last_available',                // Only option remaining
    WEIGHTED_RANDOM: 'weighted_random',              // Selected via weighted random

    // Recovery reasons
    CIRCUIT_RECOVERY: 'circuit_recovery',            // Forced HALF_OPEN for recovery
    RATE_LIMIT_ROTATED: 'rate_limit_rotated',        // Rotated away from rate-limited key
    SLOW_KEY_AVOIDED: 'slow_key_avoided',            // Avoided slow/quarantined key

    // Fallback reasons
    FORCED_FALLBACK: 'forced_fallback',              // All circuits reset, last resort
    LEAST_LOADED: 'least_loaded',                    // Selected based on lowest inFlight
    FAIRNESS_BOOST: 'fairness_boost',                // Boosted due to fairness enforcement

    // Exclusion reasons (for whyNot tracking)
    EXCLUDED_CIRCUIT_OPEN: 'excluded_circuit_open',
    EXCLUDED_RATE_LIMITED: 'excluded_rate_limited',
    EXCLUDED_AT_MAX_CONCURRENCY: 'excluded_at_max_concurrency',
    EXCLUDED_SLOW_QUARANTINE: 'excluded_slow_quarantine',
    EXCLUDED_EXPLICITLY: 'excluded_explicitly',       // Caller excluded this key
    EXCLUDED_TOKEN_EXHAUSTED: 'excluded_token_exhausted'
};

// =============================================================================
// SELECTION CONTEXT - Captures decision details
// =============================================================================

class SelectionContext {
    constructor() {
        this.timestamp = Date.now();
        this.requestId = null;           // Set by caller if available
        this.attempt = 0;                // Retry attempt number

        // Decision outcome
        this.selectedKeyIndex = null;
        this.selectedKeyId = null;
        this.reason = null;

        // Scoring details
        this.healthScore = null;
        this.scoreComponents = null;
        this.competingKeys = 0;
        this.excludedKeys = [];

        // Pool state at selection time
        this.poolState = null;           // HEALTHY, DEGRADED, CRITICAL
        this.availableKeyCount = 0;
        this.totalKeyCount = 0;

        // Fairness metrics
        this.fairnessAdjustment = 0;
        this.keyUsageRatio = null;       // This key's selection ratio
    }

    toJSON() {
        return {
            ts: this.timestamp,
            requestId: this.requestId,
            attempt: this.attempt,
            selectedKeyIndex: this.selectedKeyIndex,
            selectedKeyId: this.selectedKeyId,
            reason: this.reason,
            healthScore: this.healthScore,
            scoreComponents: this.scoreComponents,
            competingKeys: this.competingKeys,
            excludedKeys: this.excludedKeys,
            poolState: this.poolState,
            availableKeyCount: this.availableKeyCount,
            totalKeyCount: this.totalKeyCount,
            fairnessAdjustment: this.fairnessAdjustment
        };
    }
}

// =============================================================================
// DECISION RECORDER - Audit trail for selections
// =============================================================================

class DecisionRecorder {
    constructor(options = {}) {
        this.maxDecisions = options.maxDecisions ?? 1000;
        this.decisions = new RingBuffer(this.maxDecisions);

        // Aggregated stats
        this.reasonCounts = {};
        this.whyNotCounts = {};      // Per-key exclusion reasons
        this.keySelectionCounts = {};
        this.keyOpportunityCounts = {}; // Times key was available but not selected

        // Initialize reason counts
        Object.values(ReasonCodes).forEach(code => {
            this.reasonCounts[code] = 0;
        });
    }

    /**
     * Record a selection decision
     */
    record(context) {
        // Store decision (ring buffer behavior)
        this.decisions.push(context.toJSON());

        // Update reason counts
        if (context.reason) {
            this.reasonCounts[context.reason] = (this.reasonCounts[context.reason] || 0) + 1;
        }

        // Update per-key selection count
        if (context.selectedKeyIndex !== null) {
            const keyId = context.selectedKeyId || `key_${context.selectedKeyIndex}`;
            this.keySelectionCounts[keyId] = (this.keySelectionCounts[keyId] || 0) + 1;
        }

        // Update exclusion counts (why not)
        for (const exclusion of context.excludedKeys) {
            const keyId = exclusion.keyId || `key_${exclusion.keyIndex}`;
            if (!this.whyNotCounts[keyId]) {
                this.whyNotCounts[keyId] = {};
            }
            const reason = exclusion.reason;
            this.whyNotCounts[keyId][reason] = (this.whyNotCounts[keyId][reason] || 0) + 1;
        }

        // Track opportunity counts (key was available but not selected)
        // This helps detect unfairness
        if (context.competingKeys > 1 && context.selectedKeyIndex !== null) {
            // All available keys except the selected one had an opportunity
            // We'll track this when we have key list in context
        }
    }

    /**
     * Record a key opportunity (was available but not selected)
     */
    recordOpportunity(keyId) {
        this.keyOpportunityCounts[keyId] = (this.keyOpportunityCounts[keyId] || 0) + 1;
    }

    /**
     * Get recent decisions
     */
    getRecentDecisions(count = 100) {
        const allDecisions = this.decisions.toArray();
        return allDecisions.slice(-count);
    }

    /**
     * Get reason distribution
     */
    getReasonDistribution() {
        const total = Object.values(this.reasonCounts).reduce((a, b) => a + b, 0);
        const distribution = {};

        for (const [reason, count] of Object.entries(this.reasonCounts)) {
            if (count > 0) {
                distribution[reason] = {
                    count,
                    percentage: total > 0 ? Math.round((count / total) * 1000) / 10 : 0
                };
            }
        }

        return distribution;
    }

    /**
     * Get per-key "why not" stats
     */
    getWhyNotStats() {
        return this.whyNotCounts;
    }

    /**
     * Get fairness metrics
     */
    getFairnessMetrics() {
        const selections = this.keySelectionCounts;
        const opportunities = this.keyOpportunityCounts;
        const totalSelections = Object.values(selections).reduce((a, b) => a + b, 0);

        const metrics = {};
        const allKeys = new Set([...Object.keys(selections), ...Object.keys(opportunities)]);

        for (const keyId of allKeys) {
            const selected = selections[keyId] || 0;
            const hadOpportunity = opportunities[keyId] || 0;
            const totalOpportunities = selected + hadOpportunity;

            metrics[keyId] = {
                selections: selected,
                opportunities: totalOpportunities,
                selectionRate: totalOpportunities > 0
                    ? Math.round((selected / totalOpportunities) * 1000) / 10
                    : 0,
                shareOfTotal: totalSelections > 0
                    ? Math.round((selected / totalSelections) * 1000) / 10
                    : 0
            };
        }

        // Calculate fairness coefficient (Gini-like measure, 0 = perfectly fair)
        const shares = Object.values(metrics).map(m => m.shareOfTotal);
        const expectedShare = 100 / shares.length;
        const deviations = shares.map(s => Math.abs(s - expectedShare));
        const avgDeviation = deviations.reduce((a, b) => a + b, 0) / shares.length;
        const fairnessScore = Math.max(0, 100 - avgDeviation * 2);

        return {
            perKey: metrics,
            fairnessScore: Math.round(fairnessScore * 10) / 10,
            totalSelections,
            keyCount: allKeys.size
        };
    }

    /**
     * Reset all stats
     */
    reset() {
        this.decisions.clear();
        Object.keys(this.reasonCounts).forEach(k => this.reasonCounts[k] = 0);
        this.whyNotCounts = {};
        this.keySelectionCounts = {};
        this.keyOpportunityCounts = {};
    }

    /**
     * Get full stats summary
     */
    getStats() {
        return {
            totalDecisions: this.decisions.size,
            reasonDistribution: this.getReasonDistribution(),
            whyNotStats: this.getWhyNotStats(),
            fairness: this.getFairnessMetrics(),
            recentDecisions: this.getRecentDecisions(10)
        };
    }
}

// =============================================================================
// POOL STATE - Health status of the key pool
// =============================================================================

const PoolState = {
    HEALTHY: 'healthy',      // >50% keys available with good health
    DEGRADED: 'degraded',    // <50% available OR average health <50
    CRITICAL: 'critical'     // <25% available OR all keys rate-limited
};

// =============================================================================
// KEY SCHEDULER - Main selection logic
// =============================================================================

class KeyScheduler {
    constructor(options = {}) {
        this.logger = options.logger;

        // Configuration
        this.config = {
            useWeightedSelection: options.useWeightedSelection !== false,
            healthScoreWeights: options.healthScoreWeights || {
                latency: 40,
                successRate: 40,
                errorRecency: 20
            },
            slowKeyThreshold: options.slowKeyThreshold ?? 2.0,
            maxConcurrencyPerKey: options.maxConcurrencyPerKey ?? 3,

            // Fairness configuration
            fairnessMode: options.fairnessMode || 'soft', // 'none', 'soft', 'strict'
            fairnessBoostFactor: options.fairnessBoostFactor ?? 1.5,
            minFairnessShare: options.minFairnessShare ?? 0.1, // 10% minimum
            starvationThresholdMs: options.starvationThresholdMs ?? 30000,

            // Quarantine configuration
            slowKeyQuarantineDurationMs: options.slowKeyQuarantineDurationMs ?? 60000,
            quarantineProbeIntervalMs: options.quarantineProbeIntervalMs ?? 10000
        };

        // Decision recording
        this.recorder = new DecisionRecorder({
            maxDecisions: options.maxDecisions ?? 1000
        });

        // Pool state tracking
        this._poolAvgLatency = 0;
        this._poolState = PoolState.HEALTHY;
        this._lastPoolStateChange = Date.now();

        // Round-robin index for fallback
        this.roundRobinIndex = 0;

        // Cached health scores (updated periodically, read on hot path)
        this._cachedScores = new Map();  // keyId -> { score, timestamp }
        this._scoreCacheTTL = options.scoreCacheTTL ?? 1000;  // 1s TTL
        this._scoreUpdateInterval = null;

        // Callbacks
        this.onPoolStateChange = options.onPoolStateChange || (() => {});

        // ARCH-02: Track per-key in-flight requests for drift detection
        this._keyInFlight = new Map();
    }

    _log(level, message, context) {
        if (this.logger) {
            this.logger[level](message, context);
        }
    }

    /**
     * Start background health score updater
     * @param {Array} keys - Reference to keys array
     */
    startScoreUpdater(keys) {
        if (this._scoreUpdateInterval) return;
        this._keysRef = keys;
        this._updateCachedScores();  // Initial calculation
        this._scoreUpdateInterval = setInterval(() => {
            this._updateCachedScores();
        }, 500);
        this._scoreUpdateInterval.unref();
    }

    /**
     * Update cached health scores for all keys
     */
    _updateCachedScores() {
        if (!this._keysRef) return;
        const now = Date.now();
        for (const key of this._keysRef) {
            const score = this._calculateHealthScore(key, this._keysRef);
            this._cachedScores.set(key.keyId, { score, timestamp: now });
        }
    }

    /**
     * Get cached health score for a key, falling back to live calculation
     */
    getCachedScore(keyInfo, allKeys) {
        const cached = this._cachedScores.get(keyInfo.keyId);
        if (cached && (Date.now() - cached.timestamp) < this._scoreCacheTTL) {
            return cached.score;
        }
        // Cache miss or stale - calculate live
        return this._calculateHealthScore(keyInfo, allKeys);
    }

    // =========================================================================
    // POOL STATE MANAGEMENT
    // =========================================================================

    /**
     * Update pool average latency from keys
     */
    updatePoolMetrics(keys) {
        const latencies = keys
            .map(k => k.latencies?.stats?.()?.p50 || 0)
            .filter(l => l > 0);

        if (latencies.length > 0) {
            this._poolAvgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
        }

        // Update pool state
        this._updatePoolState(keys);
    }

    /**
     * Calculate and update pool state
     */
    _updatePoolState(keys) {
        const totalKeys = keys.length;
        if (totalKeys === 0) {
            this._setPoolState(PoolState.CRITICAL);
            return;
        }

        const availableKeys = keys.filter(k => this._isKeyAvailable(k)).length;
        const availableRatio = availableKeys / totalKeys;

        // Calculate average health of available keys
        let avgHealth = 0;
        if (availableKeys > 0) {
            const healthScores = keys
                .filter(k => this._isKeyAvailable(k))
                .map(k => this._calculateHealthScore(k, keys).total);
            avgHealth = healthScores.reduce((a, b) => a + b, 0) / healthScores.length;
        }

        // Determine state
        let newState;
        if (availableRatio < 0.25 || availableKeys === 0) {
            newState = PoolState.CRITICAL;
        } else if (availableRatio < 0.5 || avgHealth < 50) {
            newState = PoolState.DEGRADED;
        } else {
            newState = PoolState.HEALTHY;
        }

        this._setPoolState(newState);
    }

    _setPoolState(newState) {
        if (newState !== this._poolState) {
            const oldState = this._poolState;
            this._poolState = newState;
            this._lastPoolStateChange = Date.now();

            this._log('warn', `Pool state changed: ${oldState} -> ${newState}`);
            this.onPoolStateChange(oldState, newState);
        }
    }

    getPoolState() {
        return {
            state: this._poolState,
            lastChange: this._lastPoolStateChange,
            avgLatency: this._poolAvgLatency
        };
    }

    // =========================================================================
    // KEY AVAILABILITY CHECKS
    // =========================================================================

    /**
     * Check if a key is available for selection
     */
    _isKeyAvailable(keyInfo, rateLimiter = null) {
        // Check circuit breaker
        if (!keyInfo.circuitBreaker?.isAvailable?.()) {
            return false;
        }

        // Check rate limiter if provided
        if (rateLimiter) {
            const rateCheck = rateLimiter.peekLimit(keyInfo.keyId);
            if (!rateCheck.allowed) {
                return false;
            }
        }

        return true;
    }

    /**
     * Get exclusion reason for a key
     */
    _getExclusionReason(keyInfo, excludeSet, rateLimiter, now) {
        if (excludeSet.has(keyInfo.index)) {
            return ReasonCodes.EXCLUDED_EXPLICITLY;
        }

        if (keyInfo.circuitBreaker?.state === STATES.OPEN) {
            return ReasonCodes.EXCLUDED_CIRCUIT_OPEN;
        }

        if (keyInfo.inFlight >= this.config.maxConcurrencyPerKey) {
            return ReasonCodes.EXCLUDED_AT_MAX_CONCURRENCY;
        }

        if (keyInfo._isQuarantined) {
            const quarantineEnd = keyInfo._quarantinedAt + this.config.slowKeyQuarantineDurationMs;
            if (now < quarantineEnd) {
                return ReasonCodes.EXCLUDED_SLOW_QUARANTINE;
            }
        }

        if (keyInfo.rateLimitedAt) {
            const cooldownElapsed = now - keyInfo.rateLimitedAt;
            if (cooldownElapsed < keyInfo.rateLimitCooldownMs) {
                return ReasonCodes.EXCLUDED_RATE_LIMITED;
            }
        }

        if (rateLimiter) {
            const rateCheck = rateLimiter.peekLimit(keyInfo.keyId);
            if (!rateCheck.allowed) {
                return ReasonCodes.EXCLUDED_TOKEN_EXHAUSTED;
            }
        }

        return null;
    }

    // =========================================================================
    // HEALTH SCORING
    // =========================================================================

    /**
     * Calculate health score for a key
     */
    _calculateHealthScore(keyInfo, allKeys) {
        const weights = this.config.healthScoreWeights;
        const stats = keyInfo.latencies?.stats?.() || { count: 0, p50: 0 };

        // Latency score (up to 40 points)
        // Compares key's P50 latency to pool average via ratio thresholds:
        //   ratio < 0.8  → full points (key is faster than pool average)
        //   ratio < 1.0  → 87.5% points (key is near pool average)
        //   ratio < 1.5  → 50% points (key is moderately slower)
        //   ratio >= 1.5 → 12.5% points (key is significantly slower)
        let latencyScore = weights.latency;
        if (stats.count >= 5 && this._poolAvgLatency > 0) {
            const ratio = stats.p50 / this._poolAvgLatency;
            if (ratio < 0.8) {
                // Faster than pool average: full latency score
                latencyScore = weights.latency;
            } else if (ratio < 1.0) {
                // Near pool average: 87.5% (0.875) - mild penalty
                latencyScore = Math.round(weights.latency * 0.875);
            } else if (ratio < 1.5) {
                // Moderately slower: 50% (0.5) - significant penalty
                latencyScore = Math.round(weights.latency * 0.5);
            } else {
                // Much slower than pool: 12.5% (0.125) - near-zero score
                latencyScore = Math.round(weights.latency * 0.125);
            }

            // Penalty for slow/quarantined keys
            if (keyInfo._isSlowKey || keyInfo._isQuarantined) {
                latencyScore = Math.max(0, latencyScore - 20);
            }
        }

        // Success rate score (up to 40 points)
        const successRate = keyInfo.totalRequests > 0
            ? keyInfo.successCount / keyInfo.totalRequests
            : 1.0;
        const successScore = Math.round(successRate * weights.successRate);

        // Error recency score (up to 20 points)
        // Deducts 5 points per failure in the last 60 seconds.
        // With max 20 points, 4 recent failures zeroes this component,
        // ensuring keys with repeated errors are strongly deprioritized.
        const recentFailures = keyInfo.circuitBreaker?.failureTimestamps
            ? keyInfo.circuitBreaker.failureTimestamps.filter(
                ts => (Date.now() - ts) < 60000
            ).length
            : 0;
        const errorScore = Math.max(0, weights.errorRecency - (recentFailures * 5));

        // Recency penalty (spread requests across keys to avoid bursting one key)
        // Penalizes keys used very recently to distribute load:
        //   < 500ms ago  → -30 pts (just used, strongly discourage reuse)
        //   < 1000ms ago → -20 pts (recently used, moderate penalty)
        //   < 2000ms ago → -10 pts (mild cooldown window)
        //   >= 2000ms    →   0 pts (enough time elapsed, no penalty)
        let recencyPenalty = 0;
        if (keyInfo.lastUsed) {
            const msSinceLastUse = Date.now() - new Date(keyInfo.lastUsed).getTime();
            if (msSinceLastUse < 500) {
                recencyPenalty = 30;
            } else if (msSinceLastUse < 1000) {
                recencyPenalty = 20;
            } else if (msSinceLastUse < 2000) {
                recencyPenalty = 10;
            }
        }

        // In-flight penalty: 15 points per concurrent request.
        // With maxConcurrencyPerKey=2, a fully loaded key loses 30 points,
        // making idle keys strongly preferred over busy ones.
        const inFlightPenalty = keyInfo.inFlight * 15;

        // Fairness boost (for underused keys)
        let fairnessBoost = 0;
        if (this.config.fairnessMode !== 'none') {
            fairnessBoost = this._calculateFairnessBoost(keyInfo, allKeys);
        }

        const total = Math.max(0,
            latencyScore + successScore + errorScore + fairnessBoost - recencyPenalty - inFlightPenalty
        );

        return {
            total,
            latencyScore,
            successScore,
            errorScore,
            recencyPenalty,
            inFlightPenalty,
            fairnessBoost,
            details: {
                p50: stats.p50,
                poolAvg: this._poolAvgLatency,
                successRate: Math.round(successRate * 100),
                recentFailures,
                isSlowKey: keyInfo._isSlowKey || false,
                isQuarantined: keyInfo._isQuarantined || false,
                inFlight: keyInfo.inFlight
            }
        };
    }

    /**
     * Calculate fairness boost for underused keys
     */
    _calculateFairnessBoost(keyInfo, allKeys) {
        const fairnessMetrics = this.recorder.getFairnessMetrics();
        const keyMetrics = fairnessMetrics.perKey[keyInfo.keyId];

        if (!keyMetrics || fairnessMetrics.keyCount < 2) {
            return 0;
        }

        const expectedShare = 100 / fairnessMetrics.keyCount;
        const actualShare = keyMetrics.shareOfTotal;

        // If this key is underused, give it a boost
        if (actualShare < expectedShare * 0.7) {
            // Significant underuse - strong boost
            return Math.round(20 * this.config.fairnessBoostFactor);
        } else if (actualShare < expectedShare * 0.9) {
            // Slight underuse - mild boost
            return Math.round(10 * this.config.fairnessBoostFactor);
        }

        // Check for starvation (not used recently despite being available)
        if (keyInfo.lastUsed) {
            const msSinceLastUse = Date.now() - new Date(keyInfo.lastUsed).getTime();
            if (msSinceLastUse > this.config.starvationThresholdMs) {
                return 25; // Strong starvation boost
            }
        }

        return 0;
    }

    // =========================================================================
    // MAIN SELECTION LOGIC
    // =========================================================================

    /**
     * Select the best available key
     *
     * @param {Object} params - Selection parameters
     * @param {Array} params.keys - Array of key info objects
     * @param {Set|Array} params.excludeIndices - Indices to exclude
     * @param {Object} params.rateLimiter - Rate limiter instance
     * @param {string} params.requestId - Request ID for tracing
     * @param {number} params.attempt - Retry attempt number
     * @returns {Object} { key, context } or { key: null, context }
     */
    selectKey({ keys, excludeIndices = [], rateLimiter = null, requestId = null, attempt = 0 }) {
        const context = new SelectionContext();
        context.requestId = requestId;
        context.attempt = attempt;
        context.totalKeyCount = keys.length;
        context.poolState = this._poolState;

        const excludeSet = new Set(excludeIndices);
        const now = Date.now();

        // Update pool metrics
        this.updatePoolMetrics(keys);

        // Collect available keys and exclusion reasons
        const available = [];
        const exclusions = [];

        for (const key of keys) {
            const exclusionReason = this._getExclusionReason(key, excludeSet, rateLimiter, now);

            if (exclusionReason) {
                exclusions.push({
                    keyIndex: key.index,
                    keyId: key.keyId,
                    reason: exclusionReason
                });
            } else {
                available.push(key);
            }
        }

        context.excludedKeys = exclusions;
        context.availableKeyCount = available.length;
        context.competingKeys = available.length;

        // No available keys - handle fallback
        if (available.length === 0) {
            return this._handleNoAvailableKeys(keys, excludeSet, context);
        }

        // Prefer CLOSED circuit breakers over HALF_OPEN
        const closedKeys = available.filter(k => k.circuitBreaker?.state === STATES.CLOSED);
        const candidates = closedKeys.length > 0 ? closedKeys : available;

        // Filter by concurrency limit
        const underLimit = candidates.filter(k => k.inFlight < this.config.maxConcurrencyPerKey);

        if (underLimit.length === 0) {
            context.reason = ReasonCodes.EXCLUDED_AT_MAX_CONCURRENCY;
            this.recorder.record(context);
            return { key: null, context };
        }

        // Smart rotation: prefer non-rate-limited keys
        const notRateLimited = underLimit.filter(k => {
            if (!k.rateLimitedAt) return true;
            return (now - k.rateLimitedAt) >= k.rateLimitCooldownMs;
        });

        const selectionPool = notRateLimited.length > 0 ? notRateLimited : underLimit;

        // Record opportunity for fairness tracking
        for (const key of selectionPool) {
            this.recorder.recordOpportunity(key.keyId);
        }

        // Select key based on strategy
        let selectedKey;
        let reason;

        if (selectionPool.length === 1) {
            selectedKey = selectionPool[0];
            reason = ReasonCodes.LAST_AVAILABLE;
        } else if (this.config.useWeightedSelection) {
            const result = this._weightedSelection(selectionPool, keys);
            selectedKey = result.key;
            reason = result.reason;
            context.healthScore = result.healthScore;
            context.scoreComponents = result.scoreComponents;
        } else {
            selectedKey = this._roundRobinSelection(selectionPool);
            reason = ReasonCodes.ROUND_ROBIN_TURN;
        }

        // Check for rate-limit rotation
        if (notRateLimited.length > 0 && notRateLimited.length < underLimit.length) {
            reason = ReasonCodes.RATE_LIMIT_ROTATED;
        }

        // Populate context
        context.selectedKeyIndex = selectedKey.index;
        context.selectedKeyId = selectedKey.keyId;
        context.reason = reason;

        // Record and return
        this.recorder.record(context);

        return { key: selectedKey, context };
    }

    /**
     * Weighted random selection based on health scores
     */
    _weightedSelection(candidates, allKeys) {
        // Calculate health scores
        const scoredKeys = candidates.map(key => ({
            key,
            score: this.getCachedScore(key, allKeys)
        }));

        // Sort for logging
        scoredKeys.sort((a, b) => b.score.total - a.score.total);

        // Check if top key has fairness boost
        const topKey = scoredKeys[0];
        if (topKey.score.fairnessBoost > 0) {
            return {
                key: topKey.key,
                reason: ReasonCodes.FAIRNESS_BOOST,
                healthScore: topKey.score.total,
                scoreComponents: topKey.score
            };
        }

        // Weighted random selection
        const totalWeight = scoredKeys.reduce((sum, sk) => {
            return sum + Math.max(1, (sk.score.total * sk.score.total) / 100);
        }, 0);

        let random = Math.random() * totalWeight;
        for (const sk of scoredKeys) {
            const weight = Math.max(1, (sk.score.total * sk.score.total) / 100);
            random -= weight;
            if (random <= 0) {
                return {
                    key: sk.key,
                    reason: scoredKeys[0].key === sk.key
                        ? ReasonCodes.HEALTH_SCORE_WINNER
                        : ReasonCodes.WEIGHTED_RANDOM,
                    healthScore: sk.score.total,
                    scoreComponents: sk.score
                };
            }
        }

        // Fallback
        return {
            key: scoredKeys[0].key,
            reason: ReasonCodes.HEALTH_SCORE_WINNER,
            healthScore: scoredKeys[0].score.total,
            scoreComponents: scoredKeys[0].score
        };
    }

    /**
     * Round-robin selection fallback
     */
    _roundRobinSelection(candidates) {
        const idx = this.roundRobinIndex % candidates.length;
        this.roundRobinIndex = (this.roundRobinIndex + 1) % candidates.length;
        return candidates[idx];
    }

    /**
     * Handle case when no keys are available
     */
    _handleNoAvailableKeys(keys, excludeSet, context) {
        // Try to force a recovery
        const openKeys = keys
            .filter(k => !excludeSet.has(k.index) && k.circuitBreaker?.state === STATES.OPEN)
            .sort((a, b) => (a.circuitBreaker.openedAt || 0) - (b.circuitBreaker.openedAt || 0));

        if (openKeys.length > 0) {
            // Force oldest to HALF_OPEN for recovery test
            const oldest = openKeys[0];
            oldest.circuitBreaker.forceState(STATES.HALF_OPEN);

            context.selectedKeyIndex = oldest.index;
            context.selectedKeyId = oldest.keyId;
            context.reason = ReasonCodes.CIRCUIT_RECOVERY;

            this._log('warn', `Forced Key ${oldest.index} to HALF_OPEN for recovery`);
            this.recorder.record(context);

            return { key: oldest, context };
        }

        // Check for excluded-only scenario
        const nonExcluded = keys.filter(k => !excludeSet.has(k.index));
        if (nonExcluded.length === 0) {
            context.reason = ReasonCodes.EXCLUDED_EXPLICITLY;
            this.recorder.record(context);
            return { key: null, context };
        }

        // Last resort: reset all circuits and pick least loaded
        this._log('warn', 'All keys exhausted, resetting circuits');
        keys.forEach(k => k.circuitBreaker?.reset?.());

        const leastLoaded = nonExcluded.reduce((a, b) =>
            a.inFlight <= b.inFlight ? a : b
        );

        context.selectedKeyIndex = leastLoaded.index;
        context.selectedKeyId = leastLoaded.keyId;
        context.reason = ReasonCodes.FORCED_FALLBACK;

        this.recorder.record(context);

        return { key: leastLoaded, context };
    }

    // =========================================================================
    // QUARANTINE MANAGEMENT
    // =========================================================================

    /**
     * Quarantine a slow key
     */
    quarantineKey(keyInfo, reason = 'slow') {
        keyInfo._isQuarantined = true;
        keyInfo._quarantinedAt = Date.now();
        keyInfo._quarantineReason = reason;

        this._log('warn', `Key ${keyInfo.keyPrefix} quarantined: ${reason}`, {
            keyIndex: keyInfo.index,
            duration: this.config.slowKeyQuarantineDurationMs
        });
    }

    /**
     * Release a key from quarantine
     */
    releaseFromQuarantine(keyInfo) {
        if (keyInfo._isQuarantined) {
            keyInfo._isQuarantined = false;
            keyInfo._quarantinedAt = null;
            keyInfo._quarantineReason = null;

            this._log('info', `Key ${keyInfo.keyPrefix} released from quarantine`);
        }
    }

    /**
     * Check if key should be probed for recovery
     */
    shouldProbeQuarantinedKey(keyInfo) {
        if (!keyInfo._isQuarantined) return false;

        const lastProbe = keyInfo._lastQuarantineProbe || keyInfo._quarantinedAt || 0;
        return (Date.now() - lastProbe) >= this.config.quarantineProbeIntervalMs;
    }

    /**
     * Mark that we probed a quarantined key
     */
    markQuarantineProbe(keyInfo) {
        keyInfo._lastQuarantineProbe = Date.now();
    }

    // =========================================================================
    // STATS AND TELEMETRY
    // =========================================================================

    /**
     * Get scheduler statistics
     */
    getStats() {
        return {
            poolState: this.getPoolState(),
            decisions: this.recorder.getStats(),
            config: {
                useWeightedSelection: this.config.useWeightedSelection,
                fairnessMode: this.config.fairnessMode,
                maxConcurrencyPerKey: this.config.maxConcurrencyPerKey
            }
        };
    }

    /**
     * Reset scheduler state
     */
    reset() {
        this.recorder.reset();
        this.roundRobinIndex = 0;
        this._poolState = PoolState.HEALTHY;
        this._lastPoolStateChange = Date.now();
    }

    // ---------------------------------------------------------------
    // ARCH-02: Accessor Methods for Drift Detection
    // ---------------------------------------------------------------

    /**
     * Get current pool state
     * @returns {string} Pool state: healthy, degraded, critical
     */
    getPoolStateString() {
        return this._poolState || 'unknown';
    }

    /**
     * Get key state for drift detection
     * @param {number} keyIndex - Key index
     * @returns {string} Key state: available, excluded, rate_limited, etc.
     */
    getKeyState(keyIndex) {
        // Find key info by index from keys reference
        if (!this._keysRef) return 'unknown';

        const keyInfo = this._keysRef.find(k => k.index === keyIndex);
        if (!keyInfo) return 'unknown';

        // Check exclusion reasons in priority order
        if (keyInfo.circuitBreaker?.state === STATES.OPEN) {
            return 'circuit_open';
        }
        if (keyInfo._isQuarantined) {
            return 'excluded';
        }
        if (keyInfo.rateLimitedAt) {
            const cooldownElapsed = Date.now() - keyInfo.rateLimitedAt;
            if (cooldownElapsed < keyInfo.rateLimitCooldownMs) {
                return 'rate_limited';
            }
        }
        if (this._keyInFlight?.get(keyIndex) >= this.config.maxConcurrencyPerKey) {
            return 'at_capacity';
        }

        return 'available';
    }

    /**
     * Get exclusion reason for a key
     * @param {number} keyIndex - Key index
     * @returns {string|null} Reason or null if not excluded
     */
    getExcludedReason(keyIndex) {
        if (!this._keysRef) return null;

        const keyInfo = this._keysRef.find(k => k.index === keyIndex);
        if (!keyInfo) return null;

        // Check exclusion reasons in priority order
        if (keyInfo.circuitBreaker?.state === STATES.OPEN) {
            return 'circuit_breaker';
        }
        if (keyInfo._isQuarantined) {
            return keyInfo._quarantineReason || 'slow_quarantine';
        }
        if (keyInfo.rateLimitedAt) {
            const cooldownElapsed = Date.now() - keyInfo.rateLimitedAt;
            if (cooldownElapsed < keyInfo.rateLimitCooldownMs) {
                return 'rate_limit';
            }
        }
        if (this._keyInFlight?.get(keyIndex) >= this.config.maxConcurrencyPerKey) {
            return 'at_max_concurrency';
        }

        return null;
    }

    /**
     * Get in-flight count for a key
     * @param {number} keyIndex - Key index
     * @returns {number} In-flight count
     */
    getInFlight(keyIndex) {
        // Find key info by index from keys reference
        if (!this._keysRef) return 0;

        const keyInfo = this._keysRef.find(k => k.index === keyIndex);
        return keyInfo?.inFlight || 0;
    }

    /**
     * Cleanup resources
     */
    destroy() {
        if (this._scoreUpdateInterval) {
            clearInterval(this._scoreUpdateInterval);
            this._scoreUpdateInterval = null;
        }
        this._cachedScores.clear();
        this._keysRef = null;
    }
}

module.exports = {
    KeyScheduler,
    SelectionContext,
    DecisionRecorder,
    ReasonCodes,
    PoolState
};
