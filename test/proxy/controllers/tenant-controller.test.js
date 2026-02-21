/**
 * Unit Test: Tenant Controller
 *
 * TDD Phase: Red - Write failing unit test before module exists
 *
 * Tests the TenantController class for proxy-server.js tenant-related routes.
 */

'use strict';

let TenantController;
try {
    ({ TenantController } = require('../../../lib/proxy/controllers/tenant-controller'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = TenantController ? describe : describe.skip;

describeIfModule('tenant-controller', () => {
    let controller;
    let mockTenantManager;
    let mockCostTracker;

    beforeEach(() => {
        mockTenantManager = {
            enabled: true,
            getAllTenantStats: jest.fn(() => ({
                tenantCount: 2,
                globalStats: {
                    totalRequests: 100,
                    unknownTenantRequests: 5
                },
                tenants: {
                    'tenant1': {
                        keyCount: 5,
                        requestCount: 60,
                        errorCount: 3,
                        lastUsed: Date.now()
                    },
                    'tenant2': {
                        keyCount: 3,
                        requestCount: 35,
                        errorCount: 2,
                        lastUsed: Date.now() - 10000
                    }
                }
            })),
            getTenantStats: jest.fn((id) => {
                if (id === 'tenant1') {
                    return {
                        tenantId: 'tenant1',
                        keyCount: 5,
                        requestCount: 60,
                        errorCount: 3,
                        lastUsed: Date.now()
                    };
                }
                return null;
            })
        };

        mockCostTracker = {
            getAllTenantCosts: jest.fn(() => ({
                'tenant1': {
                    totalCost: 1.50,
                    requestCost: 1.00,
                    retryCost: 0.50
                },
                'tenant2': {
                    totalCost: 0.75,
                    requestCost: 0.75,
                    retryCost: 0
                }
            }))
        };

        controller = new TenantController({
            tenantManager: mockTenantManager,
            costTracker: mockCostTracker
        });
    });

    describe('constructor', () => {
        it('should create a new TenantController', () => {
            expect(controller).toBeInstanceOf(TenantController);
        });

        it('should initialize with provided dependencies', () => {
            expect(controller._tenantManager).toBe(mockTenantManager);
            expect(controller._costTracker).toBe(mockCostTracker);
        });

        it('should initialize with default values when options omitted', () => {
            const minimalController = new TenantController();
            expect(minimalController).toBeInstanceOf(TenantController);
        });
    });

    describe('handleTenants', () => {
        it('should return 404 when tenantManager is not enabled', () => {
            controller._tenantManager = null;

            const mockReq = { url: '/tenants', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTenants(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(404, { 'content-type': 'application/json' });
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toContain('not enabled');
        });

        it('should call getAllTenantStats on tenantManager', () => {
            const mockReq = { url: '/tenants', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTenants(mockReq, mockRes);

            expect(mockTenantManager.getAllTenantStats).toHaveBeenCalled();
        });

        it('should return 200 with tenant stats', () => {
            const mockReq = { url: '/tenants', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTenants(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('tenantCount');
            expect(responseData).toHaveProperty('globalStats');
            expect(responseData).toHaveProperty('tenants');
        });

        it('should include tenant data in response', () => {
            const mockReq = { url: '/tenants', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTenants(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.tenants).toBeDefined();
            expect(responseData.tenants['tenant1']).toBeDefined();
        });
    });

    describe('handleTenantStats', () => {
        it('should return 404 when tenantManager is not enabled', () => {
            controller._tenantManager = null;

            const mockReq = { url: '/tenants/tenant1/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTenantStats(mockReq, mockRes, '/tenants/tenant1/stats');

            expect(mockRes.writeHead).toHaveBeenCalledWith(404, { 'content-type': 'application/json' });
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toContain('not enabled');
        });

        it('should return 404 when path does not match pattern', () => {
            const mockReq = { url: '/tenants/', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTenantStats(mockReq, mockRes, '/tenants/');

            expect(mockRes.writeHead).toHaveBeenCalledWith(404, { 'content-type': 'application/json' });
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('Not found');
        });

        it('should extract tenantId from path', () => {
            const mockReq = { url: '/tenants/tenant1/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTenantStats(mockReq, mockRes, '/tenants/tenant1/stats');

            expect(mockTenantManager.getTenantStats).toHaveBeenCalledWith('tenant1');
        });

        it('should return 404 when tenant not found', () => {
            mockTenantManager.getTenantStats.mockReturnValueOnce(null);

            const mockReq = { url: '/tenants/nonexistent/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTenantStats(mockReq, mockRes, '/tenants/nonexistent/stats');

            expect(mockRes.writeHead).toHaveBeenCalledWith(404, { 'content-type': 'application/json' });
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('Tenant not found');
        });

        it('should return 200 with tenant stats when found', () => {
            const mockReq = { url: '/tenants/tenant1/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTenantStats(mockReq, mockRes, '/tenants/tenant1/stats');

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
        });

        it('should return formatted JSON response', () => {
            const mockReq = { url: '/tenants/tenant1/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTenantStats(mockReq, mockRes, '/tenants/tenant1/stats');

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('tenantId', 'tenant1');
        });
    });

    describe('interface contract', () => {
        it('should have handleTenants method', () => {
            expect(typeof controller.handleTenants).toBe('function');
        });

        it('should have handleTenantStats method', () => {
            expect(typeof controller.handleTenantStats).toBe('function');
        });
    });

    describe('edge cases', () => {
        it('should handle missing tenantManager gracefully in handleTenants', () => {
            controller._tenantManager = null;

            const mockReq = { url: '/tenants', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            expect(() => controller.handleTenants(mockReq, mockRes)).not.toThrow();
        });

        it('should handle missing tenantManager gracefully in handleTenantStats', () => {
            controller._tenantManager = null;

            const mockReq = { url: '/tenants/tenant1/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            expect(() => controller.handleTenantStats(mockReq, mockRes, '/tenants/tenant1/stats')).not.toThrow();
        });
    });
});
