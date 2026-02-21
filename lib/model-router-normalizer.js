'use strict';

/**
 * Model Router Config Normalizer
 *
 * Normalizes v1 config to v2 config format.
 *
 * v1 format:
 *   tiers: {
 *     light: {
 *       targetModel: 'glm-4-flash',
 *       fallbackModels: ['glm-4-air'],
 *       failoverModel: 'glm-4-plus'
 *     }
 *   }
 *
 * v2 format:
 *   tiers: {
 *     light: {
 *       models: ['glm-4-flash', 'glm-4-air', 'glm-4-plus'],
 *       strategy: 'balanced'
 *     }
 *   }
 *
 * The normalizer:
 * - Detects v1 shapes (targetModel, fallbackModels, failoverModel)
 * - Detects v2 shapes (models[])
 * - Migrates v1 to v2: models[] = [targetModel, ...fallbackModels, failoverModel]
 * - DELETES v1 fields from output (NORM-03 requirement)
 * - Emits warnings for mixed v1/v2 input
 * - Returns { normalizedConfig, migrated: boolean, warnings: string[] }
 *
 * Migration persistence (NORM-02):
 * - Tracks file hash to persist normalized config only once per file content
 * - Marker file .model-routing.migrated stores: { hash, migratedAt }
 * - Prevents duplicate writes when same config is loaded multiple times
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Marker filename for tracking migration persistence
 */
const MIGRATION_MARKER_FILE = '.model-routing.migrated';

/**
 * Compute SHA-256 hash of config content
 * @param {Object} config - The config object to hash
 * @returns {string} Hex-encoded SHA-256 hash
 */
function computeConfigHash(config) {
    const configStr = JSON.stringify(config);
    return crypto.createHash('sha256').update(configStr).digest('hex');
}

/**
 * Get the full path to the migration marker file
 * @param {string} configPath - Path to the model-routing.json file
 * @returns {string} Path to the marker file
 */
function getMarkerPath(configPath) {
    // Place marker next to config file (e.g., config.json.migrated)
    // This ensures marker is in the same directory as the config file
    return configPath + MIGRATION_MARKER_FILE;
}

/**
 * Read migration marker file if it exists
 * @param {string} markerPath - Path to the marker file
 * @returns {Object|null} Marker data { hash: string, migratedAt: string } or null
 */
function readMigrationMarker(markerPath) {
    try {
        if (!fs.existsSync(markerPath)) {
            return null;
        }
        const content = fs.readFileSync(markerPath, 'utf8');
        return JSON.parse(content);
    } catch (err) {
        // If marker is corrupted, treat as non-existent
        return null;
    }
}

/**
 * Write migration marker file
 * @param {string} markerPath - Path to the marker file
 * @param {string} hash - Config hash to store
 * @returns {void}
 */
function writeMigrationMarker(markerPath, hash) {
    const markerData = {
        hash,
        migratedAt: new Date().toISOString()
    };
    fs.writeFileSync(markerPath, JSON.stringify(markerData, null, 2), 'utf8');
}

/**
 * Check if normalized config should be persisted based on file hash
 * @param {string} configPath - Path to the model-routing.json file
 * @param {string} currentHash - Hash of current normalized config
 * @returns {boolean} true if config should be persisted (first time or hash changed)
 */
function shouldPersistNormalizedConfig(configPath, currentHash) {
    const markerPath = getMarkerPath(configPath);
    const marker = readMigrationMarker(markerPath);

    // No marker = first time, should persist
    if (!marker) {
        return true;
    }

    // Hash matches = already persisted, skip
    if (marker.hash === currentHash) {
        return false;
    }

    // Hash changed = config updated, should persist
    return true;
}

/**
 * Update migration marker after successful persistence
 * @param {string} configPath - Path to the model-routing.json file
 * @param {string} hash - Hash of persisted config
 * @returns {void}
 */
function updateMigrationMarker(configPath, hash) {
    const markerPath = getMarkerPath(configPath);
    writeMigrationMarker(markerPath, hash);
}

