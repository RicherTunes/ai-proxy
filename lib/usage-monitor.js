/**
 * Usage Monitor Module
 * Polls z.ai account-level subscription quota and per-model usage endpoints.
 * Single source of truth for account usage data — exposed directly via /stats.
 *
 * Progressive time-series fetching:
 * - First poll: last 24h (fast, shows data immediately)
 * - Subsequent polls: backfill older data in 7-day chunks until lookbackDays reached
 * - After backfill: regular polls refresh the latest 24h and merge with cached history
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./atomic-write');

const DAY_MS = 24 * 60 * 60 * 1000;
const BACKFILL_CHUNK_DAYS = 7;
const SAVE_DEBOUNCE_MS = 10000;

class UsageMonitor {
    /**
     * @param {Object} config - usageMonitor config section
     * @param {Object} deps
     * @param {Object} deps.logger
     * @param {Object} deps.keyManager - KeyManager instance for key selection/rotation
     * @param {string} [deps.targetHost='api.z.ai'] - API hostname
     * @param {string} [deps.configDir] - Directory for persistent cache file
     */
    constructor(config, { logger, keyManager, targetHost, configDir } = {}) {
        this._config = {
            pollIntervalMs: 60000,
            timeoutMs: 10000,
            jitterRatio: 0.1,
            maxJitterMs: 2000,
            backoffMultiplier: 2,
            backoffIntervalMs: 300000,
            maxConsecutiveErrors: 5,
            exposeDetails: false,
            lookbackDays: 30,
            maxTimeSeriesPoints: 10000,
            ...config
        };

        this._logger = logger;
        this._keyManager = keyManager;
        this._targetHost = targetHost || 'api.z.ai';

        // Persistence (only when configDir explicitly provided)
        this._persistFile = config?.persistFile || 'usage-cache.json';
        this._configDir = configDir || null;
        this._persistEnabled = !!configDir;
        this._saveTimeout = null;

        // Key rotation state
        this._currentKeyIndex = 0;

        // Polling state
        this._timer = null;
        this._agent = null;
        this._consecutiveErrors = 0;

        // Per-section state
        this._sectionState = {
            quota: { data: null, lastSuccessAt: null, error: null },
            modelUsage: { data: null, lastSuccessAt: null, error: null },
            toolUsage: { data: null, lastSuccessAt: null, error: null }
        };

        // Progressive backfill state
        // Tracks the oldest timestamp we've successfully fetched back to
        this._backfill = {
            oldestFetchedMs: null,   // oldest timestamp we have data for
            complete: false,         // true when we've reached lookbackDays
            inProgress: false        // prevents concurrent backfill
        };

        // Accumulated time-series cache (merged from backfill + regular polls)
        this._timeSeriesCache = {
            times: [],       // sorted ascending
            callCounts: [],
            tokenCounts: []
        };

        // Tool usage time-series cache (parallel to model time-series)
        this._toolTimeSeriesCache = {
            times: [],
            networkSearchCount: [],
            webReadMcpCount: [],
            zreadMcpCount: [],
            searchMcpCount: []
        };

        // Snapshot cache
        this._snapshot = null;
        this._lastPollAt = null;

        // Health counters
        this._pollSuccessTotal = 0;
        this._pollErrorTotal = 0;
        this._lastSuccessAt = null;
        this._schemaValidationErrorTotal = 0;
        this._schemaValidationBySection = {
            quota: 0,
            modelUsage: 0,
            toolUsage: 0
        };

        // Anomaly detection state (COST-07)
        this._anomalyConfig = {
            enabled: true,
            rateJumpThreshold: 2.5,
            staleFeedThresholdMs: 300000,
            quotaWarningThresholds: [0.8, 0.95],
            minDataPoints: 6,
            cooldownMs: 3600000,
            ...(config?.anomaly || {})
        };
        this._onAnomalyAlert = null;
        this._prevSnapshot = null;
        this._anomalyAlerts = [];
        this._anomalyCooldowns = {};
        this._staleFeedAlerted = false;
        this._quotaThresholdsFired = new Set();

        // Load persisted cache (if any)
        this._load();
    }

    /**
     * Start polling. First poll scheduled immediately.
     */
    start() {
        if (this._timer) return;

        this._agent = new https.Agent({
            keepAlive: true,
            maxSockets: 2,
            timeout: this._config.timeoutMs
        });

        this._schedulePoll(0);
    }

    /**
     * Stop polling and destroy resources.
     */
    stop() {
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        if (this._saveTimeout) {
            clearTimeout(this._saveTimeout);
            this._saveTimeout = null;
        }
        if (this._agent) {
            this._agent.destroy();
            this._agent = null;
        }
    }

    /**
     * Return cached snapshot with stale flag.
     * @returns {Object|null}
     */
    getSnapshot() {
        if (!this._snapshot) return null;

        const staleness = this._lastPollAt
            ? Date.now() - this._lastPollAt
            : Infinity;
        const stale = staleness > this._config.pollIntervalMs * 2;
        const { partial, sourceUnavailable } = this._computeSourceFlags();

        return { ...this._snapshot, stale, partial, sourceUnavailable };
    }

    /**
     * Observability metrics for dashboards.
     * @returns {Object}
     */
    getHealthMetrics() {
        const now = Date.now();
        return {
            pollSuccessTotal: this._pollSuccessTotal,
            pollErrorTotal: this._pollErrorTotal,
            consecutiveErrors: this._consecutiveErrors,
            lastSuccessAt: this._lastSuccessAt,
            staleSeconds: this._lastSuccessAt
                ? Math.round((now - this._lastSuccessAt) / 1000)
                : null,
            currentKeyIndex: this._currentKeyIndex,
            schemaValidationErrorTotal: this._schemaValidationErrorTotal,
            schemaValidationBySection: { ...this._schemaValidationBySection }
        };
    }

    /**
     * Return full raw data for the on-demand details endpoint.
     * Always returns full detail regardless of exposeDetails flag.
     */
    getDetails() {
        const qData = this._sectionState.quota.data;
        const mData = this._sectionState.modelUsage.data;
        const tData = this._sectionState.toolUsage.data;

        let quota = null;
        if (qData) {
            quota = {
                level: qData.level || null,
                limits: (qData.limits || []).map(l => ({
                    type: l.type,
                    unit: l.unit,
                    usage: l.usage,
                    currentValue: l.currentValue,
                    remaining: l.remaining,
                    percentage: l.percentage,
                    nextResetTime: l.nextResetTime
                })),
                toolDetails: []
            };
            const timeLimit = (qData.limits || []).find(l => l.type === 'TIME_LIMIT');
            if (timeLimit && timeLimit.usageDetails) {
                quota.toolDetails = timeLimit.usageDetails.map(d => ({
                    model: d.modelCode,
                    usage: d.usage
                }));
            }
        }

        let modelUsage = null;
        if (mData) {
            const total = mData.totalUsage || {};
            modelUsage = {
                totalRequests: total.totalModelCallCount ?? 0,
                totalTokens: total.totalTokensUsage ?? 0,
                timeSeries: this._timeSeriesCache.times.length > 0
                    ? { ...this._timeSeriesCache }
                    : null,
                backfillComplete: this._backfill.complete
            };
        }

        let toolUsage = null;
        if (tData) {
            const total = tData.totalUsage || {};
            toolUsage = {
                tools: {
                    networkSearch: total.totalNetworkSearchCount ?? 0,
                    webRead: total.totalWebReadMcpCount ?? 0,
                    zread: total.totalZreadMcpCount ?? 0,
                    search: total.totalSearchMcpCount ?? 0
                },
                timeSeries: this._toolTimeSeriesCache.times.length > 0
                    ? { ...this._toolTimeSeriesCache }
                    : null,
                toolDetails: total.toolDetails || []
            };
        }

        return {
            quota,
            modelUsage,
            toolUsage,
            _monitor: this.getHealthMetrics()
        };
    }

    /**
     * Flush cache to disk and stop polling.
     * Called during graceful shutdown.
     */
    async persistAndStop() {
        // Cancel debounced save
        if (this._saveTimeout) {
            clearTimeout(this._saveTimeout);
            this._saveTimeout = null;
        }
        // Immediate save
        await this._performSave();
        this.stop();
    }

    // ---- Persistence ----

    /**
     * Load persisted cache from disk (synchronous, like CostTracker._load).
     */
    _load() {
        if (!this._persistEnabled) return;
        try {
            const filePath = path.join(this._configDir, this._persistFile);
            const raw = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed.version !== 1) {
                this._logger?.warn('Usage monitor: ignoring cache with unknown version', { version: parsed.version });
                return;
            }

            // Restore time-series cache
            if (parsed.timeSeriesCache && Array.isArray(parsed.timeSeriesCache.times)) {
                this._timeSeriesCache = {
                    times: parsed.timeSeriesCache.times,
                    callCounts: parsed.timeSeriesCache.callCounts || [],
                    tokenCounts: parsed.timeSeriesCache.tokenCounts || []
                };
            }

            // Restore tool time-series cache
            if (parsed.toolTimeSeriesCache && Array.isArray(parsed.toolTimeSeriesCache.times)) {
                this._toolTimeSeriesCache = {
                    times: parsed.toolTimeSeriesCache.times,
                    networkSearchCount: parsed.toolTimeSeriesCache.networkSearchCount || [],
                    webReadMcpCount: parsed.toolTimeSeriesCache.webReadMcpCount || [],
                    zreadMcpCount: parsed.toolTimeSeriesCache.zreadMcpCount || [],
                    searchMcpCount: parsed.toolTimeSeriesCache.searchMcpCount || []
                };
            }

            this._enforceTimeSeriesBounds();

            // Restore backfill state
            if (parsed.backfill) {
                this._backfill.oldestFetchedMs = parsed.backfill.oldestFetchedMs ?? null;
                this._backfill.complete = parsed.backfill.complete ?? false;
            }

            // Restore section state (so getSnapshot works before first poll)
            if (parsed.sectionState) {
                for (const key of ['quota', 'modelUsage', 'toolUsage']) {
                    if (parsed.sectionState[key]) {
                        this._sectionState[key].data = parsed.sectionState[key].data || null;
                        this._sectionState[key].lastSuccessAt = parsed.sectionState[key].lastSuccessAt || null;
                    }
                }
            }

            // Rebuild snapshot from loaded data
            if (this._sectionState.quota.data || this._sectionState.modelUsage.data) {
                this._lastPollAt = parsed.savedAt || Date.now();
                this._snapshot = this._buildSnapshot(Date.now());
            }

            this._logger?.info?.('Usage monitor: loaded cache', {
                dataPoints: this._timeSeriesCache.times.length,
                backfillComplete: this._backfill.complete
            });
        } catch (err) {
            if (err.code !== 'ENOENT') {
                this._logger?.warn('Usage monitor: failed to load cache, starting fresh', { error: err.message });
            }
        }
    }

    /**
     * Debounced save — triggers _performSave after SAVE_DEBOUNCE_MS.
     */
    _save() {
        if (!this._persistEnabled) return;
        if (this._saveTimeout) clearTimeout(this._saveTimeout);
        this._saveTimeout = setTimeout(() => {
            this._performSave().catch(err => {
                this._logger?.warn('Usage monitor: save failed in debounced callback', { error: err.message });
            });
        }, SAVE_DEBOUNCE_MS);
        this._saveTimeout.unref();
    }

    /**
     * Perform the actual write to disk.
     */
    async _performSave() {
        if (!this._persistEnabled) return;
        try {
            const payload = {
                version: 1,
                savedAt: Date.now(),
                timeSeriesCache: this._timeSeriesCache,
                toolTimeSeriesCache: this._toolTimeSeriesCache,
                backfill: {
                    oldestFetchedMs: this._backfill.oldestFetchedMs,
                    complete: this._backfill.complete
                },
                sectionState: {
                    quota: { data: this._sectionState.quota.data, lastSuccessAt: this._sectionState.quota.lastSuccessAt },
                    modelUsage: { data: this._sectionState.modelUsage.data, lastSuccessAt: this._sectionState.modelUsage.lastSuccessAt },
                    toolUsage: { data: this._sectionState.toolUsage.data, lastSuccessAt: this._sectionState.toolUsage.lastSuccessAt }
                }
            };
            const filePath = path.join(this._configDir, this._persistFile);
            await atomicWrite(filePath, JSON.stringify(payload));
        } catch (err) {
            this._logger?.warn('Usage monitor: failed to save cache', { error: err.message });
        }
    }

    // ---- Internal ----

    _schedulePoll(delayMs) {
        const safeDelay = Math.max(0, Number(delayMs) || 0);
        const jitter = this._computeJitterMs(safeDelay);
        this._timer = setTimeout(() => this._poll(), safeDelay + jitter);
        this._timer.unref();
    }

    _computeJitterMs(baseDelayMs) {
        const ratio = Math.max(0, Number(this._config.jitterRatio) || 0);
        const maxJitterMs = Math.max(0, Number(this._config.maxJitterMs) || 0);
        const boundedJitter = Math.min(maxJitterMs, Math.floor(baseDelayMs * ratio));
        if (boundedJitter <= 0) return 0;
        return Math.floor(Math.random() * boundedJitter);
    }

    _computeErrorDelayMs() {
        const basePollMs = Math.max(1, Number(this._config.pollIntervalMs) || 1);
        const backoffCapMs = Math.max(basePollMs, Number(this._config.backoffIntervalMs) || basePollMs);
        const threshold = Math.max(1, Number(this._config.maxConsecutiveErrors) || 1);
        const multiplier = Math.max(1, Number(this._config.backoffMultiplier) || 1);

        if (this._consecutiveErrors < threshold) {
            return basePollMs;
        }

        const exp = this._consecutiveErrors - threshold + 1;
        const scaled = Math.floor(basePollMs * (multiplier ** exp));
        return Math.min(backoffCapMs, scaled);
    }

    /**
     * Format date as 'yyyy-MM-dd HH:mm:ss' (z.ai API requirement).
     */
    _formatTime(date) {
        return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    }

    async _poll() {
        this._timer = null;
        this._lastPollAt = Date.now();

        const now = Date.now();
        // Regular polls always fetch last 24h for fresh data
        const startTime = encodeURIComponent(this._formatTime(new Date(now - DAY_MS)));
        const endTime = encodeURIComponent(this._formatTime(new Date(now)));

        // Fetch all 3 endpoints independently — partial failure OK
        const [quotaResult, modelResult, toolResult] = await Promise.allSettled([
            this._fetchUnwrapped('/api/monitor/usage/quota/limit'),
            this._fetchUnwrapped(`/api/monitor/usage/model-usage?startTime=${startTime}&endTime=${endTime}`),
            this._fetchUnwrapped(`/api/monitor/usage/tool-usage?startTime=${startTime}&endTime=${endTime}`)
        ]);

        let anySuccess = false;

        // Process quota
        if (quotaResult.status === 'fulfilled') {
            const validation = this._validateSectionPayload('quota', quotaResult.value);
            if (validation.valid) {
                this._sectionState.quota.data = quotaResult.value;
                this._sectionState.quota.lastSuccessAt = now;
                this._sectionState.quota.error = null;
                anySuccess = true;
            } else {
                this._recordSchemaValidationError('quota', validation.error);
            }
        } else {
            this._sectionState.quota.error = quotaResult.reason?.message || 'Unknown error';
        }

        // Process model usage — merge into time-series cache
        if (modelResult.status === 'fulfilled') {
            const validation = this._validateSectionPayload('modelUsage', modelResult.value);
            if (validation.valid) {
                this._sectionState.modelUsage.data = modelResult.value;
                this._sectionState.modelUsage.lastSuccessAt = now;
                this._sectionState.modelUsage.error = null;
                anySuccess = true;

                // Merge 24h data into cache
                this._mergeTimeSeries(modelResult.value);

                // Initialize backfill anchor on first success
                if (this._backfill.oldestFetchedMs === null) {
                    this._backfill.oldestFetchedMs = now - DAY_MS;
                }
            } else {
                this._recordSchemaValidationError('modelUsage', validation.error);
            }
        } else {
            this._sectionState.modelUsage.error = modelResult.reason?.message || 'Unknown error';
        }

        // Process tool usage
        if (toolResult.status === 'fulfilled') {
            const validation = this._validateSectionPayload('toolUsage', toolResult.value);
            if (validation.valid) {
                this._sectionState.toolUsage.data = toolResult.value;
                this._sectionState.toolUsage.lastSuccessAt = now;
                this._sectionState.toolUsage.error = null;
                anySuccess = true;

                // Merge tool time-series into cache
                this._mergeToolTimeSeries(toolResult.value);
            } else {
                this._recordSchemaValidationError('toolUsage', validation.error);
            }
        } else {
            this._sectionState.toolUsage.error = toolResult.reason?.message || 'Unknown error';
        }

        // Update counters BEFORE building snapshot so it reflects current poll
        if (anySuccess) {
            this._pollSuccessTotal++;
            this._lastSuccessAt = now;
            this._consecutiveErrors = 0;
        } else {
            this._pollErrorTotal++;
            this._consecutiveErrors++;
        }

        // Build snapshot (includes updated counters)
        this._snapshot = this._buildSnapshot(now);

        // Anomaly detection (COST-07)
        if (this._anomalyConfig.enabled) {
            const enriched = this.getSnapshot();
            this._checkAnomalies(enriched, this._prevSnapshot);
            this._prevSnapshot = enriched;
        }

        if (anySuccess) {
            this._pruneTimeSeries();
            this._save();
            this._schedulePoll(this._config.pollIntervalMs);

            // Kick off backfill if not complete yet
            if (!this._backfill.complete && !this._backfill.inProgress) {
                this._scheduleBackfill();
            }
        } else {
            const interval = this._computeErrorDelayMs();
            this._logger?.warn('Usage monitor: all sections failed', {
                consecutiveErrors: this._consecutiveErrors,
                nextPollMs: interval
            });
            this._schedulePoll(interval);
        }
    }

    /**
     * Remove entries older than lookbackDays from both time-series caches.
     */
    _pruneTimeSeries() {
        if (!this._config.lookbackDays || this._config.lookbackDays <= 0) {
            this._enforceTimeSeriesBounds();
            return;
        }
        const cutoff = this._formatTime(new Date(Date.now() - this._config.lookbackDays * DAY_MS));

        // Prune model time-series
        if (this._timeSeriesCache.times.length > 0) {
            let idx = 0;
            while (idx < this._timeSeriesCache.times.length && this._timeSeriesCache.times[idx] < cutoff) idx++;
            if (idx > 0) {
                this._timeSeriesCache.times = this._timeSeriesCache.times.slice(idx);
                this._timeSeriesCache.callCounts = this._timeSeriesCache.callCounts.slice(idx);
                this._timeSeriesCache.tokenCounts = this._timeSeriesCache.tokenCounts.slice(idx);
            }
        }

        // Prune tool time-series
        if (this._toolTimeSeriesCache.times.length > 0) {
            let idx = 0;
            while (idx < this._toolTimeSeriesCache.times.length && this._toolTimeSeriesCache.times[idx] < cutoff) idx++;
            if (idx > 0) {
                const fields = ['networkSearchCount', 'webReadMcpCount', 'zreadMcpCount', 'searchMcpCount'];
                this._toolTimeSeriesCache.times = this._toolTimeSeriesCache.times.slice(idx);
                for (const f of fields) {
                    this._toolTimeSeriesCache[f] = this._toolTimeSeriesCache[f].slice(idx);
                }
            }
        }

        this._enforceTimeSeriesBounds();
    }

    /**
     * Merge fetched time-series data into the accumulated cache.
     * Handles overlapping time ranges by deduplicating on timestamp.
     */
    _mergeTimeSeries(mData) {
        if (!mData || !mData.x_time || !mData.x_time.length) return;

        const newTimes = mData.x_time;
        const newCalls = mData.modelCallCount || [];
        const newTokens = mData.tokensUsage || [];

        if (this._timeSeriesCache.times.length === 0) {
            // First data — just assign
            this._timeSeriesCache.times = [...newTimes];
            this._timeSeriesCache.callCounts = [...newCalls];
            this._timeSeriesCache.tokenCounts = [...newTokens];
            this._enforceTimeSeriesBounds();
            return;
        }

        // Build a Map for fast dedup — new data overwrites old for same timestamp
        const map = new Map();
        const cache = this._timeSeriesCache;
        for (let i = 0; i < cache.times.length; i++) {
            map.set(cache.times[i], { calls: cache.callCounts[i], tokens: cache.tokenCounts[i] });
        }
        for (let i = 0; i < newTimes.length; i++) {
            map.set(newTimes[i], { calls: newCalls[i], tokens: newTokens[i] });
        }

        // Sort by timestamp string (yyyy-MM-dd HH:mm format sorts lexicographically)
        const sorted = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        this._timeSeriesCache.times = sorted.map(e => e[0]);
        this._timeSeriesCache.callCounts = sorted.map(e => e[1].calls);
        this._timeSeriesCache.tokenCounts = sorted.map(e => e[1].tokens);
        this._enforceTimeSeriesBounds();
    }

    /**
     * Merge tool usage time-series data into the tool cache.
     */
    _mergeToolTimeSeries(tData) {
        if (!tData || !tData.x_time || !tData.x_time.length) return;

        const newTimes = tData.x_time;
        const fields = ['networkSearchCount', 'webReadMcpCount', 'zreadMcpCount', 'searchMcpCount'];

        if (this._toolTimeSeriesCache.times.length === 0) {
            this._toolTimeSeriesCache.times = [...newTimes];
            for (const f of fields) {
                this._toolTimeSeriesCache[f] = [...(tData[f] || [])];
            }
            this._enforceTimeSeriesBounds();
            return;
        }

        const map = new Map();
        const cache = this._toolTimeSeriesCache;
        for (let i = 0; i < cache.times.length; i++) {
            const entry = {};
            for (const f of fields) entry[f] = cache[f][i];
            map.set(cache.times[i], entry);
        }
        for (let i = 0; i < newTimes.length; i++) {
            const entry = {};
            for (const f of fields) entry[f] = (tData[f] || [])[i];
            map.set(newTimes[i], entry);
        }

        const sorted = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        this._toolTimeSeriesCache.times = sorted.map(e => e[0]);
        for (const f of fields) {
            this._toolTimeSeriesCache[f] = sorted.map(e => e[1][f]);
        }
        this._enforceTimeSeriesBounds();
    }

    /**
     * Schedule a backfill fetch for the next chunk of historical data.
     * Fetches in BACKFILL_CHUNK_DAYS-day chunks going backwards from the oldest
     * data we already have, until we reach lookbackDays.
     */
    _scheduleBackfill() {
        // Small delay so we don't hammer the API immediately after the regular poll
        const timer = setTimeout(() => {
            this._doBackfill().catch(err => {
                this._backfill.inProgress = false;
                this._logger?.warn('Usage monitor: backfill failed', { error: err.message });
            });
        }, 5000);
        timer.unref();
    }

    async _doBackfill() {
        if (this._backfill.complete || this._backfill.inProgress) return;
        if (!this._agent) return; // stopped

        const targetMs = Date.now() - this._config.lookbackDays * DAY_MS;

        // Already reached the lookback target — nothing more to fetch
        if (this._backfill.oldestFetchedMs !== null && this._backfill.oldestFetchedMs <= targetMs) {
            this._backfill.complete = true;
            this._snapshot = this._buildSnapshot(Date.now());
            return;
        }

        this._backfill.inProgress = true;

        try {
            const chunkEnd = this._backfill.oldestFetchedMs;
            const chunkStart = Math.max(chunkEnd - BACKFILL_CHUNK_DAYS * DAY_MS, targetMs);

            const startTime = encodeURIComponent(this._formatTime(new Date(chunkStart)));
            const endTime = encodeURIComponent(this._formatTime(new Date(chunkEnd)));

            const data = await this._fetchUnwrapped(
                `/api/monitor/usage/model-usage?startTime=${startTime}&endTime=${endTime}`
            );

            this._mergeTimeSeries(data);
            this._backfill.oldestFetchedMs = chunkStart;

            // Check if backfill is complete
            if (chunkStart <= targetMs) {
                this._backfill.complete = true;
                this._logger?.info?.('Usage monitor: backfill complete', {
                    days: this._config.lookbackDays,
                    dataPoints: this._timeSeriesCache.times.length
                });
            }

            // Rebuild snapshot with updated time-series
            this._snapshot = this._buildSnapshot(Date.now());
            this._save();

            // Schedule next chunk if not done
            if (!this._backfill.complete && this._agent) {
                this._scheduleBackfill();
            }
        } catch (err) {
            this._logger?.warn('Usage monitor: backfill chunk failed, will retry next cycle', {
                error: err.message
            });
            // Don't retry immediately — next regular poll will trigger another backfill attempt
        } finally {
            this._backfill.inProgress = false;
        }
    }

    _buildSnapshot(now) {
        const exposeDetails = this._config.exposeDetails;
        const { partial, sourceUnavailable } = this._computeSourceFlags();

        // --- Quota section ---
        // z.ai shape: { limits: [{ type, usage, currentValue, remaining, percentage, nextResetTime, usageDetails }], level }
        let quota = null;
        const qData = this._sectionState.quota.data;
        if (qData) {
            const limits = Array.isArray(qData.limits) ? qData.limits : [];
            const tokensLimit = limits.find(l => l.type === 'TOKENS_LIMIT');
            const timeLimit = limits.find(l => l.type === 'TIME_LIMIT');

            quota = {
                level: qData.level || null,
                tokenUsagePercent: tokensLimit?.percentage ?? null,
                tokenNextResetAt: tokensLimit?.nextResetTime ?? null,
                toolUsage: null,
                lastSuccessAt: this._sectionState.quota.lastSuccessAt,
                error: this._sectionState.quota.error
            };

            // Tool usage from TIME_LIMIT entry
            if (timeLimit) {
                quota.toolUsage = {
                    limit: timeLimit.usage ?? 0,
                    used: timeLimit.currentValue ?? 0,
                    remaining: timeLimit.remaining ?? 0,
                    percent: timeLimit.percentage ?? 0
                };

                if (exposeDetails && timeLimit.usageDetails) {
                    quota.toolDetails = timeLimit.usageDetails.map(d => ({
                        model: d.modelCode,
                        usage: d.usage
                    }));
                }
            }
        } else if (this._sectionState.quota.error) {
            quota = {
                lastSuccessAt: this._sectionState.quota.lastSuccessAt,
                error: this._sectionState.quota.error
            };
        }

        // --- Model usage section ---
        // Uses accumulated time-series cache (progressive backfill)
        let modelUsage = null;
        const mData = this._sectionState.modelUsage.data;
        if (mData) {
            const total = this._isObject(mData.totalUsage) ? mData.totalUsage : {};
            modelUsage = {
                totalRequests: total.totalModelCallCount ?? 0,
                totalTokens: total.totalTokensUsage ?? 0,
                lastSuccessAt: this._sectionState.modelUsage.lastSuccessAt,
                error: this._sectionState.modelUsage.error
            };

            // Include accumulated time series from cache (not just last poll)
            if (this._timeSeriesCache.times.length > 0) {
                modelUsage.timeSeries = {
                    times: this._timeSeriesCache.times,
                    callCounts: this._timeSeriesCache.callCounts,
                    tokenCounts: this._timeSeriesCache.tokenCounts
                };
                modelUsage.timeSeriesBackfillComplete = this._backfill.complete;
            }
        } else if (this._sectionState.modelUsage.error) {
            modelUsage = {
                lastSuccessAt: this._sectionState.modelUsage.lastSuccessAt,
                error: this._sectionState.modelUsage.error
            };
        }

        // --- Tool usage section ---
        // z.ai shape: { x_time: [], networkSearchCount: [], ..., totalUsage: { totalNetworkSearchCount, ..., toolDetails } }
        let toolUsage = null;
        const tData = this._sectionState.toolUsage.data;
        if (tData) {
            const total = this._isObject(tData.totalUsage) ? tData.totalUsage : {};
            toolUsage = {
                tools: {
                    networkSearch: total.totalNetworkSearchCount ?? 0,
                    webRead: total.totalWebReadMcpCount ?? 0,
                    zread: total.totalZreadMcpCount ?? 0,
                    search: total.totalSearchMcpCount ?? 0
                },
                lastSuccessAt: this._sectionState.toolUsage.lastSuccessAt,
                error: this._sectionState.toolUsage.error
            };

            if (exposeDetails && total.toolDetails) {
                toolUsage.toolDetails = total.toolDetails;
            }
        } else if (this._sectionState.toolUsage.error) {
            toolUsage = {
                lastSuccessAt: this._sectionState.toolUsage.lastSuccessAt,
                error: this._sectionState.toolUsage.error
            };
        }

        return {
            schemaVersion: 1,
            lastPollAt: this._lastPollAt,
            partial,
            sourceUnavailable,
            quota,
            modelUsage,
            toolUsage,
            _monitor: this.getHealthMetrics()
        };
    }

    /**
     * Derive top-level source availability flags from per-section state.
     * partial=true when at least one section has an error but source is not fully unavailable.
     * sourceUnavailable=true when all sections failed and none has cached data.
     * @returns {{partial: boolean, sourceUnavailable: boolean}}
     */
    _computeSourceFlags() {
        const sections = Object.values(this._sectionState || {});
        if (sections.length === 0) {
            return { partial: false, sourceUnavailable: false };
        }

        const anyError = sections.some(section => !!section?.error);
        const sourceUnavailable = sections.every(section => !section?.data && !!section?.error);
        const partial = !sourceUnavailable && anyError;

        return { partial, sourceUnavailable };
    }

    _isObject(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    _validateSectionPayload(section, payload) {
        if (!this._isObject(payload)) {
            return { valid: false, error: 'payload must be an object' };
        }

        if (section === 'quota') {
            if (payload.limits !== undefined && !Array.isArray(payload.limits)) {
                return { valid: false, error: 'quota.limits must be an array when provided' };
            }
            if (payload.level !== undefined && payload.level !== null && typeof payload.level !== 'string') {
                return { valid: false, error: 'quota.level must be a string when provided' };
            }
            return { valid: true };
        }

        if (section === 'modelUsage') {
            if (payload.totalUsage !== undefined && !this._isObject(payload.totalUsage)) {
                return { valid: false, error: 'modelUsage.totalUsage must be an object when provided' };
            }
            if (payload.x_time !== undefined && !Array.isArray(payload.x_time)) {
                return { valid: false, error: 'modelUsage.x_time must be an array when provided' };
            }
            return { valid: true };
        }

        if (section === 'toolUsage') {
            if (payload.totalUsage !== undefined && !this._isObject(payload.totalUsage)) {
                return { valid: false, error: 'toolUsage.totalUsage must be an object when provided' };
            }
            if (payload.x_time !== undefined && !Array.isArray(payload.x_time)) {
                return { valid: false, error: 'toolUsage.x_time must be an array when provided' };
            }
            return { valid: true };
        }

        return { valid: true };
    }

    _recordSchemaValidationError(section, reason) {
        this._schemaValidationErrorTotal++;
        if (!(section in this._schemaValidationBySection)) {
            this._schemaValidationBySection[section] = 0;
        }
        this._schemaValidationBySection[section]++;
        this._sectionState[section].error = `Schema validation failed: ${reason}`;
        this._logger?.warn('Usage monitor: schema validation failed', { section, reason });
    }

    _enforceTimeSeriesBounds() {
        const maxPoints = Number(this._config.maxTimeSeriesPoints) || 0;
        if (maxPoints <= 0) return;

        if (this._timeSeriesCache.times.length > maxPoints) {
            const keepFrom = this._timeSeriesCache.times.length - maxPoints;
            this._timeSeriesCache.times = this._timeSeriesCache.times.slice(keepFrom);
            this._timeSeriesCache.callCounts = this._timeSeriesCache.callCounts.slice(keepFrom);
            this._timeSeriesCache.tokenCounts = this._timeSeriesCache.tokenCounts.slice(keepFrom);
        }

        if (this._toolTimeSeriesCache.times.length > maxPoints) {
            const keepFrom = this._toolTimeSeriesCache.times.length - maxPoints;
            const fields = ['networkSearchCount', 'webReadMcpCount', 'zreadMcpCount', 'searchMcpCount'];
            this._toolTimeSeriesCache.times = this._toolTimeSeriesCache.times.slice(keepFrom);
            for (const f of fields) {
                this._toolTimeSeriesCache[f] = (this._toolTimeSeriesCache[f] || []).slice(keepFrom);
            }
        }
    }

    /**
     * Fetch and unwrap z.ai API envelope ({code, msg, data, success}).
     * @param {string} urlPath
     * @returns {Promise<Object>} The unwrapped data field
     */
    async _fetchUnwrapped(urlPath) {
        const envelope = await this._fetch(urlPath);
        if (envelope && envelope.code === 200 && envelope.data) {
            return envelope.data;
        }
        // Some endpoints may not use envelope (forward-compat)
        if (envelope && !envelope.code) return envelope;
        throw new Error(`API error: ${envelope?.msg || 'Unknown'} (code: ${envelope?.code})`);
    }

    /**
     * HTTPS GET helper with abort on timeout.
     * @param {string} urlPath
     * @returns {Promise<Object>}
     */
    _fetch(urlPath) {
        return new Promise((resolve, reject) => {
            const key = this._getKey();
            if (!key) {
                reject(new Error('No API keys available'));
                return;
            }

            const req = https.get({
                hostname: this._targetHost,
                path: urlPath,
                headers: { 'Authorization': key },
                agent: this._agent,
                timeout: this._config.timeoutMs
            }, res => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode === 401 || res.statusCode === 403) {
                        this._rotateKey();
                        reject(new Error(`Auth failed: ${res.statusCode}`));
                        return;
                    }
                    if (res.statusCode !== 200) {
                        reject(new Error(`HTTP ${res.statusCode}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error('Invalid JSON'));
                    }
                });
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Timeout'));
            });
            req.on('error', reject);
        });
    }

    /**
     * Get current API key for monitoring requests.
     * @returns {string|null}
     */
    _getKey() {
        const keys = this._keyManager?.keys;
        if (!keys?.length) return null;
        return keys[this._currentKeyIndex % keys.length].key;
    }

    /**
     * Rotate to next key after auth failure.
     */
    _rotateKey() {
        const keys = this._keyManager?.keys;
        if (!keys?.length) return;
        this._currentKeyIndex = (this._currentKeyIndex + 1) % keys.length;
        this._logger?.warn('Usage monitor: rotating key after auth failure', {
            newKeyIndex: this._currentKeyIndex
        });
    }

    /**
     * Set callback for anomaly alerts (called by ProxyServer).
     * @param {Function} cb - callback receiving alert object
     */
    setAnomalyCallback(cb) {
        this._onAnomalyAlert = cb;
    }

    /**
     * Get recent anomaly alerts (bounded in-memory list).
     * @returns {Array}
     */
    getAnomalyAlerts() {
        return [...this._anomalyAlerts];
    }

    /**
     * Run all anomaly checks after a poll.
     * @param {Object} current - current enriched snapshot
     * @param {Object|null} prev - previous snapshot
     */
    _checkAnomalies(current, prev) {
        if (!this._anomalyConfig.enabled) return;
        this._checkRateJump(current);
        this._checkStaleFeed(current, prev);
        this._checkQuotaWarning(current);
    }

    /**
     * Detect rate jumps via z-score analysis on time-series data.
     * @param {Object} current - enriched snapshot
     */
    _checkRateJump(current) {
        const ts = this._timeSeriesCache;
        if (!ts || ts.tokenCounts.length < this._anomalyConfig.minDataPoints) return;

        const series = [
            { name: 'tokenCounts', values: ts.tokenCounts },
            { name: 'callCounts', values: ts.callCounts }
        ];

        for (const { name, values } of series) {
            if (values.length < this._anomalyConfig.minDataPoints) continue;
            const latest = values[values.length - 1];
            const history = values.slice(0, -1);
            const mean = history.reduce((a, b) => a + b, 0) / history.length;
            const variance = history.reduce((sum, v) => sum + (v - mean) ** 2, 0) / history.length;
            const stdDev = Math.sqrt(variance);
            if (stdDev === 0) continue;

            const zScore = (latest - mean) / stdDev;
            if (Math.abs(zScore) > this._anomalyConfig.rateJumpThreshold) {
                this._fireAnomaly('usage.rate_jump', zScore > 0 ? 'warning' : 'info', {
                    message: `${name} z-score ${zScore.toFixed(2)} exceeds threshold ${this._anomalyConfig.rateJumpThreshold}`,
                    data: {
                        metric: name,
                        direction: zScore > 0 ? 'spike' : 'drop',
                        zScore: parseFloat(zScore.toFixed(2)),
                        latest,
                        mean: parseFloat(mean.toFixed(2)),
                        stdDev: parseFloat(stdDev.toFixed(2)),
                        threshold: this._anomalyConfig.rateJumpThreshold
                    }
                });
            }
        }
    }

    /**
     * Detect stale feed transitions (false->true fires alert, true->false fires recovery).
     * @param {Object} current - enriched snapshot
     * @param {Object|null} prev - previous snapshot
     */
    _checkStaleFeed(current, prev) {
        const isStale = !!current?.stale;

        if (isStale && !this._staleFeedAlerted) {
            this._staleFeedAlerted = true;
            this._fireAnomaly('usage.feed_stale', 'warning', {
                message: 'Usage data feed is stale',
                data: {
                    lastPollAt: current.lastPollAt,
                    staleSinceMs: current.lastPollAt ? Date.now() - current.lastPollAt : null
                }
            });
        } else if (!isStale && this._staleFeedAlerted) {
            this._staleFeedAlerted = false;
            this._fireAnomaly('usage.feed_recovered', 'info', {
                message: 'Usage data feed recovered',
                data: { recoveredAt: new Date().toISOString() }
            });
        }
    }

    /**
     * Check quota usage against warning thresholds.
     * @param {Object} current - enriched snapshot
     */
    _checkQuotaWarning(current) {
        const percent = current?.quota?.tokenUsagePercent;
        if (percent == null || typeof percent !== 'number') return;

        const fraction = percent > 1 ? percent / 100 : percent;

        for (const threshold of this._anomalyConfig.quotaWarningThresholds) {
            if (fraction >= threshold && !this._quotaThresholdsFired.has(threshold)) {
                this._quotaThresholdsFired.add(threshold);
                this._fireAnomaly('usage.quota_warning',
                    threshold >= 0.95 ? 'critical' : 'warning', {
                    message: `Quota usage at ${(fraction * 100).toFixed(1)}% (threshold: ${(threshold * 100)}%)`,
                    data: {
                        currentPercent: parseFloat((fraction * 100).toFixed(1)),
                        threshold,
                        level: current.quota.level
                    }
                });
            }
        }
    }

    /**
     * Fire an anomaly alert with cooldown enforcement and bounded history.
     * @param {string} type - alert type (e.g. 'usage.rate_jump')
     * @param {string} severity - 'info' | 'warning' | 'critical'
     * @param {Object} details - { message, data }
     */
    _fireAnomaly(type, severity, { message, data }) {
        const now = Date.now();
        const lastFired = this._anomalyCooldowns[type];
        if (lastFired && (now - lastFired) < this._anomalyConfig.cooldownMs) {
            return; // Still in cooldown
        }
        this._anomalyCooldowns[type] = now;

        const alert = {
            type,
            severity,
            message,
            data,
            timestamp: new Date().toISOString()
        };

        this._anomalyAlerts.push(alert);
        // Bound history to 100 entries
        if (this._anomalyAlerts.length > 100) {
            this._anomalyAlerts = this._anomalyAlerts.slice(-100);
        }

        try {
            if (this._onAnomalyAlert) {
                this._onAnomalyAlert(alert);
            }
        } catch (err) {
            this._logger?.error('Anomaly callback error', { error: err.message });
        }
    }
}

module.exports = { UsageMonitor };
