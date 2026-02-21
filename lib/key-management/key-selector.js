/**
 * Key Selector Module
 *
 * Interface for key selection logic extracted from KeyManager.
 *
 * The actual key selection logic remains in KeyManager for now because
 * it's tightly coupled with circuit breaker state, rate limiting, and
 * in-flight tracking. This module provides a stable interface.
 *
 * Future work: Extract full selection logic here.
 *
 * @module key-management/key-selector
 */

'use strict';

/**
 * Key Selector Class
 *
 * Provides an interface for selecting API keys from a pool.
 * The actual implementation delegates to the existing KeyManager logic.
 *
 * @class
 */
class KeySelector {
    /**
     * Create a new KeySelector
     * @param {Object} options - Configuration options
     * @param {Function} options.selectKeyFn - Function to select a key (delegates to KeyManager)
     * @param {Function} options.acquireKeyFn - Function to acquire a key with retry logic
     * @param {Object} options.config - Key selection configuration
     */
    constructor(options = {}) {
        this._selectKeyFn = options.selectKeyFn;
        this._acquireKeyFn = options.acquireKeyFn;
        this._config = options.config || {
            useWeightedSelection: true,
            healthScoreWeights: { latency: 40, successRate: 40, errorRecency: 20 },
            slowKeyThreshold: 2.0,
            slowKeyCheckIntervalMs: 30000,
            slowKeyCooldownMs: 300000
        };
    }

    /**
     * Select the best available key from the pool
     *
     * This method selects a key without consuming a rate limit token.
     * Use acquireKey() for full acquisition with token consumption.
     *
     * @param {Array<number>} excludeIndices - Key indices to exclude
     * @returns {Object|null} Key info or null if no available keys
     */
    selectKey(excludeIndices = []) {
        if (!this._selectKeyFn) {
            throw new Error('KeySelector: selectKeyFn not provided');
        }
        return this._selectKeyFn(excludeIndices);
    }

    /**
     * Acquire a key with rate limit token consumption
     *
     * This method consumes a rate limit token and increments inFlight.
     * It will retry with different keys if rate limit is exhausted.
     *
     * @param {Array<number>} excludeIndices - Key indices to exclude (already tried)
     * @returns {Promise<Object|null>} Key info or null if no available keys
     */
    async acquireKey(excludeIndices = []) {
        if (!this._acquireKeyFn) {
            throw new Error('KeySelector: acquireKeyFn not provided');
        }
        return this._acquireKeyFn(excludeIndices);
    }

    /**
     * Get the selection configuration
     * @returns {Object} Selection configuration
     */
    getConfig() {
        return this._config;
    }

    /**
     * Update the selection configuration
     * @param {Object} config - New configuration
     */
    setConfig(config) {
        this._config = { ...this._config, ...config };
    }

    /**
     * Check if weighted selection is enabled
     * @returns {boolean}
     */
    isWeightedSelectionEnabled() {
        return this._config.useWeightedSelection;
    }

    /**
     * Get health score weights
     * @returns {Object} Weights for latency, successRate, errorRecency
     */
    getHealthScoreWeights() {
        return this._config.healthScoreWeights;
    }
}

module.exports = {
    KeySelector
};
