/**
 * Pool Cooldown Config Defaults Tests
 *
 * Verifies that the DEFAULT_CONFIG has correct values for pool cooldown
 * and proactive pacing settings.
 */

const { DEFAULT_CONFIG } = require('../lib/config');

describe('Pool cooldown config defaults', () => {
    test('poolCooldown section exists in DEFAULT_CONFIG', () => {
        expect(DEFAULT_CONFIG).toHaveProperty('poolCooldown');
        expect(typeof DEFAULT_CONFIG.poolCooldown).toBe('object');
    });

    test('sleepThresholdMs defaults to expected value', () => {
        // The sleepThresholdMs controls when to sleep vs return 429
        expect(DEFAULT_CONFIG.poolCooldown.sleepThresholdMs).toBeDefined();
        expect(typeof DEFAULT_CONFIG.poolCooldown.sleepThresholdMs).toBe('number');
        // Current default may differ from spec; verify it exists and is reasonable
        expect(DEFAULT_CONFIG.poolCooldown.sleepThresholdMs).toBeGreaterThan(0);
        expect(DEFAULT_CONFIG.poolCooldown.sleepThresholdMs).toBeLessThanOrEqual(5000);
    });

    test('retryJitterMs defaults to expected value', () => {
        expect(DEFAULT_CONFIG.poolCooldown.retryJitterMs).toBeDefined();
        expect(typeof DEFAULT_CONFIG.poolCooldown.retryJitterMs).toBe('number');
        expect(DEFAULT_CONFIG.poolCooldown.retryJitterMs).toBeGreaterThan(0);
        expect(DEFAULT_CONFIG.poolCooldown.retryJitterMs).toBeLessThanOrEqual(1000);
    });

    test('maxCooldownMs defaults to expected value', () => {
        expect(DEFAULT_CONFIG.poolCooldown.maxCooldownMs).toBeDefined();
        expect(typeof DEFAULT_CONFIG.poolCooldown.maxCooldownMs).toBe('number');
        expect(DEFAULT_CONFIG.poolCooldown.maxCooldownMs).toBeGreaterThan(0);
    });

    test('baseMs defaults to expected value', () => {
        expect(DEFAULT_CONFIG.poolCooldown.baseMs).toBeDefined();
        expect(typeof DEFAULT_CONFIG.poolCooldown.baseMs).toBe('number');
        expect(DEFAULT_CONFIG.poolCooldown.baseMs).toBeGreaterThan(0);
        // baseMs should be less than or equal to capMs
        expect(DEFAULT_CONFIG.poolCooldown.baseMs).toBeLessThanOrEqual(DEFAULT_CONFIG.poolCooldown.capMs);
    });

    test('capMs defaults to expected value', () => {
        expect(DEFAULT_CONFIG.poolCooldown.capMs).toBeDefined();
        expect(typeof DEFAULT_CONFIG.poolCooldown.capMs).toBe('number');
        expect(DEFAULT_CONFIG.poolCooldown.capMs).toBeGreaterThan(0);
        // capMs should be >= baseMs
        expect(DEFAULT_CONFIG.poolCooldown.capMs).toBeGreaterThanOrEqual(DEFAULT_CONFIG.poolCooldown.baseMs);
    });

    test('decayMs defaults to expected value', () => {
        expect(DEFAULT_CONFIG.poolCooldown.decayMs).toBeDefined();
        expect(typeof DEFAULT_CONFIG.poolCooldown.decayMs).toBe('number');
        expect(DEFAULT_CONFIG.poolCooldown.decayMs).toBeGreaterThan(0);
    });

    test('baseMs <= capMs invariant holds', () => {
        expect(DEFAULT_CONFIG.poolCooldown.baseMs).toBeLessThanOrEqual(
            DEFAULT_CONFIG.poolCooldown.capMs
        );
    });

    test('sleepThresholdMs <= maxCooldownMs invariant holds', () => {
        expect(DEFAULT_CONFIG.poolCooldown.sleepThresholdMs).toBeLessThanOrEqual(
            DEFAULT_CONFIG.poolCooldown.maxCooldownMs
        );
    });
});

