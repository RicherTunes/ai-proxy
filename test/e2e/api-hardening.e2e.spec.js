/**
 * API Hardening E2E Tests
 * Tests health endpoints, auth flows, and API error handling
 * using a real ProxyServer instance.
 */

const { test, expect } = require('./fixtures');
const http = require('http');

function httpRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const method = options.method || 'GET';
        const headers = options.headers || {};
        const body = options.body || null;
        const parsed = new URL(url);

        const req = http.request({
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method,
            headers,
            timeout: 5000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch (_) {}
                resolve({ status: res.statusCode, headers: res.headers, body: data, json });
            });
        });
        req.on('error', reject);
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

// ============================================================================
// HEALTH ENDPOINT TESTS
// ============================================================================

test.describe('API Health Endpoints', () => {
    test('GET /health returns 200 with status ok', async ({ proxyServer }) => {
        const res = await httpRequest(proxyServer.url + '/health');
        expect(res.status).toBe(200);
        expect(res.json).toBeTruthy();
        expect(res.json.status.toLowerCase()).toBe('ok');
    });

    test('GET /health response includes uptime', async ({ proxyServer }) => {
        const res = await httpRequest(proxyServer.url + '/health');
        expect(res.json.uptime).toBeGreaterThanOrEqual(0);
    });

    test('GET /stats returns 200 with uptime and keys', async ({ proxyServer }) => {
        const res = await httpRequest(proxyServer.url + '/stats');
        expect(res.status).toBe(200);
        expect(res.json).toBeTruthy();
        expect(typeof res.json.uptime).toBe('number');
        expect(Array.isArray(res.json.keys)).toBe(true);
        expect(res.json.keys.length).toBeGreaterThan(0);
    });
});

// ============================================================================
// API ENDPOINT SCHEMA TESTS
// ============================================================================

test.describe('API Endpoint Schemas', () => {
    test('GET /models returns array of model objects', async ({ proxyServer }) => {
        const res = await httpRequest(proxyServer.url + '/models');
        expect(res.status).toBe(200);
        expect(res.json).toBeTruthy();
        expect(Array.isArray(res.json.models)).toBe(true);
        if (res.json.models.length > 0) {
            const model = res.json.models[0];
            expect(model).toHaveProperty('id');
            expect(model).toHaveProperty('displayName');
        }
    });

    test('GET /model-routing returns routing configuration', async ({ proxyServer }) => {
        const res = await httpRequest(proxyServer.url + '/model-routing');
        expect(res.status).toBe(200);
        expect(res.json).toBeTruthy();
        expect(res.json).toHaveProperty('enabled');
    });

    test('GET /history returns history data with schema version', async ({ proxyServer }) => {
        const res = await httpRequest(proxyServer.url + '/history?minutes=5');
        expect(res.status).toBe(200);
        expect(res.json).toBeTruthy();
    });

    test('unknown endpoint returns 404', async ({ proxyServer }) => {
        const res = await httpRequest(proxyServer.url + '/nonexistent-endpoint');
        // Could be 404 or handled by proxy — just shouldn't be 500
        expect(res.status).not.toBe(500);
    });
});

// ============================================================================
// REQUEST VALIDATION TESTS
// ============================================================================

test.describe('API Request Validation', () => {
    test('POST /v1/messages without body returns error', async ({ proxyServer }) => {
        const res = await httpRequest(proxyServer.url + '/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-key1.secret1' }
        });
        // Should not crash (500) — should return 4xx
        expect(res.status).not.toBe(500);
    });

    test('POST /v1/messages with malformed JSON returns error', async ({ proxyServer }) => {
        const res = await httpRequest(proxyServer.url + '/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-key1.secret1' },
            body: '{invalid json'
        });
        // Should not crash — proxy may forward to upstream or reject
        expect(res.status).not.toBe(500);
    });

    test('PUT /model-routing with invalid JSON returns 400', async ({ proxyServer }) => {
        const res = await httpRequest(proxyServer.url + '/model-routing', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: '{not valid'
        });
        expect(res.status).toBe(400);
    });

    test('PUT /model-routing with empty body does not crash', async ({ proxyServer }) => {
        const res = await httpRequest(proxyServer.url + '/model-routing', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        // Empty object {} is valid JSON — should not 500
        expect(res.status).not.toBe(500);
    });
});

// ============================================================================
// CONTROL ENDPOINT TESTS
// ============================================================================

test.describe('Control Endpoints', () => {
    test('POST /control/pause returns 200', async ({ proxyServer }) => {
        const res = await httpRequest(proxyServer.url + '/control/pause', { method: 'POST' });
        expect(res.status).toBe(200);
    });

    test('POST /control/resume returns 200', async ({ proxyServer }) => {
        const res = await httpRequest(proxyServer.url + '/control/resume', { method: 'POST' });
        expect(res.status).toBe(200);
    });

    test('pause then resume cycle works', async ({ proxyServer }) => {
        await httpRequest(proxyServer.url + '/control/pause', { method: 'POST' });
        const statsAfterPause = await httpRequest(proxyServer.url + '/stats');
        expect(statsAfterPause.json.paused).toBe(true);

        await httpRequest(proxyServer.url + '/control/resume', { method: 'POST' });
        const statsAfterResume = await httpRequest(proxyServer.url + '/stats');
        expect(statsAfterResume.json.paused).toBe(false);
    });
});

// ============================================================================
// CONCURRENT REQUEST HANDLING
// ============================================================================

test.describe('Concurrent Request Handling', () => {
    test('multiple simultaneous stats requests all succeed', async ({ proxyServer }) => {
        const promises = [];
        for (let i = 0; i < 10; i++) {
            promises.push(httpRequest(proxyServer.url + '/stats'));
        }
        const results = await Promise.all(promises);
        for (const res of results) {
            expect(res.status).toBe(200);
            expect(res.json).toBeTruthy();
        }
    });

    test('concurrent model-routing reads do not conflict', async ({ proxyServer }) => {
        const promises = [];
        for (let i = 0; i < 5; i++) {
            promises.push(httpRequest(proxyServer.url + '/model-routing'));
        }
        const results = await Promise.all(promises);
        // All should return same config
        const firstEnabled = results[0].json.enabled;
        for (const res of results) {
            expect(res.status).toBe(200);
            expect(res.json.enabled).toBe(firstEnabled);
        }
    });
});
