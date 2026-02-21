/**
 * Config Module Tests
 */

const path = require('path');
const fs = require('fs');
const { Config, getConfig, resetConfig, DEFAULT_CONFIG } = require('../lib/config');

describe('Config', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        resetConfig();
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe('DEFAULT_CONFIG', () => {
        test('should have all expected defaults', () => {
            expect(DEFAULT_CONFIG.port).toBe(18765);
            expect(DEFAULT_CONFIG.host).toBe('127.0.0.1');
            expect(DEFAULT_CONFIG.maxRetries).toBe(3);
            expect(DEFAULT_CONFIG.maxConcurrencyPerKey).toBe(5);
            expect(DEFAULT_CONFIG.maxTotalConcurrency).toBe(200);
            expect(DEFAULT_CONFIG.maxBodySize).toBe(10 * 1024 * 1024);
            expect(DEFAULT_CONFIG.circuitBreaker.failureThreshold).toBe(5);
        });

        test('freeSocketTimeout should be 8000ms to prevent socket hangups from stale idle sockets', () => {
            expect(DEFAULT_CONFIG.freeSocketTimeout).toBe(8000);
        });

        test('poolCooldown capMs should allow longer backoff for persistent upstream throttling', () => {
            // capMs must be >= 15000 to handle persistent 429s from upstream
            // With baseMs and exponential backoff: count 6 reaches ~10s, count 7 caps at 15s
            expect(DEFAULT_CONFIG.poolCooldown.capMs).toBeGreaterThanOrEqual(15000);
            expect(DEFAULT_CONFIG.poolCooldown.maxCooldownMs).toBeGreaterThanOrEqual(10000);
        });

        test('poolCooldown decayMs should be slow enough to sustain backoff under persistent throttling', () => {
            // decayMs should be >= 15s so count doesn't reset too quickly during sustained 429s
            expect(DEFAULT_CONFIG.poolCooldown.decayMs).toBeGreaterThanOrEqual(15000);
        });

        test('modelRouting should be enabled with fallback chains for 429 resilience', () => {
            expect(DEFAULT_CONFIG.modelRouting.enabled).toBe(true);
            // Medium tier: exclusive models (no overlap with heavy or light)
            const medium = DEFAULT_CONFIG.modelRouting.tiers.medium;
            expect(medium.models[0]).toBe('glm-4.5');
            expect(medium.models).not.toContain('glm-4.5-airx');  // Removed: error 1113 on Coding Plan
            // Heavy tier should have fallback models
            const heavy = DEFAULT_CONFIG.modelRouting.tiers.heavy;
            expect(heavy.models[0]).toBe('glm-5');
            expect(heavy.models.length).toBeGreaterThan(1);
        });

        test('modelRouting rules must map claude model names to tiers so router activates', () => {
            const rules = DEFAULT_CONFIG.modelRouting.rules;
            expect(rules.length).toBeGreaterThan(0);

            // Must have rules for all three claude model families
            const ruleModels = rules.map(r => r.match?.model);

            // opus → heavy
            const opusRule = rules.find(r => r.match?.model?.includes('opus'));
            expect(opusRule).toBeDefined();
            expect(opusRule.tier).toBe('heavy');

            // sonnet → medium (base family rule, without extra conditions like hasTools)
            const sonnetRule = rules.find(r =>
                r.match?.model?.includes('sonnet') && !r.match.hasTools && !r.match.hasVision && !r.match.maxTokensGte
            );
            expect(sonnetRule).toBeDefined();
            expect(sonnetRule.tier).toBe('medium');

            // haiku → light
            const haikuRule = rules.find(r => r.match?.model?.includes('haiku'));
            expect(haikuRule).toBeDefined();
            expect(haikuRule.tier).toBe('light');
        });

        test('heavy tier should have exclusive models (no cross-tier overlap)', () => {
            const heavy = DEFAULT_CONFIG.modelRouting.tiers.heavy;
            const medium = DEFAULT_CONFIG.modelRouting.tiers.medium;
            const light = DEFAULT_CONFIG.modelRouting.tiers.light;
            // Heavy models must not include medium primary or light primary
            expect(heavy.models).not.toContain(medium.models[0]);
            expect(heavy.models).not.toContain(light.models[0]);
            // Heavy should have at least 2 models (primary + fallback)
            expect(heavy.models.length).toBeGreaterThanOrEqual(2);
        });

        test('medium tier should have exclusive models (no cross-tier overlap)', () => {
            const medium = DEFAULT_CONFIG.modelRouting.tiers.medium;
            const light = DEFAULT_CONFIG.modelRouting.tiers.light;
            // Medium models must not include light primary
            expect(medium.models).not.toContain(light.models[0]);
        });

        test('maxModelSwitchesPerRequest should allow trying all heavy-tier candidates', () => {
            const failover = DEFAULT_CONFIG.modelRouting.failover;
            // With 2 heavy candidates (glm-4.7, glm-4.6), need >= 2 switches
            expect(failover.maxModelSwitchesPerRequest).toBeGreaterThanOrEqual(2);
        });

        test('light tier models should not include models that return 400 errors', () => {
            const light = DEFAULT_CONFIG.modelRouting.tiers.light;
            // glm-4.32b-0414-128k returns 400 with Anthropic API format
            expect(light.models).not.toContain('glm-4.32b-0414-128k');
        });

        test('all tiers should use rule-match-only to prevent classifier promoting to heavy', () => {
            const tiers = DEFAULT_CONFIG.modelRouting.tiers;
            for (const [name, tier] of Object.entries(tiers)) {
                expect(tier.clientModelPolicy).toBe('rule-match-only');
            }
        });

        test('rules should have a catch-all for unknown models', () => {
            const rules = DEFAULT_CONFIG.modelRouting.rules;
            const lastRule = rules[rules.length - 1];
            // Last rule should be an empty match (catch-all)
            expect(Object.keys(lastRule.match)).toHaveLength(0);
            expect(lastRule.tier).toBe('medium');
        });

        test('maxConcurrencyPerKey should not be the bottleneck (per-model gate is the real limiter)', () => {
            // With 20 keys, total key slots = maxConcurrencyPerKey * 20
            // This must exceed per-model capacity so the model gate is what actually limits
            // Per-model caps: glm-4.7(10) + glm-4.6(8) + glm-4.5(10) + glm-4.5-air(10) + glm-4.5-flash(2) + glm-4.7-flash(1) = 41
            // But not too high (>10) or upstream gets overwhelmed with connections
            expect(DEFAULT_CONFIG.maxConcurrencyPerKey).toBeGreaterThanOrEqual(5);
            expect(DEFAULT_CONFIG.maxConcurrencyPerKey).toBeLessThanOrEqual(10);
            // Total key slots should exceed model capacity by at least 2x
            const totalKeySlots = DEFAULT_CONFIG.maxConcurrencyPerKey * 20;
            expect(totalKeySlots).toBeGreaterThanOrEqual(100);
        });
    });

    describe('constructor', () => {
        test('should use defaults when no overrides', () => {
            // Mock the keys file
            const mockKeysPath = path.join(__dirname, '..', 'api-keys.json');
            if (!fs.existsSync(mockKeysPath)) {
                jest.spyOn(fs, 'existsSync').mockReturnValue(false);
            }

            const config = new Config();
            expect(config.port).toBe(DEFAULT_CONFIG.port);
            expect(config.host).toBe(DEFAULT_CONFIG.host);
        });

        test('should apply overrides', () => {
            jest.spyOn(fs, 'existsSync').mockReturnValue(false);

            const config = new Config({
                port: 9999,
                maxRetries: 5
            });

            expect(config.port).toBe(9999);
            expect(config.maxRetries).toBe(5);
        });

        test('should merge nested overrides', () => {
            jest.spyOn(fs, 'existsSync').mockReturnValue(false);

            const config = new Config({
                circuitBreaker: {
                    failureThreshold: 10
                }
            });

            expect(config.circuitBreaker.failureThreshold).toBe(10);
            expect(config.circuitBreaker.cooldownPeriod).toBe(DEFAULT_CONFIG.circuitBreaker.cooldownPeriod);
        });
    });

    describe('environment variable overrides', () => {
        beforeEach(() => {
            jest.spyOn(fs, 'existsSync').mockReturnValue(false);
        });

        test('should override port from GLM_PORT', () => {
            process.env.GLM_PORT = '8080';
            const config = new Config();
            expect(config.port).toBe(8080);
        });

        test('should override host from GLM_HOST', () => {
            process.env.GLM_HOST = '0.0.0.0';
            const config = new Config();
            expect(config.host).toBe('0.0.0.0');
        });

        test('should disable cluster from NO_CLUSTER', () => {
            process.env.NO_CLUSTER = '1';
            const config = new Config();
            expect(config.useCluster).toBe(false);
        });

        test('should disable cluster from GLM_NO_CLUSTER', () => {
            process.env.GLM_NO_CLUSTER = 'true';
            const config = new Config();
            expect(config.useCluster).toBe(false);
        });

        test('should override max retries from GLM_MAX_RETRIES', () => {
            process.env.GLM_MAX_RETRIES = '10';
            const config = new Config();
            expect(config.maxRetries).toBe(10);
        });

        test('should override circuit breaker threshold', () => {
            process.env.GLM_CIRCUIT_THRESHOLD = '10';
            const config = new Config();
            expect(config.circuitBreaker.failureThreshold).toBe(10);
        });

        test('should override log level from GLM_LOG_LEVEL', () => {
            process.env.GLM_LOG_LEVEL = 'DEBUG';
            const config = new Config();
            expect(config.logLevel).toBe('DEBUG');
        });
    });

    describe('get method', () => {
        beforeEach(() => {
            jest.spyOn(fs, 'existsSync').mockReturnValue(false);
        });

        test('should get top-level config values', () => {
            const config = new Config();
            expect(config.get('port')).toBe(DEFAULT_CONFIG.port);
        });

        test('should get nested config values', () => {
            const config = new Config();
            expect(config.get('circuitBreaker.failureThreshold')).toBe(DEFAULT_CONFIG.circuitBreaker.failureThreshold);
        });

        test('should return undefined for missing nested keys', () => {
            const config = new Config();
            expect(config.get('missing.nested.key')).toBeUndefined();
        });
    });

    describe('getAll method', () => {
        test('should return copy of all config', () => {
            jest.spyOn(fs, 'existsSync').mockReturnValue(false);

            const config = new Config();
            const all = config.getAll();

            expect(all.port).toBe(DEFAULT_CONFIG.port);
            // Should be a copy, not the original
            all.port = 9999;
            expect(config.port).toBe(DEFAULT_CONFIG.port);
        });
    });

    describe('convenience getters', () => {
        beforeEach(() => {
            jest.spyOn(fs, 'existsSync').mockReturnValue(false);
        });

        test('should have all convenience getters', () => {
            const config = new Config();

            expect(config.port).toBeDefined();
            expect(config.host).toBeDefined();
            expect(config.targetHost).toBeDefined();
            expect(config.targetBasePath).toBeDefined();
            expect(config.maxWorkers).toBeDefined();
            expect(config.useCluster).toBeDefined();
            expect(config.maxRetries).toBeDefined();
            expect(config.circuitBreaker).toBeDefined();
            expect(config.maxConcurrencyPerKey).toBeDefined();
            expect(config.maxTotalConcurrency).toBeDefined();
            expect(config.queueSize).toBeDefined();
            expect(config.queueTimeout).toBeDefined();
            expect(config.rateLimitPerMinute).toBeDefined();
            expect(config.rateLimitBurst).toBeDefined();
            expect(config.requestTimeout).toBeDefined();
            expect(config.keepAliveTimeout).toBeDefined();
            expect(config.freeSocketTimeout).toBeDefined();
            expect(config.maxBodySize).toBeDefined();
            expect(config.shutdownTimeout).toBeDefined();
            expect(config.statsSaveInterval).toBeDefined();
            expect(config.logLevel).toBeDefined();
            expect(config.logFormat).toBeDefined();
            expect(config.apiKeys).toBeDefined();
            expect(config.configDir).toBeDefined();
            expect(config.statsFile).toBeDefined();
        });

        test('should have default queue config values', () => {
            const config = new Config();
            expect(config.queueSize).toBe(100);
            expect(config.queueTimeout).toBe(30000);
        });
    });

    describe('queue environment variable overrides', () => {
        beforeEach(() => {
            jest.spyOn(fs, 'existsSync').mockReturnValue(false);
        });

        test('should override queue size from GLM_QUEUE_SIZE', () => {
            process.env.GLM_QUEUE_SIZE = '50';
            const config = new Config();
            expect(config.queueSize).toBe(50);
        });

        test('should override queue timeout from GLM_QUEUE_TIMEOUT', () => {
            process.env.GLM_QUEUE_TIMEOUT = '15000';
            const config = new Config();
            expect(config.queueTimeout).toBe(15000);
        });
    });

    describe('GLM-5 configuration (Phase 08)', () => {
        beforeEach(() => {
            jest.spyOn(fs, 'existsSync').mockReturnValue(false);
        });

        test('should have glm5 enabled by default', () => {
            const config = new Config();
            expect(config.modelRouting.glm5.enabled).toBe(true);
        });

        test('should have glm5 preferencePercent default to 0 (shadow only)', () => {
            const config = new Config();
            expect(config.modelRouting.glm5.preferencePercent).toBe(0);
        });

        test('should override glm5 enabled from GLM_GLM5_ENABLED env var', () => {
            process.env.GLM_GLM5_ENABLED = 'false';
            const config = new Config();
            expect(config.modelRouting.glm5.enabled).toBe(false);
        });

        test('should override glm5 preferencePercent from GLM_GLM5_PREFERENCE_PERCENT env var', () => {
            process.env.GLM_GLM5_PREFERENCE_PERCENT = '50';
            const config = new Config();
            expect(config.modelRouting.glm5.preferencePercent).toBe(50);
        });
    });

    describe('Complexity upgrade configuration (Phase 08)', () => {
        beforeEach(() => {
            jest.spyOn(fs, 'existsSync').mockReturnValue(false);
        });

        test('should have complexityUpgrade thresholds with all required keys', () => {
            const config = new Config();
            const thresholds = config.modelRouting.complexityUpgrade.thresholds;
            expect(thresholds.maxTokensGte).toBe(4096);
            expect(thresholds.messageCountGte).toBe(20);
            expect(thresholds.systemLengthGte).toBe(2000);
            expect(thresholds.hasTools).toBe(true);
            expect(thresholds.hasVision).toBe(true);
        });

        test('should override maxTokensGte from GLM_COMPLEXITY_UPGRADE_MAX_TOKENS_GTE env var', () => {
            process.env.GLM_COMPLEXITY_UPGRADE_MAX_TOKENS_GTE = '8192';
            const config = new Config();
            expect(config.modelRouting.complexityUpgrade.thresholds.maxTokensGte).toBe(8192);
        });

        test('should override messageCountGte from GLM_COMPLEXITY_UPGRADE_MESSAGE_COUNT_GTE env var', () => {
            process.env.GLM_COMPLEXITY_UPGRADE_MESSAGE_COUNT_GTE = '30';
            const config = new Config();
            expect(config.modelRouting.complexityUpgrade.thresholds.messageCountGte).toBe(30);
        });

        test('should override systemLengthGte from GLM_COMPLEXITY_UPGRADE_SYSTEM_LENGTH_GTE env var', () => {
            process.env.GLM_COMPLEXITY_UPGRADE_SYSTEM_LENGTH_GTE = '3000';
            const config = new Config();
            expect(config.modelRouting.complexityUpgrade.thresholds.systemLengthGte).toBe(3000);
        });

        test('should override hasTools from GLM_COMPLEXITY_UPGRADE_HAS_TOOLS env var', () => {
            process.env.GLM_COMPLEXITY_UPGRADE_HAS_TOOLS = 'false';
            const config = new Config();
            expect(config.modelRouting.complexityUpgrade.thresholds.hasTools).toBe(false);
        });

        test('should override hasVision from GLM_COMPLEXITY_UPGRADE_HAS_VISION env var', () => {
            process.env.GLM_COMPLEXITY_UPGRADE_HAS_VISION = 'false';
            const config = new Config();
            expect(config.modelRouting.complexityUpgrade.thresholds.hasVision).toBe(false);
        });
    });

    describe('API keys loading', () => {
        test('should load keys from file', () => {
            const testKeysPath = path.join(__dirname, 'test-keys.json');
            const testKeys = {
                keys: ['key1.secret1', 'key2.secret2'],
                baseUrl: 'https://test.api.com/v1'
            };

            fs.writeFileSync(testKeysPath, JSON.stringify(testKeys));

            try {
                const config = new Config({
                    configDir: __dirname,
                    keysFile: 'test-keys.json'
                });

                expect(config.apiKeys).toHaveLength(2);
                expect(config.apiKeys[0]).toBe('key1.secret1');
                expect(config.targetHost).toBe('test.api.com');
                expect(config.targetBasePath).toBe('/v1');
            } finally {
                fs.unlinkSync(testKeysPath);
            }
        });

        test('should handle missing keys file gracefully', () => {
            // Use a path that definitely doesn't exist
            const config = new Config({
                configDir: 'Z:\\definitely\\not\\a\\real\\path',
                keysFile: 'missing-keys-file-12345.json'
            });

            expect(config.apiKeys).toEqual([]);
        });

        test('should store load errors for deferred logging', () => {
            const config = new Config({
                configDir: 'Z:\\definitely\\not\\a\\real\\path',
                keysFile: 'missing-keys-file-12345.json'
            });

            expect(config.hasLoadErrors()).toBe(true);

            const errors = config.flushLoadErrors();
            expect(errors).toHaveLength(1);
            expect(errors[0].type).toBe('api_keys');
            expect(errors[0].message).toBeDefined();

            // After flush, should be empty
            expect(config.hasLoadErrors()).toBe(false);
            expect(config.flushLoadErrors()).toHaveLength(0);
        });

        test('should have no load errors when keys file exists', () => {
            const testKeysPath = path.join(__dirname, 'test-no-errors.json');
            fs.writeFileSync(testKeysPath, JSON.stringify({ keys: ['key1'] }));

            try {
                const config = new Config({
                    configDir: __dirname,
                    keysFile: 'test-no-errors.json'
                });

                expect(config.hasLoadErrors()).toBe(false);
                expect(config.flushLoadErrors()).toHaveLength(0);
            } finally {
                fs.unlinkSync(testKeysPath);
            }
        });
    });

    describe('reloadKeys', () => {
        test('should reload keys from file', () => {
            // Restore real fs functions
            jest.restoreAllMocks();

            const testKeysPath = path.join(__dirname, 'reload-keys.json');
            const initialKeys = { keys: ['key1'] };

            fs.writeFileSync(testKeysPath, JSON.stringify(initialKeys));

            try {
                const config = new Config({
                    configDir: __dirname,
                    keysFile: 'reload-keys.json'
                });

                expect(config.apiKeys).toHaveLength(1);

                // Update file
                fs.writeFileSync(testKeysPath, JSON.stringify({ keys: ['key1', 'key2', 'key3'] }));

                const newKeys = config.reloadKeys();

                expect(newKeys).toHaveLength(3);
                expect(config.apiKeys).toHaveLength(3);
            } finally {
                if (fs.existsSync(testKeysPath)) {
                    fs.unlinkSync(testKeysPath);
                }
            }
        });
    });
});

