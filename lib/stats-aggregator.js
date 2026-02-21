/**
 * Stats Aggregator Module
 * Handles persistent stats storage and aggregation across workers
 */

const fs = require('fs');
const path = require('path');
const { LRUMap } = require('./lru-map');
const { atomicWrite } = require('./atomic-write');
const { RingBuffer } = require('./ring-buffer');

const STATS_SCHEMA_VERSION = 1;

class StatsAggregator {
    constructor(options = {}) {
        this.statsFile = options.statsFile || 'persistent-stats.json';
        this.configDir = options.configDir || __dirname;
        this.saveInterval = options.saveInterval ?? 60000;
        this.logger = options.logger;

        this.stats = this._createEmptyStats();
        this.dirty = false;
        this.saveTimer = null;
        this.pendingSaves = new Set();  // Track pending save promises for flush()

        // Error tracking with better categorization
        this.errors = {
            timeouts: 0,
            socketHangups: 0,
            connectionRefused: 0,
            serverErrors: 0,
            dnsErrors: 0,
            tlsErrors: 0,
            clientDisconnects: 0,
            rateLimited: 0,
            modelAtCapacity: 0,  // Local concurrency gate rejections
            authErrors: 0,  // 401/403 authentication errors
            brokenPipe: 0,          // EPIPE - write to closed connection
            connectionAborted: 0,   // ECONNABORTED - mid-transfer drop
            streamPrematureClose: 0, // ERR_STREAM_PREMATURE_CLOSE
            httpParseError: 0,       // HPE_* - corrupted upstream responses
            other: 0,
            totalRetries: 0,
            retriesSucceeded: 0  // Track successful retries
        };

        // Per-model usage tracking
        this.modelStats = new Map();

        // Per-model time-series (hourly buckets, keyed by model name)
        // Each entry: { times: [isoHour], tokens: [count], requests: [count] }
        this.modelTimeSeries = new Map();
        this._maxTimeSeriesBuckets = 720; // 30 days of hourly data

        // Per-model latency tracking (RingBuffer for P95 computation)
        // Used by adaptive timeout to set model-aware timeouts
        this.modelLatencies = new Map();

        // Client request tracking (not key attempts)
        // This tracks unique client requests, not retry attempts
        this.clientRequests = {
            total: 0,          // Total unique client requests received
            succeeded: 0,      // Requests that eventually succeeded (even after retries)
            failed: 0,         // Requests that ultimately failed after all retries
            inFlight: 0        // Currently processing
        };

        // Real-time stats (for /stats endpoint)
        this.realtime = {
            activeConnections: 0,
            workerStats: new Map()
        };

        // Token usage tracking (PHASE 2 - Task #4)
        this.tokens = {
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalTokens: 0,
            requestCount: 0,
            byKeyId: new LRUMap(1000)
        };

        // Connection health tracking (PHASE 3)
        this.connectionHealth = {
            totalHangups: 0,
            agentRecreations: 0,
            lastRecreationAt: null,
            consecutiveHangups: 0
        };

        // Hangup cause tracking (for diagnostics)
        // Helps identify: stale keep-alive reuse vs client abort vs network issues
        this.hangupCauses = {
            staleSocketReuse: 0,    // reusedSocket=true, clientDisconnected=false
            clientAbort: 0,         // clientDisconnected=true
            freshSocketHangup: 0,   // reusedSocket=false, clientDisconnected=false (real network issue)
            unknown: 0              // Missing data
        };

        // Telemetry tracking (dropped vs passed through)
        this.telemetry = {
            dropped: 0,
            passedThrough: 0
        };

        // Config migration write failure tracking (NORM-02)
        this.configMigration = {
            writeFailures: 0
        };

        // 429 Rate Limit tracking (upstream vs local, retry attempts)
        this.rateLimitTracking = {
            upstream429s: 0,          // 429s from upstream (z.ai)
            local429s: 0,             // 429s generated locally (backpressure)
            llm429Retries: 0,         // LLM route 429 retry attempts
            llm429RetrySuccesses: 0,  // LLM route 429 retries that succeeded
            poolCooldowns: 0          // Pool-level cooldown activations
        };

        // Early give-up tracking (Month 1 metrics)
        this.giveUpTracking = {
            total: 0,
            byReason: { max_429_attempts: 0, max_429_window: 0 }
        };

        // Retry efficiency tracking (Month 1 metrics)
        this.retryEfficiency = {
            sameModelRetries: 0,
            totalModelSwitchesOnFailure: 0,
            totalModelsTriedOnFailure: 0,
            failedRequestsWithModelStats: 0
        };

        // Retry backoff delay tracking (Month 1 metrics)
        this.retryBackoff = {
            totalDelayMs: 0,
            delayCount: 0
        };

        // Admission hold tracking (Tier-Aware Admission Hold v1)
        this.admissionHold = {
            total: 0,
            totalHoldMs: 0,
            succeeded: 0,
            timedOut: 0,
            rejected: 0,
            byTier: { light: 0, medium: 0, heavy: 0 }
        };

        // Adaptive timeout tracking (PHASE 3)
        this.adaptiveTimeouts = {
            totalRequests: 0,
            adaptiveTimeoutsUsed: 0,
            timeoutValues: new RingBuffer(100),  // Last 100 timeout values for averaging
            maxTimeoutUsed: 0,
            minTimeoutUsed: Infinity
        };

        // Health score tracking (PHASE 3)
        this.healthScores = {
            selectionsByScoreRange: {
                excellent: 0,   // 80-100
                good: 0,        // 60-79
                fair: 0,        // 40-59
                poor: 0         // 0-39
            },
            slowKeyEvents: 0,
            slowKeyRecoveries: 0
        };

        // Circuit breaker event history (Phase 2 - Task #6)
        const maxCircuitEvents = options.maxCircuitEvents || 100;
        this.circuitEvents = new RingBuffer(maxCircuitEvents);

        // Live request stream (Phase 2 - Task #10)
        const maxRecentRequests = options.maxRecentRequests || 100;
        this.recentRequests = new RingBuffer(maxRecentRequests);
        this.requestListeners = new Set(); // For SSE support
    }

