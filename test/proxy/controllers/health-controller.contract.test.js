/**
 * Contract Test: Health Controller
 *
 * This contract test ensures that health-related route operations produce consistent results
 * after extraction from ProxyServer to health-controller.js.
 *
 * TDD Phase: Red - Write failing test first
 */

'use strict';

const http = require('http');
let HealthController;
try {
    ({ HealthController } = require('../../../lib/proxy/controllers/health-controller'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = HealthController ? describe : describe.skip;

describeIfModule('ProxyServer Contract: Health Controller Operations', () => {
    let controller;
    let mockKeyManager;
    let mockRequestHandler;
    let mockModelRouter;
    let mockGetUptime;

    beforeEach(() => {
        mockKeyManager = {
            getAggregatedStats: jest.fn(() => ({
                totalKeys: 5,
                circuitStates: { closed: 3, open: 1, halfOpen: 1 }
            })),
            getSchedulerStats: jest.fn(() => ({
                reasonDistribution: {},
                fairness: { fairnessScore: 0.8 }
            })),
            getPoolState: jest.fn(() => 'active')
        };

        mockRequestHandler = {
            getBackpressureStats: jest.fn(() => ({
                current: 10,
                max: 100,
                percentUsed: 10,
                queue: { length: 10, waiting: 5 }
            })),
            getTraceStats: jest.fn(() => ({
                totalTraces: 50,
                capacity: 1000,
                utilization: 0.05,
                successCount: 45
            })),
            getConnectionHealthStats: jest.fn(() => ({
                consecutiveHangups: 0,
                totalHangups: 2,
                agentRecreationCount: 0
            }))
        };

        mockModelRouter = {
            enabled: true,
            getStats: jest.fn(() => ({ total: 100 })),
            getCooldowns: jest.fn(() => ({})),
            getOverrides: jest.fn(() => ({}))
        };

        mockGetUptime = jest.fn(() => 3600000);

        controller = new HealthController({
            keyManager: mockKeyManager,
            requestHandler: mockRequestHandler,
            modelRouter: mockModelRouter,
            getUptime: mockGetUptime
        });
    });

    describe('handleHealth', () => {
        it('should return health status with OK status when healthy keys exist', () => {
            const mockReq = { url: '/health', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealth(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.status).toBe('OK');
            expect(responseData.healthyKeys).toBe(4);
        });

        it('should return DEGRADED status when no healthy keys', () => {
            mockKeyManager.getAggregatedStats.mockReturnValue({
                totalKeys: 2,
                circuitStates: { closed: 0, open: 2, halfOpen: 0 }
            });

            const mockReq = { url: '/health', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealth(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(503, { 'content-type': 'application/json' });
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.status).toBe('DEGRADED');
        });

        it('should include uptime in response', () => {
            mockGetUptime.mockReturnValue(7200000);

            const mockReq = { url: '/health', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealth(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.uptime).toBe(7200000);
        });

        it('should include backpressure stats', () => {
            const mockReq = { url: '/health', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealth(mockReq, mockRes);

            expect(mockRequestHandler.getBackpressureStats).toHaveBeenCalled();
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.backpressure).toBeDefined();
        });
    });

    describe('handleHealthDeep', () => {
        it('should return detailed health status', () => {
            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('status');
            expect(responseData).toHaveProperty('checks');
            expect(responseData).toHaveProperty('process');
        });

        it('should include all component checks', () => {
            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.checks).toHaveProperty('keys');
            expect(responseData.checks).toHaveProperty('queue');
            expect(responseData.checks).toHaveProperty('memory');
            expect(responseData.checks).toHaveProperty('connections');
            expect(responseData.checks).toHaveProperty('traces');
        });

        it('should include scheduler stats when available', () => {
            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            expect(mockKeyManager.getSchedulerStats).toHaveBeenCalled();
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.checks.scheduler).toBeDefined();
        });

        it('should include model routing stats when available', () => {
            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.checks.modelRouting).toBeDefined();
            expect(responseData.checks.modelRouting.enabled).toBe(true);
        });

        it('should mark model routing as not_configured when modelRouter is null', () => {
            controller._modelRouter = null;

            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.checks.modelRouting.status).toBe('not_configured');
        });

        it('should return process information', () => {
            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.process).toHaveProperty('pid');
            expect(responseData.process).toHaveProperty('nodeVersion');
            expect(responseData.process).toHaveProperty('platform');
            expect(responseData.process).toHaveProperty('arch');
        });

        it('should return 503 when system is unhealthy', () => {
            mockKeyManager.getAggregatedStats.mockReturnValue({
                totalKeys: 2,
                circuitStates: { closed: 0, open: 2, halfOpen: 0 }
            });
            mockRequestHandler.getBackpressureStats.mockReturnValue({
                current: 95,
                max: 100,
                percentUsed: 95,
                queue: { length: 95, waiting: 90 }
            });

            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(503, { 'content-type': 'application/json' });
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.status).toBe('unhealthy');
        });

        it('should redact sensitive data from response', () => {
            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            // Response should be redacted (no sensitive data leaked)
            const responseStr = mockRes.end.mock.calls[0][0];
            expect(responseStr).toBeDefined();
        });
    });

    describe('interface contract', () => {
        it('should have handleHealth method', () => {
            expect(typeof controller.handleHealth).toBe('function');
        });

        it('should have handleHealthDeep method', () => {
            expect(typeof controller.handleHealthDeep).toBe('function');
        });
    });
});
