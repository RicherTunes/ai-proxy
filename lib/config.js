/**
 * Configuration Module
 * Centralizes all configuration with environment variable overrides
 */

const path = require('path');
const fs = require('fs');
const { ProviderRegistry } = require('./provider-registry');

const DEFAULT_CONFIG = {
    // Server
    port: 18765,
    host: '127.0.0.1',

    // Target API
    targetHost: 'api.z.ai',
    targetBasePath: '/api/anthropic',
    targetProtocol: 'https:',

    // Multi-provider configuration (null = single-provider mode using global target)
    providers: null,

    // Model Mapping (Claude -> GLM)
    // Maps Claude model names to z.ai GLM equivalents
    // Concurrency limits per model (per-account, NOT per-key — stress-tested 2026-02-17):
    //   glm-5: 1 | glm-4.7: 10 | glm-4.6: 8
    //   glm-4.5: 10 | glm-4.5-air: 10
    //   glm-4.7-flash: 1 (free) | glm-4.5-flash: 2 (free)
    // Unavailable on Coding Plan (error 1113): glm-4-plus, glm-4.5-airx, glm-4.7-flashx, glm-4.5-x
    // Invalid model IDs (error 1211): glm-4.32b-0414-128k, glm-flash
    modelMapping: {
        enabled: true,
        models: {
            // Opus -> GLM 4.7 (flagship fallback when routing is disabled)
            'claude-opus-4-6': 'glm-4.7',
            'claude-opus-4-5-20251101': 'glm-4.7',
            'claude-opus-4-20250514': 'glm-4.7',
            // Sonnet -> GLM 4.5 (balanced, 5 concurrent for better parallelism)
            'claude-sonnet-4-5-20250929': 'glm-4.5',
            'claude-sonnet-4-20250514': 'glm-4.5',
            // Haiku -> GLM 4.5 Air (5 concurrent, handles burst traffic well)
            'claude-haiku-4-5-20251001': 'glm-4.5-air',
            'claude-3-5-haiku-20241022': 'glm-4.5-air',
            // Legacy models
            'claude-3-5-sonnet-20241022': 'glm-4.5',
            'claude-3-opus-20240229': 'glm-4.7',
            'claude-3-sonnet-20240229': 'glm-4.5',
            'claude-3-haiku-20240307': 'glm-4.5-air'
        },
        // Default model if no mapping found (null = pass through unchanged)
        defaultModel: null,
        // Log model transformations
        logTransformations: true
    },

    // Model Routing (complexity-aware routing layer above model mapping)
    modelRouting: {
        enabled: true,   // Enable model routing with fallback chains for 429/capacity resilience
        defaultModel: null,  // Fallback if classifier has no match (null = defer to legacy)

        tiers: {
            light: {
                // Removed: glm-4-plus (error 1113), glm-4.7-flashx (error 1113)
                models: ['glm-4.5-air', 'glm-4.5-flash', 'glm-4.7-flash'],
                strategy: 'throughput',
                clientModelPolicy: 'rule-match-only'
            },
            medium: {
                // Removed: glm-4.5-airx (error 1113 on Coding Plan)
                models: ['glm-4.5'],
                strategy: 'balanced',
                clientModelPolicy: 'rule-match-only'
            },
            heavy: {
                // Prefer the newest heavy model when available; fall back when the single slot is busy or cooled down.
                models: ['glm-5', 'glm-4.7', 'glm-4.6'],
                strategy: 'quality',
                clientModelPolicy: 'rule-match-only'  // Only explicit rules can route to heavy (prevents classifier promoting unknown models)
            }
        },

        // Rule-based routing (evaluated in order, first match wins)
        // Maps incoming claude-* model names to tiers for proper router activation
        rules: [
            // Opus → always heavy
            { match: { model: 'claude-opus*' }, tier: 'heavy' },
            { match: { model: 'claude-3-opus*' }, tier: 'heavy' },

            // Model family defaults (opus=heavy, sonnet=medium, haiku=light)
            { match: { model: 'claude-sonnet*' }, tier: 'medium' },
            { match: { model: 'claude-3-sonnet*' }, tier: 'medium' },
            { match: { model: 'claude-3-5-sonnet*' }, tier: 'medium' },
            { match: { model: 'claude-haiku*' }, tier: 'light' },
            { match: { model: 'claude-3-haiku*' }, tier: 'light' },
            { match: { model: 'claude-3-5-haiku*' }, tier: 'light' },
            { match: { model: 'claude-instant*' }, tier: 'light' },

            // Catch-all: unknown models default to medium (prevents classifier from promoting to heavy)
            { match: {}, tier: 'medium' }
        ],

        // Classifier thresholds (for body feature extraction)
        classifier: {
            heavyThresholds: {
                maxTokensGte: 4096,
                systemLengthGte: 2000,
                messageCountGte: 20,
                hasTools: true,
                hasVision: true
            },
            lightThresholds: {
                maxTokensLte: 512,
                messageCountLte: 3
            }
        },

        // Per-model cooldown tracking
        cooldown: {
            defaultMs: 5000,
            maxMs: 30000,
            decayMs: 60000,
            backoffMultiplier: 2,
            maxCooldownEntries: 50,
            burstDampeningFactor: 0.5
        },

        // Failover / fallback chain
        failover: {
            maxModelSwitchesPerRequest: 3,  // Max model switches on retry (allows trying all heavy-tier candidates)

            // Early give-up: stop cascading when tier is clearly saturated.
            // Window must accommodate upstream 429 response latency (api.z.ai takes 3-6s to return 429).
            // With 3s window, most requests never get a retry. 15s allows 2 full retry cycles.
            // Admission hold time is excluded (line 898-899 shifts retryLoopStartTime).
            max429AttemptsPerRequest: 3,     // Max 429 retries before giving up (separate from maxRetries)
            max429RetryWindowMs: 15000,      // Max wall-clock time in 429 retry loop (was 3000 — too tight for 3-6s upstream latency)

            // Cross-tier downgrade: fall back to lower tier when current tier is exhausted.
            // Off by default to avoid silent quality changes. Shadow telemetry always active.
            allowTierDowngrade: false,
            downgradeOrder: ['medium', 'light'],  // Tiers to try when current tier is exhausted
            maxTierDowngradesPerRequest: 1         // Max tier downgrades per request
        },

        // Observability
        logDecisions: true,

        // Persistence (relative to configDir)
        overridesFile: 'model-routing-overrides.json',

        // Config persistence (enabled by default — saves to configFile on disk)
        persistConfigEdits: true,
        configFile: 'model-routing.json',

        maxOverrides: 100,

        // Pool 429 penalty: sliding window counter for per-model 429 rate scoring.
        // Separate from cooldown entries — always increments on every upstream 429.
        pool429Penalty: {
            enabled: true,               // On by default (safe: only affects scoring, not availability)
            windowMs: 120000,            // 2-minute sliding window
            penaltyWeight: 0.5,          // Same formula: 1/(1 + count * weight). Higher = harsher.
            maxPenaltyHits: 20,          // Cap penalty at this many hits (prevent score going to 0)
            maxModels: 50,               // Max tracked models (evicts oldest-inactive when exceeded)
        },

        // GLM-5 safe launch (Phase 08)
        glm5: {
            enabled: true,           // GLM5-02: Enable/disable GLM-5 preference
            preferencePercent: 0,    // GLM5-07: Staged rollout (0 = shadow only)
        },
        // Complexity upgrade telemetry (GLM5-03)
        // Tracks WHY a request was upgraded to heavy tier (via scoped rules).
        // Actual upgrades are driven by scoped rules above; this is telemetry-only.
        complexityUpgrade: {
            enabled: false,          // Disabled: tier determined by model family (opus=heavy, sonnet=medium, haiku=light)
            allowedFamilies: ['claude-sonnet', 'claude-opus'],     // Telemetry: only track upgrades for Sonnet/Opus
            thresholds: {
                maxTokensGte: 4096,
                messageCountGte: 20,
                systemLengthGte: 2000,
                hasTools: true,
                hasVision: true
            }
        },

        // Transient context overflow retries: when 200K-context models are
        // temporarily unavailable (at capacity or cooled down), retry instead
        // of returning an immediate 400.  Off by default for safe canary rollout.
        transientOverflowRetry: {
            enabled: false              // Set true to enable 503+retry for transient overflows
        },

        // TRUST-03: Decision trace sampling for controlling SSE/log volume
        trace: {
            maxPayloadSize: 100000,     // Max trace payload size in bytes (100KB default)
            samplingRate: 10            // 0-100 percent of decisions to include traces (10% default)
        }
    },

    // Cluster mode - DISABLED BY DEFAULT for safety
    // When enabled, each worker has its own key scheduler + circuit breaker,
    // which can violate per-key concurrency limits across workers.
    // Dashboard/stats also show "random worker view" instead of aggregated data.
    // Enable only if you understand these limitations and have configured
    // master-side aggregation properly.
    maxWorkers: 4,
    useCluster: false,

    // Cluster worker persistence controls (Milestone 6)
    // When cluster mode is enabled, workers should NOT write persistent data
    // Only the master process should persist stats, history, costs, and request store
    clusterWorkerPersistence: {
        statsEnabled: false,        // Workers don't persist stats
        historyEnabled: false,      // Workers don't persist history
        costEnabled: false,         // Workers don't persist cost data
        requestStoreEnabled: false  // Workers don't persist request store
    },

    // Retries
    maxRetries: 3,

    // Retry Configuration (moved from request-handler for runtime configurability)
    retryConfig: {
        baseDelayMs: 100,          // Initial delay before first retry
        maxDelayMs: 30000,         // Maximum delay between retries (30s for rate limits)
        backoffMultiplier: 2,      // Exponential backoff factor
        jitterPercent: 0.2         // Random jitter to prevent thundering herd
    },

    // Circuit Breaker
    circuitBreaker: {
        failureThreshold: 5,      // failures to open circuit
        failureWindow: 30000,     // 30 seconds window
        cooldownPeriod: 60000,    // 60 seconds before half-open
        halfOpenTimeout: 10000    // timeout for test request
    },

    // Concurrency (per-model gate enforces upstream model limits, per-key is a safety net)
    // Z.AI limits are per-account (not per-key). concurrencyMultiplier=1.
    // Total model capacity: glm-5(1)+glm-4.7(10)+glm-4.6(8)+glm-4.5(10)+glm-4.5-air(10)+flash(3)=42
    maxConcurrencyPerKey: 5,
    maxTotalConcurrency: 200,     // Backpressure limit

    // Request Queue (handles bursts when all keys at capacity)
    queueSize: 100,               // Max requests to queue
    queueTimeout: 30000,          // Max wait time in queue (ms)

    // Rate Limiting (per key)
    rateLimitPerMinute: 60,       // requests per minute per key (0 = disabled)
    rateLimitBurst: 10,           // allow burst above limit

    // Timeouts (ms)
    requestTimeout: 300000,       // 5 minutes (max timeout cap)
    keepAliveTimeout: 120000,     // 2 minutes
    freeSocketTimeout: 8000,      // 8 seconds (was 15s - lowered to prevent socket hangups from stale idle sockets)

    // Adaptive Timeout Configuration (tuned for China-based API with high latency variance)
    adaptiveTimeout: {
        enabled: true,            // Use adaptive timeouts based on key latency
        initialMs: 90000,         // 90s for first attempt (China latency can be high)
        maxMs: 120000,            // 2min absolute cap
        minMs: 45000,             // 45s minimum (China network latency)
        retryMultiplier: 1.5,     // Increase timeout 50% per retry
        // Multiplier applied to P95 latency to compute adaptive timeout.
        // Set to 4.0 to accommodate China-based API routing where network
        // variance is high (3-5x normal). Lower values (2.0) suit US/EU endpoints.
        latencyMultiplier: 4.0,   // timeout = P95 * 4.0 (extra headroom for China variance)
        minSamples: 3             // Need 3 samples before using latency-based (faster warmup)
    },

    // Adaptive Concurrency (AIMD) — dynamically adjusts per-model concurrency limits
    // based on upstream 429 feedback. Start in observe_only mode for safe rollout.
    adaptiveConcurrency: {
        enabled: true,
        mode: 'observe_only',        // 'observe_only' | 'enforce'
        tickIntervalMs: 2000,        // Adjust window every 2s (not per-request)
        decreaseFactor: 0.5,         // Multiplicative decrease: x0.5 on congestion tick
        recoveryDelayMs: 5000,       // Wait 5s after last 429 before growing
        minWindow: 1,                // Floor: never below 1
        growthCleanTicks: 2,         // Require 2 consecutive clean ticks before +1
        growthMode: 'fixed_ticks',   // 'fixed_ticks' | 'proportional'
        minHoldMs: 4000,             // Minimum time between any two adjustments
        idleTimeoutMs: 300000,       // 5 min no traffic → reset toward static
        idleDecayStep: 1,            // +1 toward static per tick when idle
        quotaRetryAfterMs: 60000,    // retry-after >60s = quota issue
        treatUnknownAsCongestion: true,
        globalMaxConcurrency: 0      // 0 = disabled (sum of effective limits across all models)
    },

    // z.ai Account Usage Monitoring — polls subscription quota and per-model usage
    usageMonitor: {
        enabled: true,
        pollIntervalMs: 60000,        // Poll every 60s
        timeoutMs: 10000,             // 10s timeout per API call (24h per poll, backfill in chunks)
        jitterRatio: 0.1,             // Add 0-10% random jitter to poll cadence to avoid sync spikes
        maxJitterMs: 2000,            // Absolute jitter cap
        backoffMultiplier: 2,         // Exponential backoff factor after repeated full failures
        backoffIntervalMs: 300000,    // 5min after consecutive failures
        maxConsecutiveErrors: 5,      // errors before backoff
        exposeDetails: false,         // false = top-N summary; true = full detail
        lookbackDays: 30,             // How far back to fetch usage history (max ~30 days)
        maxTimeSeriesPoints: 10000,   // Hard cap for model/tool usage series retained in memory
        persistFile: 'usage-cache.json', // Cache file for surviving restarts
        anomaly: {
            enabled: true,
            rateJumpThreshold: 2.5,       // z-score σ threshold
            staleFeedThresholdMs: 300000,  // 5 min
            quotaWarningThresholds: [0.8, 0.95],
            minDataPoints: 6,
            cooldownMs: 3600000            // 1 hour between same alert type
        }
    },

    // Intelligent Key Selection
    keySelection: {
        useWeightedSelection: true,   // Use health-score weighted selection vs round-robin
        healthScoreWeights: {
            latency: 40,              // Weight for latency score (0-40 points)
            successRate: 40,          // Weight for success rate (0-40 points)
            errorRecency: 20          // Weight for error recency (0-20 points)
        },
        slowKeyThreshold: 2.0,        // Mark key as slow if P50 > 2x pool average
        slowKeyCheckIntervalMs: 30000, // Check for slow keys every 30s
        slowKeyCooldownMs: 300000     // Don't re-warn about slow key for 5min
    },

    // Connection Health Monitoring
    connectionHealth: {
        maxConsecutiveHangups: 5,     // Recreate agent after 5 consecutive hangups
        agentRecreationCooldownMs: 60000  // Min time between agent recreations
    },

    // Pool Cooldown Policy (for global 429 bursts)
    // When multiple keys hit 429 in quick succession, the pool enters cooldown
    poolCooldown: {
        sleepThresholdMs: 1500,       // Absorb cooldowns ≤1.5s instead of failing to client
        retryJitterMs: 150,           // Jitter for retry timing
        maxCooldownMs: 10000,         // Max inline sleep / Retry-After sent to client (10s)
        baseMs: 300,                  // Initial cooldown per pool hit
        capMs: 15000,                 // Max pool cooldown duration (15s) - must be high enough for persistent upstream throttling
        decayMs: 15000                // Decay backoff counter after 15s of quiet (slow enough to sustain backoff under sustained 429s)
    },

    // Tier-aware admission hold (v1)
    // Hold requests when ALL models in a tier are in cooldown, instead of
    // sending to a guaranteed-429 upstream. Sleep on cooldown, not polling.
    admissionHold: {
        enabled: false,              // Opt-in (set true to activate)
        tiers: ['heavy'],            // Which tiers can hold (default: heavy only)
        maxHoldMs: 15000,            // Max hold before returning 429 (15s)
        maxConcurrentHolds: 20,      // Global cap — reject above this
        jitterMs: 100,               // Stagger wakeup to prevent thundering herd
        minCooldownToHold: 500,      // Only hold if tier cooldown > 500ms
    },

    // Proactive rate limit pacing
    // Uses x-ratelimit-remaining headers to slow down before hitting 429s
    proactivePacing: {
        enabled: true,
        remainingThreshold: 15,       // Start pacing when remaining requests < 15
        pacingDelayMs: 500             // Max delay per request when pacing
    },

    // Per-key cooldown decay (reset escalated cooldowns after quiet period)
    keyRateLimitCooldown: {
        cooldownDecayMs: 30000,       // 30s without 429 → reset escalation
        baseCooldownMs: 1000          // Reset target (1s base cooldown)
    },

    // Account-level 429 detection (multiple keys rate-limited simultaneously)
    accountLevelDetection: {
        enabled: true,
        keyThreshold: 3,              // 3+ unique keys hitting 429 → account-level
        windowMs: 5000,               // Within 5 seconds
        cooldownMs: 10000             // 10s account-level cooldown
    },

    // Body limits
    maxBodySize: 10 * 1024 * 1024, // 10MB

    // Graceful shutdown
    shutdownTimeout: 30000,       // 30 seconds to drain connections

    // Stats
    statsSaveInterval: 60000,     // Save persistent stats every 60s

    // Logging
    logLevel: 'INFO',             // DEBUG, INFO, WARN, ERROR
    logFormat: 'text',            // text or json

    // File paths
    configDir: path.join(__dirname, '..'),
    keysFile: 'api-keys.json',
    statsFile: 'persistent-stats.json',

    // Hot Reload (file watcher for keys changes)
    enableHotReload: true,           // Set false in tests to prevent race conditions

    // Latency Histogram (#4)
    histogram: {
        enabled: true,
        buckets: [0, 100, 500, 1000, 2000, 5000, 10000, 30000, 60000, 120000],
        maxDataPoints: 10000
    },

    // Cost Tracking (#6)
    costTracking: {
        enabled: true,
        rates: {
            inputTokenPer1M: 3.00,   // $3.00 per 1M input tokens
            outputTokenPer1M: 15.00  // $15.00 per 1M output tokens
        },
        budget: {
            daily: null,     // No daily limit by default
            monthly: null,   // No monthly limit by default
            alertThresholds: [0.5, 0.8, 0.95, 1.0]
        },
        persistPath: 'cost-data.json'
    },

    // Request Tracing (#3)
    requestTracing: {
        enabled: true,
        maxTraces: 1000,
        captureBody: false,  // Privacy opt-in
        maxBodyPreview: 1024,
        excludePaths: ['/health', '/stats']
    },

    // On-demand request payload capture for dashboard side panel.
    // Full payloads are stored in-memory only (sanitized + TTL-bounded).
    requestPayload: {
        maxEntries: 200,
        retentionMs: 900000   // 15 minutes
    },

    // Webhooks (#7)
    webhooks: {
        enabled: false,
        endpoints: [],       // Array of { url, secret, events, name }
        maxRetries: 3,
        retryDelayMs: 1000,
        timeoutMs: 10000,
        errorSpikeThreshold: 10,
        errorSpikeWindow: 60000,
        dedupeWindowMs: 60000
    },

    // Request Store / Replay (#9)
    requestStore: {
        enabled: false,
        storeFile: 'failed-requests.json',
        maxRequests: 1000,
        ttlHours: 24,
        storeBodySizeLimit: 1048576,  // 1MB
        errorTypesToStore: ['timeout', 'server_error', 'socket_hangup']
    },

    // Multi-tenant Support (#10)
    multiTenant: {
        enabled: false,
        tenantHeader: 'x-tenant-id',
        defaultTenantId: 'default',
        strictMode: false,      // Reject unknown tenants
        isolateStats: true      // Separate stats per tenant
    },

    // Telemetry Handling
    // Event logging/telemetry requests can steal capacity from LLM calls
    // Options: 'drop' (return 204, don't forward), 'passthrough' (forward normally)
    telemetry: {
        mode: 'drop',           // 'drop' or 'passthrough'
        paths: ['/api/event_logging'],  // Paths to match (prefix match)
        dropResponse: { status: 204 }   // Response when dropping
    },

    // Admin Authentication
    adminAuth: {
        enabled: false,
        headerName: 'x-admin-token',
        tokens: [],             // Array of admin tokens
        // Protected endpoints - these require authentication when enabled
        // Mutations (POST/PUT/PATCH/DELETE) on these paths are always gated
        // Some GET endpoints are also gated for sensitive data
        protectedPaths: [
            '/control/',       // All control operations (pause, resume, reset, circuit, shutdown)
            '/reload',         // Hot reload keys
            '/logs',           // Log access (can expose sensitive info)
            '/audit-log',      // Security audit log (always sensitive)
            '/replay/',        // Request replay functionality
            '/webhooks',       // Webhook management
            '/tenants',        // Tenant management
            '/model-mapping',  // Model mapping configuration
            '/model-routing',  // Model routing configuration
            '/model-selection', // Model selection configuration
            '/requests',       // Request tracing (can expose sensitive data)
            '/admin/cost-tracking'  // Cost tracking configuration and metrics
        ]
    },

    // Security settings for production hardening
    security: {
        // Security mode: "local" (default) or "internet"
        // - "local": Dashboard readable without auth, mutations require auth
        // - "internet": Everything requires auth, stricter rate limits, all headers
        mode: 'local',

        // CORS configuration for SSE and API endpoints
        cors: {
            // Default: same-origin only (no CORS headers sent)
            // Set to ['*'] for development or specify allowed origins
            allowedOrigins: [],  // Empty = same-origin only (secure default)
            // Examples:
            // ['http://localhost:3000'] - specific origin
            // ['https://dashboard.example.com'] - production dashboard
            // ['*'] - allow all (NOT recommended for production)
        },

        // Rate limiting for dashboard/SSE (per IP)
        rateLimit: {
            enabled: true,
            // Dashboard page requests per minute per IP
            dashboardRpm: 300,
            // SSE connections per IP (concurrent)
            maxSsePerIp: 5,
            // Max total SSE clients
            maxSseTotal: 100,
            // API requests per minute per IP (for /stats, /logs, etc.)
            // Worst-case: ~114 req/min with all poll families active (12 families, no leaks)
            apiRpm: 180
        },

        // Security headers for dashboard responses
        headers: {
            // Content-Security-Policy (already have)
            csp: "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
            // Permissions-Policy (restrict browser features)
            permissionsPolicy: 'camera=(), microphone=(), geolocation=(), payment=()',
            // X-Frame-Options (legacy, backup for frame-ancestors)
            xFrameOptions: 'DENY',
            // X-Content-Type-Options
            xContentTypeOptions: 'nosniff',
            // Referrer-Policy
            referrerPolicy: 'strict-origin-when-cross-origin'
        },

        // Endpoints requiring auth in "internet" mode (read-only in "local" mode)
        internetModeProtectedReads: [
            '/dashboard',
            '/requests/stream',
            '/logs',
            '/stats',
            '/stats/cost',
            '/stats/latency-histogram',
            '/model-mapping',
            '/compare',
            '/predictions'
        ],

        // Debug endpoints ALWAYS require auth (sensitive even on LAN)
        // These expose internal state that could aid attacks
        debugEndpointsAlwaysRequireAuth: true,
        debugEndpoints: [
            '/debug/',
            '/health/deep',
            '/traces'
        ],

        // Rate limiting specifically for debug endpoints (per IP)
        debugRateLimit: {
            enabled: true,
            // Max requests per minute per IP to debug endpoints
            rpm: 30,
            // Burst allowance
            burst: 5
        },

        // Debug exports (window.__DASHBOARD_*)
        // Only enabled when ?debug=1 query param is present
        // Set to true to always enable (NOT recommended for production)
        debugExportsAlwaysEnabled: false,

        // Audit logging for sensitive operations
        auditLog: {
            enabled: true,
            // Log model mapping changes
            modelMappingChanges: true,
            // Log control actions (pause, resume, circuit changes)
            controlActions: true,
            // Log auth failures
            authFailures: true,
            // Max entries to keep in memory (also written to file)
            maxEntries: 1000,
            // File path for audit log (null = memory only)
            filePath: null
        },

        // Trusted proxy IPs for X-Forwarded-For processing
        // Only exact IP match (no CIDR). Add your reverse proxy IPs here.
        trustedProxies: ['127.0.0.1', '::1', '::ffff:127.0.0.1'],

        // Model Discovery - Dynamic model list for frontend
        modelDiscovery: {
            enabled: true,
            ttl: 300000,              // Cache TTL in ms (5 minutes)
            verifyEnabled: false,     // Verify models with upstream (no z.ai endpoint)
            customModels: []          // User-defined models: [{ id, name, tier, description }]
        }
    }
};