    _createEmptyStats() {
        return {
            firstSeen: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
            keys: {},
            totals: {
                requests: 0,
                successes: 0,
                failures: 0,
                retries: 0
            }
        };
    }

    _getStatsPath() {
        return path.join(this.configDir, this.statsFile);
    }

    _log(level, message, context) {
        if (this.logger) {
            this.logger[level](message, context);
        }
    }

    /**
     * Load stats from file
     */
    load() {
        const statsPath = this._getStatsPath();
        try {
            if (fs.existsSync(statsPath)) {
                const data = JSON.parse(fs.readFileSync(statsPath, 'utf8'));

                // Schema version handling
                const version = data.schemaVersion || 0;
                if (version > STATS_SCHEMA_VERSION) {
                    this._log('warn', `Stats file has newer schema (v${version}), loading with best effort`);
                }
                // Remove schemaVersion from the data before merging into stats
                const { schemaVersion, ...statsData } = data;

                this.stats = {
                    ...this._createEmptyStats(),
                    ...statsData,
                    keys: statsData.keys || {},
                    totals: { ...this._createEmptyStats().totals, ...statsData.totals }
                };
                this._log('info', `Loaded persistent stats: ${Object.keys(this.stats.keys).length} keys tracked`);
                return true;
            }
        } catch (err) {
            this._log('error', `Failed to load persistent stats: ${err.message}`);
        }
        this.stats = this._createEmptyStats();
        return false;
    }

    /**
     * Save stats to file (async with atomic write via temp + rename)
     * Uses fire-and-forget to avoid blocking the event loop
     * Pending saves are tracked for flush() support
     */
    save() {
        if (!this.dirty) return false;

        const statsPath = this._getStatsPath();
        this.stats.lastUpdated = new Date().toISOString();
        this.dirty = false;

        const data = JSON.stringify({ schemaVersion: STATS_SCHEMA_VERSION, ...this.stats }, null, 2);
        const savePromise = atomicWrite(statsPath, data)
            .then(() => {
                this._log('info', `Saved persistent stats: ${this.stats.totals.requests} total requests`);
            })
            .catch((err) => {
                this.dirty = true;
                this._log('error', `Failed to save persistent stats: ${err.message}`);
            })
            .finally(() => {
                this.pendingSaves.delete(savePromise);
            });

        this.pendingSaves.add(savePromise);
        return true;
    }

    /**
     * Flush all pending saves to disk
     * Returns a promise that resolves when all pending saves complete
     * Call this during shutdown and in tests to ensure writes are persisted
     */
    async flush() {
        if (this.pendingSaves.size === 0) {
            return;  // No pending saves
        }
        // Wait for all pending save promises to settle
        await Promise.all(Array.from(this.pendingSaves));
    }

    /**
     * Drain alias for flush() - more intuitive name for "wait until done"
     */
    async drain() {
        return this.flush();
    }

    /**
     * Destroy the aggregator, stopping auto-save and flushing pending writes
     */
    async destroy() {
        this.destroyed = true;
        this.stopAutoSave();
        await this.flush();
        this.requestListeners.clear();
        this.modelStats.clear();
    }

    /**
     * Start periodic saving
     */
    startAutoSave() {
        if (this.saveTimer) return;
        this.saveTimer = setInterval(() => this.save(), this.saveInterval);
        this.saveTimer.unref();
        this._log('info', `Started auto-save every ${this.saveInterval}ms`);
    }

    /**
     * Stop periodic saving
     */
    stopAutoSave() {
        if (this.saveTimer) {
            clearInterval(this.saveTimer);
            this.saveTimer = null;
        }
    }

    /**
     * Record key usage
     */
    recordKeyUsage(keyId, data) {
        if (!this.stats.keys[keyId]) {
            this.stats.keys[keyId] = {
                firstSeen: new Date().toISOString(),
                lastUsed: null,
                totalRequests: 0,
                successes: 0,
                failures: 0,
                keyPrefix: keyId.substring(0, 8)
            };
        }

        const keyStats = this.stats.keys[keyId];
        keyStats.totalRequests += data.requests || 0;
        keyStats.successes += data.successes || 0;
        keyStats.failures += data.failures || 0;
        if (data.lastUsed) {
            keyStats.lastUsed = data.lastUsed;
        }

        this.stats.totals.requests += data.requests || 0;
        this.stats.totals.successes += data.successes || 0;
        this.stats.totals.failures += data.failures || 0;

        this.dirty = true;
    }

    /**
     * Record per-model usage
     * @param {string} model - Target GLM model name
     * @param {Object} data - { latencyMs, success, is429, inputTokens, outputTokens }
     */
    recordModelUsage(model, data = {}) {
        if (!model) return;

        if (!this.modelStats.has(model)) {
            this.modelStats.set(model, {
                requests: 0,
                successes: 0,
                failures: 0,
                rate429: 0,
                totalLatencyMs: 0,
                inputTokens: 0,
                outputTokens: 0
            });
        }

        const stats = this.modelStats.get(model);
        stats.requests++;

        if (data.success) {
            stats.successes++;
            // Only accumulate latency for successful requests
            if (data.latencyMs) {
                stats.totalLatencyMs += data.latencyMs;
                // Track in RingBuffer for percentile computation (adaptive timeout)
                if (!this.modelLatencies.has(model)) {
                    this.modelLatencies.set(model, new RingBuffer(100));
                }
                this.modelLatencies.get(model).push(data.latencyMs);
            }
        } else {
            stats.failures++;
        }

        if (data.is429) {
            stats.rate429++;
        }

        if (data.inputTokens) {
            stats.inputTokens += data.inputTokens;
        }

        if (data.outputTokens) {
            stats.outputTokens += data.outputTokens;
        }

        // Record in per-model time-series (hourly buckets)
        this._recordModelTimeSeries(model, data);

        this.dirty = true;
    }

