/**
 * Token Tracker Module
 *
 * Handles token usage tracking across requests.
 * Extracted from StatsAggregator as part of the god class refactoring.
 *
 * TDD Phase: Green - Implementation to make tests pass
 */

'use strict';

const { LRUMap } = require('../lru-map');

const DEFAULT_MAX_KEYS = 1000;

/**
 * TokenTracker class
 * Tracks token usage for API requests with per-key breakdown
 */
class TokenTracker {
    /**
     * @param {Object} options - Configuration options
     * @param {number} options.maxKeys - Maximum number of keys to track
     * @param {Object} options.logger - Logger instance
     */
    constructor(options = {}) {
        this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
        this.logger = options.logger || null;

        this._reset();
    }

    /**
     * Reset internal state
     * @private
     */
    _reset() {
        this.tokens = {
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalTokens: 0,
            requestCount: 0,
            byKeyId: new LRUMap(this.maxKeys)
        };
    }

    /**
     * Log message if logger is available
     * @param {string} level - Log level
     * @param {string} message - Log message
     * @private
     */
    _log(level, message) {
        if (this.logger && typeof this.logger[level] === 'function') {
            this.logger[level](message);
        }
    }

    /**
     * Record token usage from a request response
     * @param {string} keyId - API key identifier
     * @param {Object} usage - Token usage data { input_tokens, output_tokens }
     */
    recordTokenUsage(keyId, usage = {}) {
        const inputTokens = usage.input_tokens || usage.inputTokens || usage.prompt_tokens || 0;
        const outputTokens = usage.output_tokens || usage.outputTokens || usage.completion_tokens || 0;
        const total = inputTokens + outputTokens;

        if (total === 0) return;

        this.tokens.totalInputTokens += inputTokens;
        this.tokens.totalOutputTokens += outputTokens;
        this.tokens.totalTokens += total;
        this.tokens.requestCount++;

        // Track per-key usage
        if (!this.tokens.byKeyId.has(keyId)) {
            this.tokens.byKeyId.set(keyId, {
                totalInputTokens: 0,
                totalOutputTokens: 0,
                totalTokens: 0,
                requestCount: 0
            });
        }

        const keyTokens = this.tokens.byKeyId.get(keyId);
        keyTokens.totalInputTokens += inputTokens;
        keyTokens.totalOutputTokens += outputTokens;
        keyTokens.totalTokens += total;
        keyTokens.requestCount++;
    }

    /**
     * Get token usage statistics
     * @returns {Object} Token usage stats
     */
    getTokenStats() {
        return {
            totalInputTokens: this.tokens.totalInputTokens,
            totalOutputTokens: this.tokens.totalOutputTokens,
            totalTokens: this.tokens.totalTokens,
            requestCount: this.tokens.requestCount,
            avgInputPerRequest: this.tokens.requestCount > 0
                ? Math.round(this.tokens.totalInputTokens / this.tokens.requestCount)
                : 0,
            avgOutputPerRequest: this.tokens.requestCount > 0
                ? Math.round(this.tokens.totalOutputTokens / this.tokens.requestCount)
                : 0,
            avgTotalPerRequest: this.tokens.requestCount > 0
                ? Math.round(this.tokens.totalTokens / this.tokens.requestCount)
                : 0,
            byKey: Object.fromEntries(
                Array.from(this.tokens.byKeyId.entries()).map(([keyId, stats]) => [
                    keyId,
                    {
                        ...stats,
                        avgInputPerRequest: stats.requestCount > 0
                            ? Math.round(stats.totalInputTokens / stats.requestCount)
                            : 0,
                        avgOutputPerRequest: stats.requestCount > 0
                            ? Math.round(stats.totalOutputTokens / stats.requestCount)
                            : 0
                    }
                ])
            )
        };
    }

    /**
     * Reset token stats
     */
    resetTokenStats() {
        this._reset();
        this._log('info', 'Token stats reset');
    }

    /**
     * Get the maxKeys setting
     * @returns {number} Maximum number of keys to track
     */
    getMaxKeys() {
        return this.maxKeys;
    }
}

module.exports = {
    TokenTracker
};
