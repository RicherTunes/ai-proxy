/**
 * Adaptive Concurrency Controller (AIMD)
 *
 * TCP-inspired Additive Increase / Multiplicative Decrease that dynamically adjusts
 * per-model effective concurrency limits based on upstream 429 feedback.
 *
 * Features:
 * - Per-model AIMD windows with configurable decrease factor and growth mode
 * - Global account-level window (optional)
 * - Tick-based adjustment (not per-request) to avoid oscillation
 * - 3-way 429 classification: congestion vs quota vs unknown
 * - Shadow/observe_only mode for safe rollout
 * - Anti-flap hysteresis (minimum hold between adjustments)
 * - Idle decay (drift back toward static limits when no traffic)
 *
 * TODO: Redis shared state for multi-instance deployments (config.instanceId reserved)
 */

'use strict';

const DEFAULT_CONFIG = {
    enabled: true,
    mode: 'observe_only',        // 'observe_only' | 'enforce'
    tickIntervalMs: 2000,
    decreaseFactor: 0.5,
    recoveryDelayMs: 5000,
    minWindow: 1,
    growthCleanTicks: 2,
    growthMode: 'fixed_ticks',   // 'fixed_ticks' | 'proportional'
    minHoldMs: 4000,
    idleTimeoutMs: 300000,
    idleDecayStep: 1,
    quotaRetryAfterMs: 60000,
    treatUnknownAsCongestion: true,
    globalMaxConcurrency: 0      // 0 = disabled
};

class ModelWindow {
    constructor(model, staticMax, floor) {
        this.model = model;
        this.staticMax = staticMax;
        this.effectiveMax = staticMax;
        this.floor = floor;
        // Tick accumulators (reset each tick)
        this.congestionCount = 0;
        this.successCount = 0;
        this.quotaHitCount = 0;
        this.unknownHitCount = 0;
        // Conservative growth tracking
        this.consecutiveCleanTicks = 0;
        // Timing
        this.lastAdjustAt = Date.now();
        this.lastCongestionAt = 0;
        this.lastTrafficAt = Date.now();
        this.lastDecreaseAt = 0;
        this.lastIncreaseAt = 0;
        // Cumulative stats for observability
        this.totalAdjustmentsUp = 0;
        this.totalAdjustmentsDown = 0;
        this.lastAdjustReason = 'init';
    }
}

class GlobalAccountWindow {
    constructor(globalMax) {
        this.effectiveMax = globalMax || Infinity;
        this.congestionCount = 0;
        this.successCount = 0;
    }
}

class AdaptiveConcurrencyController {
    /**
     * @param {Object} config - Adaptive concurrency configuration
     * @param {Object} deps - Dependencies
     * @param {Object} deps.keyManager - KeyManager instance (for setEffectiveModelLimit)
     * @param {Object} [deps.logger] - Logger instance
     * @param {Object} [deps.statsAggregator] - StatsAggregator instance
     */
    constructor(config, { keyManager, logger, statsAggregator } = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        // Coerce invalid mode to safe default
        if (this.config.mode !== 'observe_only' && this.config.mode !== 'enforce') {
            this.config.mode = 'observe_only';
        }
        this._keyManager = keyManager;
        this._logger = logger || { info() {}, warn() {}, debug() {}, error() {} };
        this._statsAggregator = statsAggregator || null;
        this._windows = new Map();
        this._tickInterval = null;

        // Global account window
        this._globalWindow = this.config.globalMaxConcurrency > 0
            ? new GlobalAccountWindow(this.config.globalMaxConcurrency)
            : null;
    }

    // --- Feedback API (called by RequestHandler) ---

