/**
 * Tenant Manager Module
 * Multi-tenant support with isolated key pools and stats
 */

const { KeyManager } = require('./key-manager');
const { StatsAggregator } = require('./stats-aggregator');

const DEFAULT_TENANT_ID = 'default';

/**
 * Tenant context containing isolated managers
 */
class TenantContext {
    /**
     * Create tenant context
     * @param {string} tenantId - Tenant identifier
     * @param {Object} config - Tenant configuration
     * @param {Object} options - Manager options
     */
    constructor(tenantId, config, options = {}) {
        this.tenantId = tenantId;
        this.config = config;
        this.createdAt = new Date().toISOString();
        this.lastUsed = null;

        // Create isolated key manager
        this.keyManager = new KeyManager({
            maxConcurrencyPerKey: options.maxConcurrencyPerKey || 2,
            circuitBreaker: options.circuitBreaker || {},
            rateLimitPerMinute: config.rateLimitPerMinute || options.rateLimitPerMinute || 60,
            rateLimitBurst: config.rateLimitBurst || options.rateLimitBurst || 10,
            keySelection: options.keySelection,
            defaultProviderName: options.defaultProviderName || 'z.ai',
            logger: options.logger?.child?.(`tenant:${tenantId}`) || options.logger
        });

        // Load tenant's keys
        this.keyManager.loadKeys(config.keys || []);

        // Create isolated stats aggregator (if stats isolation enabled)
        if (options.isolateStats !== false) {
            this.statsAggregator = new StatsAggregator({
                statsFile: `tenant-${tenantId}-stats.json`,
                configDir: options.configDir,
                saveInterval: options.statsSaveInterval || 60000,
                logger: options.logger?.child?.(`tenant:${tenantId}:stats`) || options.logger
            });
            this.statsAggregator.load();
            this.statsAggregator.startAutoSave();
        } else {
            this.statsAggregator = null;
        }

        // Request tracking
        this.requestCount = 0;
        this.errorCount = 0;
    }

    /**
     * Record request for tenant
     */
    recordRequest() {
        this.requestCount++;
        this.lastUsed = new Date().toISOString();
    }

    /**
     * Record error for tenant
     */
    recordError() {
        this.errorCount++;
    }

    /**
     * Get tenant stats
     * @returns {Object} Tenant statistics
     */
    getStats() {
        return {
            tenantId: this.tenantId,
            createdAt: this.createdAt,
            lastUsed: this.lastUsed,
            keyCount: this.keyManager.keys.length,
            requestCount: this.requestCount,
            errorCount: this.errorCount,
            keyStats: this.keyManager.getAggregatedStats(),
            ...(this.statsAggregator ? { aggregated: this.statsAggregator.getErrorStats() } : {})
        };
    }

    /**
     * Cleanup tenant resources
     */
    destroy() {
        this.keyManager.destroy?.();
        if (this.statsAggregator) {
            this.statsAggregator.save();
            this.statsAggregator.stopAutoSave();
        }
    }
}

/**
 * Multi-tenant manager
 */
class TenantManager {
    /**
     * Create tenant manager
     * @param {Object} options - Configuration
     */
    constructor(options = {}) {
        this.enabled = options.enabled !== false;
        this.tenantHeader = options.tenantHeader || 'x-tenant-id';
        this.defaultTenantId = options.defaultTenantId || DEFAULT_TENANT_ID;
        this.strictMode = options.strictMode || false; // Reject unknown tenants
        this.isolateStats = options.isolateStats !== false;

        this.logger = options.logger;
        this.managerOptions = {
            maxConcurrencyPerKey: options.maxConcurrencyPerKey || 2,
            circuitBreaker: options.circuitBreaker || {},
            rateLimitPerMinute: options.rateLimitPerMinute || 60,
            rateLimitBurst: options.rateLimitBurst || 10,
            keySelection: options.keySelection,
            configDir: options.configDir,
            statsSaveInterval: options.statsSaveInterval,
            logger: this.logger,
            isolateStats: this.isolateStats
        };

        // Tenant contexts
        this.tenants = new Map();

        // Global stats for cross-tenant reporting
        this.globalStats = {
            totalRequests: 0,
            requestsByTenant: {},
            unknownTenantRequests: 0
        };
    }

    _log(level, message, context) {
        if (this.logger) {
            this.logger[level](message, context);
        }
    }

    /**
     * Load tenant configurations
     * @param {Object} tenantConfigs - Map of tenantId -> config
     */
    loadTenants(tenantConfigs) {
        if (!tenantConfigs || typeof tenantConfigs !== 'object') {
            this._log('warn', 'No tenant configurations provided');
            return;
        }

        for (const [tenantId, config] of Object.entries(tenantConfigs)) {
            if (!config.keys || !Array.isArray(config.keys)) {
                this._log('warn', `Tenant ${tenantId} has no keys configured, skipping`);
                continue;
            }

            this._createTenant(tenantId, config);
        }

        this._log('info', `Loaded ${this.tenants.size} tenants`);
    }