class Config {
    constructor(overrides = {}) {
        this.config = { ...DEFAULT_CONFIG };
        this._loadErrors = [];  // Store errors for later logging
        this._applyOverrides(overrides);
        this._applyEnvOverrides();
        this._loadApiKeys();
        this._initializeProviderRegistry();
        this._initializeModelMappingManager();
        this._validate();
    }

    /**
     * Validate configuration values
     * @throws {Error} If any config values are invalid
     */
    _validate() {
        const errors = [];

        // Server (port 0 is valid: OS assigns a random available port)
        if (!Number.isFinite(this.config.port) || this.config.port < 0 || this.config.port > 65535) {
            errors.push(`Invalid port: ${this.config.port} (must be 0-65535)`);
        }

        // Concurrency
        if (!Number.isFinite(this.config.maxConcurrencyPerKey) || this.config.maxConcurrencyPerKey < 1) {
            errors.push(`Invalid maxConcurrencyPerKey: ${this.config.maxConcurrencyPerKey} (must be >= 1)`);
        }
        if (!Number.isFinite(this.config.maxTotalConcurrency) || this.config.maxTotalConcurrency < 0) {
            errors.push(`Invalid maxTotalConcurrency: ${this.config.maxTotalConcurrency} (must be >= 0)`);
        }

        // Timeouts (must be positive finite numbers)
        const timeoutFields = ['requestTimeout', 'keepAliveTimeout', 'freeSocketTimeout', 'queueTimeout'];
        for (const field of timeoutFields) {
            if (this.config[field] !== undefined && (!Number.isFinite(this.config[field]) || this.config[field] < 0)) {
                errors.push(`Invalid ${field}: ${this.config[field]} (must be a positive number)`);
            }
        }

        // Circuit breaker
        const cb = this.config.circuitBreaker;
        if (cb) {
            if (!Number.isFinite(cb.failureThreshold) || cb.failureThreshold < 1) {
                errors.push(`Invalid circuitBreaker.failureThreshold: ${cb.failureThreshold} (must be >= 1)`);
            }
            if (!Number.isFinite(cb.cooldownPeriod) || cb.cooldownPeriod < 0) {
                errors.push(`Invalid circuitBreaker.cooldownPeriod: ${cb.cooldownPeriod} (must be >= 0)`);
            }
        }

        // Retries
        if (!Number.isFinite(this.config.maxRetries) || this.config.maxRetries < 0) {
            errors.push(`Invalid maxRetries: ${this.config.maxRetries} (must be >= 0)`);
        }

        // Queue
        if (!Number.isFinite(this.config.queueSize) || this.config.queueSize < 0) {
            errors.push(`Invalid queueSize: ${this.config.queueSize} (must be >= 0)`);
        }

        // TRUST-03: Clamp trace sampling rate to 0-100
        if (this.config.modelRouting?.trace?.samplingRate !== undefined) {
            const rate = this.config.modelRouting.trace.samplingRate;
            if (rate < 0) {
                this.config.modelRouting.trace.samplingRate = 0;
            } else if (rate > 100) {
                this.config.modelRouting.trace.samplingRate = 100;
            }
        }

        if (errors.length > 0) {
            throw new Error(`Configuration validation failed:\n  - ${errors.join('\n  - ')}`);
        }
    }

