/**
 * Unit Test: Model Transformer Module
 *
 * TDD Phase: Red - Write failing unit test before module exists
 *
 * Tests the async function transformRequestBody() which extracts
 * model transformation logic from RequestHandler.
 */

'use strict';

const { transformRequestBody } = require('../../lib/request/model-transformer');

describe('model-transformer', () => {
    describe('transformRequestBody', () => {
        describe('Edge cases', () => {
            it('should handle empty body', async () => {
                const body = Buffer.from('');
                const result = await transformRequestBody(body, {}, null, null, null);
                expect(result).toEqual({
                    body,
                    originalModel: null,
                    mappedModel: null,
                    routingDecision: null,
                    provider: null
                });
            });

            it('should handle invalid JSON', async () => {
                const body = Buffer.from('invalid json');
                const logger = { debug: jest.fn() };
                const result = await transformRequestBody(body, logger, null, null, null);
                expect(result).toEqual({
                    body,
                    originalModel: null,
                    mappedModel: null,
                    routingDecision: null,
                    provider: null
                });
                expect(logger.debug).toHaveBeenCalled();
            });

            it('should handle body without model field', async () => {
                const body = Buffer.from(JSON.stringify({ messages: [] }));
                const result = await transformRequestBody(body, null, null, null, null);
                expect(result).toEqual({
                    body,
                    originalModel: null,
                    mappedModel: null,
                    routingDecision: null,
                    provider: null
                });
            });
        });

        describe('Model Router path', () => {
            it('should use router when it returns a model', async () => {
                const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus', max_tokens: 100 }));
                const mockRouter = {
                    selectModel: jest.fn().mockResolvedValue({
                        model: 'glm-4-opus',
                        source: 'tier',
                        tier: 'premium',
                        reason: 'high complexity'
                    }),
                    config: { logDecisions: false },
                    shadowMode: false
                };

                const result = await transformRequestBody(body, null, 0, null, null, mockRouter);

                expect(result.originalModel).toBe('claude-3-opus');
                expect(result.mappedModel).toBe('glm-4-opus');
                expect(result.routingDecision).toEqual({
                    model: 'glm-4-opus',
                    source: 'tier',
                    tier: 'premium',
                    reason: 'high complexity'
                });
                const parsed = JSON.parse(result.body.toString());
                expect(parsed.model).toBe('glm-4-opus');
            });

            it('should return original model when router returns null', async () => {
                const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));
                const mockRouter = {
                    selectModel: jest.fn().mockResolvedValue(null),
                    config: { logDecisions: false },
                    shadowMode: false
                };

                const result = await transformRequestBody(body, null, 0, null, null, mockRouter);

                expect(result.mappedModel).toBe('claude-3-opus');
                expect(result.routingDecision).toBeNull();
            });

            it('should log shadow decisions when in shadow mode', async () => {
                const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));
                const shadowDecision = {
                    model: 'glm-4-opus',
                    source: 'shadow',
                    tier: 'premium',
                    reason: 'shadow mode'
                };
                const mockRouter = {
                    selectModel: jest.fn().mockResolvedValue(null),
                    getLastShadowDecision: jest.fn(() => shadowDecision),
                    config: { logDecisions: true },
                    shadowMode: true
                };
                const logger = { info: jest.fn() };

                await transformRequestBody(body, logger, 0, null, null, mockRouter);

                expect(logger.info).toHaveBeenCalledWith(
                    expect.stringContaining('[SHADOW]'),
                    expect.objectContaining({
                        shadowMode: true
                    })
                );
            });

            describe('TRUST-03: includeTrace integration', () => {
                it('should pass includeTrace=true to selectModel', async () => {
                    const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));
                    const mockRouter = {
                        selectModel: jest.fn().mockResolvedValue({
                            model: 'glm-4-opus',
                            source: 'tier',
                            tier: 'premium',
                            reason: 'high complexity'
                        })
                    };

                    await transformRequestBody(body, null, 0, null, null, mockRouter);

                    expect(mockRouter.selectModel).toHaveBeenCalledWith(
                        expect.objectContaining({
                            includeTrace: true
                        })
                    );
                });

                it('should include trace field in routingDecision when router returns it', async () => {
                    const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));
                    const routingDecisionWithTrace = {
                        model: 'glm-4-opus',
                        source: 'tier',
                        tier: 'premium',
                        reason: 'high complexity',
                        trace: {
                            requestId: 'test-request-id',
                            classification: {
                                tier: 'heavy',
                                upgradeTrigger: 'has_tools'
                            }
                        }
                    };
                    const mockRouter = {
                        selectModel: jest.fn().mockResolvedValue(routingDecisionWithTrace)
                    };

                    const result = await transformRequestBody(body, null, 0, null, null, mockRouter);

                    expect(result.routingDecision).toEqual(routingDecisionWithTrace);
                });

                it('should preserve routingDecision structure when trace is null', async () => {
                    const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));
                    const routingDecisionWithoutTrace = {
                        model: 'glm-4-opus',
                        source: 'tier',
                        tier: 'premium',
                        reason: 'high complexity'
                        // No trace field
                    };
                    const mockRouter = {
                        selectModel: jest.fn().mockResolvedValue(routingDecisionWithoutTrace)
                    };

                    const result = await transformRequestBody(body, null, 0, null, null, mockRouter);

                    expect(result.routingDecision).toEqual(routingDecisionWithoutTrace);
                });
            });
        });

        describe('stream_options injection', () => {
            it('should inject stream_options for streaming requests', async () => {
                const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus', stream: true }));
                const mockRouter = {
                    selectModel: jest.fn().mockResolvedValue({
                        model: 'glm-4-opus',
                        source: 'rule',
                        tier: 'heavy',
                        reason: 'rule match'
                    }),
                    config: { logDecisions: false },
                    shadowMode: false
                };

                const result = await transformRequestBody(body, null, 0, null, null, mockRouter);
                const parsed = JSON.parse(result.body.toString());

                expect(parsed.stream_options).toEqual({ include_usage: true });
            });

            it('should not overwrite existing stream_options', async () => {
                const body = Buffer.from(JSON.stringify({
                    model: 'claude-3-opus',
                    stream: true,
                    stream_options: { include_usage: false }
                }));
                const mockRouter = {
                    selectModel: jest.fn().mockResolvedValue({
                        model: 'glm-4-opus',
                        source: 'rule',
                        tier: 'heavy',
                        reason: 'rule match'
                    }),
                    config: { logDecisions: false },
                    shadowMode: false
                };

                const result = await transformRequestBody(body, null, 0, null, null, mockRouter);
                const parsed = JSON.parse(result.body.toString());

                // Should preserve client's explicit setting
                expect(parsed.stream_options).toEqual({ include_usage: false });
            });

            it('should not inject stream_options for non-streaming requests', async () => {
                const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));
                const mockRouter = {
                    selectModel: jest.fn().mockResolvedValue({
                        model: 'glm-4-opus',
                        source: 'rule',
                        tier: 'heavy',
                        reason: 'rule match'
                    }),
                    config: { logDecisions: false },
                    shadowMode: false
                };

                const result = await transformRequestBody(body, null, 0, null, null, mockRouter);
                const parsed = JSON.parse(result.body.toString());

                expect(parsed.stream_options).toBeUndefined();
            });
        });

        describe('No router path', () => {
            it('should return original model when no router provided', async () => {
                const body = Buffer.from(JSON.stringify({ model: 'claude-3-sonnet' }));

                const result = await transformRequestBody(body, null, 0, null, null, null);

                expect(result.originalModel).toBe('claude-3-sonnet');
                expect(result.mappedModel).toBe('claude-3-sonnet');
                expect(result.routingDecision).toBeNull();
                expect(result.body).toBe(body);
            });
        });

        describe('Response shape contract', () => {
            it('should always return object with body, originalModel, mappedModel, routingDecision', async () => {
                const body = Buffer.from(JSON.stringify({ model: 'test' }));
                const result = await transformRequestBody(body, null, null, null, null, null);

                expect(result).toHaveProperty('body');
                expect(result).toHaveProperty('originalModel');
                expect(result).toHaveProperty('mappedModel');
                expect(result).toHaveProperty('routingDecision');
                expect(result.body).toBeInstanceOf(Buffer);
            });
        });

        // Tests for x-model-override header handling (lines 71-111)

        describe('x-model-override header', () => {
            const mockAdminAuthInstance = {
                authenticate: jest.fn()
            };

            it('should accept override when admin auth passes', async () => {
                const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4' }));
                const mockReq = {
                    headers: { 'x-model-override': 'claude-sonnet-4-5-20250929' }
                };
                const reqLogger = { info: jest.fn() };
                const mockRouter = {
                    selectModel: jest.fn().mockResolvedValue({
                        model: 'claude-sonnet-4-5-20250929',
                        source: 'override',
                        tier: 'medium',
                        reason: 'admin override'
                    }),
                    config: {
                        adminAuth: { enabled: true },
                        _adminAuthInstance: mockAdminAuthInstance
                    }
                };

                mockAdminAuthInstance.authenticate.mockReturnValue({ authenticated: true });

                await transformRequestBody(body, reqLogger, 0, mockReq, null, mockRouter);

                expect(mockRouter.selectModel).toHaveBeenCalledWith(expect.objectContaining({
                    override: 'claude-sonnet-4-5-20250929'
                }));
            });

            it('should reject override when admin auth fails', async () => {
                const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4' }));
                const mockReq = {
                    headers: { 'x-model-override': 'claude-sonnet-4-5-20250929' }
                };
                const reqLogger = { info: jest.fn(), warn: jest.fn() };
                const mockRouter = {
                    selectModel: jest.fn().mockResolvedValue({
                        model: 'claude-opus-4',
                        source: 'tier'
                    }),
                    config: {
                        adminAuth: { enabled: true },
                        _adminAuthInstance: mockAdminAuthInstance
                    }
                };

                mockAdminAuthInstance.authenticate.mockReturnValue({ authenticated: false, error: 'Unauthorized' });

                await transformRequestBody(body, reqLogger, 0, mockReq, null, mockRouter);

                // Override should NOT be passed to selectModel
                expect(mockRouter.selectModel).toHaveBeenCalledWith(expect.objectContaining({
                    override: null
                }));
            });

            it('should accept override when no auth configured', async () => {
                const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4' }));
                const mockReq = {
                    headers: { 'x-model-override': 'claude-sonnet-4-5-20250929' }
                };
                const reqLogger = { info: jest.fn() };
                const mockRouter = {
                    selectModel: jest.fn().mockResolvedValue({
                        model: 'claude-sonnet-4-5-20250929',
                        source: 'override'
                    }),
                    config: {
                        adminAuth: null
                    }
                };

                await transformRequestBody(body, reqLogger, 0, mockReq, null, mockRouter);

                expect(mockRouter.selectModel).toHaveBeenCalledWith(expect.objectContaining({
                    override: 'claude-sonnet-4-5-20250929'
                }));
            });

            it('should accept override when admin auth disabled', async () => {
                const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4' }));
                const mockReq = {
                    headers: { 'x-model-override': 'claude-sonnet-4-5-20250929' }
                };
                const reqLogger = { info: jest.fn() };
                const mockRouter = {
                    selectModel: jest.fn().mockResolvedValue({
                        model: 'claude-sonnet-4-5-20250929',
                        source: 'override'
                    }),
                    config: {
                        adminAuth: { enabled: false }
                    }
                };

                await transformRequestBody(body, reqLogger, 0, mockReq, null, mockRouter);

                expect(mockRouter.selectModel).toHaveBeenCalledWith(expect.objectContaining({
                    override: 'claude-sonnet-4-5-20250929'
                }));
            });

            it('should use original model when override is rejected', async () => {
                const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4' }));
                const mockReq = {
                    headers: { 'x-model-override': 'claude-sonnet-4-5-20250929' }
                };
                const reqLogger = { warn: jest.fn() };
                const mockRouter = {
                    selectModel: jest.fn().mockResolvedValue({
                        model: 'claude-opus-4',
                        source: 'tier'
                    }),
                    config: {
                        adminAuth: { enabled: true },
                        _adminAuthInstance: mockAdminAuthInstance
                    }
                };

                mockAdminAuthInstance.authenticate.mockReturnValue({ authenticated: false, error: 'Invalid token' });

                const result = await transformRequestBody(body, reqLogger, 0, mockReq, null, mockRouter);

                // Should use original model since override was rejected
                expect(result.mappedModel).toBe('claude-opus-4');
            });

            it('should handle missing headers object', async () => {
                const body = Buffer.from(JSON.stringify({ model: 'claude-opus-4' }));
                const mockReq = {}; // No headers
                const mockRouter = {
                    selectModel: jest.fn().mockResolvedValue({
                        model: 'claude-opus-4',
                        source: 'tier'
                    }),
                    config: {}
                };

                const result = await transformRequestBody(body, null, 0, mockReq, null, mockRouter);

                expect(mockRouter.selectModel).toHaveBeenCalledWith(expect.objectContaining({
                    override: null
                }));
            });
        });
    });
});
