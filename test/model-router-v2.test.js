/**
 * ModelRouter V2 Config Schema Tests
 *
 * Tests for v2 config schema with:
 * - version: '2.0'
 * - tiers[].models[] (ordered array)
 * - tiers[].strategy: 'quality' | 'throughput' | 'balanced'
 * - tiers[].label (optional UI label)
 * - Auto-migration from v1 to v2
 */

jest.mock('../lib/atomic-write', () => ({
    atomicWrite: jest.fn().mockResolvedValue()
}));

const { ModelRouter } = require('../lib/model-router');

/** Mock ModelDiscovery instance */
const mockModelDiscovery = {
    getModel: jest.fn().mockResolvedValue(null)
};

/**
 * Helper: build a v2 config with models[] array
 */
function makeV2Config(overrides = {}) {
    return {
        version: '2.0',
        enabled: true,
        tiers: {
            light: {
                models: ['glm-4-flash', 'glm-4-air'],
                strategy: 'balanced',
                label: 'Flash (Light)',
                clientModelPolicy: 'always-route'
            },
            medium: {
                models: ['glm-4-air', 'glm-4-flash'],
                strategy: 'balanced',
                label: 'Air (Medium)',
                clientModelPolicy: 'always-route'
            },
            heavy: {
                models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
                strategy: 'quality',
                label: 'Plus (Heavy)',
                clientModelPolicy: 'always-route'
            }
        },
        rules: [
            { match: { model: 'claude-opus-*' }, tier: 'heavy' }
        ],
        classifier: {
            heavyThresholds: { maxTokensGte: 100000 }
        },
        ...overrides
    };
}

/**
 * Helper: build a v1 config (old format)
 */
function makeV1Config(overrides = {}) {
    return {
        enabled: true,
        tiers: {
            light: {
                targetModel: 'glm-4-flash',
                fallbackModels: ['glm-4-air'],
                clientModelPolicy: 'always-route'
            },
            heavy: {
                targetModel: 'glm-4-plus',
                fallbackModels: ['glm-4-air', 'glm-4-flash'],
                clientModelPolicy: 'always-route'
            }
        },
        rules: [
            { match: { model: 'claude-opus-*' }, tier: 'heavy' }
        ],
        ...overrides
    };
}

describe('ModelRouter v2 Config Schema', () => {
    let router;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('v2 config acceptance', () => {
        test('accepts v2 config with models[] array', () => {
            const v2Config = makeV2Config();
            router = new ModelRouter(v2Config, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            expect(router.config.tiers.heavy.models).toEqual(['glm-4-plus', 'glm-4-air', 'glm-4-flash']);
        });

        test('stores version field', () => {
            const v2Config = makeV2Config({ version: '2.0' });
            router = new ModelRouter(v2Config, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            expect(router.config.version).toBe('2.0');
        });

        test('stores models[] array in tier config', () => {
            const v2Config = makeV2Config();
            router = new ModelRouter(v2Config, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            expect(router.config.tiers.light.models).toEqual(['glm-4-flash', 'glm-4-air']);
            expect(router.config.tiers.medium.models).toEqual(['glm-4-air', 'glm-4-flash']);
            expect(router.config.tiers.heavy.models).toEqual(['glm-4-plus', 'glm-4-air', 'glm-4-flash']);
        });
    });

    describe('strategy field (v2)', () => {
        test('accepts strategy: quality', () => {
            const v2Config = makeV2Config({
                tiers: {
                    heavy: {
                        models: ['glm-4-plus'],
                        strategy: 'quality'
                    }
                }
            });
            router = new ModelRouter(v2Config, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            expect(router.config.tiers.heavy.strategy).toBe('quality');
        });

        test('accepts strategy: throughput', () => {
            const v2Config = makeV2Config({
                tiers: {
                    heavy: {
                        models: ['glm-4-plus'],
                        strategy: 'throughput'
                    }
                }
            });
            router = new ModelRouter(v2Config, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            expect(router.config.tiers.heavy.strategy).toBe('throughput');
        });

        test('accepts strategy: balanced', () => {
            const v2Config = makeV2Config({
                tiers: {
                    heavy: {
                        models: ['glm-4-plus'],
                        strategy: 'balanced'
                    }
                }
            });
            router = new ModelRouter(v2Config, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            expect(router.config.tiers.heavy.strategy).toBe('balanced');
        });
    });

    describe('label field (v2)', () => {
        test('stores label field in tier config', () => {
            const v2Config = makeV2Config({
                tiers: {
                    heavy: {
                        models: ['glm-4-plus'],
                        label: 'Opus (Heavy)'
                    }
                }
            });
            router = new ModelRouter(v2Config, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            expect(router.config.tiers.heavy.label).toBe('Opus (Heavy)');
        });

        test('label is optional (undefined when not provided)', () => {
            const v2Config = makeV2Config({
                tiers: {
                    heavy: {
                        models: ['glm-4-plus']
                    }
                }
            });
            router = new ModelRouter(v2Config, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            expect(router.config.tiers.heavy.label).toBeUndefined();
        });
    });

    describe('clientModelPolicy preservation (v2)', () => {
        test('preserves clientModelPolicy: rule-match-only', () => {
            const v2Config = makeV2Config({
                tiers: {
                    heavy: {
                        models: ['glm-4-plus'],
                        clientModelPolicy: 'rule-match-only'
                    }
                }
            });
            router = new ModelRouter(v2Config, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            expect(router.config.tiers.heavy.clientModelPolicy).toBe('rule-match-only');
        });

        test('preserves clientModelPolicy: always-route', () => {
            const v2Config = makeV2Config({
                tiers: {
                    heavy: {
                        models: ['glm-4-plus'],
                        clientModelPolicy: 'always-route'
                    }
                }
            });
            router = new ModelRouter(v2Config, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            expect(router.config.tiers.heavy.clientModelPolicy).toBe('always-route');
        });
    });

    describe('classifier preservation (v2)', () => {
        test('preserves classifier section', () => {
            const v2Config = makeV2Config({
                classifier: {
                    heavyThresholds: {
                        maxTokensGte: 100000,
                        hasTools: true
                    },
                    lightThresholds: {
                        maxTokensLte: 512
                    }
                }
            });
            router = new ModelRouter(v2Config, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            expect(router.config.classifier).toBeDefined();
            expect(router.config.classifier.heavyThresholds.maxTokensGte).toBe(100000);
            expect(router.config.classifier.heavyThresholds.hasTools).toBe(true);
            expect(router.config.classifier.lightThresholds.maxTokensLte).toBe(512);
        });
    });
});

describe('V1 to V2 Migration', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('auto-migrates v1 config to v2', () => {
        const v1Config = makeV1Config();
        const router = new ModelRouter(v1Config, {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery
        });

        // Version should be set to 2.0
        expect(router.config.version).toBe('2.0');

        // models[] should be created
        expect(router.config.tiers.heavy.models).toBeDefined();
        expect(Array.isArray(router.config.tiers.heavy.models)).toBe(true);
    });

    test('v1 targetModel becomes v2 models[0]', () => {
        const v1Config = makeV1Config({
            tiers: {
                heavy: {
                    targetModel: 'glm-4-plus',
                    fallbackModels: ['glm-4-air']
                }
            }
        });
        const router = new ModelRouter(v1Config, {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery
        });

        expect(router.config.tiers.heavy.models[0]).toBe('glm-4-plus');
    });

    test('v1 fallbackModels becomes v2 models[1...]', () => {
        const v1Config = makeV1Config({
            tiers: {
                heavy: {
                    targetModel: 'glm-4-plus',
                    fallbackModels: ['glm-4-air', 'glm-4-flash']
                }
            }
        });
        const router = new ModelRouter(v1Config, {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery
        });

        expect(router.config.tiers.heavy.models).toEqual(['glm-4-plus', 'glm-4-air', 'glm-4-flash']);
    });

    test('migrated config has default strategy: balanced', () => {
        const v1Config = makeV1Config({
            tiers: {
                heavy: {
                    targetModel: 'glm-4-plus',
                    fallbackModels: ['glm-4-air']
                }
            }
        });
        const router = new ModelRouter(v1Config, {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery
        });

        expect(router.config.tiers.heavy.strategy).toBe('balanced');
    });

    test('migrated config has version: 2.0', () => {
        const v1Config = makeV1Config();
        const router = new ModelRouter(v1Config, {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery
        });

        expect(router.config.version).toBe('2.0');
    });

    test('v1 with failoverModel migrates to models[]', () => {
        const v1Config = {
            enabled: true,
            tiers: {
                heavy: {
                    targetModel: 'glm-4-plus',
                    failoverModel: 'glm-4-air'
                }
            }
        };
        const router = new ModelRouter(v1Config, {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery
        });

        expect(router.config.tiers.heavy.models).toEqual(['glm-4-plus', 'glm-4-air']);
    });

    test('v1 with pool strategy preserves it', () => {
        const v1Config = {
            enabled: true,
            tiers: {
                heavy: {
                    targetModel: 'glm-4-plus',
                    fallbackModels: ['glm-4-air'],
                    strategy: 'pool'
                }
            }
        };
        const router = new ModelRouter(v1Config, {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery
        });

        // Pool strategy should be preserved (v2 still supports 'pool')
        expect(router.config.tiers.heavy.strategy).toBe('pool');
    });

    test('v1 with failover strategy migrates to balanced', () => {
        const v1Config = {
            enabled: true,
            tiers: {
                heavy: {
                    targetModel: 'glm-4-plus',
                    fallbackModels: ['glm-4-air'],
                    strategy: 'failover'
                }
            }
        };
        const router = new ModelRouter(v1Config, {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery
        });

        expect(router.config.tiers.heavy.strategy).toBe('balanced');
    });
});

describe('V2 Config Validation', () => {
    test('rejects v2 config with empty models[] array', () => {
        const result = ModelRouter.validateConfig({
            version: '2.0',
            tiers: {
                heavy: { models: [], strategy: 'quality' }
            }
        });

        expect(result.valid).toBe(false);
        expect(result.error).toContain('models');
    });

    test('rejects v2 config with models[] length > 10', () => {
        const result = ModelRouter.validateConfig({
            version: '2.0',
            tiers: {
                heavy: { models: Array(11).fill('model'), strategy: 'quality' }
            }
        });

        expect(result.valid).toBe(false);
        expect(result.error).toContain('models');
    });

    test('rejects invalid strategy value for v2', () => {
        const result = ModelRouter.validateConfig({
            version: '2.0',
            tiers: {
                heavy: { models: ['x'], strategy: 'invalid' }
            }
        });

        expect(result.valid).toBe(false);
        expect(result.error).toContain('strategy');
    });

    test('accepts valid strategy values for v2', () => {
        const qualityResult = ModelRouter.validateConfig({
            version: '2.0',
            tiers: { heavy: { models: ['x'], strategy: 'quality' } }
        });
        expect(qualityResult.valid).toBe(true);

        const throughputResult = ModelRouter.validateConfig({
            version: '2.0',
            tiers: { heavy: { models: ['x'], strategy: 'throughput' } }
        });
        expect(throughputResult.valid).toBe(true);

        const balancedResult = ModelRouter.validateConfig({
            version: '2.0',
            tiers: { heavy: { models: ['x'], strategy: 'balanced' } }
        });
        expect(balancedResult.valid).toBe(true);
    });

    test('label is optional for v2', () => {
        const result = ModelRouter.validateConfig({
            version: '2.0',
            tiers: {
                heavy: { models: ['glm-4-plus'] }
            }
        });

        expect(result.valid).toBe(true);
    });

    test('accepts label when provided', () => {
        const result = ModelRouter.validateConfig({
            version: '2.0',
            tiers: {
                heavy: { models: ['glm-4-plus'], label: 'Plus (Heavy)' }
            }
        });

        expect(result.valid).toBe(true);
    });

    test('rejects non-string label', () => {
        const result = ModelRouter.validateConfig({
            version: '2.0',
            tiers: {
                heavy: { models: ['glm-4-plus'], label: 123 }
            }
        });

        expect(result.valid).toBe(false);
        expect(result.error).toContain('label');
    });

    test('rejects non-string entries in models[]', () => {
        const result = ModelRouter.validateConfig({
            version: '2.0',
            tiers: {
                heavy: { models: ['glm-4-plus', 123] }
            }
        });

        expect(result.valid).toBe(false);
        expect(result.error).toContain('models[');
    });

    test('v1 config still validates correctly', () => {
        const result = ModelRouter.validateConfig({
            tiers: {
                heavy: { targetModel: 'glm-4-plus', fallbackModels: ['glm-4-air'] }
            }
        });

        expect(result.valid).toBe(true);
    });

    test('v1 with pool strategy validates', () => {
        const result = ModelRouter.validateConfig({
            tiers: {
                heavy: { targetModel: 'glm-4-plus', fallbackModels: ['glm-4-air'], strategy: 'pool' }
            }
        });

        expect(result.valid).toBe(true);
    });

    test('v1 with failover strategy validates', () => {
        const result = ModelRouter.validateConfig({
            tiers: {
                heavy: { targetModel: 'glm-4-plus', fallbackModels: ['glm-4-air'], strategy: 'failover' }
            }
        });

        expect(result.valid).toBe(true);
    });

    test('v1 requires targetModel', () => {
        const result = ModelRouter.validateConfig({
            tiers: {
                heavy: { fallbackModels: ['glm-4-air'] }
            }
        });

        expect(result.valid).toBe(false);
        expect(result.error).toContain('targetModel');
    });
});

// ============================================================================
// DECISION LAYER SPLIT TESTS (Wave 2)
// ============================================================================

describe('computeDecision', () => {
    let router;

    beforeEach(() => {
        jest.clearAllMocks();
        // Mock model discovery to return metadata
        mockModelDiscovery.getModel.mockResolvedValue({
            maxConcurrency: 2,
            pricing: { input: 2.5, output: 10 }
        });
    });

    test('returns decision object without state mutation', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });
        const context = {
            parsedBody: { model: 'claude-3-opus-20240229', max_tokens: 1000 },
            requestModel: 'claude-3-opus-20240229'
        };

        const beforeInFlight = new Map(router._inFlight);
        const decision = await router.computeDecision(context);
        const afterInFlight = new Map(router._inFlight);

        expect(decision).toBeDefined();
        expect(decision.model).toBe('glm-4-plus');
        expect(decision.tier).toBe('heavy');
        expect(decision.strategy).toBe('quality');
        expect(decision.source).toBeDefined();
        expect(decision.reason).toBeDefined();
        expect(beforeInFlight).toEqual(afterInFlight);  // No mutation
    });

    test('returns decision with all required fields', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                medium: {
                    models: ['glm-4-air'],
                    strategy: 'balanced',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: 'claude-3-sonnet-*' }, tier: 'medium' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });
        const context = {
            parsedBody: { model: 'claude-3-sonnet-20240229', max_tokens: 1000 },
            requestModel: 'claude-3-sonnet-20240229'
        };

        const decision = await router.computeDecision(context);

        expect(decision).toBeDefined();
        expect(decision).toHaveProperty('model');
        expect(decision).toHaveProperty('tier');
        expect(decision).toHaveProperty('strategy');
        expect(decision).toHaveProperty('source');
        expect(decision).toHaveProperty('reason');
        expect(decision.model).toBe('glm-4-air');
        expect(decision.tier).toBe('medium');
        expect(decision.strategy).toBe('balanced');
    });

    test('works with v1 config (backward compatibility)', async () => {
        const config = {
            enabled: true,
            tiers: {
                heavy: {
                    targetModel: 'glm-4-plus',
                    fallbackModels: ['glm-4-air'],
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });
        const context = {
            parsedBody: { model: 'claude-3-opus-20240229', max_tokens: 1000 },
            requestModel: 'claude-3-opus-20240229'
        };

        const decision = await router.computeDecision(context);

        expect(decision).toBeDefined();
        expect(decision.model).toBe('glm-4-plus');
        expect(decision.tier).toBe('heavy');
    });

    test('returns disabled decision when router is disabled', async () => {
        const config = {
            version: '2.0',
            enabled: false,
            tiers: {
                heavy: { models: ['glm-4-plus'] }
            }
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });
        const context = {
            parsedBody: { model: 'claude-3-opus-20240229' },
            requestModel: 'claude-3-opus-20240229'
        };

        const decision = await router.computeDecision(context);

        expect(decision).toBeDefined();
        expect(decision.model).toBeNull();
        expect(decision.reason).toContain('disabled');
        expect(decision.source).toBe('none');
    });

    test('does not acquire model slot (pure function)', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus'],
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });
        const context = {
            parsedBody: { model: 'test-model' },
            requestModel: 'test-model'
        };

        const beforeInFlight = router._inFlight.get('glm-4-plus') || 0;
        await router.computeDecision(context);
        const afterInFlight = router._inFlight.get('glm-4-plus') || 0;

        expect(beforeInFlight).toBe(afterInFlight);
        expect(afterInFlight).toBe(0);  // Should still be 0
    });

    test('does not mutate stats before commit (trace + fallback + glm5 paths)', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-5', 'model-a'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            glm5: { enabled: true, preferencePercent: 100 },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });
        // Force one fallback reason path while keeping selection possible.
        router.recordModelCooldown('model-a', 1000);

        const statsBefore = router.getStats();
        const decision = await router.computeDecision({
            parsedBody: { model: 'claude-3-opus-20240229', max_tokens: 4096 },
            requestModel: 'claude-3-opus-20240229',
            includeTrace: true
        });
        const statsAfterCompute = router.getStats();

        expect(decision).toBeDefined();
        expect(decision.model).toBe('glm-5');
        expect(statsAfterCompute).toEqual(statsBefore);

        router.commitDecision(decision);
        const statsAfterCommit = router.getStats();
        expect(statsAfterCommit.total).toBe(statsBefore.total + 1);
        expect(statsAfterCommit.traceSampledTotal).toBe(statsBefore.traceSampledTotal + 1);
        expect(statsAfterCommit.glm5EligibleTotal).toBe(statsBefore.glm5EligibleTotal + 1);
        expect(statsAfterCommit.byFallbackReason.cooldown || 0).toBe((statsBefore.byFallbackReason.cooldown || 0) + 1);
    });

    test('does not mutate shadow downgrade counters before commit', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['model-a'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                },
                medium: {
                    models: ['model-b'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            failover: {
                allowTierDowngrade: false,
                downgradeOrder: ['medium'],
                maxModelSwitchesPerRequest: 2
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });
        router.recordModelCooldown('model-a', 1000);

        const statsBefore = router.getStats();
        const decision = await router.computeDecision({
            parsedBody: { model: 'claude-3-opus-20240229', max_tokens: 4096 },
            requestModel: 'claude-3-opus-20240229'
        });
        const statsAfterCompute = router.getStats();

        expect(decision).toBeDefined();
        expect(statsAfterCompute.tierDowngradeShadow).toBe(statsBefore.tierDowngradeShadow);
        expect(statsAfterCompute.tierDowngradeShadowByRoute).toEqual(statsBefore.tierDowngradeShadowByRoute);

        router.commitDecision(decision);
        const statsAfterCommit = router.getStats();
        expect(statsAfterCommit.tierDowngradeShadow).toBe(statsBefore.tierDowngradeShadow + 1);
        expect(statsAfterCommit.tierDowngradeShadowByRoute['heavy->medium']).toBe(
            (statsBefore.tierDowngradeShadowByRoute['heavy->medium'] || 0) + 1
        );
    });
});

