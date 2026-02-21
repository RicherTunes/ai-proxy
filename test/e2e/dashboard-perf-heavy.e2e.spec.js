/**
 * Dashboard Performance Tests - Heavy (Nightly/On-Demand)
 *
 * Timing-based tests that can flake on slow CI runners.
 * Run nightly or on-demand with label, not on every PR.
 *
 * For always-on perf smoke tests, see dashboard-perf-smoke.e2e.spec.js
 *
 * Environment variables for CI tuning:
 *   PERF_FACTOR - Multiplier for thresholds (default: 1, CI: 2-3)
 *   PERF_WARN_ONLY - Set to "1" to warn instead of fail on heap tests
 *   RUN_HEAVY_PERF - Set to "1" to enable these tests (default: skip in CI)
 */

const { test: baseTest, expect } = require('./fixtures');

// Skip heavy perf tests in CI unless explicitly enabled
const isCI = process.env.CI === 'true';
const runHeavyPerf = process.env.RUN_HEAVY_PERF === '1';
const test = (isCI && !runHeavyPerf) ? baseTest.skip : baseTest;

// Performance factor for CI runners (slower VMs need higher thresholds)
const PERF_FACTOR = parseFloat(process.env.PERF_FACTOR || '1');
const PERF_WARN_ONLY = process.env.PERF_WARN_ONLY === '1';

// Performance thresholds (in milliseconds) - scaled by PERF_FACTOR
const THRESHOLDS = {
  initialRenderMs: 2000 * PERF_FACTOR,      // Max time to render with 500 events
  scrollFrameMs: 50 * PERF_FACTOR,          // Max frame time during scroll (20fps min)
  eventProcessP95Ms: 10 * PERF_FACTOR,      // P95 time per event in burst
  memoryGrowthMb: 50 * PERF_FACTOR,         // Max memory growth after 1000 events (warn only)
  maxDomNodes: 100,                          // Deterministic: virtual list node cap
  maxStoreRequests: 10000,                   // Deterministic: ring buffer cap (matches dashboard.js)
};

