/**
 * Model Routing E2E Smoke Tests
 *
 * Tests model routing functionality end-to-end:
 * - GET /model-routing returns state
 * - GET /model-routing/test dry-run classifier
 * - PUT/GET/DELETE /model-routing/overrides
 * - POST /model-routing/reset
 * - GET /model-routing/export
 * - GET /model-routing/cooldowns
 * - /v1/messages model rewriting (when upstream reachable)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');


const { ProxyServer } = require('../lib/proxy-server');
const { Config, resetConfig } = require('../lib/config');
const { resetLogger } = require('../lib/logger');

// Helper to make HTTP requests (same pattern as e2e-smoke.test.js)
function request(url, options = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        body: data,
                        json: () => JSON.parse(data)
                    });
                } catch (e) {
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        body: data,
                        json: () => null
                    });
                }
            });
        });
        req.on('error', reject);
        if (options.body) {
            req.write(options.body);
        }
        req.end();
    });
}

// Mock upstream that can return 429
function createMockUpstream(options = {}) {
    const { responseDelay = 10 } = options;
    let requestCount = 0;
    const requests = [];
    let force429 = false;

    const server = https.createServer({
        key: fs.readFileSync(path.join(__dirname, 'fixtures', 'server.key')),
        cert: fs.readFileSync(path.join(__dirname, 'fixtures', 'server.crt'))
    }, (req, res) => {
        requestCount++;
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            requests.push({ method: req.method, url: req.url, headers: req.headers, body });

            setTimeout(() => {
                if (force429) {
                    res.writeHead(429, {
                        'content-type': 'application/json',
                        'retry-after': '1'
                    });
                    res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'Rate limited' } }));
                    return;
                }

                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    id: 'msg_' + requestCount,
                    type: 'message',
                    content: [{ type: 'text', text: 'response' }],
                    model: 'glm-4-air',
                    usage: { input_tokens: 10, output_tokens: 20 }
                }));
            }, responseDelay);
        });
    });

    return {
        server,
        getRequests: () => requests,
        getRequestCount: () => requestCount,
        setForce429: (v) => { force429 = v; },
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

describe('Model Routing E2E Smoke Tests', () => {
    let testDir;
    let proxyServer;
    let proxyUrl;
    let upstream;
    let upstreamPort;

    beforeAll(() => {
        // Ensure SSL fixtures exist (reuse from e2e-smoke pattern)
        const fixturesDir = path.join(__dirname, 'fixtures');
        if (!fs.existsSync(fixturesDir)) {
            fs.mkdirSync(fixturesDir, { recursive: true });
        }
        const keyPath = path.join(fixturesDir, 'server.key');
        const certPath = path.join(fixturesDir, 'server.crt');
        if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
            try {
                const { execSync } = require('child_process');
                execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 365 -nodes -subj "/CN=localhost"`, { stdio: 'pipe' });
            } catch (e) {
                console.warn('OpenSSL not available, tests will be skipped');
            }
        }
    });

    beforeEach(async () => {
        resetConfig();
        resetLogger();

        testDir = path.join(os.tmpdir(), 'model-routing-e2e-' + Date.now());
        fs.mkdirSync(testDir, { recursive: true });

        // Start mock upstream on an ephemeral port (avoids EADDRINUSE under parallel Jest)
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
            rejectUnauthorized: false,  // Allow self-signed certs in test
            modelRouting: {
                enabled: true,
                defaultModel: 'glm-4-air',
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash',
                        failoverModel: 'glm-4-air',
                        clientModelPolicy: 'always-route'
                    },
                    medium: {
                        targetModel: 'glm-4-air',
                        failoverModel: 'glm-4-flash',
                        clientModelPolicy: 'always-route'
                    },
                    heavy: {
                        targetModel: 'glm-4-plus',
                        failoverModel: 'glm-4-air',
                        clientModelPolicy: 'always-route'
                    }
                },
                rules: [
                    { match: { model: 'claude-3-haiku-*' }, tier: 'light' },
                    { match: { model: 'claude-3-opus-*' }, tier: 'heavy' }
                ],
                classifier: {
                    heavyThresholds: {
                        maxTokensGte: 4096,
                        messageCountGte: 20,
                        hasTools: true,
                        hasVision: true,
                        systemLengthGte: 2000
                    },
                    lightThresholds: {
                        maxTokensLte: 512,
                        messageCountLte: 3
                    }
                },
                cooldown: {
                    defaultMs: 5000,
                    maxMs: 30000,
                    decayMs: 60000,
                    backoffMultiplier: 2
                },
                logDecisions: false
            }
        });

        proxyServer = new ProxyServer({ config });
        const server = await proxyServer.start();
        const address = server.address();
        proxyUrl = `http://127.0.0.1:${address.port}`;
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
        upstreamPort = undefined;
        try {
            const files = fs.readdirSync(testDir);
            files.forEach(f => {
                const fp = path.join(testDir, f);
                try { fs.unlinkSync(fp); } catch (_e) { /* ignore */ }
            });
            fs.rmdirSync(testDir);
        } catch (e) { /* ignore */ }
    });

    // -----------------------------------------------------------------
    // Admin endpoint: GET /model-routing
    // -----------------------------------------------------------------

    test('GET /model-routing returns enabled state with config', async () => {
        const res = await request(`${proxyUrl}/model-routing`);
        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data.enabled).toBe(true);
        expect(data.config).toBeDefined();
        expect(data.config.tiers).toBeDefined();
        expect(data.config.tiers.light).toBeDefined();
        expect(data.config.tiers.medium).toBeDefined();
        expect(data.config.tiers.heavy).toBeDefined();
        expect(data.stats).toBeDefined();
        expect(data.stats.total).toBe(0);
        expect(data.overrides).toBeDefined();
        expect(data.cooldowns).toBeDefined();
    });

    // -----------------------------------------------------------------
    // Admin endpoint: GET /model-routing/test  (dry-run classifier)
    // -----------------------------------------------------------------

    test('GET /model-routing/test classifies opus model as heavy via rule', async () => {
        const res = await request(`${proxyUrl}/model-routing/test?model=claude-3-opus-20240229&max_tokens=8192`);
        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data.features).toBeDefined();
        expect(data.features.model).toBe('claude-3-opus-20240229');
        expect(data.features.maxTokens).toBe(8192);
        expect(data.classification).toBeDefined();
        expect(data.classification.tier).toBe('heavy');
        expect(data.targetModel).toBe('glm-4-plus');
        expect(data.failoverModel).toBe('glm-4-air');
    });

    test('GET /model-routing/test classifies haiku model as light via rule', async () => {
        const res = await request(`${proxyUrl}/model-routing/test?model=claude-3-haiku-20240307&max_tokens=100`);
        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data.classification.tier).toBe('light');
        expect(data.targetModel).toBe('glm-4-flash');
    });

    test('GET /model-routing/test classifies short request as light via classifier', async () => {
        // No rule match for this model, so classifier kicks in
        const res = await request(`${proxyUrl}/model-routing/test?model=claude-sonnet-4-20250514&max_tokens=256&messages=2`);
        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data.classification).toBeDefined();
        expect(data.classification.tier).toBe('light');
        expect(data.targetModel).toBe('glm-4-flash');
    });

    test('GET /model-routing/test classifies high-token request as heavy via classifier', async () => {
        const res = await request(`${proxyUrl}/model-routing/test?model=claude-sonnet-4-20250514&max_tokens=8192`);
        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data.classification.tier).toBe('heavy');
        expect(data.targetModel).toBe('glm-4-plus');
    });

    test('GET /model-routing/test classifies tools request as heavy', async () => {
        const res = await request(`${proxyUrl}/model-routing/test?model=claude-sonnet-4-20250514&tools=true`);
        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data.classification.tier).toBe('heavy');
    });

    test('GET /model-routing/test classifies vision request as heavy', async () => {
        const res = await request(`${proxyUrl}/model-routing/test?model=claude-sonnet-4-20250514&vision=true`);
        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data.classification.tier).toBe('heavy');
    });

    test('GET /model-routing/test classifies default request as medium', async () => {
        // No rule match, max_tokens in middle range, single message
        const res = await request(`${proxyUrl}/model-routing/test?model=claude-sonnet-4-20250514&max_tokens=2048&messages=10`);
        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data.classification.tier).toBe('medium');
        expect(data.targetModel).toBe('glm-4-air');
    });

    // -----------------------------------------------------------------
    // Admin endpoint: POST /model-routing/explain  (dry-run with scoring)
    // -----------------------------------------------------------------

    test('POST /model-routing/explain returns full decision for heavy request', async () => {
        const res = await request(`${proxyUrl}/model-routing/explain`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-3-opus-20240229',
                maxTokens: 8192,
                messageCount: 5
            })
        });
        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data.selectedModel).toBeDefined();
        expect(data.tier).toBe('heavy');
        expect(data.matchedRule).toEqual({ model: 'claude-3-opus-*' });
        expect(data.cooldownReasons).toEqual([]);
        expect(data.features).toBeDefined();
    });

    test('POST /model-routing/explain returns classifierResult for classifier match', async () => {
        const res = await request(`${proxyUrl}/model-routing/explain`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                maxTokens: 8192
            })
        });
        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data.tier).toBe('heavy');
        expect(data.classifierResult).toBeDefined();
        expect(data.classifierResult.tier).toBe('heavy');
        expect(data.classifierResult.reason).toContain('classifier');
        expect(data.matchedRule).toBeNull();
    });

    test('POST /model-routing/explain rejects GET method', async () => {
        const res = await request(`${proxyUrl}/model-routing/explain`);
        expect(res.statusCode).toBe(405);
    });

    test('POST /model-routing/explain returns 400 for invalid JSON', async () => {
        const res = await request(`${proxyUrl}/model-routing/explain`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: 'not json'
        });
        expect(res.statusCode).toBe(400);
    });

    // -----------------------------------------------------------------
    // Admin endpoint: PUT/GET/DELETE /model-routing/overrides
    // -----------------------------------------------------------------

    test('PUT/GET/DELETE /model-routing/overrides lifecycle', async () => {
        // Set override
        let res = await request(`${proxyUrl}/model-routing/overrides`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: 'claude-sonnet-4', model: 'glm-4-test' })
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().success).toBe(true);

        // Get overrides
        res = await request(`${proxyUrl}/model-routing/overrides`);
        expect(res.statusCode).toBe(200);
        const overrides = res.json();
        expect(overrides['claude-sonnet-4']).toBe('glm-4-test');

        // Delete override
        const deleteBody = JSON.stringify({ key: 'claude-sonnet-4' });
        res = await request(`${proxyUrl}/model-routing/overrides`, {
            method: 'DELETE',
            headers: {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(deleteBody))
            },
            body: deleteBody
        });
        expect(res.statusCode).toBe(200);

        // Verify deleted
        res = await request(`${proxyUrl}/model-routing/overrides`);
        expect(res.json()['claude-sonnet-4']).toBeUndefined();
    });

    test('PUT /model-routing/overrides requires key and model', async () => {
        const res = await request(`${proxyUrl}/model-routing/overrides`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: 'test' })
        });
        expect(res.statusCode).toBe(400);
    });

    test('DELETE /model-routing/overrides requires key', async () => {
        const res = await request(`${proxyUrl}/model-routing/overrides`, {
            method: 'DELETE',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({})
        });
        expect(res.statusCode).toBe(400);
    });

    test('overrides persist in /model-routing state', async () => {
        // Set an override
        await request(`${proxyUrl}/model-routing/overrides`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: 'claude-test', model: 'glm-test' })
        });

        // Verify it shows in the main state endpoint
        const res = await request(`${proxyUrl}/model-routing`);
        const data = res.json();
        expect(data.overrides['claude-test']).toBe('glm-test');
    });

    // -----------------------------------------------------------------
    // Admin endpoint: POST /model-routing/reset
    // -----------------------------------------------------------------

    test('POST /model-routing/reset clears all state', async () => {
        // Set some state first
        await request(`${proxyUrl}/model-routing/overrides`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: '*', model: 'glm-4-test' })
        });

        // Verify override exists
        let overRes = await request(`${proxyUrl}/model-routing/overrides`);
        expect(overRes.json()['*']).toBe('glm-4-test');

        // Reset
        const res = await request(`${proxyUrl}/model-routing/reset`, { method: 'POST' });
        expect(res.statusCode).toBe(200);
        expect(res.json().success).toBe(true);

        // Verify overrides cleared
        overRes = await request(`${proxyUrl}/model-routing/overrides`);
        expect(Object.keys(overRes.json())).toHaveLength(0);
    });

    test('GET /model-routing/reset returns 405', async () => {
        const res = await request(`${proxyUrl}/model-routing/reset`);
        expect(res.statusCode).toBe(405);
    });

    // -----------------------------------------------------------------
    // Admin endpoint: GET /model-routing/export
    // -----------------------------------------------------------------

    test('GET /model-routing/export returns downloadable JSON', async () => {
        const res = await request(`${proxyUrl}/model-routing/export`);
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-disposition']).toContain('attachment');
        expect(res.headers['cache-control']).toBe('no-store');
        const data = res.json();
        expect(data.enabled).toBe(true);
        expect(data.exportedAt).toBeDefined();
        expect(data.version).toBe('1.0');
        expect(data.config).toBeDefined();
        expect(data.stats).toBeDefined();
    });

    // -----------------------------------------------------------------
    // Admin endpoint: GET /model-routing/cooldowns
    // -----------------------------------------------------------------

    test('GET /model-routing/cooldowns returns empty initially', async () => {
        const res = await request(`${proxyUrl}/model-routing/cooldowns`);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({});
    });

    test('GET /model-routing/cooldowns returns 405 for POST', async () => {
        const res = await request(`${proxyUrl}/model-routing/cooldowns`, { method: 'POST' });
        expect(res.statusCode).toBe(405);
    });

    // -----------------------------------------------------------------
    // Cooldown tracking via ModelRouter API
    // -----------------------------------------------------------------

    test('cooldowns appear after recording a model cooldown', async () => {
        // Record a cooldown directly on the model router
        proxyServer.modelRouter.recordModelCooldown('glm-4-plus', 5000);

        const res = await request(`${proxyUrl}/model-routing/cooldowns`);
        expect(res.statusCode).toBe(200);
        const cooldowns = res.json();
        expect(cooldowns['glm-4-plus']).toBeDefined();
        expect(cooldowns['glm-4-plus'].remainingMs).toBeGreaterThan(0);
        expect(cooldowns['glm-4-plus'].count).toBe(1);
    });

    test('cooldown affects test dry-run failover', async () => {
        // Put the heavy tier target model on cooldown
        proxyServer.modelRouter.recordModelCooldown('glm-4-plus', 10000);

        const res = await request(`${proxyUrl}/model-routing/test?model=claude-3-opus-20240229`);
        expect(res.statusCode).toBe(200);
        const data = res.json();
        // Classification should still be heavy
        expect(data.classification.tier).toBe('heavy');
        // But cooldown info should show the target is cooled down
        expect(data.cooldown).toBeDefined();
        expect(data.cooldown.targetMs).toBeGreaterThan(0);
    });

    test('reset clears cooldowns', async () => {
        // Record a cooldown
        proxyServer.modelRouter.recordModelCooldown('glm-4-plus', 5000);

        // Verify it exists
        let res = await request(`${proxyUrl}/model-routing/cooldowns`);
        expect(Object.keys(res.json())).toHaveLength(1);

        // Reset
        await request(`${proxyUrl}/model-routing/reset`, { method: 'POST' });

        // Verify cleared
        res = await request(`${proxyUrl}/model-routing/cooldowns`);
        expect(res.json()).toEqual({});
    });

    // -----------------------------------------------------------------
    // PUT /model-routing (runtime config update)
    // -----------------------------------------------------------------

    test('PUT /model-routing updates config at runtime', async () => {
        const res = await request(`${proxyUrl}/model-routing`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ logDecisions: true })
        });
        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data.success).toBe(true);
        expect(data.config).toBeDefined();
    });

    // -----------------------------------------------------------------
    // Stats tracking
    // -----------------------------------------------------------------

    test('stats track routing decisions through model router', async () => {
        // Make several test calls through selectModel to accumulate stats
        const router = proxyServer.modelRouter;

        await router.selectModel({
            parsedBody: { model: 'claude-3-opus-20240229', messages: [{ role: 'user', content: 'test' }] },
            requestModel: 'claude-3-opus-20240229'
        });

        await router.selectModel({
            parsedBody: { model: 'claude-3-haiku-20240307', messages: [{ role: 'user', content: 'test' }] },
            requestModel: 'claude-3-haiku-20240307'
        });

        // Check stats via admin endpoint
        const res = await request(`${proxyUrl}/model-routing`);
        const data = res.json();
        expect(data.stats.total).toBe(2);
        expect(data.stats.byTier.heavy).toBe(1);
        expect(data.stats.byTier.light).toBe(1);
        expect(data.stats.bySource.rule).toBe(2);
    });

    test('stats count saved-override source', async () => {
        // Set a wildcard override
        await request(`${proxyUrl}/model-routing/overrides`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: '*', model: 'glm-override' })
        });

        // Route through selectModel
        const router = proxyServer.modelRouter;
        const result = await router.selectModel({
            parsedBody: { model: 'anything', messages: [] },
            requestModel: 'anything'
        });

        expect(result.model).toBe('glm-override');
        expect(result.source).toBe('saved-override');

        // Check via endpoint
        const res = await request(`${proxyUrl}/model-routing`);
        const data = res.json();
        expect(data.stats.bySource['saved-override']).toBeGreaterThanOrEqual(1);
    });

    // -----------------------------------------------------------------
    // Concurrent admin requests
    // -----------------------------------------------------------------

    test('handles concurrent admin requests', async () => {
        const promises = [];

        // Fire multiple concurrent requests to different model-routing endpoints
        for (let i = 0; i < 10; i++) {
            const endpoints = [
                '/model-routing',
                '/model-routing/test?model=claude-sonnet-4-20250514',
                '/model-routing/overrides',
                '/model-routing/cooldowns'
            ];
            const endpoint = endpoints[i % endpoints.length];
            promises.push(request(`${proxyUrl}${endpoint}`));
        }

        const results = await Promise.all(promises);

        results.forEach(res => {
            expect(res.statusCode).toBe(200);
        });
    });

    // -----------------------------------------------------------------
    // Edge cases
    // -----------------------------------------------------------------

    test('GET /model-routing/test with no parameters uses defaults', async () => {
        const res = await request(`${proxyUrl}/model-routing/test`);
        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data.features).toBeDefined();
        expect(data.features.messageCount).toBe(1);
        expect(data.classification).toBeDefined();
    });

    test('export never contains sensitive fields (tokens, keys)', async () => {
        const res = await request(`${proxyUrl}/model-routing/export`);
        const data = res.json();
        expect(data.adminTokens).toBeUndefined();
        expect(data.apiKeys).toBeUndefined();
        // Stringify and check no token/key patterns
        const json = JSON.stringify(data);
        expect(json).not.toContain('x-admin-token');
        expect(json).not.toContain('secret');
    });

    test('export response contains no API key or token substrings', async () => {
        const res = await request(`${proxyUrl}/model-routing/export`);
        expect(res.statusCode).toBe(200);
        const raw = res.body;
        // The test config uses 'testkey1.secret1' as the API key
        expect(raw).not.toContain('testkey1');
        expect(raw).not.toContain('secret1');
        expect(raw).not.toContain('x-admin-token');
        expect(raw).not.toContain('authorization');
    });

    test('GET /model-routing response contains no API key substrings', async () => {
        const res = await request(`${proxyUrl}/model-routing`);
        expect(res.statusCode).toBe(200);
        const raw = res.body;
        expect(raw).not.toContain('testkey1');
        expect(raw).not.toContain('secret1');
    });

    test('export includes overrides when set', async () => {
        // Set an override
        await request(`${proxyUrl}/model-routing/overrides`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: 'test-model', model: 'glm-export-test' })
        });

        const res = await request(`${proxyUrl}/model-routing/export`);
        const data = res.json();
        expect(data.overrides['test-model']).toBe('glm-export-test');
    });

    test('multiple overrides can coexist', async () => {
        // Set multiple overrides
        await request(`${proxyUrl}/model-routing/overrides`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: 'model-a', model: 'glm-a' })
        });
        await request(`${proxyUrl}/model-routing/overrides`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: 'model-b', model: 'glm-b' })
        });

        const res = await request(`${proxyUrl}/model-routing/overrides`);
        const overrides = res.json();
        expect(overrides['model-a']).toBe('glm-a');
        expect(overrides['model-b']).toBe('glm-b');
    });

    // -----------------------------------------------------------------
    // Prometheus metrics
    // -----------------------------------------------------------------

    test('GET /metrics includes model routing counters', async () => {
        // Make a routing decision first to generate stats
        await proxyServer.modelRouter.selectModel({
            parsedBody: { model: 'claude-3-opus-20240229', messages: [{ role: 'user', content: 'test' }] },
            requestModel: 'claude-3-opus-20240229'
        });

        const res = await request(`${proxyUrl}/metrics`);
        expect(res.statusCode).toBe(200);
        const body = res.body;
        expect(body).toContain('glm_proxy_model_routing_enabled 1');
        expect(body).toContain('glm_proxy_model_routing_decisions_total');
        expect(body).toContain('glm_proxy_model_routing_failovers_total');
        expect(body).toContain('glm_proxy_model_routing_cooldowns_active');
        expect(body).toContain('glm_proxy_model_routing_overrides_active');
    });

    test('modelRouter is exposed on ProxyServer for /health/deep integration', () => {
        // /health/deep requires auth in no-auth mode (403), so verify the data path directly
        expect(proxyServer.modelRouter).toBeDefined();
        expect(proxyServer.modelRouter.enabled).toBe(true);
        const stats = proxyServer.modelRouter.getStats();
        expect(stats.byTier).toBeDefined();
        expect(stats.bySource).toBeDefined();
    });

    // -----------------------------------------------------------------
    // History endpoint: routing field plumbing
    // -----------------------------------------------------------------

    test('GET /history includes routing field when model routing enabled', async () => {
        // Make a routing decision to populate stats
        await proxyServer.modelRouter.selectModel({
            parsedBody: { model: 'claude-3-haiku-20240307', messages: [{ role: 'user', content: 'hello' }] },
            requestModel: 'claude-3-haiku-20240307'
        });

        // Wait for at least one history tick to collect the routing data
        await new Promise(resolve => setTimeout(resolve, 1200));

        const res = await request(`${proxyUrl}/history?minutes=1`);
        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data.points).toBeDefined();
        expect(data.points.length).toBeGreaterThan(0);

        // Find a point with routing data (may not be the first if timing is tight)
        const pointWithRouting = data.points.find(p => p.routing);
        expect(pointWithRouting).toBeDefined();
        expect(pointWithRouting.routing.total).toBeDefined();
        expect(typeof pointWithRouting.routing.totalDelta).toBe('number');
        expect(typeof pointWithRouting.rateLimitedDelta).toBe('number');
    });
});