    /**
     * Record a data point in the per-model time-series
     * @param {string} model - Model name
     * @param {Object} data - { inputTokens, outputTokens }
     */
    _recordModelTimeSeries(model, data) {
        const now = new Date();
        const hourKey = now.getFullYear() + '-' +
            String(now.getMonth() + 1).padStart(2, '0') + '-' +
            String(now.getDate()).padStart(2, '0') + ' ' +
            String(now.getHours()).padStart(2, '0') + ':00';

        if (!this.modelTimeSeries.has(model)) {
            this.modelTimeSeries.set(model, { times: [], tokens: [], requests: [] });
        }

        const series = this.modelTimeSeries.get(model);
        const lastIdx = series.times.length - 1;

        if (lastIdx >= 0 && series.times[lastIdx] === hourKey) {
            // Append to current bucket
            series.tokens[lastIdx] += (data.inputTokens || 0) + (data.outputTokens || 0);
            series.requests[lastIdx]++;
        } else {
            // New bucket
            series.times.push(hourKey);
            series.tokens.push((data.inputTokens || 0) + (data.outputTokens || 0));
            series.requests.push(1);
            // Trim old buckets
            while (series.times.length > this._maxTimeSeriesBuckets) {
                series.times.shift();
                series.tokens.shift();
                series.requests.shift();
            }
        }
    }

    /**
     * Get P95 latency for a specific model from recent samples.
     * Used by adaptive timeout to set model-aware timeouts.
     * @param {string} model - Model name
     * @returns {number|null} P95 latency in ms, or null if insufficient data
     */
    getModelP95(model) {
        const rb = this.modelLatencies.get(model);
        if (!rb || rb.size < 5) return null;
        return rb.stats().p95;
    }

    /**
     * Get per-model stats
     * @returns {Object} Model stats with computed averages
     */
    getModelStats() {
        const result = {};

        for (const [model, stats] of this.modelStats.entries()) {
            const completedRequests = stats.successes + stats.failures;
            result[model] = {
                requests: stats.requests,
                successes: stats.successes,
                failures: stats.failures,
                rate429: stats.rate429,
                avgLatencyMs: stats.successes > 0
                    ? Math.round(stats.totalLatencyMs / stats.successes)
                    : null,
                inputTokens: stats.inputTokens,
                outputTokens: stats.outputTokens,
                successRate: completedRequests > 0
                    ? Math.round((stats.successes / completedRequests) * 100 * 10) / 10
                    : null,
                p95LatencyMs: this.getModelP95(model)
            };
        }

        return result;
    }

    /**
     * Get per-model time-series data for dashboard charts
     * @returns {Object} { models: { [modelName]: { times, tokens, requests } } }
     */
    getModelTimeSeries() {
        const result = {};
        for (const [model, series] of this.modelTimeSeries.entries()) {
            result[model] = {
                times: [...series.times],
                tokens: [...series.tokens],
                requests: [...series.requests]
            };
        }
        return result;
    }

    /**
     * Record error with better categorization
     */
    recordError(errorType, errorDetails = null) {
        switch (errorType) {
            case 'timeout':
                this.errors.timeouts++;
                break;
            case 'socket_hangup':
                this.errors.socketHangups++;
                break;
            case 'connection_refused':
                this.errors.connectionRefused++;
                break;
            case 'server_error':
                this.errors.serverErrors++;
                break;
            case 'dns_error':
                this.errors.dnsErrors++;
                break;
            case 'tls_error':
                this.errors.tlsErrors++;
                break;
            case 'client_disconnect':
                this.errors.clientDisconnects++;
                break;
            case 'rate_limited':
                this.errors.rateLimited++;
                break;
            case 'model_at_capacity':
                this.errors.modelAtCapacity++;
                break;
            case 'auth_error':
                this.errors.authErrors++;
                break;
            case 'broken_pipe':
                this.errors.brokenPipe++;
                break;
            case 'connection_aborted':
                this.errors.connectionAborted++;
                break;
            case 'stream_premature_close':
                this.errors.streamPrematureClose++;
                break;
            case 'http_parse_error':
                this.errors.httpParseError++;
                break;
            default:
                this.errors.other++;
                // Log unrecognized error types for debugging
                if (errorDetails) {
                    this._log('debug', `Unrecognized error type: ${errorType}`, errorDetails);
                }
        }
    }

    /**
     * Record a successful retry (request succeeded after at least one failure)
     */
    recordRetrySuccess() {
        this.errors.retriesSucceeded++;
    }

    /**
     * Record retry
     */
    recordRetry() {
        this.errors.totalRetries++;
        this.stats.totals.retries++;
        this.dirty = true;
    }

    /**
     * Record telemetry request handling
     * @param {boolean} dropped - Whether the request was dropped (true) or passed through (false)
     */
    recordTelemetry(dropped) {
        if (dropped) {
            this.telemetry.dropped++;
        } else {
            this.telemetry.passedThrough++;
        }
    }

    /**
     * Record config migration write failure (NORM-02)
     * Called when normalized config persistence fails
     */
    recordConfigMigrationWriteFailure() {
        this.configMigration.writeFailures++;
        this.dirty = true;
    }

    // ========== 429 RATE LIMIT TRACKING ==========

    /**
     * Record an upstream 429 (confirmed from z.ai, not local backpressure)
     * Called when we have provenance evidence that 429 came from upstream
     */
    recordUpstream429() {
        this.rateLimitTracking.upstream429s++;
    }

    /**
     * Record a local 429 (generated by proxy for backpressure)
     */
    recordLocal429() {
        this.rateLimitTracking.local429s++;
    }

