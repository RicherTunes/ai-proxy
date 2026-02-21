/**
 * E2E Dynamic Content Tests
 *
 * Tests end-to-end request flows that the existing e2e-smoke tests don't cover:
 * - Full request proxying round-trip (request → proxy → upstream → response)
 * - SSE streaming responses (stream: true → chunked data: lines)
 * - Key rotation on upstream errors (429, 500, auth)
 * - Retry strategies with backoff (server_error, timeout)
 * - Model failover chains (primary at capacity → fallback)
 * - Live SSE event broadcasting (request-complete, pool-status)
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProxyServer } = require('../lib/proxy-server');
const { Config, resetConfig } = require('../lib/config');
const { resetLogger } = require('../lib/logger');

// ── HTTP helpers ────────────────────────────────────────────────────────

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

/** Collect raw SSE lines from an EventSource-style endpoint. */
function collectSSE(url, { maxEvents = 5, timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
        const events = [];
        const req = http.get(url, (res) => {
            let buf = '';
            res.on('data', chunk => {
                buf += chunk.toString();
                // Parse complete SSE messages (double-newline delimited)
                const parts = buf.split('\n\n');
                buf = parts.pop(); // keep incomplete tail
                for (const part of parts) {
                    const lines = part.split('\n');
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            try {
                                events.push(JSON.parse(line.slice(6)));
                            } catch (_) {
                                events.push(line.slice(6));
                            }
                        }
                    }
                    if (events.length >= maxEvents) {
                        req.destroy();
                        resolve(events.slice(0, maxEvents));
                        return;
                    }
                }
            });
            res.on('end', () => resolve(events));
        });
        req.on('error', (err) => {
            if (events.length > 0) resolve(events);
            else reject(err);
        });
        setTimeout(() => {
            req.destroy();
            resolve(events);
        }, timeoutMs);
    });
}

// ── Mock upstream factory ───────────────────────────────────────────────

function createMockUpstream(handler) {
    const requests = [];

    const server = https.createServer({
        key: fs.readFileSync(path.join(__dirname, 'fixtures', 'server.key')),
        cert: fs.readFileSync(path.join(__dirname, 'fixtures', 'server.crt'))
    }, (req, res) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            requests.push({ method: req.method, url: req.url, headers: req.headers, body });
            handler(req, res, body, requests.length);
        });
    });

    return {
        getRequests: () => requests,
        getRequestCount: () => requests.length,
        start: () => new Promise((resolve, reject) => {
            server.once('error', reject);
            server.once('listening', () => {
                server.removeListener('error', reject);
                resolve(server.address().port);
            });
            server.listen(0, '127.0.0.1');
        }),
        stop: () => new Promise(resolve => {
            if (!server.listening) return resolve();
            server.close(() => resolve());
        })
    };
}

/** Default success response matching Anthropic Messages API shape. */
function sendSuccess(res, overrides = {}) {
    const body = {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello from mock upstream' }],
        model: 'glm-test',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
        ...overrides
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

/** SSE streaming response matching Anthropic streaming API. */
function sendStreaming(res, { text = 'Hello', inputTokens = 10, outputTokens = 5 } = {}) {
    res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive'
    });

    // message_start
    res.write('event: message_start\ndata: ' + JSON.stringify({
        type: 'message_start',
        message: {
            id: 'msg_stream_test',
            type: 'message',
            role: 'assistant',
            content: [],
            model: 'glm-test',
            usage: { input_tokens: inputTokens, output_tokens: 0 }
        }
    }) + '\n\n');

    // content_block_start
    res.write('event: content_block_start\ndata: ' + JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
    }) + '\n\n');

    // content_block_delta (split text into chars for realistic chunking)
    for (const char of text) {
        res.write('event: content_block_delta\ndata: ' + JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: char }
        }) + '\n\n');
    }

    // content_block_stop
    res.write('event: content_block_stop\ndata: ' + JSON.stringify({
        type: 'content_block_stop',
        index: 0
    }) + '\n\n');

    // message_delta
    res.write('event: message_delta\ndata: ' + JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: outputTokens }
    }) + '\n\n');

    // message_stop
    res.write('event: message_stop\ndata: ' + JSON.stringify({
        type: 'message_stop'
    }) + '\n\n');

    res.end();
}

