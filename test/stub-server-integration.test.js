/**
 * StubServer Integration Tests
 *
 * Uses the StubServer (plain HTTP) as a real upstream to test the proxy's
 * retry logic, error handling, and scenario queuing — without HTTPS certs
 * or mock modules.
 *
 * Roadmap items:
 *   M3.2  Transient overflow retry / 500→500→200 retry sequence
 *   M3.3  /v1/messages retry-sequence via queueScenarios()
 */

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { StubServer } = require('./helpers/stub-server');
const { ProxyServer } = require('../lib/proxy-server');
const { Config, resetConfig } = require('../lib/config');
const { resetLogger } = require('../lib/logger');

// ── HTTP helper ──────────────────────────────────────────────────────────

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
                    json() { try { return JSON.parse(data); } catch (_) { return null; } }
                });
            });
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

// ── Test infrastructure ──────────────────────────────────────────────────

/**
 * Create a proxy server pointing at a StubServer (HTTP upstream).
 * This avoids HTTPS self-signed cert complexity.
 */
async function createProxyWithStub(stubUrl, configOverrides = {}) {
    const testDir = path.join(
        os.tmpdir(),
        'stub-int-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    );
    fs.mkdirSync(testDir, { recursive: true });

    const keys = configOverrides._keys || [
        'testkey1.secret1',
        'testkey2.secret2',
        'testkey3.secret3'
    ];
    delete configOverrides._keys;

    // baseUrl uses http:// so the proxy will use http.request
    fs.writeFileSync(
        path.join(testDir, 'test-keys.json'),
        JSON.stringify({ keys, baseUrl: stubUrl })
    );

    const config = new Config({
        configDir: testDir,
        keysFile: 'test-keys.json',
        statsFile: 'test-stats.json',
        useCluster: false,
        port: 0,
        logLevel: 'ERROR',
        requestTimeout: 10000,
        maxRetries: 3,
        security: { rateLimit: { enabled: false } },
        usageMonitor: { enabled: false },
        ...configOverrides
    });

    const proxyServer = new ProxyServer({ config });
    const server = await proxyServer.start();
    const address = server.address();

    return {
        proxyServer,
        proxyUrl: `http://127.0.0.1:${address.port}`,
        testDir,
        async shutdown() {
            await proxyServer.shutdown();
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    };
}

/** Standard /v1/messages POST body */
function llmBody(model = 'claude-sonnet-4-20250514') {
    return JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 256
    });
}

// ═══════════════════════════════════════════════════════════════════════
// M3.2: Server Error Retry Sequences
// ═══════════════════════════════════════════════════════════════════════

describe('StubServer Integration: server error retries (M3.2)', () => {
    let stub;
    let proxy;

    beforeEach(async () => {
        stub = new StubServer();
        await stub.start();
    });

    afterEach(async () => {
        if (proxy) { await proxy.shutdown(); proxy = null; }
        if (stub) { await stub.stop(); stub = null; }
        resetConfig();
        resetLogger();
    });

    test('retries through 500 errors and succeeds on third attempt', async () => {
        stub.queueScenarios('error500', 'error500', 'success');
        proxy = await createProxyWithStub(stub.url);

        const res = await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: llmBody()
        });

        expect(res.statusCode).toBe(200);
        // 2 failures + 1 success = 3 upstream requests
        expect(stub.stats.requests).toBe(3);
        expect(stub.stats.errors500).toBe(2);
        expect(stub.stats.successes).toBe(1);
    }, 30000);

    test('exhausts maxRetries on persistent 500 and returns error', async () => {
        // maxRetries=3 means 4 total attempts (0,1,2,3)
        stub.queueScenarios('error500', 'error500', 'error500', 'error500', 'error500');
        proxy = await createProxyWithStub(stub.url, { maxRetries: 3 });

        const res = await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: llmBody()
        });

        // Proxy returns 503 after exhausting retries (service unavailable)
        expect(res.statusCode).toBe(503);
        // maxRetries=3 → up to 4 attempts, but server_error strategy has maxRetries=3
        // The lower of (global maxRetries, strategy maxRetries) applies
        expect(stub.stats.requests).toBeGreaterThanOrEqual(3);
        expect(stub.stats.requests).toBeLessThanOrEqual(4);
    }, 30000);

    test('retries auth error (401) and succeeds with different key', async () => {
        // 401 triggers key exclusion + retry with a fresh key
        stub.queueScenarios('error401', 'success');
        proxy = await createProxyWithStub(stub.url);

        const res = await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: llmBody()
        });

        expect(res.statusCode).toBe(200);
        expect(stub.stats.requests).toBe(2);
        expect(stub.stats.errors401).toBe(1);
        expect(stub.stats.successes).toBe(1);
    }, 30000);
});

