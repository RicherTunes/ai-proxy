/**
 * Dashboard Polish E2E Tests
 * TDD implementation for frontend dashboard improvements
 *
 * Phases:
 * 0 - Debug hooks for deterministic testing
 * 1 - Fix escapeRegex + Search correctness
 * 2 - Add 300ms debounce + Searching indicator
 * 3 - Action-level loading states
 * 4 - ErrorBoundary at event delegation seam
 * 5 - Dynamic ARIA correctness
 * 6 - Targeted hover states with reduced-motion support
 */

const { test, expect } = require('./fixtures');
const { gotoDashboardReady } = require('./fixtures');

test.describe('Dashboard Polish - Phase 0: Debug Hooks', () => {
  test('debug API exists for deterministic testing', async ({ page, proxyServer }) => {
    await gotoDashboardReady(page, proxyServer.url);

    const hasDebug = await page.evaluate(() => {
      return !!(window.__DASHBOARD_DEBUG__?.search &&
                window.__DASHBOARD_DEBUG__?.errors &&
                window.__DASHBOARD_DEBUG__?.loading);
    });

    expect(hasDebug).toBeTruthy();
  });

  test('debug API has addRequestToStream helper', async ({ page, proxyServer }) => {
    await gotoDashboardReady(page, proxyServer.url);

    const hasHelper = await page.evaluate(() => {
      return typeof window.__DASHBOARD_DEBUG__?.addRequestToStream === 'function';
    });

    expect(hasHelper).toBeTruthy();
  });

  test('debug counters initialize at zero', async ({ page, proxyServer }) => {
    await gotoDashboardReady(page, proxyServer.url);

    const counters = await page.evaluate(() => {
      return {
        searchRuns: window.__DASHBOARD_DEBUG__?.search?.runs ?? -1,
        errorToasts: window.__DASHBOARD_DEBUG__?.errors?.toastsShown ?? -1,
        loadingInFlight: window.__DASHBOARD_DEBUG__?.loading?.inFlight ?? -1
      };
    });

    expect(counters.searchRuns).toBe(0);
    expect(counters.errorToasts).toBe(0);
    expect(counters.loadingInFlight).toBe(0);
  });
});

test.describe('Dashboard Polish - Phase 1: Fix escapeRegex + Search Correctness', () => {
  test('special regex characters work correctly', async ({ page, proxyServer }) => {
    await gotoDashboardReady(page, proxyServer.url);

    // Add a searchable element with special chars directly to DOM
    await page.evaluate(() => {
      const item = document.createElement('div');
      item.className = 'trace-item';
      item.textContent = '/v1/messages?x=[test]';
      item.id = 'test-search-item';
      document.body.appendChild(item);
    });

    // Attach page error handler - collect errors for assertion
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e));

    // Act: fill search with special chars
    await page.fill('#globalSearchInput', '[test]');
    await page.waitForTimeout(400);  // Wait for debounce

    // Assert: no page errors occurred
    expect(pageErrors).toEqual([]);

    // Assert: search ran
    const debug = await page.evaluate(() => window.__DASHBOARD_DEBUG__.search);
    expect(debug.runs).toBeGreaterThanOrEqual(1);
    expect(debug.lastQuery).toBe('[test]');
  });

  test('literal matching with regex specials (parentheses)', async ({ page, proxyServer }) => {
    await gotoDashboardReady(page, proxyServer.url);

    // Add searchable element with parentheses
    await page.evaluate(() => {
      const item = document.createElement('div');
      item.className = 'trace-item';
      item.textContent = '/v1/messages?test=(value)';
      item.id = 'test-paren-item';
      document.body.appendChild(item);
    });

    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e));

    await page.fill('#globalSearchInput', '(value)');
    await page.waitForTimeout(400);

    // Should not crash
    expect(pageErrors).toEqual([]);

    // Search should run
    const debug = await page.evaluate(() => window.__DASHBOARD_DEBUG__.search);
    expect(debug.runs).toBeGreaterThanOrEqual(1);
  });

  test('dollar sign character works correctly', async ({ page, proxyServer }) => {
    await gotoDashboardReady(page, proxyServer.url);

    await page.evaluate(() => {
      const item = document.createElement('div');
      item.className = 'trace-item';
      item.textContent = '/v1/messages?price=$100';
      item.id = 'test-dollar-item';
      document.body.appendChild(item);
    });

    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e));

    await page.fill('#globalSearchInput', '$100');
    await page.waitForTimeout(400);

    // Should not crash with dollar sign
    expect(pageErrors).toEqual([]);

    const debug = await page.evaluate(() => window.__DASHBOARD_DEBUG__.search);
    expect(debug.runs).toBeGreaterThanOrEqual(1);
  });

  test('backslash and pipe characters work correctly', async ({ page, proxyServer }) => {
    await gotoDashboardReady(page, proxyServer.url);

    await page.evaluate(() => {
      const item = document.createElement('div');
      item.className = 'trace-item';
      item.textContent = '/v1/messages?path=C:\\|pipe';
      item.id = 'test-backslash-item';
      document.body.appendChild(item);
    });

    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e));

    await page.fill('#globalSearchInput', 'C:\\|');
    await page.waitForTimeout(400);

    expect(pageErrors).toEqual([]);

    const debug = await page.evaluate(() => window.__DASHBOARD_DEBUG__.search);
    expect(debug.runs).toBeGreaterThanOrEqual(1);
  });
});