    /**
     * Record a 429 congestion signal from upstream.
     * @param {string} model - Target model name
     * @param {Object} details - Classification details
     * @param {number|null} details.retryAfterMs - Retry-After value in ms (null if missing)
     * @param {string|null} details.errorCode - Error code from response body
     * @param {string|null} details.errorBody - Raw error body for quota detection
     */
    recordCongestion(model, { retryAfterMs, errorCode, errorBody } = {}) {
        const w = this._getOrCreate(model);
        if (!w) return;  // Unknown model — no tracking
        w.congestionCount++;
        w.lastCongestionAt = Date.now();
        w.lastTrafficAt = Date.now();

        // 3-way classification
        if (retryAfterMs && retryAfterMs > this.config.quotaRetryAfterMs) {
            w.quotaHitCount++;
        } else if (retryAfterMs == null && !errorCode) {
            w.unknownHitCount++;
        }

        // Check error code/body for quota signals
        if (errorCode === 'quota_exceeded' ||
            (typeof errorBody === 'string' && errorBody.includes('quota'))) {
            w.quotaHitCount++;
        }

        // Global window tracking
        if (this._globalWindow) {
            this._globalWindow.congestionCount++;
        }
    }

    /**
     * Record a successful upstream response.
     * @param {string} model - Target model name
     */
    recordSuccess(model) {
        const w = this._getOrCreate(model);
        if (!w) return;  // Unknown model — no tracking
        w.successCount++;
        w.lastTrafficAt = Date.now();

        // Global window tracking
        if (this._globalWindow) {
            this._globalWindow.successCount++;
        }
    }

    // --- Query API (called by ModelRouter) ---

    /**
     * Get effective concurrency limit for a model.
     * Returns null in observe_only mode (shadow mode: don't enforce).
     * @param {string} model
     * @returns {number|null} Effective limit, or null to use static
     */
    getEffectiveConcurrency(model) {
        if (this.config.mode !== 'enforce') return null;
        const w = this._windows.get(model);
        return w ? w.effectiveMax : null;
    }

    /**
     * Get what effective limit WOULD be (for shadow mode logging/stats).
     * Always returns computed value regardless of mode.
     * @param {string} model
     * @returns {number|null}
     */
    getObservedConcurrency(model) {
        const w = this._windows.get(model);
        return w ? w.effectiveMax : null;
    }

    // --- Observability ---

    /**
     * Get a snapshot of all adaptive concurrency state for stats/monitoring.
     * @returns {Object} Snapshot with mode, global window, and per-model state
     */
    getSnapshot() {
        const models = {};
        for (const [model, w] of this._windows) {
            models[model] = {
                staticMax: w.staticMax,
                effectiveMax: w.effectiveMax,
                floor: w.floor,
                congestion429: w.congestionCount,
                quota429: w.quotaHitCount,
                unknown429: w.unknownHitCount,
                success: w.successCount,
                adjustmentsUp: w.totalAdjustmentsUp,
                adjustmentsDown: w.totalAdjustmentsDown,
                lastAdjustReason: w.lastAdjustReason,
                lastTrafficAt: w.lastTrafficAt,
                isIdle: (Date.now() - w.lastTrafficAt) > this.config.idleTimeoutMs
            };
        }
        return {
            mode: this.config.mode,
            globalWindow: this._globalWindow ? {
                effectiveMax: this._globalWindow.effectiveMax,
                sumModelEffective: this._sumModelEffective()
            } : null,
            models
        };
    }

    // --- Lifecycle ---

    /**
     * Start the tick loop. Call once after construction.
     */
    start() {
        if (this._tickInterval) return;
        this._tickInterval = setInterval(() => this._tick(), this.config.tickIntervalMs);
        this._tickInterval.unref(); // Don't keep process alive
    }

    /**
     * Stop the tick loop and restore static limits. Safe to call multiple times.
     */
    stop() {
        if (this._tickInterval) {
            clearInterval(this._tickInterval);
            this._tickInterval = null;
        }
        // Restore effective limits to static baselines on stop
        if (this.config.mode === 'enforce') {
            this._keyManager?.restoreStaticLimits?.();
        }
    }

    // --- Internal ---

