/**
 * Month 7 Provider-Keys Guard Tests
 *
 * TDD guards for per-provider key pools and provider-first routing.
 * Guards marked .todo define target behavior (will fail until implemented).
 * Guards without .todo document current behavior that MUST NOT regress.
 */

'use strict';

const { KeyManager } = require('../lib/key-manager');
const { ProviderRegistry } = require('../lib/provider-registry');
const { transformRequestBody } = require('../lib/request/model-transformer');

// ═══════════════════════════════════════════════════════════════════════
// GUARD-08: Per-provider key pools
// ═══════════════════════════════════════════════════════════════════════

describe('GUARD-08: Per-provider key pools', () => {
    let km;

    afterEach(() => {
        if (km) {
            km.destroy?.();
            km = null;
        }
    });

    test('current: loadKeys accepts flat array (backward compat)', () => {
        km = new KeyManager({ maxConcurrencyPerKey: 5 });
        km.loadKeys(['key1.secret1', 'key2.secret2']);
        expect(km.keys).toHaveLength(2);
        // All keys have provider: null for flat array input
        for (const key of km.keys) {
            expect(key.provider).toBeNull();
        }
    });

    test('loadKeys with provider map creates tagged key pools', () => {
        km = new KeyManager({ maxConcurrencyPerKey: 5 });
        km.loadKeys({ 'z.ai': ['zkey.s1'], 'anthropic': ['sk-ant.s2'] });
        expect(km.keys).toHaveLength(2);
        expect(km.keys[0].provider).toBe('z.ai');
        expect(km.keys[1].provider).toBe('anthropic');
    });

    test('acquireKey(provider) returns key from correct pool', () => {
        km = new KeyManager({ maxConcurrencyPerKey: 5 });
        km.loadKeys({ 'z.ai': ['zkey.s1'], 'anthropic': ['sk-ant.s2'] });
        const key = km.acquireKey([], 'anthropic');
        expect(key).not.toBeNull();
        expect(key.provider).toBe('anthropic');
    });

    test('acquireKey(provider) returns null when provider has no keys', () => {
        km = new KeyManager({ maxConcurrencyPerKey: 5 });
        km.loadKeys({ 'z.ai': ['zkey.s1'] });
        const key = km.acquireKey([], 'anthropic');
        expect(key).toBeNull();
    });

    test('acquireKey without provider arg uses all keys (backward compat)', () => {
        km = new KeyManager({ maxConcurrencyPerKey: 5 });
        km.loadKeys({ 'z.ai': ['zkey.s1'], 'anthropic': ['sk-ant.s2'] });
        const key = km.acquireKey(); // no provider filter
        expect(key).toBeDefined();
        expect(key).not.toBeNull();
    });
});

// ═══════════════════════════════════════════════════════════════════════
// GUARD-09: Key isolation enforcement
// ═══════════════════════════════════════════════════════════════════════

describe('GUARD-09: Key isolation enforcement', () => {
    let km;

    afterEach(() => {
        if (km) {
            km.destroy?.();
            km = null;
        }
    });

    test('z.ai key is never returned when requesting anthropic provider', () => {
        km = new KeyManager({ maxConcurrencyPerKey: 5 });
        km.loadKeys({ 'z.ai': ['zkey.s1', 'zkey.s2'] });
        const key = km.acquireKey([], 'anthropic');
        expect(key).toBeNull(); // no anthropic keys exist
    });

    test('key provider tag matches what was loaded', () => {
        km = new KeyManager({ maxConcurrencyPerKey: 5 });
        km.loadKeys({ 'z.ai': ['zkey.s1'], 'anthropic': ['sk-ant.s2'] });
        expect(km.keys[0].provider).toBe('z.ai');
        expect(km.keys[1].provider).toBe('anthropic');
    });

    test('current: formatAuthHeader prevents cross-provider auth', () => {
        // Even today, formatAuthHeader returns null for unknown providers
        const registry = new ProviderRegistry();
        const auth = registry.formatAuthHeader('nonexistent', 'key');
        expect(auth).toBeNull();
    });
});

// ═══════════════════════════════════════════════════════════════════════
// GUARD-10: modelMapping wired to resolveProviderForModel
// ═══════════════════════════════════════════════════════════════════════

