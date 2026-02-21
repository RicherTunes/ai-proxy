'use strict';

/**
 * Contract Test: Unified Decision Trace
 * ARCH-04: Validates the structure of unified trace payload
 */

const { ModelRouter } = require('../lib/model-router');
const { ModelDiscovery } = require('../lib/model-discovery');

describe('ModelRouter Unified Decision Trace - Contract (ARCH-04)', () => {
    let router;

    beforeEach(() => {
        const discovery = new ModelDiscovery({
            models: [
                { id: 'glm-4', tier: 'medium', maxConcurrency: 10 },
                { id: 'glm-5', tier: 'heavy', maxConcurrency: 1 }
            ]
        });

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
    });

    describe('UnifiedDecisionTrace schema', () => {
        it('should include all required base properties', async () => {
            const request = {
                requestId: 'test-001',
                body: {
                    model: 'auto',
                    messages: [{ role: 'user', content: 'Hello' }]
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
                {}
            );

            // Required base properties
            expect(trace).toHaveProperty('requestId');
            expect(trace).toHaveProperty('timestamp');
            expect(trace).toHaveProperty('input');
            expect(trace).toHaveProperty('classification');
            expect(trace).toHaveProperty('modelSelection');
        });

        it('should include routerPool when includeRouterState=true', async () => {
            const request = {
                requestId: 'test-002',
                body: { model: 'auto', messages: [] }
            };

            const decision = {
                model: 'glm-4',
                tier: 'medium'
            };

            const candidates = [
                { model: 'glm-4', score: 0.9, inFlight: 0, maxConcurrency: 10, available: 1 }
            ];

            const trace = await router._buildTrace(
                { parsedBody: request.body, requestId: request.requestId },
                {},
                null,
                decision,
                candidates,
                { includeRouterState: true }
            );

            // Debug: log trace structure
            console.log('Trace:', JSON.stringify(trace, null, 2));
            console.log('Candidates:', JSON.stringify(candidates, null, 2));

            // Verify routerPool structure
            expect(trace).toHaveProperty('routerPool');
            expect(trace.routerPool).toMatchObject({
                modelId: 'glm-4',
                inFlight: 0,
                max: expect.any(Number),
                isAvailable: expect.any(Boolean)
            });
            expect(trace.routerPool).toHaveProperty('cooldownUntil');
        });

        it('should not include routerPool when includeRouterState=false', async () => {
            const request = {
                requestId: 'test-003',
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
                { includeRouterState: false }
            );

            expect(trace).not.toHaveProperty('routerPool');
        });

        it('should include requestId for trace/logs/metrics linking', async () => {
            const request = {
                body: { model: 'auto', messages: [] }
            };

            const trace = await router._buildTrace(
                { parsedBody: request.body },
                {},
                null,
                { model: 'glm-4', tier: 'medium' },
                [],
                {}
            );

            // Verify requestId format for linking across trace/logs/metrics
            expect(trace.requestId).toMatch(/^req_\d+_[a-z0-9]+$/);
        });

        it('should generate unique requestIds', async () => {
            const request = { body: { model: 'auto', messages: [] } };

            const trace1 = await router._buildTrace(
                { parsedBody: request.body },
                {},
                null,
                { model: 'glm-4', tier: 'medium' },
                [],
                {}
            );

            const trace2 = await router._buildTrace(
                { parsedBody: request.body },
                {},
                null,
                { model: 'glm-4', tier: 'medium' },
                [],
                {}
            );

            expect(trace1.requestId).not.toBe(trace2.requestId);
        });
    });

    describe('UnifiedDecisionTrace compatibility', () => {
        it('should maintain backward compatibility with existing DecisionTrace', async () => {
            // This test ensures that unified trace extends DecisionTrace
            // and doesn't break existing consumers

            const request = {
                requestId: 'compat-001',
                body: {
                    model: 'auto',
                    messages: [{ role: 'user', content: 'Compatibility test' }]
                }
            };

            const selectedModel = { model: 'glm-4', tier: 'medium' };
            const candidates = [
                { model: 'glm-4', score: 0.9, inFlight: 0, maxConcurrency: 10, available: 1 }
            ];

            // Build trace without unified state options (default behavior)
            const trace = await router._buildTrace(
                { parsedBody: request.body, requestId: request.requestId },
                {},
                null,
                selectedModel,
                candidates
            );

            // Base DecisionTrace properties should still be present
            expect(trace).toHaveProperty('requestId');
            expect(trace).toHaveProperty('timestamp');
            expect(trace).toHaveProperty('input');
            expect(trace).toHaveProperty('classification');
            expect(trace).toHaveProperty('modelSelection');

            // Unified properties should NOT be included by default
            expect(trace).not.toHaveProperty('routerPool');
            expect(trace).not.toHaveProperty('key');
        });
    });

    describe('UnifiedDecisionTrace JSDoc types', () => {
        it('should export UnifiedDecisionTrace type definition', () => {
            // This test validates that JSDoc types are properly defined
            // In a real TypeScript environment, these would be compile-time checks

            // Check that _buildTrace method exists
            expect(typeof router._buildTrace).toBe('function');

            // Check method signature accepts options parameter
            const traceStr = router._buildTrace.toString();
            expect(traceStr).toContain('options');
            expect(traceStr).toContain('includeRouterState');
            expect(traceStr).toContain('includeKeyState');
        });
    });
});
