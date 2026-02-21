'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./atomic-write');
const { RingBuffer } = require('./ring-buffer');

/**
 * HistoryTracker - Time-series data collection for proxy metrics
 * Maintains tiered storage for multi-resolution historical visualization:
 * - fine: 1s resolution, last 1 hour (3600 points max)
 * - medium: 10s resolution, last 24 hours (8640 points max)
 * - coarse: 60s resolution, last 7 days (10080 points max)
 */
class HistoryTracker {
    constructor(options = {}) {
        this.interval = options.interval || 1000;          // 1 second per data point
        this.maxPoints = options.maxPoints || 3600;        // 1 hour retention for fine tier
        this.historyFile = options.historyFile || path.join(process.cwd(), 'history.json');
        this.saveInterval = options.saveInterval || 30000; // Save every 30 seconds

        // Schema version for migration support
        this.schemaVersion = 2;

        // Tiered storage for multi-resolution support
        this.tiers = {
            fine: { data: new RingBuffer(3600), resolution: 1 },    // 1s resolution × 3600 points = 1 hour retention
            medium: { data: new RingBuffer(8640), resolution: 10 },  // 10s resolution × 8640 points = 24 hours retention
            coarse: { data: new RingBuffer(10080), resolution: 60 }  // 60s resolution × 10080 points = 7 days retention
        };
        this._tickCount = 0;

        this.collectTimer = null;
        this.saveTimer = null;
        this.statsSource = null;
        this.routingSource = null;
        this.lastStats = null;
        this._lastRoutingStats = { total: 0, failover: 0, burstDampenedTotal: 0 };
        this._lastRateLimited = 0;
        this.logger = options.logger || console;

        // Circuit state transition timeline (PHASE 2 - Task #6) - using RingBuffer directly
        this.circuitTransitions = new RingBuffer(options.maxTransitions || 1000);

        // Expose .points with direct RingBuffer access
        Object.defineProperty(this, 'points', {
            get: () => ({
                fine: this.tiers.fine.data,
                medium: this.tiers.medium.data,
                coarse: this.tiers.coarse.data
            }),
            enumerable: false
        });
    }

    /**
     * Start collecting history data
     * @param {Function} statsSource - Function that returns current stats object
     */
    start(statsSource, routingSource = null) {
        this.statsSource = statsSource;
        this.routingSource = routingSource;
        this.load();

        // Collect data every interval
        this.collectTimer = setInterval(() => {
            this._collectDataPoint();
        }, this.interval);
        this.collectTimer.unref();

        // Save to disk periodically
        this.saveTimer = setInterval(() => {
            this.save();
        }, this.saveInterval);
        this.saveTimer.unref();

        if (this.logger.info) {
            this.logger.info('History tracker started', {
                interval: this.interval,
                maxPoints: this.maxPoints,
                saveInterval: this.saveInterval
            });
        }
    }

    /**
     * Stop collecting and save final state
     */
    stop() {
        if (this.collectTimer) {
            clearInterval(this.collectTimer);
            this.collectTimer = null;
        }
        if (this.saveTimer) {
            clearInterval(this.saveTimer);
            this.saveTimer = null;
        }
        this.save();
        if (this.logger.info) {
            this.logger.info('History tracker stopped');
        }
    }

    /**
     * Destroy the tracker, stopping collection and saving final state
     */
    async destroy() {
        if (this.destroyed) return;  // Idempotent
        this.stop();
        this.save();  // Final save before marking destroyed
        this.destroyed = true;
    }