    /**
     * Record an LLM 429 retry attempt
     * Called when we retry a /v1/messages request after 429
     */
    recordLlm429Retry() {
        this.rateLimitTracking.llm429Retries++;
    }

    /**
     * Record a successful LLM 429 retry
     * Called when a retry after 429 succeeds with a different key
     */
    recordLlm429RetrySuccess() {
        this.rateLimitTracking.llm429RetrySuccesses++;
    }

    /**
     * Record a pool cooldown activation
     * Called when pool-level rate limiting is triggered
     */
    recordPoolCooldown() {
        this.rateLimitTracking.poolCooldowns++;
    }

    // ========== MONTH 1 METRICS: GIVE-UP, RETRY EFFICIENCY, BACKOFF ==========

    /**
     * Record an early give-up event
     * @param {string} reason - 'max_429_attempts' | 'max_429_window'
     */
    recordGiveUp(reason) {
        this.giveUpTracking.total++;
        if (reason in this.giveUpTracking.byReason) {
            this.giveUpTracking.byReason[reason]++;
        }
        this.dirty = true;
    }

    /**
     * Record a same-model retry (waste: pool assigned a model we already tried)
     */
    recordSameModelRetry() {
        this.retryEfficiency.sameModelRetries++;
        this.dirty = true;
    }

    /**
     * Record model stats for a final failed request
     * @param {number} attemptedModelsCount - Number of distinct models tried
     * @param {number} modelSwitchCount - Number of model switches during retries
     */
    recordFailedRequestModelStats(attemptedModelsCount, modelSwitchCount) {
        this.retryEfficiency.totalModelsTriedOnFailure += attemptedModelsCount;
        this.retryEfficiency.totalModelSwitchesOnFailure += modelSwitchCount;
        this.retryEfficiency.failedRequestsWithModelStats++;
        this.dirty = true;
    }

    /**
     * Record a retry backoff delay (only attempt>0 backoff sleeps)
     * @param {number} delayMs - The backoff delay in milliseconds
     */
    recordRetryBackoff(delayMs) {
        this.retryBackoff.totalDelayMs += delayMs;
        this.retryBackoff.delayCount++;
        this.dirty = true;
    }

    // ========== ADMISSION HOLD TRACKING ==========

    /**
     * Record a request entering admission hold
     * @param {string} tier - The tier that triggered the hold
     */
    recordAdmissionHold(tier) {
        this.admissionHold.total++;
        if (tier in this.admissionHold.byTier) {
            this.admissionHold.byTier[tier]++;
        }
        this.dirty = true;
    }

    /**
     * Record admission hold completion (success or timeout)
     * @param {number} holdMs - Duration of the hold in milliseconds
     * @param {boolean} succeeded - Whether the hold succeeded (capacity recovered)
     */
    recordAdmissionHoldComplete(holdMs, succeeded) {
        this.admissionHold.totalHoldMs += holdMs;
        if (succeeded) this.admissionHold.succeeded++;
        else this.admissionHold.timedOut++;
        this.dirty = true;
    }

    /**
     * Record an admission hold rejection (concurrency guard)
     */
    recordAdmissionHoldRejected() {
        this.admissionHold.rejected++;
        this.dirty = true;
    }

    /**
     * Get admission hold stats (raw counters)
     */
    getAdmissionHoldStats() {
        return {
            total: this.admissionHold.total,
            totalHoldMs: this.admissionHold.totalHoldMs,
            succeeded: this.admissionHold.succeeded,
            timedOut: this.admissionHold.timedOut,
            rejected: this.admissionHold.rejected,
            byTier: { ...this.admissionHold.byTier }
        };
    }

    /**
     * Get give-up tracking stats (raw counters)
     */
    getGiveUpStats() {
        return {
            total: this.giveUpTracking.total,
            byReason: { ...this.giveUpTracking.byReason }
        };
    }

    /**
     * Get retry efficiency stats (raw counters)
     */
    getRetryEfficiencyStats() {
        return {
            sameModelRetries: this.retryEfficiency.sameModelRetries,
            totalModelsTriedOnFailure: this.retryEfficiency.totalModelsTriedOnFailure,
            totalModelSwitchesOnFailure: this.retryEfficiency.totalModelSwitchesOnFailure,
            failedRequestsWithModelStats: this.retryEfficiency.failedRequestsWithModelStats
        };
    }

    /**
     * Get retry backoff stats (raw counters)
     */
    getRetryBackoffStats() {
        return {
            totalDelayMs: this.retryBackoff.totalDelayMs,
            delayCount: this.retryBackoff.delayCount
        };
    }

    /**
     * Get 429 rate limit tracking stats
     */
    getRateLimitTrackingStats() {
        const total429s = this.rateLimitTracking.upstream429s + this.rateLimitTracking.local429s;
        return {
            ...this.rateLimitTracking,
            total429s,
            upstreamPercent: total429s > 0
                ? Math.round((this.rateLimitTracking.upstream429s / total429s) * 100)
                : null,
            llm429RetrySuccessRate: this.rateLimitTracking.llm429Retries > 0
                ? Math.round((this.rateLimitTracking.llm429RetrySuccesses / this.rateLimitTracking.llm429Retries) * 100)
                : null
        };
    }

    /**
     * Record hangup cause for diagnostics
     * Helps identify: stale keep-alive reuse vs client abort vs network issues
     * @param {Object} cause - { reusedSocket: boolean, clientDisconnected: boolean, keyIndex: number }
     */
    recordHangupCause(cause) {
        if (!cause || typeof cause !== 'object') {
            this.hangupCauses.unknown++;
            return;
        }

        const { reusedSocket, clientDisconnected } = cause;

        if (clientDisconnected) {
            // Client aborted the request
            this.hangupCauses.clientAbort++;
        } else if (reusedSocket) {
            // Stale keep-alive socket reuse (most common cause)
            this.hangupCauses.staleSocketReuse++;
        } else if (reusedSocket === false) {
            // Fresh socket hangup (real network issue)
            this.hangupCauses.freshSocketHangup++;
        } else {
            // Missing reusedSocket info
            this.hangupCauses.unknown++;
        }
    }

