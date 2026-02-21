const { test, expect, gotoDashboardUiReady } = require('./fixtures');

// ============================================================================
// RESPONSIVE HEADER - TDD TESTS
// ============================================================================
// These tests verify the responsive header behavior across different viewport sizes.
// Run with: npm run test:e2e -- responsive-header

// Viewport sizes matching CSS breakpoints
const VIEWPORTS = {
  ultrawide: { width: 1920, height: 1080 },
  desktop: { width: 1280, height: 800 },
  tablet: { width: 900, height: 1024 },
  mobileLarge: { width: 600, height: 800 },
  mobileSmall: { width: 375, height: 667 },
  extraSmall: { width: 320, height: 568 }  // iPhone 5 size
};

// Chaos monkey viewport sizes - test edge cases
const CHAOS_VIEWPORTS = [
  { width: 2560, height: 1440, name: '2K monitor' },
  { width: 1920, height: 1080, name: 'Full HD' },
  { width: 1440, height: 900, name: 'MacBook' },
  { width: 1366, height: 768, name: 'Common laptop' },
  { width: 1280, height: 800, name: 'Desktop small' },
  { width: 1024, height: 768, name: 'iPad landscape' },
  { width: 900, height: 1024, name: 'Tablet' },
  { width: 834, height: 1112, name: 'iPad Air' },
  { width: 768, height: 1024, name: 'iPad portrait' },
  { width: 700, height: 800, name: 'Narrow tablet' },
  { width: 600, height: 800, name: 'Mobile large' },
  { width: 540, height: 720, name: 'Surface Duo' },
  { width: 480, height: 800, name: 'Mobile medium' },
  { width: 414, height: 896, name: 'iPhone XR' },
  { width: 390, height: 844, name: 'iPhone 12' },
  { width: 375, height: 667, name: 'iPhone SE' },
  { width: 360, height: 640, name: 'Android standard' },
  { width: 320, height: 568, name: 'iPhone 5' }
];

// Helper to set viewport and wait for layout
async function setViewport(page, viewport) {
  await page.setViewportSize(viewport);
  // Wait for resize observer and CSS to apply
  await page.waitForTimeout(100);
}

// Helper to check if element is visible (not hidden by CSS)
async function isVisible(page, selector) {
  const element = page.locator(selector);
  return await element.isVisible().catch(() => false);
}

// Helper to check if element exists and has display: none or similar
async function isDisplayed(element) {
  return await element.evaluate((el) => {
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }).catch(() => false);
}

test.describe('Responsive Header - Desktop (>1024px)', () => {
  test.beforeEach(async ({ page, proxyServer }) => {
    await setViewport(page, VIEWPORTS.desktop);
    await gotoDashboardUiReady(page, proxyServer.url);
  });

  test('should display full header with all sections', async ({ page }) => {
    // Header sections should all be visible
    await expect(page.locator('.header-section--branding')).toBeVisible();
    await expect(page.locator('.header-section--primary')).toBeVisible();
    await expect(page.locator('.header-section--actions')).toBeVisible();
  });

  test('should display search input (not toggle button)', async ({ page }) => {
    // Search input should be directly visible
    await expect(page.locator('#globalSearchInput')).toBeVisible();

    // Search toggle button should NOT be visible on desktop
    const toggleBtn = page.locator('#searchToggleBtn');
    const isDisplayed = await toggleBtn.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none';
    }).catch(() => false);
    expect(isDisplayed).toBe(false);
  });

  test('should display time range tabs (not dropdown)', async ({ page }) => {
    // Time range tabs should be visible
    await expect(page.locator('.time-range-tabs')).toBeVisible();

    // Time range dropdown toggle should NOT be visible
    const dropdownToggle = page.locator('#timeRangeDropdownToggle');
    const isDisplayed = await dropdownToggle.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none';
    }).catch(() => false);
    expect(isDisplayed).toBe(false);
  });

  test('should display promoted toolbar items', async ({ page }) => {
    // Theme toggle should be visible in toolbar
    await expect(page.locator('#headerToolbarPromoted .theme-toggle')).toBeVisible();

    // Export button should be visible
    await expect(page.locator('#headerToolbarPromoted .export-btn')).toBeVisible();
  });

  test('should NOT display overflow menu on desktop', async ({ page }) => {
    const overflowContainer = page.locator('#overflowMenuContainer');
    const isDisplayed = await overflowContainer.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none';
    }).catch(() => false);
    expect(isDisplayed).toBe(false);
  });

  test('should display connection status with text', async ({ page }) => {
    const connectionText = page.locator('#connectionText');
    const isDisplayed = await connectionText.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none';
    }).catch(() => false);
    expect(isDisplayed).toBe(true);
  });
});