    /**
     * Get or create a ModelWindow for a model.
     * Uses KeyManager's static limit as baseline. Returns null for unknown models
     * (models without a static limit are permissive and shouldn't be tracked).
     * @param {string} model
     * @returns {ModelWindow|null}
     */
    _getOrCreate(model) {
        let w = this._windows.get(model);
        if (!w) {
            const staticMax = this._keyManager?.getStaticModelLimit?.(model);
            if (staticMax === undefined) return null;  // Unknown model — stay permissive
            w = new ModelWindow(model, staticMax, this.config.minWindow);
            this._windows.set(model, w);
        }
        return w;
    }

    /**
     * Sum of all model effective limits (for global window).
     * @returns {number}
     */
    _sumModelEffective() {
        let sum = 0;
        for (const w of this._windows.values()) {
            sum += w.effectiveMax;
        }
        return sum;
    }

    /**
     * Main tick loop — runs every tickIntervalMs.
     * Adjusts each model window based on accumulated signals.
     */
    _tick() {
        const now = Date.now();

        for (const [model, w] of this._windows) {
            this._adjustWindow(model, w, now);
        }

        // Global window enforcement (if enabled)
        if (this._globalWindow && this._globalWindow.effectiveMax < Infinity) {
            this._enforceGlobalWindow(now);
            // Reset global accumulators
            this._globalWindow.congestionCount = 0;
            this._globalWindow.successCount = 0;
        }

        // Push snapshot to stats aggregator
        if (this._statsAggregator?.recordAdaptiveConcurrency) {
            this._statsAggregator.recordAdaptiveConcurrency(this.getSnapshot());
        }
    }

    /**
     * Adjust a single model's AIMD window based on accumulated tick signals.
     * @param {string} model
     * @param {ModelWindow} w
     * @param {number} now
     */
    _adjustWindow(model, w, now) {
        // 1. ANTI-FLAP CHECK — retain signals for next tick instead of dropping them
        if (now - w.lastAdjustAt < this.config.minHoldMs) {
            return;
        }

        // 2. CONGESTION: 429s accumulated this tick
        if (w.congestionCount > 0) {
            const classification = this._classify429(w);

            if (classification === 'quota') {
                // Quota issue (budget), not concurrency — don't shrink
                this._logger.warn('Quota-level 429 detected, not shrinking window', {
                    model, quotaHits: w.quotaHitCount, effectiveMax: w.effectiveMax
                });
                w.lastAdjustReason = 'quota_skip';
            } else if (classification === 'congestion' ||
                       (classification === 'unknown' && this.config.treatUnknownAsCongestion)) {
                // MULTIPLICATIVE DECREASE
                const prev = w.effectiveMax;
                w.effectiveMax = Math.max(
                    w.floor,
                    Math.floor(w.effectiveMax * this.config.decreaseFactor)
                );

                if (w.effectiveMax !== prev) {
                    w.totalAdjustmentsDown++;
                    w.lastDecreaseAt = now;
                    w.lastAdjustAt = now;
                    w.lastAdjustReason = `decrease_${classification}`;
                    w.consecutiveCleanTicks = 0;

                    this._logger.info('AIMD decrease', {
                        model, from: prev, to: w.effectiveMax,
                        classification, congestionCount: w.congestionCount
                    });

                    // Write back if enforcing
                    if (this.config.mode === 'enforce') {
                        this._keyManager?.setEffectiveModelLimit?.(model, w.effectiveMax);
                    }
                }
            } else {
                // Unknown classification, treatUnknownAsCongestion=false — observe only
                w.lastAdjustReason = 'unknown_skip';
                this._logger.debug('Unknown 429 classification, not shrinking', {
                    model, unknownHits: w.unknownHitCount
                });
            }

            w.consecutiveCleanTicks = 0;
            this._resetAccumulators(w);
            return;
        }

        // 3. GROWTH: successes only, no congestion, recovery delay passed
        if (w.successCount > 0 && (now - w.lastCongestionAt > this.config.recoveryDelayMs)) {
            w.consecutiveCleanTicks++;

            let growthAllowed = false;
            let growthStep = 1;

            if (this.config.growthMode === 'fixed_ticks') {
                growthAllowed = w.consecutiveCleanTicks >= this.config.growthCleanTicks;
            } else if (this.config.growthMode === 'proportional') {
                // Proportional: grow faster when window is larger (recovering toward staticMax).
                // At small windows, step=1. At large windows, step=ceil(staticMax * 0.1).
                growthStep = Math.max(1, Math.ceil(w.staticMax * 0.1));
                growthAllowed = true;
            }

            if (growthAllowed && w.effectiveMax < w.staticMax) {
                const prev = w.effectiveMax;
                w.effectiveMax = Math.min(w.staticMax, w.effectiveMax + growthStep);

                if (w.effectiveMax !== prev) {
                    w.totalAdjustmentsUp++;
                    w.lastIncreaseAt = now;
                    w.lastAdjustAt = now;
                    w.lastAdjustReason = 'additive_increase';
                    w.consecutiveCleanTicks = 0;

                    this._logger.debug('AIMD increase', {
                        model, from: prev, to: w.effectiveMax
                    });

                    if (this.config.mode === 'enforce') {
                        this._keyManager?.setEffectiveModelLimit?.(model, w.effectiveMax);
                    }
                }
            }
        } else if (w.successCount === 0) {
            // No traffic this tick — check idle decay
            // 4. IDLE DECAY
            if ((now - w.lastTrafficAt > this.config.idleTimeoutMs) && w.effectiveMax < w.staticMax) {
                const prev = w.effectiveMax;
                w.effectiveMax = Math.min(w.staticMax, w.effectiveMax + this.config.idleDecayStep);

                if (w.effectiveMax !== prev) {
                    w.lastAdjustAt = now;
                    w.lastAdjustReason = 'idle_decay';

                    this._logger.debug('Idle decay', {
                        model, from: prev, to: w.effectiveMax
                    });

                    if (this.config.mode === 'enforce') {
                        this._keyManager?.setEffectiveModelLimit?.(model, w.effectiveMax);
                    }
                }
            }
        }

        // 5. Reset tick accumulators
        this._resetAccumulators(w);
    }