describe('Model Routing Config Persistence', () => {
    let testDir;
    let proxyServer;
    let proxyUrl;
    let upstream;
    let upstreamPort;

    beforeAll(() => {
        const fixturesDir = path.join(__dirname, 'fixtures');
        if (!fs.existsSync(fixturesDir)) {
            fs.mkdirSync(fixturesDir, { recursive: true });
        }
    });

    beforeEach(async () => {
        resetConfig();
        resetLogger();

        testDir = path.join(os.tmpdir(), 'model-routing-persist-' + Date.now());
        fs.mkdirSync(testDir, { recursive: true });

        // Start mock upstream on an ephemeral port (avoids EADDRINUSE under parallel Jest)
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
            rejectUnauthorized: false,  // Allow self-signed certs in test
            modelRouting: {
                enabled: true,
                defaultModel: 'glm-4-air',
                persistConfigEdits: true,
                configFile: 'model-routing.json',
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash',
                        failoverModel: 'glm-4-air',
                        clientModelPolicy: 'always-route'
                    },
                    medium: {
                        targetModel: 'glm-4-air',
                        failoverModel: 'glm-4-flash',
                        clientModelPolicy: 'always-route'
                    },
                    heavy: {
                        targetModel: 'glm-4-plus',
                        failoverModel: 'glm-4-air',
                        clientModelPolicy: 'always-route'
                    }
                },
                classifier: {
                    heavyThresholds: { maxTokensGte: 4096 },
                    lightThresholds: { maxTokensLte: 512, messageCountLte: 3 }
                },
                cooldown: { defaultMs: 5000, maxMs: 30000, decayMs: 60000, backoffMultiplier: 2 },
                logDecisions: false
            }
        });

        proxyServer = new ProxyServer({ config });
        const server = await proxyServer.start();
        const address = server.address();
        proxyUrl = `http://127.0.0.1:${address.port}`;
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
        upstreamPort = null;
        try {
            const files = fs.readdirSync(testDir);
            files.forEach(f => {
                const fp = path.join(testDir, f);
                try { fs.unlinkSync(fp); } catch (_e) { /* ignore */ }
            });
            fs.rmdirSync(testDir);
        } catch (_e) { /* ignore */ }
    });

    test('GET /model-routing includes persistence state', async () => {
        const res = await request(`${proxyUrl}/model-routing`);
        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data.persistence).toBeDefined();
        expect(data.persistence.enabled).toBe(true);
        expect(data.persistence.configPath).toContain('model-routing.json');
        expect(data.persistence.lastSavedAt).toBeNull();  // No saves yet
        expect(data.persistence.lastSaveError).toBeNull();
        expect(data.persistence.lastLoadError).toBeNull();  // No load errors
        expect(data.persistence.configWarnings).toBeNull();  // No warnings initially
    });

    test('GET /model-routing shows configWarnings after PUT that generates warnings', async () => {
        // PUT failover.maxModelSwitchesPerRequest that exceeds existing tiers' models count.
        // The merged validation triggers VALIDATE-03 as a warning.
        // (Each tier has 2 models, so maxSwitches=10 exceeds all.)
        const putBody = JSON.stringify({
            failover: {
                maxModelSwitchesPerRequest: 10
            }
        });
        const putRes = await request(`${proxyUrl}/model-routing`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: putBody
        });
        expect(putRes.statusCode).toBe(200);
        const putData = putRes.json();
        // PUT response includes warnings
        expect(putData.warnings).toBeDefined();
        expect(putData.warnings.length).toBeGreaterThan(0);
        expect(putData.warnings.some((warning) => warning.includes('maxModelSwitchesPerRequest'))).toBe(true);

        // Subsequent GET should also show warnings in persistence
        const getRes = await request(`${proxyUrl}/model-routing`);
        const getData = getRes.json();
        expect(getData.persistence.configWarnings).toBeDefined();
        expect(getData.persistence.configWarnings.length).toBeGreaterThan(0);
        expect(getData.persistence.configWarnings.some((warning) => warning.includes('maxModelSwitchesPerRequest'))).toBe(true);
    });

    test('PUT /model-routing persists config to disk', async () => {
        const putBody = JSON.stringify({ defaultModel: 'glm-4-turbo' });
        const putRes = await request(`${proxyUrl}/model-routing`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(putBody)) },
            body: putBody
        });
        expect(putRes.statusCode).toBe(200);
        const putData = putRes.json();
        expect(putData.success).toBe(true);
        expect(putData.persisted).toBe(true);
        expect(putData.warning).toBeUndefined();

        // Verify file exists on disk
        const configPath = path.join(testDir, 'model-routing.json');
        expect(fs.existsSync(configPath)).toBe(true);

        // Verify file contents
        const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        expect(saved.defaultModel).toBe('glm-4-turbo');
        expect(saved.enabled).toBe(true);
        // Meta-config should NOT be in persisted file
        expect(saved.persistConfigEdits).toBeUndefined();
        expect(saved.configFile).toBeUndefined();
        expect(saved.overridesFile).toBeUndefined();
        expect(saved.maxOverrides).toBeUndefined();
    });

    test('PUT /model-routing creates backup before overwriting', async () => {
        // First write
        const body1 = JSON.stringify({ defaultModel: 'glm-4-v1' });
        await request(`${proxyUrl}/model-routing`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body1)) },
            body: body1
        });

        // Second write (should create backup of first)
        const body2 = JSON.stringify({ defaultModel: 'glm-4-v2' });
        await request(`${proxyUrl}/model-routing`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body2)) },
            body: body2
        });

        // Verify backup exists
        const backupPath = path.join(testDir, 'model-routing.json.bak');
        expect(fs.existsSync(backupPath)).toBe(true);

        // Backup should contain the first version
        const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
        expect(backup.defaultModel).toBe('glm-4-v1');

        // Main file should contain the second version
        const current = JSON.parse(fs.readFileSync(path.join(testDir, 'model-routing.json'), 'utf8'));
        expect(current.defaultModel).toBe('glm-4-v2');
    });

    test('PUT /model-routing rejects invalid config (schema validation)', async () => {
        const body = JSON.stringify({ persistConfigEdits: true });
        const res = await request(`${proxyUrl}/model-routing`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
            body
        });
        expect(res.statusCode).toBe(400);
        const data = res.json();
        expect(data.error).toContain('not runtime-editable');
    });

    test('PUT /model-routing rejects unknown keys', async () => {
        const body = JSON.stringify({ unknownField: 'value' });
        const res = await request(`${proxyUrl}/model-routing`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
            body
        });
        expect(res.statusCode).toBe(400);
        const data = res.json();
        expect(data.error).toContain('Unknown config key');
    });

    test('persisted config survives restart simulation', async () => {
        // Write a config change
        const putBody = JSON.stringify({ defaultModel: 'glm-4-turbo' });
        await request(`${proxyUrl}/model-routing`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(putBody)) },
            body: putBody
        });

        // Shut down the server
        await proxyServer.shutdown();

        // Start a new server with same config dir
        resetConfig();
        const config2 = new Config({
            configDir: testDir,
            keysFile: 'test-keys.json',
            statsFile: 'test-stats.json',
            useCluster: false,
            port: 0,
            logLevel: 'ERROR',
            modelRouting: {
                enabled: true,
                defaultModel: 'glm-4-air',  // Original default
                persistConfigEdits: true,
                configFile: 'model-routing.json',
                tiers: {
                    light: { targetModel: 'glm-4-flash', failoverModel: 'glm-4-air', clientModelPolicy: 'always-route' },
                    medium: { targetModel: 'glm-4-air', failoverModel: 'glm-4-flash', clientModelPolicy: 'always-route' },
                    heavy: { targetModel: 'glm-4-plus', failoverModel: 'glm-4-air', clientModelPolicy: 'always-route' }
                },
                classifier: {
                    heavyThresholds: { maxTokensGte: 4096 },
                    lightThresholds: { maxTokensLte: 512, messageCountLte: 3 }
                },
                cooldown: { defaultMs: 5000, maxMs: 30000, decayMs: 60000, backoffMultiplier: 2 },
                logDecisions: false
            }
        });

        proxyServer = new ProxyServer({ config: config2 });
        const server2 = await proxyServer.start();
        const address2 = server2.address();
        proxyUrl = `http://127.0.0.1:${address2.port}`;

        // Verify the persisted change was loaded
        const getRes = await request(`${proxyUrl}/model-routing`);
        expect(getRes.statusCode).toBe(200);
        const data = getRes.json();
        expect(data.config.defaultModel).toBe('glm-4-turbo');  // Persisted value, not default
    });

    test('GET /model-routing shows lastSavedAt after successful persist', async () => {
        const putBody = JSON.stringify({ logDecisions: true });
        await request(`${proxyUrl}/model-routing`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(putBody)) },
            body: putBody
        });

        const getRes = await request(`${proxyUrl}/model-routing`);
        const data = getRes.json();
        expect(data.persistence.lastSavedAt).toBeTruthy();
        // Should be a valid ISO timestamp
        expect(new Date(data.persistence.lastSavedAt).getTime()).toBeGreaterThan(0);
    });

    test('persisted file includes version stamp', async () => {
        const putBody = JSON.stringify({ defaultModel: 'glm-4-turbo' });
        await request(`${proxyUrl}/model-routing`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(putBody)) },
            body: putBody
        });

        const configPath = path.join(testDir, 'model-routing.json');
        const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        expect(saved.version).toBe('2.0');
    });

    test('lastLoadError surfaces broken config file on boot', async () => {
        // Write invalid JSON to the config file
        fs.writeFileSync(path.join(testDir, 'model-routing.json'), '{broken json!!!');

        // Shut down and restart with the corrupt file present
        await proxyServer.shutdown();
        resetConfig();

        const config2 = new Config({
            configDir: testDir,
            keysFile: 'test-keys.json',
            statsFile: 'test-stats.json',
            useCluster: false,
            port: 0,
            logLevel: 'ERROR',
            modelRouting: {
                enabled: true,
                defaultModel: 'glm-4-air',
                persistConfigEdits: true,
                configFile: 'model-routing.json',
                tiers: {
                    light: { targetModel: 'glm-4-flash', failoverModel: 'glm-4-air', clientModelPolicy: 'always-route' },
                    medium: { targetModel: 'glm-4-air', failoverModel: 'glm-4-flash', clientModelPolicy: 'always-route' },
                    heavy: { targetModel: 'glm-4-plus', failoverModel: 'glm-4-air', clientModelPolicy: 'always-route' }
                },
                classifier: {
                    heavyThresholds: { maxTokensGte: 4096 },
                    lightThresholds: { maxTokensLte: 512, messageCountLte: 3 }
                },
                cooldown: { defaultMs: 5000, maxMs: 30000, decayMs: 60000, backoffMultiplier: 2 },
                logDecisions: false
            }
        });

        proxyServer = new ProxyServer({ config: config2 });
        const server2 = await proxyServer.start();
        const address2 = server2.address();
        proxyUrl = `http://127.0.0.1:${address2.port}`;

        const getRes = await request(`${proxyUrl}/model-routing`);
        const data = getRes.json();
        expect(data.persistence.lastLoadError).toBeTruthy();
        expect(data.persistence.lastLoadError).toContain('Failed to load');
        // Should still be functional with defaults
        expect(data.enabled).toBe(true);
        expect(data.config.defaultModel).toBe('glm-4-air');  // Fell back to default
    });
});