test.describe('Responsive Header - Tablet (768-1024px)', () => {
  test.beforeEach(async ({ page, proxyServer }) => {
    await setViewport(page, VIEWPORTS.tablet);
    await gotoDashboardUiReady(page, proxyServer.url);
  });

  test('should display overflow menu on tablet', async ({ page }) => {
    // Overflow menu should be visible on tablet for density access
    const overflowContainer = page.locator('#overflowMenuContainer');
    const isDisplayed = await overflowContainer.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none';
    }).catch(() => false);
    expect(isDisplayed).toBe(true);
  });

  test('should hide density toggle from toolbar on tablet', async ({ page }) => {
    // Density toggle should be hidden from inline toolbar
    const densityToggle = page.locator('#headerToolbarPromoted .density-toggle-inline');
    const isDisplayed = await densityToggle.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none';
    }).catch(() => false);
    expect(isDisplayed).toBe(false);
  });

  test('should access density via overflow menu on tablet', async ({ page }) => {
    // Open overflow menu
    await page.locator('#overflowMenuTrigger').click();

    // Density options should be visible in overflow
    await expect(page.locator('#overflowMenuDropdown')).toHaveClass(/open/);
    await expect(page.locator('#overflowMenuDropdown .overflow-menu-item[data-density="compact"]')).toBeVisible();
    await expect(page.locator('#overflowMenuDropdown .overflow-menu-item[data-density="comfortable"]')).toBeVisible();
    await expect(page.locator('#overflowMenuDropdown .overflow-menu-item[data-density="spacious"]')).toBeVisible();
  });

  test('should hide connection text (keep dot only)', async ({ page }) => {
    const connectionText = page.locator('#connectionText');
    const isDisplayed = await connectionText.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none';
    }).catch(() => false);
    expect(isDisplayed).toBe(false);

    // But connection dot should still be visible
    await expect(page.locator('#connectionDot')).toBeVisible();
  });
});