    /**
     * Create a tenant context
     * @param {string} tenantId - Tenant ID
     * @param {Object} config - Tenant config
     * @returns {TenantContext} Tenant context
     */
    _createTenant(tenantId, config) {
        if (this.tenants.has(tenantId)) {
            this.tenants.get(tenantId).destroy();
        }

        const context = new TenantContext(tenantId, config, this.managerOptions);
        this.tenants.set(tenantId, context);

        this._log('info', `Created tenant: ${tenantId}`, {
            keyCount: config.keys.length,
            rateLimitPerMinute: config.rateLimitPerMinute
        });

        return context;
    }

    /**
     * Get tenant context by ID
     * @param {string} tenantId - Tenant ID
     * @returns {TenantContext|null} Tenant context or null
     */
    getTenant(tenantId) {
        return this.tenants.get(tenantId) || null;
    }

    /**
     * Get tenant context from request
     * @param {http.IncomingMessage} req - HTTP request
     * @returns {Object} Result with context and tenantId
     */
    getTenantFromRequest(req) {
        if (!this.enabled) {
            // Multi-tenant disabled, return default
            return {
                tenantId: this.defaultTenantId,
                context: this.tenants.get(this.defaultTenantId),
                isDefault: true
            };
        }

        // Extract tenant ID from header
        const tenantId = req.headers[this.tenantHeader] || this.defaultTenantId;
        const context = this.tenants.get(tenantId);

        // Track stats
        this.globalStats.totalRequests++;
        this.globalStats.requestsByTenant[tenantId] = (this.globalStats.requestsByTenant[tenantId] || 0) + 1;

        if (!context) {
            this.globalStats.unknownTenantRequests++;

            if (this.strictMode) {
                return {
                    tenantId,
                    context: null,
                    error: 'unknown_tenant',
                    isDefault: false
                };
            }

            // Fall back to default tenant
            const defaultContext = this.tenants.get(this.defaultTenantId);
            return {
                tenantId: this.defaultTenantId,
                context: defaultContext,
                originalTenantId: tenantId,
                isDefault: true
            };
        }

        context.recordRequest();
        return {
            tenantId,
            context,
            isDefault: tenantId === this.defaultTenantId
        };
    }

    /**
     * Get all tenant stats
     * @returns {Object} All tenant statistics
     */
    getAllTenantStats() {
        const tenantStats = {};

        for (const [tenantId, context] of this.tenants) {
            tenantStats[tenantId] = context.getStats();
        }

        return {
            enabled: this.enabled,
            tenantCount: this.tenants.size,
            strictMode: this.strictMode,
            isolateStats: this.isolateStats,
            globalStats: { ...this.globalStats },
            tenants: tenantStats
        };
    }

    /**
     * Get stats for a specific tenant
     * @param {string} tenantId - Tenant ID
     * @returns {Object|null} Tenant stats or null
     */
    getTenantStats(tenantId) {
        const context = this.tenants.get(tenantId);
        if (!context) return null;
        return context.getStats();
    }

    /**
     * Add a new tenant at runtime
     * @param {string} tenantId - Tenant ID
     * @param {Object} config - Tenant configuration
     * @returns {boolean} Success
     */
    addTenant(tenantId, config) {
        if (!config.keys || !Array.isArray(config.keys) || config.keys.length === 0) {
            this._log('warn', `Cannot add tenant ${tenantId}: no keys provided`);
            return false;
        }

        this._createTenant(tenantId, config);
        return true;
    }

    /**
     * Remove a tenant
     * @param {string} tenantId - Tenant ID
     * @returns {boolean} Success
     */
    removeTenant(tenantId) {
        if (tenantId === this.defaultTenantId) {
            this._log('warn', 'Cannot remove default tenant');
            return false;
        }

        const context = this.tenants.get(tenantId);
        if (context) {
            context.destroy();
            this.tenants.delete(tenantId);
            this._log('info', `Removed tenant: ${tenantId}`);
            return true;
        }
        return false;
    }

    /**
     * Update tenant keys
     * @param {string} tenantId - Tenant ID
     * @param {string[]} keys - New keys array
     * @returns {Object|null} Result or null if tenant not found
     */
    updateTenantKeys(tenantId, keys) {
        const context = this.tenants.get(tenantId);
        if (!context) return null;

        const result = context.keyManager.reloadKeys(keys);
        this._log('info', `Updated keys for tenant ${tenantId}`, result);
        return result;
    }

    /**
     * Get list of tenant IDs
     * @returns {string[]} Tenant IDs
     */
    getTenantIds() {
        return Array.from(this.tenants.keys());
    }

    /**
     * Check if tenant exists
     * @param {string} tenantId - Tenant ID
     * @returns {boolean}
     */
    hasTenant(tenantId) {
        return this.tenants.has(tenantId);
    }

    /**
     * Destroy all tenants (cleanup)
     */
    destroy() {
        for (const context of this.tenants.values()) {
            context.destroy();
        }
        this.tenants.clear();
        this._log('info', 'Tenant manager destroyed');
    }

    /**
     * Reload tenant configurations
     * @param {Object} tenantConfigs - New tenant configs
     */
    reload(tenantConfigs) {
        // Destroy existing tenants
        this.destroy();

        // Load new configurations
        this.loadTenants(tenantConfigs);
    }
}

module.exports = {
    TenantManager,
    TenantContext,
    DEFAULT_TENANT_ID
};
