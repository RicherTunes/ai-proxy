/**
 * E2E Test: Dashboard Vendor Script Loading
 *
 * Verifies that vendor scripts (Chart.js, D3, SortableJS) load from
 * local /dashboard/vendor/ files. No CDN dependencies should exist.
 */

const { test, expect } = require('./fixtures');

test.describe('Dashboard Vendor Scripts', () => {

    test('should load all vendor scripts from local files', async ({ page, proxyServer }) => {
        // Set up request listener BEFORE navigation to capture all requests
        const vendorRequests = [];
        page.on('request', request => {
            if (request.url().includes('/dashboard/vendor/')) {
                vendorRequests.push(request.url());
            }
        });

        // Navigate to dashboard
        await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });

        // Wait for vendor libraries to be globally available (scripts loaded and executed)
        await page.waitForFunction(() => !!(window.Chart && window.d3 && window.Sortable), { timeout: 10000 });

        // Verify three vendor script URLs were requested
        const hasChartJs = vendorRequests.some(url => url.includes('chart.js.min.js'));
        const hasD3 = vendorRequests.some(url => url.includes('d3.min.js'));
        const hasSortable = vendorRequests.some(url => url.includes('sortable.min.js'));

        expect(hasChartJs).toBe(true);
        expect(hasD3).toBe(true);
        expect(hasSortable).toBe(true);

        // Verify libraries are globally available
        const allLoaded = await page.evaluate(() => !!(window.Chart && window.d3 && window.Sortable));
        expect(allLoaded).toBe(true);
    });

    test('should not load any scripts from CDN', async ({ page, proxyServer }) => {
        // Set up request listener BEFORE navigation
        const cdnRequests = [];
        page.on('request', request => {
            const url = request.url();
            if (url.includes('cdn.jsdelivr.net') || url.includes('cdnjs.cloudflare.com') || url.includes('unpkg.com')) {
                cdnRequests.push(url);
            }
        });

        // Navigate to dashboard and wait for scripts to load
        await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !!(window.Chart && window.d3 && window.Sortable), { timeout: 10000 });

        // Verify zero requests to any CDN
        expect(cdnRequests).toHaveLength(0);
    });

    test('should not show fallback banner', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });

        // Fallback banner should not be visible (dead code removed from template)
        const banner = page.locator('#fallbackBanner');
        const count = await banner.count();
        if (count > 0) {
            // If element exists in DOM, it must not be visible
            await expect(banner).not.toBeVisible();
        }
        // If element doesn't exist (count === 0), test passes - banner fully removed
    });

    test('should render charts after vendor scripts load', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });

        // Wait for vendor scripts to be available
        await page.waitForFunction(() => !!(window.Chart && window.d3 && window.Sortable), { timeout: 10000 });

        // Chart.js loaded and initialized - requestChart canvas should be visible
        const requestChart = page.locator('#requestChart');
        await expect(requestChart).toBeVisible();

        // D3 loaded - liveFlowCanvas element exists in DOM (inside routing tab, may be hidden by tab state)
        const liveFlowCanvas = page.locator('#liveFlowCanvas');
        await expect(liveFlowCanvas).toHaveCount(1);

        // Verify D3 is actually available and functional
        const d3Available = await page.evaluate(() => typeof window.d3 === 'object' && typeof window.d3.select === 'function');
        expect(d3Available).toBe(true);
    });
});
