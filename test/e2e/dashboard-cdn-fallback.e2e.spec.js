/**
 * E2E: Dashboard resiliency when CDN is blocked.
 *
 * Verifies local vendor assets keep charts and tier builder functional
 * even when jsdelivr is unavailable.
 */

const { liveFlowTest: test, expect, gotoDashboardReady } = require('./fixtures');

test.describe('Dashboard CDN fallback', () => {
    test('charts and vendor globals load when CDN is blocked', async ({ page, proxyServer }) => {
        const runtimeErrors = [];
        const pageErrors = [];

        page.on('console', (msg) => {
            if (msg.type() !== 'error') return;
            const text = msg.text();
            if (/chart is not defined|sortable is not defined|d3 is not defined/i.test(text)) {
                runtimeErrors.push(text);
            }
        });
        page.on('pageerror', (err) => {
            if (/chart is not defined|sortable is not defined|d3 is not defined/i.test(String(err?.message || err))) {
                pageErrors.push(String(err.message || err));
            }
        });

        await page.route('**/cdn.jsdelivr.net/**', (route) => route.abort());
        await gotoDashboardReady(page, proxyServer.url);

        await page.waitForFunction(() => !!(window.Chart && window.d3 && window.Sortable), { timeout: 10000 });
        const loaded = await page.evaluate(() => ({
            chart: typeof window.Chart === 'function' || typeof window.Chart === 'object',
            d3: typeof window.d3 === 'object',
            sortable: typeof window.Sortable === 'function'
        }));

        expect(loaded.chart).toBe(true);
        expect(loaded.d3).toBe(true);
        expect(loaded.sortable).toBe(true);
        expect(runtimeErrors).toHaveLength(0);
        expect(pageErrors).toHaveLength(0);
    });

    test('tier builder remains usable when CDN is blocked', async ({ page, proxyServer }) => {
        const runtimeErrors = [];
        const pageErrors = [];

        page.on('console', (msg) => {
            if (msg.type() !== 'error') return;
            const text = msg.text();
            if (/sortable is not defined|failed to initialize tier builder/i.test(text)) {
                runtimeErrors.push(text);
            }
        });
        page.on('pageerror', (err) => {
            if (/sortable is not defined/i.test(String(err?.message || err))) {
                pageErrors.push(String(err.message || err));
            }
        });

        await page.route('**/cdn.jsdelivr.net/**', (route) => route.abort());
        await gotoDashboardReady(page, proxyServer.url);

        await page.locator('.page-nav-btn[data-page="routing"]').click();
        await page.waitForFunction(() => {
            const section = document.getElementById('modelSelectionSection');
            return section && !section.classList.contains('page-hidden');
        }, { timeout: 5000 });
        await page.waitForTimeout(800);

        const bankCard = page.locator('#modelsBankList .model-card').first();
        const heavyLane = page.locator('#tierLaneHeavy');
        await expect(bankCard).toBeVisible();
        await expect(heavyLane).toBeVisible();

        const sortableState = await page.evaluate(() => ({
            hasTierBuilder: !!window._tierBuilder,
            hasBankSortable: !!window._tierBuilder?.sortables?.bank,
            hasHeavySortable: !!window._tierBuilder?.sortables?.heavy,
            hasMediumSortable: !!window._tierBuilder?.sortables?.medium,
            hasLightSortable: !!window._tierBuilder?.sortables?.light,
            sortableGlobal: typeof window.Sortable === 'function'
        }));

        expect(sortableState.hasTierBuilder).toBe(true);
        expect(sortableState.hasBankSortable).toBe(true);
        expect(sortableState.hasHeavySortable).toBe(true);
        expect(sortableState.hasMediumSortable).toBe(true);
        expect(sortableState.hasLightSortable).toBe(true);
        expect(sortableState.sortableGlobal).toBe(true);
        expect(runtimeErrors).toHaveLength(0);
        expect(pageErrors).toHaveLength(0);
    });
});
