/**
 * Auth Controller Module
 *
 * Handles authentication-related routes extracted from ProxyServer.
 * Provides endpoints for auth status checking and authentication utilities.
 *
 * TDD Phase: Green - Implementation to make tests pass
 */

'use strict';

const { hashToken, secureCompare } = require('../../admin-auth');

/**
 * Known admin/internal API paths
 * Used to determine if a request is for admin functions vs proxy traffic
 */
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

/**
 * Sensitive GET paths that always require authentication
 */
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

/**
 * AuthController class for authentication-related HTTP endpoints
 */
class AuthController {
    /**
     * @param {Object} options - Configuration options
     * @param {Object} options.adminAuth - AdminAuth instance
     * @param {Object} options.config - Configuration object
     * @param {Function} options.addAuditEntry - Audit log function
     */
    constructor(options = {}) {
        this._adminAuth = options.adminAuth || null;
        this._config = options.config || { security: {} };
        this._addAuditEntry = options.addAuditEntry || (() => {});
    }

    /**
     * Handle /auth-status endpoint
     * GET: Return authentication status without recording failures
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    handleAuthStatus(req, res) {
        const headerName = this._adminAuth?.headerName || 'x-admin-token';

        // Peek at token without recording failures
        let authenticated = false;
        let tokensConfigured = 0;
        let tokensRequired = false;

        if (this._adminAuth && this._adminAuth.enabled) {
            tokensConfigured = this._adminAuth.tokens ? this._adminAuth.tokens.size : 0;
            tokensRequired = tokensConfigured > 0;

            // If tokens are configured, validate the provided token
            if (tokensRequired) {
                const providedToken = this._adminAuth.extractToken ? this._adminAuth.extractToken(req) : null;
                if (providedToken) {
                    // Validate by hashing and comparing against stored hashes
                    const hashedToken = hashToken(providedToken);
                    const tokens = this._adminAuth.tokens || (this._adminAuth._tokens ? this._adminAuth._tokens : new Set());
                    for (const storedHash of tokens) {
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
            enabled: !!(this._adminAuth && this._adminAuth.enabled),
            tokensConfigured,
            tokensRequired,
            authenticated,
            headerName
        }));
    }

    /**
     * Require authentication for a request
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     * @returns {boolean} True if authenticated, false if rejected
     */
    requireAuth(req, res) {
        if (!this._adminAuth) {
            // No auth configured - allow through
            return true;
        }

        const authResult = this._adminAuth.authenticate(req);
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
     * Determine if a request requires admin authentication
     * - Mutations (POST/PUT/PATCH/DELETE) on admin routes require auth
     * - GET requests on sensitive paths require auth
     * @param {string} path - Request path
     * @param {string} method - HTTP method
     * @returns {boolean}
     */
    requiresAdminAuth(path, method) {
        if (!this._adminAuth || !this._adminAuth.enabled) return false;

        // Check if it's a sensitive GET path
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
     * Check if a path is an admin route
     * @param {string} path - Request path
     * @returns {boolean}
     */
    isAdminRoute(path) {
        // Check for prefix matches (e.g., /control/*, /replay/*)
        for (const adminPath of ADMIN_PATHS) {
            if (adminPath.endsWith('/')) {
                if (path.startsWith(adminPath)) return true;
            } else {
                if (path === adminPath) return true;
                // Also check for dynamic patterns
                if (adminPath === '/requests' && path.startsWith('/requests')) return true;
                if (adminPath === '/stats/latency-histogram' && path.startsWith('/stats/latency-histogram/')) return true;
            }
        }
        return false;
    }

    /**
     * Check if debug endpoints require authentication
     * @returns {boolean}
     */
    debugEndpointsRequireAuth() {
        const security = this._config.security || {};
        // Default to true - debug endpoints should require auth by default
        return security.debugEndpointsAlwaysRequireAuth !== false;
    }

    /**
     * Check if a path is a debug endpoint
     * @param {string} path - Request path
     * @returns {boolean}
     */
    isDebugEndpoint(path) {
        return path.startsWith('/debug');
    }
}

module.exports = {
    AuthController
};