describe('getConfig singleton', () => {
    beforeEach(() => {
        resetConfig();
    });

    test('should return singleton instance', () => {
        const config1 = getConfig({ configDir: 'Z:\\fake', keysFile: 'none.json' });
        const config2 = getConfig();
        expect(config1).toBe(config2);
    });

    test('should create new instance with overrides', () => {
        const config1 = getConfig({ port: 8080, configDir: 'Z:\\fake', keysFile: 'none.json' });
        expect(config1.port).toBe(8080);
    });

    test('should reset singleton', () => {
        getConfig({ port: 8080, configDir: 'Z:\\fake', keysFile: 'none.json' });
        resetConfig();
        const config2 = getConfig({ port: 9090, configDir: 'Z:\\fake', keysFile: 'none.json' });
        expect(config2.port).toBe(9090);
    });
});

// Import ModelMappingManager for tests
const { ModelMappingManager } = require('../lib/config');

describe('ModelMappingManager', () => {
    describe('constructor', () => {
        test('should initialize with default values when no config provided', () => {
            const manager = new ModelMappingManager();
            expect(manager.enabled).toBe(false);
            expect(manager.models).toEqual({});
            expect(manager.defaultModel).toBeNull();
            expect(manager.logTransformations).toBe(true);
        });

        test('should initialize with provided config', () => {
            const manager = new ModelMappingManager({
                enabled: true,
                models: {
                    'claude-opus-4-5-20251101': 'glm-4.7',
                    'claude-haiku-4-5-20251001': 'glm-4.7-flash'
                },
                defaultModel: 'glm-4.7',
                logTransformations: false
            });

            expect(manager.enabled).toBe(true);
            expect(manager.models['claude-opus-4-5-20251101']).toBe('glm-4.7');
            expect(manager.models['claude-haiku-4-5-20251001']).toBe('glm-4.7-flash');
            expect(manager.defaultModel).toBe('glm-4.7');
            expect(manager.logTransformations).toBe(false);
        });
    });

    describe('getMappedModel', () => {
        let manager;

        beforeEach(() => {
            manager = new ModelMappingManager({
                enabled: true,
                models: {
                    'claude-opus-4-5-20251101': 'glm-4.7',
                    'claude-haiku-4-5-20251001': 'glm-4.7-flash',
                    'claude-sonnet-4-5-20250929': 'glm-4.7'
                },
                defaultModel: null
            });
        });

        test('should return original model when disabled', () => {
            manager.enabled = false;
            const result = manager.getMappedModel('claude-opus-4-5-20251101');
            expect(result).toBe('claude-opus-4-5-20251101');
        });

        test('should return original model when model is null/undefined', () => {
            expect(manager.getMappedModel(null)).toBeNull();
            expect(manager.getMappedModel(undefined)).toBeUndefined();
        });

        test('should map known Claude models to GLM equivalents', () => {
            expect(manager.getMappedModel('claude-opus-4-5-20251101')).toBe('glm-4.7');
            expect(manager.getMappedModel('claude-haiku-4-5-20251001')).toBe('glm-4.7-flash');
            expect(manager.getMappedModel('claude-sonnet-4-5-20250929')).toBe('glm-4.7');
        });

        test('should pass through unmapped models when no default', () => {
            const result = manager.getMappedModel('unknown-model');
            expect(result).toBe('unknown-model');
        });

        test('should use default model for unmapped models when default is set', () => {
            manager.defaultModel = 'glm-4.7-default';
            const result = manager.getMappedModel('unknown-model');
            expect(result).toBe('glm-4.7-default');
        });

        test('should prioritize per-key override over global mapping', () => {
            manager.setKeyOverride(0, 'claude-opus-4-5-20251101', 'glm-4.7-custom');

            // Key 0 should use override
            expect(manager.getMappedModel('claude-opus-4-5-20251101', 0)).toBe('glm-4.7-custom');

            // Key 1 should use global mapping
            expect(manager.getMappedModel('claude-opus-4-5-20251101', 1)).toBe('glm-4.7');

            // No key should use global mapping
            expect(manager.getMappedModel('claude-opus-4-5-20251101')).toBe('glm-4.7');
        });

        test('should fall through to global mapping if per-key override not found for model', () => {
            manager.setKeyOverride(0, 'claude-opus-4-5-20251101', 'glm-4.7-custom');

            // Key 0 has override for opus, but haiku should use global
            expect(manager.getMappedModel('claude-haiku-4-5-20251001', 0)).toBe('glm-4.7-flash');
        });
    });

    describe('setKeyOverride', () => {
        let manager;

        beforeEach(() => {
            manager = new ModelMappingManager({ enabled: true });
        });

        test('should create override for new key', () => {
            manager.setKeyOverride(0, 'claude-opus-4-5-20251101', 'glm-4.7-key0');

            const override = manager.getKeyOverride(0);
            expect(override).toEqual({ 'claude-opus-4-5-20251101': 'glm-4.7-key0' });
        });

        test('should add multiple overrides for same key', () => {
            manager.setKeyOverride(0, 'claude-opus-4-5-20251101', 'glm-4.7');
            manager.setKeyOverride(0, 'claude-haiku-4-5-20251001', 'glm-4.7-flash');

            const override = manager.getKeyOverride(0);
            expect(override).toEqual({
                'claude-opus-4-5-20251101': 'glm-4.7',
                'claude-haiku-4-5-20251001': 'glm-4.7-flash'
            });
        });

        test('should update existing override', () => {
            manager.setKeyOverride(0, 'claude-opus-4-5-20251101', 'glm-4.7-v1');
            manager.setKeyOverride(0, 'claude-opus-4-5-20251101', 'glm-4.7-v2');

            const override = manager.getKeyOverride(0);
            expect(override['claude-opus-4-5-20251101']).toBe('glm-4.7-v2');
        });
    });

    describe('clearKeyOverride', () => {
        let manager;

        beforeEach(() => {
            manager = new ModelMappingManager({ enabled: true });
            manager.setKeyOverride(0, 'claude-opus-4-5-20251101', 'glm-4.7');
            manager.setKeyOverride(0, 'claude-haiku-4-5-20251001', 'glm-4.7-flash');
            manager.setKeyOverride(1, 'claude-opus-4-5-20251101', 'glm-4.7-other');
        });

        test('should clear specific model override for key', () => {
            manager.clearKeyOverride(0, 'claude-opus-4-5-20251101');

            const override = manager.getKeyOverride(0);
            expect(override).toEqual({ 'claude-haiku-4-5-20251001': 'glm-4.7-flash' });
        });

        test('should clear all overrides for key when no model specified', () => {
            manager.clearKeyOverride(0);

            expect(manager.getKeyOverride(0)).toBeNull();
            expect(manager.getKeyOverride(1)).not.toBeNull(); // Other key unaffected
        });

        test('should remove key entry when last override cleared', () => {
            manager.clearKeyOverride(0, 'claude-opus-4-5-20251101');
            manager.clearKeyOverride(0, 'claude-haiku-4-5-20251001');

            expect(manager.getKeyOverride(0)).toBeNull();
        });

        test('should handle clearing non-existent key gracefully', () => {
            expect(() => manager.clearKeyOverride(99)).not.toThrow();
            expect(() => manager.clearKeyOverride(99, 'some-model')).not.toThrow();
        });
    });

    describe('updateGlobalMapping', () => {
        let manager;

        beforeEach(() => {
            manager = new ModelMappingManager({
                enabled: true,
                models: { 'old-model': 'old-target' },
                defaultModel: 'old-default',
                logTransformations: true
            });
        });

        test('should update models mapping', () => {
            manager.updateGlobalMapping({
                models: { 'new-model': 'new-target' }
            });

            expect(manager.models).toEqual({ 'new-model': 'new-target' });
        });

        test('should update default model', () => {
            manager.updateGlobalMapping({ defaultModel: 'new-default' });
            expect(manager.defaultModel).toBe('new-default');
        });

        test('should update enabled flag', () => {
            manager.updateGlobalMapping({ enabled: false });
            expect(manager.enabled).toBe(false);
        });

        test('should update logTransformations flag', () => {
            manager.updateGlobalMapping({ logTransformations: false });
            expect(manager.logTransformations).toBe(false);
        });

        test('should only update provided fields', () => {
            manager.updateGlobalMapping({ enabled: false });

            expect(manager.enabled).toBe(false);
            expect(manager.models).toEqual({ 'old-model': 'old-target' }); // Unchanged
            expect(manager.defaultModel).toBe('old-default'); // Unchanged
        });
    });

    describe('resetToDefaults', () => {
        test('should reset to provided defaults', () => {
            const manager = new ModelMappingManager({
                enabled: true,
                models: { 'model': 'target' },
                defaultModel: 'default'
            });
            manager.setKeyOverride(0, 'model', 'override');

            manager.resetToDefaults({
                enabled: false,
                models: { 'new-model': 'new-target' },
                defaultModel: 'new-default'
            });

            expect(manager.enabled).toBe(false);
            expect(manager.models).toEqual({ 'new-model': 'new-target' });
            expect(manager.defaultModel).toBe('new-default');
            expect(manager.getKeyOverrides()).toEqual({}); // Overrides cleared
        });

        test('should use sensible defaults when no config provided', () => {
            const manager = new ModelMappingManager({
                enabled: true,
                models: { 'model': 'target' }
            });

            manager.resetToDefaults();

            expect(manager.enabled).toBe(true); // Default is not false
            expect(manager.models).toEqual({});
            expect(manager.defaultModel).toBeNull();
        });
    });

    describe('toConfig', () => {
        test('should export current configuration', () => {
            const manager = new ModelMappingManager({
                enabled: true,
                models: { 'claude-opus': 'glm-4.7' },
                defaultModel: 'glm-4.7',
                logTransformations: false
            });

            const config = manager.toConfig();

            expect(config).toMatchObject({
                enabled: true,
                models: { 'claude-opus': 'glm-4.7' },
                defaultModel: 'glm-4.7',
                logTransformations: false
            });
        });

        test('should return copy of models, not reference', () => {
            const manager = new ModelMappingManager({
                enabled: true,
                models: { 'claude-opus': 'glm-4.7' }
            });

            const config = manager.toConfig();
            config.models['claude-opus'] = 'modified';

            expect(manager.models['claude-opus']).toBe('glm-4.7'); // Unchanged
        });
    });

    describe('getKeyOverrides', () => {
        test('should return all key overrides', () => {
            const manager = new ModelMappingManager({ enabled: true });
            manager.setKeyOverride(0, 'model-a', 'target-a');
            manager.setKeyOverride(1, 'model-b', 'target-b');

            const overrides = manager.getKeyOverrides();

            expect(overrides).toEqual({
                0: { 'model-a': 'target-a' },
                1: { 'model-b': 'target-b' }
            });
        });

        test('should return empty object when no overrides', () => {
            const manager = new ModelMappingManager({ enabled: true });
            expect(manager.getKeyOverrides()).toEqual({});
        });
    });
});

describe('Config with ModelMappingManager', () => {
    beforeEach(() => {
        resetConfig();
        jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('should initialize modelMappingManager from config', () => {
        const config = new Config({
            modelMapping: {
                enabled: true,
                models: { 'claude-opus': 'glm-4.7' }
            }
        });

        expect(config.modelMappingManager).toBeDefined();
        expect(config.modelMappingManager.enabled).toBe(true);
        expect(config.modelMappingManager.getMappedModel('claude-opus')).toBe('glm-4.7');
    });

    test('should have modelMapping getter', () => {
        const config = new Config({
            modelMapping: {
                enabled: true,
                models: { 'test': 'mapped' }
            }
        });

        expect(config.modelMapping).toBeDefined();
        expect(config.modelMapping.enabled).toBe(true);
        expect(config.modelMapping.models.test).toBe('mapped');
    });

    test('should use default modelMapping when not specified', () => {
        const config = new Config();

        expect(config.modelMappingManager).toBeDefined();
        // Default config should have enabled: true with model mappings
        expect(config.modelMapping.enabled).toBe(true);
    });
});