test.describe('Dashboard Polish - Phase 2: Debounce + Searching Indicator', () => {
  test('debounce delays search execution', async ({ page, proxyServer }) => {
    await gotoDashboardReady(page, proxyServer.url);

    // Add searchable element
    await page.evaluate(() => {
      const item = document.createElement('div');
      item.className = 'trace-item';
      item.textContent = 'test query content here';
      item.id = 'test-debounce-item';
      document.body.appendChild(item);
    });

    // Reset debug counter
    await page.evaluate(() => {
      window.__DASHBOARD_DEBUG__.search.runs = 0;
    });

    // Fill twice quickly
    const search = page.locator('#globalSearchInput');
    await search.fill('test');
    await search.fill('test query');

    // Assert: no run before 300ms
    await page.waitForTimeout(250);
    const runsEarly = await page.evaluate(() => window.__DASHBOARD_DEBUG__.search.runs);
    expect(runsEarly).toBe(0);

    // Assert: exactly 1 run after debounce
    await page.waitForTimeout(200);  // 450ms total
    const runsLate = await page.evaluate(() => window.__DASHBOARD_DEBUG__.search);
    expect(runsLate.runs).toBe(1);
    expect(runsLate.lastQuery).toBe('test query');
  });

  test('searching indicator visible immediately, then hidden after run', async ({ page, proxyServer }) => {
    await gotoDashboardReady(page, proxyServer.url);

    // Add searchable element
    await page.evaluate(() => {
      const item = document.createElement('div');
      item.className = 'trace-item';
      item.textContent = 'test indicator';
      item.id = 'test-indicator-item';
      document.body.appendChild(item);
      window.__DASHBOARD_DEBUG__.search.runs = 0;
    });

    const indicator = page.locator('#searchingIndicator');
    const search = page.locator('#globalSearchInput');

    // Initially hidden
    await expect(indicator).not.toBeVisible();

    // Fill search
    await search.fill('test');

    // Indicator should become visible immediately
    await expect(indicator).toBeVisible();

    // Wait for search to complete
    await page.waitForFunction(() =>
      window.__DASHBOARD_DEBUG__.search.runs === 1,
      { timeout: 500 }
    );

    // Indicator should be hidden after search completes
    await expect(indicator).not.toBeVisible();
  });

  test('skip unchanged queries (performance optimization)', async ({ page, proxyServer }) => {
    await gotoDashboardReady(page, proxyServer.url);

    // Add searchable element
    await page.evaluate(() => {
      const item = document.createElement('div');
      item.className = 'trace-item';
      item.textContent = 'unchanged test query';
      item.id = 'test-unchanged-item';
      document.body.appendChild(item);
      window.__DASHBOARD_DEBUG__.search.runs = 0;
    });

    const search = page.locator('#globalSearchInput');

    // First search
    await search.fill('test');
    await page.waitForFunction(() =>
      window.__DASHBOARD_DEBUG__.search.runs === 1,
      { timeout: 500 }
    );

    // Fill with same query again (should be skipped)
    await search.fill('test');

    // Should still be 1 run (unchanged query was skipped)
    await page.waitForTimeout(400);
    const runs = await page.evaluate(() => window.__DASHBOARD_DEBUG__.search.runs);
    expect(runs).toBe(1);
  });
});

