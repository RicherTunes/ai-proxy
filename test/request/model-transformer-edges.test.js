/**
 * Edge-case Unit Tests: Model Transformer Module
 *
 * Covers sanitization boundaries, null/missing inputs, override
 * precedence, provider mapping, chained transforms, and oversized /
 * special-character model names.
 */

'use strict';

const {
    transformRequestBody,
    sanitizeModelOverride,
    MAX_OVERRIDE_LENGTH
} = require('../../lib/request/model-transformer');

// ---------------------------------------------------------------------------
// 1-3  sanitizeModelOverride
// ---------------------------------------------------------------------------
describe('sanitizeModelOverride', () => {
    it('should strip null bytes, newlines, and tabs from input', () => {
        const dirty = 'claude\x00-3\n-opus\t-v2';
        const result = sanitizeModelOverride(dirty);
        expect(result).toBe('claude-3-opus-v2');
        // Ensure no control characters remain
        expect(result).not.toMatch(/[\x00-\x1f\x7f]/);
    });

    it('should truncate input longer than MAX_OVERRIDE_LENGTH (128)', () => {
        const long = 'a'.repeat(200);
        const result = sanitizeModelOverride(long);
        expect(result).toHaveLength(MAX_OVERRIDE_LENGTH);
        expect(result).toBe('a'.repeat(MAX_OVERRIDE_LENGTH));
    });

    it('should return null for an empty string (all content stripped)', () => {
        // Empty string
        expect(sanitizeModelOverride('')).toBeNull();
        // String that becomes empty after control-char removal
        expect(sanitizeModelOverride('\x00\n\t')).toBeNull();
    });

    it('should return null for non-string inputs', () => {
        expect(sanitizeModelOverride(undefined)).toBeNull();
        expect(sanitizeModelOverride(null)).toBeNull();
        expect(sanitizeModelOverride(42)).toBeNull();
        expect(sanitizeModelOverride({})).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// 4  Transform with no model in body
// ---------------------------------------------------------------------------
describe('transformRequestBody — no model field', () => {
    it('should pass through a request body that has no model field', async () => {
        const payload = { messages: [{ role: 'user', content: 'hello' }], max_tokens: 50 };
        const body = Buffer.from(JSON.stringify(payload));

        const result = await transformRequestBody(body, null);

        expect(result.originalModel).toBeNull();
        expect(result.mappedModel).toBeNull();
        expect(result.routingDecision).toBeNull();
        expect(result.provider).toBeNull();
        // Body buffer must be the exact same reference (untouched)
        expect(result.body).toBe(body);
    });
});

// ---------------------------------------------------------------------------
// 5  Transform with unknown model
// ---------------------------------------------------------------------------
describe('transformRequestBody — unknown model name', () => {
    it('should preserve an unknown model name as-is when no router is provided', async () => {
        const body = Buffer.from(JSON.stringify({ model: 'totally-unknown-model-xyz' }));

        const result = await transformRequestBody(body, null);

        expect(result.originalModel).toBe('totally-unknown-model-xyz');
        expect(result.mappedModel).toBe('totally-unknown-model-xyz');
        expect(result.routingDecision).toBeNull();
    });

    it('should let the router decide when an unknown model is sent', async () => {
        const body = Buffer.from(JSON.stringify({ model: 'mystery-model' }));
        const mockRouter = {
            selectModel: jest.fn().mockResolvedValue({
                model: 'fallback-model',
                source: 'catch-all',
                tier: 'low',
                reason: 'unknown input'
            }),
            config: { logDecisions: false },
            shadowMode: false
        };

        const result = await transformRequestBody(body, null, 0, null, null, mockRouter);

        expect(result.originalModel).toBe('mystery-model');
        expect(result.mappedModel).toBe('fallback-model');
    });
});

// ---------------------------------------------------------------------------
// 6  Transform with null body
// ---------------------------------------------------------------------------
describe('transformRequestBody — null / empty body', () => {
    it('should not crash with a zero-length buffer', async () => {
        const body = Buffer.alloc(0);
        const result = await transformRequestBody(body, null);

        expect(result.originalModel).toBeNull();
        expect(result.mappedModel).toBeNull();
        expect(result.body).toBe(body);
    });

    it('should not crash with binary garbage (non-JSON)', async () => {
        const body = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
        const logger = { debug: jest.fn() };
        const result = await transformRequestBody(body, logger);

        expect(result.originalModel).toBeNull();
        expect(result.mappedModel).toBeNull();
        expect(logger.debug).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// 7  Transform with provider-specific mappings
// ---------------------------------------------------------------------------
describe('transformRequestBody — provider resolution', () => {
    it('should resolve provider for routed model via providerRegistry', async () => {
        const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));
        const mockRouter = {
            selectModel: jest.fn().mockResolvedValue({
                model: 'glm-4-opus',
                source: 'tier',
                tier: 'premium',
                reason: 'mapped'
            }),
            config: { logDecisions: false },
            shadowMode: false
        };
        const mockProviderRegistry = {
            resolveProviderForModel: jest.fn().mockReturnValue({ providerName: 'zhipu' })
        };
        const mockModelMapping = { models: { 'glm-4-opus': { provider: 'zhipu' } } };

        const result = await transformRequestBody(
            body, null, 0, null, null, mockRouter, null,
            mockProviderRegistry, mockModelMapping
        );

        expect(result.provider).toBe('zhipu');
        expect(mockProviderRegistry.resolveProviderForModel).toHaveBeenCalledWith(
            'glm-4-opus', mockModelMapping
        );
    });

    it('should resolve provider for original model when router returns null', async () => {
        const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));
        const mockRouter = {
            selectModel: jest.fn().mockResolvedValue(null),
            config: { logDecisions: false },
            shadowMode: false
        };
        const mockProviderRegistry = {
            resolveProviderForModel: jest.fn().mockReturnValue({ providerName: 'anthropic' })
        };

        const result = await transformRequestBody(
            body, null, 0, null, null, mockRouter, null,
            mockProviderRegistry, null
        );

        expect(result.provider).toBe('anthropic');
        expect(mockProviderRegistry.resolveProviderForModel).toHaveBeenCalledWith(
            'claude-3-opus', null
        );
    });

    it('should set provider to null when no providerRegistry given', async () => {
        const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));
        const mockRouter = {
            selectModel: jest.fn().mockResolvedValue({
                model: 'glm-4-opus', source: 'tier'
            }),
            config: { logDecisions: false },
            shadowMode: false
        };

        const result = await transformRequestBody(
            body, null, 0, null, null, mockRouter, null,
            null, null
        );

        expect(result.provider).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// 8  Override header precedence
// ---------------------------------------------------------------------------
describe('transformRequestBody — x-model-override precedence', () => {
    it('should use override model instead of body model when auth passes', async () => {
        const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));
        const req = {
            headers: { 'x-model-override': 'override-model-v2' }
        };
        const mockRouter = {
            selectModel: jest.fn().mockImplementation(async (opts) => {
                // The router receives the override and should route to it
                return {
                    model: opts.override || opts.requestModel,
                    source: opts.override ? 'override' : 'tier',
                    tier: 'high',
                    reason: 'test'
                };
            }),
            config: { adminAuth: null },
            shadowMode: false
        };

        const result = await transformRequestBody(body, null, 0, req, null, mockRouter);

        // Verify the override was passed to selectModel
        expect(mockRouter.selectModel).toHaveBeenCalledWith(
            expect.objectContaining({ override: 'override-model-v2' })
        );
        expect(result.mappedModel).toBe('override-model-v2');
    });

    it('should fall back to body model when override header is absent', async () => {
        const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));
        const req = { headers: {} };
        const mockRouter = {
            selectModel: jest.fn().mockImplementation(async (opts) => {
                return { model: opts.requestModel, source: 'tier' };
            }),
            config: {},
            shadowMode: false
        };

        const result = await transformRequestBody(body, null, 0, req, null, mockRouter);

        expect(mockRouter.selectModel).toHaveBeenCalledWith(
            expect.objectContaining({ override: null })
        );
        expect(result.mappedModel).toBe('claude-3-opus');
    });
});

// ---------------------------------------------------------------------------
// 9  Override with auth required but not present
// ---------------------------------------------------------------------------
describe('transformRequestBody — override rejected when auth required', () => {
    it('should not pass override to router when auth is required but fails', async () => {
        const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));
        const req = {
            headers: { 'x-model-override': 'sneaky-model' }
        };
        const mockAdminAuth = {
            authenticate: jest.fn().mockReturnValue({ authenticated: false, error: 'No token' })
        };
        const mockRouter = {
            selectModel: jest.fn().mockResolvedValue({
                model: 'claude-3-opus', source: 'tier'
            }),
            config: {
                adminAuth: { enabled: true },
                _adminAuthInstance: mockAdminAuth,
                logDecisions: false
            },
            shadowMode: false
        };
        const logger = { warn: jest.fn() };
        const throttle = { accepted: 0, rejected: 0 };

        await transformRequestBody(body, logger, 0, req, null, mockRouter, throttle);

        // Override must be null since auth failed
        expect(mockRouter.selectModel).toHaveBeenCalledWith(
            expect.objectContaining({ override: null })
        );
        // Should have logged a warning
        expect(logger.warn).toHaveBeenCalledWith(
            'x-model-override rejected: auth failed',
            expect.objectContaining({ override: 'sneaky-model' })
        );
    });
});