    // ========== CLIENT REQUEST TRACKING ==========
    // Tracks unique client requests (not key retry attempts)

    /**
     * Record start of a new client request
     */
    recordClientRequestStart() {
        this.clientRequests.total++;
        this.clientRequests.inFlight++;
    }

    /**
     * Record successful completion of a client request
     */
    recordClientRequestSuccess() {
        this.clientRequests.succeeded++;
        this.clientRequests.inFlight = Math.max(0, this.clientRequests.inFlight - 1);
    }

    /**
     * Record failed completion of a client request (after all retries exhausted)
     */
    recordClientRequestFailure() {
        this.clientRequests.failed++;
        this.clientRequests.inFlight = Math.max(0, this.clientRequests.inFlight - 1);
    }

    /**
     * Get client request stats
     */
    getClientRequestStats() {
        const completed = this.clientRequests.succeeded + this.clientRequests.failed;
        return {
            total: this.clientRequests.total,
            succeeded: this.clientRequests.succeeded,
            failed: this.clientRequests.failed,
            inFlight: this.clientRequests.inFlight,
            successRate: completed > 0
                ? Math.round((this.clientRequests.succeeded / completed) * 100 * 10) / 10
                : null
        };
    }

    // ========== CONNECTION HEALTH TRACKING (PHASE 3) ==========

    /**
     * Record a socket hangup
     */
    recordSocketHangup() {
        this.connectionHealth.totalHangups++;
        this.connectionHealth.consecutiveHangups++;
    }

    /**
     * Record successful connection (resets consecutive hangups)
     */
    recordConnectionSuccess() {
        this.connectionHealth.consecutiveHangups = 0;
    }

    /**
     * Record agent recreation
     */
    recordAgentRecreation() {
        this.connectionHealth.agentRecreations++;
        this.connectionHealth.lastRecreationAt = new Date().toISOString();
        this.connectionHealth.consecutiveHangups = 0;
        this._log('warn', 'HTTPS agent recreated', {
            totalRecreations: this.connectionHealth.agentRecreations
        });
    }

    /**
     * Get connection health stats
     */
    getConnectionHealthStats() {
        return { ...this.connectionHealth };
    }

    // ========== ADAPTIVE TIMEOUT TRACKING (PHASE 3) ==========

    /**
     * Record an adaptive timeout value
     */
    recordAdaptiveTimeout(timeoutMs) {
        this.adaptiveTimeouts.totalRequests++;
        this.adaptiveTimeouts.adaptiveTimeoutsUsed++;

        // Track min/max
        if (timeoutMs > this.adaptiveTimeouts.maxTimeoutUsed) {
            this.adaptiveTimeouts.maxTimeoutUsed = timeoutMs;
        }
        if (timeoutMs < this.adaptiveTimeouts.minTimeoutUsed) {
            this.adaptiveTimeouts.minTimeoutUsed = timeoutMs;
        }

        // Keep last 100 values for averaging
        this.adaptiveTimeouts.timeoutValues.push(timeoutMs);
    }

    /**
     * Store latest adaptive concurrency snapshot (set by controller each tick)
     * @param {Object} snapshot - Snapshot from AdaptiveConcurrencyController.getSnapshot()
     */
    recordAdaptiveConcurrency(snapshot) {
        this._adaptiveConcurrencySnapshot = snapshot;
    }

    /**
     * Get adaptive timeout stats
     */
    getAdaptiveTimeoutStats() {
        const values = this.adaptiveTimeouts.timeoutValues.toArray();
        const avgTimeout = values.length > 0
            ? Math.round(values.reduce((a, b) => a + b, 0) / values.length)
            : 0;

        return {
            totalRequests: this.adaptiveTimeouts.totalRequests,
            adaptiveTimeoutsUsed: this.adaptiveTimeouts.adaptiveTimeoutsUsed,
            avgTimeout,
            maxTimeout: this.adaptiveTimeouts.maxTimeoutUsed || 0,
            minTimeout: this.adaptiveTimeouts.minTimeoutUsed === Infinity ? 0 : this.adaptiveTimeouts.minTimeoutUsed
        };
    }

    // ========== HEALTH SCORE TRACKING (PHASE 3) ==========

    /**
     * Record a key selection with health score
     */
    recordKeySelection(healthScore) {
        if (healthScore >= 80) {
            this.healthScores.selectionsByScoreRange.excellent++;
        } else if (healthScore >= 60) {
            this.healthScores.selectionsByScoreRange.good++;
        } else if (healthScore >= 40) {
            this.healthScores.selectionsByScoreRange.fair++;
        } else {
            this.healthScores.selectionsByScoreRange.poor++;
        }
    }

    /**
     * Record a slow key detection event
     */
    recordSlowKeyEvent() {
        this.healthScores.slowKeyEvents++;
    }

    /**
     * Record a slow key recovery
     */
    recordSlowKeyRecovery() {
        this.healthScores.slowKeyRecoveries++;
    }

    /**
     * Get health score stats
     */
    getHealthScoreStats() {
        const total = Object.values(this.healthScores.selectionsByScoreRange)
            .reduce((a, b) => a + b, 0);

        return {
            selectionsByScoreRange: { ...this.healthScores.selectionsByScoreRange },
            distributionPercentage: total > 0 ? {
                excellent: Math.round((this.healthScores.selectionsByScoreRange.excellent / total) * 100),
                good: Math.round((this.healthScores.selectionsByScoreRange.good / total) * 100),
                fair: Math.round((this.healthScores.selectionsByScoreRange.fair / total) * 100),
                poor: Math.round((this.healthScores.selectionsByScoreRange.poor / total) * 100)
            } : null,
            slowKeyEvents: this.healthScores.slowKeyEvents,
            slowKeyRecoveries: this.healthScores.slowKeyRecoveries
        };
    }

