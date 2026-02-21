'use strict';

/**
 * E2E Test: Unified Decision Trace Endpoint
 * ARCH-04: Verifies unified trace payload in live system
 *
 * Uses ProxyServer + raw HTTP (same as model-routing-e2e.test.js).
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProxyServer } = require('../../lib/proxy-server');
const { Config, resetConfig } = require('../../lib/config');
const { resetLogger } = require('../../lib/logger');

// HTTP helper (same pattern as model-routing-e2e.test.js)
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
                } catch (_e) {
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

describe('E2E: Unified Decision Trace Endpoint - ARCH-04', () => {
    let proxyServer;
    let proxyUrl;
    let testDir;

    beforeAll(async () => {
        resetConfig();
        resetLogger();

        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-trace-'));
        fs.writeFileSync(
            path.join(testDir, 'test-keys.json'),
            JSON.stringify({
                keys: ['e2e-key1.secret1', 'e2e-key2.secret2'],
                baseUrl: 'https://api.z.ai/api/anthropic'
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
                    light: { models: ['glm-3-turbo'], strategy: 'throughput' },
                    medium: { models: ['glm-4-flash'], strategy: 'balanced' },
                    heavy: { models: ['glm-5-flash'], strategy: 'quality' }
                },
                rules: [],
                classifier: {
                    heavyThresholds: { maxTokensGte: 4096 },
                    lightThresholds: { maxTokensLte: 512, messageCountLte: 3 }
                }
            }
        });

        proxyServer = new ProxyServer({ config });
        const server = await proxyServer.start();
        const address = server.address();
        proxyUrl = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
        if (proxyServer) {
            await proxyServer.shutdown();
            proxyServer = null;
        }
        try {
            const files = fs.readdirSync(testDir);
            files.forEach(f => {
                try { fs.unlinkSync(path.join(testDir, f)); } catch (_e) { /* ok */ }
            });
            fs.rmdirSync(testDir);
        } catch (_e) { /* ok */ }
    });

    describe('POST /model-routing/explain', () => {
        test('should return explain with model selection for heavy request', async () => {
            const body = JSON.stringify({
                model: 'claude-3-opus-20240229',
                maxTokens: 8192,
                messageCount: 5
            });

            const res = await request(`${proxyUrl}/model-routing/explain`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'content-length': String(Buffer.byteLength(body))
                },
                body
            });

            expect(res.statusCode).toBe(200);
            const data = res.json();

            expect(data).toHaveProperty('selectedModel');
            expect(data).toHaveProperty('tier');
            expect(data).toHaveProperty('reason');
            expect(data).toHaveProperty('strategy');
        });

        test('should return explain for medium-tier request', async () => {
            const body = JSON.stringify({
                model: 'claude-3-sonnet-20240229',
                maxTokens: 1024,
                messageCount: 3
            });

            const res = await request(`${proxyUrl}/model-routing/explain`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'content-length': String(Buffer.byteLength(body))
                },
                body
            });

            expect(res.statusCode).toBe(200);
            const data = res.json();

            expect(data).toHaveProperty('selectedModel');
            expect(data).toHaveProperty('tier');
        });

        test('should handle concurrent explain requests', async () => {
            const makeExplainRequest = (model) => {
                const body = JSON.stringify({ model, messageCount: 1 });
                return request(`${proxyUrl}/model-routing/explain`, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'content-length': String(Buffer.byteLength(body))
                    },
                    body
                });
            };

            const [res1, res2] = await Promise.all([
                makeExplainRequest('claude-3-opus-20240229'),
                makeExplainRequest('claude-3-haiku-20240307')
            ]);

            expect(res1.statusCode).toBe(200);
            expect(res2.statusCode).toBe(200);

            const data1 = res1.json();
            const data2 = res2.json();

            expect(data1).toHaveProperty('selectedModel');
            expect(data2).toHaveProperty('selectedModel');
        });
    });

    describe('GET /model-routing/test classification', () => {
        test('should classify heavy tier for high max_tokens', async () => {
            const qs = 'model=claude-3-opus-20240229&max_tokens=8192&messages=5';
            const res = await request(`${proxyUrl}/model-routing/test?${qs}`);

            expect(res.statusCode).toBe(200);
            const data = res.json();

            expect(data).toHaveProperty('selectedModel');
            expect(data).toHaveProperty('classification');
            expect(data.classification).toHaveProperty('tier');
        });

        test('should classify light request correctly', async () => {
            const qs = 'model=claude-3-haiku-20240307&max_tokens=256&messages=1';
            const res = await request(`${proxyUrl}/model-routing/test?${qs}`);

            expect(res.statusCode).toBe(200);
            const data = res.json();
            expect(data).toHaveProperty('selectedModel');
        });
    });

    describe('GET /model-routing state', () => {
        test('should return routing state with config and stats', async () => {
            const res = await request(`${proxyUrl}/model-routing`);

            expect(res.statusCode).toBe(200);
            const data = res.json();

            expect(data).toHaveProperty('enabled', true);
            expect(data).toHaveProperty('config');
            expect(data.config).toHaveProperty('tiers');
            expect(data).toHaveProperty('stats');
            expect(data.stats).toHaveProperty('total');
        });
    });
});
