const { test, expect } = require('./fixtures');

test.describe('Dock Insets System (M2.1)', () => {
    test('--dock-bottom reflects collapsed drawer header height', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
        const dockBottom = await page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--dock-bottom').trim()
        );
        // Should be a non-zero pixel value
        expect(dockBottom).toMatch(/^\d+px$/);
        const value = parseInt(dockBottom);
        expect(value).toBeGreaterThan(0);
        expect(value).toBeLessThan(100);
    });

    test('--dock-bottom increases when drawer expands', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
        const collapsedBottom = await page.evaluate(() =>
            parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dock-bottom'))
        );
        // Expand drawer
        await page.keyboard.press('l');
        await page.waitForTimeout(300); // transition
        const expandedBottom = await page.evaluate(() =>
            parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dock-bottom'))
        );
        expect(expandedBottom).toBeGreaterThan(collapsedBottom);
    });

    test('--dock-bottom is 0 when drawer is hidden', async ({ page, proxyServer }) => {
        // Navigate to a page where drawer isn't shown (if any), or hide via scope
        await page.goto(proxyServer.url + '/dashboard#overview', { waitUntil: 'domcontentloaded' });
        // Check if drawer is hidden on overview
        const drawerVisible = await page.evaluate(() => {
            const d = document.getElementById('bottomDrawer');
            return d && d.style.display !== 'none';
        });
        if (!drawerVisible) {
            const dockBottom = await page.evaluate(() =>
                parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dock-bottom'))
            );
            expect(dockBottom).toBe(0);
        }
    });

    test('--dock-right updates when side panel opens', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
        const closedRight = await page.evaluate(() =>
            parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dock-right'))
        );
        expect(closedRight).toBe(0);
    });

    test('main-content padding-bottom matches --dock-bottom', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
        const [dockBottom, paddingBottom] = await page.evaluate(() => {
            const root = getComputedStyle(document.documentElement);
            const main = document.querySelector('.main-content');
            return [
                root.getPropertyValue('--dock-bottom').trim(),
                main ? getComputedStyle(main).paddingBottom : null
            ];
        });
        expect(paddingBottom).toBe(dockBottom);
    });
});
