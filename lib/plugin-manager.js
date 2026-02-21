const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

/**
 * Plugin interface definition
 * @typedef {Object} Plugin
 * @property {string} name - Plugin name
 * @property {string} version - Plugin version
 * @property {string} description - Plugin description
 * @property {boolean} enabled - Whether plugin is active
 * @property {Function} init - Initialize plugin (called on register)
 * @property {Function} [destroy] - Cleanup (called on unregister)
 * @property {Function} [onRequest] - Before request processing
 * @property {Function} [onResponse] - After response received
 * @property {Function} [onError] - On error
 * @property {Function} [onKeySelect] - Before key selection
 * @property {Function} [onMetrics] - Periodic metrics hook
 */

/**
 * Plugin context provided to plugin hooks
 * @typedef {Object} PluginContext
 * @property {Object} config - Proxy configuration
 * @property {Object} logger - Logger instance
 * @property {Object} keyManager - Key manager instance
 * @property {EventEmitter} events - Event emitter for custom events
 * @property {Object} state - Plugin-specific state storage
 */

/**
 * PluginManager - Extensible plugin system for the proxy
 */
class PluginManager extends EventEmitter {
  /**
   * @param {Object} options - Plugin manager options
   * @param {string} options.pluginDir - Directory to load plugins from
   * @param {boolean} options.autoload - Whether to auto-load plugins on init
   * @param {Object} options.config - Proxy configuration
   * @param {Object} options.logger - Logger instance
   * @param {Object} options.keyManager - Key manager instance
   */
  constructor(options = {}) {
    super();

    this.pluginDir = options.pluginDir || path.join(process.cwd(), 'plugins');
    this.autoload = options.autoload !== false; // Default true
    this.config = options.config || {};
    this.logger = options.logger || console;
    this.keyManager = options.keyManager || null;

    // Plugin registry
    this.plugins = new Map();

    // Plugin state storage
    this.pluginStates = new Map();

    // Statistics
    this.stats = {
      registered: 0,
      enabled: 0,
      disabled: 0,
      errors: 0,
      hooksExecuted: {
        onRequest: 0,
        onResponse: 0,
        onError: 0,
        onKeySelect: 0,
        onMetrics: 0
      }
    };

    // Auto-load plugins if enabled
    if (this.autoload && fs.existsSync(this.pluginDir)) {
      this.loadFromDirectory(this.pluginDir);
    }
  }

  /**
   * Register a plugin
   * @param {string} name - Plugin name (overrides plugin.name if provided)
   * @param {Plugin} plugin - Plugin instance
   * @returns {boolean} Success
   */
  register(name, plugin) {
    try {
      // Validate plugin
      if (!plugin || typeof plugin !== 'object') {
        throw new Error('Plugin must be an object');
      }

      // Use provided name or plugin.name
      const pluginName = name || plugin.name;
      if (!pluginName) {
        throw new Error('Plugin must have a name');
      }

      // Check if already registered
      if (this.plugins.has(pluginName)) {
        throw new Error(`Plugin '${pluginName}' is already registered`);
      }

      // Set defaults
      plugin.name = pluginName;
      plugin.version = plugin.version || '1.0.0';
      plugin.description = plugin.description || 'No description';
      plugin.enabled = plugin.enabled !== false; // Default enabled

      // Validate required methods
      if (typeof plugin.init !== 'function') {
        throw new Error(`Plugin '${pluginName}' must have an init() method`);
      }

      // Create plugin context
      const context = this._createContext(pluginName);

      // Initialize plugin
      plugin.init(context);

      // Register plugin
      this.plugins.set(pluginName, plugin);
      this.stats.registered++;

      if (plugin.enabled) {
        this.stats.enabled++;
      } else {
        this.stats.disabled++;
      }

      this.logger.info(`Plugin '${pluginName}' v${plugin.version} registered`);
      this.emit('plugin:registered', pluginName, plugin);

      return true;
    } catch (error) {
      this.logger.error(`Failed to register plugin '${name}':`, error.message);
      this.stats.errors++;
      this.emit('plugin:error', name, error);
      return false;
    }
  }

  /**
   * Unregister a plugin
   * @param {string} name - Plugin name
   * @returns {boolean} Success
   */
  unregister(name) {
    try {
      const plugin = this.plugins.get(name);
      if (!plugin) {
        throw new Error(`Plugin '${name}' not found`);
      }

      // Call destroy if available
      if (typeof plugin.destroy === 'function') {
        plugin.destroy();
      }

      // Remove plugin
      this.plugins.delete(name);
      this.pluginStates.delete(name);
      this.stats.registered--;

      if (plugin.enabled) {
        this.stats.enabled--;
      } else {
        this.stats.disabled--;
      }

      this.logger.info(`Plugin '${name}' unregistered`);
      this.emit('plugin:unregistered', name);

      return true;
    } catch (error) {
      this.logger.error(`Failed to unregister plugin '${name}':`, error.message);
      this.stats.errors++;
      this.emit('plugin:error', name, error);
      return false;
    }
  }

