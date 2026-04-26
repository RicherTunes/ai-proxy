'use strict';

/**
 * Config Module Branch Coverage Tests
 * Targets uncovered lines 863 and 929
 */

const path = require('path');
const fs = require('fs');
const { Config, getConfig, resetConfig } = require('../lib/config');

describe('Config Uncovered Branches', () => {
    const originalEnv = process.env;
    let tempConfigDir;
    let tempKeysPath;

    beforeEach(() => {
        resetConfig();
        process.env = { ...originalEnv };

        // Create temp config directory
        tempConfigDir = path.join(__dirname, 'temp-config-test');
        tempKeysPath = path.join(tempConfigDir, 'test-keys.json');
        if (!fs.existsSync(tempConfigDir)) {
            fs.mkdirSync(tempConfigDir, { recursive: true });
        }
    });

    afterEach(() => {
        process.env = originalEnv;
        jest.restoreAllMocks();

        // Clean up temp directory
        if (fs.existsSync(tempConfigDir)) {
            fs.rmSync(tempConfigDir, { recursive: true, force: true });
        }
    });

    describe('Line 863: nested key assignment when target is null', () => {
        // Covers line 863: target[parts[i]] = {} when target[parts[i]] === null
        test('should create empty object when nested path contains null value', () => {
            // Arrange: set up environment with a nested key that will encounter null
            // We need to set a value first, then set part of it to null, then set a nested value
            process.env.GLM_LOG_LEVEL = 'INFO';

            const config = new Config({
                configDir: tempConfigDir,
                keysFile: 'test-keys.json'
            });

            // Pre-set a nested path with null at an intermediate level
            config.config.adaptiveTimeout = null;

            // Now apply env override that has nested key (adaptiveTimeout.enabled)
            // This should trigger line 863 when it encounters null
            process.env.GLM_ADAPTIVE_TIMEOUT = 'true';

            // The _applyEnvOverrides is called in constructor, but we can test by creating a new config
            const config2 = new Config({
                configDir: tempConfigDir,
                keysFile: 'test-keys.json',
                // Set adaptiveTimeout to null so the nested assignment hits the null case
                adaptiveTimeout: null
            });

            // With adaptiveTimeout set to null in overrides, the env var GLM_ADAPTIVE_TIMEOUT
            // should cause the code to hit line 863 when it tries to set nested value
            // But the constructor calls _applyOverrides first, which sets it to null,
            // then _applyEnvOverrides which should handle the null case

            // Actually, to hit line 863, we need the intermediate level to be null
            // Let's use a different approach - set the env var and ensure the nested path has null
            process.env.GLM_ADAPTIVE_TIMEOUT = 'true';

            const config3 = new Config({
                configDir: tempConfigDir,
                keysFile: 'test-keys.json',
                adaptiveTimeout: null  // This sets the root to null
            });

            // The env override should try to set adaptiveTimeout.enabled
            // When it finds adaptiveTimeout is null, it should create {} at line 863
            // Then set enabled = true on that object
            expect(config3.config.adaptiveTimeout).toBeDefined();
            expect(config3.config.adaptiveTimeout.enabled).toBe(true);
        });

        // Covers line 863: target[parts[i]] = {} when target[parts[i]] === null
        test('should handle nested key when intermediate object is explicitly null', () => {
            process.env.GLM_TRACE_SAMPLING_RATE = '50';  // modelRouting.trace.samplingRate

            const config = new Config({
                configDir: tempConfigDir,
                keysFile: 'test-keys.json',
                modelRouting: {
                    trace: null  // Set intermediate level to null
                }
            });

            // The env override should handle the null case at line 863
            expect(config.config.modelRouting.trace.samplingRate).toBe(50);
        });
    });

    describe('Line 929: ProviderRegistry initialized with providersConfig', () => {
        // Covers line 929: this._providerRegistry = new ProviderRegistry(providersConfig)
        test('should initialize ProviderRegistry with custom providers config', () => {
            const providersConfig = {
                'custom-provider': {
                    targetHost: 'custom.example.com',
                    targetBasePath: '/api/v1',
                    targetProtocol: 'https:',
                    authScheme: 'bearer',
                    costTier: 'premium'
                }
            };

            const config = new Config({
                configDir: tempConfigDir,
                keysFile: 'test-keys.json',
                providers: providersConfig
            });

            const registry = config.providerRegistry;
            expect(registry).toBeDefined();
            expect(registry.providers).toBeDefined();
            expect(registry.providers.has('custom-provider')).toBe(true);
        });

        // Covers line 929: multiple providers config
        test('should initialize ProviderRegistry with multiple providers', () => {
            const providersConfig = {
                'provider-a': {
                    targetHost: 'api.example-a.com',
                    targetBasePath: '/v1',
                    targetProtocol: 'https:',
                    authScheme: 'x-api-key',
                    costTier: 'free'
                },
                'provider-b': {
                    targetHost: 'api.example-b.com',
                    targetBasePath: '/api',
                    targetProtocol: 'https:',
                    authScheme: 'bearer',
                    costTier: 'metered'
                }
            };

            const config = new Config({
                configDir: tempConfigDir,
                keysFile: 'test-keys.json',
                providers: providersConfig
            });

            const registry = config.providerRegistry;
            expect(registry).toBeDefined();
            expect(registry.providers.has('provider-a')).toBe(true);
            expect(registry.providers.has('provider-b')).toBe(true);
        });

        // Covers line 929: providers config with additional options
        test('should use providers config when provided', () => {
            jest.spyOn(fs, 'readFileSync').mockReturnValue(
                JSON.stringify({ keys: [] })
            );

            const providersConfig = {
                'test-provider': {
                    targetHost: 'test.api.com',
                    targetBasePath: '/anthropic',
                    targetProtocol: 'https:',
                    authScheme: 'x-api-key',
                    costTier: 'free'
                }
            };

            const config = new Config({
                providers: providersConfig,
                configDir: tempConfigDir,
                keysFile: 'test-keys.json'
            });

            // Verify the provider registry was initialized with the custom config
            const registry = config.providerRegistry;
            expect(registry).toBeDefined();
            expect(registry.providers.has('test-provider')).toBe(true);

            jest.restoreAllMocks();
        });
    });

    describe('Additional branch coverage for nested env overrides', () => {
        // Covers branches in _applyEnvOverrides with deeply nested keys
        test('should set deeply nested config via environment variable', () => {
            process.env.GLM_POOL_COOLDOWN_BASE = '5000';  // poolCooldown.baseMs

            const config = new Config({
                configDir: tempConfigDir,
                keysFile: 'test-keys.json'
            });

            expect(config.config.poolCooldown.baseMs).toBe(5000);
        });

        // Covers the for loop iteration for multiple nested env vars
        test('should handle multiple nested environment variables', () => {
            process.env.GLM_POOL_COOLDOWN_BASE = '6000';
            process.env.GLM_POOL_COOLDOWN_CAP = '30000';
            process.env.GLM_POOL_COOLDOWN_DECAY = '20000';
            process.env.GLM_TRACE_SAMPLING_RATE = '25';

            const config = new Config({
                configDir: tempConfigDir,
                keysFile: 'test-keys.json'
            });

            expect(config.config.poolCooldown.baseMs).toBe(6000);
            expect(config.config.poolCooldown.capMs).toBe(30000);
            expect(config.config.poolCooldown.decayMs).toBe(20000);
            expect(config.config.modelRouting.trace.samplingRate).toBe(25);
        });
    });

    describe('Line 863: intermediate null with 3-level nesting', () => {
        // Covers line 863 with 3-level deep nesting
        test('should create object when 3-level nested path has null at middle level', () => {
            process.env.GLM_COST_DAILY_BUDGET = '10.5';  // costTracking.budget.daily

            const config = new Config({
                configDir: tempConfigDir,
                keysFile: 'test-keys.json',
                costTracking: {
                    budget: null  // Set middle level to null
                }
            });

            // Should handle the null case and create the object
            expect(config.config.costTracking.budget.daily).toBe(10.5);
        });
    });
});
