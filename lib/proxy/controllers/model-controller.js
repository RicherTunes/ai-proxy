/**
 * Model Controller Module
 *
 * Handles model-related routes extracted from ProxyServer.
 * Provides endpoints for model routing, model discovery, model mapping, and model selection.
 *
 * TDD Phase: Green - Implementation to make tests pass
 */

'use strict';

const { parseJsonBody } = require('../../body-parser');
const { ModelRouter } = require('../../model-router');
const {
    normalizeModelRoutingConfig,
    computeConfigHash,
    shouldPersistNormalizedConfig,
    updateMigrationMarker
} = require('../../model-router-normalizer');
const { getClientIp } = require('../../client-ip');
const fs = require('fs');
const cluster = require('cluster');
const { atomicWrite } = require('../../atomic-write');
const path = require('path');

/**
 * ModelController class for model-related HTTP endpoints
 */
class ModelController {
    /**
     * @param {Object} options - Configuration options
     * @param {Object} options.modelRouter - ModelRouter instance
     * @param {Object} options.modelDiscovery - ModelDiscovery instance
     * @param {Object} options.modelMappingManager - ModelMappingManager instance
     * @param {Object} options.adminAuth - AdminAuth instance
     * @param {Object} options.config - Configuration object
     * @param {Object} options.logger - Logger instance
     * @param {Function} options.addAuditEntry - Audit log function
     * @param {boolean} options.isClusterWorker - Whether running as cluster worker
     * @param {Function} options.getClientIp - Client IP extraction function
     */
    constructor(options = {}) {
        this._modelRouter = options.modelRouter || null;
        this._modelDiscovery = options.modelDiscovery || { getModels: async () => [], getModelsByTier: async () => [], getCacheStats: () => ({}) };
        this._modelMappingManager = options.modelMappingManager || { enabled: false, toConfig: () => ({}), getKeyOverrides: () => [] };
        this._adminAuth = options.adminAuth || null;
        this._config = options.config || { modelMappingManager: this._modelMappingManager, modelMapping: {} };
        this._logger = options.logger || null;
        this._addAuditEntry = options.addAuditEntry || (() => {});
        this._isClusterWorker = options.isClusterWorker || false;
        this._getClientIp = options.getClientIp || ((req) => getClientIp(req, ['127.0.0.1', '::1', '::ffff:127.0.0.1']));

        // Routing persistence state
        this._routingPersistence = {
            enabled: false,
            configPath: null,
            lastSavedAt: null,
            lastSaveError: null,
            lastLoadError: null
        };
    }

    /**
     * Set routing persistence configuration
     * @param {Object} config - Persistence configuration
     */
    setRoutingPersistence(config) {
        this._routingPersistence = { ...this._routingPersistence, ...config };
    }

    /**
     * Send JSON response with standard headers
     * @private
     */
    _sendJson(res, status, data) {
        if (res.headersSent) return;
        res.writeHead(status, {
            'content-type': 'application/json',
            'cache-control': 'no-store'
        });
        res.end(JSON.stringify(data, null, 2));
    }

    /**
     * Send JSON error response
     * @private
     */
    _sendError(res, status, message) {
        this._sendJson(res, status, { error: message });
    }