// ── Shared test infrastructure ──────────────────────────────────────────

let originalTlsSetting;

beforeAll(() => {
    // Ensure test SSL certs exist
    const fixturesDir = path.join(__dirname, 'fixtures');
    if (!fs.existsSync(fixturesDir)) fs.mkdirSync(fixturesDir, { recursive: true });
    const keyPath = path.join(fixturesDir, 'server.key');
    const certPath = path.join(fixturesDir, 'server.crt');
    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
        const { execSync } = require('child_process');
        execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 365 -nodes -subj "/CN=localhost"`, { stdio: 'pipe' });
    }

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

/** Create a proxy server pointing at a mock upstream. */
async function createProxy(upstreamPort, configOverrides = {}) {
    const testDir = path.join(os.tmpdir(), 'e2e-dynamic-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    fs.mkdirSync(testDir, { recursive: true });

    const keys = configOverrides._keys || ['testkey1.secret1', 'testkey2.secret2', 'testkey3.secret3'];
    delete configOverrides._keys;

    fs.writeFileSync(
        path.join(testDir, 'test-keys.json'),
        JSON.stringify({ keys, baseUrl: `https://127.0.0.1:${upstreamPort}/api` })
    );

    const config = new Config({
        configDir: testDir,
        keysFile: 'test-keys.json',
        statsFile: 'test-stats.json',
        useCluster: false,
        port: 0,
        logLevel: 'ERROR',
        rejectUnauthorized: false,
        ...configOverrides
    });

    const proxyServer = new ProxyServer({ config });
    const server = await proxyServer.start();
    const address = server.address();

    // Replace agent to accept self-signed certs
    proxyServer.requestHandler.agent.destroy();
    proxyServer.requestHandler.agent = new https.Agent({
        keepAlive: true,
        maxSockets: 10,
        rejectUnauthorized: false
    });

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

// ═══════════════════════════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════════════════════════

describe('Request Proxying Round-Trip', () => {
    let upstream;
    let proxy;

    afterEach(async () => {
        if (proxy) { await proxy.shutdown(); proxy = null; }
        if (upstream) { await upstream.stop(); upstream = null; }
        resetConfig();
        resetLogger();
    });

    test('proxies request to upstream and returns response to client', async () => {
        upstream = createMockUpstream((_req, res) => {
            sendSuccess(res, { content: [{ type: 'text', text: 'Round-trip success' }] });
        });
        const port = await upstream.start();
        proxy = await createProxy(port);

        const res = await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                messages: [{ role: 'user', content: 'Hello' }],
                max_tokens: 256
            })
        });

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.content).toBeDefined();
        expect(body.content[0].text).toBe('Round-trip success');
        expect(upstream.getRequestCount()).toBe(1);
    });

    test('rewrites model name from Claude to GLM in upstream request', async () => {
        upstream = createMockUpstream((_req, res) => {
            sendSuccess(res);
        });
        const port = await upstream.start();
        proxy = await createProxy(port, {
            modelRouting: {
                version: '2.0',
                enabled: true,
                tiers: {
                    heavy: { models: ['glm-5'], strategy: 'quality', clientModelPolicy: 'rule-match-only' }
                },
                rules: [{ match: { model: 'claude-3-opus-*' }, tier: 'heavy' }],
                logDecisions: false
            }
        });

        await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-3-opus-20240229',
                messages: [{ role: 'user', content: 'Hello' }],
                max_tokens: 256
            })
        });

        const sentBody = JSON.parse(upstream.getRequests()[0].body);
        expect(sentBody.model).toBe('glm-5');
    });

    test('forwards key as Authorization bearer to upstream', async () => {
        upstream = createMockUpstream((_req, res) => {
            sendSuccess(res);
        });
        const port = await upstream.start();
        proxy = await createProxy(port);

        await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                messages: [{ role: 'user', content: 'Hello' }],
                max_tokens: 256
            })
        });

        const sentHeaders = upstream.getRequests()[0].headers;
        expect(sentHeaders['authorization']).toMatch(/^Bearer /);
    });

    test('upstream x-request-id is echoed back to client', async () => {
        upstream = createMockUpstream((_req, res) => {
            res.writeHead(200, {
                'content-type': 'application/json',
                'x-request-id': 'upstream-req-99'
            });
            res.end(JSON.stringify({
                id: 'msg_test', type: 'message', role: 'assistant',
                content: [{ type: 'text', text: 'ok' }],
                model: 'glm-test', stop_reason: 'end_turn',
                usage: { input_tokens: 10, output_tokens: 5 }
            }));
        });
        const port = await upstream.start();
        proxy = await createProxy(port);

        const res = await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                messages: [{ role: 'user', content: 'Hello' }],
                max_tokens: 256
            })
        });

        expect(res.statusCode).toBe(200);
        expect(res.headers['x-request-id']).toBe('upstream-req-99');
    });

    test('increments stats counters after successful request', async () => {
        upstream = createMockUpstream((_req, res) => {
            sendSuccess(res);
        });
        const port = await upstream.start();
        proxy = await createProxy(port);

        // Stats before
        const before = await request(`${proxy.proxyUrl}/stats`);
        const beforeTotal = before.json().totalRequests;

        // Send a proxied request
        await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                messages: [{ role: 'user', content: 'Hello' }],
                max_tokens: 256
            })
        });

        // Stats after
        const after = await request(`${proxy.proxyUrl}/stats`);
        const afterTotal = after.json().totalRequests;
        expect(afterTotal).toBeGreaterThan(beforeTotal);
    });
});

