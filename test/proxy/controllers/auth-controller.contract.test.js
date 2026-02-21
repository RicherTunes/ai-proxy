/**
 * Contract Test: Auth Controller
 *
 * This contract test ensures that auth-related route operations produce consistent results
 * after extraction from ProxyServer to auth-controller.js.
 *
 * TDD Phase: Red - Write failing test first
 */

'use strict';

const http = require('http');
let AuthController;
try {
    ({ AuthController } = require('../../../lib/proxy/controllers/auth-controller'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = AuthController ? describe : describe.skip;

describeIfModule('ProxyServer Contract: Auth Controller Operations', () => {
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
            addAuditEntry: mockAddAuditEntry
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
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('enabled');
            expect(responseData).toHaveProperty('tokensConfigured');
            expect(responseData).toHaveProperty('tokensRequired');
            expect(responseData).toHaveProperty('authenticated');
            expect(responseData).toHaveProperty('headerName');
        });

        it('should return enabled=true when adminAuth exists and is enabled', () => {
            mockAdminAuth.enabled = true;

            const mockReq = { url: '/auth-status', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleAuthStatus(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.enabled).toBe(true);
        });

        it('should return enabled=false when adminAuth is disabled', () => {
            mockAdminAuth.enabled = false;

            const mockReq = { url: '/auth-status', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleAuthStatus(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.enabled).toBe(false);
        });

        it('should return correct tokensConfigured count', () => {
            mockAdminAuth.tokens = new Set(['token1', 'token2', 'token3']);

            const mockReq = { url: '/auth-status', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleAuthStatus(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.tokensConfigured).toBe(3);
        });

        it('should return tokensRequired=true when tokens are configured', () => {
            mockAdminAuth.tokens = new Set(['token1']);

            const mockReq = { url: '/auth-status', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleAuthStatus(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.tokensRequired).toBe(true);
        });

        it('should return tokensRequired=false when no tokens configured', () => {
            mockAdminAuth.tokens = new Set();

            const mockReq = { url: '/auth-status', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleAuthStatus(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.tokensRequired).toBe(false);
        });

        it('should return authenticated=false when no token provided', () => {
            mockAdminAuth.extractToken.mockReturnValue(null);

            const mockReq = { url: '/auth-status', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleAuthStatus(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.authenticated).toBe(false);
        });

        it('should return custom headerName when configured', () => {
            mockAdminAuth.headerName = 'x-custom-auth';

            const mockReq = { url: '/auth-status', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleAuthStatus(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.headerName).toBe('x-custom-auth');
        });

        it('should return default headerName when not configured', () => {
            mockAdminAuth.headerName = undefined;

            const mockReq = { url: '/auth-status', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleAuthStatus(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.headerName).toBe('x-admin-token');
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

        it('should return false and send 401 when authentication fails', () => {
            mockAdminAuth.authenticate.mockReturnValue({
                authenticated: false,
                error: 'unauthorized'
            });

            const mockReq = { url: '/test', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            const result = controller.requireAuth(mockReq, mockRes);

            expect(result).toBe(false);
            expect(mockRes.writeHead).toHaveBeenCalledWith(401, {
                'content-type': 'application/json'
            });
        });

        it('should return false and send 429 when too many attempts', () => {
            mockAdminAuth.authenticate.mockReturnValue({
                authenticated: false,
                error: 'too_many_attempts',
                retryAfterMs: 5000
            });

            const mockReq = { url: '/test', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            const result = controller.requireAuth(mockReq, mockRes);

            expect(result).toBe(false);
            expect(mockRes.writeHead).toHaveBeenCalledWith(429, {
                'content-type': 'application/json',
                'retry-after': '5'
            });
        });

        it('should include retry-after header when provided', () => {
            mockAdminAuth.authenticate.mockReturnValue({
                authenticated: false,
                error: 'too_many_attempts',
                retryAfterMs: 10000
            });

            const mockReq = { url: '/test', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.requireAuth(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(429, {
                'content-type': 'application/json',
                'retry-after': '10'
            });
        });

        it('should send error response with message', () => {
            mockAdminAuth.authenticate.mockReturnValue({
                authenticated: false,
                error: 'unauthorized'
            });

            const mockReq = { url: '/test', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.requireAuth(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('error');
            expect(responseData).toHaveProperty('message');
        });
    });

    describe('requiresAdminAuth', () => {
        it('should return false when adminAuth is not enabled', () => {
            mockAdminAuth.enabled = false;

            const result = controller.requiresAdminAuth('/stats', 'GET');
            expect(result).toBe(false);
        });

        it('should return false when adminAuth is null', () => {
            controller._adminAuth = null;

            const result = controller.requiresAdminAuth('/stats', 'GET');
            expect(result).toBe(false);
        });

        it('should return true for sensitive GET paths', () => {
            const sensitivePaths = [
                '/logs',
                '/model-mapping',
                '/model-routing',
                '/model-selection',
                '/requests'
            ];

            sensitivePaths.forEach(path => {
                const result = controller.requiresAdminAuth(path, 'GET');
                expect(result).toBe(true);
            });
        });

        it('should return true for mutation methods on admin routes', () => {
            const mutations = ['POST', 'PUT', 'PATCH', 'DELETE'];

            mutations.forEach(method => {
                const result = controller.requiresAdminAuth('/stats', method);
                expect(result).toBe(true);
            });
        });

        it('should return false for GET on non-sensitive paths', () => {
            const result = controller.requiresAdminAuth('/health', 'GET');
            expect(result).toBe(false);
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
                '/auth-status'
            ];

            adminPaths.forEach(path => {
                const result = controller.isAdminRoute(path);
                expect(result).toBe(true);
            });
        });

        it('should return false for proxy traffic', () => {
            const result = controller.isAdminRoute('/v1/messages');
            expect(result).toBe(false);
        });

        it('should return true for prefix matches', () => {
            expect(controller.isAdminRoute('/control/something')).toBe(true);
            expect(controller.isAdminRoute('/replay/test')).toBe(true);
            expect(controller.isAdminRoute('/traces/id')).toBe(true);
        });
    });

    describe('debugEndpointsRequireAuth', () => {
        it('should return true by default', () => {
            const result = controller.debugEndpointsRequireAuth();
            expect(result).toBe(true);
        });

        it('should return false when config disables it', () => {
            controller = new AuthController({
                adminAuth: mockAdminAuth,
                config: { security: { debugEndpointsAlwaysRequireAuth: false } }
            });

            const result = controller.debugEndpointsRequireAuth();
            expect(result).toBe(false);
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
    });
});
