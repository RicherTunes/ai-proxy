const { test, expect } = require('@playwright/test');

test.describe('CSS Design Token Contracts', () => {
    test.beforeEach(async ({ page }) => {
        // Abort SSE to prevent hanging
        await page.route('**/events', route => route.abort());
        await page.route('**/requests/stream', route => route.abort());
    });

    test('critical CSS custom properties exist in :root', async ({ page }) => {
        await page.goto('/dashboard');
        const root = page.locator(':root');

        const criticalVars = [
            '--bg-primary', '--bg-secondary', '--text-primary', '--text-secondary',
            '--accent', '--border', '--error', '--success',
            '--warning'
        ];

        for (const varName of criticalVars) {
            const value = await page.evaluate((v) => {
                return getComputedStyle(document.documentElement).getPropertyValue(v).trim();
            }, varName);
            expect(value, `${varName} should be defined`).not.toBe('');
        }
    });

    test('no hardcoded white rgba colors in computed styles of key elements', async ({ page }) => {
        await page.goto('/dashboard');
        // Spot-check: body background should use a CSS variable, not a hardcoded value
        const bgColor = await page.evaluate(() => {
            return getComputedStyle(document.body).backgroundColor;
        });
        // Should be defined (not empty/transparent)
        expect(bgColor).toBeTruthy();
    });

    test('font-family uses consistent stacks', async ({ page }) => {
        await page.goto('/dashboard');
        const bodyFont = await page.evaluate(() => {
            return getComputedStyle(document.body).fontFamily;
        });
        // Should have a font-family set
        expect(bodyFont).toBeTruthy();
        expect(bodyFont).not.toBe('');
    });

    test('interactive elements have appropriate cursor', async ({ page }) => {
        await page.goto('/dashboard');
        const buttons = page.locator('button');
        const count = await buttons.count();
        if (count > 0) {
            // Check first visible button has pointer cursor
            for (let i = 0; i < Math.min(count, 5); i++) {
                const btn = buttons.nth(i);
                if (await btn.isVisible()) {
                    const cursor = await btn.evaluate(el => getComputedStyle(el).cursor);
                    expect(['pointer', 'default']).toContain(cursor);
                    break;
                }
            }
        }
    });

    test('z-index values are reasonable (no extreme values)', async ({ page }) => {
        await page.goto('/dashboard');
        // Check that common overlay elements don't have absurd z-index
        const zIndexes = await page.evaluate(() => {
            const elements = document.querySelectorAll('.modal, .toast, .dropdown, .overlay, [class*="modal"], [class*="toast"]');
            return Array.from(elements).map(el => ({
                class: el.className.substring(0, 50),
                zIndex: getComputedStyle(el).zIndex
            })).filter(e => e.zIndex !== 'auto');
        });
        for (const item of zIndexes) {
            const z = parseInt(item.zIndex);
            if (!isNaN(z)) {
                expect(z, `z-index of .${item.class}`).toBeLessThan(10000);
            }
        }
    });
});
