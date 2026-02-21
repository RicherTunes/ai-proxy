/**
 * E2E Tests for Requests Table Model Mapping Display
 *
 * Verifies that the Requests "Table" tab correctly renders
 * original → mapped model format when routing decisions occur,
 * and shows a single model name when no routing happens.
 */

const { test, expect, waitForStoreReady } = require('./fixtures');

test.describe('Requests Table — Model Mapping Display', () => {

    test('routed request shows "original → mapped" in Model column', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });
        await waitForStoreReady(page);

        // Navigate to Requests page
        await page.locator('[data-page="requests"][data-action="switch-page"]').click();

        // Inject routed request into store and trigger render
        await page.evaluate(() => {
            const STATE = window.DashboardStore?.STATE;
            if (STATE) {
                STATE.requestsHistory.push({
                    requestId: 'test-routed-1',
                    timestamp: Date.now(),
                    keyIndex: 0,
                    path: '/v1/messages',
                    originalModel: 'claude-sonnet-4-5-20250929',
                    mappedModel: 'glm-4.5',
                    status: 'completed',
                    latency: 120,
                    statusCode: 200,
                    routingDecision: { tier: 'medium', source: 'rule', reason: 'matched claude-sonnet*' }
                });
            }
            if (window.DashboardSSE?.updateRecentRequestsTable) {
                window.DashboardSSE.updateRecentRequestsTable();
            }
        });

        const tbody = page.locator('#recentRequestsBody');
        const html = await tbody.innerHTML();

        // Should contain both original and mapped model names with arrow
        expect(html).toContain('claude-sonnet-4-5-20250929');
        expect(html).toContain('glm-4.5');
        expect(html).toMatch(/→|&rarr;/);
    });

    test('non-routed request shows single model name', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });
        await waitForStoreReady(page);

        await page.locator('[data-page="requests"][data-action="switch-page"]').click();

        // Inject a request where originalModel === mappedModel (no routing)
        await page.evaluate(() => {
            const STATE = window.DashboardStore?.STATE;
            if (STATE) {
                // Replace history to avoid arrow from prior test
                STATE.requestsHistory = [{
                    requestId: 'test-same-model-1',
                    timestamp: Date.now(),
                    keyIndex: 0,
                    path: '/v1/messages',
                    originalModel: 'glm-4.5',
                    mappedModel: 'glm-4.5',
                    status: 'completed',
                    latency: 80,
                    statusCode: 200
                }];
            }
            if (window.DashboardSSE?.updateRecentRequestsTable) {
                window.DashboardSSE.updateRecentRequestsTable();
            }
        });

        const tbody = page.locator('#recentRequestsBody');
        const html = await tbody.innerHTML();

        // Should show the model name but NOT the arrow notation
        expect(html).toContain('glm-4.5');
        expect(html).not.toMatch(/→|&rarr;/);
    });

    test('multiple routed requests all display mapping correctly', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });
        await waitForStoreReady(page);

        await page.locator('[data-page="requests"][data-action="switch-page"]').click();

        // Inject multiple routed requests with different model pairs
        await page.evaluate(() => {
            const STATE = window.DashboardStore?.STATE;
            if (STATE) {
                const pairs = [
                    { original: 'claude-sonnet-4-5-20250929', mapped: 'glm-4.5', tier: 'medium' },
                    { original: 'claude-opus-4-20250514', mapped: 'glm-5', tier: 'heavy' },
                    { original: 'claude-haiku-4-5-20251001', mapped: 'glm-4.5-air', tier: 'light' }
                ];
                STATE.requestsHistory = pairs.map(function(p, i) {
                    return {
                        requestId: 'test-multi-' + i,
                        timestamp: Date.now() - i * 1000,
                        keyIndex: 0,
                        path: '/v1/messages',
                        originalModel: p.original,
                        mappedModel: p.mapped,
                        status: 'completed',
                        latency: 100 + i * 20,
                        statusCode: 200,
                        routingDecision: { tier: p.tier, source: 'rule', reason: 'matched rule' }
                    };
                });
            }
            if (window.DashboardSSE?.updateRecentRequestsTable) {
                window.DashboardSSE.updateRecentRequestsTable();
            }
        });

        const tbody = page.locator('#recentRequestsBody');
        const html = await tbody.innerHTML();

        // All three pairs should be visible with arrow notation
        expect(html).toContain('claude-sonnet-4-5-20250929');
        expect(html).toContain('glm-4.5');
        expect(html).toContain('claude-opus-4-20250514');
        expect(html).toContain('glm-5');
        expect(html).toContain('claude-haiku-4-5-20251001');
        expect(html).toContain('glm-4.5-air');

        // Should have arrows for the routed requests
        const arrowCount = (html.match(/→|&rarr;/g) || []).length;
        expect(arrowCount).toBeGreaterThanOrEqual(3);
    });

    test('request with only mappedModel (no originalModel) shows mapped model', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });
        await waitForStoreReady(page);

        await page.locator('[data-page="requests"][data-action="switch-page"]').click();

        // Inject request with only mappedModel set (edge case)
        await page.evaluate(() => {
            const STATE = window.DashboardStore?.STATE;
            if (STATE) {
                STATE.requestsHistory = [{
                    requestId: 'test-mapped-only-1',
                    timestamp: Date.now(),
                    keyIndex: 0,
                    path: '/v1/messages',
                    mappedModel: 'glm-4.5-flash',
                    status: 'completed',
                    latency: 50,
                    statusCode: 200
                }];
            }
            if (window.DashboardSSE?.updateRecentRequestsTable) {
                window.DashboardSSE.updateRecentRequestsTable();
            }
        });

        const tbody = page.locator('#recentRequestsBody');
        const html = await tbody.innerHTML();

        // Should show the mapped model name
        expect(html).toContain('glm-4.5-flash');
    });
});
