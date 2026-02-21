/**
 * ModelRouter Extended Tests
 *
 * Targets uncovered lines: 161, 165, 171, 198, 208, 348, 484, 664, 672, 699, 713, 752
 * and uncovered branches in classify(), selectModel(), validateConfig(), _persistOverrides().
 */

jest.mock('../lib/atomic-write', () => ({
    atomicWrite: jest.fn().mockResolvedValue()
}));

const fs = require('fs');
const { atomicWrite } = require('../lib/atomic-write');

const originalReadFileSync = fs.readFileSync;
jest.spyOn(fs, 'readFileSync').mockImplementation((filePath, encoding) => {
    if (typeof filePath === 'string' && filePath.includes('model-routing-overrides')) {
        return '{}';
    }
    return originalReadFileSync(filePath, encoding);
});

const { ModelRouter } = require('../lib/model-router');

/** Helper: build a full modelRouting config with sensible defaults. */
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
        rules: [],
        classifier: {
            heavyThresholds: {
                maxTokensGte: 4096,
                messageCountGte: 20,
                hasTools: true,
                hasVision: true,
                systemLengthGte: 5000
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

/** Helper: build a minimal parsed Anthropic body. */
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

/** Mock ModelDiscovery instance */
const mockModelDiscovery = {
    getModel: jest.fn().mockResolvedValue(null)
};

/** Helper: create ModelRouter with mock ModelDiscovery */
function makeRouter(config, overrides = {}) {
    return new ModelRouter(config, {
        persistEnabled: false,
        modelDiscovery: mockModelDiscovery,
        ...overrides
    });
}

describe('ModelRouter extended - classify uncovered branches', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // Line 161: maxTokens is present but below maxTokensGte threshold in a rule
    test('rule with maxTokensGte does not match when maxTokens is below threshold', () => {
        const config = makeConfig({
            rules: [
                { match: { maxTokensGte: 8000 }, tier: 'heavy' }
            ]
        });
        const router = makeRouter(config);
        const features = router.extractFeatures(makeBody({ max_tokens: 4000 }));
        const result = router.classify(features);

        // maxTokens=4000 < 8000, so the rule should NOT match
        // Should fall through to classifier (always-route tiers present)
        expect(result).not.toBeNull();
        expect(result.tier).not.toBe('heavy');
        expect(result.reason).not.toContain('rule:');
    });

    // Line 165: messageCount < match.messageCountGte in a rule
    test('rule with messageCountGte does not match when messageCount is below threshold', () => {
        const config = makeConfig({
            rules: [
                { match: { messageCountGte: 10 }, tier: 'heavy' }
            ]
        });
        const router = makeRouter(config);
        const features = router.extractFeatures(makeBody({
            messages: [{ role: 'user', content: 'Hi' }]
        }));
        const result = router.classify(features);

        // messageCount=1 < 10, so the rule should NOT match
        expect(result).not.toBeNull();
        expect(result.reason).not.toContain('rule:');
    });

    // Line 165: messageCountGte rule DOES match when equal
    test('rule with messageCountGte matches when messageCount equals threshold', () => {
        const msgs = [];
        for (let i = 0; i < 5; i++) msgs.push({ role: 'user', content: 'msg' });
        const config = makeConfig({
            rules: [
                { match: { messageCountGte: 5 }, tier: 'heavy' }
            ]
        });
        const router = makeRouter(config);
        const features = router.extractFeatures(makeBody({ messages: msgs }));
        const result = router.classify(features);

        expect(result.tier).toBe('heavy');
        expect(result.reason).toContain('rule:');
    });

    // Line 171: hasVision mismatch in a rule
    test('rule with hasVision=true does not match when request has no vision', () => {
        const config = makeConfig({
            rules: [
                { match: { hasVision: true }, tier: 'heavy' }
            ]
        });
        const router = makeRouter(config);
        const features = router.extractFeatures(makeBody({
            messages: [{ role: 'user', content: 'Hello' }]
        }));
        const result = router.classify(features);

        // No vision content, rule should not match
        expect(result).not.toBeNull();
        expect(result.reason).not.toContain('rule:');
    });

    // Line 171: hasVision rule match (positive case)
    test('rule with hasVision=true matches when request has vision content', () => {
        const config = makeConfig({
            rules: [
                { match: { hasVision: true }, tier: 'heavy' }
            ]
        });
        const router = makeRouter(config);
        const features = router.extractFeatures(makeBody({
            messages: [
                { role: 'user', content: [{ type: 'image', source: { data: 'base64' } }] }
            ]
        }));
        const result = router.classify(features);

        expect(result.tier).toBe('heavy');
        expect(result.reason).toContain('rule:');
    });

    // Line 198: classifier heavy via messageCount >= messageCountGte
    test('classifier routes to heavy when messageCount meets heavy threshold', () => {
        const config = makeConfig({ rules: [] });
        const router = makeRouter(config);

        const msgs = [];
        for (let i = 0; i < 25; i++) msgs.push({ role: 'user', content: 'msg ' + i });

        const features = router.extractFeatures(makeBody({
            max_tokens: 100,
            messages: msgs
        }));
        const result = router.classify(features);

        expect(result.tier).toBe('heavy');
        expect(result.reason).toContain('classifier');
        expect(result.reason).toContain('messageCount');
    });

    // Line 208: classifier heavy via systemLength >= systemLengthGte
    test('classifier routes to heavy when systemLength meets heavy threshold', () => {
        const config = makeConfig({ rules: [] });
        const router = makeRouter(config);

        const longSystem = 'x'.repeat(6000);
        const features = router.extractFeatures(makeBody({
            max_tokens: 100,
            system: longSystem,
            messages: [{ role: 'user', content: 'Hi' }]
        }));
        const result = router.classify(features);

        expect(result.tier).toBe('heavy');
        expect(result.reason).toContain('classifier');
        expect(result.reason).toContain('systemLength');
    });

    // Additional: classifier does NOT trigger heavy for systemLength below threshold
    test('classifier does not trigger heavy when systemLength is below threshold', () => {
        const config = makeConfig({ rules: [] });
        const router = makeRouter(config);

        const features = router.extractFeatures(makeBody({
            max_tokens: 100,
            system: 'Short system prompt',
            messages: [{ role: 'user', content: 'Hi' }]
        }));
        const result = router.classify(features);

        // Should be light (short tokens, 1 message, no tools/vision)
        expect(result.tier).toBe('light');
    });
});

describe('ModelRouter extended - selectModel uncovered branches', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // Line 348: target cooled down, can switch, but no fallback models available
    test('target cooled, canSwitch=true, but no fallbacks configured -> warning about no fallback', async () => {
        const config = makeConfig({
            tiers: {
                light: { targetModel: 'glm-4-flash', clientModelPolicy: 'always-route' },
                medium: { targetModel: 'glm-4-air', clientModelPolicy: 'always-route' },
                heavy: {
                    targetModel: 'glm-4-plus',
                    // No failoverModel, no fallbackModels
                    clientModelPolicy: 'always-route'
                }
            },
            rules: [
                { match: { model: 'claude-3-opus-*' }, tier: 'heavy' }
            ]
        });
        const router = makeRouter(config);
        router.recordModelCooldown('glm-4-plus', 10000);

        const result = await router.selectModel({
            parsedBody: makeBody({ model: 'claude-3-opus-20240229' }),
            requestModel: 'claude-3-opus-20240229'
        });

        // Target is cooled, canSwitch is true (attemptedModels empty), but no fallbacks
        // Falls into the else-if (targetUnavailable, !canSwitch OR no fallbacks)
        // Since canSwitch IS true, but fallbacks.length === 0, the condition is:
        // targetUnavailable && canSwitch && fallbacks.length > 0 → false (fallbacks empty)
        // targetUnavailable → true
        // canSwitch → true
        // So it hits the `else if (targetUnavailable)` branch, and canSwitch is true
        // → line 348: 'targetModel cooled down, no fallback available'
        expect(result.model).toBe('glm-4-plus');
        expect(result.reason).toContain('no fallback available');
    });

    // Additional coverage: selectModel with classifier source (not rule)
    test('classifier-based route shows source as classifier not rule', async () => {
        const config = makeConfig({ rules: [] });
        const router = makeRouter(config);

        const result = await router.selectModel({
            parsedBody: makeBody({ max_tokens: 5000 }),
            requestModel: 'claude-sonnet-4-20250514'
        });

        expect(result.source).toBe('classifier');
        expect(result.tier).toBe('heavy');
    });

    // After v2 normalization, pool selection uses classification source (classifier)
    test('classifier-based classification shows classifier source after pool selection', async () => {
        const config = makeConfig({
            rules: [],
            tiers: {
                light: { targetModel: 'glm-4-flash', clientModelPolicy: 'always-route' },
                medium: { targetModel: 'glm-4-air', clientModelPolicy: 'always-route' },
                heavy: {
                    targetModel: 'glm-4-plus',
                    fallbackModels: ['glm-4-air'],
                    clientModelPolicy: 'always-route'
                }
            }
        });
        const router = makeRouter(config);
        router.recordModelCooldown('glm-4-plus', 10000);

        const result = await router.selectModel({
            parsedBody: makeBody({ max_tokens: 5000 }),
            requestModel: 'claude-sonnet-4-20250514'
        });

        expect(result.model).toBe('glm-4-air');
        // After v2 normalization, pool selection uses classification source (classifier)
        expect(result.source).toBe('classifier');
        expect(result.reason).toContain('classifier');
    });

    // All candidates unavailable with classifier source
    test('all fallbacks unavailable with classifier shows warning', async () => {
        const config = makeConfig({
            rules: [],
            failover: { maxModelSwitchesPerRequest: 5 },
            tiers: {
                light: { targetModel: 'glm-4-flash', clientModelPolicy: 'always-route' },
                medium: { targetModel: 'glm-4-air', clientModelPolicy: 'always-route' },
                heavy: {
                    targetModel: 'glm-4-plus',
                    fallbackModels: ['glm-4-air'],
                    clientModelPolicy: 'always-route'
                }
            }
        });
        const router = makeRouter(config);
        router.recordModelCooldown('glm-4-plus', 10000);
        router.recordModelCooldown('glm-4-air', 10000);

        const result = await router.selectModel({
            parsedBody: makeBody({ max_tokens: 5000 }),
            requestModel: 'claude-sonnet-4-20250514'
        });

        // When all candidates are cooled with equal duration, either target or
        // fallback may win due to sub-ms timing differences in cooldownUntil.
        expect(['glm-4-plus', 'glm-4-air']).toContain(result.model);
        expect(result.source).toBe('classifier');
        expect(result.reason).toContain('all candidates unavailable');
    });
});

