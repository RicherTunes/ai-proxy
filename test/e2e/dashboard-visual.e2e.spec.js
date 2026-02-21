const { test, expect, gotoDashboardReady } = require('./fixtures');

// Deterministic mock data for visual regression
const MOCK_STATS = {
  keys: [
    { state: 'CLOSED', total: 50, success: 48, errors: 2, successRate: 96, latency: { avg: 162, p50: 150, p95: 200, p99: 250 }, healthScore: { total: 85 }, inFlight: 1 },
    { state: 'CLOSED', total: 30, success: 30, errors: 0, successRate: 100, latency: { avg: 120, p50: 110, p95: 150, p99: 180 }, healthScore: { total: 100 }, inFlight: 0 }
  ],
  uptime: 3600,
  paused: false,
  requestsPerMinute: 12,
  successRate: 97.5,
  latency: { avg: 145, p50: 130, p95: 180, p99: 220 },
  totalRequests: 80,
  circuitBreakers: { open: 0, halfOpen: 0, closed: 2 }
};

const MOCK_HISTORY = {
  points: Array.from({ length: 20 }, (_, i) => ({
    timestamp: 1700000000000 + i * 60000,
    rpm: 10 + Math.floor(i / 2),
    latency: 100 + i * 5,
    errors: i % 7 === 0 ? 1 : 0,
    successRate: 95 + (i % 5)
  })),
  tier: 'medium',
  tierResolution: 10
};

async function setupDeterministicRoutes(page) {
    await page.route('**/stats', route => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(MOCK_STATS)
    }));
    await page.route('**/history*', route => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(MOCK_HISTORY)
    }));
    await page.route('**/stats/cost', route => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ cost: 0, projection: { daily: { projected: 0 }, monthly: { current: 0 } }, avgCostPerRequest: 0 })
    }));
    await page.route('**/logs*', route => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ logs: [] })
    }));
    await page.route('**/traces*', route => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ traces: [] })
    }));
    await page.route('**/events', route => route.abort());
    await page.route('**/requests/stream', route => route.abort());
    // Intercept other polling endpoints
    await page.route('**/stats/latency-histogram*', route => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ buckets: [] })
    }));
    await page.route('**/stats/comparison*', route => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({})
    }));
    await page.route('**/model-routing', route => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ enabled: false, tiers: {} })
    }));
    await page.route('**/model-mappings', route => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ mappings: {} })
    }));
    await page.route('**/models', route => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ models: [] })
    }));
    await page.route('**/auth/status', route => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ enabled: false })
    }));
    await page.route('**/tenants', route => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ tenants: [] })
    }));
}

async function clickDashboardControl(page, selector) {
    const control = page.locator(selector).first();
    if (await control.isVisible().catch(() => false)) {
        await control.click();
        return;
    }
    const overflow = page.locator('#overflowMenuTrigger').first();
    if (await overflow.isVisible().catch(() => false)) {
        await overflow.click();
        await page.locator(selector).first().click();
        return;
    }
    throw new Error(`Dashboard control not visible: ${selector}`);
}

test.describe('Dashboard Visual Regression', () => {
    test.beforeEach(async ({ page }) => {
        await setupDeterministicRoutes(page);
    });

    test('overview page screenshot', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard?screenshot=1', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
        await page.waitForTimeout(1000);
        await expect(page).toHaveScreenshot('overview.png', { fullPage: true });
    });

    test('routing page screenshot', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard?screenshot=1', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
        await page.waitForTimeout(500);
        await page.click('.page-nav-btn[data-page="routing"]');
        await page.waitForTimeout(1000);
        await expect(page).toHaveScreenshot('routing-page.png', { fullPage: true });
    });

    test('dark theme screenshot', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard?screenshot=1', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
        await page.waitForTimeout(500);
        // Dashboard defaults to dark theme
        const theme = await page.locator('html').getAttribute('data-theme');
        if (theme === 'light') {
            await clickDashboardControl(page, '[data-action="toggle-theme"]');
            await page.waitForTimeout(300);
        }
        await expect(page).toHaveScreenshot('dark-theme.png');
    });

    test('light theme screenshot', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard?screenshot=1', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
        await page.waitForTimeout(500);
        await clickDashboardControl(page, '[data-action="toggle-theme"]');
        await page.waitForTimeout(300);
        await expect(page).toHaveScreenshot('light-theme.png');
    });

    test('compact density screenshot', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard?screenshot=1', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
        await page.waitForTimeout(500);
        await clickDashboardControl(page, '.density-btn[data-density="compact"]');
        await page.waitForTimeout(300);
        await expect(page).toHaveScreenshot('compact-density.png');
    });

    test('traces tab screenshot', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard?screenshot=1', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
        await page.waitForTimeout(500);
        await page.keyboard.press('l');
        await page.waitForTimeout(300);
        await page.click('[data-testid="tab-traces"]');
        await page.waitForTimeout(500);
        await expect(page).toHaveScreenshot('traces-tab.png');
    });

    test('logs tab screenshot', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard?screenshot=1', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
        await page.waitForTimeout(500);
        await page.keyboard.press('l');
        await page.waitForTimeout(300);
        await page.click('[data-testid="tab-logs"]');
        await page.waitForTimeout(500);
        await expect(page).toHaveScreenshot('logs-tab.png');
    });
});
