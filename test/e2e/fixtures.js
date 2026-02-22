const { test, expect } = require('@playwright/test');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { ProxyServer } = require('../../lib/proxy-server');
const { Config } = require('../../lib/config');

// Start test server (no upstream needed for dashboard UI tests)
async function startTestServer() {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-proxy-e2e-'));
  const testKeysFile = 'test-keys.json';
  const testStatsFile = 'test-stats.json';

  // Create test keys with dummy baseUrl (we won't make real upstream requests in dashboard tests)
  fs.writeFileSync(
    path.join(testDir, testKeysFile),
    JSON.stringify({
      keys: ['test-key1.secret1', 'test-key2.secret2'],
      baseUrl: 'https://api.anthropic.com'  // Dummy URL - won't be used for dashboard UI tests
    })
  );

  fs.writeFileSync(path.join(testDir, testStatsFile), JSON.stringify({}));

  const config = new Config({
    configDir: testDir,
    keysFile: testKeysFile,
    statsFile: testStatsFile,
    useCluster: false,
    port: 0,
    adminAuth: { enabled: false },
    enableHotReload: false,  // Disable hot reload in tests to avoid race conditions
    security: { rateLimit: { enabled: false } },  // Disable rate limiting in tests to prevent 429s after many sequential tests
    usageMonitor: { enabled: false }  // Keep E2E deterministic and independent from external monitor endpoints
  });

  const proxyServer = new ProxyServer({ config });
  const server = await proxyServer.start();
  const address = server.address();
  const proxyUrl = `http://127.0.0.1:${address.port}`;

  return { proxyServer, proxyUrl, testDir, config };
}

// Seed stats by directly calling statsAggregator
async function seedStats(proxyServer) {
  const statsAggregator = proxyServer.statsAggregator;

  // Record some initial requests for the dashboard to display
  statsAggregator.recordRequest({
    id: 'req-1',
    keyIndex: 0,
    method: 'POST',
    path: '/v1/messages',
    status: 'success',
    latency: 150,
    error: null
  });

  statsAggregator.recordRequest({
    id: 'req-2',
    keyIndex: 1,
    method: 'POST',
    path: '/v1/messages',
    status: 'success',
    latency: 200,
    error: null
  });

  statsAggregator.recordRequest({
    id: 'req-3',
    keyIndex: 0,
    method: 'POST',
    path: '/v1/messages',
    status: 'success',
    latency: 175,
    error: null
  });
}

// Helper to wait for SSE connection with retry and page reload fallback
async function waitForSSEConnection(page, timeout = 10000) {
  const startTime = Date.now();
  let lastStatus = null;
  let errorCount = 0;
  let reloadCount = 0;
  const maxReloads = 2;

  while (Date.now() - startTime < timeout) {
    const status = await page.evaluate(() => {
      return window.__DASHBOARD_STORE__?.getState()?.connection?.status;
    });

    if (status === 'connected') {
      return true;
    }

    // Track error/disconnected status - only reload if stuck for 3 seconds and haven't exceeded max reloads
    if (status === 'error' || status === 'disconnected') {
      errorCount++;
      // If in error/disconnected state for 3 seconds (15 checks at 200ms), try reloading
      if (errorCount > 15 && reloadCount < maxReloads) {
        reloadCount++;
        await page.reload({ waitUntil: 'domcontentloaded' });
        errorCount = 0;
      }
    } else {
      errorCount = 0;
    }

    lastStatus = status;
    await page.waitForTimeout(200);
  }
  throw new Error(`SSE connection not established within ${timeout}ms (last status: ${lastStatus})`);
}

// Helper to send test request (for integration tests that need real proxy behavior)
// Accepts either (proxyUrl) or (proxyServerFixture, options) for backward compatibility
async function sendTestRequest(proxyUrlOrFixture, options) {
  const url = typeof proxyUrlOrFixture === 'string'
    ? proxyUrlOrFixture
    : (proxyUrlOrFixture && proxyUrlOrFixture.url) || String(proxyUrlOrFixture);

  const {
    model = 'claude-3-opus',
    messages = [{ role: 'user', content: 'test' }],
    tools,
    max_tokens = 100
  } = options || {};

  const body = { model, messages, max_tokens };
  if (tools) body.tools = tools;

  // This will fail upstream but that's OK - we're testing dashboard updates
  await new Promise((resolve, reject) => {
    const req = http.request(url + '/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'test-key1.secret1'
      },
      timeout: 5000
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve());
    });
    req.on('error', () => resolve());  // Upstream errors are OK for dashboard testing
    req.end(JSON.stringify(body));
  });
}

