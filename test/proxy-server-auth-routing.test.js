const http = require('http');
const { ProxyServer } = require('../lib/proxy-server');
const { Config } = require('../lib/config');
const { generateToken } = require('../lib/admin-auth');

function request(port, pathname, options = {}) {
    const method = options.method || 'GET';
    const headers = { connection: 'close', ...(options.headers || {}) };
    const body = options.body || null;
    const keepOpen = options.keepOpen === true;

    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: pathname,
            method,
            headers,
            agent: false
        }, (res) => {
            if (keepOpen) {
                resolve({
                    status: res.statusCode || 0,
                    headers: res.headers
                });
                res.destroy();
                return;
            }

            let raw = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
                resolve({
                    status: res.statusCode || 0,
                    headers: res.headers,
                    text: raw,
                    json: raw ? JSON.parse(raw) : {}
                });
            });
        });

        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

describe('ProxyServer auth routing hardening', () => {
    let proxy;
    let server;
    let port;
    let token;

    beforeAll(async () => {
        token = generateToken();
        const config = new Config({
            port: 0,
            host: '127.0.0.1',
            apiKeys: ['test-key'],
            adminAuth: {
                enabled: true,
                tokens: [token],
                headerName: 'x-admin-token',
                maxAttempts: 100
            },
            security: {
                mode: 'internet',
                debugEndpointsAlwaysRequireAuth: true,
                rateLimit: { enabled: false }
            },
            enableHotReload: false
        });

        proxy = new ProxyServer({ config });
        await proxy.initialize();

        await new Promise((resolve) => {
            server = proxy._createServer();
            server.listen(0, '127.0.0.1', () => {
                port = server.address().port;
                resolve();
            });
        });
    });

    beforeEach(() => {
        if (proxy?.adminAuth?.failedAttempts) {
            proxy.adminAuth.failedAttempts.clear();
        }
    });

    afterAll(async () => {
        if (proxy) {
            await proxy.shutdown();
        } else if (server && server.listening) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test('internet mode requires auth for /stats', async () => {
        const response = await request(port, '/stats');
        expect(response.status).toBe(401);
    });

    test('internet mode requires auth for /requests payload reads', async () => {
        const response = await request(port, '/requests/example/payload');
        expect(response.status).toBe(401);
    });

    test('internet mode requires auth for /events SSE', async () => {
        const response = await request(port, '/events', { keepOpen: true });
        expect(response.status).toBe(401);
    });

    test('internet mode requires auth for /requests/stream SSE', async () => {
        const response = await request(port, '/requests/stream', { keepOpen: true });
        expect(response.status).toBe(401);
    });

    test('debug endpoints require auth by default', async () => {
        const response = await request(port, '/health/deep');
        expect(response.status).toBe(401);
    });

    test('protected reads succeed with a valid token', async () => {
        const response = await request(port, '/stats', {
            headers: { 'x-admin-token': token }
        });

        expect(response.status).toBe(200);
    });

    test('protected SSE succeeds with a valid token', async () => {
        const response = await request(port, '/events', {
            headers: { 'x-admin-token': token },
            keepOpen: true
        });

        expect(response.status).toBe(200);
        expect(String(response.headers['content-type'] || '')).toContain('text/event-stream');
    });

    test('SSE endpoints reject query-string auth after cookie-session hardening', async () => {
        const eventsResponse = await request(port, '/events?admin_token=' + encodeURIComponent(token), {
            keepOpen: true
        });
        const streamResponse = await request(port, '/requests/stream?admin_token=' + encodeURIComponent(token), {
            keepOpen: true
        });

        expect(eventsResponse.status).toBe(401);
        expect(streamResponse.status).toBe(401);
    });

    test('cookie-authenticated session can access protected reads and SSE', async () => {
        const loginResponse = await request(port, '/auth/login', {
            method: 'POST',
            headers: { 'x-admin-token': token }
        });
        const sessionCookie = String(loginResponse.headers['set-cookie'][0] || loginResponse.headers['set-cookie']).split(';')[0];

        const statsResponse = await request(port, '/stats', {
            headers: { cookie: sessionCookie }
        });
        const eventsResponse = await request(port, '/events', {
            headers: { cookie: sessionCookie },
            keepOpen: true
        });
        const streamResponse = await request(port, '/requests/stream', {
            headers: { cookie: sessionCookie },
            keepOpen: true
        });

        expect(loginResponse.status).toBe(200);
        expect(statsResponse.status).toBe(200);
        expect(eventsResponse.status).toBe(200);
        expect(streamResponse.status).toBe(200);
    });
});