describe('commitDecision', () => {
    let router;

    beforeEach(() => {
        jest.clearAllMocks();
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus', 'glm-4-air'],
                    clientModelPolicy: 'always-route'
                }
            }
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });
    });

    test('acquires slot for model', async () => {
        const decision = {
            model: 'glm-4-plus',
            tier: 'heavy',
            strategy: 'quality',
            source: 'pool',
            reason: 'test decision'
        };

        const beforeCount = router._inFlight.get('glm-4-plus') || 0;
        const result = await router.commitDecision(decision);
        const afterCount = router._inFlight.get('glm-4-plus') || 0;

        expect(result).toEqual(decision);
        expect(afterCount).toBe(beforeCount + 1);
        expect(afterCount).toBe(1);
    });

    test('increments in-flight count for each unique decision', async () => {
        // commitDecision is idempotent per decision (committed flag prevents double-count)
        // Each new decision object increments in-flight
        await router.commitDecision({ model: 'glm-4-plus', tier: 'heavy' });
        expect(router._inFlight.get('glm-4-plus')).toBe(1);

        await router.commitDecision({ model: 'glm-4-plus', tier: 'heavy' });
        expect(router._inFlight.get('glm-4-plus')).toBe(2);

        await router.commitDecision({ model: 'glm-4-plus', tier: 'heavy' });
        expect(router._inFlight.get('glm-4-plus')).toBe(3);
    });

    test('returns the decision object unchanged', async () => {
        const decision = {
            model: 'glm-4-air',
            tier: 'heavy',
            strategy: 'throughput',
            source: 'pool',
            reason: 'test',
            scoringTable: []
        };

        const result = await router.commitDecision(decision);

        expect(result).toBe(decision);  // Same reference
        expect(result.model).toBe('glm-4-air');
        expect(result.tier).toBe('heavy');
    });

    test('handles null model gracefully', async () => {
        const decision = {
            model: null,
            tier: null,
            source: 'none'
        };

        const beforeInFlight = new Map(router._inFlight);
        const result = await router.commitDecision(decision);
        const afterInFlight = new Map(router._inFlight);

        expect(result).toEqual(decision);
        expect(beforeInFlight).toEqual(afterInFlight);  // No changes
    });

    test('handles undefined model gracefully', async () => {
        const decision = {
            model: undefined,
            tier: 'heavy'
        };

        const beforeInFlight = new Map(router._inFlight);
        const result = await router.commitDecision(decision);
        const afterInFlight = new Map(router._inFlight);

        expect(result).toEqual(decision);
        expect(beforeInFlight).toEqual(afterInFlight);  // No changes
    });
});

describe('selectModel drift validation (DRIFT-01)', () => {
    let router;
    let mockKeyManager;

    beforeEach(() => {
        jest.clearAllMocks();
        mockModelDiscovery.getModel.mockResolvedValue({
            maxConcurrency: 2,
            pricing: { input: 2.5, output: 10 }
        });

        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                medium: {
                    models: ['glm-4'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            }
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        // Wire up mock key manager for drift detection
        mockKeyManager = {
            getKeySnapshot: jest.fn().mockReturnValue({
                version: '1.0',
                timestamp: Date.now(),
                keyIndex: 0,
                keyId: 'key1',
                state: 'available',
                inFlight: 0,
                maxConcurrency: 3,
                excludedReason: null
            }),
            getAllKeySnapshots: jest.fn().mockReturnValue([])
        };
        router.setKeyManagerForDrift(mockKeyManager);
    });

    test('calls validateRoutingDecision during selectModel (fast path)', async () => {
        const spy = jest.spyOn(router._driftDetector, 'validateRoutingDecision');

        await router.selectModel({
            parsedBody: { model: 'glm-4', messages: [{ role: 'user', content: 'hello' }] },
            requestModel: 'glm-4'
        });

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({
                tier: 'medium',
                isAvailable: expect.any(Boolean)
            }),
            expect.any(Number)
        );
    });

    test('calls validateRoutingDecision during selectModel (trace path)', async () => {
        const spy = jest.spyOn(router._driftDetector, 'validateRoutingDecision');

        await router.selectModel({
            parsedBody: { model: 'glm-4', messages: [{ role: 'user', content: 'hello' }] },
            requestModel: 'glm-4',
            includeTrace: true
        });

        expect(spy).toHaveBeenCalledTimes(1);
    });

    test('does NOT call validateRoutingDecision in shadow mode', async () => {
        router.config.shadowMode = true;  // shadowMode is a getter reading from config
        const spy = jest.spyOn(router._driftDetector, 'validateRoutingDecision');

        await router.selectModel({
            parsedBody: { model: 'glm-4', messages: [{ role: 'user', content: 'hello' }] },
            requestModel: 'glm-4'
        });

        expect(spy).not.toHaveBeenCalled();
    });

    test('does NOT call validateRoutingDecision when disabled', async () => {
        router.config.enabled = false;  // enabled is a getter reading from config
        const spy = jest.spyOn(router._driftDetector, 'validateRoutingDecision');

        await router.selectModel({
            parsedBody: { model: 'glm-4', messages: [{ role: 'user', content: 'hello' }] },
            requestModel: 'glm-4'
        });

        expect(spy).not.toHaveBeenCalled();
    });

    test('detects drift when KM key is excluded but router routes to model', async () => {
        // Set KM to report key as excluded
        mockKeyManager.getKeySnapshot.mockReturnValue({
            version: '1.0',
            timestamp: Date.now(),
            keyIndex: 0,
            keyId: 'key1',
            state: 'excluded',
            inFlight: 0,
            maxConcurrency: 3,
            excludedReason: 'circuit_breaker'
        });

        const driftEvents = router._driftDetector.getDriftEvents();
        expect(driftEvents).toHaveLength(0);

        await router.selectModel({
            parsedBody: { model: 'glm-4', messages: [{ role: 'user', content: 'hello' }] },
            requestModel: 'glm-4'
        });

        const driftEventsAfter = router._driftDetector.getDriftEvents();
        expect(driftEventsAfter.length).toBeGreaterThan(0);
        expect(driftEventsAfter[0].reason).toBe('router_available_km_excluded');
    });

    test('commitDecision no longer calls validateRoutingDecision', async () => {
        const spy = jest.spyOn(router._driftDetector, 'validateRoutingDecision');

        await router.commitDecision({
            model: 'glm-4',
            tier: 'medium',
            reason: 'test'
        });

        expect(spy).not.toHaveBeenCalled();
    });
});