    _applyOverrides(overrides) {
        for (const [key, value] of Object.entries(overrides)) {
            if (typeof value === 'object' && !Array.isArray(value) && this.config[key]) {
                this.config[key] = { ...this.config[key], ...value };
            } else {
                this.config[key] = value;
            }
        }
    }

    _applyEnvOverrides() {
        const envMappings = {
            'GLM_PORT': { key: 'port', type: 'int' },
            'GLM_HOST': { key: 'host', type: 'string' },
            'GLM_TARGET_HOST': { key: 'targetHost', type: 'string' },
            'GLM_MAX_WORKERS': { key: 'maxWorkers', type: 'int' },
            'GLM_NO_CLUSTER': { key: 'useCluster', type: 'bool', invert: true },
            'GLM_MAX_RETRIES': { key: 'maxRetries', type: 'int' },
            'GLM_CIRCUIT_THRESHOLD': { key: 'circuitBreaker.failureThreshold', type: 'int' },
            'GLM_CIRCUIT_WINDOW': { key: 'circuitBreaker.failureWindow', type: 'int' },
            'GLM_CIRCUIT_COOLDOWN': { key: 'circuitBreaker.cooldownPeriod', type: 'int' },
            'GLM_MAX_CONCURRENCY_PER_KEY': { key: 'maxConcurrencyPerKey', type: 'int' },
            'GLM_MAX_TOTAL_CONCURRENCY': { key: 'maxTotalConcurrency', type: 'int' },
            'GLM_QUEUE_SIZE': { key: 'queueSize', type: 'int' },
            'GLM_QUEUE_TIMEOUT': { key: 'queueTimeout', type: 'int' },
            'GLM_RATE_LIMIT': { key: 'rateLimitPerMinute', type: 'int' },
            'GLM_REQUEST_TIMEOUT': { key: 'requestTimeout', type: 'int' },
            'GLM_MAX_BODY_SIZE': { key: 'maxBodySize', type: 'int' },
            // Adaptive timeout
            'GLM_ADAPTIVE_TIMEOUT': { key: 'adaptiveTimeout.enabled', type: 'bool' },
            'GLM_INITIAL_TIMEOUT': { key: 'adaptiveTimeout.initialMs', type: 'int' },
            'GLM_MAX_TIMEOUT': { key: 'adaptiveTimeout.maxMs', type: 'int' },
            'GLM_MIN_TIMEOUT': { key: 'adaptiveTimeout.minMs', type: 'int' },
            // Key selection
            'GLM_USE_WEIGHTED_SELECTION': { key: 'keySelection.useWeightedSelection', type: 'bool' },
            'GLM_SLOW_KEY_THRESHOLD': { key: 'keySelection.slowKeyThreshold', type: 'float' },
            // Connection health
            'GLM_MAX_CONSECUTIVE_HANGUPS': { key: 'connectionHealth.maxConsecutiveHangups', type: 'int' },
            // Pool cooldown
            'GLM_POOL_COOLDOWN_SLEEP_THRESHOLD': { key: 'poolCooldown.sleepThresholdMs', type: 'int' },
            'GLM_POOL_COOLDOWN_JITTER': { key: 'poolCooldown.retryJitterMs', type: 'int' },
            'GLM_POOL_COOLDOWN_MAX': { key: 'poolCooldown.maxCooldownMs', type: 'int' },
            'GLM_POOL_COOLDOWN_BASE': { key: 'poolCooldown.baseMs', type: 'int' },
            'GLM_POOL_COOLDOWN_CAP': { key: 'poolCooldown.capMs', type: 'int' },
            'GLM_POOL_COOLDOWN_DECAY': { key: 'poolCooldown.decayMs', type: 'int' },
            // Admission hold
            'GLM_ADMISSION_HOLD_ENABLED': { key: 'admissionHold.enabled', type: 'bool' },
            'GLM_ADMISSION_HOLD_MAX_MS': { key: 'admissionHold.maxHoldMs', type: 'int' },
            'GLM_ADMISSION_HOLD_MAX_CONCURRENT': { key: 'admissionHold.maxConcurrentHolds', type: 'int' },
            'GLM_LOG_LEVEL': { key: 'logLevel', type: 'string' },
            'GLM_LOG_FORMAT': { key: 'logFormat', type: 'string' },
            'GLM_KEYS_FILE': { key: 'keysFile', type: 'string' },
            'NO_CLUSTER': { key: 'useCluster', type: 'bool', invert: true },
            // New features (Phase 2-3)
            'GLM_HISTOGRAM_ENABLED': { key: 'histogram.enabled', type: 'bool' },
            'GLM_COST_ENABLED': { key: 'costTracking.enabled', type: 'bool' },
            'GLM_COST_DAILY_BUDGET': { key: 'costTracking.budget.daily', type: 'float' },
            'GLM_COST_MONTHLY_BUDGET': { key: 'costTracking.budget.monthly', type: 'float' },
            'GLM_TRACE_ENABLED': { key: 'requestTracing.enabled', type: 'bool' },
            'GLM_TRACE_CAPTURE_BODY': { key: 'requestTracing.captureBody', type: 'bool' },
            'GLM_REQUEST_PAYLOAD_MAX_ENTRIES': { key: 'requestPayload.maxEntries', type: 'int' },
            'GLM_REQUEST_PAYLOAD_RETENTION_MS': { key: 'requestPayload.retentionMs', type: 'int' },
            'GLM_WEBHOOKS_ENABLED': { key: 'webhooks.enabled', type: 'bool' },
            'GLM_REQUEST_STORE_ENABLED': { key: 'requestStore.enabled', type: 'bool' },
            'GLM_MULTI_TENANT': { key: 'multiTenant.enabled', type: 'bool' },
            'GLM_TENANT_HEADER': { key: 'multiTenant.tenantHeader', type: 'string' },
            'GLM_ADMIN_AUTH_ENABLED': { key: 'adminAuth.enabled', type: 'bool' },
            // Failover tuning
            'GLM_MAX_429_ATTEMPTS': { key: 'modelRouting.failover.max429AttemptsPerRequest', type: 'int' },
            'GLM_MAX_429_WINDOW_MS': { key: 'modelRouting.failover.max429RetryWindowMs', type: 'int' },
            'GLM_ALLOW_TIER_DOWNGRADE': { key: 'modelRouting.failover.allowTierDowngrade', type: 'bool' },
            // Pool 429 penalty
            'GLM_POOL_429_PENALTY_ENABLED': { key: 'modelRouting.pool429Penalty.enabled', type: 'bool' },
            'GLM_POOL_429_PENALTY_WINDOW_MS': { key: 'modelRouting.pool429Penalty.windowMs', type: 'int' },
            'GLM_POOL_429_PENALTY_WEIGHT': { key: 'modelRouting.pool429Penalty.penaltyWeight', type: 'float' },
            // GLM-5 config (Phase 08)
            'GLM_GLM5_ENABLED': { key: 'modelRouting.glm5.enabled', type: 'bool' },
            'GLM_GLM5_PREFERENCE_PERCENT': { key: 'modelRouting.glm5.preferencePercent', type: 'int' },
            // Complexity upgrade thresholds (Phase 08)
            'GLM_COMPLEXITY_UPGRADE_MAX_TOKENS_GTE': { key: 'modelRouting.complexityUpgrade.thresholds.maxTokensGte', type: 'int' },
            'GLM_COMPLEXITY_UPGRADE_MESSAGE_COUNT_GTE': { key: 'modelRouting.complexityUpgrade.thresholds.messageCountGte', type: 'int' },
            'GLM_COMPLEXITY_UPGRADE_SYSTEM_LENGTH_GTE': { key: 'modelRouting.complexityUpgrade.thresholds.systemLengthGte', type: 'int' },
            'GLM_COMPLEXITY_UPGRADE_HAS_TOOLS': { key: 'modelRouting.complexityUpgrade.thresholds.hasTools', type: 'bool' },
            'GLM_COMPLEXITY_UPGRADE_HAS_VISION': { key: 'modelRouting.complexityUpgrade.thresholds.hasVision', type: 'bool' },
            // Transient overflow retry
            'GLM_TRANSIENT_OVERFLOW_RETRY': { key: 'modelRouting.transientOverflowRetry.enabled', type: 'bool' },
            // Trace sampling (TRUST-03)
            'GLM_TRACE_SAMPLING_RATE': { key: 'modelRouting.trace.samplingRate', type: 'int' },
            // Trace payload size limit (TRUST-01)
            'GLM_TRACE_MAX_PAYLOAD_SIZE': { key: 'modelRouting.trace.maxPayloadSize', type: 'int' },
            // Adaptive concurrency mode
            'GLM_ADAPTIVE_CONCURRENCY_MODE': { key: 'adaptiveConcurrency.mode', type: 'string' }
        };

        for (const [envVar, mapping] of Object.entries(envMappings)) {
            const envValue = process.env[envVar];
            if (envValue !== undefined) {
                let value;
                switch (mapping.type) {
                    case 'int': {
                        const parsed = parseInt(envValue, 10);
                        if (isNaN(parsed)) continue;
                        value = parsed;
                        break;
                    }
                    case 'float': {
                        const parsed = parseFloat(envValue);
                        if (isNaN(parsed)) continue;
                        value = parsed;
                        break;
                    }
                    case 'bool':
                        value = envValue === '1' || envValue.toLowerCase() === 'true';
                        if (mapping.invert) value = !value;
                        break;
                    default:
                        value = envValue;
                }

                // Handle nested keys (supports arbitrary depth: a.b.c.d)
                if (mapping.key.includes('.')) {
                    const parts = mapping.key.split('.');
                    let target = this.config;
                    for (let i = 0; i < parts.length - 1; i++) {
                        if (target[parts[i]] === undefined || target[parts[i]] === null) {
                            target[parts[i]] = {};
                        }
                        target = target[parts[i]];
                    }
                    target[parts[parts.length - 1]] = value;
                } else {
                    this.config[mapping.key] = value;
                }
            }
        }
    }