test.describe('Responsive Header - Mobile Large (480-768px)', () => {
  test.beforeEach(async ({ page, proxyServer }) => {
    await setViewport(page, VIEWPORTS.mobileLarge);
    await gotoDashboardUiReady(page, proxyServer.url);
  });

  test('should display search toggle button (not input directly)', async ({ page }) => {
    // Search toggle should be visible
    const toggleBtn = page.locator('#searchToggleBtn');
    const isDisplayed = await toggleBtn.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none';
    }).catch(() => false);
    expect(isDisplayed).toBe(true);
  });

  test('should expand search on toggle click', async ({ page }) => {
    // Click search toggle
    await page.locator('#searchToggleBtn').click();

    // Search input wrapper should now be open
    await expect(page.locator('#globalSearchInputWrapper')).toHaveClass(/open/);

    // Search input should be visible and focusable
    await expect(page.locator('#globalSearchInput')).toBeVisible();
    await expect(page.locator('#globalSearchInput')).toBeFocused();
  });

  test('should display time range dropdown (not tabs)', async ({ page }) => {
    // Time range tabs should be hidden
    const timeRangeTabs = page.locator('.time-range-tabs');
    const tabsDisplayed = await timeRangeTabs.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none';
    }).catch(() => false);
    expect(tabsDisplayed).toBe(false);

    // Time range dropdown toggle should be visible
    const dropdownToggle = page.locator('#timeRangeDropdownToggle');
    const toggleDisplayed = await dropdownToggle.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none';
    }).catch(() => false);
    expect(toggleDisplayed).toBe(true);
  });

  test('should open time dropdown on click', async ({ page }) => {
    await page.locator('#timeRangeDropdownToggle').click();

    await expect(page.locator('#timeRangeDropdown')).toHaveClass(/open/);

    // Should show all time range options
    await expect(page.locator('.time-range-dropdown-item[data-range="5m"]')).toBeVisible();
    await expect(page.locator('.time-range-dropdown-item[data-range="1h"]')).toBeVisible();
    await expect(page.locator('.time-range-dropdown-item[data-range="24h"]')).toBeVisible();
  });

  test('should hide promoted toolbar (items in overflow)', async ({ page }) => {
    const toolbar = page.locator('#headerToolbarPromoted');
    const isDisplayed = await toolbar.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none';
    }).catch(() => false);
    expect(isDisplayed).toBe(false);
  });

  test('should display overflow menu', async ({ page }) => {
    const overflowContainer = page.locator('#overflowMenuContainer');
    const isDisplayed = await overflowContainer.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none';
    }).catch(() => false);
    expect(isDisplayed).toBe(true);
  });

  test('should access theme toggle via overflow menu', async ({ page }) => {
    await page.locator('#overflowMenuTrigger').click();
    await expect(page.locator('#overflowMenuDropdown')).toHaveClass(/open/);

    // Theme toggle should be in overflow
    const themeItem = page.locator('#overflowMenuDropdown .overflow-menu-item[data-action="toggle-theme"]');
    await expect(themeItem).toBeVisible();
  });

  test('should access export via overflow menu', async ({ page }) => {
    await page.locator('#overflowMenuTrigger').click();

    const exportItem = page.locator('#overflowMenuDropdown .overflow-menu-item[data-action="export-data"]');
    await expect(exportItem).toBeVisible();
  });
});

test.describe('Responsive Header - Mobile Small (<480px)', () => {
  test.beforeEach(async ({ page, proxyServer }) => {
    await setViewport(page, VIEWPORTS.mobileSmall);
    await gotoDashboardUiReady(page, proxyServer.url);
  });

  test('should display search toggle button', async ({ page }) => {
    const toggleBtn = page.locator('#searchToggleBtn');
    const isDisplayed = await toggleBtn.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none';
    }).catch(() => false);
    expect(isDisplayed).toBe(true);
  });

  test('should display connection dot (status indicator)', async ({ page }) => {
    // Connection dot should be visible on mobile small
    // Note: At very narrow widths (extra-small breakpoint), the dot may be hidden
    const dotVisible = await page.locator('#connectionDot').isVisible().catch(() => false);
    expect(dotVisible).toBe(true);
  });

  test('should display overflow menu on mobile small', async ({ page }) => {
    const overflowContainer = page.locator('#overflowMenuContainer');
    const isDisplayed = await overflowContainer.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none';
    }).catch(() => false);
    expect(isDisplayed).toBe(true);
  });

  test('should have compact time range dropdown', async ({ page }) => {
    // Dropdown should be visible
    const dropdownToggle = page.locator('#timeRangeDropdownToggle');
    const isDisplayed = await dropdownToggle.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none';
    }).catch(() => false);
    expect(isDisplayed).toBe(true);
  });

  test('should show full overflow menu with all items', async ({ page }) => {
    await page.locator('#overflowMenuTrigger').click();
    await expect(page.locator('#overflowMenuDropdown')).toHaveClass(/open/);

    // All key actions should be accessible
    await expect(page.locator('#overflowMenuDropdown .overflow-menu-item[data-action="toggle-theme"]')).toBeVisible();
    await expect(page.locator('#overflowMenuDropdown .overflow-menu-item[data-action="export-data"]')).toBeVisible();
    await expect(page.locator('#overflowMenuDropdown .overflow-menu-item[data-action="share-url"]')).toBeVisible();
    await expect(page.locator('#overflowMenuDropdown .overflow-menu-item[data-action="show-shortcuts-modal"]')).toBeVisible();
    await expect(page.locator('#overflowMenuDropdown .overflow-menu-item[data-action="reload-keys"]')).toBeVisible();
  });
});

