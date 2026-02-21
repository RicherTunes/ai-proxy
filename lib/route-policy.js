const fs = require('fs');
const path = require('path');

/**
 * Default policy configuration
 */
const DEFAULT_POLICY = {
    name: 'default',
    retryBudget: 3,
    maxQueueTime: 30000,
    pacing: null,  // Use global rate limits
    tracing: {
        sampleRate: 100,
        includeBody: false,
        maxBodySize: 1024
    },
    telemetry: {
        mode: 'normal'
    },
    priority: -1,
    enabled: true
};

/**
 * Validate a policy object
 * @param {Object} policy - Policy to validate
 * @returns {Object} { valid: boolean, errors: string[] }
 */
function validatePolicy(policy) {
    const errors = [];

    if (!policy) {
        errors.push('Policy is required');
        return { valid: false, errors };
    }

    // Required fields
    if (!policy.name || typeof policy.name !== 'string') {
        errors.push('Policy name is required and must be a string');
    }

    // Validate match rules if present
    if (policy.match) {
        if (policy.match.paths && !Array.isArray(policy.match.paths)) {
            errors.push('match.paths must be an array');
        }
        if (policy.match.methods && !Array.isArray(policy.match.methods)) {
            errors.push('match.methods must be an array');
        }
        if (policy.match.models && !Array.isArray(policy.match.models)) {
            errors.push('match.models must be an array');
        }
    }

    // Validate retryBudget
    if (policy.retryBudget !== undefined) {
        if (typeof policy.retryBudget !== 'number' || policy.retryBudget < 0) {
            errors.push('retryBudget must be a non-negative number');
        }
    }

    // Validate maxQueueTime
    if (policy.maxQueueTime !== undefined) {
        if (typeof policy.maxQueueTime !== 'number' || policy.maxQueueTime < 0) {
            errors.push('maxQueueTime must be a non-negative number');
        }
    }

    // Validate pacing
    if (policy.pacing !== null && policy.pacing !== undefined) {
        if (typeof policy.pacing !== 'object') {
            errors.push('pacing must be an object or null');
        } else {
            if (policy.pacing.requestsPerMinute !== undefined &&
                (typeof policy.pacing.requestsPerMinute !== 'number' || policy.pacing.requestsPerMinute < 0)) {
                errors.push('pacing.requestsPerMinute must be a non-negative number');
            }
            if (policy.pacing.burstSize !== undefined &&
                (typeof policy.pacing.burstSize !== 'number' || policy.pacing.burstSize < 0)) {
                errors.push('pacing.burstSize must be a non-negative number');
            }
        }
    }

    // Validate tracing
    if (policy.tracing) {
        if (typeof policy.tracing !== 'object') {
            errors.push('tracing must be an object');
        } else {
            if (policy.tracing.sampleRate !== undefined) {
                if (typeof policy.tracing.sampleRate !== 'number' ||
                    policy.tracing.sampleRate < 0 ||
                    policy.tracing.sampleRate > 100) {
                    errors.push('tracing.sampleRate must be a number between 0 and 100');
                }
            }
            if (policy.tracing.includeBody !== undefined && typeof policy.tracing.includeBody !== 'boolean') {
                errors.push('tracing.includeBody must be a boolean');
            }
            if (policy.tracing.maxBodySize !== undefined &&
                (typeof policy.tracing.maxBodySize !== 'number' || policy.tracing.maxBodySize < 0)) {
                errors.push('tracing.maxBodySize must be a non-negative number');
            }
        }
    }

    // Validate telemetry
    if (policy.telemetry) {
        if (typeof policy.telemetry !== 'object') {
            errors.push('telemetry must be an object');
        } else {
            const validModes = ['normal', 'drop', 'sample'];
            if (policy.telemetry.mode !== undefined && !validModes.includes(policy.telemetry.mode)) {
                errors.push(`telemetry.mode must be one of: ${validModes.join(', ')}`);
            }
            if (policy.telemetry.sampleRate !== undefined) {
                if (typeof policy.telemetry.sampleRate !== 'number' ||
                    policy.telemetry.sampleRate < 0 ||
                    policy.telemetry.sampleRate > 100) {
                    errors.push('telemetry.sampleRate must be a number between 0 and 100');
                }
            }
        }
    }

    // Validate priority
    if (policy.priority !== undefined && typeof policy.priority !== 'number') {
        errors.push('priority must be a number');
    }

    // Validate enabled
    if (policy.enabled !== undefined && typeof policy.enabled !== 'boolean') {
        errors.push('enabled must be a boolean');
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Match a path against a pattern
 * Supports prefix matching and wildcards
 * @param {string} path - Path to match
 * @param {string} pattern - Pattern to match against
 * @returns {boolean}
 */
function matchPath(path, pattern) {
    if (!path || !pattern) return false;

    // Exact match
    if (path === pattern) return true;

    // Wildcard pattern
    if (pattern.includes('*')) {
        // ReDoS protection: limit wildcards and pattern length
        const wildcardCount = (pattern.match(/\*/g) || []).length;
        if (wildcardCount > 5 || pattern.length > 200) {
            return false; // Pattern too complex, reject
        }

        try {
            const regexPattern = pattern
                .replace(/[.+?^${}()|[\]\\]/g, '\\$&')  // Escape special chars
                .replace(/\*/g, '[^/]*');  // Convert * to [^/]* (non-greedy, no path traversal)
            const regex = new RegExp(`^${regexPattern}$`);
            return regex.test(path);
        } catch (e) {
            return false; // Invalid regex, no match
        }
    }

    // Prefix match (pattern without trailing *)
    return path.startsWith(pattern);
}

/**
 * Match a model against a pattern
 * Supports glob patterns with wildcards
 * @param {string} model - Model to match
 * @param {string} pattern - Pattern to match against
 * @returns {boolean}
 */
function matchModel(model, pattern) {
    if (!model || !pattern) return false;

    // Match all
    if (pattern === '*') return true;

    // Exact match
    if (model === pattern) return true;

    // Wildcard pattern
    if (pattern.includes('*')) {
        // ReDoS protection: limit wildcards and pattern length
        const wildcardCount = (pattern.match(/\*/g) || []).length;
        if (wildcardCount > 5 || pattern.length > 200) {
            return false; // Pattern too complex, reject
        }

        try {
            const regexPattern = pattern
                .replace(/[.+?^${}()|[\]\\]/g, '\\$&')  // Escape special chars
                .replace(/\*/g, '.*?');  // Convert * to .*? (non-greedy)
            const regex = new RegExp(`^${regexPattern}$`, 'i');  // Case insensitive
            return regex.test(model);
        } catch (e) {
            return false; // Invalid regex, no match
        }
    }

    return false;
}

/**
 * Match a method against allowed methods
 * @param {string} method - HTTP method
 * @param {string[]} allowedMethods - Allowed methods
 * @returns {boolean}
 */
function matchMethod(method, allowedMethods) {
    if (!method || !allowedMethods || allowedMethods.length === 0) return false;
    return allowedMethods.some(m =>
        typeof m === 'string' && m.toLowerCase() === method.toLowerCase()
    );
}

/**
 * Deep merge two objects
 * @param {Object} target - Target object
 * @param {Object} source - Source object
 * @returns {Object} Merged object
 */
function deepMerge(target, source) {
    const result = { ...target };

    for (const key in source) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
            result[key] = deepMerge(result[key] || {}, source[key]);
        } else {
            result[key] = source[key];
        }
    }

    return result;
}

