/**
 * E2E Tests for Tier Validation and Time Range Switching
 * Tests that verify backend-to-frontend data synchronization
 */

const { test, expect } = require('./fixtures');

test.describe('Dashboard - Tier Validation', () => {
  test('should return tier metadata from history endpoint', async ({ page, proxyServer }) => {
    const proxyUrl = proxyServer.url;

    // Fetch history for different time ranges and verify tier metadata
    const ranges = [
      { minutes: 5, expectedTier: 'fine' },
      { minutes: 60, expectedTier: 'fine' },
      { minutes: 120, expectedTier: 'medium' },
      { minutes: 1440, expectedTier: 'medium' },
      { minutes: 2000, expectedTier: 'coarse' }
    ];

    for (const { minutes, expectedTier } of ranges) {
      const response = await page.request.get(`${proxyUrl}/history?minutes=${minutes}`);
      const history = await response.json();

      expect(history).toHaveProperty('tier', expectedTier);
      expect(history).toHaveProperty('tierResolution');
      expect(history).toHaveProperty('expectedInterval');
      expect(history).toHaveProperty('expectedPointCount');
      expect(history).toHaveProperty('actualPointCount');
      expect(history).toHaveProperty('dataAgeMs');
      expect(history).toHaveProperty('schemaVersion', 2);
      expect(history).toHaveProperty('points');
    }
  });

  test('should switch time ranges and update charts', async ({ page, proxyServer }) => {
    const proxyUrl = proxyServer.url;
    await page.goto(proxyUrl + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });

    // Wait for initial load
    await expect(page.getByTestId('time-range')).toBeVisible();

    // Click different time range buttons
    const timeRanges = ['5m', '15m', '1h', '6h', '24h'];

    for (const range of timeRanges) {
      // Use first() to avoid strict mode violation (multiple data-range elements on page)
      await page.click(`[data-range="${range}"] >> nth=0`);

      // Wait for the button to become active
      await expect(page.locator(`[data-range="${range}"] >> nth=0`)).toHaveClass(/active/);

      // Verify the time label updates
      const timeLabel = await page.locator('#chartTimeLabel').textContent();
      expect(timeLabel).toBeTruthy();

      // Small delay to allow charts to update
      await page.waitForTimeout(100);
    }
  });

  test('should show data quality indicators', async ({ page, proxyServer }) => {
    const proxyUrl = proxyServer.url;
    await page.goto(proxyUrl + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });

    // Check for data quality indicators (new feature)
    const indicator = page.locator('#dataQualityIndicator');
    const indicator2 = page.locator('#dataQualityIndicator2');
    const indicator3 = page.locator('#dataQualityIndicator3');

    // Should exist (even if empty initially)
    expect(await indicator.count()).toBeGreaterThan(0);
    expect(await indicator2.count()).toBeGreaterThan(0);
    expect(await indicator3.count()).toBeGreaterThan(0);
  });

  test('should handle tier transitions when switching time ranges', async ({ page, proxyServer }) => {
    const proxyUrl = proxyServer.url;
    await page.goto(proxyUrl + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });

    // Start with fine tier (5m)
    await page.click('[data-range="5m"]');
    await page.waitForTimeout(200);

    // Get history response for fine tier
    const fineResponse = await page.request.get(`${proxyUrl}/history?minutes=5`);
    const fineHistory = await fineResponse.json();
    expect(fineHistory.tier).toBe('fine');

    // Switch to medium tier (6h)
    await page.click('[data-range="6h"]');
    await page.waitForTimeout(200);

    const mediumResponse = await page.request.get(`${proxyUrl}/history?minutes=360`);
    const mediumHistory = await mediumResponse.json();
    expect(mediumHistory.tier).toBe('medium');

    // Switch to coarse tier (7d)
    await page.click('[data-range="7d"]');
    await page.waitForTimeout(200);

    const coarseResponse = await page.request.get(`${proxyUrl}/history?minutes=10080`);
    const coarseHistory = await coarseResponse.json();
    expect(coarseHistory.tier).toBe('coarse');
  });

  test('should have consistent data point counts with tier resolution', async ({ page, proxyServer }) => {
    const proxyUrl = proxyServer.url;
    // Test that expectedPointCount matches the tier resolution
    const cases = [
      { minutes: 5, tier: 'fine', expectedResolution: 1 },
      { minutes: 120, tier: 'medium', expectedResolution: 10 },
      { minutes: 2000, tier: 'coarse', expectedResolution: 60 }
    ];

    for (const { minutes, tier, expectedResolution } of cases) {
      const response = await page.request.get(`${proxyUrl}/history?minutes=${minutes}`);
      const history = await response.json();

      expect(history.tier).toBe(tier);
      expect(history.tierResolution).toBe(expectedResolution);

      // Expected point count should be minutes * 60 / resolution
      const expectedPoints = Math.ceil((minutes * 60) / expectedResolution);
      expect(history.expectedPointCount).toBe(expectedPoints);
    }
  });

  test('should include schema version in all history responses', async ({ page, proxyServer }) => {
    const proxyUrl = proxyServer.url;
    const endpoints = [
      '/history?minutes=5',
      '/history?minutes=60',
      '/history?minutes=1440',
      '/history?minutes=10080'
    ];

    for (const endpoint of endpoints) {
      const response = await page.request.get(`${proxyUrl}${endpoint}`);
      const history = await response.json();

      expect(history).toHaveProperty('schemaVersion');
      expect(history.schemaVersion).toBe(2);
    }
  });

  test('charts should render without errors when switching time ranges', async ({ page, proxyServer }) => {
    const proxyUrl = proxyServer.url;
    await page.goto(proxyUrl + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });

    // Monitor for console errors
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    // Switch through all time ranges
    const ranges = ['5m', '15m', '1h', '6h', '24h', '7d'];
    for (const range of ranges) {
      await page.click(`[data-range="${range}"]`);
      await page.waitForTimeout(300);
    }

    // Check for any critical errors
    const criticalErrors = errors.filter(e =>
      e.includes('TypeError') ||
      e.includes('ReferenceError') ||
      e.includes('Cannot read')
    );

    expect(criticalErrors).toHaveLength(0);
  });
});

