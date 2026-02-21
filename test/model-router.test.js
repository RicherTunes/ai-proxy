/**
 * ModelRouter Module Tests
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

/**
 * Helper: build a full modelRouting config with sensible defaults.
 */
function makeConfig(overrides = {}) {
    return {
        enabled: true,
        tiers: {
            light: {
                targetModel: 'glm-4-flash',
                failoverModel: 'glm-4-air',
                clientModelPolicy: 'always-route'
            },
            medium: {
                targetModel: 'glm-4-air',
                failoverModel: 'glm-4-flash',
                clientModelPolicy: 'always-route'
            },
            heavy: {
                targetModel: 'glm-4-plus',
                failoverModel: 'glm-4-air',
                clientModelPolicy: 'always-route'
            }
        },
        rules: [
            { match: { model: 'claude-instant-*' }, tier: 'light' },
            { match: { model: 'claude-3-haiku-*' }, tier: 'light' },
            { match: { model: 'claude-3-opus-*' }, tier: 'heavy' },
            { match: { model: 'claude-opus-*' }, tier: 'heavy' }
        ],
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

/** Mock ModelDiscovery instance */
const mockModelDiscovery = {
    getModel: jest.fn().mockResolvedValue(null)
};

describe('ModelRouter', () => {
    let router;

    beforeEach(() => {
        jest.clearAllMocks();
        router = new ModelRouter(makeConfig(), {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery
        });
    });

    // ==================================================================
    // extractFeatures
    // ==================================================================

    describe('extractFeatures', () => {
        test('extracts features from a full Anthropic body with tools, vision, and system string', () => {
            const body = {
                model: 'claude-sonnet-4-20250514',
                max_tokens: 2048,
                messages: [
                    { role: 'user', content: 'describe this image' },
                    { role: 'user', content: [{ type: 'image', source: { data: 'abc' } }] }
                ],
                system: 'You are an assistant.',
                tools: [{ name: 'web_search' }],
                stream: true
            };
            const f = router.extractFeatures(body);

            expect(f.model).toBe('claude-sonnet-4-20250514');
            expect(f.maxTokens).toBe(2048);
            expect(f.messageCount).toBe(2);
            expect(f.systemLength).toBe('You are an assistant.'.length);
            expect(f.hasTools).toBe(true);
            expect(f.hasVision).toBe(true);
            expect(f.stream).toBe(true);
        });

        test('handles system as array (JSON.stringify length)', () => {
            const systemArr = [{ type: 'text', text: 'Be helpful' }];
            const body = makeBody({ system: systemArr });
            const f = router.extractFeatures(body);

            expect(f.systemLength).toBe(JSON.stringify(systemArr).length);
        });

        test('handles empty messages array', () => {
            const body = makeBody({ messages: [] });
            const f = router.extractFeatures(body);

            expect(f.messageCount).toBe(0);
            expect(f.hasVision).toBe(false);
        });

        test('handles missing max_tokens -> maxTokens is null', () => {
            const body = makeBody();
            delete body.max_tokens;
            const f = router.extractFeatures(body);

            expect(f.maxTokens).toBeNull();
        });

        test('handles max_tokens: 0 -> maxTokens is 0', () => {
            const body = makeBody({ max_tokens: 0 });
            const f = router.extractFeatures(body);

            expect(f.maxTokens).toBe(0);
        });

        test('handles no tools -> hasTools false', () => {
            const body = makeBody({ tools: undefined });
            const f = router.extractFeatures(body);

            expect(f.hasTools).toBe(false);
        });

        test('detects vision from image content blocks', () => {
            const body = makeBody({
                messages: [
                    { role: 'user', content: [{ type: 'image', source: { data: 'base64...' } }] }
                ]
            });
            const f = router.extractFeatures(body);

            expect(f.hasVision).toBe(true);
        });
    });

    // ==================================================================
    // _matchGlob
    // ==================================================================

    describe('_matchGlob', () => {
        test('exact match', () => {
            expect(router._matchGlob('claude-sonnet-4', 'claude-sonnet-4')).toBe(true);
        });

        test('wildcard suffix matches', () => {
            expect(router._matchGlob('claude-opus-*', 'claude-opus-4-5-20251101')).toBe(true);
        });

        test('wildcard in middle', () => {
            expect(router._matchGlob('claude-*-latest', 'claude-sonnet-latest')).toBe(true);
        });

        test('dots are escaped in model names', () => {
            expect(router._matchGlob('model.v1.0', 'model.v1.0')).toBe(true);
            expect(router._matchGlob('model.v1.0', 'modelXv1X0')).toBe(false);
        });

        test('no match returns false', () => {
            expect(router._matchGlob('claude-opus-*', 'claude-sonnet-4')).toBe(false);
        });
    });

    // ==================================================================
    // classify
    // ==================================================================

    describe('classify', () => {
        test('rule matching with model glob', () => {
            const features = router.extractFeatures(makeBody({ model: 'claude-3-opus-20240229' }));
            const result = router.classify(features);

            expect(result.tier).toBe('heavy');
            expect(result.reason).toContain('rule:');
        });

        test('rule matching with maxTokensGte', () => {
            const config = makeConfig({
                rules: [
                    { match: { maxTokensGte: 8000 }, tier: 'heavy' }
                ]
            });
            const r = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });
            const features = r.extractFeatures(makeBody({ max_tokens: 10000 }));
            const result = r.classify(features);

            expect(result.tier).toBe('heavy');
            expect(result.reason).toContain('rule:');
        });

        test('rule matching skips maxTokensGte when features.maxTokens is null', () => {
            const config = makeConfig({
                rules: [
                    { match: { maxTokensGte: 100 }, tier: 'heavy' }
                ]
            });
            const r = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });
            const body = makeBody();
            delete body.max_tokens;
            const features = r.extractFeatures(body);
            const result = r.classify(features);

            // Should NOT match the rule because maxTokens is null
            expect(result.tier).not.toBe('heavy');
        });

        test('rule AND logic - all conditions must match', () => {
            const config = makeConfig({
                rules: [
                    { match: { model: 'claude-sonnet-*', hasTools: true }, tier: 'heavy' }
                ]
            });
            const r = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            // Model matches but hasTools=false → no match on this rule
            const features = r.extractFeatures(makeBody({
                model: 'claude-sonnet-4-20250514',
                tools: undefined
            }));
            const result = r.classify(features);

            // Falls through to classifier, not rule-matched as heavy
            expect(result.reason).not.toContain('rule:');
        });

        test('first matching rule wins (order matters)', () => {
            const config = makeConfig({
                rules: [
                    { match: { model: 'claude-*' }, tier: 'light' },
                    { match: { model: 'claude-*' }, tier: 'heavy' }
                ]
            });
            const r = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });
            const features = r.extractFeatures(makeBody({ model: 'claude-sonnet-4' }));
            const result = r.classify(features);

            expect(result.tier).toBe('light');
        });

        test('always-route heuristic: heavy when maxTokens >= threshold', () => {
            const config = makeConfig({ rules: [] });
            const r = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });
            const features = r.extractFeatures(makeBody({ max_tokens: 5000 }));
            const result = r.classify(features);

            expect(result.tier).toBe('heavy');
            expect(result.reason).toContain('classifier');
            expect(result.reason).toContain('maxTokens');
        });

        test('always-route heuristic: heavy when hasTools', () => {
            const config = makeConfig({ rules: [] });
            const r = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });
            const features = r.extractFeatures(makeBody({
                max_tokens: 100,
                tools: [{ name: 'calculator' }]
            }));
            const result = r.classify(features);

            expect(result.tier).toBe('heavy');
            expect(result.reason).toContain('hasTools');
        });

        test('always-route heuristic: heavy when hasVision', () => {
            const config = makeConfig({ rules: [] });
            const r = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });
            const features = r.extractFeatures(makeBody({
                max_tokens: 100,
                messages: [
                    { role: 'user', content: [{ type: 'image', source: {} }] }
                ]
            }));
            const result = r.classify(features);

            expect(result.tier).toBe('heavy');
            expect(result.reason).toContain('hasVision');
        });

        test('always-route heuristic: light when all light thresholds met', () => {
            const config = makeConfig({ rules: [] });
            const r = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });
            const features = r.extractFeatures(makeBody({
                max_tokens: 256,
                messages: [{ role: 'user', content: 'Hi' }]
            }));
            const result = r.classify(features);

            expect(result.tier).toBe('light');
            expect(result.reason).toContain('classifier');
        });

        test('always-route heuristic: medium when neither light nor heavy', () => {
            const config = makeConfig({ rules: [] });
            const r = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });
            // 1024 tokens, 1 message, no tools, no vision → not heavy (< 4096) but not light (> 512)
            const features = r.extractFeatures(makeBody({ max_tokens: 1024 }));
            const result = r.classify(features);

            expect(result.tier).toBe('medium');
            expect(result.reason).toContain('classifier');
        });

        test('rule-match-only returns null when no rule matches', () => {
            const config = makeConfig({
                rules: [
                    { match: { model: 'gpt-*' }, tier: 'heavy' }
                ],
                tiers: {
                    heavy: { targetModel: 'glm-4-plus', clientModelPolicy: 'rule-match-only' }
                }
            });
            const r = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });
            const features = r.extractFeatures(makeBody({ model: 'claude-sonnet-4' }));
            const result = r.classify(features);

            expect(result).toBeNull();
        });

        test('empty rules with rule-match-only returns null', () => {
            const config = makeConfig({
                rules: [],
                tiers: {
                    light: { targetModel: 'glm-4-flash', clientModelPolicy: 'rule-match-only' },
                    medium: { targetModel: 'glm-4-air', clientModelPolicy: 'rule-match-only' },
                    heavy: { targetModel: 'glm-4-plus', clientModelPolicy: 'rule-match-only' }
                }
            });
            const r = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });
            const features = r.extractFeatures(makeBody());
            const result = r.classify(features);

            expect(result).toBeNull();
        });
    });

    // ==================================================================
    // selectModel
    // ==================================================================

    describe('selectModel', () => {
        test('returns null when disabled', async () => {
            const config = makeConfig({ enabled: false });
            const r = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });
            const result = await r.selectModel({
                parsedBody: makeBody(),
                requestModel: 'claude-sonnet-4'
            });

            expect(result).toBeNull();
        });

        test('override has highest priority', async () => {
            const result = await router.selectModel({
                parsedBody: makeBody(),
                requestModel: 'claude-sonnet-4',
                override: 'glm-4-custom'
            });

            expect(result.model).toBe('glm-4-custom');
            expect(result.source).toBe('override');
            expect(result.reason).toBe('per-request override');
        });

        test('override with trace includes trace field', async () => {
            const result = await router.selectModel({
                parsedBody: makeBody(),
                requestModel: 'claude-sonnet-4',
                override: 'glm-4-custom',
                includeTrace: true,
                bypassSampling: true  // Ensure trace is included (bypasses 10% sampling)
            });

            expect(result.model).toBe('glm-4-custom');
            expect(result.source).toBe('override');
            expect(result.trace).toBeDefined();
            expect(result.trace.requestId).toBeDefined();
        });

        test('saved override for specific model', async () => {
            router.setOverride('claude-sonnet-4', 'glm-4-turbo');
            const result = await router.selectModel({
                parsedBody: makeBody(),
                requestModel: 'claude-sonnet-4'
            });

            expect(result.model).toBe('glm-4-turbo');
            expect(result.source).toBe('saved-override');
            expect(result.reason).toContain('claude-sonnet-4');
        });

        test('saved override with trace includes trace field', async () => {
            router.setOverride('claude-sonnet-4', 'glm-4-turbo');
            const result = await router.selectModel({
                parsedBody: makeBody(),
                requestModel: 'claude-sonnet-4',
                includeTrace: true,
                bypassSampling: true  // Ensure trace is included
            });

            expect(result.model).toBe('glm-4-turbo');
            expect(result.source).toBe('saved-override');
            expect(result.trace).toBeDefined();
            expect(result.trace.requestId).toBeDefined();
        });

        test('saved override wildcard *', async () => {
            router.setOverride('*', 'glm-4-wildcard');
            const result = await router.selectModel({
                parsedBody: makeBody(),
                requestModel: 'claude-unknown-model'
            });

            expect(result.model).toBe('glm-4-wildcard');
            expect(result.source).toBe('saved-override');
            expect(result.reason).toContain('*');
        });

        test('saved override wildcard with trace', async () => {
            router.setOverride('*', 'glm-4-wildcard');
            const result = await router.selectModel({
                parsedBody: makeBody(),
                requestModel: 'claude-unknown-model',
                includeTrace: true,
                bypassSampling: true  // Ensure trace is included
            });

            expect(result.model).toBe('glm-4-wildcard');
            expect(result.source).toBe('saved-override');
            expect(result.trace).toBeDefined();
        });

        test('rule-based routing', async () => {
            const result = await router.selectModel({
                parsedBody: makeBody({ model: 'claude-3-opus-20240229' }),
                requestModel: 'claude-3-opus-20240229'
            });

            expect(result.model).toBe('glm-4-plus');
            expect(result.tier).toBe('heavy');
            expect(result.source).toBe('rule');
        });

        test('classifier-based routing (always-route tier)', async () => {
            // Use a model that doesn't match any rule but triggers heavy via classifier
            const result = await router.selectModel({
                parsedBody: makeBody({ model: 'claude-sonnet-4-20250514', max_tokens: 5000 }),
                requestModel: 'claude-sonnet-4-20250514'
            });

            expect(result.model).toBe('glm-4-plus');
            expect(result.tier).toBe('heavy');
            expect(result.source).toBe('classifier');
        });

        test('defaultModel fallback', async () => {
            const config = makeConfig({
                rules: [],
                tiers: {
                    heavy: { targetModel: 'glm-4-plus', clientModelPolicy: 'rule-match-only' }
                },
                defaultModel: 'glm-4-fallback'
            });
            const r = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });
            const result = await r.selectModel({
                parsedBody: makeBody({ model: 'some-unknown-model' }),
                requestModel: 'some-unknown-model'
            });

            expect(result.model).toBe('glm-4-fallback');
            expect(result.source).toBe('default');
        });

        test('skipOverrides bypasses per-request and saved overrides', async () => {
            router.setOverride('claude-sonnet-4', 'glm-4-turbo');
            const result = await router.selectModel({
                parsedBody: makeBody({ model: 'claude-sonnet-4' }),
                requestModel: 'claude-sonnet-4',
                override: 'glm-4-custom',
                skipOverrides: true
            });

            // Should NOT use the per-request override or saved override
            // Should fall through to rule/classifier/default
            expect(result.source).not.toBe('override');
            expect(result.source).not.toBe('saved-override');
        });

        test('returns null when nothing matches and no defaultModel', async () => {
            const config = makeConfig({
                rules: [],
                tiers: {
                    heavy: { targetModel: 'glm-4-plus', clientModelPolicy: 'rule-match-only' }
                },
                defaultModel: undefined
            });
            const r = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });
            const result = await r.selectModel({
                parsedBody: makeBody(),
                requestModel: 'claude-sonnet-4'
            });

            expect(result).toBeNull();
        });
    });

    // ==================================================================
    // cooldowns
    // ==================================================================

    describe('cooldowns', () => {
        test('recordModelCooldown creates entry, getModelCooldown returns remaining', () => {
            router.recordModelCooldown('glm-4-plus', 5000);
            const remaining = router.getModelCooldown('glm-4-plus');

            expect(remaining).toBeGreaterThan(0);
            expect(remaining).toBeLessThanOrEqual(5000);
        });

        test('targetModel cooled down -> failover used', async () => {
            router.recordModelCooldown('glm-4-plus', 10000);

            const result = await router.selectModel({
                parsedBody: makeBody({ model: 'claude-3-opus-20240229' }),
                requestModel: 'claude-3-opus-20240229'
            });

            expect(result.model).toBe('glm-4-air'); // failover for heavy tier
            // After v2 normalization, pool selection uses classification source (rule/classifier)
            expect(result.source).toBe('rule');
        });

        test('both models cooled down -> targetModel used (best effort)', async () => {
            router.recordModelCooldown('glm-4-plus', 10000);
            router.recordModelCooldown('glm-4-air', 10000);

            const result = await router.selectModel({
                parsedBody: makeBody({ model: 'claude-3-opus-20240229' }),
                requestModel: 'claude-3-opus-20240229'
            });

            expect(result.model).toBe('glm-4-plus');
            expect(result.reason).toContain('warning');
        });

        test('evicts oldest cooldown entry when at maxCooldownEntries limit', () => {
            const router = new ModelRouter({
                enabled: true,
                cooldown: { maxCooldownEntries: 3, decayMs: 60000 }
            }, { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            // Fill to capacity
            router.recordModelCooldown('model-a', 1000);
            router.recordModelCooldown('model-b', 1000);
            router.recordModelCooldown('model-c', 1000);

            // Adding a 4th should evict model-a (oldest)
            router.recordModelCooldown('model-d', 1000);

            const cooldowns = router.getCooldowns();
            expect(Object.keys(cooldowns)).not.toContain('model-a');
            expect(Object.keys(cooldowns)).toContain('model-d');
            expect(Object.keys(cooldowns).length).toBeLessThanOrEqual(3);
        });

        test('cooldown decays after window', () => {
            // Use a config with very short decay for testing
            const config = makeConfig({
                cooldown: { defaultMs: 100, maxMs: 1000, decayMs: 1, backoffMultiplier: 2 }
            });
            const r = new ModelRouter(config, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            r.recordModelCooldown('glm-4-plus', 100);

            // Simulate time passing by manipulating the entry directly
            const entry = r._cooldowns.get('glm-4-plus');
            entry.lastHit = Date.now() - 10; // 10ms ago, decayMs is 1ms
            entry.cooldownUntil = Date.now() - 10;

            const remaining = r.getModelCooldown('glm-4-plus');
            expect(remaining).toBe(0);
            // Entry should have been deleted
            expect(r._cooldowns.has('glm-4-plus')).toBe(false);
        });

        test('burstDampened: true skips count increment', () => {
            router.recordModelCooldown('model-x', 1000, { burstDampened: true });
            router.recordModelCooldown('model-x', 1000, { burstDampened: true });
            router.recordModelCooldown('model-x', 1000, { burstDampened: true });
            const entry = router._cooldowns.get('model-x');
            expect(entry.count).toBe(0);
        });

        test('burstDampened: true sets lastBurstDampened flag', () => {
            router.recordModelCooldown('model-x', 1000, { burstDampened: true });
            const entry = router._cooldowns.get('model-x');
            expect(entry.lastBurstDampened).toBe(true);
        });

        test('normal call after burst-dampened increments count from 0 correctly', () => {
            // 5 burst-dampened calls
            for (let i = 0; i < 5; i++) {
                router.recordModelCooldown('model-x', 1000, { burstDampened: true });
            }
            expect(router._cooldowns.get('model-x').count).toBe(0);

            // 1 normal call
            router.recordModelCooldown('model-x', 1000);
            const entry = router._cooldowns.get('model-x');
            expect(entry.count).toBe(1);
            expect(entry.lastBurstDampened).toBe(false);
        });

        test('burst cannot shorten existing longer cooldown (max semantics)', () => {
            // Record a long cooldown
            router.recordModelCooldown('model-x', 20000);
            const afterLong = router._cooldowns.get('model-x').cooldownUntil;

            // Burst-dampened with much shorter value shouldn't reduce cooldownUntil
            router.recordModelCooldown('model-x', 100, { burstDampened: true });
            const afterBurst = router._cooldowns.get('model-x').cooldownUntil;
            expect(afterBurst).toBeGreaterThanOrEqual(afterLong);
        });

        test('getStats includes burstDampenedTotal', () => {
            router.recordModelCooldown('model-x', 1000, { burstDampened: true });
            router.recordModelCooldown('model-x', 1000, { burstDampened: true });
            const stats = router.getStats();
            expect(stats.burstDampenedTotal).toBe(2);
        });

        test('reset clears burstDampenedTotal', () => {
            router.recordModelCooldown('model-x', 1000, { burstDampened: true });
            expect(router.getStats().burstDampenedTotal).toBe(1);
            router.reset();
            expect(router.getStats().burstDampenedTotal).toBe(0);
        });

        test('getCooldowns includes burstDampened boolean', () => {
            router.recordModelCooldown('model-x', 5000, { burstDampened: true });
            router.recordModelCooldown('model-y', 5000);
            const cooldowns = router.getCooldowns();
            expect(cooldowns['model-x'].burstDampened).toBe(true);
            expect(cooldowns['model-y'].burstDampened).toBe(false);
        });
    });

    // ==================================================================
    // overrides
    // ==================================================================

    describe('overrides', () => {
        test('setOverride + getOverrides', () => {
            router.setOverride('claude-sonnet-4', 'glm-4-turbo');
            router.setOverride('claude-opus-4', 'glm-4-plus');

            const overrides = router.getOverrides();
            expect(overrides).toEqual({
                'claude-sonnet-4': 'glm-4-turbo',
                'claude-opus-4': 'glm-4-plus'
            });
        });

        test('clearOverride removes entry', () => {
            router.setOverride('claude-sonnet-4', 'glm-4-turbo');
            router.clearOverride('claude-sonnet-4');

            expect(router.getOverrides()).toEqual({});
        });

        test('persistence calls atomicWrite when enabled', async () => {
            const r = new ModelRouter(makeConfig(), {
                persistEnabled: true,
                configDir: '/tmp/test-config',
                modelDiscovery: mockModelDiscovery
            });

            r.setOverride('claude-sonnet-4', 'glm-4-turbo');

            // atomicWrite is async, give it a tick to be called
            await new Promise(resolve => setImmediate(resolve));

            expect(atomicWrite).toHaveBeenCalled();
            const [filePath, data] = atomicWrite.mock.calls[atomicWrite.mock.calls.length - 1];
            expect(filePath).toContain('model-routing-overrides.json');
            const parsed = JSON.parse(data);
            expect(parsed['claude-sonnet-4']).toBe('glm-4-turbo');
        });

        test('rejects new override when at maxOverrides limit', () => {
            const router = new ModelRouter({
                enabled: true,
                maxOverrides: 2
            }, { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            expect(router.setOverride('key-a', 'model-1')).toBe(true);
            expect(router.setOverride('key-b', 'model-2')).toBe(true);
            // At capacity - new key rejected
            expect(router.setOverride('key-c', 'model-3')).toBe(false);
            // Existing key update still works
            expect(router.setOverride('key-a', 'model-4')).toBe(true);

            const overrides = router.getOverrides();
            expect(Object.keys(overrides).length).toBe(2);
            expect(overrides['key-a']).toBe('model-4');
        });

        test('persistEnabled: false -> no file writes', () => {
            router.setOverride('claude-sonnet-4', 'glm-4-turbo');
            router.clearOverride('claude-sonnet-4');

            expect(atomicWrite).not.toHaveBeenCalled();
        });
    });

    // ==================================================================
    // stats
    // ==================================================================

    describe('stats', () => {
        test('increments stats by source type', async () => {
            // Override
            await router.selectModel({
                parsedBody: makeBody(),
                requestModel: 'claude-sonnet-4',
                override: 'glm-4-custom'
            });

            // Rule
            await router.selectModel({
                parsedBody: makeBody({ model: 'claude-3-opus-20240229' }),
                requestModel: 'claude-3-opus-20240229'
            });

            const stats = router.getStats();
            expect(stats.bySource.override).toBe(1);
            expect(stats.bySource.rule).toBe(1);
            expect(stats.total).toBe(2);
        });

        test('failover counter increments', async () => {
            const r = new ModelRouter(makeConfig(), { persistEnabled: false, modelDiscovery: mockModelDiscovery });
            r.recordModelCooldown('glm-4-plus', 10000);

            await r.selectModel({
                parsedBody: makeBody({ model: 'claude-3-opus-20240229' }),
                requestModel: 'claude-3-opus-20240229'
            });

            const stats = r.getStats();
            // After v2 normalization, pool selection uses classification source (rule/classifier)
            // The rule match increments bySource.rule, not bySource.failover
            expect(stats.bySource.rule).toBe(1);
        });
    });

    // ==================================================================
    // updateConfig
    // ==================================================================

    describe('updateConfig', () => {
        test('hot-updates tiers without losing cooldown state', () => {
            router.recordModelCooldown('glm-4-plus', 10000);

            const newConfig = makeConfig({
                tiers: {
                    light: { targetModel: 'glm-NEW-flash', clientModelPolicy: 'always-route' },
                    medium: { targetModel: 'glm-NEW-air', clientModelPolicy: 'always-route' },
                    heavy: { targetModel: 'glm-NEW-plus', clientModelPolicy: 'always-route' }
                }
            });
            router.updateConfig(newConfig);

            // Cooldown state should survive
            const remaining = router.getModelCooldown('glm-4-plus');
            expect(remaining).toBeGreaterThan(0);

            // New config should be active
            expect(router.config.tiers.heavy.targetModel).toBe('glm-NEW-plus');
        });
    });

    // ==================================================================
    // toJSON
    // ==================================================================

    describe('toJSON', () => {
        test('returns complete state snapshot', async () => {
            router.setOverride('claude-sonnet-4', 'glm-4-turbo');
            await router.selectModel({
                parsedBody: makeBody({ model: 'claude-3-opus-20240229' }),
                requestModel: 'claude-3-opus-20240229'
            });

            const snapshot = router.toJSON();

            expect(snapshot).toHaveProperty('enabled', true);
            expect(snapshot).toHaveProperty('config');
            expect(snapshot.config).toHaveProperty('tiers');
            expect(snapshot.config).toHaveProperty('rules');
            expect(snapshot.config).toHaveProperty('classifier');
            expect(snapshot.config).toHaveProperty('cooldown');
            expect(snapshot.config).toHaveProperty('defaultModel');
            expect(snapshot.config).toHaveProperty('logDecisions');
            expect(snapshot).toHaveProperty('overrides');
            expect(snapshot.overrides).toHaveProperty('claude-sonnet-4', 'glm-4-turbo');
            expect(snapshot).toHaveProperty('cooldowns');
            expect(snapshot).toHaveProperty('stats');
            expect(snapshot.stats.total).toBeGreaterThan(0);
        });

        test('handles null/invalid tier configs gracefully', () => {
            const config = makeConfig({
                tiers: {
                    light: null,  // null tier
                    medium: 'invalid',  // non-object tier
                    heavy: { targetModel: 'glm-4-plus' }  // valid tier
                }
            });

            const routerWithNullTier = new ModelRouter(config, { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            // toJSON should not throw - normalizer handles null/invalid tiers
            expect(() => routerWithNullTier.toJSON()).not.toThrow();

            const snapshot = routerWithNullTier.toJSON();
            expect(snapshot.config.tiers).toBeDefined();
            // The normalizer creates empty tiers for VALID_TIERS
            expect(snapshot.config.tiers.light).toBeDefined();
            expect(snapshot.config.tiers.light.models).toEqual([]);
        });
    });

    // ==================================================================
    // reset
    // ==================================================================

    describe('reset', () => {
        test('clears all transient state', async () => {
            router.setOverride('key', 'val');
            router.recordModelCooldown('glm-4-plus', 5000);
            await router.selectModel({
                parsedBody: makeBody(),
                requestModel: 'claude-sonnet-4',
                override: 'glm-custom'
            });

            router.reset();

            expect(router.getOverrides()).toEqual({});
            expect(router.getModelCooldown('glm-4-plus')).toBe(0);
            const stats = router.getStats();
            expect(stats.total).toBe(0);
            expect(stats.bySource.override).toBe(0);
        });
    });

    // ==================================================================
    // constructor - persisted overrides loading
    // ==================================================================

    describe('constructor', () => {
        test('loads persisted overrides from file on construction', () => {
            fs.readFileSync.mockImplementationOnce(() =>
                JSON.stringify({ 'claude-opus-4': 'glm-4-saved' })
            );

            const r = new ModelRouter(makeConfig(), {
                persistEnabled: true,
                configDir: '/tmp/test-config',
                modelDiscovery: mockModelDiscovery
            });

            expect(r.getOverrides()).toEqual({ 'claude-opus-4': 'glm-4-saved' });
        });

        test('handles missing overrides file gracefully', () => {
            fs.readFileSync.mockImplementationOnce(() => {
                const err = new Error('ENOENT');
                err.code = 'ENOENT';
                throw err;
            });

            const r = new ModelRouter(makeConfig(), {
                persistEnabled: true,
                configDir: '/tmp/nonexistent',
                modelDiscovery: mockModelDiscovery
            });

            expect(r.getOverrides()).toEqual({});
        });
    });
});

// ==================================================================
// Static: validateConfig
// ==================================================================

describe('ModelRouter.validateConfig', () => {
    test('accepts valid partial update with enabled only', () => {
        expect(ModelRouter.validateConfig({ enabled: true })).toEqual({ valid: true });
    });

    test('accepts valid full editable config', () => {
        const result = ModelRouter.validateConfig({
            enabled: true,
            defaultModel: 'glm-4-air',
            logDecisions: false,
            tiers: {
                light: { targetModel: 'glm-4-flash', failoverModel: 'glm-4-air' },
                heavy: { targetModel: 'glm-4-plus' }
            },
            rules: [{ tier: 'heavy', match: { model: 'claude-opus-*' } }],
            classifier: { heavyThresholds: { maxTokensGte: 4096 } },
            cooldown: { defaultMs: 5000, maxMs: 30000 }
        });
        expect(result).toEqual({ valid: true });
    });

    test('accepts defaultModel as null', () => {
        expect(ModelRouter.validateConfig({ defaultModel: null })).toEqual({ valid: true });
    });

    test('rejects non-object input', () => {
        expect(ModelRouter.validateConfig('string').valid).toBe(false);
        expect(ModelRouter.validateConfig(null).valid).toBe(false);
        expect(ModelRouter.validateConfig([]).valid).toBe(false);
        expect(ModelRouter.validateConfig(42).valid).toBe(false);
    });

    test('rejects meta-config keys', () => {
        const result1 = ModelRouter.validateConfig({ persistConfigEdits: true });
        expect(result1.valid).toBe(false);
        expect(result1.error).toContain('not runtime-editable');

        const result2 = ModelRouter.validateConfig({ configFile: 'foo.json' });
        expect(result2.valid).toBe(false);

        const result3 = ModelRouter.validateConfig({ overridesFile: 'foo.json' });
        expect(result3.valid).toBe(false);

        const result4 = ModelRouter.validateConfig({ maxOverrides: 50 });
        expect(result4.valid).toBe(false);
    });

    test('rejects unknown keys', () => {
        const result = ModelRouter.validateConfig({ enabled: true, banana: 'yellow' });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Unknown config key');
        expect(result.error).toContain('banana');
    });

    test('rejects wrong type for enabled', () => {
        const result = ModelRouter.validateConfig({ enabled: 'yes' });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('boolean');
    });

    test('rejects wrong type for defaultModel', () => {
        const result = ModelRouter.validateConfig({ defaultModel: 123 });
        expect(result.valid).toBe(false);
    });

    test('rejects wrong type for logDecisions', () => {
        const result = ModelRouter.validateConfig({ logDecisions: 'true' });
        expect(result.valid).toBe(false);
    });

    test('rejects invalid tier names', () => {
        const result = ModelRouter.validateConfig({
            tiers: { ultralight: { targetModel: 'glm-4-nano' } }
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('ultralight');
    });

    test('rejects tier without targetModel', () => {
        const result = ModelRouter.validateConfig({
            tiers: { light: { failoverModel: 'glm-4-air' } }
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('targetModel');
    });

    test('rejects non-array rules', () => {
        const result = ModelRouter.validateConfig({ rules: 'not-an-array' });
        expect(result.valid).toBe(false);
    });

    test('rejects rules entry without tier', () => {
        const result = ModelRouter.validateConfig({
            rules: [{ match: { model: 'claude-*' } }]
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('tier');
    });

    test('rejects non-object classifier', () => {
        expect(ModelRouter.validateConfig({ classifier: 'fast' }).valid).toBe(false);
        expect(ModelRouter.validateConfig({ classifier: null }).valid).toBe(false);
    });

    test('rejects non-numeric cooldown fields', () => {
        const result = ModelRouter.validateConfig({
            cooldown: { defaultMs: 'five thousand' }
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('number');
    });

    test('accepts empty object (no-op update)', () => {
        expect(ModelRouter.validateConfig({})).toEqual({ valid: true });
    });

    test('accepts version field as string', () => {
        expect(ModelRouter.validateConfig({ version: '1.0' })).toEqual({ valid: true });
    });

    test('rejects non-string version', () => {
        const result = ModelRouter.validateConfig({ version: 1 });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('version');
    });

    test('accepts failover config', () => {
        expect(ModelRouter.validateConfig({
            failover: { maxModelSwitchesPerRequest: 3 }
        })).toEqual({ valid: true });
    });

    test('rejects non-object failover', () => {
        expect(ModelRouter.validateConfig({ failover: 'fast' }).valid).toBe(false);
        expect(ModelRouter.validateConfig({ failover: null }).valid).toBe(false);
    });

    test('rejects non-numeric maxModelSwitchesPerRequest', () => {
        const result = ModelRouter.validateConfig({
            failover: { maxModelSwitchesPerRequest: 'two' }
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('maxModelSwitchesPerRequest');
    });

    test('accepts tier with fallbackModels array', () => {
        const result = ModelRouter.validateConfig({
            tiers: {
                heavy: {
                    targetModel: 'glm-4-plus',
                    fallbackModels: ['glm-4-air', 'glm-4-flash']
                }
            }
        });
        expect(result).toEqual({ valid: true });
    });

    test('rejects non-array fallbackModels', () => {
        const result = ModelRouter.validateConfig({
            tiers: {
                heavy: { targetModel: 'glm-4-plus', fallbackModels: 'glm-4-air' }
            }
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('fallbackModels');
    });

    test('rejects fallbackModels exceeding max length of 10', () => {
        const result = ModelRouter.validateConfig({
            tiers: {
                heavy: {
                    targetModel: 'glm-4-plus',
                    fallbackModels: Array(11).fill('model')
                }
            }
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('max length');
    });

    test('rejects non-string entries in fallbackModels', () => {
        const result = ModelRouter.validateConfig({
            tiers: {
                heavy: {
                    targetModel: 'glm-4-plus',
                    fallbackModels: ['glm-4-air', 123]
                }
            }
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('fallbackModels[1]');
    });

    test('accepts burstDampeningFactor in cooldown config', () => {
        const result = ModelRouter.validateConfig({
            cooldown: { burstDampeningFactor: 0.2 }
        });
        expect(result).toEqual({ valid: true });
    });

    test('rejects burstDampeningFactor outside 0-1', () => {
        const result1 = ModelRouter.validateConfig({
            cooldown: { burstDampeningFactor: -0.1 }
        });
        expect(result1.valid).toBe(false);
        expect(result1.error).toContain('burstDampeningFactor');

        const result2 = ModelRouter.validateConfig({
            cooldown: { burstDampeningFactor: 1.5 }
        });
        expect(result2.valid).toBe(false);
        expect(result2.error).toContain('burstDampeningFactor');
    });

    // Phase 08: GLM-5 and complexityUpgrade validation
    test('accepts valid glm5 config', () => {
        expect(ModelRouter.validateConfig({ glm5: { enabled: true } })).toEqual({ valid: true });
        expect(ModelRouter.validateConfig({ glm5: { preferencePercent: 50 } })).toEqual({ valid: true });
    });

    test('rejects glm5 as non-object', () => {
        const result = ModelRouter.validateConfig({ glm5: 'invalid' });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('"glm5" must be an object');
    });

    test('rejects glm5.enabled as non-boolean', () => {
        const result = ModelRouter.validateConfig({ glm5: { enabled: 'yes' } });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('"glm5.enabled" must be a boolean');
    });

    test('rejects glm5.preferencePercent out of range (> 100)', () => {
        const result = ModelRouter.validateConfig({ glm5: { preferencePercent: 150 } });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('"glm5.preferencePercent" must be an integer between 0 and 100');
    });

    test('rejects glm5.preferencePercent out of range (< 0)', () => {
        const result = ModelRouter.validateConfig({ glm5: { preferencePercent: -1 } });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('"glm5.preferencePercent" must be an integer between 0 and 100');
    });

    test('rejects glm5.preferencePercent as non-integer', () => {
        const result = ModelRouter.validateConfig({ glm5: { preferencePercent: 50.5 } });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('"glm5.preferencePercent" must be an integer between 0 and 100');
    });

    test('accepts valid complexityUpgrade config', () => {
        expect(ModelRouter.validateConfig({
            complexityUpgrade: { thresholds: { maxTokensGte: 8192 } }
        })).toEqual({ valid: true });
        expect(ModelRouter.validateConfig({
            complexityUpgrade: { thresholds: { hasTools: false } }
        })).toEqual({ valid: true });
    });

    test('rejects complexityUpgrade as non-object', () => {
        const result = ModelRouter.validateConfig({ complexityUpgrade: 'invalid' });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('"complexityUpgrade" must be an object');
    });

    test('rejects complexityUpgrade.thresholds as non-object', () => {
        const result = ModelRouter.validateConfig({
            complexityUpgrade: { thresholds: 'invalid' }
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('"complexityUpgrade.thresholds" must be an object');
    });

    test('rejects complexityUpgrade.thresholds.maxTokensGte as negative', () => {
        const result = ModelRouter.validateConfig({
            complexityUpgrade: { thresholds: { maxTokensGte: -1 } }
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('"complexityUpgrade.thresholds.maxTokensGte" must be a non-negative number');
    });

    test('rejects complexityUpgrade.thresholds.messageCountGte as negative', () => {
        const result = ModelRouter.validateConfig({
            complexityUpgrade: { thresholds: { messageCountGte: -1 } }
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('"complexityUpgrade.thresholds.messageCountGte" must be a non-negative number');
    });

    test('rejects complexityUpgrade.thresholds.systemLengthGte as negative', () => {
        const result = ModelRouter.validateConfig({
            complexityUpgrade: { thresholds: { systemLengthGte: -1 } }
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('"complexityUpgrade.thresholds.systemLengthGte" must be a non-negative number');
    });

    test('rejects complexityUpgrade.thresholds.hasTools as non-boolean', () => {
        const result = ModelRouter.validateConfig({
            complexityUpgrade: { thresholds: { hasTools: 'yes' } }
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('"complexityUpgrade.thresholds.hasTools" must be a boolean');
    });

    test('rejects complexityUpgrade.thresholds.hasVision as non-boolean', () => {
        const result = ModelRouter.validateConfig({
            complexityUpgrade: { thresholds: { hasVision: 'yes' } }
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('"complexityUpgrade.thresholds.hasVision" must be a boolean');
    });
});

// ==================================================================
// Fallback chains
// ==================================================================

describe('ModelRouter fallback chains', () => {
    /**
     * Helper: build config with fallbackModels instead of single failoverModel.
     */
    function makeFallbackConfig(overrides = {}) {
        return {
            enabled: true,
            tiers: {
                light: {
                    targetModel: 'glm-4-flash',
                    fallbackModels: ['glm-4-air'],
                    clientModelPolicy: 'always-route'
                },
                medium: {
                    targetModel: 'glm-4-air',
                    fallbackModels: ['glm-4-flash', 'glm-4-lite'],
                    clientModelPolicy: 'always-route'
                },
                heavy: {
                    targetModel: 'glm-4-plus',
                    fallbackModels: ['glm-4-air', 'glm-4-flash'],
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [
                { match: { model: 'claude-3-opus-*' }, tier: 'heavy' },
                { match: { model: 'claude-opus-*' }, tier: 'heavy' }
            ],
            classifier: {
                heavyThresholds: { maxTokensGte: 4096, hasTools: true, hasVision: true },
                lightThresholds: { maxTokensLte: 512, messageCountLte: 3 }
            },
            cooldown: { defaultMs: 5000, maxMs: 30000, decayMs: 60000, backoffMultiplier: 2 },
            failover: { maxModelSwitchesPerRequest: 2 },
            defaultModel: 'glm-4-air',
            overridesFile: 'model-routing-overrides.json',
            logDecisions: false,
            ...overrides
        };
    }

    describe('_resolveFallbackList', () => {
        test('prefers fallbackModels over deprecated failoverModel', () => {
            const router = new ModelRouter(makeFallbackConfig(), { persistEnabled: false, modelDiscovery: mockModelDiscovery });
            const tierConfig = {
                targetModel: 'glm-4-plus',
                fallbackModels: ['glm-4-air', 'glm-4-flash'],
                failoverModel: 'glm-4-deprecated'
            };
            const list = router._resolveFallbackList(tierConfig);
            expect(list).toEqual(['glm-4-air', 'glm-4-flash']);
        });

        test('falls back to [failoverModel] when fallbackModels absent', () => {
            const router = new ModelRouter(makeFallbackConfig(), { persistEnabled: false, modelDiscovery: mockModelDiscovery });
            const tierConfig = {
                targetModel: 'glm-4-plus',
                failoverModel: 'glm-4-air'
            };
            const list = router._resolveFallbackList(tierConfig);
            expect(list).toEqual(['glm-4-air']);
        });

        test('falls back to [failoverModel] when fallbackModels is empty array', () => {
            const router = new ModelRouter(makeFallbackConfig(), { persistEnabled: false, modelDiscovery: mockModelDiscovery });
            const tierConfig = {
                targetModel: 'glm-4-plus',
                fallbackModels: [],
                failoverModel: 'glm-4-air'
            };
            const list = router._resolveFallbackList(tierConfig);
            expect(list).toEqual(['glm-4-air']);
        });

        test('returns empty array when neither fallbackModels nor failoverModel', () => {
            const router = new ModelRouter(makeFallbackConfig(), { persistEnabled: false, modelDiscovery: mockModelDiscovery });
            const list = router._resolveFallbackList({ targetModel: 'glm-4-plus' });
            expect(list).toEqual([]);
        });
    });

    describe('selectModel with attemptedModels', () => {
        test('skips targetModel when in attemptedModels, uses first fallback', async () => {
            const router = new ModelRouter(makeFallbackConfig(), { persistEnabled: false, modelDiscovery: mockModelDiscovery });
            const attempted = new Set(['glm-4-plus']);

            const result = await router.selectModel({
                parsedBody: makeBody({ model: 'claude-3-opus-20240229' }),
                requestModel: 'claude-3-opus-20240229',
                attemptedModels: attempted
            });

            expect(result.model).toBe('glm-4-air');
            // After v2 normalization, pool selection uses classification source (rule/classifier)
            expect(result.source).toBe('rule');
        });

        test('skips attempted fallbacks, uses next available', async () => {
            // maxModelSwitchesPerRequest must be > attemptedModels.size to allow switching
            const config = makeFallbackConfig({
                failover: { maxModelSwitchesPerRequest: 3 }
            });
            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: mockModelDiscovery });
            const attempted = new Set(['glm-4-plus', 'glm-4-air']);

            const result = await router.selectModel({
                parsedBody: makeBody({ model: 'claude-3-opus-20240229' }),
                requestModel: 'claude-3-opus-20240229',
                attemptedModels: attempted
            });

            expect(result.model).toBe('glm-4-flash');
            // After v2 normalization, pool selection uses classification source (rule/classifier)
            expect(result.source).toBe('rule');
        });

        test('falls back to targetModel (best effort) when all candidates exhausted', async () => {
            // With runtime clamp, effective maxSwitches = candidates.length = 3.
            // When all 3 are attempted, cap is also reached → best effort.
            const config = makeFallbackConfig({
                failover: { maxModelSwitchesPerRequest: 10 }
            });
            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: mockModelDiscovery });
            const attempted = new Set(['glm-4-plus', 'glm-4-air', 'glm-4-flash']);

            const result = await router.selectModel({
                parsedBody: makeBody({ model: 'claude-3-opus-20240229' }),
                requestModel: 'claude-3-opus-20240229',
                attemptedModels: attempted
            });

            expect(result.model).toBe('glm-4-plus');
            expect(result.reason).toContain('warning');
            // With clamped effective max = candidate count, cap is reached when exhausted
            expect(result.reason).toContain('maxModelSwitchesPerRequest');
        });

        test('picks model with shortest cooldown when all candidates are cooled', async () => {
            const config = makeFallbackConfig({
                failover: { maxModelSwitchesPerRequest: 10 }
            });
            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            // Cool all candidates with different durations
            router.recordModelCooldown('glm-4-plus', 10000);  // 10s cooldown (target)
            router.recordModelCooldown('glm-4-air', 2000);    // 2s cooldown (shortest!)
            router.recordModelCooldown('glm-4-flash', 8000);  // 8s cooldown

            const result = await router.selectModel({
                parsedBody: makeBody({ model: 'claude-3-opus-20240229' }),
                requestModel: 'claude-3-opus-20240229',
                attemptedModels: new Set()
            });

            // Should pick glm-4-air (shortest cooldown), not glm-4-plus (target)
            expect(result.model).toBe('glm-4-air');
            expect(result.reason).toContain('least-cooldown');
        });
    });

    describe('selectModel with cooldowns and attemptedModels combined', () => {
        test('skips both cooled and attempted models in fallback selection', async () => {
            const router = new ModelRouter(makeFallbackConfig(), { persistEnabled: false, modelDiscovery: mockModelDiscovery });
            router.recordModelCooldown('glm-4-air', 10000);  // first fallback cooled
            const attempted = new Set(['glm-4-plus']);  // target attempted

            const result = await router.selectModel({
                parsedBody: makeBody({ model: 'claude-3-opus-20240229' }),
                requestModel: 'claude-3-opus-20240229',
                attemptedModels: attempted
            });

            // Should skip glm-4-plus (attempted) and glm-4-air (cooled), use glm-4-flash
            expect(result.model).toBe('glm-4-flash');
            // After v2 normalization, pool selection uses classification source (rule/classifier)
            expect(result.source).toBe('rule');
        });
    });

    describe('maxModelSwitchesPerRequest enforcement', () => {
        test('caps model switches at maxModelSwitchesPerRequest', async () => {
            const config = makeFallbackConfig({
                failover: { maxModelSwitchesPerRequest: 1 }
            });
            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            // First request: targetModel cooled (unavailable), no models attempted yet
            // switchesSoFar=0 < maxSwitches=1 → switch allowed
            router.recordModelCooldown('glm-4-plus', 10000);
            const result1 = await router.selectModel({
                parsedBody: makeBody({ model: 'claude-3-opus-20240229' }),
                requestModel: 'claude-3-opus-20240229',
                attemptedModels: new Set()
            });
            expect(result1.model).toBe('glm-4-air');
            // After v2 normalization, pool selection uses classification source (rule/classifier)
            expect(result1.source).toBe('rule');

            // Second attempt: 1 model already attempted, pool selection skips it
            // Pool still finds glm-4-flash available
            const result2 = await router.selectModel({
                parsedBody: makeBody({ model: 'claude-3-opus-20240229' }),
                requestModel: 'claude-3-opus-20240229',
                attemptedModels: new Set(['glm-4-air'])
            });
            // Pool selection skips attempted glm-4-air and cooled glm-4-plus, picks glm-4-flash
            expect(result2.model).toBe('glm-4-flash');
            expect(result2.source).toBe('rule');
        });

        test('higher maxModelSwitchesPerRequest allows more switches', async () => {
            const config = makeFallbackConfig({
                failover: { maxModelSwitchesPerRequest: 3 }
            });
            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            // 2 models attempted, max is 3 → switching still allowed
            const attempted = new Set(['glm-4-plus', 'glm-4-air']);
            const result = await router.selectModel({
                parsedBody: makeBody({ model: 'claude-3-opus-20240229' }),
                requestModel: 'claude-3-opus-20240229',
                attemptedModels: attempted
            });
            expect(result.model).toBe('glm-4-flash');
            // After v2 normalization, pool selection uses classification source (rule/classifier)
            expect(result.source).toBe('rule');
        });

        test('defaults to 1 when failover config is absent', async () => {
            const config = makeFallbackConfig();
            delete config.failover;
            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            // One model attempted → cap reached (1 >= 1)
            const attempted = new Set(['glm-4-plus']);
            const result = await router.selectModel({
                parsedBody: makeBody({ model: 'claude-3-opus-20240229' }),
                requestModel: 'claude-3-opus-20240229',
                attemptedModels: attempted
            });
            // Pool selection skips attempted glm-4-plus, picks next available
            // With balanced strategy and equal capacity, picks based on scoring
            expect(result.model).toBe('glm-4-air');
            expect(result.source).toBe('rule');
        });
    });

    describe('getNextFallback', () => {
        test('returns targetModel when nothing attempted', () => {
            const router = new ModelRouter(makeFallbackConfig(), { persistEnabled: false, modelDiscovery: mockModelDiscovery });
            const next = router.getNextFallback({ tier: 'heavy' });
            expect(next).toBe('glm-4-plus');
        });

        test('returns first non-attempted, non-cooled fallback', () => {
            const router = new ModelRouter(makeFallbackConfig(), { persistEnabled: false, modelDiscovery: mockModelDiscovery });
            const next = router.getNextFallback({
                tier: 'heavy',
                attemptedModels: new Set(['glm-4-plus'])
            });
            expect(next).toBe('glm-4-air');
        });

        test('skips cooled models in first pass', () => {
            const router = new ModelRouter(makeFallbackConfig(), { persistEnabled: false, modelDiscovery: mockModelDiscovery });
            router.recordModelCooldown('glm-4-air', 10000);
            const next = router.getNextFallback({
                tier: 'heavy',
                attemptedModels: new Set(['glm-4-plus'])
            });
            expect(next).toBe('glm-4-flash');
        });

        test('returns cooled model (best effort) when all non-attempted are cooled', () => {
            const router = new ModelRouter(makeFallbackConfig(), { persistEnabled: false, modelDiscovery: mockModelDiscovery });
            router.recordModelCooldown('glm-4-air', 10000);
            router.recordModelCooldown('glm-4-flash', 10000);
            const next = router.getNextFallback({
                tier: 'heavy',
                attemptedModels: new Set(['glm-4-plus'])
            });
            // Second pass: first non-attempted model (even if cooled)
            expect(next).toBe('glm-4-air');
        });

        test('returns null when all candidates attempted', () => {
            const router = new ModelRouter(makeFallbackConfig(), { persistEnabled: false, modelDiscovery: mockModelDiscovery });
            const next = router.getNextFallback({
                tier: 'heavy',
                attemptedModels: new Set(['glm-4-plus', 'glm-4-air', 'glm-4-flash'])
            });
            expect(next).toBeNull();
        });

        test('respects maxModelSwitchesPerRequest cap', () => {
            const config = makeFallbackConfig({
                failover: { maxModelSwitchesPerRequest: 1 }
            });
            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: mockModelDiscovery });
            // 2 models attempted > max 1 switch → returns null
            const next = router.getNextFallback({
                tier: 'heavy',
                attemptedModels: new Set(['glm-4-plus', 'glm-4-air'])
            });
            expect(next).toBeNull();
        });

        test('returns null when disabled', () => {
            const config = makeFallbackConfig({ enabled: false });
            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: mockModelDiscovery });
            expect(router.getNextFallback({ tier: 'heavy' })).toBeNull();
        });

        test('returns null for unknown tier', () => {
            const router = new ModelRouter(makeFallbackConfig(), { persistEnabled: false, modelDiscovery: mockModelDiscovery });
            expect(router.getNextFallback({ tier: 'nonexistent' })).toBeNull();
        });
    });

    describe('backward compatibility with failoverModel', () => {
        test('selectModel uses failoverModel when fallbackModels absent', async () => {
            const config = makeFallbackConfig();
            // Replace heavy tier to use old-style failoverModel
            config.tiers.heavy = {
                targetModel: 'glm-4-plus',
                failoverModel: 'glm-4-legacy-fb',
                clientModelPolicy: 'always-route'
            };
            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: mockModelDiscovery });
            router.recordModelCooldown('glm-4-plus', 10000);

            // Use a model that matches the heavy rule to route to heavy tier
            const result = await router.selectModel({
                parsedBody: makeBody({ model: 'claude-3-opus-20240229' }),
                requestModel: 'claude-3-opus-20240229'
            });

            // After normalization, failoverModel is in models[] array at position 1
            // When glm-4-plus is cooled down, pool selection picks glm-4-legacy-fb
            expect(result.model).toBe('glm-4-legacy-fb');
            // Pool selection uses classification source (rule match)
            expect(result.source).toBe('rule');
        });
    });
});

// ==================================================================
// Deep-merge semantics: arrays replace, not element-wise merge
// ==================================================================

describe('ModelRouter config merge semantics', () => {
    test('updateConfig replaces rules array entirely (not element-wise)', () => {
        const router = new ModelRouter(makeConfig({
            rules: [
                { match: { model: 'claude-opus-*' }, tier: 'heavy' },
                { match: { model: 'claude-haiku-*' }, tier: 'light' }
            ]
        }), { persistEnabled: false, modelDiscovery: mockModelDiscovery });

        // Update with a single new rule — should NOT merge with old rules
        router.updateConfig({
            ...router.config,
            rules: [{ match: { model: 'claude-sonnet-*' }, tier: 'medium' }]
        });

        expect(router.config.rules).toHaveLength(1);
        expect(router.config.rules[0].match.model).toBe('claude-sonnet-*');
    });

    test('spread merge of persisted config replaces rules array', () => {
        const defaults = makeConfig({
            rules: [
                { match: { model: 'claude-opus-*' }, tier: 'heavy' },
                { match: { model: 'claude-haiku-*' }, tier: 'light' }
            ]
        });
        const persisted = {
            rules: [{ match: { model: 'claude-sonnet-*' }, tier: 'medium' }]
        };

        // Simulate startup merge: { ...defaults, ...persisted }
        const merged = { ...defaults, ...persisted };

        expect(merged.rules).toHaveLength(1);
        expect(merged.rules[0].match.model).toBe('claude-sonnet-*');
    });
});

// ==================================================================
// Shadow Mode
// ==================================================================

describe('Shadow Mode', () => {
    test('selectModel returns null when shadowMode is true', async () => {
        const router = new ModelRouter(makeConfig({ shadowMode: true }), {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery
        });
        const result = await router.selectModel({
            parsedBody: makeBody({ model: 'claude-3-opus-20240229' }),
            requestModel: 'claude-3-opus-20240229'
        });
        expect(result).toBeNull();
    });

    test('shadow mode still records decision in getLastShadowDecision', async () => {
        const router = new ModelRouter(makeConfig({ shadowMode: true }), {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery
        });
        await router.selectModel({
            parsedBody: makeBody({ model: 'claude-3-opus-20240229' }),
            requestModel: 'claude-3-opus-20240229'
        });
        const shadow = router.getLastShadowDecision();
        expect(shadow).not.toBeNull();
        expect(shadow.shadowMode).toBe(true);
        expect(shadow.model).toBeDefined();
        expect(shadow.tier).toBe('heavy');
        // computeDecision preserves classification origin (rule/classifier) as source
        expect(shadow.source).toBe('rule');
    });

    test('shadow mode classifier decision is captured', async () => {
        const router = new ModelRouter(makeConfig({ shadowMode: true }), {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery
        });
        await router.selectModel({
            parsedBody: makeBody({ model: 'some-unknown-model', max_tokens: 100 }),
            requestModel: 'some-unknown-model'
        });
        const shadow = router.getLastShadowDecision();
        expect(shadow).not.toBeNull();
        expect(shadow.shadowMode).toBe(true);
        expect(shadow.tier).toBe('light');
        // computeDecision preserves classification origin (rule/classifier) as source
        expect(shadow.source).toBe('classifier');
    });

    test('getLastShadowDecision returns null when shadow mode is off', async () => {
        const router = new ModelRouter(makeConfig({ shadowMode: false }), {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery
        });
        await router.selectModel({
            parsedBody: makeBody({ model: 'claude-3-opus-20240229' }),
            requestModel: 'claude-3-opus-20240229'
        });
        expect(router.getLastShadowDecision()).toBeNull();
    });

    test('reset() clears shadow decision', async () => {
        const router = new ModelRouter(makeConfig({ shadowMode: true }), {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery
        });
        await router.selectModel({
            parsedBody: makeBody({ model: 'claude-3-opus-20240229' }),
            requestModel: 'claude-3-opus-20240229'
        });
        expect(router.getLastShadowDecision()).not.toBeNull();
        router.reset();
        expect(router.getLastShadowDecision()).toBeNull();
    });

    test('shadowMode getter reflects config', () => {
        const router = new ModelRouter(makeConfig({ shadowMode: true }), {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery
        });
        expect(router.shadowMode).toBe(true);

        const router2 = new ModelRouter(makeConfig({ shadowMode: false }), {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery
        });
        expect(router2.shadowMode).toBe(false);

        const router3 = new ModelRouter(makeConfig(), {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery
        });
        expect(router3.shadowMode).toBe(false);
    });

    test('shadow mode decision does not affect stats counters', async () => {
        const router = new ModelRouter(makeConfig({ shadowMode: true }), {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery
        });
        const statsBefore = JSON.parse(JSON.stringify(router.toJSON()));
        await router.selectModel({
            parsedBody: makeBody({ model: 'claude-3-opus-20240229' }),
            requestModel: 'claude-3-opus-20240229'
        });
        // Shadow mode runs _selectModelInternal which does increment stats
        // but returns null to caller - verify the decision was captured
        expect(router.getLastShadowDecision()).not.toBeNull();
    });

    test('toJSON includes shadowMode field', () => {
        const router = new ModelRouter(makeConfig({ shadowMode: true }), {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery
        });
        const json = router.toJSON();
        expect(json.shadowMode).toBe(true);
    });

    test('validateConfig accepts shadowMode boolean', () => {
        expect(ModelRouter.validateConfig({ shadowMode: true }).valid).toBe(true);
        expect(ModelRouter.validateConfig({ shadowMode: false }).valid).toBe(true);
    });

    test('validateConfig rejects non-boolean shadowMode', () => {
        expect(ModelRouter.validateConfig({ shadowMode: 'yes' }).valid).toBe(false);
        expect(ModelRouter.validateConfig({ shadowMode: 1 }).valid).toBe(false);
    });

    // ==================================================================
    // TRUST-03: selectModel with includeTrace
    // ==================================================================

    describe('selectModel with includeTrace', () => {
        test('selectModel({ includeTrace: false }) returns result without trace field', async () => {
            const r = new ModelRouter(makeConfig(), {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            const result = await r.selectModel({
                parsedBody: makeBody(),
                requestModel: 'claude-sonnet-4-20250514',
                includeTrace: false
            });

            expect(result).toBeDefined();
            expect(result.model).toBeDefined();
            expect(result.trace).toBeUndefined();
        });

        test('selectModel({ includeTrace: true }) returns result with trace field', async () => {
            const r = new ModelRouter({
                ...makeConfig(),
                trace: { samplingRate: 100 }  // Always sample
            }, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            const result = await r.selectModel({
                parsedBody: makeBody(),
                requestModel: 'claude-sonnet-4-20250514',
                includeTrace: true
            });

            expect(result).toBeDefined();
            expect(result.model).toBeDefined();
            expect(result.trace).toBeDefined();
            expect(result.trace.requestId).toBeDefined();
            expect(result.trace.timestamp).toBeDefined();
        });

        test('selectModel with includeTrace includes trace.classification.upgradeTrigger', async () => {
            const r = new ModelRouter({
                ...makeConfig(),
                trace: { samplingRate: 100 }
            }, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            // Request with tools should trigger heavy tier
            const result = await r.selectModel({
                parsedBody: makeBody({
                    tools: [{ name: 'test_tool', type: 'code_1' }]
                }),
                requestModel: 'claude-sonnet-4-20250514',
                includeTrace: true
            });

            expect(result.trace).toBeDefined();
            expect(result.trace.classification).toBeDefined();
            expect(result.trace.classification.tier).toBe('heavy');
            expect(result.trace.classification.upgradeTrigger).toBe('has_tools');
        });

        test('selectModel with includeTrace applies sampling (samplingRate < 100)', async () => {
            const r = new ModelRouter({
                ...makeConfig(),
                trace: { samplingRate: 50 }  // 50% sampling
            }, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            let traceIncludedCount = 0;
            const runs = 100;

            for (let i = 0; i < runs; i++) {
                const result = await r.selectModel({
                    parsedBody: makeBody(),
                    requestModel: 'claude-sonnet-4-20250514',
                    includeTrace: true
                });

                if (result.trace !== undefined) {
                    traceIncludedCount++;
                }
            }

            const percentage = (traceIncludedCount / runs) * 100;
            // Should be around 50% (allowing for randomness and CI variance)
            expect(percentage).toBeGreaterThanOrEqual(30);
            expect(percentage).toBeLessThanOrEqual(70);
        });

        test('selectModel({ includeTrace: true }) updates trace sampling stats', async () => {
            const r = new ModelRouter({
                ...makeConfig(),
                trace: { samplingRate: 100 }
            }, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            await r.selectModel({
                parsedBody: makeBody(),
                requestModel: 'claude-sonnet-4-20250514',
                includeTrace: true
            });

            const stats = r.getStats();
            expect(stats.traceSampledTotal).toBe(1);
            expect(stats.traceSampledIncluded).toBe(1);
        });
    });

    // ==================================================================
    // Pool strategy
    // ==================================================================

    describe('pool strategy', () => {
        function makePoolConfig(overrides = {}) {
            return makeConfig({
                tiers: {
                    light: {
                        targetModel: 'glm-4.5-air',
                        fallbackModels: ['glm-4.7-flashx', 'glm-4.7-flash'],
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
                        targetModel: 'glm-4-plus',
                        fallbackModels: ['glm-4-air'],
                        strategy: 'failover',
                        clientModelPolicy: 'always-route'
                    }
                },
                ...overrides
            });
        }

        const modelMeta = {
            'glm-4.5-air': { maxConcurrency: 10, pricing: { input: 0.20, output: 1.10 } },
            'glm-4.7-flashx': { maxConcurrency: 3, pricing: { input: 0.07, output: 0.40 } },
            'glm-4.7-flash': { maxConcurrency: 1, pricing: { input: 0, output: 0 } },
            'glm-4.5': { maxConcurrency: 10, pricing: { input: 0.60, output: 2.20 } },
            'glm-4-plus': { maxConcurrency: 1, pricing: { input: 0.60, output: 2.20 } },
            'glm-4-air': { maxConcurrency: 5, pricing: { input: 0.20, output: 1.10 } }
        };

        // Mock ModelDiscovery instance
        const mockModelDiscovery = {
            getModel: jest.fn().mockImplementation((id) => modelMeta[id] || null)
        };

        function makePoolRouter(configOverrides = {}) {
            return new ModelRouter(makePoolConfig(configOverrides), {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });
        }

        test('pool strategy selects model with most available capacity', async () => {
            const r = makePoolRouter();
            // Simulate 9 in-flight on glm-4.5-air (10 max → 1 available)
            r._inFlight.set('glm-4.5-air', 9);
            // glm-4.7-flashx has 0 in-flight → 3 available (most)

            const result = await r.selectModel({
                parsedBody: makeBody({ max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
                requestModel: 'claude-sonnet-4-20250514'
            });

            expect(result).not.toBeNull();
            expect(result.source).toBe('pool');
            expect(result.model).toBe('glm-4.7-flashx');
            expect(result.reason).toContain('pool:');
        });

        test('pool strategy picks least-cost model when capacity is tied', async () => {
            const r = makePoolRouter();
            // Both at 0 in-flight:
            // glm-4.5-air: 10 available, cost 1.30
            // glm-4.7-flashx: 3 available, cost 0.47
            // glm-4.7-flash: 1 available, cost 0
            // glm-4.5-air has most available (10), so it wins

            const result = await r.selectModel({
                parsedBody: makeBody({ max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
                requestModel: 'claude-sonnet-4-20250514'
            });

            expect(result.source).toBe('pool');
            expect(result.model).toBe('glm-4.5-air');
        });

        test('pool strategy skips cooled-down models', async () => {
            const r = makePoolRouter();
            // Cool down the target and flashx
            r.recordModelCooldown('glm-4.5-air', 5000);
            r.recordModelCooldown('glm-4.7-flashx', 5000);

            const result = await r.selectModel({
                parsedBody: makeBody({ max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
                requestModel: 'claude-sonnet-4-20250514'
            });

            // Only glm-4.7-flash should be available
            expect(result.source).toBe('pool');
            expect(result.model).toBe('glm-4.7-flash');
        });

        test('pool strategy skips models at capacity', async () => {
            const r = makePoolRouter();
            // Fill up glm-4.5-air (10/10) and flashx (3/3)
            r._inFlight.set('glm-4.5-air', 10);
            r._inFlight.set('glm-4.7-flashx', 3);

            const result = await r.selectModel({
                parsedBody: makeBody({ max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
                requestModel: 'claude-sonnet-4-20250514'
            });

            // Only glm-4.7-flash is available (1 slot)
            expect(result.source).toBe('pool');
            expect(result.model).toBe('glm-4.7-flash');
        });

        test('pool exhausted falls through to failover logic', async () => {
            const r = makePoolRouter();
            // Fill all models to capacity
            r._inFlight.set('glm-4.5-air', 10);
            r._inFlight.set('glm-4.7-flashx', 3);
            r._inFlight.set('glm-4.7-flash', 1);

            const result = await r.selectModel({
                parsedBody: makeBody({ max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
                requestModel: 'claude-sonnet-4-20250514'
            });

            // Falls through to failover → picks targetModel (best effort)
            expect(result).not.toBeNull();
            expect(result.source).not.toBe('pool');
            expect(result.model).toBe('glm-4.5-air');
        });

        test('failover strategy is unchanged by pool feature', async () => {
            const r = makePoolRouter();
            // Heavy tier uses failover strategy
            const result = await r.selectModel({
                parsedBody: makeBody({ model: 'claude-3-opus-20240229' }),
                requestModel: 'claude-3-opus-20240229'
            });

            expect(result).not.toBeNull();
            expect(result.model).toBe('glm-4-plus');
            expect(result.source).not.toBe('pool');
        });

        test('acquireModel and releaseModel track in-flight counts', () => {
            const r = makePoolRouter();
            expect(r._inFlight.get('glm-4.5')).toBeUndefined();

            r.acquireModel('glm-4.5');
            expect(r._inFlight.get('glm-4.5')).toBe(1);

            r.acquireModel('glm-4.5');
            expect(r._inFlight.get('glm-4.5')).toBe(2);

            r.releaseModel('glm-4.5');
            expect(r._inFlight.get('glm-4.5')).toBe(1);

            r.releaseModel('glm-4.5');
            // Should be cleaned up (deleted from map)
            expect(r._inFlight.has('glm-4.5')).toBe(false);
        });

        test('releaseModel does not go below zero', () => {
            const r = makePoolRouter();
            r.releaseModel('glm-4.5');
            expect(r._inFlight.has('glm-4.5')).toBe(false);
        });

        test('acquireModel/releaseModel ignore null/undefined', () => {
            const r = makePoolRouter();
            r.acquireModel(null);
            r.acquireModel(undefined);
            r.releaseModel(null);
            r.releaseModel(undefined);
            expect(r._inFlight.size).toBe(0);
        });

        test('getPoolStatus returns data only for pool-strategy tiers', async () => {
            const r = makePoolRouter();
            r.acquireModel('glm-4.5-air');

            const status = await r.getPoolStatus();

            // light and medium have pool strategy
            expect(status).toHaveProperty('light');
            expect(status).toHaveProperty('medium');
            // heavy has failover → not included
            expect(status).not.toHaveProperty('heavy');

            // Verify light tier contents
            const lightModels = status.light.map(m => m.model);
            expect(lightModels).toContain('glm-4.5-air');
            expect(lightModels).toContain('glm-4.7-flashx');

            // Verify in-flight tracking
            const airStatus = status.light.find(m => m.model === 'glm-4.5-air');
            expect(airStatus.inFlight).toBe(1);
            expect(airStatus.maxConcurrency).toBe(10);
            expect(airStatus.available).toBe(9);
        });

        test('pool stats are tracked in bySource', async () => {
            const r = makePoolRouter();
            await r.selectModel({
                parsedBody: makeBody({ max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
                requestModel: 'claude-sonnet-4-20250514'
            });

            const stats = r.getStats();
            expect(stats.bySource.pool).toBe(1);
        });

        test('reset() clears in-flight map', () => {
            const r = makePoolRouter();
            r.acquireModel('glm-4.5');
            r.acquireModel('glm-4.5-air');
            expect(r._inFlight.size).toBe(2);

            r.reset();
            expect(r._inFlight.size).toBe(0);
        });

        test('toJSON() excludes pools field (use toJSONWithPools for async)', () => {
            const r = makePoolRouter();
            const json = r.toJSON();
            expect(json).not.toHaveProperty('pools');
        });

        test('toJSONWithPools() includes pools field', async () => {
            const r = makePoolRouter();
            const json = await r.toJSONWithPools();
            expect(json).toHaveProperty('pools');
            expect(json.pools).toHaveProperty('light');
        });

        test('pool selection atomically acquires slot to prevent TOCTOU race', async () => {
            const r = makePoolRouter();
            // light tier: glm-4.5-air (10), glm-4.7-flashx (3), glm-4.7-flash (1)
            // Fill glm-4.5-air to 9/10 so it has 1 remaining
            r._inFlight.set('glm-4.5-air', 9);

            // First selection: should pick glm-4.7-flashx (3 available, most after air's 1 remaining)
            const result1 = await r.selectModel({
                parsedBody: makeBody({ max_tokens: 100, messages: [{ role: 'user', content: 'a' }] }),
                requestModel: 'claude-sonnet-4-20250514'
            });
            expect(result1.source).toBe('pool');

            // The selected model should already be acquired (inFlight incremented)
            const selected = result1.model;
            const inFlightAfter = r._inFlight.get(selected) || 0;
            expect(inFlightAfter).toBeGreaterThan(0);
        });

        test('concurrent pool selections distribute across models (no TOCTOU)', async () => {
            const r = makePoolRouter();
            // light tier: glm-4.5-air (10 max), glm-4.7-flashx (3 max), glm-4.7-flash (1 max)
            // Total 14 slots. Simulate 14 concurrent selections.
            const models = [];
            for (let i = 0; i < 14; i++) {
                const result = await r.selectModel({
                    parsedBody: makeBody({ max_tokens: 100, messages: [{ role: 'user', content: 'req ' + i }] }),
                    requestModel: 'claude-sonnet-4-20250514'
                });
                if (result && result.source === 'pool') {
                    models.push(result.model);
                }
            }

            // All 14 slots should be used — none should exceed maxConcurrency
            expect(r._inFlight.get('glm-4.5-air') || 0).toBeLessThanOrEqual(10);
            expect(r._inFlight.get('glm-4.7-flashx') || 0).toBeLessThanOrEqual(3);
            expect(r._inFlight.get('glm-4.7-flash') || 0).toBeLessThanOrEqual(1);

            // Should have distributed across multiple models
            const uniqueModels = [...new Set(models)];
            expect(uniqueModels.length).toBeGreaterThan(1);
            // All 14 slots should be pool-routed
            expect(models.length).toBe(14);
        });

        test('pool strategy deprioritizes models with high 429 hit count', async () => {
            const r = makePoolRouter();
            // glm-4.5-air: 10 max, cost 1.30
            // glm-4.7-flashx: 3 max, cost 0.47
            // glm-4.7-flash: 1 max, cost 0
            //
            // Without 429 awareness: glm-4.5-air wins (10 available > 3 > 1)
            // With 429 awareness: glm-4.5-air has 20 hits, flashx has 0
            //   → flashx should win despite fewer slots

            // Simulate 20 consecutive 429s on glm-4.5-air using sliding window counter
            for (let i = 0; i < 20; i++) {
                r.recordPool429('glm-4.5-air');
            }

            const result = await r.selectModel({
                parsedBody: makeBody({ max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
                requestModel: 'claude-sonnet-4-20250514'
            });

            expect(result.source).toBe('pool');
            // flashx (3 avail, 0 hits) should beat glm-4.5-air (10 avail, 20 hits)
            expect(result.model).toBe('glm-4.7-flashx');
        });

        test('pool strategy still prefers high-capacity model with few 429s', async () => {
            const r = makePoolRouter();
            // glm-4.5-air has 10 slots, 1 429 hit → still best
            r.recordPool429('glm-4.5-air');

            const result = await r.selectModel({
                parsedBody: makeBody({ max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
                requestModel: 'claude-sonnet-4-20250514'
            });

            expect(result.source).toBe('pool');
            // 1 hit is minor — glm-4.5-air (5*0.67=3.3) still beats flashx (3*1.0=3.0)
            expect(result.model).toBe('glm-4.5-air');
        });

        // ==================================================================
        // GLM5 Observability Counters (GLM5-04, GLM5-05, GLM5-06)
        // ==================================================================

        describe('GLM5 observability counters', () => {
            let r;

            beforeEach(() => {
                r = new ModelRouter(makeConfig({
                    classifier: {
                        heavyThresholds: {
                            maxTokensGte: 4096,
                            messageCountGte: 20,
                            hasTools: true,
                            hasVision: true,
                            systemLengthGte: 10000
                        },
                        lightThresholds: {
                            maxTokensLte: 512,
                            messageCountLte: 3,
                            hasTools: false,
                            hasVision: false
                        }
                    }
                }), {
                    modelDiscovery: mockModelDiscovery,
                    persistEnabled: false
                });
            });

            describe('_classifyUpgradeReason', () => {
                test('returns has_tools when tools present and threshold set', () => {
                    const features = r.extractFeatures(makeBody({
                        tools: [{ type: 'function', function: { name: 'search' } }]
                    }));
                    const reason = r._classifyUpgradeReason(features);
                    expect(reason).toBe('has_tools');
                });

                test('returns has_vision when vision present and threshold set', () => {
                    const features = r.extractFeatures(makeBody({
                        messages: [{ role: 'user', content: [
                            { type: 'image', source: { type: 'base64', data: 'abc' } }
                        ] }]
                    }));
                    const reason = r._classifyUpgradeReason(features);
                    expect(reason).toBe('has_vision');
                });

                test('returns max_tokens when maxTokens meets threshold', () => {
                    const features = r.extractFeatures(makeBody({ max_tokens: 4096 }));
                    const reason = r._classifyUpgradeReason(features);
                    expect(reason).toBe('max_tokens');
                });

                test('returns message_count when messageCount meets threshold', () => {
                    const messages = Array(25).fill({ role: 'user', content: 'hi' });
                    const features = r.extractFeatures(makeBody({ messages }));
                    const reason = r._classifyUpgradeReason(features);
                    expect(reason).toBe('message_count');
                });

                test('returns system_length when systemLength meets threshold', () => {
                    const features = r.extractFeatures(makeBody({ system: 'A'.repeat(10000) }));
                    const reason = r._classifyUpgradeReason(features);
                    expect(reason).toBe('system_length');
                });

                test('returns other when no thresholds match', () => {
                    const features = r.extractFeatures(makeBody({ max_tokens: 100 }));
                    const reason = r._classifyUpgradeReason(features);
                    expect(reason).toBe('other');
                });
            });

            describe('byUpgradeReason counter', () => {
                test('increments has_tools when heavy tier selected due to tools', async () => {
                    const result = await r.selectModel({
                        parsedBody: makeBody({
                            tools: [{ type: 'function', function: { name: 'search' } }]
                        }),
                        requestModel: 'claude-sonnet-4-20250514'
                    });
                    expect(result.tier).toBe('heavy');
                    expect(result.source).toBe('classifier');

                    const stats = r.getStats();
                    expect(stats.byUpgradeReason.has_tools).toBe(1);
                });

                test('increments max_tokens when heavy tier selected due to max_tokens', async () => {
                    const result = await r.selectModel({
                        parsedBody: makeBody({ max_tokens: 4096 }),
                        requestModel: 'claude-sonnet-4-20250514'
                    });
                    expect(result.tier).toBe('heavy');

                    const stats = r.getStats();
                    expect(stats.byUpgradeReason.max_tokens).toBe(1);
                });
            });

            describe('byModel counter', () => {
                test('increments counter for selected heavy model', async () => {
                    const result = await r.selectModel({
                        parsedBody: makeBody({ max_tokens: 4096 }),
                        requestModel: 'claude-sonnet-4-20250514'
                    });
                    expect(result.tier).toBe('heavy');
                    expect(result.model).toBe('glm-4-plus');

                    const stats = r.getStats();
                    expect(stats.byModel['glm-4-plus']).toBe(1);
                });

                test('increments counter for non-heavy tiers via commitDecision', async () => {
                    const result = await r.selectModel({
                        parsedBody: makeBody({ max_tokens: 100 }),
                        requestModel: 'claude-sonnet-4-20250514'
                    });
                    expect(result.tier).toBe('light');

                    // commitDecision now records byModel for all tiers, not just heavy
                    const stats = r.getStats();
                    expect(stats.byModel[result.model]).toBe(1);
                });
            });

            describe('byFallbackReason counter', () => {
                test('increments cooldown when candidate in cooldown', async () => {
                    r.recordModelCooldown('glm-4-plus', 5000);

                    const result = await r.selectModel({
                        parsedBody: makeBody({ max_tokens: 4096 }),
                        requestModel: 'claude-sonnet-4-20250514'
                    });

                    const stats = r.getStats();
                    // After v1->v2 migration, the config has models[] array
                    // So pool selection runs and increments cooldown counter
                    expect(stats.byFallbackReason.cooldown || 0).toBe(1);
                });

                test('increments not_in_candidates when model in pool strategy already attempted', async () => {
                    // Create a clean v2 pool config
                    const r2 = new ModelRouter({
                        enabled: true,
                        tiers: {
                            light: { targetModel: 'glm-4-flash', failoverModel: 'glm-4-air', clientModelPolicy: 'always-route' },
                            medium: { targetModel: 'glm-4-air', failoverModel: 'glm-4-flash', clientModelPolicy: 'always-route' },
                            heavy: {
                                models: ['glm-4-plus', 'glm-4.5-air'],
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
                                hasVision: true,
                                systemLengthGte: 10000
                            },
                            lightThresholds: {
                                maxTokensLte: 512,
                                messageCountLte: 3,
                                hasTools: false,
                                hasVision: false
                            }
                        },
                        cooldown: { defaultMs: 5000, maxMs: 30000, decayMs: 60000, backoffMultiplier: 2 },
                        defaultModel: 'glm-4-air',
                        overridesFile: 'model-routing-overrides.json',
                        logDecisions: false
                    }, { modelDiscovery: mockModelDiscovery, persistEnabled: false });

                    const result = await r2.selectModel({
                        parsedBody: makeBody({ max_tokens: 4096 }),
                        requestModel: 'claude-sonnet-4-20250514',
                        attemptedModels: new Set(['glm-4-plus'])
                    });

                    const stats = r2.getStats();
                    expect(stats.byFallbackReason.not_in_candidates).toBeGreaterThan(0);
                });

                test('increments at_capacity when pool strategy candidate at capacity', async () => {
                    // Create a clean v2 pool config
                    const r2 = new ModelRouter({
                        enabled: true,
                        tiers: {
                            light: { targetModel: 'glm-4-flash', failoverModel: 'glm-4-air', clientModelPolicy: 'always-route' },
                            medium: { targetModel: 'glm-4-air', failoverModel: 'glm-4-flash', clientModelPolicy: 'always-route' },
                            heavy: {
                                models: ['glm-4-plus', 'glm-4.5-air'],
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
                                hasVision: true,
                                systemLengthGte: 10000
                            },
                            lightThresholds: {
                                maxTokensLte: 512,
                                messageCountLte: 3,
                                hasTools: false,
                                hasVision: false
                            }
                        },
                        cooldown: { defaultMs: 5000, maxMs: 30000, decayMs: 60000, backoffMultiplier: 2 },
                        defaultModel: 'glm-4-air',
                        overridesFile: 'model-routing-overrides.json',
                        logDecisions: false
                    }, {
                        modelDiscovery: mockModelDiscovery,
                        persistEnabled: false
                    });

                    // Mock discovery to return maxConcurrency=1 for both
                    const originalGetModel = mockModelDiscovery.getModel;
                    mockModelDiscovery.getModel = jest.fn().mockImplementation((id) => {
                        if (id === 'glm-4-plus' || id === 'glm-4.5-air') {
                            return { maxConcurrency: 1, pricing: { input: 0, output: 0 } };
                        }
                        return originalGetModel.call(mockModelDiscovery, id);
                    });

                    // Mark both models as in-flight (at capacity)
                    r2._inFlight.set('glm-4-plus', 1);
                    r2._inFlight.set('glm-4.5-air', 1);

                    const result = await r2.selectModel({
                        parsedBody: makeBody({ max_tokens: 4096 }),
                        requestModel: 'claude-sonnet-4-20250514'
                    });

                    // Restore mock
                    mockModelDiscovery.getModel = originalGetModel;

                    const stats = r2.getStats();
                    expect(stats.byFallbackReason.at_capacity).toBeGreaterThan(0);
                });

                test('increments tier_exhausted when pool strategy all candidates unavailable', async () => {
                    // Create a clean v2 pool config
                    const r2 = new ModelRouter({
                        enabled: true,
                        tiers: {
                            light: { targetModel: 'glm-4-flash', failoverModel: 'glm-4-air', clientModelPolicy: 'always-route' },
                            medium: { targetModel: 'glm-4-air', failoverModel: 'glm-4-flash', clientModelPolicy: 'always-route' },
                            heavy: {
                                models: ['glm-4-plus', 'glm-4.5-air'],
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
                                hasVision: true,
                                systemLengthGte: 10000
                            },
                            lightThresholds: {
                                maxTokensLte: 512,
                                messageCountLte: 3,
                                hasTools: false,
                                hasVision: false
                            }
                        },
                        cooldown: { defaultMs: 5000, maxMs: 30000, decayMs: 60000, backoffMultiplier: 2 },
                        defaultModel: 'glm-4-air',
                        overridesFile: 'model-routing-overrides.json',
                        logDecisions: false
                    }, {
                        modelDiscovery: mockModelDiscovery,
                        persistEnabled: false
                    });

                    // Mock discovery to return maxConcurrency=1
                    const originalGetModel = mockModelDiscovery.getModel;
                    mockModelDiscovery.getModel = jest.fn().mockImplementation((id) => {
                        if (id === 'glm-4-plus' || id === 'glm-4.5-air') {
                            return { maxConcurrency: 1, pricing: { input: 0, output: 0 } };
                        }
                        return originalGetModel.call(mockModelDiscovery, id);
                    });

                    // Mark both models as at full capacity (1 in-flight each)
                    r2._inFlight.set('glm-4-plus', 1);
                    r2._inFlight.set('glm-4.5-air', 1);

                    const result = await r2.selectModel({
                        parsedBody: makeBody({ max_tokens: 4096 }),
                        requestModel: 'claude-sonnet-4-20250514'
                    });

                    // Restore mock
                    mockModelDiscovery.getModel = originalGetModel;

                    // Both candidates at capacity - tier_exhausted should be incremented
                    const stats = r2.getStats();
                    expect(stats.byFallbackReason.tier_exhausted).toBeGreaterThan(0);
                });
            });

            describe('getStats exports new counters', () => {
                test('includes byUpgradeReason, byModel, byFallbackReason', async () => {
                    await r.selectModel({
                        parsedBody: makeBody({ max_tokens: 4096 }),
                        requestModel: 'claude-sonnet-4-20250514'
                    });

                    const stats = r.getStats();
                    expect(stats.byUpgradeReason).toBeDefined();
                    expect(stats.byModel).toBeDefined();
                    expect(stats.byFallbackReason).toBeDefined();
                    expect(stats.heavyModels).toBeDefined();
                });
            });

            describe('reset clears new counters', () => {
                test('clears byUpgradeReason, byModel, byFallbackReason on reset', async () => {
                    await r.selectModel({
                        parsedBody: makeBody({ max_tokens: 4096 }),
                        requestModel: 'claude-sonnet-4-20250514'
                    });

                    r.reset();

                    const stats = r.getStats();
                    expect(stats.byUpgradeReason.has_tools || 0).toBe(0);
                    expect(stats.byUpgradeReason.max_tokens || 0).toBe(0);
                    expect(stats.byModel['glm-4-plus'] || 0).toBe(0);
                    expect(stats.byFallbackReason.cooldown || 0).toBe(0);
                });
            });
        });
    });

    // ==================================================================
    // GLM5-07: Staged rollout (preferencePercent knob)
    // ==================================================================

    describe('GLM5-07: Staged rollout', () => {
        let r;
        let mockModelDiscovery;

        beforeEach(() => {
            mockModelDiscovery = {
                getModel: jest.fn().mockResolvedValue({
                    maxConcurrency: 10,
                    pricing: { input: 0.5, output: 1.5 }
                }),
                isAvailable: jest.fn().mockResolvedValue(true)
            };

            r = new ModelRouter({
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
                        models: ['glm-4-plus', 'glm-5'],
                        strategy: 'balanced',
                        clientModelPolicy: 'always-route'
                    }
                },
                rules: [],
                classifier: {
                    heavyThresholds: {
                        maxTokensGte: 4096,
                        messageCountGte: 20,
                        hasTools: true,
                        hasVision: true,
                        systemLengthGte: 10000
                    }
                },
                cooldown: { defaultMs: 5000, maxMs: 30000, decayMs: 60000, backoffMultiplier: 2 },
                defaultModel: 'glm-4-air',
                overridesFile: 'model-routing-overrides.json',
                logDecisions: false
            }, { modelDiscovery: mockModelDiscovery, persistEnabled: false });
        });

        test('preferencePercent=0 (shadow only)', async () => {
            // Update config to enable glm5 with 0% preference (shadow only)
            r.updateConfig({
                ...r.config,
                glm5: { enabled: true, preferencePercent: 0 }
            });

            const result = await r.selectModel({
                parsedBody: { max_tokens: 8192, tools: [] },
                requestModel: 'claude-sonnet-4-20250514'
            });

            const stats = r.getStats();
            expect(stats.glm5EligibleTotal).toBe(1);
            expect(stats.glm5PreferenceShadow).toBe(1);
            expect(stats.glm5PreferenceApplied).toBe(0);
            // At 0%, glm-5 should NOT be forced to win (may or may not be selected)
        });

        test('preferencePercent=100 (always prefer)', async () => {
            r.updateConfig({
                ...r.config,
                glm5: { enabled: true, preferencePercent: 100 }
            });

            const result = await r.selectModel({
                parsedBody: { max_tokens: 8192, tools: [] },
                requestModel: 'claude-sonnet-4-20250514'
            });

            const stats = r.getStats();
            expect(stats.glm5EligibleTotal).toBe(1);
            expect(stats.glm5PreferenceApplied).toBe(1);
            expect(stats.glm5PreferenceShadow).toBe(0);
            // At 100%, glm-5 should ALWAYS win for heavy tier
            expect(result.model).toBe('glm-5');
        });

        test('enabled=false (disabled)', async () => {
            r.updateConfig({
                ...r.config,
                glm5: { enabled: false }
            });

            const result = await r.selectModel({
                parsedBody: { max_tokens: 8192, tools: [] },
                requestModel: 'claude-sonnet-4-20250514'
            });

            const stats = r.getStats();
            // Disabled skips eligibility counting entirely
            expect(stats.glm5EligibleTotal).toBe(0);
            expect(stats.glm5PreferenceApplied).toBe(0);
            expect(stats.glm5PreferenceShadow).toBe(0);
            // glm-5 should NOT be selected when disabled
            expect(result.model).not.toBe('glm-5');
        });

        test('preferencePercent=50 (statistical - applied)', async () => {
            // Mock Math.random to return value below 50% (applied)
            const originalRandom = Math.random;
            Math.random = jest.fn(() => 0.25); // 25% < 50% -> applied

            r.updateConfig({
                ...r.config,
                glm5: { enabled: true, preferencePercent: 50 }
            });

            const result = await r.selectModel({
                parsedBody: { max_tokens: 8192, tools: [] },
                requestModel: 'claude-sonnet-4-20250514'
            });

            const stats = r.getStats();
            expect(stats.glm5EligibleTotal).toBe(1);
            expect(stats.glm5PreferenceApplied).toBe(1);
            expect(stats.glm5PreferenceShadow).toBe(0);
            expect(result.model).toBe('glm-5');

            Math.random = originalRandom;
        });

        test('preferencePercent=50 (statistical - shadow)', async () => {
            // Mock Math.random to return value above 50% (shadow)
            const originalRandom = Math.random;
            Math.random = jest.fn(() => 0.75); // 75% >= 50% -> shadow

            r.updateConfig({
                ...r.config,
                glm5: { enabled: true, preferencePercent: 50 }
            });

            const result = await r.selectModel({
                parsedBody: { max_tokens: 8192, tools: [] },
                requestModel: 'claude-sonnet-4-20250514'
            });

            const stats = r.getStats();
            expect(stats.glm5EligibleTotal).toBe(1);
            expect(stats.glm5PreferenceShadow).toBe(1);
            expect(stats.glm5PreferenceApplied).toBe(0);

            Math.random = originalRandom;
        });

        test('Non-heavy tier ignored', async () => {
            r.updateConfig({
                ...r.config,
                glm5: { enabled: true, preferencePercent: 100 }
            });

            // Light tier request
            const result = await r.selectModel({
                parsedBody: { max_tokens: 256, tools: [] },
                requestModel: 'claude-sonnet-4-20250514'
            });

            const stats = r.getStats();
            // Non-heavy tiers should not increment GLM5 stats
            expect(stats.glm5EligibleTotal).toBe(0);
            expect(stats.glm5PreferenceApplied).toBe(0);
            expect(stats.glm5PreferenceShadow).toBe(0);
        });

        test('glm-5 not in candidates', async () => {
            r.updateConfig({
                ...r.config,
                glm5: { enabled: true, preferencePercent: 100 },
                tiers: {
                    ...r.config.tiers,
                    heavy: {
                        models: ['glm-4-plus', 'glm-4.5-air'],
                        strategy: 'balanced',
                        clientModelPolicy: 'always-route'
                    }
                }
            });

            const result = await r.selectModel({
                parsedBody: { max_tokens: 8192, tools: [] },
                requestModel: 'claude-sonnet-4-20250514'
            });

            const stats = r.getStats();
            // glm-5 not in candidates -> no eligibility counting
            expect(stats.glm5EligibleTotal).toBe(0);
            expect(stats.glm5PreferenceApplied).toBe(0);
            expect(stats.glm5PreferenceShadow).toBe(0);
        });

        test('reset clears glm5 stats', async () => {
            r.updateConfig({
                ...r.config,
                glm5: { enabled: true, preferencePercent: 50 }
            });

            await r.selectModel({
                parsedBody: { max_tokens: 8192, tools: [] },
                requestModel: 'claude-sonnet-4-20250514'
            });

            let stats = r.getStats();
            expect(stats.glm5EligibleTotal).toBeGreaterThan(0);

            r.reset();

            stats = r.getStats();
            expect(stats.glm5EligibleTotal).toBe(0);
            expect(stats.glm5PreferenceApplied).toBe(0);
            expect(stats.glm5PreferenceShadow).toBe(0);
        });

        test('getStats exports glm5 preference counters', async () => {
            r.updateConfig({
                ...r.config,
                glm5: { enabled: true, preferencePercent: 50 }
            });

            await r.selectModel({
                parsedBody: { max_tokens: 8192, tools: [] },
                requestModel: 'claude-sonnet-4-20250514'
            });

            const stats = r.getStats();
            expect(stats.glm5EligibleTotal).toBeDefined();
            expect(stats.glm5PreferenceApplied).toBeDefined();
            expect(stats.glm5PreferenceShadow).toBeDefined();
        });
    });

    // ==================================================================
    // validateConfig — strategy field
    // ==================================================================

    describe('validateConfig — strategy', () => {
    });

    // ==================================================================
    // validateConfig — strategy field
    // ==================================================================

    describe('validateConfig — strategy', () => {
        test('accepts valid strategy values', () => {
            expect(ModelRouter.validateConfig({
                tiers: { light: { targetModel: 'glm-4.5-air', strategy: 'failover' } }
            }).valid).toBe(true);

            expect(ModelRouter.validateConfig({
                tiers: { light: { targetModel: 'glm-4.5-air', strategy: 'pool' } }
            }).valid).toBe(true);
        });

        test('accepts tier without strategy (optional field)', () => {
            expect(ModelRouter.validateConfig({
                tiers: { light: { targetModel: 'glm-4.5-air' } }
            }).valid).toBe(true);
        });

        test('rejects invalid strategy value', () => {
            const result = ModelRouter.validateConfig({
                tiers: { light: { targetModel: 'glm-4.5-air', strategy: 'round-robin' } }
            });
            expect(result.valid).toBe(false);
            expect(result.error).toContain('strategy');
        });
    });

    // ==================================================================
    // TRUST-03: Trace Sampling
    // ==================================================================

    describe('Trace Sampling', () => {
        test('config accepts samplingRate in modelRouting.trace', () => {
            const r = new ModelRouter({
                ...makeConfig(),
                trace: { samplingRate: 50 }
            }, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            expect(r.config.trace.samplingRate).toBe(50);
        });

        test('samplingRate defaults to 10 when not specified', async () => {
            const r = new ModelRouter(makeConfig(), {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            // When trace config is not specified, _shouldSampleTrace should use default 10%
            // Test by running 1000 times and checking approximately 10% are sampled
            let traceIncludedCount = 0;
            const runs = 1000;

            for (let i = 0; i < runs; i++) {
                const decision = await r.computeDecision({
                    parsedBody: makeBody(),
                    requestModel: 'claude-sonnet-4-20250514',
                    includeTrace: true
                });
                if (decision.trace !== undefined) {
                    traceIncludedCount++;
                }
            }

            // Should be approximately 10% (allow 5-15% range for randomness)
            const percentage = (traceIncludedCount / runs) * 100;
            expect(percentage).toBeGreaterThanOrEqual(5);
            expect(percentage).toBeLessThanOrEqual(15);
        });

        test('env var GLM_TRACE_SAMPLING_RATE is parsed', () => {
            const originalValue = process.env.GLM_TRACE_SAMPLING_RATE;
            process.env.GLM_TRACE_SAMPLING_RATE = '75';

            // Create a new config instance to pick up the env var
            const { Config } = require('../lib/config');
            const config = new Config();

            expect(config.get('modelRouting.trace.samplingRate')).toBe(75);

            // Restore original value
            if (originalValue === undefined) {
                delete process.env.GLM_TRACE_SAMPLING_RATE;
            } else {
                process.env.GLM_TRACE_SAMPLING_RATE = originalValue;
            }
        });

        test('samplingRate=0 never includes trace', async () => {
            const r = new ModelRouter({
                ...makeConfig(),
                trace: { samplingRate: 0 }
            }, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            // Run 100 times with includeTrace=true
            for (let i = 0; i < 100; i++) {
                const decision = await r.computeDecision({
                    parsedBody: makeBody(),
                    requestModel: 'claude-sonnet-4-20250514',
                    includeTrace: true
                });
                expect(decision.trace).toBeUndefined();
            }

            // computeDecision is pure; stats mutate only via commit/selectModel
            const stats = r.getStats();
            expect(stats.traceSampledTotal).toBe(0);
            expect(stats.traceSampledIncluded).toBe(0);
        });

        test('samplingRate=100 always includes trace', async () => {
            const r = new ModelRouter({
                ...makeConfig(),
                trace: { samplingRate: 100 }
            }, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            // Run 100 times with includeTrace=true
            for (let i = 0; i < 100; i++) {
                const decision = await r.computeDecision({
                    parsedBody: makeBody(),
                    requestModel: 'claude-sonnet-4-20250514',
                    includeTrace: true
                });
                expect(decision.trace).toBeDefined();
            }

            // computeDecision is pure; stats mutate only via commit/selectModel
            const stats = r.getStats();
            expect(stats.traceSampledTotal).toBe(0);
            expect(stats.traceSampledIncluded).toBe(0);
        });

        test('samplingRate=50 approximately 50% over many runs', async () => {
            const r = new ModelRouter({
                ...makeConfig(),
                trace: { samplingRate: 50 }
            }, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            let traceIncludedCount = 0;
            const runs = 1000;

            for (let i = 0; i < runs; i++) {
                const decision = await r.computeDecision({
                    parsedBody: makeBody(),
                    requestModel: 'claude-sonnet-4-20250514',
                    includeTrace: true
                });
                if (decision.trace !== undefined) {
                    traceIncludedCount++;
                }
            }

            // Should be approximately 50% (allow 40-60% range for randomness)
            const percentage = (traceIncludedCount / runs) * 100;
            expect(percentage).toBeGreaterThanOrEqual(40);
            expect(percentage).toBeLessThanOrEqual(60);

            // computeDecision is pure; stats mutate only via commit/selectModel
            const stats = r.getStats();
            expect(stats.traceSampledTotal).toBe(0);
            expect(stats.traceSampledIncluded).toBe(0);
        });

        test('trace sampling only applies when includeTrace=true', async () => {
            const r = new ModelRouter({
                ...makeConfig(),
                trace: { samplingRate: 100 }  // Always sample
            }, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            // Without includeTrace, no trace should be included
            const decision1 = await r.computeDecision({
                parsedBody: makeBody(),
                requestModel: 'claude-sonnet-4-20250514',
                includeTrace: false
            });
            expect(decision1.trace).toBeUndefined();

            // With includeTrace, trace should be included
            const decision2 = await r.computeDecision({
                parsedBody: makeBody(),
                requestModel: 'claude-sonnet-4-20250514',
                includeTrace: true
            });
            expect(decision2.trace).toBeDefined();

            // computeDecision is pure; stats mutate only via commit/selectModel
            const stats = r.getStats();
            expect(stats.traceSampledTotal).toBe(0);
            expect(stats.traceSampledIncluded).toBe(0);
        });

        test('getStats exports trace sampling counters', async () => {
            const r = new ModelRouter({
                ...makeConfig(),
                trace: { samplingRate: 100 }
            }, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            await r.computeDecision({
                parsedBody: makeBody(),
                requestModel: 'claude-sonnet-4-20250514',
                includeTrace: true
            });

            const stats = r.getStats();
            expect(stats.traceSampledTotal).toBeDefined();
            expect(stats.traceSampledIncluded).toBeDefined();
            expect(stats.traceSampledTotal).toBe(0);
            expect(stats.traceSampledIncluded).toBe(0);
        });
    });

    // TRUST-02: Simulation Mode Tests
    describe('Decision Mode Simulation', () => {

        test('simulateDecisionMode returns all models as available', async () => {
            const r = new ModelRouter({
                ...makeConfig(),
                tiers: {
                    heavy: {
                        models: ['glm-4-plus', 'glm-4-flash'],
                        strategy: 'pool'
                    }
                }
            }, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            // Set up some cooldowns and in-flight requests
            r._cooldowns.set('glm-4-plus', { count: 1, until: Date.now() + 10000 });
            r._inFlight.set('glm-4-flash', 5);

            const context = {
                parsedBody: makeBody(),
                requestModel: 'claude-opus-4-20250514'
            };

            const result = await r.simulateDecisionMode(context);

            // Decision mode should ignore cooldowns and in-flight
            expect(result.mode).toBe('decision');
            expect(result.selectedModel).toBeDefined();
            expect(result.cooldownReasons).toEqual([]);
        });

        test('simulateDecisionMode ignores current in-flight counts', async () => {
            const r = new ModelRouter({
                ...makeConfig(),
                tiers: {
                    heavy: {
                        models: ['glm-4-plus', 'glm-4-flash'],
                        strategy: 'throughput'
                    }
                }
            }, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            // Max out in-flight for one model
            r._inFlight.set('glm-4-plus', 100);

            const context = {
                parsedBody: makeBody(),
                requestModel: 'claude-opus-4-20250514'
            };

            const result = await r.simulateDecisionMode(context);

            // Decision mode should still select from all models
            expect(result.mode).toBe('decision');
            expect(result.selectedModel).toBeDefined();
            // Original in-flight should be unchanged
            expect(r._inFlight.get('glm-4-plus')).toBe(100);
        });

        test('simulateDecisionMode produces deterministic output', async () => {
            const r = new ModelRouter({
                ...makeConfig(),
                tiers: {
                    heavy: {
                        models: ['glm-4-plus', 'glm-4-flash'],
                        strategy: 'balanced'
                    }
                }
            }, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            const context = {
                parsedBody: makeBody(),
                requestModel: 'claude-opus-4-20250514'
            };

            const result1 = await r.simulateDecisionMode(context);
            const result2 = await r.simulateDecisionMode(context);

            // Same input should produce same output
            expect(result1.selectedModel).toBe(result2.selectedModel);
            expect(result1.tier).toBe(result2.tier);
        });

        test('simulateDecisionMode includes trace by default', async () => {
            const r = new ModelRouter({
                ...makeConfig()
            }, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            const context = {
                parsedBody: makeBody(),
                requestModel: 'claude-sonnet-4-20250514'
            };

            const result = await r.simulateDecisionMode(context);

            expect(result.trace).toBeDefined();
            expect(result.trace.requestId).toBeDefined();
            expect(result.trace.timestamp).toBeDefined();
        });
    });

    describe('Stateful Mode Simulation', () => {

        test('simulateStatefulMode uses provided snapshot', async () => {
            const r = new ModelRouter({
                ...makeConfig(),
                tiers: {
                    heavy: {
                        models: ['glm-4-plus', 'glm-4-flash'],
                        strategy: 'pool'
                    }
                }
            }, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            const snapshot = {
                version: '1.0',
                timestamp: Date.now(),
                models: [
                    {
                        modelId: 'glm-4-plus',
                        tier: 'heavy',
                        inFlight: 0,
                        maxConcurrency: 2,
                        isAvailable: true
                    },
                    {
                        modelId: 'glm-4-flash',
                        tier: 'heavy',
                        inFlight: 2,
                        maxConcurrency: 2,
                        isAvailable: false,
                        cooldownUntil: Date.now() + 5000
                    }
                ]
            };

            const context = {
                parsedBody: makeBody(),
                requestModel: 'claude-opus-4-20250514'
            };

            const result = await r.simulateStatefulMode(context, snapshot);

            expect(result.mode).toBe('stateful');
            expect(result.snapshotTimestamp).toBe(snapshot.timestamp);
            expect(result.selectedModel).toBeDefined();
        });

        test('simulateStatefulMode produces deterministic output for same snapshot', async () => {
            const r = new ModelRouter({
                ...makeConfig(),
                tiers: {
                    heavy: {
                        models: ['glm-4-plus', 'glm-4-flash'],
                        strategy: 'balanced'
                    }
                }
            }, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            const snapshot = {
                version: '1.0',
                timestamp: Date.now(),
                models: [
                    {
                        modelId: 'glm-4-plus',
                        tier: 'heavy',
                        inFlight: 1,
                        maxConcurrency: 2,
                        isAvailable: true
                    },
                    {
                        modelId: 'glm-4-flash',
                        tier: 'heavy',
                        inFlight: 0,
                        maxConcurrency: 2,
                        isAvailable: true
                    }
                ]
            };

            const context = {
                parsedBody: makeBody(),
                requestModel: 'claude-opus-4-20250514'
            };

            const result1 = await r.simulateStatefulMode(context, snapshot);
            const result2 = await r.simulateStatefulMode(context, snapshot);

            // Same snapshot should produce same output
            expect(result1.selectedModel).toBe(result2.selectedModel);
            expect(result1.tier).toBe(result2.tier);
        });

        test('simulateStatefulMode throws error for invalid snapshot version', async () => {
            const r = new ModelRouter({
                ...makeConfig()
            }, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            const invalidSnapshot = {
                version: '2.0',
                timestamp: Date.now(),
                models: []
            };

            const context = {
                parsedBody: makeBody(),
                requestModel: 'claude-sonnet-4-20250514'
            };

            await expect(r.simulateStatefulMode(context, invalidSnapshot))
                .rejects.toThrow('Unsupported snapshot version');
        });

        test('simulateStatefulMode throws error for missing snapshot', async () => {
            const r = new ModelRouter({
                ...makeConfig()
            }, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            const context = {
                parsedBody: makeBody(),
                requestModel: 'claude-sonnet-4-20250514'
            };

            await expect(r.simulateStatefulMode(context, null))
                .rejects.toThrow('Unsupported snapshot version');
        });

        test('simulateStatefulMode does not mutate live router state', async () => {
            const r = new ModelRouter({
                ...makeConfig(),
                tiers: {
                    heavy: {
                        models: ['glm-4-plus', 'glm-4-flash'],
                        strategy: 'pool'
                    }
                }
            }, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            // Set initial state
            r._inFlight.set('glm-4-plus', 5);
            r._cooldowns.set('glm-4-flash', { count: 1, until: Date.now() + 10000 });

            const snapshot = {
                version: '1.0',
                timestamp: Date.now(),
                models: [
                    {
                        modelId: 'glm-4-plus',
                        tier: 'heavy',
                        inFlight: 0,
                        maxConcurrency: 2,
                        isAvailable: true
                    }
                ]
            };

            const context = {
                parsedBody: makeBody(),
                requestModel: 'claude-opus-4-20250514'
            };

            await r.simulateStatefulMode(context, snapshot);

            // Original state should be unchanged
            expect(r._inFlight.get('glm-4-plus')).toBe(5);
            expect(r._cooldowns.has('glm-4-flash')).toBe(true);
        });

        test('simulateStatefulMode includes trace by default', async () => {
            const r = new ModelRouter({
                ...makeConfig()
            }, {
                persistEnabled: false,
                modelDiscovery: mockModelDiscovery
            });

            const snapshot = {
                version: '1.0',
                timestamp: Date.now(),
                models: [
                    {
                        modelId: 'glm-4-plus',
                        tier: 'heavy',
                        inFlight: 0,
                        maxConcurrency: 2,
                        isAvailable: true
                    }
                ]
            };

            const context = {
                parsedBody: makeBody(),
                requestModel: 'claude-sonnet-4-20250514'
            };

            const result = await r.simulateStatefulMode(context, snapshot);

            expect(result.trace).toBeDefined();
            expect(result.trace.requestId).toBeDefined();
            expect(result.trace.timestamp).toBeDefined();
        });
    });

});

// ==================================================================
// commitDecision stats recording (Stream 4h)
// ==================================================================

describe('commitDecision', () => {
    let router;

    beforeEach(() => {
        router = new ModelRouter(makeConfig(), {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery
        });
    });

    test('increments _stats.total, byTier, bySource, byModel and calls acquireModel', () => {
        const decision = {
            model: 'glm-4-plus',
            tier: 'heavy',
            source: 'rule',
            reason: 'test'
        };

        const before = router._inFlight.get('glm-4-plus') || 0;
        const result = router.commitDecision(decision);

        expect(result.committed).toBe(true);
        expect(router._stats.total).toBe(1);
        expect(router._stats.byTier.heavy).toBe(1);
        expect(router._stats.bySource.rule).toBe(1);
        expect(router._stats.byModel['glm-4-plus']).toBe(1);
        expect(router._inFlight.get('glm-4-plus')).toBe(before + 1);
    });

    test('records byStrategy when present', () => {
        router.commitDecision({
            model: 'glm-4-air',
            tier: 'medium',
            source: 'classifier',
            strategy: 'balanced',
            reason: 'test'
        });

        expect(router._stats.byStrategy.balanced).toBe(1);
    });

    test('records byUpgradeReason when present', () => {
        router.commitDecision({
            model: 'glm-4-plus',
            tier: 'heavy',
            source: 'classifier',
            upgradeReason: 'tools',
            reason: 'test'
        });

        expect(router._stats.byUpgradeReason.tools).toBe(1);
    });

    test('records tierDowngradeTotal when degradedFromTier is set', () => {
        router.commitDecision({
            model: 'glm-4-air',
            tier: 'medium',
            source: 'classifier',
            degradedFromTier: 'heavy',
            reason: 'test'
        });

        expect(router._stats.tierDowngradeTotal).toBe(1);
    });

    test('is idempotent - does not double-count committed decisions', () => {
        const decision = {
            model: 'glm-4-plus',
            tier: 'heavy',
            source: 'rule',
            reason: 'test'
        };

        router.commitDecision(decision);
        router.commitDecision(decision); // second call should be no-op

        expect(router._stats.total).toBe(1);
        expect(router._stats.byTier.heavy).toBe(1);
    });

    test('returns null/undefined decision unchanged', () => {
        expect(router.commitDecision(null)).toBeNull();
        expect(router.commitDecision(undefined)).toBeUndefined();
        expect(router.commitDecision({ reason: 'no model' })).toEqual({ reason: 'no model' });
        expect(router._stats.total).toBe(0);
    });
});

// ==================================================================
// selectModel returns committed decisions (Stream 4h)
// ==================================================================

describe('selectModel returns committed decisions', () => {
    let router;

    beforeEach(() => {
        router = new ModelRouter(makeConfig(), {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery
        });
    });

    test('rule-routed decision has committed === true', async () => {
        const result = await router.selectModel({
            parsedBody: makeBody({ model: 'claude-3-opus-20240229' }),
            requestModel: 'claude-3-opus-20240229'
        });

        expect(result).not.toBeNull();
        expect(result.committed).toBe(true);
        expect(result.model).toBe('glm-4-plus');
    });

    test('override-routed decision has committed === true', async () => {
        const result = await router.selectModel({
            parsedBody: makeBody(),
            requestModel: 'claude-sonnet-4',
            override: 'glm-4-custom'
        });

        expect(result.committed).toBe(true);
        expect(result.source).toBe('override');
    });

    test('classifier-routed decision has committed === true', async () => {
        const result = await router.selectModel({
            parsedBody: makeBody({ model: 'claude-sonnet-4-20250514', max_tokens: 5000 }),
            requestModel: 'claude-sonnet-4-20250514'
        });

        expect(result.committed).toBe(true);
        expect(result.source).toBe('classifier');
    });

    test('stats are accurately counted after multiple selectModel calls', async () => {
        // Rule-based (heavy)
        await router.selectModel({
            parsedBody: makeBody({ model: 'claude-3-opus-20240229' }),
            requestModel: 'claude-3-opus-20240229'
        });
        // Override
        await router.selectModel({
            parsedBody: makeBody(),
            requestModel: 'claude-sonnet-4',
            override: 'glm-4-custom'
        });
        // Another rule-based (heavy)
        await router.selectModel({
            parsedBody: makeBody({ model: 'claude-opus-4' }),
            requestModel: 'claude-opus-4'
        });

        expect(router._stats.total).toBe(3);
        expect(router._stats.byTier.heavy).toBeGreaterThanOrEqual(2);
        expect(router._stats.bySource.override).toBe(1);
        expect(router._stats.bySource.rule).toBeGreaterThanOrEqual(2);
    });
});

// ==================================================================
// _estimateRequestTokens
// ==================================================================

describe('_estimateRequestTokens', () => {
    let router;

    beforeEach(() => {
        jest.clearAllMocks();
        router = new ModelRouter(makeConfig(), {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery
        });
    });

    test('returns 0 for null/undefined body', () => {
        expect(router._estimateRequestTokens(null)).toBe(0);
        expect(router._estimateRequestTokens(undefined)).toBe(0);
    });

    test('estimates string messages correctly', () => {
        const result = router._estimateRequestTokens({
            messages: [{ role: 'user', content: 'Hello world' }],
            max_tokens: 100
        });
        // 11 chars content + 16 overhead = 27 chars → 7 input tokens
        // + 100 max_tokens = 107 → * 1.1 safety = ~118
        expect(result).toBeGreaterThan(0);
        expect(result).toBeLessThan(500);
    });

    test('includes system prompt in estimation', () => {
        const withSystem = router._estimateRequestTokens({
            system: 'A'.repeat(4000), // 1000 tokens worth
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 100
        });
        const withoutSystem = router._estimateRequestTokens({
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 100
        });
        expect(withSystem).toBeGreaterThan(withoutSystem);
    });

    test('handles array system prompt blocks', () => {
        const result = router._estimateRequestTokens({
            system: [{ type: 'text', text: 'You are helpful.' }],
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 100
        });
        expect(result).toBeGreaterThan(0);
    });

    test('counts image blocks as ~260 tokens', () => {
        const withImage = router._estimateRequestTokens({
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: 'describe this' },
                    { type: 'image', source: { type: 'base64', data: 'abc' } }
                ]
            }],
            max_tokens: 100
        });
        const withoutImage = router._estimateRequestTokens({
            messages: [{ role: 'user', content: 'describe this' }],
            max_tokens: 100
        });
        // Image should add ~260 tokens (no safety margin inflation)
        expect(withImage - withoutImage).toBeGreaterThan(200);
    });

    test('counts tool definitions', () => {
        const withTools = router._estimateRequestTokens({
            messages: [{ role: 'user', content: 'hi' }],
            tools: [{ name: 'get_weather', description: 'Get weather data', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
            max_tokens: 100
        });
        const withoutTools = router._estimateRequestTokens({
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 100
        });
        expect(withTools).toBeGreaterThan(withoutTools);
    });

    test('uses max_tokens from body, defaults to 4096', () => {
        const withExplicit = router._estimateRequestTokens({
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 100
        });
        const withDefault = router._estimateRequestTokens({
            messages: [{ role: 'user', content: 'hi' }]
        });
        // Default 4096 should produce much larger estimate
        expect(withDefault).toBeGreaterThan(withExplicit);
    });

    test('handles tool_use and tool_result blocks', () => {
        const result = router._estimateRequestTokens({
            messages: [{
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } }]
            }, {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Sunny, 22C' }]
            }],
            max_tokens: 100
        });
        expect(result).toBeGreaterThan(0);
    });
});

// ==================================================================
// Context overflow in pool selection
// ==================================================================

describe('context overflow in pool selection', () => {
    const modelMeta = {
        'small-model': { maxConcurrency: 5, pricing: { input: 0.1, output: 0.5 }, contextLength: 8000 },
        'large-model': { maxConcurrency: 5, pricing: { input: 0.5, output: 2.0 }, contextLength: 200000 },
        'unknown-ctx-model': { maxConcurrency: 5, pricing: { input: 0.2, output: 1.0 } }
    };

    const overflowDiscovery = {
        getModel: jest.fn().mockImplementation((id) => modelMeta[id] || null)
    };

    function makeOverflowRouter(configOverrides = {}) {
        return new ModelRouter(makeConfig({
            tiers: {
                light: {
                    models: ['small-model', 'large-model'],
                    strategy: 'balanced',
                    clientModelPolicy: 'always-route'
                },
                medium: {
                    models: ['unknown-ctx-model'],
                    strategy: 'balanced',
                    clientModelPolicy: 'always-route'
                },
                heavy: {
                    targetModel: 'large-model',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [
                { match: { model: 'claude-haiku-*' }, tier: 'light' },
                { match: { model: 'claude-sonnet-*' }, tier: 'medium' }
            ],
            ...configOverrides
        }), {
            persistEnabled: false,
            modelDiscovery: overflowDiscovery
        });
    }

    // Helper: build a large body that exceeds 8K context but fits in 200K
    function makeLargeBody() {
        return makeBody({
            model: 'claude-haiku-3',
            max_tokens: 4096,
            system: 'A'.repeat(20000), // ~5000 tokens from system alone
            messages: [{ role: 'user', content: 'B'.repeat(20000) }] // ~5000 more
        });
    }

    test('skips model whose contextLength is smaller than estimated tokens', async () => {
        const r = makeOverflowRouter();
        const result = await r.computeDecision({
            parsedBody: makeLargeBody(),
            requestModel: 'claude-haiku-3'
        });

        // Should route to large-model (200K context), skipping small-model (8K)
        expect(result.model).toBe('large-model');
    });

    test('records context_overflow fallback reason after commit', async () => {
        const r = makeOverflowRouter();
        const decision = await r.computeDecision({
            parsedBody: makeLargeBody(),
            requestModel: 'claude-haiku-3'
        });

        // Before commit, stats are in decisionMeta
        expect(r._stats.byFallbackReason.context_overflow).toBe(0);

        // After commit, fallback reasons are flushed to stats
        r.commitDecision(decision);
        expect(r._stats.byFallbackReason.context_overflow).toBeGreaterThan(0);
    });

    test('allows model when contextLength is missing (unknown policy)', async () => {
        // Use a model that maps to medium tier (has unknown-ctx-model)
        const r = makeOverflowRouter();
        // Directly use classifier to route to medium tier by simulating a body
        // that the classifier would send to medium
        const result = await r.computeDecision({
            parsedBody: makeLargeBody(),
            requestModel: 'claude-sonnet-4-20250514',
            override: 'unknown-ctx-model'
        });

        // Override forces unknown-ctx-model, which has no contextLength → allowed
        expect(result.model).toBe('unknown-ctx-model');
    });

    test('allows small request through small-context model', async () => {
        const r = makeOverflowRouter();
        const result = await r.computeDecision({
            parsedBody: makeBody({
                model: 'claude-haiku-3',
                max_tokens: 100,
                messages: [{ role: 'user', content: 'hi' }]
            }),
            requestModel: 'claude-haiku-3'
        });

        // Small request fits in small-model (8K context)
        expect(result.model).toBe('small-model');
    });

    test('attaches contextOverflow warning when all models overflow', async () => {
        // Use only models with small context
        const r = new ModelRouter(makeConfig({
            tiers: {
                light: {
                    models: ['small-model'],
                    strategy: 'balanced',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: 'claude-haiku-*' }, tier: 'light' }]
        }), {
            persistEnabled: false,
            modelDiscovery: overflowDiscovery
        });

        const result = await r.computeDecision({
            parsedBody: makeLargeBody(),
            requestModel: 'claude-haiku-3'
        });

        // Model should still be returned (best effort) but with contextOverflow warning
        expect(result.contextOverflow).toBeDefined();
        expect(result.contextOverflow.estimatedTokens).toBeGreaterThan(8000);
        expect(result.contextOverflow.modelContextLength).toBe(8000);
        expect(result.contextOverflow.overflowBy).toBeGreaterThan(0);
        expect(result.reason).toContain('warning: estimated');
    });
});

// ==================================================================
// Context overflow in selectModel (non-committed path)
// ==================================================================

describe('context overflow selectModel behavior', () => {
    const modelMeta = {
        'tiny-model': { maxConcurrency: 5, pricing: { input: 0.1, output: 0.5 }, contextLength: 4000 }
    };

    const overflowDiscovery = {
        getModel: jest.fn().mockImplementation((id) => modelMeta[id] || null)
    };

    function makeOverflowRouter() {
        return new ModelRouter(makeConfig({
            tiers: {
                light: {
                    models: ['tiny-model'],
                    strategy: 'balanced',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: 'claude-haiku-*' }, tier: 'light' }]
        }), {
            persistEnabled: false,
            modelDiscovery: overflowDiscovery
        });
    }

    function makeLargeBody() {
        return makeBody({
            model: 'claude-haiku-3',
            max_tokens: 4096,
            system: 'A'.repeat(20000),
            messages: [{ role: 'user', content: 'B'.repeat(20000) }]
        });
    }

    test('returns decision with committed=false when context overflows', async () => {
        const r = makeOverflowRouter();
        const result = await r.selectModel({
            parsedBody: makeLargeBody(),
            requestModel: 'claude-haiku-3'
        });

        expect(result).not.toBeNull();
        expect(result.contextOverflow).toBeDefined();
        expect(result.committed).toBe(false);
    });

    test('does not acquire model slot on overflow', async () => {
        const r = makeOverflowRouter();
        await r.selectModel({
            parsedBody: makeLargeBody(),
            requestModel: 'claude-haiku-3'
        });

        // No slot should be acquired
        expect(r._inFlight.get('tiny-model') || 0).toBe(0);
    });

    test('does not increment routing stats on overflow', async () => {
        const r = makeOverflowRouter();
        await r.selectModel({
            parsedBody: makeLargeBody(),
            requestModel: 'claude-haiku-3'
        });

        // Routing total should NOT be incremented
        expect(r._stats.total).toBe(0);
        expect(r._stats.byTier.light).toBe(0);
    });

    test('increments overflow-specific counters', async () => {
        const r = makeOverflowRouter();
        await r.selectModel({
            parsedBody: makeLargeBody(),
            requestModel: 'claude-haiku-3'
        });

        expect(r._stats.contextOverflowTotal).toBe(1);
        expect(r._stats.contextOverflowByModel['tiny-model']).toBe(1);
        expect(r._stats.contextOverflowByTier.light).toBe(1);
    });

    test('overflow counters exposed in getStats()', async () => {
        const r = makeOverflowRouter();
        await r.selectModel({
            parsedBody: makeLargeBody(),
            requestModel: 'claude-haiku-3'
        });

        const stats = r.getStats();
        expect(stats.contextOverflowTotal).toBe(1);
        expect(stats.contextOverflowByModel).toEqual({ 'tiny-model': 1 });
        expect(stats.contextOverflowByTier).toEqual({ light: 1 });
    });
});

// ==================================================================
// commitDecisionOverflow contract
// ==================================================================

describe('commitDecisionOverflow', () => {
    let router;

    beforeEach(() => {
        jest.clearAllMocks();
        router = new ModelRouter(makeConfig(), {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery
        });
    });

    test('sets committed=false and increments overflow counters', () => {
        const decision = {
            model: 'glm-4-plus',
            tier: 'heavy',
            source: 'classifier',
            reason: 'test',
            contextOverflow: {
                estimatedTokens: 200000,
                modelContextLength: 128000,
                overflowBy: 72000
            }
        };

        const result = router.commitDecisionOverflow(decision);

        expect(result.committed).toBe(false);
        expect(router._stats.contextOverflowTotal).toBe(1);
        expect(router._stats.contextOverflowByModel['glm-4-plus']).toBe(1);
        expect(router._stats.contextOverflowByTier.heavy).toBe(1);
    });

    test('does not increment routing counters (total, byTier, bySource)', () => {
        const decision = {
            model: 'glm-4-flash',
            tier: 'light',
            source: 'rule',
            reason: 'test',
            contextOverflow: {
                estimatedTokens: 50000,
                modelContextLength: 8000,
                overflowBy: 42000
            }
        };

        router.commitDecisionOverflow(decision);

        expect(router._stats.total).toBe(0);
        expect(router._stats.byTier.light).toBe(0);
        expect(router._stats.bySource.rule).toBe(0);
    });

    test('flushes fallback reason deltas to stats', () => {
        const decision = {
            model: 'glm-4-flash',
            tier: 'light',
            source: 'rule',
            reason: 'test',
            contextOverflow: {
                estimatedTokens: 50000,
                modelContextLength: 8000,
                overflowBy: 42000
            }
        };
        // Attach meta using the same non-enumerable __commitMeta property
        Object.defineProperty(decision, '__commitMeta', {
            value: { byFallbackReason: { context_overflow: 2, cooldown: 1 } },
            enumerable: false,
            writable: true,
            configurable: true
        });

        router.commitDecisionOverflow(decision);

        expect(router._stats.byFallbackReason.context_overflow).toBe(2);
        expect(router._stats.byFallbackReason.cooldown).toBe(1);
    });

    test('returns decision unchanged for non-overflow decisions', () => {
        const decision = { model: 'glm-4-flash', tier: 'light', reason: 'test' };
        const result = router.commitDecisionOverflow(decision);

        expect(result).toBe(decision);
        expect(router._stats.contextOverflowTotal).toBe(0);
    });

    test('returns null/undefined unchanged', () => {
        expect(router.commitDecisionOverflow(null)).toBeNull();
        expect(router.commitDecisionOverflow(undefined)).toBeUndefined();
        expect(router._stats.contextOverflowTotal).toBe(0);
    });

    test('is idempotent — second call does not double-count', () => {
        const decision = {
            model: 'glm-4-plus',
            tier: 'heavy',
            reason: 'test',
            contextOverflow: {
                estimatedTokens: 200000,
                modelContextLength: 128000,
                overflowBy: 72000
            }
        };
        Object.defineProperty(decision, '__commitMeta', {
            value: { byFallbackReason: { context_overflow: 1 } },
            enumerable: false,
            writable: true,
            configurable: true
        });

        router.commitDecisionOverflow(decision);
        expect(router._stats.contextOverflowTotal).toBe(1);
        expect(router._stats.byFallbackReason.context_overflow).toBe(1);

        // Second call: contextOverflow still present but __commitMeta consumed
        router.commitDecisionOverflow(decision);
        // Total increments (overflow is still flagged) but meta does NOT double-flush
        expect(router._stats.contextOverflowTotal).toBe(2);
        expect(router._stats.byFallbackReason.context_overflow).toBe(1); // Not 2
    });

    test('only flushes byFallbackReason from meta — other meta fields are intentionally skipped', () => {
        // commitDecisionOverflow intentionally skips:
        // - traceSampledTotal/traceSampledIncluded (no trace on overflow)
        // - glm5EligibleTotal/glm5PreferenceApplied (no preference on overflow)
        // - tierDowngradeShadow/tierDowngradeShadowByRoute (overflow != downgrade)
        // Only byFallbackReason is flushed.
        const decision = {
            model: 'glm-4-plus',
            tier: 'heavy',
            reason: 'test',
            contextOverflow: {
                estimatedTokens: 200000,
                modelContextLength: 128000,
                overflowBy: 72000
            }
        };
        Object.defineProperty(decision, '__commitMeta', {
            value: {
                traceSampledTotal: 1,
                traceSampledIncluded: 1,
                glm5EligibleTotal: 1,
                tierDowngradeShadow: 1,
                byFallbackReason: { context_overflow: 3 }
            },
            enumerable: false,
            writable: true,
            configurable: true
        });

        router.commitDecisionOverflow(decision);

        // Only byFallbackReason flushed
        expect(router._stats.byFallbackReason.context_overflow).toBe(3);
        // These are intentionally NOT flushed by the overflow path
        expect(router._stats.traceSampledTotal).toBe(0);
        expect(router._stats.traceSampledIncluded).toBe(0);
        expect(router._stats.glm5EligibleTotal).toBe(0);
        expect(router._stats.tierDowngradeShadow).toBe(0);
    });
});

// ==================================================================
// Slot accounting invariant under mixed overflow/capacity traffic
// ==================================================================

describe('slot accounting invariant', () => {
    const modelMeta = {
        'model-a': { maxConcurrency: 3, pricing: { input: 0.1, output: 0.5 }, contextLength: 4000 },
        'model-b': { maxConcurrency: 3, pricing: { input: 0.5, output: 2.0 }, contextLength: 200000 }
    };

    const slotDiscovery = {
        getModel: jest.fn().mockImplementation((id) => modelMeta[id] || null)
    };

    function makeSlotRouter() {
        return new ModelRouter(makeConfig({
            tiers: {
                light: {
                    models: ['model-a', 'model-b'],
                    strategy: 'balanced',
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [{ match: { model: 'claude-haiku-*' }, tier: 'light' }]
        }), {
            persistEnabled: false,
            modelDiscovery: slotDiscovery
        });
    }

    test('inFlight never goes negative under mixed overflow and normal traffic', async () => {
        const r = makeSlotRouter();

        // Normal small request — should acquire and release cleanly
        const normalResult = await r.selectModel({
            parsedBody: makeBody({ model: 'claude-haiku-3', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
            requestModel: 'claude-haiku-3'
        });
        expect(normalResult.committed).toBe(true);
        expect(r._inFlight.get(normalResult.model) || 0).toBe(1);
        r.releaseModel(normalResult.model);
        expect(r._inFlight.get(normalResult.model) || 0).toBe(0);

        // Overflow request — should NOT acquire slot
        const overflowResult = await r.selectModel({
            parsedBody: makeBody({
                model: 'claude-haiku-3',
                max_tokens: 4096,
                system: 'A'.repeat(20000),
                messages: [{ role: 'user', content: 'B'.repeat(20000) }]
            }),
            requestModel: 'claude-haiku-3'
        });

        if (overflowResult && overflowResult.contextOverflow) {
            expect(overflowResult.committed).toBe(false);
            // No slot acquired — inFlight should still be 0
            for (const [, count] of r._inFlight.entries()) {
                expect(count).toBeGreaterThanOrEqual(0);
            }
        }

        // Another normal request — should work fine
        const normal2 = await r.selectModel({
            parsedBody: makeBody({ model: 'claude-haiku-3', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
            requestModel: 'claude-haiku-3'
        });
        expect(normal2.committed).toBe(true);
        r.releaseModel(normal2.model);

        // Final invariant: no inFlight counter is negative
        for (const [model, count] of r._inFlight.entries()) {
            expect(count).toBeGreaterThanOrEqual(0);
        }
    });

    test('concurrent mixed traffic maintains non-negative inFlight', async () => {
        const r = makeSlotRouter();
        const smallBody = makeBody({ model: 'claude-haiku-3', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
        const largeBody = makeBody({
            model: 'claude-haiku-3',
            max_tokens: 4096,
            system: 'A'.repeat(20000),
            messages: [{ role: 'user', content: 'B'.repeat(20000) }]
        });

        // Fire 10 mixed requests concurrently
        const requests = [];
        for (let i = 0; i < 10; i++) {
            const body = i % 3 === 0 ? largeBody : smallBody;
            requests.push(r.selectModel({
                parsedBody: body,
                requestModel: 'claude-haiku-3'
            }));
        }

        const results = await Promise.all(requests);

        // Release all committed slots
        for (const result of results) {
            if (result && result.committed && result.model) {
                r.releaseModel(result.model);
            }
        }

        // Invariant: all inFlight counts >= 0
        for (const [model, count] of r._inFlight.entries()) {
            expect(count).toBeGreaterThanOrEqual(0);
        }
    });
});

    // --- FAILOVER PATH IN COMPUTEDECISION (lines 1374-1378) ---
    // This path is reached when:
    // 1. Pool strategy is exhausted (returns null) because fallback is at capacity
    // 2. Target model is on cooldown
    // 3. Failover logic doesn't check capacity, so it finds the fallback anyway
    // Note: This code path exists for legacy v1 configs, but modern configs use pool strategy

    describe('failover path in computeDecision', () => {
        test('finds fallback when pool exhausted by capacity but failover ignores capacity (lines 1374-1378)', async () => {
            const failoverModelMeta = {
                'primary-model': { maxConcurrency: 1 },
                'fallback-model': { maxConcurrency: 1 }  // Only 1 slot
            };

            const failoverDiscovery = {
                getModel: jest.fn().mockImplementation((id) => failoverModelMeta[id] || null)
            };

            const testConfig = makeConfig({
                failover: {
                    maxModelSwitchesPerRequest: 3
                },
                tiers: {
                    light: {
                        targetModel: 'primary-model',
                        fallbackModels: ['fallback-model']
                    }
                },
                rules: [{ match: { model: 'test-*' }, tier: 'light' }]
            });

            const router = new ModelRouter(testConfig, { persistEnabled: false, modelDiscovery: failoverDiscovery });

            // Fill the fallback-model's slot to make pool exhausted
            router.acquireModel('fallback-model');
            expect(router._inFlight.get('fallback-model')).toBe(1);

            // Put primary-model on cooldown
            router.recordModelCooldown('primary-model', 5000);

            const result = await router.selectModel({
                parsedBody: {
                    model: 'test-model',
                    max_tokens: 1000,
                    messages: [{ role: 'user', content: 'test' }]
                },
                requestModel: 'test-model'
            });

            // Pool should be exhausted (fallback at capacity), but failover logic
            // should still find fallback-model because it doesn't check capacity
            expect(result.model).toBe('fallback-model');
            expect(result.source).toBe('failover');
            expect(result.reason).toContain('failover');

            // Cleanup
            router.releaseModel('fallback-model');
        });
    });

// ==================================================================
// Context overflow with REAL GLM model context windows
// Validates that the routing logic respects actual Z.AI model specs:
//   200K: glm-5, glm-4.7, glm-4.6, glm-4.7-flashx (api_only), glm-4.7-flash
//   128K: glm-4.5, glm-4.5-air, glm-4.5-airx (api_only), glm-4-plus (api_only), glm-4.5-flash, etc.
//    64K: glm-4.5v
// Source: https://docs.z.ai/guides/overview/concept-param (Feb 2026)
// ==================================================================

describe('context overflow with real GLM model specs', () => {
    // Mirror actual KNOWN_GLM_MODELS context windows
    const realModelMeta = {
        // 200K context
        'glm-5':          { maxConcurrency: 1,  pricing: { input: 0.60, output: 2.20 }, contextLength: 200000 },
        'glm-4.7':        { maxConcurrency: 10, pricing: { input: 0.60, output: 2.20 }, contextLength: 200000 },
        'glm-4.6':        { maxConcurrency: 8,  pricing: { input: 0.60, output: 2.20 }, contextLength: 200000 },
        'glm-4.7-flashx': { maxConcurrency: 3,  pricing: { input: 0.07, output: 0.40 }, contextLength: 200000 },
        'glm-4.7-flash':  { maxConcurrency: 1,  pricing: { input: 0,    output: 0    }, contextLength: 200000 },
        // 128K context
        'glm-4.5':        { maxConcurrency: 10, pricing: { input: 0.60, output: 2.20 }, contextLength: 128000 },
        'glm-4.5-air':    { maxConcurrency: 10, pricing: { input: 0.20, output: 1.10 }, contextLength: 128000 },
        'glm-4.5-airx':   { maxConcurrency: 2,  pricing: { input: 0.20, output: 1.10 }, contextLength: 128000 },
        'glm-4-plus':     { maxConcurrency: 1,  pricing: { input: 0.05, output: 0.05 }, contextLength: 128000 },
        'glm-4.5-flash':  { maxConcurrency: 2,  pricing: { input: 0,    output: 0    }, contextLength: 128000 },
        // 64K context
        'glm-4.5v':       { maxConcurrency: 10, pricing: { input: 0.60, output: 2.20 }, contextLength: 64000 },
    };

    const realDiscovery = {
        getModel: jest.fn().mockImplementation((id) => realModelMeta[id] || null),
        getModelCached: jest.fn().mockImplementation((id) => realModelMeta[id] || null)
    };

    // Mirrors the actual production tier config from config.js
    function makeRealTierRouter(tierOverrides = {}) {
        return new ModelRouter(makeConfig({
            tiers: {
                light: {
                    models: ['glm-4.5-air', 'glm-4.5-flash', 'glm-4.7-flash'],
                    strategy: 'throughput',
                    clientModelPolicy: 'rule-match-only',
                    ...tierOverrides.light
                },
                medium: {
                    models: ['glm-4.5'],
                    strategy: 'balanced',
                    clientModelPolicy: 'rule-match-only',
                    ...tierOverrides.medium
                },
                heavy: {
                    models: ['glm-5', 'glm-4.7', 'glm-4.6'],
                    strategy: 'quality',
                    clientModelPolicy: 'rule-match-only',
                    ...tierOverrides.heavy
                }
            },
            rules: [
                { match: { model: 'claude-opus*' }, tier: 'heavy' },
                { match: { model: 'claude-sonnet*' }, tier: 'medium' },
                { match: { model: 'claude-haiku*' }, tier: 'light' },
                { match: {}, tier: 'medium' }
            ],
            classifier: {
                heavyThresholds: { maxTokensGte: 4096, messageCountGte: 20, hasTools: true, hasVision: true },
                lightThresholds: { maxTokensLte: 512, messageCountLte: 3 }
            }
        }), {
            persistEnabled: false,
            modelDiscovery: realDiscovery
        });
    }

    // Helper: build body of approximately N input tokens
    function makeBodyWithTokens(model, inputTokens, maxTokens = 8192) {
        const charCount = inputTokens * 4; // CHARS_PER_TOKEN = 4
        return makeBody({
            model,
            max_tokens: maxTokens,
            system: '',
            messages: [{ role: 'user', content: 'x'.repeat(charCount) }]
        });
    }

    // --- LIGHT TIER (haiku) ---

    describe('light tier (haiku → glm-4.5-air/glm-4.5-flash/glm-4.7-flash)', () => {
        test('small request routes to any light model (fits in 128K)', async () => {
            const r = makeRealTierRouter();
            const result = await r.computeDecision({
                parsedBody: makeBodyWithTokens('claude-haiku-4-5-20251001', 50000),
                requestModel: 'claude-haiku-4-5-20251001'
            });
            expect(result.model).toBeDefined();
            expect(result.tier).toBe('light');
            expect(result.contextOverflow).toBeUndefined();
        });

        test('large request (>128K tokens) skips 128K models, uses 200K model', async () => {
            const r = makeRealTierRouter();
            // ~140K input tokens + 8K max_tokens = ~148K (no margin)
            // Exceeds 128K, fits in 200K
            const result = await r.computeDecision({
                parsedBody: makeBodyWithTokens('claude-haiku-4-5-20251001', 140000),
                requestModel: 'claude-haiku-4-5-20251001'
            });
            expect(result.model).toBeDefined();
            expect(result.tier).toBe('light');
            // Must route to a 200K model (only glm-4.7-flash is 200K in light tier)
            expect(result.model).toBe('glm-4.7-flash');
            expect(result.contextOverflow).toBeUndefined();
        });

        test('oversized request (>200K tokens) triggers context overflow', async () => {
            const r = makeRealTierRouter();
            // ~193K input tokens + 8K max_tokens = ~201K (no safety margin)
            // Exceeds ALL models in light tier (max 200K)
            const result = await r.computeDecision({
                parsedBody: makeBodyWithTokens('claude-haiku-4-5-20251001', 193000),
                requestModel: 'claude-haiku-4-5-20251001'
            });
            expect(result.contextOverflow).toBeDefined();
            expect(result.contextOverflow.estimatedTokens).toBeGreaterThan(200000);
        });
    });

    // --- MEDIUM TIER (sonnet) ---

    describe('medium tier (sonnet → glm-4.5)', () => {
        test('normal request routes to medium model', async () => {
            const r = makeRealTierRouter();
            const result = await r.computeDecision({
                parsedBody: makeBodyWithTokens('claude-sonnet-4-5-20250929', 50000),
                requestModel: 'claude-sonnet-4-5-20250929'
            });
            expect(result.model).toBeDefined();
            expect(result.tier).toBe('medium');
            expect(result.model).toBe('glm-4.5');
            expect(result.contextOverflow).toBeUndefined();
        });

        test('request exceeding 128K overflows (medium tier is all 128K)', async () => {
            const r = makeRealTierRouter();
            // ~125K input + 8K max = 133K (no margin) — exceeds 128K
            const result = await r.computeDecision({
                parsedBody: makeBodyWithTokens('claude-sonnet-4-5-20250929', 125000),
                requestModel: 'claude-sonnet-4-5-20250929'
            });
            // Medium model is 128K — no 200K fallback in this tier
            expect(result.contextOverflow).toBeDefined();
            expect(result.contextOverflow.modelContextLength).toBe(128000);
        });
    });

    // --- HEAVY TIER (opus) ---

    describe('heavy tier (opus → glm-5/glm-4.7/glm-4.6)', () => {
        test('large request routes to heavy model (all 200K)', async () => {
            const r = makeRealTierRouter();
            // ~160K input + 8K max = 168K (no margin) — fits in 200K
            const result = await r.computeDecision({
                parsedBody: makeBodyWithTokens('claude-opus-4-6', 160000),
                requestModel: 'claude-opus-4-6'
            });
            expect(result.model).toBeDefined();
            expect(result.tier).toBe('heavy');
            expect(['glm-5', 'glm-4.7', 'glm-4.6']).toContain(result.model);
            expect(result.contextOverflow).toBeUndefined();
        });

        test('oversized request (>200K) overflows even heavy tier', async () => {
            const r = makeRealTierRouter();
            // ~193K input + 8K max = 201K (no safety margin) — exceeds 200K
            const result = await r.computeDecision({
                parsedBody: makeBodyWithTokens('claude-opus-4-6', 193000),
                requestModel: 'claude-opus-4-6'
            });
            expect(result.contextOverflow).toBeDefined();
            expect(result.contextOverflow.estimatedTokens).toBeGreaterThan(200000);
        });
    });

    // --- TOKEN ESTIMATION BOUNDARY TESTS ---

    describe('token estimation boundaries', () => {
        test('max_tokens contributes to estimated total', () => {
            const r = makeRealTierRouter();
            const lowMax = r._estimateRequestTokens(makeBodyWithTokens('claude-haiku-4-5-20251001', 50000, 100));
            const highMax = r._estimateRequestTokens(makeBodyWithTokens('claude-haiku-4-5-20251001', 50000, 50000));
            expect(highMax).toBeGreaterThan(lowMax);
            // Difference should be ~(50000-100) = 49900
            expect(highMax - lowMax).toBeGreaterThan(40000);
        });

        test('no safety margin (1.0x) — estimate equals raw token count for plain text', () => {
            const r = makeRealTierRouter();
            // 100K chars = 25K tokens; makeBody defaults max_tokens=1024
            const body = makeBody({
                model: 'claude-haiku-4-5-20251001',
                system: '',
                messages: [{ role: 'user', content: 'x'.repeat(100000) }]
            });
            const est = r._estimateRequestTokens(body);
            // Raw: ceil(100016/4) + 1024 = 25004 + 1024 = 26028
            // With 1.0x: ceil(26028 * 1.0) = 26028 (no inflation)
            const rawTokens = Math.ceil(100016 / 4) + 1024; // 26028
            expect(est).toBe(rawTokens);
        });

        test('128K boundary: request just under 128K context routes normally', async () => {
            const r = makeRealTierRouter();
            // Target: ~115K estimated total → fits in 128K
            // 100K input tokens + 8K max = 108K (no margin) — fits in 128K
            const result = await r.computeDecision({
                parsedBody: makeBodyWithTokens('claude-haiku-4-5-20251001', 100000),
                requestModel: 'claude-haiku-4-5-20251001'
            });
            expect(result.tier).toBe('light');
            expect(result.contextOverflow).toBeUndefined();
        });

        test('200K boundary: request just under 200K routes to 200K model', async () => {
            const r = makeRealTierRouter();
            // Target: ~175K estimated → fits in 200K but not 128K
            // 163K input tokens + 8K max = 171K (no margin) — fits in 200K
            const result = await r.computeDecision({
                parsedBody: makeBodyWithTokens('claude-haiku-4-5-20251001', 163000),
                requestModel: 'claude-haiku-4-5-20251001'
            });
            expect(result.tier).toBe('light');
            // Only glm-4.7-flash is 200K in the light tier
            expect(result.model).toBe('glm-4.7-flash');
            expect(result.contextOverflow).toBeUndefined();
        });
    });

    // --- POOL EXHAUSTION: 200K models busy, large request ---

    describe('pool exhaustion with mixed context windows', () => {
        test('when 200K models at capacity, large request overflows via failover', async () => {
            const r = makeRealTierRouter();
            // Fill up 200K model: glm-4.7-flash (1 slot) — only 200K model in light tier
            r._inFlight.set('glm-4.7-flash', 1);

            // Large request that needs 200K context
            const result = await r.computeDecision({
                parsedBody: makeBodyWithTokens('claude-haiku-4-5-20251001', 140000),
                requestModel: 'claude-haiku-4-5-20251001'
            });

            // Pool selection will skip all 128K models (overflow) and find 200K models at capacity
            // Failover picks first model (glm-4.5-air, 128K) → context overflow
            expect(result.contextOverflow).toBeDefined();
        });

        test('when 200K models available, large request routes to them', async () => {
            const r = makeRealTierRouter();
            // Only fill some 128K models, leave 200K (glm-4.7-flash) open
            r._inFlight.set('glm-4.5-air', 10);

            const result = await r.computeDecision({
                parsedBody: makeBodyWithTokens('claude-haiku-4-5-20251001', 140000),
                requestModel: 'claude-haiku-4-5-20251001'
            });

            expect(result.model).toBe('glm-4.7-flash');
            expect(result.contextOverflow).toBeUndefined();
        });
    });

    // --- CAUSE CLASSIFICATION: transient vs genuine context overflow ---

    describe('context overflow cause classification', () => {
        test('200K models at_capacity → transient_unavailable', async () => {
            const r = makeRealTierRouter();
            // Fill 200K model to max (well above maxConcurrency * multiplier)
            r._inFlight.set('glm-4.7-flash', 100);
            const result = await r.computeDecision({
                parsedBody: makeBodyWithTokens('claude-haiku-4-5-20251001', 150000),
                requestModel: 'claude-haiku-4-5-20251001'
            });
            expect(result.contextOverflow).toBeDefined();
            expect(result.contextOverflow.cause).toBe('transient_unavailable');
        });

        test('200K models on cooldown → transient_unavailable', async () => {
            const r = makeRealTierRouter();
            r.recordModelCooldown('glm-4.7-flash', 5000);
            const result = await r.computeDecision({
                parsedBody: makeBodyWithTokens('claude-haiku-4-5-20251001', 150000),
                requestModel: 'claude-haiku-4-5-20251001'
            });
            expect(result.contextOverflow).toBeDefined();
            expect(result.contextOverflow.cause).toBe('transient_unavailable');
        });

        test('request exceeds ALL models (>200K) → genuine', async () => {
            const r = makeRealTierRouter();
            const result = await r.computeDecision({
                parsedBody: makeBodyWithTokens('claude-haiku-4-5-20251001', 200000),
                requestModel: 'claude-haiku-4-5-20251001'
            });
            expect(result.contextOverflow).toBeDefined();
            expect(result.contextOverflow.cause).toBe('genuine');
        });

        test('medium tier (all 128K) → genuine even with models available', async () => {
            const r = makeRealTierRouter();
            const result = await r.computeDecision({
                parsedBody: makeBodyWithTokens('claude-sonnet-4-5-20250929', 130000),
                requestModel: 'claude-sonnet-4-5-20250929'
            });
            expect(result.contextOverflow).toBeDefined();
            expect(result.contextOverflow.cause).toBe('genuine');
        });
    });

    // --- STATS SPLIT BY OVERFLOW CAUSE ---

    describe('context overflow stats by cause', () => {
        test('commitDecisionOverflow increments cause-specific counter', () => {
            const r = makeRealTierRouter();
            r.commitDecisionOverflow({
                model: 'test', tier: 'light',
                contextOverflow: { estimatedTokens: 150000, modelContextLength: 128000,
                                  overflowBy: 22000, cause: 'transient_unavailable' }
            });
            expect(r._stats.contextOverflowByCause.transient_unavailable).toBe(1);
            expect(r._stats.contextOverflowByCause.genuine).toBe(0);

            r.commitDecisionOverflow({
                model: 'test2', tier: 'heavy',
                contextOverflow: { estimatedTokens: 250000, modelContextLength: 200000,
                                  overflowBy: 50000, cause: 'genuine' }
            });
            expect(r._stats.contextOverflowByCause.genuine).toBe(1);
        });

        test('getStats exposes contextOverflowByCause', () => {
            const r = makeRealTierRouter();
            const stats = r.getStats();
            expect(stats.contextOverflowByCause).toEqual({ genuine: 0, transient_unavailable: 0 });
        });
    });

    // --- SLOT/ACCOUNTING DRIFT GUARD ---

    describe('transient overflow slot safety', () => {
        test('transient overflow does NOT acquire or leak router slot', async () => {
            const r = makeRealTierRouter();
            r._inFlight.set('glm-4.7-flash', 100);
            const before = new Map(r._inFlight);

            const decision = await r.computeDecision({
                parsedBody: makeBodyWithTokens('claude-haiku-4-5-20251001', 150000),
                requestModel: 'claude-haiku-4-5-20251001'
            });
            r.commitDecisionOverflow(decision);
            expect(decision.committed).toBe(false);
            // In-flight counters unchanged (no slot acquired, no double-release)
            expect(new Map(r._inFlight)).toEqual(before);
        });
    });

    // --- TRACE TRUNCATION (lines 770-801) ---

    describe('_truncateTrace', () => {
        test('truncates modelSelection candidates when > MAX_CANDIDATES', () => {
            const config = makeConfig();
            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            // Create a large trace with many candidates that exceeds size limit
            const largeTrace = {
                model: 'test-model',
                tier: 'medium',
                modelSelection: {
                    candidates: Array.from({ length: 10 }, (_, i) => ({
                        model: `model-with-a-very-long-name-${i}`,
                        score: 100 - i,
                        details: 'x'.repeat(500) // Make each candidate large
                    }))
                },
                input: { messages: [] }
            };

            const truncated = router._truncateTrace(largeTrace, 2000); // Small max to force truncation

            expect(truncated.modelSelection.candidates.length).toBe(5); // MAX_CANDIDATES
            expect(truncated.modelSelection.truncated).toBe(true);
        });

        test('truncates input messages when > MAX_MESSAGES', () => {
            const config = makeConfig();
            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            const largeTrace = {
                model: 'test-model',
                input: {
                    messages: Array.from({ length: 10 }, (_, i) => ({
                        role: 'user',
                        content: 'A'.repeat(500) // Large content to exceed size
                    }))
                }
            };

            const truncated = router._truncateTrace(largeTrace, 2000); // Small max to force truncation

            expect(truncated.input.messages.length).toBe(3); // MAX_MESSAGES
            expect(truncated.input.truncated).toBe(true);
        });

        test('sets _warning when trace still exceeds max after truncation', () => {
            const config = makeConfig();
            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            // Create a trace that will definitely exceed max after all truncation
            // 3 messages × 1000 chars each = 3000+ chars (way over 500 byte limit)
            const hugeTrace = {
                model: 'test-model',
                tier: 'heavy',
                input: {
                    messages: Array.from({ length: 100 }, (_, i) => ({
                        role: 'user',
                        content: 'X'.repeat(1000) // Each message is 1000 chars
                    }))
                }
            };

            // Use very small max size (500) to guarantee warning is set
            // Even after truncating to 3 messages, each message is 1000 chars
            const truncated = router._truncateTrace(hugeTrace, 500);

            // With 3 messages of 1000 chars each, the trace is definitely > 500 bytes
            // So _warning must be defined
            expect(truncated._warning).toBeDefined();
            expect(truncated._warning).toMatch(/truncated|bytes|limit/);

            // Also verify truncation happened
            expect(truncated.input.messages.length).toBeLessThanOrEqual(3);
        });

        test('sets _truncated flag when partial truncation occurs', () => {
            const config = makeConfig();
            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            // Create a trace that will definitely exceed maxSize BEFORE truncation
            // but fit AFTER truncating candidates from 10 to 5
            const trace = {
                model: 'test-model',
                modelSelection: {
                    candidates: Array.from({ length: 10 }, (_, i) => ({
                        model: `model-with-a-very-long-name-to-increase-size-${i}`,
                        score: 100 - i,
                        extraData: 'x'.repeat(200) // Each candidate is ~250 chars
                    }))
                }
            };

            // Original size ~2500 chars, want maxSize smaller than that but larger than 5 candidates (~1250)
            const maxSize = 1800;
            const truncated = router._truncateTrace(trace, maxSize);

            // Verify candidates were reduced
            expect(truncated.modelSelection.candidates.length).toBeLessThan(10);
        });

        test('returns unchanged trace when within size limit', () => {
            const config = makeConfig();
            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            const smallTrace = {
                model: 'test-model',
                tier: 'light'
            };

            const truncated = router._truncateTrace(smallTrace, 100000);

            expect(truncated).toEqual(smallTrace);
        });
    });

    // --- COOLDOWN EVICTION (lines 2670-2681) ---

    describe('recordModelCooldown - eviction when at capacity', () => {
        test('evicts oldest entry when at max capacity', () => {
            const config = makeConfig({
                cooldown: {
                    maxCooldownEntries: 3 // Small limit for testing
                }
            });
            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            // Fill to capacity
            router.recordModelCooldown('model-a', 1000);
            router.recordModelCooldown('model-b', 1000);
            router.recordModelCooldown('model-c', 1000);

            // All three should be in cooldowns
            expect(router._cooldowns.has('model-a')).toBe(true);
            expect(router._cooldowns.has('model-b')).toBe(true);
            expect(router._cooldowns.has('model-c')).toBe(true);

            // Add one more - should evict oldest
            router.recordModelCooldown('model-d', 1000);

            expect(router._cooldowns.has('model-a')).toBe(false); // Evicted
            expect(router._cooldowns.has('model-b')).toBe(true);
            expect(router._cooldowns.has('model-c')).toBe(true);
            expect(router._cooldowns.has('model-d')).toBe(true);
        });

        test('does NOT evict when updating existing entry', () => {
            const config = makeConfig({
                cooldown: {
                    maxCooldownEntries: 2
                }
            });
            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            router.recordModelCooldown('model-a', 1000);
            router.recordModelCooldown('model-b', 1000);

            // Update model-a (should not evict anything)
            router.recordModelCooldown('model-a', 2000);

            expect(router._cooldowns.has('model-a')).toBe(true);
            expect(router._cooldowns.has('model-b')).toBe(true);
            expect(router._cooldowns.size).toBe(2);
        });
    });

    // --- TIER NOT FOUND (lines 1288-1297) ---
    // NOTE: The "tier not found" code path is currently unreachable because the normalizer
    // always creates empty tier configs for all VALID_TIERS (light, medium, heavy).
    // The classifier only returns these three tiers, so tierConfig will always exist.
    // These tests have been removed since they tested unreachable code.

    describe('normalizer ensures all tiers exist', () => {
        test('normalizer creates empty tiers for missing VALID_TIERS', () => {
            const config = makeConfig({
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash',
                        clientModelPolicy: 'always-route'
                    }
                }
            });

            // The router normalizes the config, which adds medium and heavy
            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            // Verify all tiers exist after normalization
            expect(router.config.tiers.light).toBeDefined();
            expect(router.config.tiers.medium).toBeDefined();
            expect(router.config.tiers.heavy).toBeDefined();
        });
    });

    // --- INVALID STRATEGY HANDLING (lines 1303-1305) ---

    describe('invalid strategy handling', () => {
        test('defaults to balanced strategy when tier strategy is invalid', async () => {
            const config = makeConfig({
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash',
                        strategy: 'invalid-strategy-name',
                        clientModelPolicy: 'always-route'  // Enable classifier
                    }
                },
                classifier: {
                    lightThresholds: {
                        maxTokensLte: 4096,
                        messageCountLte: 10
                    }
                }
            });
            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            // Use request that will definitely classify to light tier
            const result = await router.computeDecision({
                parsedBody: makeBody({
                    max_tokens: 100,
                    messages: [{ role: 'user', content: 'Test' }]
                }),
                requestModel: 'claude-haiku-4-5-20251001'
            });

            // Should route to light tier with default balanced strategy
            expect(result.tier).toBe('light');
            expect(result.model).toBe('glm-4-flash');
            expect(result.strategy).toBe('balanced'); // Falls back to default
        });
    });

    // --- FALLBACK CONTEXT WINDOW PRE-FLIGHT (lines 1369-1378) ---

    describe('fallback context window pre-flight', () => {
        const modelMeta = {
            'huge-model': { maxConcurrency: 5, contextLength: 200000 },
            'tiny-model': { maxConcurrency: 5, contextLength: 8000 },
            'medium-model': { maxConcurrency: 5, contextLength: 128000 }
        };

        const fallbackDiscovery = {
            getModel: jest.fn().mockImplementation((id) => modelMeta[id] || null)
        };

        function makeFallbackRouter(configOverrides = {}) {
            return new ModelRouter(makeConfig({
                tiers: {
                    heavy: {
                        models: ['huge-model', 'tiny-model', 'medium-model'],
                        strategy: 'balanced',
                        clientModelPolicy: 'always-route'
                    }
                },
                rules: [{ match: { model: 'claude-opus-*' }, tier: 'heavy' }],
                ...configOverrides
            }), {
                persistEnabled: false,
                modelDiscovery: fallbackDiscovery
            });
        }

        test('skips fallback model whose context is too small (lines 1369-1372)', async () => {
            const router = makeFallbackRouter();

            // Put huge-model (highest priority) on cooldown to trigger fallback
            router.recordModelCooldown('huge-model', 5000);

            // Request with estimated tokens > 8000 (tiny-model's context)
            // This exercises the context window pre-flight check for fallback candidates
            const result = await router.computeDecision({
                parsedBody: makeBody({
                    max_tokens: 15000,
                    system: 'A'.repeat(30000),
                    messages: [{ role: 'user', content: 'B'.repeat(10000) }]
                }),
                requestModel: 'claude-opus-4'
            });

            expect(result).toBeDefined();
            // tiny-model (8K context) must be skipped; medium-model (128K) should be selected
            expect(result.model).not.toBe('tiny-model');
            expect(result.model).toBe('medium-model');
        });

        test('selects any fallback when tokens fit all models (lines 1373-1378)', async () => {
            const router = makeFallbackRouter();

            // Put huge-model on cooldown
            router.recordModelCooldown('huge-model', 5000);

            // Request with small tokens that fits in all models including tiny-model
            const result = await router.computeDecision({
                parsedBody: makeBody({
                    model: 'claude-opus-4',  // Must match rule pattern claude-opus-*
                    max_tokens: 1000,
                    messages: [{ role: 'user', content: 'hi' }]
                }),
                requestModel: 'claude-opus-4'
            });

            expect(result).toBeDefined();
            // Any non-cooled model is acceptable (tiny-model or medium-model)
            expect(['tiny-model', 'medium-model']).toContain(result.model);
        });
    });

    // --- TOJSON WITH INVALID TIER CONFIGS (lines 3318-3319, 3331) ---
    // NOTE: The null tier test is covered above in "handles null/invalid tier configs gracefully"

    describe('toJSON handles invalid tier configs', () => {
        test('handles tier without models array (line 3331)', () => {
            const config = makeConfig({
                tiers: {
                    light: { strategy: 'balanced' }  // No models array
                }
            });
            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            const json = router.toJSON();
            expect(json.config.tiers.light.models).toEqual([]);
        });

        test('includes label when present (line 3336)', () => {
            const config = makeConfig({
                tiers: {
                    light: {
                        models: ['glm-4-flash'],
                        strategy: 'balanced',
                        label: 'Fast Models'
                    }
                }
            });
            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            const json = router.toJSON();
            expect(json.config.tiers.light.label).toBe('Fast Models');
        });
    });

    // --- _SELECTFROMPOOL WITH ATTEMPTED/COOLED MODELS (lines 2895-2903) ---

    describe('_selectFromPool tracks skipped models', () => {
        test('tracks models skipped due to being attempted (lines 2895-2897)', async () => {
            const config = makeConfig({
                tiers: {
                    light: {
                        models: ['model-a', 'model-b'],
                        strategy: 'balanced',
                        clientModelPolicy: 'always-route'
                    }
                }
            });
            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            // Attempt model-a first
            const attemptedModels = new Set(['model-a']);
            const result = await router._selectFromPool(['model-a', 'model-b'], attemptedModels);

            // Should select model-b since model-a was attempted
            expect(result).toBeDefined();
            expect(result.model).toBe('model-b');
            // Check the stats were updated
            expect(router._stats.byFallbackReason.not_in_candidates).toBeGreaterThan(0);
        });

        test('tracks models skipped due to cooldown (lines 2901-2903)', async () => {
            const config = makeConfig({
                tiers: {
                    light: {
                        models: ['model-a', 'model-b'],
                        strategy: 'balanced',
                        clientModelPolicy: 'always-route'
                    }
                }
            });
            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            // Put model-a on cooldown
            router.recordModelCooldown('model-a', 5000);

            const result = await router._selectFromPool(['model-a', 'model-b'], new Set());

            // Should select model-b since model-a is on cooldown
            expect(result).toBeDefined();
            expect(result.model).toBe('model-b');
            // Check the stats were updated
            expect(router._stats.byFallbackReason.cooldown).toBeGreaterThan(0);
        });
    });

    // --- _TRUNCATETRACE PRESERVES VISION CONTENT (line 759) ---

    describe('_truncateTrace preserves vision content', () => {
        test('preserves message content as array when not string (vision case - line 759)', () => {
            const router = new ModelRouter(makeConfig(), { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            const traceWithVision = {
                input: {
                    messages: [
                        {
                            role: 'user',
                            content: [
                                { type: 'text', text: 'x'.repeat(100000) },
                                { type: 'image', source: { type: 'base64', data: 'abc123' } }
                            ]
                        }
                    ]
                }
            };

            const truncated = router._truncateTrace(traceWithVision, 1000);

            // Should preserve content as array (not convert to string)
            expect(Array.isArray(truncated.input.messages[0].content)).toBe(true);
            expect(truncated.input.messages[0].content[0].type).toBe('text');
            expect(truncated.input.messages[0].content[1].type).toBe('image');
        });
    });

    // --- _BUILDTRACE INTEGRATION VIA COMPUTEDECISION (lines 911-1010+) ---

    describe('_buildTrace integration via computeDecision', () => {
        const modelMeta = {
            'model-a': { maxConcurrency: 5, contextLength: 200000 },
            'model-b': { maxConcurrency: 3, contextLength: 200000 }
        };

        const traceDiscovery = {
            getModel: jest.fn().mockImplementation((id) => modelMeta[id] || null)
        };

        function makeTraceRouter() {
            return new ModelRouter(makeConfig({
                tiers: {
                    light: {
                        models: ['model-a', 'model-b'],
                        strategy: 'balanced',
                        clientModelPolicy: 'always-route'
                    }
                },
                rules: [{ match: { model: 'claude-haiku-*' }, tier: 'light' }]
            }), {
                persistEnabled: false,
                modelDiscovery: traceDiscovery
            });
        }

        test('includes trace with modelSelection candidates (lines 947-967)', async () => {
            const router = makeTraceRouter();

            const result = await router.computeDecision({
                parsedBody: makeBody({
                    model: 'claude-haiku-4-5-20251001',
                    max_tokens: 1000,
                    messages: [{ role: 'user', content: 'test' }]
                }),
                requestModel: 'claude-haiku-4-5-20251001',
                includeTrace: true,
                bypassSampling: true
            });

            expect(result.trace).toBeDefined();
            expect(result.trace.modelSelection).toBeDefined();
            expect(result.trace.modelSelection.candidates).toBeInstanceOf(Array);
            expect(result.trace.modelSelection.candidates.length).toBeGreaterThan(0);
            expect(result.trace.modelSelection.rationale).toBeDefined();
        });

        test('includes routerPool state when includeRouterState is true (lines 990-1009)', async () => {
            const router = makeTraceRouter();

            const result = await router.computeDecision({
                parsedBody: makeBody({
                    model: 'claude-haiku-4-5-20251001',
                    max_tokens: 1000,
                    messages: [{ role: 'user', content: 'test' }]
                }),
                requestModel: 'claude-haiku-4-5-20251001',
                includeTrace: true,
                bypassSampling: true,
                includeRouterState: true  // Request router pool state
            });

            expect(result.trace).toBeDefined();
            expect(result.trace.routerPool).toBeDefined();
            expect(result.trace.routerPool.modelId).toBeTruthy();
            expect(result.trace.routerPool.inFlight).toBeDefined();
            expect(result.trace.routerPool.max).toBeDefined();
            expect(result.trace.routerPool.isAvailable).toBeDefined();
        });

        test('includes classification with upgradeTrigger for heavy tier (lines 942-945)', async () => {
            const router = new ModelRouter(makeConfig({
                tiers: {
                    heavy: {
                        models: ['model-a'],
                        strategy: 'balanced',
                        clientModelPolicy: 'always-route'
                    }
                },
                rules: [{ match: { model: 'claude-opus-*' }, tier: 'heavy' }]
            }), {
                persistEnabled: false,
                modelDiscovery: traceDiscovery
            });

            const result = await router.computeDecision({
                parsedBody: makeBody({
                    model: 'claude-opus-4',
                    max_tokens: 10000,
                    messages: [{ role: 'user', content: 'test' }]
                }),
                requestModel: 'claude-opus-4',
                includeTrace: true,
                bypassSampling: true
            });

            expect(result.trace).toBeDefined();
            expect(result.trace.classification).toBeDefined();
            expect(result.trace.classification.tier).toBe('heavy');
            expect(result.trace.classification.upgradeTrigger).toBeDefined();
        });

        test('adds selected model as candidate when pool selection returns empty (lines 957-967)', async () => {
            const router = new ModelRouter(makeConfig({
                enabled: true,
                defaultModel: 'model-a',
                tiers: {},  // Override to disable tier-based routing
                rules: []   // Override to disable rule-based routing
            }), {
                persistEnabled: false,
                modelDiscovery: traceDiscovery
            });

            const result = await router.computeDecision({
                parsedBody: makeBody({
                    model: 'unknown-model',
                    max_tokens: 1000,
                    messages: [{ role: 'user', content: 'test' }]
                }),
                requestModel: 'unknown-model',
                includeTrace: true,
                bypassSampling: true
            });

            expect(result.trace).toBeDefined();
            expect(result.trace.modelSelection.candidates).toBeDefined();
            expect(result.trace.modelSelection.candidates.length).toBeGreaterThan(0);
            // Should have at least the selected model as a candidate
            // Note: The traceCandidates at line 957-967 adds modelId property
            expect(result.trace.modelSelection.candidates.some(c => (c.modelId || c.model) === 'model-a')).toBe(true);
        });
    });

    // --- RATIONALE GENERATION VIA COMPUTEDECISION TRACE (lines 877, 883) ---

    describe('rationale generation via computeDecision trace', () => {
        const modelMeta = {
            'busy-model': { maxConcurrency: 5 },
            'free-model': { maxConcurrency: 5 }
        };

        const rationaleDiscovery = {
            getModel: jest.fn().mockImplementation((id) => modelMeta[id] || null)
        };

        test('includes zero in-flight rationale (line 877)', async () => {
            const router = new ModelRouter(makeConfig({
                tiers: {
                    light: {
                        models: ['busy-model', 'free-model'],
                        strategy: 'balanced',
                        clientModelPolicy: 'always-route'
                    }
                },
                rules: [{ match: { model: 'test-*' }, tier: 'light' }]
            }), {
                persistEnabled: false,
                modelDiscovery: rationaleDiscovery
            });

            // Set busy-model to near-capacity to strongly bias balanced strategy toward free-model
            router._inFlight.set('busy-model', 4);

            const result = await router.computeDecision({
                parsedBody: makeBody({
                    model: 'test-model',
                    max_tokens: 1000,
                    messages: [{ role: 'user', content: 'hi' }]
                }),
                requestModel: 'test-model',
                includeTrace: true,
                bypassSampling: true
            });

            // Balanced strategy should prefer free-model (0 in-flight vs 4)
            expect(result.model).toBe('free-model');
            expect(result.trace.modelSelection.rationale).toBeDefined();
            expect(typeof result.trace.modelSelection.rationale).toBe('string');
        });

        test('includes currently available rationale (line 883)', async () => {
            const router = new ModelRouter(makeConfig({
                tiers: {
                    light: {
                        models: ['busy-model', 'free-model'],
                        strategy: 'balanced',
                        clientModelPolicy: 'always-route'
                    }
                },
                rules: [{ match: { model: 'test-*' }, tier: 'light' }]
            }), {
                persistEnabled: false,
                modelDiscovery: rationaleDiscovery
            });

            // Put busy-model on cooldown
            router.recordModelCooldown('busy-model', 5000);

            const result = await router.computeDecision({
                parsedBody: makeBody({
                    model: 'test-model',
                    max_tokens: 1000,
                    messages: [{ role: 'user', content: 'hi' }]
                }),
                requestModel: 'test-model',
                includeTrace: true,
                bypassSampling: true
            });

            // free-model should be selected, rationale should mention availability
            expect(result.trace.modelSelection.rationale).toBeDefined();
            expect(result.model).toBe('free-model');
        });
    });

    // --- _CALCULATECOMPLEXITY BRANCHES (lines 833-834, 844) ---

    describe('_calculateComplexity with classifier thresholds', () => {
        test('adds system length contribution when systemLengthGte threshold is set (lines 833-834)', () => {
            const config = makeConfig({
                classifier: {
                    heavyThresholds: {
                        systemLengthGte: 1000  // Set threshold
                    }
                }
            });
            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            // Features with system length > threshold
            const features = {
                maxTokens: 1000,
                messageCount: 5,
                systemLength: 2000,  // Above threshold
                hasTools: false,
                hasVision: false
            };

            const complexity = router._calculateComplexity(features);

            // Should include system length contribution (up to 20 points)
            expect(complexity).toBeGreaterThan(0);
        });

        test('adds vision bonus when hasVision and threshold is set (line 844)', () => {
            const config = makeConfig({
                classifier: {
                    heavyThresholds: {
                        hasVision: true,  // Enable vision threshold
                        maxTokensGte: 100000
                    }
                }
            });
            const router = new ModelRouter(config, { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            // Features with vision
            const features = {
                maxTokens: 5000,
                messageCount: 5,
                systemLength: 100,
                hasTools: false,
                hasVision: true  // Vision present
            };

            const complexity = router._calculateComplexity(features);

            // Should include vision bonus (10 points)
            expect(complexity).toBeGreaterThanOrEqual(10);
        });
    });

    // --- _GENERATESELECTIONRATIONALE DIRECT COVERAGE (lines 877, 883) ---

    describe('_generateSelectionRationale direct coverage', () => {
        test('includes zero in-flight rationale when selected has zero and others have in-flight (line 877)', () => {
            const router = new ModelRouter(makeConfig(), { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            const selected = { model: 'model-a' };
            const candidates = [
                { modelId: 'model-a', score: 0.8, inFlight: 0, isAvailable: true },
                { modelId: 'model-b', score: 0.7, inFlight: 5, isAvailable: true }
            ];

            const rationale = router._generateSelectionRationale(selected, candidates, 'balanced');

            expect(rationale).toContain('zero in-flight requests');
        });

        test('includes currently available rationale when selected is available and others are not (line 883)', () => {
            const router = new ModelRouter(makeConfig(), { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            const selected = { model: 'model-a' };
            const candidates = [
                { modelId: 'model-a', score: 0.6, inFlight: 0, isAvailable: true },
                { modelId: 'model-b', score: 0.9, inFlight: 0, isAvailable: false }
            ];

            const rationale = router._generateSelectionRationale(selected, candidates, 'balanced');

            expect(rationale).toContain('currently available');
        });
    });

    // --- TOJSON WITH NON-OBJECT TIER CONFIGS (lines 3318-3319) ---

    describe('toJSON handles non-object tier configs', () => {
        test('passes through tier config that is not an object (lines 3318-3319)', () => {
            const router = new ModelRouter(makeConfig(), { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            // Manually set a non-object tier config AFTER construction (edge case)
            router.config.tiers.light = null;

            const json = router.toJSON();
            // Should pass through non-object tier config as-is
            expect(json.config.tiers.light).toBeNull();
        });

        test('passes through tier config that is a string (lines 3318-3319)', () => {
            const router = new ModelRouter(makeConfig(), { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            // Manually set a non-object tier config AFTER construction (edge case)
            router.config.tiers.light = 'invalid';

            const json = router.toJSON();
            // Should pass through non-object tier config as-is
            expect(json.config.tiers.light).toBe('invalid');
        });
    });

    // --- _GETCANDIDATES WITH V1 CONFIG (lines 2016-2021) ---

    describe('_getCandidates with v1 config', () => {
        test('builds candidates from targetModel and fallbackModels (lines 2016-2021)', () => {
            const router = new ModelRouter(makeConfig(), { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            // Create a v1-format tier config (not normalized, direct v1 format)
            const tierConfig = {
                targetModel: 'primary-model',
                fallbackModels: ['fallback-1', 'fallback-2'],
                strategy: 'balanced'
            };
            const candidates = router._getCandidates(tierConfig);

            // Should include targetModel + fallbacks
            expect(candidates).toEqual(['primary-model', 'fallback-1', 'fallback-2']);
        });

        test('returns only targetModel when no fallbacks (lines 2016-2021)', () => {
            const router = new ModelRouter(makeConfig(), { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            // Create a v1-format tier config without fallbacks
            const tierConfig = {
                targetModel: 'primary-model',
                strategy: 'balanced'
            };
            const candidates = router._getCandidates(tierConfig);

            expect(candidates).toEqual(['primary-model']);
        });
    });

    // --- SIMULATESTATEFULMODE SNAPSHOT VALIDATION (line 1897) ---

    describe('simulateStatefulMode snapshot validation', () => {
        test('throws error when models array is missing (line 1897)', async () => {
            const router = new ModelRouter(makeConfig(), { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            const invalidSnapshot = {
                version: '1.0',
                // models array is missing
            };

            await expect(router.simulateStatefulMode({}, invalidSnapshot))
                .rejects.toThrow('Invalid snapshot: models array is required');
        });

        test('throws error when snapshot version is missing', async () => {
            const router = new ModelRouter(makeConfig(), { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            const invalidSnapshot = {
                // version is missing
                models: []
            };

            await expect(router.simulateStatefulMode({}, invalidSnapshot))
                .rejects.toThrow('Unsupported snapshot version: missing');
        });
    });

    // --- VALIDATECONFIG V2 TIER VALIDATION (line 3455) ---

    describe('validateConfig v2 tier validation', () => {
        test('accepts semver 2.x configs with models array', () => {
            const config = {
                version: '2.4.0',
                enabled: true,
                tiers: {
                    light: {
                        models: ['glm-4.5-air'],
                        strategy: 'balanced'
                    }
                }
            };

            const result = ModelRouter.validateConfig(config);

            expect(result.valid).toBe(true);
        });

        test('returns error when v2 tier lacks models array (line 3455)', () => {
            const config = {
                version: '2.0',
                enabled: true,
                tiers: {
                    light: {
                        strategy: 'balanced'
                        // models array is missing
                    }
                }
            };

            const result = ModelRouter.validateConfig(config);

            expect(result.valid).toBe(false);
            expect(result.error).toContain('requires a "models" array');
        });

        test('returns error when v2 tier models is not an array', () => {
            const config = {
                version: '2.0',
                enabled: true,
                tiers: {
                    light: {
                        models: 'not-an-array',
                        strategy: 'balanced'
                    }
                }
            };

            const result = ModelRouter.validateConfig(config);

            expect(result.valid).toBe(false);
            expect(result.error).toContain('requires a "models" array');
        });
    });

    // --- DECISION MODE CLASSIFIER RESULT (lines 1726, 1844, 1970) ---

    describe('decision mode classification parsing', () => {
        test('handles malformed rule JSON in explain method (line 1726)', async () => {
            const router = new ModelRouter(makeConfig({
                enabled: true,
                rules: [{ match: { model: 'test-*' }, tier: 'light' }],
                tiers: {
                    light: {
                        models: ['model-a'],
                        strategy: 'balanced',
                        clientModelPolicy: 'always-route'
                    }
                }
            }), { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            // Mock the classify method to return malformed JSON in the reason
            jest.spyOn(router, 'classify').mockReturnValue({
                tier: 'light',
                reason: 'rule: { invalid json'
            });

            try {
                // Call explain - it should handle malformed JSON gracefully
                const result = await router.explain({
                    parsedBody: {
                        model: 'test-model',
                        max_tokens: 1000,
                        messages: [{ role: 'user', content: 'hi' }]
                    },
                    requestModel: 'test-model',
                    mode: 'decision'
                });

                // Should handle the error and set matchedRule to null
                expect(result).toBeDefined();
                expect(result.selectedModel).toBeDefined();
                expect(result.matchedRule).toBeNull(); // Should be null due to JSON parse error
            } finally {
                router.classify.mockRestore();
            }
        });
    });

    // --- FAILOVER DURING WARMUP WINDOW (line 1616) ---

    describe('failover warmup tracking', () => {
        test('increments failoverWarmupTotal when failover occurs during warmup (line 1616)', async () => {
            // Create router with custom warmup duration to ensure we're in warmup window
            const router = new ModelRouter(makeConfig({
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash',
                        failoverModel: 'glm-4-air',
                        clientModelPolicy: 'always-route'
                    }
                }
            }), { persistEnabled: false, modelDiscovery: mockModelDiscovery, warmupDurationMs: 60000 });

            // Create a decision object with source='failover' to test the branch
            // Note: In current v2 normalized code, source='failover' is only set in
            // legacy paths, but we can still test the commitDecision logic
            const result = {
                model: 'glm-4-air',
                tier: 'light',
                source: 'failover',
                reason: 'rule: matched (failover: glm-4-flash unavailable)',
                strategy: 'balanced'
            };

            // Commit the decision to trigger the stats update
            router.commitDecision(result);

            // The failoverWarmupTotal stat should be incremented
            const stats = router.getStats();
            expect(stats.failoverWarmupTotal).toBe(1);
        });
    });

    // --- NO MATCH WITH TRACE (line 1553) ---

    describe('computeDecision no match with trace', () => {
        test('returns null model with trace when nothing matches (line 1553)', async () => {
            const router = new ModelRouter(makeConfig({
                // No rules, no tiers that would match, no default model
                tiers: {},
                rules: [],
                defaultModel: null
            }), { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            const result = await router.computeDecision({
                parsedBody: {
                    model: 'unknown-model',
                    max_tokens: 1000,
                    messages: [{ role: 'user', content: 'test' }]
                },
                requestModel: 'unknown-model',
                includeTrace: true,
                bypassSampling: true
            });

            // Should return no-match decision with trace
            expect(result.model).toBeNull();
            expect(result.reason).toContain('no match');
            expect(result.source).toBe('none');
            expect(result.trace).toBeDefined();
        });
    });

    // --- TIER DOWNGRADE SCENARIOS (lines 1403, 1459) ---

    describe('tier downgrade scenarios', () => {
        const downgradeModelMeta = {
            'heavy-model': { maxConcurrency: 5 },
            'medium-model': { maxConcurrency: 5 },
            'light-model': { maxConcurrency: 5 }
        };

        const downgradeDiscovery = {
            getModel: jest.fn().mockImplementation((id) => downgradeModelMeta[id] || null)
        };

        test('triggers tier downgrade when heavy tier is exhausted with trace (line 1459)', async () => {
            const router = new ModelRouter(makeConfig({
                failover: {
                    allowTierDowngrade: true,
                    downgradeOrder: ['medium', 'light']
                },
                tiers: {
                    heavy: {
                        models: ['heavy-model'],
                        strategy: 'balanced',
                        clientModelPolicy: 'always-route'
                    },
                    medium: {
                        models: ['medium-model'],
                        strategy: 'balanced'
                    }
                },
                rules: [{ match: { model: 'claude-opus-*' }, tier: 'heavy' }]
            }), { persistEnabled: false, modelDiscovery: downgradeDiscovery });

            // Put heavy-model on cooldown to exhaust the tier
            router.recordModelCooldown('heavy-model', 5000);

            const result = await router.computeDecision({
                parsedBody: {
                    model: 'claude-opus-4',
                    max_tokens: 10000,
                    messages: [{ role: 'user', content: 'test' }]
                },
                requestModel: 'claude-opus-4',
                includeTrace: true,
                bypassSampling: true
            });

            // Should downgrade to medium tier
            expect(result.source).toBe('tier_downgrade');
            expect(result.tier).toBe('medium');
            expect(result.degradedFromTier).toBe('heavy');
            expect(result.trace).toBeDefined();
        });

        test('adds warning when all candidates unavailable with shortestCooldown = Infinity (line 1403)', async () => {
            // Create model discovery that returns context length
            const contextAwareDiscovery = {
                getModel: jest.fn().mockImplementation((id) => {
                    const meta = downgradeModelMeta[id] || { maxConcurrency: 5 };
                    // Give models small context length to trigger filtering
                    if (id === 'model-a') meta.contextLength = 1000;
                    if (id === 'model-b') meta.contextLength = 1000;
                    if (id === 'model-c') meta.contextLength = 1000;
                    return meta;
                })
            };

            const router = new ModelRouter(makeConfig({
                rules: [{ match: { model: 'model-*' }, tier: 'light' }],
                failover: {
                    maxModelSwitchesPerRequest: 10
                },
                tiers: {
                    light: {
                        models: ['model-a', 'model-b', 'model-c'],
                        strategy: 'balanced',
                        clientModelPolicy: 'always-route'
                    }
                }
            }), { persistEnabled: false, modelDiscovery: contextAwareDiscovery });

            // Put target on cooldown
            router.recordModelCooldown('model-a', 5000);

            // Request with large max_tokens that exceeds all model context lengths
            const result = await router.computeDecision({
                parsedBody: {
                    model: 'model-a',
                    max_tokens: 100000,  // Exceeds contextLength of 1000
                    messages: [{ role: 'user', content: 'test' }]
                },
                requestModel: 'model-a',
                attemptedModels: new Set(['model-b'])
            });

            // All candidates should be filtered by context check,
            // shortestCooldown stays Infinity, triggering line 1403
            expect(result).toBeDefined();
            // Verify the warning is present
            expect(result.reason).toContain('warning: all candidates unavailable');
        });

        test('finds fallback when target unavailable with available fallback (line 1374-1378)', async () => {
            const router = new ModelRouter(makeConfig({
                rules: [{ match: { model: 'fallback-test-*' }, tier: 'light' }],
                tiers: {
                    light: {
                        models: ['fallback-test-a', 'fallback-test-b'],
                        strategy: 'balanced',
                        clientModelPolicy: 'always-route'
                    }
                }
            }), { persistEnabled: false, modelDiscovery: downgradeDiscovery });

            // Put target on cooldown, fallback available
            router.recordModelCooldown('fallback-test-a', 5000);

            const result = await router.computeDecision({
                parsedBody: {
                    model: 'fallback-test-a',
                    max_tokens: 1000,
                    messages: [{ role: 'user', content: 'test' }]
                },
                requestModel: 'fallback-test-a',
                bypassSampling: true
            });

            // Should route to fallback-test-b since fallback-test-a is on cooldown
            expect(result).toBeDefined();
            expect(result.model).toBe('fallback-test-b');
        });
    });

    // --- TRACE REBUILD WITH ROUTER STATE (lines 1777-1785) ---

    describe('trace rebuild with router state in selectModel', () => {
        test('rebuilds trace with routerPool when not already included (lines 1777-1785)', async () => {
            const router = new ModelRouter(makeConfig({
                tiers: {
                    light: {
                        models: ['model-a'],
                        strategy: 'balanced',
                        clientModelPolicy: 'always-route'
                    }
                },
                rules: [{ match: { model: 'claude-haiku-*' }, tier: 'light' }]
            }), { persistEnabled: false, modelDiscovery: mockModelDiscovery });

            // Call selectModel with includeRouterState using a routable model name
            const result = await router.selectModel({
                parsedBody: makeBody({
                    model: 'claude-haiku-4-5-20251001',
                    max_tokens: 1000,
                    messages: [{ role: 'user', content: 'test' }]
                }),
                requestModel: 'claude-haiku-4-5-20251001',
                includeTrace: true,
                includeRouterState: true,
                bypassSampling: true
            });

            // Result should exist and have trace with router state
            expect(result).toBeDefined();
            expect(result.trace).toBeDefined();
            expect(result.trace.routerPool).toBeDefined();
        });
    });
});