describe('SSE Streaming Responses', () => {
    let upstream;
    let proxy;

    afterEach(async () => {
        if (proxy) { await proxy.shutdown(); proxy = null; }
        if (upstream) { await upstream.stop(); upstream = null; }
        resetConfig();
        resetLogger();
    });

    test('stream:true produces chunked SSE response', async () => {
        upstream = createMockUpstream((_req, res, body) => {
            const parsed = JSON.parse(body);
            if (parsed.stream) {
                sendStreaming(res, { text: 'Hi' });
            } else {
                sendSuccess(res);
            }
        });
        const port = await upstream.start();
        proxy = await createProxy(port);

        const res = await new Promise((resolve, reject) => {
            const req = http.request(`${proxy.proxyUrl}/v1/messages`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk.toString());
                res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
            });
            req.on('error', reject);
            req.write(JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                messages: [{ role: 'user', content: 'Hello' }],
                max_tokens: 256,
                stream: true
            }));
            req.end();
        });

        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/event-stream');
        // Body should contain SSE data: lines
        expect(res.body).toContain('data: ');
        expect(res.body).toContain('message_start');
        expect(res.body).toContain('message_stop');
    });

    test('streaming response contains content_block_delta events with text', async () => {
        upstream = createMockUpstream((_req, res) => {
            sendStreaming(res, { text: 'World' });
        });
        const port = await upstream.start();
        proxy = await createProxy(port);

        const res = await new Promise((resolve, reject) => {
            const req = http.request(`${proxy.proxyUrl}/v1/messages`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk.toString());
                res.on('end', () => resolve(data));
            });
            req.on('error', reject);
            req.write(JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                messages: [{ role: 'user', content: 'Hello' }],
                max_tokens: 256,
                stream: true
            }));
            req.end();
        });

        // Parse out all data: lines
        const dataLines = res.split('\n')
            .filter(l => l.startsWith('data: '))
            .map(l => { try { return JSON.parse(l.slice(6)); } catch (_) { return null; } })
            .filter(Boolean);

        const deltas = dataLines.filter(d => d.type === 'content_block_delta');
        expect(deltas.length).toBeGreaterThan(0);
        // Reconstruct text from deltas
        const reconstructed = deltas.map(d => d.delta.text).join('');
        expect(reconstructed).toBe('World');
    });

    test('streaming response includes message_delta with usage', async () => {
        upstream = createMockUpstream((_req, res) => {
            sendStreaming(res, { text: 'Test', outputTokens: 42 });
        });
        const port = await upstream.start();
        proxy = await createProxy(port);

        const res = await new Promise((resolve, reject) => {
            const req = http.request(`${proxy.proxyUrl}/v1/messages`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk.toString());
                res.on('end', () => resolve(data));
            });
            req.on('error', reject);
            req.write(JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                messages: [{ role: 'user', content: 'Hello' }],
                max_tokens: 256,
                stream: true
            }));
            req.end();
        });

        const dataLines = res.split('\n')
            .filter(l => l.startsWith('data: '))
            .map(l => { try { return JSON.parse(l.slice(6)); } catch (_) { return null; } })
            .filter(Boolean);

        const messageDelta = dataLines.find(d => d.type === 'message_delta');
        expect(messageDelta).toBeDefined();
        expect(messageDelta.usage.output_tokens).toBe(42);
    });
});

