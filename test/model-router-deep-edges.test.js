/**
 * ModelRouter Deep-Edge Tests
 *
 * Covers deep branches and edge cases:
 * 1. _applyGlm5Preference with glm-5 absent from candidates
 * 2. _applyGlm5Preference disabled (enabled=false)
 * 3. _applyGlm5Preference roll below/above percent
 * 4. _computeDeterministicRoll same requestId → same roll
 * 5. _computeDeterministicRoll different IDs → different rolls
 * 6. Pool 429 tracking (recordPool429 / getPool429Count)
 * 7. Pool 429 window expiry (fake timers)
 * 8. Tier downgrade path (heavy exhausted → medium)
 * 9. All tiers exhausted → null with trace
 * 10. Config hot-reload (updateConfig mid-flight)
 * 11. Override limit (maxOverrides rejection)
 * 12. Concurrent selectModel calls don't interfere
 */

jest.mock('../lib/atomic-write', () => ({
    atomicWrite: jest.fn().mockResolvedValue()
}));

const fs = require('fs');

const originalReadFileSync = fs.readFileSync;
jest.spyOn(fs, 'readFileSync').mockImplementation((filePath, encoding) => {
    if (typeof filePath === 'string' && filePath.includes('model-routing-overrides')) {
        return '{}';
    }
    return originalReadFileSync(filePath, encoding);
});

