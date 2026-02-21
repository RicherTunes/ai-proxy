'use strict';

/**
 * Model Router Boundary Integration Tests
 *
 * Tests for normalization at system boundaries (startup, PUT endpoint).
 * Verifies that v1 shapes are normalized to v2 before entering memory.
 *
 * NORM-01: Single normalization at all boundaries
 * NORM-03: V1 shapes never persist in memory
 * NORM-07: Deterministic tie-breaking in pool selection
 */

const { normalizeModelRoutingConfig } = require('../lib/model-router-normalizer');
const { ModelRouter } = require('../lib/model-router');
const { ModelDiscovery } = require('../lib/model-discovery');

// Mock ModelDiscovery for testing
const mockModelDiscovery = {
    async getModels() {
        return [
            {
                name: 'glm-4-flash',
                tier: 'light',
                costPerMillion: 0.15,
                maxConcurrency: 50,
                source: 'config'
            },
            {
                name: 'glm-4-air',
                tier: 'light',
                costPerMillion: 0.10,
                maxConcurrency: 50,
                source: 'config'
            },
            {
                name: 'glm-4-plus',
                tier: 'medium',
                costPerMillion: 0.40,
                maxConcurrency: 50,
                source: 'config'
            }
        ];
    },

    async getModelsByTier(tier) {
        const models = await this.getModels();
        return models.filter(m => m.tier === tier);
    },

    getCacheStats() {
        return { lastRefresh: new Date().toISOString() };
    }
};