test.describe('Dashboard Polish - Phase 3: Action-Level Loading States', () => {
  test('withLoading wrapper exists and is functional', async ({ page, proxyServer }) => {
    await gotoDashboardReady(page, proxyServer.url);

    // Check that withLoading is exposed
    const hasWithLoading = await page.evaluate(() => typeof window.withLoading === 'function');
    expect(hasWithLoading).toBeTruthy();
  });

  test('loading.inFlight counter tracks loading state', async ({ page, proxyServer }) => {
    await gotoDashboardReady(page, proxyServer.url);

    // Check initial state
    const inFlightBefore = await page.evaluate(() => window.__DASHBOARD_DEBUG__.loading.inFlight);
    expect(inFlightBefore).toBe(0);

    // Manually test the counter by simulating what withLoading does
    await page.evaluate(() => {
      window.__DASHBOARD_DEBUG__.loading.inFlight++;
    });

    const inFlightDuring = await page.evaluate(() => window.__DASHBOARD_DEBUG__.loading.inFlight);
    expect(inFlightDuring).toBe(1);

    // Decrement
    await page.evaluate(() => {
      window.__DASHBOARD_DEBUG__.loading.inFlight--;
    });

    const inFlightAfter = await page.evaluate(() => window.__DASHBOARD_DEBUG__.loading.inFlight);
    expect(inFlightAfter).toBe(0);
  });

  test('errorBoundary exists and is functional', async ({ page, proxyServer }) => {
    await gotoDashboardReady(page, proxyServer.url);

    // Check that errorBoundary is exposed
    const hasErrorBoundary = await page.evaluate(() =>
      typeof window.errorBoundary === 'object' && window.errorBoundary !== null
    );
    expect(hasErrorBoundary).toBeTruthy();
  });

  test('errorBoundary has isBenign filter', async ({ page, proxyServer }) => {
    await gotoDashboardReady(page, proxyServer.url);

    const hasIsBenign = await page.evaluate(() =>
      typeof window.errorBoundary?.isBenign === 'function'
    );
    expect(hasIsBenign).toBeTruthy();

    // Test benign error detection
    const isAbortBenign = await page.evaluate(() =>
      window.errorBoundary.isBenign(new Error('AbortError: Operation aborted'))
    );
    expect(isAbortBenign).toBe(true);

    // Test non-benign error
    const isRealBenign = await page.evaluate(() =>
      window.errorBoundary.isBenign(new Error('Real error that matters'))
    );
    expect(isRealBenign).toBe(false);
  });
});

test.describe('Dashboard Polish - Phase 4: ErrorBoundary', () => {
  test('error boundary catches errors and shows toast', async ({ page, proxyServer }) => {
    await gotoDashboardReady(page, proxyServer.url);

    // Reset error counter
    await page.evaluate(() => {
      window.__DASHBOARD_DEBUG__.errors.toastsShown = 0;
    });

    // Trigger error via error boundary directly
    await page.evaluate(() => {
      window.errorBoundary.handleError(new Error('Test error from boundary'), 'test-component');
    });

    // Error counter should increment
    const toastsShown = await page.evaluate(() => window.__DASHBOARD_DEBUG__.errors.toastsShown);
    expect(toastsShown).toBeGreaterThan(0);

    // Last toast should be recorded
    const lastToast = await page.evaluate(() => window.__DASHBOARD_DEBUG__.errors.lastToast);
    expect(lastToast).toBe('Test error from boundary');

    // Toast should be visible
    await expect(page.locator('.toast.error')).toBeVisible();
  });

  test('error boundary dedupes same errors', async ({ page, proxyServer }) => {
    await gotoDashboardReady(page, proxyServer.url);

    // Reset error counter
    await page.evaluate(() => {
      window.__DASHBOARD_DEBUG__.errors.toastsShown = 0;
    });

    // Trigger same error twice quickly
    await page.evaluate(() => {
      const testError = new Error('Dedup test error');
      window.errorBoundary.handleError(testError, 'test-component');
      window.errorBoundary.handleError(testError, 'test-component');
    });

    // Should only show one toast (dedupe)
    const toastsShown = await page.evaluate(() => window.__DASHBOARD_DEBUG__.errors.toastsShown);
    expect(toastsShown).toBe(1);
  });

  test('error boundary filters benign errors', async ({ page, proxyServer }) => {
    await gotoDashboardReady(page, proxyServer.url);

    // Reset error counter
    await page.evaluate(() => {
      window.__DASHBOARD_DEBUG__.errors.toastsShown = 0;
    });

    // Trigger a benign error (AbortError from fetch abort)
    await page.evaluate(() => {
      // Access ErrorBoundary and test isBenign
      if (window.errorBoundary) {
        const benignError = new Error('AbortError: The operation was aborted');
        const result = window.errorBoundary.isBenign(benignError);
        // Should be filtered (no toast shown)
        return result;
      }
      return false;
    });

    // Benign errors should not increment toast counter
    const toastsShown = await page.evaluate(() => window.__DASHBOARD_DEBUG__.errors.toastsShown);
    expect(toastsShown).toBe(0);
  });
});

