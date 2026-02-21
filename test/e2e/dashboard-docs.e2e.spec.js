const { test, expect, gotoDashboardReady } = require('./fixtures');

// Deterministic mock data for documentation screenshots
const MOCK_STATS = {
    keys: [
        { state: 'CLOSED', total: 50, success: 48, errors: 2, successRate: 96, latency: { avg: 162, p50: 150, p95: 200, p99: 250 }, healthScore: { total: 85 }, inFlight: 1 },
        { state: 'CLOSED', total: 30, success: 30, errors: 0, successRate: 100, latency: { avg: 120, p50: 110, p95: 150, p99: 180 }, healthScore: { total: 100 }, inFlight: 0 },
        { state: 'HALF_OPEN', total: 20, success: 15, errors: 5, successRate: 75, latency: { avg: 200, p50: 180, p95: 250, p99: 300 }, healthScore: { total: 60 }, inFlight: 2 }
    ],
    uptime: 3600,
    paused: false,
    requestsPerMinute: 12,
    successRate: 97.5,
    latency: { avg: 145, p50: 130, p95: 180, p99: 220 },
    totalRequests: 80,
    circuitBreakers: { open: 0, halfOpen: 1, closed: 2 },
    cost: { total: 0.001234, projection: { daily: { projected: 0.05 }, monthly: { current: 0.15 } } }
};

const MOCK_HISTORY = {
    points: Array.from({ length: 20 }, (_, i) => ({
        timestamp: 1700000000000 + i * 60000,
        rpm: 10 + Math.floor(i / 2),
        latency: 100 + i * 5,
        errors: i % 7 === 0 ? 1 : 0,
        successRate: 95 + (i % 5),
        inputTokens: 1000 + i * 100,
        outputTokens: 500 + i * 50
    })),
    tier: 'medium',
    tierResolution: 10,
    models: {
        'gpt-4o': { requests: 30, inputTokens: 15000, outputTokens: 8000, cost: 0.05 },
        'gpt-4o-mini': { requests: 50, inputTokens: 25000, outputTokens: 12000, cost: 0.02 }
    }
};

const MOCK_LOGS = [
    { timestamp: 1700000000000, level: 'info', message: 'Server started on port 3000' },
    { timestamp: 1700000010000, level: 'info', message: 'Connected to model provider' },
    { timestamp: 1700000020000, level: 'warn', message: 'High latency detected on key-0' },
    { timestamp: 1700000030000, level: 'info', message: 'Request completed: /v1/messages' }
];

const MOCK_TRACES = [
    {
        traceId: 'trace-001',
        path: '/v1/messages',
        model: 'gpt-4o',
        statusCode: 200,
        totalDuration: 1450,
        queueTime: 10,
        attempts: 1,
        timestamp: 1700000000000,
        keyId: 'key-0'
    },
    {
        traceId: 'trace-002',
        path: '/v1/chat/completions',
        model: 'gpt-4o-mini',
        statusCode: 200,
        totalDuration: 890,
        queueTime: 5,
        attempts: 1,
        timestamp: 1700000010000,
        keyId: 'key-1'
    }
];

const MOCK_ROUTING = {
    enabled: true,
    tiers: {
        heavy: {
            targetModel: 'gpt-4o',
            fallbackModels: ['gpt-4o-turbo'],
            strategy: 'quality',
            clientModelPolicy: 'allow'
        },
        medium: {
            targetModel: 'gpt-4o-mini',
            fallbackModels: ['gpt-4o'],
            strategy: 'balanced',
            clientModelPolicy: 'allow'
        },
        light: {
            targetModel: 'gpt-4o-mini',
            fallbackModels: [],
            strategy: 'cost',
            clientModelPolicy: 'allow'
        }
    },
    stats: {
        decisions: [
            { tier: 'heavy', source: 'Classifier', count: 15 },
            { tier: 'medium', source: 'Rule', count: 8 },
            { tier: 'light', source: 'Override', count: 5 }
        ]
    }
};

const MOCK_MODELS = {
    models: [
        { id: 'gpt-4o', name: 'GPT-4o', tier: 'heavy', price: { input: 2.5, output: 10 }, concurrency: { current: 2, max: 10 } },
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini', tier: 'light', price: { input: 0.15, output: 0.6 }, concurrency: { current: 5, max: 20 } },
        { id: 'gpt-4o-turbo', name: 'GPT-4o Turbo', tier: 'medium', price: { input: 1, output: 4 }, concurrency: { current: 3, max: 15 } }
    ]
};