/**
 * V1 field names that indicate legacy config format
 */
const V1_FIELDS = new Set(['targetModel', 'fallbackModels', 'failoverModel']);

/**
 * Valid v2 strategy names
 */
const VALID_STRATEGIES = new Set(['quality', 'throughput', 'balanced', 'pool']);

/**
 * Valid tier names for validation
 */
const VALID_TIERS = new Set(['light', 'medium', 'heavy']);

/**
 * Detect if a tier config uses v1 format
 * @param {Object} tierConfig - The tier configuration object
 * @returns {boolean} true if any v1 field is present
 */
function _isV1Format(tierConfig) {
    if (!tierConfig || typeof tierConfig !== 'object') {
        return false;
    }
    // Check if any v1 field is present (targetModel, fallbackModels, or failoverModel)
    // A tier with only fallbackModels is still v1 format and needs migration
    for (const field of V1_FIELDS) {
        if (field in tierConfig) {
            return true;
        }
    }
    return false;
}

/**
 * Detect if a tier config uses v2 format
 * @param {Object} tierConfig - The tier configuration object
 * @returns {boolean} true if models array is present and non-empty
 */
function _isV2Format(tierConfig) {
    if (!tierConfig || typeof tierConfig !== 'object') {
        return false;
    }
    return Array.isArray(tierConfig.models) && tierConfig.models.length > 0;
}

/**
 * Detect if a tier has mixed v1 and v2 fields
 * @param {Object} tierConfig - The tier configuration object
 * @returns {boolean} true if both v1 and v2 fields present
 */
function _isMixedFormat(tierConfig) {
    return _isV1Format(tierConfig) && _isV2Format(tierConfig);
}

/**
 * Normalize a single tier from v1 to v2 format
 * @param {string} tierName - The tier name (light, medium, heavy)
 * @param {Object} tierConfig - The tier configuration
 * @param {string[]} warnings - Array to collect warnings
 * @returns {Object} Normalized tier config with v2 format
 */
function _normalizeTier(tierName, tierConfig, warnings) {
    if (!tierConfig || typeof tierConfig !== 'object') {
        // Empty or invalid tier - return minimal valid v2 structure
        return {
            models: [],
            strategy: 'balanced'
        };
    }

    // Check for mixed format
    if (_isMixedFormat(tierConfig)) {
        warnings.push(
            `Tier "${tierName}" has both v1 fields (targetModel/fallbackModels/failoverModel) and v2 field (models[]). ` +
            `V2 format takes precedence.`
        );
    }

    // If already v2 format, pass through with validation
    if (_isV2Format(tierConfig)) {
        const normalized = {
            ...tierConfig,
            models: [...tierConfig.models] // Clone array to avoid mutation
        };

        // Ensure strategy has a valid default
        if (!normalized.strategy || !VALID_STRATEGIES.has(normalized.strategy)) {
            normalized.strategy = 'balanced';
        }

        // Ensure v1 fields are NOT present (NORM-03)
        delete normalized.targetModel;
        delete normalized.fallbackModels;
        delete normalized.failoverModel;

        return normalized;
    }

    // Migrate v1 to v2
    const models = [];

    // Add targetModel first (primary model)
    if (tierConfig.targetModel && typeof tierConfig.targetModel === 'string') {
        models.push(tierConfig.targetModel);
    }

    // Add fallbackModels (secondary models)
    if (Array.isArray(tierConfig.fallbackModels)) {
        for (const model of tierConfig.fallbackModels) {
            if (model && typeof model === 'string' && !models.includes(model)) {
                models.push(model);
            }
        }
    }

    // Add failoverModel (last resort)
    if (tierConfig.failoverModel && typeof tierConfig.failoverModel === 'string') {
        if (!models.includes(tierConfig.failoverModel)) {
            models.push(tierConfig.failoverModel);
        }
    }

    // Determine strategy (migrate v1 strategies to v2)
    let strategy = 'balanced'; // Default
    if (tierConfig.strategy) {
        if (tierConfig.strategy === 'failover') {
            // v1 'failover' strategy maps to v2 'balanced'
            strategy = 'balanced';
        } else if (VALID_STRATEGIES.has(tierConfig.strategy)) {
            strategy = tierConfig.strategy;
        }
        // else: keep default 'balanced'
    }

    // Build normalized v2 tier config
    const normalized = {
        strategy
    };

    // Only add models array if we have models
    if (models.length > 0) {
        normalized.models = models;
    } else {
        normalized.models = [];
    }

    // Copy over other v2-compatible fields
    if (tierConfig.label !== undefined) {
        normalized.label = tierConfig.label;
    }
    if (tierConfig.clientModelPolicy !== undefined) {
        normalized.clientModelPolicy = tierConfig.clientModelPolicy;
    }

    // CRITICAL: Do NOT include v1 fields in output (NORM-03)
    // (we explicitly don't copy targetModel, fallbackModels, failoverModel)

    return normalized;
}