// ---------------------------------------------------------------------------
// 10  Multiple transforms in sequence
// ---------------------------------------------------------------------------
describe('transformRequestBody — chained transforms', () => {
    it('should correctly chain: original -> routed -> provider resolved', async () => {
        const body = Buffer.from(JSON.stringify({ model: 'gpt-4' }));

        // Step 1: Router maps gpt-4 -> glm-4-plus
        const mockRouter = {
            selectModel: jest.fn().mockResolvedValue({
                model: 'glm-4-plus',
                source: 'tier',
                tier: 'medium',
                reason: 'cost optimization'
            }),
            config: { logDecisions: false },
            shadowMode: false
        };
        // Step 2: Provider registry resolves glm-4-plus -> zhipu provider
        const mockProviderRegistry = {
            resolveProviderForModel: jest.fn().mockReturnValue({ providerName: 'zhipu' })
        };

        const result = await transformRequestBody(
            body, null, 0, null, null, mockRouter, null,
            mockProviderRegistry, null
        );

        // Verify the full chain
        expect(result.originalModel).toBe('gpt-4');
        expect(result.mappedModel).toBe('glm-4-plus');
        expect(result.provider).toBe('zhipu');
        expect(result.routingDecision).toEqual(expect.objectContaining({
            model: 'glm-4-plus',
            source: 'tier'
        }));

        // Body should have the final routed model
        const parsed = JSON.parse(result.body.toString());
        expect(parsed.model).toBe('glm-4-plus');
    });

    it('should allow a second transform on the output of a first', async () => {
        // Simulate two sequential transformations (e.g., re-routing on failover)
        const body1 = Buffer.from(JSON.stringify({ model: 'gpt-4' }));

        const router1 = {
            selectModel: jest.fn().mockResolvedValue({
                model: 'glm-4-plus', source: 'tier'
            }),
            config: { logDecisions: false },
            shadowMode: false
        };

        const result1 = await transformRequestBody(body1, null, 0, null, null, router1);
        expect(result1.mappedModel).toBe('glm-4-plus');

        // Second transform takes the output body and re-routes (e.g., failover)
        const router2 = {
            selectModel: jest.fn().mockResolvedValue({
                model: 'glm-4-flash', source: 'failover'
            }),
            config: { logDecisions: false },
            shadowMode: false
        };
        const attempted = new Set(['glm-4-plus']);

        const result2 = await transformRequestBody(
            result1.body, null, 0, null, attempted, router2
        );

        expect(result2.originalModel).toBe('glm-4-plus');
        expect(result2.mappedModel).toBe('glm-4-flash');
        expect(router2.selectModel).toHaveBeenCalledWith(
            expect.objectContaining({ attemptedModels: attempted })
        );
    });
});

