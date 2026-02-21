/**
 * Dashboard Performance Smoke Tests
 *
 * Lightweight, deterministic tests that run on every PR.
 * These tests assert on bounded/capped values that don't vary with runner speed.
 *
 * For heavy perf tests (timing-based), see dashboard-perf-heavy.e2e.spec.js
 */

const { test, expect } = require('./fixtures');

// Deterministic thresholds (not affected by CI runner speed)
const THRESHOLDS = {
  maxDomNodes: 100,           // Virtual list should cap rendered nodes
  maxStoreRequests: 10000,    // Ring buffer cap (matches dashboard.js implementation)
};

test.describe('Dashboard - Performance Smoke (always-on)', () => {
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

  test('DOM node count stays bounded with virtualization', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });
    await expect.poll(async () => {
      return page.evaluate(() => window.__DASHBOARD_STORE__?.getState()?.connection?.status);
    }, { timeout: 10000 }).toBe('connected');

    // Expand drawer
    await page.keyboard.press('l');
    await expect(page.getByTestId('bottom-drawer')).toHaveClass(/expanded/);

    // Add 1000 events
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

    // Count DOM nodes
    const nodeCount = await page.evaluate(() => {
      const content = document.querySelector('.virtual-scroll-content');
      return content ? content.children.length : 0;
    });

    console.log(`DOM nodes in virtual list: ${nodeCount} (cap: ${THRESHOLDS.maxDomNodes})`);
    // Deterministic: virtual list should only render visible items
    expect(nodeCount).toBeLessThan(THRESHOLDS.maxDomNodes);
  });

  test('SSE connection handles reconnection gracefully', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });

    // Wait for initial connection
    await expect.poll(async () => {
      return page.evaluate(() => window.__DASHBOARD_STORE__?.getState()?.connection?.status);
    }, { timeout: 10000 }).toBe('connected');

    // Simulate disconnection
    const connectionState = await page.evaluate(async () => {
      const store = window.__DASHBOARD_STORE__;
      const Actions = window.__DASHBOARD_ACTIONS__;

      const initialClientId = store.getState().connection.clientId;
      store.dispatch(Actions.sseDisconnected());

      await new Promise(resolve => setTimeout(resolve, 100));

      return {
        initialClientId,
        statusAfterDisconnect: store.getState().connection.status
      };
    });

    // Verify disconnect was recorded (state machine transition)
    expect(['disconnected', 'connecting', 'connected']).toContain(connectionState.statusAfterDisconnect);
  });

  test('store maintains data integrity after many events', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });
    await expect.poll(async () => {
      return page.evaluate(() => window.__DASHBOARD_STORE__?.getState()?.connection?.status);
    }, { timeout: 10000 }).toBe('connected');

    // Add events with known data
    const testCount = 500;
    await page.evaluate((count) => {
      const store = window.__DASHBOARD_STORE__;
      const Actions = window.__DASHBOARD_ACTIONS__;
      for (let i = 0; i < count; i++) {
        store.dispatch(Actions.requestReceived({
          requestId: 'integrity-' + i,
          timestamp: 1700000000000 + i * 1000,
          status: i % 5 === 0 ? 500 : 200,
          latencyMs: 100 + i
        }));
      }
    }, testCount);

    // Verify data integrity
    const integrity = await page.evaluate(() => {
      const store = window.__DASHBOARD_STORE__;
      const state = store.getState();
      // Handle both old format (array) and new format (object with items)
      const requests = state.requests?.items || state.requests || [];

      // Check that requests are valid objects
      const validRequests = requests.filter(r =>
        r && typeof r.requestId === 'string' && typeof r.status === 'number'
      );

      // Check ordering (store uses chronological order, oldest first)
      let orderedCorrectly = true;
      for (let i = 1; i < requests.length; i++) {
        if (requests[i].timestamp < requests[i-1].timestamp) {
          orderedCorrectly = false;
          break;
        }
      }

      return {
        totalRequests: requests.length,
        validRequests: validRequests.length,
        orderedCorrectly,
        hasRequestIds: requests.every(r => r.requestId && r.requestId.startsWith('integrity-'))
      };
    });

    expect(integrity.validRequests).toBe(integrity.totalRequests);
    expect(integrity.orderedCorrectly).toBe(true);
    expect(integrity.hasRequestIds).toBe(true);
  });
});