    _loadApiKeys() {
        const keysPath = path.join(this.config.configDir, this.config.keysFile);
        try {
            const data = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
            this.config.apiKeys = data.keys || [];
            if (data.baseUrl) {
                // Extract host, path, and protocol from baseUrl if provided
                const url = new URL(data.baseUrl);
                this.config.targetHost = url.host;
                this.config.targetBasePath = url.pathname;
                this.config.targetProtocol = url.protocol;
            }
        } catch (err) {
            // Store error for later logging (logger not available during construction)
            this._loadErrors.push({
                type: 'api_keys',
                path: keysPath,
                message: err.message
            });
            this.config.apiKeys = [];
        }
    }

    /**
     * Get and clear any errors that occurred during config loading
     * Call this after logger is available to log any issues
     * @returns {Array} Array of error objects
     */
    flushLoadErrors() {
        const errors = [...this._loadErrors];
        this._loadErrors = [];
        return errors;
    }

    /**
     * Check if there were any load errors
     * @returns {boolean}
     */
    hasLoadErrors() {
        return this._loadErrors.length > 0;
    }

    reloadKeys() {
        this._loadApiKeys();
        return this.config.apiKeys;
    }

    /**
     * Initialize provider registry from config or default to z.ai
     * @private
     */
    _initializeProviderRegistry() {
        const providersConfig = this.config.providers;
        if (providersConfig) {
            this._providerRegistry = new ProviderRegistry(providersConfig);
        } else {
            this._providerRegistry = new ProviderRegistry({
                'z.ai': {
                    targetHost: this.config.targetHost,
                    targetBasePath: this.config.targetBasePath,
                    targetProtocol: this.config.targetProtocol,
                    authScheme: 'x-api-key',
                    costTier: 'free'
                }
            });
        }
        this.config._providerRegistry = this._providerRegistry;
    }