// ---------------------------------------------------------------------------
// 11  Edge: very large model name
// ---------------------------------------------------------------------------
describe('transformRequestBody — very large model name in body', () => {
    it('should handle a 10KB model name without crashing', async () => {
        const hugeModel = 'x'.repeat(10 * 1024);
        const body = Buffer.from(JSON.stringify({ model: hugeModel }));

        // Without router — passes through
        const result = await transformRequestBody(body, null);

        expect(result.originalModel).toBe(hugeModel);
        expect(result.mappedModel).toBe(hugeModel);
        expect(result.body).toBe(body);
    });

    it('should handle a 10KB model name with a router', async () => {
        const hugeModel = 'x'.repeat(10 * 1024);
        const body = Buffer.from(JSON.stringify({ model: hugeModel }));
        const mockRouter = {
            selectModel: jest.fn().mockResolvedValue({
                model: 'normal-model', source: 'catch-all'
            }),
            config: { logDecisions: false },
            shadowMode: false
        };

        const result = await transformRequestBody(body, null, 0, null, null, mockRouter);

        expect(result.originalModel).toBe(hugeModel);
        expect(result.mappedModel).toBe('normal-model');
        expect(mockRouter.selectModel).toHaveBeenCalledWith(
            expect.objectContaining({ requestModel: hugeModel })
        );
    });
});

// ---------------------------------------------------------------------------
// 12  Edge: model name with special characters
// ---------------------------------------------------------------------------
describe('transformRequestBody — special characters in model name', () => {
    const specialModels = [
        { name: 'unicode emoji', model: 'claude-\u{1F680}-rocket' },
        { name: 'spaces', model: 'my custom model' },
        { name: 'dots', model: 'gpt-4.turbo.2024.01.25' },
        { name: 'hyphens and underscores', model: 'claude_3-5-sonnet_v2' },
        { name: 'slashes', model: 'org/model/variant' },
        { name: 'at-sign and colon', model: '@provider:model-v1' },
        { name: 'CJK characters', model: '\u6A21\u578B-glm-4' },
        { name: 'mixed unicode', model: 'mod\u00E8le-fran\u00E7ais-v1' }
    ];

    it.each(specialModels)(
        'should preserve model name with $name characters: "$model"',
        async ({ model }) => {
            const body = Buffer.from(JSON.stringify({ model }));

            const result = await transformRequestBody(body, null);

            expect(result.originalModel).toBe(model);
            expect(result.mappedModel).toBe(model);
        }
    );

    it('should route special-character model names through the router', async () => {
        const body = Buffer.from(JSON.stringify({ model: 'org/special-model.v2' }));
        const mockRouter = {
            selectModel: jest.fn().mockResolvedValue({
                model: 'mapped-special', source: 'rule'
            }),
            config: { logDecisions: false },
            shadowMode: false
        };

        const result = await transformRequestBody(body, null, 0, null, null, mockRouter);

        expect(result.originalModel).toBe('org/special-model.v2');
        expect(result.mappedModel).toBe('mapped-special');
        const parsed = JSON.parse(result.body.toString());
        expect(parsed.model).toBe('mapped-special');
    });
});
