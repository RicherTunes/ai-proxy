/**
 * Extended Unit Test: Model Transformer Module
 *
 * Additional edge case tests to improve branch coverage.
 */

'use strict';

const { transformRequestBody } = require('../../lib/request/model-transformer');

describe('model-transformer extended', () => {
    describe('override handling edge cases', () => {
        it('should accept override when no auth configured', async () => {
            const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));
            const req = {
                headers: { 'x-model-override': 'glm-4-opus' }
            };
            const mockRouter = {
                selectModel: jest.fn().mockResolvedValue({
                    model: 'glm-4-opus',
                    source: 'override',
                    reason: 'admin override'
                }),
                config: { logDecisions: false },
                shadowMode: false
            };
            const logger = { info: jest.fn() };
            const throttle = { accepted: 0, rejected: 0 };

            const result = await transformRequestBody(body, logger, 0, req, null, mockRouter, throttle);

            expect(result.mappedModel).toBe('glm-4-opus');
            expect(logger.info).toHaveBeenCalledWith(
                'x-model-override accepted (no auth)',
                expect.any(Object)
            );
        });

        it('should reject override when auth fails', async () => {
            const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));
            const req = {
                headers: { 'x-model-override': 'glm-4-opus' }
            };
            const mockAuth = {
                enabled: true,
                authenticate: jest.fn(() => ({ authenticated: false }))
            };
            const mockRouter = {
                config: {
                    adminAuth: mockAuth,
                    _adminAuthInstance: mockAuth,
                    logDecisions: false
                },
                selectModel: jest.fn().mockResolvedValue(null),
                shadowMode: false
            };
            const logger = { info: jest.fn(), warn: jest.fn() };
            const throttle = { accepted: 0, rejected: 0 };

            await transformRequestBody(body, logger, 0, req, null, mockRouter, throttle);

            expect(logger.warn).toHaveBeenCalledWith(
                'x-model-override rejected: auth failed',
                expect.any(Object)
            );
        });

        it('should throttle override accepted logs', async () => {
            const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));
            const req = {
                headers: { 'x-model-override': 'glm-4-opus' }
            };
            const mockRouter = {
                selectModel: jest.fn().mockResolvedValue({ model: 'glm-4-opus', source: 'override' }),
                config: { logDecisions: false },
                shadowMode: false
            };
            const logger = { info: jest.fn() };
            const throttle = { accepted: Date.now() - 500, rejected: 0 }; // Recent log

            await transformRequestBody(body, logger, 0, req, null, mockRouter, throttle);

            // Should not log because throttle hasn't expired (1000ms)
            expect(logger.info).not.toHaveBeenCalled();
        });

        it('should throttle override rejected logs', async () => {
            const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));
            const req = {
                headers: { 'x-model-override': 'glm-4-opus' }
            };
            const mockAuth = {
                enabled: true,
                authenticate: jest.fn(() => ({ authenticated: false }))
            };
            const mockRouter = {
                config: { adminAuth: mockAuth, logDecisions: false, _adminAuthInstance: mockAuth },
                selectModel: jest.fn().mockResolvedValue(null),
                shadowMode: false
            };
            const logger = { info: jest.fn(), warn: jest.fn() };
            const throttle = { accepted: 0, rejected: Date.now() - 500 };

            await transformRequestBody(body, logger, 0, req, null, mockRouter, throttle);

            // Should not log because throttle hasn't expired
            expect(logger.warn).not.toHaveBeenCalled();
        });
    });

    describe('router shadow mode', () => {
        it('should not log shadow when shadowMode is false', async () => {
            const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));
            const mockRouter = {
                selectModel: jest.fn().mockResolvedValue(null),
                getLastShadowDecision: jest.fn(() => ({ model: 'shadow-model' })),
                config: { logDecisions: true },
                shadowMode: false // Shadow mode off
            };
            const logger = { info: jest.fn() };

            await transformRequestBody(body, logger, 0, null, null, mockRouter);

            expect(logger.info).not.toHaveBeenCalledWith(
                expect.stringContaining('[SHADOW]'),
                expect.anything()
            );
        });

        it('should not log shadow when logDecisions is false', async () => {
            const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));
            const mockRouter = {
                selectModel: jest.fn().mockResolvedValue(null),
                getLastShadowDecision: jest.fn(() => ({ model: 'shadow-model' })),
                config: { logDecisions: false },
                shadowMode: true
            };
            const logger = { info: jest.fn() };

            await transformRequestBody(body, logger, 0, null, null, mockRouter);

            expect(logger.info).not.toHaveBeenCalled();
        });

        it('should not log shadow when no shadow decision', async () => {
            const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));
            const mockRouter = {
                selectModel: jest.fn().mockResolvedValue(null),
                getLastShadowDecision: jest.fn(() => null),
                config: { logDecisions: true },
                shadowMode: true
            };
            const logger = { info: jest.fn() };

            await transformRequestBody(body, logger, 0, null, null, mockRouter);

            expect(logger.info).not.toHaveBeenCalled();
        });
    });

    describe('router result handling', () => {
        it('should handle router result with null model', async () => {
            const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));
            const mockRouter = {
                selectModel: jest.fn().mockResolvedValue({ model: null, source: 'test' }),
                config: { logDecisions: false },
                shadowMode: false
            };

            const result = await transformRequestBody(body, null, 0, null, null, mockRouter);

            // Router returned null model - returns original unchanged
            expect(result.mappedModel).toBe('claude-3-opus');
            expect(result.routingDecision).toBeNull();
        });

        it('should handle router result with undefined model', async () => {
            const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));
            const mockRouter = {
                selectModel: jest.fn().mockResolvedValue({ source: 'test' }), // No model field
                config: { logDecisions: false },
                shadowMode: false
            };

            const result = await transformRequestBody(body, null, 0, null, null, mockRouter);

            // Router returned undefined model - returns original unchanged
            expect(result.mappedModel).toBe('claude-3-opus');
        });

        it('should log routing when logDecisions is true', async () => {
            const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));
            const mockRouter = {
                selectModel: jest.fn().mockResolvedValue({
                    model: 'glm-4-opus',
                    source: 'tier',
                    tier: 'premium',
                    reason: 'complexity'
                }),
                config: { logDecisions: true },
                shadowMode: false
            };
            const logger = { info: jest.fn() };

            const result = await transformRequestBody(body, logger, 0, null, null, mockRouter);

            expect(logger.info).toHaveBeenCalledWith(
                'Model routed: claude-3-opus -> glm-4-opus [tier]',
                {
                    tier: 'premium',
                    reason: 'complexity',
                    keyIndex: 0
                }
            );
        });
    });

    describe('no router edge cases', () => {
        it('should return original model when no router and no extra args', async () => {
            const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));

            const result = await transformRequestBody(body, null, 0, null, null, null);

            expect(result.originalModel).toBe('claude-3-opus');
            expect(result.mappedModel).toBe('claude-3-opus');
            expect(result.routingDecision).toBeNull();
            expect(result.body).toBe(body);
        });

        it('should not log anything when no router provided', async () => {
            const body = Buffer.from(JSON.stringify({ model: 'claude-3-sonnet' }));
            const logger = { info: jest.fn() };

            await transformRequestBody(body, logger, 0, null, null, null);

            expect(logger.info).not.toHaveBeenCalled();
        });
    });

    describe('attemptedModels parameter', () => {
        it('should pass attemptedModels to router', async () => {
            const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));
            const attempted = new Set(['glm-4-plus', 'glm-4-opus']);
            const mockRouter = {
                selectModel: jest.fn().mockImplementation(async (opts) => {
                    expect(opts.attemptedModels).toBe(attempted);
                    return { model: 'glm-4-flash', source: 'test' };
                }),
                config: { logDecisions: false },
                shadowMode: false
            };

            const result = await transformRequestBody(body, null, 0, null, attempted, mockRouter);

            expect(result.mappedModel).toBe('glm-4-flash');
        });
    });

    describe('JSON serialization', () => {
        it('should preserve non-model fields in body', async () => {
            const originalBody = { model: 'claude-3-opus', messages: [{ role: 'user', content: 'test' }], max_tokens: 100 };
            const body = Buffer.from(JSON.stringify(originalBody));
            const mockRouter = {
                selectModel: jest.fn().mockResolvedValue({ model: 'glm-4-opus', source: 'test' }),
                config: { logDecisions: false },
                shadowMode: false
            };

            const result = await transformRequestBody(body, null, 0, null, null, mockRouter);
            const parsed = JSON.parse(result.body.toString());

            expect(parsed.model).toBe('glm-4-opus');
            expect(parsed.messages).toEqual(originalBody.messages);
            expect(parsed.max_tokens).toBe(originalBody.max_tokens);
        });

        it('should handle special characters in JSON', async () => {
            const body = Buffer.from(JSON.stringify({
                model: 'claude-3-opus',
                messages: [{ role: 'user', content: 'Test with "quotes" and\nnewlines' }]
            }));
            const mockRouter = {
                selectModel: jest.fn().mockResolvedValue({ model: 'glm-4-opus', source: 'test' }),
                config: { logDecisions: false },
                shadowMode: false
            };

            const result = await transformRequestBody(body, null, 0, null, null, mockRouter);
            const parsed = JSON.parse(result.body.toString());

            expect(parsed.messages[0].content).toContain('quotes');
        });
    });
});