    /**
     * Collect a single data point from the stats source
     */
    _collectDataPoint() {
        if (!this.statsSource) return;

        try {
            const stats = this.statsSource();
            if (!stats) return;

            // Calculate requests since last collection
            const currentRequests = stats.totalRequests || 0;
            const requestsDelta = this.lastStats
                ? currentRequests - (this.lastStats.totalRequests || 0)
                : 0;

            // Compute errorRate from client deltas (not key retries) to avoid inflation
            const clientReq = stats.clientRequests || {};
            const lastClient = this.lastStats?.clientRequests || {};

            const totalNow = clientReq.total || 0;
            const failedNow = clientReq.failed || 0;
            const totalLast = lastClient.total || 0;
            const failedLast = lastClient.failed || 0;

            const totalDelta = totalNow - totalLast;
            const failedDelta = failedNow - failedLast;

            const errorRate = totalDelta > 0
                ? (failedDelta / totalDelta) * 100
                : 0;

            const point = {
                timestamp: Date.now(),
                requests: Math.max(0, requestsDelta),
                failures: Math.max(0, failedDelta),
                totalRequests: currentRequests,
                successRate: stats.successRate || 0,
                errorRate: Math.max(0, Math.min(100, errorRate)),
                avgLatency: stats.latency?.avg || 0,
                p95Latency: stats.latency?.p95 || 0,
                p99Latency: stats.latency?.p99 || 0,
                activeConnections: stats.activeConnections || 0,
                queueSize: stats.queue?.current || 0,
                errors: {
                    timeouts: stats.errors?.timeouts || 0,
                    socketHangups: stats.errors?.socketHangups || 0,
                    serverErrors: stats.errors?.serverErrors || 0,
                    rateLimited: stats.errors?.rateLimited || 0,
                    other: stats.errors?.other || 0
                },
                circuitStates: this._countCircuitStates(stats.keys || [])
            };

            // Collect routing data if source available
            if (this.routingSource) {
                try {
                    const rs = this.routingSource();
                    if (rs) {
                        const prev = this._lastRoutingStats;
                        const srcObj = rs.bySource || {};
                        point.routing = {
                            // Cumulative snapshots (rollup: take LAST, clone objects)
                            total: rs.total || 0,
                            light: rs.byTier?.light || 0,
                            medium: rs.byTier?.medium || 0,
                            heavy: rs.byTier?.heavy || 0,
                            failover: srcObj.failover || 0,
                            burstDampenedTotal: rs.burstDampenedTotal || 0,
                            bySource: Object.assign({}, srcObj),
                            // Deltas for rate charts (rollup: SUM)
                            totalDelta: Math.max(0, (rs.total || 0) - prev.total),
                            failoverDelta: Math.max(0, (srcObj.failover || 0) - prev.failover),
                            burstDelta: Math.max(0, (rs.burstDampenedTotal || 0) - prev.burstDampenedTotal)
                        };
                        this._lastRoutingStats = {
                            total: rs.total || 0,
                            failover: srcObj.failover || 0,
                            burstDampenedTotal: rs.burstDampenedTotal || 0
                        };
                    }
                } catch (err) { this.logger.warn('Routing source error', { error: err.message }); }
            }

            // Compute rateLimitedDelta from cumulative errors.rateLimited
            const currentRL = point.errors?.rateLimited || 0;
            const lastRL = this._lastRateLimited || 0;
            point.rateLimitedDelta = Math.max(0, currentRL - lastRL);
            this._lastRateLimited = currentRL;

            // Add to fine tier
            this.tiers.fine.data.push(point);
            this._tickCount++;

            // Every 10 ticks, rollup to medium tier
            if (this._tickCount % 10 === 0) {
                this._rollupToMedium();
            }

            // Every 60 ticks, rollup to coarse tier
            if (this._tickCount % 60 === 0) {
                this._rollupToCoarse();
            }

            this.lastStats = stats;
        } catch (err) {
            if (this.logger.error) {
                this.logger.error('Error collecting history point', { error: err.message });
            }
        }
    }

