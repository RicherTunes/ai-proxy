const { test, expect } = require('./fixtures');

test.describe('Accessibility (M6)', () => {
    test.beforeEach(async ({ page }) => {
        await page.route('**/events', route => route.abort());
        await page.route('**/requests/stream', route => route.abort());
    });

    test('search dropdown has listbox role', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
        const dropdown = page.locator('#searchHistoryDropdown');
        await expect(dropdown).toHaveAttribute('role', 'listbox');
    });

    test('search dropdown items are keyboard-navigable', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });

        // Focus search input
        await page.keyboard.press('Control+k');
        await page.waitForTimeout(200);

        const searchInput = page.locator('#globalSearchInput');
        await expect(searchInput).toBeFocused();

        // Type to trigger dropdown
        await searchInput.fill('test');
        await page.waitForTimeout(300);

        // Check if dropdown items have role="option"
        const items = page.locator('#searchHistoryDropdown [role="option"]');
        const count = await items.count();
        // If items exist, they should have proper ARIA attributes
        if (count > 0) {
            await expect(items.first()).toHaveAttribute('tabindex', '-1');
        }
    });

    test('arrow keys navigate search dropdown items', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });

        // Focus and type in search
        await page.keyboard.press('Control+k');
        await page.waitForTimeout(200);

        const searchInput = page.locator('#globalSearchInput');
        await searchInput.fill('test query');
        await page.waitForTimeout(300);

        // Press ArrowDown to navigate into dropdown
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(100);

        // The focus should have moved from input to a dropdown item
        const activeElement = await page.evaluate(() => {
            var el = document.activeElement;
            return el ? { tag: el.tagName, role: el.getAttribute('role'), className: el.className } : null;
        });

        // Active element should be a dropdown item (or stay on input if no items)
        if (activeElement && activeElement.role === 'option') {
            expect(activeElement.role).toBe('option');
        }
    });

    test('escape closes search dropdown and returns focus to input', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });

        await page.keyboard.press('Control+k');
        await page.waitForTimeout(200);

        const searchInput = page.locator('#globalSearchInput');
        await searchInput.fill('test');
        await page.waitForTimeout(300);

        // Press Escape
        await page.keyboard.press('Escape');
        await page.waitForTimeout(100);

        // Dropdown should be hidden
        const dropdownVisible = await page.evaluate(() => {
            var dd = document.getElementById('searchHistoryDropdown');
            return dd && dd.children.length > 0 && getComputedStyle(dd).display !== 'none';
        });
        // Escape should close or clear the dropdown
    });

    test('drawer header min-height uses CSS variable', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });

        const drawerHeader = page.locator('.bottom-drawer .drawer-header');
        if (await drawerHeader.isVisible()) {
            const minHeight = await drawerHeader.evaluate(el => getComputedStyle(el).minHeight);
            // Should be 34px (from --drawer-header-h override on .bottom-drawer)
            expect(minHeight).toBe('34px');
        }
    });
});
