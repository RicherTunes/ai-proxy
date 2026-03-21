'use strict';

/**
 * Stats Controller Branch Coverage Tests
 *
 * Covers uncovered branches identified by lcov:
 * Lines: 87, 127, 149, 156, 165, 169, 281, 288, 306, 350, 366, 375, 384,
 *        396, 402, 407, 417, 425, 430, 440, 450, 468, 480, 481, 495, 542, 562, 577, 606, 623, 797
 */

const { StatsController, appendMonth1Metrics } = require('../../../lib/proxy/controllers/stats-controller');

describe('stats-controller branch coverage', () => {
    let controller;
    let mockRes;

    afterEach(() => {
        jest.restoreAllMocks();
        jest.resetModules();
    });

    describe('handleStats - missing dependencies branches', () => {
        // Covers line 87: this._keyManager && this._keyManager.getPoolRateLimitStats (false branch)
        it('should handle null keyManager in handleStats', () => {
            // Covers line 87: keyManager null branch
            controller = new StatsController({
                statsAggregator: {
                    getFullStats: jest.fn(() => ({
                        keys: [],
                        uptime: 1000,
                        clientRequests: {}
                    }))
                },
                requestHandler: {
                    getBackpressureStats: jest.fn(() => ({ current: 0, max: 0, percentUsed: 0, queue: { length: 0, waiting: 0 } })),
                    getRequestPayloadStoreStats: jest.fn(() => ({ size: 0 }))
                },
                keyManager: null,  // null keyManager triggers line 87 false branch
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleStats({}, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'content-type': 'application/json' }));
            const responseBody = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseBody.poolCooldown).toBeDefined();
            expect(responseBody.poolCooldown.policy).toBeDefined();
        });

        // Covers lines 82-84: requestHandler without getRequestPayloadStoreStats method
        it('should handle requestHandler without getRequestPayloadStoreStats', () => {
            controller = new StatsController({
                statsAggregator: {
                    getFullStats: jest.fn(() => ({ keys: [], uptime: 1000, clientRequests: {} }))
                },
                requestHandler: {
                    getBackpressureStats: jest.fn(() => ({ current: 0, max: 0, percentUsed: 0, queue: { length: 0, waiting: 0 } }))
                    // No getRequestPayloadStoreStats method
                },
                keyManager: { getPoolRateLimitStats: jest.fn(() => ({ inCooldown: false })) },
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleStats({}, mockRes);

            const responseBody = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseBody).toBeDefined();
        });
    });

    describe('handleMetrics - missing dependencies branches', () => {
        // Covers line 149: this._requestHandler null in handleMetrics
        it('should handle null requestHandler in handleMetrics', () => {
            // Covers line 149: requestHandler null branch
            controller = new StatsController({
                statsAggregator: {
                    getFullStats: jest.fn(() => ({
                        keys: [],
                        uptime: 1000,
                        clientRequests: {},
                        latency: {},
                        errors: {},
                        tokens: {}
                    }))
                },
                requestHandler: null,  // null requestHandler triggers line 149 false branch
                keyManager: { getPoolRateLimitStats: jest.fn(() => ({ inCooldown: false })) },
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleMetrics({}, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
            const output = mockRes.end.mock.calls[0][0];
            expect(output).toContain('glm_proxy_info');
        });

        // Covers line 156: this._statsAggregator null in handleMetrics
        it('should handle null statsAggregator in handleMetrics', () => {
            // Covers line 156: statsAggregator null branch
            controller = new StatsController({
                statsAggregator: null,  // null statsAggregator triggers line 156 false branch
                requestHandler: {
                    getBackpressureStats: jest.fn(() => ({ current: 0, max: 0, percentUsed: 0, queue: { current: 0, max: 0 } }))
                },
                keyManager: { getPoolRateLimitStats: jest.fn(() => ({ inCooldown: false })) },
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleMetrics({}, mockRes);

            const output = mockRes.end.mock.calls[0][0];
            expect(output).toContain('glm_proxy_info');
        });

        // Covers line 165: statsAggregator without getRateLimitTrackingStats
        it('should handle statsAggregator without getRateLimitTrackingStats', () => {
            // Covers line 165: statsAggregator.getRateLimitTrackingStats missing
            controller = new StatsController({
                statsAggregator: {
                    getFullStats: jest.fn(() => ({
                        keys: [],
                        uptime: 1000,
                        clientRequests: {},
                        latency: {},
                        errors: {},
                        tokens: {}
                    }))
                    // No getRateLimitTrackingStats method
                },
                requestHandler: {
                    getBackpressureStats: jest.fn(() => ({ current: 0, max: 0, percentUsed: 0, queue: { current: 0, max: 0 } }))
                },
                keyManager: { getPoolRateLimitStats: jest.fn(() => ({ inCooldown: false })) },
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleMetrics({}, mockRes);

            const output = mockRes.end.mock.calls[0][0];
            expect(output).toContain('glm_proxy_retries_total 0');
        });

        // Covers line 169: keyManager without getPoolRateLimitStats
        it('should handle keyManager without getPoolRateLimitStats', () => {
            // Covers line 169: keyManager.getPoolRateLimitStats missing
            controller = new StatsController({
                statsAggregator: {
                    getFullStats: jest.fn(() => ({
                        keys: [],
                        uptime: 1000,
                        clientRequests: {},
                        latency: {},
                        errors: {},
                        tokens: {}
                    })),
                    getRateLimitTrackingStats: jest.fn(() => ({ poolCooldowns: 1 }))
                },
                requestHandler: {
                    getBackpressureStats: jest.fn(() => ({ current: 0, max: 0, percentUsed: 0, queue: { current: 0, max: 0 } }))
                },
                keyManager: {},  // No getPoolRateLimitStats method
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleMetrics({}, mockRes);

            const output = mockRes.end.mock.calls[0][0];
            expect(output).toContain('glm_proxy_pool_in_cooldown 0');
        });
    });

    describe('handleMetrics - key state and total branches', () => {
        // Covers line 281: key.total || 0 when total is 0/undefined
        it('should emit 0 for key requests when total is missing', () => {
            // Covers line 281: key.total || 0 fallback
            controller = new StatsController({
                statsAggregator: {
                    getFullStats: jest.fn(() => ({
                        keys: [
                            { state: 'CLOSED' },  // No total property
                            { state: 'OPEN', total: 0 }  // total is 0
                        ],
                        uptime: 1000,
                        clientRequests: {},
                        latency: {},
                        errors: {},
                        tokens: {}
                    }))
                },
                requestHandler: {
                    getBackpressureStats: jest.fn(() => ({ current: 0, max: 0, percentUsed: 0, queue: { current: 0, max: 0 } }))
                },
                keyManager: { getPoolRateLimitStats: jest.fn(() => ({ inCooldown: false })) },
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleMetrics({}, mockRes);

            const output = mockRes.end.mock.calls[0][0];
            expect(output).toContain('glm_proxy_key_requests_total{key="0"} 0');
            expect(output).toContain('glm_proxy_key_requests_total{key="1"} 0');
        });

        // Covers line 288: key.state HALF_OPEN and OPEN branches
        it('should emit state value 1 for HALF_OPEN keys', () => {
            // Covers line 288: key.state === 'HALF_OPEN' branch (returns 1)
            controller = new StatsController({
                statsAggregator: {
                    getFullStats: jest.fn(() => ({
                        keys: [{ state: 'HALF_OPEN', total: 10 }],
                        uptime: 1000,
                        clientRequests: {},
                        latency: {},
                        errors: {},
                        tokens: {}
                    }))
                },
                requestHandler: {
                    getBackpressureStats: jest.fn(() => ({ current: 0, max: 0, percentUsed: 0, queue: { current: 0, max: 0 } }))
                },
                keyManager: { getPoolRateLimitStats: jest.fn(() => ({ inCooldown: false })) },
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleMetrics({}, mockRes);

            const output = mockRes.end.mock.calls[0][0];
            expect(output).toContain('glm_proxy_key_state{key="0"} 1');
        });

        it('should emit state value 2 for OPEN keys', () => {
            // Covers line 288: else branch (returns 2 for OPEN or unknown state)
            controller = new StatsController({
                statsAggregator: {
                    getFullStats: jest.fn(() => ({
                        keys: [{ state: 'OPEN', total: 5 }],
                        uptime: 1000,
                        clientRequests: {},
                        latency: {},
                        errors: {},
                        tokens: {}
                    }))
                },
                requestHandler: {
                    getBackpressureStats: jest.fn(() => ({ current: 0, max: 0, percentUsed: 0, queue: { current: 0, max: 0 } }))
                },
                keyManager: { getPoolRateLimitStats: jest.fn(() => ({ inCooldown: false })) },
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleMetrics({}, mockRes);

            const output = mockRes.end.mock.calls[0][0];
            expect(output).toContain('glm_proxy_key_state{key="0"} 2');
        });
    });

    describe('handleMetrics - cost tracking branches', () => {
        // Covers line 306: trackedCost && trackedCost.cost > 0 false branches
        it('should use fallback rates when costTracker is null', () => {
            // Covers line 306-307: trackedCost is null/undefined
            controller = new StatsController({
                statsAggregator: {
                    getFullStats: jest.fn(() => ({
                        keys: [],
                        uptime: 1000,
                        clientRequests: {},
                        latency: {},
                        errors: {},
                        tokens: { totalInputTokens: 1000000, totalOutputTokens: 500000 }
                    }))
                },
                requestHandler: {
                    getBackpressureStats: jest.fn(() => ({ current: 0, max: 0, percentUsed: 0, queue: { current: 0, max: 0 } }))
                },
                keyManager: { getPoolRateLimitStats: jest.fn(() => ({ inCooldown: false })) },
                costTracker: null,  // null costTracker triggers fallback
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleMetrics({}, mockRes);

            const output = mockRes.end.mock.calls[0][0];
            expect(output).toContain('glm_proxy_cost_total');
        });

        it('should use fallback when trackedCost.cost is 0', () => {
            // Covers line 306: trackedCost.cost > 0 is false
            controller = new StatsController({
                statsAggregator: {
                    getFullStats: jest.fn(() => ({
                        keys: [],
                        uptime: 1000,
                        clientRequests: {},
                        latency: {},
                        errors: {},
                        tokens: { totalInputTokens: 100000, totalOutputTokens: 50000 }
                    }))
                },
                requestHandler: {
                    getBackpressureStats: jest.fn(() => ({ current: 0, max: 0, percentUsed: 0, queue: { current: 0, max: 0 } }))
                },
                keyManager: { getPoolRateLimitStats: jest.fn(() => ({ inCooldown: false })) },
                costTracker: {
                    getStats: jest.fn(() => ({ cost: 0 }))  // cost is 0
                },
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleMetrics({}, mockRes);

            const output = mockRes.end.mock.calls[0][0];
            expect(output).toContain('glm_proxy_cost_total');
        });

        it('should use costTracker rates for fallback calculation', () => {
            // Covers line 310-315: fallback with costTracker.rates
            controller = new StatsController({
                statsAggregator: {
                    getFullStats: jest.fn(() => ({
                        keys: [],
                        uptime: 1000,
                        clientRequests: {},
                        latency: {},
                        errors: {},
                        tokens: { totalInputTokens: 2000000, totalOutputTokens: 1000000 }
                    }))
                },
                requestHandler: {
                    getBackpressureStats: jest.fn(() => ({ current: 0, max: 0, percentUsed: 0, queue: { current: 0, max: 0 } }))
                },
                keyManager: { getPoolRateLimitStats: jest.fn(() => ({ inCooldown: false })) },
                costTracker: {
                    getStats: jest.fn(() => ({ cost: 0 })),
                    rates: { inputTokenPer1M: 5.00, outputTokenPer1M: 20.00 }
                },
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleMetrics({}, mockRes);

            const output = mockRes.end.mock.calls[0][0];
            // With custom rates: (2000000/1000000)*5 + (1000000/1000000)*20 = 10 + 20 = 30
            expect(output).toContain('glm_proxy_cost_total 30.000000');
        });
    });

    describe('handleMetrics - tenant metrics branches', () => {
        // Covers line 350: tenantStats.enabled && tenantStats.tenants false
        it('should skip tenant metrics when tenantStats.enabled is false', () => {
            // Covers line 350: enabled is false
            controller = new StatsController({
                statsAggregator: {
                    getFullStats: jest.fn(() => ({ keys: [], uptime: 1000, clientRequests: {}, latency: {}, errors: {}, tokens: {} }))
                },
                requestHandler: {
                    getBackpressureStats: jest.fn(() => ({ current: 0, max: 0, percentUsed: 0, queue: { current: 0, max: 0 } }))
                },
                keyManager: { getPoolRateLimitStats: jest.fn(() => ({ inCooldown: false })) },
                tenantManager: {
                    getAllTenantStats: jest.fn(() => ({ enabled: false, tenants: {} }))
                },
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleMetrics({}, mockRes);

            const output = mockRes.end.mock.calls[0][0];
            expect(output).not.toContain('glm_proxy_tenant_info');
        });

        // Covers lines 350, 366, 375, 384: tenant iteration with actual tenants
        it('should emit tenant metrics with strictMode true', () => {
            // Covers lines 350, 356, 366, 375, 384: tenant iteration branches
            controller = new StatsController({
                statsAggregator: {
                    getFullStats: jest.fn(() => ({ keys: [], uptime: 1000, clientRequests: {}, latency: {}, errors: {}, tokens: {} }))
                },
                requestHandler: {
                    getBackpressureStats: jest.fn(() => ({ current: 0, max: 0, percentUsed: 0, queue: { current: 0, max: 0 } }))
                },
                keyManager: { getPoolRateLimitStats: jest.fn(() => ({ inCooldown: false })) },
                tenantManager: {
                    getAllTenantStats: jest.fn(() => ({
                        enabled: true,
                        tenants: {
                            'tenant1': { tenantId: 'tenant1', strictMode: true, keyCount: 5, requestCount: 100, errorCount: 2 }
                        }
                    }))
                },
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleMetrics({}, mockRes);

            const output = mockRes.end.mock.calls[0][0];
            expect(output).toContain('glm_proxy_tenant_info{tenant="tenant1",strict_mode="true"} 1');
            expect(output).toContain('glm_proxy_tenant_requests_total{tenant="tenant1"} 100');
            expect(output).toContain('glm_proxy_tenant_keys_total{tenant="tenant1"} 5');
            expect(output).toContain('glm_proxy_tenant_errors_total{tenant="tenant1"} 2');
        });

        it('should handle tenant with strictMode false', () => {
            // Covers line 356: strictMode || false fallback
            controller = new StatsController({
                statsAggregator: {
                    getFullStats: jest.fn(() => ({ keys: [], uptime: 1000, clientRequests: {}, latency: {}, errors: {}, tokens: {} }))
                },
                requestHandler: {
                    getBackpressureStats: jest.fn(() => ({ current: 0, max: 0, percentUsed: 0, queue: { current: 0, max: 0 } }))
                },
                keyManager: { getPoolRateLimitStats: jest.fn(() => ({ inCooldown: false })) },
                tenantManager: {
                    getAllTenantStats: jest.fn(() => ({
                        enabled: true,
                        tenants: {
                            'tenant2': { tenantId: 'tenant2', keyCount: 3, requestCount: 50, errorCount: 0 }  // No strictMode
                        }
                    }))
                },
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleMetrics({}, mockRes);

            const output = mockRes.end.mock.calls[0][0];
            expect(output).toContain('strict_mode="false"');
        });

        it('should handle tenants without requestCount/errorCount', () => {
            // Covers lines 366, 375, 384: missing tenant properties
            controller = new StatsController({
                statsAggregator: {
                    getFullStats: jest.fn(() => ({ keys: [], uptime: 1000, clientRequests: {}, latency: {}, errors: {}, tokens: {} }))
                },
                requestHandler: {
                    getBackpressureStats: jest.fn(() => ({ current: 0, max: 0, percentUsed: 0, queue: { current: 0, max: 0 } }))
                },
                keyManager: { getPoolRateLimitStats: jest.fn(() => ({ inCooldown: false })) },
                tenantManager: {
                    getAllTenantStats: jest.fn(() => ({
                        enabled: true,
                        tenants: {
                            'minimal': { tenantId: 'minimal' }  // Minimal tenant data
                        }
                    }))
                },
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleMetrics({}, mockRes);

            const output = mockRes.end.mock.calls[0][0];
            expect(output).toContain('glm_proxy_tenant_requests_total{tenant="minimal"} 0');
            expect(output).toContain('glm_proxy_tenant_keys_total{tenant="minimal"} 0');
            expect(output).toContain('glm_proxy_tenant_errors_total{tenant="minimal"} 0');
        });
    });

    describe('handleMetrics - model router branches', () => {
        // Covers line 396: modelRouter.enabled false
        it('should handle modelRouter with enabled false', () => {
            // Covers line 396: this._modelRouter.enabled is false
            controller = new StatsController({
                statsAggregator: {
                    getFullStats: jest.fn(() => ({ keys: [], uptime: 1000, clientRequests: {}, latency: {}, errors: {}, tokens: {} }))
                },
                requestHandler: {
                    getBackpressureStats: jest.fn(() => ({ current: 0, max: 0, percentUsed: 0, queue: { current: 0, max: 0 } }))
                },
                keyManager: { getPoolRateLimitStats: jest.fn(() => ({ inCooldown: false })) },
                modelRouter: {
                    enabled: false,
                    getStats: jest.fn(() => ({
                        total: 0,
                        byTier: {},
                        bySource: {},
                        byStrategy: {},
                        byUpgradeReason: {},
                        byFallbackReason: {},
                        heavyModels: [],
                        byModel: {}
                    })),
                    getCooldowns: jest.fn(() => ({})),
                    getOverrides: jest.fn(() => ({}))
                },
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleMetrics({}, mockRes);

            const output = mockRes.end.mock.calls[0][0];
            expect(output).toContain('glm_proxy_model_routing_enabled 0');
        });

        // Covers lines 402, 407, 417: count > 0 false branches
        it('should skip metrics when tier counts are 0', () => {
            // Covers lines 402, 407, 417: count > 0 is false
            controller = new StatsController({
                statsAggregator: {
                    getFullStats: jest.fn(() => ({ keys: [], uptime: 1000, clientRequests: {}, latency: {}, errors: {}, tokens: {} }))
                },
                requestHandler: {
                    getBackpressureStats: jest.fn(() => ({ current: 0, max: 0, percentUsed: 0, queue: { current: 0, max: 0 } }))
                },
                keyManager: { getPoolRateLimitStats: jest.fn(() => ({ inCooldown: false })) },
                modelRouter: {
                    enabled: true,
                    getStats: jest.fn(() => ({
                        total: 10,
                        byTier: { 'premium': 0, 'standard': 0 },  // All zeros
                        bySource: { 'direct': 0, 'failover': 0 },  // All zeros
                        byStrategy: { 'quality': 0 },  // Zero
                        byUpgradeReason: {},
                        byFallbackReason: {},
                        heavyModels: [],
                        byModel: {}
                    })),
                    getCooldowns: jest.fn(() => ({})),
                    getOverrides: jest.fn(() => ({}))
                },
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleMetrics({}, mockRes);

            const output = mockRes.end.mock.calls[0][0];
            // Should not contain tier entries with 0 count
            expect(output).not.toContain('glm_proxy_model_routing_decisions_total{tier="premium"');
            expect(output).toContain('glm_proxy_model_routing_decisions_total{tier="all",source="all"} 10');
        });

        // Covers lines 425, 430: failover count 0
        it('should emit 0 for failover when bySource.failover is 0', () => {
            // Covers lines 425, 430: routingStats.bySource.failover || 0
            controller = new StatsController({
                statsAggregator: {
                    getFullStats: jest.fn(() => ({ keys: [], uptime: 1000, clientRequests: {}, latency: {}, errors: {}, tokens: {} }))
                },
                requestHandler: {
                    getBackpressureStats: jest.fn(() => ({ current: 0, max: 0, percentUsed: 0, queue: { current: 0, max: 0 } }))
                },
                keyManager: { getPoolRateLimitStats: jest.fn(() => ({ inCooldown: false })) },
                modelRouter: {
                    enabled: true,
                    getStats: jest.fn(() => ({
                        total: 5,
                        byTier: { 'standard': 5 },
                        bySource: { 'direct': 5, 'failover': 0 },  // failover is 0
                        byStrategy: {},
                        byUpgradeReason: {},
                        byFallbackReason: {},
                        heavyModels: [],
                        byModel: {}
                    })),
                    getCooldowns: jest.fn(() => ({})),
                    getOverrides: jest.fn(() => ({}))
                },
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleMetrics({}, mockRes);

            const output = mockRes.end.mock.calls[0][0];
            expect(output).toContain('glm_proxy_model_routing_failovers_total 0');
            expect(output).toContain('glm_proxy_model_routing_switches_total 0');
        });

        // Covers line 440: activeCooldowns > 0 false
        it('should skip max cooldown metric when no active cooldowns', () => {
            // Covers line 440: activeCooldowns > 0 is false
            controller = new StatsController({
                statsAggregator: {
                    getFullStats: jest.fn(() => ({ keys: [], uptime: 1000, clientRequests: {}, latency: {}, errors: {}, tokens: {} }))
                },
                requestHandler: {
                    getBackpressureStats: jest.fn(() => ({ current: 0, max: 0, percentUsed: 0, queue: { current: 0, max: 0 } }))
                },
                keyManager: { getPoolRateLimitStats: jest.fn(() => ({ inCooldown: false })) },
                modelRouter: {
                    enabled: true,
                    getStats: jest.fn(() => ({
                        total: 5,
                        byTier: {},
                        bySource: {},
                        byStrategy: {},
                        byUpgradeReason: {},
                        byFallbackReason: {},
                        heavyModels: [],
                        byModel: {}
                    })),
                    getCooldowns: jest.fn(() => ({})),  // No cooldowns
                    getOverrides: jest.fn(() => ({}))
                },
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleMetrics({}, mockRes);

            const output = mockRes.end.mock.calls[0][0];
            expect(output).toContain('glm_proxy_model_routing_cooldowns_active 0');
            expect(output).not.toContain('glm_proxy_model_routing_cooldown_max_remaining_ms');
        });

        // Covers line 450: Math.max(0, normalTotal) when burstDampened > total
        it('should handle negative normalTotal with Math.max', () => {
            // Covers line 450: Math.max(0, normalTotal) when normalTotal would be negative
            controller = new StatsController({
                statsAggregator: {
                    getFullStats: jest.fn(() => ({ keys: [], uptime: 1000, clientRequests: {}, latency: {}, errors: {}, tokens: {} }))
                },
                requestHandler: {
                    getBackpressureStats: jest.fn(() => ({ current: 0, max: 0, percentUsed: 0, queue: { current: 0, max: 0 } }))
                },
                keyManager: { getPoolRateLimitStats: jest.fn(() => ({ inCooldown: false })) },
                modelRouter: {
                    enabled: true,
                    getStats: jest.fn(() => ({
                        total: 5,
                        burstDampenedTotal: 10,  // Greater than total - makes normalTotal negative
                        byTier: {},
                        bySource: {},
                        byStrategy: {},
                        byUpgradeReason: {},
                        byFallbackReason: {},
                        heavyModels: [],
                        byModel: {}
                    })),
                    getCooldowns: jest.fn(() => ({})),
                    getOverrides: jest.fn(() => ({}))
                },
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleMetrics({}, mockRes);

            const output = mockRes.end.mock.calls[0][0];
            expect(output).toContain('glm_proxy_model_routing_cooldowns_recorded_total{mode="normal"} 0');
            expect(output).toContain('glm_proxy_model_routing_cooldowns_recorded_total{mode="burst"} 10');
        });

        // Covers line 468: count > 0 false for upgradeReason
        it('should skip upgrade reason metrics when count is 0', () => {
            // Covers line 468: count > 0 is false
            controller = new StatsController({
                statsAggregator: {
                    getFullStats: jest.fn(() => ({ keys: [], uptime: 1000, clientRequests: {}, latency: {}, errors: {}, tokens: {} }))
                },
                requestHandler: {
                    getBackpressureStats: jest.fn(() => ({ current: 0, max: 0, percentUsed: 0, queue: { current: 0, max: 0 } }))
                },
                keyManager: { getPoolRateLimitStats: jest.fn(() => ({ inCooldown: false })) },
                modelRouter: {
                    enabled: true,
                    getStats: jest.fn(() => ({
                        total: 5,
                        byTier: {},
                        bySource: {},
                        byStrategy: {},
                        byUpgradeReason: { 'context_overflow': 0, 'latency': 0 },  // All zeros
                        byFallbackReason: {},
                        heavyModels: [],
                        byModel: {}
                    })),
                    getCooldowns: jest.fn(() => ({})),
                    getOverrides: jest.fn(() => ({}))
                },
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleMetrics({}, mockRes);

            const output = mockRes.end.mock.calls[0][0];
            expect(output).not.toContain('glm_proxy_upgrade_reason_total{reason="context_overflow"');
        });

        // Covers lines 480, 481: heavyModels empty or count 0
        it('should skip heavy model metrics when heavyModels is empty', () => {
            // Covers line 480: heavyModels.length > 0 is false
            controller = new StatsController({
                statsAggregator: {
                    getFullStats: jest.fn(() => ({ keys: [], uptime: 1000, clientRequests: {}, latency: {}, errors: {}, tokens: {} }))
                },
                requestHandler: {
                    getBackpressureStats: jest.fn(() => ({ current: 0, max: 0, percentUsed: 0, queue: { current: 0, max: 0 } }))
                },
                keyManager: { getPoolRateLimitStats: jest.fn(() => ({ inCooldown: false })) },
                modelRouter: {
                    enabled: true,
                    getStats: jest.fn(() => ({
                        total: 5,
                        byTier: {},
                        bySource: {},
                        byStrategy: {},
                        byUpgradeReason: {},
                        byFallbackReason: {},
                        heavyModels: [],  // Empty
                        byModel: {}
                    })),
                    getCooldowns: jest.fn(() => ({})),
                    getOverrides: jest.fn(() => ({}))
                },
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleMetrics({}, mockRes);

            const output = mockRes.end.mock.calls[0][0];
            expect(output).not.toContain('glm_proxy_heavy_model_selections_total');
        });

        it('should skip heavy model metrics when byModel count is 0', () => {
            // Covers line 481: count > 0 is false for byModel
            controller = new StatsController({
                statsAggregator: {
                    getFullStats: jest.fn(() => ({ keys: [], uptime: 1000, clientRequests: {}, latency: {}, errors: {}, tokens: {} }))
                },
                requestHandler: {
                    getBackpressureStats: jest.fn(() => ({ current: 0, max: 0, percentUsed: 0, queue: { current: 0, max: 0 } }))
                },
                keyManager: { getPoolRateLimitStats: jest.fn(() => ({ inCooldown: false })) },
                modelRouter: {
                    enabled: true,
                    getStats: jest.fn(() => ({
                        total: 5,
                        byTier: {},
                        bySource: {},
                        byStrategy: {},
                        byUpgradeReason: {},
                        byFallbackReason: {},
                        heavyModels: ['gpt-4'],
                        byModel: { 'gpt-4': 0 }  // Count is 0
                    })),
                    getCooldowns: jest.fn(() => ({})),
                    getOverrides: jest.fn(() => ({}))
                },
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleMetrics({}, mockRes);

            const output = mockRes.end.mock.calls[0][0];
            expect(output).not.toContain('glm_proxy_heavy_model_selections_total{model="gpt-4"}');
        });

        // Covers line 495: count > 0 false for fallbackReason
        it('should skip fallback reason metrics when count is 0', () => {
            // Covers line 495: count > 0 is false
            controller = new StatsController({
                statsAggregator: {
                    getFullStats: jest.fn(() => ({ keys: [], uptime: 1000, clientRequests: {}, latency: {}, errors: {}, tokens: {} }))
                },
                requestHandler: {
                    getBackpressureStats: jest.fn(() => ({ current: 0, max: 0, percentUsed: 0, queue: { current: 0, max: 0 } }))
                },
                keyManager: { getPoolRateLimitStats: jest.fn(() => ({ inCooldown: false })) },
                modelRouter: {
                    enabled: true,
                    getStats: jest.fn(() => ({
                        total: 5,
                        byTier: {},
                        bySource: {},
                        byStrategy: {},
                        byUpgradeReason: {},
                        byFallbackReason: { 'rate_limit': 0, 'timeout': 0 },  // All zeros
                        heavyModels: [],
                        byModel: {}
                    })),
                    getCooldowns: jest.fn(() => ({})),
                    getOverrides: jest.fn(() => ({}))
                },
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleMetrics({}, mockRes);

            const output = mockRes.end.mock.calls[0][0];
            expect(output).not.toContain('glm_proxy_fallback_reason_total{reason="rate_limit"');
        });
    });

    describe('handlePersistentStats - branches', () => {
        // Covers line 542: this._statsAggregator null
        it('should return default response when statsAggregator is null', () => {
            // Covers line 542: statsAggregator null branch
            controller = new StatsController({
                statsAggregator: null,
                keyManager: { getKeyId: jest.fn(k => k) },
                config: { apiKeys: ['key1'] }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handlePersistentStats({}, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
            const responseBody = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseBody).toEqual({ stats: {}, persistent: false });
        });

        it('should handle keyManager without getKeyId', () => {
            // Covers line 536-540: keyManager exists but no getKeyId
            controller = new StatsController({
                statsAggregator: {
                    getPersistentStatsResponse: jest.fn(() => ({ stats: { requests: 100 }, persistent: true }))
                },
                keyManager: {},  // No getKeyId method
                config: { apiKeys: ['raw-key-1'] }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handlePersistentStats({}, mockRes);

            const responseBody = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseBody.persistent).toBe(true);
        });
    });

    describe('handleReload - branches', () => {
        // Covers line 562: this._reloadKeys null or returns falsy
        it('should return failure when reloadKeys is null', () => {
            // Covers line 562: reloadKeys is null
            controller = new StatsController({
                reloadKeys: null,
                config: {}
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleReload({ method: 'POST' }, mockRes);

            const responseBody = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseBody.success).toBe(false);
            expect(responseBody.error).toBe('Failed to reload keys');
        });

        it('should return failure when reloadKeys returns falsy', () => {
            // Covers line 562-566: reloadKeys returns falsy
            controller = new StatsController({
                reloadKeys: jest.fn(() => null),
                config: {}
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleReload({ method: 'POST' }, mockRes);

            const responseBody = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseBody.success).toBe(false);
        });
    });

    describe('handleBackpressure - branches', () => {
        // Covers line 577: this._requestHandler null
        it('should return default backpressure when requestHandler is null', () => {
            // Covers line 577: requestHandler null branch
            controller = new StatsController({
                requestHandler: null,
                config: {}
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleBackpressure({}, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
            const responseBody = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseBody).toEqual({ current: 0, max: 0, percentUsed: 0, queue: { current: 0, max: 0 } });
        });
    });

    describe('handleStatsTenants - branches', () => {
        // Covers line 606: this._costTracker null
        it('should handle null costTracker in handleStatsTenants', () => {
            // Covers line 606: costTracker null branch
            controller = new StatsController({
                tenantManager: {
                    getAllTenantStats: jest.fn(() => ({
                        enabled: true,
                        tenantCount: 1,
                        globalStats: { totalRequests: 100, unknownTenantRequests: 5 },
                        tenants: {
                            'tenant1': { tenantId: 'tenant1', keyCount: 2, requestCount: 95, errorCount: 3, lastUsed: Date.now() }
                        }
                    }))
                },
                costTracker: null,  // null costTracker
                config: {}
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleStatsTenants({}, mockRes);

            const responseBody = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseBody.summary).toBeDefined();
            expect(responseBody.summary.totalTenants).toBe(1);
        });

        it('should handle costTracker without getAllTenantCosts', () => {
            // Covers line 606: costTracker exists but no getAllTenantCosts
            controller = new StatsController({
                tenantManager: {
                    getAllTenantStats: jest.fn(() => ({
                        enabled: true,
                        tenantCount: 1,
                        globalStats: { totalRequests: 100 },
                        tenants: {
                            't1': { tenantId: 't1', keyCount: 1, requestCount: 100, errorCount: 0 }
                        }
                    }))
                },
                costTracker: {},  // No getAllTenantCosts method
                config: {}
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleStatsTenants({}, mockRes);

            const responseBody = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseBody.summary).toBeDefined();
        });

        // Covers line 623: empty tenants object
        it('should handle empty tenants object', () => {
            // Covers line 623: Object.entries(tenantStats.tenants || {}) with empty
            controller = new StatsController({
                tenantManager: {
                    getAllTenantStats: jest.fn(() => ({
                        enabled: true,
                        tenantCount: 0,
                        globalStats: { totalRequests: 0, unknownTenantRequests: 0 },
                        tenants: {}  // Empty tenants
                    }))
                },
                costTracker: { getAllTenantCosts: jest.fn(() => ({})) },
                config: {}
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleStatsTenants({}, mockRes);

            const responseBody = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseBody.summary.totalTenants).toBe(0);
            expect(responseBody.summary.tenantBreakdown).toEqual([]);
        });

        it('should compute errorRate when requestCount > 0', () => {
            // Covers line 629-631: errorRate calculation
            controller = new StatsController({
                tenantManager: {
                    getAllTenantStats: jest.fn(() => ({
                        enabled: true,
                        tenantCount: 1,
                        globalStats: { totalRequests: 100 },
                        tenants: {
                            't1': { tenantId: 't1', keyCount: 1, requestCount: 100, errorCount: 25, lastUsed: Date.now() }
                        }
                    }))
                },
                costTracker: { getAllTenantCosts: jest.fn(() => ({ 't1': { totalCost: 5.50 } })) },
                config: {}
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleStatsTenants({}, mockRes);

            const responseBody = JSON.parse(mockRes.end.mock.calls[0][0]);
            const breakdown = responseBody.summary.tenantBreakdown[0];
            expect(breakdown.errorRate).toBe(25);  // 25/100 * 100 = 25
            expect(breakdown.totalCost).toBe(5.50);
        });

        it('should handle zero requestCount for errorRate', () => {
            // Covers line 629-631: errorRate when requestCount is 0
            controller = new StatsController({
                tenantManager: {
                    getAllTenantStats: jest.fn(() => ({
                        enabled: true,
                        tenantCount: 1,
                        globalStats: { totalRequests: 0 },
                        tenants: {
                            't1': { tenantId: 't1', keyCount: 1, requestCount: 0, errorCount: 0 }
                        }
                    }))
                },
                config: {}
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleStatsTenants({}, mockRes);

            const responseBody = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseBody.summary.tenantBreakdown[0].errorRate).toBe(0);
        });
    });

    describe('appendMonth1Metrics - line 797 branch', () => {
        // Covers line 797: typeof e === 'object' ? e.hits : e (else branch for non-object)
        it('should handle pool429Penalty with numeric entry values', () => {
            // Covers line 797: entry is not object, use entry directly
            const lines = [];
            const stats = {
                pool429Penalty: {
                    trackedModels: 1,
                    byModel: {
                        'model-numeric': 42  // Plain number, not { hits: 42 }
                    }
                }
            };

            appendMonth1Metrics(lines, stats, null);

            const joined = lines.join('\n');
            expect(joined).toContain('glm_proxy_pool_429_penalty_hits{model="model-numeric"} 42');
            expect(joined).toContain('glm_proxy_pool_429_penalty_max_hits 42');
        });

        it('should handle pool429Penalty with object entries missing hits', () => {
            // Covers line 797: object entry without hits property
            const lines = [];
            const stats = {
                pool429Penalty: {
                    trackedModels: 1,
                    byModel: {
                        'model-no-hits': {}  // Object without hits
                    }
                }
            };

            appendMonth1Metrics(lines, stats, null);

            const joined = lines.join('\n');
            // When hits is undefined, (e.hits || 0) should give 0
            expect(joined).toContain('glm_proxy_pool_429_penalty_max_hits 0');
        });
    });

    describe('handleMetrics - heavyModels with actual counts', () => {
        // Covers lines 480-481: heavyModels with non-zero counts
        it('should emit heavy model selections when count > 0', () => {
            // Covers line 480-481: heavyModels with actual byModel counts
            controller = new StatsController({
                statsAggregator: {
                    getFullStats: jest.fn(() => ({ keys: [], uptime: 1000, clientRequests: {}, latency: {}, errors: {}, tokens: {} }))
                },
                requestHandler: {
                    getBackpressureStats: jest.fn(() => ({ current: 0, max: 0, percentUsed: 0, queue: { current: 0, max: 0 } }))
                },
                keyManager: { getPoolRateLimitStats: jest.fn(() => ({ inCooldown: false })) },
                modelRouter: {
                    enabled: true,
                    getStats: jest.fn(() => ({
                        total: 10,
                        byTier: {},
                        bySource: {},
                        byStrategy: {},
                        byUpgradeReason: {},
                        byFallbackReason: {},
                        heavyModels: ['gpt-4', 'claude-3'],
                        byModel: { 'gpt-4': 7, 'claude-3': 3 }  // Non-zero counts
                    })),
                    getCooldowns: jest.fn(() => ({})),
                    getOverrides: jest.fn(() => ({}))
                },
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleMetrics({}, mockRes);

            const output = mockRes.end.mock.calls[0][0];
            expect(output).toContain('glm_proxy_heavy_model_selections_total{model="gpt-4"} 7');
            expect(output).toContain('glm_proxy_heavy_model_selections_total{model="claude-3"} 3');
        });

        it('should escape special chars in heavy model names', () => {
            // Covers line 483: model name escaping
            controller = new StatsController({
                statsAggregator: {
                    getFullStats: jest.fn(() => ({ keys: [], uptime: 1000, clientRequests: {}, latency: {}, errors: {}, tokens: {} }))
                },
                requestHandler: {
                    getBackpressureStats: jest.fn(() => ({ current: 0, max: 0, percentUsed: 0, queue: { current: 0, max: 0 } }))
                },
                keyManager: { getPoolRateLimitStats: jest.fn(() => ({ inCooldown: false })) },
                modelRouter: {
                    enabled: true,
                    getStats: jest.fn(() => ({
                        total: 10,
                        byTier: {},
                        bySource: {},
                        byStrategy: {},
                        byUpgradeReason: {},
                        byFallbackReason: {},
                        heavyModels: ['model"with\\special'],
                        byModel: { 'model"with\\special': 5 }
                    })),
                    getCooldowns: jest.fn(() => ({})),
                    getOverrides: jest.fn(() => ({}))
                },
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleMetrics({}, mockRes);

            const output = mockRes.end.mock.calls[0][0];
            expect(output).toContain('model\\"with\\\\special');
        });
    });

    describe('handleMetrics - costTracker.getStats returns undefined', () => {
        // Covers line 306: trackedCost is undefined
        it('should use fallback when costTracker.getStats returns undefined', () => {
            // Covers line 306: trackedCost is undefined
            controller = new StatsController({
                statsAggregator: {
                    getFullStats: jest.fn(() => ({
                        keys: [],
                        uptime: 1000,
                        clientRequests: {},
                        latency: {},
                        errors: {},
                        tokens: { totalInputTokens: 500000, totalOutputTokens: 250000 }
                    }))
                },
                requestHandler: {
                    getBackpressureStats: jest.fn(() => ({ current: 0, max: 0, percentUsed: 0, queue: { current: 0, max: 0 } }))
                },
                keyManager: { getPoolRateLimitStats: jest.fn(() => ({ inCooldown: false })) },
                costTracker: {
                    getStats: jest.fn(() => undefined)  // Returns undefined
                },
                config: { apiKeys: [], poolCooldown: {} }
            });

            mockRes = { writeHead: jest.fn(), end: jest.fn() };
            controller.handleMetrics({}, mockRes);

            const output = mockRes.end.mock.calls[0][0];
            expect(output).toContain('glm_proxy_cost_total');
        });
    });
});
