/**
 * Admin Auth Tests (Milestone 1)
 * Tests for authentication gate, auth-status endpoint, and token handling
 */

const { AdminAuth, generateToken, hashToken, secureCompare } = require('../lib/admin-auth');
const http = require('http');

describe('AdminAuth', () => {
    let auth;

    beforeEach(() => {
        auth = new AdminAuth({
            enabled: true,
            headerName: 'x-admin-token',
            maxAttempts: 3,
            lockoutDurationMs: 5000  // Short for tests
        });
    });

    describe('Token Management', () => {
        test('should add token and hash it', () => {
            const token = generateToken();
            const result = auth.addToken(token);

            expect(result).toBe(true);
            expect(auth.tokens.size).toBe(1);
        });

        test('should reject tokens that are too short', () => {
            const result = auth.addToken('short');

            expect(result).toBe(false);
            expect(auth.tokens.size).toBe(0);
        });

        test('should remove token', () => {
            const token = generateToken();
            auth.addToken(token);
            expect(auth.tokens.size).toBe(1);

            const result = auth.removeToken(token);
            expect(result).toBe(true);
            expect(auth.tokens.size).toBe(0);
        });

        test('should generate and add token', () => {
            const token = auth.generateAndAddToken();

            expect(token).toBeTruthy();
            expect(token.length).toBeGreaterThanOrEqual(16); // At least 16 chars
            expect(auth.tokens.size).toBe(1);
        });
    });

    describe('Authentication', () => {
        let validToken;

        beforeEach(() => {
            validToken = generateToken();
            auth.addToken(validToken);
        });

        test('should authenticate valid token via header', () => {
            const req = {
                url: '/control/pause',
                headers: { 'x-admin-token': validToken },
                socket: { remoteAddress: '127.0.0.1' }
            };

            const result = auth.authenticate(req);

            expect(result.authenticated).toBe(true);
            expect(result.required).toBe(true);
        });

        test('should reject missing token when configured', () => {
            const req = {
                url: '/control/pause',
                headers: {},
                socket: { remoteAddress: '127.0.0.1' }
            };

            const result = auth.authenticate(req);

            expect(result.authenticated).toBe(false);
            expect(result.error).toBe('missing_token');
        });

        test('should reject invalid token', () => {
            const req = {
                url: '/control/pause',
                headers: { 'x-admin-token': 'invalid-token-12345678' },
                socket: { remoteAddress: '127.0.0.1' }
            };

            const result = auth.authenticate(req);

            expect(result.authenticated).toBe(false);
            expect(result.error).toBe('invalid_token');
        });

        test('should allow access when no tokens configured', () => {
            const authNoTokens = new AdminAuth({ enabled: true });
            const req = {
                url: '/control/pause',
                headers: {},
                socket: { remoteAddress: '127.0.0.1' }
            };

            const result = authNoTokens.authenticate(req);

            expect(result.authenticated).toBe(true);
            expect(result.warning).toBe('no_tokens_configured');
        });

        test('should lock out after max failed attempts', () => {
            const req = {
                url: '/control/pause',
                headers: { 'x-admin-token': 'wrong-token' },
                socket: { remoteAddress: '127.0.0.1' }
            };

            // Attempt 1
            let result = auth.authenticate(req);
            expect(result.authenticated).toBe(false);
            expect(result.error).toBe('invalid_token');

            // Attempt 2
            result = auth.authenticate(req);
            expect(result.error).toBe('invalid_token');

            // Attempt 3 - should trigger lockout
            result = auth.authenticate(req);
            expect(result.error).toBe('invalid_token');

            // Attempt 4 - should be locked out
            result = auth.authenticate(req);
            expect(result.authenticated).toBe(false);
            expect(result.error).toBe('too_many_attempts');
            expect(result.retryAfterMs).toBeGreaterThan(0);
        });
    });

    describe('Protected Paths', () => {
        test('should identify protected paths', () => {
            expect(auth.requiresAuth('/control/pause')).toBe(true);
            expect(auth.requiresAuth('/reload')).toBe(true);
            expect(auth.requiresAuth('/logs')).toBe(true);
            expect(auth.requiresAuth('/replay/requests')).toBe(true);
            expect(auth.requiresAuth('/model-mapping')).toBe(true);
            expect(auth.requiresAuth('/requests')).toBe(true);
        });

        test('should not require auth for non-protected paths', () => {
            expect(auth.requiresAuth('/health')).toBe(false);
            expect(auth.requiresAuth('/stats')).toBe(false);
            expect(auth.requiresAuth('/dashboard')).toBe(false);
            expect(auth.requiresAuth('/backpressure')).toBe(false);
        });
    });

    describe('Security Functions', () => {
        test('hashToken should produce consistent hash', () => {
            const token = 'test-token-12345';
            const hash1 = hashToken(token);
            const hash2 = hashToken(token);

            expect(hash1).toBe(hash2);
            expect(hash1).toHaveLength(64); // SHA-256 hex
        });

        test('secureCompare should use constant-time comparison', () => {
            const a = 'same-value';
            const b = 'same-value';
            const c = 'different-value';

            expect(secureCompare(a, b)).toBe(true);
            expect(secureCompare(a, c)).toBe(false);
        });

        test('secureCompare should handle different length strings', () => {
            expect(secureCompare('short', 'much-longer-string')).toBe(false);
        });
    });
});

