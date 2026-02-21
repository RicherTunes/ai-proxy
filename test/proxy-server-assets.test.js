/**
 * Dashboard asset whitelist smoke tests.
 *
 * Verifies local vendor fallback assets are actually served.
 */

'use strict';

const fs = require('fs');
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
                    body: data
                });
            });
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

describe('ProxyServer dashboard asset whitelist', () => {
    let testDir;
    let proxyServer;
    let proxyUrl;

    beforeEach(async () => {
        resetConfig();
        resetLogger();

        testDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'glm-assets-'));
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
            port: 0,
            host: '127.0.0.1',
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

    test.each([
        '/dashboard/vendor/chart.js.min.js',
        '/dashboard/vendor/d3.min.js',
        '/dashboard/vendor/sortable.min.js',
        '/dashboard/dashboard-utils.js'
    ])('serves %s with 200', async (assetPath) => {
        const res = await request(proxyUrl + assetPath);
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('javascript');
        expect(res.body.length).toBeGreaterThan(0);
    });

    test('returns 404 for unknown dashboard asset', async () => {
        const res = await request(proxyUrl + '/dashboard/vendor/unknown.js');
        expect(res.statusCode).toBe(404);
    });
});
