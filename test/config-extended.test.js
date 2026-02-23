/**
 * Config Module Extended Tests
 * Targets uncovered lines: 449,454,457,464,472,475,481,486,490,569-572,653,701,705-707
 *
 * Focus areas:
 * - _validate() method: all validation branches that produce errors
 * - Float env var parsing in _applyEnvOverrides()
 * - Lazy initialization of modelMappingManager getter
 * - Convenience getters for keySelection, clusterWorkerPersistence, histogram, costTracking
 */

const path = require('path');
const fs = require('fs');
const { Config, getConfig, resetConfig, DEFAULT_CONFIG } = require('../lib/config');

describe('Config Extended - Validation', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        resetConfig();
        process.env = { ...originalEnv };
        jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
            throw new Error('No keys file');
        });
    });

    afterEach(() => {
        process.env = originalEnv;
        jest.restoreAllMocks();
    });

    // Line 449: Invalid port
    test('should throw on invalid port (negative)', () => {
        expect(() => new Config({ port: -1 })).toThrow('Configuration validation failed');
        expect(() => new Config({ port: -1 })).toThrow('Invalid port');
    });

    test('should throw on invalid port (too high)', () => {
        expect(() => new Config({ port: 70000 })).toThrow('Invalid port');
    });

    test('should throw on non-finite port (NaN)', () => {
        expect(() => new Config({ port: NaN })).toThrow('Invalid port');
    });

    test('should throw on non-finite port (Infinity)', () => {
        expect(() => new Config({ port: Infinity })).toThrow('Invalid port');
    });

    // Line 454: Invalid maxConcurrencyPerKey
    test('should throw on invalid maxConcurrencyPerKey (zero)', () => {
        expect(() => new Config({ maxConcurrencyPerKey: 0 })).toThrow('Invalid maxConcurrencyPerKey');
    });

    test('should throw on invalid maxConcurrencyPerKey (negative)', () => {
        expect(() => new Config({ maxConcurrencyPerKey: -1 })).toThrow('Invalid maxConcurrencyPerKey');
    });

    test('should throw on non-finite maxConcurrencyPerKey', () => {
        expect(() => new Config({ maxConcurrencyPerKey: NaN })).toThrow('Invalid maxConcurrencyPerKey');
    });

    // Line 457: Invalid maxTotalConcurrency
    test('should throw on invalid maxTotalConcurrency (negative)', () => {
        expect(() => new Config({ maxTotalConcurrency: -1 })).toThrow('Invalid maxTotalConcurrency');
    });

    test('should throw on non-finite maxTotalConcurrency', () => {
        expect(() => new Config({ maxTotalConcurrency: NaN })).toThrow('Invalid maxTotalConcurrency');
    });

    // Line 464: Invalid timeout fields
    test('should throw on invalid requestTimeout (negative)', () => {
        expect(() => new Config({ requestTimeout: -100 })).toThrow('Invalid requestTimeout');
    });

    test('should throw on non-finite keepAliveTimeout', () => {
        expect(() => new Config({ keepAliveTimeout: NaN })).toThrow('Invalid keepAliveTimeout');
    });

    test('should throw on non-finite freeSocketTimeout', () => {
        expect(() => new Config({ freeSocketTimeout: Infinity })).toThrow('Invalid freeSocketTimeout');
    });

    test('should throw on invalid queueTimeout', () => {
        expect(() => new Config({ queueTimeout: -1 })).toThrow('Invalid queueTimeout');
    });

    // Line 472: Invalid circuitBreaker.failureThreshold
    test('should throw on invalid circuitBreaker.failureThreshold (zero)', () => {
        expect(() => new Config({
            circuitBreaker: { failureThreshold: 0, cooldownPeriod: 60000 }
        })).toThrow('Invalid circuitBreaker.failureThreshold');
    });

    test('should throw on non-finite circuitBreaker.failureThreshold', () => {
        expect(() => new Config({
            circuitBreaker: { failureThreshold: NaN, cooldownPeriod: 60000 }
        })).toThrow('Invalid circuitBreaker.failureThreshold');
    });

    // Line 475: Invalid circuitBreaker.cooldownPeriod
    test('should throw on invalid circuitBreaker.cooldownPeriod (negative)', () => {
        expect(() => new Config({
            circuitBreaker: { failureThreshold: 5, cooldownPeriod: -1 }
        })).toThrow('Invalid circuitBreaker.cooldownPeriod');
    });

    test('should throw on non-finite circuitBreaker.cooldownPeriod', () => {
        expect(() => new Config({
            circuitBreaker: { failureThreshold: 5, cooldownPeriod: NaN }
        })).toThrow('Invalid circuitBreaker.cooldownPeriod');
    });

    // Line 481: Invalid maxRetries
    test('should throw on invalid maxRetries (negative)', () => {
        expect(() => new Config({ maxRetries: -1 })).toThrow('Invalid maxRetries');
    });

    test('should throw on non-finite maxRetries', () => {
        expect(() => new Config({ maxRetries: NaN })).toThrow('Invalid maxRetries');
    });

    // Line 486: Invalid queueSize
    test('should throw on invalid queueSize (negative)', () => {
        expect(() => new Config({ queueSize: -1 })).toThrow('Invalid queueSize');
    });

    test('should throw on non-finite queueSize', () => {
        expect(() => new Config({ queueSize: NaN })).toThrow('Invalid queueSize');
    });

    // Line 490: Multiple validation errors combined
    test('should combine multiple validation errors into one throw', () => {
        try {
            new Config({
                port: -1,
                maxConcurrencyPerKey: 0,
                maxRetries: -1
            });
            // Should not reach here
            expect(true).toBe(false);
        } catch (err) {
            expect(err.message).toContain('Configuration validation failed');
            expect(err.message).toContain('Invalid port');
            expect(err.message).toContain('Invalid maxConcurrencyPerKey');
            expect(err.message).toContain('Invalid maxRetries');
        }
    });

    // Boundary: valid edge cases should NOT throw
    test('should accept port 0 (OS-assigned)', () => {
        expect(() => new Config({ port: 0 })).not.toThrow();
    });

    test('should accept port 65535 (max)', () => {
        expect(() => new Config({ port: 65535 })).not.toThrow();
    });

    test('should accept maxRetries 0', () => {
        expect(() => new Config({ maxRetries: 0 })).not.toThrow();
    });

    test('should accept maxTotalConcurrency 0', () => {
        expect(() => new Config({ maxTotalConcurrency: 0 })).not.toThrow();
    });

    test('should accept queueSize 0', () => {
        expect(() => new Config({ queueSize: 0 })).not.toThrow();
    });
});

