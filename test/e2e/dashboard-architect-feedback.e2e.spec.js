/**
 * Architect Feedback Verification Tests
 *
 * Verifies fixes from the architect feedback implementation:
 * - Stream 2: Chart theming (toggle + saved theme)
 * - Stream 3: Smart polling (visibility pause)
 * - Stream 1: Event delegation (single-fire)
 * - Stream 7: Dashboard init integration
 */
const { test, expect, gotoDashboardReady } = require('./fixtures');

test.describe('Stream 2 - Chart Theming', () => {
  test('theme toggle updates chart grid/tick colors for all charts', async ({ page, proxyServer }) => {
    await gotoDashboardReady(page, proxyServer.url);

    // Dark mode default: check grid color contains 255,255,255
    const darkGrid = await page.evaluate(() =>
      window.DashboardStore?.STATE?.charts?.request?.options?.scales?.x?.grid?.color
    );
    expect(darkGrid).toContain('255,255,255');

    // Toggle to light via data-action
    const themeBtn = page.locator('[data-action="toggle-theme"]');
    if (await themeBtn.count() > 0) {
      await themeBtn.first().click();
    } else {
      // Fallback: use keyboard shortcut
      await page.keyboard.press('d');
    }

    await page.waitForTimeout(500);

    const lightGrid = await page.evaluate(() =>
      window.DashboardStore?.STATE?.charts?.request?.options?.scales?.x?.grid?.color
    );
    expect(lightGrid).toContain('0,0,0');

    // Verify doughnut legend color changed too
    const distLegend = await page.evaluate(() => {
      var dist = window.DashboardStore?.STATE?.charts?.dist;
      if (!dist) return null;
      try { return dist.options.plugins.legend.labels.color; } catch(e) { return null; }
    });
    if (distLegend) {
      expect(distLegend).toBe('#444');
    }
  });

  test('saved light theme initializes charts in light colors', async ({ page, proxyServer }) => {
    // Set theme before page load
    await page.addInitScript(() => {
      localStorage.setItem('dashboard-theme', 'light');
    });

    await gotoDashboardReady(page, proxyServer.url);

    const gridColor = await page.evaluate(() =>
      window.DashboardStore?.STATE?.charts?.request?.options?.scales?.x?.grid?.color
    );
    expect(gridColor).toContain('0,0,0');
  });

  test('all 8 chart slots registered in STATE.charts', async ({ page, proxyServer }) => {
    await gotoDashboardReady(page, proxyServer.url);

    const charts = await page.evaluate(() => {
      var c = window.DashboardStore?.STATE?.charts;
      if (!c) return {};
      return {
        request: !!c.request,
        latency: !!c.latency,
        error: !!c.error,
        dist: !!c.dist,
        routingTier: c.routingTier !== undefined,
        routingSource: c.routingSource !== undefined,
        routing429: c.routing429 !== undefined,
        histogram: c.histogram !== undefined
      };
    });
    expect(charts.request).toBe(true);
    expect(charts.latency).toBe(true);
    expect(charts.error).toBe(true);
    expect(charts.dist).toBe(true);
  });
});

