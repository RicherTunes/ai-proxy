'use strict';

/**
 * Config Edge-Case Tests
 *
 * Covers 10 edge-case categories:
 * 1. Env var type coercion (non-numeric port, etc.)
 * 2. Boolean env vars ("true"/"false"/"1"/"0")
 * 3. Nested config paths from env vars (deep nesting)
 * 4. Config reload (reloadKeys picks up new keys)
 * 5. Missing config file (all defaults, no crash)
 * 6. Config validation (invalid values produce warnings, not crashes)
 * 7. Key file format (key.suffix and bare keys)
 * 8. Path resolution (relative and absolute configDir)
 * 9. Default values (every config field has a sensible default)
 * 10. Config immutability (returned config can't mutate internal state)
 */

const path = require('path');
const fs = require('fs');
const { Config, getConfig, resetConfig, DEFAULT_CONFIG, ModelMappingManager } = require('../lib/config');

// ─── Helpers ────────────────────────────────────────────────────────────────
const originalEnv = { ...process.env };

function cleanEnv() {
    process.env = { ...originalEnv };
}

function mockNoKeysFile() {
    jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
        throw new Error('ENOENT: no such file');
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. ENV VAR TYPE COERCION
// ─────────────────────────────────────────────────────────────────────────────
describe('1. Env var type coercion', () => {
    beforeEach(() => { resetConfig(); cleanEnv(); mockNoKeysFile(); });
    afterEach(() => { cleanEnv(); jest.restoreAllMocks(); });

    test('GLM_PORT="abc" does not crash; uses default port', () => {
        process.env.GLM_PORT = 'abc';
        const config = new Config();
        expect(config.port).toBe(DEFAULT_CONFIG.port);
    });

    test('GLM_PORT="" (empty string) does not crash; uses default port', () => {
        process.env.GLM_PORT = '';
        const config = new Config();
        expect(config.port).toBe(DEFAULT_CONFIG.port);
    });

    test('GLM_PORT="3.14" truncates to integer 3', () => {
        process.env.GLM_PORT = '3.14';
        const config = new Config();
        expect(config.port).toBe(3);
    });

    test('GLM_MAX_RETRIES="not-a-number" does not crash; uses default', () => {
        process.env.GLM_MAX_RETRIES = 'not-a-number';
        const config = new Config();
        expect(config.maxRetries).toBe(DEFAULT_CONFIG.maxRetries);
    });

    test('GLM_SLOW_KEY_THRESHOLD="xyz" does not crash; uses default', () => {
        process.env.GLM_SLOW_KEY_THRESHOLD = 'xyz';
        const config = new Config();
        expect(config.get('keySelection.slowKeyThreshold')).toBe(DEFAULT_CONFIG.keySelection.slowKeyThreshold);
    });

    test('GLM_MAX_CONCURRENCY_PER_KEY="Infinity" does not crash; uses default (parseInt yields NaN)', () => {
        process.env.GLM_MAX_CONCURRENCY_PER_KEY = 'Infinity';
        const config = new Config();
        // parseInt('Infinity', 10) returns NaN, so the mapping is skipped
        expect(config.maxConcurrencyPerKey).toBe(DEFAULT_CONFIG.maxConcurrencyPerKey);
    });

    test('GLM_QUEUE_SIZE="  " (whitespace) does not crash; uses default', () => {
        process.env.GLM_QUEUE_SIZE = '  ';
        const config = new Config();
        expect(config.queueSize).toBe(DEFAULT_CONFIG.queueSize);
    });

    test('GLM_PORT="-0" parses as -0 (Object.is distinguishes -0 from 0, but both are valid port 0)', () => {
        process.env.GLM_PORT = '-0';
        const config = new Config();
        // parseInt('-0') returns -0; Object.is(-0, 0) is false but == and === treat them as equal
        expect(config.port).toEqual(-0);
        expect(config.port == 0).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. BOOLEAN ENV VARS
// ─────────────────────────────────────────────────────────────────────────────
describe('2. Boolean env vars', () => {
    beforeEach(() => { resetConfig(); cleanEnv(); mockNoKeysFile(); });
    afterEach(() => { cleanEnv(); jest.restoreAllMocks(); });

    test('GLM_ADMIN_AUTH_ENABLED="true" enables admin auth', () => {
        process.env.GLM_ADMIN_AUTH_ENABLED = 'true';
        const config = new Config();
        expect(config.adminAuth.enabled).toBe(true);
    });

    test('GLM_ADMIN_AUTH_ENABLED="false" disables admin auth', () => {
        process.env.GLM_ADMIN_AUTH_ENABLED = 'false';
        const config = new Config();
        expect(config.adminAuth.enabled).toBe(false);
    });

    test('GLM_ADMIN_AUTH_ENABLED="1" enables admin auth', () => {
        process.env.GLM_ADMIN_AUTH_ENABLED = '1';
        const config = new Config();
        expect(config.adminAuth.enabled).toBe(true);
    });

    test('GLM_ADMIN_AUTH_ENABLED="0" disables admin auth', () => {
        process.env.GLM_ADMIN_AUTH_ENABLED = '0';
        const config = new Config();
        expect(config.adminAuth.enabled).toBe(false);
    });

    test('GLM_ADMIN_AUTH_ENABLED="TRUE" (uppercase) enables admin auth', () => {
        process.env.GLM_ADMIN_AUTH_ENABLED = 'TRUE';
        const config = new Config();
        expect(config.adminAuth.enabled).toBe(true);
    });

    test('GLM_ADMIN_AUTH_ENABLED="True" (mixed case) enables admin auth', () => {
        process.env.GLM_ADMIN_AUTH_ENABLED = 'True';
        const config = new Config();
        expect(config.adminAuth.enabled).toBe(true);
    });

    test('GLM_ADMIN_AUTH_ENABLED="yes" does NOT enable (only "true" and "1" are truthy)', () => {
        process.env.GLM_ADMIN_AUTH_ENABLED = 'yes';
        const config = new Config();
        expect(config.adminAuth.enabled).toBe(false);
    });

    test('GLM_ADMIN_AUTH_ENABLED="" (empty) does NOT enable', () => {
        process.env.GLM_ADMIN_AUTH_ENABLED = '';
        const config = new Config();
        expect(config.adminAuth.enabled).toBe(false);
    });

    test('inverted bool: NO_CLUSTER="1" disables cluster', () => {
        process.env.NO_CLUSTER = '1';
        const config = new Config();
        expect(config.useCluster).toBe(false);
    });

    test('inverted bool: NO_CLUSTER="true" disables cluster', () => {
        process.env.NO_CLUSTER = 'true';
        const config = new Config();
        expect(config.useCluster).toBe(false);
    });

    test('inverted bool: NO_CLUSTER="false" enables cluster (invert of false = true)', () => {
        process.env.NO_CLUSTER = 'false';
        const config = new Config();
        expect(config.useCluster).toBe(true);
    });

    test('inverted bool: NO_CLUSTER="0" enables cluster (invert of false = true)', () => {
        process.env.NO_CLUSTER = '0';
        const config = new Config();
        expect(config.useCluster).toBe(true);
    });

    test('GLM_ADAPTIVE_TIMEOUT="false" disables adaptive timeout', () => {
        process.env.GLM_ADAPTIVE_TIMEOUT = 'false';
        const config = new Config();
        expect(config.adaptiveTimeout.enabled).toBe(false);
    });

    test('GLM_TRACE_ENABLED="1" enables request tracing', () => {
        process.env.GLM_TRACE_ENABLED = '1';
        const config = new Config();
        expect(config.requestTracing.enabled).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. NESTED CONFIG PATHS FROM ENV VARS
// ─────────────────────────────────────────────────────────────────────────────
describe('3. Nested config from env vars', () => {
    beforeEach(() => { resetConfig(); cleanEnv(); mockNoKeysFile(); });
    afterEach(() => { cleanEnv(); jest.restoreAllMocks(); });

    test('2-level nested: GLM_ADAPTIVE_CONCURRENCY_MODE sets adaptiveConcurrency.mode', () => {
        process.env.GLM_ADAPTIVE_CONCURRENCY_MODE = 'enforce';
        const config = new Config();
        expect(config.adaptiveConcurrency.mode).toBe('enforce');
    });

    test('3-level nested: GLM_POOL_429_PENALTY_WEIGHT sets modelRouting.pool429Penalty.penaltyWeight', () => {
        process.env.GLM_POOL_429_PENALTY_WEIGHT = '0.8';
        const config = new Config();
        expect(config.get('modelRouting.pool429Penalty.penaltyWeight')).toBe(0.8);
    });

    test('4-level nested: GLM_COMPLEXITY_UPGRADE_MAX_TOKENS_GTE sets modelRouting.complexityUpgrade.thresholds.maxTokensGte', () => {
        process.env.GLM_COMPLEXITY_UPGRADE_MAX_TOKENS_GTE = '16384';
        const config = new Config();
        expect(config.get('modelRouting.complexityUpgrade.thresholds.maxTokensGte')).toBe(16384);
    });

    test('deep nested env does not clobber sibling keys', () => {
        process.env.GLM_POOL_429_PENALTY_WINDOW_MS = '60000';
        const config = new Config();
        const penalty = config.get('modelRouting.pool429Penalty');
        expect(penalty.windowMs).toBe(60000);
        // Siblings must survive
        expect(penalty.enabled).toBe(DEFAULT_CONFIG.modelRouting.pool429Penalty.enabled);
        expect(penalty.penaltyWeight).toBe(DEFAULT_CONFIG.modelRouting.pool429Penalty.penaltyWeight);
        expect(penalty.maxPenaltyHits).toBe(DEFAULT_CONFIG.modelRouting.pool429Penalty.maxPenaltyHits);
    });

    test('multiple deep overrides in same sub-tree work independently', () => {
        process.env.GLM_COMPLEXITY_UPGRADE_MAX_TOKENS_GTE = '8192';
        process.env.GLM_COMPLEXITY_UPGRADE_MESSAGE_COUNT_GTE = '50';
        process.env.GLM_COMPLEXITY_UPGRADE_HAS_TOOLS = 'false';
        const config = new Config();
        const thresholds = config.get('modelRouting.complexityUpgrade.thresholds');
        expect(thresholds.maxTokensGte).toBe(8192);
        expect(thresholds.messageCountGte).toBe(50);
        expect(thresholds.hasTools).toBe(false);
        // unchanged sibling
        expect(thresholds.systemLengthGte).toBe(DEFAULT_CONFIG.modelRouting.complexityUpgrade.thresholds.systemLengthGte);
    });

    test('get() traverses arbitrary depth', () => {
        const config = new Config();
        expect(config.get('modelRouting.cooldown.defaultMs')).toBe(DEFAULT_CONFIG.modelRouting.cooldown.defaultMs);
        expect(config.get('modelRouting.failover.maxModelSwitchesPerRequest'))
            .toBe(DEFAULT_CONFIG.modelRouting.failover.maxModelSwitchesPerRequest);
    });

    test('get() returns undefined for partially valid path', () => {
        const config = new Config();
        expect(config.get('modelRouting.nonexistent.something')).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. CONFIG RELOAD
// ─────────────────────────────────────────────────────────────────────────────
describe('4. Config reload', () => {
    const tempKeysFile = path.join(__dirname, 'config-edges-reload-keys.json');

    beforeEach(() => { resetConfig(); cleanEnv(); jest.restoreAllMocks(); });
    afterEach(() => {
        cleanEnv();
        jest.restoreAllMocks();
        try { fs.unlinkSync(tempKeysFile); } catch (_) { /* noop */ }
    });

    test('reloadKeys() picks up new keys from file', () => {
        fs.writeFileSync(tempKeysFile, JSON.stringify({ keys: ['initial.key'] }));

        const config = new Config({
            configDir: __dirname,
            keysFile: 'config-edges-reload-keys.json'
        });
        expect(config.apiKeys).toHaveLength(1);

        // Write new keys
        fs.writeFileSync(tempKeysFile, JSON.stringify({ keys: ['key1.a', 'key2.b', 'key3.c'] }));
        const reloaded = config.reloadKeys();

        expect(reloaded).toHaveLength(3);
        expect(config.apiKeys).toHaveLength(3);
        expect(config.apiKeys).toEqual(['key1.a', 'key2.b', 'key3.c']);
    });

    test('reloadKeys() handles file disappearing gracefully', () => {
        fs.writeFileSync(tempKeysFile, JSON.stringify({ keys: ['key1'] }));

        const config = new Config({
            configDir: __dirname,
            keysFile: 'config-edges-reload-keys.json'
        });
        expect(config.apiKeys).toHaveLength(1);

        // Delete the file
        fs.unlinkSync(tempKeysFile);
        const reloaded = config.reloadKeys();

        expect(reloaded).toEqual([]);
        expect(config.apiKeys).toEqual([]);
    });

    test('reloadKeys() picks up baseUrl changes', () => {
        fs.writeFileSync(tempKeysFile, JSON.stringify({
            keys: ['key1'],
            baseUrl: 'https://api.example.com/v1'
        }));

        const config = new Config({
            configDir: __dirname,
            keysFile: 'config-edges-reload-keys.json'
        });
        expect(config.targetHost).toBe('api.example.com');

        // Reload with different baseUrl
        fs.writeFileSync(tempKeysFile, JSON.stringify({
            keys: ['key1', 'key2'],
            baseUrl: 'https://api.other.com/v2'
        }));
        config.reloadKeys();

        expect(config.targetHost).toBe('api.other.com');
        expect(config.targetBasePath).toBe('/v2');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. MISSING CONFIG FILE
// ─────────────────────────────────────────────────────────────────────────────
describe('5. Missing config file', () => {
    beforeEach(() => { resetConfig(); cleanEnv(); });
    afterEach(() => { cleanEnv(); jest.restoreAllMocks(); });

    test('no config file uses all defaults without crash', () => {
        const config = new Config({
            configDir: path.join(__dirname, 'nonexistent-dir-xyz-12345'),
            keysFile: 'nonexistent-keys.json'
        });

        expect(config.port).toBe(DEFAULT_CONFIG.port);
        expect(config.host).toBe(DEFAULT_CONFIG.host);
        expect(config.maxRetries).toBe(DEFAULT_CONFIG.maxRetries);
        expect(config.apiKeys).toEqual([]);
        expect(config.logLevel).toBe(DEFAULT_CONFIG.logLevel);
    });

    test('missing config file sets hasLoadErrors=true', () => {
        const config = new Config({
            configDir: path.join(__dirname, 'nonexistent-dir-xyz-12345'),
            keysFile: 'nonexistent-keys.json'
        });

        expect(config.hasLoadErrors()).toBe(true);
    });

    test('flushLoadErrors() returns error info and then clears', () => {
        const config = new Config({
            configDir: path.join(__dirname, 'nonexistent-dir-xyz-12345'),
            keysFile: 'nonexistent-keys.json'
        });

        const errors = config.flushLoadErrors();
        expect(errors.length).toBe(1);
        expect(errors[0].type).toBe('api_keys');
        expect(typeof errors[0].message).toBe('string');
        expect(typeof errors[0].path).toBe('string');

        // After flush, empty
        expect(config.flushLoadErrors()).toHaveLength(0);
        expect(config.hasLoadErrors()).toBe(false);
    });

    test('all feature subsystems have usable defaults', () => {
        const config = new Config({
            configDir: path.join(__dirname, 'nonexistent-dir-xyz-12345'),
            keysFile: 'nonexistent-keys.json'
        });

        // Feature subsystems should all have defined defaults
        expect(config.circuitBreaker).toBeDefined();
        expect(config.adaptiveTimeout).toBeDefined();
        expect(config.adaptiveConcurrency).toBeDefined();
        expect(config.costTracking).toBeDefined();
        expect(config.requestTracing).toBeDefined();
        expect(config.webhooks).toBeDefined();
        expect(config.requestStore).toBeDefined();
        expect(config.multiTenant).toBeDefined();
        expect(config.adminAuth).toBeDefined();
        expect(config.modelRouting).toBeDefined();
        expect(config.security).toBeDefined();
        expect(config.histogram).toBeDefined();
        expect(config.poolCooldown).toBeDefined();
        expect(config.retryConfig).toBeDefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. CONFIG VALIDATION
// ─────────────────────────────────────────────────────────────────────────────
describe('6. Config validation', () => {
    beforeEach(() => { resetConfig(); cleanEnv(); mockNoKeysFile(); });
    afterEach(() => { cleanEnv(); jest.restoreAllMocks(); });

    test('invalid logLevel produces warning, does not crash', () => {
        const config = new Config({ logLevel: 'TRACE' });
        expect(config._validationWarnings.some(w => w.includes('logLevel'))).toBe(true);
        // Config still created
        expect(config.logLevel).toBe('TRACE');
    });

    test('invalid logFormat produces warning, does not crash', () => {
        const config = new Config({ logFormat: 'csv' });
        expect(config._validationWarnings.some(w => w.includes('logFormat'))).toBe(true);
        expect(config.logFormat).toBe('csv');
    });

    test('invalid adaptiveConcurrency.mode produces warning, does not crash', () => {
        const config = new Config({ adaptiveConcurrency: { mode: 'turbo' } });
        expect(config._validationWarnings.some(w => w.includes('adaptiveConcurrency.mode'))).toBe(true);
    });

    test('valid config values produce no warnings for enum fields', () => {
        const config = new Config({
            logLevel: 'WARN',
            logFormat: 'json',
            adaptiveConcurrency: { mode: 'enforce' }
        });
        const enumWarnings = config._validationWarnings.filter(w =>
            w.includes('logLevel') || w.includes('logFormat') || w.includes('adaptiveConcurrency.mode')
        );
        expect(enumWarnings).toEqual([]);
    });

    test('multiple invalid values report all warnings', () => {
        const config = new Config({
            logLevel: 'VERBOSE',
            logFormat: 'xml',
            adaptiveConcurrency: { mode: 'auto' }
        });
        expect(config._validationWarnings.length).toBe(3);
    });

    test('invalid hard-error fields still throw (port out of range)', () => {
        expect(() => new Config({ port: -1 })).toThrow('Invalid port');
    });

    test('invalid hard-error fields still throw (maxConcurrencyPerKey = 0)', () => {
        expect(() => new Config({ maxConcurrencyPerKey: 0 })).toThrow('Invalid maxConcurrencyPerKey');
    });

    test('trace sampling rate clamped to 0-100', () => {
        const configLow = new Config({
            modelRouting: { trace: { samplingRate: -10 } }
        });
        expect(configLow.get('modelRouting.trace.samplingRate')).toBe(0);

        resetConfig();
        const configHigh = new Config({
            modelRouting: { trace: { samplingRate: 200 } }
        });
        expect(configHigh.get('modelRouting.trace.samplingRate')).toBe(100);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. KEY FILE FORMAT
// ─────────────────────────────────────────────────────────────────────────────
describe('7. Key file format', () => {
    const tempKeysFile = path.join(__dirname, 'config-edges-keyformat.json');

    beforeEach(() => { resetConfig(); cleanEnv(); jest.restoreAllMocks(); });
    afterEach(() => {
        cleanEnv();
        jest.restoreAllMocks();
        try { fs.unlinkSync(tempKeysFile); } catch (_) { /* noop */ }
    });

    test('keys in "key.suffix" format are loaded correctly', () => {
        fs.writeFileSync(tempKeysFile, JSON.stringify({
            keys: ['abc123.secret456', 'def789.secretXYZ']
        }));

        const config = new Config({
            configDir: __dirname,
            keysFile: 'config-edges-keyformat.json'
        });

        expect(config.apiKeys).toHaveLength(2);
        expect(config.apiKeys[0]).toBe('abc123.secret456');
        expect(config.apiKeys[1]).toBe('def789.secretXYZ');
    });

    test('bare keys (no suffix) are loaded correctly', () => {
        fs.writeFileSync(tempKeysFile, JSON.stringify({
            keys: ['simplekey1', 'simplekey2']
        }));

        const config = new Config({
            configDir: __dirname,
            keysFile: 'config-edges-keyformat.json'
        });

        expect(config.apiKeys).toHaveLength(2);
        expect(config.apiKeys[0]).toBe('simplekey1');
    });

    test('mixed key formats are loaded correctly', () => {
        fs.writeFileSync(tempKeysFile, JSON.stringify({
            keys: ['bare-key', 'dotted.key', 'multi.dot.key']
        }));

        const config = new Config({
            configDir: __dirname,
            keysFile: 'config-edges-keyformat.json'
        });

        expect(config.apiKeys).toEqual(['bare-key', 'dotted.key', 'multi.dot.key']);
    });

    test('empty keys array is valid', () => {
        fs.writeFileSync(tempKeysFile, JSON.stringify({
            keys: []
        }));

        const config = new Config({
            configDir: __dirname,
            keysFile: 'config-edges-keyformat.json'
        });

        expect(config.apiKeys).toEqual([]);
        expect(config.hasLoadErrors()).toBe(false);
    });

    test('keys file without keys field defaults to empty array', () => {
        fs.writeFileSync(tempKeysFile, JSON.stringify({
            baseUrl: 'https://example.com/v1'
        }));

        const config = new Config({
            configDir: __dirname,
            keysFile: 'config-edges-keyformat.json'
        });

        expect(config.apiKeys).toEqual([]);
    });

    test('malformed JSON in keys file does not crash, returns empty keys', () => {
        fs.writeFileSync(tempKeysFile, 'this is not valid json {{{');

        const config = new Config({
            configDir: __dirname,
            keysFile: 'config-edges-keyformat.json'
        });

        expect(config.apiKeys).toEqual([]);
        expect(config.hasLoadErrors()).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. PATH RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────
describe('8. Path resolution', () => {
    const tempKeysFile = path.join(__dirname, 'config-edges-pathres.json');

    beforeEach(() => { resetConfig(); cleanEnv(); jest.restoreAllMocks(); });
    afterEach(() => {
        cleanEnv();
        jest.restoreAllMocks();
        try { fs.unlinkSync(tempKeysFile); } catch (_) { /* noop */ }
    });

    test('absolute configDir path works', () => {
        fs.writeFileSync(tempKeysFile, JSON.stringify({ keys: ['k1'] }));

        const config = new Config({
            configDir: __dirname,
            keysFile: 'config-edges-pathres.json'
        });

        expect(config.apiKeys).toEqual(['k1']);
        expect(path.isAbsolute(config.configDir)).toBe(true);
    });

    test('default configDir is absolute and points to project root', () => {
        mockNoKeysFile();
        const config = new Config();
        expect(path.isAbsolute(config.configDir)).toBe(true);
        // Default configDir is path.join(__dirname, '..') from lib/config.js
        // which is the project root
        expect(config.configDir).toBe(path.join(__dirname, '..'));
    });

    test('relative configDir is used as-is in path.join for key loading', () => {
        // path.join will resolve relative paths relative to CWD
        // We just test that it doesn't crash and stores the value
        mockNoKeysFile();
        const config = new Config({
            configDir: './relative-dir',
            keysFile: 'keys.json'
        });

        expect(config.configDir).toBe('./relative-dir');
        // Keys loading will fail (dir doesn't exist) but that's handled gracefully
        expect(config.apiKeys).toEqual([]);
    });

    test('custom keysFile name is respected', () => {
        const customKeysFile = path.join(__dirname, 'my-custom-keys.json');
        fs.writeFileSync(customKeysFile, JSON.stringify({ keys: ['custom-key-1'] }));

        try {
            const config = new Config({
                configDir: __dirname,
                keysFile: 'my-custom-keys.json'
            });

            expect(config.apiKeys).toEqual(['custom-key-1']);
        } finally {
            try { fs.unlinkSync(customKeysFile); } catch (_) { /* noop */ }
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. DEFAULT VALUES
// ─────────────────────────────────────────────────────────────────────────────
describe('9. Default values', () => {
    beforeEach(() => { resetConfig(); cleanEnv(); mockNoKeysFile(); });
    afterEach(() => { cleanEnv(); jest.restoreAllMocks(); });

    test('every top-level numeric config field has a sensible default', () => {
        const config = new Config();

        // Server
        expect(typeof config.port).toBe('number');
        expect(config.port).toBeGreaterThan(0);
        expect(typeof config.host).toBe('string');
        expect(config.host.length).toBeGreaterThan(0);

        // Target API
        expect(typeof config.targetHost).toBe('string');
        expect(config.targetHost.length).toBeGreaterThan(0);
        expect(typeof config.targetBasePath).toBe('string');
        expect(typeof config.targetProtocol).toBe('string');

        // Concurrency
        expect(config.maxConcurrencyPerKey).toBeGreaterThanOrEqual(1);
        expect(config.maxTotalConcurrency).toBeGreaterThanOrEqual(0);

        // Retries
        expect(config.maxRetries).toBeGreaterThanOrEqual(0);

        // Timeouts
        expect(config.requestTimeout).toBeGreaterThan(0);
        expect(config.keepAliveTimeout).toBeGreaterThan(0);
        expect(config.freeSocketTimeout).toBeGreaterThan(0);
        expect(config.queueTimeout).toBeGreaterThan(0);

        // Queue
        expect(config.queueSize).toBeGreaterThanOrEqual(0);

        // Rate limit
        expect(typeof config.rateLimitPerMinute).toBe('number');
        expect(typeof config.rateLimitBurst).toBe('number');

        // Body size
        expect(config.maxBodySize).toBeGreaterThan(0);

        // Workers
        expect(config.maxWorkers).toBeGreaterThan(0);
    });

    test('every feature subsystem has enabled/disabled default', () => {
        const config = new Config();

        expect(typeof config.histogram.enabled).toBe('boolean');
        expect(typeof config.costTracking.enabled).toBe('boolean');
        expect(typeof config.requestTracing.enabled).toBe('boolean');
        expect(typeof config.webhooks.enabled).toBe('boolean');
        expect(typeof config.requestStore.enabled).toBe('boolean');
        expect(typeof config.multiTenant.enabled).toBe('boolean');
        expect(typeof config.adminAuth.enabled).toBe('boolean');
        expect(typeof config.modelRouting.enabled).toBe('boolean');
        expect(typeof config.adaptiveTimeout.enabled).toBe('boolean');
        expect(typeof config.adaptiveConcurrency.enabled).toBe('boolean');
        expect(typeof config.usageMonitor.enabled).toBe('boolean');
    });

    test('circuitBreaker has all required sub-fields', () => {
        const config = new Config();
        const cb = config.circuitBreaker;

        expect(typeof cb.failureThreshold).toBe('number');
        expect(typeof cb.failureWindow).toBe('number');
        expect(typeof cb.cooldownPeriod).toBe('number');
        expect(typeof cb.halfOpenTimeout).toBe('number');
        expect(cb.failureThreshold).toBeGreaterThanOrEqual(1);
    });

    test('retryConfig has all required sub-fields', () => {
        const config = new Config();
        const rc = config.retryConfig;

        expect(typeof rc.baseDelayMs).toBe('number');
        expect(typeof rc.maxDelayMs).toBe('number');
        expect(typeof rc.backoffMultiplier).toBe('number');
        expect(typeof rc.jitterPercent).toBe('number');
        expect(rc.baseDelayMs).toBeGreaterThan(0);
        expect(rc.maxDelayMs).toBeGreaterThan(rc.baseDelayMs);
    });

    test('security has mode, cors, rateLimit, headers', () => {
        const config = new Config();
        const sec = config.security;

        expect(typeof sec.mode).toBe('string');
        expect(sec.cors).toBeDefined();
        expect(sec.rateLimit).toBeDefined();
        expect(sec.headers).toBeDefined();
        expect(typeof sec.headers.csp).toBe('string');
        expect(typeof sec.rateLimit.enabled).toBe('boolean');
    });

    test('poolCooldown has all expected timing fields', () => {
        const config = new Config();
        const pc = config.poolCooldown;

        expect(typeof pc.sleepThresholdMs).toBe('number');
        expect(typeof pc.retryJitterMs).toBe('number');
        expect(typeof pc.maxCooldownMs).toBe('number');
        expect(typeof pc.baseMs).toBe('number');
        expect(typeof pc.capMs).toBe('number');
        expect(typeof pc.decayMs).toBe('number');
    });

    test('adaptiveConcurrency has all required sub-fields', () => {
        const config = new Config();
        const ac = config.adaptiveConcurrency;

        expect(typeof ac.mode).toBe('string');
        expect(typeof ac.tickIntervalMs).toBe('number');
        expect(typeof ac.decreaseFactor).toBe('number');
        expect(typeof ac.recoveryDelayMs).toBe('number');
        expect(typeof ac.minWindow).toBe('number');
        expect(typeof ac.growthCleanTicks).toBe('number');
    });

    test('modelMapping defaults have models and enabled flag', () => {
        expect(typeof DEFAULT_CONFIG.modelMapping.enabled).toBe('boolean');
        expect(typeof DEFAULT_CONFIG.modelMapping.models).toBe('object');
        expect(Object.keys(DEFAULT_CONFIG.modelMapping.models).length).toBeGreaterThan(0);
    });

    test('apiKeys defaults to empty array when no file', () => {
        const config = new Config({
            configDir: 'Z:\\nonexistent',
            keysFile: 'nope.json'
        });
        expect(Array.isArray(config.apiKeys)).toBe(true);
        expect(config.apiKeys).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. CONFIG IMMUTABILITY
// ─────────────────────────────────────────────────────────────────────────────
describe('10. Config immutability', () => {
    beforeEach(() => { resetConfig(); cleanEnv(); mockNoKeysFile(); });
    afterEach(() => { cleanEnv(); jest.restoreAllMocks(); });

    test('getAll() returns a shallow copy — mutating it does not affect internal state', () => {
        const config = new Config();
        const all = config.getAll();

        all.port = 99999;
        all.host = 'hacked.com';

        expect(config.port).toBe(DEFAULT_CONFIG.port);
        expect(config.host).toBe(DEFAULT_CONFIG.host);
    });

    test('mutating getAll() nested object does affect internal (shallow copy limitation)', () => {
        const config = new Config();
        const all = config.getAll();

        // Shallow copy means nested objects are shared references
        // This documents the current behavior — getAll() is a shallow copy
        const originalThreshold = config.circuitBreaker.failureThreshold;
        all.circuitBreaker.failureThreshold = 999;

        // This IS the current behavior: shallow copy shares nested refs
        expect(config.circuitBreaker.failureThreshold).toBe(999);

        // Restore for other tests
        config.circuitBreaker.failureThreshold = originalThreshold;
    });

    test('get() for nested path returns the actual object reference (not a copy)', () => {
        const config = new Config();
        const cb1 = config.get('circuitBreaker');
        const cb2 = config.get('circuitBreaker');

        // Same reference
        expect(cb1).toBe(cb2);
    });

    test('convenience getter returns same reference as config internal', () => {
        const config = new Config();
        const cb = config.circuitBreaker;

        // Mutating through getter affects config
        const original = cb.failureThreshold;
        cb.failureThreshold = 42;
        expect(config.get('circuitBreaker.failureThreshold')).toBe(42);

        // Restore
        cb.failureThreshold = original;
    });

    test('ModelMappingManager.toConfig() returns an independent copy of models', () => {
        const manager = new ModelMappingManager({
            enabled: true,
            models: { 'claude-opus': 'glm-4.7' }
        });

        const exported = manager.toConfig();
        exported.models['claude-opus'] = 'HACKED';

        expect(manager.models['claude-opus']).toBe('glm-4.7');
    });

    test('ModelMappingManager.getKeyOverride() returns a copy', () => {
        const manager = new ModelMappingManager({ enabled: true });
        manager.setKeyOverride(0, 'model-a', 'target-a');

        const override = manager.getKeyOverride(0);
        override['model-a'] = 'HACKED';

        expect(manager.getMappedModel('model-a', 0)).toBe('target-a');
    });

    test('ModelMappingManager.getKeyOverrides() returns copies per key', () => {
        const manager = new ModelMappingManager({ enabled: true });
        manager.setKeyOverride(0, 'model-a', 'target-a');

        const overrides = manager.getKeyOverrides();
        overrides[0]['model-a'] = 'HACKED';

        expect(manager.getMappedModel('model-a', 0)).toBe('target-a');
    });

    test('singleton getConfig() returns same instance on repeated calls', () => {
        resetConfig();
        const c1 = getConfig({ configDir: 'Z:\\fake', keysFile: 'none.json' });
        const c2 = getConfig();
        expect(c1).toBe(c2);
    });

    test('resetConfig() clears singleton — next getConfig() creates fresh instance', () => {
        resetConfig();
        const c1 = getConfig({ port: 11111, configDir: 'Z:\\fake', keysFile: 'none.json' });
        expect(c1.port).toBe(11111);

        resetConfig();
        const c2 = getConfig({ port: 22222, configDir: 'Z:\\fake', keysFile: 'none.json' });
        expect(c2.port).toBe(22222);
        expect(c1).not.toBe(c2);
    });
});
