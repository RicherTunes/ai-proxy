/**
 * Admin Authentication Module
 * Simple token-based authentication for admin endpoints
 */

const crypto = require('crypto');
const { getClientIp } = require('./client-ip');
const { RingBuffer } = require('./ring-buffer');

/**
 * Generate a secure random token
 * @param {number} length - Token length in bytes
 * @returns {string} Hex token
 */
function generateToken(length = 32) {
    return crypto.randomBytes(length).toString('hex');
}

/**
 * Hash a token for storage
 * @param {string} token - Plain token
 * @returns {string} Hashed token
 */
function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time token comparison
 * @param {string} a - First token
 * @param {string} b - Second token
 * @returns {boolean} Match result
 */
function secureCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
        return false;
    }
    if (a.length !== b.length) {
        return false;
    }
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

class AdminAuth {
    /**
     * Create admin auth handler
     * @param {Object} options - Configuration
     */
    constructor(options = {}) {
        this.enabled = options.enabled !== false;
        this.headerName = options.headerName || 'x-admin-token';
        this.queryParam = options.queryParam || 'admin_token';
        this.logger = options.logger;

        // Token storage (hashed)
        this.tokens = new Set();

        // Rate limiting for auth failures
        this.failedAttempts = new Map();
        this.maxAttempts = options.maxAttempts || 5;
        this.lockoutDurationMs = options.lockoutDurationMs || 15 * 60 * 1000; // 15 minutes

        // Failed attempts cleanup configuration
        this._maxFailedEntries = options.maxFailedEntries || 10000;
        this._maxEntryAgeMs = 24 * 60 * 60 * 1000; // 24h absolute max age

        // Trusted proxies for IP resolution
        this.trustedProxies = options.trustedProxies || [];

        // Audit log
        this._maxAuditLog = options.maxAuditEntries || 1000;
        this.auditLog = new RingBuffer(this._maxAuditLog);

        // Protected paths - all admin/control endpoints
        this.protectedPaths = options.protectedPaths || [
            '/control/',       // All control operations (pause, resume, reset, circuit, shutdown)
            '/replay/',        // Request replay functionality
            '/reload',         // Hot reload keys
            '/webhooks',       // Webhook management
            '/tenants',        // Tenant management
            '/requests',       // Request tracing (can expose sensitive data)
            '/logs',           // Log access
            '/model-mapping'   // Model mapping configuration
        ];

        // Load tokens if provided
        if (options.tokens) {
            for (const token of options.tokens) {
                this.addToken(token);
            }
        }

        // Periodic cleanup of stale failedAttempts entries (.unref() to not keep Node alive)
        this._cleanupInterval = setInterval(() => this._cleanupFailedAttempts(), 5 * 60 * 1000);
        this._cleanupInterval.unref();
    }

    _log(level, message, context) {
        if (this.logger) {
            this.logger[level](message, context);
        }
    }

    /**
     * Add an admin token
     * @param {string} token - Plain token to add
     */
    addToken(token) {
        if (!token || token.length < 16) {
            this._log('warn', 'Token too short, minimum 16 characters required');
            return false;
        }
        const hashed = hashToken(token);
        this.tokens.add(hashed);
        return true;
    }

    /**
     * Remove an admin token
     * @param {string} token - Plain token to remove
     * @returns {boolean} Success
     */
    removeToken(token) {
        const hashed = hashToken(token);
        return this.tokens.delete(hashed);
    }

    /**
     * Generate and add a new token
     * @returns {string} The new plain token (save this!)
     */
    generateAndAddToken() {
        const token = generateToken();
        this.addToken(token);
        return token;
    }

