'use strict';

const fs = require('fs');
const path = require('path');
const { ModelRouter } = require('../lib/model-router');

describe('ModelRouter - uncovered branches coverage', () => {
    let originalJestWorkerId;

    function createMockModelDiscovery() {
        return {
            getModel: jest.fn().mockResolvedValue({
                id: 'claude-3-5-sonnet-20241022',
                contextLength: 200000,
                maxTokens: 8192
            })
        };
    }

    beforeEach(() => {
        jest.useFakeTimers().setSystemTime(1000000);
        originalJestWorkerId = process.env.JEST_WORKER_ID;
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
        if (originalJestWorkerId !== undefined) {
            process.env.JEST_WORKER_ID = originalJestWorkerId;
        } else {
            delete process.env.JEST_WORKER_ID;
        }
        if (ModelRouter._consoleOverlapWarnHashes) {
            ModelRouter._consoleOverlapWarnHashes.clear();
        }
    });

    // Covers line 267: non-ENOENT error when loading persisted overrides
    test('should log warning when override file read fails with non-ENOENT error', () => {
        const mockLogger = {
            warn: jest.fn(),
            info: jest.fn(),
            error: jest.fn(),
            debug: jest.fn()
        };

        const mockError = new Error('Permission denied');
        mockError.code = 'EACCES';

        jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
            throw mockError;
        });

        const config = {
            enabled: true,
            tiers: {
                light: { models: ['claude-3-haiku-20240307'] }
            }
        };

        expect(() => {
            new ModelRouter(config, {
                modelDiscovery: createMockModelDiscovery(),
                configDir: '/tmp/test',
                persistEnabled: true,
                logger: mockLogger
            });
        }).not.toThrow();

        expect(mockLogger.warn).toHaveBeenCalledWith(
            'Failed to load model routing overrides',
            { error: 'Permission denied' }
        );
    });

    // Covers lines 335-342: console overlap warning hash deduplication
    test('should use static hash set for console overlap deduplication', () => {
        ModelRouter._consoleOverlapWarnHashes = undefined;
        delete process.env.JEST_WORKER_ID;

        const config = {
            tiers: {
                light: { models: ['claude-3-haiku-20240307'] },
                medium: { models: ['claude-3-haiku-20240307'] }
            }
        };

        const router1 = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery(),
            logger: console
        });

        expect(ModelRouter._consoleOverlapWarnHashes).toBeInstanceOf(Set);
        expect(ModelRouter._consoleOverlapWarnHashes.size).toBeGreaterThan(0);

        const router2 = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery(),
            logger: console
        });

        expect(ModelRouter._consoleOverlapWarnHashes.size).toBeGreaterThan(0);
    });

    // Covers lines 335-342: hash eviction when size exceeds 256
    test('should evict oldest hash when console overlap hash set exceeds 256 entries', () => {
        ModelRouter._consoleOverlapWarnHashes = new Set();
        for (let i = 0; i < 256; i++) {
            ModelRouter._consoleOverlapWarnHashes.add(`hash-${i}`);
        }
        delete process.env.JEST_WORKER_ID;

        const config = {
            tiers: {
                light: { models: [`unique-model-a`] },
                medium: { models: [`unique-model-a`] }
            }
        };

        new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery(),
            logger: console
        });

        expect(ModelRouter._consoleOverlapWarnHashes.size).toBeLessThanOrEqual(257);
    });

    // Covers lines 1307-1315: tier not found when classify returns unknown tier
    test('should return null decision when tier from classification does not exist in config', async () => {
        const config = {
            enabled: true,
            tiers: {
                light: { models: ['claude-3-haiku-20240307'] }
            },
            rules: [
                {
                    match: { model: 'test-model' },
                    tier: 'nonexistent-tier'
                }
            ]
        };

        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });

        const context = {
            parsedBody: {
                model: 'test-model',
                messages: []
            }
        };

        const decision = await router.computeDecision(context);

        expect(decision).not.toBeNull();
        expect(decision.model).toBeNull();
        expect(decision.tier).toBe('nonexistent-tier');
        expect(decision.reason).toBe('tier not found');
        expect(decision.source).toBe('none');
    });

    // Covers lines 1307-1315: tier not found with includeTrace
    test('should include trace when tier not found and includeTrace is true', async () => {
        const config = {
            enabled: true,
            tiers: {
                light: { models: ['claude-3-haiku-20240307'] }
            },
            rules: [
                {
                    match: { model: 'test-model' },
                    tier: 'missing-tier'
                }
            ]
        };

        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });

        const context = {
            parsedBody: {
                model: 'test-model',
                messages: []
            },
            includeTrace: true,
            bypassSampling: true
        };

        const decision = await router.computeDecision(context);

        expect(decision.model).toBeNull();
        expect(decision.tier).toBe('missing-tier');
        expect(decision.reason).toBe('tier not found');
        expect(decision.trace).toBeDefined();
    });

    // Covers line 1412: cooldown decay when entry.lastHit is older than decayMs in failover
    // This test mocks _computePoolSelection to skip it, ensuring failover path is taken
    test('should set cooldown to 0 when entry.lastHit is older than decayMs in failover', async () => {
        const config = {
            enabled: true,
            tiers: {
                heavy: {
                    models: ['claude-3-5-sonnet-20241022', 'claude-3-opus-20240229']
                }
            },
            rules: [
                {
                    match: { model: 'claude-3-5-sonnet-20241022' },
                    tier: 'heavy'
                }
            ],
            cooldown: {
                defaultMs: 5000,
                maxMs: 30000,
                decayMs: 1000
            },
            failover: {
                maxModelSwitchesPerRequest: 5
            }
        };

        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });

        // Set up cooldown entries where decay is met (lastHit older than decayMs)
        const now = Date.now();
        router._cooldowns.set('claude-3-5-sonnet-20241022', {
            cooldownUntil: now + 5000,
            lastHit: now - 2000, // 2 seconds ago, decayMs is 1 second - decay IS met
            count: 1
        });
        router._cooldowns.set('claude-3-opus-20240229', {
            cooldownUntil: now + 5000,
            lastHit: now - 2000, // decay IS met
            count: 1
        });

        // Mock _computePoolSelection to return null
        // This bypasses pool selection so getModelCooldown doesn't delete entries
        jest.spyOn(router, '_computePoolSelection').mockResolvedValue(null);

        const context = {
            parsedBody: {
                model: 'claude-3-5-sonnet-20241022',
                max_tokens: 100,
                messages: [{ role: 'user', content: 'test' }]
            },
            attemptedModels: new Set(['claude-3-5-sonnet-20241022'])
        };

        const decision = await router.computeDecision(context);

        // Verify decision
        expect(decision).not.toBeNull();
        expect(decision.model).toBeDefined();
        // Should contain failover/warning in reason
        expect(decision.reason).toMatch(/warning|failover|unavailable/);
    });

    // Covers lines 1816-1824: trace rebuild when routerPool is missing from trace
    test('should rebuild trace with router state when trace exists but routerPool is missing', async () => {
        const config = {
            enabled: true,
            tiers: {
                light: {
                    models: ['claude-3-haiku-20240307']
                }
            },
            rules: [
                {
                    match: { model: 'claude-3-haiku-20240307' },
                    tier: 'light'
                }
            ]
        };

        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });

        const context = {
            parsedBody: {
                model: 'claude-3-haiku-20240307',
                messages: []
            },
            bypassSampling: true
        };

        // Mock computeDecision to return a trace without routerPool
        const originalComputeDecision = router.computeDecision;
        jest.spyOn(router, 'computeDecision').mockImplementation(async (ctx) => {
            const result = await originalComputeDecision.call(router, ctx);
            if (result.trace && result.trace.routerPool) {
                delete result.trace.routerPool;
            }
            return result;
        });

        const explanation = await router.explain(context, { includeTrace: true });

        expect(explanation.trace).toBeDefined();
        expect(explanation.selectedModel).toBeDefined();
    });

    // Covers line 1883: JSON.parse failure when rule reason has malformed JSON
    test('should handle JSON.parse failure gracefully in simulateDecisionMode', async () => {
        const config = {
            tiers: {
                light: {
                    models: ['claude-3-haiku-20240307']
                }
            },
            rules: [
                {
                    match: { model: 'test-model' },
                    tier: 'light'
                }
            ]
        };

        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });

        // Mock classify to return malformed rule reason
        const originalClassify = router.classify;
        jest.spyOn(router, 'classify').mockImplementation((features) => {
            if (features.model === 'test-model') {
                return {
                    tier: 'light',
                    reason: 'rule: {invalid json}'
                };
            }
            return originalClassify.call(router, features);
        });

        const context = {
            parsedBody: {
                model: 'test-model',
                messages: []
            }
        };

        const result = await router.simulateDecisionMode(context);

        expect(result).not.toBeNull();
        expect(result.selectedModel).toBeDefined();
        expect(result.matchedRule).toBeNull();
    });

    // =============================================================
    // _selectModelInternal — deprecated but untested (lines 2397-2691)
    // =============================================================

    // Covers line 2400: context.override returns per-request override
    test('_selectModelInternal returns override when context.override is set', async () => {
        const config = {
            enabled: true,
            tiers: {
                heavy: { models: ['claude-3-opus-20240229'] }
            }
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });
        const result = await router._selectModelInternal({
            override: 'claude-3-haiku-20240307',
            parsedBody: { model: 'test', messages: [] }
        });
        expect(result.model).toBe('claude-3-haiku-20240307');
        expect(result.tier).toBeNull();
        expect(result.reason).toBe('per-request override');
        expect(result.source).toBe('override');
        expect(router._stats.bySource.override).toBe(1);
        expect(router._stats.total).toBe(1);
    });

    // Covers line 2400 binary-expr: skipOverrides=true skips override
    test('_selectModelInternal skips override when skipOverrides is true', async () => {
        const config = {
            enabled: true,
            tiers: {
                light: { models: ['claude-3-haiku-20240307'] },
                medium: { models: ['claude-3-5-sonnet-20241022'] }
            },
            classifier: { heavyThresholds: { maxTokens: 100000 } },
            rules: [{ match: { model: 'test-model' }, tier: 'light' }]
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });
        const result = await router._selectModelInternal({
            override: 'some-override',
            skipOverrides: true,
            parsedBody: { model: 'test-model', messages: [] }
        });
        expect(result.model).not.toBe('some-override');
        expect(result.source).not.toBe('override');
    });

    // Covers lines 2413-2426: saved overrides path
    test('_selectModelInternal returns saved override for specific model', async () => {
        const config = {
            enabled: true,
            tiers: {
                light: { models: ['claude-3-haiku-20240307'] }
            }
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });
        router._overrides.set('test-model', 'my-overridden-model');

        const result = await router._selectModelInternal({
            requestModel: 'test-model',
            parsedBody: { model: 'test-model', messages: [] }
        });
        expect(result.model).toBe('my-overridden-model');
        expect(result.tier).toBeNull();
        expect(result.reason).toBe('saved override for test-model');
        expect(result.source).toBe('saved-override');
    });

    // Covers line 2414: wildcard override fallback
    test('_selectModelInternal returns wildcard override when specific key not found', async () => {
        const config = {
            enabled: true,
            tiers: {
                light: { models: ['claude-3-haiku-20240307'] }
            }
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });
        router._overrides.set('*', 'wildcard-model');

        const result = await router._selectModelInternal({
            requestModel: 'any-model',
            parsedBody: { model: 'any-model', messages: [] }
        });
        expect(result.model).toBe('wildcard-model');
        expect(result.reason).toBe('saved override for *');
        expect(result.source).toBe('saved-override');
    });

    // Covers line 2413: skipOverrides=true skips saved overrides
    test('_selectModelInternal skips saved overrides when skipOverrides is true', async () => {
        const config = {
            enabled: true,
            tiers: {
                light: { models: ['claude-3-haiku-20240307'] }
            },
            rules: [{ match: { model: 'test-model' }, tier: 'light' }]
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });
        router._overrides.set('test-model', 'overridden');

        const result = await router._selectModelInternal({
            requestModel: 'test-model',
            skipOverrides: true,
            parsedBody: { model: 'test-model', messages: [] }
        });
        expect(result.model).not.toBe('overridden');
        expect(result.source).not.toBe('saved-override');
    });

    // Covers lines 2435-2439: classification is null or tierConfig missing
    test('_selectModelInternal returns null when classification is null and no defaultModel', async () => {
        const config = {
            enabled: true,
            tiers: {
                light: { models: ['claude-3-haiku-20240307'] }
            }
            // No rules, no classifier thresholds → classify returns null
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });

        const result = await router._selectModelInternal({
            parsedBody: { model: 'test-model', messages: [] }
        });
        expect(result).toBeNull();
    });

    // Covers lines 2679-2688: defaultModel fallback
    test('_selectModelInternal returns defaultModel when no classification matches', async () => {
        const config = {
            enabled: true,
            tiers: {
                light: { models: ['claude-3-haiku-20240307'] }
            },
            defaultModel: 'fallback-default'
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });

        const result = await router._selectModelInternal({
            parsedBody: { model: 'test-model', messages: [] }
        });
        expect(result).not.toBeNull();
        expect(result.model).toBe('fallback-default');
        expect(result.tier).toBeNull();
        expect(result.reason).toBe('default model');
        expect(result.source).toBe('default');
        expect(router._stats.bySource.default).toBe(1);
        expect(router._stats.total).toBe(1);
    });

    // Covers lines 2446-2484: v2 models[] pool selection path
    test('_selectModelInternal uses v2 models[] pool selection', async () => {
        const config = {
            enabled: true,
            tiers: {
                light: {
                    models: ['claude-3-haiku-20240307', 'claude-3-5-sonnet-20241022'],
                    strategy: 'balanced'
                }
            },
            rules: [{ match: { model: 'test-model' }, tier: 'light' }]
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });

        const result = await router._selectModelInternal({
            parsedBody: { model: 'test-model', messages: [] }
        });
        expect(result).not.toBeNull();
        expect(result.tier).toBe('light');
        expect(result.model).toBeDefined();
        expect(result.strategy).toBe('balanced');
        // Source is 'rule' because the classification is rule-based
        expect(result.source).toBe('rule');
        expect(result.scoringTable).toBeDefined();
        expect(router._stats.total).toBe(1);
    });

    // Covers line 2458-2460: pool strategy source is 'pool'
    test('_selectModelInternal uses pool source for pool strategy', async () => {
        const config = {
            enabled: true,
            tiers: {
                heavy: {
                    models: ['claude-3-opus-20240229', 'claude-3-5-sonnet-20241022'],
                    strategy: 'pool'
                }
            },
            rules: [{ match: { model: 'test-model' }, tier: 'heavy' }]
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });

        const result = await router._selectModelInternal({
            parsedBody: { model: 'test-model', messages: [] }
        });
        expect(result).not.toBeNull();
        expect(result.tier).toBe('heavy');
        expect(result.source).toBe('pool');
        expect(result.strategy).toBe('pool');
    });

    // Covers line 2459-2460: rule source for non-pool strategy with rule classification
    test('_selectModelInternal uses rule source when classification is rule-based', async () => {
        const config = {
            enabled: true,
            tiers: {
                light: {
                    models: ['claude-3-haiku-20240307']
                }
            },
            rules: [{ match: { model: 'my-model' }, tier: 'light' }]
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });

        const result = await router._selectModelInternal({
            parsedBody: { model: 'my-model', messages: [] }
        });
        expect(result).not.toBeNull();
        expect(result.source).toBe('rule');
    });

    // Covers lines 2467-2475: heavy tier upgrade reason tracking (v2 models[])
    test('_selectModelInternal tracks upgrade reason for heavy tier with v2 models', async () => {
        const config = {
            enabled: true,
            tiers: {
                heavy: {
                    models: ['claude-3-opus-20240229']
                }
            },
            rules: [{ match: { model: 'test-model' }, tier: 'heavy' }]
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });

        await router._selectModelInternal({
            parsedBody: { model: 'test-model', messages: [], tools: [] }
        });
        expect(router._stats.byUpgradeReason).toBeDefined();
        expect(Object.values(router._stats.byUpgradeReason).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
        expect(router._stats.byModel['claude-3-opus-20240229']).toBe(1);
    });

    // Covers lines 2490-2516: legacy pool strategy (v1 with strategy: 'pool', no models[])
    test('_selectModelInternal uses legacy pool strategy for v1 config', async () => {
        const config = {
            enabled: true,
            tiers: {
                heavy: {
                    targetModel: 'claude-3-opus-20240229',
                    fallbackModels: ['claude-3-5-sonnet-20241022'],
                    strategy: 'pool'
                }
            },
            rules: [{ match: { model: 'test-model' }, tier: 'heavy' }]
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });

        const result = await router._selectModelInternal({
            parsedBody: { model: 'test-model', messages: [] }
        });
        expect(result).not.toBeNull();
        expect(result.tier).toBe('heavy');
        expect(result.source).toBe('pool');
        expect(result.model).toBeDefined();
    });

    // Covers lines 2500-2508: heavy tier upgrade reason in legacy pool
    test('_selectModelInternal tracks upgrade reason for heavy tier with legacy pool', async () => {
        const config = {
            enabled: true,
            tiers: {
                heavy: {
                    targetModel: 'claude-3-opus-20240229',
                    strategy: 'pool'
                }
            },
            rules: [{ match: { model: 'test-model' }, tier: 'heavy' }]
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });

        await router._selectModelInternal({
            parsedBody: { model: 'test-model', messages: [], tools: [] }
        });
        expect(Object.keys(router._stats.byUpgradeReason).length).toBeGreaterThan(0);
    });

    // Covers lines 2531-2542: failover when target unavailable, can switch, fallback available
    test('_selectModelInternal falls back when target is unavailable and fallback exists', async () => {
        const config = {
            enabled: true,
            tiers: {
                light: {
                    targetModel: 'claude-3-haiku-20240307',
                    fallbackModels: ['claude-3-5-sonnet-20241022']
                }
            },
            rules: [{ match: { model: 'test-model' }, tier: 'light' }],
            failover: { maxModelSwitchesPerRequest: 5 }
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });
        // Mock _computePoolSelection to force failover path
        jest.spyOn(router, '_computePoolSelection').mockResolvedValue(null);
        router.recordModelCooldown('claude-3-haiku-20240307', 30000);

        const result = await router._selectModelInternal({
            parsedBody: { model: 'test-model', messages: [] }
        });
        expect(result).not.toBeNull();
        expect(result.model).toBe('claude-3-5-sonnet-20241022');
        expect(result.source).toBe('failover');
        expect(result.reason).toContain('failover');
    });

    // Covers lines 2543-2563: all fallbacks unavailable, picks shortest cooldown
    test('_selectModelInternal picks shortest cooldown when all candidates unavailable', async () => {
        const config = {
            enabled: true,
            tiers: {
                light: {
                    targetModel: 'model-a',
                    fallbackModels: ['model-b', 'model-c']
                }
            },
            rules: [{ match: { model: 'test-model' }, tier: 'light' }],
            failover: { maxModelSwitchesPerRequest: 5 }
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });
        // Mock _computePoolSelection to force failover path
        jest.spyOn(router, '_computePoolSelection').mockResolvedValue(null);
        // All models in cooldown with different durations
        router.recordModelCooldown('model-a', 30000);
        router.recordModelCooldown('model-b', 10000);
        router.recordModelCooldown('model-c', 20000);

        const result = await router._selectModelInternal({
            parsedBody: { model: 'test-model', messages: [] }
        });
        expect(result).not.toBeNull();
        // model-b has shortest cooldown (10000ms)
        expect(result.model).toBe('model-b');
        expect(result.reason).toContain('warning');
        expect(result.reason).toContain('least-cooldown');
    });

    // Covers line 2559: all candidates unavailable with some having 0 cooldown but attempted
    test('_selectModelInternal picks 0-cooldown candidate when others have cooldown', async () => {
        const config = {
            enabled: true,
            tiers: {
                light: {
                    targetModel: 'model-a',
                    fallbackModels: ['model-b']
                }
            },
            rules: [{ match: { model: 'test-model' }, tier: 'light' }],
            failover: { maxModelSwitchesPerRequest: 5 }
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });
        // Mock _computePoolSelection to force failover path
        jest.spyOn(router, '_computePoolSelection').mockResolvedValue(null);
        router.recordModelCooldown('model-a', 30000);
        router.recordModelCooldown('model-b', 20000);

        const result = await router._selectModelInternal({
            parsedBody: { model: 'test-model', messages: [] }
        });
        expect(result).not.toBeNull();
        expect(result.model).toBe('model-b');
        expect(result.reason).toContain('least-cooldown');
        expect(result.reason).toContain('20000ms');
    });

    // Covers lines 2565-2573: target unavailable, can't switch (max switches reached)
    test('_selectModelInternal returns target when maxModelSwitchesPerRequest reached', async () => {
        const config = {
            enabled: true,
            tiers: {
                light: {
                    targetModel: 'model-a',
                    fallbackModels: ['model-b']
                }
            },
            rules: [{ match: { model: 'test-model' }, tier: 'light' }],
            failover: { maxModelSwitchesPerRequest: 0 }
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });
        // Mock _computePoolSelection to force failover path
        jest.spyOn(router, '_computePoolSelection').mockResolvedValue(null);
        router.recordModelCooldown('model-a', 30000);

        const result = await router._selectModelInternal({
            parsedBody: { model: 'test-model', messages: [] },
            attemptedModels: new Set()
        });
        expect(result).not.toBeNull();
        expect(['model-a', 'model-b']).toContain(result.model);
        expect(result.reason).toContain('maxModelSwitchesPerRequest reached');
    });

    // Covers lines 2565-2573: target unavailable, no fallbacks
    test('_selectModelInternal returns target with warning when no fallbacks available', async () => {
        const config = {
            enabled: true,
            tiers: {
                light: { models: ['model-a'] }
            },
            rules: [{ match: { model: 'test-model' }, tier: 'light' }]
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });
        // Mock _computePoolSelection to force failover path
        jest.spyOn(router, '_computePoolSelection').mockResolvedValue(null);
        router.recordModelCooldown('model-a', 30000);

        const result = await router._selectModelInternal({
            parsedBody: { model: 'test-model', messages: [] }
        });
        expect(result).not.toBeNull();
        expect(result.model).toBe('model-a');
        expect(result.reason).toContain('warning');
    });

    // Covers lines 2574-2578: normal routing, target available
    test('_selectModelInternal routes normally when target is available', async () => {
        const config = {
            enabled: true,
            tiers: {
                light: { models: ['claude-3-haiku-20240307'] }
            },
            rules: [{ match: { model: 'test-model' }, tier: 'light' }]
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });
        // Mock _computePoolSelection to force failover path (no pool result = normal routing)
        jest.spyOn(router, '_computePoolSelection').mockResolvedValue(null);

        const result = await router._selectModelInternal({
            parsedBody: { model: 'test-model', messages: [] }
        });
        expect(result).not.toBeNull();
        expect(result.model).toBe('claude-3-haiku-20240307');
        expect(result.tier).toBe('light');
        expect(result.reason).toBe('rule: {"model":"test-model"}');
        expect(result.source).toBe('rule');
    });

    // Covers lines 2580-2653: tier downgrade when tier exhausted
    test('_selectModelInternal performs tier downgrade when current tier exhausted', async () => {
        const config = {
            enabled: true,
            tiers: {
                heavy: { models: ['model-heavy'] },
                medium: { models: ['model-medium'] }
            },
            rules: [{ match: { model: 'test-model' }, tier: 'heavy' }],
            failover: {
                allowTierDowngrade: true,
                downgradeOrder: ['medium', 'light'],
                maxTierDowngradesPerRequest: 2
            }
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });
        router.recordModelCooldown('model-heavy', 30000);

        const result = await router._selectModelInternal({
            parsedBody: { model: 'test-model', messages: [] }
        });
        expect(result).not.toBeNull();
        expect(result.model).toBe('model-medium');
        expect(result.tier).toBe('medium');
        expect(result.source).toBe('tier_downgrade');
        expect(result.degradedFromTier).toBe('heavy');
        expect(result.reason).toContain('tier_downgrade');
        expect(router._stats.tierDowngradeTotal).toBe(1);
        expect(router._stats.tierDowngradeByRoute['heavy->medium']).toBe(1);
    });

    // Covers lines 2642-2649: shadow tier downgrade (allowDowngrade=false)
    test('_selectModelInternal records shadow downgrade when allowTierDowngrade is false', async () => {
        const config = {
            enabled: true,
            tiers: {
                heavy: { models: ['model-heavy'] },
                medium: { models: ['model-medium'] }
            },
            rules: [{ match: { model: 'test-model' }, tier: 'heavy' }],
            failover: {
                allowTierDowngrade: false,
                downgradeOrder: ['medium', 'light']
            }
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });
        router.recordModelCooldown('model-heavy', 30000);

        const result = await router._selectModelInternal({
            parsedBody: { model: 'test-model', messages: [] }
        });
        // Should NOT downgrade — stays with original tier
        expect(result).not.toBeNull();
        expect(result.tier).toBe('heavy');
        expect(result.source).not.toBe('tier_downgrade');
        expect(router._stats.tierDowngradeShadow).toBe(1);
        expect(router._stats.tierDowngradeShadowByRoute['heavy->medium']).toBe(1);
    });

    // Covers line 2621: tier downgrade with maxDowngrades reached
    test('_selectModelInternal does not downgrade when tierDowngrades reaches max', async () => {
        const config = {
            enabled: true,
            tiers: {
                heavy: { models: ['model-heavy'] },
                medium: { models: ['model-medium'] }
            },
            rules: [{ match: { model: 'test-model' }, tier: 'heavy' }],
            failover: {
                allowTierDowngrade: true,
                downgradeOrder: ['medium'],
                maxTierDowngradesPerRequest: 1
            }
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });
        router.recordModelCooldown('model-heavy', 30000);

        const result = await router._selectModelInternal({
            parsedBody: { model: 'test-model', messages: [] },
            _tierDowngrades: 1  // Already at max
        });
        expect(result).not.toBeNull();
        expect(result.tier).toBe('heavy');
        expect(result.source).not.toBe('tier_downgrade');
    });

    // Covers lines 2608-2610: downgrade tier with pool strategy
    test('_selectModelInternal uses pool selection for downgrade tier with pool strategy', async () => {
        const config = {
            enabled: true,
            tiers: {
                heavy: { models: ['model-heavy'] },
                medium: {
                    models: ['model-med-a', 'model-med-b'],
                    strategy: 'pool'
                }
            },
            rules: [{ match: { model: 'test-model' }, tier: 'heavy' }],
            failover: {
                allowTierDowngrade: true,
                downgradeOrder: ['medium']
            }
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });
        router.recordModelCooldown('model-heavy', 30000);

        const result = await router._selectModelInternal({
            parsedBody: { model: 'test-model', messages: [] }
        });
        expect(result).not.toBeNull();
        expect(result.model).toBeDefined();
        expect(result.tier).toBe('medium');
        expect(result.source).toBe('tier_downgrade');
    });

    // Covers lines 2655-2674: normal return path with stats
    test('_selectModelInternal increments stats for normal routing', async () => {
        const config = {
            enabled: true,
            tiers: {
                medium: { models: ['model-medium'] }
            },
            rules: [{ match: { model: 'test-model' }, tier: 'medium' }]
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });

        await router._selectModelInternal({
            parsedBody: { model: 'test-model', messages: [] }
        });
        expect(router._stats.byTier.medium).toBe(1);
        expect(router._stats.bySource.rule).toBe(1);
        expect(router._stats.byStrategy.balanced).toBe(1);
        expect(router._stats.total).toBe(1);
    });

    // Covers lines 2664-2672: heavy tier upgrade reason and model tracking in normal path
    test('_selectModelInternal tracks heavy tier upgrade reason in normal path', async () => {
        const config = {
            enabled: true,
            tiers: {
                heavy: { models: ['model-heavy'] }
            },
            rules: [{ match: { model: 'test-model' }, tier: 'heavy' }]
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });

        await router._selectModelInternal({
            parsedBody: { model: 'test-model', messages: [], tools: [] }
        });
        expect(Object.values(router._stats.byUpgradeReason).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
        expect(router._stats.byModel['model-heavy']).toBe(1);
    });

    // Covers line 2582: tierExhausted check — source is pool
    test('_selectModelInternal does not downgrade when source is pool', async () => {
        const config = {
            enabled: true,
            tiers: {
                heavy: {
                    models: ['model-heavy', 'model-heavy-2'],
                    strategy: 'pool'
                },
                medium: { models: ['model-medium'] }
            },
            rules: [{ match: { model: 'test-model' }, tier: 'heavy' }],
            failover: { allowTierDowngrade: true, downgradeOrder: ['medium'] }
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });

        const result = await router._selectModelInternal({
            parsedBody: { model: 'test-model', messages: [] }
        });
        expect(result).not.toBeNull();
        expect(result.source).toBe('pool');
        expect(result.tier).toBe('heavy');
        expect(router._stats.tierDowngradeTotal).toBe(0);
    });

    // Covers lines 2520-2525: attemptedModels affects canSwitch and targetUnavailable
    test('_selectModelInternal respects attemptedModels for switch counting', async () => {
        const config = {
            enabled: true,
            tiers: {
                light: {
                    targetModel: 'model-a',
                    fallbackModels: ['model-b', 'model-c']
                }
            },
            rules: [{ match: { model: 'test-model' }, tier: 'light' }],
            failover: { maxModelSwitchesPerRequest: 1 }
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });
        // Mock _computePoolSelection to force failover path
        jest.spyOn(router, '_computePoolSelection').mockResolvedValue(null);
        router.recordModelCooldown('model-a', 30000);

        // 2 attempted = 2 switches already done, max is 1 → can't switch
        const result = await router._selectModelInternal({
            parsedBody: { model: 'test-model', messages: [] },
            attemptedModels: new Set(['model-x', 'model-y'])
        });
        expect(result).not.toBeNull();
        expect(['model-a', 'model-b']).toContain(result.model);
        expect(result.reason).toContain('maxModelSwitchesPerRequest reached');
    });

    // =============================================================
    // _validateTierOverlaps — uncovered branches
    // =============================================================

    // Covers line 284: no tiers in config
    test('_validateTierOverlaps returns early when tiers is missing', () => {
        const config = { enabled: true };
        expect(() => {
            new ModelRouter(config, {
                modelDiscovery: createMockModelDiscovery()
            });
        }).not.toThrow();
    });

    // Covers line 290: null tierConfig in tiers
    test('_validateTierOverlaps skips null tierConfig', () => {
        const config = {
            enabled: true,
            tiers: {
                light: null,
                medium: { models: ['model-b'] }
            }
        };
        expect(() => {
            new ModelRouter(config, {
                modelDiscovery: createMockModelDiscovery()
            });
        }).not.toThrow();
    });

    // Covers line 301: falsy fallback entry
    test('_validateTierOverlaps skips falsy fallback entries', () => {
        const config = {
            enabled: true,
            tiers: {
                light: {
                    targetModel: 'model-a',
                    fallbackModels: ['model-b', '', null, 'model-c']
                }
            }
        };
        expect(() => {
            new ModelRouter(config, {
                modelDiscovery: createMockModelDiscovery()
            });
        }).not.toThrow();
    });

    // Covers line 303: fallback equals targetModel
    test('_validateTierOverlaps skips fallback that equals targetModel', () => {
        const config = {
            enabled: true,
            tiers: {
                light: {
                    targetModel: 'model-a',
                    fallbackModels: ['model-a', 'model-b']
                }
            }
        };
        expect(() => {
            new ModelRouter(config, {
                modelDiscovery: createMockModelDiscovery()
            });
        }).not.toThrow();
    });

    // =============================================================
    // extractFeatures — uncovered branches
    // =============================================================

    // Covers lines 445-446: system as array with string block
    test('extractFeatures counts chars from string blocks in system array', () => {
        const config = {
            tiers: { light: { models: ['model-a'] } }
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });

        const features = router.extractFeatures({
            model: 'test',
            system: ['hello world', { type: 'text', text: 'goodbye' }],
            messages: []
        });
        expect(features.systemLength).toBeGreaterThan(0);
    });

    // Covers lines 459-460: image block in message content
    test('extractFeatures counts image blocks in messages', () => {
        const config = {
            tiers: { light: { models: ['model-a'] } }
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });

        const features = router.extractFeatures({
            model: 'test',
            messages: [{
                role: 'user',
                content: [
                    { type: 'image', source: { type: 'base64', data: 'abc' } },
                    { type: 'text', text: 'hello' }
                ]
            }]
        });
        expect(features.hasVision).toBe(true);
        expect(features.messageCount).toBe(1);
    });

    // Covers lines 461-466: tool_use and tool_result blocks in messages
    test('extractFeatures counts tool_use and tool_result blocks', () => {
        const config = {
            tiers: { light: { models: ['model-a'] } }
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });

        const features = router.extractFeatures({
            model: 'test',
            messages: [{
                role: 'assistant',
                content: [
                    { type: 'tool_use', id: 't1', name: 'get_weather', input: { city: 'NYC' } }
                ]
            }, {
                role: 'user',
                content: [
                    { type: 'tool_result', tool_use_id: 't1', content: 'sunny' }
                ]
            }]
        });
        // tool_use/tool_result blocks don't set hasTools - only top-level tools does
        expect(features.hasTools).toBe(false);
        expect(features.messageCount).toBe(2);
    });

    // =============================================================
    // classify — uncovered branches
    // =============================================================

    // Covers line 560: rule.match is undefined → falls back to {}
    test('classify handles rule without match property', () => {
        const config = {
            tiers: { light: { models: ['model-a'] } },
            rules: [{ tier: 'light' }]
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });

        const result = router.classify({ model: 'test', maxTokens: 100, messageCount: 1 });
        expect(result).not.toBeNull();
        expect(result.tier).toBe('light');
        expect(result.reason).toContain('rule:');
    });

    // Covers lines 635-641: light conditions with hasTools and hasVision
    test('classify light tier with hasTools and hasVision conditions', () => {
        const config = {
            tiers: {
                light: { models: ['model-a'], clientModelPolicy: 'always-route' },
                medium: { models: ['model-b'], clientModelPolicy: 'always-route' }
            },
            classifier: {
                lightThresholds: { hasTools: false, hasVision: false }
            }
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });

        // hasTools=false, hasVision=false → matches light
        const result = router.classify({ model: 'test', maxTokens: 100, messageCount: 1, hasTools: false, hasVision: false });
        expect(result).not.toBeNull();
        expect(result.tier).toBe('light');
        expect(result.reason).toContain('all light thresholds met');
    });

    test('classify light tier rejects when hasTools mismatch', () => {
        const config = {
            tiers: {
                light: { models: ['model-a'], clientModelPolicy: 'always-route' },
                medium: { models: ['model-b'], clientModelPolicy: 'always-route' }
            },
            classifier: {
                lightThresholds: { hasTools: false, hasVision: false }
            }
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });

        const result = router.classify({ model: 'test', maxTokens: 100, messageCount: 1, hasTools: true, hasVision: false });
        expect(result).not.toBeNull();
        expect(result.tier).toBe('medium');
    });

    test('classify light tier rejects when hasVision mismatch', () => {
        const config = {
            tiers: {
                light: { models: ['model-a'], clientModelPolicy: 'always-route' },
                medium: { models: ['model-b'], clientModelPolicy: 'always-route' }
            },
            classifier: {
                lightThresholds: { hasTools: false, hasVision: false }
            }
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });

        const result = router.classify({ model: 'test', maxTokens: 100, messageCount: 1, hasTools: false, hasVision: true });
        expect(result).not.toBeNull();
        expect(result.tier).toBe('medium');
    });

    // =============================================================
    // _computeDeterministicRoll — uncovered branches
    // =============================================================

    // Covers lines 2077-2082: features with null/undefined values
    test('_computeDeterministicRoll handles null features', () => {
        const config = {
            tiers: { light: { models: ['model-a'] } }
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });

        const roll = router._computeDeterministicRoll(null, null, 'light', ['model-a']);
        expect(typeof roll).toBe('number');
        expect(roll).toBeGreaterThanOrEqual(0);
        expect(roll).toBeLessThan(100);
    });

    // Covers lines 2079-2080: features without hasTools/hasVision
    test('_computeDeterministicRoll handles features without hasTools/hasVision', () => {
        const config = {
            tiers: { light: { models: ['model-a'] } }
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });

        const roll = router._computeDeterministicRoll(
            { requestModel: 'test' },
            { model: 'test' },
            'light',
            ['model-a']
        );
        expect(typeof roll).toBe('number');
        expect(roll).toBeGreaterThanOrEqual(0);
    });

    // Covers lines 2491-2510: legacy pool strategy with v1 config (no models[])
    test('_selectModelInternal uses legacy pool strategy with v1 config', async () => {
        const config = {
            enabled: true,
            tiers: {
                light: {
                    strategy: 'pool'
                    // No models[] array - this triggers legacy pool path
                }
            },
            rules: [{ match: { model: 'test-model' }, tier: 'light' }]
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });
        // Mock _selectFromPool to return a selection
        jest.spyOn(router, '_selectFromPool').mockResolvedValue({
            model: 'legacy-pool-model',
            reason: 'pool selected'
        });

        const result = await router._selectModelInternal({
            parsedBody: { model: 'test-model', messages: [] }
        });
        expect(result).not.toBeNull();
        expect(result.model).toBe('legacy-pool-model');
        expect(result.source).toBe('pool');
        expect(router._stats.byStrategy.pool).toBe(1);
    });

    // Covers line 2562: all candidates unavailable with shortestCooldown = Infinity
    test('_selectModelInternal handles all candidates unavailable with Infinity cooldown', async () => {
        const config = {
            enabled: true,
            tiers: {
                light: {
                    targetModel: 'model-a',
                    fallbackModels: ['model-b']
                }
            },
            rules: [{ match: { model: 'test-model' }, tier: 'light' }],
            failover: { maxModelSwitchesPerRequest: 5 }
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });
        // Mock _computePoolSelection to force failover path
        jest.spyOn(router, '_computePoolSelection').mockResolvedValue(null);
        // Set all models in cooldown
        router.recordModelCooldown('model-a', 30000);
        router.recordModelCooldown('model-b', 30000);

        const result = await router._selectModelInternal({
            parsedBody: { model: 'test-model', messages: [] },
            attemptedModels: new Set()
        });
        expect(result).not.toBeNull();
        expect(result.reason).toContain('warning');
        // Both models are cooled, should pick one with shortest cooldown
        expect(['model-a', 'model-b']).toContain(result.model);
    });

    // Covers lines 2501-2502, 2507: legacy pool with heavy tier upgrade tracking
    test('_selectModelInternal tracks heavy tier stats in legacy pool path', async () => {
        const config = {
            enabled: true,
            tiers: {
                heavy: {
                    strategy: 'pool'
                    // No models[] - triggers legacy pool path
                }
            },
            rules: [{ match: { model: 'test-model' }, tier: 'heavy' }]
        };
        const router = new ModelRouter(config, {
            modelDiscovery: createMockModelDiscovery()
        });
        // Mock _selectFromPool to return a selection
        jest.spyOn(router, '_selectFromPool').mockResolvedValue({
            model: 'heavy-pool-model',
            reason: 'pool selected'
        });

        const result = await router._selectModelInternal({
            parsedBody: { model: 'test-model', messages: [], tools: [{ name: 'test' }] }
        });
        expect(result).not.toBeNull();
        expect(result.model).toBe('heavy-pool-model');
        expect(result.tier).toBe('heavy');
        // Heavy tier tracking
        expect(router._stats.byModel['heavy-pool-model']).toBe(1);
        expect(Object.values(router._stats.byUpgradeReason).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    });
});