describe('Config Extended - Float Env Var Parsing', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        resetConfig();
        process.env = { ...originalEnv };
        jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
            throw new Error('No keys file');
        });
    });

    afterEach(() => {
        process.env = originalEnv;
        jest.restoreAllMocks();
    });

    // Lines 569-572: float env var parsing
    // GLM_COST_DAILY_BUDGET maps to 'costTracking.budget.daily' — deep nesting sets the leaf property.
    test('should parse GLM_COST_DAILY_BUDGET as float (exercises float branch)', () => {
        process.env.GLM_COST_DAILY_BUDGET = '50.75';
        const config = new Config();
        // Deep nesting sets costTracking.budget.daily = 50.75
        expect(config.get('costTracking.budget.daily')).toBe(50.75);
    });

    test('should parse GLM_COST_MONTHLY_BUDGET as float (exercises float branch)', () => {
        process.env.GLM_COST_MONTHLY_BUDGET = '999.99';
        const config = new Config();
        // Deep nesting sets costTracking.budget.monthly = 999.99
        expect(config.get('costTracking.budget.monthly')).toBe(999.99);
    });

    test('should parse GLM_SLOW_KEY_THRESHOLD as float', () => {
        process.env.GLM_SLOW_KEY_THRESHOLD = '3.5';
        const config = new Config();
        expect(config.get('keySelection.slowKeyThreshold')).toBe(3.5);
    });

    test('should skip invalid float env var (NaN)', () => {
        process.env.GLM_SLOW_KEY_THRESHOLD = 'not-a-number';
        const config = new Config();
        // Should remain the default since parseFloat('not-a-number') is NaN
        expect(config.get('keySelection.slowKeyThreshold')).toBe(DEFAULT_CONFIG.keySelection.slowKeyThreshold);
    });

    test('should skip invalid int env var (NaN)', () => {
        process.env.GLM_PORT = 'not-a-number';
        const config = new Config();
        // Should remain the default
        expect(config.port).toBe(DEFAULT_CONFIG.port);
    });

    test('deep-nested env overrides: pool429Penalty (3-level path)', () => {
        process.env.GLM_POOL_429_PENALTY_ENABLED = 'false';
        process.env.GLM_POOL_429_PENALTY_WINDOW_MS = '60000';
        process.env.GLM_POOL_429_PENALTY_WEIGHT = '0.75';
        const config = new Config();

        // Verify 3-level nesting works correctly
        const penalty = config.get('modelRouting.pool429Penalty');
        expect(penalty).toBeDefined();
        expect(penalty.enabled).toBe(false);
        expect(penalty.windowMs).toBe(60000);
        expect(penalty.penaltyWeight).toBe(0.75);
        // maxPenaltyHits should retain default (no env override for it)
        expect(penalty.maxPenaltyHits).toBe(20);
    });

    test('deep-nested env overrides do not clobber sibling keys', () => {
        // Setting one deeply nested key should not destroy siblings.
        // Only set GLM_POOL_429_PENALTY_WINDOW_MS (NOT enabled or weight)
        // to verify only that one leaf is modified.
        process.env.GLM_POOL_429_PENALTY_WINDOW_MS = '30000';
        const config = new Config();

        const penalty = config.get('modelRouting.pool429Penalty');
        expect(penalty.windowMs).toBe(30000);
        // Siblings should still be present (not clobbered)
        expect(typeof penalty.enabled).toBe('boolean');
        expect(typeof penalty.penaltyWeight).toBe('number');
        expect(penalty.maxPenaltyHits).toBe(20);
    });

    test('2-level env overrides still work after deep-nesting fix', () => {
        // Regression guard: ensure existing 2-level env overrides still work
        process.env.GLM_POOL_COOLDOWN_BASE = '500';
        process.env.GLM_SLOW_KEY_THRESHOLD = '2.5';
        const config = new Config();

        expect(config.get('poolCooldown.baseMs')).toBe(500);
        expect(config.get('keySelection.slowKeyThreshold')).toBe(2.5);
    });
});