/**
 * Route Policy Manager
 * Manages policies for different routes with hot reload support
 */
class RoutePolicyManager {
    /**
     * @param {Object} options - Configuration options
     * @param {string} options.configPath - Path to config file
     * @param {Object} options.logger - Logger instance
     * @param {Function} options.onReload - Callback for reload events
     */
    constructor(options = {}) {
        this.policies = [];
        this.defaultPolicy = { ...DEFAULT_POLICY };
        this.configPath = options.configPath;
        this.logger = options.logger || console;
        this.watcher = null;
        this.onReload = options.onReload;
        this.reloadDebounceTimer = null;

        // Load policies if config file exists
        if (this.configPath) {
            if (fs.existsSync(this.configPath)) {
                try {
                    this.loadPolicies(this.configPath);
                } catch (error) {
                    this.logger.error(`Failed to load policies from ${this.configPath}:`, error.message);
                }
            } else {
                this.logger.info(`Route policies config not found at ${this.configPath}; policies disabled`);
            }
        }
    }

    /**
     * Load policies from a configuration file
     * @param {string} configPath - Path to config file
     * @returns {Object} { success: boolean, policiesLoaded: number, errors: string[] }
     */
    loadPolicies(configPath) {
        const result = {
            success: false,
            policiesLoaded: 0,
            errors: []
        };

        try {
            if (!fs.existsSync(configPath)) {
                result.errors.push(`Config file not found: ${configPath}`);
                this.logger.error(`Config file not found: ${configPath}`);
                return result;
            }

            const content = fs.readFileSync(configPath, 'utf8');
            const config = JSON.parse(content);

            // Validate config structure
            if (!config.policies || !Array.isArray(config.policies)) {
                result.errors.push('Config must have a "policies" array');
                return result;
            }

            // Validate and load policies
            const validPolicies = [];
            for (const policy of config.policies) {
                const validation = validatePolicy(policy);
                if (validation.valid) {
                    validPolicies.push(policy);
                } else {
                    result.errors.push(`Invalid policy "${policy.name || 'unnamed'}": ${validation.errors.join(', ')}`);
                }
            }

            // Sort policies by priority (highest first)
            validPolicies.sort((a, b) => {
                const priorityA = a.priority !== undefined ? a.priority : 0;
                const priorityB = b.priority !== undefined ? b.priority : 0;
                return priorityB - priorityA;
            });

            this.policies = validPolicies;
            result.success = true;
            result.policiesLoaded = validPolicies.length;

            this.logger.info(`Loaded ${validPolicies.length} policies from ${configPath}`);
            if (result.errors.length > 0) {
                this.logger.warn(`Policy load warnings: ${result.errors.join('; ')}`);
            }
        } catch (error) {
            result.errors.push(error.message);
            this.logger.error(`Failed to load policies:`, error);
        }

        return result;
    }

