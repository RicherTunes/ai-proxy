/**
 * Provider Isolation Integration Tests (Month 8)
 *
 * Proves metered-provider cost-safety: requests for a provider with no
 * matching keys never reach the upstream stub. The critical invariant is
 * stub.stats.requests === 0 when no keys are available for the provider.
 *
 * Strategy:
 * - Model routing is disabled so model names pass through unchanged to
 *   resolveProviderForModel (otherwise the router would remap 'claude-opus-4'
 *   to a GLM model before the provider lookup).
 * - "No keys" tests load ONLY tagged keys for OTHER providers (or none at all),
 *   so hasKeysForProvider('anthropic') = false AND no untagged keys exist.
 *   This triggers the immediate provider_no_keys_configured 503 path
 *   (request-handler.js:1283) without queuing.
 * - "Keys present" tests load tagged anthropic keys so the request goes through.
 * - "Untagged restriction" tests use defaultProviderName='z.ai' with flat keys
 *   plus a short queueTimeout so the queue-wait path terminates quickly.
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

/** Standard /v1/messages POST body */
function llmBody(model = 'claude-sonnet-4-20250514') {
    return JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 256
    });
}

// ── Test infrastructure ────────────────────────────────────────────────

async function createProxyWithStub(stubUrl, configOverrides = {}) {
    const testDir = path.join(
        os.tmpdir(),
        'prov-iso-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
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
        // Disable model routing so model names pass through unchanged to resolveProviderForModel.
        // The router would remap 'claude-opus-4' to a GLM model before provider resolution,
        // causing the anthropic provider lookup to fall through to the default z.ai.
        modelRouting: { enabled: false },
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

/**
 * Register a named provider in the proxy's provider registry so that
 * resolveProviderForModel returns it instead of null (GUARD-02 bypass).
 * The stub URL is used as the target host so upstream requests still hit the stub.
 */
function injectProvider(proxyObj, providerName, stubUrl) {
    const parsed = new URL(stubUrl);
    const registry = proxyObj.proxyServer.config._providerRegistry;
    registry._addProvider(providerName, {
        targetHost: parsed.host,
        targetBasePath: '/v1',
        targetProtocol: 'http:',
        authScheme: 'x-api-key',
        costTier: 'metered'
    });
}

/** Anthropic model mapping: claude-opus-4 → anthropic provider (no model remapping) */
const ANTHROPIC_MODEL_MAPPING = {
    enabled: true,
    models: {
        'claude-opus-4': { target: 'claude-opus-4', provider: 'anthropic' }
    }
};

// ═══════════════════════════════════════════════════════════════════════
// Group 1: Provider isolation: anthropic route fails closed
// ═══════════════════════════════════════════════════════════════════════

describe('Provider isolation: anthropic route fails closed', () => {
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

    test('request for anthropic-mapped model with no anthropic keys returns 503', async () => {
        stub.setScenario('success');
        // Start with NO keys at all — empty key array so hasProviderKeys = false
        // and the immediate provider_no_keys_configured 503 path fires.
        proxy = await createProxyWithStub(stub.url, { _keys: [] });

        // Register anthropic in the provider registry (otherwise resolveProviderForModel
        // would return null for unknown provider, falling through to default z.ai)
        injectProvider(proxy, 'anthropic', stub.url);

        // Inject anthropic model mapping
        proxy.proxyServer.config.config.modelMapping = ANTHROPIC_MODEL_MAPPING;

        const res = await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: llmBody('claude-opus-4')
        });

        // Must fail: no anthropic keys configured at all (no tagged, no untagged)
        // → provider_no_keys_configured (non-retryable, immediate)
        expect(res.statusCode).toBe(503);

        const body = res.json();
        expect(body).not.toBeNull();
        expect(body.errorType).toBe('provider_no_keys_configured');

        // Critical invariant: upstream was never contacted
        expect(stub.stats.requests).toBe(0);
    }, 10000);

    test('request for anthropic-mapped model succeeds with tagged anthropic keys', async () => {
        stub.setScenario('success');
        proxy = await createProxyWithStub(stub.url, { _keys: [] });

        injectProvider(proxy, 'anthropic', stub.url);

        // Load anthropic-tagged keys AFTER proxy start
        proxy.proxyServer.keyManager.loadKeys({ 'anthropic': ['antkey.secret1'] });
        proxy.proxyServer.config.config.modelMapping = ANTHROPIC_MODEL_MAPPING;

        const res = await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: llmBody('claude-opus-4')
        });

        // Tagged key is eligible for the anthropic provider — request must reach stub
        expect(res.statusCode).toBe(200);
        expect(stub.stats.requests).toBe(1);
    }, 10000);
});

