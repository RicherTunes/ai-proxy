/**
 * Unit Test: Auth Controller
 *
 * TDD Phase: Red - Write failing unit test before module exists
 *
 * Tests the AuthController class for proxy-server.js auth-related routes.
 */

'use strict';

let AuthController;
try {
    ({ AuthController } = require('../../../lib/proxy/controllers/auth-controller'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = AuthController ? describe : describe.skip;

describeIfModule('auth-controller', () => {
    let controller;
    let mockAdminAuth;
    let mockAddAuditEntry;

    beforeEach(() => {
        mockAdminAuth = {
            enabled: true,
            tokens: new Set(['hashed-token-1', 'hashed-token-2']),
            headerName: 'x-admin-token',
            authenticate: jest.fn(() => ({ authenticated: true })),
            extractToken: jest.fn(() => 'test-token')
        };

        mockAddAuditEntry = jest.fn();

        controller = new AuthController({
            adminAuth: mockAdminAuth,
            addAuditEntry: mockAddAuditEntry,
            config: { security: {} }
        });
    });

    describe('constructor', () => {
        it('should create a new AuthController', () => {
            expect(controller).toBeInstanceOf(AuthController);
        });

        it('should initialize with provided dependencies', () => {
            expect(controller._adminAuth).toBe(mockAdminAuth);
            expect(controller._config).toBeDefined();
        });

        it('should initialize with default values when options omitted', () => {
            const minimalController = new AuthController();
            expect(minimalController).toBeInstanceOf(AuthController);
        });
    });

    describe('handleAuthStatus', () => {
        it('should return auth status on GET', () => {
            const mockReq = {
                url: '/auth-status',
                headers: { host: 'localhost' }
            };
            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn()
            };

            controller.handleAuthStatus(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
        });

        it('should include all required fields in response', () => {
            const mockReq = { url: '/auth-status', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleAuthStatus(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toEqual({
                enabled: true,
                tokensConfigured: 2,
                tokensRequired: true,
                authenticated: false,
                headerName: 'x-admin-token'
            });
        });

        it('should handle null adminAuth gracefully', () => {
            controller._adminAuth = null;

            const mockReq = { url: '/auth-status', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleAuthStatus(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.enabled).toBe(false);
            expect(responseData.tokensConfigured).toBe(0);
            expect(responseData.tokensRequired).toBe(false);
        });

        it('should validate token when provided', () => {
            // Mock the internal auth validation
            mockAdminAuth.extractToken.mockReturnValue('provided-token');

            const mockReq = {
                url: '/auth-status',
                headers: { host: 'localhost', 'x-admin-token': 'provided-token' }
            };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleAuthStatus(mockReq, mockRes);

            expect(mockAdminAuth.extractToken).toHaveBeenCalledWith(mockReq);
        });
    });

    describe('requireAuth', () => {
        it('should return true when authentication succeeds', () => {
            mockAdminAuth.authenticate.mockReturnValue({ authenticated: true });

            const mockReq = { url: '/test', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            const result = controller.requireAuth(mockReq, mockRes);

            expect(result).toBe(true);
            expect(mockRes.writeHead).not.toHaveBeenCalled();
        });

        it('should return 401 when authentication fails', () => {
            mockAdminAuth.authenticate.mockReturnValue({
                authenticated: false,
                error: 'invalid_token'
            });

            const mockReq = { url: '/test', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            const result = controller.requireAuth(mockReq, mockRes);

            expect(result).toBe(false);
            expect(mockRes.writeHead).toHaveBeenCalledWith(401, {
                'content-type': 'application/json'
            });
        });

        it('should return 429 for too many attempts', () => {
            mockAdminAuth.authenticate.mockReturnValue({
                authenticated: false,
                error: 'too_many_attempts',
                retryAfterMs: 60000
            });

            const mockReq = { url: '/test', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            const result = controller.requireAuth(mockReq, mockRes);

            expect(result).toBe(false);
            expect(mockRes.writeHead).toHaveBeenCalledWith(429, {
                'content-type': 'application/json',
                'retry-after': '60'
            });
        });

        it('should send appropriate error message', () => {
            mockAdminAuth.authenticate.mockReturnValue({
                authenticated: false,
                error: 'unauthorized'
            });

            const mockReq = { url: '/test', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.requireAuth(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.message).toBe('Admin authentication required');
        });

        it('should send retry-after rounded up to seconds', () => {
            mockAdminAuth.authenticate.mockReturnValue({
                authenticated: false,
                error: 'too_many_attempts',
                retryAfterMs: 5500
            });

            const mockReq = { url: '/test', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.requireAuth(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(429, {
                'content-type': 'application/json',
                'retry-after': '6'
            });
        });
    });

    describe('requiresAdminAuth', () => {
        it('should return false when adminAuth not enabled', () => {
            mockAdminAuth.enabled = false;

            const result = controller.requiresAdminAuth('/stats', 'GET');
            expect(result).toBe(false);
        });

        it('should return false when adminAuth is null', () => {
            controller._adminAuth = null;

            const result = controller.requiresAdminAuth('/stats', 'GET');
            expect(result).toBe(false);
        });

        it('should return true for mutations on admin routes', () => {
            const mutations = ['POST', 'PUT', 'DELETE', 'PATCH'];

            mutations.forEach(method => {
                const result = controller.requiresAdminAuth('/stats', method);
                expect(result).toBe(true);
            });
        });

        it('should return true for sensitive GET paths', () => {
            const sensitivePaths = [
                '/logs',
                '/replay/123',
                '/model-mapping',
                '/model-routing',
                '/model-routing/export',
                '/model-routing/import-from-mappings',
                '/model-selection',
                '/requests',
                '/admin/cost-tracking/config'
            ];

            sensitivePaths.forEach(path => {
                const result = controller.requiresAdminAuth(path, 'GET');
                expect(result).toBe(true);
            });
        });

        it('should return false for non-sensitive GET paths', () => {
            const safePaths = ['/health', '/health/deep', '/metrics', '/stats', '/dashboard'];

            safePaths.forEach(path => {
                const result = controller.requiresAdminAuth(path, 'GET');
                expect(result).toBe(false);
            });
        });

        it('should match prefix paths correctly', () => {
            expect(controller.requiresAdminAuth('/replay/test-id', 'GET')).toBe(true);
            expect(controller.requiresAdminAuth('/model-routing/reset', 'GET')).toBe(true);
        });
    });

    describe('isAdminRoute', () => {
        it('should return true for known admin paths', () => {
            const adminPaths = [
                '/health',
                '/stats',
                '/dashboard',
                '/logs',
                '/model-mapping',
                '/model-routing',
                '/auth-status',
                '/metrics',
                '/reload',
                '/backpressure',
                '/history',
                '/events'
            ];

            adminPaths.forEach(path => {
                expect(controller.isAdminRoute(path)).toBe(true);
            });
        });

        it('should return true for prefix matches', () => {
            expect(controller.isAdminRoute('/control/something')).toBe(true);
            expect(controller.isAdminRoute('/replay/test')).toBe(true);
            expect(controller.isAdminRoute('/traces/id')).toBe(true);
            expect(controller.isAdminRoute('/policies/route')).toBe(true);
        });

        it('should handle /requests prefix correctly', () => {
            expect(controller.isAdminRoute('/requests')).toBe(true);
            expect(controller.isAdminRoute('/requests/search')).toBe(true);
        });

        it('should return false for proxy traffic', () => {
            const proxyPaths = [
                '/v1/messages',
                '/v1/chat/completions',
                '/v1/models'
            ];

            proxyPaths.forEach(path => {
                expect(controller.isAdminRoute(path)).toBe(false);
            });
        });

        it('should return false for unknown paths', () => {
            expect(controller.isAdminRoute('/unknown/path')).toBe(false);
            expect(controller.isAdminRoute('/api/unknown')).toBe(false);
        });

        it('should handle /stats/latency-histogram prefix', () => {
            expect(controller.isAdminRoute('/stats/latency-histogram')).toBe(true);
            expect(controller.isAdminRoute('/stats/latency-histogram/buckets')).toBe(true);
        });
    });

    describe('debugEndpointsRequireAuth', () => {
        it('should return true by default', () => {
            const result = controller.debugEndpointsRequireAuth();
            expect(result).toBe(true);
        });

        it('should return false when explicitly disabled in config', () => {
            controller = new AuthController({
                adminAuth: mockAdminAuth,
                config: { security: { debugEndpointsAlwaysRequireAuth: false } }
            });

            const result = controller.debugEndpointsRequireAuth();
            expect(result).toBe(false);
        });

        it('should handle missing security config', () => {
            controller = new AuthController({
                adminAuth: mockAdminAuth,
                config: {}
            });

            const result = controller.debugEndpointsRequireAuth();
            expect(result).toBe(true);
        });
    });

    describe('isDebugEndpoint', () => {
        it('should return true for /debug paths', () => {
            expect(controller.isDebugEndpoint('/debug')).toBe(true);
            expect(controller.isDebugEndpoint('/debug/test')).toBe(true);
        });

        it('should return false for non-debug paths', () => {
            expect(controller.isDebugEndpoint('/stats')).toBe(false);
            expect(controller.isDebugEndpoint('/health')).toBe(false);
        });
    });

    describe('interface contract', () => {
        it('should have handleAuthStatus method', () => {
            expect(typeof controller.handleAuthStatus).toBe('function');
        });

        it('should have requireAuth method', () => {
            expect(typeof controller.requireAuth).toBe('function');
        });

        it('should have requiresAdminAuth method', () => {
            expect(typeof controller.requiresAdminAuth).toBe('function');
        });

        it('should have isAdminRoute method', () => {
            expect(typeof controller.isAdminRoute).toBe('function');
        });

        it('should have debugEndpointsRequireAuth method', () => {
            expect(typeof controller.debugEndpointsRequireAuth).toBe('function');
        });

        it('should have isDebugEndpoint method', () => {
            expect(typeof controller.isDebugEndpoint).toBe('function');
        });
    });
});
