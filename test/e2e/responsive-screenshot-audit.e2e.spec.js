'use strict';
const { test, expect } = require('./fixtures');
const path = require('path');
const fs = require('fs');

/**
 * Responsive Screenshot Audit — Full Dashboard
 *
 * Captures every page/tab combination at key viewport breakpoints.
 * Screenshots land in test/e2e/responsive-audit-screenshots/
 *
 * Run:  npx playwright test test/e2e/responsive-screenshot-audit.e2e.spec.js --project=chromium
 */

const MOCK_STATS = {
  keys: [
    { name: 'key-1', state: 'CLOSED', total: 120, success: 117, errors: 3, successRate: 97.5, latency: { avg: 8578, p50: 7200, p95: 12000, p99: 27637 }, healthScore: { total: 72 }, inFlight: 1 },
    { name: 'key-2', state: 'HALF_OPEN', total: 80, success: 78, errors: 2, successRate: 97.5, latency: { avg: 3200, p50: 2800, p95: 5000, p99: 6200 }, healthScore: { total: 85 }, inFlight: 0 },
    { name: 'key-3', state: 'CLOSED', total: 60, success: 60, errors: 0, successRate: 100, latency: { avg: 1800, p50: 1500, p95: 3000, p99: 4000 }, healthScore: { total: 98 }, inFlight: 2 },
  ],
  uptime: 7200,
  paused: false,
  requestsPerMinute: 3,
  successRate: 98.3,
  latency: { avg: 8578, p50: 6100, p95: 11000, p99: 27637 },
  totalRequests: 260,
  circuitBreakers: { open: 0, halfOpen: 1, closed: 2 },
  pool: { active: 3, idle: 1, size: 10 },
  queue: { depth: 0, maxDepth: 50 },
  activeKeys: 20,
};

const MOCK_HISTORY = {
  points: Array.from({ length: 30 }, (_, i) => ({
    timestamp: 1700000000000 + i * 60000,
    rpm: 2 + (i % 6),
    latency: 3000 + (i * 200),
    errors: i % 11 === 0 ? 1 : 0,
    successRate: 95 + (i % 5),
  })),
  tier: 'medium',
  tierResolution: 10,
};

const MOCK_MODEL_ROUTING = {
  enabled: true,
  tiers: {
    light: { models: ['claude-haiku-4-5-20251001'], maxTokens: 1024 },
    medium: { models: ['claude-sonnet-4-6-20250514'], maxTokens: 4096 },
    heavy: { models: ['claude-opus-4-6-20250514'], maxTokens: 8192 },
  },
};

async function setupRoutes(page) {
  await page.route('**/stats', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_STATS) }));
  await page.route('**/history*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_HISTORY) }));
  await page.route('**/stats/cost', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ cost: 1.23, projection: { daily: { projected: 2.50 }, monthly: { current: 18.75 } }, avgCostPerRequest: 0.0047 }) }));
  await page.route('**/logs*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ logs: [
    { timestamp: Date.now() - 5000, level: 'INFO', message: 'Request routed to key-1 (claude-sonnet-4-6)' },
    { timestamp: Date.now() - 3000, level: 'WARN', message: 'Key key-2 circuit half-open, probing' },
    { timestamp: Date.now() - 1000, level: 'INFO', message: 'Request completed in 3200ms' },
  ] }) }));
  await page.route('**/traces*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ traces: [
    { traceId: 'abc-123', timestamp: Date.now() - 10000, model: 'claude-sonnet-4-6', latency: 3200, status: 200, keyIndex: 0 },
    { traceId: 'def-456', timestamp: Date.now() - 5000, model: 'claude-haiku-4-5', latency: 800, status: 200, keyIndex: 2 },
  ] }) }));
  await page.route('**/events', route => route.abort());
  await page.route('**/requests/stream', route => route.abort());
  await page.route('**/stats/latency-histogram*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ buckets: [
    { range: '0-500ms', count: 5 }, { range: '500-1000ms', count: 12 },
    { range: '1000-2000ms', count: 25 }, { range: '2000-5000ms', count: 18 },
    { range: '5000-10000ms', count: 8 }, { range: '10000ms+', count: 3 },
  ] }) }));
  await page.route('**/stats/comparison*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    keys: [
      { name: 'key-1', score: 72, latency: 8578, successRate: 97.5 },
      { name: 'key-2', score: 85, latency: 3200, successRate: 97.5 },
      { name: 'key-3', score: 98, latency: 1800, successRate: 100 },
    ],
  }) }));
  await page.route('**/model-routing', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_MODEL_ROUTING) }));
  await page.route('**/model-mappings', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ mappings: {} }) }));
  await page.route('**/models', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: ['claude-sonnet-4-6-20250514', 'claude-haiku-4-5-20251001', 'claude-opus-4-6-20250514'] }) }));
  await page.route('**/auth/status', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: false }) }));
  await page.route('**/tenants', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tenants: [] }) }));
}

