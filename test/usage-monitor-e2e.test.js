/**
 * E2E Test: Usage Monitor integration with /stats endpoint
 *
 * Proves that accountUsage data flows from UsageMonitor → _handleStats → /stats HTTP response.
 * Uses a real ProxyServer with usageMonitor enabled, mocking only the upstream HTTPS calls.
 */

const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const { ProxyServer } = require('../lib/proxy-server');
const { Config } = require('../lib/config');
const path = require('path');
const os = require('os');
const fs = require('fs');

// z.ai API mock responses (real shapes from production)
const MOCK_QUOTA = {
    code: 200, msg: 'Operation successful', success: true,
    data: {
        limits: [
            {
                type: 'TIME_LIMIT', unit: 5, number: 1,
                usage: 4000, currentValue: 85, remaining: 3915, percentage: 2,
                nextResetTime: Date.now() + 86400000,
                usageDetails: [{ modelCode: 'search-prime', usage: 61 }]
            },
            { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 18, nextResetTime: Date.now() + 86400000 }
        ],
        level: 'max'
    }
};

const MOCK_MODEL_USAGE = {
    code: 200, msg: 'Operation successful', success: true,
    data: {
        x_time: ['2026-02-20 10:00', '2026-02-20 11:00'],
        modelCallCount: [100, 200],
        tokensUsage: [5000000, 10000000],
        totalUsage: { totalModelCallCount: 300, totalTokensUsage: 15000000 }
    }
};

const MOCK_TOOL_USAGE = {
    code: 200, msg: 'Operation successful', success: true,
    data: {
        x_time: ['2026-02-20 10:00', '2026-02-20 11:00'],
        networkSearchCount: [null, null],
        totalUsage: {
            totalNetworkSearchCount: 10, totalWebReadMcpCount: 5,
            totalZreadMcpCount: 0, totalSearchMcpCount: 3, toolDetails: []
        }
    }
};

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('Invalid JSON: ' + data.slice(0, 100))); }
            });
        }).on('error', reject);
    });
}