describe('Model Routing Retry-Loop Integration', () => {
    let testDir;
    let proxyServer;
    let proxyUrl;
    let upstream;
    let upstreamPort;
    let originalTlsSetting;

    beforeAll(() => {
        // Allow self-signed certs for upstream mock
        originalTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    });

    afterAll(() => {
        // Restore TLS setting
        if (originalTlsSetting === undefined) {
            delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        } else {
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalTlsSetting;
        }
    });

    function createRetryMockUpstream(options = {}) {
        const { responseDelay = 5 } = options;
        let requestCount = 0;
        const requests = [];
        let force429Remaining = 0;

        const server = https.createServer({
            key: fs.readFileSync(path.join(__dirname, 'fixtures', 'server.key')),
            cert: fs.readFileSync(path.join(__dirname, 'fixtures', 'server.crt'))
        }, (req, res) => {
            requestCount++;
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                requests.push({ method: req.method, url: req.url, headers: req.headers, body });
                setTimeout(() => {
                    if (force429Remaining > 0) {
                        force429Remaining--;
                        res.writeHead(429, {
                            'content-type': 'application/json',
                            'retry-after': '1'
                        });
                        res.end(JSON.stringify({ error: { type: 'rate_limit_error', message: 'Rate limited' } }));
                        return;
                    }
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({
                        id: 'msg_' + requestCount,
                        type: 'message',
                        content: [{ type: 'text', text: 'response' }],
                        model: 'glm-4-air',
                        usage: { input_tokens: 10, output_tokens: 20 }
                    }));
                }, responseDelay);
            });
        });

        return {
            server,
            getRequests: () => requests,
            getRequestCount: () => requestCount,
            force429ForNext: (n) => { force429Remaining = n; },
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

    beforeEach(async () => {
        resetConfig();
        resetLogger();

        testDir = path.join(os.tmpdir(), 'model-routing-retry-' + Date.now());
        fs.mkdirSync(testDir, { recursive: true });

        upstream = createRetryMockUpstream();
        upstreamPort = await upstream.start(0);

        fs.writeFileSync(
            path.join(testDir, 'test-keys.json'),
            JSON.stringify({
                keys: ['testkey1.secret1', 'testkey2.secret2', 'testkey3.secret3'],
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
            modelRouting: {
                enabled: true,
                defaultModel: 'glm-4-air',
                tiers: {
                    heavy: {
                        targetModel: 'glm-4-plus',
                        fallbackModels: ['glm-4-air', 'glm-4-flash'],
                        clientModelPolicy: 'always-route'
                    },
                    light: {
                        targetModel: 'glm-4-flash',
                        fallbackModels: ['glm-4-air'],
                        clientModelPolicy: 'always-route'
                    },
                    medium: {
                        targetModel: 'glm-4-air',
                        fallbackModels: ['glm-4-flash'],
                        clientModelPolicy: 'always-route'
                    }
                },
                rules: [
                    { match: { model: 'claude-3-opus-*' }, tier: 'heavy' }
                ],
                classifier: {
                    heavyThresholds: { maxTokensGte: 4096 },
                    lightThresholds: { maxTokensLte: 512, messageCountLte: 3 }
                },
                cooldown: { defaultMs: 5000, maxMs: 30000, decayMs: 60000, backoffMultiplier: 2 },
                failover: { maxModelSwitchesPerRequest: 2 },
                logDecisions: false
            }
        });

        proxyServer = new ProxyServer({ config });
        const server = await proxyServer.start();
        const address = server.address();
        proxyUrl = `http://127.0.0.1:${address.port}`;

        // Disable pool-level cooldown so 429 retries proceed without being blocked.
        // Pool cooldown is tested elsewhere; here we specifically test model routing during retry.
        proxyServer.requestHandler.keyManager.getPoolCooldownRemainingMs = () => 0;

        // Replace HTTPS agent with one that accepts self-signed certs from mock upstream.
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
        upstreamPort = null;
        try {
            const files = fs.readdirSync(testDir);
            files.forEach(f => {
                try { fs.unlinkSync(path.join(testDir, f)); } catch (_e) { /* ignore */ }
            });
            fs.rmdirSync(testDir);
        } catch (_e) { /* ignore */ }
    });

    test('429 triggers model switch on retry via fallback chain', async () => {
        upstream.force429ForNext(1);

        const body = JSON.stringify({
            model: 'claude-3-opus-20240229',
            max_tokens: 1024,
            messages: [{ role: 'user', content: 'test' }]
        });

        const res = await request(`${proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(body)),
                'x-api-key': 'testkey1'
            },
            body
        });

        // Should succeed after retry with fallback model
        expect(res.statusCode).toBe(200);

        const requests = upstream.getRequests();
        expect(requests.length).toBe(2);

        // First attempt: primary model for heavy tier (position 0 in models[])
        const firstBody = JSON.parse(requests[0].body);
        expect(firstBody.model).toBe('glm-4-plus');

        // Retry: pool selection skips glm-4-plus (in attemptedModels set) and picks
        // the next best scored model. In v2 pool mode, attemptedModels filtering
        // is the mechanism (not the v1 failover chain).
        const secondBody = JSON.parse(requests[1].body);
        expect(secondBody.model).toBe('glm-4-air');

        // The model switch (glm-4-plus -> glm-4-air) is the primary verification.
        // Stats counters are checked separately in the routing state tests.
    });

    test('maxModelSwitchesPerRequest: 0 — pool selection still avoids failed models', async () => {
        // In v2 pool mode, maxModelSwitchesPerRequest gates the v1 failover path,
        // but pool selection independently avoids attemptedModels. The retry handler
        // tracks models across attempts, so the pool picks the next available model.
        const configBody = JSON.stringify({ failover: { maxModelSwitchesPerRequest: 0 } });
        await request(`${proxyUrl}/model-routing`, {
            method: 'PUT',
            headers: {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(configBody))
            },
            body: configBody
        });

        upstream.force429ForNext(1);

        const body = JSON.stringify({
            model: 'claude-3-opus-20240229',
            max_tokens: 1024,
            messages: [{ role: 'user', content: 'test' }]
        });

        const res = await request(`${proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(body)),
                'x-api-key': 'testkey1'
            },
            body
        });

        // Retry fires and succeeds (pool avoids the 429'd model)
        expect(res.statusCode).toBe(200);

        const requests = upstream.getRequests();
        expect(requests.length).toBe(2);

        // First attempt: primary model from heavy tier pool
        const firstBody = JSON.parse(requests[0].body);
        expect(firstBody.model).toBe('glm-4-plus');

        // Second attempt: pool skips glm-4-plus (in attemptedModels), picks next best.
        // maxModelSwitchesPerRequest doesn't gate v2 pool selection's attemptedModels filter.
        const secondBody = JSON.parse(requests[1].body);
        expect(['glm-4-air', 'glm-4-flash']).toContain(secondBody.model);
    });
});

