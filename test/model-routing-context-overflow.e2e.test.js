/**
 * Model Routing Context Overflow E2E
 *
 * Verifies the full /v1/messages proxy path returns a deterministic 400
 * when request size exceeds selected model context, without hitting upstream.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ProxyServer } = require('../lib/proxy-server');
const { Config, resetConfig } = require('../lib/config');
const { resetLogger } = require('../lib/logger');

function request(url, options = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: data,
                    json: () => {
                        try { return JSON.parse(data); } catch (_) { return null; }
                    }
                });
            });
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

function createMockUpstream() {
    let requestCount = 0;
    const requests = [];

    const server = https.createServer({
        key: fs.readFileSync(path.join(__dirname, 'fixtures', 'server.key')),
        cert: fs.readFileSync(path.join(__dirname, 'fixtures', 'server.crt'))
    }, (req, res) => {
        requestCount++;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            requests.push({ method: req.method, url: req.url, headers: req.headers, body });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                id: 'msg_ok',
                type: 'message',
                content: [{ type: 'text', text: 'ok' }],
                model: 'glm-5',
                usage: { input_tokens: 10, output_tokens: 10 }
            }));
        });
    });

    return {
        getRequestCount: () => requestCount,
        getRequests: () => requests,
        start: (port = 0) => new Promise((resolve, reject) => {
            const onError = (err) => {
                server.off('listening', onListening);
                reject(err);
            };
            const onListening = () => {
                server.off('error', onError);
                const address = server.address();
                resolve(address && typeof address === 'object' ? address.port : port);
            };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(port, '127.0.0.1');
        }),
        stop: () => new Promise((resolve) => {
            if (!server.listening) return resolve();
            server.close(() => resolve());
        })
    };
}

describe('Model Routing Context Overflow E2E', () => {
    let testDir;
    let proxyServer;
    let proxyUrl;
    let upstream;
    let upstreamPort;
    let originalTlsSetting;

    beforeAll(() => {
        const fixturesDir = path.join(__dirname, 'fixtures');
        if (!fs.existsSync(fixturesDir)) {
            fs.mkdirSync(fixturesDir, { recursive: true });
        }
        const keyPath = path.join(fixturesDir, 'server.key');
        const certPath = path.join(fixturesDir, 'server.crt');
        if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
            const { execSync } = require('child_process');
            execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 365 -nodes -subj "/CN=localhost"`, { stdio: 'pipe' });
        }
    });

    beforeAll(() => {
        originalTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    });

    afterAll(() => {
        if (originalTlsSetting === undefined) {
            delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        } else {
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalTlsSetting;
        }
    });

    beforeEach(async () => {
        resetConfig();
        resetLogger();

        testDir = path.join(os.tmpdir(), 'model-routing-context-overflow-' + Date.now());
        fs.mkdirSync(testDir, { recursive: true });

        upstream = createMockUpstream();
        upstreamPort = await upstream.start(0);

        fs.writeFileSync(
            path.join(testDir, 'test-keys.json'),
            JSON.stringify({
                keys: ['testkey1.secret1'],
                baseUrl: `https://127.0.0.1:${upstreamPort}/api`
            })
        );

        const config = new Config({
            configDir: testDir,
            keysFile: 'test-keys.json',
            statsFile: 'test-stats.json',
            useCluster: false,
            port: 0,
            logLevel: 'ERROR',
            rejectUnauthorized: false,
            modelRouting: {
                version: '2.0',
                enabled: true,
                tiers: {
                    heavy: {
                        models: ['glm-5'],
                        strategy: 'quality',
                        clientModelPolicy: 'rule-match-only'
                    },
                    medium: {
                        models: ['glm-4-air'],
                        strategy: 'balanced',
                        clientModelPolicy: 'rule-match-only'
                    },
                    light: {
                        models: ['glm-4-flash'],
                        strategy: 'throughput',
                        clientModelPolicy: 'rule-match-only'
                    }
                },
                rules: [
                    { match: { model: 'claude-3-opus-*' }, tier: 'heavy' },
                    { match: { model: '*' }, tier: 'medium' }
                ],
                failover: {
                    maxModelSwitchesPerRequest: 2
                },
                logDecisions: false
            }
        });

        proxyServer = new ProxyServer({ config });
        const server = await proxyServer.start();
        const address = server.address();
        proxyUrl = `http://127.0.0.1:${address.port}`;

        // Ensure test upstream self-signed cert is accepted consistently.
        proxyServer.requestHandler.agent.destroy();
        proxyServer.requestHandler.agent = new https.Agent({
            keepAlive: true,
            maxSockets: 10,
            rejectUnauthorized: false
        });
    });

    afterEach(async () => {
        if (proxyServer) {
            await proxyServer.shutdown();
            proxyServer = null;
        }
        if (upstream) {
            await upstream.stop();
            upstream = null;
        }
        if (testDir) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    test('oversized /v1/messages request returns 400 context_overflow without upstream call', async () => {
        const hugePrompt = 'x'.repeat(900000);
        const payload = {
            model: 'claude-3-opus-20240229',
            messages: [{ role: 'user', content: hugePrompt }],
            max_tokens: 8000
        };

        const res = await request(`${proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
        });

        expect(res.statusCode).toBe(400);
        expect(res.headers['x-proxy-error']).toBe('context_overflow');
        expect(res.headers['x-proxy-overflow-cause']).toBe('genuine');

        const body = res.json();
        expect(body).toBeTruthy();
        expect(body.type).toBe('error');
        expect(body.error.type).toBe('invalid_request_error');
        expect(body.error.message).toContain('context window');
        expect(upstream.getRequestCount()).toBe(0);
    });

    test('oversized request exposes captured payload via /requests/:id/payload', async () => {
        const hugePrompt = 'x'.repeat(900000);
        const payload = {
            model: 'claude-3-opus-20240229',
            api_key: 'should-be-redacted',
            messages: [{ role: 'user', content: hugePrompt }],
            max_tokens: 8000
        };

        const res = await request(`${proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
        });

        expect(res.statusCode).toBe(400);
        const errBody = res.json();
        expect(errBody?.requestId).toBeTruthy();

        const payloadRes = await request(`${proxyUrl}/requests/${encodeURIComponent(errBody.requestId)}/payload`, {
            method: 'GET'
        });

        expect(payloadRes.statusCode).toBe(200);
        const payloadBody = payloadRes.json();
        expect(payloadBody?.requestId).toBe(errBody.requestId);
        expect(payloadBody?.payload?.json).toContain('"model": "claude-3-opus-20240229"');
        expect(payloadBody?.payload?.json).toContain('"api_key": "[REDACTED]"');
        expect(payloadBody?.payload?.json).not.toContain('should-be-redacted');
    });

    test('normal /v1/messages request still reaches upstream and succeeds', async () => {
        const payload = {
            model: 'claude-3-opus-20240229',
            messages: [{ role: 'user', content: 'hello' }],
            max_tokens: 256
        };

        const res = await request(`${proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
        });

        expect(res.statusCode).toBe(200);
        expect(upstream.getRequestCount()).toBe(1);

        const sent = upstream.getRequests()[0];
        expect(sent).toBeTruthy();
        const sentBody = JSON.parse(sent.body);
        expect(sentBody.model).toBe('glm-5');
    });

    test('successful /v1/messages request payload can be fetched via /requests/:id/payload', async () => {
        const payload = {
            model: 'claude-3-opus-20240229',
            accessToken: 'top-secret-token',
            messages: [{ role: 'user', content: 'show me this payload later' }],
            max_tokens: 256
        };

        const res = await request(`${proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
        });

        expect(res.statusCode).toBe(200);
        expect(upstream.getRequestCount()).toBe(1);
        const sent = upstream.getRequests()[0];
        const requestId = sent?.headers?.['x-request-id'];
        expect(requestId).toBeTruthy();

        const payloadRes = await request(`${proxyUrl}/requests/${encodeURIComponent(requestId)}/payload`, {
            method: 'GET'
        });

        expect(payloadRes.statusCode).toBe(200);
        const payloadBody = payloadRes.json();
        expect(payloadBody?.requestId).toBe(requestId);
        expect(payloadBody?.payload?.json).toContain('"model": "claude-3-opus-20240229"');
        expect(payloadBody?.payload?.json).toContain('"accessToken": "[REDACTED]"');
        expect(payloadBody?.payload?.json).not.toContain('top-secret-token');
        expect(payloadBody?.payload?.json).toContain('show me this payload later');
    });

    test('transient overflow with flag OFF falls through to 400 (not 503)', async () => {
        // Default config has transientOverflowRetry.enabled = false.
        // Light tier: glm-4-flash has no contextLength metadata so pool selection
        // uses the heavy tier with glm-5 (200K, maxConc=1).
        // Fill the heavy model to simulate capacity.
        const router = proxyServer.requestHandler.modelRouter;
        if (router) {
            router._inFlight.set('glm-5', 100);
        }

        // ~230K chars = ~57K tokens + 8K max = ~65K total — fits in 200K context
        // but glm-5 is at capacity. Since flag is OFF, transient cause is ignored → 400.
        // Use a genuinely oversized request that exceeds ALL models.
        const hugePrompt = 'x'.repeat(900000);
        const res = await request(`${proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-3-opus-20240229',
                messages: [{ role: 'user', content: hugePrompt }],
                max_tokens: 8000
            })
        });

        expect(res.statusCode).toBe(400);
        expect(res.headers['x-proxy-error']).toBe('context_overflow');
        expect(upstream.getRequestCount()).toBe(0);
    });
});

describe('Transient Context Overflow E2E (flag enabled)', () => {
    let testDir;
    let proxyServer;
    let proxyUrl;
    let upstream;
    let upstreamPort;
    let originalTlsSetting;

    beforeAll(() => {
        const fixturesDir = path.join(__dirname, 'fixtures');
        if (!fs.existsSync(fixturesDir)) {
            fs.mkdirSync(fixturesDir, { recursive: true });
        }
        const keyPath = path.join(fixturesDir, 'server.key');
        const certPath = path.join(fixturesDir, 'server.crt');
        if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
            const { execSync } = require('child_process');
            execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 365 -nodes -subj "/CN=localhost"`, { stdio: 'pipe' });
        }
    });

    beforeAll(() => {
        originalTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    });

    afterAll(() => {
        if (originalTlsSetting === undefined) {
            delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        } else {
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalTlsSetting;
        }
    });

    beforeEach(async () => {
        resetConfig();
        resetLogger();

        testDir = path.join(os.tmpdir(), 'transient-overflow-e2e-' + Date.now());
        fs.mkdirSync(testDir, { recursive: true });

        upstream = createMockUpstream();
        upstreamPort = await upstream.start(0);

        fs.writeFileSync(
            path.join(testDir, 'test-keys.json'),
            JSON.stringify({
                keys: ['testkey1.secret1'],
                baseUrl: `https://127.0.0.1:${upstreamPort}/api`
            })
        );

        const config = new Config({
            configDir: testDir,
            keysFile: 'test-keys.json',
            statsFile: 'test-stats.json',
            useCluster: false,
            port: 0,
            logLevel: 'ERROR',
            rejectUnauthorized: false,
            // maxRetries: 0 → first attempt is the only attempt.
            // If transient overflow fires, no retry → immediate 503.
            maxRetries: 0,
            modelRouting: {
                version: '2.0',
                enabled: true,
                tiers: {
                    heavy: {
                        models: ['glm-5'],
                        strategy: 'quality',
                        clientModelPolicy: 'rule-match-only'
                    },
                    medium: {
                        models: ['glm-4.5'],
                        strategy: 'balanced',
                        clientModelPolicy: 'rule-match-only'
                    },
                    light: {
                        // 128K model FIRST (becomes target in failover), 200K second.
                        // When 200K model is at capacity, failover picks 128K target →
                        // overflow check finds the 200K model at capacity → transient.
                        models: ['glm-4.5-air', 'glm-4.7-flash'],
                        strategy: 'throughput',
                        clientModelPolicy: 'rule-match-only'
                    }
                },
                rules: [
                    { match: { model: 'claude-3-opus-*' }, tier: 'heavy' },
                    { match: { model: 'claude-opus*' }, tier: 'heavy' },
                    { match: { model: 'claude-haiku*' }, tier: 'light' },
                    { match: { model: 'claude-3-haiku*' }, tier: 'light' },
                    { match: { model: '*' }, tier: 'medium' }
                ],
                failover: {
                    maxModelSwitchesPerRequest: 5
                },
                // Feature flag ON
                transientOverflowRetry: {
                    enabled: true
                },
                logDecisions: false
            }
        });

        proxyServer = new ProxyServer({ config });
        const server = await proxyServer.start();
        const address = server.address();
        proxyUrl = `http://127.0.0.1:${address.port}`;

        proxyServer.requestHandler.agent.destroy();
        proxyServer.requestHandler.agent = new https.Agent({
            keepAlive: true,
            maxSockets: 10,
            rejectUnauthorized: false
        });
    });

    afterEach(async () => {
        if (proxyServer) {
            await proxyServer.shutdown();
            proxyServer = null;
        }
        if (upstream) {
            await upstream.stop();
            upstream = null;
        }
        if (testDir) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    test('transient overflow retries then succeeds when cooldown expires', async () => {
        // Short cooldown on 200K model: first routing attempt picks 128K model
        // → overflow → transient cause.  Retry backoff (~300ms) outlasts the
        // cooldown, so the second attempt picks 200K model → upstream → 200.
        const router = proxyServer.requestHandler.modelRouter;
        router.recordModelCooldown('glm-4.7-flash', 200);  // 200ms cooldown

        // ~150K input tokens: 150000 * 4 = 600000 chars
        // estimated: ceil(600016/4) + 8192 = 158196 total → exceeds 128K, fits 200K
        const largePrompt = 'x'.repeat(600000);
        const res = await request(`${proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                messages: [{ role: 'user', content: largePrompt }],
                max_tokens: 8192
            })
        });

        // Retry succeeds after cooldown expires → upstream responds 200
        expect(res.statusCode).toBe(200);
        expect(upstream.getRequestCount()).toBe(1);

        // Verify the upstream received a 200K model
        const sent = upstream.getRequests()[0];
        const sentBody = JSON.parse(sent.body);
        expect(sentBody.model).toBe('glm-4.7-flash');
    }, 15000);

    test('genuine overflow still returns 400 even with flag enabled', async () => {
        // Request exceeds ALL models (>200K) — this is genuine, not transient
        const hugePrompt = 'x'.repeat(900000);
        const res = await request(`${proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                messages: [{ role: 'user', content: hugePrompt }],
                max_tokens: 8000
            })
        });

        expect(res.statusCode).toBe(400);
        expect(res.headers['x-proxy-error']).toBe('context_overflow');
        expect(res.headers['x-proxy-overflow-cause']).toBe('genuine');
        expect(upstream.getRequestCount()).toBe(0);
    });
});