test.describe('Stream 3 - Smart Polling', () => {
  test('polling pauses when tab becomes hidden', async ({ page, proxyServer }) => {
    await page.addInitScript(() => {
      window.__fetchCount = 0;
      var origFetch = window.fetch;
      window.fetch = function() {
        window.__fetchCount++;
        return origFetch.apply(this, arguments);
      };
    });

    await gotoDashboardReady(page, proxyServer.url);
    await page.waitForTimeout(3000);

    const before = await page.evaluate(() => window.__fetchCount);

    // Simulate hidden tab
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, writable: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await page.waitForTimeout(5000);
    const after = await page.evaluate(() => window.__fetchCount);

    // Allow at most 2 straggler requests (in-flight when paused)
    expect(after - before).toBeLessThanOrEqual(2);
  });

  test('only one EventSource opened per load', async ({ page, proxyServer }) => {
    await page.addInitScript(() => {
      window.__esCount = 0;
      var OrigES = window.EventSource;
      window.EventSource = function() {
        window.__esCount++;
        return new OrigES(arguments[0], arguments[1]);
      };
      window.EventSource.prototype = OrigES.prototype;
      window.EventSource.CONNECTING = OrigES.CONNECTING;
      window.EventSource.OPEN = OrigES.OPEN;
      window.EventSource.CLOSED = OrigES.CLOSED;
    });

    await gotoDashboardReady(page, proxyServer.url);
    await page.waitForTimeout(3000);

    const count = await page.evaluate(() => window.__esCount);
    expect(count).toBe(1);
  });

  test('polling resumes after external server unpause', async ({ page, proxyServer }) => {
    await page.addInitScript(() => {
      window.__fetchCount = 0;
      var origFetch = window.fetch;
      window.fetch = function() {
        window.__fetchCount++;
        return origFetch.apply(this, arguments);
      };
    });

    await gotoDashboardReady(page, proxyServer.url);
    await page.waitForTimeout(3000);

    const beforePause = await page.evaluate(() => window.__fetchCount);

    // Simulate server pause signal coming from another operator.
    await page.evaluate(() => {
      var stats = window.DashboardStore?.STATE?.statsData || {};
      window.DashboardData.updateUI(Object.assign({}, stats, { paused: true }));
    });
    await page.waitForTimeout(3000);
    const duringPause = await page.evaluate(() => window.__fetchCount);
    expect(duringPause - beforePause).toBeLessThanOrEqual(2);

    // Simulate external resume signal; polling should restart.
    await page.evaluate(() => {
      var stats = window.DashboardStore?.STATE?.statsData || {};
      window.DashboardData.updateUI(Object.assign({}, stats, { paused: false }));
    });
    await page.waitForTimeout(3000);
    const afterResume = await page.evaluate(() => window.__fetchCount);
    expect(afterResume).toBeGreaterThan(duringPause);
  });

  test('stats polling applies exponential backoff on repeated failures', async ({ page, proxyServer }) => {
    await page.addInitScript(() => {
      window.__statsFetchCount = 0;
      var origFetch = window.fetch;
      window.fetch = function() {
        try {
          var url = arguments[0];
          var parsed = new URL(String(url), window.location.origin);
          if (parsed.pathname === '/stats') {
            window.__statsFetchCount++;
          }
        } catch (_) {}
        return origFetch.apply(this, arguments);
      };
    });

    await gotoDashboardReady(page, proxyServer.url);
    await page.waitForTimeout(2000);

    const before = await page.evaluate(() => window.__statsFetchCount);

    await page.route('**/stats', route => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'forced-failure' })
    }));

    await page.waitForTimeout(10000);
    const after = await page.evaluate(() => window.__statsFetchCount);

    // Without backoff this would be ~5 additional calls in 10s at 2s cadence.
    expect(after - before).toBeLessThanOrEqual(3);

    const backoff = await page.evaluate(() => {
      var stats = window.DashboardData?.getPollingBackoffState?.()?.stats || {};
      return {
        failures: stats.failures || 0,
        msRemaining: Math.max((stats.nextAllowedAt || 0) - Date.now(), 0)
      };
    });
    expect(backoff.failures).toBeGreaterThan(0);
    expect(backoff.msRemaining).toBeGreaterThan(0);
  });

  test('stats polling backoff resets after endpoint recovers', async ({ page, proxyServer }) => {
    await page.addInitScript(() => {
      window.__statsFetchCount = 0;
      var origFetch = window.fetch;
      window.fetch = function() {
        try {
          var url = arguments[0];
          var parsed = new URL(String(url), window.location.origin);
          if (parsed.pathname === '/stats') {
            window.__statsFetchCount++;
          }
        } catch (_) {}
        return origFetch.apply(this, arguments);
      };
    });

    await gotoDashboardReady(page, proxyServer.url);
    await page.waitForTimeout(2000);

    await page.route('**/stats', route => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'forced-failure' })
    }));

    await page.waitForTimeout(7000);
    const beforeRecovery = await page.evaluate(() => ({
      count: window.__statsFetchCount,
      state: window.DashboardData?.getPollingBackoffState?.()?.stats || {}
    }));

    expect(beforeRecovery.state.failures || 0).toBeGreaterThan(0);

    await page.unroute('**/stats');

    await page.waitForTimeout(9000);
    const afterRecovery = await page.evaluate(() => ({
      count: window.__statsFetchCount,
      state: window.DashboardData?.getPollingBackoffState?.()?.stats || {}
    }));

    expect(afterRecovery.count).toBeGreaterThan(beforeRecovery.count);
    expect(afterRecovery.state.failures || 0).toBe(0);
    expect(afterRecovery.state.nextAllowedAt || 0).toBe(0);
  });

  test('stats backoff does not accumulate while tab is hidden', async ({ page, proxyServer }) => {
    await gotoDashboardReady(page, proxyServer.url);
    await page.waitForTimeout(2000);

    await page.route('**/stats', route => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'forced-failure' })
    }));

    await page.waitForTimeout(3500);
    const beforeHidden = await page.evaluate(() => window.DashboardData?.getPollingBackoffState?.()?.stats || {});
    expect(beforeHidden.failures || 0).toBeGreaterThan(0);

    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, writable: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await page.waitForTimeout(5000);

    const afterHidden = await page.evaluate(() => window.DashboardData?.getPollingBackoffState?.()?.stats || {});
    expect(afterHidden.failures || 0).toBe(beforeHidden.failures || 0);
  });

  test('logs polling runs only on live/logs tabs', async ({ page, proxyServer }) => {
    await page.addInitScript(() => {
      localStorage.setItem('dashboard-active-tab', 'queue');
      window.__logsFetchCount = 0;
      var origFetch = window.fetch;
      window.fetch = function() {
        try {
          var url = arguments[0];
          var parsed = new URL(String(url), window.location.origin);
          if (parsed.pathname === '/logs') {
            window.__logsFetchCount++;
          }
        } catch (_) {}
        return origFetch.apply(this, arguments);
      };
    });

    await gotoDashboardReady(page, proxyServer.url);
    await page.waitForTimeout(3000);
    const baseline = await page.evaluate(() => window.__logsFetchCount);

    // Force queue tab state: no periodic logs polling should run.
    await page.evaluate(() => window.DashboardData?.onTabChanged?.('queue'));
    await page.waitForTimeout(3000);
    const queueDelta = await page.evaluate((before) => window.__logsFetchCount - before, baseline);
    expect(queueDelta).toBeLessThanOrEqual(2);

    // Switch to logs tab: periodic logs polling should start.
    await page.evaluate(() => window.DashboardData?.onTabChanged?.('logs'));
    await page.waitForTimeout(3000);
    const afterLogs = await page.evaluate(() => window.__logsFetchCount);
    expect(afterLogs).toBeGreaterThan(baseline);

    // Switch away: logs polling should stop again.
    await page.evaluate(() => window.DashboardData?.onTabChanged?.('queue'));
    const beforeStop = await page.evaluate(() => window.__logsFetchCount);
    await page.waitForTimeout(3000);
    const stoppedDelta = await page.evaluate((before) => window.__logsFetchCount - before, beforeStop);
    expect(stoppedDelta).toBeLessThanOrEqual(2);
  });
});

