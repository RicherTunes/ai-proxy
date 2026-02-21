const { test, expect, waitForStoreReady } = require('./fixtures');

test.describe('Dashboard hash bootstrap', () => {
  test('boots directly to requests table from #requests/table', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard?debug=1#requests/table', { waitUntil: 'domcontentloaded' });
    await waitForStoreReady(page);

    await page.waitForFunction(() => {
      return window.DashboardStore?.STATE?.activePage === 'requests' &&
        localStorage.getItem('dashboard-request-tab') === 'table';
    });

    const snapshot = await page.evaluate(() => ({
      hash: window.location.hash,
      activePage: window.DashboardStore?.STATE?.activePage,
      requestTab: localStorage.getItem('dashboard-request-tab'),
      tableActive: !!document.querySelector('#requestsSubTabs .sub-tab.active[data-tab="table"]')
    }));

    expect(snapshot.hash).toBe('#requests/table');
    expect(snapshot.activePage).toBe('requests');
    expect(snapshot.requestTab).toBe('table');
    expect(snapshot.tableActive).toBe(true);
  });

  test('boots directly to routing advanced from #routing/advanced', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard?debug=1#routing/advanced', { waitUntil: 'domcontentloaded' });
    await waitForStoreReady(page);

    await page.waitForFunction(() => {
      return window.DashboardStore?.STATE?.activePage === 'routing' &&
        localStorage.getItem('dashboard-routing-tab') === 'advanced';
    });

    const snapshot = await page.evaluate(() => ({
      hash: window.location.hash,
      activePage: window.DashboardStore?.STATE?.activePage,
      routingTab: localStorage.getItem('dashboard-routing-tab'),
      advancedActive: !!document.querySelector('.routing-tab-panel.active[data-routing-panel="advanced"]')
    }));

    expect(snapshot.hash).toBe('#routing/advanced');
    expect(snapshot.activePage).toBe('routing');
    expect(snapshot.routingTab).toBe('advanced');
    expect(snapshot.advancedActive).toBe(true);
  });
});
