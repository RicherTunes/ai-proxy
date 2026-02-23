/**
 * Contract Test: Model Transformer
 *
 * This contract test ensures that model transformation produces consistent results
 * after extraction from RequestHandler to model-transformer.js.
 *
 * TDD Phase: Red - Write failing test first
 */

'use strict';

const { transformRequestBody } = require('../../lib/request/model-transformer');

describe('RequestHandler Contract: Model Transformation', () => {
    describe('should handle empty bodies', () => {
        it('should return null models for empty body', async () => {
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
    });

    describe('should handle non-JSON bodies', () => {
        it('should return body as-is for invalid JSON', async () => {
            const body = Buffer.from('not json');
            const logger = { debug: jest.fn() };
            const result = await transformRequestBody(body, logger, null, null, null);
            expect(result).toEqual({
                body,
                originalModel: null,
                mappedModel: null,
                routingDecision: null,
                provider: null
            });
            expect(logger.debug).toHaveBeenCalledWith(
                'Body not JSON, skipping model mapping',
                { error: expect.any(String) }
            );
        });
    });

    describe('should handle bodies without model field', () => {
        it('should return body as-is when no model field', async () => {
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

    describe('should use model router when available', () => {
        it('should route to model from router when router returns non-null', async () => {
            const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus', messages: [] }));
            const mockRouter = {
                selectModel: jest.fn().mockResolvedValue({
                    model: 'glm-4-opus',
                    source: 'tier',
                    tier: 'premium',
                    reason: 'complexity'
                }),
                config: { logDecisions: false },
                shadowMode: false
            };
            const logger = { info: jest.fn() };

            const result = await transformRequestBody(body, logger, 0, null, null, mockRouter);

            expect(result.originalModel).toBe('claude-3-opus');
            expect(result.mappedModel).toBe('glm-4-opus');
            expect(result.routingDecision).toEqual({
                model: 'glm-4-opus',
                source: 'tier',
                tier: 'premium',
                reason: 'complexity'
            });
            expect(result.body).toBeInstanceOf(Buffer);
            const parsed = JSON.parse(result.body.toString());
            expect(parsed.model).toBe('glm-4-opus');
        });

        it('should return original model when router returns null', async () => {
            const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus', messages: [] }));
            const mockRouter = {
                selectModel: jest.fn().mockResolvedValue(null),
                config: { logDecisions: false },
                shadowMode: false
            };

            const result = await transformRequestBody(body, null, 0, null, null, mockRouter);

            expect(result.originalModel).toBe('claude-3-opus');
            expect(result.mappedModel).toBe('claude-3-opus');
            expect(result.routingDecision).toBeNull();
        });
    });

    describe('should return original model when no router provided', () => {
        it('should return original model unchanged when no router', async () => {
            const body = Buffer.from(JSON.stringify({ model: 'claude-3-sonnet', messages: [] }));
            const result = await transformRequestBody(body, null, 0, null, null, null);

            expect(result.originalModel).toBe('claude-3-sonnet');
            expect(result.mappedModel).toBe('claude-3-sonnet');
            expect(result.routingDecision).toBeNull();
            expect(result.body).toBe(body); // Same buffer, not re-serialized
        });
    });

    describe('router with catch-all always returns non-null decision', () => {
        it('should always return a routing decision when router has catch-all rule', async () => {
            const mockRouter = {
                selectModel: jest.fn().mockResolvedValue({
                    model: 'glm-4.5',
                    tier: 'medium',
                    source: 'catch-all',
                    reason: 'catch-all'
                }),
                config: { logDecisions: false },
                shadowMode: false
            };
            const body = Buffer.from(JSON.stringify({ model: 'unknown-model', messages: [] }));
            const result = await transformRequestBody(body, null, 0, null, null, mockRouter);
            expect(result.routingDecision).not.toBeNull();
            expect(result.mappedModel).toBe('glm-4.5');
        });
    });

    describe('model-router routing contract', () => {
        it('should use router result when router returns non-null', async () => {
            const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));
            const mockRouter = {
                selectModel: jest.fn().mockResolvedValue({ model: 'routed-model', source: 'test' }),
                config: { logDecisions: false },
                shadowMode: false
            };

            const result = await transformRequestBody(body, null, 0, null, null, mockRouter);

            expect(result.mappedModel).toBe('routed-model');
            expect(result.routingDecision).not.toBeNull();
        });
    });
});