    /**
     * Get provider registry instance
     * @returns {ProviderRegistry}
     */
    get providerRegistry() {
        return this._providerRegistry;
    }

    /**
     * Initialize model mapping manager
     * @private
     */
    _initializeModelMappingManager() {
        this._modelMappingManager = new ModelMappingManager(this.config.modelMapping);
    }

    /**
     * Get model mapping manager instance
     * @returns {ModelMappingManager}
     */
    get modelMappingManager() {
        if (!this._modelMappingManager) {
            this._modelMappingManager = new ModelMappingManager(this.config.modelMapping);
        }
        return this._modelMappingManager;
    }

    get(key) {
        if (key.includes('.')) {
            const parts = key.split('.');
            let value = this.config;
            for (const part of parts) {
                value = value?.[part];
            }
            return value;
        }
        return this.config[key];
    }

    getAll() {
        return { ...this.config };
    }

    // Convenience getters
    get port() { return this.config.port; }
    get host() { return this.config.host; }
    get targetHost() { return this.config.targetHost; }
    get targetBasePath() { return this.config.targetBasePath; }
    get targetProtocol() { return this.config.targetProtocol; }
    get maxWorkers() { return this.config.maxWorkers; }
    get useCluster() { return this.config.useCluster; }
    get maxRetries() { return this.config.maxRetries; }
    get circuitBreaker() { return this.config.circuitBreaker; }
    get maxConcurrencyPerKey() { return this.config.maxConcurrencyPerKey; }
    get maxTotalConcurrency() { return this.config.maxTotalConcurrency; }
    get queueSize() { return this.config.queueSize; }
    get queueTimeout() { return this.config.queueTimeout; }
    get rateLimitPerMinute() { return this.config.rateLimitPerMinute; }
    get rateLimitBurst() { return this.config.rateLimitBurst; }
    get requestTimeout() { return this.config.requestTimeout; }
    get keepAliveTimeout() { return this.config.keepAliveTimeout; }
    get freeSocketTimeout() { return this.config.freeSocketTimeout; }
    get maxBodySize() { return this.config.maxBodySize; }
    get shutdownTimeout() { return this.config.shutdownTimeout; }
    get statsSaveInterval() { return this.config.statsSaveInterval; }
    get logLevel() { return this.config.logLevel; }
    get logFormat() { return this.config.logFormat; }
    get apiKeys() { return this.config.apiKeys; }
    get configDir() { return this.config.configDir; }
    get statsFile() { return this.config.statsFile; }
    get adaptiveTimeout() { return this.config.adaptiveTimeout; }
    get adaptiveConcurrency() { return this.config.adaptiveConcurrency; }
    get usageMonitor() { return this.config.usageMonitor; }
    get keySelection() { return this.config.keySelection; }
    get connectionHealth() { return this.config.connectionHealth; }
    get poolCooldown() { return this.config.poolCooldown; }
    get retryConfig() { return this.config.retryConfig; }
    get clusterWorkerPersistence() { return this.config.clusterWorkerPersistence; }
    // New feature getters
    get histogram() { return this.config.histogram; }
    get costTracking() { return this.config.costTracking; }
    get requestTracing() { return this.config.requestTracing; }
    get requestPayload() { return this.config.requestPayload; }
    get webhooks() { return this.config.webhooks; }
    get requestStore() { return this.config.requestStore; }
    get multiTenant() { return this.config.multiTenant; }
    get adminAuth() { return this.config.adminAuth; }
    get modelMapping() { return this.config.modelMapping; }
    get admissionHold() { return this.config.admissionHold; }
    get modelRouting() { return this.config.modelRouting; }
    get modelDiscovery() { return this.config.modelDiscovery; }
    get security() { return this.config.security; }
}

