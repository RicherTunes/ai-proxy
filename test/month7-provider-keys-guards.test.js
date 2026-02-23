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

// ═══════════════════════════════════════════════════════════════════════
// GUARD-12: Untagged key cost-safety restriction
// ═══════════════════════════════════════════════════════════════════════

describe('GUARD-12: Untagged keys restricted to default provider', () => {
    let km;

    afterEach(() => {
        if (km) {
            km.destroy?.();
            km = null;
        }
    });

    test('untagged keys (flat array) are NOT returned for metered provider', () => {
        // CRITICAL COST-SAFETY: flat-file keys must never silently route to metered providers.
        // When defaultProviderName is set, untagged keys only match that provider.
        km = new KeyManager({ maxConcurrencyPerKey: 5, defaultProviderName: 'z.ai' });
        km.loadKeys(['key1.secret1', 'key2.secret2']); // flat array → provider=null

        // Requesting anthropic (metered) with only untagged keys → null
        const key = km.acquireKey([], 'anthropic');
        expect(key).toBeNull();
    });

    test('untagged keys ARE returned for the default provider', () => {
        km = new KeyManager({ maxConcurrencyPerKey: 5, defaultProviderName: 'z.ai' });
        km.loadKeys(['key1.secret1', 'key2.secret2']); // flat array → provider=null

        // Requesting z.ai (default) with untagged keys → works
        const key = km.acquireKey([], 'z.ai');
        expect(key).not.toBeNull();
        km.recordSuccess(key, 100);
    });

    test('untagged keys pass any filter when no defaultProviderName set (legacy compat)', () => {
        // If defaultProviderName is not configured (legacy mode), untagged keys pass any filter.
        km = new KeyManager({ maxConcurrencyPerKey: 5 }); // no defaultProviderName
        km.loadKeys(['key1.secret1', 'key2.secret2']);

        // Without defaultProviderName, untagged keys match any provider (legacy behavior)
        const key = km.acquireKey([], 'anthropic');
        expect(key).not.toBeNull();
        km.recordSuccess(key, 100);
    });

    test('tagged keys still work normally alongside untagged restriction', () => {
        km = new KeyManager({ maxConcurrencyPerKey: 5, defaultProviderName: 'z.ai' });
        km.loadKeys({ 'z.ai': ['zkey.s1'], 'anthropic': ['sk-ant.s2'] });

        // Tagged anthropic key works for anthropic
        const antKey = km.acquireKey([], 'anthropic');
        expect(antKey).not.toBeNull();
        expect(antKey.provider).toBe('anthropic');
        km.recordSuccess(antKey, 100);

        // Tagged z.ai key works for z.ai
        const zKey = km.acquireKey([], 'z.ai');
        expect(zKey).not.toBeNull();
        expect(zKey.provider).toBe('z.ai');
        km.recordSuccess(zKey, 100);
    });

    test('mixed tagged + untagged: untagged only eligible for default provider', () => {
        // Real-world scenario: user has flat keys file + adds one provider-specific key
        km = new KeyManager({ maxConcurrencyPerKey: 5, defaultProviderName: 'z.ai' });

        // Load flat array first (untagged), then provider-specific
        km.loadKeys(['flat-key1.s1', 'flat-key2.s2']);
        // Reload with provider map that includes untagged-style keys
        km.reloadKeys({ 'anthropic': ['sk-ant.s1'] });

        // Only tagged anthropic key should be returned for anthropic
        const antKey = km.acquireKey([], 'anthropic');
        expect(antKey).not.toBeNull();
        expect(antKey.provider).toBe('anthropic');
        km.recordSuccess(antKey, 100);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// GUARD-13: Per-key override limitation in provider-first flow
// ═══════════════════════════════════════════════════════════════════════

describe('GUARD-13: Per-key override limitation', () => {
    test('transformRequestBody with keyIndex=null still resolves provider', async () => {
        // In provider-first flow, keyIndex is null during pre-flight transform.
        // Provider resolution must work without per-key context.
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

        // keyIndex=null (no key acquired yet) — provider-first flow
        const result = await transformRequestBody(
            body, null, null, null, null,
            null, null, registry, mapping
        );
        expect(result.provider).toBe('anthropic');
        expect(result.mappedModel).toBe('claude-opus-4');
    });

    test('x-model-override header requires router (not available in provider-first pre-flight)', async () => {
        // Document: per-key overrides via x-model-override require a modelRouter.
        // In provider-first flow, the pre-flight transform runs without per-key context.
        const body = Buffer.from(JSON.stringify({ model: 'test-model', messages: [] }));

        // Without router, override headers are ignored — this is expected behavior
        const mockReq = { headers: { 'x-model-override': 'different-model' } };
        const result = await transformRequestBody(
            body, null, null, mockReq, null,
            null, // no router → override ignored
            null, null, null
        );
        // Model unchanged since no router to process override
        expect(result.originalModel).toBe('test-model');
        expect(result.mappedModel).toBe('test-model');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// GUARD-14: Unknown provider in model mapping yields deterministic error
// ═══════════════════════════════════════════════════════════════════════

describe('GUARD-14: Unknown provider yields null resolution', () => {
    test('resolveProviderForModel returns null for non-configured provider', () => {
        // GUARD-02: Model mapping references a provider that doesn't exist in registry
        const registry = new ProviderRegistry({
            'z.ai': { costTier: 'free' }
            // 'openai' NOT configured
        });
        const mapping = {
            models: {
                'gpt-4': { target: 'gpt-4', provider: 'openai' }
            }
        };
        const result = registry.resolveProviderForModel('gpt-4', mapping);
        expect(result).toBeNull(); // Not silently routed to default
    });

    test('transformRequestBody returns null provider for unconfigured provider', async () => {
        const registry = new ProviderRegistry({
            'z.ai': { costTier: 'free' }
        });
        const mapping = {
            models: {
                'gpt-4': { target: 'gpt-4', provider: 'openai' }
            }
        };
        const body = Buffer.from(JSON.stringify({ model: 'gpt-4', messages: [] }));
        const result = await transformRequestBody(
            body, null, null, null, null,
            null, null, registry, mapping
        );
        // Provider is null because openai is not in the registry
        expect(result.provider).toBeNull();
    });

    test('acquireKey with null provider filter falls through to no-filter path', () => {
        // When transformRequestBody returns null provider (unconfigured),
        // the request handler gets providerFilter=null.
        // This means acquireKey runs without provider filter — backward compat.
        const km = new KeyManager({ maxConcurrencyPerKey: 5 });
        km.loadKeys(['key1.s1']);

        // null provider filter → no filtering, any key works
        const key = km.acquireKey([], null);
        expect(key).not.toBeNull();
        km.recordSuccess(key, 100);
        km.destroy?.();
    });
});
