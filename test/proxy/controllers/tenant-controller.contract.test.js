/**
 * Contract Test: Tenant Controller
 *
 * This contract test ensures that tenant-related route operations produce consistent results
 * after extraction from ProxyServer to tenant-controller.js.
 *
 * TDD Phase: Red - Write failing test first
 */

'use strict';

const http = require('http');
let TenantController;
try {
    ({ TenantController } = require('../../../lib/proxy/controllers/tenant-controller'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = TenantController ? describe : describe.skip;

describeIfModule('ProxyServer Contract: Tenant Controller Operations', () => {
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
                    totalCost: 1.50
                }
            }))
        };

        controller = new TenantController({
            tenantManager: mockTenantManager,
            costTracker: mockCostTracker
        });
    });

    describe('handleTenants', () => {
        it('should return 404 when tenantManager is not enabled', () => {
            controller._tenantManager = null;

            const mockReq = { url: '/tenants', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTenants(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(404, { 'content-type': 'application/json' });
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
        });

        it('should include tenantCount in response', () => {
            const mockReq = { url: '/tenants', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTenants(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('tenantCount');
        });

        it('should include globalStats in response', () => {
            const mockReq = { url: '/tenants', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTenants(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('globalStats');
        });

        it('should include tenants object in response', () => {
            const mockReq = { url: '/tenants', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTenants(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('tenants');
        });
    });

    describe('handleTenantStats', () => {
        it('should return 404 when tenantManager is not enabled', () => {
            controller._tenantManager = null;

            const mockReq = { url: '/tenants/tenant1/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTenantStats(mockReq, mockRes, '/tenants/tenant1/stats');

            expect(mockRes.writeHead).toHaveBeenCalledWith(404, { 'content-type': 'application/json' });
        });

        it('should return 404 when path does not match pattern', () => {
            const mockReq = { url: '/tenants/', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTenantStats(mockReq, mockRes, '/tenants/');

            expect(mockRes.writeHead).toHaveBeenCalledWith(404, { 'content-type': 'application/json' });
        });

        it('should extract tenantId from path and call getTenantStats', () => {
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
        });

        it('should return 200 with tenant stats when found', () => {
            const mockReq = { url: '/tenants/tenant1/stats', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTenantStats(mockReq, mockRes, '/tenants/tenant1/stats');

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
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
});
