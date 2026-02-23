/**
 * Key Manager Module
 * Manages API keys with circuit breaker, rate limiting, and load balancing
 */

const { CircuitBreaker, STATES } = require('./circuit-breaker');
const { RateLimiter } = require('./rate-limiter');
const { RingBuffer } = require('./ring-buffer');
const { LatencyHistogram, GlobalHistogramAggregator } = require('./latency-histogram');
const { KeyScheduler, ReasonCodes, PoolState } = require('./key-scheduler');
const { exponentialBackoff } = require('./backoff');

class KeyManager {
    constructor(options = {}) {
        this.keys = [];
        this.keyMap = new Map();  // keyId -> key info
        this._providerKeyIndices = new Map(); // provider -> Set<index>
        this.defaultProviderName = options.defaultProviderName || null; // Cost-safety: restrict untagged keys
        this.roundRobinIndex = 0;
        this.maxConcurrencyPerKey = options.maxConcurrencyPerKey ?? 3;
        this.circuitBreakerConfig = options.circuitBreaker || {};
        this.rateLimiter = new RateLimiter({
            requestsPerMinute: options.rateLimitPerMinute ?? 0,
            burst: options.rateLimitBurst ?? 10
        });
        this.logger = options.logger;

        // Key selection configuration
        this.keySelectionConfig = options.keySelection || {
            useWeightedSelection: true,
            healthScoreWeights: { latency: 40, successRate: 40, errorRecency: 20 },
            slowKeyThreshold: 2.0,
            slowKeyCheckIntervalMs: 30000,
            slowKeyCooldownMs: 300000
        };

        // Pool-level metrics for health scoring
        this._poolAvgLatency = 0;
        this._lastSlowKeyCheck = 0;

        // Per-model pool state for independent rate limit tracking
        // Each model gets its own { rateLimitedUntil, count, lastHitAt } entry
        this._modelPools = new Map(); // model -> { rateLimitedUntil, count, lastHitAt }

        // Per-model concurrency tracking (prevents exceeding upstream model limits)
        this._modelInFlight = new Map(); // model -> current in-flight count
        this._modelStaticLimits = new Map(); // model -> original maxConcurrency from model-discovery
        this._modelLimits = new Map();   // model -> effective maxConcurrency (may be reduced by adaptive concurrency)
        this.pool429Count = 0;  // Updated to reflect most recent pool's count (backward compat)
        // Accept pool cooldown config from options, with defaults
        const poolCooldown = options.poolCooldown || {};
        this.poolCooldownConfig = {
            baseMs: poolCooldown.baseMs ?? 500,      // Start with 500ms cooldown
            capMs: poolCooldown.capMs ?? 5000,       // Cap at 5s
            decayMs: poolCooldown.decayMs ?? 10000   // Reset pool429Count after 10s without 429
        };

        // Per-key cooldown decay config (reset escalated cooldowns after quiet period)
        const keyRateLimitCooldown = options.keyRateLimitCooldown || {};
        this.cooldownDecayConfig = {
            cooldownDecayMs: keyRateLimitCooldown.cooldownDecayMs ?? 30000,
            baseCooldownMs: keyRateLimitCooldown.baseCooldownMs ?? 1000
        };

        // Account-level 429 detection (multiple unique keys hitting 429 simultaneously)
        const accountDetection = options.accountLevelDetection || {};
        this.accountLevelConfig = {
            enabled: accountDetection.enabled !== false,
            keyThreshold: accountDetection.keyThreshold ?? 3,
            windowMs: accountDetection.windowMs ?? 5000,
            cooldownMs: accountDetection.cooldownMs ?? 10000
        };
        this._accountLevelState = { recentHits: [], cooldownUntil: 0 };

        // Start slow key detection interval if enabled
        if (this.keySelectionConfig.useWeightedSelection) {
            this._slowKeyCheckInterval = setInterval(() => {
                this._checkForSlowKeys();
            }, this.keySelectionConfig.slowKeyCheckIntervalMs);
            this._slowKeyCheckInterval.unref();
        }

        // Callbacks
        this.onKeyStateChange = options.onKeyStateChange || (() => {});

        // Global histogram aggregator (#4)
        this.histogramAggregator = new GlobalHistogramAggregator({
            buckets: options.histogramBuckets
        });

        // Key Scheduler for explainable selection (v2)
        this.scheduler = new KeyScheduler({
            logger: this.logger,
            maxConcurrencyPerKey: this.maxConcurrencyPerKey,
            useWeightedSelection: this.keySelectionConfig.useWeightedSelection,
            healthScoreWeights: this.keySelectionConfig.healthScoreWeights,
            slowKeyThreshold: this.keySelectionConfig.slowKeyThreshold,
            fairnessMode: options.fairnessMode || 'soft',
            onPoolStateChange: (oldState, newState) => {
                this._log('warn', `Pool state: ${oldState} -> ${newState}`);
            }
        });
    }

    /**
     * Extract key ID from full key string
     */
    static getKeyId(fullKey) {
        return fullKey.split('.')[0];
    }

    /**
     * Initialize keys from array or provider map
     * @param {string[]|Object} keyInput - Flat array of key strings, or provider map { 'z.ai': ['key1.s1'], 'anthropic': ['sk-ant.s1'] }
     */
    loadKeys(keyInput) {
        // Normalize input: accept flat array or provider map
        let keyEntries; // Array of { key: string, provider: string|null }
        if (Array.isArray(keyInput)) {
            // Backward compat: flat array, no provider tag
            keyEntries = keyInput.map(key => ({ key, provider: null }));
        } else if (keyInput && typeof keyInput === 'object') {
            // Provider map: { 'z.ai': ['key1.s1'], 'anthropic': ['sk-ant.s1'] }
            keyEntries = [];
            for (const [provider, keys] of Object.entries(keyInput)) {
                if (!Array.isArray(keys)) continue;
                for (const key of keys) {
                    keyEntries.push({ key, provider });
                }
            }
        } else {
            keyEntries = [];
        }

        // Clear provider indices
        this._providerKeyIndices = new Map();

        this.keys = keyEntries.map(({ key: keyStr, provider }, index) => {
            const keyId = KeyManager.getKeyId(keyStr);
            const keyInfo = {
                index,
                key: keyStr,
                keyId,
                keyPrefix: keyId.substring(0, 8),
                provider,  // null for flat array (backward compat), string for provider map
                inFlight: 0,
                totalRequests: 0,
                successCount: 0,
                rateLimitedCount: 0,        // Track how many 429s this key has received
                rateLimitedAt: null,        // Timestamp of last 429
                rateLimitCooldownMs: 1000,  // Adaptive: starts at 1s, increases on repeated 429s // Wait 60s after 429 before using key again
                latencies: new RingBuffer(100),  // O(1) circular buffer
                lastUsed: null,
                lastSuccess: null,          // Track last successful request time
                circuitBreaker: new CircuitBreaker({
                    ...this.circuitBreakerConfig,
                    onStateChange: (from, to, info) => {
                        this._log('info', `Key ${index} (${keyId.substring(0, 8)}): ${from} -> ${to}`, info);
                        this.onKeyStateChange(keyInfo, from, to, info);
                    }
                })
            };
            this.keyMap.set(keyId, keyInfo);

            // Track provider indices
            if (provider) {
                if (!this._providerKeyIndices.has(provider)) {
                    this._providerKeyIndices.set(provider, new Set());
                }
                this._providerKeyIndices.get(provider).add(index);
            }

            return keyInfo;
        });

        this._log('info', `Loaded ${this.keys.length} keys`);
        // Start background score updater for cached health scores
        this.scheduler.startScoreUpdater(this.keys);
        return this.keys.length;
    }