  /**
   * Get plugin by name
   * @param {string} name - Plugin name
   * @returns {Plugin|null} Plugin instance or null
   */
  get(name) {
    return this.plugins.get(name) || null;
  }

  /**
   * List all registered plugins
   * @returns {Array<Object>} Plugin info array
   */
  list() {
    return Array.from(this.plugins.values()).map(plugin => ({
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      enabled: plugin.enabled
    }));
  }

  /**
   * Load plugins from directory
   * @param {string} dir - Directory path
   * @returns {number} Number of plugins loaded
   */
  loadFromDirectory(dir) {
    let loaded = 0;

    try {
      if (!fs.existsSync(dir)) {
        this.logger.warn(`Plugin directory '${dir}' does not exist`);
        return 0;
      }

      const files = fs.readdirSync(dir);

      for (const file of files) {
        // Only load .js files
        if (!file.endsWith('.js')) {
          continue;
        }

        // Path traversal protection
        if (file.includes('..') || file.includes('/') || file.includes('\\')) {
          this.logger.warn(`Skipping suspicious plugin filename: ${file}`);
          continue;
        }

        const filePath = path.resolve(dir, file);
        const resolvedDir = path.resolve(dir);

        // Ensure resolved path is within plugin directory
        if (!filePath.startsWith(resolvedDir + path.sep)) {
          this.logger.warn(`Skipping path traversal attempt: ${file}`);
          continue;
        }

        const stat = fs.statSync(filePath);

        if (!stat.isFile()) {
          continue;
        }

        try {
          // Load plugin module
          const pluginModule = require(filePath);

          // Get plugin instance (support both default export and direct export)
          const plugin = pluginModule.default || pluginModule;

          // Register plugin
          const pluginName = path.basename(file, '.js');
          if (this.register(pluginName, plugin)) {
            loaded++;
          }
        } catch (error) {
          this.logger.error(`Failed to load plugin '${file}':`, error.message);
          this.stats.errors++;
        }
      }

      this.logger.info(`Loaded ${loaded} plugin(s) from '${dir}'`);
    } catch (error) {
      this.logger.error(`Failed to load plugins from '${dir}':`, error.message);
      this.stats.errors++;
    }

    return loaded;
  }

  /**
   * Enable a plugin
   * @param {string} name - Plugin name
   * @returns {boolean} Success
   */
  enable(name) {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      this.logger.error(`Plugin '${name}' not found`);
      return false;
    }

    if (plugin.enabled) {
      this.logger.warn(`Plugin '${name}' is already enabled`);
      return true;
    }

    plugin.enabled = true;
    this.stats.enabled++;
    this.stats.disabled--;

    this.logger.info(`Plugin '${name}' enabled`);
    this.emit('plugin:enabled', name);