const { ModelRouter } = require('../lib/model-router');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a v2-style config with models[] arrays */
function makeV2Config(overrides = {}) {
    return {
        version: '2.0',
        enabled: true,
        tiers: {
            light: {
                models: ['glm-4-flash', 'glm-4-air'],
                strategy: 'balanced',
                clientModelPolicy: 'always-route'
            },
            medium: {
                models: ['glm-4-air', 'glm-4-flash'],
                strategy: 'balanced',
                clientModelPolicy: 'always-route'
            },
            heavy: {
                models: ['glm-4-plus', 'glm-4-air'],
                strategy: 'quality',
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
        defaultModel: 'glm-4-air',
        logDecisions: false,
        pool429Penalty: { enabled: true, windowMs: 120000, maxPenaltyHits: 20, penaltyWeight: 0.5 },
        ...overrides
    };
}

/** Build a minimal Anthropic request body */
function makeBody(overrides = {}) {
    return {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
        system: 'You are helpful.',
        stream: false,
        ...overrides
    };
}

/** Mock ModelDiscovery */
function makeMockDiscovery(metaMap = {}) {
    return {
        getModel: jest.fn().mockImplementation(async (modelId) => {
            return metaMap[modelId] || { maxConcurrency: 4, contextLength: 200000 };
        }),
        getModelCached: jest.fn().mockImplementation((modelId) => {
            return metaMap[modelId] || { maxConcurrency: 4, contextLength: 200000 };
        })
    };
}

/** Create a router with given config and optional options */
function makeRouter(config, opts = {}) {
    const discovery = opts.modelDiscovery || makeMockDiscovery();
    return new ModelRouter(config, {
        persistEnabled: false,
        modelDiscovery: discovery,
        ...opts
    });
}

// ===========================================================================
// 1. _applyGlm5Preference with glm-5 absent
// ===========================================================================
describe('_applyGlm5Preference with glm-5 absent from candidates', () => {
    test('returns scored array unmodified when glm-5 is not present', () => {
        const config = makeV2Config({
            glm5: { enabled: true, preferencePercent: 100 }
        });
        const router = makeRouter(config);

        const scored = [
            { model: 'glm-4-plus', score: 0.8, position: 0 },
            { model: 'glm-4-air', score: 0.6, position: 1 }
        ];
        const original = scored.map(s => ({ ...s }));

        const result = router._applyGlm5Preference('heavy', ['glm-4-plus', 'glm-4-air'], scored, {});
        // Scores should be unchanged — early return path
        expect(result).toBe(scored);
        expect(result[0].score).toBe(original[0].score);
        expect(result[1].score).toBe(original[1].score);
    });

    test('returns scored array unmodified for non-heavy tiers even if glm-5 present', () => {
        const config = makeV2Config({
            glm5: { enabled: true, preferencePercent: 100 }
        });
        const router = makeRouter(config);

        const scored = [
            { model: 'glm-5', score: 0.8, position: 0 },
            { model: 'glm-4-air', score: 0.6, position: 1 }
        ];
        const originalGlm5Score = scored[0].score;

        const result = router._applyGlm5Preference('medium', ['glm-5', 'glm-4-air'], scored, {});
        expect(result).toBe(scored);
        // glm-5 score unmodified — method returns early for non-heavy tier
        expect(result[0].score).toBe(originalGlm5Score);
    });
});

// ===========================================================================
// 2. _applyGlm5Preference disabled (enabled=false)
// ===========================================================================
describe('_applyGlm5Preference disabled', () => {
    test('sets glm-5 score to -Infinity when enabled=false', () => {
        const config = makeV2Config({
            glm5: { enabled: false, preferencePercent: 100 }
        });
        const router = makeRouter(config);

        const scored = [
            { model: 'glm-5', score: 0.9, position: 0 },
            { model: 'glm-4-plus', score: 0.7, position: 1 }
        ];

        const result = router._applyGlm5Preference('heavy', ['glm-5', 'glm-4-plus'], scored, {});
        const glm5 = result.find(s => s.model === 'glm-5');
        expect(glm5.score).toBe(-Infinity);
        expect(glm5.disabled).toBe(true);
    });

    test('other candidates scores remain untouched when disabled', () => {
        const config = makeV2Config({
            glm5: { enabled: false }
        });
        const router = makeRouter(config);

        const scored = [
            { model: 'glm-5', score: 0.9, position: 0 },
            { model: 'glm-4-plus', score: 0.7, position: 1 }
        ];

        router._applyGlm5Preference('heavy', ['glm-5', 'glm-4-plus'], scored, {});
        expect(scored[1].score).toBe(0.7);
    });
});

// ===========================================================================
// 3. _applyGlm5Preference roll below/above percent
// ===========================================================================
describe('_applyGlm5Preference roll below/above percent', () => {
    test('boosts glm-5 score to Infinity when roll is below preferencePercent', () => {
        const config = makeV2Config({
            glm5: { enabled: true, preferencePercent: 50 }
        });
        const router = makeRouter(config);

        const scored = [
            { model: 'glm-5', score: 0.5, position: 0 },
            { model: 'glm-4-plus', score: 0.8, position: 1 }
        ];

        // deterministicRoll = 25 → below 50% → boosted
        const decisionMeta = router._createDecisionMeta();
        router._applyGlm5Preference('heavy', ['glm-5', 'glm-4-plus'], scored, {
            deterministicRoll: 25,
            decisionMeta
        });
        const glm5 = scored.find(s => s.model === 'glm-5');
        expect(glm5.score).toBe(Infinity);
        expect(glm5.position).toBe(-1);
        expect(decisionMeta.glm5PreferenceApplied).toBe(1);
    });

    test('does not boost glm-5 score when roll is above preferencePercent (shadow)', () => {
        const config = makeV2Config({
            glm5: { enabled: true, preferencePercent: 50 }
        });
        const router = makeRouter(config);

        const scored = [
            { model: 'glm-5', score: 0.5, position: 0 },
            { model: 'glm-4-plus', score: 0.8, position: 1 }
        ];

        // deterministicRoll = 75 → above 50% → shadow only
        const decisionMeta = router._createDecisionMeta();
        router._applyGlm5Preference('heavy', ['glm-5', 'glm-4-plus'], scored, {
            deterministicRoll: 75,
            decisionMeta
        });
        const glm5 = scored.find(s => s.model === 'glm-5');
        expect(glm5.score).toBe(0.5);
        expect(decisionMeta.glm5PreferenceShadow).toBe(1);
        expect(decisionMeta.glm5PreferenceApplied).toBe(0);
    });

    test('always increments glm5EligibleTotal when enabled', () => {
        const config = makeV2Config({
            glm5: { enabled: true, preferencePercent: 0 }
        });
        const router = makeRouter(config);

        const scored = [
            { model: 'glm-5', score: 0.5, position: 0 }
        ];
        const decisionMeta = router._createDecisionMeta();
        router._applyGlm5Preference('heavy', ['glm-5'], scored, {
            deterministicRoll: 99,
            decisionMeta
        });
        expect(decisionMeta.glm5EligibleTotal).toBe(1);
        // 0% preferencePercent → roll (99) never < 0 → shadow
        expect(decisionMeta.glm5PreferenceShadow).toBe(1);
    });

    test('skips eligibility counter in dryRun mode', () => {
        const config = makeV2Config({
            glm5: { enabled: true, preferencePercent: 100 }
        });
        const router = makeRouter(config);

        const scored = [{ model: 'glm-5', score: 0.5, position: 0 }];
        const decisionMeta = router._createDecisionMeta();
        router._applyGlm5Preference('heavy', ['glm-5'], scored, {
            deterministicRoll: 10,
            dryRun: true,
            decisionMeta
        });
        // Score still boosted but counters not incremented
        expect(scored[0].score).toBe(Infinity);
        expect(decisionMeta.glm5EligibleTotal).toBe(0);
        expect(decisionMeta.glm5PreferenceApplied).toBe(0);
    });
});

// ===========================================================================
// 4. _computeDeterministicRoll — same requestId → same roll
// ===========================================================================
describe('_computeDeterministicRoll determinism', () => {
    test('same inputs always produce same roll value between 0-100', () => {
        const config = makeV2Config();
        const router = makeRouter(config);

        const context = { requestModel: 'claude-sonnet-4-20250514' };
        const features = { maxTokens: 1024, messageCount: 5, systemLength: 100, hasTools: false, hasVision: false };
        const candidates = ['glm-4-plus', 'glm-4-air'];

        const roll1 = router._computeDeterministicRoll(context, features, 'heavy', candidates);
        const roll2 = router._computeDeterministicRoll(context, features, 'heavy', candidates);
        const roll3 = router._computeDeterministicRoll(context, features, 'heavy', candidates);

        expect(roll1).toBe(roll2);
        expect(roll2).toBe(roll3);
        expect(roll1).toBeGreaterThanOrEqual(0);
        expect(roll1).toBeLessThanOrEqual(100);
    });
});

// ===========================================================================
// 5. _computeDeterministicRoll — different IDs → different rolls
// ===========================================================================
describe('_computeDeterministicRoll variance', () => {
    test('different request models produce different roll values', () => {
        const config = makeV2Config();
        const router = makeRouter(config);

        const features = { maxTokens: 1024, messageCount: 5, systemLength: 100, hasTools: false, hasVision: false };
        const candidates = ['glm-4-plus', 'glm-4-air'];

        const rolls = new Set();
        const models = [
            'claude-sonnet-4-20250514',
            'claude-opus-4-20250514',
            'claude-haiku-4-20250514',
            'claude-3-5-sonnet-20241022',
            'gpt-4o',
            'gpt-4-turbo',
            'gemini-pro',
            'mistral-large'
        ];
        for (const requestModel of models) {
            const roll = router._computeDeterministicRoll(
                { requestModel },
                features,
                'heavy',
                candidates
            );
            rolls.add(roll);
            expect(roll).toBeGreaterThanOrEqual(0);
            expect(roll).toBeLessThanOrEqual(100);
        }
        // At least 2 distinct values among 8 different request models
        expect(rolls.size).toBeGreaterThanOrEqual(2);
    });

    test('different tier names produce different rolls for same context', () => {
        const config = makeV2Config();
        const router = makeRouter(config);

        const context = { requestModel: 'claude-sonnet-4-20250514' };
        const features = { maxTokens: 1024, messageCount: 5, systemLength: 100, hasTools: false, hasVision: false };
        const candidates = ['glm-4-plus', 'glm-4-air'];

        const rollHeavy = router._computeDeterministicRoll(context, features, 'heavy', candidates);
        const rollMedium = router._computeDeterministicRoll(context, features, 'medium', candidates);
        const rollLight = router._computeDeterministicRoll(context, features, 'light', candidates);

        // At least two of the three should differ (FNV-1a with distinct seed)
        const unique = new Set([rollHeavy, rollMedium, rollLight]);
        expect(unique.size).toBeGreaterThanOrEqual(2);
    });
});

// ===========================================================================
// 6. Pool 429 tracking
// ===========================================================================
describe('Pool 429 tracking', () => {
    test('recordPool429 increments count and getPool429Count returns it', () => {
        const config = makeV2Config();
        const router = makeRouter(config);

        expect(router.getPool429Count('glm-4-plus')).toBe(0);

        router.recordPool429('glm-4-plus');
        expect(router.getPool429Count('glm-4-plus')).toBe(1);

        router.recordPool429('glm-4-plus');
        router.recordPool429('glm-4-plus');
        expect(router.getPool429Count('glm-4-plus')).toBe(3);
    });

    test('recordPool429 does nothing when pool429Penalty disabled', () => {
        const config = makeV2Config({
            pool429Penalty: { enabled: false }
        });
        const router = makeRouter(config);

        router.recordPool429('glm-4-plus');
        expect(router.getPool429Count('glm-4-plus')).toBe(0);
    });

    test('getPool429Count caps at maxPenaltyHits', () => {
        const config = makeV2Config({
            pool429Penalty: { enabled: true, windowMs: 120000, maxPenaltyHits: 5 }
        });
        const router = makeRouter(config);

        for (let i = 0; i < 10; i++) {
            router.recordPool429('glm-4-plus');
        }
        // Only last 5 retained
        expect(router.getPool429Count('glm-4-plus')).toBe(5);
    });

    test('different models tracked independently', () => {
        const config = makeV2Config();
        const router = makeRouter(config);

        router.recordPool429('glm-4-plus');
        router.recordPool429('glm-4-plus');
        router.recordPool429('glm-4-air');

        expect(router.getPool429Count('glm-4-plus')).toBe(2);
        expect(router.getPool429Count('glm-4-air')).toBe(1);
    });
});

// ===========================================================================
// 7. Pool 429 window expiry (fake timers)
// ===========================================================================
describe('Pool 429 window expiry', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('429 counts within window are returned', () => {
        const config = makeV2Config({
            pool429Penalty: { enabled: true, windowMs: 10000 }
        });
        const router = makeRouter(config);

        router.recordPool429('glm-4-plus');
        jest.advanceTimersByTime(5000); // still within 10s window
        router.recordPool429('glm-4-plus');

        expect(router.getPool429Count('glm-4-plus')).toBe(2);
    });

    test('old 429s outside window are pruned on read', () => {
        const config = makeV2Config({
            pool429Penalty: { enabled: true, windowMs: 10000 }
        });
        const router = makeRouter(config);

        router.recordPool429('glm-4-plus');
        router.recordPool429('glm-4-plus');
        expect(router.getPool429Count('glm-4-plus')).toBe(2);

        // Advance past the window
        jest.advanceTimersByTime(15000);
        expect(router.getPool429Count('glm-4-plus')).toBe(0);
    });

    test('partial expiry: some entries inside, some outside window', () => {
        const config = makeV2Config({
            pool429Penalty: { enabled: true, windowMs: 10000 }
        });
        const router = makeRouter(config);

        router.recordPool429('glm-4-plus'); // t=0
        jest.advanceTimersByTime(6000);
        router.recordPool429('glm-4-plus'); // t=6000

        // Advance to t=11000 — first 429 (t=0) is >10s old, second (t=6000) is 5s old
        jest.advanceTimersByTime(5000);
        expect(router.getPool429Count('glm-4-plus')).toBe(1);
    });

    test('model entry deleted from map when all timestamps expire', () => {
        const config = makeV2Config({
            pool429Penalty: { enabled: true, windowMs: 5000 }
        });
        const router = makeRouter(config);

        router.recordPool429('glm-4-plus');
        expect(router.getPool429Count('glm-4-plus')).toBe(1);

        jest.advanceTimersByTime(6000);
        const count = router.getPool429Count('glm-4-plus');
        expect(count).toBe(0);

        // Internal map entry should have been deleted
        expect(router._recentPool429s.has('glm-4-plus')).toBe(false);
    });
});

// ===========================================================================
// 8. Tier downgrade path
// ===========================================================================
describe('Tier downgrade path', () => {
    test('when heavy tier exhausted, request downgrades to medium tier', async () => {
        const config = makeV2Config({
            tiers: {
                light: {
                    models: ['glm-4-flash'],
                    strategy: 'balanced',
                    clientModelPolicy: 'always-route'
                },
                medium: {
                    models: ['glm-4-air'],
                    strategy: 'balanced',
                    clientModelPolicy: 'always-route'
                },
                heavy: {
                    models: ['glm-4-plus'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            failover: {
                allowTierDowngrade: true,
                downgradeOrder: ['medium', 'light']
            },
            classifier: {
                heavyThresholds: { hasTools: true }
            }
        });

        const discovery = makeMockDiscovery({
            'glm-4-plus': { maxConcurrency: 1, contextLength: 200000 },
            'glm-4-air': { maxConcurrency: 4, contextLength: 200000 },
            'glm-4-flash': { maxConcurrency: 4, contextLength: 200000 }
        });
        const router = makeRouter(config, { modelDiscovery: discovery });

        // Exhaust heavy tier: put glm-4-plus on cooldown
        router.recordModelCooldown('glm-4-plus', 10000);

        // Request that classifies as heavy (has tools)
        const body = makeBody({ tools: [{ name: 'test', description: 'test', input_schema: {} }] });
        const decision = await router.selectModel({
            parsedBody: body,
            requestModel: body.model
        });

        expect(decision).not.toBeNull();
        expect(decision.model).toBe('glm-4-air');
        expect(decision.source).toBe('tier_downgrade');
        expect(decision.degradedFromTier).toBe('heavy');
        expect(decision.tier).toBe('medium');
    });

    test('tier downgrade skips tiers whose candidates are also exhausted', async () => {
        const config = makeV2Config({
            tiers: {
                light: {
                    models: ['glm-4-flash'],
                    strategy: 'balanced',
                    clientModelPolicy: 'always-route'
                },
                medium: {
                    models: ['glm-4-air'],
                    strategy: 'balanced',
                    clientModelPolicy: 'always-route'
                },
                heavy: {
                    models: ['glm-4-plus'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            failover: {
                allowTierDowngrade: true,
                downgradeOrder: ['medium', 'light']
            },
            classifier: {
                heavyThresholds: { hasTools: true }
            }
        });
        const router = makeRouter(config);

        // Exhaust heavy AND medium
        router.recordModelCooldown('glm-4-plus', 10000);
        router.recordModelCooldown('glm-4-air', 10000);

        const body = makeBody({ tools: [{ name: 'test', description: 'test', input_schema: {} }] });
        const decision = await router.selectModel({
            parsedBody: body,
            requestModel: body.model
        });

        // Should fall through to light tier
        expect(decision).not.toBeNull();
        expect(decision.model).toBe('glm-4-flash');
        expect(decision.tier).toBe('light');
    });
});

// ===========================================================================
// 9. All tiers exhausted → returns null with appropriate trace
// ===========================================================================
describe('All tiers exhausted', () => {
    test('returns decision with warning when all tiers are exhausted (best-effort routing)', async () => {
        // When the pool is exhausted, the router falls through to legacy failover
        // logic which returns the model as best-effort with a warning.
        // With cooldown on the only candidate + no fallback + no downgrade + no default,
        // the router still returns the cooled-down model as best-effort.
        const config = makeV2Config({
            tiers: {
                heavy: {
                    models: ['glm-4-plus'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            },
            failover: {
                allowTierDowngrade: true,
                downgradeOrder: []
            },
            classifier: {
                heavyThresholds: { hasTools: true }
            },
            defaultModel: null
        });
        const router = makeRouter(config);

        // Put only model on cooldown — pool selection returns null,
        // legacy failover kicks in best-effort
        router.recordModelCooldown('glm-4-plus', 30000);

        const body = makeBody({ tools: [{ name: 'test', description: 'test', input_schema: {} }] });
        const decision = await router.selectModel({
            parsedBody: body,
            requestModel: body.model
        });

        // Best-effort: returns the cooled-down model with a warning
        expect(decision).not.toBeNull();
        expect(decision.model).toBe('glm-4-plus');
        expect(decision.reason).toContain('warning');
    });

    test('returns null via computeDecision when no classification, no default, router enabled', async () => {
        // A request that matches no rules and no classifier thresholds,
        // with no tiers configured and no defaultModel → null
        const config = makeV2Config({
            tiers: {},
            rules: [],
            classifier: {},
            defaultModel: null
        });
        const router = makeRouter(config);

        const body = makeBody();
        const decision = await router.selectModel({
            parsedBody: body,
            requestModel: body.model
        });

        expect(decision).toBeNull();
    });

    test('returns null when disabled', async () => {
        const config = makeV2Config({ enabled: false });
        const router = makeRouter(config);

        const decision = await router.selectModel({
            parsedBody: makeBody(),
            requestModel: 'claude-sonnet-4-20250514'
        });
        expect(decision).toBeNull();
    });
});

// ===========================================================================
// 10. Config hot-reload
// ===========================================================================
describe('Config hot-reload', () => {
    test('updateConfig changes routing behavior for subsequent requests', async () => {
        const config = makeV2Config();
        const router = makeRouter(config);

        // First request — routes normally to heavy tier (uses tools)
        const bodyHeavy = makeBody({ tools: [{ name: 'test', description: 'test', input_schema: {} }] });
        const decision1 = await router.selectModel({
            parsedBody: bodyHeavy,
            requestModel: bodyHeavy.model
        });
        expect(decision1).not.toBeNull();
        expect(decision1.model).toBe('glm-4-plus');

        // Hot-reload: change heavy tier to use a different primary model
        const newConfig = {
            ...config,
            tiers: {
                ...config.tiers,
                heavy: {
                    models: ['glm-4-new-heavy', 'glm-4-plus'],
                    strategy: 'quality',
                    clientModelPolicy: 'always-route'
                }
            }
        };
        router.updateConfig(newConfig);

        // Release previous slot
        router.releaseModel('glm-4-plus');

        // Second request — should pick the new primary model
        const decision2 = await router.selectModel({
            parsedBody: bodyHeavy,
            requestModel: bodyHeavy.model
        });
        expect(decision2).not.toBeNull();
        expect(decision2.model).toBe('glm-4-new-heavy');
    });

    test('updateConfig preserves cooldown state', async () => {
        const config = makeV2Config();
        const router = makeRouter(config);

        // Set a cooldown
        router.recordModelCooldown('glm-4-plus', 30000);
        const cdBefore = router.getModelCooldown('glm-4-plus');
        expect(cdBefore).toBeGreaterThan(0);

        // Hot-reload config
        router.updateConfig({ ...config });

        // Cooldown should still be active
        const cdAfter = router.getModelCooldown('glm-4-plus');
        expect(cdAfter).toBeGreaterThan(0);
    });

    test('updateConfig preserves overrides', () => {
        const config = makeV2Config();
        const router = makeRouter(config);

        router.setOverride('claude-opus-4-20250514', 'glm-4-plus');

        router.updateConfig({ ...config });

        const overrides = router.getOverrides();
        expect(overrides['claude-opus-4-20250514']).toBe('glm-4-plus');
    });
});

// ===========================================================================
// 11. Override limit (maxOverrides rejection)
// ===========================================================================
describe('Override limit', () => {
    test('rejects new overrides beyond maxOverrides', () => {
        const config = makeV2Config({ maxOverrides: 3 });
        const router = makeRouter(config);

        expect(router.setOverride('key-1', 'model-a')).toBe(true);
        expect(router.setOverride('key-2', 'model-b')).toBe(true);
        expect(router.setOverride('key-3', 'model-c')).toBe(true);

        // 4th override should be rejected
        const result = router.setOverride('key-4', 'model-d');
        expect(result).toBe(false);

        const overrides = router.getOverrides();
        expect(Object.keys(overrides)).toHaveLength(3);
        expect(overrides['key-4']).toBeUndefined();
    });

    test('updating existing override does not count against limit', () => {
        const config = makeV2Config({ maxOverrides: 2 });
        const router = makeRouter(config);

        expect(router.setOverride('key-1', 'model-a')).toBe(true);
        expect(router.setOverride('key-2', 'model-b')).toBe(true);

        // Update existing key — should succeed
        expect(router.setOverride('key-1', 'model-x')).toBe(true);

        const overrides = router.getOverrides();
        expect(overrides['key-1']).toBe('model-x');
    });

    test('clearing an override frees a slot for a new one', () => {
        const config = makeV2Config({ maxOverrides: 2 });
        const router = makeRouter(config);

        router.setOverride('key-1', 'model-a');
        router.setOverride('key-2', 'model-b');

        // At capacity — reject
        expect(router.setOverride('key-3', 'model-c')).toBe(false);

        // Clear one
        router.clearOverride('key-1');

        // Now should succeed
        expect(router.setOverride('key-3', 'model-c')).toBe(true);
        expect(router.getOverrides()['key-3']).toBe('model-c');
    });
});

// ===========================================================================
// 12. Concurrent selectModel calls don't interfere
// ===========================================================================
describe('Concurrent selectModel calls', () => {
    test('multiple simultaneous selectModel calls all get valid decisions', async () => {
        const config = makeV2Config({
            tiers: {
                ...makeV2Config().tiers,
                heavy: {
                    models: ['glm-4-plus', 'glm-4-air'],
                    strategy: 'throughput',
                    clientModelPolicy: 'always-route'
                }
            }
        });
        const discovery = makeMockDiscovery({
            'glm-4-plus': { maxConcurrency: 10, contextLength: 200000 },
            'glm-4-air': { maxConcurrency: 10, contextLength: 200000 },
            'glm-4-flash': { maxConcurrency: 10, contextLength: 200000 }
        });
        const router = makeRouter(config, { modelDiscovery: discovery });

        const bodyHeavy = makeBody({ tools: [{ name: 'test', description: 'test', input_schema: {} }] });

        // Fire 10 concurrent selectModel calls
        const promises = Array.from({ length: 10 }, () =>
            router.selectModel({
                parsedBody: bodyHeavy,
                requestModel: bodyHeavy.model
            })
        );

        const decisions = await Promise.all(promises);

        // All should return non-null decisions
        for (const d of decisions) {
            expect(d).not.toBeNull();
            expect(d.model).toBeDefined();
            expect(['glm-4-plus', 'glm-4-air']).toContain(d.model);
        }

        // Total in-flight should equal 10
        const totalInFlight = (router._inFlight.get('glm-4-plus') || 0)
            + (router._inFlight.get('glm-4-air') || 0);
        expect(totalInFlight).toBe(10);
    });

    test('concurrent calls with limited capacity all resolve (TOCTOU by design)', async () => {
        // Note: selectModel uses compute-then-commit. During concurrent calls,
        // all compute phases see the same in-flight state (TOCTOU by design).
        // The commit phase increments in-flight regardless of capacity checks.
        // This test verifies the behavior is stable (no crashes, valid models).
        const config = makeV2Config({
            tiers: {
                ...makeV2Config().tiers,
                heavy: {
                    models: ['model-a', 'model-b'],
                    strategy: 'throughput',
                    clientModelPolicy: 'always-route'
                }
            }
        });
        const discovery = makeMockDiscovery({
            'model-a': { maxConcurrency: 3, contextLength: 200000 },
            'model-b': { maxConcurrency: 3, contextLength: 200000 },
            'glm-4-flash': { maxConcurrency: 10, contextLength: 200000 },
            'glm-4-air': { maxConcurrency: 10, contextLength: 200000 }
        });
        const router = makeRouter(config, { modelDiscovery: discovery });

        const bodyHeavy = makeBody({ tools: [{ name: 'test', description: 'test', input_schema: {} }] });

        // Fire 6 concurrent calls
        const promises = [];
        for (let i = 0; i < 6; i++) {
            promises.push(
                router.selectModel({
                    parsedBody: bodyHeavy,
                    requestModel: bodyHeavy.model
                })
            );
        }

        const decisions = await Promise.all(promises);

        // All concurrent calls should complete without errors
        const nonNull = decisions.filter(d => d !== null);
        expect(nonNull.length).toBe(6);

        // All decisions should reference valid models
        for (const d of nonNull) {
            expect(['model-a', 'model-b']).toContain(d.model);
        }

        // Total in-flight = 6 (compute-then-commit, TOCTOU allows over-subscription)
        const totalFlight = (router._inFlight.get('model-a') || 0)
            + (router._inFlight.get('model-b') || 0);
        expect(totalFlight).toBe(6);
    });

    test('concurrent calls do not corrupt stats counters', async () => {
        const config = makeV2Config();
        const discovery = makeMockDiscovery({
            'glm-4-plus': { maxConcurrency: 100, contextLength: 200000 },
            'glm-4-air': { maxConcurrency: 100, contextLength: 200000 },
            'glm-4-flash': { maxConcurrency: 100, contextLength: 200000 }
        });
        const router = makeRouter(config, { modelDiscovery: discovery });

        const bodyHeavy = makeBody({ tools: [{ name: 'test', description: 'test', input_schema: {} }] });

        const promises = Array.from({ length: 20 }, () =>
            router.selectModel({
                parsedBody: bodyHeavy,
                requestModel: bodyHeavy.model
            })
        );

        await Promise.all(promises);

        const stats = router.getStats();
        expect(stats.total).toBe(20);
    });
});
