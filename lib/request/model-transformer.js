/**
 * Model Transformer Module
 *
 * Function for transforming request bodies to map/route model names.
 * Extracted from RequestHandler for better testability and reusability.
 *
 * Supports:
 * - Model Router: Complexity-aware routing with override support
 *
 * @module request/model-transformer
 */

'use strict';

/**
 * Transform request body to map/route model names.
 *
 * Uses the ModelRouter for complexity-aware routing. When the router
 * returns a non-null model, the body is updated with the routed model.
 * When no router is provided or the router returns null, the body is
 * returned unchanged.
 *
 * @param {Buffer} body - Original request body
 * @param {Object|null} reqLogger - Request-scoped logger (optional)
 * @param {number|null} keyIndex - API key index for per-key overrides (optional)
 * @param {http.IncomingMessage|null} req - HTTP request for x-model-override header (optional)
 * @param {Set<string>|null} attemptedModels - Models already attempted in this request (optional)
 * @param {Object|null} modelRouter - ModelRouter instance for complexity-aware routing (optional)
 * @param {Object} overrideLogThrottle - Log throttle state for override logging (optional)
 * @param {Object|null} providerRegistry - ProviderRegistry instance for provider resolution (optional)
 * @param {Object|null} modelMapping - Model mapping config with models object for provider resolution (optional)
 * @returns {Promise<{body: Buffer, originalModel: string|null, mappedModel: string|null, routingDecision: Object|null, provider: string|null}>}
 *
 * @example
 * const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus', messages: [] }));
 * const result = await transformRequestBody(body, logger, 0, null, null, modelRouter);
 * // => { body: Buffer, originalModel: 'claude-3-opus', mappedModel: 'glm-4-opus', routingDecision: {...} }
 */
async function transformRequestBody(
    body,
    reqLogger,
    keyIndex = null,
    req = null,
    attemptedModels = null,
    modelRouter = null,
    overrideLogThrottle = null,
    providerRegistry = null,
    modelMapping = null
) {
    // Handle empty body
    if (body.length === 0) {
        return { body, originalModel: null, mappedModel: null, routingDecision: null, provider: null };
    }

    // Parse JSON body
    let parsed;
    try {
        parsed = JSON.parse(body.toString('utf8'));
    } catch (err) {
        reqLogger?.debug('Body not JSON, skipping model mapping', { error: err.message });
        return { body, originalModel: null, mappedModel: null, routingDecision: null, provider: null };
    }

    // No model field - nothing to transform
    if (!parsed.model) {
        return { body, originalModel: null, mappedModel: null, routingDecision: null, provider: null };
    }

    const originalModel = parsed.model;

    // ========== MODEL ROUTER PATH ==========
    if (modelRouter) {
        // Check for per-request override via header
        let override = null;
        if (req && req.headers && req.headers['x-model-override']) {
            const requestedOverride = req.headers['x-model-override'];
            // Only honor override if admin auth passes (when auth is enabled)
            const adminAuth = modelRouter.config?.adminAuth;
            const adminAuthInstance = modelRouter.config?._adminAuthInstance;

            if (adminAuth && adminAuth.enabled && adminAuthInstance) {
                const authResult = adminAuthInstance.authenticate(req);
                if (authResult.authenticated) {
                    override = requestedOverride;
                    const now = Date.now();
                    if (overrideLogThrottle && now - overrideLogThrottle.accepted > 1000) {
                        overrideLogThrottle.accepted = now;
                        reqLogger?.info('x-model-override accepted', {
                            override: requestedOverride,
                            originalModel
                        });
                    }
                } else {
                    const now = Date.now();
                    if (overrideLogThrottle && now - overrideLogThrottle.rejected > 1000) {
                        overrideLogThrottle.rejected = now;
                        reqLogger?.warn('x-model-override rejected: auth failed', {
                            override: requestedOverride,
                            originalModel
                        });
                    }
                }
            } else {
                // No auth configured — honor the override
                override = requestedOverride;
                const now = Date.now();
                if (overrideLogThrottle && now - overrideLogThrottle.accepted > 1000) {
                    overrideLogThrottle.accepted = now;
                    reqLogger?.info('x-model-override accepted (no auth)', {
                        override: requestedOverride,
                        originalModel
                    });
                }
            }
        }

        const routingResult = await modelRouter.selectModel({
            parsedBody: parsed,
            requestModel: originalModel,
            keyIndex,
            override,
            attemptedModels,
            includeTrace: true  // Always request trace for SSE dashboard
        });

        if (routingResult && routingResult.model) {
            parsed.model = routingResult.model;

            // Inject stream_options for streaming requests so upstream returns usage data.
            // Supported by z.ai and OpenAI-compatible providers.
            // Providers that don't support it (e.g., direct Anthropic) should set
            // requestTransform to strip it in their transform layer.
            if (parsed.stream === true && !parsed.stream_options) {
                parsed.stream_options = { include_usage: true };
            }

            const newBody = Buffer.from(JSON.stringify(parsed), 'utf8');

            if (modelRouter.config && modelRouter.config.logDecisions) {
                reqLogger?.info(`Model routed: ${originalModel} -> ${routingResult.model} [${routingResult.source}]`, {
                    tier: routingResult.tier,
                    reason: routingResult.reason,
                    keyIndex
                });
            }

            // Resolve provider for the routed model using model mapping config.
            const resolvedProvider = providerRegistry
                ? providerRegistry.resolveProviderForModel(routingResult.model, modelMapping)
                : null;

            return {
                body: newBody,
                originalModel,
                mappedModel: routingResult.model,
                routingDecision: routingResult,
                provider: resolvedProvider ? resolvedProvider.providerName : null
            };
        }

        // Shadow mode: log what WOULD have been routed
        if (modelRouter.shadowMode) {
            const shadowDecision = modelRouter.getLastShadowDecision();
            if (shadowDecision && modelRouter.config && modelRouter.config.logDecisions) {
                reqLogger?.info(`[SHADOW] Model would be routed: ${originalModel} -> ${shadowDecision.model} [${shadowDecision.source}]`, {
                    tier: shadowDecision.tier,
                    reason: shadowDecision.reason,
                    keyIndex,
                    shadowMode: true
                });
            }
        }
    }

    // Resolve provider for original model (no routing happened).
    const noRouteProvider = providerRegistry
        ? providerRegistry.resolveProviderForModel(originalModel, modelMapping)
        : null;
    const noRouteProviderName = noRouteProvider ? noRouteProvider.providerName : null;

    // No routing decision — still inject stream_options for cost tracking
    if (parsed.stream === true && !parsed.stream_options) {
        parsed.stream_options = { include_usage: true };
        const newBody = Buffer.from(JSON.stringify(parsed), 'utf8');
        return { body: newBody, originalModel, mappedModel: originalModel, routingDecision: null, provider: noRouteProviderName };
    }

    return { body, originalModel, mappedModel: originalModel, routingDecision: null, provider: noRouteProviderName };
}

module.exports = {
    transformRequestBody
};
