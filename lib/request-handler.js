/**
 * Request Handler Module
 * Handles proxying requests with retry logic, error handling, and stats tracking
 *
 * Features:
 * - Iterative retry loop (no recursion/stack overflow)
 * - Exponential backoff between retries
 * - Promise timeout protection (prevents hanging)
 * - Secure logging (no key data exposed)
 */

const https = require('https');
const http = require('http');
const { generateRequestId } = require('./logger');
const { RequestQueue } = require('./request-queue');
const { EventEmitter } = require('events');
const { RequestTrace, TraceStore, SpanType } = require('./request-trace');
const { DEFAULT_CONFIG } = require('./config');
const { categorizeError } = require('./request/error-classifier');
const { parseTokenUsage: parseTokenUsageUtil } = require('./request/stream-parser');
const { transformRequestBody: transformRequestBodyUtil } = require('./request/model-transformer');

// Default retry configuration (can be overridden via config.retryConfig)
const DEFAULT_RETRY_CONFIG = {
    baseDelayMs: 100,      // Initial delay before first retry
    maxDelayMs: 30000,     // Maximum delay between retries (30s for rate limits)
    backoffMultiplier: 2,  // Exponential backoff factor
    jitterPercent: 0.2     // Random jitter to prevent thundering herd
};

// Backward-compatible alias for external consumers
const RETRY_CONFIG = DEFAULT_RETRY_CONFIG;

// Error-specific retry strategies
const ERROR_STRATEGIES = {
    socket_hangup: {
        shouldRetry: true,
        excludeKey: false,       // Network issue, not key issue
        backoffMultiplier: 1.5,  // Backoff to avoid thundering herd during connection storms
        maxRetries: 3,           // Fewer retries — if upstream is overloaded, hammering makes it worse
        useFreshConnection: true // Use fresh connection on retry (not whole agent recreation)
    },
    timeout: {
        shouldRetry: true,
        excludeKey: true,        // Key is slow
        backoffMultiplier: 2.0,
        maxRetries: 2
    },
    server_error: {
        shouldRetry: true,
        excludeKey: true,
        backoffMultiplier: 2.0,
        maxRetries: 3
    },
    rate_limited: {
        shouldRetry: false,      // DO NOT RETRY - 429 means quota exhausted, retrying wastes more quota!
        excludeKey: true,        // Mark key as rate limited
        backoffMultiplier: 1.0,
        maxRetries: 0            // No retries - pass 429 back to client
    },
    model_at_capacity: {
        shouldRetry: true,       // Local concurrency gate - retry after short delay (slot may free up)
        excludeKey: false,       // Not key-specific, model-level limit
        backoffMultiplier: 1.5,
        maxRetries: 4            // Retry several times with backoff to wait for slots
    },
    context_overflow: {
        shouldRetry: false,      // Request exceeds model context window - retrying won't help
        excludeKey: false,       // Not key-specific, request-size issue
        backoffMultiplier: 1.0,
        maxRetries: 0            // No retries - request is too large for the model
    },
    context_overflow_transient: {
        shouldRetry: true,       // Sufficient-context models exist but transiently unavailable
        excludeKey: false,       // Not key-specific
        backoffMultiplier: 2.0,  // Aggressive backoff to cover cooldown durations
        maxRetries: 4            // Advisory: actual limit is global maxRetries
    },
    connection_refused: {
        shouldRetry: true,
        excludeKey: true,
        backoffMultiplier: 2.0,
        maxRetries: 3
    },
    dns_error: {
        shouldRetry: true,
        excludeKey: false,       // Not key-specific
        backoffMultiplier: 2.0,
        maxRetries: 2
    },
    tls_error: {
        shouldRetry: false,      // Not transient
        excludeKey: true,
        backoffMultiplier: 1.0,
        maxRetries: 0
    },
    auth_error: {
        shouldRetry: true,       // Retry with different key
        excludeKey: true,        // This key is likely invalid
        backoffMultiplier: 1.0,  // No extra backoff needed
        maxRetries: 2            // Try a couple other keys
    },
    broken_pipe: {
        shouldRetry: true,       // Transient, like socket_hangup
        excludeKey: false,       // Not key-specific
        backoffMultiplier: 1.0,
        maxRetries: 3,
        useFreshConnection: true
    },
    connection_aborted: {
        shouldRetry: true,       // Connection dropped mid-transfer
        excludeKey: false,       // Network issue, not key issue
        backoffMultiplier: 1.5,
        maxRetries: 3,
        useFreshConnection: true
    },
    stream_premature_close: {
        shouldRetry: true,       // Upstream closed connection early
        excludeKey: true,        // Could be key-specific load issue
        backoffMultiplier: 2.0,
        maxRetries: 2,
        useFreshConnection: true
    },
    http_parse_error: {
        shouldRetry: true,       // Corrupted response, try again
        excludeKey: true,        // Key may be returning bad data
        backoffMultiplier: 2.0,
        maxRetries: 2,
        useFreshConnection: true
    },
    other: {
        shouldRetry: true,
        excludeKey: true,
        backoffMultiplier: 2.0,
        maxRetries: 3
    },
    aborted: {
        shouldRetry: false,     // Client aborted - don't retry
        excludeKey: false,      // Not the key's fault
        backoffMultiplier: 1.0,
        maxRetries: 0           // No retries on client abort
    }
};

/**
 * Connection Health Monitor
 * Tracks connection health and triggers agent recreation when needed
 */
class ConnectionHealthMonitor {
    constructor(options = {}) {
        this.consecutiveHangups = 0;
        this.totalHangups = 0;
        this.maxConsecutiveHangups = options.maxConsecutiveHangups || 5;
        this.agentRecreationCooldownMs = options.agentRecreationCooldownMs || 60000;
        this.lastAgentRecreation = 0;
        this.agentRecreationCount = 0;
    }

    recordHangup() {
        this.consecutiveHangups++;
        this.totalHangups++;
    }

    recordSuccess() {
        this.consecutiveHangups = 0;
    }

    shouldRecreateAgent() {
        if (this.consecutiveHangups < this.maxConsecutiveHangups) {
            return false;
        }

        // Check cooldown
        const now = Date.now();
        if ((now - this.lastAgentRecreation) < this.agentRecreationCooldownMs) {
            return false;
        }

        return true;
    }

    markAgentRecreated() {
        this.consecutiveHangups = 0;
        this.lastAgentRecreation = Date.now();
        this.agentRecreationCount++;
    }

    getStats() {
        return {
            consecutiveHangups: this.consecutiveHangups,
            totalHangups: this.totalHangups,
            agentRecreationCount: this.agentRecreationCount,
            lastAgentRecreation: this.lastAgentRecreation
        };
    }
}

/**
 * Calculate exponential backoff delay with jitter
 * @param {number} attempt - Current attempt number (0-indexed)
 * @param {Object} [retryConfig] - Retry configuration (defaults to DEFAULT_RETRY_CONFIG)
 * @returns {number} Delay in milliseconds
 */