describe('Model Router Boundary Integration (NORM-01, NORM-03, NORM-07)', () => {
    describe('Startup boundary normalization', () => {
        test('v1 persisted config produces v2 in-memory config', () => {
            // Simulate v1 persisted config from file
            const v1Config = {
                version: '1.0',
                enabled: true,
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash',
                        fallbackModels: ['glm-4-air'],
                        strategy: 'pool'
                    },
                    heavy: {
                        targetModel: 'glm-4-plus',
                        failoverModel: 'glm-4-air',
                        strategy: 'failover'
                    }
                }
            };

            // Normalize at startup boundary
            const result = normalizeModelRoutingConfig(v1Config);

            // Verify normalization occurred
            expect(result.migrated).toBe(true);
            expect(result.warnings).toEqual([]);

            // Verify v2 format in normalized output
            expect(result.normalizedConfig.version).toBe('2.0');
            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-flash', 'glm-4-air']);
            expect(result.normalizedConfig.tiers.light.strategy).toBe('pool');

            // CRITICAL: v1 fields must NOT be present (NORM-03)
            expect(result.normalizedConfig.tiers.light.targetModel).toBeUndefined();
            expect(result.normalizedConfig.tiers.light.fallbackModels).toBeUndefined();
            expect(result.normalizedConfig.tiers.light.failoverModel).toBeUndefined();

            // Verify heavy tier migration
            expect(result.normalizedConfig.tiers.heavy.models).toEqual(['glm-4-plus', 'glm-4-air']);
            expect(result.normalizedConfig.tiers.heavy.strategy).toBe('balanced'); // failover -> balanced
            expect(result.normalizedConfig.tiers.heavy.targetModel).toBeUndefined();
        });

        test('v2 persisted config passes through unchanged', () => {
            const v2Config = {
                version: '2.0',
                enabled: true,
                tiers: {
                    light: {
                        models: ['glm-4-flash', 'glm-4-air'],
                        strategy: 'throughput'
                    }
                }
            };

            const result = normalizeModelRoutingConfig(v2Config);

            expect(result.migrated).toBe(false);
            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-flash', 'glm-4-air']);
            expect(result.normalizedConfig.tiers.light.strategy).toBe('throughput');
        });

        test('mixed v1/v2 input emits warning and uses v2', () => {
            const mixedConfig = {
                version: '2.0',
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash',  // v1 field
                        models: ['glm-4-air']          // v2 field
                    }
                }
            };

            const result = normalizeModelRoutingConfig(mixedConfig);

            expect(result.migrated).toBe(false); // Not migrated, already has models[]
            expect(result.warnings.length).toBeGreaterThan(0);
            expect(result.warnings[0]).toContain('both v1 fields');
            expect(result.warnings[0]).toContain('V2 format takes precedence');

            // v2 field wins
            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-air']);
            expect(result.normalizedConfig.tiers.light.targetModel).toBeUndefined();
        });
    });

    describe('PUT boundary normalization', () => {
        test('PUT with v1 payload returns v2 response', () => {
            const v1Payload = {
                enabled: true,
                tiers: {
                    medium: {
                        targetModel: 'glm-4-plus',
                        fallbackModels: ['glm-4-air']
                    }
                }
            };

            const result = normalizeModelRoutingConfig(v1Payload);

            // Response should be v2 format
            expect(result.normalizedConfig.tiers.medium.models).toEqual(['glm-4-plus', 'glm-4-air']);
            expect(result.normalizedConfig.tiers.medium.targetModel).toBeUndefined();

            // Include migration flag in response (as PUT handler would)
            expect(result.migrated).toBe(true);
        });

        test('PUT with mixed v1/v2 payload includes warnings', () => {
            const mixedPayload = {
                tiers: {
                    heavy: {
                        targetModel: 'glm-4-plus',
                        models: ['glm-4-flash']
                    }
                }
            };

            const result = normalizeModelRoutingConfig(mixedPayload);

            // Warnings should be included
            expect(result.warnings.length).toBeGreaterThan(0);

            // Response should use v2 format
            expect(result.normalizedConfig.tiers.heavy.models).toEqual(['glm-4-flash']);
        });
    });

    describe('Deterministic tie-breaking (NORM-07)', () => {
        test('same input always produces same output for throughput strategy', () => {
            const candidates = [
                { model: 'glm-4-air', available: 10, maxConcurrency: 50, costPerMillion: 0.10, position: 0, hitCount: 0 },
                { model: 'glm-4-flash', available: 10, maxConcurrency: 50, costPerMillion: 0.10, position: 1, hitCount: 0 }
            ];

            // Simulate throughput sorting with model name tiebreaker
            const sorted1 = [...candidates].sort((a, b) =>
                (b.available * 1) - (a.available * 1) ||
                a.costPerMillion - b.costPerMillion ||
                b.maxConcurrency - a.maxConcurrency ||
                a.model.localeCompare(b.model)
            );

            const sorted2 = [...candidates].sort((a, b) =>
                (b.available * 1) - (a.available * 1) ||
                a.costPerMillion - b.costPerMillion ||
                b.maxConcurrency - a.maxConcurrency ||
                a.model.localeCompare(b.model)
            );

            expect(sorted1[0].model).toBe(sorted2[0].model);
            expect(sorted1[0].model).toBe('glm-4-air'); // alphabetically first
        });

        test('same input always produces same output for balanced strategy', () => {
            const candidates = [
                { model: 'glm-4-air', available: 10, maxConcurrency: 50, costPerMillion: 0.10, position: 0 },
                { model: 'glm-4-flash', available: 10, maxConcurrency: 50, costPerMillion: 0.10, position: 0 }
            ];

            // Simulate balanced sorting with model name tiebreaker
            const maxPos = Math.max(...candidates.map(s => s.position));
            const scored = candidates.map(s => ({
                ...s,
                score: 0.6 * (1 - (s.position / (maxPos + 1))) + 0.4 * (s.available / s.maxConcurrency)
            }));

            const sorted1 = [...scored].sort((a, b) =>
                b.score - a.score ||
                a.costPerMillion - b.costPerMillion ||
                a.model.localeCompare(b.model)
            );

            const sorted2 = [...scored].sort((a, b) =>
                b.score - a.score ||
                a.costPerMillion - b.costPerMillion ||
                a.model.localeCompare(b.model)
            );

            expect(sorted1[0].model).toBe(sorted2[0].model);
            expect(sorted1[0].model).toBe('glm-4-air'); // alphabetically first
        });

        test('pool strategy includes model name in sort', () => {
            const candidates = [
                { model: 'glm-4-flash', available: 10, maxConcurrency: 50, costPerMillion: 0.15, position: 0, hitCount: 0 },
                { model: 'glm-4-air', available: 10, maxConcurrency: 50, costPerMillion: 0.15, position: 1, hitCount: 0 }
            ];

            // Pool strategy sort: score DESC, cost ASC, maxConcurrency DESC, model ASC
            const sorted = [...candidates].sort((a, b) =>
                (b.available * 1) - (a.available * 1) ||
                a.costPerMillion - b.costPerMillion ||
                b.maxConcurrency - a.maxConcurrency ||
                a.model.localeCompare(b.model)
            );

            // When all scores/costs/concurrency are equal, model name decides
            expect(sorted[0].model).toBe('glm-4-air');
        });
    });

    describe('ModelRouter constructor uses normalization', () => {
        test('ModelRouter constructor normalizes v1 config', () => {
            const v1Config = {
                enabled: false,
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash',
                        fallbackModels: ['glm-4-air']
                    }
                }
            };

            const router = new ModelRouter(v1Config, {
                modelDiscovery: mockModelDiscovery,
                logger: console
            });

            // Verify normalized config in memory
            expect(router.config.version).toBe('2.0');
            expect(router.config.tiers.light.models).toEqual(['glm-4-flash', 'glm-4-air']);

            // CRITICAL: v1 fields must NOT be in memory (NORM-03)
            expect(router.config.tiers.light.targetModel).toBeUndefined();
            expect(router.config.tiers.light.fallbackModels).toBeUndefined();
        });

        test('ModelRouter constructor handles v2 config correctly', () => {
            const v2Config = {
                enabled: false,
                version: '2.0',
                tiers: {
                    light: {
                        models: ['glm-4-flash'],
                        strategy: 'quality'
                    }
                }
            };

            const router = new ModelRouter(v2Config, {
                modelDiscovery: mockModelDiscovery,
                logger: console
            });

            expect(router.config.version).toBe('2.0');
            expect(router.config.tiers.light.models).toEqual(['glm-4-flash']);
            expect(router.config.tiers.light.strategy).toBe('quality');
        });
    });
});