    /**
     * Reload keys (hot reload support)
     * @param {string[]|Object} keyInput - Flat array of key strings, or provider map
     */
    reloadKeys(keyInput) {
        // Normalize input: accept flat array or provider map
        let keyEntries; // Array of { key: string, provider: string|null }
        if (Array.isArray(keyInput)) {
            keyEntries = keyInput.map(key => ({ key, provider: null }));
        } else if (keyInput && typeof keyInput === 'object') {
            keyEntries = [];
            for (const [provider, keys] of Object.entries(keyInput)) {
                if (!Array.isArray(keys)) continue;
                for (const key of keys) {
                    keyEntries.push({ key, provider });
                }
            }
        } else {
            keyEntries = [];
        }

        const existingKeyIds = new Set(this.keys.map(k => k.keyId));
        const newKeyIds = new Set(keyEntries.map(e => KeyManager.getKeyId(e.key)));

        // Find removed keys
        const removedKeys = this.keys.filter(k => !newKeyIds.has(k.keyId));

        // Find added keys
        const addedKeyStrings = keyEntries.filter(e => !existingKeyIds.has(KeyManager.getKeyId(e.key)));

        // Update key array preserving existing stats where possible
        const oldKeyMap = new Map(this.keyMap);
        this.keys = [];
        this.keyMap.clear();

        // Clear provider indices
        this._providerKeyIndices = new Map();

        keyEntries.forEach(({ key: keyStr, provider }, index) => {
            const keyId = KeyManager.getKeyId(keyStr);
            const existing = oldKeyMap.get(keyId);

            if (existing) {
                // Preserve existing key info, update index, key string, and provider
                existing.index = index;
                existing.key = keyStr;  // Update key string in case secret portion changed
                existing.provider = provider;  // Update provider tag
                this.keys.push(existing);
                this.keyMap.set(keyId, existing);
            } else {
                // Create new key info
                const keyInfo = {
                    index,
                    key: keyStr,
                    keyId,
                    keyPrefix: keyId.substring(0, 8),
                    provider,  // null for flat array (backward compat), string for provider map
                    inFlight: 0,
                    totalRequests: 0,
                    successCount: 0,
                    rateLimitedCount: 0,
                    rateLimitedAt: null,
                    rateLimitCooldownMs: 1000,  // Adaptive: starts at 1s, increases on repeated 429s
                    latencies: new RingBuffer(100),  // O(1) circular buffer
                    lastUsed: null,
                    lastSuccess: null,
                    circuitBreaker: new CircuitBreaker({
                        ...this.circuitBreakerConfig,
                        onStateChange: (from, to, info) => {
                            this._log('info', `Key ${index}: ${from} -> ${to}`, info);
                            this.onKeyStateChange(keyInfo, from, to, info);
                        }
                    })
                };
                this.keys.push(keyInfo);
                this.keyMap.set(keyId, keyInfo);
            }

            // Track provider indices
            if (provider) {
                if (!this._providerKeyIndices.has(provider)) {
                    this._providerKeyIndices.set(provider, new Set());
                }
                this._providerKeyIndices.get(provider).add(index);
            }
        });

        this._log('info', `Reloaded keys: ${addedKeyStrings.length} added, ${removedKeys.length} removed, ${this.keys.length} total`);
        // Restart score updater with new keys reference
        this.scheduler.startScoreUpdater(this.keys);

        return {
            added: addedKeyStrings.length,
            removed: removedKeys.length,
            total: this.keys.length
        };
    }

    _log(level, message, context) {
        if (this.logger) {
            this.logger[level](message, context);
        }
    }

    /**
     * Get or create per-model pool state
     * @param {string} model - Model name, or falsy for global pool
     * @returns {Object} Pool state { rateLimitedUntil, count, lastHitAt }
     */
    _getOrCreatePool(model) {
        const key = model || '__global__';
        if (!this._modelPools.has(key)) {
            this._modelPools.set(key, {
                rateLimitedUntil: 0,
                count: 0,
                lastHitAt: 0
            });
        }
        return this._modelPools.get(key);
    }

    /**
     * Update pool average latency (called after each request)
     */
    _updatePoolAverageLatency() {
        const latencies = this.keys
            .map(k => k.latencies.stats().p50)
            .filter(l => l > 0);

        if (latencies.length > 0) {
            this._poolAvgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
        }
    }

    /**
     * Check for slow keys and mark them for deprioritization
     */
    _checkForSlowKeys() {
        this._updatePoolAverageLatency();

        if (this._poolAvgLatency === 0) return;

        const threshold = this.keySelectionConfig.slowKeyThreshold;
        const cooldown = this.keySelectionConfig.slowKeyCooldownMs;
        const now = Date.now();

        for (const key of this.keys) {
            const stats = key.latencies.stats();
            if (stats.count < 10) continue;

            const ratio = stats.p50 / this._poolAvgLatency;
            const wasSlowKey = key._isSlowKey;

            if (ratio >= threshold) {
                key._isSlowKey = true;

                // Only log if newly detected or cooldown expired
                if (!wasSlowKey || (now - (key._slowKeyWarningAt || 0)) > cooldown) {
                    key._slowKeyWarningAt = now;
                    this._log('warn', `Key ${key.keyPrefix} marked slow`, {
                        ratio: ratio.toFixed(2),
                        p50: Math.round(stats.p50),
                        poolAvg: Math.round(this._poolAvgLatency)
                    });
                }
            } else if (ratio < threshold * 0.8) {
                // Recovery: unmark if significantly below threshold
                if (wasSlowKey) {
                    key._isSlowKey = false;
                    this._log('info', `Key ${key.keyPrefix} recovered from slow status`, {
                        ratio: ratio.toFixed(2)
                    });
                }
            }
        }
    }

    /**
     * Weighted random selection based on health scores
     * Higher scores have higher probability of selection
     */
    _weightedRandomSelect(scoredKeys) {
        if (scoredKeys.length === 0) return null;
        if (scoredKeys.length === 1) return scoredKeys[0].key;

        // Calculate total weight (use score squared for stronger preference)
        const totalWeight = scoredKeys.reduce((sum, sk) => {
            const weight = Math.max(1, sk.score.total * sk.score.total / 100);
            return sum + weight;
        }, 0);

        // Random selection weighted by score
        let random = Math.random() * totalWeight;
        for (const sk of scoredKeys) {
            const weight = Math.max(1, sk.score.total * sk.score.total / 100);
            random -= weight;
            if (random <= 0) {
                return sk.key;
            }
        }

        // Fallback to first (shouldn't happen)
        return scoredKeys[0].key;
    }

