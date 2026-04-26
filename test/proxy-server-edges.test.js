'use strict';

/**
 * Edge-case tests for untested internal handlers in ProxyServer.
 *
 * Covers: auth login/logout, audit log, security headers, SSE connection
 * limits, CORS headers, debug endpoint identification, dashboard path
 * traversal, account details, and internet-mode auth requirements.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { ProxyServer } = require('../lib/proxy-server');
const { Config, resetConfig } = require('../lib/config');
const { resetLogger } = require('../lib/logger');
const { generateToken } = require('../lib/admin-auth');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Make an HTTP request returning { status, headers, text, json }.
 */
function request(port, pathname, options = {}) {
    const method = options.method || 'GET';
    const headers = { connection: 'close', ...(options.headers || {}) };
    const body = options.body || null;

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
                let json = {};
                try { json = JSON.parse(raw); } catch { /* non-JSON is fine */ }
                resolve({
                    status: res.statusCode || 0,
                    headers: res.headers,
                    text: raw,
                    json
                });
            });
        });

        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ProxyServer edge handlers', () => {
    let testDir;
    let proxy;
    let port;
    let adminToken;

    beforeAll(async () => {
        resetConfig();
        resetLogger();

        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-edges-'));
        fs.writeFileSync(
            path.join(testDir, 'test-keys.json'),
            JSON.stringify({
                keys: ['testkey1.secret1'],
                baseUrl: 'https://api.z.ai'
            })
        );
        fs.writeFileSync(path.join(testDir, 'test-stats.json'), '{}');

        adminToken = generateToken();

        const config = new Config({
            configDir: testDir,
            keysFile: 'test-keys.json',
            statsFile: 'test-stats.json',
            useCluster: false,
            port: 0,
            host: '127.0.0.1',
            enableHotReload: false,
            usageMonitor: { enabled: false },
            adminAuth: {
                enabled: true,
                tokens: [adminToken],
                headerName: 'x-admin-token',
                maxAttempts: 100
            },
            security: {
                mode: 'internet',
                debugEndpointsAlwaysRequireAuth: true,
                debugEndpoints: ['/debug/', '/health/deep', '/traces'],
                rateLimit: { enabled: true, maxSsePerIp: 2, maxSseTotal: 4, apiRpm: 10000, dashboardRpm: 10000 },
                auditLog: { enabled: true, maxEntries: 500 },
                cors: { allowedOrigins: ['https://allowed.example.com', 'https://other.example.com'] },
                internetModeProtectedReads: [
                    '/dashboard', '/events', '/requests', '/requests/stream',
                    '/logs', '/stats', '/stats/cost', '/stats/latency-histogram',
                    '/model-mapping', '/compare', '/predictions'
                ]
            }
        });

        proxy = new ProxyServer({ config });
        await proxy.initialize();

        await new Promise((resolve) => {
            proxy._createServer();
            proxy.server.listen(0, '127.0.0.1', () => {
                port = proxy.server.address().port;
                resolve();
            });
        });
    });

    beforeEach(() => {
        // Clear failed attempts so lockouts don't leak between tests
        if (proxy?.adminAuth?.failedAttempts) {
            proxy.adminAuth.failedAttempts.clear();
        }
    });

    afterAll(async () => {
        if (proxy) {
            await proxy.shutdown();
        }
        if (testDir) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    // -----------------------------------------------------------------------
    // 1. Auth login / logout
    // -----------------------------------------------------------------------
    describe('auth login / logout', () => {
        test('POST /auth/login with valid token returns 200 and set-cookie', async () => {
            const res = await request(port, '/auth/login', {
                method: 'POST',
                headers: { 'x-admin-token': adminToken }
            });
            expect(res.status).toBe(200);
            expect(res.json.authenticated).toBe(true);
            expect(res.headers['set-cookie']).toBeDefined();
        });

        test('POST /auth/login with invalid token returns 401', async () => {
            const res = await request(port, '/auth/login', {
                method: 'POST',
                headers: { 'x-admin-token': 'bad-token-value' }
            });
            expect(res.status).toBe(401);
        });

        test('GET /auth/login returns 405', async () => {
            const res = await request(port, '/auth/login', {
                method: 'GET',
                headers: { 'x-admin-token': adminToken }
            });
            expect(res.status).toBe(405);
        });

        test('POST /auth/logout returns 200 with authenticated false', async () => {
            // First login to get a session
            await request(port, '/auth/login', {
                method: 'POST',
                headers: { 'x-admin-token': adminToken }
            });

            const res = await request(port, '/auth/logout', {
                method: 'POST',
                headers: { 'x-admin-token': adminToken }
            });
            expect(res.status).toBe(200);
            expect(res.json.authenticated).toBe(false);
            expect(res.headers['set-cookie']).toBeDefined();
        });

        test('GET /auth/logout returns 405', async () => {
            const res = await request(port, '/auth/logout', {
                method: 'GET',
                headers: { 'x-admin-token': adminToken }
            });
            expect(res.status).toBe(405);
        });
    });

    // -----------------------------------------------------------------------
    // 2. Audit log & clear-logs
    // -----------------------------------------------------------------------
    describe('audit log', () => {
        test('in-memory audit log captures entries via _addAuditEntry', () => {
            // Trigger an auditable action (unauthenticated request in internet mode)
            const sizeBefore = proxy._auditLog.size;
            proxy._addAuditEntry('test_event', { ip: '10.0.0.1', detail: 'manual' });
            expect(proxy._auditLog.size).toBe(sizeBefore + 1);
            const entries = proxy._auditLog.toArray();
            const last = entries[entries.length - 1];
            expect(last.event).toBe('test_event');
            expect(last.ip).toBe('10.0.0.1');
        });

        test('_handleAuditLog returns entries with valid auth', () => {
            // Seed a few entries
            proxy._addAuditEntry('edge_test_1', { ip: '10.0.0.1' });
            proxy._addAuditEntry('edge_test_2', { ip: '10.0.0.2' });

            // Invoke handler directly with mock req/res
            const mockReq = {
                url: '/audit-log',
                headers: { host: 'localhost', 'x-admin-token': adminToken },
                socket: { remoteAddress: '127.0.0.1' }
            };
            // Make adminAuth.authenticate accept our request
            const authResult = proxy.adminAuth.authenticate(mockReq, { forceRequired: true });
            expect(authResult.authenticated).toBe(true);

            let statusCode, body;
            const mockRes = {
                writeHead(code) { statusCode = code; },
                end(data) { body = data; }
            };
            proxy._handleAuditLog(mockReq, mockRes);
            expect(statusCode).toBe(200);
            const json = JSON.parse(body);
            expect(json).toHaveProperty('count');
            expect(json).toHaveProperty('total');
            expect(json).toHaveProperty('entries');
            expect(json.entries.length).toBeGreaterThan(0);
        });

        test('_handleAuditLog rejects without auth', () => {
            const mockReq = {
                url: '/audit-log',
                headers: { host: 'localhost' }, // no token
                socket: { remoteAddress: '127.0.0.1' }
            };
            let statusCode;
            const mockRes = {
                writeHead(code) { statusCode = code; },
                end() {}
            };
            proxy._handleAuditLog(mockReq, mockRes);
            expect(statusCode).toBe(401);
        });

        test('POST /control/clear-logs clears logs', async () => {
            const res = await request(port, '/control/clear-logs', {
                method: 'POST',
                headers: { 'x-admin-token': adminToken }
            });
            expect(res.status).toBe(200);
            expect(res.json.status).toBe('logs_cleared');
        });

        test('GET /control/clear-logs returns 405', async () => {
            const res = await request(port, '/control/clear-logs', {
                method: 'GET',
                headers: { 'x-admin-token': adminToken }
            });
            expect(res.status).toBe(405);
        });
    });

    // -----------------------------------------------------------------------
    // 3. Security headers
    // -----------------------------------------------------------------------
    describe('security headers', () => {
        test('GET /dashboard includes X-Frame-Options', async () => {
            const res = await request(port, '/dashboard', {
                headers: { 'x-admin-token': adminToken }
            });
            expect(res.status).toBe(200);
            expect(res.headers['x-frame-options']).toBe('DENY');
        });

        test('GET /dashboard includes X-Content-Type-Options', async () => {
            const res = await request(port, '/dashboard', {
                headers: { 'x-admin-token': adminToken }
            });
            expect(res.headers['x-content-type-options']).toBe('nosniff');
        });

        test('GET /dashboard includes X-XSS-Protection', async () => {
            const res = await request(port, '/dashboard', {
                headers: { 'x-admin-token': adminToken }
            });
            expect(res.headers['x-xss-protection']).toBe('1; mode=block');
        });

        test('GET /dashboard includes Referrer-Policy', async () => {
            const res = await request(port, '/dashboard', {
                headers: { 'x-admin-token': adminToken }
            });
            expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
        });

        test('GET /dashboard includes Permissions-Policy', async () => {
            const res = await request(port, '/dashboard', {
                headers: { 'x-admin-token': adminToken }
            });
            expect(res.headers['permissions-policy']).toBeDefined();
        });

        test('_getSecurityHeaders returns correct defaults', () => {
            const hdrs = proxy._getSecurityHeaders();
            expect(hdrs['x-frame-options']).toBe('DENY');
            expect(hdrs['x-content-type-options']).toBe('nosniff');
            expect(hdrs['x-xss-protection']).toBe('1; mode=block');
        });
    });

    // -----------------------------------------------------------------------
    // 4. SSE connection limits
    // -----------------------------------------------------------------------
    describe('SSE connection limits (_checkSseLimit)', () => {
        test('allows connection when under limit', () => {
            const result = proxy._checkSseLimit('10.0.0.1');
            expect(result.allowed).toBe(true);
        });

        test('denies when per-IP limit reached', () => {
            const testIp = '10.99.99.99';
            // Simulate existing connections (maxSsePerIp = 2)
            proxy._ssePerIp.set(testIp, new Set(['c1', 'c2']));

            try {
                const result = proxy._checkSseLimit(testIp);
                expect(result.allowed).toBe(false);
                expect(result.reason).toContain('per IP');
            } finally {
                proxy._ssePerIp.delete(testIp);
            }
        });

        test('denies when total SSE limit reached', () => {
            const originalStream = proxy.sseStreamClients.size;
            const originalEvent = proxy.sseEventClients.size;

            // Fill up to maxSseTotal (4)
            const fakeClients = [];
            for (let i = 0; i < 4; i++) {
                const fake = { id: `fake-${i}`, res: {}, ip: `192.168.${i}.1` };
                proxy.sseStreamClients.add(fake);
                fakeClients.push(fake);
            }

            try {
                const result = proxy._checkSseLimit('10.0.0.1');
                expect(result.allowed).toBe(false);
                expect(result.reason).toContain('Max SSE connections reached');
            } finally {
                for (const fc of fakeClients) {
                    proxy.sseStreamClients.delete(fc);
                }
            }
        });
    });

    // -----------------------------------------------------------------------
    // 5. CORS headers
    // -----------------------------------------------------------------------
    describe('CORS headers (_getCorsHeaders)', () => {
        test('returns allow-origin for allowed origin', () => {
            const fakeReq = { headers: { origin: 'https://allowed.example.com' } };
            const hdrs = proxy._getCorsHeaders(fakeReq);
            expect(hdrs['access-control-allow-origin']).toBe('https://allowed.example.com');
            expect(hdrs['vary']).toBe('Origin');
        });

        test('returns empty object for disallowed origin', () => {
            const fakeReq = { headers: { origin: 'https://evil.example.com' } };
            const hdrs = proxy._getCorsHeaders(fakeReq);
            expect(hdrs).toEqual({});
        });

        test('returns empty when no origin header sent', () => {
            const fakeReq = { headers: {} };
            const hdrs = proxy._getCorsHeaders(fakeReq);
            expect(hdrs).toEqual({});
        });

        test('wildcard config returns * for any origin', () => {
            const saved = proxy.config.security.cors;
            proxy.config.security.cors = { allowedOrigins: ['*'] };
            try {
                const fakeReq = { headers: { origin: 'https://anything.test' } };
                const hdrs = proxy._getCorsHeaders(fakeReq);
                expect(hdrs['access-control-allow-origin']).toBe('*');
            } finally {
                proxy.config.security.cors = saved;
            }
        });

        test('no allowedOrigins config returns empty for any origin', () => {
            const saved = proxy.config.security.cors;
            proxy.config.security.cors = {};
            try {
                const fakeReq = { headers: { origin: 'https://any.test' } };
                const hdrs = proxy._getCorsHeaders(fakeReq);
                expect(hdrs).toEqual({});
            } finally {
                proxy.config.security.cors = saved;
            }
        });
    });

    // -----------------------------------------------------------------------
    // 6. Debug endpoint auth (_isDebugEndpoint)
    // -----------------------------------------------------------------------
    describe('debug endpoint identification (_isDebugEndpoint)', () => {
        test('/debug/anything is a debug endpoint', () => {
            expect(proxy._isDebugEndpoint('/debug/foo')).toBe(true);
            expect(proxy._isDebugEndpoint('/debug/bar/baz')).toBe(true);
        });

        test('/traces is a debug endpoint', () => {
            expect(proxy._isDebugEndpoint('/traces')).toBe(true);
        });

        test('/traces/123 is a debug endpoint (prefix match)', () => {
            expect(proxy._isDebugEndpoint('/traces/123')).toBe(true);
        });

        test('/health/deep is a debug endpoint', () => {
            expect(proxy._isDebugEndpoint('/health/deep')).toBe(true);
        });

        test('/health is NOT a debug endpoint', () => {
            expect(proxy._isDebugEndpoint('/health')).toBe(false);
        });

        test('/stats is NOT a debug endpoint', () => {
            expect(proxy._isDebugEndpoint('/stats')).toBe(false);
        });

        test('/dashboard is NOT a debug endpoint', () => {
            expect(proxy._isDebugEndpoint('/dashboard')).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // 7. Dashboard asset serving — path traversal blocked
    // -----------------------------------------------------------------------
    describe('dashboard asset path traversal protection', () => {
        test('../../etc/passwd is blocked (404 via whitelist)', async () => {
            const res = await request(port, '/dashboard/../../etc/passwd', {
                headers: { 'x-admin-token': adminToken }
            });
            // The whitelist approach means anything not listed returns 404
            expect(res.status).toBe(404);
        });

        test('/dashboard/../proxy-server.js is blocked', async () => {
            const res = await request(port, '/dashboard/../proxy-server.js', {
                headers: { 'x-admin-token': adminToken }
            });
            expect(res.status).toBe(404);
        });

        test('/dashboard/vendor/../../keys.json is blocked', async () => {
            const res = await request(port, '/dashboard/vendor/../../keys.json', {
                headers: { 'x-admin-token': adminToken }
            });
            expect(res.status).toBe(404);
        });

        test('known whitelisted asset returns 200', async () => {
            const res = await request(port, '/dashboard/dashboard-utils.js', {
                headers: { 'x-admin-token': adminToken }
            });
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toContain('javascript');
        });

        test('unknown asset returns 404', async () => {
            const res = await request(port, '/dashboard/vendor/nope.js', {
                headers: { 'x-admin-token': adminToken }
            });
            expect(res.status).toBe(404);
        });
    });

    // -----------------------------------------------------------------------
    // 8. Account details
    // -----------------------------------------------------------------------
    describe('account details', () => {
        test('GET /stats/account-details returns 404 when usageMonitor is null', async () => {
            // Save and nullify usageMonitor
            const saved = proxy.usageMonitor;
            proxy.usageMonitor = null;

            try {
                const res = await request(port, '/stats/account-details', {
                    headers: { 'x-admin-token': adminToken }
                });
                expect(res.status).toBe(404);
            } finally {
                proxy.usageMonitor = saved;
            }
        });

        test('GET /stats/account-details returns data when usageMonitor exists', async () => {
            // Temporarily install a mock usageMonitor
            const saved = proxy.usageMonitor;
            const mockDetails = {
                plan: 'pro',
                usage: { inputTokens: 1000, outputTokens: 500 }
            };
            proxy.usageMonitor = { getDetails: () => ({ ...mockDetails }) };

            try {
                const res = await request(port, '/stats/account-details', {
                    headers: { 'x-admin-token': adminToken }
                });
                expect(res.status).toBe(200);
                expect(res.json.plan).toBe('pro');
                expect(res.json).toHaveProperty('keyHealth');
            } finally {
                proxy.usageMonitor = saved;
            }
        });
    });

    // -----------------------------------------------------------------------
    // 9. Internet mode auth (_requiresAuthInInternetMode)
    // -----------------------------------------------------------------------
    describe('internet mode auth (_requiresAuthInInternetMode)', () => {
        test('/stats requires auth in internet mode', () => {
            expect(proxy._requiresAuthInInternetMode('/stats')).toBe(true);
        });

        test('/dashboard requires auth in internet mode', () => {
            expect(proxy._requiresAuthInInternetMode('/dashboard')).toBe(true);
        });

        test('/events requires auth in internet mode', () => {
            expect(proxy._requiresAuthInInternetMode('/events')).toBe(true);
        });

        test('/requests/stream requires auth in internet mode', () => {
            expect(proxy._requiresAuthInInternetMode('/requests/stream')).toBe(true);
        });

        test('/health does NOT require auth in internet mode', () => {
            expect(proxy._requiresAuthInInternetMode('/health')).toBe(false);
        });

        test('/v1/messages does NOT require auth in internet mode', () => {
            expect(proxy._requiresAuthInInternetMode('/v1/messages')).toBe(false);
        });

        test('returns false when mode is not internet', () => {
            const saved = proxy.config.security.mode;
            proxy.config.security.mode = 'local';
            try {
                expect(proxy._requiresAuthInInternetMode('/stats')).toBe(false);
            } finally {
                proxy.config.security.mode = saved;
            }
        });
    });
});