/**
 * Model Mapping Manager
 * Handles live model mapping with per-key overrides
 */
class ModelMappingManager {
    constructor(config = {}) {
        this.enabled = config.enabled || false;
        this.models = { ...config.models } || {};
        this.defaultModel = config.defaultModel || null;
        this.logTransformations = config.logTransformations !== false;
        this.keyOverrides = new Map(); // keyIndex -> { claudeModel: glmModel }
        // Statistics tracking
        this._stats = {
            totalTransformations: 0,
            bySourceModel: new Map() // claudeModel -> count
        };
    }

    /**
     * Get mapped model for a given Claude model and key index
     * @param {string} claudeModel - The Claude model name
     * @param {number} keyIndex - The API key index (for per-key overrides)
     * @returns {string|null} The mapped GLM model name, or original if no mapping
     */
    getMappedModel(claudeModel, keyIndex = null) {
        if (!this.enabled || !claudeModel) {
            return claudeModel;
        }

        let mappedModel = null;

        // Check per-key override first
        if (keyIndex !== null && this.keyOverrides.has(keyIndex)) {
            const overrides = this.keyOverrides.get(keyIndex);
            if (overrides[claudeModel]) {
                mappedModel = overrides[claudeModel];
            }
        }

        // Check global mapping
        if (!mappedModel && this.models[claudeModel]) {
            mappedModel = this.models[claudeModel];
        }

        // Use default if set
        if (!mappedModel && this.defaultModel) {
            mappedModel = this.defaultModel;
        }

        // If transformation occurred, track it
        if (mappedModel && mappedModel !== claudeModel) {
            this._stats.totalTransformations++;
            const currentCount = this._stats.bySourceModel.get(claudeModel) || 0;
            this._stats.bySourceModel.set(claudeModel, currentCount + 1);
            return mappedModel;
        }

        // Pass through unchanged
        return claudeModel;
    }

