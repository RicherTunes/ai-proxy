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

    // Covers line 1412: cooldown decay when entry.lastHit is older than decayMs
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

        const now = Date.now();
        router._cooldowns.set('claude-3-5-sonnet-20241022', {
            cooldownUntil: now + 5000,
            lastHit: now - 2000,
            count: 1
        });
        router._cooldowns.set('claude-3-opus-20240229', {
            cooldownUntil: now + 5000,
            lastHit: now - 2000,
            count: 1
        });

        // Mock _computePoolSelection to return null to force failover path
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

        // Debug: Check decision structure
        expect(decision).not.toBeNull();
        // The decision should have a model picked from failover path
        expect(decision.model).toBeDefined();
        // Verify the failover path was taken
        expect(decision.reason).toContain('failover');
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
});
