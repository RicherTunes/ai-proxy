/**
 * Coverage Test: Health Controller
 *
 * Targets uncovered branches in lib/proxy/controllers/health-controller.js
 * Uncovered lines: 125, 144-147
 *
 * BEFORE coverage: Branch 75%, Function 94.82%
 */

'use strict';

const { HealthController } = require('../lib/proxy/controllers/health-controller');

describe('health-controller coverage', () => {
    let controller;
    let mockKeyManager;
    let mockRequestHandler;
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

        mockGetUptime = jest.fn(() => 3600000);

        controller = new HealthController({
            keyManager: mockKeyManager,
            requestHandler: mockRequestHandler,
            getUptime: mockGetUptime
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('handleHealthDeep - connection health degraded status', () => {
        // Covers line 125: consecutiveHangups >= 3 → status 'degraded'
        it('should return degraded connection status when consecutiveHangups >= 3 (line 125)', () => {
            mockRequestHandler.getConnectionHealthStats.mockReturnValue({
                consecutiveHangups: 5,
                totalHangups: 10,
                agentRecreationCount: 3
            });

            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.checks.connections.status).toBe('degraded');
            expect(responseData.checks.connections.consecutiveHangups).toBe(5);
            expect(responseData.checks.connections.totalHangups).toBe(10);
            expect(responseData.checks.connections.agentRecreations).toBe(3);
        });

        // Covers line 125: consecutiveHangups = 2 → status 'healthy' (boundary)
        it('should return healthy connection status when consecutiveHangups < 3 (line 125)', () => {
            mockRequestHandler.getConnectionHealthStats.mockReturnValue({
                consecutiveHangups: 2,
                totalHangups: 5,
                agentRecreationCount: 1
            });

            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.checks.connections.status).toBe('healthy');
            expect(responseData.checks.connections.consecutiveHangups).toBe(2);
        });
    });

    describe('handleHealthDeep - scheduler stats null handling', () => {
        // Covers line 144: getSchedulerStats returns null → scheduler check not added
        it('should not include scheduler check when getSchedulerStats returns null (line 144)', () => {
            mockKeyManager.getSchedulerStats.mockReturnValue(null);

            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.checks.scheduler).toBeUndefined();
        });

        // Covers line 144: getSchedulerStats returns undefined → scheduler check not added
        it('should not include scheduler check when getSchedulerStats returns undefined (line 144)', () => {
            mockKeyManager.getSchedulerStats.mockReturnValue(undefined);

            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.checks.scheduler).toBeUndefined();
        });
    });

    describe('handleHealthDeep - poolState unknown fallback', () => {
        // Covers line 147: getPoolState undefined → poolState 'unknown'
        it('should return unknown poolState when getPoolState is undefined (line 147)', () => {
            // Create keyManager without getPoolState method
            const keyManagerNoPoolState = {
                getAggregatedStats: jest.fn(() => ({
                    totalKeys: 5,
                    circuitStates: { closed: 3, open: 1, halfOpen: 1 }
                })),
                getSchedulerStats: jest.fn(() => ({
                    reasonDistribution: { 'rate-limit': 3 },
                    fairness: { fairnessScore: 0.75 }
                }))
                // No getPoolState method
            };

            const controllerNoPoolState = new HealthController({
                keyManager: keyManagerNoPoolState,
                requestHandler: mockRequestHandler,
                getUptime: mockGetUptime
            });

            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn() };

            controllerNoPoolState.handleHealthDeep(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.checks.scheduler).toBeDefined();
            expect(responseData.checks.scheduler.poolState).toBe('unknown');
            expect(responseData.checks.scheduler.reasonDistribution).toEqual({ 'rate-limit': 3 });
            expect(responseData.checks.scheduler.fairnessScore).toBe(0.75);
        });
    });

    describe('handleHealthDeep - combined edge cases', () => {
        // Covers line 125 + 144 together: degraded connections AND null scheduler stats
        it('should handle degraded connections and missing scheduler together', () => {
            mockRequestHandler.getConnectionHealthStats.mockReturnValue({
                consecutiveHangups: 4,
                totalHangups: 8,
                agentRecreationCount: 2
            });
            mockKeyManager.getSchedulerStats.mockReturnValue(null);

            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.checks.connections.status).toBe('degraded');
            expect(responseData.checks.scheduler).toBeUndefined();
        });

        // Covers lines 144-147: scheduler stats with null fairness
        it('should handle scheduler stats with null fairness score (line 149)', () => {
            mockKeyManager.getSchedulerStats.mockReturnValue({
                reasonDistribution: { 'error': 2 },
                fairness: null
            });

            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn() };

            controller.handleHealthDeep(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.checks.scheduler).toBeDefined();
            expect(responseData.checks.scheduler.fairnessScore).toBeUndefined();
        });
    });

    describe('default getUptime function coverage', () => {
        // Covers line 29: default arrow function () => 0 when no getUptime provided
        it('should use default getUptime returning 0 when not provided (line 29)', () => {
            const controllerNoUptime = new HealthController({
                keyManager: mockKeyManager,
                requestHandler: mockRequestHandler
                // No getUptime provided - should use default () => 0
            });

            const mockReq = { url: '/health', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn() };

            controllerNoUptime.handleHealth(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.uptime).toBe(0);
        });

        // Covers line 29: default getUptime in handleHealthDeep as well
        it('should use default getUptime in deep health check (line 29)', () => {
            const controllerNoUptime = new HealthController({
                keyManager: mockKeyManager,
                requestHandler: mockRequestHandler
                // No getUptime provided - should use default () => 0
            });

            const mockReq = { url: '/health/deep', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn() };

            controllerNoUptime.handleHealthDeep(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.uptime).toBe(0);
        });
    });
});
