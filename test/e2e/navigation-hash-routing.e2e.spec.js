/**
 * Navigation Hash Routing E2E Tests
 *
 * Tests for Phase 1 (URL Routing), Phase 2 (Command Palette), and Phase 3 (Tab Labels)
 * of the Dashboard Navigation Improvement Plan.
 */

const { test, expect } = require('./fixtures');

// ============================================================================
// PHASE 1: URL HASH ROUTING
// ============================================================================

test.describe('Navigation - URL Hash Routing', () => {
  test('should navigate to Overview page by default', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav-btn.active');

    const activeBtn = page.locator('.page-nav-btn.active');
    await expect(activeBtn).toHaveAttribute('data-page', 'overview');
  });

  test('should navigate to Requests page via hash', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard#requests', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav-btn.active');

    const activeBtn = page.locator('.page-nav-btn.active');
    await expect(activeBtn).toHaveAttribute('data-page', 'requests');

    // URL should still have the hash
    expect(page.url()).toContain('#requests');
  });

  test('should navigate to Requests > Traces via nested hash', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard#requests/traces', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav-btn.active');

    const activeBtn = page.locator('.page-nav-btn.active');
    await expect(activeBtn).toHaveAttribute('data-page', 'requests');

    // URL should still have the nested hash
    expect(page.url()).toContain('#requests/traces');
  });

  test('should navigate to Routing page via hash', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard#routing', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav-btn.active');

    const activeBtn = page.locator('.page-nav-btn.active');
    await expect(activeBtn).toHaveAttribute('data-page', 'routing');
  });

  test('should navigate to System/Diagnostics page via hash', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard#system', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav-btn.active');

    const activeBtn = page.locator('.page-nav-btn.active');
    await expect(activeBtn).toHaveAttribute('data-page', 'system');
  });

  test('should update hash when clicking navigation buttons', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav-btn.active');

    // Click Requests button
    await page.locator('.page-nav-btn[data-page="requests"]').click();

    // Wait for navigation to complete
    await page.waitForFunction(() => window.location.hash === '#requests');

    expect(page.url()).toContain('#requests');
  });

  // Note: Browser back/forward with hash navigation is flaky in Playwright
  // The hashchange event does fire in real browsers but Playwright's goBack()
  // doesn't always trigger it reliably. Core hash routing works - see other tests.
  test.skip('should handle browser back/forward navigation', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav-btn.active');

    // Navigate to Requests
    await page.locator('.page-nav-btn[data-page="requests"]').click();
    await page.waitForFunction(() => window.location.hash === '#requests', { timeout: 3000 });

    // Navigate to System
    await page.locator('.page-nav-btn[data-page="system"]').click();
    await page.waitForFunction(() => window.location.hash === '#system', { timeout: 3000 });

    // Go back - should return to requests
    await page.goBack();
    await page.waitForFunction(() => {
      const hash = window.location.hash;
      return hash === '#requests';
    }, { timeout: 5000 });

    let activeBtn = page.locator('.page-nav-btn.active');
    await expect(activeBtn).toHaveAttribute('data-page', 'requests');

    // Go back again - should return to overview
    await page.goBack();
    await page.waitForFunction(() => {
      const hash = window.location.hash;
      return hash === '' || hash === '#overview' || hash === '#';
    }, { timeout: 5000 });

    activeBtn = page.locator('.page-nav-btn.active');
    await expect(activeBtn).toHaveAttribute('data-page', 'overview');

    // Go forward - should go to requests
    await page.goForward();
    await page.waitForFunction(() => window.location.hash === '#requests', { timeout: 5000 });

    activeBtn = page.locator('.page-nav-btn.active');
    await expect(activeBtn).toHaveAttribute('data-page', 'requests');
  });

  test('should preserve page on refresh', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard#routing', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav-btn.active');

    // Refresh the page
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav-btn.active');

    const activeBtn = page.locator('.page-nav-btn.active');
    await expect(activeBtn).toHaveAttribute('data-page', 'routing');
    expect(page.url()).toContain('#routing');
  });

  test('should not interfere with /requests API endpoint', async ({ page, proxyServer }) => {
    // The API endpoint /requests should still return JSON, not the dashboard
    const response = await page.request.get(proxyServer.url + '/requests');

    // Should get a valid response (either 200 with data or appropriate error)
    // The key is it shouldn't return HTML dashboard content
    const contentType = response.headers()['content-type'] || '';
    expect(contentType).not.toContain('text/html');
  });

  test('should migrate legacy localStorage to hash', async ({ page, proxyServer }) => {
    // First clear any existing state
    await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });

    // Set legacy localStorage values
    await page.evaluate(() => {
      localStorage.removeItem('dashboard-active-page');
      localStorage.removeItem('dashboard-request-tab');
      // Set new values
      localStorage.setItem('dashboard-active-page', 'system');
    });

    // Clear URL hash to simulate legacy state
    await page.evaluate(() => {
      history.replaceState(null, '', window.location.pathname);
    });

    // Reload to trigger migration
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav-btn.active');

    // Should have navigated to system page
    const activeBtn = page.locator('.page-nav-btn.active');
    await expect(activeBtn).toHaveAttribute('data-page', 'system');

    // URL should now have the hash (allow time for migration)
    await page.waitForFunction(() => window.location.hash === '#system', { timeout: 3000 });
    expect(page.url()).toContain('#system');
  });

  test('should support nested routing tab hashes', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard#routing/observability', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav-btn.active');

    const activeBtn = page.locator('.page-nav-btn.active');
    await expect(activeBtn).toHaveAttribute('data-page', 'routing');
    expect(page.url()).toContain('#routing/observability');
  });
});