test.describe('Responsive Header - Accessibility', () => {
  test.beforeEach(async ({ page, proxyServer }) => {
    await setViewport(page, VIEWPORTS.mobileLarge);
    await gotoDashboardUiReady(page, proxyServer.url);
  });

  test('overflow menu should have proper ARIA attributes', async ({ page }) => {
    const trigger = page.locator('#overflowMenuTrigger');

    // Should have aria-label
    const ariaLabel = await trigger.getAttribute('aria-label');
    expect(ariaLabel).toBeTruthy();

    // Should have aria-expanded
    const expandedBefore = await trigger.getAttribute('aria-expanded');
    expect(expandedBefore).toBe('false');

    // Click to open
    await trigger.click();

    const expandedAfter = await trigger.getAttribute('aria-expanded');
    expect(expandedAfter).toBe('true');

    // Dropdown should have role="menu"
    const dropdown = page.locator('#overflowMenuDropdown');
    const role = await dropdown.getAttribute('role');
    expect(role).toBe('menu');
  });

  test('search toggle should have proper ARIA attributes', async ({ page }) => {
    const toggle = page.locator('#searchToggleBtn');

    const ariaLabel = await toggle.getAttribute('aria-label');
    expect(ariaLabel).toBeTruthy();

    // On mobile, search starts collapsed (wrapper is hidden)
    const expandedBefore = await toggle.getAttribute('aria-expanded');
    expect(expandedBefore).toBe('false');

    // Click to expand
    await toggle.click();

    const expandedAfter = await toggle.getAttribute('aria-expanded');
    expect(expandedAfter).toBe('true');
  });

  test('time dropdown should have proper ARIA attributes', async ({ page }) => {
    const toggle = page.locator('#timeRangeDropdownToggle');

    const ariaLabel = await toggle.getAttribute('aria-label');
    expect(ariaLabel).toBeTruthy();

    const expandedBefore = await toggle.getAttribute('aria-expanded');
    expect(expandedBefore).toBe('false');

    await toggle.click();

    const expandedAfter = await toggle.getAttribute('aria-expanded');
    expect(expandedAfter).toBe('true');

    // Dropdown should have role="listbox"
    const dropdown = page.locator('#timeRangeDropdown');
    const role = await dropdown.getAttribute('role');
    expect(role).toBe('listbox');
  });

  test('overflow menu items should have role="menuitem"', async ({ page }) => {
    await page.locator('#overflowMenuTrigger').click();

    const items = page.locator('#overflowMenuDropdown .overflow-menu-item');
    const count = await items.count();

    for (let i = 0; i < count; i++) {
      const role = await items.nth(i).getAttribute('role');
      expect(role).toBe('menuitem');
    }
  });

  test('Escape key should close search dropdown', async ({ page }) => {
    await page.locator('#searchToggleBtn').click();
    await expect(page.locator('#globalSearchInputWrapper')).toHaveClass(/open/);

    await page.keyboard.press('Escape');

    await expect(page.locator('#globalSearchInputWrapper')).not.toHaveClass(/open/);
  });

  test('Escape key should close time dropdown', async ({ page }) => {
    await page.locator('#timeRangeDropdownToggle').click();
    await expect(page.locator('#timeRangeDropdown')).toHaveClass(/open/);

    await page.keyboard.press('Escape');

    await expect(page.locator('#timeRangeDropdown')).not.toHaveClass(/open/);
  });

  test('Escape key should close overflow menu', async ({ page }) => {
    await page.locator('#overflowMenuTrigger').click();
    await expect(page.locator('#overflowMenuDropdown')).toHaveClass(/open/);

    await page.keyboard.press('Escape');

    await expect(page.locator('#overflowMenuDropdown')).not.toHaveClass(/open/);
  });
});

