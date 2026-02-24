/**
 * Provider Observability Tests (Month 9)
 *
 * 1. getProviderHealthStats() returns per-provider key health summary
 * 2. /stats endpoint includes providerHealth section
 * 3. Dual-stub integration: two upstream stubs, no key/header crossover
 */

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { KeyManager } = require('../lib/key-manager');
const { StubServer } = require('./helpers/stub-server');
const { ProxyServer } = require('../lib/proxy-server');
const { Config, resetConfig } = require('../lib/config');
const { resetLogger } = require('../lib/logger');

// ── HTTP helper ────────────────────────────────────────────────────────

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

function llmBody(model = 'claude-sonnet-4-20250514') {
    return JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 256
    });
}

// ═══════════════════════════════════════════════════════════════════════
// Unit: getProviderHealthStats
// ═══════════════════════════════════════════════════════════════════════

describe('getProviderHealthStats', () => {
    let km;

    afterEach(() => {
        if (km) { km.destroy?.(); km = null; }
    });

    test('returns per-provider stats for tagged key pools', () => {
        km = new KeyManager({ maxConcurrencyPerKey: 5 });
        km.loadKeys({ 'z.ai': ['zkey1.s1', 'zkey2.s2'], 'anthropic': ['antkey.s3'] });

        const health = km.getProviderHealthStats();
        expect(health['z.ai']).toBeDefined();
        expect(health['z.ai'].total).toBe(2);
        expect(health['z.ai'].available).toBe(2);
        expect(health['z.ai'].openCircuits).toBe(0);
        expect(health['z.ai'].inFlight).toBe(0);

        expect(health['anthropic']).toBeDefined();
        expect(health['anthropic'].total).toBe(1);
    });

    test('returns __untagged__ for flat array keys', () => {
        km = new KeyManager({ maxConcurrencyPerKey: 5 });
        km.loadKeys(['key1.s1', 'key2.s2']);

        const health = km.getProviderHealthStats();
        expect(health['__untagged__']).toBeDefined();
        expect(health['__untagged__'].total).toBe(2);
    });

    test('tracks open circuits per provider', () => {
        km = new KeyManager({ maxConcurrencyPerKey: 5 });
        km.loadKeys({ 'z.ai': ['zkey.s1'], 'anthropic': ['antkey.s2'] });

        // Trip the anthropic key's circuit breaker
        const antKey = km.keys[1];
        for (let i = 0; i < 10; i++) {
            antKey.circuitBreaker.recordFailure('test');
        }

        const health = km.getProviderHealthStats();
        expect(health['z.ai'].openCircuits).toBe(0);
        expect(health['anthropic'].openCircuits).toBe(1);
    });

    test('tracks inFlight per provider', () => {
        km = new KeyManager({ maxConcurrencyPerKey: 5 });
        km.loadKeys({ 'z.ai': ['zkey.s1'], 'anthropic': ['antkey.s2'] });

        // Acquire a z.ai key (increments inFlight)
        const key = km.acquireKey([], 'z.ai');
        expect(key).not.toBeNull();

        const health = km.getProviderHealthStats();
        expect(health['z.ai'].inFlight).toBe(1);
        expect(health['anthropic'].inFlight).toBe(0);

        km.recordSuccess(key, 100);
    });

    test('calculates error rate per provider', () => {
        km = new KeyManager({ maxConcurrencyPerKey: 5 });
        km.loadKeys({ 'z.ai': ['zkey.s1'] });

        // Simulate requests with failures
        const key = km.acquireKey([], 'z.ai');
        km.recordFailure(key, 'test_error');
        const key2 = km.acquireKey([], 'z.ai');
        km.recordSuccess(key2, 100);

        const health = km.getProviderHealthStats();
        // 2 total requests, 1 success, 1 failure → 50% error rate
        expect(health['z.ai'].errorRate).toBe(50);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Integration: /stats endpoint includes providerHealth
// ═══════════════════════════════════════════════════════════════════════

describe('/stats includes providerHealth', () => {
    let stub;
    let proxy;

    beforeEach(async () => {
        stub = new StubServer();
        await stub.start();
    });

    afterEach(async () => {
        if (proxy) {
            await proxy.proxyServer.shutdown();
            fs.rmSync(proxy.testDir, { recursive: true, force: true });
            proxy = null;
        }
        if (stub) { await stub.stop(); stub = null; }
        resetConfig();
        resetLogger();
    });

    test('providerHealth section present in stats response', async () => {
        const testDir = path.join(os.tmpdir(), 'prov-obs-' + Date.now());
        fs.mkdirSync(testDir, { recursive: true });
        fs.writeFileSync(
            path.join(testDir, 'test-keys.json'),
            JSON.stringify({ keys: ['key1.s1', 'key2.s2'], baseUrl: stub.url })
        );

        const config = new Config({
            configDir: testDir,
            keysFile: 'test-keys.json',
            statsFile: 'test-stats.json',
            useCluster: false,
            port: 0,
            logLevel: 'ERROR',
            security: { rateLimit: { enabled: false } },
            usageMonitor: { enabled: false }
        });

        const proxyServer = new ProxyServer({ config });
        const server = await proxyServer.start();
        const address = server.address();
        proxy = { proxyServer, testDir };

        const res = await request(`http://127.0.0.1:${address.port}/stats`, {
            method: 'GET'
        });

        expect(res.statusCode).toBe(200);
        const stats = res.json();
        expect(stats.providerHealth).toBeDefined();
        // Flat keys → __untagged__ provider
        expect(stats.providerHealth['__untagged__']).toBeDefined();
        expect(stats.providerHealth['__untagged__'].total).toBe(2);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Integration: Dual-stub no-crossover test
// ═══════════════════════════════════════════════════════════════════════

describe('Dual-stub: no key/header crossover', () => {
    let stubA; // z.ai upstream
    let stubB; // anthropic upstream
    let proxy;

    beforeEach(async () => {
        stubA = new StubServer();
        stubB = new StubServer();
        await stubA.start();
        await stubB.start();
    });

    afterEach(async () => {
        if (proxy) {
            await proxy.proxyServer.shutdown();
            fs.rmSync(proxy.testDir, { recursive: true, force: true });
            proxy = null;
        }
        if (stubA) { await stubA.stop(); stubA = null; }
        if (stubB) { await stubB.stop(); stubB = null; }
        resetConfig();
        resetLogger();
    });

    test('z.ai request hits stubA, anthropic request blocked', async () => {
        // Both stubs are running, but proxy only points at stubA (the target).
        // Keys are tagged for z.ai only. Anthropic requests should fail with 503.
        const testDir = path.join(os.tmpdir(), 'dual-stub-' + Date.now());
        fs.mkdirSync(testDir, { recursive: true });
        fs.writeFileSync(
            path.join(testDir, 'test-keys.json'),
            JSON.stringify({ keys: ['zkey.s1'], baseUrl: stubA.url })
        );

        const config = new Config({
            configDir: testDir,
            keysFile: 'test-keys.json',
            statsFile: 'test-stats.json',
            useCluster: false,
            port: 0,
            logLevel: 'ERROR',
            modelRouting: { enabled: false },
            security: { rateLimit: { enabled: false } },
            usageMonitor: { enabled: false }
        });

        const proxyServer = new ProxyServer({ config });
        const server = await proxyServer.start();
        const address = server.address();
        proxy = { proxyServer, testDir };

        // Load tagged keys for z.ai only
        proxyServer.keyManager.loadKeys({ 'z.ai': ['zkey.s1'] });
        proxyServer.keyManager.defaultProviderName = 'z.ai';

        // Register anthropic provider in registry so resolveProviderForModel works
        const registry = proxyServer.config._providerRegistry;
        if (!registry.hasProvider('anthropic')) {
            registry._addProvider('anthropic', { costTier: 'metered' });
        }

        // Set model mapping: default model goes to z.ai, claude-opus-4 goes to anthropic
        proxyServer.config.config.modelMapping = {
            models: {
                'claude-opus-4': { target: 'claude-opus-4', provider: 'anthropic' }
            }
        };

        const proxyUrl = `http://127.0.0.1:${address.port}`;

        // 1. Request a z.ai model → should reach stubA
        const zaiRes = await request(`${proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': 'test' },
            body: llmBody('some-model')  // Not in mapping → default z.ai
        });
        expect(zaiRes.statusCode).toBe(200);
        expect(stubA.stats.requests).toBe(1);
        expect(stubB.stats.requests).toBe(0);

        // 2. Request anthropic-mapped model → should be blocked (no anthropic keys)
        const antRes = await request(`${proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': 'test' },
            body: llmBody('claude-opus-4')
        });
        expect(antRes.statusCode).toBe(503);
        // stubA shouldn't have received another request
        expect(stubA.stats.requests).toBe(1);
        // stubB should NEVER have received any request (no crossover)
        expect(stubB.stats.requests).toBe(0);

        // 3. Verify auth headers on the z.ai request
        const zaiHeaders = stubA.stats.requestHeaders[0];
        expect(zaiHeaders['x-api-key']).toBeDefined();
    });
});