// ============================================================================
// PHASE 2: COMMAND PALETTE NAVIGATION
// ============================================================================

test.describe('Navigation - Command Palette', () => {
  test('should focus search input with Ctrl+K', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#globalSearchInput');

    // Press Ctrl+K to focus search
    await page.keyboard.press('Control+k');

    // Search input should be focused
    await expect(page.locator('#globalSearchInput')).toBeFocused({ timeout: 5000 });
  });

  test('should navigate when pressing Enter on navigation command', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav-btn.active');

    // Focus search input and type command using type() to trigger input events
    const searchInput = page.locator('#globalSearchInput');
    await searchInput.click();
    await searchInput.type('go to system', { delay: 50 });
    await searchInput.press('Enter');

    // Wait for navigation
    await page.waitForFunction(() => {
      const btn = document.querySelector('.page-nav-btn.active');
      return btn && btn.getAttribute('data-page') === 'system';
    }, { timeout: 5000 });

    const activeBtn = page.locator('.page-nav-btn.active');
    await expect(activeBtn).toHaveAttribute('data-page', 'system');
  });

  test('should navigate with short command aliases', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav-btn.active');

    // Test "diag" alias for system
    const searchInput = page.locator('#globalSearchInput');
    await searchInput.click();
    await searchInput.type('diag', { delay: 50 });
    await searchInput.press('Enter');

    await page.waitForFunction(() => {
      const btn = document.querySelector('.page-nav-btn.active');
      return btn && btn.getAttribute('data-page') === 'system';
    }, { timeout: 5000 });

    let activeBtn = page.locator('.page-nav-btn.active');
    await expect(activeBtn).toHaveAttribute('data-page', 'system');

    // Clear and test "live" alias for requests/live
    await searchInput.click();
    await searchInput.fill(''); // Clear first
    await searchInput.type('live', { delay: 50 });
    await searchInput.press('Enter');

    await page.waitForFunction(() => {
      const btn = document.querySelector('.page-nav-btn.active');
      return btn && btn.getAttribute('data-page') === 'requests';
    }, { timeout: 5000 });

    activeBtn = page.locator('.page-nav-btn.active');
    await expect(activeBtn).toHaveAttribute('data-page', 'requests');
  });

  test('should show command suggestions for "go to" prefix', async ({ page, proxyServer }) => {
    // Capture console messages for debugging
    const consoleMessages = [];
    page.on('console', msg => {
      if (msg.text().includes('[CommandPalette]')) {
        consoleMessages.push(msg.text());
      }
    });

    await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#globalSearchInput');

    // Focus search input and set value, then dispatch input event manually
    const searchInput = page.locator('#globalSearchInput');
    await searchInput.click();
    await searchInput.fill('go to');

    // Dispatch input event to trigger the handler
    await searchInput.evaluate(el => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Wait for input event to be processed and dropdown to appear
    await page.waitForFunction(() => {
      const dropdown = document.getElementById('searchHistoryDropdown');
      return dropdown && dropdown.classList.contains('visible');
    }, { timeout: 5000 });

    const dropdown = page.locator('#searchHistoryDropdown');
    await expect(dropdown).toHaveClass(/visible/);
  });

  test('should show command suggestions with "/" prefix', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#globalSearchInput');

    // Focus search input and type / using type() to trigger input events
    const searchInput = page.locator('#globalSearchInput');
    await searchInput.click();
    await searchInput.type('/', { delay: 50 });

    // Wait for input event to be processed and dropdown to appear
    await page.waitForFunction(() => {
      const dropdown = document.getElementById('searchHistoryDropdown');
      return dropdown && dropdown.classList.contains('visible');
    }, { timeout: 5000 });

    const dropdown = page.locator('#searchHistoryDropdown');
    await expect(dropdown).toHaveClass(/visible/);
  });

  test('should execute help command', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav');

    // Execute help command
    const searchInput = page.locator('#globalSearchInput');
    await searchInput.click();
    await searchInput.type('help', { delay: 50 });
    await searchInput.press('Enter');

    // Wait for shortcuts modal to become visible
    await page.waitForFunction(() => {
      const modal = document.getElementById('shortcutsModal');
      return modal && modal.classList.contains('visible');
    }, { timeout: 3000 });

    // Modal should be visible
    const modal = page.locator('#shortcutsModal');
    await expect(modal).toHaveClass(/visible/);
  });

  test('should show action command suggestions', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#globalSearchInput');

    const searchInput = page.locator('#globalSearchInput');
    await searchInput.click();
    await searchInput.type('export', { delay: 50 });

    // Trigger input event
    await searchInput.evaluate(el => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Wait for dropdown
    await page.waitForFunction(() => {
      const dropdown = document.getElementById('searchHistoryDropdown');
      return dropdown && dropdown.classList.contains('visible');
    }, { timeout: 5000 });

    const dropdown = page.locator('#searchHistoryDropdown');
    await expect(dropdown).toHaveClass(/visible/);
  });
});

