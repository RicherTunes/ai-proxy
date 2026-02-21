/**
 * Pool Manager Module
 *
 * Manages per-model pool state for rate limiting and cooldown.
 * Extracted from KeyManager for better separation of concerns.
 *
 * Features:
 * - Per-model pool isolation (Model A cooldown doesn't block Model B)
 * - Exponential backoff with configurable caps
 * - Automatic count decay after quiet period
 * - Proactive pacing from rate limit headers
 *
 * @module key-management/pool-manager
 */

'use strict';

const { exponentialBackoff } = require('../backoff');
const POOL_COOLDOWN_JITTER_FACTOR = 0.15;

/**
 * Pool Manager Class
 *
 * Manages rate limit state for API key pools on a per-model basis.
 * Each model gets its own pool with independent rate limiting state.
 *
 * @class
 */
class PoolManager {
    /**
     * Create a new PoolManager
     * @param {Object} [config={}] - Configuration options
     * @param {number} [config.baseMs=500] - Base cooldown in milliseconds
     * @param {number} [config.capMs=5000] - Maximum cooldown in milliseconds
     * @param {number} [config.decayMs=10000] - Time before count resets (ms)
     */
    constructor(config = {}) {
        this.config = {
            baseMs: config.baseMs ?? 500,
            capMs: config.capMs ?? 5000,
            decayMs: config.decayMs ?? 10000
        };

        // Map of model -> pool state
        this._pools = new Map();
    }

    /**
     * Get or create pool state for a model
     * @param {string|null} model - Model name, or null for global pool
     * @returns {Object} Pool state { rateLimitedUntil, count, lastHitAt, lastRateLimitRemaining, lastRateLimitLimit, lastRateLimitReset }
     * @private
     */
    _getOrCreatePool(model) {
        const key = model || '__global__';
        if (!this._pools.has(key)) {
            this._pools.set(key, {
                rateLimitedUntil: 0,
                count: 0,
                lastHitAt: 0,
                lastRateLimitRemaining: null,
                lastRateLimitLimit: null,
                lastRateLimitReset: null
            });
        }
        return this._pools.get(key);
    }

    /**
     * Get pool state for a model
     * @param {string|null} model - Model name, or null for global pool
     * @returns {Object} Pool state
     */
    getPoolState(model) {
        const pool = this._getOrCreatePool(model);
        const now = Date.now();

        return {
            rateLimitedUntil: pool.rateLimitedUntil,
            count: pool.count,
            lastHitAt: pool.lastHitAt,
            lastRateLimitRemaining: pool.lastRateLimitRemaining,
            lastRateLimitLimit: pool.lastRateLimitLimit,
            lastRateLimitReset: pool.lastRateLimitReset,
            isRateLimited: now < pool.rateLimitedUntil,
            cooldownRemainingMs: Math.max(0, pool.rateLimitedUntil - now),
            pool429Count: pool.count
        };
    }

    /**
     * Set pool cooldown for a model
     * @param {string|null} model - Model name, or null for global pool
     * @param {Object} options - Cooldown options
     * @param {number} [options.count=1] - Pool 429 count (for exponential backoff)
     * @param {number} [options.baseMs] - Override base cooldown
     * @param {number} [options.capMs] - Override cap cooldown
     */
    setPoolCooldown(model, options = {}) {
        const { count = 1, baseMs, capMs } = options;
        const pool = this._getOrCreatePool(model);
        const now = Date.now();

        // Use provided overrides or config defaults
        const effectiveBase = baseMs ?? this.config.baseMs;
        const effectiveCap = capMs ?? this.config.capMs;

        const finalCooldown = exponentialBackoff({
            baseMs: effectiveBase,
            capMs: effectiveCap,
            attempt: count,
            jitter: POOL_COOLDOWN_JITTER_FACTOR
        });

        pool.rateLimitedUntil = now + finalCooldown;
        pool.count = count;
        pool.lastHitAt = now;
    }

    /**
     * Record a pool-level rate limit hit
     * @param {string|null} [model=null] - Model name, or null for global pool
     * @param {Object} [options={}] - Cooldown options
     * @param {number} [options.baseMs] - Override base cooldown
     * @param {number} [options.capMs] - Override cap cooldown
     * @returns {Object} Cooldown info
     */
    recordPoolRateLimitHit(model = null, options = {}) {
        const now = Date.now();
        const { baseMs, capMs } = options;
        const pool = this._getOrCreatePool(model);

        // Decay count if last 429 was more than decayMs ago
        if (now - pool.lastHitAt > this.config.decayMs) {
            pool.count = 0;
        }

        pool.lastHitAt = now;
        pool.count = Math.min(pool.count + 1, 10); // Cap to prevent unbounded growth

        // Use provided overrides or config defaults
        const effectiveBase = baseMs ?? this.config.baseMs;
        const effectiveCap = capMs ?? this.config.capMs;

        // Exponential backoff: base * 2^(count-1), capped
        const cooldownMs = Math.min(effectiveBase * Math.pow(2, pool.count - 1), effectiveCap);

        // Add jitter (±15%) to prevent thundering herd
        const jitter = cooldownMs * 0.15 * (Math.random() * 2 - 1);
        const finalCooldown = Math.round(cooldownMs + jitter);

        pool.rateLimitedUntil = now + finalCooldown;

        return {
            cooldownMs: finalCooldown,
            pool429Count: pool.count,
            cooldownUntil: pool.rateLimitedUntil,
            model: model || 'global'
        };
    }

