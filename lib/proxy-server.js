/**
 * Proxy Server Module
 * Main proxy server with clustering, graceful shutdown, and hot reload
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cluster = require('cluster');
const os = require('os');

const { Config, getConfig } = require('./config');
const { Logger, getLogger, generateRequestId } = require('./logger');
const { KeyManager } = require('./key-manager');
const { StatsAggregator } = require('./stats-aggregator');
const { RequestHandler } = require('./request-handler');
const { HistoryTracker } = require('./history-tracker');
const { generateDashboard } = require('./dashboard');
// New feature imports (#3-#10)
const { CostTracker } = require('./cost-tracker');
const { WebhookManager } = require('./webhook-manager');
const { RequestStore } = require('./request-store');
const { TenantManager } = require('./tenant-manager');
const { AdminAuth } = require('./admin-auth');
const { redactSensitiveData } = require('./redact');
const { parseJsonBody } = require('./body-parser');
const { ModelRouter } = require('./model-router');
const {
    normalizeModelRoutingConfig,
    computeConfigHash,
    shouldPersistNormalizedConfig,
    updateMigrationMarker
} = require('./model-router-normalizer');
const { atomicWrite } = require('./atomic-write');
const { RingBuffer } = require('./ring-buffer');
const { getClientIp } = require('./client-ip');
const { ModelDiscovery } = require('./model-discovery');
const { performStartupMigration } = require('./config-migrator');
const { appendMonth1Metrics } = require('./proxy/controllers/stats-controller');
const { CountersController } = require('./proxy/controllers/counters-controller');

// Route policy engine (Week 6)
let RoutePolicyManager;
try {
    RoutePolicyManager = require('./route-policy').RoutePolicyManager;
} catch (e) {
    RoutePolicyManager = null;
    if (e.code !== 'MODULE_NOT_FOUND') console.warn('[proxy-server] Failed to load route-policy:', e.message);
}

// Predictive scaling (Week 8)
let PredictiveScaler;
try {
    PredictiveScaler = require('./predictive-scaler').PredictiveScaler;
} catch (e) {
    PredictiveScaler = null;
    if (e.code !== 'MODULE_NOT_FOUND') console.warn('[proxy-server] Failed to load predictive-scaler:', e.message);
}

// Replay Queue (Week 11)
let ReplayQueue;
try {
    ReplayQueue = require('./replay-queue');
} catch (e) {
    ReplayQueue = null;
    if (e.code !== 'MODULE_NOT_FOUND') console.warn('[proxy-server] Failed to load replay-queue:', e.message);
}

// Plugin Manager (Week 12)
let PluginManager;
try {
    PluginManager = require('./plugin-manager').PluginManager;
} catch (e) {
    PluginManager = null;
    if (e.code !== 'MODULE_NOT_FOUND') console.warn('[proxy-server] Failed to load plugin-manager:', e.message);
}

/**
 * Allowlist of headers permitted in sanitized replay requests.
 * All other headers (auth, cookies, hop-by-hop, etc.) are stripped.
 */
const REPLAY_ALLOWED_HEADERS = new Set([
    'content-type',
    'accept',
    'accept-encoding',
    'accept-language',
    'user-agent',
    'anthropic-version',
    'anthropic-beta'
]);

class ProxyServer {
    constructor(options = {}) {
        this.config = options.config || getConfig();
        // Track if running as cluster worker (to disable file writes)
        this.isClusterWorker = options.isClusterWorker || false;
        this.logger = options.logger || getLogger({
            level: this.config.logLevel,
            format: this.config.logFormat,
            prefix: this._getProcessPrefix()
        });

        this.keyManager = new KeyManager({
            maxConcurrencyPerKey: this.config.maxConcurrencyPerKey,
            circuitBreaker: this.config.circuitBreaker,
            rateLimitPerMinute: this.config.rateLimitPerMinute,
            rateLimitBurst: this.config.rateLimitBurst,
            poolCooldown: this.config.poolCooldown,
            logger: this.logger.child('keys')
        });

        // Load per-model concurrency limits from known model metadata.
        // Z.ai concurrency limits are per-model per-account (not per-key).
        // With multiple keys sharing one account, the limit is shared across all keys.
        const { KNOWN_GLM_MODELS: knownModels } = require('./model-discovery');
        const modelLimits = {};
        for (const m of knownModels) {
            if (m.maxConcurrency) modelLimits[m.id] = m.maxConcurrency;
        }
        this.keyManager.setModelConcurrencyLimits(modelLimits);

        this.statsAggregator = new StatsAggregator({
            statsFile: this.config.statsFile,
            configDir: this.config.configDir,
            saveInterval: this.config.statsSaveInterval,
            logger: this.logger.child('stats')
        });

        // Adaptive concurrency (AIMD) — observes 429 signals and adjusts effective limits
        this.adaptiveConcurrency = null;
        if (this.config.adaptiveConcurrency?.enabled !== false) {
            const { AdaptiveConcurrencyController } = require('./adaptive-concurrency');
            this.adaptiveConcurrency = new AdaptiveConcurrencyController(
                this.config.adaptiveConcurrency || {},
                {
                    keyManager: this.keyManager,
                    logger: this.logger.child ? this.logger.child('adaptive-conc') : this.logger,
                    statsAggregator: this.statsAggregator
                }
            );
        }

        // z.ai Account Usage Monitor — polls subscription quota (primary only)
        this.usageMonitor = null;
        if (this.config.usageMonitor?.enabled !== false
            && this.config.apiKeys?.length > 0
            && !this.isClusterWorker) {
            const { UsageMonitor } = require('./usage-monitor');
            this.usageMonitor = new UsageMonitor(
                this.config.usageMonitor || {},
                {
                    logger: this.logger.child ? this.logger.child('usage-monitor') : this.logger,
                    keyManager: this.keyManager,
                    targetHost: this.config.targetHost?.replace(/:\d+$/, '') || 'api.z.ai',
                    configDir: this.config.configDir
                }
            );
        }

        this.requestHandler = new RequestHandler({
            keyManager: this.keyManager,
            statsAggregator: this.statsAggregator,
            config: this.config,
            logger: this.logger.child('proxy'),
            costTracker: this.costTracker || null
        });

        this.rateLimiter = this.keyManager.rateLimiter;

        this.server = null;
        this.startTime = Date.now();
        this.isShuttingDown = false;
        this.isPaused = false;
        this.activeConnections = new Set();

        // File watcher for hot reload
        this.keysWatcher = null;
        this._routePolicyHotReloadEnabled = false;

        // Initialize history tracker
        this.historyTracker = new HistoryTracker({
            logger: this.logger,
            historyFile: path.join(this.config.configDir, 'history.json')
        });

        // Setup circuit state change tracking for history (PHASE 2 - Task #6)
        this.keyManager.onKeyStateChange = (keyInfo, from, to, info) => {
            this.historyTracker.recordCircuitTransition(
                keyInfo.index,
                keyInfo.keyPrefix,
                from.toUpperCase(),
                to.toUpperCase(),
                info?.reason || 'state_change'
            );
        };

        // Setup SSE clients
        // - stream clients: /requests/stream (message-only SSE)
        // - event clients:  /events (typed SSE events for E2E + dashboards)
        this.sseStreamClients = new Set();
        this.sseEventClients = new Set();

        // Pool-status SSE broadcast state
        this._poolStatusSeq = 0;
        this._poolStatusInterval = null;

        // Security: Rate limiting and SSE connection tracking
        this._rateLimitMap = new Map();  // IP -> { count, resetTime }
        this._ssePerIp = new Map();      // IP -> Set of client IDs
        this._auditLogMaxEntries = this.config.security?.auditLog?.maxEntries || 1000;
        this._auditLog = new RingBuffer(this._auditLogMaxEntries); // In-memory audit log buffer

        // Async buffered audit logging
        this._auditFileBuffer = [];      // Pending entries to write to file
        this._auditFlushTimer = null;    // Timer for periodic flush
        this._auditFlushing = false;     // Prevent concurrent flushes

        // Start periodic audit flush (every 2 seconds or 50 entries)
        this._auditFlushTimer = setInterval(() => {
            this._flushAuditBuffer();
        }, 2000);
        this._auditFlushTimer.unref();

        // Clean up rate limit map every minute
        this._rateLimitCleanupInterval = setInterval(() => {
            const now = Date.now();
            for (const [ip, data] of this._rateLimitMap) {
                if (data.resetTime < now) {
                    this._rateLimitMap.delete(ip);
                }
            }
        }, 60000);
        this._rateLimitCleanupInterval.unref();

        // Subscribe to RequestHandler 'request' events for SSE broadcast
        // This is the SINGLE source of truth for request events (no dual emission)
        this.requestHandler.on('request', (request) => this._broadcastRequest(request));

        // Initialize Cost Tracker (#6)
        if (this.config.costTracking?.enabled) {
            // Disable persistence in cluster workers
            const persistPath = this.isClusterWorker
                ? null
                : this.config.costTracking.persistPath;

            try {
                this.costTracker = new CostTracker({
                    rates: this.config.costTracking.rates,
                    budget: this.config.costTracking.budget,
                    persistPath: persistPath,
                    configDir: this.config.configDir,
                    logger: this.logger.child('cost'),
                    onBudgetAlert: (alert) => this._handleBudgetAlert(alert)
                });
                // Wire cost tracker to request handler (created earlier in constructor)
                this.requestHandler.costTracker = this.costTracker;
            } catch (err) {
                this.logger.error('Cost tracking initialization failed, continuing without it', { error: err.message });
                this.costTracker = null;
            }
        }

        // Initialize Webhook Manager (#7)
        if (this.config.webhooks?.enabled) {
            this.webhookManager = new WebhookManager({
                enabled: this.config.webhooks.enabled,
                endpoints: this.config.webhooks.endpoints,
                maxRetries: this.config.webhooks.maxRetries,
                retryDelayMs: this.config.webhooks.retryDelayMs,
                timeoutMs: this.config.webhooks.timeoutMs,
                errorSpikeThreshold: this.config.webhooks.errorSpikeThreshold,
                errorSpikeWindow: this.config.webhooks.errorSpikeWindow,
                dedupeWindowMs: this.config.webhooks.dedupeWindowMs,
                logger: this.logger.child('webhooks')
            });
        }

        // Initialize Request Store (#9)
        // Disable entirely in cluster workers (memory-only store is not useful)
        if (this.config.requestStore?.enabled && !this.isClusterWorker) {
            this.requestStore = new RequestStore({
                enabled: this.config.requestStore.enabled,
                storeFile: this.config.requestStore.storeFile,
                configDir: this.config.configDir,
                maxRequests: this.config.requestStore.maxRequests,
                ttlHours: this.config.requestStore.ttlHours,
                storeBodySizeLimit: this.config.requestStore.storeBodySizeLimit,
                errorTypesToStore: this.config.requestStore.errorTypesToStore,
                logger: this.logger.child('replay'),
                onReplay: (req) => this._handleReplay(req)
            });
        } else if (this.config.requestStore?.enabled && this.isClusterWorker) {
            this.logger.warn('Request store disabled in cluster worker (master-only feature)');
        }

        // Initialize Admin Auth
        if (this.config.adminAuth?.enabled) {
            this.adminAuth = new AdminAuth({
                enabled: this.config.adminAuth.enabled,
                headerName: this.config.adminAuth.headerName,
                tokens: this.config.adminAuth.tokens,
                protectedPaths: this.config.adminAuth.protectedPaths,
                trustedProxies: this.config.security?.trustedProxies,
                logger: this.logger.child('auth')
            });

            // Expose adminAuth instance for RequestHandler header override auth
            this.config._adminAuthInstance = this.adminAuth;
        }

        // Initialize Model Router (always constructed, even when disabled)
        // This allows UI/API to configure it while disabled and toggle on without restart

        // Load persisted model routing config (if file exists)
        let modelRoutingConfig = this.config.modelRouting || {};
        let modelRoutingMigrated = false; // Track migration for conditional persistence (Wave 3)
        let persistedPath = null; // Hoisted for NORM-02 persistence block below
        if (this.config.configDir && modelRoutingConfig.configFile) {
            try {
                persistedPath = path.join(this.config.configDir, modelRoutingConfig.configFile);
                const raw = fs.readFileSync(persistedPath, 'utf8');
                const persisted = JSON.parse(raw);

                // NORM-01: Normalize persisted config through normalizer
                // This handles v1-to-v2 migration and ensures pure v2 shapes in memory
                const normalizationResult = normalizeModelRoutingConfig(persisted, {
                    logger: this.logger.child ? this.logger.child('model-router') : this.logger
                });

                modelRoutingConfig = normalizationResult.normalizedConfig;
                modelRoutingMigrated = normalizationResult.migrated;

                // Log warnings from normalization
                if (normalizationResult.warnings && normalizationResult.warnings.length > 0) {
                    this._routingConfigWarnings = this._routingConfigWarnings || [];
                    this._routingConfigWarnings.push(...normalizationResult.warnings);
                    this.logger.warn?.('[ModelRouter] Normalization warnings: ' + normalizationResult.warnings.join('; '));
                }

                // Forward-compat: reject unknown major versions
                // Accept 1.x (original) and 2.x (v2 tier format with models[])
                if (persisted.version) {
                    const major = parseInt(String(persisted.version).split('.')[0], 10);
                    if (isNaN(major) || major > 2) {
                        this._routingLoadError = 'Incompatible config version: ' + persisted.version + ' (expected 1.x or 2.x)';
                        this.logger.warn?.('[ModelRouter] ' + this._routingLoadError);
                        // Still use normalized config even if version check fails (normalizer handles v1/v2)
                    }
                }

                // Validate normalized config
                const validation = ModelRouter.validateConfig(modelRoutingConfig);
                if (!validation.valid) {
                    this._routingLoadError = 'Invalid persisted config after normalization: ' + validation.error;
                    this.logger.warn?.('[ModelRouter] ' + this._routingLoadError);
                } else {
                    // Deep-merge: persisted editable fields override defaults
                    modelRoutingConfig = { ...this.config.modelRouting, ...modelRoutingConfig };
                    this.logger.info?.('[ModelRouter] Loaded persisted config from ' + persistedPath);
                    if (modelRoutingMigrated) {
                        this.logger.info?.('[ModelRouter] Persisted config was normalized from v1 to v2 format');
                    }
                    if (validation.warnings?.length > 0) {
                        this._routingConfigWarnings = this._routingConfigWarnings || [];
                        this._routingConfigWarnings.push(...validation.warnings);
                        this.logger.warn?.('[ModelRouter] Config warnings: ' + validation.warnings.join('; '));
                    }
                }
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    this._routingLoadError = 'Failed to load persisted config: ' + err.message;
                    this.logger.warn?.('[ModelRouter] ' + this._routingLoadError);
                }
                // ENOENT = file doesn't exist yet — silently use defaults
            }

            // NORM-02: Persist normalized config only when migration occurred
            // This ensures v1 configs are migrated to v2 and written back to disk
            // but only once per file hash to avoid repeated writes
            if (modelRoutingMigrated && persistedPath) {
                try {
                    const currentHash = computeConfigHash(modelRoutingConfig);

                    // Check if we should persist (first time or hash changed)
                    if (shouldPersistNormalizedConfig(persistedPath, currentHash)) {
                        this.logger.info?.('[ModelRouter] Persisting normalized config to disk after migration');

                        // Serialize with 2-space indent for readability
                        const serialized = JSON.stringify(modelRoutingConfig, null, 2);
                        // Note: atomicWrite returns a Promise but we're in sync constructor context
                        // Use synchronous write here instead
                        fs.writeFileSync(persistedPath, serialized, 'utf8');

                        // Update marker after successful write
                        updateMigrationMarker(persistedPath, currentHash);

                        this.logger.info?.('[ModelRouter] Normalized config persisted successfully');
                    }
                } catch (persistErr) {
                    // NORM-02: Graceful failure handling - don't crash on write errors
                    const errMsg = `Failed to persist normalized config: ${persistErr.message}`;
                    this.logger.warn?.('[ModelRouter] ' + errMsg);

                    // Emit metric for monitoring
                    if (this.statsAggregator) {
                        this.statsAggregator.recordConfigMigrationWriteFailure();
                    }

                    // Store for API response inclusion
                    this._routingConfigWriteFailure = errMsg;
                }
            }
        }

        // Auto-migrate modelMapping to modelRouting if needed (Phase 3: MIGRATE-02)
        const migrationResult = performStartupMigration(
            modelRoutingConfig,
            this.config.modelMapping,
            this.logger
        );
        if (migrationResult.migrated) {
            modelRoutingConfig = migrationResult.config;
        }

        // Initialize Model Discovery (must be before ModelRouter)
        this.modelDiscovery = new ModelDiscovery({
            cacheTTL: this.config.modelDiscovery?.ttl || 5 * 60 * 1000,
            configPath: this.config.configDir
                ? path.join(this.config.configDir, '.omc-config.json')
                : path.join(process.cwd(), '.omc-config.json'),
            customModels: this.config.modelDiscovery?.customModels || []
        });

        // Initialize Model Router with ModelDiscovery
        // concurrencyMultiplier=1 (default): z.ai limits are per-model per-account.
        // If keys span multiple accounts, set concurrencyMultiplier to numAccounts.
        this.modelRouter = new ModelRouter(modelRoutingConfig, {
            configDir: this.config.configDir,
            logger: this.logger.child ? this.logger.child('model-router') : this.logger,
            persistEnabled: !this.isClusterWorker,
            modelDiscovery: this.modelDiscovery
        });

        // Wire model router into request handler (constructed earlier in init sequence)
        this.requestHandler.modelRouter = this.modelRouter;

        // ARCH-03: Wire up drift detection between Router and KeyManager
        this.modelRouter.setKeyManagerForDrift(this.keyManager);

        // Wire adaptive concurrency into request handler and model router
        if (this.adaptiveConcurrency) {
            this.requestHandler.adaptiveConcurrency = this.adaptiveConcurrency;
            this.modelRouter.adaptiveConcurrency = this.adaptiveConcurrency;
            this.adaptiveConcurrency.start();
            this.logger.info('Adaptive concurrency started', {
                mode: this.config.adaptiveConcurrency?.mode || 'observe_only'
            });
        }

        // Start usage monitor (polls z.ai subscription quota)
        if (this.usageMonitor) {
            this.usageMonitor.start();
            this.logger.info('Usage monitor started');
        }

        // Model routing config persistence state
        this._routingPersistence = {
            enabled: !!(this.config.modelRouting?.persistConfigEdits) && !this.isClusterWorker,
            configPath: this.config.configDir
                ? path.join(this.config.configDir, this.config.modelRouting?.configFile || 'model-routing.json')
                : null,
            lastSavedAt: null,
            lastSaveError: null,
            lastLoadError: this._routingLoadError || null,
            configWarnings: this._routingConfigWarnings || null,
            migrated: modelRoutingMigrated // Track if migration occurred (Wave 3: conditional persistence)
        };

        // Initialize Tenant Manager (#10)
        if (this.config.multiTenant?.enabled) {
            this.tenantManager = new TenantManager({
                enabled: this.config.multiTenant.enabled,
                tenantHeader: this.config.multiTenant.tenantHeader,
                defaultTenantId: this.config.multiTenant.defaultTenantId,
                strictMode: this.config.multiTenant.strictMode,
                isolateStats: this.config.multiTenant.isolateStats,
                maxConcurrencyPerKey: this.config.maxConcurrencyPerKey,
                circuitBreaker: this.config.circuitBreaker,
                rateLimitPerMinute: this.config.rateLimitPerMinute,
                rateLimitBurst: this.config.rateLimitBurst,
                configDir: this.config.configDir,
                logger: this.logger.child('tenants')
            });
        }

        // Route Policy Manager (Week 6)
        if (RoutePolicyManager && this.config.routePolicies?.enabled !== false) {
            const configPath = this.config.routePolicies?.configPath ||
                path.join(this.config.configDir, 'config', 'route-policies.json');

            this.routePolicyManager = new RoutePolicyManager({
                configPath,
                logger: this.logger.child('policies'),
                onReload: (result) => {
                    this._addAuditEntry('policy_reload', {
                        success: result.success,
                        policiesLoaded: result.policiesLoaded,
                        error: result.error
                    });
                    if (result.success) {
                        this.logger.info(`Route policies reloaded: ${result.policiesLoaded} policies`);
                    } else {
                        this.logger.error(`Route policy reload failed: ${result.error}`);
                    }
                }
            });
            this._routePolicyHotReloadEnabled = this.config.routePolicies?.hotReload !== false;
        }

        // Predictive Scaler (Week 8)
        if (PredictiveScaler && this.config.predictiveScaling?.enabled !== false) {
            this.predictiveScaler = new PredictiveScaler({
                historyWindow: this.config.predictiveScaling?.historyWindow || 7200000,
                predictionHorizon: this.config.predictiveScaling?.predictionHorizon || 900000,
                minSamples: this.config.predictiveScaling?.minSamples || 10
            });
            // Record usage every minute
            this._scalerInterval = setInterval(() => {
                this._recordScalerUsage();
            }, 60000);
            this._scalerInterval.unref();
        }

        // Replay Queue (Week 11)
        if (ReplayQueue && this.config.replayQueue?.enabled !== false && !this.isClusterWorker) {
            this.replayQueue = new ReplayQueue({
                maxQueueSize: this.config.replayQueue?.maxQueueSize || 100,
                retentionPeriod: this.config.replayQueue?.retentionPeriod || 86400000,
                maxRetries: this.config.replayQueue?.maxRetries || 3
            });

            // Subscribe to queue events for logging
            this.replayQueue.on('enqueued', ({ traceId, queueSize }) => {
                this.logger.debug(`Request ${traceId} enqueued for replay (queue size: ${queueSize})`);
            });
            this.replayQueue.on('replaySuccess', ({ traceId, attempts }) => {
                this.logger.info(`Request ${traceId} replayed successfully after ${attempts} attempt(s)`);
            });
            this.replayQueue.on('replayError', ({ traceId, attempts, canRetry }) => {
                this.logger.warn(`Request ${traceId} replay failed (attempt ${attempts}, can retry: ${canRetry})`);
            });
        } else if (this.config.replayQueue?.enabled && this.isClusterWorker) {
            this.logger.warn('Replay queue disabled in cluster worker (master-only feature)');
        }

