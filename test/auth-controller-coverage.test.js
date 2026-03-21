/**
 * Coverage Test: Auth Controller
 *
 * TDD Phase: Green - Tests for uncovered branches in auth-controller.js
 *
 * Uncovered lines: 126, 134-135, 161
 * Target: 98%+ branch and function coverage
 */

'use strict';

const { AuthController } = require('../lib/proxy/controllers/auth-controller');
const { hashToken } = require('../lib/admin-auth');

describe('auth-controller - coverage tests', () => {
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

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('handleAuthStatus - peekAuthentication path (line 126)', () => {
        // Covers line 126: when peekAuthentication method exists
        it('should use peekAuthentication when available', () => {
            mockAdminAuth.peekAuthentication = jest.fn(() => ({
                authenticated: true
            }));

            const mockReq = {
                url: '/auth-status',
                headers: { host: 'localhost', 'x-admin-token': 'valid-token' }
            };
            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn()
            };

            controller.handleAuthStatus(mockReq, mockRes);

            expect(mockAdminAuth.peekAuthentication).toHaveBeenCalledWith(mockReq);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.authenticated).toBe(true);
        });

        // Covers line 126: when peekAuthentication returns false
        it('should return authenticated=false when peekAuthentication returns not authenticated', () => {
            mockAdminAuth.peekAuthentication = jest.fn(() => ({
                authenticated: false
            }));

            const mockReq = {
                url: '/auth-status',
                headers: { host: 'localhost', 'x-admin-token': 'invalid-token' }
            };
            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn()
            };

            controller.handleAuthStatus(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.authenticated).toBe(false);
        });
    });

    describe('handleAuthStatus - fallback token comparison (lines 134-135)', () => {
        // Covers lines 134-135: the else-if branch when peekAuthentication is absent
        // and token matches via secureCompare loop
        it('should authenticate via secureCompare loop when peekAuthentication is absent', () => {
            // Remove peekAuthentication to force fallback path
            delete mockAdminAuth.peekAuthentication;

            // Use actual hashToken to create matching hash
            const testToken = 'test-secret-token';
            const hashedToken = hashToken(testToken);
            mockAdminAuth.tokens = new Set([hashedToken]);
            mockAdminAuth.extractToken.mockReturnValue(testToken);

            const mockReq = {
                url: '/auth-status',
                headers: { host: 'localhost', 'x-admin-token': testToken }
            };
            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn()
            };

            controller.handleAuthStatus(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.authenticated).toBe(true);
        });

        // Covers lines 134-135: loop continues when no match found
        it('should return authenticated=false when token does not match any stored hash', () => {
            delete mockAdminAuth.peekAuthentication;

            const testToken = 'wrong-token';
            mockAdminAuth.tokens = new Set([hashToken('correct-token')]);
            mockAdminAuth.extractToken.mockReturnValue(testToken);

            const mockReq = {
                url: '/auth-status',
                headers: { host: 'localhost', 'x-admin-token': testToken }
            };
            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn()
            };

            controller.handleAuthStatus(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.authenticated).toBe(false);
        });

        // Covers lines 134-135: multiple tokens in Set, matching second one
        it('should match token against multiple stored hashes', () => {
            delete mockAdminAuth.peekAuthentication;

            const testToken = 'my-secret-token';
            const otherHash = hashToken('other-token');
            const matchingHash = hashToken(testToken);
            mockAdminAuth.tokens = new Set([otherHash, matchingHash]);
            mockAdminAuth.extractToken.mockReturnValue(testToken);

            const mockReq = {
                url: '/auth-status',
                headers: { host: 'localhost', 'x-admin-token': testToken }
            };
            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn()
            };

            controller.handleAuthStatus(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.authenticated).toBe(true);
        });
    });

    describe('requireAuth - when adminAuth is not configured (line 161)', () => {
        // Covers line 161: when _adminAuth is null/falsy
        it('should return true when _adminAuth is null', () => {
            controller._adminAuth = null;

            const mockReq = {
                url: '/some-path',
                headers: { host: 'localhost' }
            };
            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn()
            };

            const result = controller.requireAuth(mockReq, mockRes);

            expect(result).toBe(true);
            expect(mockRes.writeHead).not.toHaveBeenCalled();
        });

        // Covers line 161: when _adminAuth is undefined
        it('should return true when _adminAuth is undefined', () => {
            controller = new AuthController({
                adminAuth: undefined,
                config: { security: {} }
            });

            const mockReq = {
                url: '/some-path',
                headers: { host: 'localhost' }
            };
            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn()
            };

            const result = controller.requireAuth(mockReq, mockRes);

            expect(result).toBe(true);
            expect(mockRes.writeHead).not.toHaveBeenCalled();
        });
    });

    describe('handleAuthStatus - tokens undefined branch (line 123)', () => {
        // Covers line 123: ternary false branch when tokens is undefined
        it('should handle tokens property being undefined', () => {
            mockAdminAuth.tokens = undefined;

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

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.tokensConfigured).toBe(0);
            expect(responseData.tokensRequired).toBe(false);
        });

        // Covers line 123: ternary false branch when tokens is null
        it('should handle tokens property being null', () => {
            mockAdminAuth.tokens = null;

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

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.tokensConfigured).toBe(0);
        });
    });

    describe('requireAuth - error undefined branch (line 176)', () => {
        // Covers line 176: when authResult.error is undefined/falsy
        it('should default error to unauthorized when authResult.error is undefined', () => {
            mockAdminAuth.authenticate.mockReturnValue({
                authenticated: false
                // error is undefined
            });

            const mockReq = {
                url: '/test',
                headers: { host: 'localhost' }
            };
            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn()
            };

            const result = controller.requireAuth(mockReq, mockRes);

            expect(result).toBe(false);
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('unauthorized');
            expect(responseData.message).toBe('Admin authentication required');
        });

        // Covers line 176: when authResult.error is empty string
        it('should default error to unauthorized when authResult.error is empty string', () => {
            mockAdminAuth.authenticate.mockReturnValue({
                authenticated: false,
                error: ''
            });

            const mockReq = {
                url: '/test',
                headers: { host: 'localhost' }
            };
            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn()
            };

            controller.requireAuth(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('unauthorized');
        });
    });

    describe('handleAuthStatus - edge cases around token validation', () => {
        // Covers the branch where tokensRequired is true but extractToken returns null
        it('should return authenticated=false when no token extracted', () => {
            delete mockAdminAuth.peekAuthentication;
            mockAdminAuth.extractToken.mockReturnValue(null);
            mockAdminAuth.tokens = new Set([hashToken('some-token')]);

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

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.authenticated).toBe(false);
        });

        // Covers the branch where extractToken is not available
        it('should handle missing extractToken gracefully', () => {
            delete mockAdminAuth.peekAuthentication;
            delete mockAdminAuth.extractToken;
            mockAdminAuth.tokens = new Set([hashToken('some-token')]);

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

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.authenticated).toBe(false);
        });
    });

});
