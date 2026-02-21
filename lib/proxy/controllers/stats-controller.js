/**
 * Stats Controller Module
 *
 * Handles stats-related routes extracted from ProxyServer.
 * Provides endpoints for statistics, metrics, and data persistence.
 *
 * TDD Phase: Green - Implementation to make tests pass
 */

'use strict';

/**
 * StatsController class for stats-related HTTP endpoints
 */
class StatsController {
    /**
     * @param {Object} options - Configuration options
     * @param {Object} options.statsAggregator - StatsAggregator instance
     * @param {Object} options.keyManager - KeyManager instance
     * @param {Object} options.requestHandler - RequestHandler instance
     * @param {Object} options.tenantManager - TenantManager instance (optional)
     * @param {Object} options.costTracker - CostTracker instance (optional)
     * @param {Object} options.modelRouter - ModelRouter instance (optional)
     * @param {Function} options.getUptime - Function to get uptime in ms
     * @param {Function} options.reloadKeys - Function to reload API keys
     * @param {Object} options.config - Configuration object
     */
    constructor(options = {}) {
        this._statsAggregator = options.statsAggregator || null;
        this._keyManager = options.keyManager || null;
        this._requestHandler = options.requestHandler || null;
        this._tenantManager = options.tenantManager || null;
        this._costTracker = options.costTracker || null;
        this._modelRouter = options.modelRouter || null;
        this._getUptime = options.getUptime || (() => 0);
        this._reloadKeys = options.reloadKeys || null;
        this._config = options.config || { apiKeys: [], poolCooldown: {} };
        this._isPaused = options.isPaused || false;
    }

