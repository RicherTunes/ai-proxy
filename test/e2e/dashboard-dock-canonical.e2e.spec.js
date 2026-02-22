const { test, expect, gotoDashboardReady } = require('./fixtures');

// ============================================================================
// M5: CANONICAL DOCK PANEL PLACEMENT
// Verifies that dock panels are rendered directly inside #drawerContent
// server-side, with no runtime relocateDockPanels() mutation.
// ============================================================================

test.describe('Canonical Dock Panels (M5)', () => {
    test.beforeEach(async ({ page }) => {
        // Abort SSE connections to keep tests fast and deterministic
        await page.route('**/events', route => route.abort());
        await page.route('**/requests/stream', route => route.abort());
    });

    test('dock tab panels exist inside drawerContent on load', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });

        const tabIds = ['tab-live', 'tab-traces', 'tab-logs', 'tab-queue', 'tab-circuit'];
        for (const id of tabIds) {
            const isInDrawer = await page.evaluate((tabId) => {
                var el = document.getElementById(tabId);
                var drawer = document.getElementById('drawerContent');
                return el && drawer && drawer.contains(el);
            }, id);
            expect(isInDrawer, `${id} should be inside #drawerContent`).toBe(true);
        }
    });

    test('no dockPanelsContainer exists in DOM', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
        const containerExists = await page.evaluate(() => !!document.getElementById('dockPanelsContainer'));
        expect(containerExists).toBe(false);
    });

    test('drawer tabs switch content on non-Requests pages', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard#overview', { waitUntil: 'domcontentloaded' });

        // Expand drawer
        await page.keyboard.press('l');
        await page.waitForTimeout(300);

        // Click a dock tab
        const tracesTab = page.locator('[data-testid="tab-traces"], .dock-tab[data-tab="traces"]');
        if (await tracesTab.isVisible()) {
            await tracesTab.click();
            await page.waitForTimeout(200);

            // Traces tab content should be visible
            const tracesVisible = await page.evaluate(() => {
                var el = document.getElementById('tab-traces');
                return el && getComputedStyle(el).display !== 'none';
            });
            expect(tracesVisible).toBe(true);
        }
    });

    test('drawer tabs work on Requests page', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard#requests', { waitUntil: 'domcontentloaded' });

        // Expand drawer
        await page.keyboard.press('l');
        await page.waitForTimeout(300);

        const liveVisible = await page.evaluate(() => {
            var el = document.getElementById('tab-live');
            return el && getComputedStyle(el).display !== 'none';
        });
        // Live tab should be the default visible tab
        expect(liveVisible).toBe(true);
    });

    test('tab-content wrapper exists inside drawerContent', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });

        const hasTabContent = await page.evaluate(() => {
            var drawer = document.getElementById('drawerContent');
            return drawer && !!drawer.querySelector('.tab-content');
        });
        expect(hasTabContent).toBe(true);
    });
});