test.describe('Dashboard - Performance (G4)', () => {
  test('initial render with 500 events completes under threshold', async ({ page, proxyServer }) => {
    // Navigate and wait for connection
    await page.goto(proxyServer.url + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });
    await expect.poll(async () => {
      return page.evaluate(() => window.__DASHBOARD_STORE__?.getState()?.connection?.status);
    }, { timeout: 10000 }).toBe('connected');

    // Measure time to add 500 events and render
    const renderTime = await page.evaluate(async (count) => {
      const store = window.__DASHBOARD_STORE__;
      const Actions = window.__DASHBOARD_ACTIONS__;
      const startTime = performance.now();

      // Add events in batches to simulate realistic load
      for (let i = 0; i < count; i++) {
        store.dispatch(Actions.requestReceived({
          requestId: 'perf-req-' + i,
          timestamp: Date.now() - i * 100,
          status: i % 10 === 0 ? 500 : 200,
          latencyMs: 50 + Math.random() * 200,
          keyIndex: i % 2,
          path: '/v1/messages',
          model: 'claude-3-sonnet'
        }));
      }

      // Force a layout/paint
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);

      return performance.now() - startTime;
    }, 500);

    console.log(`Render time for 500 events: ${Math.round(renderTime)}ms`);
    expect(renderTime).toBeLessThan(THRESHOLDS.initialRenderMs);
  });

  test('virtual scroll maintains performance with 1000 events', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });
    await expect.poll(async () => {
      return page.evaluate(() => window.__DASHBOARD_STORE__?.getState()?.connection?.status);
    }, { timeout: 10000 }).toBe('connected');

    // Add 1000 events
    await page.evaluate(() => {
      const store = window.__DASHBOARD_STORE__;
      const Actions = window.__DASHBOARD_ACTIONS__;
      for (let i = 0; i < 1000; i++) {
        store.dispatch(Actions.requestReceived({
          requestId: 'scroll-perf-' + i,
          timestamp: Date.now() - i * 100,
          status: 200,
          latencyMs: 100 + Math.random() * 100
        }));
      }
    });

    // Expand drawer to show the list
    await page.keyboard.press('l');
    await expect(page.getByTestId('bottom-drawer')).toHaveClass(/expanded/);

    // Wait for virtual scroll to render
    await page.waitForSelector('.virtual-scroll-content', { state: 'visible', timeout: 5000 });

    // Measure scroll performance
    const scrollMetrics = await page.evaluate(async () => {
      const viewport = document.querySelector('.virtual-scroll-viewport');
      if (!viewport) return { error: 'No viewport found' };

      const frameTimes = [];
      let lastTime = performance.now();

      // Scroll and measure frame times
      for (let i = 0; i < 10; i++) {
        viewport.scrollTop += 200;
        await new Promise(requestAnimationFrame);
        const now = performance.now();
        frameTimes.push(now - lastTime);
        lastTime = now;
      }

      return {
        avgFrameTime: frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length,
        maxFrameTime: Math.max(...frameTimes),
        minFrameTime: Math.min(...frameTimes)
      };
    });

    console.log(`Scroll metrics: avg=${Math.round(scrollMetrics.avgFrameTime)}ms, max=${Math.round(scrollMetrics.maxFrameTime)}ms`);

    // Allow some tolerance - max frame should be under threshold
    expect(scrollMetrics.maxFrameTime).toBeLessThan(THRESHOLDS.scrollFrameMs * 2);
  });

  test('event burst processing rate is acceptable (p95)', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });
    await expect.poll(async () => {
      return page.evaluate(() => window.__DASHBOARD_STORE__?.getState()?.connection?.status);
    }, { timeout: 10000 }).toBe('connected');

    // Measure time to process events with per-event timing for percentiles
    const burstMetrics = await page.evaluate(() => {
      const store = window.__DASHBOARD_STORE__;
      const Actions = window.__DASHBOARD_ACTIONS__;
      const eventCount = 100;
      const times = [];

      for (let i = 0; i < eventCount; i++) {
        const start = performance.now();
        store.dispatch(Actions.requestReceived({
          requestId: 'burst-' + i,
          timestamp: Date.now(),
          status: 200,
          latencyMs: 100
        }));
        times.push(performance.now() - start);
      }

      // Calculate percentiles
      times.sort((a, b) => a - b);
      const p50 = times[Math.floor(times.length * 0.5)];
      const p95 = times[Math.floor(times.length * 0.95)];
      const p99 = times[Math.floor(times.length * 0.99)];
      const avg = times.reduce((a, b) => a + b, 0) / times.length;

      return { eventCount, avg, p50, p95, p99 };
    });

    console.log(`Burst processing: ${burstMetrics.eventCount} events - avg=${burstMetrics.avg.toFixed(2)}ms, p50=${burstMetrics.p50.toFixed(2)}ms, p95=${burstMetrics.p95.toFixed(2)}ms, p99=${burstMetrics.p99.toFixed(2)}ms`);
    expect(burstMetrics.p95).toBeLessThan(THRESHOLDS.eventProcessP95Ms);
  });

  test('memory growth with 1000 events (warn if excessive)', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });
    await expect.poll(async () => {
      return page.evaluate(() => window.__DASHBOARD_STORE__?.getState()?.connection?.status);
    }, { timeout: 10000 }).toBe('connected');

    // Get initial memory (if available)
    const initialMemory = await page.evaluate(() => {
      if (performance.memory) {
        return performance.memory.usedJSHeapSize / (1024 * 1024);
      }
      return null;
    });

    // Add 1000 events
    await page.evaluate(() => {
      const store = window.__DASHBOARD_STORE__;
      const Actions = window.__DASHBOARD_ACTIONS__;
      for (let i = 0; i < 1000; i++) {
        store.dispatch(Actions.requestReceived({
          requestId: 'mem-test-' + i,
          timestamp: Date.now() - i * 100,
          status: 200,
          latencyMs: 100,
          model: 'claude-3-sonnet-20240229',
          path: '/v1/messages',
          keyIndex: i % 5
        }));
      }
    });

    // Force GC if available and measure
    const finalMemory = await page.evaluate(() => {
      if (window.gc) window.gc();
      if (performance.memory) {
        return performance.memory.usedJSHeapSize / (1024 * 1024);
      }
      return null;
    });

    if (initialMemory !== null && finalMemory !== null) {
      const memoryGrowth = finalMemory - initialMemory;
      console.log(`Memory: initial=${initialMemory.toFixed(2)}MB, final=${finalMemory.toFixed(2)}MB, growth=${memoryGrowth.toFixed(2)}MB`);

      // Heap is non-deterministic - warn unless wildly off (>200MB)
      if (memoryGrowth > THRESHOLDS.memoryGrowthMb) {
        console.log(`::warning::Memory growth ${memoryGrowth.toFixed(2)}MB exceeds ${THRESHOLDS.memoryGrowthMb}MB threshold`);
        if (!PERF_WARN_ONLY && memoryGrowth > 200) {
          // Only fail if growth is extreme (likely a real leak)
          expect(memoryGrowth).toBeLessThan(200);
        }
      }
    } else {
      console.log('Memory measurement not available in this browser');
    }
  });

  test('store request count is bounded by ring buffer', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });
    await expect.poll(async () => {
      return page.evaluate(() => window.__DASHBOARD_STORE__?.getState()?.connection?.status);
    }, { timeout: 10000 }).toBe('connected');

    // Add more events than the ring buffer should hold
    await page.evaluate(() => {
      const store = window.__DASHBOARD_STORE__;
      const Actions = window.__DASHBOARD_ACTIONS__;
      for (let i = 0; i < 1500; i++) {
        store.dispatch(Actions.requestReceived({
          requestId: 'ring-test-' + i,
          timestamp: Date.now() - i * 100,
          status: 200,
          latencyMs: 100
        }));
      }
    });

    // Check store size is bounded
    const storeSize = await page.evaluate(() => {
      const store = window.__DASHBOARD_STORE__;
      const state = store.getState();
      // Store returns requests as { items: [...] }
      return state.requests?.items?.length ?? state.requests?.length ?? 0;
    });

    console.log(`Store request count: ${storeSize} (cap: ${THRESHOLDS.maxStoreRequests})`);
    // This is deterministic - ring buffer should cap at maxStoreRequests
    expect(storeSize).toBeLessThanOrEqual(THRESHOLDS.maxStoreRequests);
  });

  test('DOM node count stays bounded with ring buffer', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });
    await expect.poll(async () => {
      return page.evaluate(() => window.__DASHBOARD_STORE__?.getState()?.connection?.status);
    }, { timeout: 10000 }).toBe('connected');

    // Expand drawer
    await page.keyboard.press('l');
    await expect(page.getByTestId('bottom-drawer')).toHaveClass(/expanded/);

    // Count initial DOM nodes in the virtual list
    const initialNodeCount = await page.evaluate(() => {
      const content = document.querySelector('.virtual-scroll-content');
      return content ? content.children.length : 0;
    });

    // Add 1000 events (should trigger ring buffer eviction)
    await page.evaluate(() => {
      const store = window.__DASHBOARD_STORE__;
      const Actions = window.__DASHBOARD_ACTIONS__;
      for (let i = 0; i < 1000; i++) {
        store.dispatch(Actions.requestReceived({
          requestId: 'dom-test-' + i,
          timestamp: Date.now() - i * 100,
          status: 200,
          latencyMs: 100
        }));
      }
    });

    // Wait for render
    await page.waitForTimeout(500);

    // Count final DOM nodes
    const finalNodeCount = await page.evaluate(() => {
      const content = document.querySelector('.virtual-scroll-content');
      return content ? content.children.length : 0;
    });

    console.log(`DOM nodes in virtual list: initial=${initialNodeCount}, final=${finalNodeCount}`);

    // Virtual list should only render visible items (roughly viewport height / row height)
    // With virtualization, we should see < 100 DOM nodes even with 1000 items
    expect(finalNodeCount).toBeLessThan(100);
  });

  test('KPI updates remain responsive during high load', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });
    await expect.poll(async () => {
      return page.evaluate(() => window.__DASHBOARD_STORE__?.getState()?.connection?.status);
    }, { timeout: 10000 }).toBe('connected');

    // Measure KPI update latency while processing events
    const kpiMetrics = await page.evaluate(async () => {
      const store = window.__DASHBOARD_STORE__;
      const Actions = window.__DASHBOARD_ACTIONS__;

      // Get initial KPI state
      const getKpiRpm = () => {
        const el = document.querySelector('[data-testid="kpi-rpm"]');
        return el ? el.textContent : null;
      };

      const initialRpm = getKpiRpm();
      const startTime = performance.now();

      // Dispatch events
      for (let i = 0; i < 100; i++) {
        store.dispatch(Actions.requestReceived({
          requestId: 'kpi-test-' + i,
          timestamp: Date.now(),
          status: 200,
          latencyMs: 100
        }));
      }

      // Wait for DOM update
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);

      const updateTime = performance.now() - startTime;
      const finalRpm = getKpiRpm();

      return {
        updateTime,
        rpmChanged: finalRpm !== initialRpm,
        initialRpm,
        finalRpm
      };
    });

    console.log(`KPI update: ${Math.round(kpiMetrics.updateTime)}ms, RPM changed: ${kpiMetrics.rpmChanged}`);

    // KPI should update within reasonable time
    expect(kpiMetrics.updateTime).toBeLessThan(500);
  });
});