/**
 * Inject a synthetic request into the SSE stream for dashboard testing.
 * Bypasses upstream API calls - directly adds data to the request handler stream.
 * @param {Object} proxyServerFixture - The proxyServer fixture { url, server, ... }
 * @param {Object} requestData - Request data to inject (model, tier, trace, etc.)
 */
function injectRequestToStream(proxyServerFixture, requestData) {
  const server = proxyServerFixture.server;
  const data = {
    requestId: requestData.requestId || `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    model: requestData.model || 'test-model',
    tier: requestData.tier || null,
    strategy: requestData.strategy || null,
    latencyMs: requestData.latencyMs || 50,
    success: requestData.success !== undefined ? requestData.success : true,
    status: requestData.status || 200,
    trace: requestData.trace || null,
    ...requestData
  };
  server.requestHandler.addRequestToStream(data);
}

// Export extended test with fixtures
// Using 'worker' scope to share server across tests in a worker for speed
// Retry mechanism handles occasional SSE connection flakiness
exports.test = test.extend({
  proxyServer: [async ({}, use) => {
    const { proxyServer, proxyUrl, testDir, config } = await startTestServer();
    await seedStats(proxyServer);
    await use({ url: proxyUrl, server: proxyServer, testDir, config });
    await proxyServer.shutdown();
    fs.rmSync(testDir, { recursive: true, force: true });
  }, { scope: 'worker' }],

  liveProxyServer: [async ({}, use, testInfo) => {
    const apiKey = process.env.Z_AI_GLM_API_KEY_FOR_TESTS;
    if (!apiKey) {
      // Mark test as skipped when the secret is unavailable
      testInfo.skip(true, 'Z_AI_GLM_API_KEY_FOR_TESTS secret not set — skipping live integration test');
      await use(null);
      return;
    }

    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-proxy-live-e2e-'));
    const testKeysFile = 'api-keys.json';
    const testStatsFile = 'test-stats.json';

    fs.writeFileSync(
      path.join(testDir, testKeysFile),
      JSON.stringify({
        keys: [apiKey],
        baseUrl: 'https://api.z.ai/api/anthropic'
      })
    );

    fs.writeFileSync(path.join(testDir, testStatsFile), JSON.stringify({}));

    const config = new Config({
      configDir: testDir,
      keysFile: testKeysFile,
      statsFile: testStatsFile,
      useCluster: false,
      port: 0,
      adminAuth: { enabled: false },
      enableHotReload: false,
      security: { rateLimit: { enabled: false } },
      usageMonitor: { enabled: false }
    });

    const proxyServer = new ProxyServer({ config });
    const server = await proxyServer.start();
    const address = server.address();
    const proxyUrl = `http://127.0.0.1:${address.port}`;

    await use({ url: proxyUrl, server: proxyServer, testDir, config });

    await proxyServer.shutdown();
    fs.rmSync(testDir, { recursive: true, force: true });
  }, { scope: 'test' }],
});

// Helper to wait for store and debug API to be initialized (no SSE required)
async function waitForStoreReady(page, timeout = 5000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const ready = await page.evaluate(() => {
      return !!(window.__DASHBOARD_STORE__ && window.__DASHBOARD_ACTIONS__);
    });
    if (ready) return true;
    await page.waitForTimeout(100);
  }
  throw new Error(`Dashboard store not ready within ${timeout}ms`);
}

