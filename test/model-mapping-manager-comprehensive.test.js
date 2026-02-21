/**
 * Model Mapping Manager - Comprehensive Tests
 *
 * TDD: Comprehensive test suite for ModelMappingManager covering:
 * - Stats tracking (totalTransformations, bySourceModel)
 * - Edge cases (null, undefined, empty strings, special characters)
 * - Integration scenarios (concurrent updates, model lifecycle)
 * - Error conditions and validation
 */

const { ModelMappingManager } = require('../lib/config');

describe('ModelMappingManager - Comprehensive Tests', () => {
    describe('Stats tracking', () => {
        let manager;

        beforeEach(() => {
            manager = new ModelMappingManager({
                enabled: true,
                models: {
                    'claude-opus-4-6': 'glm-4.7',
                    'claude-sonnet-4-5-20250929': 'glm-4.6',
                    'claude-haiku-4-5-20251001': 'glm-4.5-air'
                }
            });
        });

        test('should track total transformations when mapping occurs', () => {
            manager.getMappedModel('claude-opus-4-6');

            const stats = manager.getStats();
            expect(stats.totalTransformations).toBe(1);
        });

        test('should track transformations per source model', () => {
            manager.getMappedModel('claude-opus-4-6');
            manager.getMappedModel('claude-opus-4-6');
            manager.getMappedModel('claude-sonnet-4-5-20250929');

            const stats = manager.getStats();
            expect(stats.bySourceModel['claude-opus-4-6']).toBe(2);
            expect(stats.bySourceModel['claude-sonnet-4-5-20250929']).toBe(1);
        });

        test('should not track when no transformation occurs (pass-through)', () => {
            manager.getMappedModel('unknown-model');

            const stats = manager.getStats();
            expect(stats.totalTransformations).toBe(0);
            expect(stats.bySourceModel['unknown-model']).toBeUndefined();
        });

        test('should not track when disabled', () => {
            manager.enabled = false;
            manager.getMappedModel('claude-opus-4-6');

            const stats = manager.getStats();
            expect(stats.totalTransformations).toBe(0);
        });

        test('should track per-key override transformations separately', () => {
            manager.setKeyOverride(0, 'claude-opus-4-6', 'glm-4.7-custom');

            manager.getMappedModel('claude-opus-4-6', 0); // Uses override
            manager.getMappedModel('claude-opus-4-6', 1); // Uses global mapping

            const stats = manager.getStats();
            expect(stats.totalTransformations).toBe(2);
            expect(stats.bySourceModel['claude-opus-4-6']).toBe(2);
        });

        test('should track default model transformations', () => {
            manager.defaultModel = 'glm-4.7-default';
            manager.getMappedModel('unknown-model');

            const stats = manager.getStats();
            expect(stats.totalTransformations).toBe(1);
        });

        test('should reset stats when resetStats is called', () => {
            manager.getMappedModel('claude-opus-4-6');
            manager.getMappedModel('claude-sonnet-4-5-20250929');

            manager.resetStats();

            const stats = manager.getStats();
            expect(stats.totalTransformations).toBe(0);
            expect(stats.bySourceModel).toEqual({});
        });

        test('should include stats in toConfig export', () => {
            manager.getMappedModel('claude-opus-4-6');

            const config = manager.toConfig();
            expect(config.stats).toBeDefined();
            expect(config.stats.totalTransformations).toBe(1);
        });
    });

    describe('Edge cases - null and undefined handling', () => {
        let manager;

        beforeEach(() => {
            manager = new ModelMappingManager({
                enabled: true,
                models: { 'test-model': 'test-target' },
                defaultModel: 'default-target'
            });
        });

        test('should return null when input is null', () => {
            expect(manager.getMappedModel(null)).toBeNull();
        });

        test('should return undefined when input is undefined', () => {
            expect(manager.getMappedModel(undefined)).toBeUndefined();
        });

        test('should handle empty string model name', () => {
            const result = manager.getMappedModel('');
            expect(result).toBe('');
        });

        test('should handle whitespace-only model name - maps to default when set', () => {
            // Whitespace-only model name is truthy but has no mapping
            // With defaultModel set, it will be mapped to default
            const result = manager.getMappedModel('   ');
            expect(result).toBe('default-target');
        });

        test('should handle model name with special characters', () => {
            manager.models['model-with-special-chars_123'] = 'target-123';
            const result = manager.getMappedModel('model-with-special-chars_123');
            expect(result).toBe('target-123');
        });

        test('should handle model name with Unicode characters', () => {
            manager.models['模型-测试'] = 'glm-测试';
            const result = manager.getMappedModel('模型-测试');
            expect(result).toBe('glm-测试');
        });

        test('should handle very long model names - maps to default when set', () => {
            const longName = 'a'.repeat(1000);
            // Long name with no mapping falls back to defaultModel
            const result = manager.getMappedModel(longName);
            expect(result).toBe('default-target');
        });

        test('should handle keyIndex of 0 explicitly', () => {
            manager.setKeyOverride(0, 'test-model', 'custom-target');
            expect(manager.getMappedModel('test-model', 0)).toBe('custom-target');
        });

        test('should handle negative keyIndex gracefully', () => {
            manager.setKeyOverride(-1, 'test-model', 'negative-target');
            expect(manager.getMappedModel('test-model', -1)).toBe('negative-target');
        });

        test('should handle very large keyIndex', () => {
            manager.setKeyOverride(999999, 'test-model', 'large-index-target');
            expect(manager.getMappedModel('test-model', 999999)).toBe('large-index-target');
        });
    });

    describe('Edge cases - Configuration validation', () => {
        test('should handle empty models object', () => {
            const manager = new ModelMappingManager({
                enabled: true,
                models: {}
            });

            expect(manager.getMappedModel('any-model')).toBe('any-model');
        });

        test('should handle null models in config', () => {
            const manager = new ModelMappingManager({
                enabled: true,
                models: null
            });

            expect(manager.getMappedModel('test-model')).toBe('test-model');
        });

        test('should handle undefined models in config', () => {
            const manager = new ModelMappingManager({
                enabled: true,
                models: undefined
            });

            expect(manager.getMappedModel('test-model')).toBe('test-model');
        });

        test('should handle non-string model values in config - null values fall through', () => {
            const manager = new ModelMappingManager({
                enabled: true,
                models: {
                    'valid': 'target',
                    'null-target': null,
                    'number-target': 123,
                    'object-target': { value: 'test' }
                },
                defaultModel: 'default-target'
            });

            expect(manager.getMappedModel('valid')).toBe('target');
            // null is falsy, so it falls through to default
            expect(manager.getMappedModel('null-target')).toBe('default-target');
            // number is truthy, so it's used
            expect(manager.getMappedModel('number-target')).toBe(123);
            // object is truthy, so it's used
            expect(manager.getMappedModel('object-target')).toEqual({ value: 'test' });
        });

        test('should handle defaultModel set to empty string - treated as no default', () => {
            const manager = new ModelMappingManager({
                enabled: true,
                models: {},
                defaultModel: ''
            });

            // Empty string is falsy, so it acts like no default is set
            expect(manager.getMappedModel('unknown-model')).toBe('unknown-model');
        });

        test('should handle defaultModel set to null', () => {
            const manager = new ModelMappingManager({
                enabled: true,
                models: {},
                defaultModel: null
            });

            expect(manager.getMappedModel('unknown-model')).toBe('unknown-model');
        });
    });

    describe('Integration scenarios - Model lifecycle', () => {
        let manager;

        beforeEach(() => {
            manager = new ModelMappingManager({
                enabled: true,
                models: {}
            });
        });

        test('should handle adding mappings incrementally', () => {
            // Start with no mappings
            expect(manager.getMappedModel('model-1')).toBe('model-1');

            // Add first mapping
            manager.updateGlobalMapping({
                models: { 'model-1': 'target-1' }
            });
            expect(manager.getMappedModel('model-1')).toBe('target-1');

            // Add second mapping without removing first
            manager.updateGlobalMapping({
                models: { 'model-1': 'target-1', 'model-2': 'target-2' }
            });
            expect(manager.getMappedModel('model-1')).toBe('target-1');
            expect(manager.getMappedModel('model-2')).toBe('target-2');
        });

        test('should handle changing mappings over time', () => {
            manager.updateGlobalMapping({
                models: { 'stable-model': 'target-v1' }
            });
            expect(manager.getMappedModel('stable-model')).toBe('target-v1');

            // Update to v2
            manager.updateGlobalMapping({
                models: { 'stable-model': 'target-v2' }
            });
            expect(manager.getMappedModel('stable-model')).toBe('target-v2');

            // Remove mapping
            manager.updateGlobalMapping({
                models: {}
            });
            expect(manager.getMappedModel('stable-model')).toBe('stable-model');
        });

        test('should handle toggling enabled state', () => {
            manager.updateGlobalMapping({
                enabled: true,
                models: { 'test': 'target' }
            });

            expect(manager.getMappedModel('test')).toBe('target');

            manager.updateGlobalMapping({ enabled: false });
            expect(manager.getMappedModel('test')).toBe('test');

            manager.updateGlobalMapping({ enabled: true });
            expect(manager.getMappedModel('test')).toBe('target');
        });

        test('should handle complex mapping chain', () => {
            // Setup base mappings
            manager.updateGlobalMapping({
                models: {
                    'opus': 'glm-4.7',
                    'sonnet': 'glm-4.6',
                    'haiku': 'glm-4.5-air'
                },
                defaultModel: 'glm-4.5-flash'
            });

            // Add key-specific override
            manager.setKeyOverride(0, 'opus', 'glm-4.7-custom');

            // Verify priority chain
            expect(manager.getMappedModel('opus', 0)).toBe('glm-4.7-custom'); // Key override
            expect(manager.getMappedModel('opus', 1)).toBe('glm-4.7'); // Global mapping
            expect(manager.getMappedModel('sonnet')).toBe('glm-4.6'); // Global mapping
            expect(manager.getMappedModel('unknown')).toBe('glm-4.5-flash'); // Default
        });
    });

    describe('Integration scenarios - Concurrent updates', () => {
        test('should handle multiple key override updates', () => {
            const manager = new ModelMappingManager({ enabled: true });

            // Simulate concurrent updates
            for (let i = 0; i < 10; i++) {
                manager.setKeyOverride(i, `model-${i}`, `target-${i}`);
            }

            const overrides = manager.getKeyOverrides();
            expect(Object.keys(overrides)).toHaveLength(10);
            expect(overrides[0]['model-0']).toBe('target-0');
            expect(overrides[9]['model-9']).toBe('target-9');
        });

        test('should handle rapid global mapping updates', () => {
            const manager = new ModelMappingManager({ enabled: true });

            // Simulate rapid config changes
            for (let i = 0; i < 5; i++) {
                manager.updateGlobalMapping({
                    models: { [`model-${i}`]: `target-${i}` }
                });
            }

            // Last update should win
            expect(manager.getMappedModel('model-4')).toBe('target-4');
            expect(Object.keys(manager.models)).toHaveLength(1);
        });

        test('should handle interleaved key and global updates', () => {
            const manager = new ModelMappingManager({
                enabled: true,
                models: { 'base': 'base-target' }
            });

            manager.setKeyOverride(0, 'base', 'override-1');
            expect(manager.getMappedModel('base', 0)).toBe('override-1');

            manager.updateGlobalMapping({
                models: { 'base': 'base-target-v2' }
            });
            // Key override should still take precedence
            expect(manager.getMappedModel('base', 0)).toBe('override-1');
            expect(manager.getMappedModel('base', 1)).toBe('base-target-v2');
        });
    });

    describe('Per-key override edge cases', () => {
        let manager;

        beforeEach(() => {
            manager = new ModelMappingManager({ enabled: true });
        });

        test('should handle empty override object', () => {
            manager.setKeyOverride(0, 'model', 'target');
            manager.clearKeyOverride(0, 'model');

            expect(manager.getKeyOverride(0)).toBeNull();
        });

        test('should handle setting same override multiple times', () => {
            manager.setKeyOverride(0, 'model', 'target-v1');
            expect(manager.getKeyOverride(0)['model']).toBe('target-v1');

            manager.setKeyOverride(0, 'model', 'target-v2');
            expect(manager.getKeyOverride(0)['model']).toBe('target-v2');

            // Should only have one entry, not duplicates
            expect(Object.keys(manager.getKeyOverride(0))).toHaveLength(1);
        });

        test('should handle clearing non-existent model override', () => {
            manager.setKeyOverride(0, 'model-a', 'target-a');
            manager.clearKeyOverride(0, 'model-b'); // Doesn't exist

            expect(manager.getKeyOverride(0)).toEqual({ 'model-a': 'target-a' });
        });

        test('should handle clearing override from non-existent key', () => {
            expect(() => manager.clearKeyOverride(999)).not.toThrow();
            expect(() => manager.clearKeyOverride(999, 'model')).not.toThrow();
        });

        test('should handle getting override for non-existent key', () => {
            expect(manager.getKeyOverride(999)).toBeNull();
        });
    });

    describe('Reset scenarios', () => {
        test('should clear all state when reset', () => {
            const manager = new ModelMappingManager({
                enabled: true,
                models: { 'test': 'target' },
                defaultModel: 'default'
            });

            manager.setKeyOverride(0, 'test', 'override');
            manager.getMappedModel('test'); // Generate stats

            manager.resetToDefaults({
                enabled: false,
                models: {},
                defaultModel: null,
                logTransformations: true
            });

            expect(manager.enabled).toBe(false);
            expect(manager.models).toEqual({});
            expect(manager.defaultModel).toBeNull();
            expect(manager.getKeyOverrides()).toEqual({});
            expect(manager.getStats().totalTransformations).toBe(0);
        });

        test('should preserve stats when only updating config', () => {
            const manager = new ModelMappingManager({
                enabled: true,
                models: { 'test': 'target' }
            });

            manager.getMappedModel('test');
            expect(manager.getStats().totalTransformations).toBe(1);

            manager.updateGlobalMapping({
                models: { 'new-test': 'new-target' }
            });

            // Stats should be preserved
            expect(manager.getStats().totalTransformations).toBe(1);
        });

        test('should clear stats when resetStats is called', () => {
            const manager = new ModelMappingManager({
                enabled: true,
                models: { 'test': 'target' }
            });

            manager.getMappedModel('test');
            manager.getMappedModel('test');
            expect(manager.getStats().totalTransformations).toBe(2);

            manager.resetStats();
            expect(manager.getStats().totalTransformations).toBe(0);
        });
    });

    describe('Log transformations behavior', () => {
        test('should respect logTransformations flag', () => {
            const manager = new ModelMappingManager({
                enabled: true,
                models: { 'test': 'target' },
                logTransformations: false
            });

            expect(manager.logTransformations).toBe(false);

            manager.updateGlobalMapping({ logTransformations: true });
            expect(manager.logTransformations).toBe(true);
        });

        test('should default logTransformations to true', () => {
            const manager = new ModelMappingManager();
            expect(manager.logTransformations).toBe(true);
        });
    });

    describe('toConfig export edge cases', () => {
        test('should export immutable copies', () => {
            const manager = new ModelMappingManager({
                enabled: true,
                models: { 'test': 'target' }
            });

            const config1 = manager.toConfig();
            const config2 = manager.toConfig();

            // Modifying one export should not affect the other
            config1.models['test'] = 'modified';
            expect(config2.models['test']).toBe('target');
            expect(manager.models['test']).toBe('target');
        });

        test('should export all properties including stats', () => {
            const manager = new ModelMappingManager({
                enabled: true,
                models: { 'test': 'target' },
                defaultModel: 'default',
                logTransformations: false
            });

            manager.setKeyOverride(0, 'test', 'override');
            manager.getMappedModel('test');

            const config = manager.toConfig();

            expect(config).toHaveProperty('enabled');
            expect(config).toHaveProperty('models');
            expect(config).toHaveProperty('defaultModel');
            expect(config).toHaveProperty('logTransformations');
            expect(config).toHaveProperty('stats');
            expect(config.stats).toHaveProperty('totalTransformations');
            expect(config.stats).toHaveProperty('bySourceModel');
        });

        test('should handle exporting with no overrides', () => {
            const manager = new ModelMappingManager({ enabled: true });
            const config = manager.toConfig();

            expect(config.models).toEqual({});
            expect(config.enabled).toBe(true);
        });
    });

    describe('Performance and scale', () => {
        test('should handle large number of mappings efficiently', () => {
            const largeModels = {};
            for (let i = 0; i < 1000; i++) {
                largeModels[`model-${i}`] = `target-${i}`;
            }

            const manager = new ModelMappingManager({
                enabled: true,
                models: largeModels
            });

            expect(manager.getMappedModel('model-0')).toBe('target-0');
            expect(manager.getMappedModel('model-999')).toBe('target-999');
            expect(manager.getMappedModel('model-500')).toBe('target-500');
        });

        test('should handle large number of key overrides', () => {
            const manager = new ModelMappingManager({
                enabled: true,
                models: { 'shared-model': 'shared-target' }
            });

            // Add overrides for 100 keys
            for (let i = 0; i < 100; i++) {
                manager.setKeyOverride(i, 'shared-model', `target-${i}`);
            }

            expect(manager.getKeyOverride(0)['shared-model']).toBe('target-0');
            expect(manager.getKeyOverride(99)['shared-model']).toBe('target-99');
            expect(Object.keys(manager.getKeyOverrides())).toHaveLength(100);
        });

        test('should handle large stats history', () => {
            const manager = new ModelMappingManager({
                enabled: true,
                models: { 'test': 'target' }
            });

            // Generate many transformations
            for (let i = 0; i < 10000; i++) {
                manager.getMappedModel('test');
            }

            const stats = manager.getStats();
            expect(stats.totalTransformations).toBe(10000);
            expect(stats.bySourceModel['test']).toBe(10000);
        });
    });
});