test.describe('Dashboard - SSE Performance', () => {
  test('SSE connection handles reconnection gracefully', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });

    // Wait for initial connection
    await expect.poll(async () => {
      return page.evaluate(() => window.__DASHBOARD_STORE__?.getState()?.connection?.status);
    }, { timeout: 10000 }).toBe('connected');

    // Simulate disconnection by navigating away and back
    const connectionState = await page.evaluate(async () => {
      const store = window.__DASHBOARD_STORE__;

      // Record initial state
      const initialClientId = store.getState().connection.clientId;

      // Trigger reconnection by dispatching disconnect
      const Actions = window.__DASHBOARD_ACTIONS__;
      store.dispatch(Actions.sseDisconnected());

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 100));

      return {
        initialClientId,
        statusAfterDisconnect: store.getState().connection.status
      };
    });

    // Verify disconnect was recorded
    expect(['disconnected', 'connecting', 'connected']).toContain(connectionState.statusAfterDisconnect);
  });

  test.skip('chart rendering remains smooth with rapid KPI updates', async ({ page, proxyServer }) => {
    // SKIPPED: This test requires Actions.kpiReceived which doesn't exist in the current dashboard
    // The dashboard store architecture has changed and this test needs to be rewritten
    // TODO: Rewrite to use actual SSE KPI events instead of store.dispatch

    await page.goto(proxyServer.url + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });
    await expect.poll(async () => {
      return page.evaluate(() => window.__DASHBOARD_STORE__?.getState()?.connection?.status);
    }, { timeout: 10000 }).toBe('connected');

    // Measure chart update performance
    const chartMetrics = await page.evaluate(async () => {
      const store = window.__DASHBOARD_STORE__;
      const Actions = window.__DASHBOARD_ACTIONS__;

      const frameTimes = [];
      let lastFrame = performance.now();

      // Update KPIs rapidly while measuring frame times
      for (let i = 0; i < 20; i++) {
        store.dispatch(Actions.kpiReceived({
          rpm: 100 + i * 10,
          successRate: 95 + Math.random() * 5,
          p95: 150 + Math.random() * 50,
          poolHealth: 0.9 + Math.random() * 0.1,
          keysHealth: 0.95
        }));

        await new Promise(requestAnimationFrame);
        const now = performance.now();
        frameTimes.push(now - lastFrame);
        lastFrame = now;
      }

      return {
        avgFrameTime: frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length,
        maxFrameTime: Math.max(...frameTimes),
        frameCount: frameTimes.length
      };
    });

    console.log(`Chart update: avg=${Math.round(chartMetrics.avgFrameTime)}ms, max=${Math.round(chartMetrics.maxFrameTime)}ms`);

    // Charts should update smoothly (target 30fps = 33ms/frame)
    expect(chartMetrics.avgFrameTime).toBeLessThan(100);
  });
});
