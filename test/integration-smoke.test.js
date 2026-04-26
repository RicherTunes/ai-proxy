/**
 * Integration Smoke Tests
 *
 * Lightweight end-to-end tests that verify the proxy system works as a whole.
 * Each test boots a real ProxyServer on a random port (port 0) with minimal
 * config (1 key, defaults) and validates a single behavioural contract.
 *
 * Gaps filled vs existing suites (e2e-smoke, proxy-server):
 *   - Dashboard HTML response
 *   - Model routing endpoint
 *   - SSE /requests/stream content-type
 *   - 404 handling on unknown admin paths
 *   - CORS headers when configured
 *   - Restart resilience (start → stop → start)
 */

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { ProxyServer } = require('../lib/proxy-server');
const { Config, resetConfig } = require('../lib/config');
const { resetLogger } = require('../lib/logger');
const { request } = require('./helpers/http-request');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp directory with a minimal 1-key config and return paths. */
function createMinimalConfig(overrides = {}) {
    const testDir = path.join(__dirname, 'int-smoke-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
    const keysFile = 'keys.json';
    const statsFile = 'stats.json';

    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(
        path.join(testDir, keysFile),
        JSON.stringify({
            keys: ['testkey1.secret1'],
            baseUrl: 'https://127.0.0.1:19999/api'
        })
    );

    const config = new Config({
        configDir: testDir,
        keysFile,
        statsFile,
        useCluster: false,
        port: 0,
        logLevel: 'ERROR',
        enableHotReload: false,
        adminAuth: { enabled: false },
        security: { rateLimit: { enabled: false } },
        ...overrides
    });

    return { testDir, keysFile, statsFile, config };
}

/** Recursively delete a directory. */
function rmdir(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    for (const entry of fs.readdirSync(dirPath)) {
        const full = path.join(dirPath, entry);
        if (fs.statSync(full).isDirectory()) {
            rmdir(full);
        } else {
            fs.unlinkSync(full);
        }
    }
    fs.rmdirSync(dirPath);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Integration Smoke Tests', () => {
    let proxyServer;
    let proxyUrl;
    let testDir;

    beforeEach(() => {
        resetConfig();
        resetLogger();
    });

    afterEach(async () => {
        if (proxyServer) {
            try {
                await Promise.race([
                    proxyServer.shutdown(),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('shutdown timeout')), 5000))
                ]);
            } catch (_) { /* ignore */ }
            proxyServer = null;
        }
        if (testDir) {
            try { rmdir(testDir); } catch (_) { /* ignore */ }
            testDir = null;
        }
    });

    // ----- 1. Server boot -----
    test('starts without crash on minimal config (1 key, defaults)', async () => {
        const ctx = createMinimalConfig();
        testDir = ctx.testDir;

        proxyServer = new ProxyServer({ config: ctx.config });
        const httpServer = await proxyServer.start();

        expect(httpServer).toBeTruthy();
        expect(httpServer.listening).toBe(true);

        const address = httpServer.address();
        expect(address.port).toBeGreaterThan(0);
    });

    // ----- 2. Health endpoint -----
    test('GET /health returns 200 with status, uptime, keys', async () => {
        const ctx = createMinimalConfig();
        testDir = ctx.testDir;

        proxyServer = new ProxyServer({ config: ctx.config });
        const httpServer = await proxyServer.start();
        proxyUrl = `http://127.0.0.1:${httpServer.address().port}`;

        const res = await request(`${proxyUrl}/health`);

        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data).toHaveProperty('status');
        expect(data).toHaveProperty('uptime');
        expect(data).toHaveProperty('totalKeys');
        expect(data.totalKeys).toBe(1);
        expect(data.uptime).toBeGreaterThanOrEqual(0);
    });

    // ----- 3. Stats endpoint -----
    test('GET /stats returns 200 with valid JSON', async () => {
        const ctx = createMinimalConfig();
        testDir = ctx.testDir;

        proxyServer = new ProxyServer({ config: ctx.config });
        const httpServer = await proxyServer.start();
        proxyUrl = `http://127.0.0.1:${httpServer.address().port}`;

        const res = await request(`${proxyUrl}/stats`);

        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data).toHaveProperty('uptime');
        expect(data).toHaveProperty('keys');
        expect(data).toHaveProperty('errors');
        expect(Array.isArray(data.keys)).toBe(true);
        expect(data.keys.length).toBe(1);
    });

    // ----- 4. Dashboard endpoint -----
    test('GET /dashboard returns 200 with HTML containing expected structure', async () => {
        const ctx = createMinimalConfig();
        testDir = ctx.testDir;

        proxyServer = new ProxyServer({ config: ctx.config });
        const httpServer = await proxyServer.start();
        proxyUrl = `http://127.0.0.1:${httpServer.address().port}`;

        const res = await request(`${proxyUrl}/dashboard`);

        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/html/);
        // The dashboard should contain standard HTML markers
        expect(res.body).toMatch(/<!DOCTYPE html>/i);
        expect(res.body).toMatch(/<html/i);
        expect(res.body).toMatch(/<\/html>/i);
    });

    // ----- 5. Model routing endpoint -----
    test('GET /model-routing returns 200 with routing config', async () => {
        const ctx = createMinimalConfig();
        testDir = ctx.testDir;

        proxyServer = new ProxyServer({ config: ctx.config });
        const httpServer = await proxyServer.start();
        proxyUrl = `http://127.0.0.1:${httpServer.address().port}`;

        const res = await request(`${proxyUrl}/model-routing`);

        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data).toBeTruthy();
        // Model routing returns either enabled routing state or a disabled-info object
        expect(typeof data).toBe('object');
    });

    // ----- 6. SSE connection -----
    test('/requests/stream returns text/event-stream content type', async () => {
        const ctx = createMinimalConfig();
        testDir = ctx.testDir;

        proxyServer = new ProxyServer({ config: ctx.config });
        const httpServer = await proxyServer.start();
        const port = httpServer.address().port;

        // Use raw http to capture headers before the stream stays open
        const contentType = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('SSE header timeout')), 5000);

            const req = http.get(`http://127.0.0.1:${port}/requests/stream`, (res) => {
                clearTimeout(timer);
                // Capture content-type then immediately destroy to avoid hanging
                resolve(res.headers['content-type']);
                res.destroy();
            });
            req.on('error', (err) => {
                clearTimeout(timer);
                // ECONNRESET is acceptable if server-side closes first
                if (err.code === 'ECONNRESET') {
                    resolve(null);
                } else {
                    reject(err);
                }
            });
        });

        expect(contentType).toMatch(/text\/event-stream/);
    });

    // ----- 7. 404 handling -----
    test('unknown admin path returns 404 or is routed to proxy (not crash)', async () => {
        const ctx = createMinimalConfig();
        testDir = ctx.testDir;

        proxyServer = new ProxyServer({ config: ctx.config });
        const httpServer = await proxyServer.start();
        proxyUrl = `http://127.0.0.1:${httpServer.address().port}`;

        // Paths not in the admin route list get forwarded to the upstream proxy handler,
        // which will fail to connect and return an error code. The key assertion is
        // that the server does NOT crash and returns a valid HTTP response.
        const res = await request(`${proxyUrl}/nonexistent-path-xyz`);

        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        // Response should be valid (not empty, not a crash)
        expect(res.body.length).toBeGreaterThan(0);
    });

    // ----- 8. CORS headers -----
    test('responses include CORS headers when allowedOrigins configured with wildcard', async () => {
        const ctx = createMinimalConfig({
            security: {
                rateLimit: { enabled: false },
                cors: { allowedOrigins: ['*'] }
            }
        });
        testDir = ctx.testDir;

        proxyServer = new ProxyServer({ config: ctx.config });
        const httpServer = await proxyServer.start();
        proxyUrl = `http://127.0.0.1:${httpServer.address().port}`;

        // CORS headers are applied on SSE and some endpoints via _getCorsHeaders.
        // The /health endpoint itself doesn't go through _getCorsHeaders in most routes,
        // but /requests/stream explicitly applies CORS. Let's verify via the SSE endpoint.
        const corsHeader = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('CORS timeout')), 5000);

            const req = http.get(`http://127.0.0.1:${httpServer.address().port}/requests/stream`, {
                headers: { origin: 'http://example.com' }
            }, (res) => {
                clearTimeout(timer);
                resolve(res.headers['access-control-allow-origin']);
                res.destroy();
            });
            req.on('error', (err) => {
                clearTimeout(timer);
                if (err.code === 'ECONNRESET') resolve(null);
                else reject(err);
            });
        });

        expect(corsHeader).toBe('*');
    });

    // ----- 9. Graceful shutdown -----
    test('server shuts down cleanly within 5 seconds', async () => {
        const ctx = createMinimalConfig({ shutdownTimeout: 2000 });
        testDir = ctx.testDir;

        proxyServer = new ProxyServer({ config: ctx.config });
        await proxyServer.start();

        const start = Date.now();
        await proxyServer.shutdown();
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(5000);
        expect(proxyServer.isShuttingDown).toBe(true);

        // Prevent afterEach from double-shutting down
        proxyServer = null;
    });

    // ----- 10. Restart resilience -----
    test('start, stop, start again — second start works', async () => {
        const ctx = createMinimalConfig();
        testDir = ctx.testDir;

        // First start
        proxyServer = new ProxyServer({ config: ctx.config });
        const httpServer1 = await proxyServer.start();
        const port1 = httpServer1.address().port;
        expect(httpServer1.listening).toBe(true);

        // Verify it responds
        const res1 = await request(`http://127.0.0.1:${port1}/health`);
        expect(res1.statusCode).toBe(200);

        // Stop
        await proxyServer.shutdown();
        proxyServer = null;

        // Reset singletons between starts
        resetConfig();
        resetLogger();

        // Second start with fresh config pointing at same directory
        const config2 = new Config({
            configDir: ctx.testDir,
            keysFile: ctx.keysFile,
            statsFile: ctx.statsFile,
            useCluster: false,
            port: 0,
            logLevel: 'ERROR',
            enableHotReload: false,
            adminAuth: { enabled: false },
            security: { rateLimit: { enabled: false } }
        });

        proxyServer = new ProxyServer({ config: config2 });
        const httpServer2 = await proxyServer.start();
        const port2 = httpServer2.address().port;

        expect(httpServer2.listening).toBe(true);
        expect(port2).toBeGreaterThan(0);

        // Verify second instance responds
        const res2 = await request(`http://127.0.0.1:${port2}/health`);
        expect(res2.statusCode).toBe(200);
        expect(res2.json().totalKeys).toBe(1);
    });
});
