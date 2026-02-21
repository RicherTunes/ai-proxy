/**
 * Model Router Normalization Contract Tests
 *
 * Contract tests for NORM-05: normalization correctness.
 * These tests verify that the normalizer correctly transforms v1 config to v2 format.
 */

const {
    normalizeModelRoutingConfig,
    _isV1Format,
    _isV2Format,
    _isMixedFormat,
    VALID_TIERS,
    VALID_STRATEGIES,
    V1_FIELDS
} = require('../lib/model-router-normalizer');

describe('Model Router Normalization Contract Tests (NORM-05)', () => {

    // -----------------------------------------------------------------
    // Helper functions for format detection
    // -----------------------------------------------------------------

    describe('_isV1Format', () => {
        test('detects v1 format by presence of targetModel', () => {
            expect(_isV1Format({ targetModel: 'glm-4-flash' })).toBe(true);
        });

        test('returns false when targetModel is missing', () => {
            expect(_isV1Format({ models: ['glm-4-flash'] })).toBe(false);
        });

        test('returns false for null/undefined input', () => {
            expect(_isV1Format(null)).toBe(false);
            expect(_isV1Format(undefined)).toBe(false);
        });

        test('returns false for non-object input', () => {
            expect(_isV1Format('string')).toBe(false);
            expect(_isV1Format(123)).toBe(false);
        });
    });

    describe('_isV2Format', () => {
        test('detects v2 format by presence of models array', () => {
            expect(_isV2Format({ models: ['glm-4-flash', 'glm-4-air'] })).toBe(true);
        });

        test('returns false when models is not array', () => {
            expect(_isV2Format({ models: 'not-array' })).toBe(false);
            expect(_isV2Format({ targetModel: 'glm-4-flash' })).toBe(false);
        });

        test('returns false for empty models array', () => {
            expect(_isV2Format({ models: [] })).toBe(false);
        });

        test('returns false for null/undefined input', () => {
            expect(_isV2Format(null)).toBe(false);
            expect(_isV2Format(undefined)).toBe(false);
        });
    });

    describe('_isMixedFormat', () => {
        test('detects both v1 and v2 fields present', () => {
            const mixed = {
                targetModel: 'glm-4-flash',
                models: ['glm-4-air']
            };
            expect(_isMixedFormat(mixed)).toBe(true);
        });

        test('returns false when only v1 fields present', () => {
            const v1 = { targetModel: 'glm-4-flash' };
            expect(_isMixedFormat(v1)).toBe(false);
        });

        test('returns false when only v2 fields present', () => {
            const v2 = { models: ['glm-4-flash'] };
            expect(_isMixedFormat(v2)).toBe(false);
        });
    });

    // -----------------------------------------------------------------
    // Contract tests: pure v1 input produces pure v2 output
    // -----------------------------------------------------------------

    describe('Contract: Pure v1 -> v2', () => {
        test('pure v1 input produces pure v2 output', () => {
            const v1Config = {
                enabled: true,
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash',
                        fallbackModels: ['glm-4-air']
                    },
                    medium: {
                        targetModel: 'glm-4-air',
                        fallbackModels: ['glm-4-flash', 'glm-4-plus']
                    },
                    heavy: {
                        targetModel: 'glm-5',
                        fallbackModels: ['glm-4.7', 'glm-4.6'],
                        failoverModel: 'glm-4-plus'
                    }
                }
            };

            const result = normalizeModelRoutingConfig(v1Config);

            // Verify v2 output structure
            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-flash', 'glm-4-air']);
            expect(result.normalizedConfig.tiers.medium.models).toEqual(['glm-4-air', 'glm-4-flash', 'glm-4-plus']);
            expect(result.normalizedConfig.tiers.heavy.models).toEqual(['glm-5', 'glm-4.7', 'glm-4.6', 'glm-4-plus']);
            expect(result.normalizedConfig.version).toBe('2.0');
        });

        test('fallbackModels array correctly expands to models[]', () => {
            const config = {
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash',
                        fallbackModels: ['glm-4-air', 'glm-4-plus', 'glm-4.7']
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.tiers.light.models).toEqual([
                'glm-4-flash',
                'glm-4-air',
                'glm-4-plus',
                'glm-4.7'
            ]);
        });

        test('failoverModel correctly appends to models[]', () => {
            const config = {
                tiers: {
                    heavy: {
                        targetModel: 'glm-5',
                        fallbackModels: ['glm-4.7'],
                        failoverModel: 'glm-4.6'
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.tiers.heavy.models).toEqual([
                'glm-5',
                'glm-4.7',
                'glm-4.6'
            ]);
        });

        test('tier with only targetModel (no fallback) normalizes', () => {
            const config = {
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash'
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-flash']);
        });

        test('tier with only fallbackModels (no target) normalizes', () => {
            const config = {
                tiers: {
                    light: {
                        fallbackModels: ['glm-4-air', 'glm-4-plus']
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-air', 'glm-4-plus']);
        });
    });

    // -----------------------------------------------------------------
    // Contract tests: pure v2 input passes through unchanged
    // -----------------------------------------------------------------

    describe('Contract: Pure v2 -> v2 (pass-through)', () => {
        test('pure v2 input passes through unchanged', () => {
            const v2Config = {
                version: '2.0',
                enabled: true,
                tiers: {
                    light: {
                        models: ['glm-4-flash', 'glm-4-air'],
                        strategy: 'throughput'
                    },
                    medium: {
                        models: ['glm-4-air', 'glm-4-flash'],
                        strategy: 'balanced'
                    },
                    heavy: {
                        models: ['glm-5', 'glm-4.7', 'glm-4.6'],
                        strategy: 'quality'
                    }
                }
            };

            const result = normalizeModelRoutingConfig(v2Config);

            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-flash', 'glm-4-air']);
            expect(result.normalizedConfig.tiers.medium.models).toEqual(['glm-4-air', 'glm-4-flash']);
            expect(result.normalizedConfig.tiers.heavy.models).toEqual(['glm-5', 'glm-4.7', 'glm-4.6']);
            expect(result.normalizedConfig.tiers.light.strategy).toBe('throughput');
            expect(result.normalizedConfig.tiers.medium.strategy).toBe('balanced');
            expect(result.normalizedConfig.tiers.heavy.strategy).toBe('quality');
            expect(result.normalizedConfig.version).toBe('2.0');
        });

        test('migrated flag is false for pure v2 input', () => {
            const v2Config = {
                version: '2.0',
                tiers: {
                    light: {
                        models: ['glm-4-flash']
                    }
                }
            };

            const result = normalizeModelRoutingConfig(v2Config);

            expect(result.migrated).toBe(false);
        });

        test('tier with models[] already present (no-op)', () => {
            const config = {
                tiers: {
                    light: {
                        models: ['glm-4-flash', 'glm-4-air'],
                        strategy: 'quality'
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-flash', 'glm-4-air']);
            expect(result.migrated).toBe(false);
        });
    });

    // -----------------------------------------------------------------
    // Contract tests: mixed v1/v2 input
    // -----------------------------------------------------------------

    describe('Contract: Mixed v1/v2 input', () => {
        test('mixed v1/v2 input (targetModel + models) emits warning', () => {
            const mixedConfig = {
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash',
                        models: ['glm-4-air']
                    }
                }
            };

            const result = normalizeModelRoutingConfig(mixedConfig);

            expect(result.warnings.length).toBeGreaterThan(0);
            expect(result.warnings.some(w =>
                w.includes('both v1 fields') && w.includes('v2 field')
            )).toBe(true);
        });

        test('mixed input uses v2 format (takes precedence)', () => {
            const mixedConfig = {
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash',
                        models: ['glm-4-air', 'glm-4-plus']
                    }
                }
            };

            const result = normalizeModelRoutingConfig(mixedConfig);

            // Should use v2 models[] array, not construct from v1
            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-air', 'glm-4-plus']);
            expect(result.normalizedConfig.tiers.light.models).not.toContain('glm-4-flash');
        });
    });

    // -----------------------------------------------------------------
    // Contract tests: v1 fields NEVER appear in normalized output (NORM-03)
    // -----------------------------------------------------------------

    describe('Contract: V1 fields NEVER in normalized output (NORM-03)', () => {
        test('targetModel NEVER appears in normalized output', () => {
            const config = {
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash',
                        fallbackModels: ['glm-4-air']
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect('targetModel' in result.normalizedConfig.tiers.light).toBe(false);
        });

        test('fallbackModels NEVER appears in normalized output', () => {
            const config = {
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash',
                        fallbackModels: ['glm-4-air']
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect('fallbackModels' in result.normalizedConfig.tiers.light).toBe(false);
        });

        test('failoverModel NEVER appears in normalized output', () => {
            const config = {
                tiers: {
                    heavy: {
                        targetModel: 'glm-5',
                        failoverModel: 'glm-4.6'
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect('failoverModel' in result.normalizedConfig.tiers.heavy).toBe(false);
        });

        test('all v1 fields removed from complex config', () => {
            const config = {
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash',
                        fallbackModels: ['glm-4-air'],
                        failoverModel: 'glm-4-plus'
                    },
                    medium: {
                        targetModel: 'glm-4-air',
                        fallbackModels: ['glm-4-flash']
                    },
                    heavy: {
                        targetModel: 'glm-5',
                        fallbackModels: ['glm-4.7', 'glm-4.6'],
                        failoverModel: 'glm-4-plus'
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            // Check all tiers for v1 fields
            for (const tier of VALID_TIERS) {
                const tierConfig = result.normalizedConfig.tiers[tier];
                expect('targetModel' in tierConfig).toBe(false);
                expect('fallbackModels' in tierConfig).toBe(false);
                expect('failoverModel' in tierConfig).toBe(false);
            }
        });

        test('v1 fields removed even when v2 format had them', () => {
            // Someone might have both models[] AND v1 fields in v2 (malformed)
            const malformedV2 = {
                version: '2.0',
                tiers: {
                    light: {
                        models: ['glm-4-flash'],
                        targetModel: 'glm-4-flash',  // Should be removed
                        fallbackModels: ['glm-4-air'] // Should be removed
                    }
                }
            };

            const result = normalizeModelRoutingConfig(malformedV2);

            expect('targetModel' in result.normalizedConfig.tiers.light).toBe(false);
            expect('fallbackModels' in result.normalizedConfig.tiers.light).toBe(false);
            // models[] should still be there
            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-flash']);
        });
    });

    // -----------------------------------------------------------------
    // Contract tests: migrated flag
    // -----------------------------------------------------------------

    describe('Contract: Migrated flag correctness', () => {
        test('migrated flag is true when v1 detected', () => {
            const v1Config = {
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash'
                    }
                }
            };

            const result = normalizeModelRoutingConfig(v1Config);

            expect(result.migrated).toBe(true);
        });

        test('migrated flag is false for pure v2', () => {
            const v2Config = {
                version: '2.0',
                tiers: {
                    light: {
                        models: ['glm-4-flash']
                    }
                }
            };

            const result = normalizeModelRoutingConfig(v2Config);

            expect(result.migrated).toBe(false);
        });

        test('migrated flag is true when any tier migrated', () => {
            const config = {
                tiers: {
                    light: {
                        models: ['glm-4-flash'] // v2
                    },
                    heavy: {
                        targetModel: 'glm-5' // v1 - triggers migration
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.migrated).toBe(true);
        });

        test('migrated flag is false when all tiers v2', () => {
            const config = {
                version: '2.0',
                tiers: {
                    light: { models: ['glm-4-flash'] },
                    medium: { models: ['glm-4-air'] },
                    heavy: { models: ['glm-5'] }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.migrated).toBe(false);
        });
    });

    // -----------------------------------------------------------------
    // Contract tests: all three tiers normalize correctly
    // -----------------------------------------------------------------

    describe('Contract: All three tiers (light, medium, heavy)', () => {
        test('light tier normalizes correctly', () => {
            const config = {
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash',
                        fallbackModels: ['glm-4-air']
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.tiers.light).toBeDefined();
            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-flash', 'glm-4-air']);
        });

        test('medium tier normalizes correctly', () => {
            const config = {
                tiers: {
                    medium: {
                        targetModel: 'glm-4-air',
                        fallbackModels: ['glm-4-flash']
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.tiers.medium).toBeDefined();
            expect(result.normalizedConfig.tiers.medium.models).toEqual(['glm-4-air', 'glm-4-flash']);
        });

        test('heavy tier normalizes correctly', () => {
            const config = {
                tiers: {
                    heavy: {
                        targetModel: 'glm-5',
                        fallbackModels: ['glm-4.7'],
                        failoverModel: 'glm-4.6'
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.tiers.heavy).toBeDefined();
            expect(result.normalizedConfig.tiers.heavy.models).toEqual(['glm-5', 'glm-4.7', 'glm-4.6']);
        });

        test('all tiers normalize together correctly', () => {
            const config = {
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash',
                        fallbackModels: ['glm-4-air']
                    },
                    medium: {
                        targetModel: 'glm-4-air',
                        fallbackModels: ['glm-4-flash']
                    },
                    heavy: {
                        targetModel: 'glm-5',
                        fallbackModels: ['glm-4.7']
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-flash', 'glm-4-air']);
            expect(result.normalizedConfig.tiers.medium.models).toEqual(['glm-4-air', 'glm-4-flash']);
            expect(result.normalizedConfig.tiers.heavy.models).toEqual(['glm-5', 'glm-4.7']);
        });
    });

    // -----------------------------------------------------------------
    // Contract tests: strategy defaults
    // -----------------------------------------------------------------

    describe('Contract: Strategy defaults', () => {
        test('strategy defaults to balanced when missing', () => {
            const config = {
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash'
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.tiers.light.strategy).toBe('balanced');
        });

        test('v1 failover strategy maps to v2 balanced', () => {
            const config = {
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash',
                        strategy: 'failover'
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.tiers.light.strategy).toBe('balanced');
        });

        test('valid v2 strategies pass through', () => {
            const strategies = ['quality', 'throughput', 'balanced'];

            for (const strategy of strategies) {
                const config = {
                    tiers: {
                        light: {
                            models: ['glm-4-flash'],
                            strategy: strategy
                        }
                    }
                };

                const result = normalizeModelRoutingConfig(config);

                expect(result.normalizedConfig.tiers.light.strategy).toBe(strategy);
            }
        });

        test('invalid strategy defaults to balanced', () => {
            const config = {
                tiers: {
                    light: {
                        models: ['glm-4-flash'],
                        strategy: 'invalid-strategy'
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.tiers.light.strategy).toBe('balanced');
        });
    });

    // -----------------------------------------------------------------
    // Contract tests: complex v1 config
    // -----------------------------------------------------------------

    describe('Contract: Complex v1 config fully normalizes', () => {
        test('complex v1 config with all fields normalizes', () => {
            const complexV1 = {
                enabled: true,
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash',
                        fallbackModels: ['glm-4-air', 'glm-4-plus'],
                        label: 'Light Tier',
                        clientModelPolicy: 'always-route'
                    },
                    medium: {
                        targetModel: 'glm-4-air',
                        fallbackModels: ['glm-4-flash'],
                        strategy: 'pool'
                    },
                    heavy: {
                        targetModel: 'glm-5',
                        fallbackModels: ['glm-4.7', 'glm-4.6'],
                        failoverModel: 'glm-4-plus',
                        label: 'Heavy Workloads',
                        clientModelPolicy: 'route-if-supported'
                    }
                }
            };

            const result = normalizeModelRoutingConfig(complexV1);

            // Verify all tiers normalized
            expect(result.normalizedConfig.tiers.light.models).toEqual([
                'glm-4-flash', 'glm-4-air', 'glm-4-plus'
            ]);
            expect(result.normalizedConfig.tiers.light.label).toBe('Light Tier');
            expect(result.normalizedConfig.tiers.light.clientModelPolicy).toBe('always-route');

            expect(result.normalizedConfig.tiers.medium.models).toEqual([
                'glm-4-air', 'glm-4-flash'
            ]);
            expect(result.normalizedConfig.tiers.medium.strategy).toBe('pool');

            expect(result.normalizedConfig.tiers.heavy.models).toEqual([
                'glm-5', 'glm-4.7', 'glm-4.6', 'glm-4-plus'
            ]);
            expect(result.normalizedConfig.tiers.heavy.label).toBe('Heavy Workloads');
            expect(result.normalizedConfig.tiers.heavy.clientModelPolicy).toBe('route-if-supported');

            // Verify v1 fields removed
            expect('targetModel' in result.normalizedConfig.tiers.heavy).toBe(false);
            expect('fallbackModels' in result.normalizedConfig.tiers.heavy).toBe(false);
            expect('failoverModel' in result.normalizedConfig.tiers.heavy).toBe(false);

            expect(result.migrated).toBe(true);
        });
    });

    // -----------------------------------------------------------------
    // Module constants
    // -----------------------------------------------------------------

    describe('Module constants', () => {
        test('VALID_TIERS contains expected tier names', () => {
            expect(VALID_TIERS.has('light')).toBe(true);
            expect(VALID_TIERS.has('medium')).toBe(true);
            expect(VALID_TIERS.has('heavy')).toBe(true);
        });

        test('VALID_STRATEGIES contains expected strategies', () => {
            expect(VALID_STRATEGIES.has('quality')).toBe(true);
            expect(VALID_STRATEGIES.has('throughput')).toBe(true);
            expect(VALID_STRATEGIES.has('balanced')).toBe(true);
            expect(VALID_STRATEGIES.has('pool')).toBe(true);
        });

        test('V1_FIELDS contains legacy field names', () => {
            expect(V1_FIELDS.has('targetModel')).toBe(true);
            expect(V1_FIELDS.has('fallbackModels')).toBe(true);
            expect(V1_FIELDS.has('failoverModel')).toBe(true);
        });
    });

    // -----------------------------------------------------------------
    // Return value structure
    // -----------------------------------------------------------------

    describe('Return value structure', () => {
        test('returns object with normalizedConfig, migrated, warnings', () => {
            const config = { tiers: { light: { targetModel: 'glm-4-flash' } } };
            const result = normalizeModelRoutingConfig(config);

            expect(result).toHaveProperty('normalizedConfig');
            expect(result).toHaveProperty('migrated');
            expect(result).toHaveProperty('warnings');
            expect(typeof result.normalizedConfig).toBe('object');
            expect(typeof result.migrated).toBe('boolean');
            expect(Array.isArray(result.warnings)).toBe(true);
        });

        test('warnings is always an array', () => {
            const result = normalizeModelRoutingConfig({ tiers: {} });

            expect(Array.isArray(result.warnings)).toBe(true);
        });
    });

    // -----------------------------------------------------------------
    // Edge case tests
    // -----------------------------------------------------------------

    describe('Edge Cases', () => {
        test('empty tiers object handled gracefully', () => {
            const result = normalizeModelRoutingConfig({ tiers: {} });

            expect(result.normalizedConfig.tiers.light).toBeDefined();
            expect(result.normalizedConfig.tiers.medium).toBeDefined();
            expect(result.normalizedConfig.tiers.heavy).toBeDefined();
            expect(result.normalizedConfig.tiers.light.models).toEqual([]);
            expect(result.normalizedConfig.tiers.light.strategy).toBe('balanced');
        });

        test('tier with only targetModel (no fallback) normalizes', () => {
            const config = {
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash'
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-flash']);
            expect(result.migrated).toBe(true);
        });

        test('tier with only fallbackModels (no target) normalizes', () => {
            const config = {
                tiers: {
                    light: {
                        fallbackModels: ['glm-4-air', 'glm-4-plus']
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-air', 'glm-4-plus']);
            expect(result.migrated).toBe(true);
        });

        test('tier with models[] already present (no-op)', () => {
            const config = {
                tiers: {
                    light: {
                        models: ['glm-4-flash', 'glm-4-air'],
                        strategy: 'quality'
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-flash', 'glm-4-air']);
            expect(result.normalizedConfig.tiers.light.strategy).toBe('quality');
            expect(result.migrated).toBe(false);
        });

        test('tier with neither v1 nor v2 shapes returns empty models', () => {
            const config = {
                tiers: {
                    light: {
                        label: 'Light Tier',
                        clientModelPolicy: 'always-route'
                        // No targetModel, fallbackModels, failoverModel, or models[]
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.tiers.light.models).toEqual([]);
            expect(result.normalizedConfig.tiers.light.label).toBe('Light Tier');
            expect(result.normalizedConfig.tiers.light.clientModelPolicy).toBe('always-route');
        });

        test('multiple tiers with mixed shapes normalize correctly', () => {
            const config = {
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash',  // v1
                        fallbackModels: ['glm-4-air']
                    },
                    medium: {
                        models: ['glm-4-air', 'glm-4-flash']  // v2
                    },
                    heavy: {
                        targetModel: 'glm-5',  // v1
                        fallbackModels: ['glm-4.7'],
                        failoverModel: 'glm-4.6'
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-flash', 'glm-4-air']);
            expect(result.normalizedConfig.tiers.medium.models).toEqual(['glm-4-air', 'glm-4-flash']);
            expect(result.normalizedConfig.tiers.heavy.models).toEqual(['glm-5', 'glm-4.7', 'glm-4.6']);
            expect(result.migrated).toBe(true);
        });

        test('non-serializable config values handled gracefully', () => {
            // Create config with circular reference (non-serializable)
            const circular = { ref: null };
            circular.ref = circular;

            const config = {
                tiers: {
                    light: {
                        models: ['glm-4-flash'],
                        circular: circular  // Non-serializable
                    }
                }
            };

            // Should not crash
            const result = normalizeModelRoutingConfig(config);

            expect(result).toBeDefined();
            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-flash']);
        });

        test('null/undefined config handled gracefully', () => {
            const result1 = normalizeModelRoutingConfig(null);
            const result2 = normalizeModelRoutingConfig(undefined);

            expect(result1.normalizedConfig).toBeDefined();
            expect(result2.normalizedConfig).toBeDefined();
            expect(result1.warnings).toContain('Input config is null or invalid');
            expect(result2.warnings).toContain('Input config is null or invalid');
        });

        test('invalid tier config (non-object) skipped with warning', () => {
            const config = {
                tiers: {
                    light: 'not-an-object',
                    medium: null,
                    heavy: 123
                }
            };

            const result = normalizeModelRoutingConfig(config);

            // Should still create default tier objects
            expect(result.normalizedConfig.tiers.light).toBeDefined();
            expect(result.normalizedConfig.tiers.medium).toBeDefined();
            expect(result.normalizedConfig.tiers.heavy).toBeDefined();
            // Should have warnings about invalid tier configs
            expect(result.warnings.some(w => w.includes('invalid config'))).toBe(true);
        });

        test('empty models array handled correctly', () => {
            const config = {
                tiers: {
                    light: {
                        models: []
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.tiers.light.models).toEqual([]);
        });

        test('duplicate models in input are preserved (no deduplication)', () => {
            // Normalizer doesn't dedupe - that's up to the consumer
            const config = {
                tiers: {
                    light: {
                        models: ['glm-4-flash', 'glm-4-flash', 'glm-4-air']
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-flash', 'glm-4-flash', 'glm-4-air']);
        });

        test('partial v1 with missing fallbackModels array', () => {
            const config = {
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash',
                        fallbackModels: null  // explicitly null
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-flash']);
        });

        test('partial v1 with empty fallbackModels array', () => {
            const config = {
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash',
                        fallbackModels: []
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-flash']);
        });
    });

    // -----------------------------------------------------------------
    // Module export tests
    // -----------------------------------------------------------------

    describe('Module Exports', () => {
        test('module has normalizeModelRoutingConfig export', () => {
            const normalizer = require('../lib/model-router-normalizer');

            expect(normalizer.normalizeModelRoutingConfig).toBeDefined();
            expect(typeof normalizer.normalizeModelRoutingConfig).toBe('function');
        });

        test('function accepts (config, options) parameters', () => {
            const normalizer = require('../lib/model-router-normalizer');

            // Should not throw with just config
            expect(() => {
                normalizer.normalizeModelRoutingConfig({ tiers: {} });
            }).not.toThrow();

            // Should not throw with config and options
            expect(() => {
                normalizer.normalizeModelRoutingConfig({ tiers: {} }, { logger: console });
            }).not.toThrow();

            // Should not throw with null options
            expect(() => {
                normalizer.normalizeModelRoutingConfig({ tiers: {} }, null);
            }).not.toThrow();
        });

        test('can be imported by other modules', () => {
            // Test that require works (doesn't throw)
            const normalizer = require('../lib/model-router-normalizer');

            expect(normalizer).toHaveProperty('normalizeModelRoutingConfig');
            expect(normalizer).toHaveProperty('_isV1Format');
            expect(normalizer).toHaveProperty('_isV2Format');
            expect(normalizer).toHaveProperty('_isMixedFormat');
            expect(normalizer).toHaveProperty('_normalizeTier');
            expect(normalizer).toHaveProperty('VALID_TIERS');
            expect(normalizer).toHaveProperty('VALID_STRATEGIES');
            expect(normalizer).toHaveProperty('V1_FIELDS');
        });

        test('function returns expected structure', () => {
            const normalizer = require('../lib/model-router-normalizer');
            const result = normalizer.normalizeModelRoutingConfig({ tiers: {} });

            expect(result).toHaveProperty('normalizedConfig');
            expect(result).toHaveProperty('migrated');
            expect(result).toHaveProperty('warnings');
        });
    });
});