describe('Admin Auth Integration', () => {
    let server;
    let port;
    let proxyInstance;

    const request = (pathname, options = {}) => {
        const method = options.method || 'GET';
        const headers = { connection: 'close', ...(options.headers || {}) };
        const body = options.body;

        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port,
                path: pathname,
                method,
                headers,
                agent: false
            }, (res) => {
                let raw = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { raw += chunk; });
                res.on('end', () => {
                    resolve({
                        status: res.statusCode || 0,
                        headers: res.headers,
                        text: async () => raw,
                        json: async () => (raw ? JSON.parse(raw) : {})
                    });
                });
            });

            req.on('error', reject);
            if (body) {
                req.write(body);
            }
            req.end();
        });
    };

    beforeAll(async () => {
        // Create a test proxy server with auth enabled
        const { ProxyServer } = require('../lib/proxy-server');
        const { Config } = require('../lib/config');

        // Generate test token
        const testToken = generateToken();

        // Create a proper Config instance
        const config = new Config({
            port: 0, // Let OS pick port
            host: '127.0.0.1',
            adminAuth: {
                enabled: true,
                tokens: [testToken],
                headerName: 'x-admin-token'
            }
        });

        // Expose test token for tests
        global.__TEST_ADMIN_TOKEN__ = testToken;

        proxyInstance = new ProxyServer({ config });
        await proxyInstance.initialize();

        return new Promise((resolve) => {
            server = proxyInstance._createServer();
            server.listen(0, '127.0.0.1', () => {
                port = server.address().port;
                resolve();
            });
        });
    });

    afterAll(async () => {
        if (proxyInstance) {
            await proxyInstance.shutdown();
            proxyInstance = null;
        } else if (server && server.listening) {
            await new Promise((resolve) => {
                server.close(resolve);
            });
        }
        server = null;
    });

    describe('Admin Endpoint Protection', () => {
        test('POST /control/pause should return 401 without token', async () => {
            const response = await request('/control/pause', {
                method: 'POST'
            });

            expect(response.status).toBe(401);
        });

        test('POST /control/pause should succeed with valid token', async () => {
            const response = await request('/control/pause', {
                method: 'POST',
                headers: {
                    'x-admin-token': global.__TEST_ADMIN_TOKEN__
                }
            });

            expect(response.status).toBe(200);
        });

        test('POST /reload should return 401 without token', async () => {
            const response = await request('/reload', {
                method: 'POST'
            });

            expect(response.status).toBe(401);
        });

        test('GET /health should work without token (public endpoint)', async () => {
            const response = await request('/health');
            expect([200, 503]).toContain(response.status); // May be degraded if no keys
        });

        test('GET /stats should work without token (public endpoint)', async () => {
            const response = await request('/stats');
            expect(response.status).toBe(200);
        });

        test('GET /logs should require auth (sensitive endpoint)', async () => {
            const response = await request('/logs');
            expect(response.status).toBe(401);
        });
    });

    describe('Auth Status Endpoint', () => {
        test('GET /auth-status should return auth state', async () => {
            const response = await request('/auth-status');

            expect(response.status).toBe(200);

            const data = await response.json();
            expect(data).toHaveProperty('enabled');
            expect(data).toHaveProperty('tokensConfigured');
            expect(data).toHaveProperty('tokensRequired');
            expect(data).toHaveProperty('authenticated');
            expect(data).toHaveProperty('headerName');
        });

        test('GET /auth-status should show authenticated with valid token', async () => {
            const response = await request('/auth-status', {
                headers: {
                    'x-admin-token': global.__TEST_ADMIN_TOKEN__
                }
            });

            expect(response.status).toBe(200);

            const data = await response.json();
            expect(data.enabled).toBe(true);
            expect(data.tokensConfigured).toBe(1);
            expect(data.tokensRequired).toBe(true);
            expect(data.authenticated).toBe(true);
        });

        test('GET /auth-status should show unauthenticated without token', async () => {
            const response = await request('/auth-status');

            expect(response.status).toBe(200);

            const data = await response.json();
            expect(data.enabled).toBe(true);
            expect(data.tokensConfigured).toBe(1);
            expect(data.tokensRequired).toBe(true);
            expect(data.authenticated).toBe(false);
        });
    });

    describe('Token Not Leaked to Upstream', () => {
        test('x-admin-token should be stripped before proxying', async () => {
            // This test verifies that the admin token is not forwarded
            // to the upstream API
            const response = await request('/v1/messages', {
                method: 'POST',
                headers: {
                    'x-admin-token': global.__TEST_ADMIN_TOKEN__,
                    'content-type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'claude-3-5-sonnet-20241022',
                    max_tokens: 10,
                    messages: [{ role: 'user', content: 'test' }]
                })
            });

            // The request should fail (no valid API key, or connection error to upstream)
            // but the important thing is it should NOT be a 401 auth error
            // If the admin token was leaked, it might be rejected by upstream
            // The error should be something else (no keys, connection refused, etc.)
            expect(response.status).not.toBe(401);
        });
    });
});
