/**
 * Unit Test: Health Controller
 *
 * TDD Phase: Red - Write failing unit test before module exists
 *
 * Tests the HealthController class for proxy-server.js health-related routes.
 */

'use strict';

let HealthController;
try {
    ({ HealthController } = require('../../../lib/proxy/controllers/health-controller'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = HealthController ? describe : describe.skip;

describeIfModule('health-controller', () => {
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
            getCooldowns: jest.fn(() => ({ key1: Date.now() + 60000 })),
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

    describe('constructor', () => {
        it('should create a new HealthController', () => {
            expect(controller).toBeInstanceOf(HealthController);
        });

        it('should initialize with provided dependencies', () => {
            expect(controller._keyManager).toBe(mockKeyManager);
            expect(controller._requestHandler).toBe(mockRequestHandler);
            expect(controller._modelRouter).toBe(mockModelRouter);
        });

        it('should initialize with default values when options omitted', () => {
            const minimalController = new HealthController();
            expect(minimalController).toBeInstanceOf(HealthController);
        });
    });

    describe('handleHealth', () => {
        it('should return 200 when healthy keys exist', () => {
            const mockReq = { url: '/health', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealth(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
        });

        it('should return 503 when no healthy keys', () => {
            mockKeyManager.getAggregatedStats.mockReturnValue({
                totalKeys: 2,
                circuitStates: { closed: 0, open: 2, halfOpen: 0 }
            });

            const mockReq = { url: '/health', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealth(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(503, { 'content-type': 'application/json' });
        });

        it('should include all required fields in response', () => {
            const mockReq = { url: '/health', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealth(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('status');
            expect(responseData).toHaveProperty('healthyKeys');
            expect(responseData).toHaveProperty('totalKeys');
            expect(responseData).toHaveProperty('uptime');
            expect(responseData).toHaveProperty('backpressure');
        });

        it('should calculate healthyKeys correctly', () => {
            const mockReq = { url: '/health', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealth(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.healthyKeys).toBe(4); // 3 closed + 1 halfOpen
        });

        it('should return OK status when healthy', () => {
            const mockReq = { url: '/health', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealth(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.status).toBe('OK');
        });

        it('should return DEGRADED status when unhealthy', () => {
            mockKeyManager.getAggregatedStats.mockReturnValue({
                totalKeys: 2,
                circuitStates: { closed: 0, open: 2, halfOpen: 0 }
            });

            const mockReq = { url: '/health', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealth(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.status).toBe('DEGRADED');
        });

        it('should handle null keyManager gracefully', () => {
            const controllerNoKeyManager = new HealthController({
                keyManager: null,
                requestHandler: mockRequestHandler,
                getUptime: mockGetUptime
            });

            const mockReq = { url: '/health', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controllerNoKeyManager.handleHealth(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(503, { 'content-type': 'application/json' });
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.status).toBe('DEGRADED');
            expect(responseData.totalKeys).toBe(0);
        });

        it('should handle null requestHandler gracefully', () => {
            const controllerNoRequestHandler = new HealthController({
                keyManager: mockKeyManager,
                requestHandler: null,
                getUptime: mockGetUptime
            });

            const mockReq = { url: '/health', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            expect(() => controllerNoRequestHandler.handleHealth(mockReq, mockRes)).not.toThrow();

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.backpressure).toBeDefined();
            expect(responseData.backpressure.current).toBe(0);
        });

        it('should include uptime from getUptime', () => {
            mockGetUptime.mockReturnValue(1234567);

            const mockReq = { url: '/health', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealth(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.uptime).toBe(1234567);
        });
    });

    describe('handleHealthDeep', () => {
        it('should return 200 when system is healthy', () => {
            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
        });

        it('should return 503 when system is unhealthy', () => {
            mockKeyManager.getAggregatedStats.mockReturnValue({
                totalKeys: 2,
                circuitStates: { closed: 0, open: 2, halfOpen: 0 }
            });

            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(503, { 'content-type': 'application/json' });
        });

        it('should include checks object with all components', () => {
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

        it('should include key check with status', () => {
            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.checks.keys.status).toBe('healthy');
            expect(responseData.checks.keys.healthy).toBe(4);
            expect(responseData.checks.keys.total).toBe(5);
        });

        it('should include queue check with stats', () => {
            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.checks.queue.status).toBe('healthy');
            expect(responseData.checks.queue.current).toBe(10);
            expect(responseData.checks.queue.max).toBe(100);
        });

        it('should include memory check with stats', () => {
            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.checks.memory).toHaveProperty('status');
            expect(responseData.checks.memory).toHaveProperty('heapUsed');
            expect(responseData.checks.memory).toHaveProperty('heapTotal');
        });

        it('should include scheduler check when available', () => {
            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            expect(mockKeyManager.getSchedulerStats).toHaveBeenCalled();
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.checks.scheduler).toBeDefined();
        });

        it('should include model routing check when available', () => {
            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.checks.modelRouting).toBeDefined();
            expect(responseData.checks.modelRouting.enabled).toBe(true);
        });

        it('should mark model routing as not_configured when null', () => {
            controller._modelRouter = null;

            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.checks.modelRouting.status).toBe('not_configured');
        });

        it('should include process information', () => {
            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.process).toHaveProperty('pid');
            expect(responseData.process).toHaveProperty('nodeVersion');
            expect(responseData.process).toHaveProperty('platform');
            expect(responseData.process).toHaveProperty('arch');
        });

        it('should include timestamp and checkDuration', () => {
            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('timestamp');
            expect(responseData).toHaveProperty('checkDuration');
            expect(responseData.checkDuration).toBeGreaterThanOrEqual(0);
        });

        it('should calculate overall status correctly', () => {
            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(['healthy', 'degraded', 'unhealthy']).toContain(responseData.status);
        });

        it('should return degraded when keys are healthy but queue is not', () => {
            mockRequestHandler.getBackpressureStats.mockReturnValue({
                current: 95,
                max: 100,
                percentUsed: 95,
                queue: { length: 95, waiting: 90 }
            });

            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.status).toBe('degraded');
        });

        it('should handle null keyManager gracefully', () => {
            const controllerNoKeyManager = new HealthController({
                keyManager: null,
                requestHandler: mockRequestHandler,
                getUptime: mockGetUptime
            });

            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            expect(() => controllerNoKeyManager.handleHealthDeep(mockReq, mockRes)).not.toThrow();

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.checks.keys.total).toBe(0);
        });

        it('should handle null requestHandler gracefully', () => {
            const controllerNoRequestHandler = new HealthController({
                keyManager: mockKeyManager,
                requestHandler: null,
                getUptime: mockGetUptime
            });

            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            expect(() => controllerNoRequestHandler.handleHealthDeep(mockReq, mockRes)).not.toThrow();

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.checks.queue).toBeDefined();
            expect(responseData.checks.traces).toBeDefined();
        });

        it('should handle both dependencies null gracefully', () => {
            const controllerMinimal = new HealthController({
                keyManager: null,
                requestHandler: null,
                getUptime: mockGetUptime
            });

            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            expect(() => controllerMinimal.handleHealthDeep(mockReq, mockRes)).not.toThrow();

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.status).toBe('unhealthy'); // No keys means unhealthy, not degraded
            expect(responseData.checks).toBeDefined();
        });

        it('should return warning status when memory usage is high (line 117)', () => {
            // Mock process.memoryUsage to return high heap usage
            const originalMemUsage = process.memoryUsage;
            try {
                process.memoryUsage = jest.fn(() => ({
                    heapUsed: 1900 * 1024 * 1024,  // 1900MB - high usage
                    heapTotal: 2000 * 1024 * 1024, // 2000MB total
                    external: 100 * 1024 * 1024,
                    rss: 2100 * 1024 * 1024
                }));

                const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
                const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

                controller.handleHealthDeep(mockReq, mockRes);

                const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
                expect(responseData.checks.memory.status).toBe('warning');
            } finally {
                process.memoryUsage = originalMemUsage;
            }
        });

        it('should include scheduler check when getSchedulerStats returns data (lines 144-147)', () => {
            mockKeyManager.getSchedulerStats.mockReturnValue({
                reasonDistribution: { 'rate-limit': 5, 'error': 2 },
                fairness: { fairnessScore: 0.85 }
            });
            mockKeyManager.getPoolState = jest.fn(() => 'active');

            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.checks.scheduler).toBeDefined();
            expect(responseData.checks.scheduler.status).toBe('healthy');
            expect(responseData.checks.scheduler.poolState).toBe('active');
            expect(responseData.checks.scheduler.reasonDistribution).toEqual({ 'rate-limit': 5, 'error': 2 });
            expect(responseData.checks.scheduler.fairnessScore).toBe(0.85);
        });

        it('should mark model routing as disabled when router exists but enabled is false (line 157)', () => {
            mockModelRouter.enabled = false;

            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.checks.modelRouting.status).toBe('disabled');
            expect(responseData.checks.modelRouting.enabled).toBe(false);
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
