/**
 * Router Module
 *
 * Provides route registration and dispatch for proxy-server.js.
 * Replaces the large switch statement with a data-driven routing table.
 *
 * TDD Phase: Green - Implementation to make tests pass
 */

'use strict';

/**
 * Router class for HTTP route dispatch
 */
class Router {
    /**
     * @param {Object} options - Configuration options
     * @param {Function} options.authChecker - Custom auth checker function
     */
    constructor(options = {}) {
        this.routes = new Map();
        this.authChecker = options.authChecker || this._defaultAuthChecker.bind(this);
    }

    /**
     * Default auth checker - checks for req.isAuthenticated
     * @param {Object} req - HTTP request
     * @returns {boolean} true if authenticated
     * @private
     */
    _defaultAuthChecker(req) {
        return req.isAuthenticated === true;
    }

    /**
     * Set a custom auth checker function
     * @param {Function} checker - Auth checker function
     */
    setAuthChecker(checker) {
        this.authChecker = checker;
    }

    /**
     * Register a route
     * @param {string} pathname - Route path
     * @param {Object} options - Route options
     * @param {Function} options.handler - Route handler
     * @param {string[]} options.methods - Allowed HTTP methods
     * @param {boolean} options.authRequired - Whether auth is required
     */
    register(pathname, options = {}) {
        const route = {
            handler: options.handler,
            methods: options.methods || ['GET'],
            authRequired: options.authRequired || false
        };
        this.routes.set(pathname, route);
    }

    /**
     * Dispatch request to matching route
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     * @returns {Promise<void>}
     */
    async dispatch(req, res) {
        // CRITICAL: Use new URL for path resolution (req.path doesn't exist on IncomingMessage)
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const pathname = url.pathname;

        const route = this.routes.get(pathname);

        if (!route) {
            // Route not found
            res.setHeader('Content-Type', 'application/json');
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Not Found' }));
            return;
        }

        // Check HTTP method
        if (!route.methods.includes(req.method)) {
            // Method not allowed
            res.setHeader('Allow', route.methods.join(', '));
            res.setHeader('Content-Type', 'application/json');
            res.writeHead(405);
            res.end(JSON.stringify({ error: 'Method Not Allowed' }));
            return;
        }

        // Check authentication
        if (route.authRequired && !this.authChecker(req)) {
            res.setHeader('Content-Type', 'application/json');
            res.writeHead(401);
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }

        // Call the handler
        await route.handler(req, res);
    }
}

module.exports = {
    Router
};