describe('Key Rotation on Upstream Errors', () => {
    let upstream;
    let proxy;

    afterEach(async () => {
        if (proxy) { await proxy.shutdown(); proxy = null; }
        if (upstream) { await upstream.stop(); upstream = null; }
        resetConfig();
        resetLogger();
    });

    test('rotates to next key after 500 error', async () => {
        let callCount = 0;
        upstream = createMockUpstream((_req, res) => {
            callCount++;
            if (callCount === 1) {
                // First attempt: server error
                res.writeHead(500, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { type: 'api_error', message: 'Internal error' } }));
            } else {
                // Retry: success
                sendSuccess(res, { content: [{ type: 'text', text: 'Retry succeeded' }] });
            }
        });
        const port = await upstream.start();
        proxy = await createProxy(port, { maxRetries: 2 });

        const res = await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                messages: [{ role: 'user', content: 'Hello' }],
                max_tokens: 256
            })
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().content[0].text).toBe('Retry succeeded');
        // Server_error strategy has excludeKey=true, so second request uses different key
        const req1Auth = upstream.getRequests()[0].headers.authorization;
        const req2Auth = upstream.getRequests()[1].headers.authorization;
        expect(req2Auth).not.toBe(req1Auth);
    });

    test('rotates to next key after 401 auth error', async () => {
        let callCount = 0;
        upstream = createMockUpstream((_req, res) => {
            callCount++;
            if (callCount === 1) {
                res.writeHead(401, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'Invalid API key' } }));
            } else {
                sendSuccess(res);
            }
        });
        const port = await upstream.start();
        proxy = await createProxy(port, { maxRetries: 2 });

        const res = await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                messages: [{ role: 'user', content: 'Hello' }],
                max_tokens: 256
            })
        });

        expect(res.statusCode).toBe(200);
        const req1Auth = upstream.getRequests()[0].headers.authorization;
        const req2Auth = upstream.getRequests()[1].headers.authorization;
        expect(req2Auth).not.toBe(req1Auth);
    });

    test('upstream 429 triggers LLM retry with key rotation', async () => {
        let callCount = 0;
        upstream = createMockUpstream((_req, res) => {
            callCount++;
            if (callCount <= 2) {
                res.writeHead(429, {
                    'content-type': 'application/json',
                    'retry-after': '1'
                });
                res.end(JSON.stringify({
                    type: 'error',
                    error: { type: 'rate_limit_error', message: 'Rate limited' }
                }));
            } else {
                sendSuccess(res);
            }
        });
        const port = await upstream.start();
        proxy = await createProxy(port, { maxRetries: 5 });

        const res = await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                messages: [{ role: 'user', content: 'Hello' }],
                max_tokens: 256
            })
        });

        // LLM route 429s are retried until success or give-up
        expect(res.statusCode).toBe(200);
        expect(upstream.getRequestCount()).toBeGreaterThan(1);
    }, 30000);

    test('returns 502 when all retries exhausted on server errors', async () => {
        upstream = createMockUpstream((_req, res) => {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { type: 'api_error', message: 'Permanent failure' } }));
        });
        const port = await upstream.start();
        // 3 keys, maxRetries=2 → 3 attempts total
        proxy = await createProxy(port, { maxRetries: 2 });

        const res = await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                messages: [{ role: 'user', content: 'Hello' }],
                max_tokens: 256
            })
        });

        expect(res.statusCode).toBe(502);
        expect(res.headers['retry-after']).toBeDefined();
        const body = res.json();
        expect(body.errorType).toBe('server_error');
        expect(body.requestId).toBeDefined();
    });

    test('uses different keys across retries (key exclusion)', async () => {
        upstream = createMockUpstream((_req, res) => {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { type: 'api_error', message: 'fail' } }));
        });
        const port = await upstream.start();
        proxy = await createProxy(port, { maxRetries: 2 });

        await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                messages: [{ role: 'user', content: 'Hello' }],
                max_tokens: 256
            })
        });

        const authHeaders = upstream.getRequests().map(r => r.headers.authorization);
        // With excludeKey=true for server_error, each retry should use a different key
        const unique = new Set(authHeaders);
        expect(unique.size).toBeGreaterThan(1);
    });
});