    /**
     * Set or update a per-key override
     * @param {number} keyIndex - The API key index
     * @param {string} claudeModel - The Claude model name
     * @param {string} glmModel - The GLM model name to map to
     *
     * Note: Per-key overrides are simple model ID string mappings (claudeModel -> glmModel).
     * They are NOT tier configs (targetModel, fallbackModels, etc.), so they do NOT require
     * normalization for NORM-08. This is already v2-compatible.
     */
    setKeyOverride(keyIndex, claudeModel, glmModel) {
        if (!this.keyOverrides.has(keyIndex)) {
            this.keyOverrides.set(keyIndex, {});
        }
        this.keyOverrides.get(keyIndex)[claudeModel] = glmModel;
    }

    /**
     * Clear a per-key override
     * @param {number} keyIndex - The API key index
     * @param {string} claudeModel - The Claude model name (optional, clears all if omitted)
     */
    clearKeyOverride(keyIndex, claudeModel = null) {
        if (!this.keyOverrides.has(keyIndex)) {
            return;
        }

        if (claudeModel) {
            delete this.keyOverrides.get(keyIndex)[claudeModel];
            // Remove entry if empty
            if (Object.keys(this.keyOverrides.get(keyIndex)).length === 0) {
                this.keyOverrides.delete(keyIndex);
            }
        } else {
            this.keyOverrides.delete(keyIndex);
        }
    }

