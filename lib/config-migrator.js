'use strict';

/**
 * Config Migrator - Pure Migration Functions
 *
 * Converts a modelMapping config into equivalent modelRouting rules.
 * This module is pure: no I/O, no side effects, no dependencies on Config or ProxyServer.
 *
 * @module config-migrator
 */

/**
 * Infer the routing tier from a source model name and/or target model name.
 *
 * Priority: source model name keywords > target model name keywords > default 'medium'.
 *
 * @param {string} sourceModel - The Claude model name (e.g. 'claude-opus-4-6')
 * @param {string} targetModel - The GLM target model (e.g. 'glm-4.7')
 * @returns {'heavy'|'medium'|'light'} The inferred tier
 */
function inferTier(sourceModel, targetModel) {
    const src = (sourceModel || '').toLowerCase();
    const tgt = (targetModel || '').toLowerCase();

    // Check source model name first (most reliable)
    if (src.includes('opus')) return 'heavy';
    if (src.includes('sonnet')) return 'medium';
    if (src.includes('haiku')) return 'light';

    // Fallback: check target model name
    if (tgt.includes('glm-4.7')) return 'heavy';
    if (tgt.includes('glm-4.5-air')) return 'light';
    if (tgt.includes('glm-4.5')) return 'medium';

    return 'medium';
}

/**
 * Convert a concrete model name into a wildcard pattern for rule matching.
 *
 * e.g. 'claude-opus-4-6' -> 'claude-opus-*'
 *      'claude-3-5-sonnet-20241022' -> 'claude-sonnet-*'
 *      'claude-3-haiku-20240307' -> 'claude-haiku-*'
 *
 * @param {string} modelName - A concrete model name
 * @returns {string} A wildcard pattern
 */
function toWildcardPattern(modelName) {
    const lower = (modelName || '').toLowerCase();
    if (lower.includes('opus')) return 'claude-opus-*';
    if (lower.includes('sonnet')) return 'claude-sonnet-*';
    if (lower.includes('haiku')) return 'claude-haiku-*';
    return modelName; // Keep as-is for unknown patterns
}

/**
 * Migrate a modelMapping config into equivalent modelRouting rules and tier targets.
 *
 * @param {Object} mappingConfig - The modelMapping config object (same shape as DEFAULT_CONFIG.modelMapping)
 * @param {boolean} [mappingConfig.enabled] - Whether mapping is enabled
 * @param {Object} [mappingConfig.models] - Map of source model -> target model
 * @param {string|null} [mappingConfig.defaultModel] - Default model if no mapping found
 * @returns {{ rules: Array, tiers: Object, catchAll: Object }} Equivalent modelRouting fragment
 */
function migrateModelMappingToRouting(mappingConfig) {
    if (!mappingConfig || !mappingConfig.models) {
        return {
            rules: [],
            tiers: {},
            catchAll: { match: { model: '*' }, tier: 'medium' }
        };
    }

    const rulesMap = new Map(); // pattern -> rule (for deduplication)
    const tierTargets = {};     // tier -> Set of target models

    for (const [sourceModel, targetModel] of Object.entries(mappingConfig.models)) {
        const tier = inferTier(sourceModel, targetModel);
        const pattern = toWildcardPattern(sourceModel);

        // Deduplicate by match pattern
        if (!rulesMap.has(pattern)) {
            rulesMap.set(pattern, {
                match: { model: pattern },
                tier,
                comment: 'Migrated from model-mapping'
            });
        }

        // Collect target models per tier
        if (!tierTargets[tier]) tierTargets[tier] = new Set();
        tierTargets[tier].add(targetModel);
    }

    // Build tiers output with deduplicated target models
    const tiers = {};
    for (const [tier, targets] of Object.entries(tierTargets)) {
        tiers[tier] = { targetModels: [...targets] };
    }

    const catchAll = { match: { model: '*' }, tier: 'medium' };

    return {
        rules: [...rulesMap.values()],
        tiers,
        catchAll
    };
}

/**
 * Migrate per-key model overrides from ModelMappingManager to routing overrides.
 *
 * ModelMappingManager stores overrides as: Map<keyIndex, { claudeModel: glmModel }>
 * Routing overrides use a simpler model: one target model per key.
 * When a key has multiple model mappings, only the first target is used (lossy).
 *
 * @param {Map<number, Object>|null} keyOverrides - ModelMappingManager keyOverrides map
 * @param {Array<{key: string}>} apiKeys - Array of API key objects
 * @returns {{ overrides: Array<{keyIndex: number, targetModel: string}>, warnings: string[] }}
 */
function migrateKeyOverrides(keyOverrides, apiKeys) {
    const overrides = [];
    const warnings = [];

    if (!keyOverrides || keyOverrides.size === 0) {
        return { overrides, warnings };
    }

    for (const [keyIndex, modelMap] of keyOverrides.entries()) {
        const entries = Object.entries(modelMap);
        if (entries.length === 0) continue;

        if (entries.length > 1) {
            warnings.push(
                `Key index ${keyIndex} has multiple model overrides (${entries.length}); ` +
                `only the first target model will be used in routing overrides`
            );
        }

        const [, targetModel] = entries[0];
        overrides.push({ keyIndex, targetModel });
    }

    return { overrides, warnings };
}

/**
 * Perform startup migration: convert modelMapping config into modelRouting rules.
 *
 * Migration is triggered when:
 *   - mappingConfig exists and is enabled
 *   - mappingConfig.models has entries
 *   - routingConfig.version is NOT '2.0' (already migrated)
 *
 * Migration is skipped (returns { migrated: false }) when any condition fails.
 *
 * @param {Object} routingConfig - The current modelRouting config
 * @param {Object|null} mappingConfig - The modelMapping config
 * @param {Object} [logger] - Logger with info() and warn() methods
 * @returns {{ migrated: boolean, config: Object }}
 */
function performStartupMigration(routingConfig, mappingConfig, logger) {
    // Skip if mapping not enabled or not present
    if (!mappingConfig || !mappingConfig.enabled || !mappingConfig.models) {
        return { migrated: false, config: routingConfig };
    }

    // Skip if models is empty
    if (Object.keys(mappingConfig.models).length === 0) {
        return { migrated: false, config: routingConfig };
    }

    // Skip if already migrated (v2.0)
    if (routingConfig.version === '2.0') {
        return { migrated: false, config: routingConfig };
    }

    // Skip if routing already has explicit rules (user-configured routing takes precedence)
    if (Array.isArray(routingConfig.rules) && routingConfig.rules.length > 0) {
        return { migrated: false, config: routingConfig };
    }

    const migration = migrateModelMappingToRouting(mappingConfig);
    const mergedConfig = { ...routingConfig };

    // Merge migrated rules (append to existing, or replace empty)
    const existingRules = Array.isArray(mergedConfig.rules) ? mergedConfig.rules : [];
    mergedConfig.rules = [...existingRules, ...migration.rules, migration.catchAll];

    // Set version to signal migration complete
    mergedConfig.version = '2.0';

    logger?.info?.(`[Migration] Auto-migrated modelMapping to modelRouting: ${migration.rules.length} rules generated`);

    return { migrated: true, config: mergedConfig };
}

module.exports = { migrateModelMappingToRouting, inferTier, toWildcardPattern, migrateKeyOverrides, performStartupMigration };
