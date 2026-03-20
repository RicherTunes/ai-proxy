/**
 * Provider Registry Edge-Case Tests
 *
 * Comprehensive edge-case coverage for the ProviderRegistry module.
 * Covers: default provider fallback, lookup by name, unknown providers,
 * request transforms, base URLs, model mapping, case sensitivity,
 * and custom provider registration at runtime.
 */

'use strict';

const {
    ProviderRegistry,
    DEFAULT_PROVIDER_NAME,
    DEFAULT_PROVIDER_CONFIG,
    VALID_AUTH_SCHEMES,
    VALID_COST_TIERS
} = require('../lib/provider-registry');

// ═══════════════════════════════════════════════════════════════════════
// 1. Default provider fallback
// ═══════════════════════════════════════════════════════════════════════

describe('Default provider fallback', () => {
    test('returns z.ai when constructed with no arguments', () => {
        const reg = new ProviderRegistry();
        const def = reg.getDefaultProvider();
        expect(def).toBeDefined();
        expect(reg.defaultProviderName).toBe(DEFAULT_PROVIDER_NAME);
    });

    test('returns z.ai when constructed with null', () => {
        const reg = new ProviderRegistry(null);
        expect(reg.getDefaultProvider()).toBeDefined();
        expect(reg.defaultProviderName).toBe('z.ai');
    });

    test('returns z.ai when constructed with empty object', () => {
        const reg = new ProviderRegistry({});
        expect(reg.getDefaultProvider()).toBeDefined();
        expect(reg.defaultProviderName).toBe('z.ai');
    });

    test('default provider config matches exported DEFAULT_PROVIDER_CONFIG', () => {
        const reg = new ProviderRegistry();
        const def = reg.getDefaultProvider();
        expect(def.targetHost).toBe(DEFAULT_PROVIDER_CONFIG.targetHost);
        expect(def.targetBasePath).toBe(DEFAULT_PROVIDER_CONFIG.targetBasePath);
        expect(def.targetProtocol).toBe(DEFAULT_PROVIDER_CONFIG.targetProtocol);
        expect(def.authScheme).toBe(DEFAULT_PROVIDER_CONFIG.authScheme);
        expect(def.costTier).toBe(DEFAULT_PROVIDER_CONFIG.costTier);
    });

    test('injects z.ai when providers configured but default name not among them', () => {
        const reg = new ProviderRegistry({
            'openai': { targetHost: 'api.openai.com', authScheme: 'bearer' }
        });
        // default falls back to z.ai since 'openai' was not named as default
        expect(reg.defaultProviderName).toBe('z.ai');
        expect(reg.hasProvider('z.ai')).toBe(true);
        expect(reg.hasProvider('openai')).toBe(true);
    });

    test('uses custom default when that provider is in config', () => {
        const reg = new ProviderRegistry({
            'my-llm': { targetHost: 'llm.example.com' }
        }, 'my-llm');
        expect(reg.defaultProviderName).toBe('my-llm');
        expect(reg.getDefaultProvider().targetHost).toBe('llm.example.com');
    });

    test('falls back to z.ai when custom default name is not in providers', () => {
        const reg = new ProviderRegistry({
            'provider-a': { targetHost: 'a.example.com' }
        }, 'missing-provider');
        // missing-provider is not in config, so z.ai is injected as default
        expect(reg.defaultProviderName).toBe('z.ai');
        expect(reg.hasProvider('z.ai')).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Provider lookup by name
// ═══════════════════════════════════════════════════════════════════════

describe('Provider lookup by name', () => {
    let registry;

    beforeEach(() => {
        registry = new ProviderRegistry({
            'z.ai': {
                targetHost: 'api.z.ai',
                targetBasePath: '/api/anthropic',
                authScheme: 'x-api-key',
                costTier: 'free'
            },
            'anthropic': {
                targetHost: 'api.anthropic.com',
                targetBasePath: '',
                authScheme: 'x-api-key',
                costTier: 'metered',
                extraHeaders: { 'anthropic-version': '2023-06-01' }
            },
            'openai': {
                targetHost: 'api.openai.com',
                targetBasePath: '/v1',
                authScheme: 'bearer',
                costTier: 'metered'
            }
        });
    });

    test('each registered provider returns its own config', () => {
        const zai = registry.getProvider('z.ai');
        expect(zai.targetHost).toBe('api.z.ai');
        expect(zai.authScheme).toBe('x-api-key');

        const anthropic = registry.getProvider('anthropic');
        expect(anthropic.targetHost).toBe('api.anthropic.com');
        expect(anthropic.costTier).toBe('metered');

        const openai = registry.getProvider('openai');
        expect(openai.targetHost).toBe('api.openai.com');
        expect(openai.authScheme).toBe('bearer');
    });

    test('provider configs are isolated from each other', () => {
        const zai = registry.getProvider('z.ai');
        const openai = registry.getProvider('openai');
        // Mutating one should not affect the other (they are separate objects)
        expect(zai).not.toBe(openai);
        expect(zai.targetHost).not.toBe(openai.targetHost);
    });

    test('listProviders returns all registered names', () => {
        const names = registry.listProviders();
        expect(names).toContain('z.ai');
        expect(names).toContain('anthropic');
        expect(names).toContain('openai');
        expect(names).toHaveLength(3);
    });

    test('hasProvider is true for each registered name', () => {
        expect(registry.hasProvider('z.ai')).toBe(true);
        expect(registry.hasProvider('anthropic')).toBe(true);
        expect(registry.hasProvider('openai')).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Unknown provider lookup
// ═══════════════════════════════════════════════════════════════════════

describe('Unknown provider lookup', () => {
    test('getProvider returns null for nonexistent name', () => {
        const reg = new ProviderRegistry();
        expect(reg.getProvider('nonexistent')).toBeNull();
    });

    test('getProvider returns null for undefined argument', () => {
        const reg = new ProviderRegistry();
        expect(reg.getProvider(undefined)).toBeNull();
    });

    test('hasProvider returns false for nonexistent name', () => {
        const reg = new ProviderRegistry();
        expect(reg.hasProvider('ghost')).toBe(false);
    });

    test('formatAuthHeader returns null for unknown provider', () => {
        const reg = new ProviderRegistry();
        expect(reg.formatAuthHeader('no-such-provider', 'key-123')).toBeNull();
    });

    test('resolveProviderForModel returns null when mapping points to unknown provider', () => {
        const reg = new ProviderRegistry();
        const mapping = {
            models: {
                'model-x': { target: 'model-x-v2', provider: 'unknown-provider' }
            }
        };
        const result = reg.resolveProviderForModel('model-x-v2', mapping);
        expect(result).toBeNull();
    });

    test('resolveProviderForModel returns default for unmapped model', () => {
        const reg = new ProviderRegistry();
        const mapping = { models: {} };
        const result = reg.resolveProviderForModel('totally-new-model', mapping);
        expect(result).toEqual({
            providerName: 'z.ai',
            targetModel: 'totally-new-model'
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Provider request/response transforms
// ═══════════════════════════════════════════════════════════════════════

describe('Provider transforms', () => {
    test('requestTransform is stored and retrievable', () => {
        const transform = (headers, body) => ({
            headers: { ...headers, 'x-custom': 'value' },
            body: { ...body, wrapped: true }
        });

        const reg = new ProviderRegistry({
            'custom-llm': {
                targetHost: 'llm.example.com',
                requestTransform: transform
            }
        });

        const provider = reg.getProvider('custom-llm');
        expect(provider.requestTransform).toBe(transform);
        expect(typeof provider.requestTransform).toBe('function');
    });

    test('requestTransform can modify headers and body per provider spec', () => {
        const transform = (headers, body) => ({
            headers: { ...headers, 'x-injected': 'yes' },
            body: { ...body, extra_field: 42 }
        });

        const reg = new ProviderRegistry({
            'transforming': {
                targetHost: 'transform.example.com',
                requestTransform: transform
            }
        });

        const provider = reg.getProvider('transforming');
        const result = provider.requestTransform(
            { 'content-type': 'application/json' },
            { model: 'test', messages: [] }
        );

        expect(result.headers['x-injected']).toBe('yes');
        expect(result.headers['content-type']).toBe('application/json');
        expect(result.body.extra_field).toBe(42);
        expect(result.body.model).toBe('test');
    });

    test('responseTransform is stored and retrievable', () => {
        const respTransform = (body) => ({ ...body, provider_tag: 'custom' });

        const reg = new ProviderRegistry({
            'resp-provider': {
                targetHost: 'resp.example.com',
                responseTransform: respTransform
            }
        });

        const provider = reg.getProvider('resp-provider');
        expect(provider.responseTransform).toBe(respTransform);

        const result = provider.responseTransform({ id: 'msg_1', content: 'hello' });
        expect(result.provider_tag).toBe('custom');
        expect(result.id).toBe('msg_1');
    });

    test('provider without transforms has null for both', () => {
        const reg = new ProviderRegistry({
            'plain': { targetHost: 'plain.example.com' }
        });
        const provider = reg.getProvider('plain');
        expect(provider.requestTransform).toBeNull();
        expect(provider.responseTransform).toBeNull();
    });

    test('extraHeaders are preserved alongside transforms', () => {
        const reg = new ProviderRegistry({
            'full': {
                targetHost: 'full.example.com',
                extraHeaders: { 'x-version': '2024-01' },
                requestTransform: (h, b) => ({ headers: h, body: b })
            }
        });
        const provider = reg.getProvider('full');
        expect(provider.extraHeaders['x-version']).toBe('2024-01');
        expect(provider.requestTransform).toBeDefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Provider base URL / endpoint
// ═══════════════════════════════════════════════════════════════════════

describe('Provider base URL', () => {
    test('z.ai default has correct endpoint parts', () => {
        const reg = new ProviderRegistry();
        const def = reg.getDefaultProvider();
        expect(def.targetProtocol).toBe('https:');
        expect(def.targetHost).toBe('api.z.ai');
        expect(def.targetBasePath).toBe('/api/anthropic');
    });

    test('provider with empty basePath gets empty string (not default)', () => {
        const reg = new ProviderRegistry({
            'direct': {
                targetHost: 'api.anthropic.com',
                targetBasePath: ''
            }
        });
        const provider = reg.getProvider('direct');
        expect(provider.targetBasePath).toBe('');
    });

    test('provider with custom basePath preserves it', () => {
        const reg = new ProviderRegistry({
            'versioned': {
                targetHost: 'api.example.com',
                targetBasePath: '/v2/chat'
            }
        });
        expect(reg.getProvider('versioned').targetBasePath).toBe('/v2/chat');
    });

    test('each provider can have a different host', () => {
        const reg = new ProviderRegistry({
            'provider-a': { targetHost: 'a.example.com' },
            'provider-b': { targetHost: 'b.example.com' },
            'provider-c': { targetHost: 'c.example.com' }
        });
        expect(reg.getProvider('provider-a').targetHost).toBe('a.example.com');
        expect(reg.getProvider('provider-b').targetHost).toBe('b.example.com');
        expect(reg.getProvider('provider-c').targetHost).toBe('c.example.com');
    });

    test('provider protocol defaults to https:', () => {
        const reg = new ProviderRegistry({
            'no-proto': { targetHost: 'example.com' }
        });
        expect(reg.getProvider('no-proto').targetProtocol).toBe('https:');
    });

    test('provider can specify http: protocol', () => {
        const reg = new ProviderRegistry({
            'local': { targetHost: 'localhost:8080', targetProtocol: 'http:' }
        });
        expect(reg.getProvider('local').targetProtocol).toBe('http:');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. Model mapping
// ═══════════════════════════════════════════════════════════════════════

describe('Model mapping', () => {
    let registry;

    beforeEach(() => {
        registry = new ProviderRegistry({
            'z.ai': { targetHost: 'api.z.ai', costTier: 'free' },
            'anthropic': { targetHost: 'api.anthropic.com', costTier: 'metered' },
            'openai': { targetHost: 'api.openai.com', authScheme: 'bearer', costTier: 'metered' }
        });
    });

    test('string mapping (no provider) resolves to default provider', () => {
        const mapping = {
            models: { 'claude-opus-4-6': 'glm-4.7' }
        };
        const result = registry.resolveProviderForModel('glm-4.7', mapping);
        expect(result).toEqual({ providerName: 'z.ai', targetModel: 'glm-4.7' });
    });

    test('object mapping with provider routes to that provider', () => {
        const mapping = {
            models: {
                'claude-opus-4': { target: 'claude-opus-4', provider: 'anthropic' }
            }
        };
        const result = registry.resolveProviderForModel('claude-opus-4', mapping);
        expect(result).toEqual({ providerName: 'anthropic', targetModel: 'claude-opus-4' });
    });

    test('object mapping to unknown provider returns null (GUARD-02)', () => {
        const mapping = {
            models: {
                'gpt-4': { target: 'gpt-4-turbo', provider: 'azure' }
            }
        };
        expect(registry.resolveProviderForModel('gpt-4-turbo', mapping)).toBeNull();
    });

    test('null mapping resolves to default provider with original model', () => {
        const result = registry.resolveProviderForModel('any-model', null);
        expect(result).toEqual({ providerName: 'z.ai', targetModel: 'any-model' });
    });

    test('mapping with no models key resolves to default', () => {
        const result = registry.resolveProviderForModel('any-model', {});
        expect(result).toEqual({ providerName: 'z.ai', targetModel: 'any-model' });
    });

    test('model not in mapping resolves to default', () => {
        const mapping = {
            models: {
                'specific-model': { target: 'specific-v2', provider: 'anthropic' }
            }
        };
        const result = registry.resolveProviderForModel('unrelated-model', mapping);
        expect(result).toEqual({ providerName: 'z.ai', targetModel: 'unrelated-model' });
    });

    test('multiple model mappings to different providers all resolve correctly', () => {
        const mapping = {
            models: {
                'claude-opus-4': { target: 'claude-opus-4', provider: 'anthropic' },
                'gpt-4': { target: 'gpt-4', provider: 'openai' }
            }
        };
        expect(registry.resolveProviderForModel('claude-opus-4', mapping)).toEqual({
            providerName: 'anthropic', targetModel: 'claude-opus-4'
        });
        expect(registry.resolveProviderForModel('gpt-4', mapping)).toEqual({
            providerName: 'openai', targetModel: 'gpt-4'
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. Case sensitivity
// ═══════════════════════════════════════════════════════════════════════

describe('Case sensitivity', () => {
    test('provider lookup is case-sensitive (Map semantics)', () => {
        const reg = new ProviderRegistry({
            'Anthropic': { targetHost: 'api.anthropic.com', costTier: 'metered' }
        });
        // Exact case works
        expect(reg.getProvider('Anthropic')).toBeDefined();
        expect(reg.getProvider('Anthropic').targetHost).toBe('api.anthropic.com');

        // Different case returns null
        expect(reg.getProvider('anthropic')).toBeNull();
        expect(reg.getProvider('ANTHROPIC')).toBeNull();
    });

    test('hasProvider is case-sensitive', () => {
        const reg = new ProviderRegistry({
            'MyProvider': { targetHost: 'my.example.com' }
        });
        expect(reg.hasProvider('MyProvider')).toBe(true);
        expect(reg.hasProvider('myprovider')).toBe(false);
        expect(reg.hasProvider('MYPROVIDER')).toBe(false);
    });

    test('formatAuthHeader is case-sensitive on provider name', () => {
        const reg = new ProviderRegistry({
            'CasedProvider': { targetHost: 'cased.example.com', authScheme: 'bearer' }
        });
        expect(reg.formatAuthHeader('CasedProvider', 'key-1')).toEqual({
            headerName: 'authorization',
            headerValue: 'Bearer key-1'
        });
        expect(reg.formatAuthHeader('casedprovider', 'key-1')).toBeNull();
    });

    test('default provider name z.ai is lowercase', () => {
        const reg = new ProviderRegistry();
        expect(reg.defaultProviderName).toBe('z.ai');
        expect(reg.getProvider('Z.AI')).toBeNull();
        expect(reg.getProvider('Z.Ai')).toBeNull();
    });

    test('resolveProviderForModel uses case-sensitive provider lookup', () => {
        const reg = new ProviderRegistry({
            'CasedLLM': { targetHost: 'cased.example.com' }
        }, 'CasedLLM');

        const mapping = {
            models: {
                'model-x': { target: 'model-x', provider: 'CasedLLM' }
            }
        };
        expect(reg.resolveProviderForModel('model-x', mapping)).toEqual({
            providerName: 'CasedLLM', targetModel: 'model-x'
        });

        // Wrong case in mapping => provider not found => null
        const badMapping = {
            models: {
                'model-x': { target: 'model-x', provider: 'casedllm' }
            }
        };
        expect(reg.resolveProviderForModel('model-x', badMapping)).toBeNull();
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 8. Custom provider registration at runtime
// ═══════════════════════════════════════════════════════════════════════

describe('Custom provider registration at runtime', () => {
    test('_addProvider adds a new provider to existing registry', () => {
        const reg = new ProviderRegistry();
        expect(reg.hasProvider('runtime-provider')).toBe(false);

        reg._addProvider('runtime-provider', {
            targetHost: 'runtime.example.com',
            authScheme: 'bearer',
            costTier: 'metered'
        });

        expect(reg.hasProvider('runtime-provider')).toBe(true);
        const provider = reg.getProvider('runtime-provider');
        expect(provider.targetHost).toBe('runtime.example.com');
        expect(provider.authScheme).toBe('bearer');
        expect(provider.costTier).toBe('metered');
    });

    test('runtime-added provider appears in listProviders', () => {
        const reg = new ProviderRegistry();
        const before = reg.listProviders().length;

        reg._addProvider('new-at-runtime', { targetHost: 'new.example.com' });

        const after = reg.listProviders();
        expect(after.length).toBe(before + 1);
        expect(after).toContain('new-at-runtime');
    });

    test('runtime-added provider works with formatAuthHeader', () => {
        const reg = new ProviderRegistry();
        reg._addProvider('bearer-runtime', {
            targetHost: 'bearer.example.com',
            authScheme: 'bearer'
        });

        const auth = reg.formatAuthHeader('bearer-runtime', 'rt-key-123');
        expect(auth).toEqual({
            headerName: 'authorization',
            headerValue: 'Bearer rt-key-123'
        });
    });

    test('runtime-added provider works with resolveProviderForModel', () => {
        const reg = new ProviderRegistry();
        reg._addProvider('dynamic-llm', {
            targetHost: 'dynamic.example.com',
            costTier: 'premium'
        });

        const mapping = {
            models: {
                'special-model': { target: 'special-v2', provider: 'dynamic-llm' }
            }
        };
        const result = reg.resolveProviderForModel('special-v2', mapping);
        expect(result).toEqual({
            providerName: 'dynamic-llm',
            targetModel: 'special-v2'
        });
    });

    test('runtime registration validates authScheme', () => {
        const reg = new ProviderRegistry();
        expect(() => {
            reg._addProvider('bad-auth', { authScheme: 'oauth2' });
        }).toThrow(/Invalid authScheme/);
    });

    test('runtime registration validates costTier', () => {
        const reg = new ProviderRegistry();
        expect(() => {
            reg._addProvider('bad-tier', { costTier: 'enterprise' });
        }).toThrow(/Invalid costTier/);
    });

    test('runtime registration rejects empty name', () => {
        const reg = new ProviderRegistry();
        expect(() => {
            reg._addProvider('', { targetHost: 'example.com' });
        }).toThrow(/Invalid provider name/);
    });

    test('runtime registration rejects null name', () => {
        const reg = new ProviderRegistry();
        expect(() => {
            reg._addProvider(null, { targetHost: 'example.com' });
        }).toThrow(/Invalid provider name/);
    });

    test('runtime-added provider can overwrite existing provider', () => {
        const reg = new ProviderRegistry({
            'mutable': { targetHost: 'old.example.com', costTier: 'free' }
        });
        expect(reg.getProvider('mutable').targetHost).toBe('old.example.com');

        reg._addProvider('mutable', { targetHost: 'new.example.com', costTier: 'premium' });
        expect(reg.getProvider('mutable').targetHost).toBe('new.example.com');
        expect(reg.getProvider('mutable').costTier).toBe('premium');
    });

    test('runtime-added provider fills defaults for missing fields', () => {
        const reg = new ProviderRegistry();
        reg._addProvider('minimal', { targetHost: 'minimal.example.com' });

        const provider = reg.getProvider('minimal');
        expect(provider.authScheme).toBe('x-api-key');
        expect(provider.costTier).toBe('free');
        expect(provider.targetProtocol).toBe('https:');
        expect(provider.extraHeaders).toEqual({});
        expect(provider.requestTransform).toBeNull();
        expect(provider.responseTransform).toBeNull();
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Auth header edge cases
// ═══════════════════════════════════════════════════════════════════════

describe('Auth header edge cases', () => {
    test('empty string apiKey returns null', () => {
        const reg = new ProviderRegistry();
        // empty string is falsy, so should return null
        expect(reg.formatAuthHeader('z.ai', '')).toBeNull();
    });

    test('bearer auth wraps key correctly with spaces and special chars', () => {
        const reg = new ProviderRegistry({
            'bearer-prov': { authScheme: 'bearer', targetHost: 'b.example.com' }
        });
        const auth = reg.formatAuthHeader('bearer-prov', 'sk-ant-abc123!@#$%');
        expect(auth.headerValue).toBe('Bearer sk-ant-abc123!@#$%');
    });

    test('x-api-key passes key as-is without wrapping', () => {
        const reg = new ProviderRegistry();
        const auth = reg.formatAuthHeader('z.ai', 'raw-key-value');
        expect(auth.headerValue).toBe('raw-key-value');
        expect(auth.headerName).toBe('x-api-key');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Constructor edge cases
// ═══════════════════════════════════════════════════════════════════════

describe('Constructor edge cases', () => {
    test('non-object providersConfig is treated as no config', () => {
        // Strings, numbers, booleans should not throw
        const reg1 = new ProviderRegistry('not-an-object');
        expect(reg1.getDefaultProvider()).toBeDefined();

        const reg2 = new ProviderRegistry(42);
        expect(reg2.getDefaultProvider()).toBeDefined();

        const reg3 = new ProviderRegistry(true);
        expect(reg3.getDefaultProvider()).toBeDefined();
    });

    test('multiple providers can be registered at construction', () => {
        const reg = new ProviderRegistry({
            'a': { targetHost: 'a.com' },
            'b': { targetHost: 'b.com' },
            'c': { targetHost: 'c.com' },
            'd': { targetHost: 'd.com' },
            'e': { targetHost: 'e.com' }
        });
        // 5 explicit + z.ai injected as default = 6
        expect(reg.listProviders().length).toBe(6);
    });

    test('constructor with only default provider does not duplicate', () => {
        const reg = new ProviderRegistry({
            'z.ai': { targetHost: 'api.z.ai', costTier: 'free' }
        });
        const names = reg.listProviders();
        const zaiCount = names.filter(n => n === 'z.ai').length;
        expect(zaiCount).toBe(1);
    });
});