    /**
     * Check if a path requires authentication
     * @param {string} path - Request path
     * @returns {boolean}
     */
    requiresAuth(path) {
        if (!this.enabled) return false;

        for (const protectedPath of this.protectedPaths) {
            if (path.startsWith(protectedPath)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Extract token from request
     * @param {http.IncomingMessage} req - HTTP request
     * @returns {string|null} Token or null
     */
    extractToken(req) {
        // Check header first
        const headerToken = req.headers[this.headerName];
        if (headerToken) return headerToken;

        // Check query parameter
        try {
            const url = new URL(req.url, 'http://localhost');
            const queryToken = url.searchParams.get(this.queryParam);
            if (queryToken) return queryToken;
        } catch (e) {
            // Invalid URL, ignore
        }

        return null;
    }

    /**
     * Get client identifier for rate limiting
     * @param {http.IncomingMessage} req - HTTP request
     * @returns {string} Client ID
     */
    _getClientId(req) {
        return getClientIp(req, this.trustedProxies || []);
    }

    /**
     * Check if client is locked out
     * @param {string} clientId - Client identifier
     * @returns {Object} Lockout status
     */
    _checkLockout(clientId) {
        const attempts = this.failedAttempts.get(clientId);
        if (!attempts) {
            return { locked: false };
        }

        const now = Date.now();
        if (attempts.lockoutUntil && now < attempts.lockoutUntil) {
            return {
                locked: true,
                remainingMs: attempts.lockoutUntil - now
            };
        }

        // Reset if lockout expired
        if (attempts.lockoutUntil && now >= attempts.lockoutUntil) {
            this.failedAttempts.delete(clientId);
        }

        return { locked: false };
    }

    /**
     * Record a failed auth attempt
     * @param {string} clientId - Client identifier
     */
    _recordFailure(clientId) {
        let attempts = this.failedAttempts.get(clientId);
        if (!attempts) {
            attempts = { count: 0, firstAttempt: Date.now() };
            this.failedAttempts.set(clientId, attempts);
        }

        attempts.count++;
        attempts.lastAttempt = Date.now();

        if (attempts.count >= this.maxAttempts) {
            attempts.lockoutUntil = Date.now() + this.lockoutDurationMs;
            this._log('warn', `Client locked out: ${clientId}`, {
                attempts: attempts.count,
                lockoutMinutes: this.lockoutDurationMs / 60000
            });
        }
    }

    /**
     * Record a successful auth
     * @param {string} clientId - Client identifier
     */
    _recordSuccess(clientId) {
        this.failedAttempts.delete(clientId);
    }

    /**
     * Clean up stale entries from failedAttempts map.
     * Removes expired lockouts, age-exceeded entries, and enforces size bound.
     * Size eviction uses Map insertion order (oldest inserted first).
     */
    _cleanupFailedAttempts() {
        const now = Date.now();

        // Pass 1: Remove expired/stale entries
        for (const [clientId, attempts] of this.failedAttempts) {
            // Remove if lockout expired
            if (attempts.lockoutUntil && attempts.lockoutUntil < now) {
                this.failedAttempts.delete(clientId);
                continue;
            }
            // Remove if first attempt older than lockoutDurationMs * 2
            if (attempts.firstAttempt && (now - attempts.firstAttempt > this.lockoutDurationMs * 2)) {
                this.failedAttempts.delete(clientId);
                continue;
            }
            // Remove entries older than 24h regardless
            if (attempts.firstAttempt && (now - attempts.firstAttempt > this._maxEntryAgeMs)) {
                this.failedAttempts.delete(clientId);
                continue;
            }
        }

        // Pass 2: Enforce size bound via insertion-order eviction
        // Map iteration order = insertion order. Entries are never re-inserted
        // (only count++ and lockoutUntil mutate the value, not the key position).
        while (this.failedAttempts.size > this._maxFailedEntries) {
            const oldestKey = this.failedAttempts.keys().next().value;
            this.failedAttempts.delete(oldestKey);
        }
    }

    /**
     * Authenticate a request
     * @param {http.IncomingMessage} req - HTTP request
     * @returns {Object} Auth result
     */
    authenticate(req) {
        const path = req.url.split('?')[0];

        // Check if path requires auth
        if (!this.requiresAuth(path)) {
            return { authenticated: true, required: false };
        }

        const clientId = this._getClientId(req);

        // Check lockout
        const lockout = this._checkLockout(clientId);
        if (lockout.locked) {
            this._audit('lockout', clientId, path, false);
            return {
                authenticated: false,
                required: true,
                error: 'too_many_attempts',
                retryAfterMs: lockout.remainingMs
            };
        }

        // No tokens configured = allow all (for development)
        if (this.tokens.size === 0) {
            this._audit('no_tokens', clientId, path, true);
            return { authenticated: true, required: true, warning: 'no_tokens_configured' };
        }

        // Extract token
        const token = this.extractToken(req);
        if (!token) {
            this._recordFailure(clientId);
            this._audit('missing_token', clientId, path, false);
            return {
                authenticated: false,
                required: true,
                error: 'missing_token'
            };
        }

        // Validate token
        const hashedToken = hashToken(token);
        let valid = false;

        for (const storedHash of this.tokens) {
            if (secureCompare(hashedToken, storedHash)) {
                valid = true;
                break;
            }
        }

        if (valid) {
            this._recordSuccess(clientId);
            this._audit('success', clientId, path, true);
            return { authenticated: true, required: true };
        }

        this._recordFailure(clientId);
        this._audit('invalid_token', clientId, path, false);
        return {
            authenticated: false,
            required: true,
            error: 'invalid_token'
        };
    }

    /**
     * Express/Connect middleware
     * @returns {Function} Middleware function
     */
    middleware() {
        return (req, res, next) => {
            const result = this.authenticate(req);

            if (!result.authenticated) {
                const status = result.error === 'too_many_attempts' ? 429 : 401;
                res.writeHead(status, { 'Content-Type': 'application/json' });

                const response = { error: result.error };
                if (result.retryAfterMs) {
                    response.retryAfterSeconds = Math.ceil(result.retryAfterMs / 1000);
                    res.setHeader('Retry-After', response.retryAfterSeconds);
                }

                res.end(JSON.stringify(response));
                return;
            }

            next();
        };
    }

    /**
     * Add audit log entry
     * @param {string} action - Action type
     * @param {string} clientId - Client ID
     * @param {string} path - Request path
     * @param {boolean} success - Success status
     */
    _audit(action, clientId, path, success) {
        this.auditLog.push({
            timestamp: new Date().toISOString(),
            action,
            clientId,
            path,
            success
        });
    }

    /**
     * Get audit log
     * @param {number} limit - Max entries
     * @returns {Array} Audit entries
     */
    getAuditLog(limit = 100) {
        const allLogs = this.auditLog.toArray();
        return allLogs.slice(-limit);
    }

    /**
     * Get auth statistics
     * @returns {Object} Stats
     */
    getStats() {
        const now = Date.now();
        let lockedClients = 0;

        for (const [clientId, attempts] of this.failedAttempts) {
            if (attempts.lockoutUntil && now < attempts.lockoutUntil) {
                lockedClients++;
            }
        }

        const recentAudit = this.auditLog.getRecent(100).reverse();
        const successCount = recentAudit.filter(e => e.success).length;
        const failureCount = recentAudit.filter(e => !e.success).length;

        return {
            enabled: this.enabled,
            tokenCount: this.tokens.size,
            lockedClients,
            protectedPaths: this.protectedPaths,
            recentAuth: {
                success: successCount,
                failure: failureCount,
                successRate: recentAudit.length > 0
                    ? Math.round((successCount / recentAudit.length) * 100)
                    : 100
            }
        };
    }

    /**
     * Clear failed attempts (unlock all clients)
     */
    clearLockouts() {
        this.failedAttempts.clear();
        this._log('info', 'Cleared all lockouts');
    }

    /**
     * Destroy: clear cleanup interval and optionally clear state
     * @param {Object} options - { clearState: false }
     */
    destroy(options = {}) {
        if (this._cleanupInterval) {
            clearInterval(this._cleanupInterval);
            this._cleanupInterval = null;
        }
        if (options.clearState) {
            this.failedAttempts.clear();
            this.auditLog.clear();
        }
    }
}

module.exports = {
    AdminAuth,
    generateToken,
    hashToken,
    secureCompare
};
