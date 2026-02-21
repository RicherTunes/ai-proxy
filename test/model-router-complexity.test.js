'use strict';

const { ModelRouter } = require('../lib/model-router');

/** Mock ModelDiscovery instance */
const mockModelDiscovery = {
    getModel: jest.fn().mockResolvedValue(null)
};

describe('Complexity Upgrade Config Knobs', () => {
    function createRouter(overrides = {}) {
        const baseConfig = {
            enabled: true,
            tiers: {
                light: { models: ['glm-4.5-air'], strategy: 'throughput' },
                medium: { models: ['glm-4.5'], strategy: 'balanced' },
                heavy: { models: ['glm-5', 'glm-4.7'], strategy: 'quality' }
            },
            rules: [
                { match: { model: 'claude-opus*' }, tier: 'heavy' },
                { match: { model: 'claude-sonnet*' }, tier: 'medium' },
                { match: { model: 'claude-haiku*' }, tier: 'light' }
            ],
            complexityUpgrade: {
                enabled: true,
                allowedFamilies: [],
                thresholds: {
                    maxTokensGte: 4096,
                    messageCountGte: 20,
                    hasTools: true,
                    hasVision: true,
                    systemLengthGte: 2000
                }
            },
            classifier: {
                heavyThresholds: {
                    maxTokensGte: 4096,
                    messageCountGte: 20,
                    hasTools: true,
                    hasVision: true,
                    systemLengthGte: 2000
                },
                lightThresholds: {
                    maxTokensLte: 512,
                    messageCountLte: 3
                }
            },
            ...overrides
        };
        return new ModelRouter(baseConfig, {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery
        });
    }

    test('enabled: false = no upgrades (returns null)', () => {
        const router = createRouter({
            complexityUpgrade: {
                enabled: false,
                allowedFamilies: [],
                thresholds: { hasTools: true }
            }
        });
        const features = { model: 'claude-sonnet-4-5-20250929', hasTools: true, hasVision: false, maxTokens: null, messageCount: 1, systemLength: 0 };
        const reason = router._classifyUpgradeReason(features);
        expect(reason).toBeNull();
    });

    test('enabled: true with tools returns has_tools', () => {
        const router = createRouter();
        const features = { model: 'claude-sonnet-4-5-20250929', hasTools: true, hasVision: false, maxTokens: null, messageCount: 1, systemLength: 0 };
        const reason = router._classifyUpgradeReason(features);
        expect(reason).toBe('has_tools');
    });

    test('no allowedFamilies = all can upgrade (backwards compat)', () => {
        const router = createRouter({
            complexityUpgrade: {
                enabled: true,
                allowedFamilies: [],
                thresholds: { hasTools: true }
            }
        });
        const features = { model: 'claude-haiku-4-5-20251001', hasTools: true, hasVision: false, maxTokens: null, messageCount: 1, systemLength: 0 };
        const reason = router._classifyUpgradeReason(features);
        expect(reason).toBe('has_tools');
    });

    test('haiku stays light when allowedFamilies excludes haiku', () => {
        const router = createRouter({
            complexityUpgrade: {
                enabled: true,
                allowedFamilies: ['claude-sonnet', 'claude-opus'],
                thresholds: { hasTools: true }
            }
        });
        const features = { model: 'claude-haiku-4-5-20251001', hasTools: true, hasVision: false, maxTokens: null, messageCount: 1, systemLength: 0 };
        const reason = router._classifyUpgradeReason(features);
        expect(reason).toBeNull();
    });

    test('sonnet upgrades to heavy when allowed', () => {
        const router = createRouter({
            complexityUpgrade: {
                enabled: true,
                allowedFamilies: ['claude-sonnet', 'claude-opus'],
                thresholds: { hasTools: true }
            }
        });
        const features = { model: 'claude-sonnet-4-5-20250929', hasTools: true, hasVision: false, maxTokens: null, messageCount: 1, systemLength: 0 };
        const reason = router._classifyUpgradeReason(features);
        expect(reason).toBe('has_tools');
    });

    test('validateConfig accepts enabled and allowedFamilies', () => {
        const result = ModelRouter.validateConfig({
            complexityUpgrade: {
                enabled: true,
                allowedFamilies: ['claude-sonnet']
            }
        });
        expect(result.valid).toBe(true);
    });

    test('validateConfig rejects non-boolean enabled', () => {
        const result = ModelRouter.validateConfig({
            complexityUpgrade: {
                enabled: 'yes'
            }
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('boolean');
    });

    test('validateConfig rejects non-array allowedFamilies', () => {
        const result = ModelRouter.validateConfig({
            complexityUpgrade: {
                allowedFamilies: 'claude-sonnet'
            }
        });
        expect(result.valid).toBe(false);
        expect(result.error).toContain('array');
    });
});

describe('Routing Classification — scoped complexity rules', () => {
    const mockModelDiscovery = { getModel: jest.fn().mockResolvedValue(null) };

    function createRouterWithScopedRules(rulesOverride) {
        return new ModelRouter({
            enabled: true,
            tiers: {
                light: { models: ['glm-4.5-air'], strategy: 'throughput', clientModelPolicy: 'always-route' },
                medium: { models: ['glm-4.5'], strategy: 'balanced', clientModelPolicy: 'always-route' },
                heavy: { models: ['glm-5'], strategy: 'quality', clientModelPolicy: 'always-route' }
            },
            rules: rulesOverride,
            classifier: {
                heavyThresholds: { maxTokensGte: 4096, hasTools: true, hasVision: true },
                lightThresholds: { maxTokensLte: 512, messageCountLte: 3 }
            }
        }, { persistEnabled: false, modelDiscovery: mockModelDiscovery });
    }

    test('global complexity overrides classify Haiku+tools as heavy (the bug)', () => {
        // This demonstrates the OLD behavior (global rules fire before family rules)
        const router = createRouterWithScopedRules([
            { match: { hasTools: true }, tier: 'heavy' },  // Global — fires for ALL models
            { match: { model: 'claude-haiku*' }, tier: 'light' }
        ]);
        const result = router.classify({
            model: 'claude-haiku-4-5-20251001',
            hasTools: true, hasVision: false,
            maxTokens: null, messageCount: 1, systemLength: 0
        });
        // Bug: Haiku gets classified as heavy because global rule fires first
        expect(result.tier).toBe('heavy');
    });

    test('scoped rules keep Haiku+tools in light tier', () => {
        // This is the FIXED behavior (family rules first, complexity scoped to Sonnet/Opus)
        const router = createRouterWithScopedRules([
            { match: { model: 'claude-opus*' }, tier: 'heavy' },
            { match: { model: 'claude-sonnet*', hasTools: true }, tier: 'heavy' },
            { match: { model: 'claude-sonnet*' }, tier: 'medium' },
            { match: { model: 'claude-haiku*' }, tier: 'light' }
        ]);
        const result = router.classify({
            model: 'claude-haiku-4-5-20251001',
            hasTools: true, hasVision: false,
            maxTokens: null, messageCount: 1, systemLength: 0
        });
        expect(result.tier).toBe('light');
        expect(result.reason).toContain('claude-haiku');
    });

    test('scoped rules upgrade Sonnet+tools to heavy tier', () => {
        const router = createRouterWithScopedRules([
            { match: { model: 'claude-opus*' }, tier: 'heavy' },
            { match: { model: 'claude-sonnet*', hasTools: true }, tier: 'heavy' },
            { match: { model: 'claude-sonnet*' }, tier: 'medium' },
            { match: { model: 'claude-haiku*' }, tier: 'light' }
        ]);
        const result = router.classify({
            model: 'claude-sonnet-4-5-20250929',
            hasTools: true, hasVision: false,
            maxTokens: null, messageCount: 1, systemLength: 0
        });
        expect(result.tier).toBe('heavy');
        expect(result.reason).toContain('hasTools');
    });

    test('scoped rules keep Sonnet without tools in medium tier', () => {
        const router = createRouterWithScopedRules([
            { match: { model: 'claude-opus*' }, tier: 'heavy' },
            { match: { model: 'claude-sonnet*', hasTools: true }, tier: 'heavy' },
            { match: { model: 'claude-sonnet*', hasVision: true }, tier: 'heavy' },
            { match: { model: 'claude-sonnet*' }, tier: 'medium' },
            { match: { model: 'claude-haiku*' }, tier: 'light' }
        ]);
        const result = router.classify({
            model: 'claude-sonnet-4-5-20250929',
            hasTools: false, hasVision: false,
            maxTokens: 1024, messageCount: 3, systemLength: 100
        });
        expect(result.tier).toBe('medium');
        expect(result.reason).toContain('claude-sonnet');
    });

    test('Haiku+vision stays in light tier with scoped rules', () => {
        const router = createRouterWithScopedRules([
            { match: { model: 'claude-opus*' }, tier: 'heavy' },
            { match: { model: 'claude-sonnet*', hasVision: true }, tier: 'heavy' },
            { match: { model: 'claude-sonnet*' }, tier: 'medium' },
            { match: { model: 'claude-haiku*' }, tier: 'light' }
        ]);
        const result = router.classify({
            model: 'claude-haiku-4-5-20251001',
            hasTools: false, hasVision: true,
            maxTokens: null, messageCount: 1, systemLength: 0
        });
        expect(result.tier).toBe('light');
    });

    test('unknown model returns null when only heavy has always-route', () => {
        // With rule-match-only on light/medium, unknown models only match classifier if heavy is always-route
        const router = new ModelRouter({
            enabled: true,
            tiers: {
                light: { models: ['glm-air'], strategy: 'throughput', clientModelPolicy: 'rule-match-only' },
                medium: { models: ['glm-4.5'], strategy: 'balanced', clientModelPolicy: 'rule-match-only' },
                heavy: { models: ['glm-5'], strategy: 'quality', clientModelPolicy: 'always-route' }
            },
            rules: [
                { match: { model: 'claude-sonnet*' }, tier: 'medium' },
                { match: { model: 'claude-haiku*' }, tier: 'light' }
            ],
            classifier: {
                heavyThresholds: { hasTools: true },
                lightThresholds: { maxTokensLte: 512 }
            }
        }, { persistEnabled: false, modelDiscovery: mockModelDiscovery });

        // Unknown model without tools → classifier defaults to medium (always-route heavy activates classifier)
        const result = router.classify({
            model: 'unknown-model-v1',
            hasTools: false, hasVision: false,
            maxTokens: 1024, messageCount: 1, systemLength: 0
        });
        // Classifier should activate (heavy is always-route) and return medium as default
        expect(result.tier).toBe('medium');
        expect(result.reason).toContain('classifier');
    });

    test('unknown model with tools → classifier routes to heavy', () => {
        const router = new ModelRouter({
            enabled: true,
            tiers: {
                light: { models: ['glm-air'], strategy: 'throughput', clientModelPolicy: 'rule-match-only' },
                medium: { models: ['glm-4.5'], strategy: 'balanced', clientModelPolicy: 'rule-match-only' },
                heavy: { models: ['glm-5'], strategy: 'quality', clientModelPolicy: 'always-route' }
            },
            rules: [
                { match: { model: 'claude-sonnet*' }, tier: 'medium' },
                { match: { model: 'claude-haiku*' }, tier: 'light' }
            ],
            classifier: {
                heavyThresholds: { hasTools: true },
                lightThresholds: { maxTokensLte: 512 }
            }
        }, { persistEnabled: false, modelDiscovery: mockModelDiscovery });

        const result = router.classify({
            model: 'unknown-model-v1',
            hasTools: true, hasVision: false,
            maxTokens: 1024, messageCount: 1, systemLength: 0
        });
        expect(result.tier).toBe('heavy');
        expect(result.reason).toContain('classifier');
    });
});