    /**
     * Check if a key is available for requests
     */
    isKeyAvailable(keyInfo) {
        // Check circuit breaker
        if (!keyInfo.circuitBreaker.isAvailable()) {
            return false;
        }

        // Check rate limit (peek, don't consume - we only consume when actually selecting)
        const rateCheck = this.rateLimiter.peekLimit(keyInfo.keyId);
        if (!rateCheck.allowed) {
            return false;
        }

        return true;
    }

    /**
     * Consume a rate limit token when actually allocating a key
     * Call this after getBestKey() returns a key, before making the request
     * @param {object} keyInfo - Key info object
     * @returns {boolean} Whether token was consumed successfully
     */
    consumeRateLimit(keyInfo) {
        const rateCheck = this.rateLimiter.checkLimit(keyInfo.keyId);
        return rateCheck.allowed;
    }

    /**
     * Get the best available key using health-score weighted selection
     * Falls back to round-robin if weighted selection is disabled
     * @param {number[]} excludeIndices - Indices to exclude (already tried)
     * @param {string|null} providerFilter - If set, only return keys for this provider
     * @returns {object|null} Key info or null if none available
     */
    getBestKey(excludeIndices = [], providerFilter = null) {
        const excludeSet = new Set(excludeIndices);
        const now = Date.now();

        // Filter available keys
        const available = this.keys.filter(k => {
            if (excludeSet.has(k.index)) return false;
            if (!this.isKeyAvailable(k)) return false;
            // Provider filter: if specified, only return keys tagged for that provider.
            // Untagged keys (provider=null, from flat array) are restricted to the default
            // provider only. This prevents silently sending flat-file keys to metered providers.
            if (providerFilter) {
                if (k.provider === null) {
                    // Untagged key: only eligible for default provider (cost safety)
                    if (this.defaultProviderName && providerFilter !== this.defaultProviderName) return false;
                } else if (k.provider !== providerFilter) {
                    return false;
                }
            }
            return true;
        });

        if (available.length === 0) {
            // When filtering by provider, don't attempt circuit-breaker recovery
            // on keys from other providers - just return null
            if (providerFilter) {
                // Log why no keys are available for observability
                const totalForProvider = this.keys.filter(k => k.provider === providerFilter).length;
                const untaggedCount = this.keys.filter(k => k.provider === null).length;
                this._log('warn', `No keys available for provider '${providerFilter}'`, {
                    providerFilter,
                    taggedKeysForProvider: totalForProvider,
                    untaggedKeys: untaggedCount,
                    defaultProvider: this.defaultProviderName,
                    reason: totalForProvider === 0 && untaggedCount > 0
                        ? 'untagged keys restricted to default provider'
                        : totalForProvider === 0 ? 'no keys configured for this provider' : 'all keys excluded or unavailable'
                });
                return null;
            }
            return this._handleNoAvailableKeys(excludeSet);
        }

        // Prefer CLOSED keys over HALF_OPEN
        const closedKeys = available.filter(k =>
            k.circuitBreaker.state === STATES.CLOSED
        );
        const candidates = closedKeys.length > 0 ? closedKeys : available;

        // Filter by concurrency limit (z.ai max 2 per key)
        const underLimit = candidates.filter(k => k.inFlight < this.maxConcurrencyPerKey);

        // If all at capacity, return null to trigger queue/backpressure
        // DO NOT exceed maxConcurrencyPerKey - this causes upstream 429s
        if (underLimit.length === 0) {
            this._log('warn', `All keys at max concurrency (${this.maxConcurrencyPerKey}), request should be queued`, {
                candidateCount: candidates.length,
                totalInFlight: candidates.reduce((sum, k) => sum + k.inFlight, 0)
            });
            return null;  // Signal to caller: queue this request
        }

        // COOLDOWN DECAY: Reset escalated cooldowns after quiet period
        const cooldownDecayMs = this.cooldownDecayConfig?.cooldownDecayMs ?? 30000;
        const baseCooldownMs = this.cooldownDecayConfig?.baseCooldownMs ?? 1000;
        for (const k of underLimit) {
            if (k.rateLimitedAt && (now - k.rateLimitedAt) > cooldownDecayMs) {
                k.rateLimitCooldownMs = baseCooldownMs;
                k.rateLimitedCount = 0;
                k.rateLimitedAt = null;
            }
        }

        // SMART KEY ROTATION: Separate rate-limited keys from healthy ones
        const notRateLimited = underLimit.filter(k => {
            if (!k.rateLimitedAt) return true;
            const cooldownElapsed = now - k.rateLimitedAt;
            return cooldownElapsed >= k.rateLimitCooldownMs;
        });

        const rateLimitedButCooledDown = underLimit.filter(k => {
            if (!k.rateLimitedAt) return false;
            const cooldownElapsed = now - k.rateLimitedAt;
            return cooldownElapsed >= k.rateLimitCooldownMs;
        });

        // Prefer keys that have never been rate limited or have fully cooled down
        let selectionPool = notRateLimited.length > 0 ? notRateLimited : underLimit;

        // If we have cooled-down keys, log the rotation
        if (rateLimitedButCooledDown.length > 0 && notRateLimited.length > 0) {
            this._log('debug', `Rotating away from ${underLimit.length - notRateLimited.length} rate-limited keys`);
        }

        // Use weighted selection if enabled, otherwise round-robin
        if (this.keySelectionConfig.useWeightedSelection && selectionPool.length > 1) {
            // Update pool average for accurate scoring
            this._updatePoolAverageLatency();

            // Calculate health scores for all candidates
            const scoredKeys = selectionPool.map(key => ({
                key,
                score: this.scheduler.getCachedScore(key, this.keys)
            }));

            // Sort by score (for logging/debugging) and select
            scoredKeys.sort((a, b) => b.score.total - a.score.total);

            const selected = this._weightedRandomSelect(scoredKeys);
            return selected;
        }

        // Fallback to round-robin for single key or disabled weighted selection
        for (let i = 0; i < selectionPool.length; i++) {
            const idx = (this.roundRobinIndex + i) % selectionPool.length;
            const key = selectionPool[idx];
            this.roundRobinIndex = (idx + 1) % selectionPool.length;
            return key;
        }

        return selectionPool[0];
    }

    /**
     * Handle case when no keys are available
     */
    _handleNoAvailableKeys(excludeSet) {
        // All circuits open - force oldest to half-open
        const openKeys = this.keys
            .filter(k => !excludeSet.has(k.index) && k.circuitBreaker.state === STATES.OPEN)
            .sort((a, b) => a.circuitBreaker.openedAt - b.circuitBreaker.openedAt);

        if (openKeys.length > 0) {
            const oldest = openKeys[0];
            oldest.circuitBreaker.forceState(STATES.HALF_OPEN);
            this._log('warn', `Forced Key ${oldest.index} to HALF_OPEN (no available keys)`);
            return oldest;
        }

        // Check if all excluded or truly none
        const nonExcluded = this.keys.filter(k => !excludeSet.has(k.index));
        if (nonExcluded.length === 0) {
            return null;
        }

        // Last resort: reset all circuits
        this._log('warn', 'All keys exhausted, resetting all circuits');
        this.keys.forEach(k => k.circuitBreaker.reset());
        return this.keys.reduce((a, b) => a.inFlight <= b.inFlight ? a : b);
    }