        // Plugin Manager (Week 12)
        if (PluginManager && this.config.plugins?.enabled !== false) {
            const pluginDir = this.config.plugins?.directory ||
                path.join(this.config.configDir, 'plugins');

            this.pluginManager = new PluginManager({
                pluginDir,
                autoload: this.config.plugins?.autoload !== false,
                logger: this.logger.child('plugins'),
                context: {
                    keyManager: this.keyManager,
                    statsAggregator: this.statsAggregator,
                    config: this.config
                }
            });

            // Subscribe to plugin events
            this.pluginManager.on('plugin:registered', ({ name }) => {
                this.logger.info(`Plugin registered: ${name}`);
            });
            this.pluginManager.on('plugin:error', ({ name, error }) => {
                this.logger.error(`Plugin error [${name}]: ${error}`);
            });
        }

        // Request trace store (#3)
        this.maxRequestTraces = this.config.requestTracing?.maxTraces || 1000;
        this.requestTraces = new RingBuffer(this.maxRequestTraces);
    }

    _getProcessPrefix() {
        if (cluster.isPrimary) return 'MASTER';
        if (cluster.worker) return `W${cluster.worker.id}`;
        return 'MAIN';
    }

    /**
     * Initialize the server
     */
    async initialize() {
        // Log any config load errors (deferred from construction)
        const configErrors = this.config.flushLoadErrors();
        for (const err of configErrors) {
            this.logger.error(`Config load error (${err.type}): ${err.message}`, { path: err.path });
        }

        // Load API keys
        this.keyManager.loadKeys(this.config.apiKeys);

        // CLUSTER SAFETY: Only master/standalone should persist to disk
        // Workers send stats to master via IPC, so they shouldn't write files
        if (!this.isClusterWorker) {
            // Load persistent stats
            this.statsAggregator.load();
            this.statsAggregator.startAutoSave();

            // Start history tracking with persistence
            this.historyTracker.start(
                () => this.statsAggregator.getFullStats(this.keyManager, this._getUptime()),
                this.modelRouter ? () => this.modelRouter?.getStats() ?? null : null
            );

            this.logger.info('Running in single-process mode - all persistence enabled');
        } else {
            // Workers: start history tracking without persistence (memory-only)
            this.logger.warn('='.repeat(70));
            this.logger.warn('CLUSTER MODE: Worker process - file persistence DISABLED');
            this.logger.warn('Stats, history, costs, and request store are MEMORY-ONLY in workers');
            this.logger.warn('Rate limits and key state are PER-WORKER, not global');
            this.logger.warn('Dashboard shows random worker view, not aggregated stats');
            this.logger.warn('='.repeat(70));

            // Still track in-memory for local /stats endpoint
            this.historyTracker.start(
                () => this.statsAggregator.getFullStats(this.keyManager, this._getUptime()),
                this.modelRouter ? () => this.modelRouter?.getStats() ?? null : null
            );
            // But disable the file save timer
            this.historyTracker.saveTimer && clearInterval(this.historyTracker.saveTimer);
            this.historyTracker.saveTimer = null;
        }

        // Setup hot reload watcher
        this._setupHotReload();

        // Start route policy watcher only after full server initialization.
        // This avoids leaking fs watchers in tests that instantiate ProxyServer
        // without calling initialize/start/shutdown.
        if (
            this.routePolicyManager &&
            this._routePolicyHotReloadEnabled &&
            this.routePolicyManager.configPath &&
            fs.existsSync(this.routePolicyManager.configPath)
        ) {
            this.routePolicyManager.startWatching();
        }
    }

    /**
     * Setup file watcher for hot reload
     * Can be disabled via config.enableHotReload (useful for tests)
     */
    _setupHotReload() {
        // Skip watcher if disabled (useful in tests to avoid race conditions)
        if (!this.config.get('enableHotReload')) {
            this.logger.debug('Hot reload watcher disabled via config');
            return;
        }

        const keysPath = path.join(this.config.configDir, this.config.get('keysFile'));

        try {
            this.keysWatcher = fs.watch(keysPath, (eventType) => {
                if (eventType === 'change') {
                    this.logger.info('API keys file changed, reloading...');
                    this._reloadKeys();
                }
            });
        } catch (err) {
            this.logger.warn(`Could not setup hot reload watcher: ${err.message}`);
        }
    }

    /**
     * Reload API keys
     */
    _reloadKeys() {
        try {
            const newKeys = this.config.reloadKeys();
            const result = this.keyManager.reloadKeys(newKeys);
            this.logger.info('Keys reloaded', result);

            // Hot-reload model routing config if available
            if (this.modelRouter && this.config?.modelRouting) {
                this.modelRouter.updateConfig(this.config.modelRouting);
            }

            return result;
        } catch (err) {
            this.logger.error(`Failed to reload keys: ${err.message}`);
            return null;
        }
    }

    /**
     * Create HTTP server
     */
    _createServer() {
        this.server = http.createServer((req, res) => {
            this._handleConnection(req, res);
        });

        this.server.timeout = this.config.requestTimeout;
        this.server.keepAliveTimeout = this.config.keepAliveTimeout;

        // Track connections for graceful shutdown
        this.server.on('connection', (socket) => {
            this.activeConnections.add(socket);
            socket.on('close', () => {
                this.activeConnections.delete(socket);
            });
        });
        this.server.on('close', () => {
            this._stopWatchers();
        });

        return this.server;
    }

    _stopWatchers() {
        if (this.keysWatcher) {
            this.keysWatcher.close();
            this.keysWatcher = null;
        }
        if (this.routePolicyManager) {
            this.routePolicyManager.stopWatching();
        }
    }

    /**
     * Handle incoming connection
     */
    _handleConnection(req, res) {
        // Track active connections
        this.statsAggregator.incrementConnections();

        let decremented = false;
        const decrement = () => {
            if (!decremented) {
                decremented = true;
                this.statsAggregator.decrementConnections();
            }
        };
        res.on('finish', decrement);
        res.on('close', decrement);

        // Route request
        this._routeRequest(req, res);
    }

    /**
     * Determine if a path is an admin route (internal endpoint)
     * vs proxy traffic (should be forwarded to upstream)
     * @param {string} path - Request path
     * @returns {boolean}
     */
    _isAdminRoute(path) {
        // All known internal/admin endpoints
        const ADMIN_PATHS = [
            '/health',
            '/health/deep',
            '/metrics',
            '/debug/',
            '/stats',
            '/persistent-stats',
            '/reload',
            '/backpressure',
            '/logs',
            '/control/',
            '/control/clear-logs',
            '/history',
            '/dashboard',
            '/dashboard/',
            '/requests/stream',
            '/requests',
            '/circuit-history',
            '/stats/account-details',
            '/stats/latency-histogram',
            '/stats/cost',
            '/stats/cost/history',
            '/stats/scheduler',
            '/stats/tenants',
            '/traces',
            '/traces/',
            '/predictions',
            '/compare',
            '/webhooks',
            '/tenants',
            '/policies',
            '/policies/',
            '/model-mapping',
            '/model-routing',
            '/model-routing/',
            '/model-routing/export',
            '/model-routing/export/',
            '/model-routing/import-from-mappings',
            '/model-routing/enable-safe',
            '/model-routing/explain',
            '/model-routing/simulate',
            '/model-selection',
            '/models',
            '/replay/',
            '/replay-queue',
            '/replay-queue/',
            '/plugins',
            '/plugins/',
            '/auth-status',
            '/events',
            '/admin/cost-tracking',
            '/admin/cost-tracking/',
            '/admin/cost-tracking/config',
            '/admin/cost-tracking/metrics',
            '/admin/cost-tracking/flush',
            '/admin/cost-tracking/reset'
        ];

        // Check for prefix matches (e.g., /control/*, /replay/*)
        for (const adminPath of ADMIN_PATHS) {
            if (adminPath.endsWith('/')) {
                if (path.startsWith(adminPath)) return true;
            } else {
                if (path === adminPath) return true;
                // Also check for dynamic patterns like /requests/search
                if (adminPath === '/requests' && path.startsWith('/requests')) return true;
                if (adminPath === '/stats/latency-histogram' && path.startsWith('/stats/latency-histogram/')) return true;
            }
        }
        return false;
    }

    /**
     * Determine if a request requires admin authentication
     * - Mutations (POST/PUT/PATCH/DELETE) on admin routes require auth
     * - GET requests on sensitive paths require auth
     * @param {string} path - Request path
     * @param {string} method - HTTP method
     * @returns {boolean}
     */
    _requiresAdminAuth(path, method) {
        if (!this.adminAuth || !this.adminAuth.enabled) return false;

        // Sensitive GET paths that always require auth
        const SENSITIVE_GET_PATHS = [
            '/logs',
            '/replay/',
            '/model-mapping',
            '/model-routing',
            '/model-routing/export',
            '/model-routing/import-from-mappings',
            '/model-selection',
            '/requests',
            '/admin/cost-tracking/config',
            '/admin/cost-tracking/metrics'
        ];

        const isSensitiveGet = method === 'GET' && SENSITIVE_GET_PATHS.some(sensitivePath => {
            if (sensitivePath.endsWith('/')) {
                return path.startsWith(sensitivePath);
            }
            return path.startsWith(sensitivePath);
        });

        // Auth required for:
        // 1. All non-GET/HEAD methods on admin routes (mutations)
        // 2. GET on sensitive paths
        const isMutation = !['GET', 'HEAD'].includes(method);

        return isSensitiveGet || isMutation;
    }

    /**
     * Require authentication for a request
     * @param {http.IncomingMessage} req - HTTP request
     * @param {http.ServerResponse} res - HTTP response
     * @returns {boolean} True if authenticated, false if rejected
     */
    _requireAuth(req, res) {
        const authResult = this.adminAuth.authenticate(req);
        if (!authResult.authenticated) {
            const status = authResult.error === 'too_many_attempts' ? 429 : 401;
            const headers = { 'content-type': 'application/json' };
            if (authResult.retryAfterMs) {
                headers['retry-after'] = String(Math.ceil(authResult.retryAfterMs / 1000));
            }
            res.writeHead(status, headers);
            res.end(JSON.stringify({
                error: authResult.error || 'unauthorized',
                message: authResult.error === 'too_many_attempts'
                    ? 'Too many failed authentication attempts'
                    : 'Admin authentication required'
            }));
            return false;
        }
        return true;
    }

    /**
     * Route request to appropriate handler
     */
    /**
     * Safely call an async handler, catching unhandled rejections.
     */
    _safeAsync(handlerPromise, req, res) {
        Promise.resolve(handlerPromise).catch((err) => {
            this.logger.error('Unhandled async handler error', { error: err.message, url: req.url });
            if (!res.headersSent) {
                this._sendError(res, 500, 'Internal server error');
            }
        });
    }

    _routeRequest(req, res) {
        const url = req.url.split('?')[0];
        const method = req.method;

        // Check if this is an admin route (internal endpoint) or proxy traffic
        const isAdminRoute = this._isAdminRoute(url);

        if (!isAdminRoute) {
            // Proxy traffic - never apply auth gate, forward to upstream
            this._handleProxy(req, res);
            return;
        }

        // Security: Rate limiting for admin routes
        const ip = this._getClientIp(req);
        const isDebugEndpoint = this._isDebugEndpoint(url);

        // Debug endpoints have stricter rate limits
        const rateType = isDebugEndpoint ? 'debug' : (url.startsWith('/dashboard') ? 'dashboard' : 'api');
        if (!this._checkRateLimit(ip, rateType)) {
            res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
            res.end(JSON.stringify({ error: 'rate_limit_exceeded', retryAfter: 60 }));
            return;
        }

        // Security: Debug endpoints ALWAYS require auth (high risk attack surface)
        if (isDebugEndpoint && this._debugEndpointsRequireAuth()) {
            if (!this.adminAuth || !this.adminAuth.enabled) {
                // Auth not configured - block debug endpoints entirely in this case
                this._addAuditEntry('debug_endpoint_blocked_no_auth', { ip, url });
                res.writeHead(403, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'forbidden',
                    message: 'Debug endpoints require admin authentication to be configured'
                }));
                return;
            }
            const authenticated = this._requireAuth(req, res);
            if (!authenticated) {
                this._addAuditEntry('debug_endpoint_auth_failed', { ip, url, method });
                return;
            }
            this._addAuditEntry('debug_endpoint_accessed', { ip, url, method });
        }

        // Security: Internet mode requires auth for protected read endpoints
        if (this._requiresAuthInInternetMode(url)) {
            const authenticated = this._requireAuth(req, res);
            if (!authenticated) {
                this._addAuditEntry('auth_required_internet_mode', { ip, url, method });
                return;
            }
        }

        // Admin route - check auth if required (existing logic)
        if (this._requiresAdminAuth(url, method)) {
            const authenticated = this._requireAuth(req, res);
            if (!authenticated) return;
        }

        switch (url) {
            case '/auth-status':
                this._handleAuthStatus(req, res);
                break;
            case '/health':
                this._handleHealth(req, res);
                break;
            case '/health/deep':
                this._handleHealthDeep(req, res);
                break;
            case '/stats':
                this._handleStats(req, res);
                break;
            case '/metrics':
                this._handleMetrics(req, res);
                break;
            case '/persistent-stats':
                this._handlePersistentStats(req, res);
                break;
            case '/reload':
                this._handleReload(req, res);
                break;
            case '/backpressure':
                this._handleBackpressure(req, res);
                break;
            case '/logs':
                this._handleLogs(req, res);
                break;
            case '/audit-log':
                this._handleAuditLog(req, res);
                break;
            case '/control/clear-logs':
                this._handleClearLogs(req, res);
                break;
            case '/history':
                this._handleHistory(req, res);
                break;
            case '/dashboard':
                this._handleDashboard(req, res);
                break;
            case '/requests/stream':
                this._handleRequestStream(req, res);  // PHASE 2 - Task #10
                break;
            case '/circuit-history':
                this._handleCircuitHistory(req, res);  // PHASE 2 - Task #6
                break;
            case '/stats/account-details':
                this._handleAccountDetails(req, res);
                break;
            // New endpoints (#3-#10)
            case '/stats/latency-histogram':
                this._handleLatencyHistogram(req, res);
                break;
            case '/stats/cost':
                this._handleCostStats(req, res);
                break;
            case '/stats/cost/history':
                this._handleCostHistory(req, res);
                break;
            case '/stats/scheduler':
                this._handleSchedulerStats(req, res);
                break;
            case '/stats/tenants':
                this._handleStatsTenants(req, res);
                break;
            case '/traces':
                this._handleTraces(req, res);
                break;
            case '/predictions':
                this._handlePredictions(req, res);
                break;
            case '/compare':
                this._handleCompare(req, res);
                break;
            case '/webhooks':
                this._handleWebhooks(req, res);
                break;
            case '/webhooks/test':
                this._safeAsync(this._handleWebhookTest(req, res), req, res);
                break;
            case '/tenants':
                this._handleTenants(req, res);
                break;
            case '/policies':
                this._safeAsync(this._handlePolicies(req, res), req, res);
                break;
            case '/policies/reload':
                this._handlePoliciesReload(req, res);
                break;
            case '/model-mapping':
                this._safeAsync(this._handleModelMapping(req, res), req, res);
                break;
            case '/model-mapping/reset':
                this._safeAsync(this._handleModelMappingReset(req, res), req, res);
                break;
            case '/model-routing':
                this._safeAsync(this._handleModelRouting(req, res), req, res);
                break;
            case '/model-routing/reset':
                this._safeAsync(this._handleModelRoutingReset(req, res), req, res);
                break;
            case '/model-routing/test':
                this._handleModelRoutingTest(req, res);
                break;
            case '/model-routing/export':
                this._handleModelRoutingExport(req, res);
                break;
            case '/model-routing/import-from-mappings':
                this._safeAsync(this._handleModelRoutingImportFromMappings(req, res), req, res);
                break;
            case '/model-routing/explain':
                this._safeAsync(this._handleModelRoutingExplain(req, res), req, res);
                break;
            case '/model-routing/simulate':
                this._safeAsync(this._handleModelRoutingSimulate(req, res), req, res);
                break;
            case '/model-routing/enable-safe':
                this._safeAsync(this._handleModelRoutingEnableSafe(req, res), req, res);
                break;
            case '/model-selection':
                this._handleModelSelection(req, res);
                break;
            case '/models':
                this._safeAsync(this._handleModelsRequest(req, res), req, res);
                break;
            case '/replay-queue':
                this._safeAsync(this._handleReplayQueue(req, res), req, res);
                break;
            case '/replay-queue/stats':
                this._handleReplayQueueStats(req, res);
                break;
            case '/plugins':
                this._safeAsync(this._handlePlugins(req, res), req, res);
                break;
            case '/plugins/stats':
                this._handlePluginsStats(req, res);
                break;
            case '/events':
                this._handleEventsSSE(req, res);
                break;
            case '/admin/cost-tracking/config':
                this._handleCostTrackingConfig(req, res);
                break;
            case '/admin/cost-tracking/metrics':
                this._handleCostTrackingMetrics(req, res);
                break;
            case '/admin/cost-tracking/flush':
                this._handleCostTrackingFlush(req, res);
                break;
            case '/admin/cost-tracking/reset':
                this._handleCostTrackingReset(req, res);
                break;
            default:
                // Dynamic routes
                if (url.startsWith('/dashboard/')) {
                    this._handleDashboardAsset(req, res, url);
                    return;
                }
                if (url.startsWith('/debug/')) {
                    this._handleDebug(req, res, url);
                    return;
                }
                if (url.startsWith('/stats/latency-histogram/')) {
                    this._handleKeyLatencyHistogram(req, res, url);
                    return;
                }
                if (url.startsWith('/traces/')) {
                    this._handleTraceById(req, res, url);
                    return;
                }
                if (url.startsWith('/requests')) {
                    this._handleRequests(req, res, url);
                    return;
                }
                if (url.startsWith('/policies/') && url !== '/policies/reload') {
                    this._handlePolicyByName(req, res, url);
                    return;
                }
                if (url.startsWith('/replay/')) {
                    this._safeAsync(this._handleReplayRequests(req, res, url), req, res);
                    return;
                }
                if (url.startsWith('/tenants/')) {
                    this._handleTenantStats(req, res, url);
                    return;
                }
                if (url.startsWith('/model-mapping/keys/')) {
                    this._safeAsync(this._handleModelMappingKey(req, res, url), req, res);
                    return;
                }
                if (url.startsWith('/model-routing/overrides')) {
                    this._safeAsync(this._handleModelRoutingOverrides(req, res), req, res);
                    return;
                }
                if (url.startsWith('/model-routing/cooldowns')) {
                    this._handleModelRoutingCooldowns(req, res);
                    return;
                }
                if (url.startsWith('/model-routing/pools')) {
                    this._handleModelRoutingPools(req, res);
                    return;
                }
                if (url.startsWith('/model-routing/counters')) {
                    this._handleModelRoutingCounters(req, res);
                    return;
                }
                // Control routes
                if (url.startsWith('/control/')) {
                    this._handleControl(req, res, url);
                    return;
                }
                this._handleProxy(req, res);
        }
    }

    /**
     * Handle /health endpoint
     */
    _handleHealth(req, res) {
        const aggregated = this.keyManager.getAggregatedStats();
        const healthyKeys = aggregated.circuitStates.closed + aggregated.circuitStates.halfOpen;
        const status = healthyKeys > 0 ? 'OK' : 'DEGRADED';
        const statusCode = healthyKeys > 0 ? 200 : 503;

        res.writeHead(statusCode, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            status,
            healthyKeys,
            totalKeys: aggregated.totalKeys,
            uptime: this._getUptime(),
            backpressure: this.requestHandler.getBackpressureStats()
        }));
    }

    /**
     * Handle /health/deep endpoint (Week 3 - Deep Observability)
     * Returns detailed health status for all components
     */
    _handleHealthDeep(req, res) {
        const startTime = Date.now();
        const memUsage = process.memoryUsage();
        const aggregated = this.keyManager.getAggregatedStats();
        const backpressure = this.requestHandler.getBackpressureStats();
        const traceStats = this.requestHandler.getTraceStats();
        const connectionHealth = this.requestHandler.getConnectionHealthStats();

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
        const schedulerStats = this.keyManager.getSchedulerStats?.();
        if (schedulerStats) {
            checks.scheduler = {
                status: 'healthy',
                poolState: this.keyManager.getPoolState?.() || 'unknown',
                reasonDistribution: schedulerStats.reasonDistribution,
                fairnessScore: schedulerStats.fairness?.fairnessScore
            };
        }

        // Add model routing stats if available
        if (this.modelRouter) {
            checks.modelRouting = {
                status: this.modelRouter.enabled ? 'healthy' : 'disabled',
                enabled: this.modelRouter.enabled,
                stats: this.modelRouter.getStats(),
                activeCooldowns: Object.keys(this.modelRouter.getCooldowns()).length,
                activeOverrides: Object.keys(this.modelRouter.getOverrides()).length
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

    /**
     * Handle /debug/* endpoints (Week 3 - Deep Observability)
     * Routes to specific debug handlers
     */
    _handleDebug(req, res, url) {
        const pathname = url.split('?')[0];

        switch (pathname) {
            case '/debug/state':
                this._handleDebugState(req, res);
                break;
            case '/debug/profile':
                this._handleDebugProfile(req, res);
                break;
            case '/debug/keys':
                this._handleDebugKeys(req, res);
                break;
            case '/debug/errors':
                this._handleDebugErrors(req, res);
                break;
            default:
                res.writeHead(404, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Unknown debug endpoint',
                    available: ['/debug/state', '/debug/profile', '/debug/keys', '/debug/errors']
                }));
        }
    }

    /**
     * Handle /debug/state endpoint
     * Dumps internal state for troubleshooting
     */
    _handleDebugState(req, res) {
        const backpressure = this.requestHandler.getBackpressureStats();
        const traceStats = this.requestHandler.getTraceStats();
        const connectionHealth = this.requestHandler.getConnectionHealthStats();
        const recentTraces = this.requestHandler.getRecentTraces(10);

        const state = {
            timestamp: new Date().toISOString(),
            uptime: this._getUptime(),
            paused: this.isPaused,
            shuttingDown: this.isShuttingDown,

            // Connection state
            connections: {
                active: this.activeConnections.size,
                sseClients: this.sseStreamClients.size + this.sseEventClients.size,
                health: connectionHealth
            },

            // Request processing state
            requests: {
                inFlight: backpressure.current,
                max: backpressure.max,
                queue: backpressure.queue
            },

            // Key states
            keys: this.keyManager.getStats().map(k => ({
                index: k.index,
                keyPrefix: k.keyPrefix,
                state: k.circuitBreaker.state,
                inFlight: k.inFlight,
                failures: k.circuitBreaker.failures,
                successes: k.circuitBreaker.successes,
                rateLimitUntil: k.rateLimitUntil > Date.now() ? k.rateLimitUntil : null
            })),

            // Trace store state
            traces: {
                stats: traceStats,
                recent: recentTraces
            },

            // Pool rate limiting state
            pool: this.keyManager.getPoolRateLimitStats?.() || {}
        };

        // Redact sensitive data before sending
        const redactedState = redactSensitiveData(state, {
            redactBodies: true,
            redactHeaders: true,
            bodyPreviewLength: 200
        });

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(redactedState, null, 2));
    }

    /**
     * Handle /debug/profile endpoint
     * Returns performance metrics and latency profiles
     */
    _handleDebugProfile(req, res) {
        const memUsage = process.memoryUsage();
        const cpuUsage = process.cpuUsage();
        const stats = this.statsAggregator.getFullStats(
            this.keyManager,
            this._getUptime()
        );

        // Get per-key latency profiles
        const keyProfiles = this.keyManager.getStats().map(k => ({
            index: k.index,
            keyPrefix: k.keyPrefix,
            latency: k.latency,
            healthScore: k.healthScore,
            selectionStats: k.selectionStats
        }));

        // Get trace statistics for timing analysis
        const traceStats = this.requestHandler.getTraceStats();
        const recentTraces = this.requestHandler.queryTraces({ limit: 50 });

        // Calculate P50/P95/P99 from recent traces
        const durations = recentTraces
            .filter(t => t.totalDuration != null)
            .map(t => t.totalDuration)
            .sort((a, b) => a - b);

        const traceLatency = durations.length > 0 ? {
            count: durations.length,
            min: durations[0],
            max: durations[durations.length - 1],
            p50: durations[Math.floor(durations.length * 0.5)],
            p95: durations[Math.floor(durations.length * 0.95)],
            p99: durations[Math.floor(durations.length * 0.99)],
            avg: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        } : null;

        // Retry analysis
        const tracesWithRetries = recentTraces.filter(t => t.attempts > 1);
        const retryAnalysis = {
            totalTraces: recentTraces.length,
            tracesWithRetries: tracesWithRetries.length,
            retryRate: recentTraces.length > 0
                ? Math.round((tracesWithRetries.length / recentTraces.length) * 100)
                : 0,
            avgAttemptsOnRetry: tracesWithRetries.length > 0
                ? (tracesWithRetries.reduce((sum, t) => sum + t.attempts, 0) / tracesWithRetries.length).toFixed(2)
                : null
        };

        const profile = {
            timestamp: new Date().toISOString(),

            // Process metrics
            process: {
                memory: {
                    heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
                    heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
                    externalMB: Math.round(memUsage.external / 1024 / 1024),
                    rssMB: Math.round(memUsage.rss / 1024 / 1024)
                },
                cpu: {
                    userMicros: cpuUsage.user,
                    systemMicros: cpuUsage.system
                },
                uptime: process.uptime()
            },

            // Overall latency
            latency: stats.latency,

            // Trace-based latency (more accurate, includes queue time)
            traceLatency,

            // Per-key profiles
            keys: keyProfiles,

            // Retry analysis
            retries: retryAnalysis,

            // Error distribution
            errors: stats.errors
        };

        // Redact sensitive data before sending
        const redactedProfile = redactSensitiveData(profile, {
            redactBodies: true,
            redactHeaders: true,
            bodyPreviewLength: 200
        });

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(redactedProfile, null, 2));
    }

    /**
     * Handle /debug/keys endpoint
     * Detailed key state dump
     */
    _handleDebugKeys(req, res) {
        const keys = this.keyManager.getStats();
        const schedulerStats = this.keyManager.getSchedulerStats?.();

        const detailed = keys.map(k => ({
            ...k,
            // Add scheduler info if available
            scheduler: schedulerStats ? {
                selectionCount: schedulerStats.perKeyStats?.[k.index]?.selectionCount,
                lastSelected: schedulerStats.perKeyStats?.[k.index]?.lastSelected
            } : null
        }));

        const keysData = {
            timestamp: new Date().toISOString(),
            count: detailed.length,
            keys: detailed,
            scheduler: schedulerStats
        };

        // Redact sensitive data before sending
        const redactedKeysData = redactSensitiveData(keysData, {
            redactBodies: true,
            redactHeaders: true,
            bodyPreviewLength: 200
        });

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(redactedKeysData, null, 2));
    }

    /**
     * Handle /debug/errors endpoint
     * Recent errors and error patterns
     */
    _handleDebugErrors(req, res) {
        const stats = this.statsAggregator.getFullStats(this.keyManager, this._getUptime());
        const recentTraces = this.requestHandler.queryTraces({ success: false, limit: 50 });

        // Group errors by type
        const errorsByType = {};
        recentTraces.forEach(t => {
            const type = t.finalStatus || 'unknown';
            if (!errorsByType[type]) {
                errorsByType[type] = [];
            }
            errorsByType[type].push({
                traceId: t.traceId,
                path: t.path,
                model: t.model,
                attempts: t.attempts,
                totalDuration: t.totalDuration,
                startTime: new Date(t.startTime).toISOString()
            });
        });

        const errorsData = {
            timestamp: new Date().toISOString(),
            summary: stats.errors,
            recentFailures: recentTraces.length,
            byType: errorsByType
        };

        // Redact sensitive data before sending
        const redactedErrorsData = redactSensitiveData(errorsData, {
            redactBodies: true,
            redactHeaders: true,
            bodyPreviewLength: 200
        });

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(redactedErrorsData, null, 2));
    }

    /**
     * Handle /auth-status endpoint (Milestone 1 - Auth UX)
     * Uses "peek" semantics - doesn't record failures, allows dashboard to show auth state
     * Returns: enabled, tokensConfigured, tokensRequired, authenticated
     */
    _handleAuthStatus(req, res) {
        const { hashToken, secureCompare } = require('./admin-auth');
        const headerName = this.adminAuth?.headerName || 'x-admin-token';

        // Peek at token without recording failures
        let authenticated = false;
        let tokensConfigured = 0;
        let tokensRequired = false;

        if (this.adminAuth && this.adminAuth.enabled) {
            tokensConfigured = this.adminAuth.tokens.size;
            tokensRequired = tokensConfigured > 0;

            // If tokens are configured, validate the provided token
            if (tokensRequired) {
                const providedToken = this.adminAuth.extractToken(req);
                if (providedToken) {
                    // Validate by hashing and comparing against stored hashes
                    const hashedToken = hashToken(providedToken);
                    for (const storedHash of this.adminAuth.tokens) {
                        if (secureCompare(hashedToken, storedHash)) {
                            authenticated = true;
                            break;
                        }
                    }
                }
            }
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            enabled: !!(this.adminAuth && this.adminAuth.enabled),
            tokensConfigured,
            tokensRequired,
            authenticated,
            headerName
        }));
    }

    /**
     * Handle /stats endpoint
     */
    _handleStats(req, res) {
        const backpressure = this.requestHandler.getBackpressureStats();
        const stats = this.statsAggregator.getFullStats(
            this.keyManager,
            this._getUptime(),
            backpressure.queue  // Pass queue stats for inclusion
        );

        stats.backpressure = backpressure;
        stats.paused = this.isPaused;
        if (this.requestHandler?.getRequestPayloadStoreStats) {
            stats.requestPayloadStore = this.requestHandler.getRequestPayloadStoreStats();
        }

        // Add pool cooldown policy and state (for observability)
        stats.poolCooldown = {
            // Current state
            ...this.keyManager.getPoolRateLimitStats?.() || {},
            // Configured policy
            policy: {
                sleepThresholdMs: this.config.poolCooldown?.sleepThresholdMs || 250,
                retryJitterMs: this.config.poolCooldown?.retryJitterMs || 200,
                maxCooldownMs: this.config.poolCooldown?.maxCooldownMs || 5000,
                baseMs: this.config.poolCooldown?.baseMs || 500,
                capMs: this.config.poolCooldown?.capMs || 5000,
                decayMs: this.config.poolCooldown?.decayMs || 10000
            }
        };

        // Add 429 rate limit tracking stats
        const rateLimitTracking = this.statsAggregator.getRateLimitTrackingStats?.() || {};
        if (Object.keys(rateLimitTracking).length > 0) {
            stats.rateLimitTracking = rateLimitTracking;
        }

        // Add cluster mode annotation (Milestone 6)
        // Only show as clustered if actually running in cluster mode (workers spawned)
        const cluster = require('cluster');
        const isActuallyClustered = this.isClusterWorker || (cluster.isPrimary && cluster.workers && Object.keys(cluster.workers).length > 0);
        stats.clusterMode = {
            enabled: isActuallyClustered,
            workerId: cluster.worker ? cluster.worker.id : null,
            isPrimary: cluster.isPrimary,
            workerCount: cluster.isPrimary && cluster.workers ? Object.keys(cluster.workers).length : null,
            warning: this.isClusterWorker
                ? 'CLUSTER MODE: Stats shown are for THIS WORKER ONLY. Rate limits and key state are PER-WORKER, not global. Restart without cluster mode for accurate global stats.'
                : null
        };

        // z.ai account usage (single source of truth: UsageMonitor)
        if (this.usageMonitor) {
            stats.accountUsage = this.usageMonitor.getSnapshot();
        }

        res.writeHead(200, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            'pragma': 'no-cache',
            'expires': '0'
        });
        res.end(JSON.stringify(stats, null, 2));
    }

    /**
     * Handle /stats/account-details — on-demand full account detail.
     * Enriches usage monitor data with tier status, key health, and proxy info.
     */
    async _handleAccountDetails(req, res) {
        if (!this.usageMonitor) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end('{}');
            return;
        }
        const details = this.usageMonitor.getDetails();

        // Enrich with tier status from model router
        if (this.modelRouter) {
            try {
                const tierConfig = this.config?.modelRouting?.tiers || {};
                const snapshot = await this.modelRouter.getModelPoolSnapshot();
                const tierStatus = {};
                for (const [tier, models] of Object.entries(snapshot.pools || {})) {
                    const totalAvailable = models.reduce((sum, m) => sum + m.available, 0);
                    const totalMax = models.reduce((sum, m) => sum + m.maxConcurrency, 0);
                    const anyCooldown = models.some(m => m.inFlight >= m.maxConcurrency);
                    let status = 'operational';
                    if (totalAvailable === 0) status = 'degraded';
                    if (totalMax === 0) status = 'offline';
                    tierStatus[tier] = {
                        status,
                        strategy: tierConfig[tier]?.strategy || 'unknown',
                        models: models.map(m => ({
                            model: m.model,
                            inFlight: m.inFlight,
                            maxConcurrency: m.maxConcurrency,
                            available: m.available
                        }))
                    };
                }
                details.tierStatus = tierStatus;
            } catch (_) { /* non-critical */ }
        }

        // Enrich with key health summary
        if (this.keyManager) {
            const keys = this.keyManager.keys || [];
            details.keyHealth = {
                total: keys.length,
                healthy: keys.filter(k => k.circuitBreaker?.state === 'CLOSED').length,
                halfOpen: keys.filter(k => k.circuitBreaker?.state === 'HALF_OPEN').length,
                open: keys.filter(k => k.circuitBreaker?.state === 'OPEN').length
            };
        }

        // Add adaptive concurrency summary
        if (this.adaptiveConcurrency) {
            const acSnap = this.adaptiveConcurrency.getSnapshot?.();
            if (acSnap) {
                details.adaptiveConcurrency = {
                    mode: acSnap.mode || 'unknown',
                    models: {}
                };
                for (const [model, ms] of Object.entries(acSnap.models || {})) {
                    details.adaptiveConcurrency.models[model] = {
                        effectiveMax: ms.effectiveMax,
                        congestion429: ms.congestion429,
                        success: ms.success
                    };
                }
            }
        }

        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(details));
    }

    /**
     * Handle /metrics endpoint - Prometheus format
     * Week 3: Observability export with essential gauges/counters
     */
    _handleMetrics(req, res) {
        const backpressure = this.requestHandler.getBackpressureStats();
        const stats = this.statsAggregator.getFullStats(
            this.keyManager,
            this._getUptime(),
            backpressure.queue
        );
        if (this.requestHandler?.getRequestPayloadStoreStats) {
            stats.requestPayloadStore = this.requestHandler.getRequestPayloadStoreStats();
        }

        const rateLimitTracking = this.statsAggregator.getRateLimitTrackingStats?.() || {};
        const poolStats = this.keyManager.getPoolRateLimitStats?.() || {};

        // Build Prometheus exposition format
        const lines = [];

        // Metadata
        lines.push('# HELP glm_proxy_info Proxy version and configuration');
        lines.push('# TYPE glm_proxy_info gauge');
        lines.push('glm_proxy_info{version="2.0.0"} 1');
        lines.push('');

        // Uptime
        lines.push('# HELP glm_proxy_uptime_seconds Proxy uptime in seconds');
        lines.push('# TYPE glm_proxy_uptime_seconds counter');
        lines.push(`glm_proxy_uptime_seconds ${Math.floor(stats.uptime || 0)}`);
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

        // Month 1 metrics (shared helper — single source of truth with stats-controller.js)
        const routingStatsForMonth1 = this.modelRouter ? this.modelRouter.getStats() : null;
        appendMonth1Metrics(lines, stats, routingStatsForMonth1);

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
        lines.push(`glm_proxy_paused ${this.isPaused ? 1 : 0}`);
        lines.push('');

        // Tenant metrics (if multi-tenant enabled)
        if (this.tenantManager) {
            const tenantStats = this.tenantManager.getAllTenantStats();

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
        if (this.modelRouter) {
            const routingStats = this.modelRouter.getStats();

            lines.push('# HELP glm_proxy_model_routing_enabled Whether model routing is enabled');
            lines.push('# TYPE glm_proxy_model_routing_enabled gauge');
            lines.push(`glm_proxy_model_routing_enabled ${this.modelRouter.enabled ? 1 : 0}`);
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

            lines.push('# HELP glm_proxy_model_routing_failovers_total Total failover events');
            lines.push('# TYPE glm_proxy_model_routing_failovers_total counter');
            lines.push(`glm_proxy_model_routing_failovers_total ${routingStats.bySource.failover || 0}`);
            lines.push('');

            lines.push('# HELP glm_proxy_model_routing_failovers_warmup_total Failovers during cold-start warmup (first 60s)');
            lines.push('# TYPE glm_proxy_model_routing_failovers_warmup_total counter');
            lines.push(`glm_proxy_model_routing_failovers_warmup_total ${routingStats.failoverWarmupTotal || 0}`);
            lines.push('');

            lines.push('# HELP glm_proxy_model_routing_warming_up Whether the router is still in cold-start warmup');
            lines.push('# TYPE glm_proxy_model_routing_warming_up gauge');
            lines.push(`glm_proxy_model_routing_warming_up ${routingStats.isWarmingUp ? 1 : 0}`);
            lines.push('');

            lines.push('# HELP glm_proxy_model_routing_switches_total Total model switches across all requests');
            lines.push('# TYPE glm_proxy_model_routing_switches_total counter');
            lines.push(`glm_proxy_model_routing_switches_total ${routingStats.bySource.failover || 0}`);
            lines.push('');

            const cooldowns = this.modelRouter.getCooldowns();
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

            const overrideCount = Object.keys(this.modelRouter.getOverrides()).length;
            lines.push('# HELP glm_proxy_model_routing_overrides_active Number of active routing overrides');
            lines.push('# TYPE glm_proxy_model_routing_overrides_active gauge');
            lines.push(`glm_proxy_model_routing_overrides_active ${overrideCount}`);
            lines.push('');

            // Tier downgrade counters handled by appendMonth1Metrics above
        }

        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
        res.end(lines.join('\n'));
    }

    /**
     * Handle /persistent-stats endpoint
     */
    _handlePersistentStats(req, res) {
        const configuredKeyIds = this.config.apiKeys.map(k => KeyManager.getKeyId(k));
        const response = this.statsAggregator.getPersistentStatsResponse(configuredKeyIds);

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response, null, 2));
    }

    /**
     * Handle /reload endpoint
     */
    _handleReload(req, res) {
        if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed, use POST' }));
            return;
        }

        const result = this._reloadKeys();
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
     */
    _handleBackpressure(req, res) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(this.requestHandler.getBackpressureStats()));
    }

    /**
     * Handle /logs endpoint
     */
    _handleLogs(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const limitParam = url.searchParams?.get('limit') || '100';
        const limit = Math.min(parseInt(limitParam, 10) || 100, 500);
        const logs = this.logger.getLogs(limit);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            count: logs.length,
            logs: logs
        }));
    }

    /**
     * Handle /audit-log endpoint - view security audit log
     * Requires admin auth in all modes (always sensitive)
     */
    _handleAuditLog(req, res) {
        // Always require auth for audit log
        if (this.adminAuth?.enabled) {
            const authResult = this.adminAuth.authenticate(req);
            if (!authResult.authenticated) {
                this._sendError(res, 401, authResult.error);
                return;
            }
        }

        const url = new URL(req.url, `http://${req.headers.host}`);
        const limitParam = url.searchParams?.get('limit') || '100';
        const limit = Math.min(parseInt(limitParam, 10) || 100, 1000);

        // Return most recent entries first
        const entries = this._auditLog.toArray().slice(-limit).reverse();

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            count: entries.length,
            total: this._auditLog.size,
            entries
        }, null, 2));
    }

    /**
     * Handle /control/clear-logs endpoint
     */
    _handleClearLogs(req, res) {
        if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed, use POST' }));
            return;
        }
        this.logger.clearLogs();
        this.logger.info('Logs cleared');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'logs_cleared' }));
    }

    /**
     * Handle /history endpoint
     */
    _handleHistory(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const minutesParam = url.searchParams?.get('minutes') || '15';
        const minutes = Math.min(parseInt(minutesParam, 10) || 15, 10080); // 7 days max
        const history = this.historyTracker.getHistory(minutes);
        res.writeHead(200, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            'pragma': 'no-cache',
            'expires': '0'
        });
        res.end(JSON.stringify(history));
    }

    /**
     * Handle /dashboard endpoint
     */
    _handleDashboard(req, res) {
        // Check if CSP is enabled (can be disabled with GLM_DASHBOARD_CSP=0 for rollback)
        const cspEnabled = process.env.GLM_DASHBOARD_CSP !== '0';
        if (!cspEnabled) {
            this.logger.warn('Content-Security-Policy disabled via GLM_DASHBOARD_CSP=0');
        }

        // Generate a nonce for inline scripts when CSP is enabled
        const crypto = require('crypto');
        const nonce = cspEnabled ? crypto.randomBytes(16).toString('base64') : '';

        // Generate dashboard HTML with nonce
        const html = generateDashboard({ nonce, cspEnabled });

        // Security headers (merge configurable + defaults)
        const securityHeaders = this._getSecurityHeaders();
        const headers = {
            'content-type': 'text/html; charset=utf-8',
            'cross-origin-resource-policy': 'same-origin',
            // Configurable security headers
            'x-content-type-options': securityHeaders['x-content-type-options'],
            'referrer-policy': securityHeaders['referrer-policy'],
            'x-frame-options': securityHeaders['x-frame-options'],
            'permissions-policy': securityHeaders['permissions-policy'],
            'x-xss-protection': securityHeaders['x-xss-protection']
        };

        // Add CSP headers when enabled (with nonce for inline scripts)
        if (cspEnabled) {
            headers['content-security-policy'] = [
                "default-src 'self'",
                `script-src 'self' 'nonce-${nonce}' https://cdn.jsdelivr.net`,
                "style-src 'self' 'unsafe-inline'",
                "connect-src 'self'",
                "base-uri 'none'",
                "object-src 'none'",
                "frame-ancestors 'none'"
            ].join('; ');
        }

        res.writeHead(200, headers);
        res.end(html);
    }

    /**
     * Serve static dashboard assets (CSS, JS) from public/ directory.
     * Whitelist-only to prevent path traversal. In-memory cache with mtime check.
     */
    _handleDashboardAsset(req, res, url) {
        const ASSET_WHITELIST = {
            '/dashboard/dashboard.css': { file: 'dashboard.css', contentType: 'text/css; charset=utf-8' },
            // Phase 5: Modular CSS files (split from dashboard.css)
            '/dashboard/css/tokens.css': { file: 'css/tokens.css', contentType: 'text/css; charset=utf-8' },
            '/dashboard/css/layout.css': { file: 'css/layout.css', contentType: 'text/css; charset=utf-8' },
            '/dashboard/css/components.css': { file: 'css/components.css', contentType: 'text/css; charset=utf-8' },
            '/dashboard/css/health.css': { file: 'css/health.css', contentType: 'text/css; charset=utf-8' },
            '/dashboard/css/requests.css': { file: 'css/requests.css', contentType: 'text/css; charset=utf-8' },
            '/dashboard/css/routing.css': { file: 'css/routing.css', contentType: 'text/css; charset=utf-8' },
            '/dashboard/css/charts.css': { file: 'css/charts.css', contentType: 'text/css; charset=utf-8' },
            '/dashboard/css/utilities.css': { file: 'css/utilities.css', contentType: 'text/css; charset=utf-8' },
            '/dashboard/dashboard.js': { file: 'dashboard.js', contentType: 'application/javascript; charset=utf-8' },
            '/dashboard/dashboard-utils.js': { file: 'dashboard-utils.js', contentType: 'application/javascript; charset=utf-8' },
            // Phase 6: Modular JS files (split from dashboard.js)
            '/dashboard/js/store.js': { file: 'js/store.js', contentType: 'application/javascript; charset=utf-8' },
            '/dashboard/js/sse.js': { file: 'js/sse.js', contentType: 'application/javascript; charset=utf-8' },
            '/dashboard/js/filters.js': { file: 'js/filters.js', contentType: 'application/javascript; charset=utf-8' },
            '/dashboard/js/context-menu.js': { file: 'js/context-menu.js', contentType: 'application/javascript; charset=utf-8' },
            '/dashboard/js/progressive-disclosure.js': { file: 'js/progressive-disclosure.js', contentType: 'application/javascript; charset=utf-8' },
            '/dashboard/js/anomaly.js': { file: 'js/anomaly.js', contentType: 'application/javascript; charset=utf-8' },
            '/dashboard/js/error-boundary.js': { file: 'js/error-boundary.js', contentType: 'application/javascript; charset=utf-8' },
            '/dashboard/js/live-flow.js': { file: 'js/live-flow.js', contentType: 'application/javascript; charset=utf-8' },
            '/dashboard/js/tier-builder.js': { file: 'js/tier-builder.js', contentType: 'application/javascript; charset=utf-8' },
            '/dashboard/js/dom-cache.js': { file: 'js/dom-cache.js', contentType: 'application/javascript; charset=utf-8' },
            '/dashboard/js/traces.js': { file: 'js/traces.js', contentType: 'application/javascript; charset=utf-8' },
            '/dashboard/js/actions.js': { file: 'js/actions.js', contentType: 'application/javascript; charset=utf-8' },
            '/dashboard/js/polling.js': { file: 'js/polling.js', contentType: 'application/javascript; charset=utf-8' },
            '/dashboard/js/data.js': { file: 'js/data.js', contentType: 'application/javascript; charset=utf-8' },
            '/dashboard/js/init.js': { file: 'js/init.js', contentType: 'application/javascript; charset=utf-8' },
            // TRUST-03: Routing dashboard assets
            '/dashboard/routing.html': { file: 'dashboard/routing.html', contentType: 'text/html; charset=utf-8' },
            '/dashboard/routing.js': { file: 'dashboard/routing.js', contentType: 'application/javascript; charset=utf-8' },
            '/dashboard/css/routing-standalone.css': { file: 'css/routing.css', contentType: 'text/css; charset=utf-8' },
            // CDN fallback vendor files
            '/dashboard/vendor/chart.js.min.js': { file: 'dashboard/vendor/chart.js.min.js', contentType: 'application/javascript; charset=utf-8' },
            '/dashboard/vendor/d3.min.js': { file: 'dashboard/vendor/d3.min.js', contentType: 'application/javascript; charset=utf-8' },
            '/dashboard/vendor/sortable.min.js': { file: 'dashboard/vendor/sortable.min.js', contentType: 'application/javascript; charset=utf-8' }
        };

        const asset = ASSET_WHITELIST[url];
        if (!asset) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'not_found' }));
            return;
        }

        const filePath = path.join(__dirname, '..', 'public', asset.file);

        try {
            // Check mtime for cache invalidation
            const stat = fs.statSync(filePath);
            const mtime = stat.mtimeMs;

            if (!this._dashboardAssetCache) {
                this._dashboardAssetCache = new Map();
            }

            const cached = this._dashboardAssetCache.get(asset.file);
            if (cached && cached.mtime === mtime) {
                // Serve from cache
                res.writeHead(200, {
                    'content-type': asset.contentType,
                    'x-content-type-options': 'nosniff',
                    'cache-control': 'public, max-age=3600',
                    'cross-origin-resource-policy': 'same-origin'
                });
                res.end(cached.content);
                return;
            }

            // Read and cache
            const content = fs.readFileSync(filePath, 'utf8');
            this._dashboardAssetCache.set(asset.file, { content, mtime });

            res.writeHead(200, {
                'content-type': asset.contentType,
                'x-content-type-options': 'nosniff',
                'cache-control': 'public, max-age=3600',
                'cross-origin-resource-policy': 'same-origin'
            });
            res.end(content);
        } catch (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'not_found', message: 'Dashboard asset not found' }));
            } else {
                res.writeHead(500, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'internal_error' }));
            }
        }
    }

    // ========== SECURITY METHODS (Milestone F) ==========

    /**
     * Extract client IP from request, respecting trusted proxy configuration.
     * Uses right-to-left XFF walk with trusted proxy stripping.
     */
    _getClientIp(req) {
        const trustedProxies = this.config.security?.trustedProxies || ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
        return getClientIp(req, trustedProxies);
    }

    /**
     * Send a JSON response with standard headers.
     * @param {http.ServerResponse} res
     * @param {number} status - HTTP status code
     * @param {*} data - Data to serialize as JSON
     */
    _sendJson(res, status, data) {
        if (res.headersSent) return;
        res.writeHead(status, {
            'content-type': 'application/json',
            'cache-control': 'no-store'
        });
        res.end(JSON.stringify(data, null, 2));
    }

    /**
     * Send a JSON error response with standard headers.
     * @param {http.ServerResponse} res
     * @param {number} status - HTTP status code
     * @param {string} message - Error message
     */
    _sendError(res, status, message) {
        this._sendJson(res, status, { error: message });
    }

    /**
     * Check rate limit for an IP and endpoint type
     * @param {string} ip - Client IP
     * @param {string} type - 'dashboard' | 'api' | 'sse'
     * @returns {boolean} true if allowed, false if rate limited
     */
    _checkRateLimit(ip, type = 'api') {
        const security = this.config.security || {};
        const rateLimit = security.rateLimit || {};

        if (!rateLimit.enabled) return true;

        // Debug endpoints have separate, stricter rate limits
        const debugRateLimit = security.debugRateLimit || {};
        const limits = {
            dashboard: rateLimit.dashboardRpm || 60,
            api: rateLimit.apiRpm || 120,
            sse: rateLimit.maxSsePerIp || 5,
            debug: debugRateLimit.rpm || 30  // Stricter limit for debug endpoints
        };

        const limit = limits[type] || 60;
        const now = Date.now();
        const windowMs = 60000; // 1 minute window

        const key = `${ip}:${type}`;
        let entry = this._rateLimitMap.get(key);

        if (!entry || entry.resetTime < now) {
            entry = { count: 0, resetTime: now + windowMs };
            this._rateLimitMap.set(key, entry);
        }

        entry.count++;

        if (entry.count > limit) {
            this._addAuditEntry('rate_limit_exceeded', { ip, type, count: entry.count, limit });
            return false;
        }

        return true;
    }

    /**
     * Check if SSE connection is allowed (per-IP and total limits)
     * @param {string} ip - Client IP
     * @returns {{ allowed: boolean, reason?: string }}
     */
    _checkSseLimit(ip) {
        const security = this.config.security || {};
        const rateLimit = security.rateLimit || {};

        if (!rateLimit.enabled) return { allowed: true };

        const maxPerIp = rateLimit.maxSsePerIp || 5;
        const maxTotal = rateLimit.maxSseTotal || 100;

        const totalSseClients = this.sseStreamClients.size + this.sseEventClients.size;

        // Check total limit
        if (totalSseClients >= maxTotal) {
            this._addAuditEntry('sse_total_limit', { ip, total: totalSseClients, max: maxTotal });
            return { allowed: false, reason: 'Max SSE connections reached' };
        }

        // Check per-IP limit
        const ipConnections = this._ssePerIp.get(ip) || new Set();
        if (ipConnections.size >= maxPerIp) {
            this._addAuditEntry('sse_ip_limit', { ip, count: ipConnections.size, max: maxPerIp });
            return { allowed: false, reason: 'Max SSE connections per IP reached' };
        }

        return { allowed: true };
    }

    /**
     * Track SSE connection for an IP
     */
    _trackSseConnection(ip, clientId) {
        if (!this._ssePerIp.has(ip)) {
            this._ssePerIp.set(ip, new Set());
        }
        this._ssePerIp.get(ip).add(clientId);
    }

    /**
     * Untrack SSE connection for an IP
     */
    _untrackSseConnection(ip, clientId) {
        const connections = this._ssePerIp.get(ip);
        if (connections) {
            connections.delete(clientId);
            if (connections.size === 0) {
                this._ssePerIp.delete(ip);
            }
        }
    }

    /**
     * Add entry to audit log
     */
    _addAuditEntry(event, details = {}) {
        const security = this.config.security || {};
        const auditConfig = security.auditLog || {};

        if (!auditConfig.enabled) return;

        const entry = {
            timestamp: new Date().toISOString(),
            event,
            ...details
        };

        this._auditLog.push(entry); // RingBuffer auto-evicts oldest when at capacity

        // Buffer entry for async file write if configured
        if (auditConfig.filePath) {
            this._auditFileBuffer.push(entry);

            // Flush immediately if buffer exceeds threshold (50 entries)
            if (this._auditFileBuffer.length >= 50) {
                this._flushAuditBuffer();
            }
        }
    }

    /**
     * Flush buffered audit entries to file asynchronously
     */
    async _flushAuditBuffer() {
        // Skip if already flushing or buffer is empty
        if (this._auditFlushing || this._auditFileBuffer.length === 0) {
            return;
        }

        const security = this.config.security || {};
        const auditConfig = security.auditLog || {};

        if (!auditConfig.filePath) return;

        this._auditFlushing = true;

        // Grab current buffer and reset
        const entriesToWrite = this._auditFileBuffer;
        this._auditFileBuffer = [];

        try {
            const fs = require('fs').promises;
            const content = entriesToWrite.map(e => JSON.stringify(e)).join('\n') + '\n';
            await fs.appendFile(auditConfig.filePath, content);
        } catch (e) {
            this.logger.error('Failed to flush audit log buffer', {
                error: e.message,
                entriesLost: entriesToWrite.length
            });
        } finally {
            this._auditFlushing = false;
        }
    }

    /**
     * Get security headers for dashboard responses
     */
    _getSecurityHeaders() {
        const security = this.config.security || {};
        const headers = security.headers || {};

        return {
            'content-security-policy': headers.csp || "default-src 'self'",
            'permissions-policy': headers.permissionsPolicy || 'camera=(), microphone=(), geolocation=()',
            'x-frame-options': headers.xFrameOptions || 'DENY',
            'x-content-type-options': headers.xContentTypeOptions || 'nosniff',
            'referrer-policy': headers.referrerPolicy || 'strict-origin-when-cross-origin',
            'x-xss-protection': '1; mode=block'
        };
    }

    /**
     * Check if endpoint requires auth in internet mode
     * @param {string} path - Request path
     * @returns {boolean}
     */
    _requiresAuthInInternetMode(path) {
        const security = this.config.security || {};
        if (security.mode !== 'internet') return false;

        const protectedReads = security.internetModeProtectedReads || [];
        return protectedReads.some(p => path.startsWith(p));
    }

    /**
     * Check if endpoint is a debug endpoint (always requires auth)
     * Debug endpoints expose internal state that could aid attacks
     * @param {string} path - Request path
     * @returns {boolean}
     */
    _isDebugEndpoint(path) {
        const security = this.config.security || {};
        const debugEndpoints = security.debugEndpoints || ['/debug/', '/health/deep', '/traces'];
        return debugEndpoints.some(endpoint => {
            if (endpoint.endsWith('/')) {
                return path.startsWith(endpoint);
            }
            return path === endpoint || path.startsWith(endpoint + '/') || path.startsWith(endpoint + '?');
        });
    }

    /**
     * Check if debug endpoints require auth (configurable, default true)
     * @returns {boolean}
     */
    _debugEndpointsRequireAuth() {
        const security = this.config.security || {};
        // Default to true - debug endpoints should require auth by default
        return security.debugEndpointsAlwaysRequireAuth !== false;
    }

    /**
     * Get CORS headers based on security config and request origin
     * @param {http.IncomingMessage} req - The request
     * @returns {Object} Headers object with CORS headers (empty if same-origin)
     */
    _getCorsHeaders(req) {
        const corsConfig = this.config.security?.cors || {};
        const allowedOrigins = corsConfig.allowedOrigins || [];

        // No allowed origins = same-origin only (no CORS headers)
        if (!allowedOrigins.length) {
            return {};
        }

        const requestOrigin = req.headers.origin;

        // Wildcard allows all origins
        if (allowedOrigins.includes('*')) {
            return { 'access-control-allow-origin': '*' };
        }

        // Check if request origin is in allowed list
        if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
            return {
                'access-control-allow-origin': requestOrigin,
                'vary': 'Origin'
            };
        }

        // Origin not allowed - no CORS headers
        return {};
    }

    /**
     * Handle /requests/stream SSE endpoint (PHASE 2 - Task #10)
     * Server-Sent Events for live request monitoring
     */
    _handleRequestStream(req, res) {
        const ip = this._getClientIp(req);

        // Check SSE connection limits
        const sseCheck = this._checkSseLimit(ip);
        if (!sseCheck.allowed) {
            res.writeHead(429, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: sseCheck.reason }));
            return;
        }

        // Set headers for SSE (CORS based on config)
        const corsHeaders = this._getCorsHeaders(req);
        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
            ...corsHeaders
        });

        // Send initial message with recent requests
        const recentRequests = this.requestHandler.getRecentRequests(50);
        res.write(`data: ${JSON.stringify({ type: 'init', requests: recentRequests })}\n\n`);

        // Add client to SSE clients set and track per-IP
        const clientId = Date.now() + '-' + Math.random().toString(36).slice(2);
        const client = { id: clientId, res, ip };
        this.sseStreamClients.add(client);
        this._trackSseConnection(ip, clientId);

        // Start pool-status broadcast when first client connects
        if (this.sseStreamClients.size === 1) {
            this._startPoolStatusBroadcast();
        }

        // Send keepalive comments every 30 seconds
        const keepaliveTimer = setInterval(() => {
            try {
                res.write(': keepalive\n\n');
            } catch (e) {
                clearInterval(keepaliveTimer);
                client.keepaliveTimer = null;
                this.sseStreamClients.delete(client);
                this._untrackSseConnection(ip, clientId);
                // Stop pool-status broadcast when last client disconnects
                if (this.sseStreamClients.size === 0) {
                    this._stopPoolStatusBroadcast();
                }
            }
        }, 30000);
        keepaliveTimer.unref(); // Don't prevent process exit during shutdown
        client.keepaliveTimer = keepaliveTimer; // Track for explicit cleanup

        // Clean up on disconnect
        req.on('close', () => {
            if (client.keepaliveTimer) {
                clearInterval(client.keepaliveTimer);
                client.keepaliveTimer = null;
            }
            this.sseStreamClients.delete(client);
            this._untrackSseConnection(ip, clientId);
            // Stop pool-status broadcast when last client disconnects
            if (this.sseStreamClients.size === 0) {
                this._stopPoolStatusBroadcast();
            }
        });

        this.logger.info('SSE client connected', { ip, clientId, total: this.sseStreamClients.size + this.sseEventClients.size });
    }

    /**
     * Broadcast request to all SSE clients
     */
    _broadcastRequest(request) {
        // /requests/stream: typed SSE events (routing dashboard listens for 'request-complete')
        const streamData = `event: request-complete\ndata: ${JSON.stringify(request)}\n\n`;
        for (const client of this.sseStreamClients) {
            try {
                if (client.res.writableEnded) continue;
                client.res.write(streamData);
            } catch (e) {
                // Client disconnected, will be cleaned up by keepalive check
            }
        }

        // /events: typed SSE events (used by E2E + dashboards)
        if (this.sseEventClients.size > 0) {
            const ts = Date.now();
            for (const client of this.sseEventClients) {
                try {
                    if (client.res.writableEnded) continue;
                    const event = {
                        seq: typeof client.seq === 'function' ? client.seq() : undefined,
                        ts,
                        schemaVersion: 1,
                        type: 'request',
                        ...request
                    };
                    client.res.write(`event: request\ndata: ${JSON.stringify(event)}\n\n`);
                } catch (e) {
                    // Client disconnected, will be cleaned up by keepalive check
                }
            }
        }
    }

    /**
     * Start broadcasting pool-status SSE events every 3 seconds.
     * Called when the first SSE stream client connects.
     * @private
     */
    _startPoolStatusBroadcast() {
        if (this._poolStatusInterval) return; // Already running

        this._poolStatusInterval = setInterval(async () => {
            if (this.sseStreamClients.size === 0) {
                this._stopPoolStatusBroadcast();
                return;
            }
            if (!this.modelRouter) return;

            try {
                const snapshot = await this.modelRouter.getModelPoolSnapshot();
                const event = {
                    seq: ++this._poolStatusSeq,
                    ts: Date.now(),
                    schemaVersion: 1,
                    type: 'pool-status',
                    pools: snapshot.pools
                };
                const ssePayload = `event: pool-status\ndata: ${JSON.stringify(event)}\n\n`;

                for (const client of this.sseStreamClients) {
                    try {
                        if (client.res.writableEnded) continue;
                        client.res.write(ssePayload);
                    } catch (_e) {
                        // Client disconnected, cleanup handled by keepalive/close
                    }
                }
            } catch (err) {
                this.logger.warn('Failed to broadcast pool-status', { error: err.message });
            }
        }, 3000);

        // Allow process to exit even if interval is active
        if (this._poolStatusInterval.unref) {
            this._poolStatusInterval.unref();
        }
    }

    /**
     * Stop the pool-status broadcast interval.
     * Called when the last SSE stream client disconnects or on shutdown.
     * @private
     */
    _stopPoolStatusBroadcast() {
        if (this._poolStatusInterval) {
            clearInterval(this._poolStatusInterval);
            this._poolStatusInterval = null;
        }
    }

    /**
     * Handle /events SSE endpoint for dashboard
     * Sends proper SSE events with event types for E2E testing
     */
    _handleEventsSSE(req, res) {
        const ip = this._getClientIp(req);

        // Check SSE connection limits
        const sseCheck = this._checkSseLimit(ip);
        if (!sseCheck.allowed) {
            res.writeHead(429, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: sseCheck.reason }));
            return;
        }

        // Set headers for SSE
        const corsHeaders = this._getCorsHeaders(req);
        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
            ...corsHeaders
        });

        // Generate client ID and sequence counter
        const clientId = Date.now() + '-' + Math.random().toString(36).slice(2);
        let seq = 1;

        // Send initial connected event with proper SSE event type
        const recentRequests = this.requestHandler ? this.requestHandler.getRecentRequests(50) : [];
        const connectedEvent = {
            seq: seq++,
            ts: Date.now(),
            schemaVersion: 1,
            type: 'connected',
            clientId: clientId,
            recentRequests: recentRequests
        };
        res.write(`event: connected\ndata: ${JSON.stringify(connectedEvent)}\n\n`);

        // Add client to SSE clients set
        const client = { id: clientId, res, ip, seq: () => seq++ };
        this.sseEventClients.add(client);
        this._trackSseConnection(ip, clientId);

        // Send keepalive comments every 30 seconds
        const keepaliveTimer = setInterval(() => {
            try {
                res.write(': keepalive\n\n');
            } catch (e) {
                clearInterval(keepaliveTimer);
                this.sseEventClients.delete(client);
                this._untrackSseConnection(ip, clientId);
            }
        }, 30000);

        // Clean up on disconnect
        req.on('close', () => {
            clearInterval(keepaliveTimer);
            this.sseEventClients.delete(client);
            this._untrackSseConnection(ip, clientId);
        });

        this.logger.info('SSE client connected', { ip, clientId, total: this.sseStreamClients.size + this.sseEventClients.size });
    }

    /**
     * Handle GET/POST /cost-tracking/config endpoint
     * GET: Returns current cost tracking configuration
     * POST: Updates cost tracking configuration (rates, budgets, debounce)
     */
    async _handleCostTrackingConfig(req, res) {
        try {
            if (!this.costTracker) {
                this._sendError(res, 503, 'Cost tracking not enabled');
                return;
            }

            if (req.method === 'GET') {
                // Return current configuration
                const config = {
                    rates: this.costTracker.rates,
                    modelRates: this.costTracker.modelRates,
                    budget: this.costTracker.budget,
                    saveDebounceMs: this.costTracker.saveDebounceMs,
                    persistPath: this.costTracker.persistPath
                };
                this._sendJson(res, 200, config);
            } else if (req.method === 'POST') {
                // Update configuration
                let body = '';
                for await (const chunk of req) {
                    body += chunk.toString();
                }

                let updates;
                try {
                    updates = JSON.parse(body);
                } catch (err) {
                    this._sendError(res, 400, 'Invalid JSON body');
                    return;
                }

                // Validate and update rates
                if (updates.rates) {
                    if (typeof updates.rates !== 'object' || updates.rates === null) {
                        this._sendError(res, 400, 'rates must be an object');
                        return;
                    }
                    if (updates.rates.inputTokenPer1M !== undefined) {
                        if (typeof updates.rates.inputTokenPer1M !== 'number' || updates.rates.inputTokenPer1M < 0) {
                            this._sendError(res, 400, 'inputTokenPer1M must be a non-negative number');
                            return;
                        }
                    }
                    if (updates.rates.outputTokenPer1M !== undefined) {
                        if (typeof updates.rates.outputTokenPer1M !== 'number' || updates.rates.outputTokenPer1M < 0) {
                            this._sendError(res, 400, 'outputTokenPer1M must be a non-negative number');
                            return;
                        }
                    }
                    this.costTracker.setRates(updates.rates);
                }

                // Validate and update model rates
                if (updates.modelRates) {
                    if (typeof updates.modelRates !== 'object' || updates.modelRates === null) {
                        this._sendError(res, 400, 'modelRates must be an object');
                        return;
                    }
                    for (const [model, rates] of Object.entries(updates.modelRates)) {
                        if (typeof rates !== 'object' || rates === null) {
                            this._sendError(res, 400, `modelRates.${model} must be an object`);
                            return;
                        }
                        if (rates.inputTokenPer1M !== undefined) {
                            if (typeof rates.inputTokenPer1M !== 'number' || rates.inputTokenPer1M < 0) {
                                this._sendError(res, 400, `modelRates.${model}.inputTokenPer1M must be a non-negative number`);
                                return;
                            }
                        }
                        if (rates.outputTokenPer1M !== undefined) {
                            if (typeof rates.outputTokenPer1M !== 'number' || rates.outputTokenPer1M < 0) {
                                this._sendError(res, 400, `modelRates.${model}.outputTokenPer1M must be a non-negative number`);
                                return;
                            }
                        }
                    }
                    Object.assign(this.costTracker.modelRates, updates.modelRates);
                }

                // Validate and update budget
                if (updates.budget) {
                    if (typeof updates.budget !== 'object' || updates.budget === null) {
                        this._sendError(res, 400, 'budget must be an object');
                        return;
                    }
                    if (updates.budget.daily !== undefined) {
                        if (typeof updates.budget.daily !== 'number' || updates.budget.daily < 0) {
                            this._sendError(res, 400, 'budget.daily must be a non-negative number');
                            return;
                        }
                    }
                    if (updates.budget.monthly !== undefined) {
                        if (typeof updates.budget.monthly !== 'number' || updates.budget.monthly < 0) {
                            this._sendError(res, 400, 'budget.monthly must be a non-negative number');
                            return;
                        }
                    }
                    if (updates.budget.alertThresholds !== undefined) {
                        if (!Array.isArray(updates.budget.alertThresholds)) {
                            this._sendError(res, 400, 'budget.alertThresholds must be an array');
                            return;
                        }
                        for (const threshold of updates.budget.alertThresholds) {
                            if (typeof threshold !== 'number' || threshold < 0 || threshold > 1) {
                                this._sendError(res, 400, 'budget.alertThresholds must be numbers between 0 and 1');
                                return;
                            }
                        }
                    }
                    this.costTracker.setBudget(updates.budget);
                }

                // Validate and update saveDebounceMs
                if (updates.saveDebounceMs !== undefined) {
                    if (typeof updates.saveDebounceMs !== 'number' || updates.saveDebounceMs < 0) {
                        this._sendError(res, 400, 'saveDebounceMs must be a non-negative number');
                        return;
                    }
                    this.costTracker.saveDebounceMs = updates.saveDebounceMs;
                }

                // Return updated configuration
                const newConfig = {
                    rates: this.costTracker.rates,
                    modelRates: this.costTracker.modelRates,
                    budget: this.costTracker.budget,
                    saveDebounceMs: this.costTracker.saveDebounceMs,
                    persistPath: this.costTracker.persistPath
                };

                this._sendJson(res, 200, newConfig);
                this.logger.info('Cost tracking config updated', { updates });
            } else {
                this._sendError(res, 405, 'Method not allowed');
            }
        } catch (err) {
            this.logger.error(`Error handling cost-tracking/config: ${err.message}`, { stack: err.stack });
            this._sendError(res, 500, 'Internal server error');
        }
    }

    /**
     * Handle GET /cost-tracking/metrics endpoint
     * Returns detailed metrics about cost tracking operations
     */
    _handleCostTrackingMetrics(req, res) {
        try {
            if (!this.costTracker) {
                this._sendError(res, 503, 'Cost tracking not enabled');
                return;
            }

            const metrics = this.costTracker.getMetrics();
            const fullReport = this.costTracker.getFullReport();

            const response = {
                metrics,
                summary: {
                    periods: fullReport.periods,
                    projection: fullReport.projection,
                    totalKeys: Object.keys(fullReport.byKey).length,
                    totalTenants: Object.keys(fullReport.tenantCosts).length
                }
            };

            this._sendJson(res, 200, response);
        } catch (err) {
            this.logger.error(`Error handling cost-tracking/metrics: ${err.message}`, { stack: err.stack });
            this._sendError(res, 500, 'Internal server error');
        }
    }

    /**
     * Handle POST /cost-tracking/flush endpoint
     * Forces immediate save of cost tracking data
     */
    async _handleCostTrackingFlush(req, res) {
        try {
            if (!this.costTracker) {
                this._sendError(res, 503, 'Cost tracking not enabled');
                return;
            }

            await this.costTracker.flush();

            this._sendJson(res, 200, {
                success: true,
                message: 'Cost tracking data flushed successfully',
                timestamp: new Date().toISOString()
            });

            this.logger.info('Cost tracking data flushed via API');
        } catch (err) {
            this.logger.error(`Error handling cost-tracking/flush: ${err.message}`, { stack: err.stack });
            this._sendError(res, 500, 'Internal server error');
        }
    }

    /**
     * Handle POST /cost-tracking/reset endpoint
     * Resets all cost tracking data
     */
    _handleCostTrackingReset(req, res) {
        try {
            if (!this.costTracker) {
                this._sendError(res, 503, 'Cost tracking not enabled');
                return;
            }

            this.costTracker.reset();

            this._sendJson(res, 200, {
                success: true,
                message: 'Cost tracking data reset successfully',
                timestamp: new Date().toISOString()
            });

            this.logger.info('Cost tracking data reset via API');
        } catch (err) {
            this.logger.error(`Error handling cost-tracking/reset: ${err.message}`, { stack: err.stack });
            this._sendError(res, 500, 'Internal server error');
        }
    }

    /**
     * Handle /circuit-history endpoint (PHASE 2 - Task #6)
     * Returns circuit breaker state transition history
     */
    _handleCircuitHistory(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const minutesParam = url.searchParams?.get('minutes') || '60';
        const keyIndexParam = url.searchParams?.get('keyIndex');

        const minutes = Math.min(parseInt(minutesParam, 10) || 60, 1440); // Max 24 hours
        let keyIndex = null;
        if (keyIndexParam) {
            keyIndex = parseInt(keyIndexParam, 10);
            if (isNaN(keyIndex) || keyIndex < 0 || keyIndex >= this.keyManager.keys.length) {
                this._sendError(res, 400, 'Invalid key index');
                return;
            }
        }

        const transitions = this.historyTracker.getCircuitTransitions(minutes);
        const timeline = this.historyTracker.getCircuitTimeline(keyIndex, minutes);

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            minutes,
            totalTransitions: transitions.count,
            transitions: transitions.transitions,
            timeline: timeline,
            currentStates: this.historyTracker.getCurrentCircuitStates(this.keyManager.getStats())
        }, null, 2));
    }

    // ========== NEW FEATURE ENDPOINTS (#3-#10) ==========

    /**
     * Handle /stats/latency-histogram endpoint (#4)
     */
    _handleLatencyHistogram(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const timeRange = url.searchParams?.get('range') || '15m';

        const histogram = this.keyManager.getLatencyHistogram(timeRange);

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(histogram, null, 2));
    }

    /**
     * Handle /stats/latency-histogram/:keyIndex endpoint (#4)
     */
    _handleKeyLatencyHistogram(req, res, pathname) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const match = pathname.match(/^\/stats\/latency-histogram\/(\d+)$/);

        if (!match) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid key index' }));
            return;
        }

        const keyIndex = parseInt(match[1], 10);
        if (isNaN(keyIndex) || keyIndex < 0 || keyIndex >= this.keyManager.keys.length) {
            this._sendError(res, 400, 'Invalid key index');
            return;
        }
        const timeRange = url.searchParams?.get('range') || '15m';

        const histogram = this.keyManager.getKeyLatencyHistogram(keyIndex, timeRange);

        if (!histogram) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Key not found' }));
            return;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(histogram, null, 2));
    }

    /**
     * Handle /stats/cost endpoint (#6)
     */
    _handleCostStats(req, res) {
        if (!this.costTracker) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Cost tracking not enabled' }));
            return;
        }

        const url = new URL(req.url, `http://${req.headers.host}`);
        const period = url.searchParams?.get('period') || 'today';

        const stats = this.costTracker.getStats(period);
        const projection = this.costTracker.getProjection();
        const costTimeSeries = this.costTracker.getCostTimeSeries();

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...stats, projection, costTimeSeries }, null, 2));
    }

    /**
     * Handle /stats/cost/history endpoint (#6)
     */
    _handleCostHistory(req, res) {
        if (!this.costTracker) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Cost tracking not enabled' }));
            return;
        }

        const url = new URL(req.url, `http://${req.headers.host}`);
        const days = parseInt(url.searchParams?.get('days') || '7', 10) || 7;

        const history = this.costTracker.getHistory(days);
        const fullReport = this.costTracker.getFullReport();

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(fullReport, null, 2));
    }

    /**
     * Handle /stats/scheduler endpoint (Scheduler v2)
     * Returns selection reason distribution, fairness metrics, and pool state
     */
    _handleSchedulerStats(req, res) {
        const schedulerStats = this.keyManager.getSchedulerStats();
        const poolState = this.keyManager.getPoolState();

        const response = {
            poolState,
            scheduler: schedulerStats,
            timestamp: new Date().toISOString()
        };

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response, null, 2));
    }

    /**
     * Handle /traces endpoint (Week 2 - Request Lifecycle Tracing)
     * Query params:
     * - success: filter by success (true/false)
     * - model: filter by model name
     * - hasRetries: filter to only traces with retries (true)
     * - minDuration: filter to traces longer than N ms
     * - since: filter to traces after timestamp
     * - limit: max number of traces to return
     */
    _handleTraces(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);

        // Parse query parameters
        const filter = {};

        const successParam = url.searchParams.get('success');
        if (successParam !== null) {
            filter.success = successParam === 'true';
        }

        const modelParam = url.searchParams.get('model');
        if (modelParam) {
            filter.model = modelParam;
        }

        const hasRetriesParam = url.searchParams.get('hasRetries');
        if (hasRetriesParam === 'true') {
            filter.hasRetries = true;
        }

        const minDurationParam = url.searchParams.get('minDuration');
        if (minDurationParam) {
            const minDuration = parseInt(minDurationParam, 10);
            if (!isNaN(minDuration)) {
                filter.minDuration = minDuration;
            }
        }

        const sinceParam = url.searchParams.get('since');
        if (sinceParam) {
            const since = parseInt(sinceParam, 10);
            if (!isNaN(since)) {
                filter.since = since;
            }
        }

        const limitParam = url.searchParams.get('limit');
        if (limitParam) {
            const limit = parseInt(limitParam, 10);
            if (!isNaN(limit)) {
                filter.limit = limit;
            }
        }

        // Get traces
        const hasFilters = Object.keys(filter).length > 0;
        const traces = hasFilters
            ? this.requestHandler.queryTraces(filter)
            : this.requestHandler.getRecentTraces(filter.limit || 100);

        // Get store stats
        const stats = this.requestHandler.getTraceStats();

        const tracesResponse = {
            traces,
            stats,
            filter: hasFilters ? filter : null,
            timestamp: new Date().toISOString()
        };

        // Redact sensitive data before sending (traces may contain request details)
        const redactedResponse = redactSensitiveData(tracesResponse, {
            redactBodies: true,
            redactHeaders: true,
            bodyPreviewLength: 200
        });

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(redactedResponse, null, 2));
    }

    /**
     * Handle /traces/:traceId endpoint (Week 2)
     * Returns detailed trace for a specific trace or request ID
     */
    _handleTraceById(req, res, pathname) {
        // Extract trace ID from path
        const match = pathname.match(/^\/traces\/([^/?]+)/);
        if (!match) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
            return;
        }

        const traceId = match[1];
        const trace = this.requestHandler.getTrace(traceId);

        if (!trace) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Trace not found',
                traceId,
                timestamp: new Date().toISOString()
            }));
            return;
        }

        const traceResponse = {
            trace: trace.toJSON(),
            timestamp: new Date().toISOString()
        };

        // Redact sensitive data before sending
        const redactedResponse = redactSensitiveData(traceResponse, {
            redactBodies: true,
            redactHeaders: true,
            bodyPreviewLength: 200
        });

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(redactedResponse, null, 2));
    }

    /**
     * Handle /predictions endpoint (#5, enhanced Week 8)
     */
    _handlePredictions(req, res) {
        const keyPredictions = this.keyManager.getStats().map(k => ({
            keyIndex: k.index,
            keyPrefix: k.keyPrefix,
            state: k.circuitBreaker.state,
            prediction: k.prediction
        }));

        // Find any critical predictions
        const criticalKeys = keyPredictions.filter(p =>
            p.prediction.level === 'CRITICAL' || p.prediction.level === 'WARNING'
        );

        // Week 8: Add predictive scaling data
        let scaling = null;
        if (this.predictiveScaler) {
            scaling = {
                predictions: this.predictiveScaler.predict(),
                recommendations: this.predictiveScaler.getRecommendations(),
                trend: this.predictiveScaler.getTrend(),
                patterns: this.predictiveScaler.getPatterns(),
                stats: this.predictiveScaler.getStats(),
                anomalies: this.predictiveScaler.detectAnomalies()
            };
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            keyPredictions,
            summary: {
                healthy: keyPredictions.filter(p => p.prediction.level === 'HEALTHY').length,
                elevated: keyPredictions.filter(p => p.prediction.level === 'ELEVATED').length,
                warning: keyPredictions.filter(p => p.prediction.level === 'WARNING').length,
                critical: keyPredictions.filter(p => p.prediction.level === 'CRITICAL').length
            },
            criticalKeys,
            scaling,
            timestamp: new Date().toISOString()
        }, null, 2));
    }

    /**
     * Record usage data for predictive scaling (Week 8)
     */
    _recordScalerUsage() {
        if (!this.predictiveScaler) return;

        const stats = this.statsAggregator.getFullStats(this.keyManager, this._getUptime());
        const keyStats = this.keyManager.getStats();

        // Calculate aggregate metrics from full stats
        const totalRequests = stats.clientRequests?.total || 0;
        const queueSize = stats.backpressure?.queue?.current || 0;
        const avgLatency = stats.latency?.p50 || 0;

        // Calculate key utilization
        let totalUtilization = 0;
        let activeKeys = 0;
        keyStats.forEach(k => {
            if (k.state !== 'OPEN' && k.state !== 'QUARANTINED') {
                const maxConcurrency = this.config.maxConcurrencyPerKey || 5;
                const utilization = (k.inFlight / maxConcurrency) * 100;
                totalUtilization += utilization;
                activeKeys++;
            }
        });
        const avgUtilization = activeKeys > 0 ? totalUtilization / activeKeys : 0;

        this.predictiveScaler.recordUsage(Date.now(), {
            requests: totalRequests,
            queueSize,
            latency: avgLatency,
            keyUtilization: avgUtilization
        });
    }

    /**
     * Handle /replay-queue endpoint (Week 11)
     */
    async _handleReplayQueue(req, res) {
        if (!this.replayQueue) {
            this._sendError(res, 503, 'Replay queue not enabled');
            return;
        }

        const url = new URL(req.url, `http://${req.headers.host}`);

        // GET - list queued requests
        if (req.method === 'GET') {
            const status = url.searchParams?.get('status');
            const method = url.searchParams?.get('method');
            const filter = {};
            if (status) filter.status = status;
            if (method) filter.method = method;

            const queue = this.replayQueue.getQueue(filter);

            this._sendJson(res, 200, {
                queue,
                stats: this.replayQueue.getStats(),
                timestamp: new Date().toISOString()
            });
            return;
        }

        // POST - replay a request
        if (req.method === 'POST') {
            try {
                const { traceId, dryRun } = await parseJsonBody(req);
                if (!traceId) {
                    this._sendError(res, 400, 'traceId required');
                    return;
                }

                const result = await this.replayQueue.replay(traceId, {
                    dryRun: dryRun === true,
                    sendFunction: dryRun ? undefined : (request) => this._replayRequest(request)
                });

                this._sendJson(res, 200, result);
            } catch (err) {
                this._sendError(res, err.statusCode || 400, err.message);
            }
            return;
        }

        // DELETE - clear queue
        if (req.method === 'DELETE') {
            const count = this.replayQueue.clear();
            this._sendJson(res, 200, { cleared: count });
            return;
        }

        this._sendError(res, 405, 'Method not allowed');
    }

    /**
     * Handle /replay-queue/stats endpoint (Week 11)
     */
    _handleReplayQueueStats(req, res) {
        if (!this.replayQueue) {
            this._sendError(res, 503, 'Replay queue not enabled');
            return;
        }

        this._sendJson(res, 200, this.replayQueue.getStats());
    }

    /**
     * Helper to replay a request through the proxy (used by ReplayQueue)
     * @param {Object} request - { method, path, headers, body }
     * @returns {Promise<Object>} - { success, statusCode, error? }
     */
    async _replayRequest(request) {
        return this._executeReplay({
            method: request.method,
            url: request.path,
            headers: request.headers,
            body: request.body
        });
    }

    /**
     * Execute a replay request with sanitized headers.
     * This is a sanitized replay — only allowlisted headers are forwarded,
     * auth is replaced with the proxy's own key, and a fresh request ID is generated.
     * NOT bit-for-bit faithful to the original request.
     * @param {Object} request - { method, url, headers, body (base64 string), targetKeyIndex? }
     * @returns {Promise<Object>} - { success, statusCode, body?, error? }
     */
    async _executeReplay(request) {
        const keyInfo = request.targetKeyIndex != null
            ? this.keyManager.getKeyByIndex(request.targetKeyIndex)
            : this.keyManager.acquireKey();

        if (!keyInfo) {
            return { success: false, error: 'No available API keys for replay' };
        }

        // Increment inFlight for getKeyByIndex path (acquireKey does it internally)
        if (request.targetKeyIndex != null) {
            keyInfo.inFlight++;
        }

        // Build sanitized headers from allowlist only
        const sanitizedHeaders = {};
        if (request.headers) {
            for (const [key, value] of Object.entries(request.headers)) {
                if (REPLAY_ALLOWED_HEADERS.has(key.toLowerCase())) {
                    // Normalize multi-value headers (string[] -> comma-separated)
                    sanitizedHeaders[key.toLowerCase()] = Array.isArray(value)
                        ? value.join(', ')
                        : value;
                }
            }
        }

        // Set auth from proxy's key pool
        sanitizedHeaders['x-api-key'] = keyInfo.key;

        // Fresh request ID (never forward stored one)
        sanitizedHeaders['x-request-id'] = typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : crypto.randomBytes(16).toString('hex');

        // Decode body and set content-length
        let bodyBuf = null;
        if (request.body) {
            bodyBuf = Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body, 'base64');
            sanitizedHeaders['content-length'] = String(bodyBuf.length);
        }

        // Apply model routing to replay requests
        let routedModel = null;  // Track for slot release after request completes
        if (this.modelRouter && bodyBuf) {
            try {
                const parsed = JSON.parse(bodyBuf.toString('utf8'));
                if (parsed.model) {
                    const result = await this.modelRouter.selectModel({
                        parsedBody: parsed,
                        requestModel: parsed.model,
                        skipOverrides: true
                    });
                    if (result && result.model) {
                        routedModel = result.model;
                        if (result.model !== parsed.model) {
                            parsed.model = result.model;
                            bodyBuf = Buffer.from(JSON.stringify(parsed), 'utf8');
                            sanitizedHeaders['content-length'] = String(bodyBuf.length);
                        }
                    }
                }
            } catch (_e) { /* non-JSON body, skip routing */ }
        }

        // Host from config only (never from stored headers)
        sanitizedHeaders['host'] = this.config.targetHost;

        const targetPath = this.config.targetBasePath + request.url;

        const options = {
            hostname: this.config.targetHost,
            port: 443,
            path: targetPath,
            method: request.method || 'POST',
            headers: sanitizedHeaders,
            timeout: this.config.adaptiveTimeout?.initialMs || 120000
        };

        const replayStart = Date.now();

        const releaseRoutedSlot = () => {
            if (routedModel && this.modelRouter) {
                this.modelRouter.releaseModel(routedModel);
            }
        };

        return new Promise((resolve) => {
            const proxyReq = https.request(options, (proxyRes) => {
                const chunks = [];
                proxyRes.on('data', (chunk) => chunks.push(chunk));
                proxyRes.on('end', () => {
                    const statusCode = proxyRes.statusCode;
                    const success = statusCode >= 200 && statusCode < 400;
                    const body = Buffer.concat(chunks).toString('utf8');

                    if (success) {
                        this.keyManager.recordSuccess(keyInfo, Date.now() - replayStart);
                    } else {
                        this.keyManager.recordFailure(keyInfo, 'server_error');
                    }

                    releaseRoutedSlot();
                    resolve({ success, statusCode, body });
                });
            });

            proxyReq.on('timeout', () => {
                this.keyManager.recordFailure(keyInfo, 'timeout');
                releaseRoutedSlot();
                proxyReq.destroy();
                resolve({ success: false, error: 'Replay request timed out' });
            });

            proxyReq.on('error', (err) => {
                this.keyManager.recordFailure(keyInfo, this.requestHandler._categorizeError(err));
                releaseRoutedSlot();
                resolve({ success: false, error: err.message });
            });

            if (bodyBuf) {
                proxyReq.write(bodyBuf);
            }
            proxyReq.end();
        });
    }

    /**
     * Handle /plugins endpoint (Week 12)
     */
    async _handlePlugins(req, res) {
        if (!this.pluginManager) {
            this._sendError(res, 503, 'Plugin manager not enabled');
            return;
        }

        // GET - list plugins
        if (req.method === 'GET') {
            this._sendJson(res, 200, {
                plugins: this.pluginManager.list(),
                stats: this.pluginManager.getStats(),
                timestamp: new Date().toISOString()
            });
            return;
        }

        // POST - enable/disable plugin
        if (req.method === 'POST') {
            try {
                const { name, action } = await parseJsonBody(req);
                if (!name || !action) {
                    this._sendError(res, 400, 'name and action required');
                    return;
                }

                let result;
                if (action === 'enable') {
                    result = this.pluginManager.enable(name);
                } else if (action === 'disable') {
                    result = this.pluginManager.disable(name);
                } else if (action === 'unregister') {
                    result = this.pluginManager.unregister(name);
                } else {
                    this._sendError(res, 400, 'Invalid action. Use: enable, disable, unregister');
                    return;
                }

                this._sendJson(res, 200, { success: result, action, name });
            } catch (err) {
                this._sendError(res, 400, err.message);
            }
            return;
        }

        this._sendError(res, 405, 'Method not allowed');
    }

    /**
     * Handle /plugins/stats endpoint (Week 12)
     */
    _handlePluginsStats(req, res) {
        if (!this.pluginManager) {
            this._sendError(res, 503, 'Plugin manager not enabled');
            return;
        }

        this._sendJson(res, 200, this.pluginManager.getStats());
    }

    /**
     * Handle /compare endpoint (#8)
     */
    _handleCompare(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const keysParam = url.searchParams?.get('keys');

        let keyIndices = null;
        if (keysParam) {
            keyIndices = keysParam.split(',').map(k => parseInt(k.trim(), 10)).filter(k => !isNaN(k));
        }

        const comparison = this.keyManager.compareKeys(keyIndices);

        this._sendJson(res, 200, comparison);
    }

    /**
     * Handle /requests endpoint (#3)
     */
    _handleRequests(req, res, pathname) {
        const url = new URL(req.url, `http://${req.headers.host}`);

        // GET /requests - list recent requests
        if (pathname === '/requests' && req.method === 'GET') {
            const limit = Math.min(Math.max(parseInt(url.searchParams?.get('limit') || '50', 10) || 50, 1), 500);
            const offset = Math.min(Math.max(parseInt(url.searchParams?.get('offset') || '0', 10) || 0, 0), 10000);

            const requests = this.requestTraces.toArray().slice(-(limit + offset)).slice(0, limit);

            this._sendJson(res, 200, {
                requests,
                total: this.requestTraces.size,
                limit,
                offset
            });
            return;
        }

        // GET /requests/search
        if (pathname === '/requests/search' && req.method === 'GET') {
            const keyIndexParam = url.searchParams?.get('keyIndex');
            const status = url.searchParams?.get('status');
            const minLatencyParam = url.searchParams?.get('minLatency');

            let filtered = this.requestTraces.toArray();

            if (keyIndexParam !== null) {
                const ki = parseInt(keyIndexParam, 10);
                if (!isNaN(ki)) {
                    filtered = filtered.filter(r => r.keyIndex === ki);
                }
            }
            if (status) {
                filtered = filtered.filter(r => String(r.status) === status);
            }
            if (minLatencyParam) {
                const ml = parseInt(minLatencyParam, 10);
                if (!isNaN(ml)) {
                    filtered = filtered.filter(r => r.latencyMs >= ml);
                }
            }

            this._sendJson(res, 200, { requests: filtered.slice(-100) });
            return;
        }

        // GET /requests/:requestId/payload
        const payloadMatch = pathname.match(/^\/requests\/([^/]+)\/payload$/);
        if (payloadMatch && req.method === 'GET') {
            let requestId = payloadMatch[1];
            try {
                requestId = decodeURIComponent(requestId);
            } catch {
                this._sendError(res, 400, 'Invalid request id');
                return;
            }
            const payload = this.requestHandler?.getRequestPayload?.(requestId);
            if (!payload) {
                this._sendError(res, 404, 'Payload not found');
                return;
            }
            this._sendJson(res, 200, { requestId, payload });
            return;
        }

        // GET /requests/:traceId
        const traceMatch = pathname.match(/^\/requests\/([^/]+)$/);
        if (traceMatch && req.method === 'GET') {
            const traceId = traceMatch[1];
            const trace = this.requestTraces.toArray().find(r => r.traceId === traceId || r.requestId === traceId);

            if (!trace) {
                this._sendError(res, 404, 'Trace not found');
                return;
            }

            this._sendJson(res, 200, trace);
            return;
        }

        this._sendError(res, 404, 'Not found');
    }

    /**
     * Handle /webhooks endpoint (#7)
     */
    _handleWebhooks(req, res) {
        if (!this.webhookManager) {
            this._sendError(res, 404, 'Webhooks not enabled');
            return;
        }

        this._sendJson(res, 200, {
            endpoints: this.webhookManager.getEndpoints(),
            stats: this.webhookManager.getDeliveryStats()
        });
    }

    /**
     * Handle /webhooks/test endpoint (#7)
     */
    async _handleWebhookTest(req, res) {
        if (req.method !== 'POST') {
            this._sendError(res, 405, 'Method not allowed');
            return;
        }

        if (!this.webhookManager) {
            this._sendError(res, 404, 'Webhooks not enabled');
            return;
        }

        try {
            const { url } = await parseJsonBody(req);
            if (!url) {
                this._sendError(res, 400, 'URL required');
                return;
            }

            const result = await this.webhookManager.testWebhook(url);
            this._sendJson(res, result.success ? 200 : 400, result);
        } catch (e) {
            this._sendError(res, e.statusCode || 400, e.message || 'Invalid JSON body');
        }
    }

    /**
     * Handle /replay/* endpoints (#9)
     */
    async _handleReplayRequests(req, res, pathname) {
        if (!this.requestStore) {
            this._sendError(res, 404, 'Request store not enabled');
            return;
        }

        // Check admin auth if enabled
        if (this.adminAuth) {
            const authResult = this.adminAuth.authenticate(req);
            if (!authResult.authenticated) {
                this._sendError(res, 401, authResult.error);
                return;
            }
        }

        const url = new URL(req.url, `http://${req.headers.host}`);

        // GET /replay/requests - list stored requests
        if (pathname === '/replay/requests' && req.method === 'GET') {
            const offset = parseInt(url.searchParams?.get('offset') || '0', 10) || 0;
            const limit = parseInt(url.searchParams?.get('limit') || '50', 10) || 50;
            const errorType = url.searchParams?.get('errorType');

            const result = this.requestStore.list(offset, limit, { errorType });

            this._sendJson(res, 200, result);
            return;
        }

        // POST /replay/requests/:id/replay - replay a request
        const replayMatch = pathname.match(/^\/replay\/requests\/([^/]+)\/replay$/);
        if (replayMatch && req.method === 'POST') {
            const requestId = replayMatch[1];

            let targetKeyIndex = null;
            try {
                const params = await parseJsonBody(req);
                targetKeyIndex = params.keyIndex || null;
            } catch (e) {
                this.logger?.debug('Failed to parse replay request body', { error: e.message });
            }

            const result = await this.requestStore.replay(requestId, targetKeyIndex);

            this._sendJson(res, result.success ? 200 : 400, result);
            return;
        }

        // GET /replay/stats
        if (pathname === '/replay/stats' && req.method === 'GET') {
            this._sendJson(res, 200, this.requestStore.getStats());
            return;
        }

        this._sendError(res, 404, 'Not found');
    }

    /**
     * Handle /tenants endpoint (#10)
     */
    _handleTenants(req, res) {
        if (!this.tenantManager) {
            this._sendError(res, 404, 'Multi-tenant not enabled');
            return;
        }

        this._sendJson(res, 200, this.tenantManager.getAllTenantStats());
    }

    /**
     * Handle /stats/tenants endpoint (Week 5 - Tenant-aware pools)
     * Returns comprehensive tenant statistics including cost data
     */
    _handleStatsTenants(req, res) {
        if (!this.tenantManager) {
            this._sendJson(res, 200, {
                enabled: false,
                message: 'Multi-tenant mode not enabled',
                tenants: {}
            });
            return;
        }

        const tenantStats = this.tenantManager.getAllTenantStats();

        // Enhance with cost data if cost tracker is available
        if (this.costTracker) {
            const tenantCosts = this.costTracker.getAllTenantCosts?.() || {};
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

        this._sendJson(res, 200, {
            ...tenantStats,
            summary,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Handle /policies endpoint (Week 6 - Route Policy Engine)
     * GET: List all policies
     * POST: Add new policy
     */
    async _handlePolicies(req, res) {
        if (!this.routePolicyManager) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                enabled: false,
                message: 'Route policy engine not enabled',
                policies: []
            }, null, 2));
            return;
        }

        if (req.method === 'GET') {
            const policies = this.routePolicyManager.getPolicies();
            const defaultPolicy = this.routePolicyManager.defaultPolicy;

            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                enabled: true,
                policyCount: policies.length,
                policies,
                defaultPolicy,
                configPath: this.routePolicyManager.configPath,
                hotReload: !!this.routePolicyManager.watcher,
                timestamp: new Date().toISOString()
            }, null, 2));
            return;
        }

        if (req.method === 'POST') {
            // Require auth for mutations
            if (this.adminAuth) {
                const authResult = this.adminAuth.authenticate(req);
                if (!authResult.authenticated) {
                    res.writeHead(401, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ error: authResult.error }));
                    return;
                }
            }

            try {
                const policy = await parseJsonBody(req, { allowEmpty: false });
                const validation = this.routePolicyManager.validatePolicy(policy);

                if (!validation.valid) {
                    res.writeHead(400, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'Invalid policy',
                        details: validation.errors
                    }));
                    return;
                }

                this.routePolicyManager.addPolicy(policy);
                this._addAuditEntry('policy_added', {
                    name: policy.name,
                    ip: this._getClientIp(req)
                });

                res.writeHead(201, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    policy,
                    timestamp: new Date().toISOString()
                }, null, 2));
            } catch (err) {
                res.writeHead(err.statusCode || 400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: err.message || 'Invalid JSON' }));
            }
            return;
        }

        res.writeHead(405, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
    }

    /**
     * Handle /policies/reload endpoint (Week 6)
     * POST: Trigger policy reload from config file
     */
    _handlePoliciesReload(req, res) {
        if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed, use POST' }));
            return;
        }

        if (!this.routePolicyManager) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Route policy engine not enabled' }));
            return;
        }

        // Require auth
        if (this.adminAuth) {
            const authResult = this.adminAuth.authenticate(req);
            if (!authResult.authenticated) {
                res.writeHead(401, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: authResult.error }));
                return;
            }
        }

        try {
            const result = this.routePolicyManager.reload();
            this._addAuditEntry('policy_manual_reload', {
                success: result.success,
                policiesLoaded: result.policiesLoaded,
                ip: this._getClientIp(req)
            });

            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                ...result,
                timestamp: new Date().toISOString()
            }, null, 2));
        } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Reload failed',
                message: err.message
            }));
        }
    }

    /**
     * Handle /policies/:name endpoint (Week 6)
     * GET: Get specific policy
     * PUT: Update policy
     * DELETE: Remove policy
     */
    async _handlePolicyByName(req, res, pathname) {
        if (!this.routePolicyManager) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Route policy engine not enabled' }));
            return;
        }

        const match = pathname.match(/^\/policies\/([^/?]+)/);
        if (!match) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
            return;
        }

        const policyName = decodeURIComponent(match[1]);

        if (req.method === 'GET') {
            const policy = this.routePolicyManager.getPolicyByName(policyName);
            if (!policy) {
                res.writeHead(404, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'Policy not found', name: policyName }));
                return;
            }

            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(policy, null, 2));
            return;
        }

        // Require auth for mutations
        if (this.adminAuth) {
            const authResult = this.adminAuth.authenticate(req);
            if (!authResult.authenticated) {
                res.writeHead(401, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: authResult.error }));
                return;
            }
        }

        if (req.method === 'PUT') {
            try {
                const updates = await parseJsonBody(req, { allowEmpty: false });
                const result = this.routePolicyManager.updatePolicy(policyName, updates);

                if (!result) {
                    res.writeHead(404, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Policy not found', name: policyName }));
                    return;
                }

                this._addAuditEntry('policy_updated', {
                    name: policyName,
                    updates: Object.keys(updates),
                    ip: this._getClientIp(req)
                });

                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    policy: result,
                    timestamp: new Date().toISOString()
                }, null, 2));
            } catch (err) {
                res.writeHead(err.statusCode || 400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: err.message || 'Invalid JSON' }));
            }
            return;
        }

        if (req.method === 'DELETE') {
            const removed = this.routePolicyManager.removePolicy(policyName);

            if (!removed) {
                res.writeHead(404, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'Policy not found', name: policyName }));
                return;
            }

            this._addAuditEntry('policy_removed', {
                name: policyName,
                ip: this._getClientIp(req)
            });

            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                removed: policyName,
                timestamp: new Date().toISOString()
            }));
            return;
        }

        res.writeHead(405, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
    }

    /**
     * Handle /tenants/:id/stats endpoint (#10)
     */
    _handleTenantStats(req, res, pathname) {
        if (!this.tenantManager) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Multi-tenant not enabled' }));
            return;
        }

        const match = pathname.match(/^\/tenants\/([^/]+)\/stats$/);
        if (!match) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
            return;
        }

        const tenantId = match[1];
        const stats = this.tenantManager.getTenantStats(tenantId);

        if (!stats) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Tenant not found' }));
            return;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(stats, null, 2));
    }

    /**
     * Handle /model-mapping endpoint
     * GET: Get current model mapping configuration
     * PUT: Update global model mapping configuration
     */
    async _handleModelMapping(req, res) {
        // Check admin auth if enabled
        if (this.adminAuth) {
            const authResult = this.adminAuth.authenticate(req);
            if (!authResult.authenticated) {
                res.writeHead(401, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: authResult.error }));
                return;
            }
        }

        const manager = this.config.modelMappingManager;
        const deprecationDate = this._deprecationDate || '2026-06-01';

        if (req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                config: manager.toConfig(),
                keyOverrides: manager.getKeyOverrides(),
                deprecated: true,
                deprecationDate,
                useInstead: '/model-routing',
                message: 'Model mapping is deprecated. Use /model-routing for tier-based routing.'
            }, null, 2));
            return;
        }

        if (req.method === 'PUT') {
            // DEPRECATED: No longer modifies mapping. Return deprecation info.
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                deprecated: true,
                deprecationDate,
                useInstead: '/model-routing',
                message: 'PUT /model-mapping is deprecated and no longer updates configuration. Use PUT /model-routing instead.'
            }, null, 2));
            return;
        }

        res.writeHead(405, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
    }

    /**
     * Handle /model-mapping/reset endpoint
     * POST: Reset model mapping to defaults
     */
    async _handleModelMappingReset(req, res) {
        if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed, use POST' }));
            return;
        }

        // Check admin auth if enabled
        if (this.adminAuth) {
            const authResult = this.adminAuth.authenticate(req);
            if (!authResult.authenticated) {
                res.writeHead(401, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: authResult.error }));
                return;
            }
        }

        // DEPRECATED: No longer resets mapping. Return deprecation info.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            deprecated: true,
            deprecationDate: this._deprecationDate || '2026-06-01',
            useInstead: '/model-routing',
            message: 'POST /model-mapping/reset is deprecated and no longer resets configuration. Use /model-routing instead.'
        }, null, 2));
    }

    /**
     * Handle /model-mapping/keys/:keyIndex endpoint
     * GET: Get per-key overrides for a specific key
     * PUT: Set per-key override for a specific key
     * DELETE: Clear per-key override for a specific key
     */
    async _handleModelMappingKey(req, res, pathname) {
        // Check admin auth if enabled
        if (this.adminAuth) {
            const authResult = this.adminAuth.authenticate(req);
            if (!authResult.authenticated) {
                res.writeHead(401, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: authResult.error }));
                return;
            }
        }

        const manager = this.config.modelMappingManager;
        const match = pathname.match(/^\/model-mapping\/keys\/(\d+)$/);

        if (!match) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid key index' }));
            return;
        }

        const keyIndex = parseInt(match[1], 10);
        if (isNaN(keyIndex) || keyIndex < 0 || keyIndex >= this.keyManager.keys.length) {
            this._sendError(res, 400, 'Invalid key index');
            return;
        }

        const deprecationResponse = {
            deprecated: true,
            deprecationDate: this._deprecationDate || '2026-06-01',
            useInstead: '/model-routing'
        };

        if (req.method === 'GET') {
            const overrides = manager.getKeyOverride(keyIndex);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                ...deprecationResponse,
                keyIndex,
                override: overrides || {},
                message: 'GET /model-mapping/keys is deprecated. Use /model-routing for per-key configuration.'
            }, null, 2));
            return;
        }

        if (req.method === 'PUT') {
            // DEPRECATED: No longer sets key override. Return deprecation info.
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                ...deprecationResponse,
                message: 'PUT /model-mapping/keys is deprecated and no longer sets overrides. Use /model-routing instead.'
            }, null, 2));
            return;
        }

        if (req.method === 'DELETE') {
            // DEPRECATED: No longer clears key override. Return deprecation info.
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                ...deprecationResponse,
                message: 'DELETE /model-mapping/keys is deprecated and no longer clears overrides. Use /model-routing instead.'
            }, null, 2));
            return;
        }

        res.writeHead(405, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
    }

    // ========== MODEL ROUTING ENDPOINTS ==========

    /**
     * Handle /model-routing endpoint
     * GET: Return full model routing state (includes persistence info)
     * PUT: Update routing config (persisted to disk when persistConfigEdits is enabled)
     */
    async _handleModelRouting(req, res) {
        if (!this.modelRouter) {
            this._sendJson(res, 200, {
                enabled: false,
                inactiveReason: 'disabled_by_config',
                message: 'Model routing is not enabled in configuration',
                fallbackSystem: 'model-mapping',
                suggestedNextSteps: [
                    {
                        action: 'use_model_mapping',
                        description: 'Model mapping is currently active and handling model transformations',
                        endpoint: '/model-mapping'
                    },
                    {
                        action: 'enable_model_routing',
                        description: 'Enable modelRouting in config to activate advanced routing',
                        configKey: 'modelRouting.enabled',
                        endpoint: '/model-selection'
                    },
                    {
                        action: 'check_status',
                        description: 'View overall model selection system status',
                        endpoint: '/model-selection'
                    }
                ]
            });
            return;
        }

        if (req.method === 'GET') {
            const data = this.modelRouter.toJSON();
            // Add cluster warning when running in cluster mode
            const cluster = require('cluster');
            const isActuallyClustered = this.isClusterWorker || (cluster.isPrimary && cluster.workers && Object.keys(cluster.workers).length > 0);
            if (isActuallyClustered) {
                data.warnings = data.warnings || [];
                data.warnings.push('cooldowns_not_shared_in_cluster');
                if (this.isClusterWorker) {
                    data.warnings.push('overrides_not_persisted_on_worker');
                }
            }
            // Add persistence state
            data.persistence = {
                enabled: this._routingPersistence.enabled,
                configPath: this._routingPersistence.configPath,
                lastSavedAt: this._routingPersistence.lastSavedAt,
                lastSaveError: this._routingPersistence.lastSaveError,
                lastLoadError: this._routingPersistence.lastLoadError,
                configWarnings: this._routingPersistence.configWarnings || null
            };
            this._sendJson(res, 200, data);
            return;
        }

        if (req.method === 'PUT') {
            try {
                const updates = await parseJsonBody(req, { allowEmpty: false });

                // NORM-01: Normalize updates through normalizer with patchMode
                // patchMode prevents filling missing tiers with empty defaults,
                // allowing partial PUT payloads (e.g. only updating one tier)
                const normalizationResult = normalizeModelRoutingConfig(updates, {
                    logger: this.logger,
                    patchMode: true
                });
                const normalizedUpdates = normalizationResult.normalizedConfig;

                // Validate the raw updates for structural correctness.
                // We pass only the user-provided keys through validateConfig to avoid
                // false failures from catch-all/defaultModel checks on partial payloads.
                // The normalizer already added version: '2.0', so include it for v2 tier validation.
                const keysToValidate = {};
                for (const key of Object.keys(updates)) {
                    keysToValidate[key] = normalizedUpdates[key] !== undefined ? normalizedUpdates[key] : updates[key];
                }
                // Always include version so tier validation uses v2 rules
                keysToValidate.version = normalizedUpdates.version || this.modelRouter.config.version || '2.0';
                // For partial updates: include existing defaultModel/rules context
                // so the catch-all/defaultModel completeness check doesn't falsely reject.
                // The validator requires either a catch-all rule or defaultModel when rules are present.
                if ('rules' in keysToValidate && !('defaultModel' in keysToValidate)) {
                    keysToValidate.defaultModel = this.modelRouter.config.defaultModel || null;
                }
                if ('defaultModel' in keysToValidate && !('rules' in keysToValidate)) {
                    keysToValidate.rules = this.modelRouter.config.rules || [];
                }
                // Include existing tiers context for VALIDATE-03 warnings
                // (maxModelSwitchesPerRequest vs tier model count)
                if ('failover' in keysToValidate && !('tiers' in keysToValidate)) {
                    keysToValidate.tiers = this.modelRouter.config.tiers || {};
                }
                const validation = ModelRouter.validateConfig(keysToValidate);
                if (!validation.valid) {
                    this._sendError(res, 400, validation.error);
                    return;
                }

                // Deep-merge normalized updates with existing config
                // Shallow spread for top-level keys, deep merge for tiers
                const mergedConfig = { ...this.modelRouter.config, ...normalizedUpdates };
                if (normalizedUpdates.tiers) {
                    mergedConfig.tiers = { ...this.modelRouter.config.tiers };
                    for (const [tierName, tierConfig] of Object.entries(normalizedUpdates.tiers)) {
                        mergedConfig.tiers[tierName] = tierConfig;
                    }
                }

                const ip = this._getClientIp(req);

                // Apply to runtime (always works, even when persistence is off)
                this.modelRouter.updateConfig(mergedConfig);

                const response = {
                    success: true,
                    config: this.modelRouter.toJSON()
                };
                if (validation.warnings?.length > 0) {
                    response.warnings = validation.warnings;
                }
                // Add normalization warnings if any
                if (normalizationResult.warnings?.length > 0) {
                    response.warnings = (response.warnings || []).concat(normalizationResult.warnings);
                }
                // Persist warnings so GET /model-routing reflects them
                this._routingPersistence.configWarnings = validation.warnings?.length > 0
                    ? validation.warnings
                    : null;

                // Persist if enabled
                if (this._routingPersistence.enabled && this._routingPersistence.configPath) {
                    try {
                        const configPath = this._routingPersistence.configPath;
                        const backupPath = configPath + '.bak';

                        // Extract only editable fields for persistence
                        // Use the actual config version (v2 after migration) so the
                        // paranoia-check validateConfig sees the correct tier format.
                        const editableFields = { version: mergedConfig.version || '2.0' };
                        const EDITABLE_KEYS = ['enabled', 'defaultModel', 'tiers', 'rules', 'classifier', 'cooldown', 'logDecisions', 'failover', 'shadowMode'];
                        for (const key of EDITABLE_KEYS) {
                            if (key in mergedConfig) {
                                editableFields[key] = mergedConfig[key];
                            }
                        }

                        // Backup existing file (if it exists)
                        try {
                            const existing = fs.readFileSync(configPath, 'utf8');
                            await atomicWrite(backupPath, existing);
                        } catch (_e) {
                            // No existing file to backup — that's fine
                        }

                        // Write new config
                        const serialized = JSON.stringify(editableFields, null, 2);
                        await atomicWrite(configPath, serialized);

                        // Paranoia check: re-read and validate
                        const reRead = fs.readFileSync(configPath, 'utf8');
                        const reparsed = JSON.parse(reRead);
                        const revalidation = ModelRouter.validateConfig(reparsed);
                        if (!revalidation.valid) {
                            // Restore backup
                            try {
                                const backup = fs.readFileSync(backupPath, 'utf8');
                                await atomicWrite(configPath, backup);
                            } catch (_e) {
                                fs.unlinkSync(configPath);
                            }
                            this._routingPersistence.lastSaveError = 'Paranoia check failed: ' + revalidation.error;
                            this.logger.error?.('[ModelRouter] Config persistence paranoia check failed, rolled back');
                            this._sendError(res, 500, 'Config written but failed verification — rolled back to backup');
                            return;
                        }

                        this._routingPersistence.lastSavedAt = new Date().toISOString();
                        this._routingPersistence.lastSaveError = null;
                        response.persisted = true;
                    } catch (persistErr) {
                        this._routingPersistence.lastSaveError = persistErr.message;
                        this.logger.warn?.('[ModelRouter] Config persistence failed: ' + persistErr.message);
                        response.persisted = false;
                        response.persistError = persistErr.message;
                    }
                } else {
                    response.warning = 'runtime_only_change';
                }

                this._addAuditEntry('model_routing_config_updated', {
                    ip,
                    updates: Object.keys(updates),
                    persisted: response.persisted || false,
                    timestamp: new Date().toISOString()
                });

                this._sendJson(res, 200, response);
            } catch (e) {
                this._sendError(res, e.statusCode || 400, e.message || 'Invalid JSON body');
            }
            return;
        }

        this._sendError(res, 405, 'Method not allowed');
    }

    /**
     * Handle /model-routing/reset endpoint
     * POST: Reset all routing state (overrides, cooldowns, stats)
     */
    async _handleModelRoutingReset(req, res) {
        if (req.method !== 'POST') {
            this._sendError(res, 405, 'Method not allowed, use POST');
            return;
        }

        if (!this.modelRouter) {
            this._sendError(res, 503, 'Model router not available');
            return;
        }

        const ip = this._getClientIp(req);
        this.modelRouter.reset();
        this._addAuditEntry('model_routing_reset', {
            ip,
            timestamp: new Date().toISOString()
        });

        this._sendJson(res, 200, { success: true });
    }

    /**
     * Handle /model-routing/test endpoint
     * GET: Dry-run classifier without side effects
     */
    _handleModelRoutingTest(req, res) {
        if (req.method !== 'GET') {
            this._sendError(res, 405, 'Method not allowed, use GET');
            return;
        }

        if (!this.modelRouter) {
            this._sendError(res, 503, 'Model router not available');
            return;
        }

        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const model = url.searchParams.get('model') || 'claude-sonnet-4-5-20250929';
        const maxTokensParam = url.searchParams.get('max_tokens');
        const messageCount = parseInt(url.searchParams.get('messages') || '1', 10) || 1;
        const hasTools = url.searchParams.get('tools') === 'true';
        const hasVision = url.searchParams.get('vision') === 'true';
        const systemLength = parseInt(url.searchParams.get('system_length') || '0', 10) || 0;

        // Build synthetic parsed body
        const syntheticBody = {
            model,
            messages: Array.from({ length: messageCount }, () => ({
                role: 'user',
                content: 'test'
            })),
            stream: false
        };

        // Only set max_tokens if provided (to test null vs 0)
        if (maxTokensParam !== null && maxTokensParam !== '') {
            const maxTokens = parseInt(maxTokensParam, 10);
            if (!isNaN(maxTokens)) {
                syntheticBody.max_tokens = maxTokens;
            }
        }

        if (hasTools) {
            syntheticBody.tools = [{ name: 'test_tool', description: 'test', input_schema: { type: 'object' } }];
        }

        if (hasVision) {
            syntheticBody.messages[0] = {
                role: 'user',
                content: [
                    { type: 'text', text: 'test' },
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }
                ]
            };
        }

        if (systemLength > 0) {
            syntheticBody.system = 'x'.repeat(systemLength);
        }

        const features = this.modelRouter.extractFeatures(syntheticBody);
        const classification = this.modelRouter.classify(features);

        // Resolve to models using v2 format (models[] array at top level)
        let models = [];
        let selectedModel = null;
        let tierStrategy = null;

        if (classification && this.modelRouter.config.tiers?.[classification.tier]) {
            const tierConfig = this.modelRouter.config.tiers[classification.tier];
            // V2 format: use models[] array
            if (Array.isArray(tierConfig.models) && tierConfig.models.length > 0) {
                models = [...tierConfig.models];
                // For non-pool strategies, select first model as target
                // For pool strategy, this represents the pool (actual selection happens at request time)
                const strategy = tierConfig.strategy || 'balanced';
                tierStrategy = strategy;
                if (strategy !== 'pool') {
                    selectedModel = models[0];
                } else {
                    // Pool strategy: selectedModel determined dynamically based on availability
                    // For this dry-run endpoint, indicate pool with first available model
                    selectedModel = models[0];
                }
            }
        } else if (this.modelRouter.config.defaultModel) {
            selectedModel = this.modelRouter.config.defaultModel;
            models = [this.modelRouter.config.defaultModel];
        }

        this._sendJson(res, 200, {
            features,
            classification,
            models,
            selectedModel,
            candidates: models,
            // Backwards compat: targetModel/failoverModel mirror v2 for v1 consumers
            targetModel: selectedModel,
            failoverModel: models.length > 1 ? models[models.length - 1] : null,
            strategy: tierStrategy,
            cooldown: selectedModel ? {
                selectedMs: this.modelRouter.getModelCooldown(selectedModel),
                targetMs: this.modelRouter.getModelCooldown(selectedModel),
                poolCooldowns: models.reduce((acc, m) => {
                    acc[m] = this.modelRouter.getModelCooldown(m);
                    return acc;
                }, {})
            } : null
        });
    }

    /**
     * Handle /model-routing/explain endpoint
     * POST: Explain a routing decision without side effects (dry-run)
     */
    async _handleModelRoutingExplain(req, res) {
        if (req.method !== 'POST') {
            this._sendError(res, 405, 'Method not allowed, use POST');
            return;
        }

        if (!this.modelRouter) {
            this._sendError(res, 503, 'Model router not available');
            return;
        }

        // Parse request body
        let parsed;
        try {
            parsed = await parseJsonBody(req, { allowEmpty: false });
        } catch (e) {
            this._sendError(res, 400, 'Invalid JSON body');
            return;
        }

        const {
            model = 'claude-sonnet-4-5-20250929',
            maxTokens,
            hasTools = false,
            hasVision = false,
            messageCount = 1,
            systemLength = 0
        } = parsed;

        // Build synthetic parsedBody (same approach as _handleModelRoutingTest)
        const syntheticBody = {
            model,
            messages: Array.from({ length: messageCount }, () => ({
                role: 'user',
                content: 'test'
            })),
            stream: false
        };

        if (maxTokens !== undefined && maxTokens !== null) {
            syntheticBody.max_tokens = maxTokens;
        }

        if (hasTools) {
            syntheticBody.tools = [{ name: 'test_tool', description: 'test', input_schema: { type: 'object' } }];
        }

        if (hasVision) {
            syntheticBody.messages[0] = {
                role: 'user',
                content: [
                    { type: 'text', text: 'test' },
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }
                ]
            };
        }

        if (systemLength > 0) {
            syntheticBody.system = 'x'.repeat(systemLength);
        }

        const context = {
            parsedBody: syntheticBody,
            requestModel: model
        };

        // Build migration preview if model-mapping is active
        const explainOptions = {
            includeTrace: true  // TRUST-01: Include full decision trace
        };
        const manager = this.config.modelMappingManager;
        if (manager && manager.enabled) {
            const mappingConfig = manager.toConfig();
            if (mappingConfig && mappingConfig.models && mappingConfig.models[model]) {
                explainOptions.migrationPreview = {
                    sourceModel: model,
                    mappedModel: mappingConfig.models[model],
                    mappingActive: true
                };
            }
        }

        const result = await this.modelRouter.explain(context, explainOptions);

        this._sendJson(res, 200, result);
    }

    /**
     * Handle /model-routing/simulate endpoint
     * POST: Simulate routing decisions with two modes
     * TRUST-02: Decision mode (synthetic healthy pool) and stateful mode (snapshot replay)
     */
    async _handleModelRoutingSimulate(req, res) {
        if (req.method !== 'POST') {
            this._sendError(res, 405, 'Method not allowed, use POST');
            return;
        }

        if (!this.modelRouter) {
            this._sendError(res, 503, 'Model router not available');
            return;
        }

        // Parse request body
        let parsed;
        try {
            parsed = await parseJsonBody(req, { allowEmpty: false });
        } catch (e) {
            this._sendError(res, 400, 'Invalid JSON body');
            return;
        }

        // Validate mode
        const { mode, snapshot } = parsed;
        if (!mode || (mode !== 'decision' && mode !== 'stateful')) {
            this._sendError(res, 400, 'mode is required and must be "decision" or "stateful"');
            return;
        }

        // Validate snapshot requirements
        if (mode === 'stateful') {
            if (!snapshot) {
                this._sendError(res, 400, 'snapshot is required for stateful mode');
                return;
            }
            if (snapshot.version !== '1.0') {
                this._sendError(res, 400, 'Unsupported snapshot version: ' + snapshot.version);
                return;
            }
        } else if (mode === 'decision' && snapshot) {
            this._sendError(res, 400, 'snapshot must not be provided for decision mode');
            return;
        }

        // Extract request parameters (same as explain endpoint)
        const {
            model = 'claude-sonnet-4-5-20250929',
            maxTokens,
            hasTools = false,
            hasVision = false,
            messageCount = 1,
            systemLength = 0,
            messages
        } = parsed;

        // Build synthetic parsedBody (same approach as _handleModelRoutingExplain)
        const syntheticBody = {
            model,
            messages: messages || Array.from({ length: messageCount }, () => ({
                role: 'user',
                content: 'test'
            })),
            stream: false
        };

        if (maxTokens !== undefined && maxTokens !== null) {
            syntheticBody.max_tokens = maxTokens;
        }

        if (hasTools) {
            syntheticBody.tools = [{ name: 'test_tool', description: 'test', input_schema: { type: 'object' } }];
        }

        if (hasVision) {
            syntheticBody.messages[0] = {
                role: 'user',
                content: [
                    { type: 'text', text: 'test' },
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }
                ]
            };
        }

        if (systemLength > 0) {
            syntheticBody.system = 'x'.repeat(systemLength);
        }

        const context = {
            parsedBody: syntheticBody,
            requestModel: model
        };

        // Route to appropriate simulation mode
        let result;
        try {
            if (mode === 'decision') {
                result = await this.modelRouter.simulateDecisionMode(context, { includeTrace: true });
            } else {
                result = await this.modelRouter.simulateStatefulMode(context, snapshot, { includeTrace: true });
            }
        } catch (e) {
            this._sendError(res, 400, e.message || 'Simulation failed');
            return;
        }

        this._sendJson(res, 200, result);
    }

    /**
     * Handle /model-routing/overrides endpoint
     * GET: Return all saved overrides
     * PUT: Set an override { key, model }
     * DELETE: Clear an override { key }
     */
    async _handleModelRoutingOverrides(req, res) {
        if (!this.modelRouter) {
            this._sendError(res, 503, 'Model router not available');
            return;
        }

        if (req.method === 'GET') {
            this._sendJson(res, 200, this.modelRouter.getOverrides());
            return;
        }

        if (req.method === 'PUT') {
            try {
                const body = await parseJsonBody(req, { allowEmpty: false });
                if (!body.key || !body.model) {
                    this._sendError(res, 400, 'key and model are required');
                    return;
                }
                const ip = this._getClientIp(req);
                this.modelRouter.setOverride(body.key, body.model);
                this._addAuditEntry('model_routing_override_set', {
                    ip,
                    key: body.key,
                    model: body.model,
                    timestamp: new Date().toISOString()
                });
                this._sendJson(res, 200, {
                    success: true,
                    overrides: this.modelRouter.getOverrides()
                });
            } catch (e) {
                this._sendError(res, e.statusCode || 400, e.message || 'Invalid JSON body');
            }
            return;
        }

        if (req.method === 'DELETE') {
            try {
                const body = await parseJsonBody(req, { allowEmpty: false });
                if (!body.key) {
                    this._sendError(res, 400, 'key is required');
                    return;
                }
                const ip = this._getClientIp(req);
                this.modelRouter.clearOverride(body.key);
                this._addAuditEntry('model_routing_override_cleared', {
                    ip,
                    key: body.key,
                    timestamp: new Date().toISOString()
                });
                this._sendJson(res, 200, {
                    success: true,
                    overrides: this.modelRouter.getOverrides()
                });
            } catch (e) {
                this._sendError(res, e.statusCode || 400, e.message || 'Invalid JSON body');
            }
            return;
        }

        this._sendError(res, 405, 'Method not allowed');
    }

    /**
     * Handle /model-routing/cooldowns endpoint
     * GET: Return all active cooldowns
     */
    _handleModelRoutingCooldowns(req, res) {
        if (req.method !== 'GET') {
            this._sendError(res, 405, 'Method not allowed, use GET');
            return;
        }

        if (!this.modelRouter) {
            this._sendError(res, 503, 'Model router not available');
            return;
        }

        this._sendJson(res, 200, this.modelRouter.getCooldowns());
    }

    /**
     * Handle /model-routing/pools endpoint
     * GET: Return pool utilization status for tiers with strategy: 'pool'
     */
    _handleModelRoutingPools(req, res) {
        if (req.method !== 'GET') {
            this._sendError(res, 405, 'Method not allowed, use GET');
            return;
        }

        if (!this.modelRouter) {
            this._sendError(res, 503, 'Model router not available');
            return;
        }

        this._sendJson(res, 200, this.modelRouter.getPoolStatus());
    }

    /**
     * Handle /model-routing/counters endpoint
     * GET: Return counter schema documentation (ARCH-06)
     */
    _handleModelRoutingCounters(req, res) {
        if (req.method !== 'GET') {
            this._sendError(res, 405, 'Method not allowed, use GET');
            return;
        }

        const countersController = new CountersController();
        countersController.getSchema(req, res);
    }

    /**
     * Handle /model-routing/export endpoint
     * GET: Export full routing state with metadata for import/archival
     */
    _handleModelRoutingExport(req, res) {
        if (req.method !== 'GET') {
            this._sendError(res, 405, 'Method not allowed, use GET');
            return;
        }

        if (!this.modelRouter) {
            this._sendError(res, 503, 'Model router not available');
            return;
        }

        const data = this.modelRouter.toJSON();
        // Defensive redaction: ensure no sensitive fields leak
        delete data.adminTokens;
        delete data.apiKeys;
        data.exportedAt = new Date().toISOString();
        data.version = '1.0';

        res.writeHead(200, {
            'content-type': 'application/json',
            'content-disposition': 'attachment; filename="model-routing-export.json"',
            'cache-control': 'no-store'
        });
        res.end(JSON.stringify(data, null, 2));
    }

    /**
     * Handle /model-selection endpoint
     * GET: Unified view of both model selection systems with recommendations
     */
    _handleModelSelection(req, res) {
        if (req.method !== 'GET') {
            this._sendError(res, 405, 'Method not allowed, use GET');
            return;
        }

        // DEPRECATE-05: Always report model-router as active system
        const activeSystem = 'model-router';
        const routerEnabled = !!(this.modelRouter && this.modelRouter.config && this.modelRouter.config.enabled);

        const response = {
            activeSystem,
            timestamp: new Date().toISOString(),
            systems: {
                'model-router': {
                    enabled: routerEnabled,
                    status: routerEnabled ? 'active' : 'recommended',
                    description: 'Advanced multi-tier routing with load balancing and health-based routing'
                },
                'model-mapping': {
                    enabled: false,
                    status: 'deprecated',
                    description: 'Deprecated. Use model-router for all model selection.',
                    deprecationDate: this._deprecationDate || '2026-06-01',
                    useInstead: '/model-routing'
                }
            },
            recommendations: []
        };

        this._sendJson(res, 200, response);
    }

    /**
     * Handle /models endpoint
     * GET: Return all available models with metadata
     */
    async _handleModelsRequest(req, res) {
        if (req.method !== 'GET') {
            this._sendError(res, 405, 'Method not allowed, use GET');
            return;
        }

        try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const tier = url.searchParams?.get('tier');

            let models;
            if (tier) {
                // Filter by tier if specified
                models = await this.modelDiscovery.getModelsByTier(tier);
            } else {
                // Get all models
                models = await this.modelDiscovery.getModels();
            }

            this._sendJson(res, 200, {
                models,
                count: models.length,
                timestamp: new Date().toISOString(),
                cacheStats: this.modelDiscovery.getCacheStats()
            });
        } catch (error) {
            this.logger.error(`Error fetching models: ${error.message}`);
            this._sendError(res, 500, `Failed to fetch models: ${error.message}`);
        }
    }

    /**
     * Handle /model-routing/import-from-mappings endpoint
     * GET: Generate routing rules from existing model-mapping configuration
     */
    async _handleModelRoutingImportFromMappings(req, res) {
        if (req.method !== 'GET') {
            this._sendError(res, 405, 'Method not allowed, use GET');
            return;
        }

        // Require admin auth if enabled
        if (this.adminAuth && this.adminAuth.enabled) {
            const authResult = this.adminAuth.authenticate(req);
            if (!authResult.authenticated) {
                this._sendError(res, 401, authResult.error);
                return;
            }
        }

        const manager = this.config.modelMappingManager;
        if (!manager || !manager.enabled) {
            this._sendError(res, 400, 'Model mapping is not enabled — nothing to import from');
            return;
        }

        const mappingConfig = manager.toConfig();
        const generatedRules = [];

        // Helper to determine tier from source/target model names
        const determineTier = (sourceModel, targetModel) => {
            const src = (sourceModel || '').toLowerCase();
            const tgt = (targetModel || '').toLowerCase();
            if (src.includes('opus') || tgt.includes('glm-4.7')) return 'heavy';
            if (src.includes('sonnet') || tgt.includes('glm-4.6')) return 'medium';
            if (src.includes('haiku') || tgt.includes('glm-4.5-air')) return 'light';
            return 'medium'; // default fallback
        };

        // Process global mappings
        if (mappingConfig && mappingConfig.models) {
            for (const [sourceModel, targetModel] of Object.entries(mappingConfig.models)) {
                const tier = determineTier(sourceModel, targetModel);
                // Create a wildcard match pattern from the source model
                let matchPattern = sourceModel;
                if (!matchPattern.includes('*')) {
                    // Convert specific model to wildcard: claude-3-5-sonnet-20241022 -> claude-sonnet-*
                    if (matchPattern.includes('opus')) matchPattern = 'claude-opus-*';
                    else if (matchPattern.includes('sonnet')) matchPattern = 'claude-sonnet-*';
                    else if (matchPattern.includes('haiku')) matchPattern = 'claude-haiku-*';
                }
                generatedRules.push({
                    match: { model: matchPattern },
                    tier,
                    comment: `Auto-imported from model-mapping: ${sourceModel} -> ${targetModel}`
                });
            }
        }

        // Deduplicate rules by match pattern
        const seen = new Set();
        const uniqueRules = generatedRules.filter(rule => {
            const key = JSON.stringify(rule.match);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        this._sendJson(res, 200, {
            success: true,
            source: 'model-mapping',
            generatedRules: uniqueRules,
            total: uniqueRules.length,
            message: `Generated ${uniqueRules.length} rules from existing model-mapping configuration. Review and apply via PUT /model-routing`
        });
    }

    /**
     * Handle /model-routing/enable-safe endpoint
     * PUT: Safely enable model routing with comprehensive validation
     */
    async _handleModelRoutingEnableSafe(req, res) {
        if (req.method !== 'PUT') {
            this._sendError(res, 405, 'Method not allowed, use PUT');
            return;
        }

        // Require admin auth if enabled
        if (this.adminAuth && this.adminAuth.enabled) {
            const authResult = this.adminAuth.authenticate(req);
            if (!authResult.authenticated) {
                this._sendError(res, 401, authResult.error);
                return;
            }
        }

        if (!this.modelRouter) {
            this._sendError(res, 503, 'Model router not available — modelRouting must be configured');
            return;
        }

        try {
            const body = await parseJsonBody(req, { allowEmpty: true });
            const addDefaultRules = !!(body && body.addDefaultRules);
            const userUpdates = (body && body.updates) || {};

            // Build the configuration updates
            const updates = { ...userUpdates, enabled: true };

            // Add default tier configs if requested
            if (addDefaultRules) {
                if (!updates.tiers) {
                    updates.tiers = {};
                }
                if (!updates.tiers.light) {
                    updates.tiers.light = { targetModel: 'glm-4.5-air', clientModelPolicy: 'rule-match-only' };
                }
                if (!updates.tiers.medium) {
                    updates.tiers.medium = { targetModel: 'glm-4.6', clientModelPolicy: 'rule-match-only' };
                }
                if (!updates.tiers.heavy) {
                    updates.tiers.heavy = { targetModel: 'glm-4.7', clientModelPolicy: 'always-route' };
                }

                // Add default rules if none provided
                if (!updates.rules || updates.rules.length === 0) {
                    updates.rules = [
                        { match: { model: 'claude-opus-*' }, tier: 'heavy' },
                        { match: { model: 'claude-sonnet-*' }, tier: 'medium' },
                        { match: { model: 'claude-haiku-*' }, tier: 'light' }
                    ];
                }
            }

            // Validate tier configs have models (v2) or targetModel (v1)
            const mergedConfig = { ...this.modelRouter.config, ...updates };
            const validationErrors = [];
            if (mergedConfig.tiers) {
                for (const [tierName, tierConfig] of Object.entries(mergedConfig.tiers)) {
                    if (!tierConfig) {
                        validationErrors.push(`Tier "${tierName}" is missing configuration`);
                        continue;
                    }
                    // Accept v2 (models[]) or v1 (targetModel)
                    const hasV2 = Array.isArray(tierConfig.models) && tierConfig.models.length > 0;
                    const hasV1 = tierConfig.targetModel && typeof tierConfig.targetModel === 'string';
                    if (!hasV2 && !hasV1) {
                        validationErrors.push(`Tier "${tierName}" is missing models[] or targetModel`);
                    }
                }
            }

            if (validationErrors.length > 0) {
                this._sendJson(res, 400, {
                    success: false,
                    error: 'Configuration validation failed',
                    validationErrors
                });
                return;
            }

            // Validate via ModelRouter.validateConfig
            const validation = ModelRouter.validateConfig(updates);
            if (!validation.valid) {
                this._sendJson(res, 400, {
                    success: false,
                    error: 'Configuration validation failed',
                    validationErrors: [validation.error]
                });
                return;
            }

            // Apply to runtime
            this.modelRouter.updateConfig(mergedConfig);

            const response = {
                success: true,
                enabled: true,
                updates,
                persisted: false,
                persistError: null,
                message: 'Model routing enabled safely'
            };

            // Persist if enabled
            if (this._routingPersistence.enabled && this._routingPersistence.configPath) {
                try {
                    const configPath = this._routingPersistence.configPath;
                    const backupPath = configPath + '.bak';

                    // Extract editable fields for persistence using canonical v2+ version stamp
                    const editableFields = { version: mergedConfig.version || '2.0' };
                    const EDITABLE_KEYS = ['enabled', 'defaultModel', 'tiers', 'rules', 'classifier', 'cooldown', 'logDecisions', 'failover', 'shadowMode'];
                    for (const key of EDITABLE_KEYS) {
                        if (key in mergedConfig) {
                            editableFields[key] = mergedConfig[key];
                        }
                    }

                    // Backup existing file
                    try {
                        const existing = fs.readFileSync(configPath, 'utf8');
                        await atomicWrite(backupPath, existing);
                    } catch (_e) {
                        // No existing file to backup
                    }

                    // Write new config
                    const serialized = JSON.stringify(editableFields, null, 2);
                    await atomicWrite(configPath, serialized);

                    this._routingPersistence.lastSavedAt = new Date().toISOString();
                    this._routingPersistence.lastSaveError = null;
                    response.persisted = true;
                } catch (persistErr) {
                    this._routingPersistence.lastSaveError = persistErr.message;
                    this.logger.warn?.('[ModelRouter] Config persistence failed during safe enable: ' + persistErr.message);
                    response.persistError = persistErr.message;
                }
            }

            const ip = this._getClientIp(req);
            this._addAuditEntry('model_routing_safe_enable', {
                ip,
                addDefaultRules,
                updates: Object.keys(updates),
                persisted: response.persisted,
                timestamp: new Date().toISOString()
            });

            this._sendJson(res, 200, response);
        } catch (e) {
            this._sendError(res, e.statusCode || 400, e.message || 'Invalid JSON body');
        }
    }

    /**
     * Handle budget alert from cost tracker (#6)
     */
    _handleBudgetAlert(alert) {
        this.logger.warn('Budget alert', alert);

        // Emit webhook if enabled
        if (this.webhookManager) {
            this.webhookManager.emit(alert.type, alert);
        }
    }

    /**
     * Handle request replay (#9)
     * Called by RequestStore when a replay is triggered via /replay/requests/:id/replay
     * @param {Object} request - { method, url, headers, body (Buffer), targetKeyIndex }
     * @returns {Promise<Object>} - { success, statusCode, error? }
     */
    async _handleReplay(request) {
        return this._executeReplay(request);
    }

    /**
     * Record request trace (#3)
     */
    _recordRequestTrace(trace) {
        if (!this.config.requestTracing?.enabled) return;

        this.requestTraces.push(trace); // RingBuffer auto-evicts oldest when at capacity
    }

    /**
     * Handle /control/* endpoints
     */
    async _handleControl(req, res, pathname) {
        if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed' }));
            return;
        }

        const ip = this._getClientIp(req);
        const sendJson = (status, data) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(data));
        };

        // Helper to audit control actions
        const auditControl = (action, details = {}) => {
            this._addAuditEntry('control_action', { ip, action, ...details });
        };

        try {
            if (pathname === '/control/pause') {
                this.isPaused = true;
                this.logger.info('Proxy paused');
                auditControl('pause');
                return sendJson(200, { status: 'paused' });
            }

            if (pathname === '/control/resume') {
                this.isPaused = false;
                this.logger.info('Proxy resumed');
                auditControl('resume');
                return sendJson(200, { status: 'resumed' });
            }

            if (pathname === '/control/reset-stats') {
                this.statsAggregator.resetErrors();
                this.logger.info('Stats reset');
                auditControl('reset_stats');
                return sendJson(200, { status: 'stats_reset' });
            }

            // Circuit control: /control/circuit/:index/:state
            const circuitMatch = pathname.match(/^\/control\/circuit\/(\d+)\/(CLOSED|OPEN|HALF_OPEN)$/);
            if (circuitMatch) {
                const index = parseInt(circuitMatch[1], 10);
                if (isNaN(index) || index < 0 || index >= this.keyManager.keys.length) {
                    return sendJson(400, { error: 'Invalid key index' });
                }
                const state = circuitMatch[2];
                const result = this.keyManager.forceCircuitState(index, state);
                auditControl('force_circuit', { keyIndex: index, state });
                return sendJson(200, result);
            }

            // Rate limit update
            if (pathname === '/control/rate-limit') {
                try {
                    const settings = await parseJsonBody(req, { allowEmpty: false });
                    const result = this.rateLimiter.updateSettings(settings);
                    this.logger.info('Rate limit updated', result);
                    sendJson(200, result);
                } catch (e) {
                    sendJson(e.statusCode || 400, { error: e.message || 'Invalid JSON body' });
                }
                return;
            }

            // Graceful shutdown endpoint
            if (pathname === '/control/shutdown') {
                this.logger.info('Graceful shutdown requested via API');
                sendJson(200, { status: 'shutting_down', message: 'Graceful shutdown initiated' });
                // Delay shutdown slightly to allow response to be sent
                setTimeout(() => this.shutdown(), 100);
                return;
            }

            // Cost budget control (#6)
            if (pathname === '/control/cost/budget') {
                if (!this.costTracker) {
                    return sendJson(404, { error: 'Cost tracking not enabled' });
                }

                try {
                    const budget = await parseJsonBody(req, { allowEmpty: false });
                    this.costTracker.setBudget(budget);
                    this.logger.info('Cost budget updated', budget);
                    sendJson(200, { status: 'budget_updated', budget: this.costTracker.budget });
                } catch (e) {
                    sendJson(e.statusCode || 400, { error: e.message || 'Invalid JSON body' });
                }
                return;
            }

            sendJson(404, { error: 'Unknown control endpoint' });
        } catch (err) {
            this.logger.error('Control error', { error: err.message });
            sendJson(500, { error: err.message });
        }
    }

    /**
     * Handle proxy request
     */
    _handleProxy(req, res) {
        if (this.isPaused) {
            this._sendJson(res, 503, { error: 'Proxy paused', retryAfter: 5 });
            return;
        }

        // Telemetry short-circuit: drop event logging requests to save capacity for LLM calls
        // These requests steal quota and cause 429 bursts without providing value through the proxy
        const telemetryConfig = this.config.telemetry || { mode: 'drop', paths: ['/api/event_logging'] };
        if (telemetryConfig.mode === 'drop') {
            const isTelemetry = telemetryConfig.paths.some(p => req.url.startsWith(p));
            if (isTelemetry) {
                this.statsAggregator?.recordTelemetry(true);
                const dropResponse = telemetryConfig.dropResponse || { status: 204 };
                res.writeHead(dropResponse.status, { 'content-type': 'application/json' });
                res.end(dropResponse.body ? JSON.stringify(dropResponse.body) : '');
                return;
            }
        }

        // Check body size limit
        const contentLength = parseInt(req.headers['content-length'] || '0', 10) || 0;
        if (contentLength > this.config.maxBodySize) {
            this._sendJson(res, 413, {
                error: 'Payload too large',
                maxSize: this.config.maxBodySize
            });
            return;
        }

        // Collect body
        const body = [];
        let bodySize = 0;

        req.on('data', (chunk) => {
            bodySize += chunk.length;
            if (bodySize > this.config.maxBodySize) {
                req.destroy();
                this._sendError(res, 413, 'Payload too large');
                return;
            }
            body.push(chunk);
        });

        req.once('end', () => {
            const bodyBuffer = Buffer.concat(body);
            this.requestHandler.handleRequest(req, res, bodyBuffer);
        });

        req.once('error', (err) => {
            this.logger.error(`Request error: ${err.message}`);
        });
    }

    /**
     * Get uptime in seconds
     */
    _getUptime() {
        return Math.round((Date.now() - this.startTime) / 1000);
    }

    /**
     * Start the server
     */
    async start() {
        await this.initialize();

        this._createServer();

        return new Promise((resolve, reject) => {
            this.server.listen(this.config.port, this.config.host, () => {
                this.logger.info(`Proxy running on http://${this.config.host}:${this.config.port}`);
                this.logger.info(`Target: https://${this.config.targetHost}${this.config.targetBasePath}`);
                this.logger.info(`Keys: ${this.config.apiKeys.length} | Max retries: ${this.config.maxRetries}`);
                this.logger.info(`Features: Circuit breaker, round-robin, auto-retry, rate limiting, hot reload`);
                this.logger.info(`Endpoints: /stats | /persistent-stats | /health | /reload | /backpressure | /history | /logs | /dashboard`);
                this.logger.info(`New: /requests/stream (SSE) | /circuit-history`);
                resolve(this.server);
            });

            this.server.on('error', reject);
        });
    }

    /**
     * Graceful shutdown (stop is an alias for shutdown)
     */
    async stop() { return this.shutdown(); }
    async destroy() { return this.shutdown(); }
    async shutdown() {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;

        this.logger.info('Initiating graceful shutdown...');

        // 1. Stop accepting new connections immediately
        this.isPaused = true;
        if (this.server) {
            this.server.close();
        }

        // 2. Stop all file watchers
        this._stopWatchers();

        // 3. Stop history tracker
        if (this.historyTracker) {
            this.historyTracker.stop();
        }

        // 3.5. Stop rate limit cleanup interval (Milestone F)
        if (this._rateLimitCleanupInterval) {
            clearInterval(this._rateLimitCleanupInterval);
        }

        // 3.5a. Stop audit flush timer and flush remaining entries
        if (this._auditFlushTimer) {
            clearInterval(this._auditFlushTimer);
            this._auditFlushTimer = null;
        }
        // Final flush of any pending audit entries
        await this._flushAuditBuffer();

        // 3.5b. Stop adaptive concurrency controller
        if (this.adaptiveConcurrency) {
            this.adaptiveConcurrency.stop();
        }

        // 3.5c. Persist cache and stop usage monitor
        if (this.usageMonitor) {
            await this.usageMonitor.persistAndStop();
        }

        // 3.6. Stop predictive scaler interval (Week 8)
        if (this._scalerInterval) {
            clearInterval(this._scalerInterval);
            this._scalerInterval = null;
        }

        // 3.7. Destroy replay queue (Week 11)
        if (this.replayQueue) {
            this.replayQueue.destroy();
        }

        // 3.8. Destroy plugin manager (Week 12)
        if (this.pluginManager) {
            this.pluginManager.destroy();
        }

        // 4. Clear request queue - reject pending requests with shutdown reason
        const queueStats = this.requestHandler.getQueue().getStats();
        if (queueStats.current > 0) {
            this.logger.info(`Clearing ${queueStats.current} queued requests`);
            this.requestHandler.getQueue().clear('shutdown');
        }

        // 5. Wait for in-flight upstream requests to complete
        const shutdownStart = Date.now();
        const timeout = this.config.shutdownTimeout;

        // Wait for both client connections AND upstream in-flight requests
        let lastInFlight = -1;
        while (this.activeConnections.size > 0) {
            const elapsed = Date.now() - shutdownStart;

            // Get current in-flight count to upstream
            const keyStats = this.keyManager.getAggregatedStats();
            const inFlight = keyStats.totalInFlight || 0;

            // Log progress periodically
            if (inFlight !== lastInFlight) {
                this.logger.info(`Shutdown progress: ${this.activeConnections.size} connections, ${inFlight} in-flight to upstream`);
                lastInFlight = inFlight;
            }

            if (elapsed > timeout) {
                this.logger.warn(`Shutdown timeout after ${timeout}ms`, {
                    remainingConnections: this.activeConnections.size,
                    remainingInFlight: inFlight
                });
                // Force close remaining connections
                for (const socket of this.activeConnections) {
                    socket.destroy();
                }
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        // 6. Save stats
        this.statsAggregator.save();
        this.statsAggregator.stopAutoSave();

        // 7. Cleanup resources
        this.requestHandler.destroy();
        this.keyManager.destroy();  // Clear slow key check interval

        // 7a. Cleanup new feature managers
        if (this.costTracker) {
            await this.costTracker.destroy();
        }
        if (this.webhookManager) {
            await this.webhookManager.drain(5000);
        }
        if (this.requestStore) {
            this.requestStore.destroy();
        }
        if (this.tenantManager) {
            this.tenantManager.destroy();
        }

        // 8. Stop pool-status broadcast and close SSE clients
        this._stopPoolStatusBroadcast();
        let sseCloseErrors = 0;
        for (const client of this.sseStreamClients) {
            if (client.keepaliveTimer) {
                clearInterval(client.keepaliveTimer);
                client.keepaliveTimer = null;
            }
            try { client.res.end(); } catch (e) {
                if (e.code !== 'ERR_STREAM_WRITE_AFTER_END' && e.code !== 'ERR_STREAM_DESTROYED') {
                    sseCloseErrors++;
                    this.logger.warn('SSE stream client close error', { error: e.message, clientId: client.id });
                }
            }
        }
        for (const client of this.sseEventClients) {
            try { client.res.end(); } catch (e) {
                if (e.code !== 'ERR_STREAM_WRITE_AFTER_END' && e.code !== 'ERR_STREAM_DESTROYED') {
                    sseCloseErrors++;
                    this.logger.warn('SSE event client close error', { error: e.message, clientId: client.id });
                }
            }
        }
        if (sseCloseErrors > 0) {
            this.logger.warn('SSE shutdown encountered ' + sseCloseErrors + ' unexpected close error(s)');
        }
        this.sseStreamClients.clear();
        this.sseEventClients.clear();

        this.logger.info('Shutdown complete');
    }
}

/**
 * Start proxy with clustering support
 */
async function startProxy(options = {}) {
    const config = getConfig(options);
    const numWorkers = Math.min(os.cpus().length, config.maxWorkers);
    const useCluster = config.useCluster && numWorkers > 1;

    if (useCluster && cluster.isPrimary) {
        return startMaster(config, numWorkers);
    } else {
        return startWorker(config, useCluster);
    }
}

/**
 * Start master process
 */
async function startMaster(config, numWorkers) {
    const logger = getLogger({
        level: config.logLevel,
        format: config.logFormat,
        prefix: 'MASTER'
    });

    logger.info(`Starting ${numWorkers} worker processes...`);

    // Master manages persistent stats
    const statsAggregator = new StatsAggregator({
        statsFile: config.statsFile,
        configDir: config.configDir,
        saveInterval: config.statsSaveInterval,
        logger: logger.child('stats')
    });

    statsAggregator.load();
    statsAggregator.startAutoSave();

    // Handle stats updates from workers
    const handleWorkerMessage = (msg) => {
        if (msg.type === 'stats_update') {
            statsAggregator.recordKeyUsage(msg.keyId, msg.data);
        } else if (msg.type === 'error') {
            statsAggregator.recordError(msg.errorType);
        } else if (msg.type === 'retry') {
            statsAggregator.recordRetry();
        } else if (msg.type === 'worker_stats') {
            statsAggregator.updateWorkerStats(msg.workerId, msg.stats);
        } else if (msg.type === 'get_persistent_stats') {
            const worker = cluster.workers[msg.workerId];
            if (worker) {
                worker.send({
                    type: 'persistent_stats',
                    stats: statsAggregator.getPersistentStats()
                });
            }
        }
    };

    // Fork workers
    for (let i = 0; i < numWorkers; i++) {
        const worker = cluster.fork();
        worker.on('message', handleWorkerMessage);
    }

    // Handle worker crashes
    cluster.on('exit', (worker, code, signal) => {
        logger.warn(`Worker ${worker.process.pid} died (${signal || code}). Restarting...`);
        const newWorker = cluster.fork();
        newWorker.on('message', handleWorkerMessage);
    });

    // Graceful shutdown
    const shutdown = () => {
        logger.info('Shutting down all workers...');
        statsAggregator.save();
        statsAggregator.stopAutoSave();
        for (const id in cluster.workers) {
            cluster.workers[id].kill();
        }
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    return { master: true, workers: numWorkers, statsAggregator };
}

/**
 * Start worker process
 */
async function startWorker(config, isCluster) {
    const proxy = new ProxyServer({
        config,
        isClusterWorker: isCluster  // Disable file persistence in workers
    });

    // If in cluster mode, send stats to master
    if (isCluster) {
        const originalRecordKeyUsage = proxy.statsAggregator.recordKeyUsage.bind(proxy.statsAggregator);
        proxy.statsAggregator.recordKeyUsage = (keyId, data) => {
            originalRecordKeyUsage(keyId, data);
            process.send({ type: 'stats_update', keyId, data });
        };

        const originalRecordError = proxy.statsAggregator.recordError.bind(proxy.statsAggregator);
        proxy.statsAggregator.recordError = (errorType) => {
            originalRecordError(errorType);
            process.send({ type: 'error', errorType });
        };

        const originalRecordRetry = proxy.statsAggregator.recordRetry.bind(proxy.statsAggregator);
        proxy.statsAggregator.recordRetry = () => {
            originalRecordRetry();
            process.send({ type: 'retry' });
        };

        // Periodically send worker stats to master
        const workerStatsInterval = setInterval(() => {
            process.send({
                type: 'worker_stats',
                workerId: cluster.worker.id,
                stats: proxy.statsAggregator.getFullStats(proxy.keyManager, proxy._getUptime())
            });
        }, 5000);
        workerStatsInterval.unref();
    }

    await proxy.start();

    // Graceful shutdown
    const shutdown = async () => {
        await proxy.shutdown();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    return { proxy, master: false };
}

module.exports = {
    ProxyServer,
    startProxy,
    startMaster,
    startWorker
};