/**
 * Normalize model routing config to v2 format
 *
 * @param {Object} config - The model routing config object
 * @param {Object} [options] - Optional configuration
 * @param {Object} [options.logger] - Logger instance for warnings (defaults to console)
 * @returns {Object} Result object with:
 *   - normalizedConfig: The normalized config (pure v2 format)
 *   - migrated: boolean, true if any migration occurred
 *   - warnings: string[] of any warnings generated
 */
function normalizeModelRoutingConfig(config, options = {}) {
    // Handle null/undefined options
    const opts = options || {};
    const logger = opts.logger || console;
    const warnings = [];
    let migrated = false;

    // Handle null/undefined input
    if (!config || typeof config !== 'object') {
        return {
            normalizedConfig: {
                version: '2.0',
                tiers: { light: { models: [], strategy: 'balanced' } },
                enabled: false
            },
            migrated: false,
            warnings: ['Input config is null or invalid']
        };
    }

    // Start with a copy of the config (excluding tiers which we'll rebuild)
    const normalized = {
        ...config,
        version: '2.0',
        tiers: {}
    };

    // Ensure version is explicitly set
    normalized.version = '2.0';

    // Normalize each tier
    const tiers = config.tiers || {};

    for (const [tierName, tierConfig] of Object.entries(tiers)) {
        // Skip non-object tier configs
        if (!tierConfig || typeof tierConfig !== 'object') {
            warnings.push(`Tier "${tierName}" has invalid config (not an object), skipping`);
            continue;
        }

        const wasV1 = _isV1Format(tierConfig) && !_isV2Format(tierConfig);
        const normalizedTier = _normalizeTier(tierName, tierConfig, warnings);
        normalized.tiers[tierName] = normalizedTier;

        if (wasV1) {
            migrated = true;
        }
    }

    // Ensure at least empty tier objects exist for standard tiers
    // In patch mode (PUT partial updates), do NOT fill missing tiers
    if (!opts.patchMode) {
        for (const tierName of VALID_TIERS) {
            if (!normalized.tiers[tierName]) {
                normalized.tiers[tierName] = {
                    models: [],
                    strategy: 'balanced'
                };
            }
        }
    }

    // Log warnings if any
    if (warnings.length > 0) {
        for (const warning of warnings) {
            logger.warn(`[model-router-normalizer] ${warning}`);
        }
    }

    return {
        normalizedConfig: normalized,
        migrated,
        warnings: [...warnings] // Return copy of warnings array
    };
}

module.exports = {
    normalizeModelRoutingConfig,
    // Exported for testing
    _isV1Format,
    _isV2Format,
    _isMixedFormat,
    _normalizeTier,
    VALID_TIERS,
    VALID_STRATEGIES,
    V1_FIELDS,
    // Migration tracking functions (NORM-02)
    computeConfigHash,
    getMarkerPath,
    readMigrationMarker,
    writeMigrationMarker,
    shouldPersistNormalizedConfig,
    updateMigrationMarker,
    MIGRATION_MARKER_FILE
};
