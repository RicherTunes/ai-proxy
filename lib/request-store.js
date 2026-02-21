/**
 * Request Store Module
 * Stores failed requests for replay functionality
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWrite } = require('./atomic-write');

// Error types that warrant storing for replay
const STORABLE_ERRORS = [
    'timeout',
    'server_error',
    'socket_hangup',
    'connection_refused',
    'broken_pipe',
    'connection_aborted',
    'stream_premature_close',
    'http_parse_error'
];

// Headers to strip for security
const SENSITIVE_HEADERS = [
    'authorization',
    'x-api-key',
    'x-admin-token',  // Milestone 1 - prevent admin token leakage
    'cookie',
    'set-cookie',
    'x-forwarded-for',
    'x-real-ip'
];

class RequestStore {
    /**
     * Create a new request store
     * @param {Object} options - Configuration
     */
    constructor(options = {}) {
        this.enabled = options.enabled !== false;
        this.storeFile = options.storeFile || 'failed-requests.json';
        this.configDir = options.configDir || __dirname;
        this.maxRequests = options.maxRequests ?? 1000;
        this.ttlHours = options.ttlHours ?? 24;
        this.storeBodySizeLimit = options.storeBodySizeLimit ?? 1048576; // 1MB
        this.errorTypesToStore = options.errorTypesToStore || STORABLE_ERRORS;
        this.logger = options.logger;

        // Encryption (optional)
        this.encryptionKey = options.encryptionKey || null;

        // Request store
        this.requests = new Map();

        // Replay callback
        this.onReplay = options.onReplay || null;

        // Async write state
        this._dirty = false;
        this._writing = false;
        this._writePromise = null;
        this._destroyed = false;

        // Load from disk
        this._load();

        // Cleanup interval
        this._cleanupInterval = setInterval(() => this.cleanup(), 60 * 60 * 1000); // Hourly
        this._cleanupInterval.unref();
    }

    _log(level, message, context) {
        if (this.logger) {
            this.logger[level](message, context);
        }
    }

    _getStorePath() {
        return path.join(this.configDir, this.storeFile);
    }

    /**
     * Generate unique request ID
     * @returns {string} Request ID
     */
    _generateId() {
        return `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    }

    /**
     * Strip sensitive headers from request
     * @param {Object} headers - Original headers
     * @returns {Object} Sanitized headers
     */
    _sanitizeHeaders(headers) {
        const sanitized = { ...headers };
        for (const key of Object.keys(sanitized)) {
            if (SENSITIVE_HEADERS.includes(key.toLowerCase())) {
                delete sanitized[key];
            }
        }
        return sanitized;
    }

    /**
     * Encrypt data if encryption key provided
     * @param {string} data - Data to encrypt
     * @returns {string} Encrypted or original data
     */
    _encrypt(data) {
        if (!this.encryptionKey) return data;

        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', this.encryptionKey.padEnd(32).slice(0, 32), iv);
        let encrypted = cipher.update(data, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return `${iv.toString('hex')}:${encrypted}`;
    }

    /**
     * Decrypt data if encrypted
     * @param {string} data - Data to decrypt
     * @returns {string} Decrypted or original data
     */
    _decrypt(data) {
        if (!this.encryptionKey || !data.includes(':')) return data;

        try {
            const [ivHex, encrypted] = data.split(':');
            const iv = Buffer.from(ivHex, 'hex');
            const decipher = crypto.createDecipheriv('aes-256-cbc', this.encryptionKey.padEnd(32).slice(0, 32), iv);
            let decrypted = decipher.update(encrypted, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (e) {
            return data; // Return as-is if decryption fails
        }
    }

    /**
     * Check if error type should be stored
     * @param {string} errorType - Error type
     * @returns {boolean}
     */
    shouldStore(errorType) {
        return this.enabled && this.errorTypesToStore.includes(errorType);
    }

    /**
     * Store a failed request
     * @param {string} requestId - Original request ID
     * @param {Object} req - Request object
     * @param {Buffer} body - Request body
     * @param {string} error - Error message
     * @param {number} keyIndex - Key index that failed
     * @param {Object} metadata - Additional metadata
     * @returns {string|null} Store ID or null
     */
    store(requestId, req, body, error, keyIndex, metadata = {}) {
        if (!this.enabled) return null;

        const storeId = this._generateId();

        // Check body size limit
        let storedBody = null;
        if (body && body.length <= this.storeBodySizeLimit) {
            storedBody = body.toString('base64');
            if (this.encryptionKey) {
                storedBody = this._encrypt(storedBody);
            }
        }

        const storedRequest = {
            id: storeId,
            originalRequestId: requestId,
            storedAt: Date.now(),
            expiresAt: Date.now() + (this.ttlHours * 60 * 60 * 1000),
            method: req.method,
            url: req.url,
            headers: this._sanitizeHeaders(req.headers),
            body: storedBody,
            bodySize: body ? body.length : 0,
            bodyTruncated: body ? body.length > this.storeBodySizeLimit : false,
            error: {
                type: metadata.errorType || 'unknown',
                message: error,
                keyIndex
            },
            attempts: metadata.attempts || 1,
            latency: metadata.latency || null,
            replayCount: 0,
            lastReplayAt: null,
            lastReplayResult: null
        };

        this.requests.set(storeId, storedRequest);

        // Enforce max requests limit
        this._enforceLimit();

        // Save to disk
        this._save();

        this._log('info', `Stored failed request: ${storeId}`, {
            originalRequestId: requestId,
            errorType: metadata.errorType
        });

        return storeId;
    }

    /**
     * Get a stored request by ID
     * @param {string} requestId - Request ID
     * @returns {Object|null} Stored request or null
     */
    get(requestId) {
        const request = this.requests.get(requestId);
        if (!request) return null;

        // Check expiration
        if (Date.now() > request.expiresAt) {
            this.requests.delete(requestId);
            return null;
        }

        // Decrypt body if encrypted
        if (request.body && this.encryptionKey) {
            return {
                ...request,
                body: this._decrypt(request.body)
            };
        }

        return request;
    }

    /**
     * List stored requests
     * @param {number} offset - Start offset
     * @param {number} limit - Max results
     * @param {Object} filters - Optional filters
     * @returns {Object} List result
     */
    list(offset = 0, limit = 50, filters = {}) {
        let requests = Array.from(this.requests.values());

        // Remove expired
        const now = Date.now();
        requests = requests.filter(r => r.expiresAt > now);

        // Apply filters
        if (filters.errorType) {
            requests = requests.filter(r => r.error.type === filters.errorType);
        }
        if (filters.method) {
            requests = requests.filter(r => r.method === filters.method);
        }
        if (filters.url) {
            requests = requests.filter(r => r.url.includes(filters.url));
        }

        // Sort by stored time (newest first)
        requests.sort((a, b) => b.storedAt - a.storedAt);

        const total = requests.length;
        const items = requests.slice(offset, offset + limit).map(r => ({
            id: r.id,
            originalRequestId: r.originalRequestId,
            storedAt: new Date(r.storedAt).toISOString(),
            expiresAt: new Date(r.expiresAt).toISOString(),
            method: r.method,
            url: r.url,
            error: r.error,
            bodySize: r.bodySize,
            bodyTruncated: r.bodyTruncated,
            replayCount: r.replayCount,
            lastReplayAt: r.lastReplayAt ? new Date(r.lastReplayAt).toISOString() : null,
            lastReplayResult: r.lastReplayResult
        }));

        return {
            items,
            total,
            offset,
            limit,
            hasMore: offset + limit < total
        };
    }

    /**
     * Replay a stored request
     * @param {string} requestId - Request ID to replay
     * @param {number} targetKeyIndex - Key index to use (optional)
     * @returns {Promise<Object>} Replay result
     */
    async replay(requestId, targetKeyIndex = null) {
        const request = this.get(requestId);
        if (!request) {
            return { success: false, error: 'Request not found or expired' };
        }

        if (!this.onReplay) {
            return { success: false, error: 'Replay handler not configured' };
        }

        // Decode body
        let body = null;
        if (request.body) {
            try {
                body = Buffer.from(request.body, 'base64');
            } catch (e) {
                return { success: false, error: 'Failed to decode request body' };
            }
        }

        try {
            const result = await this.onReplay({
                method: request.method,
                url: request.url,
                headers: request.headers,
                body,
                targetKeyIndex
            });

            // Update replay tracking
            const storedRequest = this.requests.get(requestId);
            if (storedRequest) {
                storedRequest.replayCount++;
                storedRequest.lastReplayAt = Date.now();
                storedRequest.lastReplayResult = result.success ? 'success' : 'failed';
                this._save();
            }

            this._log('info', `Replayed request: ${requestId}`, {
                success: result.success,
                keyIndex: result.keyIndex
            });

            return result;
        } catch (err) {
            this._log('error', `Replay failed: ${err.message}`, { requestId });
            return { success: false, error: err.message };
        }
    }

    /**
     * Delete a stored request
     * @param {string} requestId - Request ID
     * @returns {boolean} Success
     */
    delete(requestId) {
        const deleted = this.requests.delete(requestId);
        if (deleted) {
            this._save();
        }
        return deleted;
    }

    /**
     * Delete multiple requests
     * @param {string[]} requestIds - Request IDs to delete
     * @returns {number} Number deleted
     */
    deleteMany(requestIds) {
        let deleted = 0;
        for (const id of requestIds) {
            if (this.requests.delete(id)) {
                deleted++;
            }
        }
        if (deleted > 0) {
            this._save();
        }
        return deleted;
    }

    /**
     * Cleanup expired requests
     * @returns {number} Number removed
     */
    cleanup() {
        const now = Date.now();
        let removed = 0;

        for (const [id, request] of this.requests) {
            if (request.expiresAt <= now) {
                this.requests.delete(id);
                removed++;
            }
        }

        if (removed > 0) {
            this._save();
            this._log('info', `Cleaned up ${removed} expired requests`);
        }

        return removed;
    }

    /**
     * Enforce maximum requests limit
     */
    _enforceLimit() {
        while (this.requests.size > this.maxRequests) {
            // Remove oldest request
            let oldestId = null;
            let oldestTime = Infinity;

            for (const [id, request] of this.requests) {
                if (request.storedAt < oldestTime) {
                    oldestTime = request.storedAt;
                    oldestId = id;
                }
            }

            if (oldestId) {
                this.requests.delete(oldestId);
            }
        }
    }

    /**
     * Mark store as dirty and schedule an async write.
     * Coalesces multiple rapid store() calls into a single write.
     * Only one atomicWrite is in flight at a time; if dirty during a write,
     * another write is scheduled after completion.
     */
    _save() {
        this._dirty = true;
        if (this._destroyed) return;

        // Schedule flush on next microtask if not already writing
        if (!this._writing) {
            this._writePromise = this._flush();
        }
    }

    /**
     * Perform the actual async write, serializing concurrent writes.
     * @returns {Promise<void>}
     */
    async _flush() {
        // Serialize: only one write at a time
        while (this._dirty && !this._destroyed) {
            this._dirty = false;
            this._writing = true;

            try {
                const data = {
                    version: 1,
                    savedAt: new Date().toISOString(),
                    requests: Array.from(this.requests.entries())
                };

                await atomicWrite(this._getStorePath(), JSON.stringify(data, null, 2));
            } catch (err) {
                this._log('error', `Failed to save request store: ${err.message}`);
            } finally {
                this._writing = false;
            }
        }
    }

    /**
     * Load from disk
     */
    _load() {
        try {
            const storePath = this._getStorePath();
            if (fs.existsSync(storePath)) {
                const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));

                if (data.requests) {
                    this.requests = new Map(data.requests);
                    this.cleanup(); // Remove expired on load
                    this._log('info', `Loaded ${this.requests.size} stored requests`);
                }
            }
        } catch (err) {
            this._log('error', `Failed to load request store: ${err.message}`);
            this.requests = new Map();
        }
    }

    /**
     * Get store statistics
     * @returns {Object} Store stats
     */
    getStats() {
        const now = Date.now();
        const requests = Array.from(this.requests.values());

        const byErrorType = {};
        let totalSize = 0;
        let expiredCount = 0;
        let replayedCount = 0;

        for (const req of requests) {
            if (req.expiresAt <= now) {
                expiredCount++;
                continue;
            }

            byErrorType[req.error.type] = (byErrorType[req.error.type] || 0) + 1;
            totalSize += req.bodySize || 0;
            if (req.replayCount > 0) {
                replayedCount++;
            }
        }

        return {
            totalStored: this.requests.size - expiredCount,
            expiredPending: expiredCount,
            replayedCount,
            totalBodySize: totalSize,
            byErrorType,
            maxRequests: this.maxRequests,
            ttlHours: this.ttlHours
        };
    }

    /**
     * Clear all stored requests
     */
    clear() {
        this.requests.clear();
        this._save();
        this._log('info', 'Request store cleared');
    }

    /**
     * Destroy the store: stop cleanup interval, await pending writes, final flush.
     * Idempotent — safe to call multiple times.
     * @param {Object} options - { throwOnError: true } (default: surfaces errors)
     * @returns {Promise<void>}
     */
    async destroy(options = {}) {
        const { throwOnError = true } = options;

        if (this._destroyed) return;
        this._destroyed = true;

        // Stop cleanup interval
        if (this._cleanupInterval) {
            clearInterval(this._cleanupInterval);
            this._cleanupInterval = null;
        }

        try {
            // Wait for any in-flight write to complete
            if (this._writePromise) {
                await this._writePromise;
            }

            // Final flush if dirty
            if (this._dirty) {
                this._dirty = false;
                const data = {
                    version: 1,
                    savedAt: new Date().toISOString(),
                    requests: Array.from(this.requests.entries())
                };
                await atomicWrite(this._getStorePath(), JSON.stringify(data, null, 2));
            }
        } catch (err) {
            this._log('error', `Failed to flush on destroy: ${err.message}`);
            if (throwOnError) {
                throw err;
            }
        }
    }
}

module.exports = {
    RequestStore,
    STORABLE_ERRORS,
    SENSITIVE_HEADERS
};
