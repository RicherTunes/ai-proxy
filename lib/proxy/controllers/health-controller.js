/**
 * Health Controller Module
 *
 * Handles health-related routes extracted from ProxyServer.
 * Provides endpoints for health checking and system status.
 *
 * TDD Phase: Green - Implementation to make tests pass
 */

'use strict';

const { redactSensitiveData } = require('../../redact');

/**
 * HealthController class for health-related HTTP endpoints
 */
class HealthController {
    /**
     * @param {Object} options - Configuration options
     * @param {Object} options.keyManager - KeyManager instance
     * @param {Object} options.requestHandler - RequestHandler instance
     * @param {Object} options.modelRouter - ModelRouter instance
     * @param {Function} options.getUptime - Function to get uptime in ms
     */
    constructor(options = {}) {
        this._keyManager = options.keyManager || null;
        this._requestHandler = options.requestHandler || null;
        this._modelRouter = options.modelRouter || null;
        this._getUptime = options.getUptime || (() => 0);
    }

    /**
     * Handle /health endpoint
     * GET: Return basic health status
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    handleHealth(req, res) {
        const aggregated = this._keyManager ? this._keyManager.getAggregatedStats() : {
            totalKeys: 0,
            circuitStates: { closed: 0, open: 0, halfOpen: 0 }
        };
        const healthyKeys = aggregated.circuitStates.closed + aggregated.circuitStates.halfOpen;
        const status = healthyKeys > 0 ? 'OK' : 'DEGRADED';
        const statusCode = healthyKeys > 0 ? 200 : 503;

        const backpressure = this._requestHandler ? this._requestHandler.getBackpressureStats() : {
            current: 0,
            max: 0,
            percentUsed: 0,
            queue: { length: 0, waiting: 0 }
        };

        res.writeHead(statusCode, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            status,
            healthyKeys,
            totalKeys: aggregated.totalKeys,
            uptime: this._getUptime(),
            backpressure
        }));
    }

    /**
     * Handle /health/deep endpoint
     * GET: Return detailed health status for all components
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    handleHealthDeep(req, res) {
        const startTime = Date.now();
        const memUsage = process.memoryUsage();

        const aggregated = this._keyManager ? this._keyManager.getAggregatedStats() : {
            totalKeys: 0,
            circuitStates: { closed: 0, open: 0, halfOpen: 0 }
        };
        const backpressure = this._requestHandler ? this._requestHandler.getBackpressureStats() : {
            current: 0,
            max: 0,
            percentUsed: 0,
            queue: { length: 0, waiting: 0 }
        };
        const traceStats = this._requestHandler ? this._requestHandler.getTraceStats() : {
            totalTraces: 0,
            capacity: 0,
            utilization: 0,
            successCount: 0
        };
        const connectionHealth = this._requestHandler ? this._requestHandler.getConnectionHealthStats() : {
            consecutiveHangups: 0,
            totalHangups: 0,
            agentRecreationCount: 0
        };

        // Determine overall health status
        const healthyKeys = aggregated.circuitStates.closed + aggregated.circuitStates.halfOpen;
        const keyHealthy = healthyKeys > 0;
        const queueHealthy = backpressure.percentUsed < 90;
        const memoryHealthy = memUsage.heapUsed < (memUsage.heapTotal * 0.9);

        const checks = {
            keys: {
                status: keyHealthy ? 'healthy' : 'unhealthy',
                healthy: healthyKeys,
                total: aggregated.totalKeys,
                states: aggregated.circuitStates
            },
            queue: {
                status: queueHealthy ? 'healthy' : 'degraded',
                current: backpressure.current,
                max: backpressure.max,
                percentUsed: backpressure.percentUsed,
                queueStats: backpressure.queue
            },
            memory: {
                status: memoryHealthy ? 'healthy' : 'warning',
                heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
                heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
                external: Math.round(memUsage.external / 1024 / 1024),
                rss: Math.round(memUsage.rss / 1024 / 1024),
                percentUsed: Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100)
            },
            connections: {
                status: connectionHealth.consecutiveHangups < 3 ? 'healthy' : 'degraded',
                consecutiveHangups: connectionHealth.consecutiveHangups,
                totalHangups: connectionHealth.totalHangups,
                agentRecreations: connectionHealth.agentRecreationCount
            },
            traces: {
                status: 'healthy',
                stored: traceStats.totalTraces,
                capacity: traceStats.capacity,
                utilization: traceStats.utilization,
                successRate: traceStats.totalTraces > 0
                    ? Math.round((traceStats.successCount / traceStats.totalTraces) * 100)
                    : null
            }
        };

        // Add scheduler stats if available
        if (this._keyManager && this._keyManager.getSchedulerStats) {
            const schedulerStats = this._keyManager.getSchedulerStats();
            if (schedulerStats) {
                checks.scheduler = {
                    status: 'healthy',
                    poolState: this._keyManager.getPoolState ? this._keyManager.getPoolState() : 'unknown',
                    reasonDistribution: schedulerStats.reasonDistribution,
                    fairnessScore: schedulerStats.fairness?.fairnessScore
                };
            }
        }

        // Add model routing stats if available
        if (this._modelRouter) {
            checks.modelRouting = {
                status: this._modelRouter.enabled ? 'healthy' : 'disabled',
                enabled: this._modelRouter.enabled,
                stats: this._modelRouter.getStats(),
                activeCooldowns: Object.keys(this._modelRouter.getCooldowns()).length,
                activeOverrides: Object.keys(this._modelRouter.getOverrides()).length
            };
        } else {
            checks.modelRouting = { status: 'not_configured' };
        }

        // Determine overall status
        const allHealthy = keyHealthy && queueHealthy && memoryHealthy;
        const overallStatus = allHealthy ? 'healthy' : keyHealthy ? 'degraded' : 'unhealthy';
        const statusCode = allHealthy ? 200 : keyHealthy ? 200 : 503;

        const response = {
            status: overallStatus,
            timestamp: new Date().toISOString(),
            uptime: this._getUptime(),
            checkDuration: Date.now() - startTime,
            checks,
            process: {
                pid: process.pid,
                nodeVersion: process.version,
                platform: process.platform,
                arch: process.arch
            }
        };

        // Redact sensitive data before sending
        const redactedResponse = redactSensitiveData(response, {
            redactBodies: true,
            redactHeaders: true,
            bodyPreviewLength: 200
        });

        res.writeHead(statusCode, { 'content-type': 'application/json' });
        res.end(JSON.stringify(redactedResponse, null, 2));
    }
}

module.exports = {
    HealthController
};