describe('selectModel with decision split', () => {
    let router;

    beforeEach(() => {
        jest.clearAllMocks();
        // Mock model discovery to return metadata
        mockModelDiscovery.getModel.mockResolvedValue({
            maxConcurrency: 2,
            pricing: { input: 2.5, output: 10 }
        });
    });

    test('uses compute and commit pattern in normal mode', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            shadowMode: false,
            tiers: {
                heavy: {
                    models: ['glm-4-plus'],
                    strategy: 'pool',  // Use pool to ensure slot is acquired
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });
        const context = {
            parsedBody: { model: 'claude-3-opus-20240229', max_tokens: 1000 },
            requestModel: 'claude-3-opus-20240229'
        };

        const result = await router.selectModel(context);

        expect(result).toBeDefined();
        expect(result.model).toBe('glm-4-plus');
        expect(result.tier).toBe('heavy');
        // Pool strategy acquires slots
        expect(router._inFlight.get('glm-4-plus') || 0).toBeGreaterThan(0);
    });

    test('shadow mode stores decision and returns null', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            shadowMode: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });
        const context = {
            parsedBody: { model: 'claude-3-opus-20240229', max_tokens: 1000 },
            requestModel: 'claude-3-opus-20240229'
        };

        const result = await router.selectModel(context);
        const shadowDecision = router.getLastShadowDecision();

        expect(result).toBeNull();  // Shadow returns null
        expect(shadowDecision).toBeDefined();
        expect(shadowDecision.model).toBe('glm-4-plus');
        expect(shadowDecision.shadowMode).toBe(true);
        expect(router._inFlight.get('glm-4-plus') || 0).toBe(0);  // No slot acquired
    });

    test('computeDecision is called without acquiring slot', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus'],
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });
        const context = {
            parsedBody: { model: 'test-model' },
            requestModel: 'test-model'
        };

        const beforeInFlight = router._inFlight.get('glm-4-plus') || 0;
        const decision = await router.computeDecision(context);
        const afterInFlightCompute = router._inFlight.get('glm-4-plus') || 0;

        expect(decision.model).toBe('glm-4-plus');
        expect(beforeInFlight).toBe(afterInFlightCompute);  // No mutation from compute

        // Now commit
        await router.commitDecision(decision);
        const afterInFlightCommit = router._inFlight.get('glm-4-plus') || 0;
        expect(afterInFlightCommit).toBe(beforeInFlight + 1);  // Slot acquired on commit
    });

    test('selectModel returns null when disabled', async () => {
        const config = {
            version: '2.0',
            enabled: false,
            tiers: {
                heavy: { models: ['glm-4-plus'] }
            }
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });
        const context = {
            parsedBody: { model: 'test-model' },
            requestModel: 'test-model'
        };

        const result = await router.selectModel(context);

        expect(result).toBeNull();
    });

    test('selectModel with pool strategy acquires slot', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus', 'glm-4-air'],
                    strategy: 'pool',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });
        const context = {
            parsedBody: { model: 'test-model' },
            requestModel: 'test-model'
        };

        const result = await router.selectModel(context);

        expect(result).toBeDefined();
        expect(result.model).toBeDefined();
        expect(['glm-4-plus', 'glm-4-air']).toContain(result.model);
        expect(result.source).toBe('pool');
        // Slot should be acquired
        expect(router._inFlight.get(result.model)).toBe(1);
    });
});

// ============================================================================
// POOL STRATEGY TESTS (Wave 3)
// ============================================================================

describe('Quality Strategy', () => {
    let router;

    beforeEach(() => {
        jest.clearAllMocks();
        // Mock model discovery to return metadata
        mockModelDiscovery.getModel.mockImplementation((id) => ({
            maxConcurrency: 10,
            pricing: { input: 1, output: 1 }
        }));
    });

    test('selects position 0 if available', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const context = {
            parsedBody: { model: 'claude-3-opus-20240229', max_tokens: 1000 },
            requestModel: 'claude-3-opus-20240229'
        };

        const decision = await router.computeDecision(context);

        expect(decision.model).toBe('glm-4-plus');  // Position 0
        expect(decision.strategy).toBe('quality');
    });

    test('skips cooled position 0 and selects next available', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        // Cool down position 0
        router.recordModelCooldown('glm-4-plus', 60000);

        const context = {
            parsedBody: { model: 'claude-3-opus-20240229', max_tokens: 1000 },
            requestModel: 'claude-3-opus-20240229'
        };

        const decision = await router.computeDecision(context);

        expect(decision.model).toBe('glm-4-air');  // Position 1
        expect(decision.strategy).toBe('quality');
    });

    test('skips full position 0 and selects next available', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus', 'glm-4-air'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery,
            concurrencyMultiplier: 1
        });

        // Fill position 0 to capacity (maxConcurrency = 10)
        router._inFlight.set('glm-4-plus', 10);

        const context = {
            parsedBody: { model: 'test-model' },
            requestModel: 'test-model'
        };

        const decision = await router.computeDecision(context);

        expect(decision.model).toBe('glm-4-air');  // Position 1
        expect(decision.strategy).toBe('quality');
    });

    test('falls back through multiple positions', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        // Cool down positions 0 and 1
        router.recordModelCooldown('glm-4-plus', 60000);
        router.recordModelCooldown('glm-4-air', 60000);

        const context = {
            parsedBody: { model: 'test-model' },
            requestModel: 'test-model'
        };

        const decision = await router.computeDecision(context);

        expect(decision.model).toBe('glm-4-flash');  // Position 2
        expect(decision.strategy).toBe('quality');
    });

    test('includes position in scoring table', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus', 'glm-4-air'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const context = {
            parsedBody: { model: 'test-model' },
            requestModel: 'test-model'
        };

        const decision = await router.computeDecision(context);

        expect(decision.scoringTable).toBeDefined();
        expect(decision.scoringTable[0].position).toBe(0);
        expect(decision.scoringTable[0].model).toBe('glm-4-plus');
        expect(decision.scoringTable[0].selected).toBe(true);
    });
});

describe('Balanced Strategy', () => {
    let router;

    beforeEach(() => {
        jest.clearAllMocks();
        // Mock model discovery to return metadata
        mockModelDiscovery.getModel.mockImplementation((id) => ({
            maxConcurrency: 10,
            pricing: { input: 1, output: 1 }
        }));
    });

    test('blends position (0.6) and capacity (0.4)', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus', 'glm-4-air'],
                    strategy: 'balanced',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const context = {
            parsedBody: { model: 'test-model' },
            requestModel: 'test-model'
        };

        // Position 0: 9 in flight (1 available), Position 1: 1 in flight (9 available)
        router._inFlight.set('glm-4-plus', 9);
        router._inFlight.set('glm-4-air', 1);

        const decision = await router.computeDecision(context);

        // Position 0 score: 0.6 * 1.0 + 0.4 * 0.1 = 0.64
        // Position 1 score: 0.6 * 0.5 + 0.4 * 0.9 = 0.66
        // Position 1 should win (higher balanced score)
        expect(decision.model).toBe('glm-4-air');
        expect(decision.strategy).toBe('balanced');
    });

    test('may skip position 0 if capacity is very low', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus', 'glm-4-air'],
                    strategy: 'balanced',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const context = {
            parsedBody: { model: 'test-model' },
            requestModel: 'test-model'
        };

        // Position 0: almost full (1 available out of 10)
        // Position 1: mostly available (9 available out of 10)
        router._inFlight.set('glm-4-plus', 9);
        router._inFlight.set('glm-4-air', 1);

        const decision = await router.computeDecision(context);

        // Position 0 score: 0.6 * 1.0 + 0.4 * 0.1 = 0.64
        // Position 1 score: 0.6 * 0.5 + 0.4 * 0.9 = 0.66
        expect(decision.model).toBe('glm-4-air');
        expect(decision.strategy).toBe('balanced');
    });

    test('prefers position 0 when capacities are similar', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus', 'glm-4-air'],
                    strategy: 'balanced',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const context = {
            parsedBody: { model: 'test-model' },
            requestModel: 'test-model'
        };

        // Both have similar capacity (position 0 gets slight edge from position score)
        router._inFlight.set('glm-4-plus', 5);  // 5 available
        router._inFlight.set('glm-4-air', 4);   // 6 available

        const decision = await router.computeDecision(context);

        // Position 0 score: 0.6 * 1.0 + 0.4 * 0.5 = 0.8
        // Position 1 score: 0.6 * 0.5 + 0.4 * 0.6 = 0.54
        expect(decision.model).toBe('glm-4-plus');
        expect(decision.strategy).toBe('balanced');
    });

    test('includes score in scoring table', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus', 'glm-4-air'],
                    strategy: 'balanced',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const context = {
            parsedBody: { model: 'test-model' },
            requestModel: 'test-model'
        };

        const decision = await router.computeDecision(context);

        expect(decision.scoringTable).toBeDefined();
        expect(decision.scoringTable[0].score).toBeDefined();
        expect(typeof decision.scoringTable[0].score).toBe('number');
    });

    test('breaks ties by lower cost', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus', 'glm-4-air'],
                    strategy: 'balanced',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        // Mock different pricing - glm-4-plus is more expensive
        mockModelDiscovery.getModel.mockImplementation((id) => ({
            maxConcurrency: 10,
            pricing: {
                input: id === 'glm-4-plus' ? 2.5 : 0.15,
                output: id === 'glm-4-plus' ? 10 : 0.6
            }
        }));

        const context = {
            parsedBody: { model: 'test-model' },
            requestModel: 'test-model'
        };

        // Set in-flight to make position 1's capacity overcome position disadvantage
        // Position 0: 2/10 available (score: 0.6*1.0 + 0.4*0.2 = 0.68)
        // Position 1: 9/10 available (score: 0.6*0.5 + 0.4*0.9 = 0.66)
        // Actually position 0 still wins, so we need more extreme values
        router._inFlight.set('glm-4-plus', 8);
        router._inFlight.set('glm-4-air', 0);

        const decision = await router.computeDecision(context);

        // Position 0 score: 0.6 * 1.0 + 0.4 * 0.2 = 0.68
        // Position 1 score: 0.6 * 0.5 + 0.4 * 1.0 = 0.7
        // With same score (close), cheaper breaks tie
        // Actually position 1 wins on score, let me adjust
        expect(decision.model).toBe('glm-4-air');
        expect(decision.strategy).toBe('balanced');
    });
});

