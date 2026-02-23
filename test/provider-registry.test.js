/**
 * Provider Registry Tests
 *
 * TDD guard tests + unit tests for the ProviderRegistry module.
 * These tests enforce the multi-provider safety invariants.
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
// GUARD-01: Default provider resolution
// ═══════════════════════════════════════════════════════════════════════

describe('GUARD-01: Default provider resolution', () => {
    test('creates default z.ai provider when no config provided', () => {
        const registry = new ProviderRegistry();
        expect(registry.getDefaultProvider()).toBeDefined();
        expect(registry.defaultProviderName).toBe('z.ai');
    });

    test('default provider has correct z.ai target', () => {
        const registry = new ProviderRegistry();
        const provider = registry.getDefaultProvider();
        expect(provider.targetHost).toBe('api.z.ai');
        expect(provider.targetBasePath).toBe('/api/anthropic');
        expect(provider.targetProtocol).toBe('https:');
    });

    test('default provider uses x-api-key auth', () => {
        const registry = new ProviderRegistry();
        const provider = registry.getDefaultProvider();
        expect(provider.authScheme).toBe('x-api-key');
    });

    test('default provider has free cost tier', () => {
        const registry = new ProviderRegistry();
        const provider = registry.getDefaultProvider();
        expect(provider.costTier).toBe('free');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// GUARD-02: Non-configured provider rejection
// ═══════════════════════════════════════════════════════════════════════

describe('GUARD-02: Non-configured provider rejection', () => {
    test('resolveProviderForModel returns null for unconfigured provider', () => {
        const registry = new ProviderRegistry();
        const mapping = {
            models: {
                'gpt-4': { target: 'gpt-4-turbo', provider: 'openai' }
            }
        };
        const result = registry.resolveProviderForModel('gpt-4-turbo', mapping);
        expect(result).toBeNull();
    });

    test('resolveProviderForModel returns default for string mappings', () => {
        const registry = new ProviderRegistry();
        const mapping = {
            models: {
                'claude-opus-4-6': 'glm-4.7'
            }
        };
        const result = registry.resolveProviderForModel('glm-4.7', mapping);
        expect(result).toEqual({ providerName: 'z.ai', targetModel: 'glm-4.7' });
    });

    test('resolveProviderForModel returns default when no mapping', () => {
        const registry = new ProviderRegistry();
        const result = registry.resolveProviderForModel('some-model', null);
        expect(result).toEqual({ providerName: 'z.ai', targetModel: 'some-model' });
    });
});

// ═══════════════════════════════════════════════════════════════════════
// GUARD-03: Config validation
// ═══════════════════════════════════════════════════════════════════════

describe('GUARD-03: Config validation', () => {
    test('rejects invalid authScheme', () => {
        expect(() => {
            new ProviderRegistry({
                'bad': { authScheme: 'invalid' }
            });
        }).toThrow(/Invalid authScheme/);
    });

    test('rejects invalid costTier', () => {
        expect(() => {
            new ProviderRegistry({
                'bad': { costTier: 'invalid' }
            });
        }).toThrow(/Invalid costTier/);
    });

    test('accepts all valid auth schemes', () => {
        for (const scheme of VALID_AUTH_SCHEMES) {
            expect(() => {
                new ProviderRegistry({
                    'test': { authScheme: scheme }
                });
            }).not.toThrow();
        }
    });

    test('accepts all valid cost tiers', () => {
        for (const tier of VALID_COST_TIERS) {
            expect(() => {
                new ProviderRegistry({
                    'test': { costTier: tier }
                });
            }).not.toThrow();
        }
    });

    test('rejects empty provider name', () => {
        expect(() => {
            new ProviderRegistry({ '': { authScheme: 'x-api-key' } });
        }).toThrow(/Invalid provider name/);
    });

    test('fills defaults for missing config fields', () => {
        const registry = new ProviderRegistry({
            'custom': { targetHost: 'custom.api.com' }
        });
        const provider = registry.getProvider('custom');
        expect(provider.authScheme).toBe('x-api-key');
        expect(provider.costTier).toBe('free');
        expect(provider.targetProtocol).toBe('https:');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// GUARD-04: Cost tier propagation
// ═══════════════════════════════════════════════════════════════════════

describe('GUARD-04: Cost tier propagation', () => {
    test('free tier provider returns free costTier', () => {
        const registry = new ProviderRegistry({
            'z.ai': { costTier: 'free' }
        });
        expect(registry.getProvider('z.ai').costTier).toBe('free');
    });

    test('metered tier provider returns metered costTier', () => {
        const registry = new ProviderRegistry({
            'anthropic': { costTier: 'metered' }
        });
        expect(registry.getProvider('anthropic').costTier).toBe('metered');
    });

    test('premium tier provider returns premium costTier', () => {
        const registry = new ProviderRegistry({
            'premium-api': { costTier: 'premium' }
        });
        expect(registry.getProvider('premium-api').costTier).toBe('premium');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// GUARD-05: Key isolation per provider
// ═══════════════════════════════════════════════════════════════════════

describe('GUARD-05: Key isolation per provider', () => {
    test('x-api-key provider formats x-api-key header', () => {
        const registry = new ProviderRegistry({
            'z.ai': { authScheme: 'x-api-key' }
        });
        const auth = registry.formatAuthHeader('z.ai', 'test-key');
        expect(auth).toEqual({ headerName: 'x-api-key', headerValue: 'test-key' });
    });

    test('bearer provider formats Authorization header', () => {
        const registry = new ProviderRegistry({
            'openai': { authScheme: 'bearer' }
        });
        const auth = registry.formatAuthHeader('openai', 'sk-test');
        expect(auth).toEqual({ headerName: 'authorization', headerValue: 'Bearer sk-test' });
    });

    test('custom provider returns null (caller handles auth)', () => {
        const registry = new ProviderRegistry({
            'custom': { authScheme: 'custom' }
        });
        const auth = registry.formatAuthHeader('custom', 'key');
        expect(auth).toBeNull();
    });

    test('unknown provider returns null', () => {
        const registry = new ProviderRegistry();
        const auth = registry.formatAuthHeader('nonexistent', 'key');
        expect(auth).toBeNull();
    });

    test('null apiKey returns null', () => {
        const registry = new ProviderRegistry();
        const auth = registry.formatAuthHeader('z.ai', null);
        expect(auth).toBeNull();
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Default provider injection warning
// ═══════════════════════════════════════════════════════════════════════

describe('Default provider injection', () => {
    test('sets _silentDefaultInjected when providers configured but default missing', () => {
        const registry = new ProviderRegistry({
            'anthropic': { costTier: 'metered' }
        });
        expect(registry._silentDefaultInjected).toBe(true);
        // z.ai was silently injected
        expect(registry.hasProvider('z.ai')).toBe(true);
    });

    test('does not set _silentDefaultInjected when default provider is included', () => {
        const registry = new ProviderRegistry({
            'z.ai': { costTier: 'free' },
            'anthropic': { costTier: 'metered' }
        });
        expect(registry._silentDefaultInjected).toBeUndefined();
    });

    test('does not set _silentDefaultInjected when no providers configured', () => {
        const registry = new ProviderRegistry();
        expect(registry._silentDefaultInjected).toBeUndefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Provider management
// ═══════════════════════════════════════════════════════════════════════

describe('Provider management', () => {
    test('hasProvider returns true for existing provider', () => {
        const registry = new ProviderRegistry({
            'anthropic': { costTier: 'metered' }
        });
        expect(registry.hasProvider('anthropic')).toBe(true);
    });

    test('hasProvider returns false for missing provider', () => {
        const registry = new ProviderRegistry();
        expect(registry.hasProvider('nonexistent')).toBe(false);
    });

    test('listProviders returns all provider names', () => {
        const registry = new ProviderRegistry({
            'z.ai': { costTier: 'free' },
            'anthropic': { costTier: 'metered' }
        });
        const providers = registry.listProviders();
        expect(providers).toContain('z.ai');
        expect(providers).toContain('anthropic');
    });

    test('getProvider returns null for unknown provider', () => {
        const registry = new ProviderRegistry();
        expect(registry.getProvider('unknown')).toBeNull();
    });

    test('custom defaultProviderName is respected', () => {
        const registry = new ProviderRegistry({
            'custom': { targetHost: 'custom.api.com' }
        }, 'custom');
        expect(registry.defaultProviderName).toBe('custom');
        expect(registry.getDefaultProvider().targetHost).toBe('custom.api.com');
    });

    test('extraHeaders are stored on provider config', () => {
        const registry = new ProviderRegistry({
            'anthropic': {
                extraHeaders: { 'anthropic-version': '2023-06-01' }
            }
        });
        expect(registry.getProvider('anthropic').extraHeaders).toEqual({
            'anthropic-version': '2023-06-01'
        });
    });

    test('resolveProviderForModel returns configured provider for object mapping', () => {
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

    test('resolveProviderForModel returns default when no models match', () => {
        const registry = new ProviderRegistry();
        const mapping = {
            models: {
                'claude-opus-4-6': 'glm-4.7'
            }
        };
        const result = registry.resolveProviderForModel('unknown-model', mapping);
        expect(result).toEqual({ providerName: 'z.ai', targetModel: 'unknown-model' });
    });
});

// ═══════════════════════════════════════════════════════════════════════
// SPIKE: Claude direct passthrough
// ═══════════════════════════════════════════════════════════════════════

describe('SPIKE: Claude direct passthrough', () => {
    let registry;

    beforeEach(() => {
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
                costTier: 'metered'
            }
        });
    });

    test('anthropic provider requires zero request transform', () => {
        const provider = registry.getProvider('anthropic');
        expect(provider.requestTransform).toBeNull();
    });

    test('anthropic provider uses x-api-key auth (same as Anthropic API)', () => {
        const auth = registry.formatAuthHeader('anthropic', 'sk-ant-test');
        expect(auth).toEqual({ headerName: 'x-api-key', headerValue: 'sk-ant-test' });
    });

    test('anthropic provider includes anthropic-version header', () => {
        const provider = registry.getProvider('anthropic');
        expect(provider.extraHeaders['anthropic-version']).toBe('2023-06-01');
    });

    test('anthropic provider targets api.anthropic.com', () => {
        const provider = registry.getProvider('anthropic');
        expect(provider.targetHost).toBe('api.anthropic.com');
        expect(provider.targetBasePath).toBe('');
    });

    test('anthropic provider has metered cost tier', () => {
        const provider = registry.getProvider('anthropic');
        expect(provider.costTier).toBe('metered');
    });

    test('model mapping can route claude-opus-4 to anthropic provider', () => {
        const mapping = {
            models: {
                'claude-opus-4': { target: 'claude-opus-4', provider: 'anthropic' }
            }
        };
        const result = registry.resolveProviderForModel('claude-opus-4', mapping);
        expect(result).toEqual({ providerName: 'anthropic', targetModel: 'claude-opus-4' });
    });

    test('z.ai and anthropic coexist with different cost tiers', () => {
        expect(registry.getProvider('z.ai').costTier).toBe('free');
        expect(registry.getProvider('anthropic').costTier).toBe('metered');
        expect(registry.listProviders()).toHaveLength(2);
    });
});