    /**
     * Update active connections count
     */
    setActiveConnections(count) {
        this.realtime.activeConnections = count;
    }

    /**
     * Increment active connections
     */
    incrementConnections() {
        this.realtime.activeConnections++;
        return this.realtime.activeConnections;
    }

    /**
     * Decrement active connections
     */
    decrementConnections() {
        this.realtime.activeConnections = Math.max(0, this.realtime.activeConnections - 1);
        return this.realtime.activeConnections;
    }

    /**
     * Update stats from a worker
     */
    updateWorkerStats(workerId, stats) {
        this.realtime.workerStats.set(workerId, {
            ...stats,
            lastUpdate: Date.now()
        });
    }

    /**
     * Get aggregated real-time stats from all workers
     */
    getAggregatedRealtimeStats() {
        const aggregated = {
            totalRequests: 0,
            activeConnections: this.realtime.activeConnections,
            keys: new Map()
        };

        for (const [workerId, workerStats] of this.realtime.workerStats) {
            aggregated.totalRequests += workerStats.totalRequests || 0;

            if (workerStats.keys) {
                for (const keyStats of workerStats.keys) {
                    const existing = aggregated.keys.get(keyStats.index);
                    if (existing) {
                        existing.inFlight += keyStats.inFlight || 0;
                        existing.totalRequests += keyStats.total || 0;
                        existing.successes += keyStats.successes || 0;
                    } else {
                        aggregated.keys.set(keyStats.index, {
                            index: keyStats.index,
                            state: keyStats.state,
                            inFlight: keyStats.inFlight || 0,
                            totalRequests: keyStats.total || 0,
                            successes: keyStats.successes || 0,
                            avgLatency: keyStats.avgLatency,
                            lastUsed: keyStats.lastUsed
                        });
                    }
                }
            }
        }

        return {
            ...aggregated,
            keys: Array.from(aggregated.keys.values()).sort((a, b) => a.index - b.index)
        };
    }

    /**
     * Get persistent stats
     */
    getPersistentStats() {
        return { ...this.stats };
    }

    /**
     * Get error stats
     */
    getErrorStats() {
        return { ...this.errors };
    }

    /**
     * Get full stats for /stats endpoint
     */
    getFullStats(keyManager, uptime, queueStats = null) {
        const keyStats = keyManager.getStats();
        const totalRequests = keyStats.reduce((sum, k) => sum + k.totalRequests, 0);
        const totalSuccesses = keyStats.reduce((sum, k) => sum + k.successCount, 0);
        const totalInFlight = keyStats.reduce((sum, k) => sum + k.inFlight, 0);
        const completedRequests = totalRequests - totalInFlight;  // Exclude in-flight from rate calc
        const uptimeMinutes = uptime / 60;  // uptime is in seconds, divide by 60 for minutes

        // Include per-model stats
        const modelStats = this.getModelStats();

        // Aggregate latency stats across all keys
        const allLatencies = {
            min: null,
            max: null,
            samples: 0
        };
        const latencyAverages = [];
        const percentileAverages = { p50: [], p95: [], p99: [] };

        keyStats.forEach(k => {
            if (k.latency.samples > 0) {
                allLatencies.samples += k.latency.samples;
                latencyAverages.push({ avg: k.latency.avg, samples: k.latency.samples });

                if (allLatencies.min === null || k.latency.min < allLatencies.min) {
                    allLatencies.min = k.latency.min;
                }
                if (allLatencies.max === null || k.latency.max > allLatencies.max) {
                    allLatencies.max = k.latency.max;
                }

                // Collect percentiles for weighted aggregation
                if (k.latency.p50 != null) {
                    percentileAverages.p50.push({ value: k.latency.p50, samples: k.latency.samples });
                }
                if (k.latency.p95 != null) {
                    percentileAverages.p95.push({ value: k.latency.p95, samples: k.latency.samples });
                }
                if (k.latency.p99 != null) {
                    percentileAverages.p99.push({ value: k.latency.p99, samples: k.latency.samples });
                }
            }
        });

        // Weighted average latency
        const weightedAvg = latencyAverages.length > 0
            ? Math.round(latencyAverages.reduce((sum, l) => sum + l.avg * l.samples, 0) / allLatencies.samples)
            : null;

        // Weighted percentiles (approximate - true percentiles would require raw data)
        const computeWeightedPercentile = (arr) => {
            if (arr.length === 0) return null;
            const totalSamples = arr.reduce((sum, p) => sum + p.samples, 0);
            return Math.round(arr.reduce((sum, p) => sum + p.value * p.samples, 0) / totalSamples);
        };

        // Get client request stats (the TRUE success rate)
        const clientStats = this.getClientRequestStats();

        return {
            uptime,
            uptimeFormatted: this._formatUptime(uptime),
            // Client request metrics (TRUE success rate - unique requests)
            clientRequests: clientStats,
            successRate: clientStats.successRate,  // Use client success rate as primary
            // Key attempt metrics (for debugging - includes retries)
            keyAttempts: {
                total: totalRequests,
                succeeded: totalSuccesses,
                inFlight: totalInFlight,
                successRate: completedRequests > 0
                    ? Math.round((totalSuccesses / completedRequests) * 100 * 10) / 10
                    : null
            },
            totalRequests: clientStats.total,  // Show client requests as primary
            requestsPerMinute: uptimeMinutes > 0
                ? Math.round((clientStats.total / uptimeMinutes) * 100) / 100
                : 0,
            inFlightRequests: clientStats.inFlight,
            activeConnections: this.realtime.activeConnections,
            latency: {
                avg: weightedAvg,
                min: allLatencies.min,
                max: allLatencies.max,
                p50: computeWeightedPercentile(percentileAverages.p50),
                p95: computeWeightedPercentile(percentileAverages.p95),
                p99: computeWeightedPercentile(percentileAverages.p99),
                spread: allLatencies.min && allLatencies.max
                    ? Math.round((allLatencies.max / allLatencies.min) * 10) / 10
                    : null,
                samples: allLatencies.samples
            },
            circuitBreaker: keyManager.circuitBreakerConfig,
            keys: keyStats.map(k => ({
                index: k.index,
                state: k.circuitBreaker.state,
                inFlight: k.inFlight,
                total: k.totalRequests,
                successes: k.successCount,
                successRate: k.successRate,
                failures: k.circuitBreaker.failureCount,
                recentFailures: k.circuitBreaker.recentFailures,
                latency: k.latency,
                healthScore: k.healthScore,
                lastUsed: k.lastUsed,
                lastSuccess: k.lastSuccess,
                lastError: k.circuitBreaker.lastError,
                ...(k.circuitBreaker.state === 'OPEN' && {
                    openedAt: k.circuitBreaker.openedAt,
                    cooldownRemaining: Math.round(k.circuitBreaker.cooldownRemaining / 1000)
                }),
                rateLimit: k.rateLimit,
                rateLimitTracking: k.rateLimitTracking
            })),
            errors: {
                ...this.errors,
                retrySuccessRate: this.errors.totalRetries > 0
                    ? Math.round((this.errors.retriesSucceeded / this.errors.totalRetries) * 100 * 10) / 10
                    : null
            },
            queue: queueStats || null,
            tokens: this.getTokenStats(),
            // New Phase 3 metrics
            connectionHealth: this.getConnectionHealthStats(),
            hangupCauses: { ...this.hangupCauses },  // Diagnostic: stale reuse vs client abort vs network
            telemetry: { ...this.telemetry },        // Telemetry requests dropped vs passed through
            rateLimitTracking: this.getRateLimitTrackingStats(),  // 429 tracking: upstream vs local, retries
            adaptiveTimeouts: this.getAdaptiveTimeoutStats(),
            healthScoreDistribution: this.getHealthScoreStats(),
            poolAverageLatency: keyManager.getPoolAverageLatency?.() || 0,
            // Pool-level rate limit status (global/account limit detection)
            poolRateLimitStatus: keyManager.getPoolRateLimitStats?.() || null,
            // Rate limit tracking aggregated
            rateLimitStatus: this._aggregateRateLimitStatus(keyStats),
            // Per-model stats
            modelStats,
            // Per-model time-series (hourly buckets)
            modelTimeSeries: this.getModelTimeSeries(),
            // Month 1 metrics
            giveUpTracking: this.getGiveUpStats(),
            retryEfficiency: this.getRetryEfficiencyStats(),
            retryBackoff: this.getRetryBackoffStats(),
            // Admission hold metrics
            admissionHold: this.getAdmissionHoldStats(),
            // Adaptive concurrency (AIMD) state
            adaptiveConcurrency: this._adaptiveConcurrencySnapshot || null
        };
    }

