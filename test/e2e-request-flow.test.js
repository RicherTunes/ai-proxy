'use strict';

/**
 * E2E Request Flow Tests
 *
 * Tests the full request lifecycle: client -> proxy -> mock upstream -> client.
 *
 * Focuses on flows NOT covered by e2e-smoke.test.js or e2e-dynamic.test.js:
 * - Request tracking via /requests endpoint
 * - Cost tracking via /stats/cost endpoint
 * - Circuit breaker trip under repeated failures
 * - All-keys-exhausted 503 with StubServer
 * - Model routing to correct upstream model
 * - Stats counter increments after proxy round-trip
 * - Upstream 429 with retry (StubServer scenario queue)
 * - Upstream 500 persistent failure
 *
 * Uses plain HTTP upstream (StubServer) to avoid SSL certificate complexity.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProxyServer } = require('../lib/proxy-server');
const { Config, resetConfig } = require('../lib/config');
const { resetLogger } = require('../lib/logger');
const { StubServer } = require('./helpers/stub-server');

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
                    json: () => { try { return JSON.parse(data); } catch (_) { return null; } }
                });
            });
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

// ── Proxy factory ────────────────────────────────────────────────────────

/**
 * Create a proxy pointed at a plain HTTP upstream.
 * Sets targetProtocol to 'http:' so the proxy uses http.request instead of https.
 */
async function createProxy(upstreamPort, configOverrides = {}) {
    resetConfig();
    resetLogger();

    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-reqflow-'));
    const keys = configOverrides._keys || [
        'testkey1.secret1',
        'testkey2.secret2',
        'testkey3.secret3'
    ];
    delete configOverrides._keys;

    fs.writeFileSync(
        path.join(testDir, 'test-keys.json'),
        JSON.stringify({
            keys,
            baseUrl: `http://127.0.0.1:${upstreamPort}`
        })
    );

    const config = new Config({
        configDir: testDir,
        keysFile: 'test-keys.json',
        statsFile: 'test-stats.json',
        useCluster: false,
        port: 0,
        logLevel: 'ERROR',
        enableHotReload: false,
        // Cost tracking on for cost tests
        costTracking: {
            enabled: true,
            rates: { inputTokenPer1M: 3.00, outputTokenPer1M: 15.00 },
            budget: { daily: null, monthly: null, alertThresholds: [0.5, 0.8, 0.95, 1.0] },
            persistPath: 'cost-data.json'
        },
        // Request tracing on for /requests tests
        requestTracing: {
            enabled: true,
            maxTraces: 1000,
            captureBody: false,
            maxBodyPreview: 1024,
            excludePaths: ['/health', '/stats']
        },
        // Disable usage monitor (no real upstream to poll)
        usageMonitor: { enabled: false },
        // Disable rate limit sync (no real upstream)
        rateLimitSync: { enabled: false },
        // Disable upstream health monitor
        upstreamFallbacks: [],
        // Fast retries for tests
        retryConfig: {
            baseDelayMs: 10,
            maxDelayMs: 100,
            backoffMultiplier: 1.5,
            jitterPercent: 0.05
        },
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
            try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) { /* ok */ }
        }
    };
}

/** Standard Anthropic-style request body */
function anthropicBody(model = 'claude-sonnet-4-20250514', overrides = {}) {
    return JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 256,
        ...overrides
    });
}

/** Send a POST /v1/messages through the proxy */
function proxyPost(proxyUrl, body) {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    return request(`${proxyUrl}/v1/messages`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(bodyStr))
        },
        body: bodyStr
    });
}

// ═════════════════════════════════════════════════════════════════════════
// TESTS
// ═════════════════════════════════════════════════════════════════════════

