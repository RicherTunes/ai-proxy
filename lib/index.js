/**
 * GLM Proxy Library
 * Export all modules
 */

const { Config, getConfig, resetConfig, DEFAULT_CONFIG } = require('./config');
const { Logger, LOG_LEVELS, getLogger, resetLogger, generateRequestId } = require('./logger');
const { CircuitBreaker, STATES } = require('./circuit-breaker');
const { TokenBucket, RateLimiter } = require('./rate-limiter');
const { KeyManager } = require('./key-manager');
const { StatsAggregator } = require('./stats-aggregator');
const { RequestHandler, RequestQueue } = require('./request-handler');
const { ProxyServer, startProxy, startMaster, startWorker } = require('./proxy-server');
const { HistoryTracker } = require('./history-tracker');
// New feature modules (#3-#10)
const { LatencyHistogram, GlobalHistogramAggregator, DEFAULT_BUCKETS } = require('./latency-histogram');
const { CostTracker, DEFAULT_RATES, ALERT_THRESHOLDS } = require('./cost-tracker');
const { WebhookManager, EVENT_TYPES } = require('./webhook-manager');
const { RequestStore, STORABLE_ERRORS, SENSITIVE_HEADERS } = require('./request-store');
const { TenantManager, TenantContext, DEFAULT_TENANT_ID } = require('./tenant-manager');
const { AdminAuth, generateToken, hashToken, secureCompare } = require('./admin-auth');

// Drift Detector (Phase 12)
const { DriftDetector, DRIFT_REASON_ENUM } = require('./drift-detector');

// Schema exports (Phase 12)
const schemas = require('./schemas');
const { CounterRegistry, COUNTER_SCHEMA, COUNTER_LABELS } = schemas;

module.exports = {
    // Config
    Config,
    getConfig,
    resetConfig,
    DEFAULT_CONFIG,

    // Logger
    Logger,
    LOG_LEVELS,
    getLogger,
    resetLogger,
    generateRequestId,

    // Circuit Breaker
    CircuitBreaker,
    STATES,

    // Rate Limiter
    TokenBucket,
    RateLimiter,

    // Key Manager
    KeyManager,

    // Stats
    StatsAggregator,

    // Request Handler
    RequestHandler,
    RequestQueue,

    // Proxy Server
    ProxyServer,
    startProxy,
    startMaster,
    startWorker,

    // History Tracker
    HistoryTracker,

    // Latency Histogram (#4)
    LatencyHistogram,
    GlobalHistogramAggregator,
    DEFAULT_BUCKETS,

    // Cost Tracker (#6)
    CostTracker,
    DEFAULT_RATES,
    ALERT_THRESHOLDS,

    // Webhook Manager (#7)
    WebhookManager,
    EVENT_TYPES,

    // Request Store (#9)
    RequestStore,
    STORABLE_ERRORS,
    SENSITIVE_HEADERS,

    // Tenant Manager (#10)
    TenantManager,
    TenantContext,
    DEFAULT_TENANT_ID,

    // Admin Auth
    AdminAuth,
    generateToken,
    hashToken,
    secureCompare,

    // Drift Detector (Phase 12)
    DriftDetector,
    DRIFT_REASON_ENUM,

    // Schema exports (Phase 12)
    schemas,
    CounterRegistry,
    COUNTER_SCHEMA,
    COUNTER_LABELS
};