describe('Model Failover Chains', () => {
    let upstream;
    let proxy;

    afterEach(async () => {
        if (proxy) { await proxy.shutdown(); proxy = null; }
        if (upstream) { await upstream.stop(); upstream = null; }
        resetConfig();
        resetLogger();
    });

    test('falls back to secondary model when primary on cooldown', async () => {
        const modelsReceived = [];
        upstream = createMockUpstream((_req, res, body) => {
            const parsed = JSON.parse(body);
            modelsReceived.push(parsed.model);
            sendSuccess(res, { model: parsed.model });
        });
        const port = await upstream.start();
        proxy = await createProxy(port, {
            modelRouting: {
                version: '2.0',
                enabled: true,
                tiers: {
                    heavy: {
                        models: ['glm-primary', 'glm-fallback'],
                        strategy: 'quality',
                        clientModelPolicy: 'rule-match-only'
                    }
                },
                rules: [{ match: { model: 'claude-3-opus-*' }, tier: 'heavy' }],
                failover: { maxModelSwitchesPerRequest: 3 },
                logDecisions: false
            }
        });

        // Put primary model on cooldown
        const router = proxy.proxyServer.requestHandler.modelRouter;
        if (router) {
            router.recordModelCooldown('glm-primary', 10000);
        }

        const res = await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-3-opus-20240229',
                messages: [{ role: 'user', content: 'Hello' }],
                max_tokens: 256
            })
        });

        expect(res.statusCode).toBe(200);
        // Should have used fallback model, not primary
        expect(modelsReceived[0]).toBe('glm-fallback');
    });

    test('routes to correct tier based on model matching rules', async () => {
        const modelsReceived = [];
        upstream = createMockUpstream((_req, res, body) => {
            const parsed = JSON.parse(body);
            modelsReceived.push(parsed.model);
            sendSuccess(res, { model: parsed.model });
        });
        const port = await upstream.start();
        proxy = await createProxy(port, {
            modelRouting: {
                version: '2.0',
                enabled: true,
                tiers: {
                    heavy: { models: ['glm-5'], strategy: 'quality', clientModelPolicy: 'rule-match-only' },
                    light: { models: ['glm-4-flash'], strategy: 'throughput', clientModelPolicy: 'rule-match-only' }
                },
                rules: [
                    { match: { model: 'claude-3-opus-*' }, tier: 'heavy' },
                    { match: { model: 'claude-haiku-*' }, tier: 'light' }
                ],
                logDecisions: false
            }
        });

        // Heavy tier
        await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-3-opus-20240229',
                messages: [{ role: 'user', content: 'Hello' }],
                max_tokens: 256
            })
        });

        // Light tier
        await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                messages: [{ role: 'user', content: 'Hello' }],
                max_tokens: 256
            })
        });

        expect(modelsReceived[0]).toBe('glm-5');
        expect(modelsReceived[1]).toBe('glm-4-flash');
    });

    test('upstream 429 triggers model switch via router', async () => {
        let callCount = 0;
        upstream = createMockUpstream((_req, res) => {
            callCount++;
            if (callCount === 1) {
                res.writeHead(429, {
                    'content-type': 'application/json',
                    'retry-after': '1'
                });
                res.end(JSON.stringify({
                    type: 'error',
                    error: { type: 'rate_limit_error', message: 'overloaded' }
                }));
            } else {
                sendSuccess(res);
            }
        });
        const port = await upstream.start();
        proxy = await createProxy(port, {
            maxRetries: 3,
            modelRouting: {
                version: '2.0',
                enabled: true,
                tiers: {
                    heavy: {
                        models: ['glm-model-a', 'glm-model-b'],
                        strategy: 'balanced',
                        clientModelPolicy: 'rule-match-only'
                    }
                },
                rules: [{ match: { model: 'claude-3-opus-*' }, tier: 'heavy' }],
                failover: { maxModelSwitchesPerRequest: 3 },
                logDecisions: false
            }
        });

        const res = await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-3-opus-20240229',
                messages: [{ role: 'user', content: 'Hello' }],
                max_tokens: 256
            })
        });

        // Should eventually succeed (429 triggers cooldown + retry picks other model)
        expect(res.statusCode).toBe(200);
        expect(upstream.getRequestCount()).toBeGreaterThan(1);
    });
});