    /**
     * Reload policies from the config file
     * @returns {Object} Load result
     */
    reload() {
        if (!this.configPath) {
            this.logger.warn('No config path set, cannot reload');
            return { success: false, errors: ['No config path set'] };
        }

        this.logger.info('Reloading policies...');
        const result = this.loadPolicies(this.configPath);

        if (this.onReload) {
            this.onReload(result);
        }

        return result;
    }

    /**
     * Start watching the config file for changes
     */
    startWatching() {
        if (!this.configPath) {
            this.logger.warn('No config path set, cannot watch for changes');
            return;
        }

        if (this.watcher) {
            this.logger.warn('Already watching config file');
            return;
        }

        try {
            this.watcher = fs.watch(this.configPath, (eventType) => {
                if (eventType === 'change') {
                    // Debounce rapid changes
                    clearTimeout(this.reloadDebounceTimer);
                    this.reloadDebounceTimer = setTimeout(() => {
                        this.logger.info('Config file changed, reloading policies...');
                        this.reload();
                    }, 300);
                }
            });

            this.logger.info(`Watching config file for changes: ${this.configPath}`);
        } catch (error) {
            this.logger.error('Failed to start watching config file:', error);
        }
    }

    /**
     * Stop watching the config file
     */
    stopWatching() {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
            clearTimeout(this.reloadDebounceTimer);
            this.logger.info('Stopped watching config file');
        }
    }

    /**
     * Match a request to a policy
     * @param {Object} request - Request object { path, method, model, headers }
     * @returns {Object} Matched policy merged with defaults
     */
    matchPolicy(request) {
        if (!request) {
            return { ...this.defaultPolicy };
        }

        const { path: reqPath, method, model } = request;

        // Check policies in priority order
        for (const policy of this.policies) {
            // Skip disabled policies
            if (policy.enabled === false) {
                continue;
            }

            // Check if policy has match rules
            if (!policy.match) {
                continue;
            }

            let matches = true;

            // Match paths
            if (policy.match.paths && policy.match.paths.length > 0) {
                const pathMatches = policy.match.paths.some(pattern =>
                    matchPath(reqPath, pattern)
                );
                if (!pathMatches) {
                    matches = false;
                }
            }

            // Match methods
            if (matches && policy.match.methods && policy.match.methods.length > 0) {
                if (!matchMethod(method, policy.match.methods)) {
                    matches = false;
                }
            }

            // Match models
            if (matches && policy.match.models && policy.match.models.length > 0) {
                const modelMatches = policy.match.models.some(pattern =>
                    matchModel(model, pattern)
                );
                if (!modelMatches) {
                    matches = false;
                }
            }

            // If all criteria match, merge with defaults and return
            if (matches) {
                return deepMerge(this.defaultPolicy, policy);
            }
        }

        // No match found, return default policy
        return { ...this.defaultPolicy };
    }

    /**
     * Get effective policy for a request (convenience method)
     * @param {string} path - Request path
     * @param {string} method - HTTP method
     * @param {string} model - Model name
     * @returns {Object} Effective policy
     */
    getPolicy(path, method, model) {
        return this.matchPolicy({ path, method, model });
    }

    /**
     * Add a policy at runtime
     * @param {Object} policy - Policy to add
     * @returns {Object} { success: boolean, error?: string }
     */
    addPolicy(policy) {
        const validation = validatePolicy(policy);
        if (!validation.valid) {
            return {
                success: false,
                error: validation.errors.join(', ')
            };
        }

        // Check for duplicate name
        if (this.policies.some(p => p.name === policy.name)) {
            return {
                success: false,
                error: `Policy with name "${policy.name}" already exists`
            };
        }

        this.policies.push(policy);

        // Re-sort by priority
        this.policies.sort((a, b) => {
            const priorityA = a.priority !== undefined ? a.priority : 0;
            const priorityB = b.priority !== undefined ? b.priority : 0;
            return priorityB - priorityA;
        });

        this.logger.info(`Added policy: ${policy.name}`);
        return { success: true };
    }

    /**
     * Update an existing policy
     * @param {string} name - Policy name
     * @param {Object} updates - Updates to apply
     * @returns {Object} { success: boolean, error?: string }
     */
    updatePolicy(name, updates) {
        const index = this.policies.findIndex(p => p.name === name);
        if (index === -1) {
            return {
                success: false,
                error: `Policy "${name}" not found`
            };
        }

        const updatedPolicy = deepMerge(this.policies[index], updates);
        const validation = validatePolicy(updatedPolicy);
        if (!validation.valid) {
            return {
                success: false,
                error: validation.errors.join(', ')
            };
        }

        this.policies[index] = updatedPolicy;

        // Re-sort if priority changed
        if (updates.priority !== undefined) {
            this.policies.sort((a, b) => {
                const priorityA = a.priority !== undefined ? a.priority : 0;
                const priorityB = b.priority !== undefined ? b.priority : 0;
                return priorityB - priorityA;
            });
        }

        this.logger.info(`Updated policy: ${name}`);
        return { success: true };
    }

    /**
     * Remove a policy
     * @param {string} name - Policy name
     * @returns {Object} { success: boolean, error?: string }
     */
    removePolicy(name) {
        const index = this.policies.findIndex(p => p.name === name);
        if (index === -1) {
            return {
                success: false,
                error: `Policy "${name}" not found`
            };
        }

        this.policies.splice(index, 1);
        this.logger.info(`Removed policy: ${name}`);
        return { success: true };
    }

    /**
     * Get all policies
     * @returns {Object[]} Array of policies
     */
    getPolicies() {
        return [...this.policies];
    }

    /**
     * Get a policy by name
     * @param {string} name - Policy name
     * @returns {Object|null} Policy or null if not found
     */
    getPolicyByName(name) {
        return this.policies.find(p => p.name === name) || null;
    }

    /**
     * Validate a policy object
     * @param {Object} policy - Policy to validate
     * @returns {Object} { valid: boolean, errors: string[] }
     */
    validatePolicy(policy) {
        return validatePolicy(policy);
    }
}

module.exports = {
    RoutePolicyManager,
    DEFAULT_POLICY,
    validatePolicy
};