    /**
     * Acquire a key for a request (increments inFlight and consumes rate limit token)
     *
     * Token consumption semantics:
     * - Tokens represent **attempt allocations**, not "successful upstream responses"
     * - A token is consumed when we select a key for use, before making the request
     * - This ensures we don't over-allocate beyond rate limits
     *
     * @param {number[]} excludeIndices - Indices to exclude (already tried)
     * @param {string|null} providerFilter - If set, only acquire keys for this provider
     * @returns {object|null} Key info or null if no available keys
     */
    acquireKey(excludeIndices = [], providerFilter = null) {
        const maxAttempts = this.keys.length * 2;  // Bounded loop: try each key at most twice
        const tried = new Set(excludeIndices);

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            // Get next best candidate, excluding already-tried keys
            const keyInfo = this.getBestKey([...tried], providerFilter);

            // No more keys available
            if (!keyInfo) {
                this._log('warn', 'No available keys after exhausting candidates', {
                    attempts: attempt,
                    triedCount: tried.size,
                    totalKeys: this.keys.length
                });
                return null;
            }

            // Consume rate limit token - this is the actual allocation
            const rateCheck = this.rateLimiter.checkLimit(keyInfo.keyId);

            if (!rateCheck.allowed) {
                // Rate limit exhausted - mark this key and try next one
                this._log('warn', `Key ${keyInfo.keyPrefix} rate limit exhausted on acquire`, {
                    keyIndex: keyInfo.index,
                    waitTime: rateCheck.waitTime
                });

                // Mark key as rate-limited for smart rotation
                keyInfo.rateLimitedAt = Date.now();
                keyInfo.rateLimitedCount++;
                keyInfo.rateLimitCooldownMs = Math.max(
                    keyInfo.rateLimitCooldownMs,
                    rateCheck.waitTime || 60000
                );

                // Exclude this key and try again
                tried.add(keyInfo.index);
                continue;
            }

            // Token consumed successfully - allocate the key
            keyInfo.inFlight++;
            keyInfo.totalRequests++;
            return keyInfo;
        }