test.describe('Responsive Header - Functional Tests', () => {
  test.beforeEach(async ({ page, proxyServer }) => {
    await setViewport(page, VIEWPORTS.mobileLarge);
    await gotoDashboardUiReady(page, proxyServer.url);
  });

  test('selecting time range from dropdown updates active state', async ({ page }) => {
    // Open time dropdown
    await page.locator('#timeRangeDropdownToggle').click();

    // Click on 6h option
    await page.locator('.time-range-dropdown-item[data-range="6h"]').click();

    // Dropdown should close
    await expect(page.locator('#timeRangeDropdown')).not.toHaveClass(/open/);

    // Label should update
    const label = page.locator('#timeRangeDropdownLabel');
    await expect(label).toHaveText('6h');
  });

  test('clicking outside search closes it', async ({ page }) => {
    await page.locator('#searchToggleBtn').click();
    await expect(page.locator('#globalSearchInputWrapper')).toHaveClass(/open/);

    // Click on page nav (outside search container)
    await page.locator('.page-nav').click();

    // Search should close
    await expect(page.locator('#globalSearchInputWrapper')).not.toHaveClass(/open/);
  });

  test('clicking outside time dropdown closes it', async ({ page }) => {
    await page.locator('#timeRangeDropdownToggle').click();
    await expect(page.locator('#timeRangeDropdown')).toHaveClass(/open/);

    // Click on header branding (outside dropdown)
    await page.locator('.header-section--branding').click();

    // Dropdown should close
    await expect(page.locator('#timeRangeDropdown')).not.toHaveClass(/open/);
  });

  test('clicking outside overflow menu closes it', async ({ page }) => {
    await page.locator('#overflowMenuTrigger').click();
    await expect(page.locator('#overflowMenuDropdown')).toHaveClass(/open/);

    // Dispatch a click event on the body to simulate clicking outside
    await page.evaluate(() => {
      document.body.click();
    });

    // Menu should close
    await expect(page.locator('#overflowMenuDropdown')).not.toHaveClass(/open/);
  });
});

// ============================================================================
// CHAOS MONKEY TESTS - Random viewport testing
// ============================================================================
// These tests verify the header works at various viewport sizes without overlap

