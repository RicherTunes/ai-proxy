/**
 * Webhook Manager Module
 * Handles async webhook delivery with retry and HMAC signing
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { LRUMap } = require('./lru-map');

const EVENT_TYPES = [
    'circuit.trip',
    'circuit.recover',
    'rate_limit.hit',
    'rate_limit.pool_exhausted',
    'error.spike',
    'budget.warning',
    'budget.exceeded',
    'health.degraded',
    'health.critical',
    'usage.rate_jump',
    'usage.feed_stale',
    'usage.feed_recovered',
    'usage.quota_warning'
];

class WebhookManager {
    /**
     * Create a new webhook manager
     * @param {Object} options - Configuration
     */
    constructor(options = {}) {
        this.enabled = options.enabled !== false;
        this.endpoints = [];
        this.logger = options.logger;

        // Retry configuration
        this.maxRetries = options.maxRetries ?? 3;
        this.retryDelayMs = options.retryDelayMs ?? 1000;
        this.timeoutMs = options.timeoutMs ?? 10000;

        // Deduplication — LRU-bounded to prevent unbounded growth
        this.dedupeWindowMs = options.dedupeWindowMs ?? 60000;
        this._recentEvents = new LRUMap(1000);

        // Error spike detection
        this.errorSpikeThreshold = options.errorSpikeThreshold ?? 10;
        this.errorSpikeWindow = options.errorSpikeWindow ?? 60000;
        this._errorTimestamps = [];

        // Delivery stats
        this.stats = {
            sent: 0,
            succeeded: 0,
            failed: 0,
            retried: 0,
            deduped: 0,
            byEventType: {}
        };

        // Pending deliveries (for graceful shutdown)
        this._pendingDeliveries = new Set();

        // Load endpoints if provided
        if (options.endpoints) {
            this.loadWebhooks(options.endpoints);
        }
    }

    _log(level, message, context) {
        if (this.logger) {
            this.logger[level](message, context);
        }
    }

    /**
     * Load webhook endpoint configurations
     * @param {Array} endpoints - Webhook endpoint configs
     */
    loadWebhooks(endpoints) {
        this.endpoints = endpoints.filter(ep => {
            if (!ep.url) {
                this._log('warn', 'Webhook endpoint missing URL, skipping');
                return false;
            }

            // Validate URL
            try {
                new URL(ep.url);
            } catch (e) {
                this._log('warn', `Invalid webhook URL: ${ep.url}`);
                return false;
            }

            return true;
        }).map(ep => ({
            url: ep.url,
            secret: ep.secret || null,
            events: ep.events || EVENT_TYPES,
            name: ep.name || new URL(ep.url).hostname,
            headers: ep.headers || {}
        }));

        this._log('info', `Loaded ${this.endpoints.length} webhook endpoints`);
    }

    /**
     * Create HMAC signature for payload
     * @param {string} payload - JSON payload string
     * @param {string} secret - Webhook secret
     * @param {number} timestamp - Unix timestamp
     * @returns {string} HMAC signature
     */
    _createSignature(payload, secret, timestamp) {
        const signaturePayload = `${timestamp}.${payload}`;
        return crypto
            .createHmac('sha256', secret)
            .update(signaturePayload)
            .digest('hex');
    }

    /**
     * Check if event should be deduplicated
     * @param {string} eventType - Event type
     * @param {string} dedupeKey - Unique key for deduplication
     * @returns {boolean} True if should be deduplicated
     */
    _shouldDedupe(eventType, dedupeKey) {
        const key = `${eventType}:${dedupeKey}`;
        const now = Date.now();

        const lastSent = this._recentEvents.get(key);
        if (lastSent && (now - lastSent) < this.dedupeWindowMs) {
            this.stats.deduped++;
            return true;
        }

        this._recentEvents.set(key, now);
        return false;
    }

    /**
     * Emit an event to all subscribed webhooks (non-blocking)
     * @param {string} eventType - Event type
     * @param {Object} payload - Event payload
     * @param {Object} options - Emit options
     */
    emit(eventType, payload, options = {}) {
        if (!this.enabled || this.endpoints.length === 0) return;

        if (!EVENT_TYPES.includes(eventType)) {
            this._log('warn', `Unknown event type: ${eventType}`);
        }

        // Deduplication
        const dedupeKey = options.dedupeKey || JSON.stringify(payload).substring(0, 100);
        if (this._shouldDedupe(eventType, dedupeKey)) {
            this._log('debug', `Deduplicated event: ${eventType}`);
            return;
        }

        const event = {
            id: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            type: eventType,
            timestamp: new Date().toISOString(),
            payload: this._sanitizePayload(payload)
        };

        // Track stats
        this.stats.byEventType[eventType] = (this.stats.byEventType[eventType] || 0) + 1;

        // Deliver to all endpoints that subscribe to this event
        for (const endpoint of this.endpoints) {
            if (endpoint.events.includes(eventType) || endpoint.events.includes('*')) {
                // Non-blocking delivery
                this._deliver(endpoint, event).catch(err => {
                    this._log('error', `Webhook delivery failed: ${err.message}`, {
                        endpoint: endpoint.name,
                        eventType
                    });
                });
            }
        }
    }

    /**
     * Remove sensitive data from payload
     * @param {Object} payload - Raw payload
     * @returns {Object} Sanitized payload
     */
    _sanitizePayload(payload) {
        const sanitized = { ...payload };

        // Remove any potential credentials
        const sensitiveFields = ['key', 'secret', 'password', 'token', 'authorization', 'apiKey'];
        for (const field of sensitiveFields) {
            if (field in sanitized) {
                delete sanitized[field];
            }
        }

        return sanitized;
    }

    /**
     * Deliver webhook with retry
     * @param {Object} endpoint - Endpoint config
     * @param {Object} event - Event data
     * @param {number} attempt - Current attempt number
     */
    async _deliver(endpoint, event, attempt = 0) {
        const deliveryId = `${event.id}:${endpoint.name}`;
        this._pendingDeliveries.add(deliveryId);

        try {
            await this._sendRequest(endpoint, event);
            this.stats.sent++;
            this.stats.succeeded++;
            this._pendingDeliveries.delete(deliveryId);

            this._log('debug', `Webhook delivered: ${event.type} -> ${endpoint.name}`);
        } catch (err) {
            if (attempt < this.maxRetries) {
                this.stats.retried++;
                const delay = this.retryDelayMs * Math.pow(2, attempt);

                this._log('warn', `Webhook delivery failed, retrying in ${delay}ms`, {
                    endpoint: endpoint.name,
                    attempt: attempt + 1,
                    error: err.message
                });

                await new Promise(resolve => setTimeout(resolve, delay));
                return this._deliver(endpoint, event, attempt + 1);
            } else {
                this.stats.sent++;
                this.stats.failed++;
                this._pendingDeliveries.delete(deliveryId);

                this._log('error', `Webhook delivery failed after ${this.maxRetries} retries`, {
                    endpoint: endpoint.name,
                    eventType: event.type,
                    error: err.message
                });
            }
        }
    }

    /**
     * Send HTTP request
     * @param {Object} endpoint - Endpoint config
     * @param {Object} event - Event data
     * @returns {Promise<void>}
     */
    _sendRequest(endpoint, event) {
        return new Promise((resolve, reject) => {
            const payload = JSON.stringify(event);
            const timestamp = Math.floor(Date.now() / 1000);
            const url = new URL(endpoint.url);

            const headers = {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'User-Agent': 'GLM-Proxy-Webhook/1.0',
                'X-GLM-Event': event.type,
                'X-GLM-Timestamp': timestamp,
                'X-GLM-Event-ID': event.id,
                ...endpoint.headers
            };

            // Add HMAC signature if secret provided
            if (endpoint.secret) {
                const signature = this._createSignature(payload, endpoint.secret, timestamp);
                headers['X-GLM-Signature'] = `sha256=${signature}`;
            }

            const options = {
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname + url.search,
                method: 'POST',
                headers,
                timeout: this.timeoutMs
            };

            const httpModule = url.protocol === 'https:' ? https : http;

            const req = httpModule.request(options, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve();
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 100)}`));
                    }
                });
            });

            req.once('error', reject);
            req.once('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            req.write(payload);
            req.end();
        });
    }

    /**
     * Record error for spike detection
     * @param {string} errorType - Type of error
     */
    recordError(errorType) {
        const now = Date.now();
        this._errorTimestamps.push({ timestamp: now, type: errorType });

        // Cleanup old timestamps
        this._errorTimestamps = this._errorTimestamps.filter(
            e => (now - e.timestamp) < this.errorSpikeWindow
        );

        // Check for spike
        if (this._errorTimestamps.length >= this.errorSpikeThreshold) {
            this.emit('error.spike', {
                errorCount: this._errorTimestamps.length,
                windowMs: this.errorSpikeWindow,
                errorTypes: this._aggregateErrorTypes()
            }, { dedupeKey: 'error_spike' });
        }
    }

    _aggregateErrorTypes() {
        const counts = {};
        for (const e of this._errorTimestamps) {
            counts[e.type] = (counts[e.type] || 0) + 1;
        }
        return counts;
    }

    /**
     * Emit circuit breaker trip event
     * @param {number} keyIndex - Key index
     * @param {string} keyPrefix - Key prefix
     * @param {Object} info - Additional info
     */
    emitCircuitTrip(keyIndex, keyPrefix, info = {}) {
        this.emit('circuit.trip', {
            keyIndex,
            keyPrefix,
            reason: info.reason || 'threshold_exceeded',
            failures: info.failures || 0
        }, { dedupeKey: `circuit_${keyIndex}` });
    }

    /**
     * Emit circuit breaker recovery event
     * @param {number} keyIndex - Key index
     * @param {string} keyPrefix - Key prefix
     */
    emitCircuitRecover(keyIndex, keyPrefix) {
        this.emit('circuit.recover', {
            keyIndex,
            keyPrefix
        }, { dedupeKey: `circuit_${keyIndex}` });
    }

    /**
     * Emit rate limit hit event
     * @param {number} keyIndex - Key index
     * @param {string} keyPrefix - Key prefix
     */
    emitRateLimitHit(keyIndex, keyPrefix) {
        this.emit('rate_limit.hit', {
            keyIndex,
            keyPrefix
        }, { dedupeKey: `ratelimit_${keyIndex}` });
    }

    /**
     * Emit pool exhausted event
     */
    emitPoolExhausted() {
        this.emit('rate_limit.pool_exhausted', {
            message: 'All API keys are rate limited or unavailable'
        }, { dedupeKey: 'pool_exhausted' });
    }

    /**
     * Emit health status event
     * @param {string} status - 'degraded' or 'critical'
     * @param {Object} details - Health details
     */
    emitHealthStatus(status, details = {}) {
        const eventType = status === 'critical' ? 'health.critical' : 'health.degraded';
        this.emit(eventType, {
            status,
            ...details
        }, { dedupeKey: `health_${status}` });
    }

    /**
     * Test webhook delivery
     * @param {string} url - Webhook URL to test
     * @returns {Promise<Object>} Test result
     */
    async testWebhook(url) {
        const testEndpoint = {
            url,
            secret: null,
            name: 'test',
            headers: {}
        };

        const testEvent = {
            id: `test_${Date.now()}`,
            type: 'webhook.test',
            timestamp: new Date().toISOString(),
            payload: { message: 'Test webhook from GLM Proxy' }
        };

        try {
            await this._sendRequest(testEndpoint, testEvent);
            return { success: true, message: 'Webhook test successful' };
        } catch (err) {
            return { success: false, message: err.message };
        }
    }

    /**
     * Get delivery statistics
     * @returns {Object} Delivery stats
     */
    getDeliveryStats() {
        return {
            ...this.stats,
            successRate: this.stats.sent > 0
                ? Math.round((this.stats.succeeded / this.stats.sent) * 100)
                : 100,
            endpointCount: this.endpoints.length,
            pendingDeliveries: this._pendingDeliveries.size
        };
    }

    /**
     * Get configured endpoints (without secrets)
     * @returns {Array} Endpoint info
     */
    getEndpoints() {
        return this.endpoints.map(ep => ({
            name: ep.name,
            url: ep.url,
            events: ep.events,
            hasSecret: !!ep.secret
        }));
    }

    /**
     * Destroy the webhook manager, draining pending deliveries
     */
    async destroy() {
        this.destroyed = true;
        this.enabled = false;
        await this.drain();
    }

    /**
     * Wait for pending deliveries to complete
     * @param {number} timeoutMs - Max wait time
     * @returns {Promise<void>}
     */
    async drain(timeoutMs = 5000) {
        const start = Date.now();
        while (this._pendingDeliveries.size > 0 && (Date.now() - start) < timeoutMs) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (this._pendingDeliveries.size > 0) {
            this._log('warn', `${this._pendingDeliveries.size} webhook deliveries still pending at shutdown`);
        }
    }
}

module.exports = {
    WebhookManager,
    EVENT_TYPES
};