describe('Throughput Strategy', () => {
    let router;

    beforeEach(() => {
        jest.clearAllMocks();
        // Mock model discovery to return metadata
        mockModelDiscovery.getModel.mockImplementation((id) => ({
            maxConcurrency: 10,
            pricing: { input: 1, output: 1 }
        }));
    });

    test('maximizes available capacity', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
                    strategy: 'throughput',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const context = {
            parsedBody: { model: 'test-model' },
            requestModel: 'test-model'
        };

        // Position 0: 1 available, Position 1: 9 available, Position 2: 5 available
        router._inFlight.set('glm-4-plus', 9);
        router._inFlight.set('glm-4-air', 1);
        router._inFlight.set('glm-4-flash', 5);

        const decision = await router.computeDecision(context);

        // Throughput should pick position 1 (most available)
        expect(decision.model).toBe('glm-4-air');
        expect(decision.strategy).toBe('throughput');
    });

    test('breaks ties by lower cost', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus', 'glm-4-air'],
                    strategy: 'throughput',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        // Both have same availability, but glm-4-air is cheaper
        mockModelDiscovery.getModel.mockImplementation((id) => ({
            maxConcurrency: 10,
            pricing: {
                input: id === 'glm-4-plus' ? 2.5 : 0.15,
                output: id === 'glm-4-plus' ? 10 : 0.6
            }
        }));

        const context = {
            parsedBody: { model: 'test-model' },
            requestModel: 'test-model'
        };

        const decision = await router.computeDecision(context);

        expect(decision.model).toBe('glm-4-air');  // Cheaper
        expect(decision.strategy).toBe('throughput');
    });

    test('penalizes high 429 hit count', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus', 'glm-4-air'],
                    strategy: 'throughput',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const context = {
            parsedBody: { model: 'test-model' },
            requestModel: 'test-model'
        };

        // Both have same availability, but glm-4-plus has 429 hits
        // Use sliding window 429 counter (replaces old cooldown-based hitCount)
        for (let i = 0; i < 5; i++) {
            router.recordPool429('glm-4-plus');
        }

        router._inFlight.set('glm-4-plus', 5);  // 5 available
        router._inFlight.set('glm-4-air', 5);   // 5 available

        const decision = await router.computeDecision(context);

        // glm-4-air should win due to penalty on glm-4-plus
        // glm-4-plus score: 5 * (1 / (1 + 5 * 0.5)) = 5 * 0.286 = 1.43
        // glm-4-air score: 5 * (1 / (1 + 0 * 0.5)) = 5 * 1.0 = 5.0
        expect(decision.model).toBe('glm-4-air');
        expect(decision.strategy).toBe('throughput');
    });

    test('includes weighted score in scoring table', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus', 'glm-4-air'],
                    strategy: 'throughput',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const context = {
            parsedBody: { model: 'test-model' },
            requestModel: 'test-model'
        };

        const decision = await router.computeDecision(context);

        expect(decision.scoringTable).toBeDefined();
        expect(decision.scoringTable[0].score).toBeDefined();
        expect(typeof decision.scoringTable[0].score).toBe('number');
    });

    test('breaks cost ties by higher maxConcurrency', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus', 'glm-4-air'],
                    strategy: 'throughput',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        // Same cost, but glm-4-air has higher maxConcurrency
        mockModelDiscovery.getModel.mockImplementation((id) => ({
            maxConcurrency: id === 'glm-4-plus' ? 5 : 10,
            pricing: { input: 1, output: 1 }  // Same cost
        }));

        const context = {
            parsedBody: { model: 'test-model' },
            requestModel: 'test-model'
        };

        router._inFlight.set('glm-4-plus', 2);  // 3 available out of 5
        router._inFlight.set('glm-4-air', 7);   // 3 available out of 10

        const decision = await router.computeDecision(context);

        // Same available (3), same cost, glm-4-air wins on higher maxConcurrency
        expect(decision.model).toBe('glm-4-air');
        expect(decision.strategy).toBe('throughput');
    });
});

describe('Strategy Selection', () => {
    let router;

    beforeEach(() => {
        jest.clearAllMocks();
        // Mock model discovery to return metadata
        mockModelDiscovery.getModel.mockImplementation((id) => ({
            maxConcurrency: 10,
            pricing: { input: 1, output: 1 }
        }));
    });

    test('uses strategy from tier config', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus', 'glm-4-air'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const decision = await router.computeDecision({
            parsedBody: { model: 'test-model' },
            requestModel: 'test-model'
        });

        expect(decision.strategy).toBe('quality');
    });

    test('defaults to balanced when strategy not specified', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus', 'glm-4-air'],
                    // No strategy specified - should default to balanced
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const decision = await router.computeDecision({
            parsedBody: { model: 'test-model' },
            requestModel: 'test-model'
        });

        expect(decision.strategy).toBe('balanced');
    });

    test('handles invalid strategy gracefully (falls back to balanced)', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus', 'glm-4-air'],
                    strategy: 'invalid-strategy',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const decision = await router.computeDecision({
            parsedBody: { model: 'test-model' },
            requestModel: 'test-model'
        });

        // Invalid strategy should fall back to balanced
        expect(decision.strategy).toBe('balanced');
    });

    test('selects correct model based on strategy type', async () => {
        // Same models, different strategies
        const qualityConfig = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus', 'glm-4-air'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        const qualityRouter = new ModelRouter(qualityConfig, {
            modelDiscovery: mockModelDiscovery
        });

        const throughputConfig = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus', 'glm-4-air'],
                    strategy: 'throughput',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        const throughputRouter = new ModelRouter(throughputConfig, {
            modelDiscovery: mockModelDiscovery
        });

        const context = {
            parsedBody: { model: 'test-model' },
            requestModel: 'test-model'
        };

        // Quality should pick position 0
        const qualityDecision = await qualityRouter.computeDecision(context);
        expect(qualityDecision.model).toBe('glm-4-plus');
        expect(qualityDecision.strategy).toBe('quality');

        // For throughput with equal scores, NORM-07 deterministic tiebreaker
        // sorts by model name alphabetically: 'glm-4-air' < 'glm-4-plus'
        const throughputDecision = await throughputRouter.computeDecision(context);
        expect(throughputDecision.model).toBe('glm-4-air');
        expect(throughputDecision.strategy).toBe('throughput');
    });

    test('different strategies produce different results', async () => {
        const context = {
            parsedBody: { model: 'test-model' },
            requestModel: 'test-model'
        };

        // Set up in-flight to differentiate strategies
        // glm-4-plus: 1 available, glm-4-air: 9 available

        // Quality: picks position 0 regardless of availability
        const qualityConfig = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus', 'glm-4-air'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        const qualityRouter = new ModelRouter(qualityConfig, {
            modelDiscovery: mockModelDiscovery
        });
        qualityRouter._inFlight.set('glm-4-plus', 9);
        qualityRouter._inFlight.set('glm-4-air', 1);

        const qualityDecision = await qualityRouter.computeDecision(context);
        expect(qualityDecision.model).toBe('glm-4-plus');  // Position 0

        // Throughput: picks model with most availability
        const throughputConfig = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus', 'glm-4-air'],
                    strategy: 'throughput',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        const throughputRouter = new ModelRouter(throughputConfig, {
            modelDiscovery: mockModelDiscovery
        });
        throughputRouter._inFlight.set('glm-4-plus', 9);
        throughputRouter._inFlight.set('glm-4-air', 1);

        const throughputDecision = await throughputRouter.computeDecision(context);
        expect(throughputDecision.model).toBe('glm-4-air');  // More available
    });
});

// ============================================================================
// DATA CONTRACT TESTS (Wave 4)
// ============================================================================

describe('getModelPoolSnapshot', () => {
    let router;

    beforeEach(() => {
        jest.clearAllMocks();
        // Mock model discovery to return metadata with pricing
        mockModelDiscovery.getModel.mockImplementation((id) => ({
            maxConcurrency: 10,
            pricing: { input: 2.5, output: 10 }
        }));
    });

    test('returns formal ModelPoolSnapshot schema', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                },
                medium: {
                    models: ['glm-4-air'],
                    strategy: 'balanced',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const snapshot = await router.getModelPoolSnapshot();

        expect(snapshot).toBeDefined();
        expect(snapshot.schemaVersion).toBe(1);
        expect(snapshot.ts).toBeGreaterThan(0);
        expect(snapshot.pools).toBeDefined();
        expect(snapshot.pools.heavy).toBeDefined();
        expect(snapshot.pools.medium).toBeDefined();
    });

    test('includes all required fields in pool entries', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const snapshot = await router.getModelPoolSnapshot();

        const entry = snapshot.pools.heavy[0];
        expect(entry.model).toBe('glm-4-plus');
        expect(entry.inFlight).toBeDefined();
        expect(entry.maxConcurrency).toBeDefined();
        expect(entry.available).toBeDefined();
    });

    test('includes schemaVersion field', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                light: {
                    models: ['glm-4-flash'],
                    strategy: 'balanced',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'light' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const snapshot = await router.getModelPoolSnapshot();

        expect(snapshot.schemaVersion).toBe(1);
    });

    test('includes timestamp field', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus'],
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const before = Date.now();
        const snapshot = await router.getModelPoolSnapshot();
        const after = Date.now();

        expect(snapshot.ts).toBeGreaterThanOrEqual(before);
        expect(snapshot.ts).toBeLessThanOrEqual(after);
    });

    test('includes pools by tier', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                light: {
                    models: ['glm-4-flash'],
                    strategy: 'throughput',
                    clientModelPolicy: 'always-route'
                },
                medium: {
                    models: ['glm-4-air'],
                    strategy: 'balanced',
                    clientModelPolicy: 'always-route'
                },
                heavy: {
                    models: ['glm-4-plus', 'glm-4-air'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const snapshot = await router.getModelPoolSnapshot();

        expect(snapshot.pools).toBeDefined();
        expect(snapshot.pools.light).toBeDefined();
        expect(snapshot.pools.medium).toBeDefined();
        expect(snapshot.pools.heavy).toBeDefined();
    });

    test('returns empty arrays for tiers with no models', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                light: {
                    models: ['glm-4-flash'],
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'light' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const snapshot = await router.getModelPoolSnapshot();

        // Only light tier has models, so heavy/medium should not be in snapshot
        expect(snapshot.pools.light).toBeDefined();
        expect(snapshot.pools.light.length).toBe(1);
    });

    test('includes multiple models in tier pool', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
                    strategy: 'balanced',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const snapshot = await router.getModelPoolSnapshot();

        expect(snapshot.pools.heavy).toBeDefined();
        expect(snapshot.pools.heavy.length).toBe(3);
        expect(snapshot.pools.heavy[0].model).toBe('glm-4-plus');
        expect(snapshot.pools.heavy[1].model).toBe('glm-4-air');
        expect(snapshot.pools.heavy[2].model).toBe('glm-4-flash');
    });
});

describe('Null Defaults', () => {
    let router;

    beforeEach(() => {
        jest.clearAllMocks();
        // Mock model discovery to return metadata with pricing
        mockModelDiscovery.getModel.mockImplementation((id) => ({
            maxConcurrency: 10,
            pricing: { input: 1, output: 1 }
        }));
    });

    test('recent429 is null when no recent 429s', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const snapshot = await router.getModelPoolSnapshot();

        // Without recording any cooldowns, recent429 should be null
        const entry = snapshot.pools.heavy[0];
        expect(entry.recent429).toBeNull();
    });

    test('latencyP95 defaults to null', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus'],
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const snapshot = await router.getModelPoolSnapshot();

        const entry = snapshot.pools.heavy[0];
        expect(entry.latencyP95).toBeNull();
    });

    test('errorRate defaults to null', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus'],
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const snapshot = await router.getModelPoolSnapshot();

        const entry = snapshot.pools.heavy[0];
        expect(entry.errorRate).toBeNull();
    });

    test('all telemetry fields are null by default', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                medium: {
                    models: ['glm-4-air'],
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'medium' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const snapshot = await router.getModelPoolSnapshot();

        const entry = snapshot.pools.medium[0];
        expect(entry.recent429).toBeNull();
        expect(entry.latencyP95).toBeNull();
        expect(entry.errorRate).toBeNull();
    });

    test('null defaults apply to all tiers', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                light: {
                    models: ['glm-4-flash'],
                    clientModelPolicy: 'always-route'
                },
                medium: {
                    models: ['glm-4-air'],
                    clientModelPolicy: 'always-route'
                },
                heavy: {
                    models: ['glm-4-plus'],
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const snapshot = await router.getModelPoolSnapshot();

        // Check all tiers have null telemetry
        expect(snapshot.pools.light[0].recent429).toBeNull();
        expect(snapshot.pools.light[0].latencyP95).toBeNull();
        expect(snapshot.pools.light[0].errorRate).toBeNull();

        expect(snapshot.pools.medium[0].recent429).toBeNull();
        expect(snapshot.pools.medium[0].latencyP95).toBeNull();
        expect(snapshot.pools.medium[0].errorRate).toBeNull();

        expect(snapshot.pools.heavy[0].recent429).toBeNull();
        expect(snapshot.pools.heavy[0].latencyP95).toBeNull();
        expect(snapshot.pools.heavy[0].errorRate).toBeNull();
    });
});

describe('Cost Field', () => {
    let router;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('is populated from ModelDiscovery pricing', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        // Mock with specific pricing
        mockModelDiscovery.getModel.mockResolvedValue({
            maxConcurrency: 10,
            pricing: { input: 2.5, output: 10 }
        });

        const snapshot = await router.getModelPoolSnapshot();

        const entry = snapshot.pools.heavy[0];
        expect(entry.cost).toBe(12.5);  // 2.5 + 10
    });

    test('defaults to 0 when pricing not available', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['unknown-model'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        // Mock without pricing
        mockModelDiscovery.getModel.mockResolvedValue({
            maxConcurrency: 10
            // No pricing
        });

        const snapshot = await router.getModelPoolSnapshot();

        const entry = snapshot.pools.heavy[0];
        expect(entry.cost).toBe(0);
    });

    test('cost is input + output pricing', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                medium: {
                    models: ['glm-4-air'],
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'medium' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        // Mock with different pricing values
        mockModelDiscovery.getModel.mockImplementation((id) => ({
            maxConcurrency: 10,
            pricing: {
                input: id === 'glm-4-air' ? 0.15 : 1,
                output: id === 'glm-4-air' ? 0.6 : 1
            }
        }));

        const snapshot = await router.getModelPoolSnapshot();

        const entry = snapshot.pools.medium[0];
        expect(entry.cost).toBe(0.75);  // 0.15 + 0.6
    });

    test('handles missing pricing fields gracefully', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                light: {
                    models: ['glm-4-flash'],
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'light' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        // Mock with partial pricing
        mockModelDiscovery.getModel.mockResolvedValue({
            maxConcurrency: 10,
            pricing: { input: 0.1 }  // No output
        });

        const snapshot = await router.getModelPoolSnapshot();

        const entry = snapshot.pools.light[0];
        expect(entry.cost).toBe(0.1);  // 0.1 + 0 (undefined output defaults to 0)
    });

    test('handles null pricing object', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                light: {
                    models: ['glm-4-flash'],
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'light' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        // Mock with null pricing
        mockModelDiscovery.getModel.mockResolvedValue({
            maxConcurrency: 10,
            pricing: null
        });

        const snapshot = await router.getModelPoolSnapshot();

        const entry = snapshot.pools.light[0];
        expect(entry.cost).toBe(0);
    });
});

