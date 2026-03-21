/**
 * Coverage Gap Tests: Model Transformer
 *
 * Targets uncovered branches:
 * - Lines 110-111: Override accepted log with expired throttle
 * - Lines 207-209: stream_options injection when no routing occurs
 *
 * TDD Phase: Targeting 98%+ branch coverage
 */

'use strict';

const { transformRequestBody, sanitizeModelOverride } = require('../lib/request/model-transformer');

describe('model-transformer coverage gaps', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('lines 110-111: override accepted with expired throttle', () => {
        // Covers lines 110-111: x-model-override accepted logging when throttle expires
        it('should log override accepted when throttle has expired (>1000ms)', async () => {
            const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));
            const req = {
                headers: { 'x-model-override': 'glm-4-opus' }
            };

            const mockAuth = {
                enabled: true,
                authenticate: jest.fn(() => ({ authenticated: true }))
            };
            const mockRouter = {
                selectModel: jest.fn().mockResolvedValue({
                    model: 'glm-4-opus',
                    source: 'override',
                    reason: 'admin override'
                }),
                config: {
                    adminAuth: mockAuth,
                    _adminAuthInstance: mockAuth,
                    logDecisions: false
                },
                shadowMode: false
            };

            const logger = { info: jest.fn() };
            // Throttle with accepted timestamp >1000ms ago (expired)
            const throttle = { accepted: Date.now() - 2000, rejected: 0 };

            await transformRequestBody(body, logger, 0, req, null, mockRouter, throttle);

            // Should log because throttle expired
            expect(logger.info).toHaveBeenCalledWith(
                'x-model-override accepted',
                expect.objectContaining({
                    override: 'glm-4-opus',
                    originalModel: 'claude-3-opus'
                })
            );
            // Throttle should be updated to current time
            expect(throttle.accepted).toBeGreaterThan(Date.now() - 100);
        });

        // Covers lines 118-124: Override rejected logging when throttle expires
        it('should log override rejected when throttle has expired', async () => {
            const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));
            const req = {
                headers: { 'x-model-override': 'unauthorized-model' }
            };

            const mockAuth = {
                enabled: true,
                authenticate: jest.fn(() => ({ authenticated: false, error: 'Invalid token' }))
            };
            const mockRouter = {
                selectModel: jest.fn().mockResolvedValue({
                    model: 'claude-3-opus',
                    source: 'tier'
                }),
                config: {
                    adminAuth: mockAuth,
                    _adminAuthInstance: mockAuth,
                    logDecisions: false
                },
                shadowMode: false
            };

            const logger = { warn: jest.fn() };
            // Throttle with rejected timestamp >1000ms ago (expired)
            const throttle = { accepted: 0, rejected: Date.now() - 2000 };

            await transformRequestBody(body, logger, 0, req, null, mockRouter, throttle);

            // Should log warning because throttle expired
            expect(logger.warn).toHaveBeenCalledWith(
                'x-model-override rejected: auth failed',
                expect.objectContaining({
                    override: 'unauthorized-model',
                    originalModel: 'claude-3-opus'
                })
            );
            // Throttle should be updated
            expect(throttle.rejected).toBeGreaterThan(Date.now() - 100);
        });

        // Covers lines 130-136: No auth configured - override accepted with expired throttle
        it('should log override accepted when no auth and throttle expires', async () => {
            const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));
            const req = {
                headers: { 'x-model-override': 'glm-4-opus' }
            };

            const mockRouter = {
                selectModel: jest.fn().mockResolvedValue({
                    model: 'glm-4-opus',
                    source: 'override'
                }),
                config: { adminAuth: null, logDecisions: false },
                shadowMode: false
            };

            const logger = { info: jest.fn() };
            // Throttle with accepted timestamp >1000ms ago
            const throttle = { accepted: Date.now() - 1500, rejected: 0 };

            await transformRequestBody(body, logger, 0, req, null, mockRouter, throttle);

            // Should log "accepted (no auth)" because throttle expired
            expect(logger.info).toHaveBeenCalledWith(
                'x-model-override accepted (no auth)',
                expect.objectContaining({
                    override: 'glm-4-opus',
                    originalModel: 'claude-3-opus'
                })
            );
        });
    });

    describe('lines 207-209: stream_options injection without routing', () => {
        // Covers lines 206-210: stream_options injection when router returns null (no routing)
        it('should inject stream_options when router returns null and stream is true', async () => {
            const body = Buffer.from(JSON.stringify({
                model: 'claude-3-opus',
                stream: true,
                messages: []
            }));

            const mockRouter = {
                selectModel: jest.fn().mockResolvedValue(null), // No routing
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

            // Should return original model since no routing happened
            expect(result.originalModel).toBe('claude-3-opus');
            expect(result.mappedModel).toBe('claude-3-opus');
            expect(result.routingDecision).toBeNull();

            // Body should have stream_options injected
            const parsed = JSON.parse(result.body.toString());
            expect(parsed.stream_options).toEqual({ include_usage: true });
            expect(parsed.stream).toBe(true);

            // Provider should still be resolved for original model
            expect(result.provider).toBe('anthropic');
            expect(mockProviderRegistry.resolveProviderForModel).toHaveBeenCalledWith(
                'claude-3-opus', null
            );
        });

        // Covers lines 212: No stream_options injection when stream is false (no routing)
        it('should not inject stream_options when stream is false and no routing', async () => {
            const body = Buffer.from(JSON.stringify({
                model: 'claude-3-opus',
                stream: false
            }));

            const mockRouter = {
                selectModel: jest.fn().mockResolvedValue(null),
                config: { logDecisions: false },
                shadowMode: false
            };

            const result = await transformRequestBody(body, null, 0, null, null, mockRouter);

            const parsed = JSON.parse(result.body.toString());
            expect(parsed.stream_options).toBeUndefined();
            expect(result.body).toBe(body); // Same buffer, not re-serialized
        });

        // Covers lines 212: Return original body when no router and no stream_options needed
        it('should not re-serialize body when no router and not streaming', async () => {
            const body = Buffer.from(JSON.stringify({
                model: 'claude-3-opus',
                messages: [{ role: 'user', content: 'hello' }]
            }));

            const result = await transformRequestBody(body, null, 0, null, null, null);

            // Should return the same buffer reference (not re-serialized)
            expect(result.body).toBe(body);
            expect(result.originalModel).toBe('claude-3-opus');
            expect(result.mappedModel).toBe('claude-3-opus');
        });

        // Covers lines 206-210: stream_options injection with no router at all
        it('should inject stream_options when no router provided and stream is true', async () => {
            const body = Buffer.from(JSON.stringify({
                model: 'gpt-4',
                stream: true,
                max_tokens: 100
            }));

            const result = await transformRequestBody(body, null, 0, null, null, null);

            const parsed = JSON.parse(result.body.toString());
            expect(parsed.stream_options).toEqual({ include_usage: true });
            expect(parsed.model).toBe('gpt-4');
            expect(parsed.max_tokens).toBe(100);

            // Body should be re-serialized (new buffer)
            expect(result.body).not.toBe(body);
        });

        // Covers lines 200-203: Provider resolution when no routing
        it('should resolve provider for original model when no router and streaming', async () => {
            const body = Buffer.from(JSON.stringify({
                model: 'claude-3-sonnet',
                stream: true
            }));

            const mockProviderRegistry = {
                resolveProviderForModel: jest.fn().mockReturnValue({ providerName: 'anthropic' })
            };

            const result = await transformRequestBody(
                body, null, 0, null, null, null, null,
                mockProviderRegistry, null
            );

            expect(result.provider).toBe('anthropic');
            expect(mockProviderRegistry.resolveProviderForModel).toHaveBeenCalledWith(
                'claude-3-sonnet', null
            );
        });
    });

    describe('lines 150-183: Complete routing path with provider resolution', () => {
        // Covers lines 171-174: Provider resolution with routing and providerRegistry
        it('should resolve provider for routed model when providerRegistry exists', async () => {
            const body = Buffer.from(JSON.stringify({
                model: 'claude-3-opus',
                stream: true
            }));

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

            const mockProviderRegistry = {
                resolveProviderForModel: jest.fn().mockReturnValue({ providerName: 'zhipu' })
            };
            const mockModelMapping = { models: {} };

            const result = await transformRequestBody(
                body, null, 0, null, null, mockRouter, null,
                mockProviderRegistry, mockModelMapping
            );

            // Provider should be resolved for the ROUTED model, not original
            expect(result.provider).toBe('zhipu');
            expect(mockProviderRegistry.resolveProviderForModel).toHaveBeenCalledWith(
                'glm-4-opus', mockModelMapping
            );
        });

        // Covers lines 181: Provider is null when providerRegistry returns falsy
        it('should set provider to null when providerRegistry returns null', async () => {
            const body = Buffer.from(JSON.stringify({ model: 'claude-3-opus' }));

            const mockRouter = {
                selectModel: jest.fn().mockResolvedValue({
                    model: 'glm-4-opus',
                    source: 'tier'
                }),
                config: { logDecisions: false },
                shadowMode: false
            };

            const mockProviderRegistry = {
                resolveProviderForModel: jest.fn().mockReturnValue(null)
            };

            const result = await transformRequestBody(
                body, null, 0, null, null, mockRouter, null,
                mockProviderRegistry, null
            );

            expect(result.provider).toBeNull();
        });

        // Covers lines 157-159: stream_options injection with routing
        it('should inject stream_options when routing occurs and stream is true', async () => {
            const body = Buffer.from(JSON.stringify({
                model: 'claude-3-opus',
                stream: true
            }));

            const mockRouter = {
                selectModel: jest.fn().mockResolvedValue({
                    model: 'glm-4-opus',
                    source: 'tier'
                }),
                config: { logDecisions: false },
                shadowMode: false
            };

            const result = await transformRequestBody(body, null, 0, null, null, mockRouter);

            const parsed = JSON.parse(result.body.toString());
            expect(parsed.stream_options).toEqual({ include_usage: true });
            expect(parsed.model).toBe('glm-4-opus');
        });
    });

    describe('sanitizeModelOverride edge cases for coverage', () => {
        // Covers line 27-29: Non-string type check and control char stripping
        it('should return null for object input', () => {
            expect(sanitizeModelOverride({ foo: 'bar' })).toBeNull();
        });

        // Covers line 31-33: Length truncation branch
        it('should truncate exactly at MAX_OVERRIDE_LENGTH', () => {
            const input = 'a'.repeat(128) + 'b'; // 129 chars
            const result = sanitizeModelOverride(input);
            expect(result).toHaveLength(128);
            expect(result).toBe('a'.repeat(128)); // No 'b'
        });

        // Covers line 34: Empty after sanitization returns null
        it('should return null when string is all control chars', () => {
            expect(sanitizeModelOverride('\x00\x01\x02\x1f')).toBeNull();
        });
    });
});