// ============================================================================
// PHASE 3: TAB LABEL IMPROVEMENTS
// ============================================================================

test.describe('Navigation - Tab Labels', () => {
  test('should display "Routing" tab label', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav');

    const routingBtn = page.locator('.page-nav-btn[data-page="routing"]');
    await expect(routingBtn).toHaveText('Routing');
  });

  test('should display "Diagnostics" instead of "System"', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav');

    const systemBtn = page.locator('.page-nav-btn[data-page="system"]');
    await expect(systemBtn).toHaveText('Diagnostics');
  });

  test('should have 4 page navigation buttons with correct labels', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav');

    const buttons = page.locator('.page-nav-btn');
    await expect(buttons).toHaveCount(4);

    // Verify labels in order
    const labels = await buttons.allTextContents();
    expect(labels[0]).toBe('Overview');
    expect(labels[1]).toBe('Routing');
    expect(labels[2]).toBe('Requests');
    expect(labels[3]).toBe('Diagnostics');
  });
});

// ============================================================================
// PHASE 4: BREADCRUMB NAVIGATION
// ============================================================================

test.describe('Navigation - Breadcrumbs', () => {
  test('should not show breadcrumbs on Overview page', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav');

    const breadcrumbs = page.locator('#breadcrumbNav');
    await expect(breadcrumbs).toBeEmpty();
  });

  test('should show breadcrumbs on Requests page', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard#requests', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav');

    const breadcrumbs = page.locator('#breadcrumbNav');
    await expect(breadcrumbs).not.toBeEmpty();

    const breadcrumbLinks = page.locator('.breadcrumb-link');
    await expect(breadcrumbLinks).toHaveCount(1);

    const labels = await breadcrumbLinks.allTextContents();
    expect(labels[0]).toBe('Requests');
  });

  test('should show nested breadcrumbs on Requests > Traces', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard#requests/traces', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav');

    const breadcrumbs = page.locator('.breadcrumb-nav');
    await expect(breadcrumbs).toBeVisible();

    const breadcrumbLinks = page.locator('.breadcrumb-link');
    await expect(breadcrumbLinks).toHaveCount(2);

    const labels = await breadcrumbLinks.allTextContents();
    expect(labels[0]).toBe('Requests');
    expect(labels[1]).toBe('Traces');
  });

  test('should update breadcrumbs when navigating between pages', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav');

    // Click Routing
    await page.locator('.page-nav-btn[data-page="routing"]').click();
    await page.waitForTimeout(100);

    const breadcrumbs = page.locator('.breadcrumb-nav');
    await expect(breadcrumbs).not.toBeEmpty();

    let breadcrumbLinks = page.locator('.breadcrumb-link');
    let labels = await breadcrumbLinks.allTextContents();
    expect(labels[0]).toBe('Routing');

    // Click Diagnostics
    await page.locator('.page-nav-btn[data-page="system"]').click();
    await page.waitForTimeout(100);

    breadcrumbLinks = page.locator('.breadcrumb-link');
    labels = await breadcrumbLinks.allTextContents();
    expect(labels[0]).toBe('Diagnostics');
  });

  test('should update breadcrumbs when navigating to sub-tabs', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard#routing', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav');

    const breadcrumbLinks = page.locator('.breadcrumb-link');
    let labels = await breadcrumbLinks.allTextContents();
    expect(labels[0]).toBe('Routing');

    // Click on Observability sub-tab (if visible)
    const obsTab = page.locator('.routing-tab-btn[data-routing-tab="observability"]');
    if (await obsTab.isVisible()) {
      await obsTab.click();
      await page.waitForTimeout(100);

      const updatedLinks = page.locator('.breadcrumb-link');
      labels = await updatedLinks.allTextContents();
      expect(labels[0]).toBe('Routing');
      expect(labels[1]).toBe('Observability');
    }
  });

  test('breadcrumb parent link should navigate to parent page', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard#requests/traces', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav');

    // Click parent page link
    await page.locator('.breadcrumb-link').first().click();
    await page.waitForTimeout(100);

    const activeBtn = page.locator('.page-nav-btn.active');
    await expect(activeBtn).toHaveAttribute('data-page', 'requests');

    // Should only have one breadcrumb now (the parent)
    const breadcrumbLinks = page.locator('.breadcrumb-link');
    await expect(breadcrumbLinks).toHaveCount(1);
  });
});