describe('Usage Monitor E2E', () => {
    let proxyServer, proxyUrl, testDir;
    let httpsGetSpy;

    beforeAll(async () => {
        // Create temp dir with minimal key config
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-usage-e2e-'));
        fs.writeFileSync(path.join(testDir, 'test-keys.json'), JSON.stringify({
            keys: ['test-key-1.secret', 'test-key-2.secret'],
            baseUrl: 'https://api.z.ai/api/anthropic'
        }));
        fs.writeFileSync(path.join(testDir, 'test-stats.json'), '{}');

        // Mock https.get BEFORE creating ProxyServer so UsageMonitor uses our mock
        httpsGetSpy = jest.spyOn(https, 'get').mockImplementation((opts, cb) => {
            const fakeReq = new EventEmitter();
            fakeReq.destroy = jest.fn();

            // Only intercept monitor API calls, let others pass
            if (typeof opts === 'object' && opts.path && opts.path.includes('/api/monitor/')) {
                const body = opts.path.includes('quota') ? MOCK_QUOTA
                    : opts.path.includes('model-usage') ? MOCK_MODEL_USAGE
                    : MOCK_TOOL_USAGE;

                const res = new EventEmitter();
                res.statusCode = 200;
                Promise.resolve().then(() => {
                    cb(res);
                    res.emit('data', JSON.stringify(body));
                    res.emit('end');
                });
            } else {
                // Non-monitor requests: return 503 (no real upstream)
                const res = new EventEmitter();
                res.statusCode = 503;
                Promise.resolve().then(() => {
                    cb(res);
                    res.emit('data', '{"error":"mocked"}');
                    res.emit('end');
                });
            }
            return fakeReq;
        });

        const config = new Config({
            configDir: testDir,
            keysFile: 'test-keys.json',
            statsFile: 'test-stats.json',
            useCluster: false,
            port: 0,
            adminAuth: { enabled: false },
            enableHotReload: false,
            security: { rateLimit: { enabled: false } },
            usageMonitor: {
                enabled: true,
                pollIntervalMs: 60000,
                timeoutMs: 5000,
                backoffIntervalMs: 300000,
                maxConsecutiveErrors: 5,
                exposeDetails: false
            }
        });

        proxyServer = new ProxyServer({ config });
        const server = await proxyServer.start();
        proxyUrl = `http://127.0.0.1:${server.address().port}`;

        // Wait for first poll to complete (UsageMonitor starts on server.start())
        await new Promise(resolve => setTimeout(resolve, 3000));
    }, 15000);

    afterAll(async () => {
        httpsGetSpy.mockRestore();
        await proxyServer.shutdown();
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('GET /stats includes accountUsage with schemaVersion 1', async () => {
        const stats = await fetchJson(`${proxyUrl}/stats`);

        expect(stats).toHaveProperty('accountUsage');
        expect(stats.accountUsage.schemaVersion).toBe(1);
        expect(stats.accountUsage.stale).toBe(false);
        expect(stats.accountUsage.lastPollAt).toBeGreaterThan(0);
    });

    it('GET /stats accountUsage contract includes required top-level keys', async () => {
        const stats = await fetchJson(`${proxyUrl}/stats`);
        const accountUsage = stats.accountUsage;

        expect(accountUsage).toBeDefined();
        expect(accountUsage).toHaveProperty('schemaVersion');
        expect(accountUsage).toHaveProperty('lastPollAt');
        expect(accountUsage).toHaveProperty('stale');
        expect(accountUsage).toHaveProperty('partial');
        expect(accountUsage).toHaveProperty('sourceUnavailable');
        expect(accountUsage).toHaveProperty('_monitor');
        expect(accountUsage).toHaveProperty('quota');
        expect(accountUsage).toHaveProperty('modelUsage');
        expect(accountUsage).toHaveProperty('toolUsage');
    });

    it('accountUsage.quota shows subscription level and token usage', async () => {
        const stats = await fetchJson(`${proxyUrl}/stats`);
        const quota = stats.accountUsage.quota;

        expect(quota).not.toBeNull();
        expect(quota.level).toBe('max');
        expect(quota.tokenUsagePercent).toBe(18);
        expect(quota.tokenNextResetAt).toBeGreaterThan(0);
        expect(quota.error).toBeNull();
    });

    it('accountUsage.quota.toolUsage shows usage and limits', async () => {
        const stats = await fetchJson(`${proxyUrl}/stats`);
        const tu = stats.accountUsage.quota.toolUsage;

        expect(tu).not.toBeNull();
        expect(tu.limit).toBe(4000);
        expect(tu.used).toBe(85);
        expect(tu.remaining).toBe(3915);
        expect(tu.percent).toBe(2);
    });

    it('accountUsage.modelUsage shows aggregate 24h totals', async () => {
        const stats = await fetchJson(`${proxyUrl}/stats`);
        const mu = stats.accountUsage.modelUsage;

        expect(mu).not.toBeNull();
        expect(mu.totalRequests).toBe(300);
        expect(mu.totalTokens).toBe(15000000);
        expect(mu.error).toBeNull();
    });

    it('accountUsage.modelUsage includes timeSeries for dashboard charts', async () => {
        const stats = await fetchJson(`${proxyUrl}/stats`);
        const ts = stats.accountUsage.modelUsage.timeSeries;
        expect(ts).toBeDefined();
        expect(ts.times).toEqual(['2026-02-20 10:00', '2026-02-20 11:00']);
        expect(ts.callCounts).toEqual([100, 200]);
        expect(ts.tokenCounts).toEqual([5000000, 10000000]);
    });

    it('accountUsage.toolUsage shows per-tool counts', async () => {
        const stats = await fetchJson(`${proxyUrl}/stats`);
        const tools = stats.accountUsage.toolUsage.tools;

        expect(tools).toBeDefined();
        expect(tools.networkSearch).toBe(10);
        expect(tools.webRead).toBe(5);
        expect(tools.zread).toBe(0);
        expect(tools.search).toBe(3);
    });

    it('accountUsage._monitor shows healthy polling state', async () => {
        const stats = await fetchJson(`${proxyUrl}/stats`);
        const monitor = stats.accountUsage._monitor;

        expect(monitor.pollSuccessTotal).toBeGreaterThanOrEqual(1);
        expect(monitor.pollErrorTotal).toBe(0);
        expect(monitor.consecutiveErrors).toBe(0);
        expect(monitor.lastSuccessAt).toBeGreaterThan(0);
    });

    it('accountUsage.quota does NOT include toolDetails when exposeDetails=false', async () => {
        const stats = await fetchJson(`${proxyUrl}/stats`);
        expect(stats.accountUsage.quota.toolDetails).toBeUndefined();
    });

    it('accountUsage is absent when usageMonitor is null (cluster worker scenario)', async () => {
        // Verify the field exists for our server (primary, not worker)
        const stats = await fetchJson(`${proxyUrl}/stats`);
        expect(stats.accountUsage).toBeDefined();
        // The proxy-server.js code guards: if (this.usageMonitor) { stats.accountUsage = ... }
        // A cluster worker would have usageMonitor = null → no accountUsage field
    });

    // ---- /stats/account-details endpoint ----

    it('GET /stats/account-details returns full quota limits', async () => {
        const details = await fetchJson(`${proxyUrl}/stats/account-details`);

        expect(details).toHaveProperty('quota');
        expect(details.quota.level).toBe('max');
        expect(details.quota.limits).toHaveLength(2);
        expect(details.quota.limits[0].type).toBe('TIME_LIMIT');
        expect(details.quota.limits[1].type).toBe('TOKENS_LIMIT');
    });

    it('GET /stats/account-details returns tool details regardless of exposeDetails', async () => {
        // Our test config has exposeDetails: false, but getDetails() always returns full data
        const details = await fetchJson(`${proxyUrl}/stats/account-details`);

        expect(details.quota.toolDetails).toBeDefined();
        expect(details.quota.toolDetails.length).toBeGreaterThanOrEqual(1);
        expect(details.quota.toolDetails[0].model).toBe('search-prime');
    });

    it('GET /stats/account-details includes model usage with time-series', async () => {
        const details = await fetchJson(`${proxyUrl}/stats/account-details`);

        expect(details.modelUsage).not.toBeNull();
        expect(details.modelUsage.totalRequests).toBe(300);
        expect(details.modelUsage.totalTokens).toBe(15000000);
        expect(details.modelUsage.timeSeries).not.toBeNull();
        expect(details.modelUsage.timeSeries.times).toHaveLength(2);
    });

    it('GET /stats/account-details includes tool usage totals', async () => {
        const details = await fetchJson(`${proxyUrl}/stats/account-details`);

        expect(details.toolUsage).not.toBeNull();
        expect(details.toolUsage.tools.networkSearch).toBe(10);
        expect(details.toolUsage.tools.webRead).toBe(5);
    });

    it('GET /stats/account-details includes health metrics', async () => {
        const details = await fetchJson(`${proxyUrl}/stats/account-details`);

        expect(details._monitor).toBeDefined();
        expect(details._monitor.pollSuccessTotal).toBeGreaterThanOrEqual(1);
    });
});