    /**
     * Handle /stats endpoint
     * GET: Return full statistics
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    handleStats(req, res) {
        const backpressure = this._requestHandler ? this._requestHandler.getBackpressureStats() : {
            current: 0,
            max: 0,
            percentUsed: 0,
            queue: { length: 0, waiting: 0 }
        };

        const stats = this._statsAggregator ? this._statsAggregator.getFullStats(
            this._keyManager,
            this._getUptime(),
            backpressure.queue
        ) : {};

        stats.backpressure = backpressure;
        stats.paused = this._isPaused;
        if (this._requestHandler && this._requestHandler.getRequestPayloadStoreStats) {
            stats.requestPayloadStore = this._requestHandler.getRequestPayloadStoreStats();
        }

        // Add pool cooldown policy and state (for observability)
        const poolStats = this._keyManager && this._keyManager.getPoolRateLimitStats
            ? this._keyManager.getPoolRateLimitStats()
            : {};

        stats.poolCooldown = {
            // Current state
            ...poolStats,
            // Configured policy
            policy: {
                sleepThresholdMs: this._config.poolCooldown?.sleepThresholdMs || 250,
                retryJitterMs: this._config.poolCooldown?.retryJitterMs || 200,
                maxCooldownMs: this._config.poolCooldown?.maxCooldownMs || 5000,
                baseMs: this._config.poolCooldown?.baseMs || 500,
                capMs: this._config.poolCooldown?.capMs || 5000,
                decayMs: this._config.poolCooldown?.decayMs || 10000
            }
        };

        // Add 429 rate limit tracking stats
        const rateLimitTracking = this._statsAggregator && this._statsAggregator.getRateLimitTrackingStats
            ? this._statsAggregator.getRateLimitTrackingStats()
            : {};

        if (Object.keys(rateLimitTracking).length > 0) {
            stats.rateLimitTracking = rateLimitTracking;
        }

        // Add pool 429 penalty stats from model router
        if (this._modelRouter && this._modelRouter.getPool429PenaltyStats) {
            stats.pool429Penalty = this._modelRouter.getPool429PenaltyStats();
        }

        // Add cluster mode annotation (Milestone 6)
        // Only show as clustered if actually running in cluster mode (workers spawned)
        const cluster = require('cluster');
        const isActuallyClustered = cluster.isPrimary && cluster.workers && Object.keys(cluster.workers).length > 0;
        stats.clusterMode = {
            enabled: isActuallyClustered,
            workerId: cluster.worker ? cluster.worker.id : null,
            isPrimary: cluster.isPrimary,
            workerCount: cluster.isPrimary && cluster.workers ? Object.keys(cluster.workers).length : null,
            warning: cluster.worker
                ? 'CLUSTER MODE: Stats shown are for THIS WORKER ONLY. Rate limits and key state are PER-WORKER, not global. Restart without cluster mode for accurate global stats.'
                : null
        };

        res.writeHead(200, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            'pragma': 'no-cache',
            'expires': '0'
        });
        res.end(JSON.stringify(stats, null, 2));
    }

    /**
     * Handle /metrics endpoint - Prometheus format
     * GET: Return metrics in Prometheus exposition format
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    handleMetrics(req, res) {
        const backpressure = this._requestHandler ? this._requestHandler.getBackpressureStats() : {
            current: 0,
            max: 0,
            percentUsed: 0,
            queue: { current: 0, max: 0 }
        };

        const stats = this._statsAggregator ? this._statsAggregator.getFullStats(
            this._keyManager,
            this._getUptime(),
            backpressure.queue
        ) : {};
        if (this._requestHandler && this._requestHandler.getRequestPayloadStoreStats) {
            stats.requestPayloadStore = this._requestHandler.getRequestPayloadStoreStats();
        }

        const rateLimitTracking = this._statsAggregator && this._statsAggregator.getRateLimitTrackingStats
            ? this._statsAggregator.getRateLimitTrackingStats()
            : {};

        const poolStats = this._keyManager && this._keyManager.getPoolRateLimitStats
            ? this._keyManager.getPoolRateLimitStats()
            : {};

        // Build Prometheus exposition format
        const lines = [];

        // Metadata
        lines.push('# HELP glm_proxy_info Proxy version and configuration');
        lines.push('# TYPE glm_proxy_info gauge');
        lines.push('glm_proxy_info{version="2.0.0"} 1');
        lines.push('');

        // Uptime (convert ms to seconds)
        const uptimeSeconds = Math.floor((stats.uptime || 0) / 1000);
        lines.push('# HELP glm_proxy_uptime_seconds Proxy uptime in seconds');
        lines.push('# TYPE glm_proxy_uptime_seconds counter');
        lines.push(`glm_proxy_uptime_seconds ${uptimeSeconds}`);
        lines.push('');

        // Request counters
        lines.push('# HELP glm_proxy_requests_total Total number of client requests');
        lines.push('# TYPE glm_proxy_requests_total counter');
        const clientReqs = stats.clientRequests || {};
        lines.push(`glm_proxy_requests_total{status="success"} ${clientReqs.succeeded || 0}`);
        lines.push(`glm_proxy_requests_total{status="failed"} ${clientReqs.failed || 0}`);
        lines.push('');

        // In-flight requests
        lines.push('# HELP glm_proxy_requests_in_flight Current number of in-flight requests');
        lines.push('# TYPE glm_proxy_requests_in_flight gauge');
        lines.push(`glm_proxy_requests_in_flight ${clientReqs.inFlight || stats.inFlightRequests || 0}`);
        lines.push('');

        // Success rate
        lines.push('# HELP glm_proxy_success_rate Current success rate (0-100)');
        lines.push('# TYPE glm_proxy_success_rate gauge');
        lines.push(`glm_proxy_success_rate ${stats.successRate != null ? stats.successRate : 0}`);
        lines.push('');

        // Latency percentiles
        lines.push('# HELP glm_proxy_latency_milliseconds Request latency in milliseconds');
        lines.push('# TYPE glm_proxy_latency_milliseconds gauge');
        const latency = stats.latency || {};
        if (latency.p50 != null) lines.push(`glm_proxy_latency_milliseconds{quantile="0.5"} ${latency.p50}`);
        if (latency.p95 != null) lines.push(`glm_proxy_latency_milliseconds{quantile="0.95"} ${latency.p95}`);
        if (latency.p99 != null) lines.push(`glm_proxy_latency_milliseconds{quantile="0.99"} ${latency.p99}`);
        if (latency.avg != null) lines.push(`glm_proxy_latency_milliseconds{quantile="avg"} ${Math.round(latency.avg)}`);
        lines.push('');

        // Retry counters
        lines.push('# HELP glm_proxy_retries_total LLM 429 retry attempts (deprecated: prefer glm_proxy_retry_attempts_total for all-error retries)');
        lines.push('# TYPE glm_proxy_retries_total counter');
        lines.push(`glm_proxy_retries_total ${rateLimitTracking.llm429Retries || 0}`);
        lines.push('');

        lines.push('# HELP glm_proxy_retry_attempts_total Total retry attempts across all error types');
        lines.push('# TYPE glm_proxy_retry_attempts_total counter');
        const errors = stats.errors || {};
        lines.push(`glm_proxy_retry_attempts_total ${errors.totalRetries || 0}`);
        lines.push('');

        lines.push('# HELP glm_proxy_retries_succeeded_total Successful retries');
        lines.push('# TYPE glm_proxy_retries_succeeded_total counter');
        lines.push(`glm_proxy_retries_succeeded_total ${rateLimitTracking.llm429RetrySuccesses || 0}`);
        lines.push('');

        // 429 counters
        lines.push('# HELP glm_proxy_rate_limit_total Rate limit responses');
        lines.push('# TYPE glm_proxy_rate_limit_total counter');
        lines.push(`glm_proxy_rate_limit_total{source="upstream"} ${rateLimitTracking.upstream429s || 0}`);
        lines.push(`glm_proxy_rate_limit_total{source="local"} ${rateLimitTracking.local429s || 0}`);
        lines.push('');

        // Pool cooldowns
        lines.push('# HELP glm_proxy_pool_cooldowns_total Pool cooldown activations');
        lines.push('# TYPE glm_proxy_pool_cooldowns_total counter');
        lines.push(`glm_proxy_pool_cooldowns_total ${rateLimitTracking.poolCooldowns || 0}`);
        lines.push('');

        lines.push('# HELP glm_proxy_pool_in_cooldown Pool is currently in cooldown');
        lines.push('# TYPE glm_proxy_pool_in_cooldown gauge');
        lines.push(`glm_proxy_pool_in_cooldown ${poolStats.inCooldown ? 1 : 0}`);
        lines.push('');

        // Inject pool 429 penalty stats into stats for appendMonth1Metrics
        if (this._modelRouter && this._modelRouter.getPool429PenaltyStats) {
            stats.pool429Penalty = this._modelRouter.getPool429PenaltyStats();
        }

        // Month 1 metrics (shared helper — single source of truth to prevent drift with proxy-server.js)
        // Pre-fetch routing stats so they're available both here and in the modelRouter block
        const routingStats = this._modelRouter ? this._modelRouter.getStats() : null;
        appendMonth1Metrics(lines, stats, routingStats);

        // Key health
        lines.push('# HELP glm_proxy_keys_total Total number of API keys');
        lines.push('# TYPE glm_proxy_keys_total gauge');
        const keys = stats.keys || [];
        lines.push(`glm_proxy_keys_total ${keys.length}`);
        lines.push('');

        lines.push('# HELP glm_proxy_keys_healthy Number of healthy API keys');
        lines.push('# TYPE glm_proxy_keys_healthy gauge');
        const healthyKeys = keys.filter(k => k.state === 'CLOSED').length;
        lines.push(`glm_proxy_keys_healthy ${healthyKeys}`);
        lines.push('');

        // Per-key metrics
        lines.push('# HELP glm_proxy_key_requests_total Requests per key');
        lines.push('# TYPE glm_proxy_key_requests_total counter');
        keys.forEach((key, idx) => {
            lines.push(`glm_proxy_key_requests_total{key="${idx}"} ${key.total || 0}`);
        });
        lines.push('');

        lines.push('# HELP glm_proxy_key_state Key circuit breaker state (0=closed, 1=half_open, 2=open)');
        lines.push('# TYPE glm_proxy_key_state gauge');
        keys.forEach((key, idx) => {
            const stateValue = key.state === 'CLOSED' ? 0 : key.state === 'HALF_OPEN' ? 1 : 2;
            lines.push(`glm_proxy_key_state{key="${idx}"} ${stateValue}`);
        });
        lines.push('');

        // Token usage
        lines.push('# HELP glm_proxy_tokens_total Total tokens processed');
        lines.push('# TYPE glm_proxy_tokens_total counter');
        const tokens = stats.tokens || {};
        lines.push(`glm_proxy_tokens_total{type="input"} ${tokens.totalInputTokens || 0}`);
        lines.push(`glm_proxy_tokens_total{type="output"} ${tokens.totalOutputTokens || 0}`);
        lines.push('');

        // Cost tracking
        lines.push('# HELP glm_proxy_cost_total Estimated total cost in USD');
        lines.push('# TYPE glm_proxy_cost_total counter');
        // Calculate cost from tokens if cost tracker is available
        const inputCost = ((tokens.totalInputTokens || 0) / 1_000_000) * 3.00;
        const outputCost = ((tokens.totalOutputTokens || 0) / 1_000_000) * 15.00;
        lines.push(`glm_proxy_cost_total ${(inputCost + outputCost).toFixed(6)}`);
        lines.push('');

        // Error counters
        lines.push('# HELP glm_proxy_errors_total Error counts by type');
        lines.push('# TYPE glm_proxy_errors_total counter');
        lines.push(`glm_proxy_errors_total{type="timeout"} ${errors.timeouts || 0}`);
        lines.push(`glm_proxy_errors_total{type="socket_hangup"} ${errors.socketHangups || 0}`);
        lines.push(`glm_proxy_errors_total{type="connection_refused"} ${errors.connectionRefused || 0}`);
        lines.push(`glm_proxy_errors_total{type="server_error"} ${errors.serverErrors || 0}`);
        lines.push(`glm_proxy_errors_total{type="rate_limited"} ${errors.rateLimited || 0}`);
        lines.push('');

        // Queue metrics
        lines.push('# HELP glm_proxy_queue_size Current backpressure queue size');
        lines.push('# TYPE glm_proxy_queue_size gauge');
        lines.push(`glm_proxy_queue_size ${backpressure.queue?.current || 0}`);
        lines.push('');

        lines.push('# HELP glm_proxy_queue_max Maximum backpressure queue size');
        lines.push('# TYPE glm_proxy_queue_max gauge');
        lines.push(`glm_proxy_queue_max ${backpressure.queue?.max || 0}`);
        lines.push('');

        // Paused state
        lines.push('# HELP glm_proxy_paused Proxy is paused');
        lines.push('# TYPE glm_proxy_paused gauge');
        lines.push(`glm_proxy_paused ${this._isPaused ? 1 : 0}`);
        lines.push('');

        // Tenant metrics (if multi-tenant enabled)
        if (this._tenantManager) {
            const tenantStats = this._tenantManager.getAllTenantStats();

            if (tenantStats.enabled && tenantStats.tenants) {
                // Tenant info metric
                lines.push('# HELP glm_proxy_tenant_info Tenant configuration info');
                lines.push('# TYPE glm_proxy_tenant_info gauge');
                Object.values(tenantStats.tenants).forEach(tenant => {
                    const strictMode = tenant.strictMode || false;
                    lines.push(`glm_proxy_tenant_info{tenant="${tenant.tenantId}",strict_mode="${strictMode}"} 1`);
                });
                lines.push('');

                // Per-tenant request counters
                lines.push('# HELP glm_proxy_tenant_requests_total Total requests per tenant');
                lines.push('# TYPE glm_proxy_tenant_requests_total counter');
                Object.values(tenantStats.tenants).forEach(tenant => {
                    lines.push(`glm_proxy_tenant_requests_total{tenant="${tenant.tenantId}"} ${tenant.requestCount || 0}`);
                });
                lines.push('');

                // Per-tenant key counts
                lines.push('# HELP glm_proxy_tenant_keys_total Total keys per tenant');
                lines.push('# TYPE glm_proxy_tenant_keys_total gauge');
                Object.values(tenantStats.tenants).forEach(tenant => {
                    lines.push(`glm_proxy_tenant_keys_total{tenant="${tenant.tenantId}"} ${tenant.keyCount || 0}`);
                });
                lines.push('');

                // Per-tenant error counts
                lines.push('# HELP glm_proxy_tenant_errors_total Total errors per tenant');
                lines.push('# TYPE glm_proxy_tenant_errors_total counter');
                Object.values(tenantStats.tenants).forEach(tenant => {
                    lines.push(`glm_proxy_tenant_errors_total{tenant="${tenant.tenantId}"} ${tenant.errorCount || 0}`);
                });
                lines.push('');
            }
        }

        // Model routing metrics
        if (this._modelRouter) {
            // routingStats already fetched above for Month 1 metrics

            lines.push('# HELP glm_proxy_model_routing_enabled Whether model routing is enabled');
            lines.push('# TYPE glm_proxy_model_routing_enabled gauge');
            lines.push(`glm_proxy_model_routing_enabled ${this._modelRouter.enabled ? 1 : 0}`);
            lines.push('');

            lines.push('# HELP glm_proxy_model_routing_decisions_total Total routing decisions by tier and source');
            lines.push('# TYPE glm_proxy_model_routing_decisions_total counter');
            for (const [tier, count] of Object.entries(routingStats.byTier)) {
                if (count > 0) {
                    lines.push(`glm_proxy_model_routing_decisions_total{tier="${tier}",source="all"} ${count}`);
                }
            }
            for (const [source, count] of Object.entries(routingStats.bySource)) {
                if (count > 0) {
                    lines.push(`glm_proxy_model_routing_decisions_total{tier="all",source="${source}"} ${count}`);
                }
            }
            lines.push(`glm_proxy_model_routing_decisions_total{tier="all",source="all"} ${routingStats.total}`);
            lines.push('');

            lines.push('# HELP glm_proxy_routing_by_strategy Routing decisions by pool strategy');
            lines.push('# TYPE glm_proxy_routing_by_strategy gauge');
            for (const [strategy, count] of Object.entries(routingStats.byStrategy || {})) {
                if (count > 0) {
                    lines.push(`glm_proxy_routing_by_strategy{strategy="${strategy}"} ${count}`);
                }
            }
            lines.push('');

            lines.push('# HELP glm_proxy_model_routing_failovers_total Total failover events');
            lines.push('# TYPE glm_proxy_model_routing_failovers_total counter');
            lines.push(`glm_proxy_model_routing_failovers_total ${routingStats.bySource.failover || 0}`);
            lines.push('');

            lines.push('# HELP glm_proxy_model_routing_switches_total Total model switches across all requests');
            lines.push('# TYPE glm_proxy_model_routing_switches_total counter');
            lines.push(`glm_proxy_model_routing_switches_total ${routingStats.bySource.failover || 0}`);
            lines.push('');

            const cooldowns = this._modelRouter.getCooldowns();
            const activeCooldowns = Object.keys(cooldowns).length;
            lines.push('# HELP glm_proxy_model_routing_cooldowns_active Number of models currently in cooldown');
            lines.push('# TYPE glm_proxy_model_routing_cooldowns_active gauge');
            lines.push(`glm_proxy_model_routing_cooldowns_active ${activeCooldowns}`);
            lines.push('');

            if (activeCooldowns > 0) {
                const maxRemainingMs = Math.max(...Object.values(cooldowns).map(c => c.remainingMs));
                lines.push('# HELP glm_proxy_model_routing_cooldown_max_remaining_ms Maximum cooldown remaining across all models');
                lines.push('# TYPE glm_proxy_model_routing_cooldown_max_remaining_ms gauge');
                lines.push(`glm_proxy_model_routing_cooldown_max_remaining_ms ${maxRemainingMs}`);
                lines.push('');
            }

            lines.push('# HELP glm_proxy_model_routing_cooldowns_recorded_total Model cooldowns recorded by mode');
            lines.push('# TYPE glm_proxy_model_routing_cooldowns_recorded_total counter');
            const normalTotal = (routingStats.total || 0) - (routingStats.burstDampenedTotal || 0);
            lines.push(`glm_proxy_model_routing_cooldowns_recorded_total{mode="normal"} ${Math.max(0, normalTotal)}`);
            lines.push(`glm_proxy_model_routing_cooldowns_recorded_total{mode="burst"} ${routingStats.burstDampenedTotal || 0}`);
            lines.push('');

            const overrideCount = Object.keys(this._modelRouter.getOverrides()).length;
            lines.push('# HELP glm_proxy_model_routing_overrides_active Number of active routing overrides');
            lines.push('# TYPE glm_proxy_model_routing_overrides_active gauge');
            lines.push(`glm_proxy_model_routing_overrides_active ${overrideCount}`);
            lines.push('');

            // Tier downgrade counters handled by appendMonth1Metrics above

            // GLM5-04: Upgrade reason counters
            lines.push('# HELP glm_proxy_upgrade_reason_total Heavy tier upgrade triggers by reason');
            lines.push('# TYPE glm_proxy_upgrade_reason_total counter');
            for (const reason of Object.keys(routingStats.byUpgradeReason || {})) {
                const count = routingStats.byUpgradeReason[reason];
                if (count > 0) {
                    lines.push(`glm_proxy_upgrade_reason_total{reason="${reason}"} ${count}`);
                }
            }
            lines.push('');

            // GLM5-05: Per-model selection counters (heavy tier only, bounded)
            const heavyModels = routingStats.heavyModels || [];
            if (heavyModels.length > 0) {
                lines.push('# HELP glm_proxy_heavy_model_selections_total Selections per model (heavy tier only)');
                lines.push('# TYPE glm_proxy_heavy_model_selections_total counter');
                for (const model of heavyModels) {
                    const count = (routingStats.byModel || {})[model] || 0;
                    if (count > 0) {
                        // Escape \ and " for Prometheus label safety
                        const safeModel = model.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                        lines.push(`glm_proxy_heavy_model_selections_total{model="${safeModel}"} ${count}`);
                    }
                }
                lines.push('');
            }

            // GLM5-06: Fallback reason counters
            lines.push('# HELP glm_proxy_fallback_reason_total Fallback events by reason');
            lines.push('# TYPE glm_proxy_fallback_reason_total counter');
            for (const reason of Object.keys(routingStats.byFallbackReason || {})) {
                const count = routingStats.byFallbackReason[reason];
                if (count > 0) {
                    lines.push(`glm_proxy_fallback_reason_total{reason="${reason}"} ${count}`);
                }
            }
            lines.push('');

            // GLM5-07: Staged rollout counters
            lines.push('# HELP glm_proxy_glm5_eligible_total Heavy requests eligible for GLM-5 preference');
            lines.push('# TYPE glm_proxy_glm5_eligible_total counter');
            lines.push(`glm_proxy_glm5_eligible_total ${routingStats.glm5EligibleTotal || 0}`);
            lines.push('');

            lines.push('# HELP glm_proxy_glm5_preference_applied_total Requests where GLM-5 preference was actively applied');
            lines.push('# TYPE glm_proxy_glm5_preference_applied_total counter');
            lines.push(`glm_proxy_glm5_preference_applied_total ${routingStats.glm5PreferenceApplied || 0}`);
            lines.push('');

            lines.push('# HELP glm_proxy_glm5_preference_shadow_total Requests where GLM-5 would have been preferred (shadow mode)');
            lines.push('# TYPE glm_proxy_glm5_preference_shadow_total counter');
            lines.push(`glm_proxy_glm5_preference_shadow_total ${routingStats.glm5PreferenceShadow || 0}`);
            lines.push('');

            // NORM-02: Config migration write failure tracking
            const configMigration = stats?.configMigration || {};
            lines.push('# HELP glm_proxy_config_migration_write_failure_total Number of times normalized config persistence failed');
            lines.push('# TYPE glm_proxy_config_migration_write_failure_total counter');
            lines.push(`glm_proxy_config_migration_write_failure_total ${configMigration.writeFailures || 0}`);
            lines.push('');
        }

        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
        res.end(lines.join('\n'));
    }

    /**
     * Handle /persistent-stats endpoint
     * GET: Return persistent statistics
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    handlePersistentStats(req, res) {
        const configuredKeyIds = this._config.apiKeys.map(k => {
            if (this._keyManager && this._keyManager.getKeyId) {
                return this._keyManager.getKeyId(k);
            }
            return k;
        });
        const response = this._statsAggregator
            ? this._statsAggregator.getPersistentStatsResponse(configuredKeyIds)
            : { stats: {}, persistent: false };

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response, null, 2));
    }

    /**
     * Handle /reload endpoint
     * POST: Reload API keys
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    handleReload(req, res) {
        if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed, use POST' }));
            return;
        }

        const result = this._reloadKeys ? this._reloadKeys() : null;
        if (result) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ success: true, ...result }));
        } else {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Failed to reload keys' }));
        }
    }

    /**
     * Handle /backpressure endpoint
     * GET: Return backpressure statistics
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    handleBackpressure(req, res) {
        const backpressure = this._requestHandler
            ? this._requestHandler.getBackpressureStats()
            : { current: 0, max: 0, percentUsed: 0, queue: { current: 0, max: 0 } };

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(backpressure));
    }

    /**
     * Handle /stats/tenants endpoint
     * GET: Return tenant statistics
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    handleStatsTenants(req, res) {
        if (!this._tenantManager) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                enabled: false,
                message: 'Multi-tenant mode not enabled',
                tenants: {}
            }));
            return;
        }

        const tenantStats = this._tenantManager.getAllTenantStats();

        // Enhance with cost data if cost tracker is available
        if (this._costTracker && this._costTracker.getAllTenantCosts) {
            const tenantCosts = this._costTracker.getAllTenantCosts() || {};
            for (const [tenantId, costs] of Object.entries(tenantCosts)) {
                if (tenantStats.tenants[tenantId]) {
                    tenantStats.tenants[tenantId].costs = costs;
                }
            }
        }

        // Add summary statistics
        const summary = {
            totalTenants: tenantStats.tenantCount,
            totalRequests: tenantStats.globalStats?.totalRequests || 0,
            unknownTenantRequests: tenantStats.globalStats?.unknownTenantRequests || 0,
            tenantBreakdown: []
        };

        // Build tenant breakdown
        for (const [tenantId, data] of Object.entries(tenantStats.tenants || {})) {
            summary.tenantBreakdown.push({
                tenantId,
                keyCount: data.keyCount,
                requestCount: data.requestCount,
                errorCount: data.errorCount,
                errorRate: data.requestCount > 0
                    ? Math.round((data.errorCount / data.requestCount) * 100 * 100) / 100
                    : 0,
                lastUsed: data.lastUsed,
                totalCost: data.costs?.totalCost || 0
            });
        }

        // Sort by request count (most active first)
        summary.tenantBreakdown.sort((a, b) => b.requestCount - a.requestCount);

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            ...tenantStats,
            summary,
            timestamp: new Date().toISOString()
        }, null, 2));
    }
}

/**
 * Append Month 1 metrics to Prometheus lines array.
 * Shared between proxy-server.js (monolith) and StatsController to prevent drift.
 * @param {string[]} lines - Prometheus exposition lines array (mutated)
 * @param {Object} stats - Full stats from getFullStats()
 * @param {Object} [routingStats] - From modelRouter.getStats() (optional)
 */
function appendMonth1Metrics(lines, stats, routingStats) {
    // Request payload store metrics
    const payloadStore = stats.requestPayloadStore || {};
    lines.push('# HELP glm_proxy_request_payload_store_size Current number of payload snapshots stored in memory');
    lines.push('# TYPE glm_proxy_request_payload_store_size gauge');
    lines.push(`glm_proxy_request_payload_store_size ${payloadStore.size || 0}`);
    lines.push('');

    lines.push('# HELP glm_proxy_request_payload_store_max_entries Configured max payload snapshots retained');
    lines.push('# TYPE glm_proxy_request_payload_store_max_entries gauge');
    lines.push(`glm_proxy_request_payload_store_max_entries ${payloadStore.maxEntries || 0}`);
    lines.push('');

    lines.push('# HELP glm_proxy_request_payload_store_retention_ms Configured payload retention in milliseconds');
    lines.push('# TYPE glm_proxy_request_payload_store_retention_ms gauge');
    lines.push(`glm_proxy_request_payload_store_retention_ms ${payloadStore.retentionMs || 0}`);
    lines.push('');

    lines.push('# HELP glm_proxy_request_payload_store_hits_total Payload snapshot lookup hits');
    lines.push('# TYPE glm_proxy_request_payload_store_hits_total counter');
    lines.push(`glm_proxy_request_payload_store_hits_total ${payloadStore.hits || 0}`);
    lines.push('');

    lines.push('# HELP glm_proxy_request_payload_store_misses_total Payload snapshot lookup misses');
    lines.push('# TYPE glm_proxy_request_payload_store_misses_total counter');
    lines.push(`glm_proxy_request_payload_store_misses_total ${payloadStore.misses || 0}`);
    lines.push('');

    lines.push('# HELP glm_proxy_request_payload_store_evicted_ttl_total Payload snapshots evicted by TTL');
    lines.push('# TYPE glm_proxy_request_payload_store_evicted_ttl_total counter');
    lines.push(`glm_proxy_request_payload_store_evicted_ttl_total ${payloadStore.evictedByTtl || 0}`);
    lines.push('');

    lines.push('# HELP glm_proxy_request_payload_store_evicted_size_total Payload snapshots evicted by max entries');
    lines.push('# TYPE glm_proxy_request_payload_store_evicted_size_total counter');
    lines.push(`glm_proxy_request_payload_store_evicted_size_total ${payloadStore.evictedBySize || 0}`);
    lines.push('');

    lines.push('# HELP glm_proxy_request_payload_store_stored_total Total payload snapshots stored since start');
    lines.push('# TYPE glm_proxy_request_payload_store_stored_total counter');
    lines.push(`glm_proxy_request_payload_store_stored_total ${payloadStore.storedTotal || 0}`);
    lines.push('');

    // Give-up counters
    const giveUpStats = stats.giveUpTracking || {};
    const giveUpByReason = giveUpStats.byReason || {};
    lines.push('# HELP glm_proxy_give_up_total Total early give-up events');
    lines.push('# TYPE glm_proxy_give_up_total counter');
    lines.push(`glm_proxy_give_up_total ${giveUpStats.total || 0}`);
    lines.push('');

    lines.push('# HELP glm_proxy_give_up_by_reason_total Give-up events by reason');
    lines.push('# TYPE glm_proxy_give_up_by_reason_total counter');
    lines.push(`glm_proxy_give_up_by_reason_total{reason="max_429_attempts"} ${giveUpByReason.max_429_attempts || 0}`);
    lines.push(`glm_proxy_give_up_by_reason_total{reason="max_429_window"} ${giveUpByReason.max_429_window || 0}`);
    lines.push('');

    // Retry efficiency counters
    const retryEfficiency = stats.retryEfficiency || {};
    lines.push('# HELP glm_proxy_same_model_retries_total Same-model retry attempts (waste)');
    lines.push('# TYPE glm_proxy_same_model_retries_total counter');
    lines.push(`glm_proxy_same_model_retries_total ${retryEfficiency.sameModelRetries || 0}`);
    lines.push('');

    lines.push('# HELP glm_proxy_models_tried_on_failure_total Cumulative models tried across failed requests');
    lines.push('# TYPE glm_proxy_models_tried_on_failure_total counter');
    lines.push(`glm_proxy_models_tried_on_failure_total ${retryEfficiency.totalModelsTriedOnFailure || 0}`);
    lines.push('');

    lines.push('# HELP glm_proxy_model_switches_on_failure_total Cumulative model switches across failed requests');
    lines.push('# TYPE glm_proxy_model_switches_on_failure_total counter');
    lines.push(`glm_proxy_model_switches_on_failure_total ${retryEfficiency.totalModelSwitchesOnFailure || 0}`);
    lines.push('');

    lines.push('# HELP glm_proxy_failed_requests_with_model_stats_total Failed requests with model routing stats (denominator for averaging)');
    lines.push('# TYPE glm_proxy_failed_requests_with_model_stats_total counter');
    lines.push(`glm_proxy_failed_requests_with_model_stats_total ${retryEfficiency.failedRequestsWithModelStats || 0}`);
    lines.push('');

    // Retry backoff counters
    const retryBackoff = stats.retryBackoff || {};
    lines.push('# HELP glm_proxy_retry_backoff_ms_sum Cumulative retry backoff delay in milliseconds');
    lines.push('# TYPE glm_proxy_retry_backoff_ms_sum counter');
    lines.push(`glm_proxy_retry_backoff_ms_sum ${retryBackoff.totalDelayMs || 0}`);
    lines.push('');

    lines.push('# HELP glm_proxy_retry_backoff_count Total retry backoff delay events');
    lines.push('# TYPE glm_proxy_retry_backoff_count counter');
    lines.push(`glm_proxy_retry_backoff_count ${retryBackoff.delayCount || 0}`);
    lines.push('');

    // Admission hold counters
    const admissionHold = stats.admissionHold || {};
    lines.push('# HELP glm_proxy_admission_hold_total Requests entering admission hold');
    lines.push('# TYPE glm_proxy_admission_hold_total counter');
    lines.push(`glm_proxy_admission_hold_total ${admissionHold.total || 0}`);
    lines.push('');

    lines.push('# HELP glm_proxy_admission_hold_succeeded_total Held requests released after capacity recovered');
    lines.push('# TYPE glm_proxy_admission_hold_succeeded_total counter');
    lines.push(`glm_proxy_admission_hold_succeeded_total ${admissionHold.succeeded || 0}`);
    lines.push('');

    lines.push('# HELP glm_proxy_admission_hold_timed_out_total Held requests that hit max hold time');
    lines.push('# TYPE glm_proxy_admission_hold_timed_out_total counter');
    lines.push(`glm_proxy_admission_hold_timed_out_total ${admissionHold.timedOut || 0}`);
    lines.push('');

    lines.push('# HELP glm_proxy_admission_hold_rejected_total Requests rejected by concurrency guard');
    lines.push('# TYPE glm_proxy_admission_hold_rejected_total counter');
    lines.push(`glm_proxy_admission_hold_rejected_total ${admissionHold.rejected || 0}`);
    lines.push('');

    lines.push('# HELP glm_proxy_admission_hold_ms_sum Cumulative hold time in milliseconds');
    lines.push('# TYPE glm_proxy_admission_hold_ms_sum counter');
    lines.push(`glm_proxy_admission_hold_ms_sum ${admissionHold.totalHoldMs || 0}`);
    lines.push('');

    // Pool 429 penalty active hits per model
    const pool429Penalty = stats.pool429Penalty || {};
    if (pool429Penalty.byModel && Object.keys(pool429Penalty.byModel).length > 0) {
        lines.push('# HELP glm_proxy_pool_429_penalty_hits Active 429 penalty hits per model');
        lines.push('# TYPE glm_proxy_pool_429_penalty_hits gauge');
        for (const [model, entry] of Object.entries(pool429Penalty.byModel)) {
            const hits = typeof entry === 'object' ? entry.hits : entry;
            // Escape \ and " for Prometheus label safety
            const safeModel = model.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            lines.push(`glm_proxy_pool_429_penalty_hits{model="${safeModel}"} ${hits}`);
        }
        lines.push('');
    }

    // Pool 429 penalty aggregate gauges
    lines.push('# HELP glm_proxy_pool_429_penalty_tracked_models Number of models currently tracked for 429 penalty');
    lines.push('# TYPE glm_proxy_pool_429_penalty_tracked_models gauge');
    lines.push(`glm_proxy_pool_429_penalty_tracked_models ${pool429Penalty.trackedModels || 0}`);
    lines.push('');

    lines.push('# HELP glm_proxy_pool_429_penalty_max_hits Highest active 429 penalty hit count across all models');
    lines.push('# TYPE glm_proxy_pool_429_penalty_max_hits gauge');
    const maxHits = pool429Penalty.byModel
        ? Math.max(0, ...Object.values(pool429Penalty.byModel).map(e => (typeof e === 'object' ? e.hits : e) || 0))
        : 0;
    lines.push(`glm_proxy_pool_429_penalty_max_hits ${maxHits}`);
    lines.push('');

    // Tier downgrade counters (only if routingStats provided)
    if (routingStats) {
        lines.push('# HELP glm_proxy_tier_downgrade_total Active tier downgrade events');
        lines.push('# TYPE glm_proxy_tier_downgrade_total counter');
        lines.push(`glm_proxy_tier_downgrade_total ${routingStats.tierDowngradeTotal || 0}`);
        lines.push('');

        lines.push('# HELP glm_proxy_tier_downgrade_shadow_total Shadow tier downgrade events (would-have-downgraded)');
        lines.push('# TYPE glm_proxy_tier_downgrade_shadow_total counter');
        lines.push(`glm_proxy_tier_downgrade_shadow_total ${routingStats.tierDowngradeShadow || 0}`);
        lines.push('');

        const tierDowngradeByRoute = routingStats.tierDowngradeByRoute || {};
        if (Object.keys(tierDowngradeByRoute).length > 0) {
            lines.push('# HELP glm_proxy_tier_downgrade_by_route_total Active tier downgrades by route');
            lines.push('# TYPE glm_proxy_tier_downgrade_by_route_total counter');
            for (const [route, count] of Object.entries(tierDowngradeByRoute)) {
                const [from, to] = route.split('->');
                lines.push(`glm_proxy_tier_downgrade_by_route_total{from="${from}",to="${to}"} ${count}`);
            }
            lines.push('');
        }

        const tierDowngradeShadowByRoute = routingStats.tierDowngradeShadowByRoute || {};
        if (Object.keys(tierDowngradeShadowByRoute).length > 0) {
            lines.push('# HELP glm_proxy_tier_downgrade_shadow_by_route_total Shadow tier downgrades by route');
            lines.push('# TYPE glm_proxy_tier_downgrade_shadow_by_route_total counter');
            for (const [route, count] of Object.entries(tierDowngradeShadowByRoute)) {
                const [from, to] = route.split('->');
                lines.push(`glm_proxy_tier_downgrade_shadow_by_route_total{from="${from}",to="${to}"} ${count}`);
            }
            lines.push('');
        }

        // Context overflow counters
        lines.push('# HELP glm_proxy_context_overflow_total Requests rejected due to context window overflow');
        lines.push('# TYPE glm_proxy_context_overflow_total counter');
        lines.push(`glm_proxy_context_overflow_total ${routingStats.contextOverflowTotal || 0}`);
        lines.push('');

        const overflowByTier = routingStats.contextOverflowByTier || {};
        if (Object.keys(overflowByTier).length > 0) {
            lines.push('# HELP glm_proxy_context_overflow_by_tier_total Context overflow rejections by tier');
            lines.push('# TYPE glm_proxy_context_overflow_by_tier_total counter');
            for (const [tier, count] of Object.entries(overflowByTier)) {
                lines.push(`glm_proxy_context_overflow_by_tier_total{tier="${tier}"} ${count}`);
            }
            lines.push('');
        }

        const overflowByModel = routingStats.contextOverflowByModel || {};
        if (Object.keys(overflowByModel).length > 0) {
            lines.push('# HELP glm_proxy_context_overflow_by_model_total Context overflow rejections by model');
            lines.push('# TYPE glm_proxy_context_overflow_by_model_total counter');
            for (const [model, count] of Object.entries(overflowByModel)) {
                lines.push(`glm_proxy_context_overflow_by_model_total{model="${model}"} ${count}`);
            }
            lines.push('');
        }
    }
}

module.exports = {
    StatsController,
    appendMonth1Metrics
};