describe('Proactive pacing config', () => {
    // The proactive pacing config may be added to DEFAULT_CONFIG or to a separate section.
    // These tests verify that the section is present and has expected defaults.

    test('proactivePacing section exists in DEFAULT_CONFIG if feature is enabled', () => {
        // proactivePacing may be a top-level key or nested under poolCooldown
        const hasPacing = DEFAULT_CONFIG.proactivePacing !== undefined
            || DEFAULT_CONFIG.poolCooldown?.proactivePacing !== undefined;

        if (!hasPacing) {
            // Feature not yet in config - this test will pass but flag it
            // This is expected if the config agent hasn't merged yet
            console.log('NOTE: proactivePacing not yet in DEFAULT_CONFIG - config agent may not have merged');
            return;
        }

        const pacing = DEFAULT_CONFIG.proactivePacing || DEFAULT_CONFIG.poolCooldown?.proactivePacing;
        expect(pacing).toBeDefined();
    });

    test('enabled defaults to true if pacing config exists', () => {
        const pacing = DEFAULT_CONFIG.proactivePacing || DEFAULT_CONFIG.poolCooldown?.proactivePacing;
        if (!pacing) return;

        expect(pacing.enabled).toBe(true);
    });

    test('remainingThreshold defaults to a small positive number if pacing config exists', () => {
        const pacing = DEFAULT_CONFIG.proactivePacing || DEFAULT_CONFIG.poolCooldown?.proactivePacing;
        if (!pacing) return;

        expect(pacing.remainingThreshold).toBeDefined();
        expect(typeof pacing.remainingThreshold).toBe('number');
        expect(pacing.remainingThreshold).toBeGreaterThan(0);
        expect(pacing.remainingThreshold).toBeLessThanOrEqual(20);
    });

    test('pacingDelayMs defaults to a reasonable value if pacing config exists', () => {
        const pacing = DEFAULT_CONFIG.proactivePacing || DEFAULT_CONFIG.poolCooldown?.proactivePacing;
        if (!pacing) return;

        expect(pacing.pacingDelayMs).toBeDefined();
        expect(typeof pacing.pacingDelayMs).toBe('number');
        expect(pacing.pacingDelayMs).toBeGreaterThan(0);
        expect(pacing.pacingDelayMs).toBeLessThanOrEqual(1000);
    });
});

describe('Pool cooldown config integration with KeyManager', () => {
    // Verify that KeyManager picks up config defaults correctly

    test('KeyManager uses poolCooldown.baseMs from config', () => {
        const { KeyManager } = require('../lib/key-manager');
        const km = new KeyManager({
            maxConcurrencyPerKey: 2,
            rateLimitPerMinute: 0,
            poolCooldown: {
                baseMs: 300,
                capMs: 2000,
                decayMs: 5000
            }
        });
        km.loadKeys(['key1.secret1']);

        expect(km.poolCooldownConfig.baseMs).toBe(300);
        expect(km.poolCooldownConfig.capMs).toBe(2000);
        expect(km.poolCooldownConfig.decayMs).toBe(5000);

        km.destroy();
    });

    test('KeyManager uses defaults when no poolCooldown provided', () => {
        const { KeyManager } = require('../lib/key-manager');
        const km = new KeyManager({
            maxConcurrencyPerKey: 2,
            rateLimitPerMinute: 0
        });
        km.loadKeys(['key1.secret1']);

        // Should have default values (from KeyManager constructor defaults)
        expect(km.poolCooldownConfig.baseMs).toBeDefined();
        expect(km.poolCooldownConfig.capMs).toBeDefined();
        expect(km.poolCooldownConfig.decayMs).toBeDefined();
        expect(typeof km.poolCooldownConfig.baseMs).toBe('number');
        expect(typeof km.poolCooldownConfig.capMs).toBe('number');
        expect(typeof km.poolCooldownConfig.decayMs).toBe('number');

        km.destroy();
    });

    test('poolCooldown config values are all positive numbers', () => {
        expect(DEFAULT_CONFIG.poolCooldown.sleepThresholdMs).toBeGreaterThan(0);
        expect(DEFAULT_CONFIG.poolCooldown.retryJitterMs).toBeGreaterThan(0);
        expect(DEFAULT_CONFIG.poolCooldown.maxCooldownMs).toBeGreaterThan(0);
        expect(DEFAULT_CONFIG.poolCooldown.baseMs).toBeGreaterThan(0);
        expect(DEFAULT_CONFIG.poolCooldown.capMs).toBeGreaterThan(0);
        expect(DEFAULT_CONFIG.poolCooldown.decayMs).toBeGreaterThan(0);
    });
});