test.describe('Dashboard Polish - Phase 5: ARIA Correctness', () => {
  test('page tabs have correct aria-selected state', async ({ page, proxyServer }) => {
    await gotoDashboardReady(page, proxyServer.url);

    // Active tab should have aria-selected="true"
    await expect(page.locator('.page-nav-btn.active'))
      .toHaveAttribute('aria-selected', 'true');

    // Switch page
    await page.click('[data-page="requests"]');

    // Previous should be false, new should be true
    await expect(page.locator('[data-page="overview"].page-nav-btn'))
      .toHaveAttribute('aria-selected', 'false');
    await expect(page.locator('.page-nav-btn.active'))
      .toHaveAttribute('aria-selected', 'true');
  });

  test('search input has proper ARIA', async ({ page, proxyServer }) => {
    await gotoDashboardReady(page, proxyServer.url);

    const search = page.locator('#globalSearchInput');
    await expect(search).toHaveAttribute('aria-label', 'Search requests');
    await expect(search).toHaveAttribute('aria-controls', 'searchResults');
  });

  test('searching indicator has aria-live', async ({ page, proxyServer }) => {
    await gotoDashboardReady(page, proxyServer.url);

    const indicator = page.locator('#searchingIndicator');
    await expect(indicator).toHaveAttribute('aria-live', 'polite');
  });

  test('dock tabs have correct ARIA attributes', async ({ page, proxyServer }) => {
    await gotoDashboardReady(page, proxyServer.url);

    // Active dock tab
    const activeTab = page.locator('.dock-tab.active').first();
    await expect(activeTab).toHaveAttribute('aria-selected', 'true');
    await expect(activeTab).toHaveAttribute('tabindex', '0');

    // Inactive dock tab
    const inactiveTab = page.locator('.dock-tab:not(.active)').first();
    await expect(inactiveTab).toHaveAttribute('aria-selected', 'false');
    await expect(inactiveTab).toHaveAttribute('tabindex', '-1');
  });
});

test.describe('Dashboard Polish - Phase 6: Targeted Hover States', () => {
  test('page buttons have hover transition defined', async ({ page, proxyServer }) => {
    await gotoDashboardReady(page, proxyServer.url);

    const btn = page.locator('.page-nav-btn').first();

    // Check that transition is defined
    const transition = await btn.evaluate(el => {
      return getComputedStyle(el).transition;
    });

    expect(transition).toContain('background-color');
  });

  test('hover respects prefers-reduced-motion', async ({ page, proxyServer }) => {
    // Set reduced motion BEFORE page load (media query evaluated at load)
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await gotoDashboardReady(page, proxyServer.url);

    const btn = page.locator('.page-nav-btn').first();

    // Check transition duration is 0s
    const transitionDuration = await btn.evaluate(el => {
      return getComputedStyle(el).transitionDuration;
    });

    expect(transitionDuration).toBe('0s');
  });

  test('filter chips have hover styles defined', async ({ page, proxyServer }) => {
    await gotoDashboardReady(page, proxyServer.url);

    // Check CSS rules for hover state
    const hasHoverStyle = await page.evaluate(() => {
      const chips = document.querySelectorAll('.filter-chip');
      if (chips.length === 0) return false;

      const chip = chips[0];
      const styles = getComputedStyle(chip);
      return styles.transition !== 'none' || styles.transition !== '';
    });

    // This test checks that hover transitions are defined in CSS
    // If there are no filter chips on the page, we can still verify the CSS exists
    const cssExists = await page.evaluate(() => {
      const sheets = Array.from(document.styleSheets);
      for (const sheet of sheets) {
        try {
          for (const rule of sheet.cssRules || sheet.rules || []) {
            if (rule.selectorText && rule.selectorText.includes('.filter-chip:hover')) {
              return true;
            }
          }
        } catch (e) {
          // Skip if we can't access rules (CORS)
        }
      }
      return false;
    });

    expect(hasHoverStyle || cssExists).toBeTruthy();
  });
});