    /**
     * Get remaining pool cooldown time in milliseconds
     * @param {string|null} [model=null] - Model name, or null for max across all pools
     * @returns {number} Remaining cooldown in ms, or 0 if not rate limited
     */
    getPoolCooldownRemainingMs(model = null) {
        if (model !== null && model !== undefined) {
            const pool = this._pools.get(model);
            if (!pool) return 0;
            return Math.max(0, pool.rateLimitedUntil - Date.now());
        }

        // No model specified: return max cooldown across all pools
        let maxRemaining = 0;
        for (const pool of this._pools.values()) {
            const remaining = Math.max(0, pool.rateLimitedUntil - Date.now());
            if (remaining > maxRemaining) maxRemaining = remaining;
        }
        return maxRemaining;
    }

    /**
     * Check if pool is currently rate limited
     * @param {string|null} [model=null] - Model name, or null to check all pools
     * @returns {boolean} True if pool is in cooldown
     */
    isPoolRateLimited(model = null) {
        const now = Date.now();

        if (model !== null && model !== undefined) {
            const pool = this._pools.get(model);
            return pool ? now < pool.rateLimitedUntil : false;
        }

        // No model: check if ANY pool is rate limited
        for (const pool of this._pools.values()) {
            if (now < pool.rateLimitedUntil) return true;
        }
        return false;
    }

    /**
     * Get pool rate limit stats for monitoring
     * @returns {Object} Pool rate limit status
     */
    getPoolRateLimitStats() {
        const now = Date.now();
        const pools = {};
        let maxLastHitAt = 0;
        let maxRateLimitedUntil = 0;

        for (const [model, pool] of this._pools.entries()) {
            const isRateLimited = now < pool.rateLimitedUntil;
            const cooldownRemainingMs = Math.max(0, pool.rateLimitedUntil - now);

            pools[model] = {
                isRateLimited,
                cooldownRemainingMs,
                pool429Count: pool.count,
                lastPool429At: pool.lastHitAt ? new Date(pool.lastHitAt).toISOString() : null,
                cooldownUntil: pool.rateLimitedUntil ? new Date(pool.rateLimitedUntil).toISOString() : null
            };

            if (pool.lastHitAt > maxLastHitAt) maxLastHitAt = pool.lastHitAt;
            if (pool.rateLimitedUntil > maxRateLimitedUntil) maxRateLimitedUntil = pool.rateLimitedUntil;
        }

        return {
            isRateLimited: this.isPoolRateLimited(),
            cooldownRemainingMs: this.getPoolCooldownRemainingMs(),
            pool429Count: Math.max(0, ...Array.from(this._pools.values()).map(p => p.count)),
            lastPool429At: maxLastHitAt ? new Date(maxLastHitAt).toISOString() : null,
            cooldownUntil: maxRateLimitedUntil ? new Date(maxRateLimitedUntil).toISOString() : null,
            pools
        };
    }

    /**
     * Record upstream rate limit headers for proactive pacing
     * @param {string} model - Target model name
     * @param {Object} headers - Response headers from upstream
     * @param {Object} [pacingConfig={}] - Pacing configuration
     */
    recordRateLimitHeaders(model, headers, pacingConfig = {}) {
        if (!model || !headers) return;

        const remaining = parseInt(headers['x-ratelimit-remaining'], 10);
        const limit = parseInt(headers['x-ratelimit-limit'], 10);
        const resetSecs = parseInt(headers['x-ratelimit-reset'], 10);

        if (isNaN(remaining)) return;

        const {
            remainingThreshold = 5,
            pacingDelayMs = 200
        } = pacingConfig;

        const pool = this._getOrCreatePool(model);

        if (remaining <= remainingThreshold && remaining >= 0) {
            // Approaching limit: set a soft pacing delay
            const urgency = 1 - (remaining / Math.max(remainingThreshold, 1));
            const delay = Math.round(pacingDelayMs * urgency);

            // Set a soft cooldown (shorter than a 429 would cause)
            const pacingUntil = Date.now() + delay;
            if (pacingUntil > pool.rateLimitedUntil) {
                pool.rateLimitedUntil = pacingUntil;
            }
        }

        // Store rate limit info for observability
        pool.lastRateLimitRemaining = remaining;
        pool.lastRateLimitLimit = isNaN(limit) ? null : limit;
        pool.lastRateLimitReset = isNaN(resetSecs) ? null : resetSecs;
    }

    /**
     * Get pacing delay for a specific model (for proactive throttling)
     * @param {string} model - Target model name
     * @returns {number} Delay in ms, 0 if no pacing needed
     */
    getModelPacingDelayMs(model) {
        if (!model) return 0;
        const pool = this._pools.get(model);
        if (!pool) return 0;
        return Math.max(0, pool.rateLimitedUntil - Date.now());
    }
}

module.exports = {
    PoolManager
};