describe('Model Routing Burst Dampening', () => {
    let testDir;
    let proxyServer;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-burst-'));
        const { ProxyServer } = require('../lib/proxy-server');
        proxyServer = new ProxyServer({
            apiKeys: ['sk-ant-test-key1'],
            port: 0,
            logLevel: 'silent',
            modelRouting: {
                enabled: true,
                defaultModel: 'glm-4-plus',
                cooldown: {
                    defaultMs: 5000,
                    maxMs: 30000,
                    decayMs: 60000,
                    backoffMultiplier: 2,
                    maxCooldownEntries: 50,
                    burstDampeningFactor: 0.2
                },
                tiers: {
                    heavy: { targetModel: 'glm-4-plus', fallbackModels: ['glm-4-air'] },
                    medium: { targetModel: 'glm-4-air', fallbackModels: [] },
                    light: { targetModel: 'glm-4-flash', fallbackModels: [] }
                }
            },
            configDir: testDir
        });
    });

    afterEach(() => {
        if (proxyServer?.server?.listening) {
            proxyServer.server.close();
        }
        // Clean up file watchers to prevent Jest open handle warnings
        if (proxyServer?.routePolicyManager) {
            proxyServer.routePolicyManager.stopWatching();
        }
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    test('burst-dampened cooldown shows burstDampened flag in cooldowns', () => {
        proxyServer.modelRouter.recordModelCooldown('glm-4-plus', 5000, { burstDampened: true });
        const cooldowns = proxyServer.modelRouter.getCooldowns();
        expect(cooldowns['glm-4-plus']).toBeDefined();
        expect(cooldowns['glm-4-plus'].burstDampened).toBe(true);
        expect(cooldowns['glm-4-plus'].count).toBe(0);
    });

    test('burstDampenedTotal appears in stats', () => {
        proxyServer.modelRouter.recordModelCooldown('glm-4-plus', 1000, { burstDampened: true });
        proxyServer.modelRouter.recordModelCooldown('glm-4-plus', 1000, { burstDampened: true });
        proxyServer.modelRouter.recordModelCooldown('glm-4-air', 2000, { burstDampened: true });
        const stats = proxyServer.modelRouter.getStats();
        expect(stats.burstDampenedTotal).toBe(3);
    });

    test('burst-dampened calls do not escalate cooldown count', () => {
        // 5 burst-dampened calls simulating pool burst
        for (let i = 0; i < 5; i++) {
            proxyServer.modelRouter.recordModelCooldown('glm-4-plus', 500, { burstDampened: true });
        }
        const cooldowns = proxyServer.modelRouter.getCooldowns();
        expect(cooldowns['glm-4-plus'].count).toBe(0);

        // 1 normal call after burst
        proxyServer.modelRouter.recordModelCooldown('glm-4-plus', 1000);
        const after = proxyServer.modelRouter.getCooldowns();
        expect(after['glm-4-plus'].count).toBe(1);
        expect(after['glm-4-plus'].burstDampened).toBe(false);
    });
});