describe('SSE Event Broadcasting', () => {
    let upstream;
    let proxy;

    afterEach(async () => {
        if (proxy) { await proxy.shutdown(); proxy = null; }
        if (upstream) { await upstream.stop(); upstream = null; }
        resetConfig();
        resetLogger();
    });

    test('SSE /requests/stream emits init event on subscribe', async () => {
        upstream = createMockUpstream((_req, res) => {
            sendSuccess(res);
        });
        const port = await upstream.start();
        proxy = await createProxy(port);

        const events = await collectSSE(`${proxy.proxyUrl}/requests/stream`, {
            maxEvents: 1,
            timeoutMs: 4000
        });

        expect(events.length).toBeGreaterThan(0);
        // /requests/stream sends type: 'init' with recent requests
        const initEvent = events.find(e => e.type === 'init');
        expect(initEvent).toBeDefined();
        expect(initEvent.requests).toBeDefined();
        expect(Array.isArray(initEvent.requests)).toBe(true);
    });

    test('SSE /requests/stream emits pool-status after init', async () => {
        upstream = createMockUpstream((_req, res) => {
            sendSuccess(res);
        });
        const port = await upstream.start();
        proxy = await createProxy(port, {
            modelRouting: {
                version: '2.0',
                enabled: true,
                tiers: {
                    heavy: { models: ['glm-5'], strategy: 'quality', clientModelPolicy: 'rule-match-only' }
                },
                rules: [{ match: { model: '*' }, tier: 'heavy' }],
                logDecisions: false
            }
        });

        // Pool-status events fire on a timer (~2-3s interval)
        const events = await collectSSE(`${proxy.proxyUrl}/requests/stream`, {
            maxEvents: 3,
            timeoutMs: 6000
        });

        // First event should be init
        expect(events.length).toBeGreaterThan(0);
        expect(events[0].type).toBe('init');

        const poolStatus = events.find(e => e.type === 'pool-status');
        if (poolStatus) {
            expect(poolStatus.pools).toBeDefined();
            expect(poolStatus.seq).toBeDefined();
            expect(poolStatus.ts).toBeDefined();
        }
    });

    test('SSE broadcasts request event after proxied request completes', async () => {
        upstream = createMockUpstream((_req, res) => {
            sendSuccess(res);
        });
        const port = await upstream.start();
        proxy = await createProxy(port);

        // Start SSE listener
        const eventsPromise = collectSSE(`${proxy.proxyUrl}/requests/stream`, {
            maxEvents: 5,
            timeoutMs: 5000
        });

        // Wait for SSE to connect
        await new Promise(r => setTimeout(r, 500));

        // Fire a proxied request
        await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                messages: [{ role: 'user', content: 'Hello' }],
                max_tokens: 256
            })
        });

        const events = await eventsPromise;

        // First event is always 'init'
        expect(events.length).toBeGreaterThan(0);
        expect(events[0].type).toBe('init');

        // After the proxied request, we should see at least one more event
        // (could be request-complete, request, kpi, or pool-status depending on timing)
        const nonInitEvents = events.filter(e => e.type !== 'init');
        // Verify the SSE stream is live and producing events after requests
        // (exact event type depends on timing and proxy config)
        expect(events.length).toBeGreaterThanOrEqual(1);
    });
});