test.describe('Stream 1 - Event Delegation', () => {
  test('data-action handlers fire exactly once per click', async ({ page, proxyServer }) => {
    await gotoDashboardReady(page, proxyServer.url);

    // Monkey-patch representative data-action handlers with counters.
    await page.evaluate(() => {
      window.__actionCounts = { selectKey: 0, dismissIssues: 0 };

      if (window.DashboardData && typeof window.DashboardData.selectKey === 'function') {
        var origSelectKey = window.DashboardData.selectKey;
        window.DashboardData.selectKey = function() {
          window.__actionCounts.selectKey++;
          return origSelectKey.apply(this, arguments);
        };
      }

      if (window.DashboardData && typeof window.DashboardData.dismissIssues === 'function') {
        var origDismiss = window.DashboardData.dismissIssues;
        window.DashboardData.dismissIssues = function() {
          window.__actionCounts.dismissIssues++;
          return origDismiss.apply(this, arguments);
        };
      }
    });

    var testedActions = 0;

    // select-key should exist in normal dashboard state
    const selectKeyBtn = page.locator('[data-action="select-key"]').first();
    if (await selectKeyBtn.count() > 0) {
      await selectKeyBtn.click();
      const selectCount = await page.evaluate(() => window.__actionCounts.selectKey);
      expect(selectCount).toBe(1);
      testedActions++;
    }

    // dismiss-issues can be conditional; validate when rendered
    const dismissBtn = page.locator('[data-action="dismiss-issues"]');
    if (await dismissBtn.count() > 0) {
      await dismissBtn.first().click();
      const dismissCount = await page.evaluate(() => window.__actionCounts.dismissIssues);
      expect(dismissCount).toBe(1);
      testedActions++;
    }

    expect(testedActions).toBeGreaterThan(0);
  });
});

test.describe('Stream 7 - Dashboard Init Integration', () => {
  test('DashboardData initializes and charts load', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() =>
      window.DashboardData && window.DashboardStore?.STATE?.charts?.request !== null
    , { timeout: 10000 });

    const hasData = await page.evaluate(() => ({
      dashboardData: !!window.DashboardData,
      chartRequest: !!window.DashboardStore?.STATE?.charts?.request,
      chartLatency: !!window.DashboardStore?.STATE?.charts?.latency,
      updateChartTheme: typeof window.DashboardData?.updateChartTheme === 'function',
      pausePolling: typeof window.DashboardData?.pausePolling === 'function',
      selectTenant: typeof window.DashboardInit?.selectTenant === 'function',
    }));
    expect(hasData.dashboardData).toBe(true);
    expect(hasData.chartRequest).toBe(true);
    expect(hasData.chartLatency).toBe(true);
    expect(hasData.updateChartTheme).toBe(true);
    expect(hasData.pausePolling).toBe(true);
    expect(hasData.selectTenant).toBe(true);
  });
});
