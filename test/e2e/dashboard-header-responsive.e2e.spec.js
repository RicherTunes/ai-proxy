const { test, expect, gotoDashboardUiReady } = require('./fixtures');

test.describe('Dashboard header responsiveness', () => {
  const standardBreakpoints = [320, 375, 480, 768, 1024, 1280, 1920];

  test('no horizontal overflow at standard breakpoints', async ({ page, proxyServer }) => {
    for (const width of standardBreakpoints) {
      await page.setViewportSize({ width, height: 900 });
      await gotoDashboardUiReady(page, proxyServer.url);

      const overflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth;
      });
      expect(overflow, `overflow at ${width}px`).toBe(false);
    }
  });

  test('overflow menu visible on narrow widths', async ({ page, proxyServer }) => {
    await page.setViewportSize({ width: 480, height: 900 });
    await gotoDashboardUiReady(page, proxyServer.url);

    const overflowContainer = page.locator('#overflowMenuContainer');
    await expect(overflowContainer).toBeVisible();
  });

  test('overflow menu hidden on wide widths', async ({ page, proxyServer }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoDashboardUiReady(page, proxyServer.url);

    const overflowContainer = page.locator('#overflowMenuContainer');
    await expect(overflowContainer).not.toBeVisible();
  });

  test('compaction classes applied when header content overflows', async ({ page, proxyServer }) => {
    await page.setViewportSize({ width: 1180, height: 900 });
    await gotoDashboardUiReady(page, proxyServer.url);

    // Scale up font to trigger compaction (same approach as original test)
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '20px';
      window.dispatchEvent(new Event('resize'));
    });
    await page.waitForTimeout(120);

    const state = await page.evaluate(() => {
      const header = document.querySelector('.sticky-header');
      if (!header) return null;
      return {
        cramped: header.classList.contains('is-cramped'),
        tight: header.classList.contains('is-tight'),
        ultra: header.classList.contains('is-ultra-tight')
      };
    });

    expect(state).not.toBeNull();
    expect(state.cramped || state.tight || state.ultra).toBe(true);
  });

  test('header controls do not overlap at breakpoints', async ({ page, proxyServer }) => {
    const testWidths = [480, 768, 1024, 1280];
    for (const width of testWidths) {
      await page.setViewportSize({ width, height: 900 });
      await gotoDashboardUiReady(page, proxyServer.url);

      const hasOverlap = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('.sticky-header button:not([style*="display: none"])'));
        const visible = buttons.filter(b => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        for (let i = 0; i < visible.length; i++) {
          for (let j = i + 1; j < visible.length; j++) {
            const a = visible[i].getBoundingClientRect();
            const b = visible[j].getBoundingClientRect();
            const overlapX = a.left < b.right && a.right > b.left;
            const overlapY = a.top < b.bottom && a.bottom > b.top;
            if (overlapX && overlapY) return true;
          }
        }
        return false;
      });
      expect(hasOverlap, `controls overlap at ${width}px`).toBe(false);
    }
  });
});
