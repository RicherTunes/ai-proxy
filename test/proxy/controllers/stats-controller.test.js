/**
 * Unit Test: Stats Controller
 *
 * TDD Phase: Red - Write failing unit test before module exists
 *
 * Tests the StatsController class for proxy-server.js stats-related routes.
 */

'use strict';

let StatsController;
try {
    ({ StatsController } = require('../../../lib/proxy/controllers/stats-controller'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = StatsController ? describe : describe.skip;

describeIfModule('stats-controller', () => {
    let controller;
    let mockStatsAggregator;
    let mockKeyManager;
    let mockRequestHandler;
    let mockTenantManager;
    let mockCostTracker;
    let mockModelRouter;
    let mockGetUptime;
    let mockReloadKeys;
    let mockConfig;

    beforeEach(() => {
        mockStatsAggregator = {
            getFullStats: jest.fn((keyManager, uptime) => ({
                requests: { total: 1000, succeeded: 950, failed: 50 },
                clientRequests: { succeeded: 950, failed: 50, inFlight: 10 },
                tokens: {
                    totalInputTokens: 50000,
                    totalOutputTokens: 30000
                },
                keys: [
                    { keyId: 'key1', state: 'CLOSED', total: 500 },
                    { keyId: 'key2', state: 'OPEN', total: 250 }
                ],
                latency: { p50: 100, p95: 200, p99: 300, avg: 150 },
                successRate: 95,
                uptime: uptime || 3600000,
                errors: { timeouts: 5, socketHangups: 3, connectionRefused: 2, serverErrors: 10, rateLimited: 30, totalRetries: 42 },
                giveUpTracking: { total: 7, byReason: { max_429_attempts: 4, max_429_window: 3 } },
                retryEfficiency: { sameModelRetries: 12, totalModelsTriedOnFailure: 25, totalModelSwitchesOnFailure: 8, failedRequestsWithModelStats: 15 },
                retryBackoff: { totalDelayMs: 5000, delayCount: 20 }
            })),
            getRateLimitTrackingStats: jest.fn(() => ({
                llm429Retries: 100,
                llm429RetrySuccesses: 90,
                upstream429s: 50,
                local429s: 20,
                poolCooldowns: 5
            })),
            getPersistentStatsResponse: jest.fn(() => ({
                stats: { requests: 1000 },
                persistent: true
            }))
        };

        mockKeyManager = {
            getPoolRateLimitStats: jest.fn(() => ({
                inCooldown: false,
                sleepCount: 0
            }))
        };

        mockRequestHandler = {
            getBackpressureStats: jest.fn(() => ({
                current: 5,
                max: 100,
                percentUsed: 5,
                queue: { current: 5, max: 50, waiting: 2 }
            })),
            getRequestPayloadStoreStats: jest.fn(() => ({
                size: 3,
                maxEntries: 200,
                retentionMs: 900000,
                storedTotal: 12,
                hits: 4,
                misses: 1,
                evictedBySize: 2,
                evictedByTtl: 3
            }))
        };

        mockTenantManager = {
            getAllTenantStats: jest.fn(() => ({
                enabled: true,
                tenantCount: 2,
                globalStats: {
                    totalRequests: 1000,
                    unknownTenantRequests: 10
                },
                tenants: {
                    'tenant1': {
                        tenantId: 'tenant1',
                        keyCount: 5,
                        requestCount: 600,
                        errorCount: 20,
                        lastUsed: Date.now()
                    },
                    'tenant2': {
                        tenantId: 'tenant2',
                        keyCount: 3,
                        requestCount: 390,
                        errorCount: 10,
                        lastUsed: Date.now() - 10000
                    }
                }
            }))
        };

        mockCostTracker = {
            getAllTenantCosts: jest.fn(() => ({
                'tenant1': { totalCost: 1.50 },
                'tenant2': { totalCost: 0.98 }
            }))
        };

        mockModelRouter = {
            enabled: true,
            getStats: jest.fn(() => ({
                total: 500,
                byTier: { 'premium': 300, 'standard': 200 },
                bySource: { 'direct': 400, 'failover': 100 },
                byStrategy: { 'quality': 150, 'throughput': 200, 'balanced': 100, 'pool': 50 },
                burstDampenedTotal: 50,
                tierDowngradeTotal: 5,
                tierDowngradeShadow: 12,
                tierDowngradeByRoute: { 'heavy->medium': 3, 'heavy->light': 2 },
                tierDowngradeShadowByRoute: { 'heavy->medium': 8, 'heavy->light': 4 },
                contextOverflowTotal: 7,
                contextOverflowByTier: { heavy: 5, light: 2 },
                contextOverflowByModel: { 'glm-4-flash': 4, 'glm-4-air': 3 }
            })),
            getCooldowns: jest.fn(() => ({
                'model1': { remainingMs: 5000 },
                'model2': { remainingMs: 10000 }
            })),
            getOverrides: jest.fn(() => ({ 'model1': 'model2' }))
        };

        mockGetUptime = jest.fn(() => 3600000);

        mockReloadKeys = jest.fn(() => ({ reloaded: 5, errors: 0 }));

        mockConfig = {
            apiKeys: ['sk-test1', 'sk-test2'],
            poolCooldown: {
                sleepThresholdMs: 250,
                retryJitterMs: 200,
                maxCooldownMs: 5000,
                baseMs: 500,
                capMs: 5000,
                decayMs: 10000
            }
        };

        controller = new StatsController({
            statsAggregator: mockStatsAggregator,
            keyManager: mockKeyManager,
            requestHandler: mockRequestHandler,
            tenantManager: mockTenantManager,
            costTracker: mockCostTracker,
            modelRouter: mockModelRouter,
            getUptime: mockGetUptime,
            reloadKeys: mockReloadKeys,
            config: mockConfig
        });
    });

    describe('constructor', () => {
        it('should create a new StatsController', () => {
            expect(controller).toBeInstanceOf(StatsController);
        });

        it('should initialize with provided dependencies', () => {
            expect(controller._statsAggregator).toBe(mockStatsAggregator);
            expect(controller._keyManager).toBe(mockKeyManager);
            expect(controller._requestHandler).toBe(mockRequestHandler);
            expect(controller._tenantManager).toBe(mockTenantManager);
        });

        it('should initialize with default values when options omitted', () => {
            const minimalController = new StatsController();
            expect(minimalController).toBeInstanceOf(StatsController);
        });
    });

    describe('handleStats', () => {
        it('should return 200 with correct headers', () => {
            const mockReq = { url: '/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStats(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, {
                'content-type': 'application/json',
                'cache-control': 'no-store',
                'pragma': 'no-cache',
                'expires': '0'
            });
        });

        it('should include all required stats fields', () => {
            const mockReq = { url: '/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStats(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('requests');
            expect(responseData).toHaveProperty('tokens');
            expect(responseData).toHaveProperty('keys');
            expect(responseData).toHaveProperty('latency');
            expect(responseData).toHaveProperty('successRate');
        });

        it('should include backpressure stats', () => {
            const mockReq = { url: '/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStats(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.backpressure).toBeDefined();
            expect(responseData.backpressure.current).toBe(5);
        });

        it('should include request payload store stats', () => {
            const mockReq = { url: '/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStats(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.requestPayloadStore).toBeDefined();
            expect(responseData.requestPayloadStore.size).toBe(3);
            expect(responseData.requestPayloadStore.hits).toBe(4);
            expect(responseData.requestPayloadStore.evictedByTtl).toBe(3);
        });

        it('should include paused state', () => {
            controller._isPaused = true;

            const mockReq = { url: '/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStats(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.paused).toBe(true);
        });

        it('should default paused to false', () => {
            const mockReq = { url: '/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStats(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.paused).toBe(false);
        });

        it('should include pool cooldown stats', () => {
            const mockReq = { url: '/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStats(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.poolCooldown).toBeDefined();
            expect(responseData.poolCooldown.policy).toBeDefined();
            expect(responseData.poolCooldown.policy.sleepThresholdMs).toBe(250);
        });

        it('should include rate limit tracking stats', () => {
            const mockReq = { url: '/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStats(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.rateLimitTracking).toBeDefined();
            expect(responseData.rateLimitTracking.llm429Retries).toBe(100);
        });

        it('should include cluster mode info', () => {
            const mockReq = { url: '/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStats(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.clusterMode).toBeDefined();
            expect(responseData.clusterMode.enabled).toBeDefined();
            expect(responseData.clusterMode.workerId).toBeDefined();
        });

        it('should include giveUpTracking and retryEfficiency in JSON stats', () => {
            const mockReq = { url: '/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStats(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.giveUpTracking).toBeDefined();
            expect(responseData.giveUpTracking.total).toBe(7);
            expect(responseData.retryEfficiency).toBeDefined();
            expect(responseData.retryEfficiency.sameModelRetries).toBe(12);
            expect(responseData.retryBackoff).toBeDefined();
            expect(responseData.retryBackoff.totalDelayMs).toBe(5000);
        });

        it('should return empty stats when statsAggregator is null (lines 55-65)', () => {
            const controllerNoAgg = new StatsController({
                keyManager: mockKeyManager,
                requestHandler: mockRequestHandler,
                getUptime: mockGetUptime,
                config: mockConfig
            });

            const mockReq = { url: '/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controllerNoAgg.handleStats(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.backpressure).toBeDefined();
            expect(responseData.paused).toBeDefined();
            expect(responseData.poolCooldown).toBeDefined();
            // But no request/tokens stats since aggregator is null
            expect(responseData.requests).toBeUndefined();
        });

        it('should not include rateLimitTracking when empty (lines 88-90)', () => {
            mockStatsAggregator.getRateLimitTrackingStats.mockReturnValue({});

            const mockReq = { url: '/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStats(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.rateLimitTracking).toBeUndefined();
        });

        it('should include pool429Penalty when modelRouter has getPool429PenaltyStats (lines 93-95)', () => {
            mockModelRouter.getPool429PenaltyStats = jest.fn(() => ({
                'glm-4-plus': { score: 50, sampleCount: 100 }
            }));

            const mockReq = { url: '/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStats(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.pool429Penalty).toBeDefined();
            expect(responseData.pool429Penalty['glm-4-plus']).toBeDefined();
        });

        it('should include clusterMode warning when in worker (lines 106-108)', () => {
            // Mock cluster module to simulate worker mode
            const cluster = require('cluster');
            const originalWorker = cluster.worker;
            try {
                cluster.worker = { id: 1 };

                const mockReq = { url: '/stats', headers: { host: 'localhost' } };
                const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

                controller.handleStats(mockReq, mockRes);

                const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
                expect(responseData.clusterMode.workerId).toBe(1);
                expect(responseData.clusterMode.warning).toContain('CLUSTER MODE');
                expect(responseData.clusterMode.warning).toContain('PER-WORKER');
            } finally {
                cluster.worker = originalWorker;
            }
        });
    });

    describe('handleMetrics', () => {
        it('should return 200 with text/plain content-type', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, {
                'content-type': 'text/plain; version=0.0.4; charset=utf-8'
            });
        });

        it('should return Prometheus format with HELP and TYPE', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('# HELP glm_proxy_info');
            expect(responseText).toContain('# TYPE glm_proxy_info');
        });

        it('should include uptime metric', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_uptime_seconds 3600');
        });

        it('should include request counters', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_requests_total{status="success"} 950');
            expect(responseText).toContain('glm_proxy_requests_total{status="failed"} 50');
        });

        it('should include in-flight requests', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_requests_in_flight 10');
        });

        it('should include success rate', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_success_rate 95');
        });

        it('should include latency metrics', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_latency_milliseconds{quantile="0.5"} 100');
            expect(responseText).toContain('glm_proxy_latency_milliseconds{quantile="0.95"} 200');
            expect(responseText).toContain('glm_proxy_latency_milliseconds{quantile="0.99"} 300');
        });

        it('should include retry metrics', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_retries_total 100');
            expect(responseText).toContain('glm_proxy_retries_succeeded_total 90');
        });

        it('should include rate limit metrics', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_rate_limit_total{source="upstream"} 50');
            expect(responseText).toContain('glm_proxy_rate_limit_total{source="local"} 20');
        });

        it('should include admission hold metrics', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_admission_hold_total');
            expect(responseText).toContain('glm_proxy_admission_hold_succeeded_total');
            expect(responseText).toContain('glm_proxy_admission_hold_timed_out_total');
            expect(responseText).toContain('glm_proxy_admission_hold_rejected_total');
            expect(responseText).toContain('glm_proxy_admission_hold_ms_sum');
        });

        it('should include pool cooldown metrics', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_pool_cooldowns_total 5');
        });

        it('should include key health metrics', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_keys_total 2');
            expect(responseText).toContain('glm_proxy_keys_healthy 1');
        });

        it('should include token metrics', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_tokens_total{type="input"} 50000');
            expect(responseText).toContain('glm_proxy_tokens_total{type="output"} 30000');
        });

        it('should include cost estimate', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_cost_total');
        });

        it('should include error metrics', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_errors_total{type="timeout"} 5');
            expect(responseText).toContain('glm_proxy_errors_total{type="socket_hangup"} 3');
        });

        it('should include queue metrics', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_queue_size 5');
            expect(responseText).toContain('glm_proxy_queue_max 50');
        });

        it('should include paused metric', () => {
            controller._isPaused = true;

            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_paused 1');
        });

        it('should include tenant metrics when tenantManager exists', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_tenant_info{tenant="tenant1"');
            expect(responseText).toContain('glm_proxy_tenant_requests_total{tenant="tenant1"} 600');
        });

        it('should include model routing metrics when modelRouter exists', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_model_routing_enabled 1');
            expect(responseText).toContain('glm_proxy_model_routing_decisions_total{tier="premium",source="all"} 300');
            expect(responseText).toContain('glm_proxy_model_routing_cooldowns_active 2');
        });

        it('should include byStrategy Prometheus gauge', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_routing_by_strategy{strategy="quality"} 150');
            expect(responseText).toContain('glm_proxy_routing_by_strategy{strategy="throughput"} 200');
            expect(responseText).toContain('glm_proxy_routing_by_strategy{strategy="balanced"} 100');
            expect(responseText).toContain('glm_proxy_routing_by_strategy{strategy="pool"} 50');
        });

        it('should include give-up metrics', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_give_up_total 7');
            expect(responseText).toContain('glm_proxy_give_up_by_reason_total{reason="max_429_attempts"} 4');
            expect(responseText).toContain('glm_proxy_give_up_by_reason_total{reason="max_429_window"} 3');
        });

        it('should include retry efficiency metrics', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_same_model_retries_total 12');
            expect(responseText).toContain('glm_proxy_models_tried_on_failure_total 25');
            expect(responseText).toContain('glm_proxy_model_switches_on_failure_total 8');
            expect(responseText).toContain('glm_proxy_failed_requests_with_model_stats_total 15');
        });

        it('should include tier downgrade metrics with route labels', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_tier_downgrade_total 5');
            expect(responseText).toContain('glm_proxy_tier_downgrade_shadow_total 12');
            expect(responseText).toContain('glm_proxy_tier_downgrade_by_route_total{from="heavy",to="medium"} 3');
            expect(responseText).toContain('glm_proxy_tier_downgrade_shadow_by_route_total{from="heavy",to="light"} 4');
        });

        it('should include context overflow metrics with tier and model labels', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_context_overflow_total 7');
            expect(responseText).toContain('glm_proxy_context_overflow_by_tier_total{tier="heavy"} 5');
            expect(responseText).toContain('glm_proxy_context_overflow_by_tier_total{tier="light"} 2');
            expect(responseText).toContain('glm_proxy_context_overflow_by_model_total{model="glm-4-flash"} 4');
            expect(responseText).toContain('glm_proxy_context_overflow_by_model_total{model="glm-4-air"} 3');
        });

        it('should include corrected retry_attempts_total alongside deprecated retries_total', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            // Deprecated metric still present (backward compat)
            expect(responseText).toContain('glm_proxy_retries_total 100');
            // New correct metric for total retries
            expect(responseText).toContain('glm_proxy_retry_attempts_total 42');
        });

        it('should include retry backoff metrics', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_retry_backoff_ms_sum 5000');
            expect(responseText).toContain('glm_proxy_retry_backoff_count 20');
        });
    });

    describe('handlePersistentStats', () => {
        it('should return 200 with stats response', () => {
            const mockReq = { url: '/persistent-stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handlePersistentStats(mockReq, mockRes);

            expect(mockStatsAggregator.getPersistentStatsResponse).toHaveBeenCalledWith(['sk-test1', 'sk-test2']);
            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
        });

        it('should include response from aggregator', () => {
            const mockReq = { url: '/persistent-stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handlePersistentStats(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.persistent).toBe(true);
        });

        it('should use raw key when keyManager has no getKeyId method', () => {
            // Controller without keyManager.getKeyId (current mock doesn't have it)
            const mockReq = { url: '/persistent-stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handlePersistentStats(mockReq, mockRes);

            // Should use raw keys from config since getKeyId is not available
            expect(mockStatsAggregator.getPersistentStatsResponse).toHaveBeenCalledWith(['sk-test1', 'sk-test2']);
        });

        it('should use getKeyId when keyManager has the method', () => {
            // Create controller with keyManager that has getKeyId
            const keyManagerWithGetKeyId = {
                getPoolRateLimitStats: jest.fn(() => ({ inCooldown: false, sleepCount: 0 })),
                getKeyId: jest.fn((key) => `key-id-${key.substring(0, 4)}`)
            };

            const controllerWithGetKeyId = new StatsController({
                statsAggregator: mockStatsAggregator,
                keyManager: keyManagerWithGetKeyId,
                requestHandler: mockRequestHandler,
                tenantManager: mockTenantManager,
                costTracker: mockCostTracker,
                modelRouter: mockModelRouter,
                getUptime: mockGetUptime,
                reloadKeys: mockReloadKeys,
                config: mockConfig
            });

            const mockReq = { url: '/persistent-stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controllerWithGetKeyId.handlePersistentStats(mockReq, mockRes);

            // Should use getKeyId to transform keys
            expect(mockStatsAggregator.getPersistentStatsResponse).toHaveBeenCalledWith(['key-id-sk-t', 'key-id-sk-t']);
        });

        it('should handle missing keyManager gracefully', () => {
            const controllerNoKeyManager = new StatsController({
                statsAggregator: mockStatsAggregator,
                keyManager: null,
                requestHandler: mockRequestHandler,
                tenantManager: mockTenantManager,
                costTracker: mockCostTracker,
                modelRouter: mockModelRouter,
                getUptime: mockGetUptime,
                reloadKeys: mockReloadKeys,
                config: mockConfig
            });

            const mockReq = { url: '/persistent-stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            expect(() => controllerNoKeyManager.handlePersistentStats(mockReq, mockRes)).not.toThrow();
            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
        });
    });

    describe('handleReload', () => {
        it('should return 405 for GET request', () => {
            const mockReq = { method: 'GET', url: '/reload', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleReload(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(405, { 'content-type': 'application/json' });
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toContain('Method not allowed');
        });

        it('should return success on POST when reloadKeys succeeds', () => {
            const mockReq = { method: 'POST', url: '/reload', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleReload(mockReq, mockRes);

            expect(mockReloadKeys).toHaveBeenCalled();
            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.success).toBe(true);
            expect(responseData.reloaded).toBe(5);
        });

        it('should return 500 when reloadKeys returns null', () => {
            mockReloadKeys.mockReturnValue(null);

            const mockReq = { method: 'POST', url: '/reload', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleReload(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(500, { 'content-type': 'application/json' });
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.success).toBe(false);
            expect(responseData.error).toContain('Failed to reload');
        });
    });

    describe('handleBackpressure', () => {
        it('should return backpressure stats', () => {
            const mockReq = { url: '/backpressure', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleBackpressure(mockReq, mockRes);

            expect(mockRequestHandler.getBackpressureStats).toHaveBeenCalled();
            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
        });

        it('should include backpressure data in response', () => {
            const mockReq = { url: '/backpressure', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleBackpressure(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.current).toBe(5);
            expect(responseData.max).toBe(100);
        });
    });

    describe('handleStatsTenants', () => {
        it('should return enabled=false when tenantManager is null', () => {
            controller._tenantManager = null;

            const mockReq = { url: '/stats/tenants', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStatsTenants(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.enabled).toBe(false);
            expect(responseData.message).toContain('not enabled');
        });

        it('should call getAllTenantStats', () => {
            const mockReq = { url: '/stats/tenants', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStatsTenants(mockReq, mockRes);

            expect(mockTenantManager.getAllTenantStats).toHaveBeenCalled();
        });

        it('should include tenant data in response', () => {
            const mockReq = { url: '/stats/tenants', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStatsTenants(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.enabled).toBe(true);
            expect(responseData.tenants).toBeDefined();
            expect(responseData.tenants.tenant1).toBeDefined();
        });

        it('should include cost data when costTracker exists', () => {
            const mockReq = { url: '/stats/tenants', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStatsTenants(mockReq, mockRes);

            expect(mockCostTracker.getAllTenantCosts).toHaveBeenCalled();
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.tenants.tenant1.costs).toBeDefined();
            expect(responseData.tenants.tenant1.costs.totalCost).toBe(1.50);
        });

        it('should include summary with breakdown', () => {
            const mockReq = { url: '/stats/tenants', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStatsTenants(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.summary).toBeDefined();
            expect(responseData.summary.totalTenants).toBe(2);
            expect(responseData.summary.totalRequests).toBe(1000);
            expect(responseData.summary.unknownTenantRequests).toBe(10);
        });

        it('should include error rate in breakdown', () => {
            const mockReq = { url: '/stats/tenants', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStatsTenants(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            const tenant1Breakdown = responseData.summary.tenantBreakdown.find(t => t.tenantId === 'tenant1');
            expect(tenant1Breakdown.errorRate).toBe(3.33); // 20/600 * 100
        });

        it('should sort breakdown by request count descending', () => {
            const mockReq = { url: '/stats/tenants', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStatsTenants(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            const breakdown = responseData.summary.tenantBreakdown;
            expect(breakdown[0].tenantId).toBe('tenant1'); // 600 requests
            expect(breakdown[1].tenantId).toBe('tenant2'); // 390 requests
        });

        it('should include timestamp in response', () => {
            const mockReq = { url: '/stats/tenants', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStatsTenants(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.timestamp).toBeDefined();
        });
    });

    describe('interface contract', () => {
        it('should have handleStats method', () => {
            expect(typeof controller.handleStats).toBe('function');
        });

        it('should have handleMetrics method', () => {
            expect(typeof controller.handleMetrics).toBe('function');
        });

        it('should have handlePersistentStats method', () => {
            expect(typeof controller.handlePersistentStats).toBe('function');
        });

        it('should have handleReload method', () => {
            expect(typeof controller.handleReload).toBe('function');
        });

        it('should have handleBackpressure method', () => {
            expect(typeof controller.handleBackpressure).toBe('function');
        });

        it('should have handleStatsTenants method', () => {
            expect(typeof controller.handleStatsTenants).toBe('function');
        });
    });

    describe('edge cases', () => {
        it('should handle missing tenantManager gracefully in metrics', () => {
            controller._tenantManager = null;

            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).not.toContain('glm_proxy_tenant_');
        });

        it('should handle missing modelRouter gracefully in metrics', () => {
            controller._modelRouter = null;

            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).not.toContain('glm_proxy_model_routing_');
        });

        it('should handle missing costTracker gracefully in statsTenants', () => {
            controller._costTracker = null;

            const mockReq = { url: '/stats/tenants', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStatsTenants(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.tenants.tenant1.costs).toBeUndefined();
        });

        it('should handle missing rateLimitTracking gracefully in stats', () => {
            mockStatsAggregator.getRateLimitTrackingStats.mockReturnValue({});

            const mockReq = { url: '/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStats(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.rateLimitTracking).toBeUndefined();
        });

        it('should handle missing poolStats gracefully in stats', () => {
            mockKeyManager.getPoolRateLimitStats.mockReturnValue(null);

            const mockReq = { url: '/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStats(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.poolCooldown).toBeDefined();
        });
    });

    describe('pool 429 penalty in /stats and /metrics', () => {
        it('handleStats includes pool429Penalty from modelRouter', () => {
            mockModelRouter.getPool429PenaltyStats = jest.fn().mockReturnValue({
                enabled: true,
                windowMs: 120000,
                trackedModels: 2,
                byModel: {
                    'glm-4-plus': { hits: 8, lastSeenMs: 50, decayEtaMs: 30000 },
                    'glm-4.5-air': { hits: 2, lastSeenMs: 100, decayEtaMs: 60000 }
                }
            });

            const mockReq = { url: '/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStats(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.pool429Penalty).toBeDefined();
            expect(responseData.pool429Penalty.enabled).toBe(true);
            expect(responseData.pool429Penalty.byModel['glm-4-plus'].hits).toBe(8);
            expect(responseData.pool429Penalty.byModel['glm-4.5-air'].hits).toBe(2);
        });

        it('handleStats omits pool429Penalty when modelRouter has no method', () => {
            // Simulate older modelRouter without getPool429PenaltyStats
            delete mockModelRouter.getPool429PenaltyStats;

            const mockReq = { url: '/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStats(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.pool429Penalty).toBeUndefined();
        });

        it('handleMetrics includes glm_proxy_pool_429_penalty_hits gauge', () => {
            mockModelRouter.getPool429PenaltyStats = jest.fn().mockReturnValue({
                enabled: true,
                windowMs: 120000,
                trackedModels: 1,
                byModel: { 'glm-4-plus': { hits: 5, lastSeenMs: 50, decayEtaMs: 30000 } }
            });

            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const metricsOutput = mockRes.end.mock.calls[0][0];
            expect(metricsOutput).toContain('# HELP glm_proxy_pool_429_penalty_hits');
            expect(metricsOutput).toContain('# TYPE glm_proxy_pool_429_penalty_hits gauge');
            expect(metricsOutput).toContain('glm_proxy_pool_429_penalty_hits{model="glm-4-plus"} 5');
            // Aggregate gauges
            expect(metricsOutput).toContain('glm_proxy_pool_429_penalty_tracked_models 1');
            expect(metricsOutput).toContain('glm_proxy_pool_429_penalty_max_hits 5');
        });

        it('handleMetrics pool 429 max_hits picks highest across models', () => {
            mockModelRouter.getPool429PenaltyStats = jest.fn().mockReturnValue({
                enabled: true,
                windowMs: 120000,
                trackedModels: 2,
                byModel: {
                    'glm-4-plus': { hits: 3, lastSeenMs: 50, decayEtaMs: 30000 },
                    'glm-4.5-air': { hits: 8, lastSeenMs: 100, decayEtaMs: 20000 }
                }
            });

            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const metricsOutput = mockRes.end.mock.calls[0][0];
            expect(metricsOutput).toContain('glm_proxy_pool_429_penalty_tracked_models 2');
            expect(metricsOutput).toContain('glm_proxy_pool_429_penalty_max_hits 8');
        });

        it('handleMetrics omits per-model penalty gauge when no penalty data', () => {
            // No getPool429PenaltyStats on router
            delete mockModelRouter.getPool429PenaltyStats;

            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const metricsOutput = mockRes.end.mock.calls[0][0];
            // Per-model hits not present when no data
            expect(metricsOutput).not.toContain('pool_429_penalty_hits{model=');
            // Aggregate gauges still present with zero values
            expect(metricsOutput).toContain('glm_proxy_pool_429_penalty_tracked_models 0');
            expect(metricsOutput).toContain('glm_proxy_pool_429_penalty_max_hits 0');
        });

        it('handleMetrics includes request payload store gauges/counters', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const metricsOutput = mockRes.end.mock.calls[0][0];
            expect(metricsOutput).toContain('glm_proxy_request_payload_store_size 3');
            expect(metricsOutput).toContain('glm_proxy_request_payload_store_hits_total 4');
            expect(metricsOutput).toContain('glm_proxy_request_payload_store_misses_total 1');
            expect(metricsOutput).toContain('glm_proxy_request_payload_store_evicted_ttl_total 3');
            expect(metricsOutput).toContain('glm_proxy_request_payload_store_evicted_size_total 2');
        });
    });

    describe('Wave 0 baseline contracts', () => {
        it('handleMetrics emits deterministic glm_proxy_cost_total from token counters', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const metricsOutput = mockRes.end.mock.calls[0][0];
            expect(metricsOutput).toContain('glm_proxy_cost_total 0.600000');
            expect(metricsOutput).toMatch(/glm_proxy_cost_total\s+\d+\.\d{6}/);
        });

        it('handleMetrics keeps HELP/TYPE + metric line contract for glm_proxy_cost_total', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const metricsOutput = mockRes.end.mock.calls[0][0];
            const helpIndex = metricsOutput.indexOf('# HELP glm_proxy_cost_total Estimated total cost in USD');
            const typeIndex = metricsOutput.indexOf('# TYPE glm_proxy_cost_total counter');
            const valueIndex = metricsOutput.indexOf('glm_proxy_cost_total 0.600000');

            expect(helpIndex).toBeGreaterThanOrEqual(0);
            expect(typeIndex).toBeGreaterThan(helpIndex);
            expect(valueIndex).toBeGreaterThan(typeIndex);
        });
    });

    describe('GLM5-07 staged rollout metrics', () => {
        it('handleMetrics emits glm_proxy_glm5_eligible_total counter', () => {
            mockModelRouter.getStats = jest.fn(() => ({
                total: 100,
                byTier: { 'heavy': 60, 'medium': 30, 'light': 10 },
                bySource: { 'direct': 80, 'failover': 20 },
                byStrategy: { 'balanced': 100 },
                tierDowngradeTotal: 2,
                tierDowngradeShadow: 1,
                tierDowngradeByRoute: {},
                tierDowngradeShadowByRoute: {},
                byUpgradeReason: { 'complexity': 5 },
                byModel: { 'glm-4-plus': 30, 'glm-4': 20 },
                byFallbackReason: { 'unavailable': 2 },
                glm5EligibleTotal: 42,
                glm5PreferenceApplied: 15,
                glm5PreferenceShadow: 27,
                heavyModels: ['glm-4-plus', 'glm-4']
            }));

            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const metricsOutput = mockRes.end.mock.calls[0][0];
            expect(metricsOutput).toContain('# HELP glm_proxy_glm5_eligible_total Heavy requests eligible for GLM-5 preference');
            expect(metricsOutput).toContain('# TYPE glm_proxy_glm5_eligible_total counter');
            expect(metricsOutput).toContain('glm_proxy_glm5_eligible_total 42');
        });

        it('handleMetrics emits glm_proxy_glm5_preference_applied_total counter', () => {
            mockModelRouter.getStats = jest.fn(() => ({
                total: 100,
                byTier: { 'heavy': 60, 'medium': 30, 'light': 10 },
                bySource: { 'direct': 80, 'failover': 20 },
                byStrategy: { 'balanced': 100 },
                tierDowngradeTotal: 2,
                tierDowngradeShadow: 1,
                tierDowngradeByRoute: {},
                tierDowngradeShadowByRoute: {},
                byUpgradeReason: { 'complexity': 5 },
                byModel: { 'glm-4-plus': 30, 'glm-4': 20 },
                byFallbackReason: { 'unavailable': 2 },
                glm5EligibleTotal: 42,
                glm5PreferenceApplied: 15,
                glm5PreferenceShadow: 27,
                heavyModels: ['glm-4-plus', 'glm-4']
            }));

            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const metricsOutput = mockRes.end.mock.calls[0][0];
            expect(metricsOutput).toContain('# HELP glm_proxy_glm5_preference_applied_total Requests where GLM-5 preference was actively applied');
            expect(metricsOutput).toContain('# TYPE glm_proxy_glm5_preference_applied_total counter');
            expect(metricsOutput).toContain('glm_proxy_glm5_preference_applied_total 15');
        });

        it('handleMetrics emits glm_proxy_glm5_preference_shadow_total counter', () => {
            mockModelRouter.getStats = jest.fn(() => ({
                total: 100,
                byTier: { 'heavy': 60, 'medium': 30, 'light': 10 },
                bySource: { 'direct': 80, 'failover': 20 },
                byStrategy: { 'balanced': 100 },
                tierDowngradeTotal: 2,
                tierDowngradeShadow: 1,
                tierDowngradeByRoute: {},
                tierDowngradeShadowByRoute: {},
                byUpgradeReason: { 'complexity': 5 },
                byModel: { 'glm-4-plus': 30, 'glm-4': 20 },
                byFallbackReason: { 'unavailable': 2 },
                glm5EligibleTotal: 42,
                glm5PreferenceApplied: 15,
                glm5PreferenceShadow: 27,
                heavyModels: ['glm-4-plus', 'glm-4']
            }));

            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const metricsOutput = mockRes.end.mock.calls[0][0];
            expect(metricsOutput).toContain('# HELP glm_proxy_glm5_preference_shadow_total Requests where GLM-5 would have been preferred (shadow mode)');
            expect(metricsOutput).toContain('# TYPE glm_proxy_glm5_preference_shadow_total counter');
            expect(metricsOutput).toContain('glm_proxy_glm5_preference_shadow_total 27');
        });

        it('handleMetrics emits zero values when GLM5 stats are not set', () => {
            mockModelRouter.getStats = jest.fn(() => ({
                total: 10,
                byTier: { 'heavy': 5, 'medium': 3, 'light': 2 },
                bySource: { 'direct': 8, 'failover': 2 },
                byStrategy: { 'balanced': 10 },
                tierDowngradeTotal: 0,
                tierDowngradeShadow: 0,
                tierDowngradeByRoute: {},
                tierDowngradeShadowByRoute: {},
                byUpgradeReason: {},
                byModel: {},
                byFallbackReason: {},
                // No GLM5 stats - should default to 0
                heavyModels: []
            }));

            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const metricsOutput = mockRes.end.mock.calls[0][0];
            // Should still emit with 0 values due to || 0 fallback
            expect(metricsOutput).toContain('glm_proxy_glm5_eligible_total 0');
            expect(metricsOutput).toContain('glm_proxy_glm5_preference_applied_total 0');
            expect(metricsOutput).toContain('glm_proxy_glm5_preference_shadow_total 0');
        });
    });

    describe('handleStats edge cases for coverage', () => {
        it('uses default pool cooldown values when config.poolCooldown is undefined (lines 69-81)', () => {
            const controllerNoPoolConfig = new StatsController({
                statsAggregator: mockStatsAggregator,
                keyManager: mockKeyManager,
                requestHandler: mockRequestHandler,
                config: {} // No poolCooldown config
            });

            const mockReq = { url: '/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controllerNoPoolConfig.handleStats(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.poolCooldown).toBeDefined();
            expect(responseData.poolCooldown.policy.sleepThresholdMs).toBe(250);
            expect(responseData.poolCooldown.policy.retryJitterMs).toBe(200);
            expect(responseData.poolCooldown.policy.maxCooldownMs).toBe(5000);
            expect(responseData.poolCooldown.policy.baseMs).toBe(500);
            expect(responseData.poolCooldown.policy.capMs).toBe(5000);
            expect(responseData.poolCooldown.policy.decayMs).toBe(10000);
        });

        it('includes tenant costs when cost tracker is available (lines 570-576)', () => {
            mockTenantManager.getAllTenantStats = jest.fn(() => ({
                enabled: true,
                tenantCount: 1,
                globalStats: { totalRequests: 100, unknownTenantRequests: 0 },
                tenants: {
                    'tenant1': {
                        tenantId: 'tenant1',
                        keyCount: 2,
                        requestCount: 50,
                        errorCount: 1,
                        lastUsed: Date.now()
                    }
                }
            }));

            mockCostTracker.getAllTenantCosts = jest.fn(() => ({
                'tenant1': { totalCost: 0.50, inputCost: 0.30, outputCost: 0.20 }
            }));

            const mockReq = { url: '/stats/tenants', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStatsTenants(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.summary.tenantBreakdown[0].totalCost).toBe(0.50);
            expect(responseData.tenants['tenant1'].costs).toBeDefined();
        });

        it('returns errorRate of 0 when tenant has zero requests (line 594 ternary)', () => {
            mockTenantManager.getAllTenantStats = jest.fn(() => ({
                enabled: true,
                tenantCount: 1,
                globalStats: { totalRequests: 0, unknownTenantRequests: 0 },
                tenants: {
                    'tenant1': {
                        tenantId: 'tenant1',
                        keyCount: 2,
                        requestCount: 0,  // Zero requests
                        errorCount: 0,
                        lastUsed: null
                    }
                }
            }));

            const mockReq = { url: '/stats/tenants', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStatsTenants(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.summary.tenantBreakdown[0].errorRate).toBe(0);
        });

        it('emits Prometheus metrics for rate limit tracking with actual data (lines 208-226)', () => {
            mockStatsAggregator.getRateLimitTrackingStats = jest.fn(() => ({
                llm429RetrySuccesses: 42,
                upstream429s: 10,
                local429s: 5,
                poolCooldowns: 2
            }));

            mockKeyManager.getPoolRateLimitStats = jest.fn(() => ({
                inCooldown: true,
                sleepCount: 1
            }));

            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const metricsOutput = mockRes.end.mock.calls[0][0];
            expect(metricsOutput).toContain('glm_proxy_retries_succeeded_total 42');
            expect(metricsOutput).toContain('glm_proxy_rate_limit_total{source="upstream"} 10');
            expect(metricsOutput).toContain('glm_proxy_rate_limit_total{source="local"} 5');
            expect(metricsOutput).toContain('glm_proxy_pool_cooldowns_total 2');
            expect(metricsOutput).toContain('glm_proxy_pool_in_cooldown 1'); // inCooldown is true
        });
    });
});