        // Exhausted all attempts without finding an available key
        this._log('warn', 'Max acquisition attempts reached', {
            maxAttempts,
            triedCount: tried.size
        });
        return null;
    }

    /**
     * Record successful request
     */
    recordSuccess(keyInfo, latencyMs) {
        keyInfo.inFlight = Math.max(0, keyInfo.inFlight - 1);
        keyInfo.successCount++;
        const now = new Date().toISOString();
        keyInfo.lastUsed = now;
        keyInfo.lastSuccess = now;  // Track last successful request
        keyInfo.circuitBreaker.recordSuccess();

        // Clear rate limit cooldown on success (key is working again)
        if (keyInfo.rateLimitedAt) {
            this._log('info', `Key ${keyInfo.index} recovered from rate limit`);
            keyInfo.rateLimitedAt = null;
            // Reset adaptive cooldown to base (1s) on recovery
            keyInfo.rateLimitCooldownMs = 1000;
            // Decay rateLimitedCount (don't fully reset - remember recent history)
            keyInfo.rateLimitedCount = Math.max(0, keyInfo.rateLimitedCount - 1);
        }

        if (latencyMs !== undefined) {
            keyInfo.latencies.push(latencyMs);  // O(1) circular buffer
            // Record to histogram aggregator (#4)
            this.histogramAggregator.record(keyInfo.keyId, latencyMs);
        }

        // Update pool average for health scoring
        this._updatePoolAverageLatency();

        return {
            keyId: keyInfo.keyId,
            requests: 1,
            successes: 1,
            failures: 0,
            lastUsed: keyInfo.lastUsed
        };
    }

    /**
     * Record failed request (trips circuit breaker)
     * DO NOT use for 429s - use recordRateLimit() instead
     */
    recordFailure(keyInfo, errorType = 'unknown') {
        keyInfo.inFlight = Math.max(0, keyInfo.inFlight - 1);
        keyInfo.lastUsed = new Date().toISOString();
        keyInfo.circuitBreaker.recordFailure(errorType);

        return {
            keyId: keyInfo.keyId,
            requests: 1,
            successes: 0,
            failures: 1,
            lastUsed: keyInfo.lastUsed,
            errorType
        };
    }

    /**
     * Record rate limit (429) - does NOT trip circuit breaker
     * 429 is a capacity signal, not a key failure
     * Uses adaptive cooldown: starts at 1s, exponential backoff up to 10s
     */
    recordRateLimit(keyInfo, retryAfterMs = null) {
        keyInfo.inFlight = Math.max(0, keyInfo.inFlight - 1);
        keyInfo.lastUsed = new Date().toISOString();
        keyInfo.rateLimitedCount++;
        keyInfo.rateLimitedAt = Date.now();

        // Adaptive cooldown for 429 without Retry-After:
        // - Base: 1s (was 60s - too long for global/bursty limits)
        // - Exponential backoff on repeated 429s: 1s -> 2s -> 4s -> 8s -> 10s (cap)
        // - Reset on success (handled in recordSuccess)
        if (retryAfterMs) {
            // Use Retry-After header if provided
            keyInfo.rateLimitCooldownMs = retryAfterMs;
        } else {
            // Adaptive: base 1s, double on each 429, cap at 10s
            keyInfo.rateLimitCooldownMs = exponentialBackoff({
                baseMs: 1000,
                capMs: 10000,
                attempt: Math.min(keyInfo.rateLimitedCount, 4)
            });
        }

        this._log('warn', `Key ${keyInfo.index} rate limited (429) - cooldown ${keyInfo.rateLimitCooldownMs}ms`, {
            totalRateLimits: keyInfo.rateLimitedCount,
            retryAfterMs,
            adaptive: !retryAfterMs
        });

        // DON'T call circuitBreaker.recordFailure() - 429 is not a key failure!

        return {
            keyId: keyInfo.keyId,
            requests: 1,
            successes: 0,
            failures: 0,  // Not counted as failure for circuit breaker purposes
            rateLimited: true,
            lastUsed: keyInfo.lastUsed,
            errorType: 'rate_limited'
        };
    }

    /**
     * Record a pool-level rate limit hit (global 429 burst)
     * Used when multiple keys hit 429 within a short window, indicating account-level limit
     * @param {Object} options - Cooldown configuration
     * @param {number} options.baseMs - Base cooldown (default: 500ms)
     * @param {number} options.capMs - Maximum cooldown (default: 5000ms)
     */
    recordPoolRateLimitHit(options = {}) {
        const now = Date.now();
        const { model, baseMs = this.poolCooldownConfig.baseMs, capMs = this.poolCooldownConfig.capMs } = options;
        const pool = this._getOrCreatePool(model);

        // Capture whether pool was already in cooldown BEFORE this hit
        const wasAlreadyBlocked = now < pool.rateLimitedUntil;

        // Decay count if last 429 was more than decayMs ago
        if (now - pool.lastHitAt > this.poolCooldownConfig.decayMs) {
            pool.count = 0;
        }

        pool.lastHitAt = now;
        pool.count = Math.min(pool.count + 1, 10); // Cap to prevent unbounded growth

        // Exponential backoff: base * 2^(count-1), capped
        const cooldownMs = Math.min(baseMs * Math.pow(2, pool.count - 1), capMs);

        // Add jitter (±15%) to prevent thundering herd
        const jitter = cooldownMs * 0.15 * (Math.random() * 2 - 1);
        const finalCooldown = Math.round(cooldownMs + jitter);

        pool.rateLimitedUntil = now + finalCooldown;

        // Update legacy property for backward compatibility
        this.pool429Count = pool.count;

        this._log('warn', `Pool-level rate limit detected`, {
            model: model || 'global',
            pool429Count: pool.count,
            cooldownMs: finalCooldown,
            cooldownUntil: new Date(pool.rateLimitedUntil).toISOString()
        });

        return {
            cooldownMs: finalCooldown,
            pool429Count: pool.count,
            cooldownUntil: pool.rateLimitedUntil,
            model: model || 'global',
            wasAlreadyBlocked
        };
    }

    /**
     * Detect account-level rate limiting (multiple unique keys hitting 429 simultaneously)
     * @param {number} keyIndex - Index of key that just hit 429
     * @returns {{ isAccountLevel: boolean, cooldownMs: number }}
     */
    detectAccountLevelRateLimit(keyIndex) {
        if (!this.accountLevelConfig.enabled) {
            return { isAccountLevel: false, cooldownMs: 0 };
        }

        const now = Date.now();
        const { keyThreshold, windowMs, cooldownMs } = this.accountLevelConfig;

        // Record this hit
        this._accountLevelState.recentHits.push({ keyIndex, timestamp: now });

        // Prune hits outside the window
        this._accountLevelState.recentHits = this._accountLevelState.recentHits.filter(
            h => (now - h.timestamp) <= windowMs
        );

        // Count unique keys within window
        const uniqueKeys = new Set(this._accountLevelState.recentHits.map(h => h.keyIndex));

        if (uniqueKeys.size >= keyThreshold) {
            this._accountLevelState.cooldownUntil = now + cooldownMs;
            this._log('warn', `Account-level rate limit detected`, {
                uniqueKeys: uniqueKeys.size,
                threshold: keyThreshold,
                windowMs,
                cooldownMs
            });
            return { isAccountLevel: true, cooldownMs };
        }

        return { isAccountLevel: false, cooldownMs: 0 };
    }

    /**
     * Check if account-level rate limit is currently active
     * @returns {boolean}
     */
    isAccountLevelRateLimited() {
        return Date.now() < this._accountLevelState.cooldownUntil;
    }

    /**
     * Get remaining account-level cooldown time in milliseconds
     * @returns {number} Remaining ms, or 0 if not rate limited
     */
    getAccountLevelCooldownRemainingMs() {
        return Math.max(0, this._accountLevelState.cooldownUntil - Date.now());
    }

    /**
     * Get remaining pool cooldown time in milliseconds
     * @returns {number} Remaining cooldown in ms, or 0 if not rate limited
     */
    getPoolCooldownRemainingMs(model) {
        if (model) {
            const pool = this._modelPools.get(model);
            if (!pool) return 0;
            return Math.max(0, pool.rateLimitedUntil - Date.now());
        }
        // No model specified: return max cooldown across all pools
        let maxRemaining = 0;
        for (const pool of this._modelPools.values()) {
            const remaining = Math.max(0, pool.rateLimitedUntil - Date.now());
            if (remaining > maxRemaining) maxRemaining = remaining;
        }
        return maxRemaining;
    }

    /**
     * Check if pool is currently rate limited
     * @returns {boolean} True if pool is in cooldown
     */
    isPoolRateLimited(model) {
        if (model) {
            const pool = this._modelPools.get(model);
            return pool ? Date.now() < pool.rateLimitedUntil : false;
        }
        // No model: check if ANY pool is rate limited
        for (const pool of this._modelPools.values()) {
            if (Date.now() < pool.rateLimitedUntil) return true;
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
        for (const [model, pool] of this._modelPools.entries()) {
            pools[model] = {
                isRateLimited: now < pool.rateLimitedUntil,
                cooldownRemainingMs: Math.max(0, pool.rateLimitedUntil - now),
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
            pool429Count: this.pool429Count,
            lastPool429At: maxLastHitAt ? new Date(maxLastHitAt).toISOString() : null,
            cooldownUntil: maxRateLimitedUntil ? new Date(maxRateLimitedUntil).toISOString() : null,
            pools
        };
    }

    /**
     * Record upstream rate limit headers for proactive pacing.
     * When x-ratelimit-remaining is low, add a soft pacing delay to that model's pool.
     * @param {string} model - Target model name
     * @param {Object} headers - Response headers from upstream
     * @param {Object} pacingConfig - Pacing configuration
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
            // The fewer remaining, the longer the delay
            const urgency = 1 - (remaining / Math.max(remainingThreshold, 1));
            const delay = Math.round(pacingDelayMs * urgency);

            // Set a soft cooldown (shorter than a 429 would cause)
            // Only set if it would extend current cooldown
            const pacingUntil = Date.now() + delay;
            if (pacingUntil > pool.rateLimitedUntil) {
                pool.rateLimitedUntil = pacingUntil;
            }

            this._log('debug', `Proactive pacing for model ${model}`, {
                remaining,
                limit: isNaN(limit) ? null : limit,
                delay,
                urgency: Math.round(urgency * 100) + '%'
            });
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
        const pool = this._modelPools.get(model);
        if (!pool) return 0;
        return Math.max(0, pool.rateLimitedUntil - Date.now());
    }

    /**
     * Record socket hangup (connection issue, not key issue)
     */
    recordSocketHangup(keyInfo) {
        keyInfo.inFlight = Math.max(0, keyInfo.inFlight - 1);
        keyInfo.lastUsed = new Date().toISOString();
        // Don't record failure in circuit breaker - it's a connection issue

        return {
            keyId: keyInfo.keyId,
            requests: 1,
            successes: 0,
            failures: 0,  // Not counted as key failure
            socketHangup: true,
            lastUsed: keyInfo.lastUsed
        };
    }

    /**
     * Release key without recording (for late responses)
     */
    releaseKey(keyInfo) {
        keyInfo.inFlight = Math.max(0, keyInfo.inFlight - 1);
    }

    /**
     * Get key by index
     */
    getKeyByIndex(index) {
        return this.keys[index];
    }

    /**
     * Get key by ID
     */
    getKeyById(keyId) {
        return this.keyMap.get(keyId);
    }

    /**
     * Get statistics for all keys
     */
    getStats() {
        // Update pool average for accurate health scores
        this._updatePoolAverageLatency();

        return this.keys.map(k => {
            const latencyStats = k.latencies.stats();
            const healthScore = this.scheduler.getCachedScore(k, this.keys);

            // Calculate success rate excluding in-flight requests
            const completedRequests = k.totalRequests - k.inFlight;
            return {
                index: k.index,
                keyId: k.keyId,
                keyPrefix: k.keyPrefix,
                inFlight: k.inFlight,
                totalRequests: k.totalRequests,
                successCount: k.successCount,
                successRate: completedRequests > 0
                    ? Math.round((k.successCount / completedRequests) * 100 * 10) / 10
                    : null,
                latency: {
                    avg: latencyStats.avg,
                    min: latencyStats.min,
                    max: latencyStats.max,
                    p50: latencyStats.p50,
                    p95: latencyStats.p95,
                    p99: latencyStats.p99,
                    samples: latencyStats.count
                },
                healthScore: {
                    total: healthScore.total,
                    latency: healthScore.latencyScore,
                    success: healthScore.successScore,
                    errorRecency: healthScore.errorScore,
                    isSlowKey: k._isSlowKey || false
                },
                lastUsed: k.lastUsed,
                lastSuccess: k.lastSuccess,
                circuitBreaker: k.circuitBreaker.getStats(),
                rateLimit: this.rateLimiter.getKeyStats(k.keyId),
                rateLimitTracking: {
                    count: k.rateLimitedCount,
                    lastHit: k.rateLimitedAt,
                    cooldownMs: k.rateLimitCooldownMs,
                    inCooldown: k.rateLimitedAt ? (Date.now() - k.rateLimitedAt) < k.rateLimitCooldownMs : false,
                    cooldownRemaining: k.rateLimitedAt
                        ? Math.max(0, k.rateLimitCooldownMs - (Date.now() - k.rateLimitedAt))
                        : 0
                },
                // Circuit breaker prediction (#5)
                prediction: k.circuitBreaker.getPredictionData(),
                // Scheduler v2: selection tracking
                selectionStats: {
                    selections: this.scheduler.recorder.keySelectionCounts[k.keyId] || 0,
                    opportunities: this.scheduler.recorder.keyOpportunityCounts[k.keyId] || 0,
                    whyNot: this.scheduler.recorder.whyNotCounts[k.keyId] || {},
                    isQuarantined: k._isQuarantined || false,
                    quarantineReason: k._quarantineReason || null
                }
            };
        });
    }

    /**
     * Compare keys for normalized comparison (#8)
     * @param {number[]} keyIndices - Indices of keys to compare
     * @returns {Object} Comparison data with normalized scores
     */
    compareKeys(keyIndices = null) {
        // Default to all keys if none specified
        const indices = keyIndices || this.keys.map(k => k.index);
        const keysToCompare = indices
            .map(i => this.keys[i])
            .filter(k => k !== undefined);

        if (keysToCompare.length === 0) {
            return { error: 'No valid keys to compare', keys: [] };
        }

        // Calculate raw metrics for each key
        const rawMetrics = keysToCompare.map(k => {
            const latencyStats = k.latencies.stats();
            const completedRequests = k.totalRequests - k.inFlight;
            const successRate = completedRequests > 0
                ? k.successCount / completedRequests
                : 1;

            // Calculate stability (inverse of latency variance)
            let stability = 100;
            if (latencyStats.count >= 5 && latencyStats.p95 > 0) {
                const variance = (latencyStats.p95 - latencyStats.p50) / latencyStats.p50;
                stability = Math.max(0, 100 - (variance * 50));
            }

            return {
                keyIndex: k.index,
                keyPrefix: k.keyPrefix,
                state: k.circuitBreaker.state,
                // Raw metrics
                avgLatency: latencyStats.avg || 0,
                p50Latency: latencyStats.p50 || 0,
                p95Latency: latencyStats.p95 || 0,
                successRate: successRate * 100,
                totalRequests: k.totalRequests,
                recentFailures: k.circuitBreaker.failureTimestamps.length,
                rateLimitHits: k.rateLimitedCount,
                stability,
                inFlight: k.inFlight
            };
        });

        // Find min/max for normalization
        const metrics = ['avgLatency', 'p50Latency', 'p95Latency', 'successRate', 'stability', 'rateLimitHits'];
        const bounds = {};

        for (const metric of metrics) {
            const values = rawMetrics.map(m => m[metric]).filter(v => v > 0 || metric === 'rateLimitHits');
            bounds[metric] = {
                min: Math.min(...values),
                max: Math.max(...values)
            };
        }

        // Normalize and score each key
        const normalizedKeys = rawMetrics.map(raw => {
            // Normalize each metric to 0-100 scale
            const normalize = (value, min, max, higherIsBetter = true) => {
                if (max === min) return 100;
                const normalized = ((value - min) / (max - min)) * 100;
                return higherIsBetter ? normalized : 100 - normalized;
            };

            const normalized = {
                performance: 100 - normalize(raw.avgLatency, bounds.avgLatency.min, bounds.avgLatency.max, true),
                reliability: normalize(raw.successRate, bounds.successRate.min, bounds.successRate.max, true),
                stability: normalize(raw.stability, bounds.stability.min, bounds.stability.max, true),
                rateLimitRisk: normalize(raw.rateLimitHits, bounds.rateLimitHits.min, bounds.rateLimitHits.max, false)
            };

            // Overall score (weighted average)
            const overallScore = Math.round(
                normalized.performance * 0.30 +
                normalized.reliability * 0.35 +
                normalized.stability * 0.20 +
                normalized.rateLimitRisk * 0.15
            );

            return {
                ...raw,
                normalized,
                overallScore
            };
        });

        // Sort by overall score (best first)
        normalizedKeys.sort((a, b) => b.overallScore - a.overallScore);

        // Generate insights
        const insights = this._generateComparisonInsights(normalizedKeys);

        return {
            keys: normalizedKeys,
            bestKey: normalizedKeys[0]?.keyIndex,
            insights,
            comparedAt: new Date().toISOString()
        };
    }

    /**
     * Generate insights from key comparison
     * @param {Array} normalizedKeys - Normalized key data
     * @returns {Array} Insights
     */
    _generateComparisonInsights(normalizedKeys) {
        const insights = [];

        if (normalizedKeys.length < 2) {
            return [{ type: 'info', message: 'Need at least 2 keys for comparison insights' }];
        }

        const best = normalizedKeys[0];
        const worst = normalizedKeys[normalizedKeys.length - 1];

        // Performance gap
        if (best.normalized.performance - worst.normalized.performance > 30) {
            insights.push({
                type: 'warning',
                category: 'performance',
                message: `Key ${best.keyPrefix} is significantly faster than key ${worst.keyPrefix}`,
                data: {
                    bestLatency: best.avgLatency,
                    worstLatency: worst.avgLatency
                }
            });
        }

        // Reliability issues
        const unreliableKeys = normalizedKeys.filter(k => k.successRate < 95);
        if (unreliableKeys.length > 0) {
            insights.push({
                type: 'warning',
                category: 'reliability',
                message: `${unreliableKeys.length} key(s) have success rate below 95%`,
                data: {
                    keys: unreliableKeys.map(k => ({ keyPrefix: k.keyPrefix, rate: k.successRate.toFixed(1) }))
                }
            });
        }

        // Rate limit risk
        const rateLimitedKeys = normalizedKeys.filter(k => k.rateLimitHits > 0);
        if (rateLimitedKeys.length > 0) {
            insights.push({
                type: 'info',
                category: 'rate_limits',
                message: `${rateLimitedKeys.length} key(s) have experienced rate limiting`,
                data: {
                    keys: rateLimitedKeys.map(k => ({ keyPrefix: k.keyPrefix, hits: k.rateLimitHits }))
                }
            });
        }

        // Circuit breaker states
        const openCircuits = normalizedKeys.filter(k => k.state === 'OPEN');
        if (openCircuits.length > 0) {
            insights.push({
                type: 'critical',
                category: 'circuit_breaker',
                message: `${openCircuits.length} key(s) have OPEN circuits`,
                data: {
                    keys: openCircuits.map(k => k.keyPrefix)
                }
            });
        }

        // Overall recommendation
        if (best.overallScore > worst.overallScore + 20) {
            insights.push({
                type: 'recommendation',
                category: 'optimization',
                message: `Consider prioritizing key ${best.keyPrefix} (score: ${best.overallScore}) over key ${worst.keyPrefix} (score: ${worst.overallScore})`
            });
        }

        return insights;
    }

    /**
     * Get aggregated statistics
     */
    getAggregatedStats() {
        const now = Date.now();
        const keysInCooldown = this.keys.filter(k =>
            k.rateLimitedAt && (now - k.rateLimitedAt) < k.rateLimitCooldownMs
        );

        const stats = {
            totalKeys: this.keys.length,
            availableKeys: this.keys.filter(k => this.isKeyAvailable(k)).length,
            totalInFlight: this.keys.reduce((sum, k) => sum + k.inFlight, 0),
            totalRequests: this.keys.reduce((sum, k) => sum + k.totalRequests, 0),
            totalSuccesses: this.keys.reduce((sum, k) => sum + k.successCount, 0),
            circuitStates: {
                closed: this.keys.filter(k => k.circuitBreaker.state === STATES.CLOSED).length,
                open: this.keys.filter(k => k.circuitBreaker.state === STATES.OPEN).length,
                halfOpen: this.keys.filter(k => k.circuitBreaker.state === STATES.HALF_OPEN).length
            },
            rateLimitStatus: {
                keysInCooldown: keysInCooldown.length,
                keysAvailable: this.keys.length - keysInCooldown.length,
                total429s: this.keys.reduce((sum, k) => sum + k.rateLimitedCount, 0),
                cooldownKeyIds: keysInCooldown.map(k => k.index)
            }
        };
        return stats;
    }

    /**
     * Reset all keys
     */
    resetAll() {
        this.keys.forEach(k => {
            k.circuitBreaker.reset();
            k.inFlight = 0;
            // Reset rate limit tracking
            k.rateLimitedCount = 0;
            k.rateLimitedAt = null;
            k.lastSuccess = null;
        });
        this.rateLimiter.resetAll();
        this.roundRobinIndex = 0;
    }

    /**
     * Force circuit state for a specific key
     */
    forceCircuitState(index, state) {
        const keyInfo = this.keys[index];
        if (!keyInfo) {
            throw new Error(`Invalid key index: ${index}`);
        }
        const validStates = ['CLOSED', 'OPEN', 'HALF_OPEN'];
        if (!validStates.includes(state)) {
            throw new Error(`Invalid state: ${state}. Must be one of: ${validStates.join(', ')}`);
        }
        keyInfo.circuitBreaker.forceState(state);
        this._log('info', `Forced key ${keyInfo.keyPrefix} circuit to ${state}`);
        return { index, keyPrefix: keyInfo.keyPrefix, newState: state };
    }

    /**
     * Get pool average latency (for external monitoring)
     */
    getPoolAverageLatency() {
        return this._poolAvgLatency;
    }

    /**
     * Get global latency histogram (#4)
     * @param {string} timeRange - Time range: '5m', '15m', '1h', 'all'
     * @returns {Object} Histogram data
     */
    getLatencyHistogram(timeRange = '15m') {
        return this.histogramAggregator.getAggregatedHistogram(timeRange);
    }

    /**
     * Get latency histogram for a specific key (#4)
     * @param {number} keyIndex - Key index
     * @param {string} timeRange - Time range
     * @returns {Object|null} Histogram data or null
     */
    getKeyLatencyHistogram(keyIndex, timeRange = '15m') {
        const keyInfo = this.keys[keyIndex];
        if (!keyInfo) return null;
        return this.histogramAggregator.getKeyHistogramData(keyIndex, timeRange);
    }

    /**
     * Get scheduler statistics (selection reasons, fairness, pool state)
     * @returns {Object} Scheduler telemetry
     */
    getSchedulerStats() {
        // Update pool state before returning stats
        this.scheduler.updatePoolMetrics(this.keys);

        const stats = this.scheduler.getStats();

        // Merge with key-specific why-not counters
        const whyNotStats = stats.decisions.whyNotStats;
        const keyWhyNot = {};

        for (const key of this.keys) {
            const keyId = key.keyId;
            keyWhyNot[keyId] = whyNotStats[keyId] || {
                excluded_circuit_open: 0,
                excluded_rate_limited: 0,
                excluded_at_max_concurrency: 0,
                excluded_slow_quarantine: 0
            };
        }

        return {
            poolState: stats.poolState,
            reasonDistribution: stats.decisions.reasonDistribution,
            fairness: stats.decisions.fairness,
            recentDecisions: stats.decisions.recentDecisions,
            whyNotByKey: keyWhyNot,
            config: stats.config,
            totalDecisions: stats.decisions.totalDecisions
        };
    }

    /**
     * Record a selection decision to the scheduler
     * Call this after selecting a key to track decisions
     * @param {Object} params - Decision parameters
     */
    recordSelection(params) {
        const { SelectionContext } = require('./key-scheduler');
        const context = new SelectionContext();

        context.requestId = params.requestId;
        context.attempt = params.attempt || 0;
        context.selectedKeyIndex = params.keyIndex;
        context.selectedKeyId = params.keyId;
        context.reason = params.reason;
        context.healthScore = params.healthScore;
        context.excludedKeys = params.excludedKeys || [];
        context.competingKeys = params.competingKeys || 0;
        context.poolState = this.scheduler.getPoolState().state;
        context.totalKeyCount = this.keys.length;
        context.availableKeyCount = this.keys.filter(k => this.isKeyAvailable(k)).length;

        this.scheduler.recorder.record(context);
    }

    /**
     * Quarantine a slow key
     * @param {number} keyIndex - Key index to quarantine
     * @param {string} reason - Reason for quarantine
     */
    quarantineKey(keyIndex, reason = 'slow') {
        const keyInfo = this.keys[keyIndex];
        if (keyInfo) {
            this.scheduler.quarantineKey(keyInfo, reason);
        }
    }

    /**
     * Release a key from quarantine
     * @param {number} keyIndex - Key index to release
     */
    releaseFromQuarantine(keyIndex) {
        const keyInfo = this.keys[keyIndex];
        if (keyInfo) {
            this.scheduler.releaseFromQuarantine(keyInfo);
        }
    }

    /**
     * Get pool state
     * @returns {Object} Pool state info
     */
    getPoolState() {
        this.scheduler.updatePoolMetrics(this.keys);
        return this.scheduler.getPoolState();
    }

    /**
     * Set per-model concurrency limits from upstream metadata
     * @param {Object} limits - Map of model -> maxConcurrency
     */
    setModelConcurrencyLimits(limits) {
        for (const [model, max] of Object.entries(limits)) {
            this._modelStaticLimits.set(model, max);
            this._modelLimits.set(model, max);
        }
    }

    /**
     * Set the effective concurrency limit for a model (used by adaptive concurrency).
     * Only mutates the effective limit, not the static baseline.
     * When reducing below current inFlight, existing requests continue normally;
     * new requests are blocked until inFlight drops below the new limit.
     * @param {string} model - Model name
     * @param {number} limit - New effective limit (>= 1)
     */
    setEffectiveModelLimit(model, limit) {
        if (!model || typeof limit !== 'number' || limit < 1) return;
        this._modelLimits.set(model, Math.floor(limit));
    }

    /**
     * Get the current effective limit for a model.
     * @param {string} model
     * @returns {number|undefined}
     */
    getEffectiveModelLimit(model) {
        return this._modelLimits.get(model);
    }

    /**
     * Get the static (original) concurrency limit for a model.
     * This is the baseline from model-discovery, unaffected by adaptive concurrency.
     * @param {string} model
     * @returns {number|undefined}
     */
    getStaticModelLimit(model) {
        return this._modelStaticLimits.get(model);
    }

    /**
     * Restore all effective limits to their static baselines.
     * Used when adaptive concurrency is stopped or disabled.
     */
    restoreStaticLimits() {
        for (const [model, staticLimit] of this._modelStaticLimits) {
            this._modelLimits.set(model, staticLimit);
        }
    }

    /**
     * Acquire a concurrency slot for a model
     * @param {string} model - Target model name
     * @returns {boolean} true if slot acquired, false if model at capacity
     */
    acquireModelSlot(model) {
        if (!model) return true;
        const limit = this._modelLimits.get(model);
        // Unknown model → permissive (no blocking)
        if (limit === undefined) return true;

        const current = this._modelInFlight.get(model) || 0;
        if (current >= limit) return false;

        this._modelInFlight.set(model, current + 1);
        return true;
    }

    /**
     * Release a concurrency slot for a model
     * @param {string} model - Target model name
     */
    releaseModelSlot(model) {
        if (!model) return;
        const current = this._modelInFlight.get(model) || 0;
        if (current > 1) {
            this._modelInFlight.set(model, current - 1);
        } else {
            this._modelInFlight.delete(model);
        }
    }

    /**
     * Get current in-flight count for a model
     * @param {string} model - Target model name
     * @returns {number} Current in-flight count
     */
    getModelInFlight(model) {
        return this._modelInFlight.get(model) || 0;
    }

    /**
     * Check if a model is at its concurrency limit
     * @param {string} model - Target model name
     * @returns {boolean} true if at capacity
     */
    isModelAtCapacity(model) {
        if (!model) return false;
        const limit = this._modelLimits.get(model);
        if (limit === undefined) return false;
        return (this._modelInFlight.get(model) || 0) >= limit;
    }

    /**
     * Get per-model concurrency stats
     * @returns {Object} Map of model -> { inFlight, maxConcurrency }
     */
    getModelConcurrencyStats() {
        const stats = {};
        // Include all models that have limits or in-flight requests
        for (const [model, limit] of this._modelLimits.entries()) {
            stats[model] = {
                inFlight: this._modelInFlight.get(model) || 0,
                maxConcurrency: limit
            };
        }
        for (const [model, inFlight] of this._modelInFlight.entries()) {
            if (!stats[model]) {
                stats[model] = { inFlight, maxConcurrency: null };
            }
        }
        return stats;
    }

    // ---------------------------------------------------------------
    // ARCH-02: Snapshot Interfaces for Drift Detection
    // ---------------------------------------------------------------

    /**
     * Get snapshot of a single API key state
     * ARCH-02: Shared getKeySnapshot(keyIndex) interface formalized
     *
     * @param {number} keyIndex - Key index in keys array
     * @returns {Object|null} KeySnapshot object or null if index invalid
     */
    getKeySnapshot(keyIndex) {
        const key = this.keys[keyIndex];
        if (!key) {
            return null;
        }

        // Get state from scheduler
        const keyState = this.scheduler.getKeyState(keyIndex);
        const inFlight = this.scheduler.getInFlight(keyIndex);
        const excludedReason = this.scheduler.getExcludedReason(keyIndex);

        // Get latency stats from histogram aggregator
        const histogram = this.histogramAggregator.getKeyHistogram(keyIndex);
        const latencyStats = histogram ? {
            p50: histogram.getHistogram().stats.p50,
            p95: histogram.getHistogram().stats.p95,
            p99: histogram.getHistogram().stats.p99,
            mean: histogram.getHistogram().stats.avg
        } : null;

        // Build snapshot following KeySnapshotSchema
        return {
            version: '1.0',  // KeySnapshotSchema.VERSION
            timestamp: Date.now(),
            keyIndex,
            keyId: key.keyId,
            state: keyState || 'unknown',
            inFlight,
            maxConcurrency: this.maxConcurrencyPerKey,
            excludedReason: excludedReason || null,
            latency: latencyStats
        };
    }

    /**
     * Get snapshots for all keys
     * @returns {Array<Object>} Array of KeySnapshot objects
     */
    getAllKeySnapshots() {
        return this.keys
            .map((_, index) => this.getKeySnapshot(index))
            .filter(s => s !== null);
    }

    /**
     * Get key indices for a specific provider
     * @param {string} provider - Provider name
     * @returns {number[]} Array of key indices for this provider
     */
    getKeysForProvider(provider) {
        const indices = this._providerKeyIndices.get(provider);
        return indices ? Array.from(indices) : [];
    }

    /**
     * Check if any keys are available for a specific provider
     * @param {string} provider - Provider name
     * @returns {boolean}
     */
    hasKeysForProvider(provider) {
        const indices = this._providerKeyIndices.get(provider);
        return indices ? indices.size > 0 : false;
    }

    /**
     * Cleanup resources
     */
    destroy() {
        if (this._slowKeyCheckInterval) {
            clearInterval(this._slowKeyCheckInterval);
            this._slowKeyCheckInterval = null;
        }
        if (this.scheduler) {
            this.scheduler.destroy();
        }
        // Clean up circuit breaker timers on all keys
        if (this.keys) {
            for (const key of this.keys) {
                if (key.circuitBreaker && typeof key.circuitBreaker.destroy === 'function') {
                    key.circuitBreaker.destroy();
                }
            }
        }
    }
}

module.exports = {
    KeyManager,
    ReasonCodes,
    PoolState
};
