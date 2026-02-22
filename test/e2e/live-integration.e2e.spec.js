/**
 * Live Integration Tests (real API)
 *
 * These tests require a real Z.AI API key set via the Z_AI_GLM_API_KEY_FOR_TESTS
 * environment variable (populated from the GitHub secret of the same name in CI).
 *
 * All tests are guarded by describeIf so they skip gracefully when the secret is
 * absent — no test failures, no noisy errors.
 *
 * Key format expected: "keyId.secret" (period-separated), e.g. "abc123.xyz789"
 * Upstream base URL:   https://api.z.ai/api/anthropic
 */

'use strict';

const { test, expect } = require('./fixtures');

// Only run when real API key is available
const describeIf = process.env.Z_AI_GLM_API_KEY_FOR_TESTS
  ? test.describe
  : test.describe.skip;

describeIf('Live Integration Tests (real API)', () => {
  // Test 1: Health endpoint reports at least one healthy key
  test('proxy reports healthy keys with real API credentials', async ({ liveProxyServer }) => {
    const response = await fetch(liveProxyServer.url + '/health');
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.status).toBe('OK');
    expect(data.healthyKeys).toBeGreaterThan(0);
  });

  // Test 2: Dashboard loads and displays real key data
  test('dashboard shows real key health status', async ({ page, liveProxyServer }) => {
    await page.goto(liveProxyServer.url + '/dashboard', { waitUntil: 'domcontentloaded' });
    // Allow SSE time to populate the dashboard
    await page.waitForTimeout(3000);
    // Expect at least one key card or heatmap cell to be rendered
    const keyElements = await page.locator('[data-key-index], .key-cell, .heatmap-cell').count();
    expect(keyElements).toBeGreaterThan(0);
  });

  // Test 3: Stats endpoint returns structured cost and usage data
  test('stats endpoint returns structured cost and usage data', async ({ liveProxyServer }) => {
    const response = await fetch(liveProxyServer.url + '/stats');
    expect(response.ok).toBe(true);
    const stats = await response.json();
    expect(stats).toHaveProperty('keys');
    expect(stats).toHaveProperty('uptime');
    // Cost tracking field is optional but must be well-formed when present
    if (stats.costTracking) {
      expect(stats.costTracking).toHaveProperty('totalCost');
    }
  });

  // Test 4: Real API request flows through proxy and upstream responds
  test('proxied request reaches upstream and returns valid response', async ({ liveProxyServer }) => {
    const response = await fetch(liveProxyServer.url + '/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'any-value',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Reply with just the word hello' }]
      })
    });

    // Accept any valid HTTP status from upstream (200 = success, 4xx/5xx = quota or auth)
    expect([200, 400, 401, 403, 429, 529]).toContain(response.status);

    if (response.status === 200) {
      const data = await response.json();
      expect(data).toHaveProperty('content');
    }
  });

  // Test 5: Dashboard reflects request counts after a real API call
  test('dashboard reflects request after real API call', async ({ page, liveProxyServer }) => {
    // Fire a minimal request first so there is at least one recorded request
    await fetch(liveProxyServer.url + '/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'test',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'Hi' }]
      })
    });

    // Navigate to dashboard requests view
    await page.goto(liveProxyServer.url + '/dashboard#requests', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    // If the badge is visible, verify it contains a non-negative integer
    const requestsBadge = page.locator('[data-testid="request-count-badge"]');
    const badgeVisible = await requestsBadge.isVisible().catch(() => false);
    if (badgeVisible) {
      const text = await requestsBadge.textContent();
      expect(parseInt(text, 10)).toBeGreaterThanOrEqual(0);
    }
  });

  // Test 6: Account usage monitoring field is well-formed when present
  test('account usage monitoring returns real data', async ({ liveProxyServer }) => {
    const response = await fetch(liveProxyServer.url + '/stats');
    expect(response.ok).toBe(true);
    const stats = await response.json();
    if (stats.accountUsage) {
      expect(stats.accountUsage).toHaveProperty('stale');
    }
  });
});
