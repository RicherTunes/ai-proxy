/**
 * End-to-End Normalization Flow Tests
 *
 * Tests the complete normalization lifecycle:
 * 1. V1 config file loaded at startup
 * 2. Normalization occurs
 * 3. Config persisted back as v2 (if migrated)
 * 4. Subsequent startup loads v2 without re-normalizing
 * 5. PUT with v1 payload normalized
 * 6. API responses show only v2 shapes
 * 7. Warnings emitted for mixed input
 *
 * NORM-02: Conditional persistence with graceful failure
 * NORM-03: V1 shapes never in memory after normalization
 * NORM-04: API responses return models[] at top level
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const {
    normalizeModelRoutingConfig,
    computeConfigHash,
    getMarkerPath,
    readMigrationMarker,
    writeMigrationMarker,
    shouldPersistNormalizedConfig,
    updateMigrationMarker
} = require('../lib/model-router-normalizer');

describe('Model Router Normalization E2E', () => {
    let tempDir;
    let configPath;
    let markerPath;

    beforeEach(() => {
        // Create temp directory for each test
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'norm-e2e-'));
        configPath = path.join(tempDir, 'model-routing.json');
        markerPath = getMarkerPath(configPath);
    });

    afterEach(() => {
        // Clean up temp directory
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    describe('V1 to V2 migration lifecycle', () => {
        it('should normalize v1 config to v2 format', () => {
            const v1Config = {
                version: '1.0',
                enabled: true,
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash',
                        fallbackModels: ['glm-4-air']
                    },
                    medium: {
                        targetModel: 'glm-4-plus',
                        fallbackModels: ['glm-4-flash'],
                        failoverModel: 'glm-4-air'
                    },
                    heavy: {
                        targetModel: 'glm-4.7',
                        fallbackModels: ['glm-4.6'],
                        failoverModel: 'glm-4-plus'
                    }
                },
                defaultModel: 'glm-4-flash',
                classifier: {
                    complexityThreshold: 1000
                }
            };

            const result = normalizeModelRoutingConfig(v1Config);

            expect(result.migrated).toBe(true);
            expect(result.normalizedConfig.version).toBe('2.0');

            // Verify v2 format: models[] at top level
            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-flash', 'glm-4-air']);
            expect(result.normalizedConfig.tiers.medium.models).toEqual(['glm-4-plus', 'glm-4-flash', 'glm-4-air']);
            expect(result.normalizedConfig.tiers.heavy.models).toEqual(['glm-4.7', 'glm-4.6', 'glm-4-plus']);

            // Verify v1 fields removed from top level
            expect(result.normalizedConfig.tiers.light.targetModel).toBeUndefined();
            expect(result.normalizedConfig.tiers.light.fallbackModels).toBeUndefined();
            expect(result.normalizedConfig.tiers.light.failoverModel).toBeUndefined();
        });

        it('should pass through v2 config unchanged', () => {
            const v2Config = {
                version: '2.0',
                enabled: true,
                tiers: {
                    light: {
                        models: ['glm-4-flash', 'glm-4-air'],
                        strategy: 'throughput'
                    },
                    medium: {
                        models: ['glm-4-plus', 'glm-4-flash'],
                        strategy: 'balanced'
                    },
                    heavy: {
                        models: ['glm-4.7', 'glm-4.6'],
                        strategy: 'quality'
                    }
                },
                defaultModel: 'glm-4-flash'
            };

            const result = normalizeModelRoutingConfig(v2Config);

            expect(result.migrated).toBe(false);
            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-flash', 'glm-4-air']);
            expect(result.normalizedConfig.tiers.light.strategy).toBe('throughput');
        });

        it('should warn on mixed v1/v2 input', () => {
            const mixedConfig = {
                version: '2.0',
                tiers: {
                    light: {
                        models: ['glm-4-flash'],  // v2 field
                        targetModel: 'glm-4-flash'  // v1 field
                    }
                }
            };

            const result = normalizeModelRoutingConfig(mixedConfig);

            expect(result.warnings).toHaveLength(1);
            expect(result.warnings[0]).toContain('has both v1 fields');
            expect(result.warnings[0]).toContain('V2 format takes precedence');
        });
    });

    describe('Conditional persistence (NORM-02)', () => {
        it('should persist on first load', () => {
            const v1Config = {
                tiers: {
                    light: { targetModel: 'glm-4-flash' }
                }
            };

            const { normalizedConfig } = normalizeModelRoutingConfig(v1Config);
            const hash = computeConfigHash(normalizedConfig);

            // First load - no marker exists
            expect(shouldPersistNormalizedConfig(configPath, hash)).toBe(true);
        });

        it('should not persist if hash unchanged', () => {
            const config = {
                tiers: {
                    light: { models: ['glm-4-flash'] }
                }
            };

            const { normalizedConfig } = normalizeModelRoutingConfig(config);
            const hash = computeConfigHash(normalizedConfig);

            // Write marker
            writeMigrationMarker(markerPath, hash);

            // Same hash - should not persist
            expect(shouldPersistNormalizedConfig(configPath, hash)).toBe(false);
        });

        it('should persist if hash changed', () => {
            const oldHash = 'old-hash-value';
            writeMigrationMarker(markerPath, oldHash);

            const config = {
                tiers: {
                    light: { models: ['glm-4-flash'] }
                }
            };

            const { normalizedConfig } = normalizeModelRoutingConfig(config);
            const newHash = computeConfigHash(normalizedConfig);

            // Different hash - should persist
            expect(shouldPersistNormalizedConfig(configPath, newHash)).toBe(true);
        });

        it('should update marker after persistence', () => {
            const config = {
                tiers: {
                    light: { models: ['glm-4-flash'] }
                }
            };

            const { normalizedConfig } = normalizeModelRoutingConfig(config);
            const hash = computeConfigHash(normalizedConfig);

            updateMigrationMarker(configPath, hash);

            const marker = readMigrationMarker(markerPath);
            expect(marker).not.toBeNull();
            expect(marker.hash).toBe(hash);
            expect(marker.migratedAt).toBeDefined();
        });

        it('should handle corrupted marker gracefully', () => {
            // Write invalid JSON
            fs.writeFileSync(markerPath, 'invalid-json', 'utf8');

            const config = {
                tiers: {
                    light: { models: ['glm-4-flash'] }
                }
            };

            const { normalizedConfig } = normalizeModelRoutingConfig(config);
            const hash = computeConfigHash(normalizedConfig);

            // Corrupted marker treated as non-existent - should persist
            expect(shouldPersistNormalizedConfig(configPath, hash)).toBe(true);
        });
    });

    describe('API response format (NORM-04)', () => {
        it('should return models[] at top level in API response', () => {
            const v1Config = {
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash',
                        fallbackModels: ['glm-4-air'],
                        failoverModel: 'glm-4-plus'
                    }
                }
            };

            const { normalizedConfig } = normalizeModelRoutingConfig(v1Config);

            // Verify API response format
            expect(normalizedConfig.tiers.light).toBeDefined();
            expect(normalizedConfig.tiers.light.models).toBeDefined();
            expect(Array.isArray(normalizedConfig.tiers.light.models)).toBe(true);
            expect(normalizedConfig.tiers.light.models[0]).toBe('glm-4-flash');
            expect(normalizedConfig.tiers.light.models[1]).toBe('glm-4-air');
            expect(normalizedConfig.tiers.light.models[2]).toBe('glm-4-plus');

            // Verify v1 fields not at top level
            expect(normalizedConfig.tiers.light.targetModel).toBeUndefined();
            expect(normalizedConfig.tiers.light.fallbackModels).toBeUndefined();
            expect(normalizedConfig.tiers.light.failoverModel).toBeUndefined();
        });

        it('should preserve v2-compatible fields', () => {
            const config = {
                tiers: {
                    light: {
                        models: ['glm-4-flash'],
                        strategy: 'throughput',
                        label: 'Fast requests',
                        clientModelPolicy: 'prefer-route'
                    }
                }
            };

            const { normalizedConfig } = normalizeModelRoutingConfig(config);

            expect(normalizedConfig.tiers.light.strategy).toBe('throughput');
            expect(normalizedConfig.tiers.light.label).toBe('Fast requests');
            expect(normalizedConfig.tiers.light.clientModelPolicy).toBe('prefer-route');
        });
    });

    describe('Hash consistency', () => {
        it('should produce consistent hash for same config', () => {
            const config = {
                tiers: {
                    light: { models: ['glm-4-flash'] },
                    medium: { models: ['glm-4-plus'] }
                }
            };

            const hash1 = computeConfigHash(config);
            const hash2 = computeConfigHash(config);

            expect(hash1).toBe(hash2);
            expect(hash1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
        });

        it('should produce different hashes for different configs', () => {
            const config1 = { tiers: { light: { models: ['glm-4-flash'] } } };
            const config2 = { tiers: { light: { models: ['glm-4-plus'] } } };

            const hash1 = computeConfigHash(config1);
            const hash2 = computeConfigHash(config2);

            expect(hash1).not.toBe(hash2);
        });
    });

    describe('V1 shape removal (NORM-03)', () => {
        it('should remove all v1 fields from normalized config', () => {
            const v1Config = {
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash',
                        fallbackModels: ['glm-4-air'],
                        failoverModel: 'glm-4-plus',
                        strategy: 'failover'
                    }
                }
            };

            const { normalizedConfig } = normalizeModelRoutingConfig(v1Config);
            const tier = normalizedConfig.tiers.light;

            // v1 fields must not exist
            expect(tier.targetModel).toBeUndefined();
            expect(tier.fallbackModels).toBeUndefined();
            expect(tier.failoverModel).toBeUndefined();

            // v2 fields must exist
            expect(tier.models).toEqual(['glm-4-flash', 'glm-4-air', 'glm-4-plus']);
            expect(tier.strategy).toBe('balanced'); // 'failover' maps to 'balanced'
        });

        it('should handle v1-only config', () => {
            const v1Only = {
                tiers: {
                    heavy: {
                        targetModel: 'glm-4.7',
                        fallbackModels: ['glm-4.6'],
                        failoverModel: 'glm-4-plus'
                    }
                }
            };

            const { normalizedConfig, migrated } = normalizeModelRoutingConfig(v1Only);

            expect(migrated).toBe(true);
            expect(normalizedConfig.tiers.heavy.models).toEqual(['glm-4.7', 'glm-4.6', 'glm-4-plus']);
        });
    });

    describe('Edge cases', () => {
        it('should handle null/undefined input', () => {
            const result = normalizeModelRoutingConfig(null);

            expect(result.normalizedConfig).toBeDefined();
            expect(result.normalizedConfig.version).toBe('2.0');
            expect(result.migrated).toBe(false);
            expect(result.warnings).toContain('Input config is null or invalid');
        });

        it('should handle empty tiers object', () => {
            const result = normalizeModelRoutingConfig({ tiers: {} });

            expect(result.normalizedConfig.tiers.light).toBeDefined();
            expect(result.normalizedConfig.tiers.medium).toBeDefined();
            expect(result.normalizedConfig.tiers.heavy).toBeDefined();
            expect(result.normalizedConfig.tiers.light.models).toEqual([]);
        });

        it('should handle missing tiers field', () => {
            const result = normalizeModelRoutingConfig({});

            expect(result.normalizedConfig.tiers).toBeDefined();
            expect(result.normalizedConfig.tiers.light).toBeDefined();
        });

        it('should handle invalid tier config', () => {
            const config = {
                tiers: {
                    light: 'not-an-object',
                    medium: null,
                    heavy: { models: ['glm-4.7'] }
                }
            };

            const { normalizedConfig, warnings } = normalizeModelRoutingConfig(config);

            expect(normalizedConfig.tiers.heavy.models).toEqual(['glm-4.7']);
            expect(warnings.some(w => w.includes('light'))).toBe(true);
            expect(warnings.some(w => w.includes('medium'))).toBe(true);
        });
    });
});
