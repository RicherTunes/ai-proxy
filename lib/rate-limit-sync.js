/**
 * Rate Limit Sync Module
 *
 * Dynamically updates per-model concurrency baselines by observing z.ai
 * response headers (x-ratelimit-limit = concurrency cap) and optionally
 * probing ceilings for low-traffic models via AIMD.
 *
 * Primary path: header-observed (zero cost, piggybacks on real traffic)
 * Fallback path: ceiling probe (raises baseline +1 for idle models at AIMD ceiling)
 *
 * Lifecycle: constructor → start() → recordHeaders() on each response → stop()
 * Persistence: saves discovered baselines to disk, loads on restart.
 * Cluster safety: runs on primary process only.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { atomicWrite } = require('./atomic-write');

const RING_BUFFER_SIZE = 10;

const DEFAULT_CONFIG = {
    enabled: true,
    tickIntervalMs: 30000,
    quorumSize: 3,
    ceilingProbeEnabled: true,
    ceilingProbeCleanTicks: 10,
    ceilingProbeStep: 1,
    ceilingProbeMaxAboveStatic: 5,
    persistFile: 'rate-limit-cache.json',
    staleThresholdMs: 86400000  // 24h
};

class RateLimitSync {
    /**
     * @param {Object} config - rateLimitSync config section
     * @param {Object} deps
     * @param {Object} deps.logger
     * @param {Object} deps.keyManager - KeyManager instance
     * @param {Object} [deps.adaptiveConcurrency] - AdaptiveConcurrencyController instance
     * @param {Object} [deps.modelDiscovery] - ModelDiscovery instance
     * @param {string} [deps.configDir] - Directory for persistent cache file
     */
    constructor(config, { logger, keyManager, adaptiveConcurrency, modelDiscovery, configDir } = {}) {
        this._config = { ...DEFAULT_CONFIG, ...config };
        this._logger = logger || { info() {}, warn() {}, debug() {}, error() {} };
        this._keyManager = keyManager;
        this._adaptiveConcurrency = adaptiveConcurrency || null;
        this._modelDiscovery = modelDiscovery || null;

        // Persistence
        this._configDir = configDir || null;
        this._persistEnabled = !!configDir;

        // Per-model observation ring buffers: model -> { observations: Array<{limit, at}>, idx }
        this._observations = new Map();

        // Discovered baselines (model -> { concurrency, source, discoveredAt })
        this._baselines = new Map();

        // Original static limits (from KNOWN_GLM_MODELS, captured on first observation)
        this._originalStaticLimits = new Map();

        // Tick timer
        this._tickInterval = null;

        // Load cached baselines from disk
        this._load();
    }

    // --- Public API ---

    /**
     * Start the periodic tick timer.
     */
    start() {
        if (this._tickInterval) return;
        if (!this._config.enabled) return;

        // Apply any cached baselines that are still fresh
        this._applyCachedBaselines();

        this._tickInterval = setInterval(() => this._tick(), this._config.tickIntervalMs);
        this._tickInterval.unref();
        this._logger.info('RateLimitSync started', {
            tickIntervalMs: this._config.tickIntervalMs,
            quorumSize: this._config.quorumSize,
            ceilingProbeEnabled: this._config.ceilingProbeEnabled,
            cachedModels: this._baselines.size
        });
    }

    /**
     * Stop the tick timer.
     */
    stop() {
        if (this._tickInterval) {
            clearInterval(this._tickInterval);
            this._tickInterval = null;
        }
    }

    /**
     * Persist to disk and stop.
     */
    async persistAndStop() {
        this.stop();
        await this._save();
    }

    /**
     * Record response headers from an upstream response.
     * Called on every successful response by request-handler.
     * Extracts x-ratelimit-limit (= concurrency cap) and checks quorum.
     *
     * @param {string} model - The mapped (GLM) model name
     * @param {Object} headers - Response headers object
     */
    recordHeaders(model, headers) {
        if (!model || !headers) return;

        const limitStr = headers['x-ratelimit-limit'];
        if (limitStr === undefined || limitStr === null) return;

        const limit = parseInt(limitStr, 10);
        if (!Number.isFinite(limit) || limit < 1) return;

        // Capture original static limit on first observation
        if (!this._originalStaticLimits.has(model)) {
            const staticLimit = this._keyManager?.getStaticModelLimit?.(model);
            if (staticLimit !== undefined) {
                this._originalStaticLimits.set(model, staticLimit);
            }
        }

        // Get or create ring buffer for this model
        let ring = this._observations.get(model);
        if (!ring) {
            ring = { observations: new Array(RING_BUFFER_SIZE).fill(null), idx: 0, count: 0 };
            this._observations.set(model, ring);
        }

        // Store observation
        ring.observations[ring.idx] = { limit, at: Date.now() };
        ring.idx = (ring.idx + 1) % RING_BUFFER_SIZE;
        if (ring.count < RING_BUFFER_SIZE) ring.count++;

        // Check quorum immediately (primary path — no tick wait)
        this._checkQuorum(model, ring);
    }

    /**
     * Get observability snapshot for /stats endpoint.
     * @returns {Object} Current state of rate limit sync
     */
    getSnapshot() {
        const models = {};
        for (const [model, ring] of this._observations) {
            const recentObs = [];
            for (let i = 0; i < ring.count; i++) {
                const idx = (ring.idx - ring.count + i + RING_BUFFER_SIZE) % RING_BUFFER_SIZE;
                const obs = ring.observations[idx];
                if (obs) recentObs.push(obs);
            }
            const baseline = this._baselines.get(model);
            const originalStatic = this._originalStaticLimits.get(model);
            models[model] = {
                observations: recentObs,
                currentBaseline: baseline || null,
                originalStatic: originalStatic || null,
                currentStatic: this._keyManager?.getStaticModelLimit?.(model) || null,
                currentEffective: this._keyManager?.getEffectiveModelLimit?.(model) || null
            };
        }
        return {
            enabled: this._config.enabled,
            running: !!this._tickInterval,
            config: {
                quorumSize: this._config.quorumSize,
                tickIntervalMs: this._config.tickIntervalMs,
                ceilingProbeEnabled: this._config.ceilingProbeEnabled,
                ceilingProbeMaxAboveStatic: this._config.ceilingProbeMaxAboveStatic,
                staleThresholdMs: this._config.staleThresholdMs
            },
            models,
            baselines: Object.fromEntries(this._baselines)
        };
    }

    // --- Internal ---

    /**
     * Check if the last N observations for a model all agree on a limit
     * that differs from the current static baseline.
     */
    _checkQuorum(model, ring) {
        const quorumSize = this._config.quorumSize;
        if (ring.count < quorumSize) return;

        // Get last quorumSize observations
        const recent = [];
        for (let i = 0; i < quorumSize; i++) {
            const idx = (ring.idx - quorumSize + i + RING_BUFFER_SIZE) % RING_BUFFER_SIZE;
            const obs = ring.observations[idx];
            if (!obs) return;
            recent.push(obs);
        }

        // Check if all agree
        const agreedLimit = recent[0].limit;
        if (!recent.every(obs => obs.limit === agreedLimit)) return;

        // Check if different from current static baseline
        const currentStatic = this._keyManager?.getStaticModelLimit?.(model);
        if (currentStatic === agreedLimit) return;

        // Quorum met — apply discovered limit
        this._applyDiscoveredLimit(model, agreedLimit, 'header_observed');
    }

    /**
     * Periodic tick — ceiling probe for low-traffic models.
     */
    _tick() {
        if (!this._config.ceilingProbeEnabled) return;
        if (!this._adaptiveConcurrency) return;

        const windows = this._adaptiveConcurrency._windows;
        if (!windows) return;

        for (const [model, w] of windows) {
            // Skip models with recent header observations
            const ring = this._observations.get(model);
            if (ring && ring.count > 0) {
                // Check if most recent observation is within 2 tick intervals
                const latestIdx = (ring.idx - 1 + RING_BUFFER_SIZE) % RING_BUFFER_SIZE;
                const latest = ring.observations[latestIdx];
                if (latest && (Date.now() - latest.at) < this._config.tickIntervalMs * 2) {
                    continue;  // Has recent traffic — header path handles it
                }
            }

            // Check if at ceiling with enough clean ticks
            if (w.effectiveMax < w.staticMax) continue;  // AIMD reduced — not at ceiling
            if (w.consecutiveCleanTicks < this._config.ceilingProbeCleanTicks) continue;

            // Safety cap: don't probe beyond maxAboveStatic above original value
            const originalStatic = this._originalStaticLimits.get(model)
                || this._keyManager?.getStaticModelLimit?.(model)
                || w.staticMax;
            const maxAllowed = originalStatic + this._config.ceilingProbeMaxAboveStatic;
            const newLimit = w.staticMax + this._config.ceilingProbeStep;
            if (newLimit > maxAllowed) continue;

            this._applyDiscoveredLimit(model, newLimit, 'ceiling_probe');
        }
    }

    /**
     * Core update: propagate a discovered limit to all subsystems.
     */
    _applyDiscoveredLimit(model, newLimit, source) {
        const oldStatic = this._keyManager?.getStaticModelLimit?.(model);
        if (oldStatic === newLimit) return;  // No change

        this._logger.warn('Rate limit baseline changed', {
            model,
            from: oldStatic,
            to: newLimit,
            source,
            discoveredAt: new Date().toISOString()
        });

        // 1. Update KeyManager static + effective baselines
        const kmResult = this._keyManager?.updateStaticModelLimit?.(model, newLimit);

        // 2. Update AIMD ceiling
        this._adaptiveConcurrency?.updateStaticBaseline?.(model, newLimit);

        // 3. Update ModelDiscovery metadata (for /models endpoint visibility)
        this._modelDiscovery?.updateModelMetadata?.(model, {
            maxConcurrency: newLimit,
            source: 'live',
            lastRefreshedAt: new Date().toISOString()
        });

        // 4. Store in baselines
        this._baselines.set(model, {
            concurrency: newLimit,
            source,
            discoveredAt: Date.now()
        });

        // 5. Persist to disk (fire-and-forget)
        this._save().catch(err => {
            this._logger.warn('RateLimitSync: save failed', { error: err.message });
        });
    }

    /**
     * Apply cached baselines from disk (on startup).
     * Only apply baselines that are not stale.
     */
    _applyCachedBaselines() {
        const now = Date.now();
        for (const [model, baseline] of this._baselines) {
            if (now - baseline.discoveredAt > this._config.staleThresholdMs) {
                this._logger.info('RateLimitSync: stale cached baseline skipped', {
                    model,
                    age: Math.round((now - baseline.discoveredAt) / 1000) + 's',
                    limit: baseline.concurrency
                });
                continue;
            }

            const currentStatic = this._keyManager?.getStaticModelLimit?.(model);
            if (currentStatic === baseline.concurrency) continue;  // Already matches

            this._logger.info('RateLimitSync: applying cached baseline', {
                model,
                from: currentStatic,
                to: baseline.concurrency,
                source: baseline.source,
                age: Math.round((now - baseline.discoveredAt) / 1000) + 's'
            });

            // Capture original before overwriting
            if (!this._originalStaticLimits.has(model) && currentStatic !== undefined) {
                this._originalStaticLimits.set(model, currentStatic);
            }

            this._keyManager?.updateStaticModelLimit?.(model, baseline.concurrency);
            this._adaptiveConcurrency?.updateStaticBaseline?.(model, baseline.concurrency);
            this._modelDiscovery?.updateModelMetadata?.(model, {
                maxConcurrency: baseline.concurrency,
                source: 'cached',
                lastRefreshedAt: new Date(baseline.discoveredAt).toISOString()
            });
        }
    }

    // --- Persistence ---

    /**
     * Load cached baselines from disk.
     */
    _load() {
        if (!this._persistEnabled) return;
        try {
            const filePath = path.join(this._configDir, this._config.persistFile);
            const raw = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(raw);
            if (data.version !== 1) return;

            if (data.baselines && typeof data.baselines === 'object') {
                for (const [model, baseline] of Object.entries(data.baselines)) {
                    if (baseline && typeof baseline.concurrency === 'number' && baseline.concurrency >= 1) {
                        this._baselines.set(model, {
                            concurrency: baseline.concurrency,
                            source: baseline.source || 'cached',
                            discoveredAt: baseline.discoveredAt || data.savedAt || 0
                        });
                    }
                }
            }
            this._logger.info('RateLimitSync: loaded cached baselines', {
                models: this._baselines.size,
                savedAt: data.savedAt ? new Date(data.savedAt).toISOString() : 'unknown'
            });
        } catch (err) {
            if (err.code !== 'ENOENT') {
                this._logger.warn('RateLimitSync: failed to load cache', { error: err.message });
            }
        }
    }

    /**
     * Save current baselines to disk.
     */
    async _save() {
        if (!this._persistEnabled) return;
        try {
            const payload = {
                version: 1,
                savedAt: Date.now(),
                baselines: Object.fromEntries(this._baselines)
            };
            const filePath = path.join(this._configDir, this._config.persistFile);
            await atomicWrite(filePath, JSON.stringify(payload, null, 2));
        } catch (err) {
            this._logger.warn('RateLimitSync: failed to save cache', { error: err.message });
        }
    }
}

module.exports = { RateLimitSync };
