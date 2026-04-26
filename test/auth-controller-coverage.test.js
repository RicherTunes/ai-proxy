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

    describe('handleAuthStatus - fallback to _tokens property (line 131)', () => {
        // Covers line 131: the _tokens fallback branch when tokens is falsy on second access
        // Uses a getter so tokens returns a Set for tokensConfigured but null for line 131
        it('should fall back to _tokens when tokens getter returns null after initial config check', () => {
            delete mockAdminAuth.peekAuthentication;

            const testToken = 'fallback-test-token';
            const hashedToken = hashToken(testToken);
            let tokensAccessCount = 0;

            const authWithGetter = {
                enabled: true,
                get tokens() {
                    tokensAccessCount++;
                    // First two accesses (line 123 ternary + .size): return Set so tokensConfigured > 0
                    // Third access (line 131): return null to force _tokens fallback
                    return tokensAccessCount <= 2 ? new Set([hashedToken]) : null;
                },
                _tokens: new Set([hashedToken]),
                headerName: 'x-admin-token',
                authenticate: jest.fn(() => ({ authenticated: true })),
                extractToken: jest.fn(() => testToken)
            };

            controller._adminAuth = authWithGetter;

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
            // Should authenticate via _tokens fallback on line 131
            expect(responseData.authenticated).toBe(true);
            expect(responseData.tokensConfigured).toBe(1);
            expect(responseData.tokensRequired).toBe(true);
        });

        // Covers line 131: the new Set() fallback when both tokens and _tokens are falsy
        // Uses a getter so tokens returns Set for config but null for comparison,
        // and _tokens is also falsy → falls through to new Set()
        it('should fall back to empty Set when both tokens and _tokens are falsy', () => {
            delete mockAdminAuth.peekAuthentication;

            const testToken = 'orphan-token';
            const hashedToken = hashToken(testToken);
            let tokensAccessCount = 0;

            const authWithBothFalsy = {
                enabled: true,
                get tokens() {
                    tokensAccessCount++;
                    // First two accesses: Set for tokensConfigured > 0
                    // Third access: null to force fallback chain
                    return tokensAccessCount <= 2 ? new Set([hashedToken]) : null;
                },
                _tokens: null, // Also falsy → falls through to new Set()
                headerName: 'x-admin-token',
                authenticate: jest.fn(() => ({ authenticated: true })),
                extractToken: jest.fn(() => testToken)
            };

            controller._adminAuth = authWithBothFalsy;

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
            // Iterating empty Set → no match → authenticated stays false
            expect(responseData.authenticated).toBe(false);
            expect(responseData.tokensConfigured).toBe(1);
            expect(responseData.tokensRequired).toBe(true);
        });

        // Covers line 131: _tokens fallback path with undefined _tokens
        it('should fall back to empty Set when _tokens is undefined', () => {
            delete mockAdminAuth.peekAuthentication;

            const testToken = 'missing-internal-token';
            const hashedToken = hashToken(testToken);
            let tokensAccessCount = 0;

            const authWithUndefinedInternal = {
                enabled: true,
                get tokens() {
                    tokensAccessCount++;
                    return tokensAccessCount <= 2 ? new Set([hashedToken]) : null;
                },
                _tokens: undefined, // Falsy → new Set()
                headerName: 'x-admin-token',
                authenticate: jest.fn(() => ({ authenticated: true })),
                extractToken: jest.fn(() => testToken)
            };

            controller._adminAuth = authWithUndefinedInternal;

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
    });

    // Covers line 166: too_many_attempts error returns 429 status
    describe('requireAuth - too_many_attempts error (line 166)', () => {
        it('should return 429 status when authResult.error is too_many_attempts', () => {
            mockAdminAuth.authenticate.mockReturnValue({
                authenticated: false,
                error: 'too_many_attempts'
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
            expect(mockRes.writeHead).toHaveBeenCalledWith(429, expect.objectContaining({
                'content-type': 'application/json',
                'cache-control': 'no-store'
            }));
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('too_many_attempts');
            expect(responseData.message).toBe('Too many failed authentication attempts');
        });
    });

    // Covers line 171-172: retryAfterMs header inclusion
    describe('requireAuth - retryAfterMs header (line 171-172)', () => {
        it('should include retry-after header when retryAfterMs is provided', () => {
            mockAdminAuth.authenticate.mockReturnValue({
                authenticated: false,
                error: 'too_many_attempts',
                retryAfterMs: 5000
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

            expect(mockRes.writeHead).toHaveBeenCalledWith(429, expect.objectContaining({
                'retry-after': '5'
            }));
        });

        // Covers line 171-172: no retry-after header when retryAfterMs is absent
        it('should not include retry-after header when retryAfterMs is absent', () => {
            mockAdminAuth.authenticate.mockReturnValue({
                authenticated: false,
                error: 'invalid_token'
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

            const callArgs = mockRes.writeHead.mock.calls[0];
            expect(callArgs[0]).toBe(401);
            expect(callArgs[1]).not.toHaveProperty('retry-after');
        });
    });

    // Covers line 195: adminAuth exists but is disabled
    describe('requiresAdminAuth - adminAuth disabled (line 195)', () => {
        it('should return false when adminAuth exists but is disabled', () => {
            controller._adminAuth = { enabled: false };

            const result = controller.requiresAdminAuth('/logs', 'GET');

            expect(result).toBe(false);
        });

        // Covers line 195: adminAuth is null
        it('should return false when adminAuth is null', () => {
            controller._adminAuth = null;

            const result = controller.requiresAdminAuth('/logs', 'GET');

            expect(result).toBe(false);
        });
    });

    // Covers lines 198-203: SENSITIVE_GET_PATHS matching
    describe('requiresAdminAuth - sensitive path matching (lines 198-203)', () => {
        beforeEach(() => {
            controller._adminAuth = { enabled: true };
        });

        // Covers line 199-200: sensitivePath.endsWith('/') true branch
        it('should require auth for sensitive GET path with trailing slash prefix', () => {
            // '/replay/' is in SENSITIVE_GET_PATHS and ends with '/'
            const result = controller.requiresAdminAuth('/replay/something', 'GET');

            expect(result).toBe(true);
        });

        // Covers line 202: sensitivePath does NOT end with '/'
        it('should require auth for sensitive GET path without trailing slash', () => {
            // '/logs' does not end with '/'
            const result = controller.requiresAdminAuth('/logs', 'GET');

            expect(result).toBe(true);
        });

        // Covers line 202: startsWith check for non-trailing-slash path
        it('should require auth for model-routing path', () => {
            const result = controller.requiresAdminAuth('/model-routing', 'GET');

            expect(result).toBe(true);
        });

        // Covers line 208: HEAD method is not a mutation
        it('should not require auth for HEAD request on admin route', () => {
            // HEAD is not a mutation, and /health is not a sensitive GET path
            const result = controller.requiresAdminAuth('/health', 'HEAD');

            expect(result).toBe(false);
        });

        // Covers line 208: POST is a mutation
        it('should require auth for POST request on admin route', () => {
            const result = controller.requiresAdminAuth('/health', 'POST');

            expect(result).toBe(true);
        });

        // Covers line 208: DELETE is a mutation
        it('should require auth for DELETE request on admin route', () => {
            const result = controller.requiresAdminAuth('/logs', 'DELETE');

            expect(result).toBe(true);
        });

        // Non-sensitive GET on non-sensitive path
        it('should not require auth for GET on non-sensitive admin path', () => {
            const result = controller.requiresAdminAuth('/health', 'GET');

            expect(result).toBe(false);
        });
    });

    // Covers lines 221-230: isAdminRoute path matching
    describe('isAdminRoute - path matching (lines 221-230)', () => {
        // Covers line 221-222: adminPath.endsWith('/') true branch
        it('should return true for path starting with trailing-slash admin path', () => {
            // '/debug/' ends with '/' in ADMIN_PATHS
            const result = controller.isAdminRoute('/debug/something');

            expect(result).toBe(true);
        });

        // Covers line 224: exact path match
        it('should return true for exact path match', () => {
            const result = controller.isAdminRoute('/health');

            expect(result).toBe(true);
        });

        // Covers line 226: /requests dynamic pattern
        it('should return true for /requests path with suffix', () => {
            const result = controller.isAdminRoute('/requests/123');

            expect(result).toBe(true);
        });

        // Covers line 227: /stats/latency-histogram dynamic pattern
        it('should return true for /stats/latency-histogram path with suffix', () => {
            const result = controller.isAdminRoute('/stats/latency-histogram/something');

            expect(result).toBe(true);
        });

        // Not an admin route
        it('should return false for non-admin path', () => {
            const result = controller.isAdminRoute('/v1/chat/completions');

            expect(result).toBe(false);
        });

        // Exact match for non-trailing path
        it('should return true for exact /stats match', () => {
            const result = controller.isAdminRoute('/stats');

            expect(result).toBe(true);
        });

        // Path with trailing slash admin prefix
        it('should return true for /control path', () => {
            const result = controller.isAdminRoute('/control/something');

            expect(result).toBe(true);
        });
    });

    // Covers line 240: debugEndpointsAlwaysRequireAuth !== false
    describe('debugEndpointsRequireAuth - config branch (line 240)', () => {
        it('should return true when debugEndpointsAlwaysRequireAuth is undefined', () => {
            controller._config = { security: {} };

            const result = controller.debugEndpointsRequireAuth();

            expect(result).toBe(true);
        });

        it('should return true when debugEndpointsAlwaysRequireAuth is true', () => {
            controller._config = { security: { debugEndpointsAlwaysRequireAuth: true } };

            const result = controller.debugEndpointsRequireAuth();

            expect(result).toBe(true);
        });

        it('should return false when debugEndpointsAlwaysRequireAuth is false', () => {
            controller._config = { security: { debugEndpointsAlwaysRequireAuth: false } };

            const result = controller.debugEndpointsRequireAuth();

            expect(result).toBe(false);
        });
    });

    // Covers line 249: isDebugEndpoint
    describe('isDebugEndpoint - path check (line 249)', () => {
        it('should return true for /debug path', () => {
            expect(controller.isDebugEndpoint('/debug')).toBe(true);
        });

        it('should return true for /debug/ path', () => {
            expect(controller.isDebugEndpoint('/debug/something')).toBe(true);
        });

        it('should return false for non-debug path', () => {
            expect(controller.isDebugEndpoint('/health')).toBe(false);
        });
    });

    // Covers line 115: headerName fallback when _adminAuth is null
    describe('handleAuthStatus - headerName fallback (line 115)', () => {
        it('should use default headerName when _adminAuth is null', () => {
            controller._adminAuth = null;

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
            expect(responseData.headerName).toBe('x-admin-token');
            expect(responseData.enabled).toBe(false);
        });

        it('should use default headerName when _adminAuth has no headerName', () => {
            controller._adminAuth = { enabled: false };

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
            expect(responseData.headerName).toBe('x-admin-token');
        });
    });

    // Covers line 127 else-if branch: tokensRequired is false
    describe('handleAuthStatus - tokensRequired false path (line 127)', () => {
        it('should skip token validation when tokensRequired is false', () => {
            delete mockAdminAuth.peekAuthentication;
            mockAdminAuth.tokens = new Set(); // Empty set → tokensConfigured = 0 → tokensRequired = false

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

            // extractToken should not be called since tokensRequired is false
            expect(mockAdminAuth.extractToken).not.toHaveBeenCalled();
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.tokensConfigured).toBe(0);
            expect(responseData.tokensRequired).toBe(false);
            expect(responseData.authenticated).toBe(false);
        });
    });

    // Covers line 105: default addAuditEntry arrow function
    describe('constructor - default addAuditEntry function (line 105)', () => {
        it('should use default no-op addAuditEntry when not provided', () => {
            // Create controller without addAuditEntry to use the default () => {}
            const controllerNoAudit = new AuthController({
                adminAuth: null,
                config: { security: {} }
                // addAuditEntry NOT provided - uses default () => {}
            });

            // Call the default function to cover it
            // The default is a no-op, so it should return undefined and not throw
            const result = controllerNoAudit._addAuditEntry('test-event', { foo: 'bar' });

            expect(result).toBeUndefined();
        });

        it('should use default addAuditEntry when explicitly passed undefined', () => {
            const controllerNoAudit = new AuthController({
                adminAuth: null,
                config: { security: {} },
                addAuditEntry: undefined // Explicitly undefined - uses default
            });

            const result = controllerNoAudit._addAuditEntry('another-event');
            expect(result).toBeUndefined();
        });
    });

});
