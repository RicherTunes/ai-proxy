'use strict';

/**
 * Config Migrator Edge-Case Tests
 *
 * Tests 11-16: v1-to-v2 migration, already-v2 passthrough, missing fields,
 * extra fields preserved, corrupt config handling, and migration idempotency.
 */

const {
    migrateModelMappingToRouting,
    inferTier,
    toWildcardPattern,
    migrateKeyOverrides,
    performStartupMigration
} = require('../lib/config-migrator');

describe('Config Migrator Edge Cases', () => {

    // ---------------------------------------------------------------
    // 11. V1 to V2 migration
    // ---------------------------------------------------------------
    describe('V1 to V2 migration', () => {
        test('old v1 format (pre-2.0) migrated correctly to v2', () => {
            const routingConfig = {
                enabled: true,
                tiers: {
                    heavy: { targetModel: 'glm-4.7', strategy: 'pool' },
                    medium: { targetModel: 'glm-4.5', strategy: 'pool' },
                    light: { targetModel: 'glm-4.5-air', strategy: 'pool' }
                },
                rules: []
            };
            const mappingConfig = {
                enabled: true,
                models: {
                    'claude-opus-4-6': 'glm-4.7',
                    'claude-sonnet-4-20250514': 'glm-4.5',
                    'claude-haiku-4-5-20251001': 'glm-4.5-air'
                }
            };

            const result = performStartupMigration(routingConfig, mappingConfig);

            expect(result.migrated).toBe(true);
            expect(result.config.version).toBe('2.0');
            expect(result.config.rules.length).toBeGreaterThan(0);
        });

        test('migrated rules contain correct wildcard patterns', () => {
            const routingConfig = { enabled: true, tiers: {}, rules: [] };
            const mappingConfig = {
                enabled: true,
                models: {
                    'claude-opus-4-6': 'glm-4.7',
                    'claude-sonnet-4-20250514': 'glm-4.5',
                    'claude-haiku-4-5-20251001': 'glm-4.5-air'
                }
            };

            const result = performStartupMigration(routingConfig, mappingConfig);

            const patterns = result.config.rules.map(r => r.match?.model).filter(Boolean);
            expect(patterns).toContain('claude-opus-*');
            expect(patterns).toContain('claude-sonnet-*');
            expect(patterns).toContain('claude-haiku-*');
        });

        test('migrated rules include catch-all as last entry', () => {
            const routingConfig = { enabled: true, tiers: {}, rules: [] };
            const mappingConfig = {
                enabled: true,
                models: { 'claude-opus-4-6': 'glm-4.7' }
            };

            const result = performStartupMigration(routingConfig, mappingConfig);

            const lastRule = result.config.rules[result.config.rules.length - 1];
            expect(lastRule.match.model).toBe('*');
            expect(lastRule.tier).toBe('medium');
        });

        test('tier inference from source model names is correct', () => {
            expect(inferTier('claude-opus-4-6', 'glm-4.7')).toBe('heavy');
            expect(inferTier('claude-sonnet-4-20250514', 'glm-4.5')).toBe('medium');
            expect(inferTier('claude-haiku-4-5-20251001', 'glm-4.5-air')).toBe('light');
        });

        test('wildcard patterns generated correctly from concrete names', () => {
            expect(toWildcardPattern('claude-opus-4-6')).toBe('claude-opus-*');
            expect(toWildcardPattern('claude-3-5-sonnet-20241022')).toBe('claude-sonnet-*');
            expect(toWildcardPattern('claude-3-haiku-20240307')).toBe('claude-haiku-*');
        });
    });

    // ---------------------------------------------------------------
    // 12. Already v2
    // ---------------------------------------------------------------
    describe('Already v2', () => {
        test('v2 config passes through without modification', () => {
            const routingConfig = {
                version: '2.0',
                enabled: true,
                tiers: {
                    heavy: { models: ['glm-4.7'], strategy: 'quality' },
                    medium: { models: ['glm-4.5'], strategy: 'balanced' },
                    light: { models: ['glm-4.5-air'], strategy: 'throughput' }
                },
                rules: []
            };
            const mappingConfig = {
                enabled: true,
                models: { 'claude-opus-4-6': 'glm-4.7' }
            };

            const result = performStartupMigration(routingConfig, mappingConfig);

            expect(result.migrated).toBe(false);
            expect(result.config).toBe(routingConfig); // Same reference, not modified
        });

        test('v2 config with existing rules is untouched', () => {
            const existingRules = [
                { match: { model: 'claude-opus-*' }, tier: 'heavy' },
                { match: { model: '*' }, tier: 'medium' }
            ];
            const routingConfig = {
                version: '2.0',
                enabled: true,
                tiers: {},
                rules: [...existingRules]
            };
            const mappingConfig = {
                enabled: true,
                models: { 'claude-opus-4-6': 'glm-4.7' }
            };

            const result = performStartupMigration(routingConfig, mappingConfig);

            expect(result.migrated).toBe(false);
            expect(result.config.rules).toHaveLength(2);
        });
    });

    // ---------------------------------------------------------------
    // 13. Missing fields
    // ---------------------------------------------------------------
    describe('Missing fields', () => {
        test('missing mapping models returns empty rules', () => {
            const result = migrateModelMappingToRouting({ enabled: true });

            expect(result.rules).toEqual([]);
            expect(result.tiers).toEqual({});
            expect(result.catchAll).toEqual({ match: { model: '*' }, tier: 'medium' });
        });

        test('null mapping config returns empty result', () => {
            const result = migrateModelMappingToRouting(null);

            expect(result.rules).toEqual([]);
            expect(result.tiers).toEqual({});
        });

        test('undefined mapping config returns empty result', () => {
            const result = migrateModelMappingToRouting(undefined);

            expect(result.rules).toEqual([]);
            expect(result.tiers).toEqual({});
        });

        test('performStartupMigration handles missing models gracefully', () => {
            const routingConfig = { enabled: true, tiers: {}, rules: [] };
            const mappingConfig = { enabled: true }; // no 'models' key

            const result = performStartupMigration(routingConfig, mappingConfig);

            expect(result.migrated).toBe(false);
            expect(result.config).toBe(routingConfig);
        });

        test('performStartupMigration handles missing enabled gracefully', () => {
            const routingConfig = { enabled: true, tiers: {}, rules: [] };
            const mappingConfig = { models: { 'claude-opus-4': 'glm-4.7' } }; // no 'enabled' key

            const result = performStartupMigration(routingConfig, mappingConfig);

            // enabled is falsy (undefined), so migration should be skipped
            expect(result.migrated).toBe(false);
        });

        test('inferTier handles null/undefined source and target gracefully', () => {
            expect(inferTier(null, null)).toBe('medium');
            expect(inferTier(undefined, undefined)).toBe('medium');
            expect(inferTier('', '')).toBe('medium');
        });

        test('toWildcardPattern handles null/empty input', () => {
            // toWildcardPattern returns modelName as-is for unknown patterns,
            // so null/undefined/'' pass through unchanged
            expect(toWildcardPattern(null)).toBeNull();
            expect(toWildcardPattern('')).toBe('');
            expect(toWildcardPattern(undefined)).toBeUndefined();
        });
    });

    // ---------------------------------------------------------------
    // 14. Extra fields preserved
    // ---------------------------------------------------------------
    describe('Extra fields preserved during migration', () => {
        test('unknown fields in routing config are preserved after migration', () => {
            const routingConfig = {
                enabled: true,
                defaultModel: 'glm-4.5',
                logDecisions: true,
                customFlag: 'keep-me',
                tiers: {},
                rules: []
            };
            const mappingConfig = {
                enabled: true,
                models: { 'claude-opus-4-6': 'glm-4.7' }
            };

            const result = performStartupMigration(routingConfig, mappingConfig);

            expect(result.migrated).toBe(true);
            expect(result.config.defaultModel).toBe('glm-4.5');
            expect(result.config.logDecisions).toBe(true);
            expect(result.config.customFlag).toBe('keep-me');
            expect(result.config.enabled).toBe(true);
        });

        test('migrated rules carry comment field', () => {
            const mapping = {
                enabled: true,
                models: { 'claude-opus-4-6': 'glm-4.7' }
            };

            const result = migrateModelMappingToRouting(mapping);

            expect(result.rules[0].comment).toBe('Migrated from model-mapping');
        });

        test('extra fields in mapping config do not break migration', () => {
            const mapping = {
                enabled: true,
                models: { 'claude-opus-4-6': 'glm-4.7' },
                defaultModel: 'glm-4.5',
                logTransformations: true,
                unknownKey: { nested: 'value' }
            };

            const result = migrateModelMappingToRouting(mapping);

            expect(result.rules).toHaveLength(1);
            expect(result.tiers.heavy.targetModels).toContain('glm-4.7');
        });
    });

    // ---------------------------------------------------------------
    // 15. Corrupt config
    // ---------------------------------------------------------------
    describe('Corrupt config handling', () => {
        test('null routing config with valid mapping throws on property access', () => {
            // performStartupMigration accesses routingConfig.version without null guard,
            // so passing null routing config throws TypeError
            expect(() => {
                performStartupMigration(null, { enabled: true, models: { a: 'b' } });
            }).toThrow(TypeError);
        });

        test('migrateModelMappingToRouting with non-object models handles gracefully', () => {
            // models is a string instead of object
            const result = migrateModelMappingToRouting({ enabled: true, models: 'not-an-object' });

            // Object.entries on a string gives character pairs, but should not crash
            expect(result).toBeDefined();
            expect(result.catchAll).toBeDefined();
        });

        test('migrateKeyOverrides with non-Map input returns empty', () => {
            const result = migrateKeyOverrides(null, []);
            expect(result.overrides).toEqual([]);
            expect(result.warnings).toEqual([]);
        });

        test('migrateKeyOverrides with empty Map returns empty', () => {
            const result = migrateKeyOverrides(new Map(), []);
            expect(result.overrides).toEqual([]);
            expect(result.warnings).toEqual([]);
        });

        test('performStartupMigration tolerates missing logger', () => {
            const routingConfig = { enabled: true, tiers: {}, rules: [] };
            const mappingConfig = { enabled: true, models: { 'claude-opus-4': 'glm-4.7' } };

            // undefined logger
            expect(() => {
                performStartupMigration(routingConfig, mappingConfig, undefined);
            }).not.toThrow();

            // null logger
            expect(() => {
                performStartupMigration(routingConfig, mappingConfig, null);
            }).not.toThrow();
        });

        test('performStartupMigration with empty routing config', () => {
            const routingConfig = {};
            const mappingConfig = {
                enabled: true,
                models: { 'claude-opus-4-6': 'glm-4.7' }
            };

            const result = performStartupMigration(routingConfig, mappingConfig);

            expect(result.migrated).toBe(true);
            expect(result.config.version).toBe('2.0');
            expect(result.config.rules.length).toBeGreaterThan(0);
        });
    });

    // ---------------------------------------------------------------
    // 16. Migration idempotency
    // ---------------------------------------------------------------
    describe('Migration idempotency', () => {
        test('migrating already-migrated config is a no-op', () => {
            const routingConfig = { enabled: true, tiers: {}, rules: [] };
            const mappingConfig = {
                enabled: true,
                models: {
                    'claude-opus-4-6': 'glm-4.7',
                    'claude-sonnet-4-20250514': 'glm-4.5',
                    'claude-haiku-4-5-20251001': 'glm-4.5-air'
                }
            };

            // First migration
            const first = performStartupMigration(routingConfig, mappingConfig);
            expect(first.migrated).toBe(true);
            expect(first.config.version).toBe('2.0');

            // Second migration with result of first
            const second = performStartupMigration(first.config, mappingConfig);
            expect(second.migrated).toBe(false);
            expect(second.config).toBe(first.config); // Same reference
        });

        test('double migration produces identical rules', () => {
            const routingConfig = { enabled: true, tiers: {}, rules: [] };
            const mappingConfig = {
                enabled: true,
                models: {
                    'claude-opus-4-6': 'glm-4.7',
                    'claude-sonnet-4-20250514': 'glm-4.5'
                }
            };

            const first = performStartupMigration(routingConfig, mappingConfig);
            const second = performStartupMigration(first.config, mappingConfig);

            // second.config should be the same as first.config (no mutation)
            expect(second.config.rules).toEqual(first.config.rules);
            expect(second.config.version).toBe(first.config.version);
        });

        test('migrateModelMappingToRouting is deterministic across calls', () => {
            const mapping = {
                enabled: true,
                models: {
                    'claude-opus-4-6': 'glm-4.7',
                    'claude-sonnet-4-20250514': 'glm-4.5',
                    'claude-haiku-4-5-20251001': 'glm-4.5-air'
                }
            };

            const result1 = migrateModelMappingToRouting(mapping);
            const result2 = migrateModelMappingToRouting(mapping);

            expect(result1.rules).toEqual(result2.rules);
            expect(result1.tiers).toEqual(result2.tiers);
            expect(result1.catchAll).toEqual(result2.catchAll);
        });

        test('performStartupMigration skips when version is already 2.0', () => {
            const routingConfig = {
                version: '2.0',
                enabled: true,
                tiers: {},
                rules: [
                    { match: { model: 'claude-opus-*' }, tier: 'heavy', comment: 'Migrated from model-mapping' },
                    { match: { model: '*' }, tier: 'medium' }
                ]
            };
            const mappingConfig = {
                enabled: true,
                models: { 'claude-opus-4-6': 'glm-4.7' }
            };

            const result = performStartupMigration(routingConfig, mappingConfig);

            expect(result.migrated).toBe(false);
            // Rules should be untouched
            expect(result.config.rules).toHaveLength(2);
        });
    });
});
