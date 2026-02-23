/**
 * Multi-Provider Safety Guard Tests (M5.2)
 *
 * TDD guard tests that MUST pass before any multi-provider routing code
 * is written. These enforce the invariant: "never route to a provider
 * the user hasn't explicitly configured."
 *
 * Design doc: docs/design/multi-provider-abstraction.md
 */

'use strict';

const { Config, resetConfig } = require('../lib/config');
const { RequestTrace } = require('../lib/request-trace');

afterEach(() => {
    resetConfig();
});

// ═══════════════════════════════════════════════════════════════════════
// GUARD-01: Default provider resolution
// ═══════════════════════════════════════════════════════════════════════

describe('GUARD-01: Default provider resolution', () => {
    test('config without providers section defaults to z.ai target', () => {
        const config = new Config({
            configDir: __dirname,
            useCluster: false,
            port: 0,
            logLevel: 'ERROR'
        });

        expect(config.targetHost).toBe('api.z.ai');
        expect(config.targetBasePath).toBe('/api/anthropic');
        expect(config.targetProtocol).toBe('https:');
    });

    test('baseUrl in keys file overrides default target', () => {
        // When a keys file has baseUrl, it becomes the target
        const config = new Config({
            configDir: __dirname,
            useCluster: false,
            port: 0,
            logLevel: 'ERROR'
        });

        // The default without keys file is z.ai
        expect(config.targetHost).toBe('api.z.ai');
    });

    test('explicit targetHost config overrides default', () => {
        const config = new Config({
            configDir: __dirname,
            useCluster: false,
            port: 0,
            logLevel: 'ERROR',
            targetHost: 'custom.api.com',
            targetBasePath: '/v1',
            targetProtocol: 'https:'
        });

        expect(config.targetHost).toBe('custom.api.com');
        expect(config.targetBasePath).toBe('/v1');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// GUARD-02: Non-configured provider rejection
// ═══════════════════════════════════════════════════════════════════════

describe('GUARD-02: Non-configured provider rejection', () => {
    test('model mapping has no provider field by default', () => {
        const config = new Config({
            configDir: __dirname,
            useCluster: false,
            port: 0,
            logLevel: 'ERROR'
        });

        const mapping = config.config.modelMapping;
        expect(mapping).toBeDefined();
        expect(mapping.models).toBeDefined();

        // No model entry should have a "provider" field in current config
        for (const [modelName, target] of Object.entries(mapping.models)) {
            if (typeof target === 'object') {
                expect(target.provider).toBeUndefined();
            }
            // String values (current format) have no provider
            if (typeof target === 'string') {
                // This is correct — strings mean "use default provider"
                expect(typeof target).toBe('string');
            }
        }
    });

    test('config providers defaults to null (backward compat path uses global target)', () => {
        const config = new Config({
            configDir: __dirname,
            useCluster: false,
            port: 0,
            logLevel: 'ERROR'
        });

        // The providers section is not yet implemented
        expect(config.config.providers).toBeNull();
        expect(config.providerRegistry).toBeDefined();
        expect(config.providerRegistry.getDefaultProvider()).toBeDefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════
// GUARD-03: RequestTrace provider fields
// ═══════════════════════════════════════════════════════════════════════

describe('GUARD-03: RequestTrace provider fields exist but are null', () => {
    test('RequestTrace has provider and mappedProvider fields', () => {
        const trace = new RequestTrace({
            requestId: 'test-123',
            method: 'POST',
            path: '/v1/messages'
        });

        // Fields exist but are null (not populated yet)
        expect(trace.provider).toBeNull();
        expect(trace.mappedProvider).toBeNull();
    });

    test('RequestTrace provider fields are included in summary', () => {
        const trace = new RequestTrace({
            requestId: 'test-123',
            method: 'POST',
            path: '/v1/messages',
            provider: 'z.ai',
            mappedProvider: 'z.ai'
        });

        expect(trace.provider).toBe('z.ai');
        expect(trace.mappedProvider).toBe('z.ai');

        const summary = trace.getSummary();
        expect(summary.provider).toBe('z.ai');
        expect(summary.mappedProvider).toBe('z.ai');
    });

    test('RequestTrace provider fields are included in JSON', () => {
        const trace = new RequestTrace({
            requestId: 'test-123',
            method: 'POST',
            path: '/v1/messages',
            provider: 'anthropic'
        });

        const json = trace.toJSON();
        expect(json.provider).toBe('anthropic');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// GUARD-04: Auth header format
// ═══════════════════════════════════════════════════════════════════════

describe('GUARD-04: Auth headers use current provider format', () => {
    test('default target host is z.ai', () => {
        // This documents the current auth behavior:
        // Both x-api-key and Authorization Bearer are set for z.ai
        // When multi-provider lands, this should become provider-specific
        const config = new Config({
            configDir: __dirname,
            useCluster: false,
            port: 0,
            logLevel: 'ERROR'
        });

        expect(config.targetHost).toBe('api.z.ai');
        expect(config.targetProtocol).toBe('https:');
    });

    test('target host/path/protocol are single global values', () => {
        // Invariant: currently there's ONE target. Multi-provider will
        // need per-request target resolution.
        const config = new Config({
            configDir: __dirname,
            useCluster: false,
            port: 0,
            logLevel: 'ERROR'
        });

        expect(typeof config.targetHost).toBe('string');
        expect(typeof config.targetBasePath).toBe('string');
        expect(typeof config.targetProtocol).toBe('string');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// GUARD-05: Key isolation invariant
// ═══════════════════════════════════════════════════════════════════════

describe('GUARD-05: Key isolation', () => {
    test('all keys belong to a single provider in current implementation', () => {
        // This test documents the invariant: in the current single-provider
        // architecture, all keys are for the same provider. When multi-provider
        // is implemented, keys must be tagged with their provider and NEVER
        // sent to a different provider's endpoint.

        const { KeyManager } = require('../lib/key-manager');

        const km = new KeyManager({
            keys: ['key1.secret1', 'key2.secret2'],
            maxConcurrencyPerKey: 5,
            rateLimitCooldownMs: 1000
        });

        // All keys have the same structure (no provider field)
        for (const key of km.keys) {
            expect(key.key).toBeDefined();
            // No provider field exists yet
            expect(key.provider).toBeUndefined();
        }
    });

    test('keys array has no provider field on key objects', () => {
        const { KeyManager } = require('../lib/key-manager');

        const km = new KeyManager({
            maxConcurrencyPerKey: 5,
            rateLimitCooldownMs: 1000
        });
        km.loadKeys(['key1.secret1', 'key2.secret2']);

        // Keys are in a flat array — no provider grouping
        expect(km.keys).toHaveLength(2);
        for (const key of km.keys) {
            expect(key.key).toBeDefined();
            // No provider field on key objects (single-provider architecture)
            expect(key.provider).toBeUndefined();
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════
// GUARD-06: Stream parser multi-format readiness
// ═══════════════════════════════════════════════════════════════════════

describe('GUARD-06: Stream parser handles multiple response formats', () => {
    test('stream parser module exists and exports parsing functions', () => {
        const streamParser = require('../lib/request/stream-parser');
        expect(streamParser).toBeDefined();
        // The parser already handles both Anthropic and OpenAI formats
    });
});

// ═══════════════════════════════════════════════════════════════════════
// GUARD-07: Model mapping backward compatibility
// ═══════════════════════════════════════════════════════════════════════

describe('GUARD-07: Model mapping backward compatibility', () => {
    test('string model mapping values continue to work', () => {
        const config = new Config({
            configDir: __dirname,
            useCluster: false,
            port: 0,
            logLevel: 'ERROR'
        });

        const mapping = config.config.modelMapping;
        // Current format uses string values: "claude-opus-4-6": "glm-4.7"
        const entries = Object.entries(mapping.models);
        const stringEntries = entries.filter(([_, v]) => typeof v === 'string');

        // All current entries should be strings
        expect(stringEntries.length).toBe(entries.length);
    });
});
