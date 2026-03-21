'use strict';

/**
 * Coverage tests for model-router.js uncovered branches.
 * Target lines: 2009, 2363-2371, 3399, 3562, 3722
 */
const { ModelRouter } = require('../lib/model-router');

describe('ModelRouter Coverage Pt2 - Uncovered Branches', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    // ---------------------------------------------------------------
    // Line 2009: catch block for invalid JSON in classification.reason
    // This is in simulateStatefulMode, NOT computeDecision
    // ---------------------------------------------------------------
    describe('simulateStatefulMode - invalid JSON in rule reason', () => {
        // Covers line 2009: catch block sets matchedRule = null when JSON.parse fails
        test('matchedRule is null when classification.reason has invalid JSON after "rule:"', async () => {
            const modelMeta = {
                'model-a': { maxConcurrency: 10, pricing: { input: 0.1, output: 0.5 }, contextLength: 4000 }
            };

            const discovery = {
                getModel: jest.fn().mockImplementation((id) => modelMeta[id] || null)
            };

            const config = {
                version: '2.0',
                enabled: true,
                tiers: {
                    light: {
                        strategy: 'balanced',
                        models: ['model-a']
                    }
                },
                rules: [
                    { tier: 'light', match: { model: '*' } }
                ]
            };

            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: discovery });

            // Mock classify to return a reason that starts with 'rule:' but has invalid JSON
            jest.spyOn(router, 'classify').mockReturnValue({
                tier: 'light',
                reason: 'rule: {not valid json}'
            });

            const snapshot = {
                version: '1.0',
                timestamp: Date.now(),
                models: [
                    {
                        modelId: 'model-a',
                        isAvailable: true,
                        inFlight: 0,
                        maxConcurrency: 10
                    }
                ]
            };

            const result = await router.simulateStatefulMode({
                parsedBody: {
                    model: 'claude-haiku-4-5-20251001',
                    messages: [{ role: 'user', content: 'test' }],
                    max_tokens: 100
                },
                requestModel: 'claude-haiku-4-5-20251001'
            }, snapshot);

            // The decision should succeed
            expect(result).toBeDefined();
            expect(result.tier).toBe('light');
            // matchedRule should be null because JSON.parse failed
            expect(result.matchedRule).toBeNull();
        });
    });

    // ---------------------------------------------------------------
    // Lines 2363-2371: default case in _computePoolSelection switch
    // ---------------------------------------------------------------
    describe('_computePoolSelection - invalid strategy default case', () => {
        // Covers lines 2363-2371: default case applies balanced-like scoring
        test('applies balanced scoring when strategy is invalid (default case)', async () => {
            const modelMeta = {
                'model-a': { maxConcurrency: 10, pricing: { input: 0.1, output: 0.5 }, contextLength: 4000 },
                'model-b': { maxConcurrency: 10, pricing: { input: 0.2, output: 1.0 }, contextLength: 8000 }
            };

            const discovery = {
                getModel: jest.fn().mockImplementation((id) => modelMeta[id] || null)
            };

            const config = {
                version: '2.0',
                enabled: true,
                tiers: {
                    light: {
                        strategy: 'totally-invalid-strategy', // Invalid strategy
                        models: ['model-a', 'model-b'],
                        clientModelPolicy: 'always-route'
                    }
                },
                classifier: {
                    lightThresholds: { maxTokensLte: 4096 }
                }
            };

            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: discovery });

            const result = await router.computeDecision({
                parsedBody: {
                    model: 'claude-haiku-4-5-20251001',
                    messages: [{ role: 'user', content: 'test' }],
                    max_tokens: 100
                },
                requestModel: 'claude-haiku-4-5-20251001'
            });

            // Should still return a valid decision using default balanced-like scoring
            expect(result).toBeDefined();
            expect(result.tier).toBe('light');
            expect(['model-a', 'model-b']).toContain(result.model);
            // Falls back to classifier-based routing when strategy is unknown
            expect(typeof result.reason).toBe('string');
        });
    });

    // ---------------------------------------------------------------
    // Line 3399: models = [] when tierConfig.models is not an array
    // Note: The normalizer converts invalid models to empty array during construction.
    // To test line 3399, we need to directly modify the internal config after construction.
    // ---------------------------------------------------------------
    describe('toJSON - handles tierConfig without models array', () => {
        // Covers line 3399: sets processedTier.models = [] when models is not an array
        test('sets empty models array when tierConfig.models is not an array (direct config manipulation)', () => {
            const discovery = {
                getModel: jest.fn().mockResolvedValue({ maxConcurrency: 100, costPerMillion: 1.0 })
            };

            const config = {
                version: '2.0',
                enabled: true,
                tiers: {
                    light: {
                        strategy: 'balanced',
                        models: ['model-a'] // Valid array initially
                    }
                }
            };

            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: discovery });

            // Directly manipulate internal config to have non-array models
            // This simulates the edge case where config is corrupted after normalization
            router.config.tiers.light.models = 'not-an-array';

            const json = router.toJSON();

            // Should have empty array for models when input wasn't an array
            expect(json.config.tiers.light.models).toEqual([]);
        });

        test('sets empty models array when tierConfig.models is null (direct config manipulation)', () => {
            const discovery = {
                getModel: jest.fn().mockResolvedValue({ maxConcurrency: 100, costPerMillion: 1.0 })
            };

            const config = {
                version: '2.0',
                enabled: true,
                tiers: {
                    medium: {
                        strategy: 'pool',
                        models: ['model-b']
                    }
                }
            };

            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: discovery });

            // Directly manipulate internal config
            router.config.tiers.medium.models = null;

            const json = router.toJSON();

            expect(json.config.tiers.medium.models).toEqual([]);
        });

        test('sets empty models array when tierConfig.models is undefined (direct config manipulation)', () => {
            const discovery = {
                getModel: jest.fn().mockResolvedValue({ maxConcurrency: 100, costPerMillion: 1.0 })
            };

            const config = {
                version: '2.0',
                enabled: true,
                tiers: {
                    heavy: {
                        strategy: 'quality',
                        models: ['model-c']
                    }
                }
            };

            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: discovery });

            // Directly manipulate internal config
            delete router.config.tiers.heavy.models;

            const json = router.toJSON();

            expect(json.config.tiers.heavy.models).toEqual([]);
        });
    });

    // ---------------------------------------------------------------
    // Line 3562: clientModelPolicy validation error
    // ---------------------------------------------------------------
    describe('validateConfig - clientModelPolicy validation', () => {
        // Covers line 3562: invalid clientModelPolicy value error
        test('rejects invalid clientModelPolicy value', () => {
            const updates = {
                version: '2.0',
                tiers: {
                    light: {
                        models: ['model-a'],
                        clientModelPolicy: 'invalid-policy-value' // Invalid
                    }
                }
            };

            const result = ModelRouter.validateConfig(updates);

            expect(result.valid).toBe(false);
            expect(result.error).toContain('clientModelPolicy');
            expect(result.error).toContain('rule-match-only');
            expect(result.error).toContain('always-route');
        });

        test('accepts valid clientModelPolicy "rule-match-only"', () => {
            const updates = {
                version: '2.0',
                tiers: {
                    light: {
                        models: ['model-a'],
                        clientModelPolicy: 'rule-match-only'
                    }
                },
                rules: [{ tier: 'light', match: { model: '*' } }]
            };

            const result = ModelRouter.validateConfig(updates);

            expect(result.valid).toBe(true);
        });

        test('accepts valid clientModelPolicy "always-route"', () => {
            const updates = {
                version: '2.0',
                tiers: {
                    medium: {
                        models: ['model-b'],
                        clientModelPolicy: 'always-route'
                    }
                },
                rules: [{ tier: 'medium', match: { model: '*' } }]
            };

            const result = ModelRouter.validateConfig(updates);

            expect(result.valid).toBe(true);
        });
    });

    // ---------------------------------------------------------------
    // Line 3722: complexityUpgrade.allowedFamilies validation error
    // ---------------------------------------------------------------
    describe('validateConfig - complexityUpgrade.allowedFamilies validation', () => {
        // Covers line 3722: non-string element in allowedFamilies array
        test('rejects non-string element in complexityUpgrade.allowedFamilies', () => {
            const updates = {
                version: '2.0',
                tiers: {
                    light: { models: ['model-a'] }
                },
                rules: [{ tier: 'light', match: { model: '*' } }],
                complexityUpgrade: {
                    enabled: true,
                    allowedFamilies: ['valid-string', 123, 'another-string'] // 123 is invalid
                }
            };

            const result = ModelRouter.validateConfig(updates);

            expect(result.valid).toBe(false);
            expect(result.error).toContain('complexityUpgrade.allowedFamilies');
            expect(result.error).toContain('must be a string');
        });

        test('rejects null element in complexityUpgrade.allowedFamilies', () => {
            const updates = {
                version: '2.0',
                tiers: {
                    medium: { models: ['model-b'] }
                },
                rules: [{ tier: 'medium', match: { model: '*' } }],
                complexityUpgrade: {
                    enabled: true,
                    allowedFamilies: ['sonnet', null] // null is invalid
                }
            };

            const result = ModelRouter.validateConfig(updates);

            expect(result.valid).toBe(false);
            expect(result.error).toContain('complexityUpgrade.allowedFamilies');
        });

        test('accepts valid string array for complexityUpgrade.allowedFamilies', () => {
            const updates = {
                version: '2.0',
                tiers: {
                    heavy: { models: ['model-c'] }
                },
                rules: [{ tier: 'heavy', match: { model: '*' } }],
                complexityUpgrade: {
                    enabled: true,
                    allowedFamilies: ['sonnet', 'opus', 'haiku']
                }
            };

            const result = ModelRouter.validateConfig(updates);

            expect(result.valid).toBe(true);
        });

        test('rejects object element in complexityUpgrade.allowedFamilies', () => {
            const updates = {
                version: '2.0',
                tiers: {
                    light: { models: ['model-a'] }
                },
                rules: [{ tier: 'light', match: { model: '*' } }],
                complexityUpgrade: {
                    enabled: true,
                    allowedFamilies: [{ family: 'sonnet' }] // Object is invalid
                }
            };

            const result = ModelRouter.validateConfig(updates);

            expect(result.valid).toBe(false);
            expect(result.error).toContain('complexityUpgrade.allowedFamilies');
        });

        test('rejects array element in allowedFamilies', () => {
            const updates = {
                version: '2.0',
                tiers: {
                    light: { models: ['model-a'] }
                },
                rules: [{ tier: 'light', match: { model: '*' } }],
                complexityUpgrade: {
                    enabled: true,
                    allowedFamilies: [['nested-array']] // Nested array is invalid
                }
            };

            const result = ModelRouter.validateConfig(updates);

            expect(result.valid).toBe(false);
            expect(result.error).toContain('complexityUpgrade.allowedFamilies');
        });
    });

    // ---------------------------------------------------------------
    // Line 1412: cooldown decay check (now - entry.lastHit > decayMs)
    // ---------------------------------------------------------------
    describe('cooldown decay - old cooldown entries decay to zero', () => {
        // Covers line 1412: sets cooldown to 0 when entry.lastHit is older than decayMs
        test('sets cooldown to 0 when entry.lastHit is older than decayMs', async () => {
            jest.useFakeTimers();

            const modelMeta = {
                'model-a': { maxConcurrency: 10, pricing: { input: 0.1, output: 0.5 }, contextLength: 4000 },
                'model-b': { maxConcurrency: 10, pricing: { input: 0.2, output: 1.0 }, contextLength: 8000 }
            };

            const discovery = {
                getModel: jest.fn().mockImplementation((id) => modelMeta[id] || null)
            };

            const config = {
                version: '2.0',
                enabled: true,
                tiers: {
                    light: {
                        strategy: 'balanced',
                        models: ['model-a', 'model-b'],
                        clientModelPolicy: 'always-route'
                    }
                },
                classifier: {
                    lightThresholds: { maxTokensLte: 4096 }
                },
                cooldown: {
                    decayMs: 1000 // Short decay for testing
                }
            };

            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: discovery });

            // Put model-a in cooldown at the current time
            router.recordModelCooldown('model-a', 5000);

            // Advance time past the decay window
            jest.advanceTimersByTime(1500);

            // Now request a decision - the cooldown should be decayed to 0
            const result = await router.computeDecision({
                parsedBody: {
                    model: 'claude-haiku-4-5-20251001',
                    messages: [{ role: 'user', content: 'test' }],
                    max_tokens: 100
                },
                requestModel: 'claude-haiku-4-5-20251001',
                includeTrace: true
            });

            // The decision should succeed with model-a (since its cooldown decayed)
            expect(result).toBeDefined();
            expect(result.tier).toBe('light');
            // model-a should be selectable since its cooldown decayed
            expect(['model-a', 'model-b']).toContain(result.model);

            jest.useRealTimers();
        });
    });

    // ---------------------------------------------------------------
    // Lines 1816-1824: trace rebuilding without routerPool
    // ---------------------------------------------------------------
    describe('explain - trace rebuilding when routerPool missing', () => {
        // Covers lines 1816-1824: rebuilds trace with router state when routerPool is missing
        // This happens when computeDecision returns a trace without routerPool (e.g., override path)
        test('rebuilds trace with router state when trace exists but routerPool is missing (override path)', async () => {
            const modelMeta = {
                'model-a': { maxConcurrency: 10, pricing: { input: 0.1, output: 0.5 }, contextLength: 4000 }
            };

            const discovery = {
                getModel: jest.fn().mockImplementation((id) => modelMeta[id] || null)
            };

            const config = {
                version: '2.0',
                enabled: true,
                trace: { samplingRate: 100 }, // Always include trace
                tiers: {
                    light: {
                        strategy: 'balanced',
                        models: ['model-a'],
                        clientModelPolicy: 'always-route'
                    }
                },
                classifier: {
                    lightThresholds: { maxTokensLte: 4096 }
                }
            };

            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: discovery });

            // Call explain with an override - this triggers the override code path
            // which builds trace WITHOUT routerPool (includeRouterState: false)
            // Then explain should rebuild the trace WITH routerPool
            const result = await router.explain({
                parsedBody: {
                    model: 'claude-haiku-4-5-20251001',
                    messages: [{ role: 'user', content: 'test' }],
                    max_tokens: 100
                },
                requestModel: 'claude-haiku-4-5-20251001',
                override: 'model-a' // Per-request override
            }, { includeTrace: true });

            // The trace should be included and have routerPool after explain rebuilds it
            expect(result).toBeDefined();
            expect(result.selectedModel).toBe('model-a'); // From override
            expect(result.trace).toBeDefined();
            // The trace should include routerPool state after rebuild (lines 1816-1824)
            expect(result.trace.routerPool).toBeDefined();
        });
    });
});
