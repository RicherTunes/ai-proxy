const { test, expect, gotoDashboardReady, gotoDashboardUiReady } = require('./fixtures');

test.describe('Dashboard UI readiness helper', () => {
  test('gotoDashboardReady supports explicit UI readiness mode', async ({ page, proxyServer }) => {
    await page.route(url => url.pathname === '/stats', route => route.abort());
    await gotoDashboardReady(page, proxyServer.url, { readiness: 'ui', timeoutMs: 5000 });

    await expect(page.locator('.sticky-header')).toBeVisible();
    await expect(page.locator('#connectionDot')).toBeVisible();
  });

  test('gotoDashboardReady strict stats mode fails when /stats is unavailable', async ({ page, proxyServer }) => {
    await page.route(url => url.pathname === '/stats', route => route.abort());
    let failure = null;
    try {
      await gotoDashboardReady(page, proxyServer.url, { readiness: 'stats', timeoutMs: 2500 });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeTruthy();
    expect(String(failure.message || failure)).toContain('Dashboard content not rendered');
  });

  test('gotoDashboardReady falls back to UI bootstrap when /stats fails', async ({ page, proxyServer }) => {
    await page.route(url => url.pathname === '/stats', route => route.abort());
    await gotoDashboardReady(page, proxyServer.url);

    await expect(page.locator('.sticky-header')).toBeVisible();
    await expect(page.locator('#connectionDot')).toBeVisible();
  });

  test('loads base dashboard UI even when /stats fails', async ({ page, proxyServer }) => {
    await page.route(url => url.pathname === '/stats', route => route.abort());
    await gotoDashboardUiReady(page, proxyServer.url);

    await expect(page.locator('.sticky-header')).toBeVisible();
    await expect(page.locator('#connectionDot')).toBeVisible();
  });
});