    /**
     * Rollup last 10 fine points to medium tier (sum requests/failures, avg latency)
     */
    _rollupToMedium() {
        const recent = this.tiers.fine.data.getRecent(10).reverse();
        if (recent.length < 10) return;

        // SUM requests and failures, AVERAGE latency
        const requestsSum = recent.reduce((s, p) => s + (p.requests || 0), 0);
        const failuresSum = recent.reduce((s, p) => s + (p.failures || 0), 0);
        const avgLatency = recent.reduce((s, p) => s + (p.avgLatency || 0), 0) / 10;
        const errorRate = requestsSum > 0 ? (failuresSum / requestsSum) * 100 : 0;

        const medRolled = {
            timestamp: recent[recent.length - 1].timestamp,
            requests: requestsSum,
            failures: failuresSum,
            avgLatency: Math.round(avgLatency),
            errorRate: Math.max(0, Math.min(100, errorRate))
        };

        // Routing rollup: SUM deltas, take LAST for cumulative snapshots (cloned)
        const lastRouting = recent[recent.length - 1]?.routing;
        if (lastRouting) {
            medRolled.routing = {
                total: lastRouting.total,
                light: lastRouting.light,
                medium: lastRouting.medium,
                heavy: lastRouting.heavy,
                failover: lastRouting.failover,
                burstDampenedTotal: lastRouting.burstDampenedTotal,
                bySource: Object.assign({}, lastRouting.bySource),
                totalDelta: recent.reduce((s, p) => s + (p.routing?.totalDelta || 0), 0),
                failoverDelta: recent.reduce((s, p) => s + (p.routing?.failoverDelta || 0), 0),
                burstDelta: recent.reduce((s, p) => s + (p.routing?.burstDelta || 0), 0)
            };
        }
        // rateLimitedDelta: SUM across window
        medRolled.rateLimitedDelta = recent.reduce((s, p) => s + (p.rateLimitedDelta || 0), 0);

        this.tiers.medium.data.push(medRolled);
    }

    /**
     * Rollup last 6 medium points to coarse tier (sum requests/failures, avg latency)
     */
    _rollupToCoarse() {
        const recent = this.tiers.medium.data.getRecent(6).reverse();
        if (recent.length < 6) return;

        // SUM requests and failures, AVERAGE latency
        const requestsSum = recent.reduce((s, p) => s + (p.requests || 0), 0);
        const failuresSum = recent.reduce((s, p) => s + (p.failures || 0), 0);
        const avgLatency = recent.reduce((s, p) => s + (p.avgLatency || 0), 0) / 6;
        const errorRate = requestsSum > 0 ? (failuresSum / requestsSum) * 100 : 0;

        const coarseRolled = {
            timestamp: recent[recent.length - 1].timestamp,
            requests: requestsSum,
            failures: failuresSum,
            avgLatency: Math.round(avgLatency),
            errorRate: Math.max(0, Math.min(100, errorRate))
        };

        // Routing rollup: SUM deltas, take LAST for cumulative snapshots (cloned)
        const lastRouting = recent[recent.length - 1]?.routing;
        if (lastRouting) {
            coarseRolled.routing = {
                total: lastRouting.total,
                light: lastRouting.light,
                medium: lastRouting.medium,
                heavy: lastRouting.heavy,
                failover: lastRouting.failover,
                burstDampenedTotal: lastRouting.burstDampenedTotal,
                bySource: Object.assign({}, lastRouting.bySource),
                totalDelta: recent.reduce((s, p) => s + (p.routing?.totalDelta || 0), 0),
                failoverDelta: recent.reduce((s, p) => s + (p.routing?.failoverDelta || 0), 0),
                burstDelta: recent.reduce((s, p) => s + (p.routing?.burstDelta || 0), 0)
            };
        }
        // rateLimitedDelta: SUM across window
        coarseRolled.rateLimitedDelta = recent.reduce((s, p) => s + (p.rateLimitedDelta || 0), 0);

        this.tiers.coarse.data.push(coarseRolled);
    }

    /**
     * Count circuit breaker states across all keys
     */
    _countCircuitStates(keys) {
        const counts = { closed: 0, open: 0, halfOpen: 0 };
        for (const key of keys) {
            const state = (key.state || 'CLOSED').toLowerCase();
            if (state === 'closed') counts.closed++;
            else if (state === 'open') counts.open++;
            else if (state === 'half_open' || state === 'halfopen') counts.halfOpen++;
        }
        return counts;
    }