describe('ModelRouter extended - getNextFallback line 484', () => {
    // Line 484: return null at end of getNextFallback when all candidates attempted
    // (This is already tested in the main test file, but we add an additional scenario)
    test('getNextFallback returns null when tier has no fallbacks and target attempted', () => {
        const config = makeConfig({
            tiers: {
                light: { targetModel: 'glm-4-flash', clientModelPolicy: 'always-route' },
                medium: { targetModel: 'glm-4-air', clientModelPolicy: 'always-route' },
                heavy: {
                    targetModel: 'glm-4-plus',
                    // No fallbackModels, no failoverModel
                    clientModelPolicy: 'always-route'
                }
            },
            failover: { maxModelSwitchesPerRequest: 5 }
        });
        const router = makeRouter(config);

        const result = router.getNextFallback({
            tier: 'heavy',
            attemptedModels: new Set(['glm-4-plus'])
        });

        expect(result).toBeNull();
    });
});

describe('ModelRouter.validateConfig extended - uncovered branches', () => {
    // Line 664: tiers is an array (not an object)
    test('rejects tiers when it is an array', () => {
        const result = ModelRouter.validateConfig({
            tiers: [{ targetModel: 'glm-4-flash' }]
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('tiers');
        expect(result.error).toContain('object');
    });

    // Line 672: tier config value is null
    test('rejects tier when its config is null', () => {
        const result = ModelRouter.validateConfig({
            tiers: { light: null }
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('light');
        expect(result.error).toContain('object');
    });

    // Line 672: tier config value is a non-object primitive
    test('rejects tier when its config is a string', () => {
        const result = ModelRouter.validateConfig({
            tiers: { medium: 'glm-4-air' }
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('medium');
        expect(result.error).toContain('object');
    });

    // Line 699: rules entry is null
    test('rejects rules entry that is null', () => {
        const result = ModelRouter.validateConfig({
            rules: [null]
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('rules[0]');
        expect(result.error).toContain('object');
    });

    // Line 699: rules entry is a non-object (string)
    test('rejects rules entry that is a string', () => {
        const result = ModelRouter.validateConfig({
            rules: ['not-an-object']
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('rules[0]');
        expect(result.error).toContain('object');
    });

    // Line 699: rules entry is a number
    test('rejects rules entry that is a number', () => {
        const result = ModelRouter.validateConfig({
            rules: [{ tier: 'heavy', match: {} }, 42]
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('rules[1]');
    });

    // Line 713: cooldown is an array
    test('rejects cooldown when it is an array', () => {
        const result = ModelRouter.validateConfig({
            cooldown: [5000]
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('cooldown');
        expect(result.error).toContain('object');
    });

    // Line 713: cooldown is null
    test('rejects cooldown when it is null', () => {
        const result = ModelRouter.validateConfig({
            cooldown: null
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('cooldown');
    });

    // Additional: failover as an array
    test('rejects failover when it is an array', () => {
        const result = ModelRouter.validateConfig({
            failover: [1]
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('failover');
    });

    // Additional: classifier as an array
    test('rejects classifier when it is an array', () => {
        const result = ModelRouter.validateConfig({
            classifier: ['fast']
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('classifier');
    });
});

describe('ModelRouter extended - _persistOverrides error handling', () => {
    // Line 752: atomicWrite throws an error
    test('logs warning when atomicWrite fails', async () => {
        atomicWrite.mockRejectedValueOnce(new Error('disk full'));

        const warnFn = jest.fn();
        const router = makeRouter(makeConfig(), {
            persistEnabled: true,
            configDir: '/tmp/test-persist',
            logger: { warn: warnFn }
        });

        router.setOverride('claude-sonnet-4', 'glm-4-turbo');

        // _persistOverrides is async, wait for it
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(atomicWrite).toHaveBeenCalled();
        expect(warnFn).toHaveBeenCalledWith(
            expect.stringContaining('[ModelRouter] Failed to persist overrides:'),
            expect.stringContaining('disk full')
        );
    });

    // Line 744: _persistOverrides returns early when no configDir
    test('does not write when configDir is null even if persist is enabled', async () => {
        atomicWrite.mockClear();
        const router = makeRouter(makeConfig(), {
            persistEnabled: true,
            configDir: null
        });

        router.setOverride('key', 'val');

        await new Promise(resolve => setTimeout(resolve, 50));
        expect(atomicWrite).not.toHaveBeenCalled();
    });
});

describe('ModelRouter extended - extractFeatures edge cases', () => {
    test('system as non-string non-array returns 0 length', () => {
        const router = makeRouter(makeConfig());
        const features = router.extractFeatures(makeBody({ system: 12345 }));
        expect(features.systemLength).toBe(0);
    });

    test('system as undefined returns 0 length', () => {
        const router = makeRouter(makeConfig());
        const body = makeBody();
        delete body.system;
        const features = router.extractFeatures(body);
        expect(features.systemLength).toBe(0);
    });

    test('messages as undefined defaults to empty array', () => {
        const router = makeRouter(makeConfig());
        const body = makeBody();
        delete body.messages;
        const features = router.extractFeatures(body);
        expect(features.messageCount).toBe(0);
        expect(features.hasVision).toBe(false);
    });
});