// ═══════════════════════════════════════════════════════════════════════
// Group 2: Untagged key restriction
// ═══════════════════════════════════════════════════════════════════════

describe('Untagged key restriction', () => {
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

    test('flat keys serve default provider but not metered providers', async () => {
        stub.setScenario('success');
        // Start with flat (untagged) keys — eligible only for default provider (z.ai)
        proxy = await createProxyWithStub(stub.url, {
            // Short queue timeout so the "all keys busy" path resolves quickly
            queueTimeout: 200
        });

        injectProvider(proxy, 'anthropic', stub.url);

        proxy.proxyServer.keyManager.defaultProviderName = 'z.ai';
        proxy.proxyServer.config.config.modelMapping = {
            enabled: true,
            models: {
                // z.ai model: plain string mapping, no provider tag → defaults to z.ai
                'claude-sonnet-4-20250514': 'glm-4.5',
                // anthropic model: explicit provider tag
                'claude-opus-4': { target: 'claude-opus-4', provider: 'anthropic' }
            }
        };

        // First: request for z.ai model — flat keys are eligible for the default provider
        const zaiRes = await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: llmBody('claude-sonnet-4-20250514')
        });

        expect(zaiRes.statusCode).toBe(200);
        expect(stub.stats.requests).toBe(1);

        // Second: request for anthropic model — flat keys gated to z.ai, not eligible
        stub.reset();
        stub.setScenario('success');

        const anthropicRes = await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: llmBody('claude-opus-4')
        });

        // Must fail: flat keys blocked from anthropic provider
        // (provider_all_keys_busy because untagged keys exist but are gated to z.ai)
        expect(anthropicRes.statusCode).toBe(503);
        // Upstream was never contacted for the anthropic request
        expect(stub.stats.requests).toBe(0);
    }, 10000);
});

// ═══════════════════════════════════════════════════════════════════════
// Group 3: Error semantics
// ═══════════════════════════════════════════════════════════════════════

describe('Error semantics', () => {
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

    test('provider_no_keys_configured error is non-retryable (no retry-after header)', async () => {
        // No keys at all — ensures provider_no_keys_configured (not the queuing path)
        proxy = await createProxyWithStub(stub.url, { _keys: [] });

        injectProvider(proxy, 'openai', stub.url);

        proxy.proxyServer.config.config.modelMapping = {
            enabled: true,
            models: {
                'some-other-model': { target: 'some-other-model', provider: 'openai' }
            }
        };

        const res = await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: llmBody('some-other-model')
        });

        expect(res.statusCode).toBe(503);
        const body = res.json();
        expect(body).not.toBeNull();
        expect(body.errorType).toBe('provider_no_keys_configured');
        expect(body.retryable).toBe(false);
        // Non-retryable 503: no retry-after header
        expect(res.headers['retry-after']).toBeUndefined();
        // Upstream never contacted
        expect(stub.stats.requests).toBe(0);
    }, 10000);

    test('with provider keys loaded, the response is not provider_no_keys_configured', async () => {
        stub.setScenario('success');
        proxy = await createProxyWithStub(stub.url, { _keys: [] });

        injectProvider(proxy, 'anthropic', stub.url);

        // Tagged anthropic keys: request should succeed
        proxy.proxyServer.keyManager.loadKeys({ 'anthropic': ['antkey.secret1'] });
        proxy.proxyServer.config.config.modelMapping = ANTHROPIC_MODEL_MAPPING;

        const res = await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: llmBody('claude-opus-4')
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        if (body && body.errorType) {
            expect(body.errorType).not.toBe('provider_no_keys_configured');
        }
    }, 10000);
});

// ═══════════════════════════════════════════════════════════════════════
// Group 4: Key header isolation
// ═══════════════════════════════════════════════════════════════════════

describe('Key header isolation', () => {
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

    test('upstream never receives a request when provider has no keys', async () => {
        stub.setScenario('success');
        // No keys → immediate provider_no_keys_configured → zero upstream requests
        proxy = await createProxyWithStub(stub.url, { _keys: [] });

        injectProvider(proxy, 'anthropic', stub.url);

        proxy.proxyServer.config.config.modelMapping = ANTHROPIC_MODEL_MAPPING;

        // Request for anthropic model — no keys for this provider
        await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: llmBody('claude-opus-4')
        });

        // Stub must have received zero requests and zero headers
        expect(stub.stats.requests).toBe(0);
        expect(stub.stats.requestHeaders).toHaveLength(0);
    }, 10000);
});