    /**
     * Update global mapping configuration
     * @param {Object} mapping - New mapping configuration
     */
    updateGlobalMapping(mapping) {
        if (mapping.models) {
            this.models = { ...mapping.models };
        }
        if (mapping.defaultModel !== undefined) {
            this.defaultModel = mapping.defaultModel;
        }
        if (mapping.enabled !== undefined) {
            this.enabled = mapping.enabled;
        }
        if (mapping.logTransformations !== undefined) {
            this.logTransformations = mapping.logTransformations;
        }
    }

    /**
     * Reset to default configuration
     * @param {Object} defaults - Default configuration to reset to
     */
    resetToDefaults(defaults = {}) {
        this.enabled = defaults.enabled !== false;
        this.models = { ...defaults.models } || {};
        this.defaultModel = defaults.defaultModel || null;
        this.logTransformations = defaults.logTransformations !== false;
        this.keyOverrides.clear();
        // Clear stats when resetting to defaults
        this.resetStats();
    }

    /**
     * Export current configuration
     * @returns {Object} Current configuration
     */
    toConfig() {
        return {
            enabled: this.enabled,
            models: { ...this.models },
            defaultModel: this.defaultModel,
            logTransformations: this.logTransformations,
            stats: this.getStats()
        };
    }

    /**
     * Get all per-key overrides
     * @returns {Object} Map of keyIndex to overrides
     */
    getKeyOverrides() {
        const result = {};
        for (const [keyIndex, overrides] of this.keyOverrides.entries()) {
            result[keyIndex] = { ...overrides };
        }
        return result;
    }

    /**
     * Get override for specific key
     * @param {number} keyIndex - The API key index
     * @returns {Object|null} Override mapping or null
     */
    getKeyOverride(keyIndex) {
        if (this.keyOverrides.has(keyIndex)) {
            return { ...this.keyOverrides.get(keyIndex) };
        }
        return null;
    }

    /**
     * Get transformation statistics
     * @returns {Object} Statistics object with totalTransformations and bySourceModel
     */
    getStats() {
        // Convert Map to plain object for serialization
        const bySourceModelObj = {};
        for (const [model, count] of this._stats.bySourceModel.entries()) {
            bySourceModelObj[model] = count;
        }

        return {
            totalTransformations: this._stats.totalTransformations,
            bySourceModel: bySourceModelObj
        };
    }

    /**
     * Reset transformation statistics
     */
    resetStats() {
        this._stats.totalTransformations = 0;
        this._stats.bySourceModel.clear();
    }
}

// Singleton instance
let instance = null;

function getConfig(overrides) {
    if (!instance || overrides) {
        instance = new Config(overrides);
    }
    return instance;
}

function resetConfig() {
    instance = null;
}

module.exports = {
    Config,
    ModelMappingManager,
    getConfig,
    resetConfig,
    DEFAULT_CONFIG
};