test.describe('Dashboard - History Data Integrity', () => {
  test('should handle empty history gracefully', async ({ page, proxyServer }) => {
    const proxyUrl = proxyServer.url;
    // Request a very small time window that might have no data
    const response = await page.request.get(`${proxyUrl}/history?minutes=0.001`);
    const history = await response.json();

    expect(history).toHaveProperty('points');
    expect(Array.isArray(history.points)).toBe(true);
    expect(history).toHaveProperty('tier');
    expect(history).toHaveProperty('schemaVersion', 2);
  });

  test('should have dataAgeMs property tracking freshness', async ({ page, proxyServer }) => {
    const proxyUrl = proxyServer.url;
    const response = await page.request.get(`${proxyUrl}/history?minutes=5`);
    const history = await response.json();

    expect(history).toHaveProperty('dataAgeMs');

    // If we have points, dataAgeMs should be a reasonable number
    if (history.pointCount > 0) {
      expect(history.dataAgeMs).toBeGreaterThanOrEqual(0);
      expect(history.dataAgeMs).toBeLessThan(60000); // Less than 1 minute old ideally
    } else {
      expect(history.dataAgeMs).toBe(Infinity);
    }
  });

  test('should include actualPointCount separate from pointCount', async ({ page, proxyServer }) => {
    const proxyUrl = proxyServer.url;
    const response = await page.request.get(`${proxyUrl}/history?minutes=60`);
    const history = await response.json();

    // pointCount is after filtering by time and optional downsampling
    expect(history).toHaveProperty('pointCount');
    expect(history.pointCount).toBeGreaterThanOrEqual(0);

    // actualPointCount is the raw count before downsampling
    expect(history).toHaveProperty('actualPointCount');
    expect(history.actualPointCount).toBeGreaterThanOrEqual(0);

    // actualPointCount should be >= pointCount
    expect(history.actualPointCount).toBeGreaterThanOrEqual(history.pointCount);
  });
});
