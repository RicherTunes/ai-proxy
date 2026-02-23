const { test, expect } = require('./fixtures');

test.describe('Inspector Dock Mode (M3)', () => {
    test.beforeEach(async ({ page }) => {
        // Prevent SSE connections from interfering with UI-only tests
        await page.route('**/events', route => route.abort());
        await page.route('**/requests/stream', route => route.abort());
    });

    test('side panel docks without backdrop on desktop viewport', async ({ page, proxyServer }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(proxyServer.url + '/dashboard?debug=1#requests/live', { waitUntil: 'domcontentloaded' });

        // Inject a test request directly into STATE (debug mode)
        await page.evaluate(() => {
            var STATE = window.DashboardStore?.STATE;
            if (!STATE) return;
            STATE.requestsHistory.push({
                requestId: 'dock-test-1',
                timestamp: Date.now(),
                keyIndex: 0,
                path: '/v1/messages',
                originalModel: 'claude-sonnet-4-20250514',
                mappedModel: 'claude-sonnet-4-20250514',
                status: 'completed',
                error: null,
                latency: 100
            });
            if (window.DashboardSSE && window.DashboardSSE.scheduleVirtualRender) {
                window.DashboardSSE.scheduleVirtualRender();
            }
        });
        await page.waitForTimeout(500);

        // Open side panel
        await page.evaluate(() => {
            if (window.openSidePanel) window.openSidePanel('dock-test-1');
        });
        await page.waitForTimeout(300);

        // Panel should be open
        await expect(page.locator('#sidePanel')).toHaveClass(/open/);

        // Backdrop should NOT be visible on desktop (display:none via CSS)
        const backdropVisible = await page.evaluate(() => {
            var bd = document.getElementById('sidePanelBackdrop');
            return bd && getComputedStyle(bd).display !== 'none';
        });
        expect(backdropVisible).toBe(false);
    });

    test('side panel clears header on desktop (top equals --header-h)', async ({ page, proxyServer }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(proxyServer.url + '/dashboard?debug=1#requests/live', { waitUntil: 'domcontentloaded' });

        // Open panel
        await page.evaluate(() => {
            var STATE = window.DashboardStore?.STATE;
            if (!STATE) return;
            STATE.requestsHistory.push({
                requestId: 'dock-top-1',
                timestamp: Date.now(),
                keyIndex: 0,
                path: '/v1/messages',
                originalModel: 'test',
                mappedModel: 'test',
                status: 'completed',
                error: null,
                latency: 50
            });
            if (window.openSidePanel) window.openSidePanel('dock-top-1');
        });
        await page.waitForTimeout(300);

        // On desktop, side panel top should match --header-h (44px default)
        const panelTop = await page.evaluate(() => {
            var panel = document.getElementById('sidePanel');
            return panel ? getComputedStyle(panel).top : null;
        });
        expect(panelTop).toBe('44px');
    });

    test('--dock-right updates when inspector opens on desktop', async ({ page, proxyServer }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(proxyServer.url + '/dashboard?debug=1#requests/live', { waitUntil: 'domcontentloaded' });

        // Before opening: --dock-right should be 0
        const beforeRight = await page.evaluate(() =>
            parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dock-right'))
        );
        expect(beforeRight).toBe(0);

        // Open panel
        await page.evaluate(() => {
            var STATE = window.DashboardStore?.STATE;
            if (!STATE) return;
            STATE.requestsHistory.push({
                requestId: 'dock-test-2',
                timestamp: Date.now(),
                keyIndex: 0,
                path: '/v1/messages',
                originalModel: 'test',
                mappedModel: 'test',
                status: 'completed',
                error: null,
                latency: 50
            });
            if (window.openSidePanel) window.openSidePanel('dock-test-2');
        });
        await page.waitForTimeout(500);

        // --dock-right should now be > 0
        const afterRight = await page.evaluate(() =>
            parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dock-right'))
        );
        expect(afterRight).toBeGreaterThan(0);
    });

    test('clicking different row updates inspector content without closing', async ({ page, proxyServer }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(proxyServer.url + '/dashboard?debug=1#requests/live', { waitUntil: 'domcontentloaded' });

        // Inject two requests
        await page.evaluate(() => {
            var STATE = window.DashboardStore?.STATE;
            if (!STATE) return;
            ['row-a', 'row-b'].forEach(function(id) {
                STATE.requestsHistory.push({
                    requestId: id,
                    timestamp: Date.now(),
                    keyIndex: 0,
                    path: '/v1/messages',
                    originalModel: 'claude-sonnet-4-20250514',
                    mappedModel: 'claude-sonnet-4-20250514',
                    status: 'completed',
                    error: null,
                    latency: 100
                });
            });
            if (window.DashboardSSE && window.DashboardSSE.scheduleVirtualRender) {
                window.DashboardSSE.scheduleVirtualRender();
            }
        });
        await page.waitForTimeout(500);

        // Open inspector with first request
        await page.evaluate(() => { if (window.openSidePanel) window.openSidePanel('row-a'); });
        await page.waitForTimeout(300);
        await expect(page.locator('#sidePanel')).toHaveClass(/open/);

        // Now open with second request -- should update content, not close
        await page.evaluate(() => { if (window.openSidePanel) window.openSidePanel('row-b'); });
        await page.waitForTimeout(300);
        await expect(page.locator('#sidePanel')).toHaveClass(/open/);

        // Verify the selected request changed to row-b
        const selectedId = await page.evaluate(() => {
            var state = window.__DASHBOARD_STORE__ && window.__DASHBOARD_STORE__.getState();
            return state && state.selectedRequestId;
        });
        expect(selectedId).toBe('row-b');
    });

    test('bottom drawer respects --dock-right on desktop', async ({ page, proxyServer }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(proxyServer.url + '/dashboard?debug=1#requests/live', { waitUntil: 'domcontentloaded' });

        // Get initial drawer right
        const beforeRight = await page.evaluate(() => {
            var drawer = document.getElementById('bottomDrawer');
            return drawer ? getComputedStyle(drawer).right : null;
        });

        // Open side panel
        await page.evaluate(() => {
            var STATE = window.DashboardStore?.STATE;
            if (!STATE) return;
            STATE.requestsHistory.push({
                requestId: 'drawer-test',
                timestamp: Date.now(),
                keyIndex: 0,
                path: '/v1/messages',
                originalModel: 'test',
                mappedModel: 'test',
                status: 'completed',
                error: null,
                latency: 50
            });
            if (window.openSidePanel) window.openSidePanel('drawer-test');
        });
        await page.waitForTimeout(500);

        // After panel opens, drawer right should reflect --dock-right
        const afterRight = await page.evaluate(() => {
            var drawer = document.getElementById('bottomDrawer');
            return drawer ? parseInt(getComputedStyle(drawer).right) : 0;
        });
        expect(afterRight).toBeGreaterThan(0);
    });

    test('side panel uses overlay with backdrop on mobile viewport', async ({ page, proxyServer }) => {
        await page.setViewportSize({ width: 375, height: 667 });
        await page.goto(proxyServer.url + '/dashboard?debug=1#requests/live', { waitUntil: 'domcontentloaded' });

        await page.evaluate(() => {
            var STATE = window.DashboardStore?.STATE;
            if (!STATE) return;
            STATE.requestsHistory.push({
                requestId: 'mobile-test',
                timestamp: Date.now(),
                keyIndex: 0,
                path: '/v1/messages',
                originalModel: 'test',
                mappedModel: 'test',
                status: 'completed',
                error: null,
                latency: 50
            });
            if (window.openSidePanel) window.openSidePanel('mobile-test');
        });
        await page.waitForTimeout(300);

        // On mobile, backdrop should be visible (display is NOT none)
        const backdropDisplay = await page.evaluate(() => {
            var bd = document.getElementById('sidePanelBackdrop');
            return bd ? getComputedStyle(bd).display : 'none';
        });
        expect(backdropDisplay).not.toBe('none');
    });

    test('--dock-right remains 0 on mobile overlay inspector', async ({ page, proxyServer }) => {
        await page.setViewportSize({ width: 375, height: 667 });
        await page.goto(proxyServer.url + '/dashboard?debug=1#requests/live', { waitUntil: 'domcontentloaded' });

        await page.evaluate(() => {
            var STATE = window.DashboardStore?.STATE;
            if (!STATE) return;
            STATE.requestsHistory.push({
                requestId: 'mobile-dock-right-test',
                timestamp: Date.now(),
                keyIndex: 0,
                path: '/v1/messages',
                originalModel: 'claude-sonnet-4-20250514',
                mappedModel: 'claude-sonnet-4-20250514',
                status: 'completed',
                error: null,
                latency: 123
            });
            if (window.openSidePanel) window.openSidePanel('mobile-dock-right-test');
        });
        await page.waitForTimeout(500);

        const rightInset = await page.evaluate(() =>
            parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dock-right'))
        );
        expect(rightInset).toBe(0);
    });

    test('side panel top is 0 on mobile (full overlay)', async ({ page, proxyServer }) => {
        await page.setViewportSize({ width: 375, height: 667 });
        await page.goto(proxyServer.url + '/dashboard?debug=1#requests/live', { waitUntil: 'domcontentloaded' });

        await page.evaluate(() => {
            var STATE = window.DashboardStore?.STATE;
            if (!STATE) return;
            STATE.requestsHistory.push({
                requestId: 'mobile-top-test',
                timestamp: Date.now(),
                keyIndex: 0,
                path: '/v1/messages',
                originalModel: 'test',
                mappedModel: 'test',
                status: 'completed',
                error: null,
                latency: 50
            });
            if (window.openSidePanel) window.openSidePanel('mobile-top-test');
        });
        await page.waitForTimeout(300);

        // On mobile, panel should stay at top: 0 (full height overlay)
        const panelTop = await page.evaluate(() => {
            var panel = document.getElementById('sidePanel');
            return panel ? getComputedStyle(panel).top : null;
        });
        expect(panelTop).toBe('0px');
    });
});