describe('Config Extended - ModelMappingManager Lazy Init', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        resetConfig();
        process.env = { ...originalEnv };
        jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
            throw new Error('No keys file');
        });
    });

    afterEach(() => {
        process.env = originalEnv;
        jest.restoreAllMocks();
    });

    // Line 653: Lazy initialization fallback when _modelMappingManager is nullified
    test('should lazily create modelMappingManager if internal reference is cleared', () => {
        const config = new Config();
        // Force the internal reference to null to exercise the lazy init path
        config._modelMappingManager = null;

        const manager = config.modelMappingManager;
        expect(manager).toBeDefined();
        expect(manager.enabled).toBe(DEFAULT_CONFIG.modelMapping.enabled);
    });
});

describe('Config Extended - Convenience Getters', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        resetConfig();
        process.env = { ...originalEnv };
        jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
            throw new Error('No keys file');
        });
    });

    afterEach(() => {
        process.env = originalEnv;
        jest.restoreAllMocks();
    });

    // Lines 701, 705-707: Convenience getters
    test('should return keySelection config via getter', () => {
        const config = new Config();
        const ks = config.keySelection;
        expect(ks).toBeDefined();
        expect(ks.useWeightedSelection).toBe(DEFAULT_CONFIG.keySelection.useWeightedSelection);
        expect(ks.slowKeyThreshold).toBe(DEFAULT_CONFIG.keySelection.slowKeyThreshold);
    });

    test('should return clusterWorkerPersistence config via getter', () => {
        const config = new Config();
        const cwp = config.clusterWorkerPersistence;
        expect(cwp).toBeDefined();
        expect(cwp.statsEnabled).toBe(false);
        expect(cwp.historyEnabled).toBe(false);
        expect(cwp.costEnabled).toBe(false);
        expect(cwp.requestStoreEnabled).toBe(false);
    });

    test('should return histogram config via getter', () => {
        const config = new Config();
        const h = config.histogram;
        expect(h).toBeDefined();
        expect(h.enabled).toBe(true);
        expect(h.buckets).toEqual(DEFAULT_CONFIG.histogram.buckets);
        expect(h.maxDataPoints).toBe(DEFAULT_CONFIG.histogram.maxDataPoints);
    });

    test('should return costTracking config via getter', () => {
        const config = new Config();
        const ct = config.costTracking;
        expect(ct).toBeDefined();
        expect(ct.enabled).toBe(true);
        expect(ct.rates.inputTokenPer1M).toBe(3.00);
        expect(ct.rates.outputTokenPer1M).toBe(15.00);
        expect(ct.budget).toBeDefined();
        expect(ct.persistPath).toBe('cost-data.json');
    });

    test('should return adaptiveTimeout config via getter', () => {
        const config = new Config();
        const at = config.adaptiveTimeout;
        expect(at).toBeDefined();
        expect(at.enabled).toBe(true);
        expect(at.initialMs).toBe(DEFAULT_CONFIG.adaptiveTimeout.initialMs);
    });

    test('should return usageMonitor config via getter', () => {
        const config = new Config();
        const um = config.usageMonitor;
        expect(um).toBeDefined();
        expect(um.enabled).toBe(DEFAULT_CONFIG.usageMonitor.enabled);
    });

    test('should return connectionHealth config via getter', () => {
        const config = new Config();
        const ch = config.connectionHealth;
        expect(ch).toBeDefined();
        expect(ch.maxConsecutiveHangups).toBe(DEFAULT_CONFIG.connectionHealth.maxConsecutiveHangups);
    });

    test('should return poolCooldown config via getter', () => {
        const config = new Config();
        const pc = config.poolCooldown;
        expect(pc).toBeDefined();
        expect(pc.sleepThresholdMs).toBe(DEFAULT_CONFIG.poolCooldown.sleepThresholdMs);
    });

    test('should return retryConfig via getter', () => {
        const config = new Config();
        const rc = config.retryConfig;
        expect(rc).toBeDefined();
        expect(rc.baseDelayMs).toBe(DEFAULT_CONFIG.retryConfig.baseDelayMs);
        expect(rc.maxDelayMs).toBe(DEFAULT_CONFIG.retryConfig.maxDelayMs);
    });

    test('should return security config via getter', () => {
        const config = new Config();
        const sec = config.security;
        expect(sec).toBeDefined();
        expect(sec.mode).toBe('local');
        expect(sec.cors).toBeDefined();
    });

    test('should return modelRouting config via getter', () => {
        const config = new Config();
        const mr = config.modelRouting;
        expect(mr).toBeDefined();
        expect(mr.enabled).toBe(true);
    });

    test('should return requestStore config via getter', () => {
        const config = new Config();
        const rs = config.requestStore;
        expect(rs).toBeDefined();
        expect(rs.enabled).toBe(false);
    });

    test('should return multiTenant config via getter', () => {
        const config = new Config();
        const mt = config.multiTenant;
        expect(mt).toBeDefined();
        expect(mt.enabled).toBe(false);
    });

    test('should return adminAuth config via getter', () => {
        const config = new Config();
        const aa = config.adminAuth;
        expect(aa).toBeDefined();
        expect(aa.enabled).toBe(false);
    });
});