    /**
     * Aggregate rate limit status across all keys
     */
    _aggregateRateLimitStatus(keyStats) {
        const now = Date.now();
        const keysInCooldown = keyStats.filter(k =>
            k.rateLimitTracking && k.rateLimitTracking.inCooldown
        );

        return {
            keysInCooldown: keysInCooldown.length,
            keysAvailable: keyStats.length - keysInCooldown.length,
            total429s: keyStats.reduce((sum, k) =>
                sum + (k.rateLimitTracking?.count || 0), 0),
            cooldownKeys: keysInCooldown.map(k => ({
                index: k.index,
                remainingMs: k.rateLimitTracking.cooldownRemaining
            }))
        };
    }

    /**
     * Format uptime as human-readable string
     * @param {number} seconds - Uptime in seconds
     */
    _formatUptime(seconds) {
        const totalSeconds = Math.floor(seconds);
        const minutes = Math.floor(totalSeconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
        if (hours > 0) return `${hours}h ${minutes % 60}m ${totalSeconds % 60}s`;
        if (minutes > 0) return `${minutes}m ${totalSeconds % 60}s`;
        return `${totalSeconds}s`;
    }

    /**
     * Get persistent stats for /persistent-stats endpoint
     */
    getPersistentStatsResponse(configuredKeys) {
        const sortedKeys = Object.entries(this.stats.keys)
            .map(([keyId, data]) => ({
                keyId,
                keyPrefix: data.keyPrefix,
                ...data
            }))
            .sort((a, b) => b.totalRequests - a.totalRequests);

        const usedKeyIds = new Set(Object.keys(this.stats.keys));
        const unusedKeys = configuredKeys
            .filter(id => !usedKeyIds.has(id))
            .map(id => ({ keyId: id, keyPrefix: id.substring(0, 8) }));

        return {
            tracking: {
                since: this.stats.firstSeen,
                lastUpdated: this.stats.lastUpdated,
                totalTrackedKeys: sortedKeys.length,
                totalConfiguredKeys: configuredKeys.length
            },
            totals: this.stats.totals,
            keys: sortedKeys,
            unusedKeys: unusedKeys.length > 0 ? unusedKeys : undefined,
            validation: {
                allKeysUsed: unusedKeys.length === 0,
                unusedCount: unusedKeys.length,
                message: unusedKeys.length > 0
                    ? `${unusedKeys.length} keys have never been used since tracking started`
                    : 'All configured keys have been used'
            }
        };
    }

    /**
     * Reset all stats
     */
    reset() {
        this.stats = this._createEmptyStats();
        this.errors = {
            timeouts: 0,
            socketHangups: 0,
            connectionRefused: 0,
            serverErrors: 0,
            dnsErrors: 0,
            tlsErrors: 0,
            clientDisconnects: 0,
            rateLimited: 0,
            modelAtCapacity: 0,
            authErrors: 0,
            brokenPipe: 0,
            connectionAborted: 0,
            streamPrematureClose: 0,
            httpParseError: 0,
            other: 0,
            totalRetries: 0,
            retriesSucceeded: 0
        };
        // Reset Phase 3 metrics
        this.connectionHealth = {
            totalHangups: 0,
            agentRecreations: 0,
            lastRecreationAt: null,
            consecutiveHangups: 0
        };
        this.adaptiveTimeouts = {
            totalRequests: 0,
            adaptiveTimeoutsUsed: 0,
            timeoutValues: new RingBuffer(100),
            maxTimeoutUsed: 0,
            minTimeoutUsed: Infinity
        };
        this.healthScores = {
            selectionsByScoreRange: {
                excellent: 0,
                good: 0,
                fair: 0,
                poor: 0
            },
            slowKeyEvents: 0,
            slowKeyRecoveries: 0
        };
        // Reset client request tracking
        this.clientRequests = {
            total: 0,
            succeeded: 0,
            failed: 0,
            inFlight: 0
        };
        // Reset 429 rate limit tracking
        this.rateLimitTracking = {
            upstream429s: 0,
            local429s: 0,
            llm429Retries: 0,
            llm429RetrySuccesses: 0,
            poolCooldowns: 0
        };
        // Reset per-model stats
        this.modelStats = new Map();
        this.modelTimeSeries = new Map();
        // Reset Month 1 metrics
        this.giveUpTracking = {
            total: 0,
            byReason: { max_429_attempts: 0, max_429_window: 0 }
        };
        this.retryEfficiency = {
            sameModelRetries: 0,
            totalModelSwitchesOnFailure: 0,
            totalModelsTriedOnFailure: 0,
            failedRequestsWithModelStats: 0
        };
        this.retryBackoff = {
            totalDelayMs: 0,
            delayCount: 0
        };
        // Reset admission hold tracking
        this.admissionHold = {
            total: 0,
            totalHoldMs: 0,
            succeeded: 0,
            timedOut: 0,
            rejected: 0,
            byTier: { light: 0, medium: 0, heavy: 0 }
        };
        // Reset adaptive concurrency snapshot
        this._adaptiveConcurrencySnapshot = null;
        // Reset per-model latencies
        this.modelLatencies = new Map();
        this.dirty = true;
    }

    /**
     * Reset error stats only
     */
    resetErrors() {
        this.errors = {
            timeouts: 0,
            socketHangups: 0,
            connectionRefused: 0,
            serverErrors: 0,
            dnsErrors: 0,
            tlsErrors: 0,
            clientDisconnects: 0,
            rateLimited: 0,
            modelAtCapacity: 0,
            authErrors: 0,
            brokenPipe: 0,
            connectionAborted: 0,
            streamPrematureClose: 0,
            httpParseError: 0,
            other: 0,
            totalRetries: 0,
            retriesSucceeded: 0
        };
        this._log('info', 'Error stats reset');
    }

    // ========== TOKEN USAGE TRACKING (PHASE 2 - Task #4) ==========

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

        this.dirty = true;
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
        this.tokens = {
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalTokens: 0,
            requestCount: 0,
            byKeyId: new LRUMap(1000)
        };
        this._log('info', 'Token stats reset');
    }

