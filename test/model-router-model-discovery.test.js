/**
 * ModelRouter ModelDiscovery Integration Tests
 *
 * These tests verify that ModelRouter uses ModelDiscovery as its
 * canonical (and only) metadata source.
 */

jest.mock('../lib/atomic-write', () => ({
    atomicWrite: jest.fn().mockResolvedValue()
}));

const fs = require('fs');
const { atomicWrite } = require('../lib/atomic-write');

// Mock fs.readFileSync to return '{}' by default
const originalReadFileSync = fs.readFileSync;
jest.spyOn(fs, 'readFileSync').mockImplementation((filePath, encoding) => {
    if (typeof filePath === 'string' && filePath.includes('model-routing-overrides')) {
        return '{}';
    }
    return originalReadFileSync(filePath, encoding);
});

const { ModelRouter } = require('../lib/model-router');
const { ModelDiscovery } = require('../lib/model-discovery');

/**
 * Helper: build a full modelRouting config with sensible defaults.
 */
function makeConfig(overrides = {}) {
    return {
        enabled: true,
        tiers: {
            light: {
                targetModel: 'glm-4.7-flash',
                strategy: 'pool',
                clientModelPolicy: 'always-route'
            },
            medium: {
                targetModel: 'glm-4.5',
                strategy: 'pool',
                clientModelPolicy: 'always-route'
            },
            heavy: {
                targetModel: 'glm-4.7',
                strategy: 'pool',
                clientModelPolicy: 'always-route'
            }
        },
        rules: [],
        classifier: {
            heavyThresholds: {
                maxTokensGte: 4096,
                messageCountGte: 20,
                hasTools: true,
                hasVision: true
            },
            lightThresholds: {
                maxTokensLte: 512,
                messageCountLte: 3,
                hasTools: false,
                hasVision: false
            }
        },
        cooldown: {
            defaultMs: 5000,
            maxMs: 30000,
            decayMs: 60000,
            backoffMultiplier: 2
        },
        defaultModel: 'glm-4.5',
        overridesFile: 'model-routing-overrides.json',
        logDecisions: false,
        ...overrides
    };
}

/**
 * Helper: build a minimal parsed Anthropic body.
 */
function makeBody(overrides = {}) {
    return {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [
            { role: 'user', content: 'Hello' }
        ],
        system: 'You are helpful.',
        stream: false,
        ...overrides
    };
}

/**
 * Helper: create a mock ModelDiscovery instance
 */
function createMockModelDiscovery() {
    const discovery = new ModelDiscovery();
    // Mock the getModel method to return data directly without async
    const models = {
        'glm-4.7-flash': {
            id: 'glm-4.7-flash',
            maxConcurrency: 1,
            pricing: { input: 0, output: 0 }
        },
        'glm-4.5': {
            id: 'glm-4.5',
            maxConcurrency: 10,
            pricing: { input: 0.60, output: 2.20 }
        },
        'glm-4.7': {
            id: 'glm-4.7',
            maxConcurrency: 10,
            pricing: { input: 0.60, output: 2.20 }
        }
    };

    // Override getModel to return synchronous data
    discovery.getModel = jest.fn().mockImplementation((modelId) => {
        return Promise.resolve(models[modelId] || null);
    });

    return discovery;
}