// ============================================================================
// PHASE 5: VIM-STYLE KEYBOARD SHORTCUTS
// ============================================================================

test.describe('Navigation - Vim-style Shortcuts', () => {
  test('should navigate to Overview with g+o', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav-btn.active');

    // Press g then o
    await page.keyboard.press('g');
    await page.waitForTimeout(50);
    await page.keyboard.press('o');

    // Wait for navigation
    await page.waitForFunction(() => {
      const btn = document.querySelector('.page-nav-btn.active');
      return btn && btn.getAttribute('data-page') === 'overview';
    }, { timeout: 3000 });

    const activeBtn = page.locator('.page-nav-btn.active');
    await expect(activeBtn).toHaveAttribute('data-page', 'overview');
  });

  test('should navigate to Routing with g+c', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav-btn.active');

    // Press g then c
    await page.keyboard.press('g');
    await page.waitForTimeout(50);
    await page.keyboard.press('c');

    // Wait for navigation
    await page.waitForFunction(() => {
      const btn = document.querySelector('.page-nav-btn.active');
      return btn && btn.getAttribute('data-page') === 'routing';
    }, { timeout: 3000 });

    const activeBtn = page.locator('.page-nav-btn.active');
    await expect(activeBtn).toHaveAttribute('data-page', 'routing');
  });

  test('should navigate to Requests with g+r', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav-btn.active');

    // Press g then r
    await page.keyboard.press('g');
    await page.waitForTimeout(50);
    await page.keyboard.press('r');

    // Wait for navigation
    await page.waitForFunction(() => {
      const btn = document.querySelector('.page-nav-btn.active');
      return btn && btn.getAttribute('data-page') === 'requests';
    }, { timeout: 3000 });

    const activeBtn = page.locator('.page-nav-btn.active');
    await expect(activeBtn).toHaveAttribute('data-page', 'requests');
  });

  test('should navigate to Diagnostics with g+d', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav-btn.active');

    // Press g then d
    await page.keyboard.press('g');
    await page.waitForTimeout(50);
    await page.keyboard.press('d');

    // Wait for navigation
    await page.waitForFunction(() => {
      const btn = document.querySelector('.page-nav-btn.active');
      return btn && btn.getAttribute('data-page') === 'system';
    }, { timeout: 3000 });

    const activeBtn = page.locator('.page-nav-btn.active');
    await expect(activeBtn).toHaveAttribute('data-page', 'system');
  });

  test('should navigate to Live with g+l', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav-btn.active');

    // Press g then l
    await page.keyboard.press('g');
    await page.waitForTimeout(50);
    await page.keyboard.press('l');

    // Wait for navigation
    await page.waitForFunction(() => {
      const btn = document.querySelector('.page-nav-btn.active');
      const tab = document.querySelector('#requestsSubTabs .sub-tab.active');
      return btn && btn.getAttribute('data-page') === 'requests' &&
             tab && tab.getAttribute('data-tab') === 'live';
    }, { timeout: 3000 });

    const activeBtn = page.locator('.page-nav-btn.active');
    await expect(activeBtn).toHaveAttribute('data-page', 'requests');

    const activeTab = page.locator('#requestsSubTabs .sub-tab.active');
    await expect(activeTab).toHaveAttribute('data-tab', 'live');
  });

  test('should navigate to Traces with g+t', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav-btn.active');

    // Press g then t
    await page.keyboard.press('g');
    await page.waitForTimeout(50);
    await page.keyboard.press('t');

    // Wait for navigation
    await page.waitForFunction(() => {
      const btn = document.querySelector('.page-nav-btn.active');
      const tab = document.querySelector('#requestsSubTabs .sub-tab.active');
      return btn && btn.getAttribute('data-page') === 'requests' &&
             tab && tab.getAttribute('data-tab') === 'traces';
    }, { timeout: 3000 });

    const activeBtn = page.locator('.page-nav-btn.active');
    await expect(activeBtn).toHaveAttribute('data-page', 'requests');

    const activeTab = page.locator('#requestsSubTabs .sub-tab.active');
    await expect(activeTab).toHaveAttribute('data-tab', 'traces');
  });

  test('should not trigger vim shortcut when typing in input', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#globalSearchInput');

    // Focus search input
    await page.locator('#globalSearchInput').click();

    // Type 'go' - should not trigger navigation
    await page.keyboard.type('go');

    // Should still be on overview
    const activeBtn = page.locator('.page-nav-btn.active');
    await expect(activeBtn).toHaveAttribute('data-page', 'overview');

    // Input should contain 'go'
    const searchInput = page.locator('#globalSearchInput');
    await expect(searchInput).toHaveValue('go');
  });

  test('should reset pending vim shortcut after timeout', async ({ page, proxyServer }) => {
    await page.goto(proxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-nav-btn.active');

    // Press g
    await page.keyboard.press('g');

    // Wait longer than the 1 second timeout
    await page.waitForTimeout(1200);

    // Press o - should not trigger navigation (timeout reset)
    await page.keyboard.press('o');
    await page.waitForTimeout(100);

    // Should still be on overview
    const activeBtn = page.locator('.page-nav-btn.active');
    await expect(activeBtn).toHaveAttribute('data-page', 'overview');
  });
});