async function setupDocumentationRoutes(page) {
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
        body: JSON.stringify(MOCK_STATS.cost)
    }));
    await page.route('**/logs*', route => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ logs: MOCK_LOGS })
    }));
    await page.route('**/traces*', route => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ traces: MOCK_TRACES })
    }));
    await page.route('**/events', route => route.abort());
    await page.route('**/requests/stream', route => route.abort());
    await page.route('**/latency-histogram*', route => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ buckets: [
            { range: '0-100ms', count: 30 },
            { range: '100-200ms', count: 40 },
            { range: '200-500ms', count: 20 },
            { range: '500ms+', count: 10 }
        ]})
    }));
    await page.route('**/stats/comparison*', route => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
            keys: [
                { keyId: 'key-0', successRate: 96, avgLatency: 162 },
                { keyId: 'key-1', successRate: 100, avgLatency: 120 }
            ]
        })
    }));
    await page.route('**/model-routing', route => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(MOCK_ROUTING)
    }));
    await page.route('**/models', route => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(MOCK_MODELS)
    }));
    await page.route('**/auth/status', route => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ enabled: false })
    }));
    await page.route('**/tenants', route => route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ tenants: [], enabled: false })
    }));
}

/**
 * Dashboard Documentation Screenshots
 *
 * This test suite captures screenshots for documentation purposes.
 * Screenshots are organized by category and use descriptive names.
 *
 * Usage:
 *   npx playwright test dashboard-docs.e2e.spec.js --update-snapshots
 *
 * Screenshots will be saved to:
 *   test/e2e/dashboard-docs.e2e.spec.js-snapshots/
 */
