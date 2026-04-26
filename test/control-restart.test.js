'use strict';

/**
 * Tests for the POST /control/restart endpoint.
 *
 * Validates the endpoint returns the correct response, requires admin auth,
 * and rejects non-POST methods — without actually restarting the process.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { ProxyServer } = require('../lib/proxy-server');
const { Config, resetConfig } = require('../lib/config');
const { resetLogger } = require('../lib/logger');
const { generateToken } = require('../lib/admin-auth');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function request(port, pathname, options = {}) {
    const method = options.method || 'GET';
    const headers = { connection: 'close', ...(options.headers || {}) };
    const body = options.body || null;

    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: pathname,
            method,
            headers,
            agent: false
        }, (res) => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
                let json = {};
                try { json = JSON.parse(raw); } catch { /* non-JSON */ }
                resolve({ status: res.statusCode || 0, headers: res.headers, text: raw, json });
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('POST /control/restart', () => {
    let testDir;
    let proxy;
    let port;
    let adminToken;

    beforeAll(async () => {
        resetConfig();
        resetLogger();

        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-restart-'));
        fs.writeFileSync(
            path.join(testDir, 'test-keys.json'),
            JSON.stringify({ keys: ['testkey1.secret1'], baseUrl: 'https://api.z.ai' })
        );
        fs.writeFileSync(path.join(testDir, 'test-stats.json'), '{}');

        adminToken = generateToken();

        const config = new Config({
            configDir: testDir,
            keysFile: 'test-keys.json',
            statsFile: 'test-stats.json',
            useCluster: false,
            port: 0,
            host: '127.0.0.1',
            enableHotReload: false,
            usageMonitor: { enabled: false },
            adminAuth: {
                enabled: true,
                tokens: [adminToken],
                headerName: 'x-admin-token',
                maxAttempts: 200
            },
            security: {
                mode: 'local',
                rateLimit: { enabled: false },
                auditLog: { enabled: true, maxEntries: 100 }
            }
        });

        proxy = new ProxyServer({ config });
        await proxy.initialize();

        // Stub _performRestart so the process doesn't actually exit
        proxy._performRestart = jest.fn();

        await new Promise((resolve) => {
            proxy._createServer();
            proxy.server.listen(0, '127.0.0.1', () => {
                port = proxy.server.address().port;
                resolve();
            });
        });
    });

    afterAll(async () => {
        if (proxy) {
            await proxy.shutdown().catch(() => {});
        }
        try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* cleanup best-effort */ }
    });

    test('returns 200 with restarting status and full mode (non-cluster)', async () => {
        const res = await request(port, '/control/restart', {
            method: 'POST',
            headers: { 'x-admin-token': adminToken }
        });

        expect(res.status).toBe(200);
        expect(res.json.status).toBe('restarting');
        expect(res.json.message).toBe('Graceful restart initiated');
        expect(res.json.mode).toBe('full');
    });

    test('calls _performRestart after responding', async () => {
        proxy._performRestart.mockClear();

        await request(port, '/control/restart', {
            method: 'POST',
            headers: { 'x-admin-token': adminToken }
        });

        // _performRestart is called after a 100ms setTimeout
        await new Promise(resolve => setTimeout(resolve, 250));
        expect(proxy._performRestart).toHaveBeenCalled();
    });

    test('returns 401 without admin token when auth is enabled', async () => {
        const res = await request(port, '/control/restart', {
            method: 'POST'
        });

        expect(res.status).toBe(401);
    });

    test('returns 405 for GET method', async () => {
        const res = await request(port, '/control/restart', {
            method: 'GET',
            headers: { 'x-admin-token': adminToken }
        });

        expect(res.status).toBe(405);
    });

    test('logs restart to audit log', async () => {
        proxy._performRestart.mockClear();
        const sizeBefore = proxy._auditLog ? proxy._auditLog.size : 0;

        await request(port, '/control/restart', {
            method: 'POST',
            headers: { 'x-admin-token': adminToken }
        });

        // Audit entry should have been added to the ring buffer
        const sizeAfter = proxy._auditLog ? proxy._auditLog.size : 0;
        expect(sizeAfter).toBeGreaterThan(sizeBefore);

        // Check the entry: _addAuditEntry('control_action', { ip, action: 'restart', mode })
        // produces { timestamp, event: 'control_action', ip, action: 'restart', mode: 'full' }
        const entries = proxy._auditLog.toArray();
        const restartEntry = entries.find(e =>
            e.event === 'control_action' && e.action === 'restart'
        );
        expect(restartEntry).toBeTruthy();
        expect(restartEntry.mode).toBe('full');
    });
});

describe('_performRestart method', () => {
    test('exists on ProxyServer prototype', () => {
        expect(typeof ProxyServer.prototype._performRestart).toBe('function');
    });
});
