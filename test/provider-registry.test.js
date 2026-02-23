'use strict';

/**
 * Provider Registry Guard Tests
 *
 * These tests enforce safety invariants for multi-provider routing.
 * They MUST pass before any provider routing code is written.
 * See: docs/design/multi-provider-abstraction.md Section 4
 */

const { ProviderRegistry, DEFAULT_PROVIDER_NAME, DEFAULT_PROVIDER_CONFIG } = require('../lib/provider-registry');

describe('ProviderRegistry', () => {

  describe('GUARD-01: Default provider fallback', () => {
    test('returns default z.ai provider when no custom providers configured', () => {
      const registry = new ProviderRegistry();
      const provider = registry.getDefaultProvider();
      expect(provider).toBeTruthy();
      expect(provider.targetHost).toBe('api.z.ai');
    });

    test('default provider has correct z.ai target config', () => {
      const registry = new ProviderRegistry();
      const provider = registry.getDefaultProvider();
      expect(provider.targetHost).toBe('api.z.ai');
      expect(provider.targetBasePath).toBe('/api/anthropic');
      expect(provider.targetProtocol).toBe('https:');
      expect(provider.authScheme).toBe('x-api-key');
      expect(provider.costTier).toBe('free');
    });

    test('default provider name is z.ai', () => {
      const registry = new ProviderRegistry();
      expect(registry.getDefaultProviderName()).toBe('z.ai');
    });

    test('resolveProviderForModel uses default when model has no mapping', () => {
      const registry = new ProviderRegistry();
      const result = registry.resolveProviderForModel('unknown-model', {});
      expect(result).not.toBeNull();
      expect(result.providerName).toBe('z.ai');
      expect(result.targetModel).toBe('unknown-model');
    });
  });

  describe('GUARD-02: Non-configured provider rejection', () => {
    test('resolveProviderForModel returns null for model with unconfigured provider', () => {
      const registry = new ProviderRegistry({
        'z.ai': {
          targetHost: 'api.z.ai',
          targetBasePath: '/api/anthropic',
          authScheme: 'x-api-key',
          costTier: 'free'
        }
      });
      // Model mapped to 'openai' provider which is NOT configured
      const modelMapping = {
        'gpt-4': { target: 'gpt-4', provider: 'openai' }
      };
      const result = registry.resolveProviderForModel('gpt-4', modelMapping);
      expect(result).toBeNull();
    });

    test('getProvider returns null for unknown provider name', () => {
      const registry = new ProviderRegistry();
      expect(registry.getProvider('nonexistent')).toBeNull();
    });

    test('resolveProviderForModel accepts model mapped to configured provider', () => {
      const registry = new ProviderRegistry({
        'z.ai': {
          targetHost: 'api.z.ai',
          authScheme: 'x-api-key',
          costTier: 'free'
        },
        'openai': {
          targetHost: 'api.openai.com',
          targetBasePath: '/v1',
          authScheme: 'bearer',
          costTier: 'metered'
        }
      });
      const modelMapping = {
        'gpt-4': { target: 'gpt-4', provider: 'openai' }
      };
      const result = registry.resolveProviderForModel('gpt-4', modelMapping);
      expect(result).not.toBeNull();
      expect(result.providerName).toBe('openai');
      expect(result.targetModel).toBe('gpt-4');
    });
  });

  describe('GUARD-03: Config validation', () => {
    test('rejects provider with unknown authScheme', () => {
      expect(() => {
        new ProviderRegistry({
          'bad': { targetHost: 'example.com', authScheme: 'oauth2' }
        });
      }).toThrow(/invalid authScheme 'oauth2'/);
    });

    test('rejects provider without targetHost', () => {
      expect(() => {
        new ProviderRegistry({
          'bad': { authScheme: 'x-api-key' }
        });
      }).toThrow(/requires targetHost/);
    });

    test('rejects provider with unknown costTier', () => {
      expect(() => {
        new ProviderRegistry({
          'bad': { targetHost: 'example.com', costTier: 'unlimited' }
        });
      }).toThrow(/invalid costTier 'unlimited'/);
    });

    test('accepts valid x-api-key provider', () => {
      expect(() => {
        new ProviderRegistry({
          'test': { targetHost: 'example.com', authScheme: 'x-api-key', costTier: 'free' }
        });
      }).not.toThrow();
    });

    test('accepts valid bearer provider', () => {
      expect(() => {
        new ProviderRegistry({
          'test': { targetHost: 'example.com', authScheme: 'bearer', costTier: 'metered' }
        });
      }).not.toThrow();
    });

    test('accepts valid custom auth provider', () => {
      expect(() => {
        new ProviderRegistry({
          'test': { targetHost: 'example.com', authScheme: 'custom', costTier: 'premium' }
        });
      }).not.toThrow();
    });
  });

  describe('GUARD-04: Cost tier propagation', () => {
    test('provider config includes costTier field', () => {
      const registry = new ProviderRegistry({
        'z.ai': { targetHost: 'api.z.ai', costTier: 'free' }
      });
      expect(registry.getProvider('z.ai').costTier).toBe('free');
    });

    test('defaults costTier to metered when not specified', () => {
      const registry = new ProviderRegistry({
        'test': { targetHost: 'example.com' }
      });
      expect(registry.getProvider('test').costTier).toBe('metered');
    });

    test('premium costTier is preserved', () => {
      const registry = new ProviderRegistry({
        'expensive': { targetHost: 'api.expensive.ai', costTier: 'premium' }
      });
      expect(registry.getProvider('expensive').costTier).toBe('premium');
    });
  });

  describe('GUARD-05: Key isolation per provider', () => {
    let registry;

    beforeEach(() => {
      registry = new ProviderRegistry({
        'z.ai': { targetHost: 'api.z.ai', authScheme: 'x-api-key', costTier: 'free' },
        'openai': { targetHost: 'api.openai.com', authScheme: 'bearer', costTier: 'metered' },
        'custom-provider': {
          targetHost: 'api.custom.ai',
          authScheme: 'custom',
          customAuthHeader: 'x-custom-token',
          costTier: 'metered'
        }
      });
    });

    test('x-api-key provider uses x-api-key header', () => {
      const auth = registry.formatAuthHeader('z.ai', 'test-key-123');
      expect(auth).toEqual({
        headerName: 'x-api-key',
        headerValue: 'test-key-123'
      });
    });

    test('bearer provider uses Authorization header', () => {
      const auth = registry.formatAuthHeader('openai', 'sk-test-456');
      expect(auth).toEqual({
        headerName: 'authorization',
        headerValue: 'Bearer sk-test-456'
      });
    });

    test('custom provider uses custom header name', () => {
      const auth = registry.formatAuthHeader('custom-provider', 'custom-key');
      expect(auth).toEqual({
        headerName: 'x-custom-token',
        headerValue: 'custom-key'
      });
    });

    test('formatAuthHeader returns null for unknown provider', () => {
      const auth = registry.formatAuthHeader('nonexistent', 'key');
      expect(auth).toBeNull();
    });

    test('different providers never share auth format accidentally', () => {
      const zaiAuth = registry.formatAuthHeader('z.ai', 'key-A');
      const openaiAuth = registry.formatAuthHeader('openai', 'key-B');
      // Auth headers must be different format
      expect(zaiAuth.headerName).not.toBe(openaiAuth.headerName);
    });
  });

  describe('Provider management', () => {
    let registry;

    beforeEach(() => {
      registry = new ProviderRegistry({
        'z.ai': { targetHost: 'api.z.ai', costTier: 'free' },
        'openai': { targetHost: 'api.openai.com', authScheme: 'bearer', costTier: 'metered' }
      });
    });

    test('hasProvider returns true for configured providers', () => {
      expect(registry.hasProvider('z.ai')).toBe(true);
      expect(registry.hasProvider('openai')).toBe(true);
    });

    test('hasProvider returns false for unconfigured providers', () => {
      expect(registry.hasProvider('google')).toBe(false);
      expect(registry.hasProvider('')).toBe(false);
    });

    test('listProviders returns all provider names', () => {
      const providers = registry.listProviders();
      expect(providers).toContain('z.ai');
      expect(providers).toContain('openai');
      expect(providers).toHaveLength(2);
    });

    test('resolveProviderForModel uses mapping provider field', () => {
      const modelMapping = {
        'gpt-4': { target: 'gpt-4', provider: 'openai' }
      };
      const result = registry.resolveProviderForModel('gpt-4', modelMapping);
      expect(result.providerName).toBe('openai');
      expect(result.targetModel).toBe('gpt-4');
    });

    test('resolveProviderForModel uses default for string mappings', () => {
      const modelMapping = {
        'claude-opus-4-6': 'glm-4.7'
      };
      const result = registry.resolveProviderForModel('claude-opus-4-6', modelMapping);
      expect(result.providerName).toBe('z.ai');
      expect(result.targetModel).toBe('glm-4.7');
    });

    test('resolveProviderForModel defaults provider for object without provider field', () => {
      const modelMapping = {
        'some-model': { target: 'mapped-model' }
      };
      const result = registry.resolveProviderForModel('some-model', modelMapping);
      expect(result.providerName).toBe('z.ai');
      expect(result.targetModel).toBe('mapped-model');
    });

    test('provider config normalizes defaults', () => {
      const provider = registry.getProvider('openai');
      expect(provider.targetBasePath).toBe('');
      expect(provider.targetProtocol).toBe('https:');
      expect(provider.requestTransform).toBeNull();
      expect(provider.responseTransform).toBeNull();
      expect(provider.extraHeaders).toEqual({});
    });

    test('first configured provider becomes default when specified default not found', () => {
      const reg = new ProviderRegistry({
        'anthropic': { targetHost: 'api.anthropic.com', costTier: 'metered' }
      }, 'nonexistent');
      expect(reg.getDefaultProviderName()).toBe('anthropic');
    });
  });

  describe('SPIKE: Claude direct passthrough (roadmap 5.8)', () => {
    let registry;

    beforeEach(() => {
      // Dual-provider config: z.ai (default) + direct Anthropic passthrough
      registry = new ProviderRegistry({
        'z.ai': {
          targetHost: 'api.z.ai',
          targetBasePath: '/api/anthropic',
          targetProtocol: 'https:',
          authScheme: 'x-api-key',
          costTier: 'free'
        },
        'anthropic': {
          targetHost: 'api.anthropic.com',
          targetBasePath: '',
          targetProtocol: 'https:',
          authScheme: 'x-api-key',
          extraHeaders: { 'anthropic-version': '2023-06-01' },
          requestTransform: null,
          responseTransform: null,
          costTier: 'metered'
        }
      });
    });

    test('anthropic provider has zero-transform config', () => {
      const provider = registry.getProvider('anthropic');
      expect(provider.requestTransform).toBeNull();
      expect(provider.responseTransform).toBeNull();
    });

    test('anthropic provider uses same x-api-key auth as z.ai', () => {
      const auth = registry.formatAuthHeader('anthropic', 'sk-ant-test-key');
      expect(auth).toEqual({
        headerName: 'x-api-key',
        headerValue: 'sk-ant-test-key'
      });
    });

    test('anthropic provider includes anthropic-version extra header', () => {
      const provider = registry.getProvider('anthropic');
      expect(provider.extraHeaders).toEqual({ 'anthropic-version': '2023-06-01' });
    });

    test('anthropic provider targets api.anthropic.com with empty base path', () => {
      const provider = registry.getProvider('anthropic');
      expect(provider.targetHost).toBe('api.anthropic.com');
      expect(provider.targetBasePath).toBe('');
      expect(provider.targetProtocol).toBe('https:');
    });

    test('anthropic provider is metered cost tier', () => {
      const provider = registry.getProvider('anthropic');
      expect(provider.costTier).toBe('metered');
    });

    test('claude model mapped to anthropic resolves to anthropic provider', () => {
      const modelMapping = {
        'claude-opus-4-6': { target: 'claude-opus-4-6', provider: 'anthropic' },
        'claude-sonnet-4-5-20250929': 'glm-4.5'  // z.ai default
      };
      const opusResult = registry.resolveProviderForModel('claude-opus-4-6', modelMapping);
      expect(opusResult.providerName).toBe('anthropic');
      expect(opusResult.targetModel).toBe('claude-opus-4-6');

      const sonnetResult = registry.resolveProviderForModel('claude-sonnet-4-5-20250929', modelMapping);
      expect(sonnetResult.providerName).toBe('z.ai');
      expect(sonnetResult.targetModel).toBe('glm-4.5');
    });

    test('unmapped claude model falls back to z.ai (not anthropic)', () => {
      const modelMapping = {};
      const result = registry.resolveProviderForModel('claude-3-opus-20240229', modelMapping);
      expect(result.providerName).toBe('z.ai');
      expect(result.targetModel).toBe('claude-3-opus-20240229');
    });
  });
});