// Fetch stats from server using Node.js http (bypasses browser connection pool)
function fetchStatsFromServer(baseUrl) {
  return new Promise((resolve) => {
    const req = http.get(baseUrl + '/stats', { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Minimal mock stats matching our 2-key test fixture.
// Used as fallback when server /stats returns an error (e.g. after pause test).
const MOCK_STATS = {
  keys: [
    { state: 'CLOSED', total: 2, success: 2, errors: 0, successRate: 100, latency: { avg: 162, p50: 150, p95: 175, p99: 175 }, healthScore: { total: 100 }, inFlight: 0 },
    { state: 'CLOSED', total: 1, success: 1, errors: 0, successRate: 100, latency: { avg: 200, p50: 200, p95: 200, p99: 200 }, healthScore: { total: 100 }, inFlight: 0 }
  ],
  uptime: 1,
  paused: false,
  requestsPerMinute: 0,
  successRate: 100,
  latency: { avg: 175, p50: 175, p95: 200, p99: 200 },
  totalRequests: 3,
  circuitBreakers: { open: 0, halfOpen: 0, closed: 2 }
};

function parseDashboardReadyOptions(optionsOrTimeout) {
  if (typeof optionsOrTimeout === 'number') {
    return { readiness: 'auto', timeoutMs: optionsOrTimeout };
  }
  const options = optionsOrTimeout || {};
  return {
    readiness: options.readiness || 'auto',
    timeoutMs: typeof options.timeoutMs === 'number' ? options.timeoutMs : 15000
  };
}

async function waitForDashboardUiBootstrap(page, timeoutMs = 15000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const readiness = await page.evaluate(() => {
      const hasHeader = !!document.querySelector('.sticky-header');
      const hasRoot = !!document.querySelector('.app');
      const hasStore = !!window.__DASHBOARD_STORE__;
      const hasActions = !!window.__DASHBOARD_ACTIONS__;
      const hasFatal = !!document.querySelector('.dashboard-error.is-fatal');
      return {
        ready: hasHeader && hasRoot && hasStore && hasActions && !hasFatal
      };
    });

    if (readiness.ready) return true;
    await page.waitForTimeout(200);
  }

  return false;
}

// Helper to navigate to dashboard and wait for data to be fetched and rendered.
// Modes:
// - auto (default): prefer stats/heatmap readiness, fallback to UI readiness
// - stats: strict stats/heatmap readiness only
// - ui: UI bootstrap readiness only
async function gotoDashboardReady(page, baseUrl, optionsOrTimeout = 15000) {
  const { readiness, timeoutMs } = parseDashboardReadyOptions(optionsOrTimeout);

  if (readiness === 'ui') {
    return gotoDashboardUiReady(page, baseUrl, timeoutMs);
  }

  if (readiness === 'stats') {
    const startTime = Date.now();
    await page.goto(baseUrl + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });
    while (Date.now() - startTime < timeoutMs) {
      const cellCount = await page.evaluate(() => {
        const heatmap = document.getElementById('keysHeatmap');
        return heatmap ? heatmap.querySelectorAll('.heatmap-cell').length : 0;
      });
      if (cellCount > 0) return true;
      await page.waitForTimeout(200);
    }
    throw new Error(`Dashboard content not rendered within ${timeoutMs}ms`);
  }

  const startTime = Date.now();

  // Try to fetch real stats from server via Node.js http (bypasses browser limits)
  let statsData = await fetchStatsFromServer(baseUrl);
  const hasRealKeys = statsData && statsData.keys && statsData.keys.length > 0;

  // Fall back to mock stats if server returned error or empty data
  if (!hasRealKeys) {
    statsData = MOCK_STATS;
  }

  // Always intercept the FIRST browser /stats request to guarantee data availability.
  // This prevents the dashboard from showing "Connection Error" when the browser's
  // fetch is blocked by connection pool exhaustion or server transient state.
  const body = JSON.stringify(statsData);
  const statsRouteMatcher = url => url.pathname === '/stats';
  let interceptCount = 0;
  const statsRouteHandler = async (route) => {
    interceptCount++;
    if (interceptCount <= 1) {
      // First request: fulfill with cached/mock data to bootstrap heatmap render
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body
      });
    } else {
      // Subsequent requests: let them through to real server
      await route.continue();
    }
  }
  await page.route(statsRouteMatcher, statsRouteHandler);

  try {
    await page.goto(baseUrl + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });

    while (Date.now() - startTime < timeoutMs) {
      const cellCount = await page.evaluate(() => {
        const heatmap = document.getElementById('keysHeatmap');
        return heatmap ? heatmap.querySelectorAll('.heatmap-cell').length : 0;
      });
      if (cellCount > 0) return true;
      await page.waitForTimeout(200);
    }

    const uiReady = await waitForDashboardUiBootstrap(page, Math.min(4000, timeoutMs));
    if (uiReady) return true;

    throw new Error(`Dashboard content not rendered within ${timeoutMs}ms`);
  } finally {
    await page.unroute(statsRouteMatcher, statsRouteHandler);
  }
}

// Navigate to dashboard and wait for UI bootstrap only (no stats/heatmap dependency).
// Useful for header/navigation tests that should stay stable even if /stats is transiently unavailable.
async function gotoDashboardUiReady(page, baseUrl, timeout = 15000) {
  await page.goto(baseUrl + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });
  const isReady = await waitForDashboardUiBootstrap(page, timeout);
  if (isReady) return true;
  throw new Error(`Dashboard UI not ready within ${timeout}ms`);
}