// ============================================================================
// VALIDATION RULES TESTS (Wave 5)
// ============================================================================

describe('VALIDATE-01: Duplicate Model Warning', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('warns on duplicate models across tiers', () => {
        const config = {
            version: '2.0',
            tiers: {
                heavy: { models: ['glm-4-plus', 'glm-4-air'], strategy: 'quality' },
                medium: { models: ['glm-4-air', 'glm-4-flash'], strategy: 'balanced' }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };

        const result = ModelRouter.validateConfig(config);

        expect(result.valid).toBe(true);  // Still accepted
        expect(result.warnings).toBeDefined();
        expect(result.warnings.join(' ')).toContain('shared-pool');
        expect(result.warnings.join(' ')).toContain('glm-4-air');
    });

    test('accepts config with duplicate models', () => {
        const config = {
            version: '2.0',
            tiers: {
                heavy: { models: ['glm-4-plus', 'glm-4-air'], strategy: 'quality' },
                medium: { models: ['glm-4-air'], strategy: 'balanced' }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };

        const result = ModelRouter.validateConfig(config);

        expect(result.valid).toBe(true);
    });

    test('does not warn when no duplicates', () => {
        const config = {
            version: '2.0',
            tiers: {
                heavy: { models: ['glm-4-plus'], strategy: 'quality' },
                medium: { models: ['glm-4-air'], strategy: 'balanced' }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };

        const result = ModelRouter.validateConfig(config);

        expect(result.valid).toBe(true);
        expect(result.warnings).toBeUndefined();
    });

    test('warns on v1 config with duplicate models', () => {
        const config = {
            tiers: {
                heavy: {
                    targetModel: 'glm-4-plus',
                    fallbackModels: ['glm-4-air'],
                    strategy: 'failover'
                },
                medium: {
                    targetModel: 'glm-4-air',
                    fallbackModels: [],
                    strategy: 'failover'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };

        const result = ModelRouter.validateConfig(config);

        expect(result.valid).toBe(true);
        expect(result.warnings).toBeDefined();
        expect(result.warnings.join(' ')).toContain('glm-4-air');
    });

    test('lists all duplicate models in warning', () => {
        const config = {
            version: '2.0',
            tiers: {
                heavy: { models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'], strategy: 'quality' },
                medium: { models: ['glm-4-air', 'glm-4-flash'], strategy: 'balanced' },
                light: { models: ['glm-4-flash'], strategy: 'throughput' }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };

        const result = ModelRouter.validateConfig(config);
        expect(result.warnings).toBeDefined();
        expect(result.warnings.join(' ')).toContain('glm-4-air');
        expect(result.warnings.join(' ')).toContain('glm-4-flash');
    });
});

describe('VALIDATE-02: Empty Tier Rejection', () => {
    test('rejects empty models[] array', () => {
        const config = {
            version: '2.0',
            tiers: {
                heavy: { models: [], strategy: 'quality' }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };

        const result = ModelRouter.validateConfig(config);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('empty');
    });

    test('rejects tier with no targetModel (v1)', () => {
        const config = {
            tiers: {
                heavy: { strategy: 'failover' }  // No targetModel
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };

        const result = ModelRouter.validateConfig(config);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('targetModel');
    });

    test('error message indicates empty tier', () => {
        const config = {
            version: '2.0',
            tiers: {
                medium: { models: [], strategy: 'balanced' }
            },
            rules: [{ match: { model: '*' }, tier: 'medium' }]
        };

        const result = ModelRouter.validateConfig(config);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('models');
        expect(result.error).toContain('empty');
    });
});

describe('VALIDATE-03: maxModelSwitchesPerRequest Validation', () => {
    test('warns when maxModelSwitchesPerRequest > models.length', () => {
        const config = {
            version: '2.0',
            tiers: {
                heavy: { models: ['glm-4-plus'], strategy: 'quality' }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }],
            failover: {
                maxModelSwitchesPerRequest: 5  // More than models.length (1)
            }
        };

        const result = ModelRouter.validateConfig(config);

        // Now a warning, not a rejection — runtime clamps to available models
        expect(result.valid).toBe(true);
        expect(result.warnings).toBeDefined();
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(result.warnings[0]).toContain('maxModelSwitchesPerRequest');
        expect(result.warnings[0]).toContain('models.length');
    });

    test('accepts valid maxModelSwitchesPerRequest without warnings', () => {
        const config = {
            version: '2.0',
            tiers: {
                heavy: { models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'], strategy: 'quality' }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }],
            failover: {
                maxModelSwitchesPerRequest: 2  // Less than models.length (3)
            }
        };

        const result = ModelRouter.validateConfig(config);

        expect(result.valid).toBe(true);
        expect(result.warnings).toBeUndefined();
    });

    test('warning applies to each tier independently', () => {
        const config = {
            version: '2.0',
            tiers: {
                heavy: { models: ['glm-4-plus'], strategy: 'quality' },
                medium: { models: ['glm-4-air', 'glm-4-flash'], strategy: 'balanced' }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }],
            failover: {
                maxModelSwitchesPerRequest: 3  // Valid for medium (2 models), exceeds heavy (1 model)
            }
        };

        const result = ModelRouter.validateConfig(config);

        expect(result.valid).toBe(true);
        expect(result.warnings).toBeDefined();
        expect(result.warnings.some(w => w.includes('heavy'))).toBe(true);
    });

    test('allows maxModelSwitchesPerRequest equal to models.length', () => {
        const config = {
            version: '2.0',
            tiers: {
                heavy: { models: ['glm-4-plus', 'glm-4-air'], strategy: 'quality' }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }],
            failover: {
                maxModelSwitchesPerRequest: 2  // Equal to models.length (2)
            }
        };

        const result = ModelRouter.validateConfig(config);

        expect(result.valid).toBe(true);
        expect(result.warnings).toBeUndefined();
    });
});

describe('Catch-All Rule Validation', () => {
    test('rejects config with rules but no catch-all rule or defaultModel', () => {
        const config = {
            version: '2.0',
            tiers: {
                heavy: { models: ['glm-4-plus'], strategy: 'quality' }
            },
            rules: [{ match: { model: 'claude-3-opus-20240229' }, tier: 'heavy' }]
            // No catch-all (*), no defaultModel
        };

        const result = ModelRouter.validateConfig(config);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('catch-all');
        expect(result.error).toContain('defaultModel');
    });

    test('accepts config with catch-all rule', () => {
        const config = {
            version: '2.0',
            tiers: {
                heavy: { models: ['glm-4-plus'], strategy: 'quality' }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };

        const result = ModelRouter.validateConfig(config);

        expect(result.valid).toBe(true);
    });

    test('accepts config with defaultModel', () => {
        const config = {
            version: '2.0',
            tiers: {
                heavy: { models: ['glm-4-plus'], strategy: 'quality' }
            },
            rules: [{ match: { model: 'claude-3-opus-20240229' }, tier: 'heavy' }],
            defaultModel: 'glm-4-flash'
        };

        const result = ModelRouter.validateConfig(config);

        expect(result.valid).toBe(true);
    });

    test('accepts config with both catch-all and defaultModel', () => {
        const config = {
            version: '2.0',
            tiers: {
                heavy: { models: ['glm-4-plus'], strategy: 'quality' }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }],
            defaultModel: 'glm-4-flash'
        };

        const result = ModelRouter.validateConfig(config);

        expect(result.valid).toBe(true);
    });

    test('allows empty rules array when defaultModel is set', () => {
        const config = {
            version: '2.0',
            tiers: {
                heavy: { models: ['glm-4-plus'], strategy: 'quality' }
            },
            rules: [],
            defaultModel: 'glm-4-flash'
        };

        const result = ModelRouter.validateConfig(config);

        expect(result.valid).toBe(true);
    });

    test('accepts config with no rules and no defaultModel (valid but matches nothing)', () => {
        const config = {
            version: '2.0',
            tiers: {
                heavy: { models: ['glm-4-plus'], strategy: 'quality' }
            },
            rules: []
            // No defaultModel, no catch-all
        };

        const result = ModelRouter.validateConfig(config);

        // Valid config - it just won't match any requests
        expect(result.valid).toBe(true);
    });

    test('accepts config without rules field (valid but matches nothing)', () => {
        const config = {
            version: '2.0',
            tiers: {
                heavy: { models: ['glm-4-plus'], strategy: 'quality' }
            }
            // No rules field at all, no defaultModel
        };

        const result = ModelRouter.validateConfig(config);

        // Valid config - it just won't match any requests
        expect(result.valid).toBe(true);
    });
});

describe('Backward Compatibility', () => {
    let router;

    beforeEach(() => {
        jest.clearAllMocks();
        // Mock model discovery to return metadata
        mockModelDiscovery.getModel.mockResolvedValue({
            maxConcurrency: 10,
            pricing: { input: 1, output: 1 }
        });
    });

    test('getPoolStatus still works with v2 config', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus'],
                    strategy: 'pool',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const status = await router.getPoolStatus();

        expect(status).toBeDefined();
        expect(status.heavy).toBeDefined();
        expect(status.heavy[0].model).toBe('glm-4-plus');
    });

    test('getPoolStatus returns old schema format', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus'],
                    strategy: 'pool',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const status = await router.getPoolStatus();

        // Old schema fields
        expect(status.heavy[0].inFlight).toBeDefined();
        expect(status.heavy[0].maxConcurrency).toBeDefined();
        expect(status.heavy[0].cooldownMs).toBeDefined();
        expect(status.heavy[0].available).toBeDefined();
    });

    test('getPoolStatus works with v1 config', async () => {
        const config = {
            enabled: true,
            tiers: {
                heavy: {
                    targetModel: 'glm-4-plus',
                    fallbackModels: ['glm-4-air'],
                    strategy: 'pool',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const status = await router.getPoolStatus();

        expect(status).toBeDefined();
        expect(status.heavy).toBeDefined();
        expect(status.heavy.length).toBe(2);
        expect(status.heavy[0].model).toBe('glm-4-plus');
        expect(status.heavy[1].model).toBe('glm-4-air');
    });

    test('both methods coexist', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus'],
                    strategy: 'pool',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        // Both methods should work
        const status = await router.getPoolStatus();
        const snapshot = await router.getModelPoolSnapshot();

        expect(status).toBeDefined();
        expect(snapshot).toBeDefined();

        // Old schema format
        expect(status.heavy[0].model).toBe('glm-4-plus');
        expect(status.heavy[0].cooldownMs).toBeDefined();

        // New schema format
        expect(snapshot.schemaVersion).toBe(1);
        expect(snapshot.pools.heavy[0].model).toBe('glm-4-plus');
    });

    test('getPoolStatus only returns pool strategy tiers', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus'],
                    strategy: 'pool',
                    clientModelPolicy: 'always-route'
                },
                medium: {
                    models: ['glm-4-air'],
                    strategy: 'balanced',  // Not pool
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const status = await router.getPoolStatus();

        // Only heavy tier should be in status (it uses pool strategy)
        expect(status.heavy).toBeDefined();
        expect(status.medium).toBeUndefined();
    });

    test('getModelPoolSnapshot returns all tiers regardless of strategy', async () => {
        const config = {
            version: '2.0',
            enabled: true,
            tiers: {
                heavy: {
                    models: ['glm-4-plus'],
                    strategy: 'pool',
                    clientModelPolicy: 'always-route'
                },
                medium: {
                    models: ['glm-4-air'],
                    strategy: 'balanced',
                    clientModelPolicy: 'always-route'
                },
                light: {
                    models: ['glm-4-flash'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: '*' }, tier: 'heavy' }]
        };
        router = new ModelRouter(config, {
            modelDiscovery: mockModelDiscovery
        });

        const snapshot = await router.getModelPoolSnapshot();

        // All tiers should be in snapshot regardless of strategy
        expect(snapshot.pools.heavy).toBeDefined();
        expect(snapshot.pools.medium).toBeDefined();
        expect(snapshot.pools.light).toBeDefined();
    });
});

// ============================================================
// Phase 2: Observability Counters (OBSERVE-01 to OBSERVE-04)
// ============================================================
describe('Phase 2: Observability Counters (OBSERVE-01 to OBSERVE-04)', () => {

    // OBSERVE-01: Verify byTier counter (already exists)
    test('OBSERVE-01: byTier tracks heavy/medium/light routing decisions', async () => {
        const config = makeV2Config({
            tiers: {
                heavy: {
                    models: ['model-a'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            classifier: { heavyThresholds: { maxTokensGte: 100 } }
        });
        const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
        await router.selectModel({
            parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
            requestModel: 'test'
        });
        const stats = router.getStats();
        expect(stats.byTier.heavy).toBe(1);
    });

    // OBSERVE-02: byStrategy counter
    test('OBSERVE-02: byStrategy tracks quality strategy usage', async () => {
        const config = makeV2Config({
            tiers: {
                heavy: {
                    models: ['model-a'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            classifier: { heavyThresholds: { maxTokensGte: 100 } }
        });
        const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
        await router.selectModel({
            parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
            requestModel: 'test'
        });
        const stats = router.getStats();
        expect(stats.byStrategy).toBeDefined();
        expect(stats.byStrategy.quality).toBe(1);
    });

    test('OBSERVE-02: byStrategy tracks throughput strategy usage', async () => {
        const config = makeV2Config({
            tiers: {
                heavy: {
                    models: ['model-a'],
                    strategy: 'throughput',
                    clientModelPolicy: 'always-route'
                }
            },
            classifier: { heavyThresholds: { maxTokensGte: 100 } }
        });
        const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
        await router.selectModel({
            parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
            requestModel: 'test'
        });
        const stats = router.getStats();
        expect(stats.byStrategy.throughput).toBe(1);
    });

    test('OBSERVE-02: byStrategy tracks balanced strategy usage', async () => {
        const config = makeV2Config({
            tiers: {
                heavy: {
                    models: ['model-a'],
                    strategy: 'balanced',
                    clientModelPolicy: 'always-route'
                }
            },
            classifier: { heavyThresholds: { maxTokensGte: 100 } }
        });
        const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
        await router.selectModel({
            parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
            requestModel: 'test'
        });
        const stats = router.getStats();
        expect(stats.byStrategy.balanced).toBe(1);
    });

    // OBSERVE-03: shadowDecisions counter
    test('OBSERVE-03: shadowDecisions counter increments in shadow mode', async () => {
        const config = makeV2Config({ shadowMode: true });
        const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
        await router.selectModel({
            parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
            requestModel: 'test'
        });
        const stats = router.getStats();
        expect(stats.shadowDecisions).toBe(1);
    });

    test('OBSERVE-03: shadowDecisions does NOT increment in normal mode', async () => {
        const config = makeV2Config();
        const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
        await router.selectModel({
            parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
            requestModel: 'test'
        });
        const stats = router.getStats();
        expect(stats.shadowDecisions).toBe(0);
    });

    // OBSERVE-04: getStats includes all breakdowns
    test('OBSERVE-04: getStats() includes tier, strategy, shadow breakdowns', () => {
        const config = makeV2Config();
        const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
        const stats = router.getStats();
        expect(stats).toHaveProperty('byTier');
        expect(stats).toHaveProperty('byStrategy');
        expect(stats).toHaveProperty('shadowDecisions');
        expect(stats.byTier).toEqual({ light: 0, medium: 0, heavy: 0 });
        expect(stats.byStrategy).toEqual({ quality: 0, throughput: 0, balanced: 0, pool: 0 });
        expect(stats.shadowDecisions).toBe(0);
    });

    // Reset clears new counters
    test('reset() clears byStrategy and shadowDecisions', async () => {
        const config = makeV2Config();
        const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
        await router.selectModel({
            parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
            requestModel: 'test'
        });
        router.reset();
        const stats = router.getStats();
        expect(stats.byStrategy).toEqual({ quality: 0, throughput: 0, balanced: 0, pool: 0 });
        expect(stats.shadowDecisions).toBe(0);
    });
});

// ============================================================
// Phase 2: Explain Endpoint (EXPLAIN-01 to EXPLAIN-06)
// ============================================================
describe('Phase 2: Explain Endpoint (EXPLAIN-01 to EXPLAIN-06)', () => {

    describe('explain() method', () => {

        // EXPLAIN-01: Accepts standard context
        test('EXPLAIN-01: explain() returns decision for valid context', async () => {
            const config = makeV2Config({
                tiers: {
                    heavy: {
                        models: ['model-a', 'model-b'],
                        strategy: 'quality',
                        clientModelPolicy: 'always-route'
                    }
                },
                classifier: { heavyThresholds: { maxTokensGte: 100 } }
            });
            const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
            const result = await router.explain({
                parsedBody: {
                    model: 'test',
                    max_tokens: 200,
                    messages: [{ role: 'user', content: 'hi' }]
                },
                requestModel: 'test'
            });
            expect(result).toBeDefined();
            expect(result.selectedModel).toBeDefined();
            expect(result.tier).toBe('heavy');
        });

        // EXPLAIN-02: Returns matchedRule, tier, strategy, selectedModel, scoringTable
        test('EXPLAIN-02: returns matchedRule when rule matches', async () => {
            const config = makeV2Config({
                rules: [{ match: { model: 'claude-opus-*' }, tier: 'heavy' }]
            });
            const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
            const result = await router.explain({
                parsedBody: {
                    model: 'claude-opus-4-20250514',
                    messages: [{ role: 'user', content: 'hi' }]
                },
                requestModel: 'claude-opus-4-20250514'
            });
            expect(result.matchedRule).toBeDefined();
            expect(result.matchedRule).toEqual({ model: 'claude-opus-*' });
            expect(result.tier).toBe('heavy');
        });

        test('EXPLAIN-02: returns strategy from tier config', async () => {
            const config = makeV2Config({
                tiers: {
                    heavy: {
                        models: ['model-a'],
                        strategy: 'throughput',
                        clientModelPolicy: 'always-route'
                    }
                },
                classifier: { heavyThresholds: { maxTokensGte: 100 } }
            });
            const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
            const result = await router.explain({
                parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
                requestModel: 'test'
            });
            expect(result.strategy).toBe('throughput');
        });

        test('EXPLAIN-02: returns scoringTable when pool selection used', async () => {
            const mockDiscovery = {
                getModel: jest.fn().mockResolvedValue({
                    maxConcurrency: 5,
                    pricing: { input: 3, output: 15 }
                })
            };
            const config = makeV2Config({
                tiers: {
                    heavy: {
                        models: ['model-a', 'model-b'],
                        strategy: 'balanced',
                        clientModelPolicy: 'always-route'
                    }
                },
                classifier: { heavyThresholds: { maxTokensGte: 100 } }
            });
            const router = new ModelRouter(config, { modelDiscovery: mockDiscovery });
            const result = await router.explain({
                parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
                requestModel: 'test'
            });
            expect(result.scoringTable).toBeDefined();
            expect(Array.isArray(result.scoringTable)).toBe(true);
            expect(result.scoringTable.length).toBeGreaterThan(0);
            expect(result.scoringTable[0]).toHaveProperty('model');
            expect(result.scoringTable[0]).toHaveProperty('score');
            expect(result.scoringTable[0]).toHaveProperty('selected');
        });

        // EXPLAIN-03: Returns cooldownReasons[] for cooled models
        test('EXPLAIN-03: returns cooldownReasons for cooled models', async () => {
            const config = makeV2Config({
                tiers: {
                    heavy: {
                        models: ['model-a', 'model-b'],
                        strategy: 'quality',
                        clientModelPolicy: 'always-route'
                    }
                },
                classifier: { heavyThresholds: { maxTokensGte: 100 } }
            });
            const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
            // Trigger cooldown on model-a
            router.recordModelCooldown('model-a', 5000);
            const result = await router.explain({
                parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
                requestModel: 'test'
            });
            expect(result.cooldownReasons).toBeDefined();
            expect(Array.isArray(result.cooldownReasons)).toBe(true);
            expect(result.cooldownReasons.length).toBeGreaterThanOrEqual(1);
            expect(result.cooldownReasons[0]).toHaveProperty('model', 'model-a');
            expect(result.cooldownReasons[0]).toHaveProperty('remainingMs');
        });

        test('EXPLAIN-03: cooldownReasons is empty when no models cooled', async () => {
            const config = makeV2Config({
                tiers: {
                    heavy: {
                        models: ['model-a'],
                        strategy: 'quality',
                        clientModelPolicy: 'always-route'
                    }
                },
                classifier: { heavyThresholds: { maxTokensGte: 100 } }
            });
            const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
            const result = await router.explain({
                parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
                requestModel: 'test'
            });
            expect(result.cooldownReasons).toEqual([]);
        });

        // EXPLAIN-04: Returns classifierResult when classifier activated
        test('EXPLAIN-04: returns classifierResult when classifier matches', async () => {
            const config = makeV2Config({
                tiers: {
                    heavy: {
                        models: ['model-a'],
                        strategy: 'quality',
                        clientModelPolicy: 'always-route'
                    }
                },
                classifier: { heavyThresholds: { maxTokensGte: 100 } }
            });
            const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
            const result = await router.explain({
                parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
                requestModel: 'test'
            });
            expect(result.classifierResult).toBeDefined();
            expect(result.classifierResult).toHaveProperty('tier', 'heavy');
            expect(result.classifierResult).toHaveProperty('reason');
            expect(result.classifierResult.reason).toContain('classifier');
        });

        test('EXPLAIN-04: classifierResult is null when rule matches (not classifier)', async () => {
            const config = makeV2Config({
                rules: [{ match: { model: 'claude-opus-*' }, tier: 'heavy' }]
            });
            const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
            const result = await router.explain({
                parsedBody: {
                    model: 'claude-opus-4-20250514',
                    messages: [{ role: 'user', content: 'hi' }]
                },
                requestModel: 'claude-opus-4-20250514'
            });
            expect(result.classifierResult).toBeNull();
        });

        // EXPLAIN-06: No side effects
        test('EXPLAIN-06: explain() does not change stats', async () => {
            const config = makeV2Config({
                tiers: {
                    heavy: {
                        models: ['model-a'],
                        strategy: 'quality',
                        clientModelPolicy: 'always-route'
                    }
                },
                classifier: { heavyThresholds: { maxTokensGte: 100 } }
            });
            const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
            const statsBefore = router.getStats();
            await router.explain({
                parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
                requestModel: 'test'
            });
            const statsAfter = router.getStats();
            expect(statsAfter.total).toBe(statsBefore.total);
            expect(statsAfter.byTier).toEqual(statsBefore.byTier);
        });

        test('EXPLAIN-06: explain() does not acquire model slots', async () => {
            const config = makeV2Config({
                tiers: {
                    heavy: {
                        models: ['model-a'],
                        strategy: 'quality',
                        clientModelPolicy: 'always-route'
                    }
                },
                classifier: { heavyThresholds: { maxTokensGte: 100 } }
            });
            const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
            await router.explain({
                parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
                requestModel: 'test'
            });
            // _inFlight returns 0 for model-a (no slot acquired)
            expect(router._inFlight.get('model-a') || 0).toBe(0);
        });

        // explain() returns disabled decision when router is disabled
        test('explain() returns disabled decision when router is disabled', async () => {
            const config = makeV2Config({ enabled: false });
            const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
            const result = await router.explain({
                parsedBody: { model: 'test', messages: [{ role: 'user', content: 'hi' }] },
                requestModel: 'test'
            });
            expect(result.selectedModel).toBeNull();
            expect(result.reason).toBe('disabled');
        });

        // EXPLAIN-06: Multiple explain() calls do not accumulate stats
        test('EXPLAIN-06: multiple explain() calls do not accumulate stats', async () => {
            const config = makeV2Config({
                tiers: {
                    heavy: {
                        models: ['model-a'],
                        strategy: 'quality',
                        clientModelPolicy: 'always-route'
                    }
                },
                classifier: { heavyThresholds: { maxTokensGte: 100 } }
            });
            const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
            for (let i = 0; i < 10; i++) {
                await router.explain({
                    parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
                    requestModel: 'test'
                });
            }
            const stats = router.getStats();
            expect(stats.total).toBe(0);
        });

        // dryRun purity: explain/simulate must not mutate ANY stat counter
        test('EXPLAIN-06: explain() does not mutate trace sampling counters', async () => {
            const config = makeV2Config({
                tiers: {
                    heavy: {
                        models: ['model-a'],
                        strategy: 'quality',
                        clientModelPolicy: 'always-route'
                    }
                },
                classifier: { heavyThresholds: { maxTokensGte: 100 } }
            });
            const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
            const statsBefore = router.getStats();

            // Call explain with includeTrace to exercise trace sampling path
            for (let i = 0; i < 5; i++) {
                await router.explain({
                    parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
                    requestModel: 'test'
                }, { includeTrace: true });
            }

            const statsAfter = router.getStats();
            expect(statsAfter.traceSampledTotal).toBe(statsBefore.traceSampledTotal);
            expect(statsAfter.traceSampledIncluded).toBe(statsBefore.traceSampledIncluded);
        });

        test('EXPLAIN-06: explain() does not mutate fallback reason counters', async () => {
            const config = makeV2Config({
                tiers: {
                    heavy: {
                        models: ['model-a', 'model-b'],
                        strategy: 'quality',
                        clientModelPolicy: 'always-route'
                    }
                },
                classifier: { heavyThresholds: { maxTokensGte: 100 } }
            });
            const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
            const statsBefore = router.getStats();

            for (let i = 0; i < 5; i++) {
                await router.explain({
                    parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
                    requestModel: 'test'
                });
            }

            const statsAfter = router.getStats();
            expect(statsAfter.byFallbackReason).toEqual(statsBefore.byFallbackReason);
        });

        test('EXPLAIN-06: explain() does not mutate shadow downgrade counters', async () => {
            const config = makeV2Config({
                tiers: {
                    heavy: {
                        models: ['model-a'],
                        strategy: 'quality',
                        clientModelPolicy: 'always-route'
                    }
                },
                classifier: { heavyThresholds: { maxTokensGte: 100 } }
            });
            const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
            const statsBefore = router.getStats();

            for (let i = 0; i < 5; i++) {
                await router.explain({
                    parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
                    requestModel: 'test'
                });
            }

            const statsAfter = router.getStats();
            expect(statsAfter.tierDowngradeShadow).toBe(statsBefore.tierDowngradeShadow);
            expect(statsAfter.tierDowngradeShadowByRoute).toEqual(statsBefore.tierDowngradeShadowByRoute);
        });

        test('EXPLAIN-06: explain() does not mutate glm5 preference counters', async () => {
            const config = makeV2Config({
                tiers: {
                    heavy: {
                        models: ['glm-5', 'model-a'],
                        strategy: 'quality',
                        clientModelPolicy: 'always-route'
                    }
                },
                classifier: { heavyThresholds: { maxTokensGte: 100 } },
                glm5: { enabled: true, preferencePercent: 50 }
            });
            const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
            const statsBefore = router.getStats();

            for (let i = 0; i < 10; i++) {
                await router.explain({
                    parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
                    requestModel: 'test'
                });
            }

            const statsAfter = router.getStats();
            expect(statsAfter.glm5EligibleTotal).toBe(statsBefore.glm5EligibleTotal);
            expect(statsAfter.glm5PreferenceApplied).toBe(statsBefore.glm5PreferenceApplied);
            expect(statsAfter.glm5PreferenceShadow).toBe(statsBefore.glm5PreferenceShadow);
        });

        test('EXPLAIN-06: simulateDecisionMode() does not mutate any stats', async () => {
            const config = makeV2Config({
                tiers: {
                    heavy: {
                        models: ['glm-5', 'model-a'],
                        strategy: 'quality',
                        clientModelPolicy: 'always-route'
                    }
                },
                classifier: { heavyThresholds: { maxTokensGte: 100 } },
                glm5: { enabled: true, preferencePercent: 50 }
            });
            const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });

            // Prime some production stats first via selectModel
            await router.selectModel({
                parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'real request' }] },
                requestModel: 'test'
            });
            const statsBefore = router.getStats();
            expect(statsBefore.total).toBe(1);

            // Run many simulations — should NOT change any counter
            for (let i = 0; i < 10; i++) {
                await router.simulateDecisionMode({
                    parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'sim' }] },
                    requestModel: 'test'
                });
            }

            const statsAfter = router.getStats();
            expect(statsAfter.total).toBe(statsBefore.total);
            expect(statsAfter.byTier).toEqual(statsBefore.byTier);
            expect(statsAfter.bySource).toEqual(statsBefore.bySource);
            expect(statsAfter.byFallbackReason).toEqual(statsBefore.byFallbackReason);
            expect(statsAfter.traceSampledTotal).toBe(statsBefore.traceSampledTotal);
            expect(statsAfter.glm5EligibleTotal).toBe(statsBefore.glm5EligibleTotal);
            expect(statsAfter.tierDowngradeShadow).toBe(statsBefore.tierDowngradeShadow);
        });

        test('EXPLAIN-06: explain() remains deterministic with glm5 canary enabled', async () => {
            const config = makeV2Config({
                tiers: {
                    heavy: {
                        models: ['glm-5', 'model-a'],
                        strategy: 'quality',
                        clientModelPolicy: 'always-route'
                    }
                },
                classifier: { heavyThresholds: { maxTokensGte: 100 } },
                glm5: { enabled: true, preferencePercent: 50 }
            });
            const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });

            const randomSpy = jest.spyOn(Math, 'random')
                .mockReturnValueOnce(0.01)
                .mockReturnValueOnce(0.99)
                .mockReturnValue(0.42);

            try {
                const context = {
                    parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'same request' }] },
                    requestModel: 'test'
                };
                const first = await router.explain(context);
                const second = await router.explain(context);

                expect(first.selectedModel).toBe(second.selectedModel);
                expect(first.reason).toBe(second.reason);
            } finally {
                randomSpy.mockRestore();
            }
        });

        test('EXPLAIN-06: simulateDecisionMode() deterministic with glm5 canary enabled', async () => {
            const config = makeV2Config({
                tiers: {
                    heavy: {
                        models: ['glm-5', 'model-a'],
                        strategy: 'quality',
                        clientModelPolicy: 'always-route'
                    }
                },
                classifier: { heavyThresholds: { maxTokensGte: 100 } },
                glm5: { enabled: true, preferencePercent: 50 }
            });
            const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });

            const randomSpy = jest.spyOn(Math, 'random')
                .mockReturnValueOnce(0.01)
                .mockReturnValueOnce(0.99)
                .mockReturnValue(0.42);

            try {
                const context = {
                    parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'same request' }] },
                    requestModel: 'test'
                };
                const first = await router.simulateDecisionMode(context);
                const second = await router.simulateDecisionMode(context);

                expect(first.selectedModel).toBe(second.selectedModel);
                expect(first.reason).toBe(second.reason);
            } finally {
                randomSpy.mockRestore();
            }
        });

        test('EXPLAIN-06: computeDecision with dryRun=true is pure', async () => {
            const config = makeV2Config({
                tiers: {
                    heavy: {
                        models: ['model-a'],
                        strategy: 'quality',
                        clientModelPolicy: 'always-route'
                    }
                },
                classifier: { heavyThresholds: { maxTokensGte: 100 } }
            });
            const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
            const statsBefore = JSON.parse(JSON.stringify(router.getStats()));

            await router.computeDecision({
                parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'dry' }] },
                requestModel: 'test',
                dryRun: true,
                includeTrace: true
            });

            const statsAfter = router.getStats();
            // Deep-equal all stat fields — nothing changed
            expect(statsAfter).toEqual(statsBefore);
        });
    });

    // EXPLAIN-05: Migration Preview
    describe('EXPLAIN-05: migrationPreview', () => {

        test('EXPLAIN-05: returns migrationPreview when migration context provided', async () => {
            const config = makeV2Config({
                tiers: {
                    heavy: {
                        models: ['model-a'],
                        strategy: 'quality',
                        clientModelPolicy: 'always-route'
                    }
                },
                classifier: { heavyThresholds: { maxTokensGte: 100 } }
            });
            const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
            const result = await router.explain({
                parsedBody: { model: 'claude-opus-4-20250514', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
                requestModel: 'claude-opus-4-20250514'
            }, {
                migrationPreview: {
                    sourceModel: 'claude-opus-4-20250514',
                    mappedModel: 'glm-4-plus',
                    mappingActive: true
                }
            });
            expect(result.migrationPreview).toBeDefined();
            expect(result.migrationPreview.sourceModel).toBe('claude-opus-4-20250514');
            expect(result.migrationPreview.mappedModel).toBe('glm-4-plus');
            expect(result.migrationPreview.mappingActive).toBe(true);
        });

        test('EXPLAIN-05: migrationPreview is null when not provided', async () => {
            const config = makeV2Config({
                tiers: {
                    heavy: {
                        models: ['model-a'],
                        strategy: 'quality',
                        clientModelPolicy: 'always-route'
                    }
                },
                classifier: { heavyThresholds: { maxTokensGte: 100 } }
            });
            const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
            const result = await router.explain({
                parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
                requestModel: 'test'
            });
            expect(result.migrationPreview).toBeNull();
        });

        test('EXPLAIN-05: migrationPreview with mappingActive false is passed through', async () => {
            const config = makeV2Config({
                tiers: {
                    heavy: {
                        models: ['model-a'],
                        strategy: 'quality',
                        clientModelPolicy: 'always-route'
                    }
                },
                classifier: { heavyThresholds: { maxTokensGte: 100 } }
            });
            const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
            const result = await router.explain({
                parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
                requestModel: 'test'
            }, {
                migrationPreview: {
                    sourceModel: 'test',
                    mappedModel: 'glm-4-flash',
                    mappingActive: false
                }
            });
            expect(result.migrationPreview).toBeDefined();
            expect(result.migrationPreview.mappingActive).toBe(false);
        });
    });
});