test.describe('Dashboard Documentation Screenshots', () => {

    test.beforeEach(async ({ page }) => {
        await setupDocumentationRoutes(page);
    });

    // ========== MAIN VIEWS ==========

    test.describe('Main Views', () => {
        test('docs - overview page', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(1000);
            await expect(page).toHaveScreenshot('docs/01-overview.png', { fullPage: true });
        });

        test('docs - routing page', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(500);
            await page.click('.page-nav-btn[data-page="routing"]');
            await page.waitForTimeout(1000);
            await expect(page).toHaveScreenshot('docs/02-routing.png', { fullPage: true });
        });

        test('docs - requests page', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(500);
            await page.click('.page-nav-btn[data-page="requests"]');
            await page.waitForTimeout(1000);
            await expect(page).toHaveScreenshot('docs/03-requests.png', { fullPage: true });
        });

        test('docs - system page', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(500);
            await page.click('.page-nav-btn[data-page="system"]');
            await page.waitForTimeout(1000);
            await expect(page).toHaveScreenshot('docs/04-system.png', { fullPage: true });
        });
    });

    // ========== THEME VARIATIONS ==========

    test.describe('Theme Variations', () => {
        test('docs - dark theme', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(500);
            // Ensure dark theme is active (default)
            const theme = await page.locator('html').getAttribute('data-theme');
            if (theme === 'light') {
                await page.click('[data-action="toggle-theme"]');
                await page.waitForTimeout(300);
            }
            await expect(page).toHaveScreenshot('docs/themes/01-dark-theme.png');
        });

        test('docs - light theme', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(500);
            // Toggle to light theme using the toolbar button
            await page.click('[data-action="toggle-theme"]');
            await page.waitForTimeout(300);
            await expect(page).toHaveScreenshot('docs/themes/02-light-theme.png');
        });
    });

    // ========== DENSITY MODES ==========

    test.describe('Density Modes', () => {
        test('docs - compact density', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(500);
            await page.click('.density-btn[data-density="compact"]');
            await page.waitForTimeout(300);
            await expect(page).toHaveScreenshot('docs/density/01-compact.png');
        });

        test('docs - comfortable density (default)', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(500);
            await page.click('.density-btn[data-density="comfortable"]');
            await page.waitForTimeout(300);
            await expect(page).toHaveScreenshot('docs/density/02-comfortable.png');
        });
    });

    // ========== OVERVIEW SECTIONS ==========

    test.describe('Overview Sections', () => {
        test('docs - health ribbon', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(500);
            const ribbon = page.locator('.health-ribbon');
            await expect(ribbon).toHaveScreenshot('docs/sections/01-health-ribbon.png');
        });

        test('docs - keys heatmap', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(1000);
            const heatmap = page.locator('#keysHeatmap');
            await expect(heatmap).toHaveScreenshot('docs/sections/02-keys-heatmap.png');
        });

        test('docs - cost panel', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(500);
            // Toggle cost panel if not visible
            const costPanel = page.locator('#costPanel');
            const isVisible = await costPanel.isVisible().catch(() => false);
            if (!isVisible) {
                await page.click('[data-action="toggle-cost-panel"]');
                await page.waitForTimeout(300);
            }
            await expect(costPanel).toHaveScreenshot('docs/sections/03-cost-panel.png');
        });

        test('docs - charts overview', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(1000);
            const charts = page.locator('#requestChartContainer').locator('..');
            await expect(charts).toHaveScreenshot('docs/sections/04-charts.png');
        });
    });

    // ========== LIVE STREAM PANEL ==========

    test.describe('Live Stream Panel', () => {
        test('docs - live stream collapsed', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(500);
            await page.keyboard.press('l');
            await page.waitForTimeout(300);
            const drawer = page.locator('#bottomDrawer');
            await expect(drawer).toHaveScreenshot('docs/panels/live-collapsed.png');
        });

        test('docs - live stream expanded', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(500);
            await page.keyboard.press('l');
            await page.waitForTimeout(300);
            await page.click('[data-testid="drawer-toggle"]');
            await page.waitForTimeout(300);
            const drawer = page.locator('#bottomDrawer');
            await expect(drawer).toHaveScreenshot('docs/panels/live-expanded.png');
        });

        test('docs - live tab content', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(500);
            // Open drawer
            await page.keyboard.press('l');
            await page.waitForTimeout(300);
            const drawer = page.locator('#bottomDrawer');
            // Check if drawer is expanded, if not expand it
            const isExpanded = await drawer.evaluate(el => !el.classList.contains('collapsed'));
            if (!isExpanded) {
                await page.click('[data-testid="drawer-toggle"]');
                await page.waitForTimeout(300);
            }
            const tabContent = page.locator('#tab-live');
            await expect(tabContent).toHaveScreenshot('docs/panels/live-content.png');
        });
    });

    // ========== DOCK TABS ==========

    test.describe('Dock Tabs', () => {
        test('docs - traces tab', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(500);
            await page.keyboard.press('l');
            await page.waitForTimeout(300);
            await page.click('[data-testid="drawer-toggle"]');
            await page.waitForTimeout(300);
            await page.click('[data-testid="tab-traces"]');
            await page.waitForTimeout(500);
            const tabContent = page.locator('#tab-traces');
            await expect(tabContent).toHaveScreenshot('docs/dock-tabs/01-traces.png');
        });

        test('docs - logs tab', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(500);
            await page.keyboard.press('l');
            await page.waitForTimeout(300);
            await page.click('[data-testid="drawer-toggle"]');
            await page.waitForTimeout(300);
            await page.click('[data-testid="tab-logs"]');
            await page.waitForTimeout(500);
            const tabContent = page.locator('#tab-logs');
            await expect(tabContent).toHaveScreenshot('docs/dock-tabs/02-logs.png');
        });

        test('docs - queue tab', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(500);
            await page.keyboard.press('l');
            await page.waitForTimeout(300);
            await page.click('[data-testid="drawer-toggle"]');
            await page.waitForTimeout(300);
            await page.click('[data-testid="tab-queue"]');
            await page.waitForTimeout(500);
            const tabContent = page.locator('#tab-queue');
            await expect(tabContent).toHaveScreenshot('docs/dock-tabs/03-queue.png');
        });

        test('docs - circuit tab', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(500);
            await page.keyboard.press('l');
            await page.waitForTimeout(300);
            await page.click('[data-testid="drawer-toggle"]');
            await page.waitForTimeout(300);
            await page.click('[data-testid="tab-circuit"]');
            await page.waitForTimeout(500);
            const tabContent = page.locator('#tab-circuit');
            await expect(tabContent).toHaveScreenshot('docs/dock-tabs/04-circuit.png');
        });
    });

    // ========== MODEL ROUTING ==========

    test.describe('Model Routing', () => {
        test('docs - routing tier builder', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(500);
            await page.click('.page-nav-btn[data-page="routing"]');
            await page.waitForTimeout(1000);
            const routingPanel = page.locator('#tierBuilderContainer');
            await expect(routingPanel).toHaveScreenshot('docs/routing/01-tier-builder.png');
        });

        // Note: Observability and Advanced tabs require routing to be enabled
        // These tests are skipped when routing is disabled
        test.skip('docs - routing observability', async ({ page, proxyServer }) => {
            // Requires model routing to be enabled
        });

        test.skip('docs - routing advanced', async ({ page, proxyServer }) => {
            // Requires model routing to be enabled
        });
    });

    // ========== OVERFLOW MENU ==========

    test.describe('Overflow Menu', () => {
        // Note: Overflow menu requires specific interaction timing
        test.skip('docs - overflow menu open', async ({ page, proxyServer }) => {
            // Skipped: requires specific DOM timing
        });
    });

    // ========== KEYBOARD SHORTCUTS MODAL ==========

    test.describe('Modals', () => {
        test('docs - keyboard shortcuts modal', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(500);
            await page.keyboard.press('?');
            await page.waitForTimeout(300);
            const modal = page.locator('#shortcutsModal');
            await expect(modal).toHaveScreenshot('docs/modals/keyboard-shortcuts.png');
        });
    });

    // ========== SYSTEM PAGE SECTIONS ==========

    test.describe('System Page Sections', () => {
        test('docs - error breakdown card', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(500);
            await page.click('.page-nav-btn[data-page="system"]');
            await page.waitForTimeout(1000);
            const card = page.locator('#errorBreakdownCard');
            await expect(card).toHaveScreenshot('docs/system/01-error-breakdown.png');
        });

        test('docs - retry analytics card', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(500);
            await page.click('.page-nav-btn[data-page="system"]');
            await page.waitForTimeout(1000);
            const card = page.locator('#retryAnalyticsCard');
            await expect(card).toHaveScreenshot('docs/system/02-retry-analytics.png');
        });

        test('docs - health score card', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(500);
            await page.click('.page-nav-btn[data-page="system"]');
            await page.waitForTimeout(1000);
            const card = page.locator('#healthScoreCard');
            await expect(card).toHaveScreenshot('docs/system/03-health-score.png');
        });
    });

    // ========== PROGRESSIVE DISCLOSURE (COLLAPSIBLE SECTIONS) ==========

    test.describe('Progressive Disclosure', () => {
        test('docs - advanced stats collapsed', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(500);
            await page.click('.page-nav-btn[data-page="system"]');
            await page.waitForTimeout(1000);
            const section = page.locator('#advancedStatsSection');
            await expect(section).toHaveScreenshot('docs/progressive/advanced-stats-collapsed.png');
        });

        test('docs - advanced stats expanded', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(500);
            await page.click('.page-nav-btn[data-page="system"]');
            await page.waitForTimeout(1000);
            await page.click('#advancedStatsSection .collapsible-header');
            await page.waitForTimeout(300);
            const section = page.locator('#advancedStatsSection');
            await expect(section).toHaveScreenshot('docs/progressive/advanced-stats-expanded.png');
        });

        test('docs - process health collapsed', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(500);
            await page.click('.page-nav-btn[data-page="system"]');
            await page.waitForTimeout(1000);
            const section = page.locator('#processHealthSection');
            await expect(section).toHaveScreenshot('docs/progressive/process-health-collapsed.png');
        });

        test('docs - process health expanded', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(500);
            await page.click('.page-nav-btn[data-page="system"]');
            await page.waitForTimeout(1000);
            await page.click('#processHealthSection .collapsible-header');
            await page.waitForTimeout(300);
            const section = page.locator('#processHealthSection');
            await expect(section).toHaveScreenshot('docs/progressive/process-health-expanded.png');
        });
    });

    // ========== FILTERS AND SEARCH ==========

    test.describe('Filters and Search', () => {
        test.skip('docs - status filter dropdown', async ({ page, proxyServer }) => {
            // Skipped: status filter dropdown structure differs from expected
        });

        test.skip('docs - global search', async ({ page, proxyServer }) => {
            // Skipped: global search structure differs from expected
        });
    });

    // ========== RESPONSIVE LAYOUTS ==========

    test.describe('Responsive Layouts', () => {
        test('docs - mobile view (375px)', async ({ page, proxyServer }) => {
            await page.setViewportSize({ width: 375, height: 667 });
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(1000);
            await expect(page).toHaveScreenshot('docs/responsive/mobile-375px.png', { fullPage: true });
        });

        test('docs - tablet view (768px)', async ({ page, proxyServer }) => {
            await page.setViewportSize({ width: 768, height: 1024 });
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(1000);
            await expect(page).toHaveScreenshot('docs/responsive/tablet-768px.png', { fullPage: true });
        });

        test('docs - desktop view (1920px)', async ({ page, proxyServer }) => {
            await page.setViewportSize({ width: 1920, height: 1080 });
            await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-testid="health-ribbon"]', { timeout: 10000 });
            await page.waitForTimeout(1000);
            await expect(page).toHaveScreenshot('docs/responsive/desktop-1920px.png', { fullPage: true });
        });
    });
});