// ═══════════════════════════════════════════════════════════════════════
// M3.3: /v1/messages Retry Sequences via queueScenarios()
// ═══════════════════════════════════════════════════════════════════════

describe('StubServer Integration: /v1/messages retry sequences (M3.3)', () => {
    let stub;
    let proxy;

    beforeEach(async () => {
        stub = new StubServer();
        await stub.start();
    });

    afterEach(async () => {
        if (proxy) { await proxy.shutdown(); proxy = null; }
        if (stub) { await stub.stop(); stub = null; }
        resetConfig();
        resetLogger();
    });

    test('retries LLM route 429 with key rotation and succeeds', async () => {
        // First request → 429 (key rotated), second → 200
        stub.queueScenarios('rate429', 'success');
        proxy = await createProxyWithStub(stub.url);

        const res = await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: llmBody()
        });

        expect(res.statusCode).toBe(200);
        expect(stub.stats.requests).toBe(2);
        expect(stub.stats.errors429).toBe(1);
        expect(stub.stats.successes).toBe(1);
    }, 30000);

    test('telemetry routes are dropped locally (not forwarded to upstream)', async () => {
        stub.setScenario('rate429');
        proxy = await createProxyWithStub(stub.url);

        // /api/event_logging is a telemetry route → dropped locally with 204
        const res = await request(`${proxy.proxyUrl}/api/event_logging`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ event: 'test' })
        });

        // Telemetry short-circuit: 204 No Content, never hits upstream
        expect(res.statusCode).toBe(204);
        expect(stub.stats.requests).toBe(0);
    }, 15000);

    test('mixed error sequence: 500 → 429 → 200 succeeds', async () => {
        stub.queueScenarios('error500', 'rate429', 'success');
        proxy = await createProxyWithStub(stub.url);

        const res = await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: llmBody()
        });

        expect(res.statusCode).toBe(200);
        expect(stub.stats.requests).toBe(3);
        expect(stub.stats.errors500).toBe(1);
        expect(stub.stats.errors429).toBe(1);
        expect(stub.stats.successes).toBe(1);
    }, 30000);

    test('queueScenarios executes in deterministic order', async () => {
        // Queue a specific pattern and verify exact sequence
        stub.queueScenarios('error500', 'error500', 'success');
        proxy = await createProxyWithStub(stub.url);

        const res = await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: llmBody()
        });

        expect(res.statusCode).toBe(200);

        // Verify each request was received (bodies tracked)
        expect(stub.stats.requestBodies).toHaveLength(3);
        // Verify headers were tracked (all should have x-api-key)
        expect(stub.stats.requestHeaders).toHaveLength(3);
        for (const headers of stub.stats.requestHeaders) {
            expect(headers['x-api-key']).toBeDefined();
        }
    }, 30000);

    test('stats track all request details across retries', async () => {
        stub.queueScenarios('error500', 'success');
        proxy = await createProxyWithStub(stub.url);

        await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: llmBody()
        });

        // StubServer tracks full request bodies for debugging
        expect(stub.stats.requestBodies).toHaveLength(2);
        const firstBody = JSON.parse(stub.stats.requestBodies[0]);
        const secondBody = JSON.parse(stub.stats.requestBodies[1]);

        // Both should have the model field (proxy rewrites claude → glm)
        expect(firstBody.model).toBeDefined();
        expect(secondBody.model).toBeDefined();

        // Both should have messages
        expect(firstBody.messages).toBeDefined();
        expect(secondBody.messages).toBeDefined();
    }, 30000);

    test('auth error (401) triggers key rotation and retry', async () => {
        stub.queueScenarios('error401', 'success');
        proxy = await createProxyWithStub(stub.url);

        const res = await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: llmBody()
        });

        expect(res.statusCode).toBe(200);
        expect(stub.stats.requests).toBe(2);
        expect(stub.stats.errors401).toBe(1);
        expect(stub.stats.successes).toBe(1);

        // Verify key rotation: second request should use a different key
        const key1 = stub.stats.requestHeaders[0]['x-api-key'];
        const key2 = stub.stats.requestHeaders[1]['x-api-key'];
        expect(key1).not.toBe(key2);
    }, 30000);

    test('reset() clears stats between test sequences', async () => {
        stub.queueScenarios('error500', 'success');
        proxy = await createProxyWithStub(stub.url);

        await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: llmBody()
        });

        expect(stub.stats.requests).toBe(2);

        // Reset stats
        stub.reset();
        expect(stub.stats.requests).toBe(0);
        expect(stub.stats.requestBodies).toHaveLength(0);
        expect(stub.stats.requestHeaders).toHaveLength(0);

        // Second sequence uses fresh stats
        stub.queueScenarios('success');
        await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: llmBody()
        });

        expect(stub.stats.requests).toBe(1);
        expect(stub.stats.successes).toBe(1);
    }, 30000);
});

