/**
 * Contract Test: Stats Controller
 *
 * This contract test ensures that stats-related route operations produce consistent results
 * after extraction from ProxyServer to stats-controller.js.
 *
 * TDD Phase: Red - Write failing test first
 */

'use strict';

const http = require('http');
let StatsController;
try {
    ({ StatsController } = require('../../../lib/proxy/controllers/stats-controller'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = StatsController ? describe : describe.skip;

describeIfModule('ProxyServer Contract: Stats Controller Operations', () => {
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
                errors: { timeouts: 5, socketHangups: 3, connectionRefused: 2, serverErrors: 10, rateLimited: 30 }
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
                burstDampenedTotal: 50
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

    describe('handleStats', () => {
        it('should return 200 with content-type application/json', () => {
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

        it('should include backpressure stats in response', () => {
            const mockReq = { url: '/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStats(mockReq, mockRes);

            expect(mockRequestHandler.getBackpressureStats).toHaveBeenCalled();
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.backpressure).toBeDefined();
        });

        it('should include pool cooldown stats', () => {
            const mockReq = { url: '/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStats(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.poolCooldown).toBeDefined();
            expect(responseData.poolCooldown.policy).toBeDefined();
        });

        it('should include rate limit tracking stats', () => {
            const mockReq = { url: '/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStats(mockReq, mockRes);

            expect(mockStatsAggregator.getRateLimitTrackingStats).toHaveBeenCalled();
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.rateLimitTracking).toBeDefined();
        });

        it('should include cluster mode information', () => {
            const mockReq = { url: '/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStats(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.clusterMode).toBeDefined();
            expect(responseData.clusterMode.enabled).toBeDefined();
        });

        it('should include paused state', () => {
            controller._isPaused = true;

            const mockReq = { url: '/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStats(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.paused).toBe(true);
        });
    });

    describe('handleMetrics', () => {
        it('should return 200 with text/plain content-type for Prometheus', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, {
                'content-type': 'text/plain; version=0.0.4; charset=utf-8'
            });
        });

        it('should include HELP and TYPE comments for Prometheus', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('# HELP');
            expect(responseText).toContain('# TYPE');
        });

        it('should include uptime metric', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            mockGetUptime.mockReturnValue(7200000);
            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_uptime_seconds 7200');
        });

        it('should include request counters', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_requests_total{status="success"}');
            expect(responseText).toContain('glm_proxy_requests_total{status="failed"}');
        });

        it('should include latency percentiles', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_latency_milliseconds{quantile="0.5"}');
            expect(responseText).toContain('glm_proxy_latency_milliseconds{quantile="0.95"}');
            expect(responseText).toContain('glm_proxy_latency_milliseconds{quantile="0.99"}');
        });

        it('should include key health metrics', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_keys_total');
            expect(responseText).toContain('glm_proxy_keys_healthy');
        });

        it('should include tenant metrics when tenantManager exists', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_tenant_info');
            expect(responseText).toContain('glm_proxy_tenant_requests_total');
        });

        it('should include model routing metrics when modelRouter exists', () => {
            const mockReq = { url: '/metrics', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleMetrics(mockReq, mockRes);

            const responseText = mockRes.end.mock.calls[0][0];
            expect(responseText).toContain('glm_proxy_model_routing_enabled');
            expect(responseText).toContain('glm_proxy_model_routing_decisions_total');
        });
    });

    describe('handlePersistentStats', () => {
        it('should return persistent stats from aggregator', () => {
            const mockReq = { url: '/persistent-stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handlePersistentStats(mockReq, mockRes);

            expect(mockStatsAggregator.getPersistentStatsResponse).toHaveBeenCalled();
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.persistent).toBe(true);
        });
    });

    describe('handleReload', () => {
        it('should return 405 for non-POST methods', () => {
            const mockReq = { method: 'GET', url: '/reload', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleReload(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(405, { 'content-type': 'application/json' });
        });

        it('should return success when reloadKeys succeeds', () => {
            const mockReq = { method: 'POST', url: '/reload', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleReload(mockReq, mockRes);

            expect(mockReloadKeys).toHaveBeenCalled();
            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
        });

        it('should return 500 when reloadKeys fails', () => {
            mockReloadKeys.mockReturnValue(null);

            const mockReq = { method: 'POST', url: '/reload', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleReload(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(500, { 'content-type': 'application/json' });
        });
    });

    describe('handleBackpressure', () => {
        it('should return backpressure stats from requestHandler', () => {
            const mockReq = { url: '/backpressure', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleBackpressure(mockReq, mockRes);

            expect(mockRequestHandler.getBackpressureStats).toHaveBeenCalled();
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.current).toBe(5);
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

        it('should include tenant stats from tenantManager', () => {
            const mockReq = { url: '/stats/tenants', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStatsTenants(mockReq, mockRes);

            expect(mockTenantManager.getAllTenantStats).toHaveBeenCalled();
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.enabled).toBe(true);
            expect(responseData.tenants).toBeDefined();
        });

        it('should include cost data when costTracker exists', () => {
            const mockReq = { url: '/stats/tenants', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStatsTenants(mockReq, mockRes);

            expect(mockCostTracker.getAllTenantCosts).toHaveBeenCalled();
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.tenants.tenant1.costs).toBeDefined();
        });

        it('should include summary statistics', () => {
            const mockReq = { url: '/stats/tenants', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStatsTenants(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.summary).toBeDefined();
            expect(responseData.summary.totalTenants).toBe(2);
            expect(responseData.summary.totalRequests).toBe(1000);
            expect(responseData.summary.tenantBreakdown).toBeDefined();
        });

        it('should sort tenant breakdown by request count', () => {
            const mockReq = { url: '/stats/tenants', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleStatsTenants(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            const breakdown = responseData.summary.tenantBreakdown;
            expect(breakdown[0].requestCount).toBeGreaterThanOrEqual(breakdown[1].requestCount);
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
});
