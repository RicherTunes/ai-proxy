'use strict';

const { migrateModelMappingToRouting, inferTier, migrateKeyOverrides, performStartupMigration } = require('../lib/config-migrator');

describe('Config Migrator', () => {
    describe('migrateModelMappingToRouting()', () => {
        const SAMPLE_MAPPING = {
            enabled: true,
            models: {
                'claude-opus-4-6': 'glm-4.7',
                'claude-sonnet-4-20250514': 'glm-4.5',
                'claude-haiku-4-5-20251001': 'glm-4.5-air'
            },
            defaultModel: null,
            logTransformations: true
        };

        test('returns object with rules, tiers, and catchAll', () => {
            const result = migrateModelMappingToRouting(SAMPLE_MAPPING);
            expect(result).toHaveProperty('rules');
            expect(result).toHaveProperty('tiers');
            expect(result).toHaveProperty('catchAll');
            expect(Array.isArray(result.rules)).toBe(true);
        });

        test('maps opus models to heavy tier rule', () => {
            const result = migrateModelMappingToRouting(SAMPLE_MAPPING);
            const heavyRule = result.rules.find(r => r.tier === 'heavy');
            expect(heavyRule).toBeDefined();
            expect(heavyRule.match.model).toMatch(/opus/);
        });

        test('maps sonnet models to medium tier rule', () => {
            const result = migrateModelMappingToRouting(SAMPLE_MAPPING);
            const mediumRule = result.rules.find(r => r.tier === 'medium');
            expect(mediumRule).toBeDefined();
            expect(mediumRule.match.model).toMatch(/sonnet/);
        });

        test('maps haiku models to light tier rule', () => {
            const result = migrateModelMappingToRouting(SAMPLE_MAPPING);
            const lightRule = result.rules.find(r => r.tier === 'light');
            expect(lightRule).toBeDefined();
            expect(lightRule.match.model).toMatch(/haiku/);
        });

        test('generates wildcard patterns from concrete model names', () => {
            const result = migrateModelMappingToRouting(SAMPLE_MAPPING);
            const opusRule = result.rules.find(r => r.tier === 'heavy');
            expect(opusRule.match.model).toBe('claude-opus-*');
        });
    });

    describe('inferTier()', () => {
        test('unknown model names default to medium', () => {
            expect(inferTier('custom-model', 'some-target')).toBe('medium');
        });

        test('is case-insensitive', () => {
            expect(inferTier('Claude-OPUS-4', 'glm-4.7')).toBe('heavy');
            expect(inferTier('Claude-SONNET-4', 'glm-4.5')).toBe('medium');
            expect(inferTier('Claude-HAIKU-4', 'glm-4.5-air')).toBe('light');
        });

        test('handles claude-3-5-sonnet versioned names', () => {
            expect(inferTier('claude-3-5-sonnet-20241022', 'glm-4.5')).toBe('medium');
        });

        test('handles claude-3-opus versioned names', () => {
            expect(inferTier('claude-3-opus-20240229', 'glm-4.7')).toBe('heavy');
        });

        test('handles claude-3-5-haiku versioned names', () => {
            expect(inferTier('claude-3-5-haiku-20241022', 'glm-4.5-air')).toBe('light');
        });

        test('infers from target model when source is ambiguous', () => {
            expect(inferTier('my-custom-model', 'glm-4.7')).toBe('heavy');
            expect(inferTier('my-custom-model', 'glm-4.5')).toBe('medium');
            expect(inferTier('my-custom-model', 'glm-4.5-air')).toBe('light');
        });
    });

    describe('catch-all and deduplication', () => {
        const SAMPLE_MAPPING = {
            enabled: true,
            models: {
                'claude-opus-4-6': 'glm-4.7',
                'claude-sonnet-4-20250514': 'glm-4.5',
                'claude-haiku-4-5-20251001': 'glm-4.5-air'
            }
        };

        test('always includes catch-all rule', () => {
            const result = migrateModelMappingToRouting(SAMPLE_MAPPING);
            expect(result.catchAll).toEqual({ match: { model: '*' }, tier: 'medium' });
        });

        test('catch-all is present even for empty models', () => {
            const result = migrateModelMappingToRouting({ enabled: true, models: {} });
            expect(result.catchAll).toEqual({ match: { model: '*' }, tier: 'medium' });
        });

        test('deduplicates rules by match pattern', () => {
            const mapping = {
                enabled: true,
                models: {
                    'claude-opus-4-6': 'glm-4.7',
                    'claude-opus-4-5-20251101': 'glm-4.7',
                    'claude-3-opus-20240229': 'glm-4.7'
                }
            };
            const result = migrateModelMappingToRouting(mapping);
            const heavyRules = result.rules.filter(r => r.tier === 'heavy');
            expect(heavyRules).toHaveLength(1);
            expect(heavyRules[0].match.model).toBe('claude-opus-*');
        });

        test('full DEFAULT_CONFIG mapping produces 3 unique wildcard rules', () => {
            const fullMapping = {
                enabled: true,
                models: {
                    'claude-opus-4-6': 'glm-4.7',
                    'claude-opus-4-5-20251101': 'glm-4.7',
                    'claude-opus-4-20250514': 'glm-4.7',
                    'claude-sonnet-4-5-20250929': 'glm-4.5',
                    'claude-sonnet-4-20250514': 'glm-4.5',
                    'claude-haiku-4-5-20251001': 'glm-4.5-air',
                    'claude-3-5-haiku-20241022': 'glm-4.5-air',
                    'claude-3-5-sonnet-20241022': 'glm-4.5',
                    'claude-3-opus-20240229': 'glm-4.7',
                    'claude-3-sonnet-20240229': 'glm-4.5',
                    'claude-3-haiku-20240307': 'glm-4.5-air'
                }
            };
            const result = migrateModelMappingToRouting(fullMapping);
            expect(result.rules).toHaveLength(3);
            const tiers = result.rules.map(r => r.tier).sort();
            expect(tiers).toEqual(['heavy', 'light', 'medium']);
        });
    });

    describe('target model extraction', () => {
        test('extracts target models per tier', () => {
            const mapping = {
                enabled: true,
                models: {
                    'claude-opus-4-6': 'glm-4.7',
                    'claude-sonnet-4-20250514': 'glm-4.5',
                    'claude-haiku-4-5-20251001': 'glm-4.5-air'
                }
            };
            const result = migrateModelMappingToRouting(mapping);
            expect(result.tiers).toHaveProperty('heavy');
            expect(result.tiers).toHaveProperty('medium');
            expect(result.tiers).toHaveProperty('light');
        });

        test('heavy tier targets include glm-4.7', () => {
            const mapping = {
                enabled: true,
                models: {
                    'claude-opus-4-6': 'glm-4.7',
                    'claude-opus-4-5-20251101': 'glm-4.7',
                    'claude-3-opus-20240229': 'glm-4.7'
                }
            };
            const result = migrateModelMappingToRouting(mapping);
            expect(result.tiers.heavy.targetModels).toContain('glm-4.7');
        });

        test('heavy tier deduplicates target models', () => {
            const mapping = {
                enabled: true,
                models: {
                    'claude-opus-4-6': 'glm-4.7',
                    'claude-opus-4-5-20251101': 'glm-4.7',
                    'claude-3-opus-20240229': 'glm-4.7'
                }
            };
            const result = migrateModelMappingToRouting(mapping);
            expect(result.tiers.heavy.targetModels).toHaveLength(1);
            expect(result.tiers.heavy.targetModels).toEqual(['glm-4.7']);
        });

        test('medium tier targets include glm-4.5', () => {
            const mapping = {
                enabled: true,
                models: {
                    'claude-sonnet-4-20250514': 'glm-4.5',
                    'claude-3-sonnet-20240229': 'glm-4.5'
                }
            };
            const result = migrateModelMappingToRouting(mapping);
            expect(result.tiers.medium.targetModels).toContain('glm-4.5');
            expect(result.tiers.medium.targetModels).toHaveLength(1);
        });

        test('light tier targets include glm-4.5-air', () => {
            const mapping = {
                enabled: true,
                models: {
                    'claude-haiku-4-5-20251001': 'glm-4.5-air',
                    'claude-3-haiku-20240307': 'glm-4.5-air'
                }
            };
            const result = migrateModelMappingToRouting(mapping);
            expect(result.tiers.light.targetModels).toContain('glm-4.5-air');
            expect(result.tiers.light.targetModels).toHaveLength(1);
        });
    });

    describe('migrateKeyOverrides()', () => {
        test('converts single key override to routing override', () => {
            const keyOverrides = new Map();
            keyOverrides.set(0, { 'claude-opus-4': 'glm-4.7' });

            const apiKeys = [{ key: 'key-abc-0' }, { key: 'key-def-1' }];
            const result = migrateKeyOverrides(keyOverrides, apiKeys);

            expect(result.overrides).toBeDefined();
            expect(result.overrides.length).toBe(1);
            expect(result.overrides[0].keyIndex).toBe(0);
            expect(result.overrides[0].targetModel).toBe('glm-4.7');
        });

        test('converts multiple key overrides', () => {
            const keyOverrides = new Map();
            keyOverrides.set(0, { 'claude-opus-4': 'glm-4.7' });
            keyOverrides.set(1, { 'claude-sonnet-4': 'glm-4.5' });

            const apiKeys = [{ key: 'key-abc-0' }, { key: 'key-def-1' }];
            const result = migrateKeyOverrides(keyOverrides, apiKeys);

            expect(result.overrides).toHaveLength(2);
            expect(result.overrides[0].keyIndex).toBe(0);
            expect(result.overrides[0].targetModel).toBe('glm-4.7');
            expect(result.overrides[1].keyIndex).toBe(1);
            expect(result.overrides[1].targetModel).toBe('glm-4.5');
        });

        test('picks first target for multi-model key override', () => {
            const keyOverrides = new Map();
            keyOverrides.set(0, {
                'claude-opus-4': 'glm-4.7',
                'claude-sonnet-4': 'glm-4.5'
            });

            const apiKeys = [{ key: 'key-abc-0' }];
            const result = migrateKeyOverrides(keyOverrides, apiKeys);

            expect(result.overrides).toHaveLength(1);
            expect(result.overrides[0].targetModel).toBe('glm-4.7');
        });

        test('returns warnings for lossy multi-model conversions', () => {
            const keyOverrides = new Map();
            keyOverrides.set(0, {
                'claude-opus-4': 'glm-4.7',
                'claude-sonnet-4': 'glm-4.5'
            });

            const apiKeys = [{ key: 'key-abc-0' }];
            const result = migrateKeyOverrides(keyOverrides, apiKeys);

            expect(result.warnings).toHaveLength(1);
            expect(result.warnings[0]).toContain('multiple');
        });

        test('returns empty for no overrides', () => {
            const result = migrateKeyOverrides(new Map(), []);
            expect(result.overrides).toEqual([]);
            expect(result.warnings).toEqual([]);
        });

        test('returns empty for null overrides', () => {
            const result = migrateKeyOverrides(null, []);
            expect(result.overrides).toEqual([]);
            expect(result.warnings).toEqual([]);
        });

        test('skips entries with empty model map', () => {
            const keyOverrides = new Map();
            keyOverrides.set(0, {});

            const apiKeys = [{ key: 'key-abc-0' }];
            const result = migrateKeyOverrides(keyOverrides, apiKeys);

            expect(result.overrides).toEqual([]);
            expect(result.warnings).toEqual([]);
        });
    });

    describe('performStartupMigration()', () => {
        test('merges mapping rules into routing config when version !== 2.0', () => {
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
            const mockLogger = { info: jest.fn(), warn: jest.fn() };

            const result = performStartupMigration(routingConfig, mappingConfig, mockLogger);

            expect(result.migrated).toBe(true);
            expect(result.config.rules.length).toBeGreaterThan(0);
            expect(mockLogger.info).toHaveBeenCalled();
        });

        test('adds catch-all rule to migrated config', () => {
            const routingConfig = { enabled: true, tiers: {}, rules: [] };
            const mappingConfig = {
                enabled: true,
                models: { 'claude-opus-4-6': 'glm-4.7' }
            };
            const mockLogger = { info: jest.fn(), warn: jest.fn() };

            const result = performStartupMigration(routingConfig, mappingConfig, mockLogger);
            const catchAll = result.config.rules.find(r => r.match && r.match.model === '*');
            expect(catchAll).toBeDefined();
            expect(catchAll.tier).toBe('medium');
        });

        test('sets version to 2.0 after migration', () => {
            const routingConfig = { enabled: true, tiers: {}, rules: [] };
            const mappingConfig = { enabled: true, models: { 'claude-opus-4': 'glm-4.7' } };
            const mockLogger = { info: jest.fn(), warn: jest.fn() };

            const result = performStartupMigration(routingConfig, mappingConfig, mockLogger);
            expect(result.config.version).toBe('2.0');
        });

        test('preserves existing routing config fields', () => {
            const routingConfig = {
                enabled: true,
                defaultModel: 'glm-4.5',
                logDecisions: true,
                tiers: { heavy: { targetModel: 'glm-4.7' } },
                rules: []
            };
            const mappingConfig = { enabled: true, models: { 'claude-opus-4': 'glm-4.7' } };
            const mockLogger = { info: jest.fn(), warn: jest.fn() };

            const result = performStartupMigration(routingConfig, mappingConfig, mockLogger);
            expect(result.config.defaultModel).toBe('glm-4.5');
            expect(result.config.logDecisions).toBe(true);
        });

        test('skips migration when routing already has explicit rules', () => {
            const existingRule = { match: { model: 'custom-model' }, tier: 'heavy' };
            const routingConfig = {
                enabled: true,
                tiers: {},
                rules: [existingRule]
            };
            const mappingConfig = { enabled: true, models: { 'claude-opus-4': 'glm-4.7' } };
            const mockLogger = { info: jest.fn(), warn: jest.fn() };

            const result = performStartupMigration(routingConfig, mappingConfig, mockLogger);
            // Should skip: existing rules mean user-configured routing takes precedence
            expect(result.migrated).toBe(false);
            expect(result.config.rules).toHaveLength(1);
            expect(result.config.rules[0]).toEqual(existingRule);
        });

        test('logs info message with rule count', () => {
            const routingConfig = { enabled: true, tiers: {}, rules: [] };
            const mappingConfig = {
                enabled: true,
                models: {
                    'claude-opus-4-6': 'glm-4.7',
                    'claude-sonnet-4': 'glm-4.5'
                }
            };
            const mockLogger = { info: jest.fn(), warn: jest.fn() };

            performStartupMigration(routingConfig, mappingConfig, mockLogger);
            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('[Migration]')
            );
        });
    });

    describe('performStartupMigration() skip conditions', () => {
        test('skips when modelMapping.enabled is false', () => {
            const routingConfig = { enabled: true, tiers: {}, rules: [] };
            const mappingConfig = { enabled: false, models: { 'claude-opus-4': 'glm-4.7' } };
            const mockLogger = { info: jest.fn(), warn: jest.fn() };

            const result = performStartupMigration(routingConfig, mappingConfig, mockLogger);
            expect(result.migrated).toBe(false);
            expect(result.config).toBe(routingConfig);
        });

        test('skips when modelRouting.version is 2.0', () => {
            const routingConfig = { version: '2.0', enabled: true, tiers: {}, rules: [] };
            const mappingConfig = { enabled: true, models: { 'claude-opus-4': 'glm-4.7' } };
            const mockLogger = { info: jest.fn(), warn: jest.fn() };

            const result = performStartupMigration(routingConfig, mappingConfig, mockLogger);
            expect(result.migrated).toBe(false);
            expect(result.config).toBe(routingConfig);
        });

        test('skips when mappingConfig is null', () => {
            const routingConfig = { enabled: true, tiers: {}, rules: [] };
            const mockLogger = { info: jest.fn(), warn: jest.fn() };

            const result = performStartupMigration(routingConfig, null, mockLogger);
            expect(result.migrated).toBe(false);
            expect(result.config).toBe(routingConfig);
        });

        test('skips when mappingConfig is undefined', () => {
            const routingConfig = { enabled: true, tiers: {}, rules: [] };
            const mockLogger = { info: jest.fn(), warn: jest.fn() };

            const result = performStartupMigration(routingConfig, undefined, mockLogger);
            expect(result.migrated).toBe(false);
            expect(result.config).toBe(routingConfig);
        });

        test('skips when mappingConfig.models is empty object', () => {
            const routingConfig = { enabled: true, tiers: {}, rules: [] };
            const mappingConfig = { enabled: true, models: {} };
            const mockLogger = { info: jest.fn(), warn: jest.fn() };

            const result = performStartupMigration(routingConfig, mappingConfig, mockLogger);
            expect(result.migrated).toBe(false);
        });

        test('skips when mappingConfig.models is missing', () => {
            const routingConfig = { enabled: true, tiers: {}, rules: [] };
            const mappingConfig = { enabled: true };
            const mockLogger = { info: jest.fn(), warn: jest.fn() };

            const result = performStartupMigration(routingConfig, mappingConfig, mockLogger);
            expect(result.migrated).toBe(false);
        });

        test('skips when routing already has rules', () => {
            const routingConfig = {
                enabled: true,
                tiers: {},
                rules: [{ match: { model: 'claude-3-opus-*' }, tier: 'heavy' }]
            };
            const mappingConfig = { enabled: true, models: { 'claude-opus-4': 'glm-4.7' } };
            const mockLogger = { info: jest.fn(), warn: jest.fn() };

            const result = performStartupMigration(routingConfig, mappingConfig, mockLogger);
            expect(result.migrated).toBe(false);
            expect(result.config.rules).toHaveLength(1);
        });

        test('does not call logger when skipping', () => {
            const routingConfig = { version: '2.0', enabled: true, tiers: {}, rules: [] };
            const mappingConfig = { enabled: true, models: { 'claude-opus-4': 'glm-4.7' } };
            const mockLogger = { info: jest.fn(), warn: jest.fn() };

            performStartupMigration(routingConfig, mappingConfig, mockLogger);
            expect(mockLogger.info).not.toHaveBeenCalled();
        });

        test('works when logger is null', () => {
            const routingConfig = { enabled: true, tiers: {}, rules: [] };
            const mappingConfig = { enabled: true, models: { 'claude-opus-4': 'glm-4.7' } };

            // Should not throw
            const result = performStartupMigration(routingConfig, mappingConfig, null);
            expect(result.migrated).toBe(true);
        });
    });

    describe('edge cases', () => {
        test('returns empty rules for null config', () => {
            const result = migrateModelMappingToRouting(null);
            expect(result.rules).toEqual([]);
            expect(result.tiers).toEqual({});
            expect(result.catchAll).toEqual({ match: { model: '*' }, tier: 'medium' });
        });

        test('returns empty rules for undefined config', () => {
            const result = migrateModelMappingToRouting(undefined);
            expect(result.rules).toEqual([]);
            expect(result.tiers).toEqual({});
            expect(result.catchAll).toEqual({ match: { model: '*' }, tier: 'medium' });
        });

        test('returns empty rules for config without models', () => {
            const result = migrateModelMappingToRouting({});
            expect(result.rules).toEqual([]);
            expect(result.tiers).toEqual({});
            expect(result.catchAll).toEqual({ match: { model: '*' }, tier: 'medium' });
        });

        test('returns empty rules for config with empty models', () => {
            const result = migrateModelMappingToRouting({ enabled: true, models: {} });
            expect(result.rules).toEqual([]);
            expect(result.tiers).toEqual({});
            expect(result.catchAll).toEqual({ match: { model: '*' }, tier: 'medium' });
        });

        test('still migrates when enabled is false (migration is unconditional)', () => {
            const mapping = {
                enabled: false,
                models: {
                    'claude-opus-4-6': 'glm-4.7',
                    'claude-sonnet-4-20250514': 'glm-4.5'
                }
            };
            const result = migrateModelMappingToRouting(mapping);
            expect(result.rules).toHaveLength(2);
            expect(result.tiers).toHaveProperty('heavy');
            expect(result.tiers).toHaveProperty('medium');
        });

        test('handles defaultModel by preserving it in output', () => {
            const mapping = {
                enabled: true,
                models: {
                    'claude-opus-4-6': 'glm-4.7'
                },
                defaultModel: 'glm-4.5'
            };
            const result = migrateModelMappingToRouting(mapping);
            // Migration should still work regardless of defaultModel
            expect(result.rules).toHaveLength(1);
            expect(result.catchAll).toEqual({ match: { model: '*' }, tier: 'medium' });
        });
    });
});