    // ========== CIRCUIT BREAKER EVENT TRACKING (Phase 2 - Task #6) ==========

    /**
     * Record a circuit breaker state transition event
     * @param {number} keyIndex - Index of the key
     * @param {string} fromState - Previous state (CLOSED, OPEN, HALF_OPEN)
     * @param {string} toState - New state
     * @param {Object} metadata - Additional event data
     */
    recordCircuitEvent(keyIndex, fromState, toState, metadata = {}) {
        const event = {
            timestamp: Date.now(),
            keyIndex,
            from: fromState,
            to: toState,
            ...metadata
        };

        this.circuitEvents.push(event);
    }

    /**
     * Get circuit breaker event history
     * @param {number} limit - Maximum number of events to return
     * @returns {Array} Circuit events
     */
    getCircuitEvents(limit = 50) {
        const allEvents = this.circuitEvents.toArray();
        return allEvents.slice(-limit);
    }

    /**
     * Clear circuit event history
     */
    clearCircuitEvents() {
        this.circuitEvents.clear();
        this._log('info', 'Circuit event history cleared');
    }

    // ========== LIVE REQUEST STREAM (Phase 2 - Task #10) ==========

    /**
     * Record a request for the live stream
     * @param {Object} request - Request metadata
     */
    recordRequest(request) {
        const requestEntry = {
            id: request.id || generateRequestId(),
            timestamp: Date.now(),
            keyIndex: request.keyIndex,
            method: request.method || 'POST',
            path: request.path || '/v1/messages',
            status: request.status || 'pending',
            latency: request.latency || null,
            error: request.error || null
        };

        this.recentRequests.push(requestEntry);

        // Notify listeners (SSE clients)
        this._notifyRequestListeners(requestEntry);
    }

    /**
     * Get recent requests
     * @param {number} limit - Maximum number of requests
     * @returns {Array} Recent requests
     */
    getRecentRequests(limit = 50) {
        const allRequests = this.recentRequests.toArray();
        return allRequests.slice(-limit);
    }

    /**
     * Add a listener for request events (SSE)
     * @param {Function} listener - Callback function
     */
    addRequestListener(listener) {
        this.requestListeners.add(listener);
        return () => this.requestListeners.delete(listener);
    }

    /**
     * Remove a request listener
     * @param {Function} listener - Callback to remove
     */
    removeRequestListener(listener) {
        this.requestListeners.delete(listener);
    }

    /**
     * Notify all listeners of a new request
     * @param {Object} request - Request data
     */
    _notifyRequestListeners(request) {
        for (const listener of this.requestListeners) {
            try {
                listener(request);
            } catch (err) {
                this._log('error', 'Request listener error', { error: err.message });
            }
        }
    }
}

// Helper to generate request IDs
function generateRequestId() {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

module.exports = {
    StatsAggregator
};
