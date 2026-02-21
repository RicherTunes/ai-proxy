'use strict';

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
                try {
                    resolve({ statusCode: res.statusCode, headers: res.headers, body: data, json: () => JSON.parse(data) });
                } catch (e) {
                    resolve({ statusCode: res.statusCode, headers: res.headers, body: data, json: () => null });
                }
            });
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

describe('PUT /model-routing partial payloads', () => {
    let proxyServer;
    let port;
    let tempDir;

    beforeAll(async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'partial-put-'));
        const keysPath = path.join(tempDir, 'api-keys.json');
        fs.writeFileSync(keysPath, JSON.stringify({
            keys: ['test-key-1'],
            baseUrl: 'https://api.z.ai/api/anthropic'
        }));

        resetConfig();
        resetLogger();
        const config = new Config({
            port: 0,
            host: '127.0.0.1',
            configDir: tempDir,
            keysFile: 'api-keys.json',
            enableHotReload: false,
            useCluster: false,
            logLevel: 'ERROR',
            modelRouting: {
                enabled: true,
                defaultModel: 'glm-4.5-air',
                tiers: {
                    light: { models: ['glm-4.5-air', 'glm-4.5-flash', 'glm-4.7-flash'], strategy: 'throughput' },
                    medium: { models: ['glm-4.5'], strategy: 'balanced' },
                    heavy: { models: ['glm-5', 'glm-4.7'], strategy: 'quality' }
                },
                rules: [
                    { match: { model: 'claude-opus*' }, tier: 'heavy' },
                    { match: { model: 'claude-sonnet*' }, tier: 'medium' },
                    { match: { model: 'claude-haiku*' }, tier: 'light' }
                ]
            }
        });

        proxyServer = new ProxyServer({ config });
        const server = await proxyServer.start();
        const address = server.address();
        port = address.port;
    });

    afterAll(async () => {
        if (proxyServer) await proxyServer.shutdown();
        resetConfig();
        resetLogger();
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    });

    test('PUT { tiers: { heavy: {...} } } preserves light/medium from existing config', async () => {
        const payload = { tiers: { heavy: { models: ['new-model-x'], strategy: 'balanced' } } };
        const res = await request(`http://127.0.0.1:${port}/model-routing`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
        });
        expect(res.statusCode).toBe(200);

        const getRes = await request(`http://127.0.0.1:${port}/model-routing`);
        const state = getRes.json();
        const tiers = state.config.tiers;
        // light and medium should be preserved
        expect(tiers.light.models.length).toBeGreaterThan(0);
        expect(tiers.medium.models.length).toBeGreaterThan(0);
        // heavy should be updated
        expect(tiers.heavy.models).toContain('new-model-x');
    });

    test('PUT { rules: [...] } preserves all tiers', async () => {
        const payload = { rules: [{ match: { model: 'claude-opus*' }, tier: 'heavy' }] };
        const res = await request(`http://127.0.0.1:${port}/model-routing`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
        });
        expect(res.statusCode).toBe(200);

        const getRes = await request(`http://127.0.0.1:${port}/model-routing`);
        const state = getRes.json();
        const tiers = state.config.tiers;
        expect(tiers.heavy.models.length).toBeGreaterThan(0);
        expect(tiers.light.models.length).toBeGreaterThan(0);
        expect(tiers.medium.models.length).toBeGreaterThan(0);
    });

    test('PUT with version 2.4.0 does not fail persistence verification', async () => {
        const payload = {
            version: '2.4.0',
            tiers: { heavy: { models: ['glm-4.7'], strategy: 'quality' } }
        };
        const res = await request(`http://127.0.0.1:${port}/model-routing`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
        });
        expect(res.statusCode).toBe(200);

        const getRes = await request(`http://127.0.0.1:${port}/model-routing`);
        const state = getRes.json();
        expect(state.persistence?.lastSaveError).toBe(null);
    });

    test('PUT { enabled: false } preserves tiers and rules', async () => {
        const res = await request(`http://127.0.0.1:${port}/model-routing`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: false })
        });
        expect(res.statusCode).toBe(200);

        const getRes = await request(`http://127.0.0.1:${port}/model-routing`);
        const state = getRes.json();
        const tiers = state.config.tiers;
        expect(tiers).toBeDefined();
        expect(Object.keys(tiers).length).toBe(3);
    });

    test('PUT -> GET round-trip reflects changes', async () => {
        // First restore enabled
        await request(`http://127.0.0.1:${port}/model-routing`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: true })
        });

        const getRes1 = await request(`http://127.0.0.1:${port}/model-routing`);
        const original = getRes1.json();
        const origTiers = original.config.tiers;

        const payload = {
            tiers: {
                heavy: { models: ['test-model-roundtrip'], strategy: 'balanced' },
                medium: { models: origTiers.medium.models, strategy: origTiers.medium.strategy },
                light: { models: origTiers.light.models, strategy: origTiers.light.strategy }
            }
        };
        await request(`http://127.0.0.1:${port}/model-routing`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const getRes2 = await request(`http://127.0.0.1:${port}/model-routing`);
        const updated = getRes2.json();
        expect(updated.config.tiers.heavy.models).toContain('test-model-roundtrip');
    });

    test('normalizer patchMode does not fill missing tiers', () => {
        const { normalizeModelRoutingConfig } = require('../lib/model-router-normalizer');
        const result = normalizeModelRoutingConfig(
            { tiers: { heavy: { models: ['x'], strategy: 'quality' } } },
            { patchMode: true }
        );
        // In patch mode, light and medium should NOT be filled
        expect(result.normalizedConfig.tiers.light).toBeUndefined();
        expect(result.normalizedConfig.tiers.medium).toBeUndefined();
        expect(result.normalizedConfig.tiers.heavy.models).toEqual(['x']);
    });

    test('normalizer without patchMode fills missing tiers (backward compat)', () => {
        const { normalizeModelRoutingConfig } = require('../lib/model-router-normalizer');
        const result = normalizeModelRoutingConfig(
            { tiers: { heavy: { models: ['x'], strategy: 'quality' } } }
        );
        // Without patch mode, light and medium should be filled
        expect(result.normalizedConfig.tiers.light).toBeDefined();
        expect(result.normalizedConfig.tiers.medium).toBeDefined();
    });
});