// ═══════════════════════════════════════════════════════════════════════
// StatsAggregator counter verification
// ═══════════════════════════════════════════════════════════════════════

describe('StubServer Integration: stats counters', () => {
    let stub;
    let proxy;

    beforeEach(async () => {
        stub = new StubServer();
        await stub.start();
    });

    afterEach(async () => {
        if (proxy) { await proxy.shutdown(); proxy = null; }
        if (stub) { await stub.stop(); stub = null; }
        resetConfig();
        resetLogger();
    });

    test('upstream 429 increments statsAggregator upstream429 counter', async () => {
        stub.queueScenarios('rate429', 'success');
        proxy = await createProxyWithStub(stub.url);

        await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: llmBody()
        });

        const stats = proxy.proxyServer.requestHandler.statsAggregator;
        expect(stats.rateLimitTracking.upstream429s).toBeGreaterThanOrEqual(1);
        expect(stats.rateLimitTracking.llm429Retries).toBeGreaterThanOrEqual(1);
    }, 30000);
});

// ═══════════════════════════════════════════════════════════════════════
// M4.2: /adaptive-concurrency API endpoint
// ═══════════════════════════════════════════════════════════════════════

describe('StubServer Integration: /adaptive-concurrency API (M4.2)', () => {
    let stub;
    let proxy;

    beforeEach(async () => {
        stub = new StubServer();
        await stub.start();
    });

    afterEach(async () => {
        if (proxy) { await proxy.shutdown(); proxy = null; }
        if (stub) { await stub.stop(); stub = null; }
        resetConfig();
        resetLogger();
    });

    test('GET /adaptive-concurrency returns AIMD snapshot', async () => {
        proxy = await createProxyWithStub(stub.url, {
            adaptiveConcurrency: { enabled: true, mode: 'observe_only' }
        });

        const res = await request(`${proxy.proxyUrl}/adaptive-concurrency`);

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.mode).toBe('observe_only');
        expect(body.models).toBeDefined();
    }, 15000);

    test('PUT /adaptive-concurrency toggles mode to enforce', async () => {
        proxy = await createProxyWithStub(stub.url, {
            adaptiveConcurrency: { enabled: true, mode: 'observe_only' }
        });

        const res = await request(`${proxy.proxyUrl}/adaptive-concurrency`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'enforce' })
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.success).toBe(true);
        expect(body.previousMode).toBe('observe_only');
        expect(body.currentMode).toBe('enforce');
    }, 15000);

    test('PUT /adaptive-concurrency rejects invalid mode', async () => {
        proxy = await createProxyWithStub(stub.url, {
            adaptiveConcurrency: { enabled: true, mode: 'observe_only' }
        });

        const res = await request(`${proxy.proxyUrl}/adaptive-concurrency`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'invalid' })
        });

        expect(res.statusCode).toBe(400);
    }, 15000);

    test('GET returns 503 when adaptive concurrency is disabled', async () => {
        proxy = await createProxyWithStub(stub.url, {
            adaptiveConcurrency: { enabled: false }
        });

        const res = await request(`${proxy.proxyUrl}/adaptive-concurrency`);

        expect(res.statusCode).toBe(503);
    }, 15000);
});