    /**
     * Load history from disk with migration support for v1 -> v2
     */
    load() {
        try {
            if (fs.existsSync(this.historyFile)) {
                const data = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));

                // Migration: v1 format was array or {points: array}, v2 is {schemaVersion: 2, points: {fine, medium, coarse}}
                if (Array.isArray(data) || (data.points && Array.isArray(data.points))) {
                    // v1 format: migrate to v2
                    const oldPoints = Array.isArray(data) ? data : data.points;
                    const cutoff = Date.now() - (3600 * 1000); // Keep last hour in fine tier
                    const filtered = oldPoints.filter(p => p.timestamp > cutoff);
                    filtered.forEach(p => this.tiers.fine.data.push(p));
                    if (this.logger.info) {
                        this.logger.info('Migrated history from v1 (array) to v2 (tiered)', { points: filtered.length });
                    }
                } else if (data.schemaVersion === 2 && data.points) {
                    // v2 format: load directly
                    const now = Date.now();
                    const finePoints = (data.points.fine || []).filter(p => p.timestamp > now - (3600 * 1000));
                    const mediumPoints = (data.points.medium || []).filter(p => p.timestamp > now - (86400 * 1000));
                    const coarsePoints = (data.points.coarse || []).filter(p => p.timestamp > now - (7 * 86400 * 1000));

                    finePoints.forEach(p => this.tiers.fine.data.push(p));
                    mediumPoints.forEach(p => this.tiers.medium.data.push(p));
                    coarsePoints.forEach(p => this.tiers.coarse.data.push(p));

                    if (this.logger.info) {
                        this.logger.info('History loaded (v2)', {
                            fine: finePoints.length,
                            medium: mediumPoints.length,
                            coarse: coarsePoints.length
                        });
                    }
                }
            }
        } catch (err) {
            if (this.logger.warn) {
                this.logger.warn('Could not load history', { error: err.message });
            }
            this.tiers.fine.data.clear();
            this.tiers.medium.data.clear();
            this.tiers.coarse.data.clear();
        }
    }

    /**
     * Save history to disk (async with atomic write via temp + rename)
     * Uses fire-and-forget to avoid blocking the event loop
     * Saves in v2 tiered format
     */
    save() {
        if (this.destroyed) return;  // Guard: don't save after destroy
        const data = {
            schemaVersion: this.schemaVersion,
            interval: this.interval,
            lastUpdated: new Date().toISOString(),
            points: {
                fine: this.tiers.fine.data.toArray(),
                medium: this.tiers.medium.data.toArray(),
                coarse: this.tiers.coarse.data.toArray()
            }
        };

        const jsonData = JSON.stringify(data, null, 2);
        atomicWrite(this.historyFile, jsonData)
            .catch((err) => {
                if (this.logger.error) {
                    this.logger.error('Could not save history', { error: err.message });
                }
            });
    }

    /**
     * Get history data for the last N minutes
     * Selects appropriate tier based on time range:
     * - <= 60 minutes: fine tier (1s resolution)
     * - <= 1440 minutes (24h): medium tier (10s resolution)
     * - > 1440 minutes: coarse tier (60s resolution)
     *
     * @param {number} minutes - Number of minutes to retrieve (default: 15)
     * @returns {Object} History data with metadata
     */
    getHistory(minutes = 15) {
        const cutoff = Date.now() - (minutes * 60 * 1000);

        // Select appropriate tier based on time range
        let source;
        let tier;
        let tierResolution; // Resolution in seconds
        let expectedInterval; // Expected interval between points in ms

        if (minutes <= 60) {
            source = this.tiers.fine.data.toArray();
            tier = 'fine';
            tierResolution = 1; // 1 second resolution
            expectedInterval = this.interval; // ~1000ms
        } else if (minutes <= 1440) {
            source = this.tiers.medium.data.toArray();
            tier = 'medium';
            tierResolution = 10; // 10 second resolution
            expectedInterval = this.interval * 10; // ~10000ms
        } else {
            source = this.tiers.coarse.data.toArray();
            tier = 'coarse';
            tierResolution = 60; // 60 second resolution
            expectedInterval = this.interval * 60; // ~60000ms
        }

        let filtered = source.filter(p => p.timestamp > cutoff);

        // Data validation: Check if we have meaningful data for the requested range
        // For very recent time ranges on coarse tiers, data may not be available yet
        const dataAge = filtered.length > 0 ? Date.now() - filtered[filtered.length - 1].timestamp : Infinity;

        // Calculate expected points based on tier resolution and requested time range
        const expectedPointCount = Math.ceil((minutes * 60) / tierResolution);
        const actualPointCount = filtered.length;

        // Only downsample if significantly over 1000 points (allow frontend to handle visualization)
        // This prevents double-downsampling issues
        if (filtered.length > 1000) {
            const step = Math.ceil(filtered.length / 1000);
            filtered = filtered.filter((_, i) => i % step === 0);
        }

        return {
            schemaVersion: this.schemaVersion,
            interval: this.interval,
            minutes: minutes,
            tier: tier,
            tierResolution: tierResolution,
            expectedInterval: expectedInterval,
            pointCount: filtered.length,
            expectedPointCount: expectedPointCount,
            actualPointCount: actualPointCount,
            dataAgeMs: dataAge,
            points: filtered
        };
    }

    /**
     * Get summary statistics for dashboard display
     */
    getSummary() {
        const finePoints = this.tiers.fine.data.toArray();
        if (finePoints.length === 0) {
            return {
                avgRequestsPerSecond: 0,
                avgSuccessRate: 0,
                avgLatency: 0,
                peakLatency: 0,
                totalErrors: 0
            };
        }

        const recent = finePoints.slice(-60); // Last minute from fine tier
        const totalRequests = recent.reduce((sum, p) => sum + p.requests, 0);
        const avgSuccessRate = recent.reduce((sum, p) => sum + p.successRate, 0) / recent.length;
        const avgLatency = recent.reduce((sum, p) => sum + p.avgLatency, 0) / recent.length;
        const peakLatency = Math.max(...recent.map(p => p.p99Latency || p.avgLatency));

        return {
            avgRequestsPerSecond: totalRequests / recent.length,
            avgSuccessRate: avgSuccessRate,
            avgLatency: Math.round(avgLatency),
            peakLatency: Math.round(peakLatency),
            pointCount: finePoints.length
        };
    }

    // ========== CIRCUIT STATE TRANSITION TRACKING (PHASE 2 - Task #6) ==========

    /**
     * Record a circuit breaker state transition
     * @param {number} keyIndex - API key index
     * @param {string} keyPrefix - Key prefix (8 chars)
     * @param {string} fromState - Previous state (CLOSED, OPEN, HALF_OPEN)
     * @param {string} toState - New state
     * @param {string} reason - Reason for transition (optional)
     */
    recordCircuitTransition(keyIndex, keyPrefix, fromState, toState, reason = null) {
        const transition = {
            timestamp: Date.now(),
            keyIndex,
            keyPrefix,
            fromState,
            toState,
            reason
        };

        this.circuitTransitions.push(transition);
    }

    /**
     * Get circuit transitions for the last N minutes
     * @param {number} minutes - Time range in minutes
     * @returns {Object} Circuit transition history
     */
    getCircuitTransitions(minutes = 60) {
        const cutoff = Date.now() - (minutes * 60 * 1000);
        const filtered = this.circuitTransitions.toArray().filter(t => t.timestamp > cutoff);

        return {
            minutes,
            count: filtered.length,
            transitions: filtered
        };
    }

    /**
     * Get circuit state timeline for visualization
     * @param {number} keyIndex - Optional key index to filter
     * @param {number} minutes - Time range in minutes
     * @returns {Array} Timeline of state changes
     */
    getCircuitTimeline(keyIndex = null, minutes = 60) {
        const cutoff = Date.now() - (minutes * 60 * 1000);
        let filtered = this.circuitTransitions.toArray().filter(t => t.timestamp > cutoff);

        if (keyIndex !== null) {
            filtered = filtered.filter(t => t.keyIndex === keyIndex);
        }

        return filtered.map(t => ({
            time: new Date(t.timestamp).toISOString(),
            keyIndex: t.keyIndex,
            keyPrefix: t.keyPrefix,
            from: t.fromState,
            to: t.toState,
            reason: t.reason
        }));
    }

    /**
     * Get current circuit states for all keys
     * @param {Array} keys - Key stats array
     * @returns {Object} Current circuit states
     */
    getCurrentCircuitStates(keys) {
        return keys.map(k => ({
            index: k.index,
            keyPrefix: k.keyPrefix,
            state: (k.state || k.circuitBreaker?.state || 'CLOSED').toUpperCase()
        }));
    }
}

module.exports = { HistoryTracker };