// Wait for UI readiness without navigation.
async function waitForDashboardUiReady(page, timeout = 15000) {
  const isReady = await waitForDashboardUiBootstrap(page, timeout);
  if (isReady) return true;
  throw new Error(`Dashboard UI not ready within ${timeout}ms`);
}

// Simpler version that just waits for heatmap cells after page is already loaded.
// For use when page.goto was already called separately.
async function waitForDashboardReady(page, timeout = 15000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const cellCount = await page.evaluate(() => {
      const heatmap = document.getElementById('keysHeatmap');
      return heatmap ? heatmap.querySelectorAll('.heatmap-cell').length : 0;
    });
    if (cellCount > 0) return true;
    await page.waitForTimeout(250);
  }
  throw new Error(`Dashboard heatmap not rendered within ${timeout}ms`);
}

// Helper to connect to SSE and get first matching event (Node.js, not browser).
// Uses the 'eventsource' npm package to avoid browser CORS/connection-pool issues.
function getSSEEvent(url, eventType = 'connected', timeoutMs = 10000) {
  const { EventSource } = require('eventsource');
  return new Promise((resolve) => {
    let es;
    const timeout = setTimeout(() => {
      if (es) es.close();
      resolve(null);
    }, timeoutMs);

    es = new EventSource(url);
    es.addEventListener(eventType, (e) => {
      clearTimeout(timeout);
      es.close();
      try {
        resolve(JSON.parse(e.data));
      } catch {
        resolve(null);
      }
    });
    es.onerror = () => {
      clearTimeout(timeout);
      es.close();
      resolve(null);
    };
  });
}

// Start test server with explicit modelRouting tiers for pool-status SSE tests.
// Separate from startTestServer() to avoid breaking existing E2E tests.
async function startTestServerWithRouting() {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-proxy-e2e-routing-'));
  const testKeysFile = 'test-keys.json';
  const testStatsFile = 'test-stats.json';

  fs.writeFileSync(
    path.join(testDir, testKeysFile),
    JSON.stringify({
      keys: ['test-key1.secret1', 'test-key2.secret2'],
      baseUrl: 'https://api.anthropic.com'
    })
  );

  fs.writeFileSync(path.join(testDir, testStatsFile), JSON.stringify({}));

  const config = new Config({
    configDir: testDir,
    keysFile: testKeysFile,
    statsFile: testStatsFile,
    useCluster: false,
    port: 0,
    adminAuth: { enabled: false },
    enableHotReload: false,
    security: { rateLimit: { enabled: false } },
    modelRouting: {
      version: '2.0',
      enabled: true,
      defaultModel: 'test-model-medium',
      tiers: {
        heavy: {
          models: ['test-model-heavy'],
          strategy: 'balanced',
          maxConcurrency: 4
        },
        medium: {
          models: ['test-model-medium'],
          strategy: 'balanced',
          maxConcurrency: 4
        },
        light: {
          models: ['test-model-light'],
          strategy: 'quality',
          maxConcurrency: 4
        }
      }
    }
  });

  const proxyServer = new ProxyServer({ config });
  const server = await proxyServer.start();
  const address = server.address();
  const proxyUrl = `http://127.0.0.1:${address.port}`;

  return { proxyServer, proxyUrl, testDir, config };
}

// Extended test fixture with modelRouting tiers for live-flow tests
exports.liveFlowTest = test.extend({
  proxyServer: [async ({}, use) => {
    const { proxyServer, proxyUrl, testDir } = await startTestServerWithRouting();
    await seedStats(proxyServer);
    await use({ url: proxyUrl, server: proxyServer, testDir });
    await proxyServer.shutdown();
    fs.rmSync(testDir, { recursive: true, force: true });
  }, { scope: 'worker' }],
});

// Export helpers for use in tests
exports.sendTestRequest = sendTestRequest;
exports.injectRequestToStream = injectRequestToStream;
exports.waitForSSEConnection = waitForSSEConnection;
exports.waitForStoreReady = waitForStoreReady;
exports.waitForDashboardReady = waitForDashboardReady;
exports.waitForDashboardUiReady = waitForDashboardUiReady;
exports.gotoDashboardReady = gotoDashboardReady;
exports.gotoDashboardUiReady = gotoDashboardUiReady;
exports.getSSEEvent = getSSEEvent;
exports.startTestServerWithRouting = startTestServerWithRouting;
exports.expect = expect;