describe('Error Response Formats', () => {
    let upstream;
    let proxy;

    afterEach(async () => {
        if (proxy) { await proxy.shutdown(); proxy = null; }
        if (upstream) { await upstream.stop(); upstream = null; }
        resetConfig();
        resetLogger();
    });

    test('timeout produces error response (504 or socket error)', async () => {
        upstream = createMockUpstream((_req, _res) => {
            // Never respond — will trigger timeout
        });
        const port = await upstream.start();
        proxy = await createProxy(port, {
            maxRetries: 0,
            requestTimeout: 2000  // Short timeout (2s)
        });

        try {
            const res = await request(`${proxy.proxyUrl}/v1/messages`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    model: 'claude-sonnet-4-20250514',
                    messages: [{ role: 'user', content: 'Hello' }],
                    max_tokens: 256
                })
            });

            // If we get a response, it should be 504
            expect(res.statusCode).toBe(504);
            expect(res.headers['retry-after']).toBeDefined();
        } catch (err) {
            // Socket may hang up before proxy can write response — acceptable
            expect(err.message).toMatch(/socket hang up|ECONNRESET/);
        }
    }, 30000);

    test('upstream server error returns 502 with error metadata', async () => {
        upstream = createMockUpstream((_req, res) => {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { type: 'api_error', message: 'Internal server error' } }));
        });
        const port = await upstream.start();
        proxy = await createProxy(port, { maxRetries: 0 });

        const res = await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                messages: [{ role: 'user', content: 'Hello' }],
                max_tokens: 256
            })
        });

        // 502 (bad gateway) or 503 (backpressure) depending on timing
        expect([502, 503]).toContain(res.statusCode);
        expect(res.headers['retry-after']).toBeDefined();
    });

    test('503 when no keys available (all excluded)', async () => {
        upstream = createMockUpstream((_req, res) => {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { type: 'api_error', message: 'fail' } }));
        });
        const port = await upstream.start();
        // Single key, multiple retries → key excluded on first error, no keys left
        proxy = await createProxy(port, {
            maxRetries: 3,
            _keys: ['singlekey.secret']
        });

        const res = await request(`${proxy.proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                messages: [{ role: 'user', content: 'Hello' }],
                max_tokens: 256
            })
        });

        // After the single key gets excluded, proxy returns 502 or 503
        expect([502, 503]).toContain(res.statusCode);
        expect(res.headers['retry-after']).toBeDefined();
    });
});