describe('E2E Request Flow', () => {
    let stub;
    let proxy;

    beforeAll(async () => {
        stub = new StubServer();
        await stub.start();
    });

    afterAll(async () => {
        if (proxy) { await proxy.shutdown(); proxy = null; }
        if (stub) { await stub.stop(); stub = null; }
    });

    afterEach(async () => {
        if (proxy) { await proxy.shutdown(); proxy = null; }
        stub.reset();
        stub.setScenario('success');
        resetConfig();
        resetLogger();
    });

    // ── 1. Successful request round-trip ─────────────────────────────────

    test('successful request: client -> proxy -> upstream 200 -> client 200', async () => {
        stub.setScenario('success');
        const port = new URL(stub.url).port;
        proxy = await createProxy(port);

        const res = await proxyPost(proxy.proxyUrl, anthropicBody());

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body).not.toBeNull();
        // StubServer returns a usage block
        expect(body.usage).toBeDefined();
        expect(stub.stats.requests).toBe(1);
        expect(stub.stats.successes).toBe(1);
    });

    // ── 2. Upstream 429 with retry ───────────────────────────────────────

    test('upstream 429 then 200: proxy retries and client gets 200', async () => {
        // First call 429, second call success
        stub.queueScenarios('rate429', 'success');
        const port = new URL(stub.url).port;
        proxy = await createProxy(port, { maxRetries: 3 });

        const res = await proxyPost(proxy.proxyUrl, anthropicBody());

        // Proxy should retry after 429 and return 200
        expect(res.statusCode).toBe(200);
        expect(stub.stats.requests).toBeGreaterThanOrEqual(2);
        expect(stub.stats.errors429).toBe(1);
        expect(stub.stats.successes).toBe(1);
    }, 30000);

    // ── 3. Upstream 500 persistent ───────────────────────────────────────

    test('upstream 500 persistent: proxy retries and client gets error', async () => {
        stub.setScenario('error500');
        const port = new URL(stub.url).port;
        proxy = await createProxy(port, { maxRetries: 2 });

        const res = await proxyPost(proxy.proxyUrl, anthropicBody());

        // After exhausting retries, proxy returns 502 or 503
        expect([502, 503]).toContain(res.statusCode);
        // Should have attempted multiple times (initial + retries)
        expect(stub.stats.requests).toBeGreaterThan(1);
        expect(stub.stats.errors500).toBeGreaterThan(0);
    }, 30000);

    // ── 4. All keys exhausted ────────────────────────────────────────────

    test('all keys exhausted: client gets 502 or 503', async () => {
        stub.setScenario('error500');
        const port = new URL(stub.url).port;
        // Single key, maxRetries=2 -> key gets excluded after first failure
        proxy = await createProxy(port, {
            maxRetries: 2,
            _keys: ['singlekey.secret1']
        });

        const res = await proxyPost(proxy.proxyUrl, anthropicBody());

        expect([502, 503]).toContain(res.statusCode);
        const body = res.json();
        // Response should include retry-after header
        expect(res.headers['retry-after']).toBeDefined();
        // Should have a requestId in the error response
        expect(body.requestId).toBeDefined();
    }, 30000);

    // ── 5. Model routing ─────────────────────────────────────────────────

    test('model routing: claude-opus routed to correct upstream model', async () => {
        stub.setScenario('success');
        const port = new URL(stub.url).port;
        proxy = await createProxy(port, {
            modelRouting: {
                version: '2.0',
                enabled: true,
                tiers: {
                    heavy: {
                        models: ['glm-test-heavy'],
                        strategy: 'quality',
                        clientModelPolicy: 'rule-match-only'
                    },
                    light: {
                        models: ['glm-test-light'],
                        strategy: 'throughput',
                        clientModelPolicy: 'rule-match-only'
                    }
                },
                rules: [
                    { match: { model: 'claude-3-opus-*' }, tier: 'heavy' },
                    { match: { model: 'claude-3-haiku-*' }, tier: 'light' }
                ],
                logDecisions: false
            }
        });

        // Send an opus request
        await proxyPost(proxy.proxyUrl, anthropicBody('claude-3-opus-20240229'));

        // Verify the upstream received the routed model
        expect(stub.stats.requestBodies.length).toBe(1);
        const upstreamBody = JSON.parse(stub.stats.requestBodies[0]);
        expect(upstreamBody.model).toBe('glm-test-heavy');
    });

    // ── 6. Request tracking in /traces endpoint ─────────────────────────

    test('request tracking: completed request appears in /traces', async () => {
        stub.setScenario('success');
        const port = new URL(stub.url).port;
        proxy = await createProxy(port, {
            // Allow access to /traces without auth for test
            security: { debugEndpointsAlwaysRequireAuth: false }
        });

        // Send a proxied request
        const proxyRes = await proxyPost(proxy.proxyUrl, anthropicBody());
        expect(proxyRes.statusCode).toBe(200);

        // Small delay for async trace storage
        await new Promise(r => setTimeout(r, 200));

        // Check /traces endpoint (populated by RequestHandler.traceStore)
        const tracesRes = await request(`${proxy.proxyUrl}/traces`);
        expect(tracesRes.statusCode).toBe(200);

        const tracesData = tracesRes.json();
        expect(tracesData).not.toBeNull();
        expect(tracesData.traces).toBeDefined();
        expect(Array.isArray(tracesData.traces)).toBe(true);
        // At least one trace should be recorded
        expect(tracesData.traces.length).toBeGreaterThanOrEqual(1);

        // Verify trace has expected structure (getSummary() returns path, not method)
        const trace = tracesData.traces[0];
        expect(trace.traceId).toBeDefined();
        expect(trace.requestId).toBeDefined();
        expect(trace.path).toBe('/v1/messages');
        expect(trace.success).toBe(true);
        expect(trace.totalDuration).toBeGreaterThanOrEqual(0);
    });

    // ── 7. Stats update ──────────────────────────────────────────────────

    test('stats update: counters increment after request', async () => {
        stub.setScenario('success');
        const port = new URL(stub.url).port;
        proxy = await createProxy(port);

        // Get stats before
        const beforeRes = await request(`${proxy.proxyUrl}/stats`);
        const beforeStats = beforeRes.json();
        const beforeTotal = beforeStats.totalRequests || 0;

        // Send a proxied request
        await proxyPost(proxy.proxyUrl, anthropicBody());

        // Get stats after
        const afterRes = await request(`${proxy.proxyUrl}/stats`);
        const afterStats = afterRes.json();

        expect(afterStats.totalRequests).toBeGreaterThan(beforeTotal);
    });

    // ── 8. Cost tracking ─────────────────────────────────────────────────

    test('cost tracking: token usage recorded after request', async () => {
        stub.setScenario('success');
        const port = new URL(stub.url).port;
        proxy = await createProxy(port);

        // Send a proxied request (StubServer returns usage: {prompt_tokens: 100, completion_tokens: 50})
        const proxyRes = await proxyPost(proxy.proxyUrl, anthropicBody());
        expect(proxyRes.statusCode).toBe(200);

        // Small delay for async cost tracking
        await new Promise(r => setTimeout(r, 200));

        // Check /stats/cost endpoint
        const costRes = await request(`${proxy.proxyUrl}/stats/cost`);
        expect(costRes.statusCode).toBe(200);

        const costData = costRes.json();
        expect(costData).not.toBeNull();
        // After one request with 100 input + 50 output tokens, cost should be > 0
        // StubServer returns prompt_tokens: 100, completion_tokens: 50 (mapped to input/output)
        // At $3/M input + $15/M output: cost = (100/1M * 3) + (50/1M * 15) = 0.0003 + 0.00075 = 0.00105
        // CostTracker.getStats() returns: cost, inputTokens, outputTokens, totalTokens, requests
        expect(costData.cost).toBeGreaterThan(0);
        expect(costData.inputTokens).toBeGreaterThanOrEqual(100);
        expect(costData.outputTokens).toBeGreaterThanOrEqual(50);
        expect(costData.requests).toBeGreaterThanOrEqual(1);
    });

    // ── 9. Circuit breaker trip ──────────────────────────────────────────

    test('circuit breaker trip: repeated failures open circuit, next request uses different key', async () => {
        const port = new URL(stub.url).port;
        proxy = await createProxy(port, {
            maxRetries: 1,  // 1 retry = 2 attempts per request (0 is treated as 3 due to || 3 fallback)
            queueSize: 0,   // Disable queue to prevent waiting
            queueTimeout: 500,  // Short queue timeout
            circuitBreaker: {
                failureThreshold: 3,    // Open after 3 failures
                failureWindow: 30000,
                cooldownPeriod: 60000,
                halfOpenTimeout: 10000
            },
            // Disable model routing to simplify key selection
            modelRouting: { enabled: false },
            _keys: ['key-a.secret1', 'key-b.secret2', 'key-c.secret3']
        });

        // Send several requests that fail (500) to trip circuit breakers
        stub.setScenario('error500');

        // With 3 keys and failureThreshold=3, we need enough requests for
        // at least one key to accumulate 3+ failures and trip its circuit.
        // Each request uses 2 attempts (maxRetries=1), with key exclusion
        // on server_error, each attempt uses a different key.
        for (let i = 0; i < 6; i++) {
            await proxyPost(proxy.proxyUrl, anthropicBody());
        }

        // Collect all keys used by upstream
        const allKeys = stub.stats.requestHeaders.map(h => h['x-api-key']);
        const uniqueKeys = new Set(allKeys);

        // With 3 keys and retry+exclusion, multiple keys should have been tried
        expect(uniqueKeys.size).toBeGreaterThanOrEqual(2);

        // Verify circuit breaker state via /stats
        const statsRes = await request(`${proxy.proxyUrl}/stats`);
        const stats = statsRes.json();
        expect(stats.keys).toBeDefined();

        // At least one key should have failures recorded or circuit tripped
        const keysWithFailures = stats.keys.filter(k => k.recentFailures > 0 || k.state === 'OPEN');
        expect(keysWithFailures.length).toBeGreaterThan(0);
    }, 30000);
});
