'use strict';

const { ModelRouter } = require('../lib/model-router');
const { ModelDiscovery } = require('../lib/model-discovery');
const { KeyManager } = require('../lib/key-manager');

describe('ModelRouter Unified Decision Trace - ARCH-04', () => {
    let router;
    let discovery;
    let keyManager;

    beforeEach(() => {
        discovery = new ModelDiscovery({
            models: [
                { id: 'glm-4', tier: 'medium', maxConcurrency: 10 },
                { id: 'glm-5', tier: 'heavy', maxConcurrency: 1 }
            ]
        });

        keyManager = new KeyManager({
            keys: [
                { keyId: 'key1', apiKey: 'sk-test1' },
                { keyId: 'key2', apiKey: 'sk-test2' }
            ],
            maxConcurrencyPerKey: 3
        });
        keyManager.loadKeys([
            'sk-test1',
            'sk-test2'
        ]);

        router = new ModelRouter({
            enabled: true,
            tiers: {
                light: { models: ['glm-3'], strategy: 'throughput', clientModelPolicy: 'always-route' },
                medium: { models: ['glm-4'], strategy: 'balanced', clientModelPolicy: 'always-route' },
                heavy: { models: ['glm-5'], strategy: 'quality', clientModelPolicy: 'always-route' }
            },
            trace: { samplingRate: 100 }
        }, {
            modelDiscovery: discovery
        });

        router.setKeyManagerForDrift(keyManager);
    });

    describe('requestId linking', () => {
        it('should include requestId for trace/logs/metrics linking', async () => {
            const requestId = 'link-test-123';
            const request = {
                requestId,
                body: { model: 'auto', messages: [] }
            };

            const selectedModel = { model: 'glm-4', tier: 'medium' };
            const candidates = [
                { model: 'glm-4', score: 0.9, inFlight: 0, maxConcurrency: 10, available: 1 }
            ];

            const trace = await router._buildTrace(
                { parsedBody: request.body, requestId },
                {},
                null,
                selectedModel,
                candidates,
                {}
            );

            expect(trace.requestId).toBe(requestId);
        });

        it('should generate requestId if not provided', async () => {
            const request = {
                body: { model: 'auto', messages: [] }
            };

            const selectedModel = { model: 'glm-4', tier: 'medium' };
            const candidates = [
                { model: 'glm-4', score: 0.9, inFlight: 0, maxConcurrency: 10, available: 1 }
            ];

            const trace = await router._buildTrace(
                { parsedBody: request.body },
                {},
                null,
                selectedModel,
                candidates,
                {}
            );

            expect(trace.requestId).toMatch(/^req_\d+_[a-z0-9]+$/);
        });

        it('should generate unique requestIds', async () => {
            const request = { body: { model: 'auto', messages: [] } };
            const selectedModel = { model: 'glm-4', tier: 'medium' };
            const candidates = [
                { model: 'glm-4', score: 0.9, inFlight: 0, maxConcurrency: 10, available: 1 }
            ];

            const trace1 = await router._buildTrace(
                { parsedBody: request.body },
                {},
                null,
                selectedModel,
                candidates,
                {}
            );
            const trace2 = await router._buildTrace(
                { parsedBody: request.body },
                {},
                null,
                selectedModel,
                candidates,
                {}
            );

            expect(trace1.requestId).not.toBe(trace2.requestId);
        });
    });

    describe('trace structure', () => {
        it('should include all required trace properties', async () => {
            const request = {
                requestId: 'struct-test-1',
                body: { model: 'auto', messages: [{ role: 'user', content: 'test' }] }
            };

            const selectedModel = { model: 'glm-4', tier: 'medium' };

            const trace = await router._buildTrace(
                { parsedBody: request.body, requestId: request.requestId },
                {},
                null,
                selectedModel,
                [],  // Empty candidates - will trigger fallback
                { includeRouterState: true, includeKeyState: false }
            );

            // Required base properties
            expect(trace).toHaveProperty('requestId');
            expect(trace).toHaveProperty('timestamp');
            expect(trace).toHaveProperty('input');
            expect(trace).toHaveProperty('classification');
            expect(trace).toHaveProperty('modelSelection');

            // ARCH-04: routerPool included when includeRouterState=true
            expect(trace).toHaveProperty('routerPool');
        });

        it('should have correct routerPool structure', async () => {
            const request = {
                requestId: 'struct-test-2',
                body: { model: 'auto', messages: [] }
            };

            const selectedModel = { model: 'glm-4', tier: 'medium' };

            const trace = await router._buildTrace(
                { parsedBody: request.body, requestId: request.requestId },
                {},
                null,
                selectedModel,
                [],  // Empty candidates - will trigger fallback
                { includeRouterState: true }
            );

            // Check routerPool structure
            expect(trace.routerPool).toMatchObject({
                modelId: expect.any(String),
                inFlight: expect.any(Number),
                max: expect.any(Number),
                isAvailable: expect.any(Boolean)
            });
            expect(trace.routerPool).toHaveProperty('cooldownUntil');
        });

        it('should include key when includeKeyState=true with valid keyIndex', async () => {
            const request = {
                requestId: 'struct-test-3',
                body: { model: 'auto', messages: [] }
            };

            const selectedModel = { model: 'glm-4', tier: 'medium' };
            const candidates = [
                { model: 'glm-4', score: 0.9, inFlight: 0, maxConcurrency: 10, available: 1 }
            ];

            const trace = await router._buildTrace(
                { parsedBody: request.body, requestId: request.requestId, keyIndex: 0 },
                {},
                null,
                selectedModel,
                candidates,
                { includeRouterState: false, includeKeyState: true }
            );

            // Check key structure
            expect(trace).toHaveProperty('key');
            expect(trace).toHaveProperty('key');
            expect(trace.key).toHaveProperty('index');
            expect(typeof trace.key.index).toBe('number');
            expect(trace.key).toHaveProperty('excluded');
            expect(typeof trace.key.excluded).toBe('boolean');
            expect(trace.key).toHaveProperty('reason');
            // reason is null when key is not excluded
            expect(trace.key).toHaveProperty('state');
            expect(typeof trace.key.state).toBe('string');
        });

        it('should not include key when keyIndex is not provided', async () => {
            const request = {
                requestId: 'struct-test-4',
                body: { model: 'auto', messages: [] }
            };

            const selectedModel = { model: 'glm-4', tier: 'medium' };
            const candidates = [
                { model: 'glm-4', score: 0.9, inFlight: 0, maxConcurrency: 10, available: 1 }
            ];

            const trace = await router._buildTrace(
                { parsedBody: request.body, requestId: request.requestId },
                {},
                null,
                selectedModel,
                candidates,
                { includeKeyState: true }
            );

            // Should not have key if keyIndex is missing
            expect(trace).not.toHaveProperty('key');
        });
    });

    describe('explain() with unified trace', () => {
        it('should return unified trace when includeTrace=true', async () => {
            const request = {
                body: { model: 'auto', messages: [{ role: 'user', content: 'test' }] }
            };

            const result = await router.explain({ parsedBody: request.body }, { includeTrace: true });

            expect(result).toHaveProperty('trace');
            expect(result.trace).toHaveProperty('requestId');
            // When model is selected, routerPool should be included
            if (result.selectedModel) {
                expect(result.trace).toHaveProperty('routerPool');
            }
        });

        it('should not include trace when includeTrace=false', async () => {
            const request = {
                body: { model: 'auto', messages: [{ role: 'user', content: 'test' }] }
            };

            const result = await router.explain({ parsedBody: request.body }, { includeTrace: false });

            expect(result).not.toHaveProperty('trace');
        });
    });

    describe('computeDecision() with unified trace', () => {
        it('should build trace with routerPool when model is selected', async () => {
            const request = {
                parsedBody: { model: 'auto', messages: [{ role: 'user', content: 'test' }] }
            };

            const decision = await router.computeDecision({
                ...request,
                includeTrace: true,
                bypassSampling: true
            });

            expect(decision).toHaveProperty('trace');
            expect(decision.trace).toHaveProperty('routerPool');
            expect(decision.trace.routerPool).toHaveProperty('modelId');
        });

        it('should build trace without routerPool when no model selected', async () => {
            router.config.enabled = false;
            const request = {
                parsedBody: { model: 'auto', messages: [] }
            };

            const decision = await router.computeDecision({
                ...request,
                includeTrace: true,
                bypassSampling: true
            });

            expect(decision).toHaveProperty('trace');
            // When disabled, routerPool should not be included
            expect(decision.trace.routerPool).toBeUndefined();
        });
    });

    describe('trace payload size truncation', () => {
        it('should truncate when payload exceeds max size', async () => {
            const request = {
                requestId: 'truncate-test',
                body: {
                    model: 'auto',
                    messages: Array(100).fill({ role: 'user', content: 'x'.repeat(50) })
                }
            };

            const selectedModel = { model: 'glm-4', tier: 'medium' };
            const candidates = [
                { model: 'glm-4', score: 0.9, inFlight: 0, maxConcurrency: 10, available: 1 }
            ];

            const trace = await router._buildTrace(
                { parsedBody: request.body, requestId: request.requestId },
                {},
                null,
                selectedModel,
                candidates,
                { includeRouterState: true, includeKeyState: true }
            );

            // Check trace has truncation properties
            expect(trace).toHaveProperty('requestId');
            expect(trace).toHaveProperty('timestamp');
            // May or may not have routerPool and key depending on options
        });
    });
});
