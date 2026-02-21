/**
 * Boot integration smoke.
 *
 * Verifies a real ProxyServer instance starts and serves core endpoints.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { ProxyServer } = require('../lib/proxy-server');
const { Config, resetConfig } = require('../lib/config');
const { resetLogger } = require('../lib/logger');

function request(url, options = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(url, {
            method: options.method || 'GET',
            headers: options.headers || {},
            agent: false
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: data,
                    json: () => JSON.parse(data)
                });
            });
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

describe('Proxy boot integration smoke', () => {
    let proxyServer;
    let proxyUrl;
    let testDir;

    beforeEach(async () => {
        resetConfig();
        resetLogger();

        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-boot-'));
        fs.writeFileSync(
            path.join(testDir, 'test-keys.json'),
            JSON.stringify({
                keys: ['testkey1.secret1'],
                baseUrl: 'https://api.anthropic.com/'
            })
        );

        const config = new Config({
            configDir: testDir,
            keysFile: 'test-keys.json',
            statsFile: 'test-stats.json',
            useCluster: false,
            host: '127.0.0.1',
            port: 0,
            logLevel: 'ERROR'
        });

        proxyServer = new ProxyServer({ config });
        const server = await proxyServer.start();
        proxyUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterEach(async () => {
        if (proxyServer) {
            await proxyServer.shutdown();
            proxyServer = null;
        }
        if (testDir) {
            fs.rmSync(testDir, { recursive: true, force: true });
            testDir = null;
        }
    });

    test('serves /health, /dashboard, /stats after boot', async () => {
        const healthRes = await request(proxyUrl + '/health');
        expect(healthRes.statusCode).toBe(200);
        const health = healthRes.json();
        expect(health.status).toBe('OK');
        expect(health.totalKeys).toBeGreaterThan(0);

        const dashboardRes = await request(proxyUrl + '/dashboard');
        expect(dashboardRes.statusCode).toBe(200);
        expect(dashboardRes.headers['content-type']).toContain('text/html');
        expect(dashboardRes.body.length).toBeGreaterThan(1000);

        const statsRes = await request(proxyUrl + '/stats');
        expect(statsRes.statusCode).toBe(200);
        const stats = statsRes.json();
        expect(stats).toHaveProperty('uptime');
        expect(stats).toHaveProperty('keys');
    });
});