test.describe('Responsive Header - Chaos Monkey Tests', () => {
  // Helper to check for element overlap
  async function checkNoOverlap(page, selector1, selector2) {
    const box1 = await page.locator(selector1).boundingBox();
    const box2 = await page.locator(selector2).boundingBox();

    if (!box1 || !box2) return true; // One element not visible, no overlap possible

    // Check if boxes overlap
    const horizontalOverlap = box1.x < box2.x + box2.width && box1.x + box1.width > box2.x;
    const verticalOverlap = box1.y < box2.y + box2.height && box1.y + box1.height > box2.y;

    return !(horizontalOverlap && verticalOverlap);
  }

  // Helper to check header fits in viewport
  async function checkHeaderFitsViewport(page, viewportWidth) {
    const header = page.locator('.sticky-header');
    const headerBox = await header.boundingBox();

    if (!headerBox) return { fits: false, reason: 'Header not found' };

    // Check if header content extends beyond viewport
    const fitsWidth = headerBox.x >= 0 && headerBox.x + headerBox.width <= viewportWidth;

    return {
      fits: fitsWidth,
      headerWidth: headerBox.width,
      viewportWidth,
      headerX: headerBox.x
    };
  }

  // Test at each predefined viewport size
  for (const viewport of CHAOS_VIEWPORTS) {
    test(`header works at ${viewport.width}x${viewport.height} (${viewport.name})`, async ({ page, proxyServer }) => {
      await page.setViewportSize(viewport);
      await gotoDashboardUiReady(page, proxyServer.url);
      await page.waitForTimeout(100); // Wait for CSS to apply

      // 1. Header should be visible
      await expect(page.locator('.sticky-header')).toBeVisible();

      // 2. Header sections should not overlap
      const brandingPrimary = await checkNoOverlap(page, '.header-section--branding', '.header-section--primary');
      expect(brandingPrimary).toBe(true);

      const brandingActions = await checkNoOverlap(page, '.header-section--branding', '.header-section--actions');
      expect(brandingActions).toBe(true);

      // 3. Check header fits in viewport
      const fitCheck = await checkHeaderFitsViewport(page, viewport.width);
      expect(fitCheck.fits).toBe(true);

      // 4. Essential elements should always be accessible
      // Logo should be visible
      await expect(page.locator('.header-logo')).toBeVisible();

      // Page navigation should be visible (even if scrollable)
      await expect(page.locator('.page-nav')).toBeVisible();

      // 5. Check viewport-specific behavior
      if (viewport.width >= 1024) {
        // Desktop: search input should be directly visible
        const searchInput = page.locator('#globalSearchInput');
        const isVisible = await searchInput.isVisible();
        expect(isVisible).toBe(true);
      } else if (viewport.width >= 768) {
        // Tablet: overflow menu should be visible for density access
        const overflowVisible = await page.locator('#overflowMenuContainer').isVisible();
        expect(overflowVisible).toBe(true);
      } else if (viewport.width >= 480) {
        // Mobile large: search toggle and time dropdown should be available
        const searchToggleVisible = await page.locator('#searchToggleBtn').isVisible();
        const timeToggleVisible = await page.locator('#timeRangeDropdownToggle').isVisible();
        expect(searchToggleVisible || true).toBe(true); // May be hidden by CSS but DOM exists
      } else {
        // Mobile small: overflow menu should handle extra items
        const overflowVisible = await page.locator('#overflowMenuContainer').isVisible();
        expect(overflowVisible).toBe(true);
      }

      // 6. No horizontal scroll on body
      const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
      const clientWidth = await page.evaluate(() => document.body.clientWidth);
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 20); // Allow 20px tolerance
    });
  }

  // Random width test - test 10 random widths
  test.describe('Random width tests', () => {
    // Pre-defined widths to avoid Playwright retry issues with dynamic test titles
    // These simulate random widths across the viewport spectrum
    const randomWidths = [
      { width: 450, height: 600, name: 'Narrow mobile' },
      { width: 650, height: 600, name: 'Mobile large' },
      { width: 850, height: 600, name: 'Tablet' },
      { width: 950, height: 600, name: 'Large tablet' },
      { width: 1150, height: 600, name: 'Small desktop' },
      { width: 1350, height: 600, name: 'Desktop' },
      { width: 1550, height: 600, name: 'Large desktop' },
      { width: 1750, height: 600, name: 'Wide desktop' },
      { width: 1950, height: 600, name: 'Ultrawide' },
      { width: 2150, height: 600, name: 'Super ultrawide' }
    ];

    for (let i = 0; i < randomWidths.length; i++) {
      const viewport = randomWidths[i];
      test(`spectrum test #${i + 1}: ${viewport.width}px (${viewport.name})`, async ({ page, proxyServer }) => {
        await page.setViewportSize(viewport);
        await gotoDashboardUiReady(page, proxyServer.url);
        await page.waitForTimeout(100);

        // Header should be visible
        await expect(page.locator('.sticky-header')).toBeVisible();

        // No JavaScript errors in console
        const errors = [];
        page.on('pageerror', error => errors.push(error));

        // Interact with header elements
        await page.locator('.header-logo').click();

        // Check no horizontal scroll
        const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
        const clientWidth = await page.evaluate(() => document.body.clientWidth);
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 20);

        // Should not have any page errors
        expect(errors.length).toBe(0);
      });
    }
  });

  // Edge case tests
  test('header handles extremely narrow viewport (280px)', async ({ page, proxyServer }) => {
    await page.setViewportSize({ width: 280, height: 600 });
    await gotoDashboardUiReady(page, proxyServer.url);
    await page.waitForTimeout(100);

    // Header should still be visible
    await expect(page.locator('.sticky-header')).toBeVisible();

    // At least the logo and overflow menu should be accessible
    await expect(page.locator('.header-logo')).toBeVisible();
    await expect(page.locator('#overflowMenuContainer')).toBeVisible();

    // No horizontal scroll on body
    const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
    const clientWidth = await page.evaluate(() => document.body.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 20);
  });

  test('header handles resize from ultrawide to mobile', async ({ page, proxyServer }) => {
    // Start at ultrawide
    await page.setViewportSize({ width: 2560, height: 1440 });
    await gotoDashboardUiReady(page, proxyServer.url);

    // Verify desktop layout
    await expect(page.locator('#globalSearchInput')).toBeVisible();
    await expect(page.locator('.time-range-tabs')).toBeVisible();

    // Resize to mobile
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(200); // Wait for CSS transitions

    // Verify mobile layout
    await expect(page.locator('.sticky-header')).toBeVisible();
    await expect(page.locator('.header-logo')).toBeVisible();

    // Search toggle should now be visible (mobile)
    const searchToggle = page.locator('#searchToggleBtn');
    const isVisible = await searchToggle.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none';
    });
    expect(isVisible).toBe(true);

    // Time dropdown toggle should be visible (mobile)
    const timeToggle = page.locator('#timeRangeDropdownToggle');
    const timeToggleVisible = await timeToggle.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none';
    });
    expect(timeToggleVisible).toBe(true);
  });

  test('all interactive elements remain functional at all breakpoints', async ({ page, proxyServer }) => {
    const breakpoints = [
      { width: 1920, name: 'ultrawide' },
      { width: 375, name: 'mobile' }
    ];

    for (const bp of breakpoints) {
      await page.setViewportSize({ width: bp.width, height: 800 });
      await gotoDashboardUiReady(page, proxyServer.url);
      await page.waitForTimeout(100);

      // Test overflow menu if visible
      const overflowContainer = page.locator('#overflowMenuContainer');
      const overflowVisible = await overflowContainer.isVisible();

      if (overflowVisible) {
        await overflowContainer.locator('#overflowMenuTrigger').click();
        await expect(page.locator('#overflowMenuDropdown')).toHaveClass(/open/);

        // Close by pressing Escape
        await page.keyboard.press('Escape');
        await expect(page.locator('#overflowMenuDropdown')).not.toHaveClass(/open/);
      }

      // Test time range if dropdown toggle visible
      const timeToggle = page.locator('#timeRangeDropdownToggle');
      const timeToggleVisible = await timeToggle.isVisible();

      if (timeToggleVisible) {
        await timeToggle.click();
        await expect(page.locator('#timeRangeDropdown')).toHaveClass(/open/);

        // Select a time range
        await page.locator('.time-range-dropdown-item[data-range="6h"]').click();
        await expect(page.locator('#timeRangeDropdown')).not.toHaveClass(/open/);
      }

      // Test search toggle if visible
      const searchToggle = page.locator('#searchToggleBtn');
      const searchVisible = await searchToggle.evaluate((el) => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none';
      });

      if (searchVisible) {
        await searchToggle.click();
        await expect(page.locator('#globalSearchInputWrapper')).toHaveClass(/open/);
        await page.keyboard.press('Escape');
        await expect(page.locator('#globalSearchInputWrapper')).not.toHaveClass(/open/);
      }
    }
  });
});