function calculateBackoff(attempt, retryConfig) {
    const cfg = retryConfig || DEFAULT_RETRY_CONFIG;
    const exponentialDelay = cfg.baseDelayMs * Math.pow(cfg.backoffMultiplier, attempt);
    const cappedDelay = Math.min(exponentialDelay, cfg.maxDelayMs);
    const jitter = cappedDelay * cfg.jitterPercent * (Math.random() - 0.5) * 2;
    return Math.round(cappedDelay + jitter);
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a timeout promise that rejects after specified time
 * Returns an object with the promise and a cancel function to prevent memory leaks
 * @param {number} ms - Timeout in milliseconds
 * @param {string} requestId - Request ID for error message
 * @returns {{promise: Promise<never>, cancel: Function}}
 */
function createTimeout(ms, requestId) {
    let timerId;
    const promise = new Promise((_, reject) => {
        timerId = setTimeout(() => {
            reject(new Error(`Request timeout after ${ms}ms (requestId: ${requestId})`));
        }, ms);
    });

    return {
        promise,
        cancel: () => {
            if (timerId) {
                clearTimeout(timerId);
                timerId = null;
            }
        }
    };
}

class RequestHandler extends EventEmitter {
    constructor(options = {}) {
        if (!options.keyManager) {
            throw new Error('RequestHandler requires keyManager option');
        }

        super();  // Initialize EventEmitter

        this.keyManager = options.keyManager;
        this.statsAggregator = options.statsAggregator;
        this.config = options.config || {};
        this.logger = options.logger;
        this.costTracker = options.costTracker || null;  // Cost tracking for token usage

        // Extract config with defaults and validation
        this.targetHost = this.config.targetHost || 'api.z.ai';
        this.targetBasePath = this.config.targetBasePath || '/api/anthropic';
        this.targetProtocol = this.config.targetProtocol || 'https:';
        this.useHttps = this.targetProtocol === 'https:';
        this.maxRetries = Math.max(0, Math.min(this.config.maxRetries || 3, 10)); // Cap at 10
        this.requestTimeout = this.config.requestTimeout || 300000;
        this.keepAliveTimeout = this.config.keepAliveTimeout || 120000;
        this.freeSocketTimeout = this.config.freeSocketTimeout || 45000;
        this.maxConcurrentRequests = this.config.maxTotalConcurrency ?? 200;

        // Retry configuration (merge config overrides with defaults)
        this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...(options.retryConfig || this.config.retryConfig || {}) };

        // Adaptive timeout configuration (fall back to DEFAULT_CONFIG to avoid divergent values)
        this.adaptiveTimeoutConfig = this.config.adaptiveTimeout || DEFAULT_CONFIG.adaptiveTimeout;

        // Connection health configuration (fall back to DEFAULT_CONFIG to avoid divergent values)
        const connectionHealthConfig = this.config.connectionHealth || DEFAULT_CONFIG.connectionHealth;

        // Pool cooldown configuration (fall back to DEFAULT_CONFIG to avoid divergent values)
        this.poolCooldownConfig = this.config.poolCooldown || DEFAULT_CONFIG.poolCooldown;

        // Request queue for handling bursts when all keys at capacity
        this.requestQueue = new RequestQueue({
            maxSize: this.config.queueSize || 100,
            timeout: this.config.queueTimeout || 30000,
            logger: this.logger
        });

        // Create HTTPS agent with keep-alive and error handling
        this._createAgent();

        // Connection health monitor
        this.connectionMonitor = new ConnectionHealthMonitor(connectionHealthConfig);

        // Backpressure tracking
        this.currentRequests = 0;

        // Burst pacing: limit concurrent outgoing upstream requests
        // Prevents connection storms when many requests arrive simultaneously
        this.maxConcurrentUpstream = this.config.maxConcurrentUpstream ?? 10;
        this._upstreamInFlight = 0;
        this._upstreamWaiters = [];  // Queue of resolve callbacks waiting for a slot

        // Request stream buffer (PHASE 2 - Task #10)
        this.requestStream = [];
        this.maxStreamSize = options.maxStreamSize || 50;
        this.requestPayloadStore = new Map();
        this.maxRequestPayloads = options.maxRequestPayloads
            || this.config.requestPayload?.maxEntries
            || 200;
        this.requestPayloadRetentionMs = options.maxRequestPayloadRetentionMs
            || this.config.requestPayload?.retentionMs
            || 900000;
        this.requestPayloadStats = {
            storedTotal: 0,
            hits: 0,
            misses: 0,
            evictedBySize: 0,
            evictedByTtl: 0
        };

        // Model router (complexity-aware routing)
        this.modelRouter = options.modelRouter || null;

        // Admission hold concurrency counter (global cap)
        this.currentAdmissionHolds = 0;

        // Rate-limit override audit logs (max 1 per second per outcome)
        this._overrideLogThrottle = { accepted: 0, rejected: 0 };

        // Request tracing (Week 2)
        this.traceStore = new TraceStore({
            maxTraces: options.maxTraces || 1000
        });
    }

    // ========== BURST PACING ==========

    /**
     * Acquire an upstream request slot. If at capacity, waits until a slot frees up.
     * Adds small jitter between admissions to prevent synchronized connection bursts.
     * @returns {Promise<void>}
     */
    async _acquireUpstreamSlot() {
        if (this._upstreamInFlight < this.maxConcurrentUpstream) {
            this._upstreamInFlight++;
            return;
        }
        // Wait for a slot to free up
        await new Promise(resolve => this._upstreamWaiters.push(resolve));
        this._upstreamInFlight++;
        // Small jitter between admissions to stagger connection setup
        const jitter = Math.floor(Math.random() * 50);
        if (jitter > 0) await sleep(jitter);
    }

    /**
     * Release an upstream request slot and wake the next waiter.
     */
    _releaseUpstreamSlot() {
        this._upstreamInFlight = Math.max(0, this._upstreamInFlight - 1);
        if (this._upstreamWaiters.length > 0) {
            const resolve = this._upstreamWaiters.shift();
            resolve();
        }
    }

    // ========== MODEL ROUTING ==========

    /**
     * Transform request body to route model names via ModelRouter.
     * @param {Buffer} body - Original request body
     * @param {Object} reqLogger - Request-scoped logger
     * @param {number} keyIndex - API key index (for per-key overrides)
     * @param {http.IncomingMessage} [req] - HTTP request (for x-model-override header)
     * @param {Set<string>|null} attemptedModels - Models already attempted in this request
     * @returns {Promise<{body: Buffer, originalModel: string|null, mappedModel: string|null, routingDecision: Object|null}>}
     *
     * Delegates to the extracted model-transformer module.
     */
    async _transformRequestBody(body, reqLogger, keyIndex = null, req = null, attemptedModels = null) {
        return await transformRequestBodyUtil(
            body,
            reqLogger,
            keyIndex,
            req,
            attemptedModels,
            this.modelRouter,
            this._overrideLogThrottle,
            this.config?._providerRegistry || null,
            this.config?.modelMapping || null
        );
    }

    // ========== TOKEN USAGE PARSING (PHASE 2 - Task #4) ==========

    /**
     * Parse token usage from Anthropic API response
     * The final chunk contains usage information in the format:
     * event: message_stop
     * data: {"type":"message_stop","anthropic":{"usage":{"input_tokens":X,"output_tokens":Y}}}
     *
     * Delegates to the extracted stream-parser module.
     * This method is kept for backward compatibility and can be deprecated in future.
     */
    parseTokenUsage(chunks) {
        return parseTokenUsageUtil(chunks);
    }

    // ========== REQUEST STREAM TRACKING (PHASE 2 - Task #10) ==========

    /**
     * Add request to stream for live monitoring
     * Normalizes fields for dashboard compatibility
     */
    addRequestToStream(requestInfo) {
        const streamRequestId =
            requestInfo.requestId ||
            `${Date.now()}-${requestInfo.keyIndex ?? 0}-${Math.floor(Math.random() * 1000000)}`;
        const hasPayloadPreview = !!requestInfo.requestPayload?.json;
        const hasPayloadFull = !!requestInfo.requestPayloadFull?.json;

        if (hasPayloadFull) {
            this._storeRequestPayload(streamRequestId, requestInfo.requestPayloadFull);
        }

        // Normalize for dashboard compatibility
        const normalized = {
            ...requestInfo,
            requestId: streamRequestId,
            requestPayloadAvailable: requestInfo.requestPayloadAvailable === true || hasPayloadFull || hasPayloadPreview,
            timestamp: Date.now(),
            // Add 'latency' alias for 'latencyMs' (dashboard uses request.latency)
            latency: requestInfo.latencyMs,
            // Add semantic status for dashboard (expects 'completed', not HTTP code)
            status: requestInfo.success ? 'completed' :
                    requestInfo.error ? 'error' :
                    typeof requestInfo.status === 'number' ? requestInfo.status : 'pending'
        };
        delete normalized.requestPayloadFull;

        this.requestStream.push(normalized);

        // Keep only the most recent requests
        while (this.requestStream.length > this.maxStreamSize) {
            const removed = this.requestStream.shift();
            if (removed?.requestId) {
                this.requestPayloadStore.delete(removed.requestId);
            }
        }

        // Emit for event listeners (SSE clients subscribe to this event)
        this.emit('request', normalized);
    }

    _parseRequestBody(body) {
        if (!Buffer.isBuffer(body) || body.length === 0) return null;
        try {
            return JSON.parse(body.toString('utf8'));
        } catch {
            return null;
        }
    }

    _extractContentText(content) {
        if (content == null) return '';
        if (typeof content === 'string') return content.trim();
        if (Array.isArray(content)) {
            return content
                .map((item) => this._extractContentText(item))
                .filter(Boolean)
                .join('\n\n')
                .trim();
        }
        if (typeof content === 'object') {
            if (typeof content.text === 'string') return content.text.trim();
            if (typeof content.input === 'string') return content.input.trim();
            if (typeof content.content === 'string') return content.content.trim();
            if (Array.isArray(content.content)) return this._extractContentText(content.content);
            if (typeof content.message === 'string') return content.message.trim();
            return '';
        }
        return '';
    }

    _extractRequestContentPreview(body) {
        const parsed = this._parseRequestBody(body);
        if (!parsed) return null;

        const systemText = this._extractContentText(parsed.system);
        const rawMessages = Array.isArray(parsed.messages) ? parsed.messages : [];
        const messages = [];

        const maxMessages = 12;
        const maxCharsPerMessage = 1600;
        const maxTotalChars = 12000;
        let totalChars = 0;
        let truncated = false;

        for (let index = 0; index < rawMessages.length; index++) {
            const msg = rawMessages[index];
            const text = this._extractContentText(msg?.content ?? msg?.text ?? '');
            if (!text) continue;

            let normalizedText = text;
            if (normalizedText.length > maxCharsPerMessage) {
                normalizedText = normalizedText.slice(0, maxCharsPerMessage) + '…';
                truncated = true;
            }

            const remaining = maxTotalChars - totalChars;
            if (remaining <= 0) {
                truncated = true;
                break;
            }
            if (normalizedText.length > remaining) {
                normalizedText = normalizedText.slice(0, remaining) + '…';
                truncated = true;
            }

            totalChars += normalizedText.length;
            messages.push({
                index,
                role: msg?.role || 'unknown',
                text: normalizedText
            });

            if (messages.length >= maxMessages) {
                truncated = true;
                break;
            }
        }

        if (!systemText && messages.length === 0) return null;

        const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
        return {
            system: systemText || null,
            messages,
            messageCount: rawMessages.length,
            toolsCount: tools.length,
            maxTokens: typeof parsed.max_tokens === 'number' ? parsed.max_tokens : null,
            truncated
        };
    }

    _sanitizePayload(value, options, depth = 0, parentKey = '') {
        const maxDepth = options?.maxDepth ?? 10;
        const maxStringChars = options?.maxStringChars ?? 4000;
        const maxArrayItems = options?.maxArrayItems ?? 40;
        const maxObjectEntries = options?.maxObjectEntries ?? 120;

        if (value === null || value === undefined) return value;
        if (depth > maxDepth) return '[depth-limit]';

        if (typeof value === 'string') {
            if (/^data:[^;]+;base64,/i.test(value)) {
                return `[data-uri redacted, ${value.length} chars]`;
            }
            if (value.length > maxStringChars) {
                return `${value.slice(0, maxStringChars)}…[truncated]`;
            }
            return value;
        }

        if (typeof value === 'number' || typeof value === 'boolean') return value;

        if (Array.isArray(value)) {
            const out = value
                .slice(0, maxArrayItems)
                .map((item) => this._sanitizePayload(item, options, depth + 1, parentKey));
            if (value.length > maxArrayItems) {
                out.push(`[${value.length - maxArrayItems} more items omitted]`);
            }
            return out;
        }

        if (typeof value === 'object') {
            const sensitive = new Set([
                'authorization',
                'proxy-authorization',
                'x-api-key',
                'api_key',
                'apikey',
                'password',
                'secret',
                'x-admin-token'
            ]);
            const output = {};
            const entries = Object.entries(value);
            for (let idx = 0; idx < entries.length; idx++) {
                const [key, rawVal] = entries[idx];
                if (idx >= maxObjectEntries) {
                    output.__truncatedKeys = `${entries.length - maxObjectEntries} keys omitted`;
                    break;
                }
                const lowered = String(key || '').toLowerCase();
                const isTokenLike = lowered.includes('token') && lowered !== 'max_tokens';
                if (sensitive.has(lowered) || isTokenLike) {
                    output[key] = '[REDACTED]';
                } else {
                    output[key] = this._sanitizePayload(rawVal, options, depth + 1, key);
                }
            }
            return output;
        }

        return `[unsupported:${typeof value}]`;
    }

    _sanitizePayloadForPreview(value, depth = 0, parentKey = '') {
        return this._sanitizePayload(value, {
            maxDepth: 10,
            maxStringChars: 4000,
            maxArrayItems: 40,
            maxObjectEntries: 120
        }, depth, parentKey);
    }

    _sanitizePayloadForFull(value, depth = 0, parentKey = '') {
        return this._sanitizePayload(value, {
            maxDepth: 14,
            maxStringChars: 50000,
            maxArrayItems: 200,
            maxObjectEntries: 400
        }, depth, parentKey);
    }

    _extractRequestPayloadPreview(body) {
        const parsed = this._parseRequestBody(body);
        if (!parsed) return null;

        const sanitized = this._sanitizePayloadForPreview(parsed);
        const pretty = JSON.stringify(sanitized, null, 2) || '';
        const maxChars = 20000;
        if (pretty.length <= maxChars) {
            return { json: pretty, truncated: false };
        }
        return {
            json: `${pretty.slice(0, maxChars)}\n... [payload preview truncated]`,
            truncated: true
        };
    }

    _extractRequestPayloadFull(body) {
        const parsed = this._parseRequestBody(body);
        if (!parsed) return null;

        const sanitized = this._sanitizePayloadForFull(parsed);
        const pretty = JSON.stringify(sanitized, null, 2) || '';
        const maxChars = 200000;
        if (pretty.length <= maxChars) {
            return { json: pretty, truncated: false };
        }
        return {
            json: `${pretty.slice(0, maxChars)}\n... [full payload truncated]`,
            truncated: true
        };
    }

    _evictExpiredPayloads(now = Date.now()) {
        if (this.requestPayloadStore.size === 0) return;
        let evicted = 0;
        for (const [requestId, entry] of this.requestPayloadStore.entries()) {
            if (!entry?.expiresAt || entry.expiresAt > now) continue;
            this.requestPayloadStore.delete(requestId);
            evicted++;
        }
        if (evicted > 0) {
            this.requestPayloadStats.evictedByTtl += evicted;
        }
    }

    _storeRequestPayload(requestId, payload) {
        if (!requestId || !payload?.json) return;
        this._evictExpiredPayloads();
        const now = Date.now();
        this.requestPayloadStore.set(requestId, {
            json: payload.json,
            truncated: payload.truncated === true,
            capturedAt: now,
            expiresAt: now + this.requestPayloadRetentionMs
        });
        this.requestPayloadStats.storedTotal++;
        while (this.requestPayloadStore.size > this.maxRequestPayloads) {
            const oldest = this.requestPayloadStore.keys().next().value;
            this.requestPayloadStore.delete(oldest);
            this.requestPayloadStats.evictedBySize++;
        }
    }

    getRequestPayload(requestId) {
        if (!requestId) return null;
        this._evictExpiredPayloads();
        const payload = this.requestPayloadStore.get(requestId) || null;
        if (payload) {
            this.requestPayloadStats.hits++;
        } else {
            this.requestPayloadStats.misses++;
        }
        return payload;
    }

    getRequestPayloadStoreStats() {
        this._evictExpiredPayloads();
        return {
            size: this.requestPayloadStore.size,
            maxEntries: this.maxRequestPayloads,
            retentionMs: this.requestPayloadRetentionMs,
            storedTotal: this.requestPayloadStats.storedTotal,
            hits: this.requestPayloadStats.hits,
            misses: this.requestPayloadStats.misses,
            evictedBySize: this.requestPayloadStats.evictedBySize,
            evictedByTtl: this.requestPayloadStats.evictedByTtl
        };
    }

    /**
     * Get recent requests for SSE stream
     */
    getRecentRequests(count = 50) {
        return this.requestStream.slice(-count);
    }

    /**
     * Clear request stream
     */
    clearRequestStream() {
        this.requestStream = [];
        this.requestPayloadStore.clear();
    }

    // ========== AGENT MANAGEMENT ==========

    /**
     * Create or recreate the HTTPS agent
     */
    _createAgent() {
        if (this.agent) {
            this.agent.destroy();
        }

        const AgentClass = this.useHttps ? https.Agent : http.Agent;
        this.agent = new AgentClass({
            keepAlive: true,
            keepAliveMsecs: 10000,       // More aggressive keepalive (was 30s)
            maxSockets: 30,              // Limit concurrent connections to prevent upstream overload
            maxFreeSockets: 10,
            timeout: this.keepAliveTimeout,
            freeSocketTimeout: this.freeSocketTimeout,
            scheduling: 'lifo'           // Reuse most recent socket (reduces stale reuse)
        });

        // Handle agent errors
        this.agent.on('error', (err) => {
            this.logger?.error('Upstream agent error', { error: err.message, protocol: this.targetProtocol });
        });
    }

    /**
     * Recreate the HTTPS agent (called when connection issues detected)
     */
    _recreateAgent() {
        this.logger?.warn('Recreating HTTPS agent due to connection issues', {
            consecutiveHangups: this.connectionMonitor.consecutiveHangups,
            totalHangups: this.connectionMonitor.totalHangups
        });

        this._createAgent();
        this.connectionMonitor.markAgentRecreated();

        this.statsAggregator?.recordAgentRecreation?.();
    }

    // ========== ADAPTIVE TIMEOUT ==========

    /**
     * Calculate adaptive timeout based on key's latency profile
     * @param {Object} keyInfo - Key information
     * @param {number} attempt - Current attempt number (0-indexed)
     * @returns {number} Timeout in milliseconds
     */
    _calculateTimeout(keyInfo, attempt, mappedModel) {
        const cfg = this.adaptiveTimeoutConfig;

        if (!cfg.enabled) {
            return this.requestTimeout;
        }

        const stats = keyInfo.latencies.stats();

        // Base timeout: use P95 latency if we have enough samples, else default
        let baseTimeout;
        if (stats.count >= cfg.minSamples && stats.p95) {
            baseTimeout = Math.max(
                stats.p95 * cfg.latencyMultiplier,
                cfg.minMs
            );
        } else {
            baseTimeout = cfg.initialMs;
        }

        // Model-aware timeout: use max(keyP95-based, modelP95-based)
        // This prevents heavy model requests from getting timeouts calibrated
        // to the key's blended P95 (diluted by fast light-tier requests).
        if (mappedModel && this.statsAggregator) {
            const modelP95 = this.statsAggregator.getModelP95?.(mappedModel);
            if (modelP95) {
                const modelBaseTimeout = Math.max(modelP95 * cfg.latencyMultiplier, cfg.minMs);
                baseTimeout = Math.max(baseTimeout, modelBaseTimeout);
            }
        }

        // Increase for retries (exponential)
        const retryTimeout = baseTimeout * Math.pow(cfg.retryMultiplier, attempt);

        // Clamp to min/max bounds
        return Math.min(Math.max(retryTimeout, cfg.minMs), cfg.maxMs);
    }

    // ========== ERROR STRATEGY ==========

    /**
     * Get error-specific retry strategy
     */
    _getErrorStrategy(errorType) {
        return ERROR_STRATEGIES[errorType] || ERROR_STRATEGIES.other;
    }

    /**
     * Get connection health stats
     */
    getConnectionHealthStats() {
        return this.connectionMonitor.getStats();
    }

    // ========== BACKPRESSURE ==========

    /**
     * Check if we can accept a new request (backpressure)
     * @returns {boolean}
     */
    canAcceptRequest() {
        return this.currentRequests < this.maxConcurrentRequests;
    }

    /**
     * Get current backpressure stats
     * @returns {Object}
     */
    getBackpressureStats() {
        return {
            current: this.currentRequests,
            max: this.maxConcurrentRequests,
            available: this.maxConcurrentRequests - this.currentRequests,
            percentUsed: Math.round((this.currentRequests / this.maxConcurrentRequests) * 100),
            queue: this.requestQueue.getStats()
        };
    }

    /**
     * Handle an incoming request with timeout protection and queuing
     * @param {http.IncomingMessage} req - Incoming request
     * @param {http.ServerResponse} res - Server response
     * @param {Buffer} body - Request body
     */
    async handleRequest(req, res, body) {
        const requestId = generateRequestId();
        const reqLogger = this.logger?.forRequest(requestId);
        const startTime = Date.now();

        // Create request trace for lifecycle tracking
        const trace = new RequestTrace({
            requestId,
            method: req.method,
            path: req.url
        });

        // Backpressure check (hard limit)
        if (!this.canAcceptRequest()) {
            reqLogger?.warn('Request rejected due to backpressure', {
                current: this.currentRequests,
                max: this.maxConcurrentRequests
            });
            res.writeHead(503, {
                'content-type': 'application/json',
                'retry-after': '1'
            });
            res.end(JSON.stringify({
                error: 'Service temporarily unavailable',
                reason: 'backpressure',
                retryAfter: 1
            }));
            return;
        }

        this.currentRequests++;

        // Create timeout with cancel function to prevent memory leaks
        const overallTimeout = this.requestTimeout + (this.maxRetries * this.retryConfig.maxDelayMs) + 10000;
        const timeout = createTimeout(overallTimeout, requestId);

        try {
            // Wrap the entire proxy operation with a timeout
            await Promise.race([
                this._proxyWithRetries(req, res, body, requestId, reqLogger, startTime, trace),
                timeout.promise
            ]);
            // Complete trace on success
            trace.complete(true, 'success');
        } catch (err) {
            // Handle timeout or unexpected errors
            trace.complete(false, 'error', err.message);
            if (!res.headersSent) {
                reqLogger?.error('Request failed', { error: err.message });
                res.writeHead(504, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Gateway timeout',
                    requestId,
                    message: 'Request processing failed'
                }));
            }
            // Track failure if _proxyWithRetries didn't already track it
            // (e.g., timeout race won before tracking, or unexpected throw)
            if (!trace._clientTracked) {
                this.statsAggregator?.recordClientRequestFailure();
            }
        } finally {
            // CRITICAL: Cancel timeout to prevent memory leak
            timeout.cancel();

            // Store completed trace
            this.traceStore.store(trace);

            this.currentRequests = Math.max(0, this.currentRequests - 1);
            // Signal queue that a slot may be available
            this.requestQueue.signalSlotAvailable();
        }
    }

    /**
     * Proxy request with iterative retry logic (no recursion)
     * @param {http.IncomingMessage} req - Incoming request
     * @param {http.ServerResponse} res - Server response
     * @param {Buffer} body - Request body
     * @param {string} requestId - Unique request ID
     * @param {Object} reqLogger - Request-scoped logger
     * @param {number} startTime - Request start timestamp
     * @param {RequestTrace} trace - Request trace for lifecycle tracking
     */
    async _proxyWithRetries(req, res, body, requestId, reqLogger, startTime, trace) {
        const excludeKeys = [];
        let lastError = null;
        let lastErrorType = null;
        let errorSpecificRetries = 0;  // Track retries for same error type
        let clientRequestTracked = false;  // Track if we've recorded the outcome
        let useFreshConnection = false;  // Use fresh connection on next retry (for stale socket reuse)

        // 429 RETRY CONTROL
        // LLM routes get retries on 429 (to try different keys/models)
        // Cap at 3 to balance resilience vs quota burn
        let llm429Retries = 0;
        const maxLlm429Retries = 3;

        // EARLY GIVE-UP: When modelRouter is active, stop cascading 429s sooner
        // to avoid burning 3-12s per failed attempt across multiple models.
        const failoverConfig = this.modelRouter?.config?.failover || {};
        const max429Attempts = failoverConfig.max429AttemptsPerRequest ?? Infinity;
        const max429WindowMs = failoverConfig.max429RetryWindowMs ?? Infinity;
        let retryLoopStartTime = Date.now();
        let giveUpReason = null;

        // Delay override: when 429 returns retryAfterMs, use that instead of exponential backoff
        let nextRetryDelayMs = null;

        // Track client request start (unique requests, not key attempts)
        this.statsAggregator?.recordClientRequestStart();

        // Helper to track success (only once per client request)
        const trackSuccess = () => {
            if (!clientRequestTracked) {
                clientRequestTracked = true;
                trace._clientTracked = true;
                this.statsAggregator?.recordClientRequestSuccess();
            }
        };

        // Helper to track failure (only once per client request)
        const trackFailure = () => {
            if (!clientRequestTracked) {
                clientRequestTracked = true;
                trace._clientTracked = true;
                this.statsAggregator?.recordClientRequestFailure();
            }
        };

        // CLIENT DISCONNECT HANDLING:
        // Add a single 'close' listener here instead of per-attempt in _makeProxyRequest
        // This prevents listener leaks on retries (each attempt was adding a new listener)
        let clientDisconnected = false;
        let currentProxyReq = null;  // Track current proxy request for cleanup
        const closeHandler = () => {
            clientDisconnected = true;
            if (currentProxyReq) {
                currentProxyReq.destroy();
            }
        };
        res.once('close', closeHandler);

        // Track models attempted in this request lifecycle (for multi-fallback routing)
        const attemptedModels = new Set();
        let modelSwitchCount = 0;
        let prevMappedModel = null;

        // Build context for admission hold peek (same shape as selectModel context)
        let admissionHoldContext = null;
        const isLLMRouteForHold = req.url.startsWith('/v1/messages');
        if (isLLMRouteForHold && this.modelRouter?.enabled && body?.length > 0) {
            try {
                const parsedBody = JSON.parse(body.toString('utf8'));
                admissionHoldContext = {
                    parsedBody,
                    requestModel: parsedBody.model,
                    override: req.headers['x-model-override'] || null,
                    skipOverrides: false
                };
            } catch (e) { /* not JSON, skip */ }
        }

        // Iterative retry loop - no recursion
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            // Apply exponential backoff after first attempt
            if (attempt > 0) {
                // Track actual retry (attempt > 0 means we're genuinely retrying)
                this.statsAggregator?.recordRetry?.();

                let backoffMs;

                // USE OVERRIDE DELAY if set (e.g., from 429 Retry-After)
                if (nextRetryDelayMs !== null) {
                    backoffMs = nextRetryDelayMs;
                    nextRetryDelayMs = null;  // Clear after use
                    reqLogger?.debug(`Retry ${attempt}/${this.maxRetries}, using override delay ${backoffMs}ms`, {
                        errorType: lastErrorType,
                        source: '429-retry-after'
                    });
                } else {
                    // Use error-specific backoff multiplier if available
                    const strategy = lastErrorType ? this._getErrorStrategy(lastErrorType) : null;
                    const backoffMultiplier = strategy?.backoffMultiplier || 1.0;
                    const baseBackoffMs = calculateBackoff(attempt - 1, this.retryConfig);
                    backoffMs = Math.round(baseBackoffMs * backoffMultiplier);

                    reqLogger?.debug(`Retry ${attempt}/${this.maxRetries}, backoff ${backoffMs}ms`, {
                        errorType: lastErrorType,
                        backoffMultiplier
                    });
                }
                if (backoffMs > 0) {
                    this.statsAggregator?.recordRetryBackoff?.(backoffMs);
                }
                await sleep(backoffMs);
            }

            // Check if client disconnected or response already sent
            if (clientDisconnected || res.headersSent) {
                reqLogger?.debug('Client disconnected or response already sent, aborting retries');
                trackFailure();  // Track as failure (likely client disconnect)
                res.removeListener('close', closeHandler);  // Clean up listener
                return;
            }

            // POOL COOLDOWN CHECK: Handle pool-level rate limiting (global/account limit)
            // This is enforced here in RequestHandler, not in KeyManager.acquireKey(),
            // to avoid deadlocking the queue (which wakes on "slot available", not "cooldown expired")
            // Use previous attempt's model for per-model cooldown check (on retries)
            // On first attempt (prevMappedModel is null), check all pools
            const poolCooldownMs = this.keyManager.getPoolCooldownRemainingMs?.(prevMappedModel) || 0;
            if (poolCooldownMs > 0) {
                const isLLMRoute = req.url.startsWith('/v1/messages');
                // Short cooldowns: sleep instead of returning error (avoids retry storms)
                // Use configurable threshold (default 250ms)
                const { sleepThresholdMs, retryJitterMs, maxCooldownMs } = this.poolCooldownConfig;

                if (attempt === 0 && isLLMRoute && poolCooldownMs > sleepThresholdMs && !this.modelRouter) {
                    // ATTEMPT 0 + POOL BLOCKED (long cooldown) + NO MODEL ROUTER:
                    // Return local 429 with pool marker.
                    // When modelRouter IS active, skip this — the router's _selectFromPool()
                    // already considers per-model cooldowns and will pick a non-cooled model.
                    // Add jitter to Retry-After to avoid synchronized client retries
                    const jitterMs = Math.floor(Math.random() * retryJitterMs);
                    const retryAfterMs = Math.min(poolCooldownMs + jitterMs, maxCooldownMs);
                    const retryAfterSecs = Math.ceil(retryAfterMs / 1000);

                    reqLogger?.warn(`Pool cooldown active on attempt 0, returning local 429`, {
                        poolCooldownMs,
                        retryAfterMs,
                        retryAfterSecs,
                        isLLMRoute,
                        sleepThresholdMs,
                        jitterMs
                    });

                    // Track as local pool block (not upstream 429)
                    this.statsAggregator?.recordLocal429?.();
                    this.statsAggregator?.recordPoolCooldown?.();

                    if (!res.headersSent) {
                        res.writeHead(429, {
                            'content-type': 'application/json',
                            'retry-after': String(retryAfterSecs),
                            // Clear markers to distinguish from upstream 429
                            'x-rate-limit-scope': 'pool',
                            'x-proxy-rate-limit': 'pool',
                            'x-proxy-retry-after-ms': String(retryAfterMs)
                        });
                        res.end(JSON.stringify({
                            error: 'Rate limited',
                            reason: 'pool_rate_limited',
                            scope: 'pool',
                            retryAfter: retryAfterSecs,
                            retryAfterMs,
                            requestId
                        }));
                    }
                    trackFailure();
                    res.removeListener('close', closeHandler);
                    return;
                } else if (poolCooldownMs <= sleepThresholdMs || attempt > 0) {
                    // SHORT COOLDOWN or RETRY: Sleep before proceeding (bounded)
                    // This avoids returning errors for brief cooldowns
                    const sleepMs = Math.min(poolCooldownMs, maxCooldownMs);
                    reqLogger?.debug(`Pool cooldown active, sleeping ${sleepMs}ms`, {
                        poolCooldownMs,
                        attempt,
                        sleepThresholdMs,
                        reason: poolCooldownMs <= sleepThresholdMs ? 'short_cooldown' : 'retry'
                    });
                    await sleep(sleepMs);
                }
                // Non-LLM routes on attempt 0: proceed without blocking (telemetry, etc.)
            }

            // TIER-AWARE ADMISSION HOLD
            // Hold request when ALL models in tier are cooled, instead of sending to guaranteed-429 upstream.
            // Happens BEFORE acquireKey — no key slot wasted during hold.
            const admissionHoldConfig = this.config.admissionHold || {};
            if (attempt === 0 && admissionHoldContext && this.modelRouter
                && admissionHoldConfig.enabled === true) {

                const holdInfo = this.modelRouter.peekAdmissionHold(admissionHoldContext);
                const holdTiers = admissionHoldConfig.tiers || ['heavy'];
                const minToHold = admissionHoldConfig.minCooldownToHold ?? 500;

                if (holdInfo && holdInfo.allCooled
                    && holdInfo.minCooldownMs > minToHold
                    && holdTiers.includes(holdInfo.tier)) {

                    const maxConcurrent = admissionHoldConfig.maxConcurrentHolds ?? 20;

                    // Concurrency guard: reject if too many requests holding
                    if (this.currentAdmissionHolds >= maxConcurrent) {
                        reqLogger?.warn('Admission hold rejected: concurrency cap', {
                            tier: holdInfo.tier, current: this.currentAdmissionHolds, max: maxConcurrent
                        });
                        this.statsAggregator?.recordAdmissionHoldRejected?.();
                        // Fall through — attempt anyway (don't block, don't return 429 here)
                    } else {
                        const maxHoldMs = admissionHoldConfig.maxHoldMs ?? 15000;
                        const jitterMs = admissionHoldConfig.jitterMs ?? 100;
                        const holdStart = Date.now();

                        reqLogger?.info('Admission hold: all tier candidates cooled', {
                            tier: holdInfo.tier,
                            minCooldownMs: holdInfo.minCooldownMs,
                            maxHoldMs,
                            candidates: holdInfo.candidates
                        });
                        trace.markAdmissionHold(holdInfo.tier);
                        this.statsAggregator?.recordAdmissionHold?.(holdInfo.tier);
                        this.currentAdmissionHolds++;

                        try {
                            let holdSucceeded = false;

                            // Sleep-on-cooldown loop: sleep for minCooldown + jitter, then re-check.
                            // NOT polling — wakes ~once per cooldown cycle.
                            while (Date.now() - holdStart < maxHoldMs) {
                                if (clientDisconnected || res.headersSent) break;

                                const currentCooldown = this.modelRouter.peekAdmissionHold(admissionHoldContext);
                                if (!currentCooldown || !currentCooldown.allCooled) {
                                    holdSucceeded = true;
                                    break;
                                }

                                // Sleep for the cooldown duration + jitter (wake once, not polling)
                                const sleepMs = Math.min(
                                    currentCooldown.minCooldownMs + Math.floor(Math.random() * jitterMs),
                                    maxHoldMs - (Date.now() - holdStart)  // don't overshoot maxHoldMs
                                );
                                if (sleepMs <= 0) break;
                                await sleep(sleepMs);
                            }

                            const holdDurationMs = Date.now() - holdStart;
                            this.statsAggregator?.recordAdmissionHoldComplete?.(holdDurationMs, holdSucceeded);
                            trace.markAdmissionHoldRelease(holdDurationMs, holdSucceeded);

                            if (holdSucceeded) {
                                reqLogger?.info('Admission hold released', {
                                    tier: holdInfo.tier, holdDurationMs
                                });
                                // Shift give-up window so hold time doesn't count against max_429_window
                                retryLoopStartTime += holdDurationMs;
                            } else if (!clientDisconnected) {
                                // Hold timed out — return 429 with meaningful retry-after
                                const remaining = this.modelRouter.peekAdmissionHold(admissionHoldContext);
                                const retryAfterSecs = Math.ceil(
                                    Math.max(remaining?.minCooldownMs || 0, 1000) / 1000
                                );
                                reqLogger?.warn('Admission hold timed out', {
                                    tier: holdInfo.tier, holdDurationMs, retryAfterSecs
                                });
                                if (!res.headersSent) {
                                    res.writeHead(429, {
                                        'content-type': 'application/json',
                                        'retry-after': String(retryAfterSecs),
                                        'x-proxy-rate-limit': 'admission_hold_timeout',
                                        'x-proxy-hold-duration-ms': String(holdDurationMs),
                                        'x-proxy-tier': holdInfo.tier
                                    });
                                    res.end(JSON.stringify({
                                        error: 'All models in tier cooled down',
                                        errorType: 'admission_hold_timeout',
                                        tier: holdInfo.tier,
                                        holdDurationMs,
                                        retryAfter: retryAfterSecs,
                                        requestId
                                    }));
                                }
                                trackFailure();
                                res.removeListener('close', closeHandler);
                                return;
                            }
                        } finally {
                            this.currentAdmissionHolds--;
                        }
                    }
                }
            }

            // PROACTIVE PACING: Add micro-delay if approaching model's rate limit
            if (prevMappedModel) {
                const pacingMs = this.keyManager.getModelPacingDelayMs?.(prevMappedModel) || 0;
                if (pacingMs > 0 && pacingMs <= 1000) {
                    reqLogger?.debug(`Proactive pacing delay ${pacingMs}ms for model ${prevMappedModel}`);
                    await sleep(pacingMs);
                }
            }

            // PROVIDER-FIRST FLOW: Transform body to determine model/provider BEFORE key acquisition.
            // This ensures keys are acquired from the correct provider pool (GUARD-11).
            // keyIndex is null here (no key yet); per-key overrides are not supported in provider-first flow.
            const transformResult = await this._transformRequestBody(
                body, reqLogger, null, req, attemptedModels
            );
            const providerFilter = transformResult.provider || null;

            // Get a key from the target provider's pool (excluding failed ones)
            let keyInfo = this.keyManager.acquireKey(excludeKeys, providerFilter);

            // If no key available, try queuing instead of failing
            if (!keyInfo) {
                // Only queue on first attempt (don't queue retries)
                if (attempt === 0 && this.requestQueue.hasCapacity()) {
                    reqLogger?.info('All keys busy, queuing request', {
                        queuePosition: this.requestQueue.length + 1,
                        provider: providerFilter
                    });

                    // Mark trace as queued
                    trace.markQueued();

                    const queueResult = await this.requestQueue.enqueue(requestId);

                    if (!queueResult.success) {
                        // Queue rejected (full or timeout)
                        const retryAfter = queueResult.reason === 'queue_full' ? 5 : 2;
                        reqLogger?.warn('Queue rejected request', { reason: queueResult.reason });
                        if (!res.headersSent) {
                            res.writeHead(503, {
                                'content-type': 'application/json',
                                'retry-after': String(retryAfter),
                                'x-queue-full': queueResult.reason === 'queue_full' ? 'true' : 'false'
                            });
                            res.end(JSON.stringify({
                                error: 'Service temporarily unavailable',
                                reason: queueResult.reason,
                                retryAfter,
                                requestId
                            }));
                        }
                        trackFailure();  // Track client request failure (queue rejected)
                        res.removeListener('close', closeHandler);
                        return;
                    }

                    reqLogger?.info('Request dequeued, retrying key acquisition', {
                        waitTime: queueResult.waitTime
                    });

                    // Mark trace as dequeued
                    trace.markDequeued();

                    // Try to acquire key again after waiting (same provider filter)
                    keyInfo = this.keyManager.acquireKey(excludeKeys, providerFilter);
                }

                // Still no key after queue wait
                if (!keyInfo) {
                    reqLogger?.error('No keys available', {
                        excludedCount: excludeKeys.length,
                        provider: providerFilter
                    });
                    if (!res.headersSent) {
                        res.writeHead(503, {
                            'content-type': 'application/json',
                            'retry-after': '2'
                        });
                        res.end(JSON.stringify({
                            error: 'All keys exhausted or circuits open',
                            retryAfter: 2,
                            requestId,
                            provider: providerFilter
                        }));
                    }
                    trackFailure();  // Track client request failure (no keys)
                    res.removeListener('close', closeHandler);  // Clean up listener
                    return;
                }
            }

            try {
                // Start a new attempt on the trace
                const currentAttempt = trace.startAttempt({
                    index: keyInfo.index,
                    keyId: keyInfo.keyId || `key_${keyInfo.index}`,
                    selectionReason: keyInfo.selectionReason || 'round_robin'
                });

                // Add KEY_ACQUIRED span
                currentAttempt.addSpan(SpanType.KEY_ACQUIRED, {
                    keyIndex: keyInfo.index,
                    metadata: {
                        circuit: keyInfo.circuitBreaker?.state,
                        inFlight: keyInfo.inFlight,
                        provider: providerFilter
                    }
                }).end();

                const result = await this._makeProxyRequest(
                    req, res, body, keyInfo, requestId, reqLogger, startTime, attempt,
                    clientDisconnected,  // Pass disconnect flag for early abort
                    (proxyReq) => { currentProxyReq = proxyReq; },  // Track current request for cleanup
                    useFreshConnection,  // Use fresh connection (bypass agent pool) for this attempt
                    currentAttempt,      // Pass attempt for span tracking
                    attemptedModels,     // Pass attempted models for multi-fallback routing
                    trace.traceId,       // Pass traceId for request streaming
                    transformResult      // Pre-computed transform (provider-first flow)
                );

                // Track model for multi-fallback routing
                let modelWasAlreadyTried = false;
                if (result.mappedModel) {
                    // Detect same-model retry (waste): pool assigned a model we already tried
                    // Flag set here; only recorded if this turns out to be a 429 retry (below)
                    modelWasAlreadyTried = attempt > 0 && attemptedModels.has(result.mappedModel);
                    attemptedModels.add(result.mappedModel);
                    if (prevMappedModel && result.mappedModel !== prevMappedModel) {
                        modelSwitchCount++;
                    }
                    prevMappedModel = result.mappedModel;
                }

                // Reset fresh connection flag after attempt
                useFreshConnection = false;

                if (result.success) {
                    // Track successful retry if this wasn't the first attempt
                    if (attempt > 0) {
                        this.statsAggregator?.recordRetrySuccess();
                        reqLogger?.info(`Retry ${attempt} succeeded`);
                    }
                    // Track successful LLM 429 retry if this was a retry after 429
                    if (llm429Retries > 0) {
                        this.statsAggregator?.recordLlm429RetrySuccess?.();
                        reqLogger?.info(`LLM 429 retry succeeded on attempt ${attempt + 1}`);
                    }
                    trackSuccess();  // Track client request success
                    res.removeListener('close', closeHandler);  // Clean up listener
                    return; // Success - we're done
                }

                // Handle retryable errors
                lastError = result.error;
                const currentErrorType = result.errorType || 'other';

                // Special handling for aborted requests (client disconnect)
                // Release the key and stop retrying
                if (currentErrorType === 'aborted') {
                    reqLogger?.debug('Request aborted by client, releasing key');
                    keyInfo.inFlight = Math.max(0, keyInfo.inFlight - 1);
                    trackFailure();
                    res.removeListener('close', closeHandler);  // Clean up listener
                    return;  // Exit retry loop immediately
                }

                // Track error-specific retry count
                if (currentErrorType === lastErrorType) {
                    errorSpecificRetries++;
                } else {
                    errorSpecificRetries = 1;
                    lastErrorType = currentErrorType;
                }

                // Get error-specific strategy
                const strategy = this._getErrorStrategy(currentErrorType);

                // SPECIAL CASE: 429 with shouldRetry=true (LLM route retry)
                // Override the static ERROR_STRATEGIES.rate_limited.shouldRetry=false
                if (currentErrorType === 'rate_limited' && result.shouldRetry === true) {
                    // STREAMING SAFETY: Double-check response hasn't started
                    if (result.responseStarted || res.headersSent) {
                        reqLogger?.warn(`Cannot retry 429 - response already started`, {
                            responseStarted: result.responseStarted,
                            headersSent: res.headersSent
                        });
                        break;
                    }

                    // Check if we've exceeded LLM 429 retry cap
                    if (llm429Retries >= maxLlm429Retries) {
                        reqLogger?.warn(`LLM 429 retry cap reached (${llm429Retries}/${maxLlm429Retries}), not retrying`, {
                            retryDecision: 'cap_reached',
                            evidence: result.evidence
                        });
                        break;  // Exit retry loop, will fall through to error response
                    }

                    // EARLY GIVE-UP: Stop cascading within a tier when clearly saturated.
                    // Only applies when modelRouter is active (router-managed model switching).
                    if (this.modelRouter) {
                        const elapsed = Date.now() - retryLoopStartTime;
                        if (llm429Retries >= max429Attempts) {
                            giveUpReason = 'max_429_attempts';
                            reqLogger?.warn(`Early give-up: max 429 attempts reached (${llm429Retries}/${max429Attempts})`, {
                                retryDecision: 'give_up',
                                giveUpReason,
                                attemptedModelsCount: attemptedModels.size,
                                elapsedMs: elapsed
                            });
                            this.statsAggregator?.recordGiveUp?.(giveUpReason);
                            break;
                        }
                        if (elapsed >= max429WindowMs) {
                            giveUpReason = 'max_429_window';
                            reqLogger?.warn(`Early give-up: 429 retry window exceeded (${elapsed}ms/${max429WindowMs}ms)`, {
                                retryDecision: 'give_up',
                                giveUpReason,
                                attemptedModelsCount: attemptedModels.size,
                                llm429Retries
                            });
                            this.statsAggregator?.recordGiveUp?.(giveUpReason);
                            break;
                        }
                    }

                    // Accept the retry
                    llm429Retries++;
                    this.statsAggregator?.recordLlm429Retry?.();
                    // Detect same-model waste: 429 on a model we already tried (pool had no alternative)
                    if (modelWasAlreadyTried) {
                        this.statsAggregator?.recordSameModelRetry?.();
                    }

                    // Set delay override from Retry-After or computed delay
                    if (result.retryAfterMs) {
                        nextRetryDelayMs = result.retryAfterMs;
                    }

                    reqLogger?.info(`Accepting LLM 429 retry (${llm429Retries}/${maxLlm429Retries})`, {
                        nextRetryDelayMs,
                        evidence: result.evidence
                    });

                    // Continue to next iteration (don't break)
                } else {
                    // Standard retry logic
                    // Check if this error type should even retry
                    if (!strategy.shouldRetry) {
                        reqLogger?.warn(`Error type ${currentErrorType} is not retryable`);
                        break;  // Exit retry loop
                    }

                    // Check if we've exceeded error-specific max retries
                    if (errorSpecificRetries >= strategy.maxRetries) {
                        reqLogger?.warn(`Error-specific max retries reached for ${currentErrorType}`, {
                            errorSpecificRetries,
                            strategyMaxRetries: strategy.maxRetries
                        });
                    }
                }

                if (result.shouldExcludeKey) {
                    excludeKeys.push(keyInfo.index);
                }

                // If the error suggests using fresh connection on retry (e.g., stale socket)
                if (result.useFreshConnection) {
                    useFreshConnection = true;
                    reqLogger?.debug('Next retry will use fresh connection (bypassing agent pool)');
                }

                // If we've exhausted retries, the loop will exit
                if (attempt === this.maxRetries) {
                    reqLogger?.error('All retries exhausted', {
                        attempts: attempt + 1,
                        lastError: lastError?.message
                    });
                }

            } catch (err) {
                // Unexpected error - log and continue to next retry
                lastError = err;
                reqLogger?.error('Unexpected proxy error', { error: err.message });
                excludeKeys.push(keyInfo.index);
            }
        }

        // All retries exhausted - send error response with Retry-After
        if (!res.headersSent) {
            if (giveUpReason) {
                // EARLY GIVE-UP: Return 429 with explicit marker so operators can
                // distinguish "proxy gave up" from "upstream said 429"
                reqLogger?.warn('Early give-up: returning 429 to client', {
                    giveUpReason,
                    attemptedModelsCount: attemptedModels.size,
                    modelSwitchCount,
                    llm429Retries
                });
                res.writeHead(429, {
                    'content-type': 'application/json',
                    'retry-after': '5',
                    'x-proxy-rate-limit': 'model_exhausted',
                    'x-proxy-give-up-reason': giveUpReason,
                    'x-proxy-attempted-models': String(attemptedModels.size)
                });
                res.end(JSON.stringify({
                    error: 'All models in tier exhausted',
                    errorType: 'model_exhausted',
                    giveUpReason,
                    attemptedModelsCount: attemptedModels.size,
                    retryAfter: 5,
                    requestId
                }));
                if (attemptedModels.size > 0) {
                    this.statsAggregator?.recordFailedRequestModelStats?.(attemptedModels.size, modelSwitchCount);
                }
            } else if (lastErrorType === 'context_overflow_transient') {
                // Transient overflow exhausted retries → 503 (not 400)
                reqLogger?.warn('Transient context overflow: retries exhausted', { errorType: lastErrorType, requestId });
                res.writeHead(503, {
                    'content-type': 'application/json',
                    'retry-after': '5',
                    'x-proxy-error': 'context_overflow_transient',
                    'x-proxy-overflow-cause': 'transient_unavailable'
                });
                res.end(JSON.stringify({
                    type: 'error',
                    error: {
                        type: 'overloaded_error',
                        message: 'Models with sufficient context are temporarily at capacity. Retry shortly.'
                    },
                    requestId
                }));
            } else if (lastErrorType === 'context_overflow') {
                // Context overflow: request exceeds model context window
                // Return 400 (client error) with Anthropic-format error body
                reqLogger?.warn('Context overflow: request too large for available model', {
                    errorType: lastErrorType,
                    requestId
                });
                res.writeHead(400, {
                    'content-type': 'application/json',
                    'x-proxy-error': 'context_overflow',
                    'x-proxy-overflow-cause': 'genuine'
                });
                res.end(JSON.stringify({
                    type: 'error',
                    error: {
                        type: 'invalid_request_error',
                        message: 'Request exceeds the context window of the available model. To resolve: (1) reduce conversation history, (2) lower max_tokens, (3) remove large tool definitions, or (4) use a tier with larger-context models.'
                    },
                    requestId
                }));
            } else {
                const statusCode = lastError?.isTimeout ? 504 : 502;
                // Suggest retry delay based on error type: timeouts need more time,
                // transient errors can retry sooner
                const retryAfter = lastError?.isTimeout ? 10 : 5;
                // Log internal error details server-side
                reqLogger?.error('All retries exhausted', {
                    error: lastError?.message,
                    errorType: lastErrorType,
                    statusCode
                });
                res.writeHead(statusCode, {
                    'content-type': 'application/json',
                    'retry-after': String(retryAfter)
                });
                res.end(JSON.stringify({
                    error: lastError?.isTimeout ? 'Gateway timeout' : 'Request failed after retries',
                    errorType: lastErrorType || 'unknown',
                    retryAfter,
                    requestId
                }));
                if (attemptedModels.size > 0 && !clientDisconnected) {
                    this.statsAggregator?.recordFailedRequestModelStats?.(attemptedModels.size, modelSwitchCount);
                }
            }
        }
        trackFailure();  // Track client request failure (all retries exhausted)

        // Clean up the close listener to prevent memory leaks
        res.removeListener('close', closeHandler);
    }

    /**
     * Make a single proxy request attempt
     * @param {boolean} clientDisconnected - Flag indicating if client disconnected
     * @param {Function} onProxyReq - Callback to receive proxy request object for cleanup
     * @param {boolean} useFreshConnection - Use fresh connection (bypass agent pool) for this attempt
     * @param {RequestAttempt} traceAttempt - Current trace attempt for span tracking
     * @returns {Promise<{success: boolean, error?: Error, shouldExcludeKey?: boolean}>}
     */
    async _makeProxyRequest(req, res, body, keyInfo, requestId, reqLogger, startTime, attempt, clientDisconnected = false, onProxyReq = null, useFreshConnection = false, traceAttempt = null, attemptedModels = null, traceId = null, precomputedTransform = null) {
        // Use pre-computed transform (provider-first flow) or compute inline (legacy path)
        const { body: transformedBody, originalModel, mappedModel, routingDecision, provider: resolvedProviderName } = precomputedTransform
            || await this._transformRequestBody(body, reqLogger, keyInfo.index, req, attemptedModels);

        // Resolve per-request provider config (multi-provider support)
        const providerRegistry = this.config?._providerRegistry || null;
        const providerConfig = resolvedProviderName && providerRegistry
            ? providerRegistry.getProvider(resolvedProviderName)
            : null;
        const reqTargetHost = providerConfig ? providerConfig.targetHost : this.targetHost;
        const reqTargetBasePath = providerConfig ? providerConfig.targetBasePath : this.targetBasePath;
        const reqTargetProtocol = providerConfig ? providerConfig.targetProtocol : this.targetProtocol;
        const targetPath = reqTargetBasePath + req.url;

        const requestContent = this._extractRequestContentPreview(body);
        const requestPayload = this._extractRequestPayloadPreview(body);
        const requestPayloadFull = this._extractRequestPayloadFull(body);
        const emitRequestToStream = (eventData) => {
            this.addRequestToStream({
                ...eventData,
                ...(requestContent ? { requestContent } : {}),
                ...(requestPayload ? { requestPayload } : {}),
                ...(requestPayloadFull ? { requestPayloadFull } : {}),
                requestPayloadAvailable: !!requestPayloadFull,
                provider: resolvedProviderName || null,
                costTier: providerConfig ? providerConfig.costTier : null
            });
        };

        // Context overflow pre-flight: checked BEFORE capacity gate so oversized
        // requests get a deterministic 400 instead of a retryable capacity error.
        if (routingDecision && routingDecision.contextOverflow) {
            const { estimatedTokens, modelContextLength, overflowBy, cause } = routingDecision.contextOverflow;

            // Feature flag: transient overflow retries (off by default for safe canary rollout).
            // When enabled, transient overflows return a retryable signal so the retry loop
            // can re-route once a 200K-context model frees up.  When disabled (default),
            // transient overflows fall through to the genuine 400 path.
            const transientRetryEnabled = this.config?.modelRouting?.transientOverflowRetry?.enabled === true;

            if (cause === 'transient_unavailable' && transientRetryEnabled) {
                reqLogger?.warn('Transient context overflow: models with sufficient context temporarily unavailable', {
                    estimatedTokens, modelContextLength, overflowBy, model: mappedModel, cause
                });
                emitRequestToStream({
                    requestId,
                    traceId,
                    keyIndex: keyInfo.index,
                    originalModel,
                    mappedModel,
                    path: req.url,
                    method: req.method,
                    status: 503,
                    success: false,
                    retries: attempt,
                    streaming: false,
                    latencyMs: Date.now() - startTime,
                    errorType: 'context_overflow_transient',
                    error: 'Models with sufficient context are temporarily unavailable'
                });
                // Stats: router-level contextOverflowByCause tracks transient vs genuine.
                this.statsAggregator?.recordContextOverflowTransient?.();
                this.keyManager.releaseKey(keyInfo);
                if (this.modelRouter && routingDecision.committed) {
                    this.modelRouter.releaseModel(mappedModel);
                }
                return {
                    success: false,
                    errorType: 'context_overflow_transient',
                    shouldExcludeKey: false,
                    shouldRetry: true,
                    mappedModel,
                    routingDecision
                };
            }

            // Genuine overflow — non-retryable path
            reqLogger?.warn(`Context overflow: request ~${estimatedTokens} tokens exceeds ${mappedModel} context ${modelContextLength} by ${overflowBy}`, {
                estimatedTokens,
                modelContextLength,
                overflowBy,
                model: mappedModel
            });
            emitRequestToStream({
                requestId,
                traceId,
                keyIndex: keyInfo.index,
                originalModel,
                mappedModel,
                path: req.url,
                method: req.method,
                status: 400,
                success: false,
                retries: attempt,
                streaming: false,
                latencyMs: Date.now() - startTime,
                errorType: 'context_overflow',
                error: 'Request exceeds context window'
            });
            this.statsAggregator?.recordError('context_overflow');
            this.keyManager.releaseKey(keyInfo);
            // Only release model slot if decision was committed (slot was acquired).
            // Context overflow decisions are returned uncommitted — no slot to release.
            if (this.modelRouter && routingDecision.committed) {
                this.modelRouter.releaseModel(mappedModel);
            }
            return {
                success: false,
                errorType: 'context_overflow',
                shouldExcludeKey: false,
                shouldRetry: false,
                mappedModel,
                routingDecision
            };
        }

        // Per-model concurrency gate: reject if model is at upstream capacity.
        // Router slot already acquired by selectModel() → commitDecision().
        // This gate is KeyManager's authority (per-key concurrency, separate concern).
        if (mappedModel && this.keyManager.isModelAtCapacity?.(mappedModel)) {
            reqLogger?.warn(`Model ${mappedModel} at capacity, queuing for retry`, {
                inFlight: this.keyManager.getModelInFlight?.(mappedModel),
                attempt
            });
            this.statsAggregator?.recordError('model_at_capacity');
            this.keyManager.releaseKey(keyInfo);
            // Only release pool slot if decision was committed (slot was acquired)
            if (this.modelRouter && routingDecision?.committed) {
                this.modelRouter.releaseModel(mappedModel);
            }
            return {
                success: false,
                errorType: 'model_at_capacity',
                shouldExcludeKey: false,
                shouldRetry: true,
                retryAfterMs: 500 + Math.floor(Math.random() * 500),
                mappedModel,
                routingDecision
            };
        }

        // Acquire per-model concurrency slot (KeyManager authority)
        const modelSlotAcquired = mappedModel ? (this.keyManager.acquireModelSlot?.(mappedModel) ?? true) : true;

        // Calculate adaptive timeout based on key's latency profile and model latency
        const adaptiveTimeout = this._calculateTimeout(keyInfo, attempt, mappedModel);

        // Track adaptive timeout usage
        this.statsAggregator?.recordAdaptiveTimeout(adaptiveTimeout);

        // Log without exposing key data (security fix)
        reqLogger?.info(`${req.method} ${req.url} -> Key #${keyInfo.index}`, {
            circuit: keyInfo.circuitBreaker.state,
            inFlight: keyInfo.inFlight,
            attempt: attempt + 1,
            timeout: adaptiveTimeout
        });

        // BURST PACING: Wait for an upstream slot before sending
        // This prevents connection storms during burst traffic
        await this._acquireUpstreamSlot();

        return new Promise((resolve) => {
            let completed = false;
            // STREAMING SAFETY: Track if we've written anything to response
            // This is stricter than res.headersSent (covers edge cases where chunks sent without headers)
            let responseStarted = false;

            const complete = (result) => {
                if (!completed) {
                    completed = true;
                    // Release upstream pacing slot
                    this._releaseUpstreamSlot();
                    // Release per-model concurrency slot
                    if (mappedModel && modelSlotAcquired) {
                        this.keyManager.releaseModelSlot?.(mappedModel);
                    }
                    // Release pool slot for load-balanced distribution
                    if (mappedModel && this.modelRouter) {
                        this.modelRouter.releaseModel(mappedModel);
                    }
                    // Include responseStarted and mappedModel in result so retry loop
                    // can add failed model to attemptedModels for model switching
                    resolve({ ...result, responseStarted, mappedModel });
                }
            };

            // Build headers - strip sensitive/hop-by-hop headers
            const headers = { ...req.headers };

            // Strip authentication headers (we set our own)
            delete headers['authorization'];
            delete headers['x-api-key'];

            // Strip admin token header to prevent leakage to upstream
            delete headers['x-admin-token'];

            // Strip cookie to prevent session leakage
            delete headers['cookie'];

            // Strip hop-by-hop headers (RFC 2616 Section 13.5.1)
            const hopByHopHeaders = [
                'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
                'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'
            ];
            for (const h of hopByHopHeaders) {
                delete headers[h];
            }

            // Also strip headers listed in Connection header
            const connectionHeader = req.headers['connection'];
            if (connectionHeader) {
                for (const h of connectionHeader.split(',').map(s => s.trim().toLowerCase())) {
                    delete headers[h];
                }
            }

            // Strip host (we set our own)
            delete headers['host'];

            // Strip any internal proxy headers (x-proxy-*) to prevent leakage on retries
            for (const key of Object.keys(headers)) {
                if (key.toLowerCase().startsWith('x-proxy-')) {
                    delete headers[key];
                }
            }

            // Use fresh connection (no agent) if requested (e.g., after stale socket hangup)
            // This bypasses the connection pool to avoid reusing potentially stale sockets
            const agentToUse = useFreshConnection ? false : this.agent;
            if (useFreshConnection) {
                reqLogger?.debug('Using fresh connection (agent: false) for this attempt');
            }

            // Parse port from targetHost — use per-request target for multi-provider
            const [targetHostname, targetPortStr] = reqTargetHost.split(':');
            const useHttps = reqTargetProtocol === 'https:';
            const defaultPort = useHttps ? 443 : 80;
            const targetPort = targetPortStr ? parseInt(targetPortStr, 10) : defaultPort;

            // Auth headers per provider (GUARD-05: key isolation — exactly one scheme per provider)
            const authHeaders = {};
            if (providerRegistry && resolvedProviderName) {
                const auth = providerRegistry.formatAuthHeader(resolvedProviderName, keyInfo.key);
                if (auth) authHeaders[auth.headerName] = auth.headerValue;
            } else {
                // No registry (shouldn't happen — config.js always creates one).
                // Fall back to x-api-key only (default z.ai scheme).
                authHeaders['x-api-key'] = keyInfo.key;
            }

            // Provider extra headers with denylist to prevent override of structural headers
            const RESERVED_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'x-api-key', 'authorization', 'x-request-id']);
            const rawExtra = providerConfig?.extraHeaders || {};
            const extraHeaders = {};
            for (const [k, v] of Object.entries(rawExtra)) {
                if (RESERVED_HEADERS.has(k.toLowerCase())) {
                    reqLogger?.warn('Provider extraHeaders attempted to override reserved header, ignored', { header: k, provider: resolvedProviderName });
                } else {
                    extraHeaders[k] = v;
                }
            }

            const options = {
                hostname: targetHostname,
                port: targetPort,
                path: targetPath,
                method: req.method,
                agent: agentToUse,
                timeout: adaptiveTimeout,  // Use adaptive timeout
                headers: {
                    ...headers,
                    'host': reqTargetHost,
                    ...authHeaders,
                    ...extraHeaders,
                    'connection': 'keep-alive',
                    'x-request-id': requestId
                }
            };

            if (transformedBody.length > 0) {
                options.headers['content-length'] = transformedBody.length;
            }

            // Add UPSTREAM_START span when request is about to be sent
            const upstreamSpan = traceAttempt?.addSpan(SpanType.UPSTREAM_START, {
                metadata: { targetHost: reqTargetHost, targetPath, provider: resolvedProviderName }
            });

            const requestFn = useHttps ? https.request : http.request;
            const proxyReq = requestFn(options, (proxyRes) => {
                const latencyMs = Date.now() - startTime;

                // End UPSTREAM_START span and add FIRST_BYTE span
                upstreamSpan?.end();
                const firstByteSpan = traceAttempt?.addSpan(SpanType.FIRST_BYTE, {
                    status: proxyRes.statusCode
                });
                firstByteSpan?.end();

                // Already handled by another code path
                if (completed || res.headersSent) {
                    proxyRes.resume();
                    complete({ success: true });
                    return;
                }

                // Rate limited (429) - handle based on route
                // LLM routes (/v1/messages) get conditional retry; other routes pass through
                if (proxyRes.statusCode === 429) {
                    // Parse Retry-After header if present
                    const retryAfter = proxyRes.headers['retry-after'];
                    const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : null;

                    // BUILD 429 PROVENANCE EVIDENCE
                    // This can ONLY exist when upstream actually returned 429
                    const evidence = {
                        source: 'upstream',
                        status: 429,
                        upstreamHost: reqTargetHost,
                        retryAfterHeader: retryAfter ?? null,
                        retryAfterMs: retryAfterMs,
                        reusedSocket: !!proxyReq.reusedSocket,
                        timestamp: Date.now(),
                        // Whitelist safe headers for debugging
                        headers: {
                            'x-request-id': proxyRes.headers['x-request-id'],
                            'x-ratelimit-limit': proxyRes.headers['x-ratelimit-limit'],
                            'x-ratelimit-remaining': proxyRes.headers['x-ratelimit-remaining'],
                            'x-ratelimit-reset': proxyRes.headers['x-ratelimit-reset']
                        }
                    };

                    // POOL-LEVEL RATE LIMIT TRACKING
                    // Record pool-level 429 for detecting global/account rate limits
                    // Use poolCooldownConfig from config (not hardcoded) for consistent behavior.
                    // Prefer upstream Retry-After for baseMs when available.
                    const poolResult = this.keyManager.recordPoolRateLimitHit({
                        model: mappedModel,
                        baseMs: retryAfterMs || this.poolCooldownConfig.baseMs || 300,
                        capMs: this.poolCooldownConfig.capMs || 15000
                    });

                    // Adaptive concurrency: congestion signal from upstream 429
                    if (mappedModel) {
                        this.adaptiveConcurrency?.recordCongestion(mappedModel, {
                            retryAfterMs: retryAfterMs || null,
                            errorCode: null,
                            errorBody: null
                        });
                    }

                    // ACCOUNT-LEVEL 429 DETECTION
                    // If multiple unique keys hit 429 within a short window, this is account-level
                    const accountResult = this.keyManager.detectAccountLevelRateLimit?.(keyInfo.index);
                    if (accountResult?.isAccountLevel) {
                        // When model router is active, "account-level" may actually be per-model saturation
                        // Allow retry so the router can switch to a different model instead of failing
                        if (this.modelRouter && routingDecision) {
                            reqLogger?.warn('Account-level rate limit detected but model router active, allowing retry for model fallback', {
                                cooldownMs: accountResult.cooldownMs,
                                keyIndex: keyInfo.index,
                                currentModel: mappedModel
                            });
                            // Fall through to normal 429 retry path (don't return early)
                        } else {
                            reqLogger?.warn('Account-level rate limit detected, returning 429 immediately', {
                                cooldownMs: accountResult.cooldownMs,
                                keyIndex: keyInfo.index
                            });

                            // Drain upstream response
                            proxyRes.resume();

                            // Return 429 to client with account scope marker
                            if (!res.headersSent) {
                                const retryAfterSecs = Math.ceil(accountResult.cooldownMs / 1000);
                                responseStarted = true;
                                res.writeHead(429, {
                                    'content-type': 'application/json',
                                    'retry-after': String(retryAfterSecs),
                                    'x-rate-limit-scope': 'account'
                                });
                                res.end(JSON.stringify({
                                    error: 'Rate limited',
                                    reason: 'account_rate_limited',
                                    scope: 'account',
                                    retryAfter: retryAfterSecs,
                                    requestId
                                }));
                            }

                            complete({
                                success: false,
                                errorType: 'rate_limited',
                                passedThrough: true
                            });
                            return;
                        }
                    }

                    // AVOID DOUBLE-PENALIZING: If this is a pool-level burst (pool429Count > 1),
                    // don't aggressively increase per-key cooldown (would cause "blackhole" effect)
                    // Instead, use a shorter cooldown that respects pool cooldown
                    const isPoolBurst = poolResult.pool429Count > 1;
                    const perKeyCooldownMs = isPoolBurst
                        ? Math.min(1000, poolResult.cooldownMs)  // Minimal per-key during pool burst
                        : retryAfterMs;  // Normal per-key handling

                    const usageData = this.keyManager.recordRateLimit(keyInfo, perKeyCooldownMs);

                    this.statsAggregator?.recordKeyUsage(keyInfo.keyId, usageData);
                    this.statsAggregator?.recordError('rate_limited');
                    this.statsAggregator?.recordUpstream429?.();  // Track upstream vs local 429s

                    // Record per-model 429
                    if (mappedModel) {
                        this.statsAggregator?.recordModelUsage(mappedModel, {
                            latencyMs,
                            success: false,
                            is429: true
                        });
                    }

                    // ROUTE-AWARE RETRY POLICY
                    // Only /v1/messages is worth retrying (actual LLM calls)
                    // Telemetry and other routes should pass through
                    const isLLMRoute = req.url.startsWith('/v1/messages');
                    // Use both res.headersSent AND responseStarted for safety
                    const canRetry = isLLMRoute && !res.headersSent && !responseStarted;

                    // Compute retry delay: use Retry-After or adaptive cooldown
                    // Use per-model pool429Count (not legacy global) to avoid cross-model contamination
                    const computedRetryDelayMs = retryAfterMs || Math.min(
                        1000 * Math.pow(2, poolResult.pool429Count - 1),
                        this.poolCooldownConfig.capMs || 15000
                    );

                    // Record 429 for pool penalty scoring (fires on EVERY upstream 429,
                    // including burst-dampened, to feed the sliding window counter)
                    this.modelRouter?.recordPool429?.(mappedModel);

                    // Per-model cooldown tracking (separate from per-key)
                    if (this.modelRouter && mappedModel) {
                        const persistentThrottle = poolResult.pool429Count >= 3;
                        if (isPoolBurst && !persistentThrottle) {
                            // Transient burst: dampen cooldown to avoid false-positive fallback.
                            // CRITICAL: cooldown must be >= computedRetryDelayMs (the retry sleep).
                            // If cooldown < retry delay, the model appears available before the
                            // retry fires, causing guaranteed re-selection and another 429.
                            const factor = this.modelRouter.config.cooldown?.burstDampeningFactor ?? 0.2;
                            const dampenedMs = Math.max(
                                computedRetryDelayMs,  // floor: at least as long as retry delay
                                Math.max(100, Math.round(computedRetryDelayMs * factor))
                            );
                            this.modelRouter.recordModelCooldown(mappedModel, dampenedMs, { burstDampened: true });
                        } else {
                            // Persistent throttling or first 429: use full cooldown to trigger model fallback
                            this.modelRouter.recordModelCooldown(
                                mappedModel,
                                computedRetryDelayMs || (this.modelRouter.config.cooldown?.defaultMs || 5000)
                            );
                        }
                    }

                    // Determine retry decision for observability
                    // Use wasAlreadyBlocked from pool hit result to avoid catch-22:
                    // the 429 that JUST triggered the cooldown should still be retryable
                    const poolCooldownRemainingMs = this.keyManager.getPoolCooldownRemainingMs?.(mappedModel) || 0;
                    const rawPoolBlocked = poolResult.wasAlreadyBlocked === true;
                    // When model router is active, pool_blocked should NOT prevent retry
                    // because the router can switch to a different model in the pool on retry
                    // (pool cooldown is per-model, other models may still be available)
                    const hasRouterAlternatives = this.modelRouter && routingDecision;
                    const poolBlocked = rawPoolBlocked && !hasRouterAlternatives;
                    let retryDecision;
                    if (!isLLMRoute) {
                        retryDecision = 'pass_through_non_llm';
                    } else if (res.headersSent || responseStarted) {
                        retryDecision = 'pass_through_response_started';
                    } else if (poolBlocked) {
                        retryDecision = 'pool_blocked';
                    } else if (rawPoolBlocked && hasRouterAlternatives) {
                        retryDecision = 'pool_blocked_router_retry';
                    } else {
                        retryDecision = 'retry';
                    }

                    // Determine route policy for observability
                    const routePolicy = isLLMRoute ? 'llm' :
                        req.url.startsWith('/api/event_logging') ? 'telemetry' :
                        req.url.startsWith('/admin') ? 'admin' : 'other';

                    // Emit request event with full observability
                    emitRequestToStream({
                        traceId: traceId,  // Include actual traceId for detail lookup
                        requestId,
                        keyIndex: keyInfo.index,
                        keyPrefix: keyInfo.keyPrefix,
                        method: req.method,
                        path: req.url,
                        status: 429,
                        latencyMs,
                        success: false,
                        error: 'rate_limited',
                        // Observability fields
                        attempt: attempt + 1,
                        errorType: 'upstream_429',
                        retryDecision,
                        routePolicy,
                        poolCooldownRemainingMs,
                        pool429Count: poolResult.pool429Count,
                        isPoolBurst,
                        modelCooldownMode: (this.modelRouter && mappedModel) ? (isPoolBurst ? 'burst' : 'normal') : null,
                        // Provenance evidence (without secrets)
                        evidence,
                        originalModel,
                        mappedModel,
                        routingDecision: routingDecision ? {
                            tier: routingDecision.tier,
                            source: routingDecision.source,
                            reason: routingDecision.reason
                        } : null,
                        trace: routingDecision?.trace || null,
                        attemptedModelsCount: attemptedModels ? attemptedModels.size : 0
                    });

                    // If pool is in cooldown, don't retry (would just hit another 429)
                    const effectiveCanRetry = canRetry && !poolBlocked;

                    if (effectiveCanRetry) {
                        // RETRYABLE PATH: Don't write response, let retry loop handle it
                        reqLogger?.info(`Key #${keyInfo.index} rate limited (429) - LLM route, allowing retry`, {
                            latencyMs,
                            retryAfterMs: computedRetryDelayMs,
                            evidence
                        });

                        // Add RETRY span for rate limit
                        traceAttempt?.addSpan(SpanType.RETRY, {
                            error: 'rate_limited',
                            metadata: { retryAfterMs: computedRetryDelayMs }
                        }).end();
                        traceAttempt?.markRetry('rate_limited');
                        traceAttempt?.end(false, 429, 'rate_limited');

                        // IMPORTANT: Drain the upstream response without piping to client
                        proxyRes.resume();

                        // Return retryable result
                        // When modelRouter is active, 429s are per-model per-account — key
                        // rotation is useless (same account limit). Keep the key, let the
                        // router switch models on retry. Without modelRouter, legacy key
                        // rotation still applies.
                        const hasModelRouter = !!(this.modelRouter && routingDecision);
                        complete({
                            success: false,
                            errorType: 'rate_limited',
                            shouldExcludeKey: !hasModelRouter,  // Only rotate keys in legacy mode
                            shouldRetry: true,
                            retryAfterMs: computedRetryDelayMs,
                            evidence,
                            mappedModel,
                            routingDecision
                        });
                    } else {
                        // PASS-THROUGH PATH: Non-LLM route, response already started, or pool blocked
                        reqLogger?.warn(`Key #${keyInfo.index} rate limited (429) - passing to client`, {
                            latencyMs,
                            retryDecision,
                            isLLMRoute,
                            headersSent: res.headersSent,
                            poolBlocked,
                            poolCooldownRemainingMs
                        });

                        // Add ERROR span for rate limit pass-through
                        traceAttempt?.addSpan(SpanType.ERROR, {
                            error: 'rate_limited',
                            status: 429,
                            metadata: { passedThrough: true, retryDecision }
                        }).end();
                        traceAttempt?.end(false, 429, 'rate_limited');

                        // Pass the 429 response directly to client
                        if (!res.headersSent) {
                            responseStarted = true;  // Mark response as started before writing
                            res.writeHead(429, proxyRes.headers);
                            proxyRes.pipe(res);
                        }

                        proxyRes.on('end', () => complete({
                            success: false,
                            errorType: 'rate_limited',
                            passedThrough: true,  // Response was sent to client
                            evidence
                        }));
                    }
                    return;
                }

                // Auth error (401/403) - key is likely invalid, circuit break it
                if (proxyRes.statusCode === 401 || proxyRes.statusCode === 403) {
                    const usageData = this.keyManager.recordFailure(keyInfo, 'auth_error');
                    this.statsAggregator?.recordKeyUsage(keyInfo.keyId, usageData);
                    this.statsAggregator?.recordError('auth_error');

                    // Record per-model auth error
                    if (mappedModel) {
                        this.statsAggregator?.recordModelUsage(mappedModel, {
                            latencyMs,
                            success: false,
                            is429: false
                        });
                    }

                    // Emit request event for auth error
                    emitRequestToStream({
                        traceId: traceId,  // Include actual traceId for detail lookup
                        requestId,
                        keyIndex: keyInfo.index,
                        keyPrefix: keyInfo.keyPrefix,
                        method: req.method,
                        path: req.url,
                        status: proxyRes.statusCode,
                        latencyMs,
                        success: false,
                        error: 'auth_error',
                        originalModel,
                        mappedModel,
                        routingDecision: routingDecision ? {
                            tier: routingDecision.tier,
                            source: routingDecision.source,
                            reason: routingDecision.reason
                        } : null,
                        attemptedModelsCount: attemptedModels ? attemptedModels.size : 0
                    });

                    reqLogger?.error(`Key #${keyInfo.index} auth error (${proxyRes.statusCode}) - key may be invalid`, { latencyMs });

                    // Add ERROR span for auth error
                    traceAttempt?.addSpan(SpanType.ERROR, {
                        error: 'auth_error',
                        status: proxyRes.statusCode
                    }).end();
                    traceAttempt?.end(false, proxyRes.statusCode, 'auth_error');

                    // Don't retry auth errors - pass through to client
                    // But DO exclude this key from future requests in this retry cycle
                    proxyRes.resume();
                    complete({
                        success: false,
                        error: new Error(`Auth error: ${proxyRes.statusCode}`),
                        shouldExcludeKey: true,
                        errorType: 'auth_error'
                    });
                    return;
                }

                // Server error - retryable
                if (proxyRes.statusCode >= 500) {
                    const usageData = this.keyManager.recordFailure(keyInfo, 'server_error');
                    this.statsAggregator?.recordKeyUsage(keyInfo.keyId, usageData);
                    this.statsAggregator?.recordError('server_error');

                    // Record per-model server error
                    if (mappedModel) {
                        this.statsAggregator?.recordModelUsage(mappedModel, {
                            latencyMs,
                            success: false,
                            is429: false
                        });
                    }

                    // Emit request event for failed request
                    emitRequestToStream({
                        traceId: traceId,  // Include actual traceId for detail lookup
                        requestId,
                        keyIndex: keyInfo.index,
                        keyPrefix: keyInfo.keyPrefix,
                        method: req.method,
                        path: req.url,
                        status: proxyRes.statusCode,
                        latencyMs,
                        success: false,
                        error: 'server_error',
                        originalModel,
                        mappedModel,
                        routingDecision: routingDecision ? {
                            tier: routingDecision.tier,
                            source: routingDecision.source,
                            reason: routingDecision.reason
                        } : null,
                        trace: routingDecision?.trace || null,
                        attemptedModelsCount: attemptedModels ? attemptedModels.size : 0
                    });

                    reqLogger?.warn(`Key #${keyInfo.index} returned ${proxyRes.statusCode}`, { latencyMs });

                    // Add RETRY span for server error (retryable)
                    traceAttempt?.addSpan(SpanType.RETRY, {
                        error: 'server_error',
                        status: proxyRes.statusCode
                    }).end();
                    traceAttempt?.markRetry('server_error');
                    traceAttempt?.end(false, proxyRes.statusCode, 'server_error');

                    proxyRes.resume();
                    complete({
                        success: false,
                        error: new Error(`Server error: ${proxyRes.statusCode}`),
                        shouldExcludeKey: true,
                        errorType: 'server_error'
                    });
                    return;
                }

                // Success (or client error which is not retryable)
                const usageData = this.keyManager.recordSuccess(keyInfo, latencyMs);
                this.statsAggregator?.recordKeyUsage(keyInfo.keyId, usageData);

                // Adaptive concurrency: success signal (upstream-routed requests only)
                if (mappedModel) {
                    this.adaptiveConcurrency?.recordSuccess(mappedModel);
                }

                // Record successful connection (resets hangup counter)
                this.connectionMonitor.recordSuccess();

                // Proactive pacing: record rate limit headers for model-aware throttling
                if (mappedModel && proxyRes.headers) {
                    this.keyManager.recordRateLimitHeaders?.(
                        mappedModel,
                        proxyRes.headers,
                        this.config.proactivePacing || {}
                    );
                }

                // Collect response chunks for token usage parsing (PHASE 2 - Task #4)
                // MEMORY SAFETY: Only keep last 64KB to prevent memory blowup on large streams
                // Token usage data appears at end of response, so tail is sufficient
                const MAX_BUFFER_SIZE = 64 * 1024; // 64KB
                const responseChunks = [];
                let totalResponseSize = 0;
                proxyRes.on('data', (chunk) => {
                    responseChunks.push(chunk);
                    totalResponseSize += chunk.length;
                    // Trim from front when exceeding budget to keep tail (token usage is at end)
                    while (totalResponseSize > MAX_BUFFER_SIZE && responseChunks.length > 1) {
                        totalResponseSize -= responseChunks.shift().length;
                    }
                });

                proxyRes.on('end', () => {
                    // Parse token usage from response (wrap single buffer in array for parser)
                    const responseBuffer = Buffer.concat(responseChunks);
                    const tokenUsage = this.parseTokenUsage([responseBuffer]);
                    if (tokenUsage) {
                        this.statsAggregator?.recordTokenUsage(keyInfo.keyId, tokenUsage);

                        // Record cost for billing
                        if (this.costTracker) {
                            this.costTracker.recordUsage(
                                keyInfo.keyId,
                                tokenUsage.input_tokens || 0,
                                tokenUsage.output_tokens || 0,
                                mappedModel || originalModel
                            );
                        }
                    }

                    // Record per-model usage
                    if (mappedModel) {
                        this.statsAggregator?.recordModelUsage(mappedModel, {
                            latencyMs,
                            success: true,
                            is429: false,
                            inputTokens: tokenUsage?.input_tokens || 0,
                            outputTokens: tokenUsage?.output_tokens || 0
                        });
                    }

                    // Calculate per-request cost
                    const inTok = tokenUsage?.input_tokens || 0;
                    const outTok = tokenUsage?.output_tokens || 0;
                    const costModel = mappedModel || originalModel;
                    let requestCost = null;
                    if (this.costTracker && (inTok > 0 || outTok > 0)) {
                        const rates = this.costTracker.getRatesByModel(costModel);
                        requestCost = {
                            total: Math.round(((inTok / 1e6) * rates.inputTokenPer1M + (outTok / 1e6) * rates.outputTokenPer1M) * 1e6) / 1e6,
                            inputCost: Math.round((inTok / 1e6) * rates.inputTokenPer1M * 1e6) / 1e6,
                            outputCost: Math.round((outTok / 1e6) * rates.outputTokenPer1M * 1e6) / 1e6,
                            model: costModel,
                            inputRate: rates.inputTokenPer1M,
                            outputRate: rates.outputTokenPer1M
                        };
                    }

                    // Emit request event for successful request
                    emitRequestToStream({
                        traceId: traceId,  // Include actual traceId for detail lookup
                        requestId,
                        keyIndex: keyInfo.index,
                        keyPrefix: keyInfo.keyPrefix,
                        method: req.method,
                        path: req.url,
                        status: proxyRes.statusCode,
                        latencyMs,
                        success: true,
                        inputTokens: inTok,
                        outputTokens: outTok,
                        originalModel,
                        mappedModel,
                        cost: requestCost,
                        routingDecision: routingDecision ? {
                            tier: routingDecision.tier,
                            source: routingDecision.source,
                            reason: routingDecision.reason
                        } : null,
                        trace: routingDecision?.trace || null,
                        attemptedModelsCount: attemptedModels ? attemptedModels.size : 0
                    });
                });

                reqLogger?.info(`Response ${proxyRes.statusCode}`, { latencyMs, keyIndex: keyInfo.index });

                // Add STREAMING span
                const streamingSpan = traceAttempt?.addSpan(SpanType.STREAMING);

                responseStarted = true;  // Mark response as started before writing
                let streamEnded = false;
                res.writeHead(proxyRes.statusCode, proxyRes.headers);
                proxyRes.pipe(res);
                proxyRes.on('end', () => {
                    if (streamEnded) return;
                    streamEnded = true;
                    streamingSpan?.end();
                    traceAttempt?.addSpan(SpanType.COMPLETE, { status: proxyRes.statusCode }).end();
                    traceAttempt?.end(true, proxyRes.statusCode);
                    complete({ success: true });
                });
                proxyRes.on('error', () => {
                    if (streamEnded) return;
                    streamEnded = true;
                    streamingSpan?.end();
                    traceAttempt?.end(true, proxyRes.statusCode);  // Response started, consider success
                    complete({ success: true });
                });
            });

            // FIX: Explicitly enforce adaptive timeout on socket assignment.
            // Node.js v22 parses Keep-Alive: timeout=N from upstream responses and sets
            // socket.setTimeout(N*1000) on pooled sockets. When reused, the server's
            // short keep-alive timeout (e.g., 5s from Z.AI API) overrides our adaptive
            // timeout, causing premature timeout events on heavy-tier models.
            proxyReq.on('socket', (socket) => {
                if (socket.timeout !== adaptiveTimeout) {
                    socket.setTimeout(adaptiveTimeout);
                }
            });

            proxyReq.on('timeout', () => {
                // Don't count timeout if response already started streaming or completed
                if (completed || responseStarted) return;

                const usageData = this.keyManager.recordFailure(keyInfo, 'timeout');
                this.statsAggregator?.recordKeyUsage(keyInfo.keyId, usageData);
                this.statsAggregator?.recordError('timeout');

                proxyReq.destroy();

                reqLogger?.warn(`Key #${keyInfo.index} timeout`, {
                    adaptiveTimeout,
                    elapsedMs: Date.now() - startTime,
                    mappedModel
                });

                // Emit timeout event to SSE stream for dashboard visibility
                emitRequestToStream({
                    traceId,
                    requestId,
                    keyIndex: keyInfo.index,
                    keyPrefix: keyInfo.keyPrefix,
                    method: req.method,
                    path: req.url,
                    status: 'timeout',
                    latencyMs: Date.now() - startTime,
                    success: false,
                    error: 'timeout',
                    attempt: attempt + 1,
                    originalModel,
                    mappedModel,
                    routingDecision: routingDecision ? {
                        tier: routingDecision.tier,
                        source: routingDecision.source,
                        reason: routingDecision.reason
                    } : undefined
                });

                // Add TIMEOUT span
                upstreamSpan?.end();
                traceAttempt?.addSpan(SpanType.TIMEOUT).end();
                traceAttempt?.end(false, 'timeout', 'Request timeout');

                // Adaptive concurrency: timeout treated as congestion signal
                // Timeouts on overloaded models (e.g. glm-4.5) should reduce effective concurrency
                if (mappedModel) {
                    this.adaptiveConcurrency?.recordCongestion(mappedModel, {
                        retryAfterMs: null,
                        errorCode: 'timeout',
                        errorBody: null
                    });
                }

                const error = new Error('Request timeout');
                error.isTimeout = true;
                complete({ success: false, error, shouldExcludeKey: true, errorType: 'timeout' });
            });

            proxyReq.on('error', (err) => {
                if (completed) return;

                // Categorize the error and get strategy
                const errorType = this._categorizeError(err);
                const strategy = this._getErrorStrategy(errorType);

                // End upstream span on error
                upstreamSpan?.end();

                if (errorType === 'socket_hangup') {
                    // Socket hangup - track for connection health monitoring
                    this.connectionMonitor.recordHangup();

                    const usageData = this.keyManager.recordSocketHangup(keyInfo);
                    this.statsAggregator?.recordKeyUsage(keyInfo.keyId, usageData);
                    this.statsAggregator?.recordError('socket_hangup');

                    // INSTRUMENTATION: Log detailed hangup diagnostics
                    // This helps identify root cause: stale keep-alive vs client abort vs network
                    reqLogger?.warn(`Key #${keyInfo.index} socket hangup`, {
                        reusedSocket: proxyReq.reusedSocket || false,  // Was this a reused keep-alive socket?
                        clientDisconnected,                           // Did client abort?
                        consecutiveHangups: this.connectionMonitor.consecutiveHangups,
                        totalHangups: this.connectionMonitor.totalHangups,
                        attempt: attempt + 1,
                        socketLocalPort: proxyReq.socket?.localPort,
                        socketRemotePort: proxyReq.socket?.remotePort
                    });

                    // Emit socket hangup event to SSE stream for dashboard visibility
                    emitRequestToStream({
                        traceId,
                        requestId,
                        keyIndex: keyInfo.index,
                        keyPrefix: keyInfo.keyPrefix,
                        method: req.method,
                        path: req.url,
                        status: 'error',
                        latencyMs: Date.now() - startTime,
                        success: false,
                        error: 'socket_hangup',
                        attempt: attempt + 1,
                        originalModel,
                        mappedModel,
                        routingDecision: routingDecision ? {
                            tier: routingDecision.tier,
                            source: routingDecision.source,
                            reason: routingDecision.reason
                        } : undefined
                    });

                    // Track hangup cause for stats
                    this.statsAggregator?.recordHangupCause?.({
                        reusedSocket: proxyReq.reusedSocket || false,
                        clientDisconnected,
                        keyIndex: keyInfo.index
                    });

                    // Only recreate agent after sustained hangups (not on stale reuse)
                    // Stale reuse is better fixed by fresh connection retry
                    if (this.connectionMonitor.shouldRecreateAgent()) {
                        this._recreateAgent();
                    }

                    // Add ERROR span for socket hangup
                    traceAttempt?.addSpan(SpanType.ERROR, { error: 'socket_hangup' }).end();
                    traceAttempt?.end(false, 'socket_hangup', err.message);

                    // Use strategy to determine key exclusion
                    // Signal that this retry should use fresh connection
                    complete({
                        success: false,
                        error: err,
                        shouldExcludeKey: strategy.excludeKey,
                        errorType,
                        useFreshConnection: strategy.useFreshConnection
                    });
                } else {
                    const usageData = this.keyManager.recordFailure(keyInfo, errorType);
                    this.statsAggregator?.recordKeyUsage(keyInfo.keyId, usageData);
                    this.statsAggregator?.recordError(errorType, { code: err.code, message: err.message });

                    reqLogger?.warn(`Key #${keyInfo.index} error (${errorType}): ${err.message}`);

                    // Add ERROR span
                    traceAttempt?.addSpan(SpanType.ERROR, { error: errorType }).end();
                    traceAttempt?.end(false, errorType, err.message);

                    // Use strategy to determine key exclusion
                    complete({
                        success: false,
                        error: err,
                        shouldExcludeKey: strategy.excludeKey,
                        errorType
                    });
                }
            });

            // Handle proxyReq close/abort - ensures Promise resolves when destroy() is called
            // This is important for client abort handling (Milestone 5)
            proxyReq.on('close', () => {
                if (!completed) {
                    // If we haven't completed yet and the request is closing, it was likely aborted
                    complete({
                        success: false,
                        error: new Error('Request aborted'),
                        errorType: 'aborted'
                    });
                }
            });

            // NOTE: Client disconnect handling is done via a single listener in _proxyWithRetries
            // to prevent listener leaks on retries. We notify the parent of our proxyReq.
            if (onProxyReq) {
                onProxyReq(proxyReq);
            }

            // Check if client already disconnected before we send
            if (clientDisconnected) {
                proxyReq.destroy();
                complete({ success: false, error: new Error('Client disconnected') });
                return;
            }

            if (transformedBody.length > 0) {
                proxyReq.write(transformedBody);
            }
            proxyReq.end();
        });
    }

    /**
     * Categorize an error for better stats tracking
     * @param {Error} err - The error to categorize
     * @returns {string} Error category
     *
     * Delegates to the extracted error-classifier module.
     * This method is kept for backward compatibility and can be deprecated in future.
     */
    _categorizeError(err) {
        return categorizeError(err);
    }

    /**
     * Destroy the agent and queue (cleanup)
     */
    destroy() {
        this.agent.destroy();
        this.requestQueue.clear('shutdown');
        this.requestPayloadStore.clear();
        // Drain upstream waiters so blocked requests can exit gracefully
        while (this._upstreamWaiters.length > 0) {
            const resolve = this._upstreamWaiters.shift();
            resolve();
        }
    }

    /**
     * Get queue instance (for monitoring/testing)
     */
    getQueue() {
        return this.requestQueue;
    }

    // ========== REQUEST TRACING (Week 2) ==========

    /**
     * Get trace by ID
     * @param {string} traceId - Trace ID or request ID
     * @returns {RequestTrace|null}
     */
    getTrace(traceId) {
        return this.traceStore.get(traceId) || this.traceStore.getByRequestId(traceId);
    }

    /**
     * Get recent traces
     * @param {number} count - Number of traces to return
     * @returns {Array<Object>} Trace summaries
     */
    getRecentTraces(count = 100) {
        return this.traceStore.getRecent(count);
    }

    /**
     * Query traces with filters
     * @param {Object} filter - Filter options
     * @returns {Array<Object>} Matching trace summaries
     */
    queryTraces(filter = {}) {
        return this.traceStore.query(filter);
    }

    /**
     * Get trace store statistics
     * @returns {Object} Trace stats
     */
    getTraceStats() {
        return this.traceStore.getStats();
    }

    /**
     * Get the trace store instance
     * @returns {TraceStore}
     */
    getTraceStore() {
        return this.traceStore;
    }
}

module.exports = {
    RequestHandler,
    RequestQueue,
    ConnectionHealthMonitor,
    calculateBackoff,
    RETRY_CONFIG,
    ERROR_STRATEGIES
};
