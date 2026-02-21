/**
 * Rate Limiter Module
 * Token bucket algorithm for rate limiting per key
 */

class TokenBucket {
    constructor(options = {}) {
        this.capacity = options.capacity || 60;        // Max tokens (requests per minute)
        this.refillRate = options.refillRate || 1;     // Tokens per second
        this.tokens = this.capacity;
        this.lastRefill = Date.now();
        this.burst = options.burst || 10;              // Extra burst capacity
    }

    /**
     * Refill tokens based on time elapsed
     */
    _refill() {
        const now = Date.now();
        const elapsed = (now - this.lastRefill) / 1000; // seconds
        const tokensToAdd = elapsed * this.refillRate;

        this.tokens = Math.min(this.capacity + this.burst, this.tokens + tokensToAdd);
        this.lastRefill = now;
    }

    /**
     * Try to consume a token
     * @returns {boolean} true if token consumed, false if rate limited
     */
    tryConsume(tokens = 1) {
        this._refill();

        if (this.tokens >= tokens) {
            this.tokens -= tokens;
            return true;
        }

        return false;
    }

    /**
     * Get current token count
     */
    getTokens() {
        this._refill();
        return this.tokens;
    }

    /**
     * Get time until next token available (ms)
     */
    getWaitTime() {
        this._refill();
        if (this.tokens >= 1) return 0;

        const tokensNeeded = 1 - this.tokens;
        return Math.ceil(tokensNeeded / this.refillRate * 1000);
    }

    /**
     * Reset bucket to full capacity
     */
    reset() {
        this.tokens = this.capacity;
        this.lastRefill = Date.now();
    }

    /**
     * Get statistics
     */
    getStats() {
        this._refill();
        return {
            tokens: Math.floor(this.tokens),
            capacity: this.capacity,
            burst: this.burst,
            refillRate: this.refillRate,
            waitTime: this.getWaitTime()
        };
    }
}

class RateLimiter {
    constructor(options = {}) {
        this.enabled = options.enabled !== false && (options.requestsPerMinute || 0) > 0;
        this.requestsPerMinute = options.requestsPerMinute || 60;
        this.burst = options.burst || 10;
        this.buckets = new Map();
    }

    /**
     * Get or create bucket for a key
     */
    _getBucket(keyId) {
        if (!this.buckets.has(keyId)) {
            this.buckets.set(keyId, new TokenBucket({
                capacity: this.requestsPerMinute,
                refillRate: this.requestsPerMinute / 60,
                burst: this.burst
            }));
        }
        return this.buckets.get(keyId);
    }

    /**
     * Check if request is allowed for key (CONSUMES a token if allowed)
     * Use this when actually allocating a key, not during availability checks
     * @returns {{ allowed: boolean, waitTime: number }}
     */
    checkLimit(keyId) {
        if (!this.enabled) {
            return { allowed: true, waitTime: 0 };
        }

        const bucket = this._getBucket(keyId);
        const allowed = bucket.tryConsume(1);

        return {
            allowed,
            waitTime: allowed ? 0 : bucket.getWaitTime()
        };
    }

    /**
     * Peek if request would be allowed WITHOUT consuming a token
     * Use this during availability checks to avoid wasting tokens
     * @returns {{ allowed: boolean, waitTime: number }}
     */
    peekLimit(keyId) {
        if (!this.enabled) {
            return { allowed: true, waitTime: 0 };
        }

        const bucket = this._getBucket(keyId);
        const stats = bucket.getStats();

        return {
            allowed: stats.tokens >= 1,
            waitTime: stats.tokens >= 1 ? 0 : bucket.getWaitTime()
        };
    }

    /**
     * Get stats for a key
     */
    getKeyStats(keyId) {
        if (!this.enabled) {
            return { enabled: false };
        }

        const bucket = this._getBucket(keyId);
        return {
            enabled: true,
            ...bucket.getStats()
        };
    }

    /**
     * Get stats for all keys
     */
    getAllStats() {
        const stats = {
            enabled: this.enabled,
            requestsPerMinute: this.requestsPerMinute,
            burst: this.burst,
            keys: {}
        };

        for (const [keyId, bucket] of this.buckets) {
            stats.keys[keyId] = bucket.getStats();
        }

        return stats;
    }

    /**
     * Reset rate limiter for a key
     */
    resetKey(keyId) {
        if (this.buckets.has(keyId)) {
            this.buckets.get(keyId).reset();
        }
    }

    /**
     * Reset all rate limiters
     */
    resetAll() {
        for (const bucket of this.buckets.values()) {
            bucket.reset();
        }
    }

    /**
     * Remove stale buckets (cleanup)
     */
    cleanup(maxAge = 3600000) {
        const cutoff = Date.now() - maxAge;
        for (const [keyId, bucket] of this.buckets) {
            if (bucket.lastRefill < cutoff) {
                this.buckets.delete(keyId);
            }
        }
    }

    /**
     * Update rate limiter settings
     */
    updateSettings(settings) {
        if (settings.requestsPerMinute !== undefined) {
            this.requestsPerMinute = settings.requestsPerMinute;
        }
        if (settings.burst !== undefined) {
            this.burst = settings.burst;
        }
        // Reset all buckets with new settings
        this.buckets.clear();
        return { requestsPerMinute: this.requestsPerMinute, burst: this.burst };
    }
}

module.exports = {
    TokenBucket,
    RateLimiter
};
