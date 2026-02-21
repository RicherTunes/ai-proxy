/**
 * Model Router API Response Shape Tests (NORM-04)
 *
 * Tests for API response format:
 * - toJSON() returns models[] at top level
 * - toJSON() never has targetModel at top level
 * - toJSON() has legacy flag when config was migrated from v1
 */

'use strict';

const { ModelRouter } = require('../lib/model-router');

describe('Model Router API Response Shape (NORM-04)', () => {
    describe('toJSON() v2 format compliance', () => {
        test('returns models[] at top level of tiers', () => {
            const router = new ModelRouter({
                enabled: true,
                tiers: {
                    heavy: {
                        models: ['glm-4-flash', 'glm-4-plus']
                    }
                }
            }, { modelDiscovery: {} });

            const json = router.toJSON();

            // Check that tiers have models[] at top level
            expect(json.config.tiers).toBeDefined();
            expect(json.config.tiers.heavy).toBeDefined();
            expect(Array.isArray(json.config.tiers.heavy.models)).toBe(true);
        });

        test('never has targetModel at top level of config', () => {
            const router = new ModelRouter({
                enabled: true,
                tiers: {
                    heavy: {
                        models: ['glm-4-flash', 'glm-4-plus']
                    }
                }
            }, { modelDiscovery: {} });

            const json = router.toJSON();

            // Check that no tier has targetModel at top level
            const hasTargetModelAtTopLevel = json.config && json.config.tiers &&
                Object.values(json.config.tiers).some(
                    tier => tier && typeof tier === 'object' && 'targetModel' in tier
                );

            expect(hasTargetModelAtTopLevel).toBe(false);
        });

        test('never has fallbackModels at top level of config', () => {
            const router = new ModelRouter({
                enabled: true,
                tiers: {
                    heavy: {
                        models: ['glm-4-flash', 'glm-4-plus']
                    }
                }
            }, { modelDiscovery: {} });

            const json = router.toJSON();

            // Check that no tier has fallbackModels at top level
            const hasFallbackModelsAtTopLevel = json.config && json.config.tiers &&
                Object.values(json.config.tiers).some(
                    tier => tier && typeof tier === 'object' && 'fallbackModels' in tier
                );

            expect(hasFallbackModelsAtTopLevel).toBe(false);
        });

        test('never has failoverModel at top level of config', () => {
            const router = new ModelRouter({
                enabled: true,
                tiers: {
                    heavy: {
                        models: ['glm-4-flash', 'glm-4-plus']
                    }
                }
            }, { modelDiscovery: {} });

            const json = router.toJSON();

            // Check that no tier has failoverModel at top level
            const hasFailoverModelAtTopLevel = json.config && json.config.tiers &&
                Object.values(json.config.tiers).some(
                    tier => tier && typeof tier === 'object' && 'failoverModel' in tier
                );

            expect(hasFailoverModelAtTopLevel).toBe(false);
        });

        test('has no legacy key for pure v2 config', () => {
            const router = new ModelRouter({
                enabled: true,
                tiers: {
                    heavy: {
                        models: ['glm-4-flash', 'glm-4-plus']
                    }
                }
            }, { modelDiscovery: {} });

            const json = router.toJSON();

            // Pure v2 config should not have legacy key
            expect(json.legacy).toBeUndefined();
        });

        test('includes legacy flag when v1 fields were present', () => {
            const router = new ModelRouter({
                enabled: true,
                tiers: {
                    heavy: {
                        targetModel: 'glm-4-flash',
                        fallbackModels: ['glm-4-plus']
                    }
                }
            }, { modelDiscovery: {} });

            const json = router.toJSON();

            // When v1 fields exist in original config, legacy flag should be true
            expect(json.legacy).toBe(true);
            // Note: After normalization, v1 fields are removed from in-memory config.
            // Only the top-level legacy flag indicates v1 origin.
        });
    });

    describe('Normalization contract', () => {
        test('v1 config is normalized to v2 format', () => {
            const { normalizeModelRoutingConfig } = require('../lib/model-router-normalizer');

            const v1Config = {
                version: '2.0',
                enabled: true,
                tiers: {
                    heavy: {
                        targetModel: 'glm-4-flash',
                        fallbackModels: ['glm-4-plus'],
                        failoverModel: 'glm-4.7'
                    }
                }
            };

            const result = normalizeModelRoutingConfig(v1Config);

            expect(result.migrated).toBe(true);
            expect(result.normalizedConfig.tiers.heavy.models).toBeDefined();
            expect(Array.isArray(result.normalizedConfig.tiers.heavy.models)).toBe(true);
            expect(result.normalizedConfig.tiers.heavy.models).toContain('glm-4-flash');
            expect(result.normalizedConfig.tiers.heavy.models).toContain('glm-4-plus');
            expect(result.normalizedConfig.tiers.heavy.models).toContain('glm-4.7');
            expect(result.normalizedConfig.tiers.heavy.targetModel).toBeUndefined();
            expect(result.normalizedConfig.tiers.heavy.fallbackModels).toBeUndefined();
            expect(result.normalizedConfig.tiers.heavy.failoverModel).toBeUndefined();
        });

        test('v2 config passes through unchanged', () => {
            const { normalizeModelRoutingConfig } = require('../lib/model-router-normalizer');

            const v2Config = {
                version: '2.0',
                enabled: true,
                tiers: {
                    heavy: {
                        models: ['glm-4-flash', 'glm-4-plus'],
                        strategy: 'balanced'
                    }
                }
            };

            const result = normalizeModelRoutingConfig(v2Config);

            expect(result.migrated).toBe(false);
            // Normalizer adds version if missing and ensures all tiers have models[]
            expect(result.normalizedConfig.version).toBe('2.0');
            expect(result.normalizedConfig.tiers.heavy.models).toEqual(['glm-4-flash', 'glm-4-plus']);
            expect(result.normalizedConfig.tiers.heavy.strategy).toBe('balanced');
        });
    });
});