describe('Auth and Persistence Tests', () => {
    let authTestDir;
    let authProxyServer;
    let authProxyUrl;

    afterEach(async () => {
        if (authProxyServer) {
            await authProxyServer.shutdown();
            authProxyServer = null;
        }
        if (authTestDir) {
            fs.rmSync(authTestDir, { recursive: true, force: true });
        }
    });

    test('/model-selection returns 401 when adminAuth enabled and token missing', async () => {
        resetConfig();
        resetLogger();

        authTestDir = path.join(os.tmpdir(), 'model-routing-auth-' + Date.now());
        fs.mkdirSync(authTestDir, { recursive: true });
        fs.writeFileSync(
            path.join(authTestDir, 'test-keys.json'),
            JSON.stringify({
                keys: ['testkey1.secret1'],
                baseUrl: 'https://127.0.0.1:19998/api'
            })
        );

        const config = new Config({
            configDir: authTestDir,
            keysFile: 'test-keys.json',
            statsFile: 'test-stats.json',
            useCluster: false,
            port: 0,
            logLevel: 'ERROR',
            adminAuth: {
                enabled: true,
                headerName: 'x-admin-token',
                tokens: ['test-admin-token-123'],
                protectedPaths: ['/model-selection', '/model-routing', '/control/']
            },
            modelRouting: {
                enabled: true,
                defaultModel: 'glm-4-air',
                tiers: {
                    light: { targetModel: 'glm-4-flash', clientModelPolicy: 'always-route' },
                    medium: { targetModel: 'glm-4-air', clientModelPolicy: 'always-route' },
                    heavy: { targetModel: 'glm-4-plus', clientModelPolicy: 'always-route' }
                }
            }
        });

        authProxyServer = new ProxyServer({ config });
        await authProxyServer.start();
        const port = authProxyServer.server.address().port;
        authProxyUrl = `http://127.0.0.1:${port}`;

        // Without token → 401
        const res = await request(`${authProxyUrl}/model-selection`);
        expect(res.statusCode).toBe(401);

        // With token → 200
        const resAuth = await request(`${authProxyUrl}/model-selection`, {
            headers: { 'x-admin-token': 'test-admin-token-123' }
        });
        expect(resAuth.statusCode).toBe(200);
    });

    test('PUT /model-routing with shadowMode persists to disk', async () => {
        resetConfig();
        resetLogger();

        authTestDir = path.join(os.tmpdir(), 'model-routing-persist-' + Date.now());
        fs.mkdirSync(authTestDir, { recursive: true });
        fs.writeFileSync(
            path.join(authTestDir, 'test-keys.json'),
            JSON.stringify({
                keys: ['testkey1.secret1'],
                baseUrl: 'https://127.0.0.1:19998/api'
            })
        );

        const config = new Config({
            configDir: authTestDir,
            keysFile: 'test-keys.json',
            statsFile: 'test-stats.json',
            useCluster: false,
            port: 0,
            logLevel: 'ERROR',
            modelRouting: {
                enabled: true,
                defaultModel: 'glm-4-air',
                persistConfigEdits: true,
                configFile: 'model-routing.json',
                tiers: {
                    light: { targetModel: 'glm-4-flash', clientModelPolicy: 'always-route' },
                    medium: { targetModel: 'glm-4-air', clientModelPolicy: 'always-route' },
                    heavy: { targetModel: 'glm-4-plus', clientModelPolicy: 'always-route' }
                }
            }
        });

        authProxyServer = new ProxyServer({ config });
        await authProxyServer.start();
        const port = authProxyServer.server.address().port;
        authProxyUrl = `http://127.0.0.1:${port}`;

        // PUT with shadowMode: true
        const putRes = await request(`${authProxyUrl}/model-routing`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ shadowMode: true })
        });
        expect(putRes.statusCode).toBe(200);
        const putData = putRes.json();
        expect(putData.persisted).toBe(true);

        // Wait briefly for async file write
        await new Promise(r => setTimeout(r, 200));

        // Verify file on disk includes shadowMode
        const configPath = path.join(authTestDir, 'model-routing.json');
        const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        expect(persisted.shadowMode).toBe(true);
    });

    test('/model-routing/enable-safe enables routing', async () => {
        resetConfig();
        resetLogger();

        authTestDir = path.join(os.tmpdir(), 'model-routing-safe-' + Date.now());
        fs.mkdirSync(authTestDir, { recursive: true });
        fs.writeFileSync(
            path.join(authTestDir, 'test-keys.json'),
            JSON.stringify({
                keys: ['testkey1.secret1'],
                baseUrl: 'https://127.0.0.1:19998/api'
            })
        );

        const config = new Config({
            configDir: authTestDir,
            keysFile: 'test-keys.json',
            statsFile: 'test-stats.json',
            useCluster: false,
            port: 0,
            logLevel: 'ERROR',
            modelRouting: {
                enabled: false,
                tiers: {
                    light: { targetModel: 'glm-4-flash', clientModelPolicy: 'always-route' },
                    medium: { targetModel: 'glm-4-air', clientModelPolicy: 'always-route' },
                    heavy: { targetModel: 'glm-4-plus', clientModelPolicy: 'always-route' }
                }
            }
        });

        authProxyServer = new ProxyServer({ config });
        await authProxyServer.start();
        const port = authProxyServer.server.address().port;
        authProxyUrl = `http://127.0.0.1:${port}`;

        // Verify disabled initially
        const getRes = await request(`${authProxyUrl}/model-routing`);
        expect(getRes.json().enabled).toBe(false);

        // Enable via enable-safe
        const putRes = await request(`${authProxyUrl}/model-routing/enable-safe`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({})
        });
        expect(putRes.statusCode).toBe(200);
        expect(putRes.json().success).toBe(true);
        expect(putRes.json().enabled).toBe(true);

        // Persisted config should keep canonical v2 version stamp
        await new Promise(r => setTimeout(r, 200));
        const configPath = path.join(authTestDir, 'model-routing.json');
        const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        expect(typeof persisted.version).toBe('string');
        expect(persisted.version).toMatch(/^2(\.|$)/);

        // Verify now enabled
        const getRes2 = await request(`${authProxyUrl}/model-routing`);
        expect(getRes2.json().enabled).toBe(true);
    });

    test('/model-routing/import-from-mappings returns shape with GET', async () => {
        resetConfig();
        resetLogger();

        authTestDir = path.join(os.tmpdir(), 'model-routing-import-' + Date.now());
        fs.mkdirSync(authTestDir, { recursive: true });
        fs.writeFileSync(
            path.join(authTestDir, 'test-keys.json'),
            JSON.stringify({
                keys: ['testkey1.secret1'],
                baseUrl: 'https://127.0.0.1:19998/api'
            })
        );

        const config = new Config({
            configDir: authTestDir,
            keysFile: 'test-keys.json',
            statsFile: 'test-stats.json',
            useCluster: false,
            port: 0,
            logLevel: 'ERROR',
            modelRouting: {
                enabled: true,
                defaultModel: 'glm-4-air',
                tiers: {
                    light: { targetModel: 'glm-4-flash', clientModelPolicy: 'always-route' },
                    medium: { targetModel: 'glm-4-air', clientModelPolicy: 'always-route' },
                    heavy: { targetModel: 'glm-4-plus', clientModelPolicy: 'always-route' }
                }
            }
        });

        authProxyServer = new ProxyServer({ config });
        await authProxyServer.start();
        const port = authProxyServer.server.address().port;
        authProxyUrl = `http://127.0.0.1:${port}`;

        const getRes = await request(`${authProxyUrl}/model-routing/import-from-mappings`);
        // Should return 200 with import results (even if no mappings to import)
        expect(getRes.statusCode).toBe(200);
        const data = getRes.json();
        expect(data).toHaveProperty('success');
    });

    // TRUST-02: /model-routing/simulate endpoint tests
    describe('POST /model-routing/simulate', () => {

        test('decision mode returns simulation with all models available', async () => {
            resetConfig();
            resetLogger();

            const testDir = path.join(os.tmpdir(), 'simulate-decision-' + Date.now());
            fs.mkdirSync(testDir, { recursive: true });
            fs.writeFileSync(
                path.join(testDir, 'test-keys.json'),
                JSON.stringify({
                    keys: ['testkey1.secret1'],
                    baseUrl: 'https://127.0.0.1:19998/api'
                })
            );

            const config = new Config({
                configDir: testDir,
                keysFile: 'test-keys.json',
                statsFile: 'test-stats.json',
                useCluster: false,
                port: 0,
                logLevel: 'ERROR',
                modelRouting: {
                    enabled: true,
                    tiers: {
                        heavy: {
                            models: ['glm-4-plus', 'glm-4-flash'],
                            strategy: 'pool'
                        }
                    }
                }
            });

            const proxyServer = new ProxyServer({ config });
            await proxyServer.start();
            const port = proxyServer.server.address().port;
            const proxyUrl = `http://127.0.0.1:${port}`;

            try {
                const res = await request(`${proxyUrl}/model-routing/simulate`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        mode: 'decision',
                        model: 'claude-opus-4-20250514',
                        maxTokens: 4096
                    })
                });

                expect(res.statusCode).toBe(200);
                const data = res.json();
                expect(data.mode).toBe('decision');
                expect(data.selectedModel).toBeDefined();
                expect(data.tier).toBe('heavy');
                expect(data.cooldownReasons).toEqual([]);
                expect(data.trace).toBeDefined();
                expect(data.trace.requestId).toBeDefined();
            } finally {
                await proxyServer.shutdown();
            }
        });

        test('stateful mode returns simulation based on provided snapshot', async () => {
            resetConfig();
            resetLogger();

            const testDir = path.join(os.tmpdir(), 'simulate-stateful-' + Date.now());
            fs.mkdirSync(testDir, { recursive: true });
            fs.writeFileSync(
                path.join(testDir, 'test-keys.json'),
                JSON.stringify({
                    keys: ['testkey1.secret1'],
                    baseUrl: 'https://127.0.0.1:19998/api'
                })
            );

            const config = new Config({
                configDir: testDir,
                keysFile: 'test-keys.json',
                statsFile: 'test-stats.json',
                useCluster: false,
                port: 0,
                logLevel: 'ERROR',
                modelRouting: {
                    enabled: true,
                    tiers: {
                        heavy: {
                            models: ['glm-4-plus', 'glm-4-flash'],
                            strategy: 'pool'
                        }
                    }
                }
            });

            const proxyServer = new ProxyServer({ config });
            await proxyServer.start();
            const port = proxyServer.server.address().port;
            const proxyUrl = `http://127.0.0.1:${port}`;

            try {
                const snapshot = {
                    version: '1.0',
                    timestamp: Date.now(),
                    models: [
                        {
                            modelId: 'glm-4-plus',
                            tier: 'heavy',
                            inFlight: 2,
                            maxConcurrency: 2,
                            isAvailable: false,
                            cooldownUntil: Date.now() + 5000
                        },
                        {
                            modelId: 'glm-4-flash',
                            tier: 'heavy',
                            inFlight: 0,
                            maxConcurrency: 2,
                            isAvailable: true
                        }
                    ]
                };

                const res = await request(`${proxyUrl}/model-routing/simulate`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        mode: 'stateful',
                        snapshot,
                        model: 'claude-opus-4-20250514',
                        maxTokens: 4096
                    })
                });

                expect(res.statusCode).toBe(200);
                const data = res.json();
                expect(data.mode).toBe('stateful');
                expect(data.selectedModel).toBeDefined();
                expect(data.tier).toBe('heavy');
                expect(data.snapshotTimestamp).toBe(snapshot.timestamp);
                expect(data.trace).toBeDefined();
            } finally {
                await proxyServer.shutdown();
            }
        });

        test('stateful mode without snapshot returns 400', async () => {
            resetConfig();
            resetLogger();

            const testDir = path.join(os.tmpdir(), 'simulate-stateful-no-snapshot-' + Date.now());
            fs.mkdirSync(testDir, { recursive: true });
            fs.writeFileSync(
                path.join(testDir, 'test-keys.json'),
                JSON.stringify({
                    keys: ['testkey1.secret1'],
                    baseUrl: 'https://127.0.0.1:19998/api'
                })
            );

            const config = new Config({
                configDir: testDir,
                keysFile: 'test-keys.json',
                statsFile: 'test-stats.json',
                useCluster: false,
                port: 0,
                logLevel: 'ERROR',
                modelRouting: {
                    enabled: true
                }
            });

            const proxyServer = new ProxyServer({ config });
            await proxyServer.start();
            const port = proxyServer.server.address().port;
            const proxyUrl = `http://127.0.0.1:${port}`;

            try {
                const res = await request(`${proxyUrl}/model-routing/simulate`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        mode: 'stateful',
                        model: 'claude-opus-4-20250514'
                    })
                });

                expect(res.statusCode).toBe(400);
            } finally {
                await proxyServer.shutdown();
            }
        });

        test('decision mode with snapshot returns 400', async () => {
            resetConfig();
            resetLogger();

            const testDir = path.join(os.tmpdir(), 'simulate-decision-with-snapshot-' + Date.now());
            fs.mkdirSync(testDir, { recursive: true });
            fs.writeFileSync(
                path.join(testDir, 'test-keys.json'),
                JSON.stringify({
                    keys: ['testkey1.secret1'],
                    baseUrl: 'https://127.0.0.1:19998/api'
                })
            );

            const config = new Config({
                configDir: testDir,
                keysFile: 'test-keys.json',
                statsFile: 'test-stats.json',
                useCluster: false,
                port: 0,
                logLevel: 'ERROR',
                modelRouting: {
                    enabled: true
                }
            });

            const proxyServer = new ProxyServer({ config });
            await proxyServer.start();
            const port = proxyServer.server.address().port;
            const proxyUrl = `http://127.0.0.1:${port}`;

            try {
                const res = await request(`${proxyUrl}/model-routing/simulate`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        mode: 'decision',
                        snapshot: { version: '1.0', timestamp: Date.now(), models: [] },
                        model: 'claude-opus-4-20250514'
                    })
                });

                expect(res.statusCode).toBe(400);
            } finally {
                await proxyServer.shutdown();
            }
        });

        test('invalid mode returns 400', async () => {
            resetConfig();
            resetLogger();

            const testDir = path.join(os.tmpdir(), 'simulate-invalid-mode-' + Date.now());
            fs.mkdirSync(testDir, { recursive: true });
            fs.writeFileSync(
                path.join(testDir, 'test-keys.json'),
                JSON.stringify({
                    keys: ['testkey1.secret1'],
                    baseUrl: 'https://127.0.0.1:19998/api'
                })
            );

            const config = new Config({
                configDir: testDir,
                keysFile: 'test-keys.json',
                statsFile: 'test-stats.json',
                useCluster: false,
                port: 0,
                logLevel: 'ERROR',
                modelRouting: {
                    enabled: true
                }
            });

            const proxyServer = new ProxyServer({ config });
            await proxyServer.start();
            const port = proxyServer.server.address().port;
            const proxyUrl = `http://127.0.0.1:${port}`;

            try {
                const res = await request(`${proxyUrl}/model-routing/simulate`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        mode: 'invalid',
                        model: 'claude-opus-4-20250514'
                    })
                });

                expect(res.statusCode).toBe(400);
            } finally {
                await proxyServer.shutdown();
            }
        });

        test('unsupported snapshot version returns 400', async () => {
            resetConfig();
            resetLogger();

            const testDir = path.join(os.tmpdir(), 'simulate-invalid-snapshot-' + Date.now());
            fs.mkdirSync(testDir, { recursive: true });
            fs.writeFileSync(
                path.join(testDir, 'test-keys.json'),
                JSON.stringify({
                    keys: ['testkey1.secret1'],
                    baseUrl: 'https://127.0.0.1:19998/api'
                })
            );

            const config = new Config({
                configDir: testDir,
                keysFile: 'test-keys.json',
                statsFile: 'test-stats.json',
                useCluster: false,
                port: 0,
                logLevel: 'ERROR',
                modelRouting: {
                    enabled: true
                }
            });

            const proxyServer = new ProxyServer({ config });
            await proxyServer.start();
            const port = proxyServer.server.address().port;
            const proxyUrl = `http://127.0.0.1:${port}`;

            try {
                const res = await request(`${proxyUrl}/model-routing/simulate`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        mode: 'stateful',
                        snapshot: { version: '2.0', timestamp: Date.now(), models: [] },
                        model: 'claude-opus-4-20250514'
                    })
                });

                expect(res.statusCode).toBe(400);
            } finally {
                await proxyServer.shutdown();
            }
        });
    });
});