    return true;
  }

  /**
   * Disable a plugin
   * @param {string} name - Plugin name
   * @returns {boolean} Success
   */
  disable(name) {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      this.logger.error(`Plugin '${name}' not found`);
      return false;
    }

    if (!plugin.enabled) {
      this.logger.warn(`Plugin '${name}' is already disabled`);
      return true;
    }

    plugin.enabled = false;
    this.stats.enabled--;
    this.stats.disabled++;

    this.logger.info(`Plugin '${name}' disabled`);
    this.emit('plugin:disabled', name);

    return true;
  }

  /**
   * Get plugin statistics
   * @returns {Object} Statistics object
   */
  getStats() {
    return {
      ...this.stats,
      plugins: this.list()
    };
  }

  /**
   * Execute hook across all enabled plugins
   * @param {string} hookName - Hook name
   * @param {...any} args - Hook arguments
   * @returns {Promise<Array>} Array of hook results
   */
  async executeHook(hookName, ...args) {
    // Validate hook name to prevent arbitrary method calls
    const VALID_HOOKS = ['onRequest', 'onResponse', 'onError', 'onKeySelect', 'onMetrics'];
    if (!VALID_HOOKS.includes(hookName)) {
      throw new Error(`Invalid hook name: ${hookName}`);
    }

    const results = [];

    for (const [name, plugin] of this.plugins) {
      if (!plugin.enabled) {
        continue;
      }

      if (typeof plugin[hookName] !== 'function') {
        continue;
      }

      try {
        const result = await plugin[hookName](...args);
        results.push({ plugin: name, result });

        // Update stats
        if (this.stats.hooksExecuted[hookName] !== undefined) {
          this.stats.hooksExecuted[hookName]++;
        }
      } catch (error) {
        this.logger.error(`Plugin '${name}' hook '${hookName}' failed:`, error.message);
        this.stats.errors++;
        this.emit('plugin:hook:error', name, hookName, error);
      }
    }

    return results;
  }

  /**
   * Execute onRequest hook
   * @param {Object} req - Request object
   * @param {Object} context - Request context
   * @returns {Promise<Object>} Modified request
   */
  async onRequest(req, context) {
    const results = await this.executeHook('onRequest', req, context);

    // Allow plugins to modify request (last plugin wins)
    let modifiedReq = req;
    for (const { result } of results) {
      if (result && typeof result === 'object') {
        modifiedReq = { ...modifiedReq, ...result };
      }
    }

    return modifiedReq;
  }

  /**
   * Execute onResponse hook
   * @param {Object} res - Response object
   * @param {Object} context - Request context
   * @returns {Promise<Object>} Modified response
   */
  async onResponse(res, context) {
    const results = await this.executeHook('onResponse', res, context);

    // Allow plugins to modify response (last plugin wins)
    let modifiedRes = res;
    for (const { result } of results) {
      if (result && typeof result === 'object') {
        modifiedRes = { ...modifiedRes, ...result };
      }
    }

    return modifiedRes;
  }

  /**
   * Execute onError hook
   * @param {Error} error - Error object
   * @param {Object} context - Request context
   * @returns {Promise<void>}
   */
  async onError(error, context) {
    await this.executeHook('onError', error, context);
  }

  /**
   * Execute onKeySelect hook
   * @param {Object} key - Selected key
   * @param {Object} context - Request context
   * @returns {Promise<Object>} Modified key or original
   */
  async onKeySelect(key, context) {
    const results = await this.executeHook('onKeySelect', key, context);

    // Allow plugins to modify key selection (last plugin wins)
    let modifiedKey = key;
    for (const { result } of results) {
      if (result && typeof result === 'object') {
        modifiedKey = result;
      }
    }

    return modifiedKey;
  }

  /**
   * Execute onMetrics hook
   * @param {Object} metrics - Metrics object
   * @returns {Promise<void>}
   */
  async onMetrics(metrics) {
    await this.executeHook('onMetrics', metrics);
  }

  /**
   * Create plugin context
   * @param {string} pluginName - Plugin name
   * @returns {PluginContext} Plugin context
   * @private
   */
  _createContext(pluginName) {
    // Create or get plugin state
    if (!this.pluginStates.has(pluginName)) {
      this.pluginStates.set(pluginName, {});
    }

    return {
      config: this.config,
      logger: this._createPluginLogger(pluginName),
      keyManager: this.keyManager,
      events: this,
      state: this.pluginStates.get(pluginName)
    };
  }

  /**
   * Create plugin-specific logger
   * @param {string} pluginName - Plugin name
   * @returns {Object} Logger instance
   * @private
   */
  _createPluginLogger(pluginName) {
    const prefix = `[Plugin:${pluginName}]`;

    return {
      debug: (...args) => this.logger.debug(prefix, ...args),
      info: (...args) => this.logger.info(prefix, ...args),
      warn: (...args) => this.logger.warn(prefix, ...args),
      error: (...args) => this.logger.error(prefix, ...args)
    };
  }

  /**
   * Destroy the plugin manager and unregister all plugins
   */
  destroy() {
    // Convert to array to avoid modifying Map during iteration
    const pluginNames = Array.from(this.plugins.keys());

    // Unregister all plugins
    for (const name of pluginNames) {
      try {
        this.unregister(name);
      } catch (err) {
        this.logger.warn(`Error unregistering plugin ${name} during destroy: ${err.message}`);
      }
    }

    this.removeAllListeners();
    this.logger.info('Plugin manager destroyed');
  }
}

/**
 * Base plugin class for easier plugin creation
 */
class BasePlugin {
  constructor(name, version, description) {
    this.name = name;
    this.version = version || '1.0.0';
    this.description = description || 'No description';
    this.enabled = true;
    this.context = null;
  }

  init(context) {
    this.context = context;
    this.context.logger.info(`Initializing plugin '${this.name}'`);
  }

  destroy() {
    if (this.context) {
      this.context.logger.info(`Destroying plugin '${this.name}'`);
    }
  }

  // Hook stubs (override in subclass)
  async onRequest(req, context) {
    return req;
  }

  async onResponse(res, context) {
    return res;
  }

  async onError(error, context) {
    // No-op by default
  }

  async onKeySelect(key, context) {
    return key;
  }

  async onMetrics(metrics) {
    // No-op by default
  }
}

module.exports = { PluginManager, BasePlugin };