    /**
     * Classify accumulated 429 signals for a model window.
     * @param {ModelWindow} w
     * @returns {'congestion'|'quota'|'unknown'}
     */
    _classify429(w) {
        if (w.quotaHitCount > 0) return 'quota';
        if (w.unknownHitCount > 0 && w.congestionCount === w.unknownHitCount) return 'unknown';
        return 'congestion';
    }

    /**
     * Reset per-tick accumulators on a model window.
     * @param {ModelWindow} w
     */
    _resetAccumulators(w) {
        w.congestionCount = 0;
        w.successCount = 0;
        w.quotaHitCount = 0;
        w.unknownHitCount = 0;
    }

    /**
     * Enforce global account window by proportionally reducing model limits.
     * @param {number} now
     */
    _enforceGlobalWindow(now) {
        const globalMax = this._globalWindow.effectiveMax;
        const sum = this._sumModelEffective();

        if (sum <= globalMax) return;

        // Proportional reduction
        const ratio = globalMax / sum;
        for (const [model, w] of this._windows) {
            const prev = w.effectiveMax;
            w.effectiveMax = Math.max(w.floor, Math.floor(w.effectiveMax * ratio));

            if (w.effectiveMax !== prev) {
                w.lastAdjustAt = now;
                w.lastAdjustReason = 'global_cap';

                if (this.config.mode === 'enforce') {
                    this._keyManager?.setEffectiveModelLimit?.(model, w.effectiveMax);
                }
            }
        }

        this._logger.info('Global window enforcement', {
            globalMax, prevSum: sum, newSum: this._sumModelEffective()
        });
    }
}

module.exports = { AdaptiveConcurrencyController, ModelWindow, GlobalAccountWindow, DEFAULT_CONFIG };