    /**
     * Handle /model-routing endpoint
     * GET: Return current routing state
     * PUT: Update routing configuration
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    async handleModelRouting(req, res) {
        if (!this._modelRouter) {
            this._sendJson(res, 200, {
                enabled: false,
                inactiveReason: 'disabled_by_config',
                message: 'Model routing is not enabled in configuration',
                fallbackSystem: 'model-mapping',
                suggestedNextSteps: [
                    {
                        action: 'use_model_mapping',
                        description: 'Model mapping is currently active and handling model transformations',
                        endpoint: '/model-mapping'
                    },
                    {
                        action: 'enable_model_routing',
                        description: 'Enable modelRouting in config to activate advanced routing',
                        configKey: 'modelRouting.enabled',
                        endpoint: '/model-selection'
                    },
                    {
                        action: 'check_status',
                        description: 'View overall model selection system status',
                        endpoint: '/model-selection'
                    }
                ]
            });
            return;
        }

        if (req.method === 'GET') {
            const data = this._modelRouter.toJSON();
            // Add cluster warning when running in cluster mode
            const isActuallyClustered = this._isClusterWorker || (cluster.isPrimary && cluster.workers && Object.keys(cluster.workers).length > 0);
            if (isActuallyClustered) {
                data.warnings = data.warnings || [];
                data.warnings.push('cooldowns_not_shared_in_cluster');
                if (this._isClusterWorker) {
                    data.warnings.push('overrides_not_persisted_on_worker');
                }
            }
            // Add persistence state
            data.persistence = {
                enabled: this._routingPersistence.enabled,
                configPath: this._routingPersistence.configPath,
                lastSavedAt: this._routingPersistence.lastSavedAt,
                lastSaveError: this._routingPersistence.lastSaveError,
                lastLoadError: this._routingPersistence.lastLoadError
            };
            this._sendJson(res, 200, data);
            return;
        }

        if (req.method === 'PUT') {
            try {
                const updates = await parseJsonBody(req, { allowEmpty: false });

                // NORM-01: Normalize updates through normalizer with patchMode
                // patchMode prevents filling missing tiers with empty defaults,
                // allowing partial PUT payloads (e.g. only updating one tier)
                const normalizationResult = normalizeModelRoutingConfig(updates, {
                    logger: this._logger || console,
                    patchMode: true
                });

                const normalizedUpdates = normalizationResult.normalizedConfig;
                const migrated = normalizationResult.migrated;
                const warnings = normalizationResult.warnings || [];

                // Validate the user-provided keys for structural correctness
                const keysToValidate = {};
                for (const key of Object.keys(updates)) {
                    keysToValidate[key] = normalizedUpdates[key] !== undefined ? normalizedUpdates[key] : updates[key];
                }
                keysToValidate.version = normalizedUpdates.version || this._modelRouter.config.version || '2.0';
                // Include existing defaultModel/rules context for completeness checks
                if ('rules' in keysToValidate && !('defaultModel' in keysToValidate) && this._modelRouter) {
                    keysToValidate.defaultModel = this._modelRouter.config.defaultModel || null;
                }
                if ('defaultModel' in keysToValidate && !('rules' in keysToValidate) && this._modelRouter) {
                    keysToValidate.rules = this._modelRouter.config.rules || [];
                }
                const validation = ModelRouter.validateConfig(keysToValidate);
                if (!validation.valid) {
                    this._sendError(res, 400, validation.error);
                    return;
                }

                const ip = this._getClientIp(req);

                // Deep-merge normalized updates with existing config
                const mergedConfig = { ...this._modelRouter.config, ...normalizedUpdates };
                if (normalizedUpdates.tiers) {
                    mergedConfig.tiers = { ...this._modelRouter.config.tiers };
                    for (const [tierName, tierConfig] of Object.entries(normalizedUpdates.tiers)) {
                        mergedConfig.tiers[tierName] = tierConfig;
                    }
                }

                // Apply to runtime
                this._modelRouter.updateConfig(mergedConfig);

                const response = {
                    success: true,
                    config: this._modelRouter.toJSON(),
                    migrated: migrated // Indicate if migration occurred
                };

                // Include warnings if any
                if (warnings.length > 0) {
                    response.warnings = warnings;
                }

                // NORM-02: Persist normalized config when persistence is enabled (hash-based dedup prevents redundant writes)
                // This ensures both v1 (migrated) and v2 (native) configs are persisted to disk
                // Hash-based dedup prevents redundant writes when config is unchanged
                const shouldPersist = this._routingPersistence.enabled && this._routingPersistence.configPath;

                if (shouldPersist) {
                    const configPath = this._routingPersistence.configPath;

                    try {
                        // Check if we should persist based on file hash
                        const currentHash = computeConfigHash(mergedConfig);

                        if (shouldPersistNormalizedConfig(configPath, currentHash)) {
                            const backupPath = configPath + '.bak';

                            // Extract only editable fields for persistence (use normalized config)
                            const editableFields = { version: mergedConfig.version || '2.0' };
                            const EDITABLE_KEYS = ['enabled', 'defaultModel', 'tiers', 'rules', 'classifier', 'cooldown', 'logDecisions', 'failover', 'shadowMode'];
                            for (const key of EDITABLE_KEYS) {
                                if (key in mergedConfig) {
                                    editableFields[key] = mergedConfig[key];
                                }
                            }

                            // Backup existing file
                            try {
                                const existing = fs.readFileSync(configPath, 'utf8');
                                await atomicWrite(backupPath, existing);
                            } catch (_e) {
                                // No existing file to backup
                            }

                            // Write new config (normalized format)
                            const serialized = JSON.stringify(editableFields, null, 2);
                            await atomicWrite(configPath, serialized);

                            // Update marker after successful write
                            updateMigrationMarker(configPath, currentHash);

                            // Paranoia check: re-read and validate
                            const reRead = fs.readFileSync(configPath, 'utf8');
                            const reparsed = JSON.parse(reRead);
                            const revalidation = ModelRouter.validateConfig(reparsed);
                            if (!revalidation.valid) {
                                // Restore backup
                                try {
                                    const backup = fs.readFileSync(backupPath, 'utf8');
                                    await atomicWrite(configPath, backup);
                                } catch (_e) {
                                    fs.unlinkSync(configPath);
                                }
                                this._routingPersistence.lastSaveError = 'Paranoia check failed: ' + revalidation.error;
                                this._logger?.error?.('[ModelRouter] Config persistence paranoia check failed, rolled back');
                                this._sendError(res, 500, 'Config written but failed verification — rolled back to backup');
                                return;
                            }

                            this._routingPersistence.lastSavedAt = new Date().toISOString();
                            this._routingPersistence.lastSaveError = null;
                            response.persisted = true;
                        } else {
                            // Config unchanged (hash match), skip persistence
                            response.persisted = false;
                            response.warning = 'config_already_migrated';
                        }
                    } catch (persistErr) {
                        // NORM-02: Graceful failure handling
                        const errMsg = `Failed to persist normalized config: ${persistErr.message}`;
                        this._routingPersistence.lastSaveError = errMsg;
                        this._logger?.warn?.('[ModelRouter] ' + errMsg);

                        // Emit metric for monitoring
                        if (this._statsAggregator) {
                            this._statsAggregator.recordConfigMigrationWriteFailure();
                        }

                        response.persisted = false;
                        response.persistError = errMsg;
                    }
                } else {
                    response.persisted = false;
                    response.warning = 'runtime_only_change';
                }

                this._addAuditEntry('model_routing_config_updated', {
                    ip,
                    updates: Object.keys(updates),
                    persisted: response.persisted || false,
                    migrated: migrated,
                    timestamp: new Date().toISOString()
                });

                this._sendJson(res, 200, response);
            } catch (e) {
                this._sendError(res, e.statusCode || 400, e.message || 'Invalid JSON body');
            }
            return;
        }

        this._sendError(res, 405, 'Method not allowed');
    }

    /**
     * Handle /models endpoint
     * GET: Return all available models with optional tier filter
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    async handleModelsRequest(req, res) {
        if (req.method !== 'GET') {
            this._sendError(res, 405, 'Method not allowed, use GET');
            return;
        }

        try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const tier = url.searchParams?.get('tier');

            let models;
            if (tier) {
                models = await this._modelDiscovery.getModelsByTier(tier);
            } else {
                models = await this._modelDiscovery.getModels();
            }

            this._sendJson(res, 200, {
                models,
                count: models.length,
                timestamp: new Date().toISOString(),
                cacheStats: this._modelDiscovery.getCacheStats()
            });
        } catch (error) {
            this._logger?.error?.(`Error fetching models: ${error.message}`);
            this._sendError(res, 500, `Failed to fetch models: ${error.message}`);
        }
    }

    /**
     * Handle /model-selection endpoint
     * GET: Return unified view of both model selection systems
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    handleModelSelection(req, res) {
        if (req.method !== 'GET') {
            this._sendError(res, 405, 'Method not allowed, use GET');
            return;
        }

        // DEPRECATE-05: Always report model-router as active system
        const activeSystem = 'model-router';
        const routerEnabled = !!(this._modelRouter && this._modelRouter.config && this._modelRouter.config.enabled);

        const response = {
            activeSystem,
            timestamp: new Date().toISOString(),
            systems: {
                'model-router': {
                    enabled: routerEnabled,
                    status: routerEnabled ? 'active' : 'recommended',
                    description: 'Advanced multi-tier routing with load balancing and health-based routing'
                },
                'model-mapping': {
                    enabled: false,
                    status: 'deprecated',
                    description: 'Deprecated. Use model-router for all model selection.',
                    deprecationDate: this._deprecationDate || '2026-06-01',
                    useInstead: '/model-routing'
                }
            },
            recommendations: []
        };

        this._sendJson(res, 200, response);
    }

    /**
     * Handle /model-mapping endpoint
     * GET: Return mapping configuration
     * PUT: Update global mapping
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    async handleModelMapping(req, res) {
        // Check admin auth if enabled
        if (this._adminAuth) {
            const authResult = this._adminAuth.authenticate(req);
            if (!authResult.authenticated) {
                res.writeHead(401, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: authResult.error }));
                return;
            }
        }

        const manager = this._modelMappingManager;

        if (req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                config: manager.toConfig(),
                keyOverrides: manager.getKeyOverrides(),
                deprecated: true,
                deprecationDate: this._deprecationDate || '2026-06-01',
                useInstead: '/model-routing',
                message: 'Model mapping is deprecated. Use /model-routing for tier-based routing.'
            }, null, 2));
            return;
        }

        if (req.method === 'PUT') {
            // DEPRECATED: No longer modifies mapping. Return deprecation info.
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                deprecated: true,
                deprecationDate: this._deprecationDate || '2026-06-01',
                useInstead: '/model-routing',
                message: 'PUT /model-mapping is deprecated and no longer updates configuration. Use PUT /model-routing instead.'
            }, null, 2));
            return;
        }

        res.writeHead(405, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
    }

    /**
     * Handle /model-mapping/reset endpoint
     * POST: Reset model mapping to defaults
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    async handleModelMappingReset(req, res) {
        if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not allowed, use POST' }));
            return;
        }

        // Check admin auth if enabled
        if (this._adminAuth) {
            const authResult = this._adminAuth.authenticate(req);
            if (!authResult.authenticated) {
                res.writeHead(401, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: authResult.error }));
                return;
            }
        }

        // DEPRECATED: No longer resets mapping. Return deprecation info.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            deprecated: true,
            deprecationDate: this._deprecationDate || '2026-06-01',
            useInstead: '/model-routing',
            message: 'POST /model-mapping/reset is deprecated and no longer resets configuration. Use /model-routing instead.'
        }, null, 2));
    }

    /**
     * Handle /model-mapping/keys/:keyIndex endpoint
     * GET: Get per-key overrides for a specific key
     * PUT: Set per-key override for a specific key
     * DELETE: Clear per-key override for a specific key
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     * @param {string} keyIndex - Key index
     */
    async handleModelMappingKey(req, res, keyIndex) {
        // Check admin auth if enabled
        if (this._adminAuth) {
            const authResult = this._adminAuth.authenticate(req);
            if (!authResult.authenticated) {
                res.writeHead(401, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: authResult.error }));
                return;
            }
        }

        const manager = this._modelMappingManager;
        const deprecationResponse = {
            deprecated: true,
            deprecationDate: this._deprecationDate || '2026-06-01',
            useInstead: '/model-routing'
        };

        if (req.method === 'GET') {
            const override = manager.getKeyOverride(keyIndex);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                ...deprecationResponse,
                override: override || {},
                message: 'GET /model-mapping/keys is deprecated. Use /model-routing for per-key configuration.'
            }, null, 2));
            return;
        }

        if (req.method === 'PUT') {
            // DEPRECATED: No longer sets key override. Return deprecation info.
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                ...deprecationResponse,
                message: 'PUT /model-mapping/keys is deprecated and no longer sets overrides. Use /model-routing instead.'
            }, null, 2));
            return;
        }

        if (req.method === 'DELETE') {
            // DEPRECATED: No longer clears key override. Return deprecation info.
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                ...deprecationResponse,
                message: 'DELETE /model-mapping/keys is deprecated and no longer clears overrides. Use /model-routing instead.'
            }, null, 2));
            return;
        }

        res.writeHead(405, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
    }

    /**
     * Handle /model-routing/reset endpoint
     * POST: Reset all routing state
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    async handleModelRoutingReset(req, res) {
        if (req.method !== 'POST') {
            this._sendError(res, 405, 'Method not allowed, use POST');
            return;
        }

        if (!this._modelRouter) {
            this._sendError(res, 503, 'Model router not available');
            return;
        }

        const ip = this._getClientIp(req);
        this._modelRouter.reset();
        this._addAuditEntry('model_routing_reset', {
            ip,
            timestamp: new Date().toISOString()
        });

        this._sendJson(res, 200, { success: true });
    }

    /**
     * Handle /model-routing/test endpoint
     * GET: Dry-run classifier without side effects
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    handleModelRoutingTest(req, res) {
        if (req.method !== 'GET') {
            this._sendError(res, 405, 'Method not allowed, use GET');
            return;
        }

        if (!this._modelRouter) {
            this._sendError(res, 503, 'Model router not available');
            return;
        }

        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const model = (url.searchParams.get('model') || 'claude-sonnet-4-5-20250929').trim();
        const maxTokensParam = url.searchParams.get('max_tokens');
        const messageCount = Math.min(Math.max(parseInt(url.searchParams.get('messages') || '1', 10) || 1, 1), 100);
        const hasTools = url.searchParams.get('tools') === 'true';
        const hasVision = url.searchParams.get('vision') === 'true';
        const systemLength = Math.min(Math.max(parseInt(url.searchParams.get('system_length') || '0', 10) || 0, 0), 1000000);

        // Build synthetic parsed body
        const syntheticBody = {
            model,
            messages: Array.from({ length: messageCount }, () => ({
                role: 'user',
                content: 'test'
            })),
            stream: false
        };

        if (maxTokensParam !== null && maxTokensParam !== '') {
            const maxTokens = parseInt(maxTokensParam, 10);
            if (!isNaN(maxTokens)) {
                syntheticBody.max_tokens = maxTokens;
            }
        }

        if (hasTools) {
            syntheticBody.tools = [{ name: 'test_tool', description: 'test', input_schema: { type: 'object' } }];
        }

        if (hasVision) {
            syntheticBody.messages[0] = {
                role: 'user',
                content: [
                    { type: 'text', text: 'test' },
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }
                ]
            };
        }

        if (systemLength > 0) {
            syntheticBody.system = 'x'.repeat(systemLength);
        }

        const features = this._modelRouter.extractFeatures(syntheticBody);
        const classification = this._modelRouter.classify(features);

        // Resolve to target model
        let targetModel = null;
        let failoverModel = null;
        if (classification && this._modelRouter.config.tiers?.[classification.tier]) {
            const tierConfig = this._modelRouter.config.tiers[classification.tier];
            targetModel = tierConfig.targetModel;
            failoverModel = tierConfig.failoverModel;
        } else if (this._modelRouter.config.defaultModel) {
            targetModel = this._modelRouter.config.defaultModel;
        }

        this._sendJson(res, 200, {
            features,
            classification,
            targetModel,
            failoverModel,
            cooldown: targetModel ? {
                targetMs: this._modelRouter.getModelCooldown(targetModel),
                failoverMs: failoverModel ? this._modelRouter.getModelCooldown(failoverModel) : null
            } : null
        });
    }

    /**
     * Handle /model-routing/overrides endpoint
     * GET: Return all overrides
     * PUT: Set an override
     * DELETE: Clear an override
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    async handleModelRoutingOverrides(req, res) {
        if (!this._modelRouter) {
            this._sendError(res, 503, 'Model router not available');
            return;
        }

        if (req.method === 'GET') {
            this._sendJson(res, 200, this._modelRouter.getOverrides());
            return;
        }

        if (req.method === 'PUT') {
            try {
                const body = await parseJsonBody(req, { allowEmpty: false });
                if (!body.key || !body.model) {
                    this._sendError(res, 400, 'key and model are required');
                    return;
                }
                const ip = this._getClientIp(req);
                this._modelRouter.setOverride(body.key, body.model);
                this._addAuditEntry('model_routing_override_set', {
                    ip,
                    key: body.key,
                    model: body.model,
                    timestamp: new Date().toISOString()
                });
                this._sendJson(res, 200, {
                    success: true,
                    overrides: this._modelRouter.getOverrides()
                });
            } catch (e) {
                this._sendError(res, e.statusCode || 400, e.message || 'Invalid JSON body');
            }
            return;
        }

        if (req.method === 'DELETE') {
            try {
                const body = await parseJsonBody(req, { allowEmpty: false });
                if (!body.key) {
                    this._sendError(res, 400, 'key is required');
                    return;
                }
                const ip = this._getClientIp(req);
                this._modelRouter.clearOverride(body.key);
                this._addAuditEntry('model_routing_override_cleared', {
                    ip,
                    key: body.key,
                    timestamp: new Date().toISOString()
                });
                this._sendJson(res, 200, {
                    success: true,
                    overrides: this._modelRouter.getOverrides()
                });
            } catch (e) {
                this._sendError(res, e.statusCode || 400, e.message || 'Invalid JSON body');
            }
            return;
        }

        this._sendError(res, 405, 'Method not allowed');
    }

    /**
     * Handle /model-routing/cooldowns endpoint
     * GET: Return all active cooldowns
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    handleModelRoutingCooldowns(req, res) {
        if (req.method !== 'GET') {
            this._sendError(res, 405, 'Method not allowed, use GET');
            return;
        }

        if (!this._modelRouter) {
            this._sendError(res, 503, 'Model router not available');
            return;
        }

        this._sendJson(res, 200, this._modelRouter.getCooldowns());
    }

    /**
     * Handle /model-routing/pools endpoint
     * GET: Return pool status
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    handleModelRoutingPools(req, res) {
        if (req.method !== 'GET') {
            this._sendError(res, 405, 'Method not allowed, use GET');
            return;
        }

        if (!this._modelRouter) {
            this._sendError(res, 503, 'Model router not available');
            return;
        }

        this._sendJson(res, 200, this._modelRouter.getPoolStatus());
    }

    /**
     * Handle /model-routing/export endpoint
     * GET: Export full routing state for import/archival
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    handleModelRoutingExport(req, res) {
        if (req.method !== 'GET') {
            this._sendError(res, 405, 'Method not allowed, use GET');
            return;
        }

        if (!this._modelRouter) {
            this._sendError(res, 503, 'Model router not available');
            return;
        }

        const data = this._modelRouter.toJSON();
        // Defensive redaction
        delete data.adminTokens;
        delete data.apiKeys;
        data.exportedAt = new Date().toISOString();
        data.version = '1.0';

        res.writeHead(200, {
            'content-type': 'application/json',
            'content-disposition': 'attachment; filename="model-routing-export.json"',
            'cache-control': 'no-store'
        });
        res.end(JSON.stringify(data, null, 2));
    }

    /**
     * Handle /model-routing/import-from-mappings endpoint
     * GET: Generate routing rules from existing model-mapping configuration
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    async handleModelRoutingImportFromMappings(req, res) {
        if (req.method !== 'GET') {
            this._sendError(res, 405, 'Method not allowed, use GET');
            return;
        }

        // Require admin auth if enabled
        if (this._adminAuth && this._adminAuth.enabled) {
            const authResult = this._adminAuth.authenticate(req);
            if (!authResult.authenticated) {
                this._sendError(res, 401, authResult.error);
                return;
            }
        }

        if (!this._modelRouter) {
            this._sendError(res, 503, 'Model router not available — modelRouting must be configured');
            return;
        }

        const manager = this._modelMappingManager;
        const rules = [];

        // Convert model mappings to routing rules
        if (manager && typeof manager.toConfig === 'function') {
            const config = manager.toConfig();
            if (config.mapping) {
                for (const [pattern, target] of Object.entries(config.mapping)) {
                    // Convert wildcard patterns to rule format
                    const isWildcard = pattern.includes('*');
                    if (isWildcard) {
                        // Convert "claude-*" to rule match pattern
                        const modelPattern = pattern.replace(/\*/g, '.*');
                        rules.push({
                            match: { model: modelPattern },
                            tier: 'light', // Default to light tier for imported mappings
                            source: 'imported_from_model_mapping'
                        });
                    }
                }
            }
        }

        this._sendJson(res, 200, {
            rules,
            count: rules.length,
            timestamp: new Date().toISOString(),
            source: 'model-mapping'
        });
    }

    /**
     * Handle /model-routing/enable-safe endpoint
     * PUT: Enable model routing safely with validation and optional defaults
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    async handleModelRoutingEnableSafe(req, res) {
        if (req.method !== 'PUT') {
            this._sendError(res, 405, 'Method not allowed, use PUT');
            return;
        }

        // Require admin auth if enabled
        if (this._adminAuth && this._adminAuth.enabled) {
            const authResult = this._adminAuth.authenticate(req);
            if (!authResult.authenticated) {
                this._sendError(res, 401, authResult.error);
                return;
            }
        }

        if (!this._modelRouter) {
            this._sendError(res, 503, 'Model router not available — modelRouting must be configured');
            return;
        }

        try {
            const body = await parseJsonBody(req, { allowEmpty: true });
            const addDefaultRules = !!(body && body.addDefaultRules);
            const userUpdates = (body && body.updates) || {};

            // Build the configuration updates
            const updates = { ...userUpdates, enabled: true };

            // Add default tier configs if requested
            if (addDefaultRules) {
                if (!updates.tiers) {
                    updates.tiers = {};
                }
                if (!updates.tiers.light) {
                    updates.tiers.light = { targetModel: 'glm-4.5-air', clientModelPolicy: 'rule-match-only' };
                }
                if (!updates.tiers.medium) {
                    updates.tiers.medium = { targetModel: 'glm-4.6', clientModelPolicy: 'rule-match-only' };
                }
                if (!updates.tiers.heavy) {
                    updates.tiers.heavy = { targetModel: 'glm-4.7', clientModelPolicy: 'always-route' };
                }

                // Add default rules if none provided
                if (!updates.rules || updates.rules.length === 0) {
                    updates.rules = [
                        { match: { model: 'claude-opus-*' }, tier: 'heavy' },
                        { match: { model: 'claude-sonnet-*' }, tier: 'medium' },
                        { match: { model: 'claude-haiku-*' }, tier: 'light' }
                    ];
                }
            }

            // Validate tier configs have targetModel
            const mergedConfig = { ...this._modelRouter.config, ...updates };
            const validationErrors = [];
            if (mergedConfig.tiers) {
                for (const [tierName, tierConfig] of Object.entries(mergedConfig.tiers)) {
                    if (!tierConfig || !tierConfig.targetModel || typeof tierConfig.targetModel !== 'string') {
                        validationErrors.push(`Tier "${tierName}" is missing a valid targetModel`);
                    }
                }
            }

            if (validationErrors.length > 0) {
                this._sendJson(res, 400, {
                    success: false,
                    error: 'Configuration validation failed',
                    validationErrors
                });
                return;
            }

            // Validate via ModelRouter.validateConfig
            const validation = ModelRouter.validateConfig(updates);
            if (!validation.valid) {
                this._sendJson(res, 400, {
                    success: false,
                    error: 'Configuration validation failed',
                    validationErrors: [validation.error]
                });
                return;
            }

            // Apply the updates
            this._modelRouter.updateConfig(mergedConfig);

            const ip = this._getClientIp(req);
            this._addAuditEntry('model_routing_enabled_safe', {
                ip,
                addDefaultRules,
                timestamp: new Date().toISOString()
            });

            this._sendJson(res, 200, {
                success: true,
                config: this._modelRouter.toJSON(),
                message: 'Model routing enabled successfully'
            });
        } catch (e) {
            this._sendError(res, e.statusCode || 400, e.message || 'Invalid request body');
        }
    }
}

module.exports = {
    ModelController
};