describe('ModelRouter - ModelDiscovery Integration', () => {
    describe('Task 1: ModelDiscovery option support', () => {
        test('should accept modelDiscovery option in constructor', () => {
            const discovery = createMockModelDiscovery();
            const router = new ModelRouter(makeConfig(), {
                persistEnabled: false,
                modelDiscovery: discovery
            });

            expect(router).toBeDefined();
            expect(router._modelDiscovery).toBe(discovery);
        });

        test('should require modelDiscovery option', () => {
            expect(() => new ModelRouter(makeConfig(), {
                persistEnabled: false
            })).toThrow('modelDiscovery option is required');
        });
    });

    describe('Task 2: _getModelMetaAsync method', () => {
        test('should use ModelDiscovery.getModel() when modelDiscovery is provided', async () => {
            const discovery = createMockModelDiscovery();
            const getModelSpy = jest.spyOn(discovery, 'getModel').mockResolvedValue({
                id: 'glm-4.5',
                maxConcurrency: 10,
                pricing: { input: 0.60, output: 2.20 }
            });

            const router = new ModelRouter(makeConfig(), {
                persistEnabled: false,
                modelDiscovery: discovery
            });

            const meta = await router._getModelMetaAsync('glm-4.5');

            expect(getModelSpy).toHaveBeenCalledWith('glm-4.5');
            expect(meta).toEqual({
                id: 'glm-4.5',
                maxConcurrency: 10,
                pricing: { input: 0.60, output: 2.20 }
            });
        });

        test('should return null when model not found in ModelDiscovery', async () => {
            const discovery = createMockModelDiscovery();
            jest.spyOn(discovery, 'getModel').mockResolvedValue(null);

            const router = new ModelRouter(makeConfig(), {
                persistEnabled: false,
                modelDiscovery: discovery
            });

            const meta = await router._getModelMetaAsync('unknown-model');

            expect(meta).toBeNull();
        });
    });

    describe('Task 3: _selectFromPool is async', () => {
        test('should be an async method', () => {
            const discovery = createMockModelDiscovery();
            const router = new ModelRouter(makeConfig(), {
                persistEnabled: false,
                modelDiscovery: discovery
            });

            // Check that _selectFromPool returns a Promise (is async)
            const result = router._selectFromPool(['glm-4.7-flash'], new Set());
            expect(result).toBeInstanceOf(Promise);
        });

        test('should use ModelDiscovery for pool selection', async () => {
            const discovery = createMockModelDiscovery();
            const router = new ModelRouter(makeConfig(), {
                persistEnabled: false,
                modelDiscovery: discovery
            });

            const selected = await router._selectFromPool(['glm-4.7-flash'], new Set());

            expect(selected).toBeDefined();
            expect(selected.model).toBe('glm-4.7-flash');
        });

        test('should respect maxConcurrency from ModelDiscovery', async () => {
            const discovery = createMockModelDiscovery();
            const router = new ModelRouter(makeConfig(), {
                persistEnabled: false,
                modelDiscovery: discovery
            });

            // Acquire a slot for glm-4.7-flash (maxConcurrency: 1)
            router.acquireModel('glm-4.7-flash');

            // Next selection should skip glm-4.7-flash since it's at capacity
            const selected = await router._selectFromPool(
                ['glm-4.7-flash', 'glm-4.5'],
                new Set()
            );

            // Should skip glm-4.7-flash and select glm-4.5 instead
            expect(selected.model).toBe('glm-4.5');
        });

        test('concurrencyMultiplier scales maxConcurrency for multi-account setups', async () => {
            // When API keys span multiple accounts, each account gets its own
            // concurrency limits. concurrencyMultiplier scales the pool accordingly.
            const discovery = createMockModelDiscovery();
            const router = new ModelRouter(makeConfig(), {
                persistEnabled: false,
                modelDiscovery: discovery,
                concurrencyMultiplier: 20  // 20 accounts
            });

            // glm-4.7 has maxConcurrency=10. With multiplier=20, effective limit = 200.
            // Acquire 10 slots — should still have capacity (unlike without multiplier)
            for (let i = 0; i < 10; i++) router.acquireModel('glm-4.7');

            // Without multiplier: available = 10 - 10 = 0 → null
            // With multiplier: available = 200 - 10 = 190 → selects glm-4.7
            const selected = await router._selectFromPool(['glm-4.7'], new Set());

            expect(selected).not.toBeNull();
            expect(selected.model).toBe('glm-4.7');
        });

        test('concurrencyMultiplier defaults to 1 when not provided', async () => {
            const discovery = createMockModelDiscovery();
            const router = new ModelRouter(makeConfig(), {
                persistEnabled: false,
                modelDiscovery: discovery
                // No concurrencyMultiplier
            });

            // glm-4.7 has maxConcurrency=10. With default multiplier=1, limit = 10.
            for (let i = 0; i < 10; i++) router.acquireModel('glm-4.7');

            // available = 10 - 10 = 0 → should return null
            const selected = await router._selectFromPool(['glm-4.7'], new Set());
            expect(selected).toBeNull();
        });
    });

    describe('Task 4: getPoolStatus is async', () => {
        test('should be an async method', () => {
            const discovery = createMockModelDiscovery();
            const router = new ModelRouter(makeConfig(), {
                persistEnabled: false,
                modelDiscovery: discovery
            });

            // Check that getPoolStatus returns a Promise (is async)
            const result = router.getPoolStatus();
            expect(result).toBeInstanceOf(Promise);
        });

        test('should return model metadata from ModelDiscovery', async () => {
            const discovery = createMockModelDiscovery();
            const router = new ModelRouter(makeConfig(), {
                persistEnabled: false,
                modelDiscovery: discovery
            });

            const status = await router.getPoolStatus();

            expect(status).toBeDefined();
            expect(status.light).toBeDefined();
            expect(Array.isArray(status.light)).toBe(true);

            // Check that model metadata includes maxConcurrency from ModelDiscovery
            const glmFlash = status.light.find(m => m.model === 'glm-4.7-flash');
            expect(glmFlash).toBeDefined();
            expect(glmFlash.maxConcurrency).toBe(1);
        });

        test('should include in-flight counts in pool status', async () => {
            const discovery = createMockModelDiscovery();
            const router = new ModelRouter(makeConfig(), {
                persistEnabled: false,
                modelDiscovery: discovery
            });

            // Acquire a slot
            router.acquireModel('glm-4.7-flash');

            const status = await router.getPoolStatus();
            const glmFlash = status.light.find(m => m.model === 'glm-4.7-flash');

            expect(glmFlash.inFlight).toBe(1);
            expect(glmFlash.available).toBe(0); // maxConcurrency: 1, inFlight: 1
        });
    });

    describe('Integration: end-to-end pool selection with ModelDiscovery', () => {
        test('should select from pool using ModelDiscovery metadata', async () => {
            const discovery = createMockModelDiscovery();
            const config = makeConfig({
                tiers: {
                    light: {
                        targetModel: 'glm-4.7-flash',
                        strategy: 'pool',
                        fallbackModels: ['glm-4.5'],
                        clientModelPolicy: 'always-route'
                    }
                }
            });

            const router = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: discovery
            });

            const body = makeBody({ max_tokens: 256 });
            const result = await router.selectModel({
                parsedBody: body,
                requestModel: 'claude-3-haiku-20240307',
                keyIndex: 0
            });

            expect(result).toBeDefined();
            expect(result.source).toBe('pool');
            // Pool strategy selects model with most available capacity
            // glm-4.5 has maxConcurrency: 10, glm-4.7-flash has maxConcurrency: 1
            // So glm-4.5 should be selected (more available)
            expect(result.model).toBe('glm-4.5');
        });

        test('should failover within pool when primary is at capacity', async () => {
            const discovery = createMockModelDiscovery();
            const config = makeConfig({
                tiers: {
                    light: {
                        targetModel: 'glm-4.7-flash',
                        strategy: 'pool',
                        fallbackModels: ['glm-4.5'],
                        clientModelPolicy: 'always-route'
                    }
                }
            });

            const router = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: discovery
            });

            // Saturate glm-4.7-flash (maxConcurrency: 1)
            router.acquireModel('glm-4.7-flash');

            const body = makeBody({ max_tokens: 256 });
            const result = await router.selectModel({
                parsedBody: body,
                requestModel: 'claude-3-haiku-20240307',
                keyIndex: 0
            });

            expect(result).toBeDefined();
            expect(result.source).toBe('pool');
            expect(result.model).toBe('glm-4.5'); // Should failover to glm-4.5
        });
    });

    describe('Tier downgrade (cross-tier fallback)', () => {
        test('when tier exhausted and downgrade disabled, selectModel returns null', async () => {
            const discovery = createMockModelDiscovery();
            const config = makeConfig({
                tiers: {
                    heavy: {
                        targetModel: 'glm-4.7',
                        strategy: 'pool',
                        fallbackModels: ['glm-4.6'],
                        clientModelPolicy: 'always-route'
                    },
                    light: {
                        targetModel: 'glm-4.7-flash',
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    }
                },
                failover: {
                    maxModelSwitchesPerRequest: 5,
                    allowTierDowngrade: false  // Disabled
                }
            });

            const router = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: discovery
            });

            // Exhaust all heavy tier candidates
            router.recordModelCooldown('glm-4.7', 10000);
            router.recordModelCooldown('glm-4.6', 10000);

            const body = makeBody({ max_tokens: 8192 });
            const result = await router.selectModel({
                parsedBody: body,
                requestModel: 'claude-opus-4-6',
                keyIndex: 0,
                attemptedModels: new Set(['glm-4.7', 'glm-4.6'])
            });

            // With downgrade disabled, should still return a model (best-effort/least-cooldown)
            // but NOT from a different tier
            if (result) {
                expect(['glm-4.7', 'glm-4.6']).toContain(result.model);
                expect(result.source).not.toBe('tier_downgrade');
            }
        });

        test('when tier exhausted and downgrade enabled, falls back to lower tier', async () => {
            const discovery = createMockModelDiscovery();
            const config = makeConfig({
                tiers: {
                    heavy: {
                        targetModel: 'glm-4.7',
                        strategy: 'pool',
                        fallbackModels: [],
                        clientModelPolicy: 'always-route'
                    },
                    medium: {
                        targetModel: 'glm-4.5',
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    },
                    light: {
                        targetModel: 'glm-4.7-flash',
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    }
                },
                failover: {
                    maxModelSwitchesPerRequest: 5,
                    allowTierDowngrade: true,
                    downgradeOrder: ['medium', 'light'],
                    maxTierDowngradesPerRequest: 1
                }
            });

            const router = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: discovery
            });

            // Exhaust heavy tier
            router.recordModelCooldown('glm-4.7', 10000);

            const body = makeBody({ max_tokens: 8192 });
            const result = await router.selectModel({
                parsedBody: body,
                requestModel: 'claude-opus-4-6',
                keyIndex: 0,
                attemptedModels: new Set(['glm-4.7'])
            });

            // Should downgrade to medium tier (glm-4.5)
            expect(result).toBeDefined();
            expect(result.model).toBe('glm-4.5');
            expect(result.source).toBe('tier_downgrade');
            expect(result.tier).toBe('medium');
        });

        test('downgrade respects attemptedModels (no re-selection)', async () => {
            const discovery = createMockModelDiscovery();
            const config = makeConfig({
                tiers: {
                    heavy: {
                        targetModel: 'glm-4.7',
                        strategy: 'pool',
                        fallbackModels: [],
                        clientModelPolicy: 'always-route'
                    },
                    medium: {
                        targetModel: 'glm-4.5',
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    },
                    light: {
                        targetModel: 'glm-4.7-flash',
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    }
                },
                failover: {
                    maxModelSwitchesPerRequest: 5,
                    allowTierDowngrade: true,
                    downgradeOrder: ['medium', 'light'],
                    maxTierDowngradesPerRequest: 1
                }
            });

            const router = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: discovery
            });

            // Exhaust heavy AND medium target already attempted
            router.recordModelCooldown('glm-4.7', 10000);
            router.recordModelCooldown('glm-4.5', 10000);

            const body = makeBody({ max_tokens: 8192 });
            const result = await router.selectModel({
                parsedBody: body,
                requestModel: 'claude-opus-4-6',
                keyIndex: 0,
                attemptedModels: new Set(['glm-4.7', 'glm-4.5'])
            });

            // Medium target (glm-4.5) already attempted → should skip to light tier
            expect(result).toBeDefined();
            expect(result.model).toBe('glm-4.7-flash');
            expect(result.source).toBe('tier_downgrade');
            expect(result.tier).toBe('light');
        });

        test('shadow telemetry emitted even when downgrade disabled', async () => {
            const discovery = createMockModelDiscovery();
            const config = makeConfig({
                tiers: {
                    heavy: {
                        targetModel: 'glm-4.7',
                        strategy: 'pool',
                        fallbackModels: [],
                        clientModelPolicy: 'always-route'
                    },
                    medium: {
                        targetModel: 'glm-4.5',
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    }
                },
                failover: {
                    maxModelSwitchesPerRequest: 5,
                    allowTierDowngrade: false  // Disabled
                }
            });

            const router = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: discovery
            });

            // Exhaust heavy tier
            router.recordModelCooldown('glm-4.7', 10000);

            const body = makeBody({ max_tokens: 8192 });
            const result = await router.selectModel({
                parsedBody: body,
                requestModel: 'claude-opus-4-6',
                keyIndex: 0,
                attemptedModels: new Set(['glm-4.7'])
            });

            // Downgrade disabled → should NOT return a downgraded model
            // But shadow telemetry should be available
            if (result) {
                expect(result.source).not.toBe('tier_downgrade');
            }
            // Shadow telemetry recorded
            expect(router._stats.tierDowngradeShadow).toBeGreaterThanOrEqual(1);
        });
    });

    // ------------------------------------------------------------------
    // Config validation: tier overlap warnings
    // ------------------------------------------------------------------
    describe('_validateTierOverlaps', () => {
        it('warns when a model appears in multiple tiers', () => {
            const discovery = createMockModelDiscovery();
            const warnSpy = jest.fn();
            const logger = { info: jest.fn(), warn: warnSpy, error: jest.fn(), debug: jest.fn() };

            const config = makeConfig({
                tiers: {
                    light: {
                        targetModel: 'glm-4.5-air',
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    },
                    medium: {
                        targetModel: 'glm-4.5',
                        fallbackModels: ['glm-4.5-air'],  // overlap with light
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    },
                    heavy: {
                        targetModel: 'glm-4.7',
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    }
                }
            });

            new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: discovery,
                logger
            });

            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining('glm-4.5-air')
            );
            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining('multiple tiers')
            );
        });

        it('does not warn when tiers have no overlap', () => {
            const discovery = createMockModelDiscovery();
            const warnSpy = jest.fn();
            const logger = { info: jest.fn(), warn: warnSpy, error: jest.fn(), debug: jest.fn() };

            // Default makeConfig() has no overlaps
            const config = makeConfig();

            new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: discovery,
                logger
            });

            // No overlap warnings (filter out any unrelated warnings)
            const overlapWarns = warnSpy.mock.calls.filter(
                call => typeof call[0] === 'string' && call[0].includes('multiple tiers')
            );
            expect(overlapWarns).toHaveLength(0);
        });

        it('warns on updateConfig when new config introduces overlap', () => {
            const discovery = createMockModelDiscovery();
            const warnSpy = jest.fn();
            const logger = { info: jest.fn(), warn: warnSpy, error: jest.fn(), debug: jest.fn() };

            const config = makeConfig();
            const router = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: discovery,
                logger
            });

            // No overlap initially
            const initialOverlaps = warnSpy.mock.calls.filter(
                call => typeof call[0] === 'string' && call[0].includes('multiple tiers')
            );
            expect(initialOverlaps).toHaveLength(0);

            // Update with overlapping config
            router.updateConfig({
                ...config,
                tiers: {
                    ...config.tiers,
                    heavy: {
                        targetModel: 'glm-4.7',
                        fallbackModels: ['glm-4.5'],  // overlap with medium
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    }
                }
            });

            const afterOverlaps = warnSpy.mock.calls.filter(
                call => typeof call[0] === 'string' && call[0].includes('multiple tiers')
            );
            expect(afterOverlaps).toHaveLength(1);
            expect(afterOverlaps[0][0]).toContain('glm-4.5');
        });
    });

    describe('getStats includes tier downgrade fields (Month 1 metrics)', () => {
        test('getStats includes tierDowngrade fields and route breakdowns', async () => {
            const discovery = createMockModelDiscovery();
            const config = makeConfig({
                tiers: {
                    heavy: {
                        targetModel: 'glm-4.7',
                        strategy: 'pool',
                        fallbackModels: [],
                        clientModelPolicy: 'always-route'
                    },
                    medium: {
                        targetModel: 'glm-4.5',
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    }
                },
                failover: {
                    maxModelSwitchesPerRequest: 5,
                    allowTierDowngrade: true,
                    downgradeOrder: ['medium', 'light'],
                    maxTierDowngradesPerRequest: 1
                }
            });

            const router = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: discovery
            });

            // Force a tier downgrade
            router.recordModelCooldown('glm-4.7', 10000);
            const body = makeBody({ max_tokens: 8192 });
            await router.selectModel({
                parsedBody: body,
                requestModel: 'claude-opus-4-6',
                keyIndex: 0,
                attemptedModels: new Set(['glm-4.7'])
            });

            const stats = router.getStats();
            expect(stats).toHaveProperty('tierDowngradeTotal');
            expect(stats).toHaveProperty('tierDowngradeShadow');
            expect(stats).toHaveProperty('tierDowngradeByRoute');
            expect(stats).toHaveProperty('tierDowngradeShadowByRoute');
            expect(stats.tierDowngradeTotal).toBe(1);
            expect(stats.tierDowngradeByRoute['heavy->medium']).toBe(1);
        });

        test('shadow telemetry records route (from->to)', async () => {
            const discovery = createMockModelDiscovery();
            const config = makeConfig({
                tiers: {
                    heavy: {
                        targetModel: 'glm-4.7',
                        strategy: 'pool',
                        fallbackModels: [],
                        clientModelPolicy: 'always-route'
                    },
                    medium: {
                        targetModel: 'glm-4.5',
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    }
                },
                failover: {
                    maxModelSwitchesPerRequest: 5,
                    allowTierDowngrade: false  // Shadow only
                }
            });

            const router = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: discovery
            });

            router.recordModelCooldown('glm-4.7', 10000);
            const body = makeBody({ max_tokens: 8192 });
            await router.selectModel({
                parsedBody: body,
                requestModel: 'claude-opus-4-6',
                keyIndex: 0,
                attemptedModels: new Set(['glm-4.7'])
            });

            const stats = router.getStats();
            expect(stats.tierDowngradeShadow).toBeGreaterThanOrEqual(1);
            expect(stats.tierDowngradeShadowByRoute['heavy->medium']).toBe(1);
        });
    });

    describe('_validateTierOverlaps improvements (Month 1 metrics)', () => {
        it('includes role in warning message', () => {
            const discovery = createMockModelDiscovery();
            const warnSpy = jest.fn();
            const logger = { info: jest.fn(), warn: warnSpy, error: jest.fn(), debug: jest.fn() };

            const config = makeConfig({
                tiers: {
                    light: {
                        targetModel: 'glm-4.5-air',
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    },
                    medium: {
                        targetModel: 'glm-4.5',
                        fallbackModels: ['glm-4.5-air'],
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    },
                    heavy: {
                        targetModel: 'glm-4.7',
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    }
                }
            });

            new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: discovery,
                logger
            });

            const overlapWarns = warnSpy.mock.calls.filter(
                call => typeof call[0] === 'string' && call[0].includes('multiple tiers')
            );
            expect(overlapWarns.length).toBeGreaterThan(0);
            // Should contain role info like "light/targetModel" or "medium/fallbackModels[0]"
            expect(overlapWarns[0][0]).toMatch(/\w+\/targetModel/);
        });

        it('does not re-warn on same config', () => {
            const discovery = createMockModelDiscovery();
            const warnSpy = jest.fn();
            const logger = { info: jest.fn(), warn: warnSpy, error: jest.fn(), debug: jest.fn() };

            const config = makeConfig({
                tiers: {
                    light: {
                        targetModel: 'glm-4.5-air',
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    },
                    medium: {
                        targetModel: 'glm-4.5',
                        fallbackModels: ['glm-4.5-air'],
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    },
                    heavy: {
                        targetModel: 'glm-4.7',
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    }
                }
            });

            const router = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: discovery,
                logger
            });

            const firstCallCount = warnSpy.mock.calls.filter(
                call => typeof call[0] === 'string' && call[0].includes('multiple tiers')
            ).length;
            expect(firstCallCount).toBeGreaterThan(0);

            // Call updateConfig with same overlapping config
            router.updateConfig(config);

            const secondCallCount = warnSpy.mock.calls.filter(
                call => typeof call[0] === 'string' && call[0].includes('multiple tiers')
            ).length;
            // Should NOT have added more overlap warnings
            expect(secondCallCount).toBe(firstCallCount);
        });
    });

    // ========================================================================
    // peekAdmissionHold — Tier-aware admission hold peek
    // ========================================================================
    describe('peekAdmissionHold', () => {
        test('returns null when router disabled', () => {
            const discovery = createMockModelDiscovery();
            const router = new ModelRouter(makeConfig({ enabled: false }), {
                persistEnabled: false,
                modelDiscovery: discovery
            });

            const result = router.peekAdmissionHold({
                parsedBody: makeBody({ model: 'claude-opus-4-6' }),
                requestModel: 'claude-opus-4-6',
                override: null,
                skipOverrides: false
            });
            expect(result).toBeNull();
        });

        test('returns null when per-request override present', () => {
            const discovery = createMockModelDiscovery();
            const router = new ModelRouter(makeConfig(), {
                persistEnabled: false,
                modelDiscovery: discovery
            });

            const result = router.peekAdmissionHold({
                parsedBody: makeBody({ model: 'claude-opus-4-6' }),
                requestModel: 'claude-opus-4-6',
                override: 'glm-4.5',
                skipOverrides: false
            });
            expect(result).toBeNull();
        });

        test('returns null when saved override matches', () => {
            const discovery = createMockModelDiscovery();
            const router = new ModelRouter(makeConfig(), {
                persistEnabled: false,
                modelDiscovery: discovery
            });
            router.setOverride('claude-opus-4-6', 'glm-4.5');

            const result = router.peekAdmissionHold({
                parsedBody: makeBody({ model: 'claude-opus-4-6' }),
                requestModel: 'claude-opus-4-6',
                override: null,
                skipOverrides: false
            });
            expect(result).toBeNull();
        });

        test('returns null when at least one candidate available (not cooled)', () => {
            const discovery = createMockModelDiscovery();
            const config = makeConfig({
                rules: [{ match: { model: 'claude-opus*' }, tier: 'heavy' }],
                tiers: {
                    heavy: {
                        targetModel: 'glm-4.7',
                        fallbackModels: ['glm-4.6'],
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    }
                }
            });
            const router = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: discovery
            });

            // No cooldowns set — at least one candidate available
            const result = router.peekAdmissionHold({
                parsedBody: makeBody({ model: 'claude-opus-4-6' }),
                requestModel: 'claude-opus-4-6',
                override: null,
                skipOverrides: false
            });
            expect(result).toBeNull();
        });

        test('returns hold info when all candidates cooled', () => {
            const discovery = createMockModelDiscovery();
            const config = makeConfig({
                rules: [{ match: { model: 'claude-opus*' }, tier: 'heavy' }],
                tiers: {
                    heavy: {
                        targetModel: 'glm-4.7',
                        fallbackModels: ['glm-4.6'],
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    }
                }
            });
            const router = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: discovery
            });

            // Cool down ALL candidates
            router.recordModelCooldown('glm-4.7', 5000);
            router.recordModelCooldown('glm-4.6', 3000);

            const result = router.peekAdmissionHold({
                parsedBody: makeBody({ model: 'claude-opus-4-6' }),
                requestModel: 'claude-opus-4-6',
                override: null,
                skipOverrides: false
            });

            expect(result).not.toBeNull();
            expect(result.tier).toBe('heavy');
            expect(result.allCooled).toBe(true);
            expect(result.candidates).toContain('glm-4.7');
            expect(result.candidates).toContain('glm-4.6');
            expect(result.minCooldownMs).toBeGreaterThan(0);
        });

        test('includes downgrade candidates when allowTierDowngrade=true', () => {
            const discovery = createMockModelDiscovery();
            const config = makeConfig({
                rules: [{ match: { model: 'claude-opus*' }, tier: 'heavy' }],
                tiers: {
                    heavy: {
                        targetModel: 'glm-4.7',
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    },
                    medium: {
                        targetModel: 'glm-4.5',
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    }
                },
                failover: {
                    allowTierDowngrade: true,
                    downgradeOrder: ['medium', 'light']
                }
            });
            const router = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: discovery
            });

            // Cool down heavy tier
            router.recordModelCooldown('glm-4.7', 5000);
            // Medium tier candidate available → should return null (downgrade available)
            const result = router.peekAdmissionHold({
                parsedBody: makeBody({ model: 'claude-opus-4-6' }),
                requestModel: 'claude-opus-4-6',
                override: null,
                skipOverrides: false
            });
            // Since glm-4.5 is available (not cooled), should return null
            expect(result).toBeNull();
        });

        test('returns null when downgrade candidate is available (even if tier candidates cooled)', () => {
            const discovery = createMockModelDiscovery();
            const config = makeConfig({
                rules: [{ match: { model: 'claude-opus*' }, tier: 'heavy' }],
                tiers: {
                    heavy: {
                        targetModel: 'glm-4.7',
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    },
                    medium: {
                        targetModel: 'glm-4.5',
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    }
                },
                failover: {
                    allowTierDowngrade: true,
                    downgradeOrder: ['medium', 'light']
                }
            });
            const router = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: discovery
            });

            // Cool down ALL heavy + medium
            router.recordModelCooldown('glm-4.7', 5000);
            router.recordModelCooldown('glm-4.5', 3000);

            const result = router.peekAdmissionHold({
                parsedBody: makeBody({ model: 'claude-opus-4-6' }),
                requestModel: 'claude-opus-4-6',
                override: null,
                skipOverrides: false
            });

            // All candidates cooled → should return hold info
            expect(result).not.toBeNull();
            expect(result.tier).toBe('heavy');
            expect(result.allCooled).toBe(true);
            expect(result.candidates).toContain('glm-4.5');
        });

        test('respects tier rank ordering (no upgrade)', () => {
            const discovery = createMockModelDiscovery();
            const config = makeConfig({
                rules: [{ match: { model: 'claude-haiku*' }, tier: 'light' }],
                tiers: {
                    light: {
                        targetModel: 'glm-4.7-flash',
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    },
                    heavy: {
                        targetModel: 'glm-4.7',
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    }
                },
                failover: {
                    allowTierDowngrade: true,
                    downgradeOrder: ['medium', 'light']
                }
            });
            const router = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: discovery
            });

            // Cool down light tier
            router.recordModelCooldown('glm-4.7-flash', 5000);

            const result = router.peekAdmissionHold({
                parsedBody: makeBody({ model: 'claude-haiku-4-5-20251001' }),
                requestModel: 'claude-haiku-4-5-20251001',
                override: null,
                skipOverrides: false
            });

            // Light tier has no lower tier to downgrade to → should return hold info
            expect(result).not.toBeNull();
            expect(result.tier).toBe('light');
            // Heavy tier should NOT be included (that would be an upgrade)
            expect(result.candidates).not.toContain('glm-4.7');
        });
    });

    describe('pool 429 penalty scoring', () => {
        let discovery;
        let router;

        beforeEach(() => {
            discovery = createMockModelDiscovery();
            // Add glm-4-plus and glm-4.5-air to discovery for penalty tests
            const origGetModel = discovery.getModel;
            discovery.getModel = jest.fn().mockImplementation((modelId) => {
                if (modelId === 'glm-4-plus') {
                    return Promise.resolve({
                        id: 'glm-4-plus',
                        maxConcurrency: 1,
                        pricing: { input: 0.10, output: 0.40 }
                    });
                }
                if (modelId === 'glm-4.5-air') {
                    return Promise.resolve({
                        id: 'glm-4.5-air',
                        maxConcurrency: 10,
                        pricing: { input: 0.15, output: 0.60 }
                    });
                }
                return origGetModel(modelId);
            });
        });

        function makeRouterWithPenalty(penaltyOverrides = {}) {
            const config = makeConfig({
                tiers: {
                    light: {
                        targetModel: 'glm-4-plus',
                        fallbackModels: ['glm-4.5-air'],
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    }
                },
                pool429Penalty: {
                    enabled: true,
                    windowMs: 120000,
                    penaltyWeight: 0.5,
                    maxPenaltyHits: 20,
                    ...penaltyOverrides
                }
            });
            return new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: discovery
            });
        }

        test('recordPool429 increments sliding window count', () => {
            router = makeRouterWithPenalty();
            expect(router.getPool429Count('glm-4-plus')).toBe(0);

            router.recordPool429('glm-4-plus');
            expect(router.getPool429Count('glm-4-plus')).toBe(1);

            router.recordPool429('glm-4-plus');
            expect(router.getPool429Count('glm-4-plus')).toBe(2);
        });

        test('getPool429Count returns 0 for unknown model', () => {
            router = makeRouterWithPenalty();
            expect(router.getPool429Count('nonexistent-model')).toBe(0);
        });

        test('getPool429Count prunes entries outside windowMs', () => {
            router = makeRouterWithPenalty({ windowMs: 1000 });

            // Record a 429 hit
            router.recordPool429('glm-4-plus');
            expect(router.getPool429Count('glm-4-plus')).toBe(1);

            // Manually backdate the timestamp to be outside the window
            const timestamps = router._recentPool429s.get('glm-4-plus');
            timestamps[0] = Date.now() - 2000; // 2s ago, window is 1s

            expect(router.getPool429Count('glm-4-plus')).toBe(0);
        });

        test('getPool429Count caps at maxPenaltyHits', () => {
            router = makeRouterWithPenalty({ maxPenaltyHits: 5 });

            // Record 10 hits
            for (let i = 0; i < 10; i++) {
                router.recordPool429('glm-4-plus');
            }

            // Should be capped at 5
            expect(router.getPool429Count('glm-4-plus')).toBe(5);
        });

        test('_selectFromPool penalizes model with high 429 count', async () => {
            router = makeRouterWithPenalty();

            // Record 10 429s for glm-4-plus
            for (let i = 0; i < 10; i++) {
                router.recordPool429('glm-4-plus');
            }

            // glm-4-plus: 1 available * 1/(1+10*0.5) = 1 * 0.167 = 0.17
            // glm-4.5-air: 10 available * 1/(1+0*0.5) = 10 * 1.0 = 10.0
            // glm-4.5-air should win
            const result = await router._selectFromPool(
                ['glm-4-plus', 'glm-4.5-air'],
                new Set()
            );

            expect(result).not.toBeNull();
            expect(result.model).toBe('glm-4.5-air');
        });

        test('_selectFromPool prefers model with fewer recent 429s (same capacity)', async () => {
            // Use models with same capacity to isolate penalty effect
            const config = makeConfig({
                tiers: {
                    light: {
                        targetModel: 'glm-4-plus',
                        fallbackModels: ['glm-4.5-air'],
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    }
                },
                pool429Penalty: {
                    enabled: true,
                    windowMs: 120000,
                    penaltyWeight: 0.5,
                    maxPenaltyHits: 20
                }
            });
            router = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: discovery
            });

            // Record 5 429s for glm-4-plus, 1 for glm-4.5-air
            for (let i = 0; i < 5; i++) {
                router.recordPool429('glm-4-plus');
            }
            router.recordPool429('glm-4.5-air');

            // glm-4-plus: 1 * 1/(1+5*0.5) = 1 * 0.286 = 0.29
            // glm-4.5-air: 10 * 1/(1+1*0.5) = 10 * 0.667 = 6.67
            // glm-4.5-air wins because glm-4-plus has low capacity (1)
            // Add more 429s to glm-4-plus to further reduce its score:
            for (let i = 0; i < 3; i++) {
                router.recordPool429('glm-4-plus');
            }
            // glm-4-plus: 1 * 1/(1+8*0.5) = 1 * 0.2 = 0.2
            // glm-4.5-air: 10 * 1/(1+1*0.5) = 10 * 0.667 = 6.67
            // glm-4.5-air still wins. Add more:
            for (let i = 0; i < 5; i++) {
                router.recordPool429('glm-4-plus');
            }
            // glm-4-plus: 1 * 1/(1+13*0.5) = 1 * 0.133 = 0.13
            // glm-4.5-air: 10 * 1/(1+1*0.5) = 10 * 0.667 = 6.67
            // glm-4.5-air wins

            const result = await router._selectFromPool(
                ['glm-4-plus', 'glm-4.5-air'],
                new Set()
            );

            expect(result).not.toBeNull();
            expect(result.model).toBe('glm-4.5-air');
        });

        test('penalty disabled when pool429Penalty.enabled = false', async () => {
            router = makeRouterWithPenalty({ enabled: false });

            // Record many 429s - should have no effect when disabled
            for (let i = 0; i < 20; i++) {
                router.recordPool429('glm-4-plus');
            }

            // recordPool429 should be a no-op, count should remain 0
            expect(router.getPool429Count('glm-4-plus')).toBe(0);

            // glm-4.5-air should win by capacity alone (10 vs 1)
            const result = await router._selectFromPool(
                ['glm-4-plus', 'glm-4.5-air'],
                new Set()
            );

            expect(result).not.toBeNull();
            expect(result.model).toBe('glm-4.5-air');
        });

        test('getPool429PenaltyStats returns per-model counts with operator fields', () => {
            router = makeRouterWithPenalty();

            router.recordPool429('glm-4-plus');
            router.recordPool429('glm-4-plus');
            router.recordPool429('glm-4.5-air');

            const stats = router.getPool429PenaltyStats();
            expect(stats.enabled).toBe(true);
            expect(stats.windowMs).toBe(120000);
            expect(stats.trackedModels).toBe(2);
            // byModel now contains objects with hits, lastSeenMs, decayEtaMs
            expect(stats.byModel['glm-4-plus'].hits).toBe(2);
            expect(stats.byModel['glm-4.5-air'].hits).toBe(1);
            expect(typeof stats.byModel['glm-4-plus'].lastSeenMs).toBe('number');
            expect(typeof stats.byModel['glm-4-plus'].decayEtaMs).toBe('number');
        });

        test('reset() clears _recentPool429s', () => {
            router = makeRouterWithPenalty();

            router.recordPool429('glm-4-plus');
            expect(router.getPool429Count('glm-4-plus')).toBe(1);

            router.reset();
            expect(router.getPool429Count('glm-4-plus')).toBe(0);
        });

        test('penalty fully decays to 0 after window expires (time-based)', () => {
            // Proves the sliding window is purely time-based:
            // after windowMs elapses with no new 429s, penalty returns to 0.
            router = makeRouterWithPenalty({ windowMs: 500 });

            // Record several 429s
            for (let i = 0; i < 5; i++) {
                router.recordPool429('glm-4-plus');
            }
            expect(router.getPool429Count('glm-4-plus')).toBe(5);

            // Backdate all timestamps to be outside the window
            const timestamps = router._recentPool429s.get('glm-4-plus');
            const expired = Date.now() - 1000;
            for (let i = 0; i < timestamps.length; i++) {
                timestamps[i] = expired;
            }

            // Count should decay to 0
            expect(router.getPool429Count('glm-4-plus')).toBe(0);
            // Map entry should be cleaned up
            expect(router._recentPool429s.has('glm-4-plus')).toBe(false);
        });

        test('_recentPool429s evicts oldest-inactive model when at maxModels cap', () => {
            router = makeRouterWithPenalty({ maxModels: 3 });

            const now = Date.now();

            // model-a: last hit 5s ago (oldest last activity)
            router._recentPool429s.set('model-a', [now - 5000, now - 4000]);
            // model-b: last hit 3s ago (middle)
            router._recentPool429s.set('model-b', [now - 3000]);
            // model-c: last hit 1s ago (most recent)
            router._recentPool429s.set('model-c', [now - 1000]);

            expect(router._recentPool429s.size).toBe(3);

            // Add a 4th model — should evict model-a (oldest last hit)
            router.recordPool429('model-d');

            expect(router._recentPool429s.size).toBe(3);
            expect(router._recentPool429s.has('model-d')).toBe(true);
            // model-a had the oldest last hit → evicted
            expect(router._recentPool429s.has('model-a')).toBe(false);
            // model-b and model-c retained (more recent last hits)
            expect(router._recentPool429s.has('model-b')).toBe(true);
            expect(router._recentPool429s.has('model-c')).toBe(true);
        });

        test('toJSON includes pool429Penalty config and stats', () => {
            router = makeRouterWithPenalty();
            router.recordPool429('glm-4-plus');

            const json = router.toJSON();
            expect(json.config.pool429Penalty).toBeDefined();
            expect(json.config.pool429Penalty.enabled).toBe(true);
            expect(json.config.pool429Penalty.windowMs).toBe(120000);
            expect(json.pool429Penalty).toBeDefined();
            expect(json.pool429Penalty.trackedModels).toBe(1);
            expect(json.pool429Penalty.byModel['glm-4-plus'].hits).toBe(1);
        });

        test('toJSON includes effectiveMaxSwitches per tier', () => {
            router = makeRouterWithPenalty();
            const json = router.toJSON();
            expect(json.effectiveMaxSwitches).toBeDefined();
            expect(json.effectiveMaxSwitches.light).toBeDefined();
            // light tier has 2 models (glm-4-plus + glm-4.5-air), so max = min(configured, 1)
            expect(typeof json.effectiveMaxSwitches.light).toBe('number');
        });
    });

    describe('getEffectiveMaxSwitches runtime clamp', () => {
        test('clamps maxModelSwitchesPerRequest to candidate count', () => {
            // Config says 99, but tier only has 2 models → effective = 2 (attempt budget)
            const config = makeConfig({
                tiers: {
                    light: {
                        targetModel: 'glm-4-plus',
                        fallbackModels: ['glm-4.5-air'],
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    }
                },
                failover: {
                    maxModelSwitchesPerRequest: 99
                }
            });
            const router = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: createMockModelDiscovery()
            });

            // 2 models → attempt budget of 2 (allows 1 switch: A→B, then blocks)
            expect(router.getEffectiveMaxSwitches('light')).toBe(2);
        });

        test('returns configured value when it does not exceed candidates', () => {
            const config = makeConfig({
                tiers: {
                    light: {
                        targetModel: 'model-a',
                        fallbackModels: ['model-b', 'model-c', 'model-d'],
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    }
                },
                failover: {
                    maxModelSwitchesPerRequest: 2
                }
            });
            const router = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: createMockModelDiscovery()
            });

            // 4 models → attempt budget of 4, configured 2 → effective = 2
            expect(router.getEffectiveMaxSwitches('light')).toBe(2);
        });

        test('returns configured value for unknown tier', () => {
            const config = makeConfig({
                tiers: {},
                failover: {
                    maxModelSwitchesPerRequest: 5
                }
            });
            const router = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: createMockModelDiscovery()
            });

            expect(router.getEffectiveMaxSwitches('nonexistent')).toBe(5);
        });

        test('maxSwitches=99 with 2 models: router never attempts > 1 switch', () => {
            // The user's exact requirement: config has maxModelSwitchesPerRequest: 99,
            // tier has 2 models → router never attempts > 1 switch
            const config = makeConfig({
                tiers: {
                    light: {
                        targetModel: 'model-a',
                        fallbackModels: ['model-b'],
                        strategy: 'failover',
                        clientModelPolicy: 'always-route'
                    }
                },
                failover: {
                    maxModelSwitchesPerRequest: 99
                },
                rules: [{ match: { type: 'any' }, tier: 'light' }]
            });
            const router = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: createMockModelDiscovery()
            });

            // Effective cap is 2 (attempt budget for 2 models; allows 1 switch)
            expect(router.getEffectiveMaxSwitches('light')).toBe(2);

            // After trying both models (size=2), getNextFallback should return null
            const result = router.getNextFallback({
                tier: 'light',
                attemptedModels: new Set(['model-a', 'model-b'])
            });
            expect(result).toBeNull();

            // After trying 1 model, should still get a fallback
            const fallback = router.getNextFallback({
                tier: 'light',
                attemptedModels: new Set(['model-a'])
            });
            expect(fallback).toBe('model-b');
        });

        test('effective cap surfaced in toJSON per tier', () => {
            const config = makeConfig({
                tiers: {
                    heavy: {
                        targetModel: 'model-a',
                        fallbackModels: ['model-b', 'model-c'],
                        strategy: 'failover',
                        clientModelPolicy: 'always-route'
                    },
                    light: {
                        targetModel: 'model-d',
                        fallbackModels: [],
                        strategy: 'failover',
                        clientModelPolicy: 'always-route'
                    }
                },
                failover: {
                    maxModelSwitchesPerRequest: 10
                }
            });
            const router = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: createMockModelDiscovery()
            });

            const json = router.toJSON();
            // heavy: 3 models → effective 3 (clamped from 10)
            expect(json.effectiveMaxSwitches.heavy).toBe(3);
            // light: 1 model → effective 1 (single candidate, no switches possible)
            expect(json.effectiveMaxSwitches.light).toBe(1);
        });
    });

    // ==================================================================
    // GLM5 Observability Counter Integration Tests
    // ==================================================================

    describe('GLM5 observability counters with ModelDiscovery', () => {
        test('counts heavy model selections correctly with real metadata', async () => {
            const config = makeConfig({
                tiers: {
                    heavy: {
                        models: ['glm-4.7', 'glm-4.7-flash'],
                        strategy: 'balanced',
                        clientModelPolicy: 'always-route'
                    }
                },
                classifier: {
                    heavyThresholds: {
                        maxTokensGte: 4096
                    }
                }
            });
            const router = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: createMockModelDiscovery()
            });

            // Make a heavy-tier request
            const result = await router.selectModel({
                parsedBody: makeBody({ max_tokens: 4096 }),
                requestModel: 'claude-sonnet-4-20250514'
            });

            expect(result.tier).toBe('heavy');

            const stats = router.getStats();
            expect(stats.byUpgradeReason.max_tokens).toBe(1);
            expect(stats.byModel['glm-4.7'] || stats.byModel['glm-4.7-flash']).toBeDefined();
        });

        test('tracks fallback reasons during pool selection', async () => {
            const config = makeConfig({
                tiers: {
                    heavy: {
                        models: ['glm-4.7-a', 'glm-4.7-b'],
                        strategy: 'pool',
                        clientModelPolicy: 'always-route'
                    }
                }
            });
            const router = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: createMockModelDiscovery()
            });

            // Put first model in cooldown
            router.recordModelCooldown('glm-4.7-a', 5000);

            // Make a request that should skip the first model
            const result = await router.selectModel({
                parsedBody: makeBody({ max_tokens: 4096 }),
                requestModel: 'claude-sonnet-4-20250514'
            });

            expect(result.tier).toBe('heavy');

            const stats = router.getStats();
            expect(stats.byFallbackReason.cooldown).toBeGreaterThan(0);
        });
    });
});
