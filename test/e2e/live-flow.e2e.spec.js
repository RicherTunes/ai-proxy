/**
 * E2E Tests: Runway Per-Request Flow Visualization + Pool-Status SSE Events
 *
 * Tests both the backend SSE pool-status events and the frontend
 * Runway HTML-based per-request flow visualization.
 *
 * Uses liveFlowTest fixture which creates a server with explicit
 * modelRouting tiers (heavy/medium/light) for predictable pool-status data.
 */
const { liveFlowTest: test, expect, getSSEEvent, gotoDashboardReady, waitForSSEConnection } = require('./fixtures');

// ======== SSE Pool-Status Events (Node.js side) ========

test.describe('Pool-Status SSE Events', () => {

  test('pool-status event fires on /requests/stream', async ({ proxyServer }) => {
    // Use getSSEEvent helper to listen for named 'pool-status' event on /requests/stream
    const event = await getSSEEvent(
      proxyServer.url + '/requests/stream',
      'pool-status',
      8000  // Allow up to 8s (timer is 3s + connect overhead)
    );

    expect(event).not.toBeNull();
    expect(event.type).toBe('pool-status');
  });

  test('pool-status event matches SSE-02 schema', async ({ proxyServer }) => {
    const event = await getSSEEvent(
      proxyServer.url + '/requests/stream',
      'pool-status',
      8000
    );

    expect(event).not.toBeNull();

    // SSE-02: Required fields
    expect(typeof event.seq).toBe('number');
    expect(event.seq).toBeGreaterThan(0);
    expect(typeof event.ts).toBe('number');
    expect(event.schemaVersion).toBe(1);
    expect(event.type).toBe('pool-status');
    expect(typeof event.pools).toBe('object');

    // Verify tier structure
    const tierNames = Object.keys(event.pools);
    expect(tierNames.length).toBeGreaterThan(0);

    // Verify model entries in at least one tier
    const firstTier = event.pools[tierNames[0]];
    expect(Array.isArray(firstTier)).toBe(true);
    if (firstTier.length > 0) {
      const model = firstTier[0];
      expect(typeof model.model).toBe('string');
      expect(typeof model.inFlight).toBe('number');
      expect(typeof model.maxConcurrency).toBe('number');
      expect(typeof model.available).toBe('number');
    }
  });

  test('pool-status events have incrementing seq', async ({ proxyServer }) => {
    // Collect two events by connecting twice in sequence
    const event1 = await getSSEEvent(
      proxyServer.url + '/requests/stream',
      'pool-status',
      8000
    );

    // Small delay then collect second
    const event2 = await getSSEEvent(
      proxyServer.url + '/requests/stream',
      'pool-status',
      8000
    );

    expect(event1).not.toBeNull();
    expect(event2).not.toBeNull();
    // seq should be incrementing globally
    expect(event2.seq).toBeGreaterThan(event1.seq);
  });

  test('pool-status contains configured tiers', async ({ proxyServer }) => {
    const event = await getSSEEvent(
      proxyServer.url + '/requests/stream',
      'pool-status',
      8000
    );

    expect(event).not.toBeNull();

    // The liveFlowTest fixture configures heavy, medium, light tiers
    const tierNames = Object.keys(event.pools);
    expect(tierNames).toContain('heavy');
    expect(tierNames).toContain('medium');
    expect(tierNames).toContain('light');

    // Each tier should have exactly one model (as configured)
    expect(event.pools.heavy.length).toBe(1);
    expect(event.pools.medium.length).toBe(1);
    expect(event.pools.light.length).toBe(1);

    // Verify model names match fixture config
    expect(event.pools.heavy[0].model).toBe('test-model-heavy');
    expect(event.pools.medium[0].model).toBe('test-model-medium');
    expect(event.pools.light[0].model).toBe('test-model-light');
  });

  test('existing raw SSE data: lines still work alongside named events', async ({ proxyServer, page }) => {
    // SSE-04: Verify backward compatibility
    // Navigate to dashboard and verify SSE connection works
    await gotoDashboardReady(page, proxyServer.url);
    await waitForSSEConnection(page);

    // Verify the connection is established (existing functionality)
    const status = await page.evaluate(() => {
      return window.__DASHBOARD_STORE__?.getState()?.connection?.status;
    });
    expect(status).toBe('connected');
  });
});

// ======== Runway Per-Request Flow Visualization (Browser side) ========

// Helper: navigate to routing page via page-nav button click
async function goToRoutingPage(page, proxyServer) {
  await gotoDashboardReady(page, proxyServer.url);
  // Click the page-nav-btn (not the overflow menu item) to switch to routing page
  await page.locator('.page-nav-btn[data-page="routing"]').click();
  // Wait for the switchPage JS to remove page-hidden from routing sections
  await page.waitForFunction(() => {
    const el = document.getElementById('liveFlowContainer');
    return el && !el.classList.contains('page-hidden');
  }, { timeout: 5000 });
}

test.describe('Runway Flow Visualization', () => {

  test('liveFlowContainer renders on routing page', async ({ proxyServer, page }) => {
    await goToRoutingPage(page, proxyServer);

    const container = page.locator('#liveFlowContainer');
    await expect(container).toBeVisible();
  });

  test('runway-viz container exists inside liveFlowContainer', async ({ proxyServer, page }) => {
    await goToRoutingPage(page, proxyServer);

    const runway = page.locator('#runwayViz');
    await expect(runway).toHaveCount(1);
  });

  test('runway sections exist for in-flight and completed', async ({ proxyServer, page }) => {
    await goToRoutingPage(page, proxyServer);

    const inflightSection = page.locator('.runway-inflight');
    const completedSection = page.locator('.runway-completed');
    await expect(inflightSection).toHaveCount(1);
    await expect(completedSection).toHaveCount(1);
  });

  test('empty state shown when no active requests', async ({ proxyServer, page }) => {
    await goToRoutingPage(page, proxyServer);

    // RunwayViz should show empty state with no requests
    const isEmpty = await page.evaluate(() => {
      const viz = document.getElementById('runwayViz');
      return viz?.classList.contains('empty');
    });
    expect(isEmpty).toBe(true);
  });

  test('connection status indicator exists', async ({ proxyServer, page }) => {
    await goToRoutingPage(page, proxyServer);

    const statusEl = page.locator('#liveFlowStatus');
    await expect(statusEl).toBeVisible();
    const statusText = await statusEl.textContent();
    expect(statusText.length).toBeGreaterThan(0);
  });
});

// ======== Reduced Motion ========

test.describe('Reduced Motion', () => {

  test('reduced motion detected by RunwayViz', async ({ proxyServer, page }) => {
    // Emulate reduced motion preference BEFORE navigating
    await page.emulateMedia({ reducedMotion: 'reduce' });

    await goToRoutingPage(page, proxyServer);

    const reducedMotion = await page.evaluate(() => {
      return window._liveFlowViz?.reducedMotion;
    });
    expect(reducedMotion).toBe(true);
  });

  test('no pulse animations with prefers-reduced-motion', async ({ proxyServer, page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await goToRoutingPage(page, proxyServer);

    // Verify CSS disables animations via media query
    const animationDisabled = await page.evaluate(() => {
      const el = document.createElement('div');
      el.className = 'runway-segment routing';
      document.body.appendChild(el);
      const style = window.getComputedStyle(el);
      const result = style.animationName === 'none' || style.animation === 'none';
      el.remove();
      return result;
    });
    expect(animationDisabled).toBe(true);
  });
});