describe('GUARD-10: modelMapping wired to resolveProviderForModel', () => {
    test('current: resolveProviderForModel with null mapping returns default', () => {
        const registry = new ProviderRegistry();
        const result = registry.resolveProviderForModel('some-model', null);
        expect(result).toEqual({ providerName: 'z.ai', targetModel: 'some-model' });
    });

    test('resolveProviderForModel with object mapping routes to correct provider', () => {
        const registry = new ProviderRegistry({
            'z.ai': { costTier: 'free' },
            'anthropic': { costTier: 'metered' }
        });
        const mapping = {
            models: {
                'claude-opus-4': { target: 'claude-opus-4', provider: 'anthropic' }
            }
        };
        const result = registry.resolveProviderForModel('claude-opus-4', mapping);
        expect(result).toEqual({ providerName: 'anthropic', targetModel: 'claude-opus-4' });
    });

    test('transformRequestBody returns provider field', async () => {
        const registry = new ProviderRegistry();
        const body = Buffer.from(JSON.stringify({ model: 'test-model', messages: [] }));
        const result = await transformRequestBody(body, null, null, null, null, null, null, registry);
        expect(result.provider).toBe('z.ai');
    });

    test('transformRequestBody uses modelMapping for provider resolution (no router)', async () => {
        // Without a modelRouter, the original model is resolved against modelMapping.
        // If the model is in the mapping with a provider, that provider is returned.
        const registry = new ProviderRegistry({
            'z.ai': { costTier: 'free' },
            'anthropic': { costTier: 'metered' }
        });
        const mapping = {
            models: {
                'claude-opus-4': { target: 'claude-opus-4', provider: 'anthropic' }
            }
        };
        const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4', messages: [] }));
        const result = await transformRequestBody(
            body, null, null, null, null,
            null,  // no modelRouter
            null,  // no overrideLogThrottle
            registry,
            mapping
        );
        expect(result.provider).toBe('anthropic');
    });

    test('transformRequestBody uses modelMapping for provider resolution (with router)', async () => {
        // With a modelRouter that returns a model, the routed model is resolved
        // against modelMapping. If the routed model maps to a provider, that provider is returned.
        const registry = new ProviderRegistry({
            'z.ai': { costTier: 'free' },
            'anthropic': { costTier: 'metered' }
        });
        const mapping = {
            models: {
                'claude-opus-4': { target: 'claude-opus-4', provider: 'anthropic' }
            }
        };
        // Minimal mock modelRouter that routes to claude-opus-4
        const mockRouter = {
            config: { logDecisions: false },
            shadowMode: false,
            selectModel: async () => ({ model: 'claude-opus-4', source: 'test', tier: 'opus' })
        };
        const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4-6', messages: [] }));
        const result = await transformRequestBody(
            body, null, null, null, null,
            mockRouter,
            null,  // no overrideLogThrottle
            registry,
            mapping
        );
        expect(result.provider).toBe('anthropic');
        expect(result.mappedModel).toBe('claude-opus-4');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// GUARD-11: Provider-first flow ordering
// ═══════════════════════════════════════════════════════════════════════

describe('GUARD-11: Provider-first flow ordering', () => {
    test('acquireKey accepts providerFilter parameter', () => {
        // The provider-first flow passes provider to acquireKey.
        // Verify the interface works: provider filter restricts key pool.
        const km = new KeyManager({ maxConcurrencyPerKey: 5 });
        km.loadKeys({ 'z.ai': ['zkey.s1'], 'anthropic': ['sk-ant.s2'] });

        // Acquire from anthropic pool
        const antKey = km.acquireKey([], 'anthropic');
        expect(antKey).not.toBeNull();
        expect(antKey.provider).toBe('anthropic');
        km.recordSuccess(antKey, 100);

        // Acquire from z.ai pool
        const zKey = km.acquireKey([], 'z.ai');
        expect(zKey).not.toBeNull();
        expect(zKey.provider).toBe('z.ai');
        km.recordSuccess(zKey, 100);

        km.destroy?.();
    });

    test('503 when provider has no available keys', () => {
        // Even if z.ai has keys, if requesting anthropic provider with no
        // anthropic keys loaded, acquireKey returns null.
        const km = new KeyManager({ maxConcurrencyPerKey: 5 });
        km.loadKeys({ 'z.ai': ['zkey.s1', 'zkey.s2'] });

        // z.ai keys exist but anthropic pool is empty
        const antKey = km.acquireKey([], 'anthropic');
        expect(antKey).toBeNull();

        // z.ai keys still work
        const zKey = km.acquireKey([], 'z.ai');
        expect(zKey).not.toBeNull();
        km.recordSuccess(zKey, 100);

        km.destroy?.();
    });
});