// 7 viewports covering every major responsive breakpoint
const VIEWPORTS = [
  { width: 360,  height: 900,  label: '360' },
  { width: 480,  height: 900,  label: '480' },
  { width: 680,  height: 900,  label: '680' },
  { width: 768,  height: 1000, label: '768' },
  { width: 1024, height: 1000, label: '1024' },
  { width: 1280, height: 1000, label: '1280' },
  { width: 1600, height: 1080, label: '1600' },
];

/** Click a nav button — at narrow viewports the page-nav scrolls horizontally
 *  and the sticky header can obscure it, so we use JS dispatch as fallback. */
async function clickNav(page, selector) {
  const el = page.locator(selector).first();
  try {
    await el.click({ timeout: 3000 });
  } catch {
    // Fallback: dispatch click via JS (bypasses obscured-element check)
    await el.dispatchEvent('click');
  }
}

// All page/tab combinations to capture
const PAGES = [
  {
    name: 'overview',
    nav: async (page) => {
      await clickNav(page, '.page-nav-btn[data-page="overview"]');
      await page.waitForTimeout(600);
    },
  },
  {
    name: 'routing',
    nav: async (page) => {
      await clickNav(page, '.page-nav-btn[data-page="routing"]');
      await page.waitForTimeout(600);
    },
  },
  {
    name: 'requests-table',
    nav: async (page) => {
      await clickNav(page, '.page-nav-btn[data-page="requests"]');
      await page.waitForTimeout(400);
      const tableTab = page.locator('.sub-tab[data-tab="table"]');
      if (await tableTab.isVisible().catch(() => false)) {
        try { await tableTab.click({ timeout: 2000 }); } catch { await tableTab.dispatchEvent('click'); }
        await page.waitForTimeout(400);
      }
    },
  },
  {
    name: 'requests-live',
    nav: async (page) => {
      await clickNav(page, '.page-nav-btn[data-page="requests"]');
      await page.waitForTimeout(400);
      const liveTab = page.locator('.sub-tab[data-tab="live"]');
      if (await liveTab.isVisible().catch(() => false)) {
        try { await liveTab.click({ timeout: 2000 }); } catch { await liveTab.dispatchEvent('click'); }
        await page.waitForTimeout(400);
      }
    },
  },
  {
    name: 'requests-traces',
    nav: async (page) => {
      await clickNav(page, '.page-nav-btn[data-page="requests"]');
      await page.waitForTimeout(400);
      const tracesTab = page.locator('.sub-tab[data-tab="traces"]');
      if (await tracesTab.isVisible().catch(() => false)) {
        try { await tracesTab.click({ timeout: 2000 }); } catch { await tracesTab.dispatchEvent('click'); }
        await page.waitForTimeout(400);
      }
    },
  },
  {
    name: 'diagnostics',
    nav: async (page) => {
      await clickNav(page, '.page-nav-btn[data-page="system"]');
      await page.waitForTimeout(600);
    },
  },
];

const SCREENSHOT_DIR = path.join(__dirname, 'responsive-audit-screenshots');

test.describe('Responsive Screenshot Audit — Full Dashboard', () => {
  test.beforeAll(() => {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  test.beforeEach(async ({ page }) => {
    await setupRoutes(page);
  });

  for (const vp of VIEWPORTS) {
    for (const pg of PAGES) {
      test(`${pg.name} @ ${vp.label}px (${vp.width}x${vp.height})`, async ({ page, proxyServer }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(proxyServer.url + '/dashboard?screenshot=1', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 15000 });
        await page.waitForTimeout(800);

        // Navigate to target page/tab
        await pg.nav(page);

        await page.screenshot({
          path: path.join(SCREENSHOT_DIR, `${vp.label}-${pg.name}.png`),
          fullPage: true,
        });
      });
    }
  }
});