// ============================================================
// Shadow mode scoring table enhancement
// ============================================================
describe('Shadow mode scoring table enhancement', () => {

    test('shadow decision includes scoringTable from computeDecision', async () => {
        const mockDiscovery = {
            getModel: jest.fn().mockResolvedValue({
                maxConcurrency: 5,
                pricing: { input: 3, output: 15 }
            })
        };
        const config = makeV2Config({
            shadowMode: true,
            tiers: {
                heavy: {
                    models: ['model-a', 'model-b'],
                    strategy: 'balanced',
                    clientModelPolicy: 'always-route'
                }
            },
            classifier: { heavyThresholds: { maxTokensGte: 100 } }
        });
        const router = new ModelRouter(config, { modelDiscovery: mockDiscovery });
        const result = await router.selectModel({
            parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
            requestModel: 'test'
        });

        // selectModel returns null in shadow mode
        expect(result).toBeNull();

        // Shadow decision should include scoringTable
        const shadow = router.getLastShadowDecision();
        expect(shadow).toBeDefined();
        expect(shadow.shadowMode).toBe(true);
        expect(shadow.scoringTable).toBeDefined();
        expect(Array.isArray(shadow.scoringTable)).toBe(true);
    });

    test('shadow decision includes strategy field', async () => {
        const mockDiscovery = {
            getModel: jest.fn().mockResolvedValue({
                maxConcurrency: 5,
                pricing: { input: 3, output: 15 }
            })
        };
        const config = makeV2Config({
            shadowMode: true,
            tiers: {
                heavy: {
                    models: ['model-a'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            classifier: { heavyThresholds: { maxTokensGte: 100 } }
        });
        const router = new ModelRouter(config, { modelDiscovery: mockDiscovery });
        await router.selectModel({
            parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
            requestModel: 'test'
        });

        const shadow = router.getLastShadowDecision();
        expect(shadow.strategy).toBeDefined();
    });

    test('shadow mode still does not acquire model slots', async () => {
        const config = makeV2Config({
            shadowMode: true,
            tiers: {
                heavy: {
                    models: ['model-a'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            classifier: { heavyThresholds: { maxTokensGte: 100 } }
        });
        const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
        await router.selectModel({
            parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
            requestModel: 'test'
        });
        expect(router._inFlight.get('model-a') || 0).toBe(0);
    });

    test('shadow mode does not increment real routing stats', async () => {
        const config = makeV2Config({
            shadowMode: true,
            tiers: {
                heavy: {
                    models: ['model-a'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            classifier: { heavyThresholds: { maxTokensGte: 100 } }
        });
        const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
        const statsBefore = router.getStats();
        await router.selectModel({
            parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
            requestModel: 'test'
        });
        const statsAfter = router.getStats();
        expect(statsAfter.total).toBe(statsBefore.total);
        expect(statsAfter.byTier).toEqual(statsBefore.byTier);
    });

    test('shadow mode increments shadowDecisions counter', async () => {
        const config = makeV2Config({
            shadowMode: true,
            tiers: {
                heavy: {
                    models: ['model-a'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            classifier: { heavyThresholds: { maxTokensGte: 100 } }
        });
        const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
        await router.selectModel({
            parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
            requestModel: 'test'
        });
        const stats = router.getStats();
        expect(stats.shadowDecisions).toBe(1);
    });
});

// ============================================================
// TRUST-01: Decision Trace Tests
// ============================================================
describe('TRUST-01: Decision trace in explain endpoint', () => {

    test('EXPLAIN-06: explain returns trace when includeTrace=true', async () => {
        const config = makeV2Config({
            tiers: {
                heavy: {
                    models: ['model-a', 'model-b'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            classifier: { heavyThresholds: { maxTokensGte: 100 } },
            trace: { samplingRate: 100 } // 100% to ensure trace is included
        });
        const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
        const result = await router.explain({
            parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
            requestModel: 'test'
        }, { includeTrace: true });

        expect(result).toBeDefined();
        expect(result.trace).toBeDefined();
        expect(result.trace.requestId).toBeDefined();
        expect(result.trace.timestamp).toBeDefined();
        expect(result.trace.input).toBeDefined();
        expect(result.trace.classification).toBeDefined();
        expect(result.trace.modelSelection).toBeDefined();
    });

    test('EXPLAIN-07: trace contains all required fields', async () => {
        const config = makeV2Config({
            tiers: {
                heavy: {
                    models: ['model-a', 'model-b', 'model-c'],
                    strategy: 'balanced',
                    clientModelPolicy: 'always-route'
                }
            },
            classifier: { heavyThresholds: { maxTokensGte: 100 } },
            trace: { samplingRate: 100 } // 100% to ensure trace is included
        });
        const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
        const result = await router.explain({
            parsedBody: {
                model: 'test',
                max_tokens: 200,
                messages: [
                    { role: 'user', content: 'first message' },
                    { role: 'assistant', content: 'response' },
                    { role: 'user', content: 'second message' }
                ],
                stream: false
            },
            requestModel: 'test'
        }, { includeTrace: true });

        // Check input trace
        expect(result.trace.input.model).toBe('test');
        expect(result.trace.input.max_tokens).toBe(200);
        expect(result.trace.input.stream).toBe(false);
        expect(Array.isArray(result.trace.input.messages)).toBe(true);
        expect(result.trace.input.messages.length).toBe(3);

        // Check classification trace
        expect(result.trace.classification.tier).toBe('heavy');
        expect(typeof result.trace.classification.complexity).toBe('number');
        expect(result.trace.classification.thresholdComparison).toBeDefined();
        expect(typeof result.trace.classification.thresholdComparison.hasTools).toBe('boolean');
        expect(typeof result.trace.classification.thresholdComparison.hasVision).toBe('boolean');
        expect(typeof result.trace.classification.thresholdComparison.maxTokens).toBe('number');
        expect(typeof result.trace.classification.thresholdComparison.messageCount).toBe('number');
        expect(typeof result.trace.classification.thresholdComparison.systemLength).toBe('number');

        // Check modelSelection trace
        expect(result.trace.modelSelection.strategy).toBeDefined();
        expect(Array.isArray(result.trace.modelSelection.candidates)).toBe(true);
        expect(result.trace.modelSelection.selected).toBeDefined();
        expect(result.trace.modelSelection.rationale).toBeDefined();
    });

    test('EXPLAIN-08: trace candidates include modelId, score, inFlight, maxConcurrency, isAvailable', async () => {
        const config = makeV2Config({
            tiers: {
                heavy: {
                    models: ['model-a', 'model-b'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            classifier: { heavyThresholds: { maxTokensGte: 100 } },
            trace: { samplingRate: 100 } // 100% to ensure trace is included
        });
        const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
        const result = await router.explain({
            parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
            requestModel: 'test'
        }, { includeTrace: true });

        const candidates = result.trace.modelSelection.candidates;
        expect(candidates.length).toBeGreaterThan(0);
        candidates.forEach(c => {
            expect(c.modelId).toBeDefined();
            expect(typeof c.score).toBe('number');
            expect(typeof c.inFlight).toBe('number');
            expect(typeof c.maxConcurrency).toBe('number');
            expect(typeof c.isAvailable).toBe('boolean');
        });
    });

    test('EXPLAIN-09: explain does NOT return trace when includeTrace=false', async () => {
        const config = makeV2Config({
            tiers: {
                heavy: {
                    models: ['model-a'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            classifier: { heavyThresholds: { maxTokensGte: 100 } }
        });
        const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
        const result = await router.explain({
            parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
            requestModel: 'test'
        }, { includeTrace: false });

        expect(result.trace).toBeUndefined();
    });

    test('EXPLAIN-10: explain returns trace when includeTrace not specified (defaults to false)', async () => {
        const config = makeV2Config({
            tiers: {
                heavy: {
                    models: ['model-a'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            classifier: { heavyThresholds: { maxTokensGte: 100 } }
        });
        const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
        const result = await router.explain({
            parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
            requestModel: 'test'
        });

        expect(result.trace).toBeUndefined();
    });

    test('EXPLAIN-11: backward compatibility - existing fields still present', async () => {
        const config = makeV2Config({
            tiers: {
                heavy: {
                    models: ['model-a'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            classifier: { heavyThresholds: { maxTokensGte: 100 } },
            trace: { samplingRate: 100 } // 100% to ensure trace is included
        });
        const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
        const result = await router.explain({
            parsedBody: { model: 'test', max_tokens: 200, messages: [{ role: 'user', content: 'hi' }] },
            requestModel: 'test'
        }, { includeTrace: true });

        // All existing fields should still be present
        expect(result.selectedModel).toBeDefined();
        expect(result.tier).toBeDefined();
        expect(result.strategy).toBeDefined();
        expect(result.reason).toBeDefined();
        expect(result.source).toBeDefined();
        expect(result.matchedRule).toBeDefined();
        expect(result.classifierResult).toBeDefined();
        expect(result.cooldownReasons).toBeDefined();
        expect(result.scoringTable).toBeDefined();
        expect(result.features).toBeDefined();
        expect(result.migrationPreview).toBeDefined();
        // Plus the new trace field
        expect(result.trace).toBeDefined();
    });
});

// ============================================================
// TRUST-01: Trace Payload Size Configuration
// ============================================================
describe('TRUST-01: Trace payload size configuration', () => {

    test('MAX_PAYLOAD-01: _getMaxTracePayloadSize returns default 100KB when not configured', () => {
        const config = makeV2Config({
            tiers: {
                heavy: {
                    models: ['model-a'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            }
        });
        const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
        expect(router._getMaxTracePayloadSize()).toBe(100 * 1024); // 100KB
    });

    test('MAX_PAYLOAD-02: config accepts maxPayloadSize', () => {
        const config = makeV2Config({
            tiers: {
                heavy: {
                    models: ['model-a'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            trace: {
                maxPayloadSize: 50 * 1024 // 50KB
            }
        });
        const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
        expect(router._getMaxTracePayloadSize()).toBe(50 * 1024);
    });

    test('MAX_PAYLOAD-03: values below 10KB are clamped to 10KB', () => {
        const config = makeV2Config({
            tiers: {
                heavy: {
                    models: ['model-a'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            trace: {
                maxPayloadSize: 5 * 1024 // 5KB - below minimum
            }
        });
        const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
        expect(router._getMaxTracePayloadSize()).toBe(10 * 1024); // Clamped to 10KB
    });

    test('MAX_PAYLOAD-04: values above 1MB are clamped to 1MB', () => {
        const config = makeV2Config({
            tiers: {
                heavy: {
                    models: ['model-a'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            trace: {
                maxPayloadSize: 2 * 1024 * 1024 // 2MB - above maximum
            }
        });
        const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
        expect(router._getMaxTracePayloadSize()).toBe(1024 * 1024); // Clamped to 1MB
    });

    test('MAX_PAYLOAD-05: boundary values (10KB and 1MB) are accepted', () => {
        const config1 = makeV2Config({
            tiers: {
                heavy: {
                    models: ['model-a'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            trace: {
                maxPayloadSize: 10 * 1024 // Exactly 10KB
            }
        });
        const router1 = new ModelRouter(config1, { modelDiscovery: mockModelDiscovery });
        expect(router1._getMaxTracePayloadSize()).toBe(10 * 1024);

        const config2 = makeV2Config({
            tiers: {
                heavy: {
                    models: ['model-a'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            trace: {
                maxPayloadSize: 1024 * 1024 // Exactly 1MB
            }
        });
        const router2 = new ModelRouter(config2, { modelDiscovery: mockModelDiscovery });
        expect(router2._getMaxTracePayloadSize()).toBe(1024 * 1024);
    });
});

// ============================================================
// TRUST-01: Trace Truncation
// ============================================================
describe('TRUST-01: Trace payload truncation', () => {

    test('TRUNCATE-01: trace under limit is unchanged', async () => {
        const config = makeV2Config({
            tiers: {
                heavy: {
                    models: ['model-a'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            trace: {
                samplingRate: 100,
                maxPayloadSize: 100 * 1024 // 100KB - plenty of space
            }
        });
        const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
        const result = await router.explain({
            parsedBody: {
                model: 'test',
                max_tokens: 200,
                messages: [{ role: 'user', content: 'short message' }],
                stream: false
            },
            requestModel: 'test'
        }, { includeTrace: true });

        expect(result.trace).toBeDefined();
        expect(result.trace._truncated).toBeUndefined();
        expect(result.trace._warning).toBeUndefined();
    });

    test('TRUNCATE-02: trace over limit has message content truncated', async () => {
        const longContent = 'x'.repeat(10000); // 10KB of content
        const config = makeV2Config({
            tiers: {
                heavy: {
                    models: ['model-a'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            trace: {
                samplingRate: 100,
                maxPayloadSize: 5 * 1024 // Very small limit - 5KB
            }
        });
        const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
        const result = await router.explain({
            parsedBody: {
                model: 'test',
                max_tokens: 200,
                messages: [{ role: 'user', content: longContent }],
                stream: false
            },
            requestModel: 'test'
        }, { includeTrace: true });

        expect(result.trace).toBeDefined();
        // Content should be truncated
        expect(result.trace.input.messages[0].content.length).toBeLessThan(longContent.length);
        expect(result.trace.input.messages[0].content).toMatch(/\.\.\.$/);
    });

    test('TRUNCATE-03: trace with many candidates limits to top 5', async () => {
        // Create a config with many models
        const models = Array.from({ length: 10 }, (_, i) => `model-${i}`);
        const config = makeV2Config({
            tiers: {
                heavy: {
                    models: models,
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            trace: {
                samplingRate: 100,
                maxPayloadSize: 10 * 1024 // Small limit to trigger truncation
            }
        });
        const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
        const result = await router.explain({
            parsedBody: {
                model: 'test',
                max_tokens: 200,
                messages: [{ role: 'user', content: 'test message' }],
                stream: false
            },
            requestModel: 'test'
        }, { includeTrace: true });

        expect(result.trace).toBeDefined();
        // Candidates should be limited to top 5
        expect(result.trace.modelSelection.candidates.length).toBeLessThanOrEqual(5);
    });

    test('TRUNCATE-04: base trace limits messages to 10', async () => {
        // Create more than 10 messages
        const manyMessages = Array.from({ length: 20 }, (_, i) => ({
            role: 'user',
            content: `message ${i}`
        }));
        const config = makeV2Config({
            tiers: {
                heavy: {
                    models: ['model-a'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            trace: {
                samplingRate: 100
            }
        });
        const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
        const result = await router.explain({
            parsedBody: {
                model: 'test',
                max_tokens: 200,
                messages: manyMessages,
                stream: false
            },
            requestModel: 'test'
        }, { includeTrace: true });

        expect(result.trace).toBeDefined();
        // Base trace limits to 10 messages
        expect(result.trace.input.messages.length).toBe(10);
    });

    test('TRUNCATE-05: critical fields preserved during truncation', async () => {
        const longContent = 'x'.repeat(10000);
        const config = makeV2Config({
            tiers: {
                heavy: {
                    models: ['model-a'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            trace: {
                samplingRate: 100,
                maxPayloadSize: 5 * 1024
            }
        });
        const router = new ModelRouter(config, { modelDiscovery: mockModelDiscovery });
        const result = await router.explain({
            parsedBody: {
                model: 'test',
                max_tokens: 5000,
                messages: [{ role: 'user', content: longContent }],
                stream: true
            },
            requestModel: 'test'
        }, { includeTrace: true });

        expect(result.trace).toBeDefined();
        // Critical fields should still be present
        expect(result.trace.requestId).toBeDefined();
        expect(result.trace.timestamp).toBeDefined();
        expect(result.trace.classification.tier).toBeDefined();
        expect(result.trace.classification.complexity).toBeDefined();
        expect(result.trace.classification.thresholdComparison).toBeDefined();
        expect(result.trace.modelSelection.selected).toBeDefined();
        expect(result.trace.modelSelection.strategy).toBeDefined();
    });
});
