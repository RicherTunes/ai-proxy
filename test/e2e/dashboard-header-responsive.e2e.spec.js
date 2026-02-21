const { test, expect, gotoDashboardUiReady } = require('./fixtures');

test.describe('Dashboard header responsiveness', () => {
  test('header compacts under UI scaling and avoids horizontal overflow', async ({ page, proxyServer }) => {
    await page.setViewportSize({ width: 1180, height: 900 });
    await gotoDashboardUiReady(page, proxyServer.url);

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
        ultra: header.classList.contains('is-ultra-tight'),
        hasOverflow: header.scrollWidth > (header.clientWidth + 2)
      };
    });

    expect(state).not.toBeNull();
    expect(state.cramped || state.tight || state.ultra).toBe(true);
    expect(state.hasOverflow).toBe(false);
  });
});
