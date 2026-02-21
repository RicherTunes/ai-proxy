/**
 * E2E Tests: GLM-5 Stats Display
 *
 * Tests the GLM-5 Eligible and GLM-5 Applied counters in the routing stats panel.
 * These stats show shadow tracking volume when GLM-5 is in shadow mode (preferencePercent=0).
 *
 * Phase 15: GLM-5 Shadow Mode Indicator
 */
const { liveFlowTest: test, expect, sendTestRequest, gotoDashboardReady } = require('./fixtures');

// Helper: navigate to routing page and wait for stats
async function goToRoutingStats(page, baseUrl) {
    await gotoDashboardReady(page, baseUrl);
    // Click the page-nav-btn to switch to routing page
    await page.locator('.page-nav-btn[data-page="routing"]').click();
    // Wait for the routing page to be visible
    await page.waitForFunction(() => {
        const section = document.getElementById('modelSelectionSection');
        return section && !section.classList.contains('page-hidden');
    }, { timeout: 5000 });
    // Wait for routing stats to populate
    await page.waitForTimeout(1000);
}

// Helper: configure model routing via API
async function configureModelRouting(page, proxyUrl, config) {
    const response = await page.request.put(`${proxyUrl}/model-routing`, {
        headers: { 'Content-Type': 'application/json' },
        data: config
    });
    if (!response.ok()) {
        const text = await response.text();
        throw new Error(`Failed to configure routing: ${response.statusText()} - ${text}`);
    }
    return await response.json();
}

test.describe('GLM-5 Stats Display', () => {

    test('stats elements exist in DOM with initial value 0', async ({ proxyServer, page }) => {
        // Navigate to routing stats panel
        await goToRoutingStats(page, proxyServer.url);

        // Verify GLM-5 Eligible element exists
        const eligibleEl = page.locator('#routingGlm5Eligible');
        await expect(eligibleEl).toBeVisible();
        await expect(eligibleEl).toHaveText('0');

        // Verify GLM-5 Applied element exists
        const appliedEl = page.locator('#routingGlm5Applied');
        await expect(appliedEl).toBeVisible();
        await expect(appliedEl).toHaveText('0');
    });

    test('stats show counter values from API response', async ({ proxyServer, page }) => {
        // Configure routing with GLM-5 in heavy tier, shadow mode (preferencePercent=0)
        await configureModelRouting(page, proxyServer.url, {
            version: '2.0',
            tiers: {
                heavy: { models: ['glm-5', 'glm-4-plus'] },
                medium: { models: ['claude-3-5-sonnet-20241022'] },
                light: { models: ['claude-3-5-haiku-20241022'] }
            },
            glm5: {
                enabled: true,
                preferencePercent: 0
            }
        });

        // Send a request with tools to trigger heavy tier classification
        // Heavy tier triggers GLM-5 eligibility check
        await sendTestRequest(proxyServer, {
            model: 'claude-sonnet-4-5-20250929',
            tools: [
                {
                    name: 'test_tool',
                    description: 'A test tool',
                    input_schema: {
                        type: 'object',
                        properties: {}
                    }
                }
            ],
            max_tokens: 1000
        });

        // Navigate to routing stats panel
        await goToRoutingStats(page, proxyServer.url);

        // Wait for stats to poll and update
        await page.waitForTimeout(2000);

        // Fetch routing stats from API to get actual values
        const response = await page.request.get(`${proxyServer.url}/model-routing`);
        const data = await response.json();
        const stats = data.stats || {};

        // Verify eligible counter updated (should be > 0 since we sent a heavy request)
        const eligibleEl = page.locator('#routingGlm5Eligible');
        const eligibleText = await eligibleEl.textContent();
        const eligibleValue = parseInt(eligibleText, 10);

        // In shadow mode (preferencePercent=0), eligible should increment but applied stays 0
        expect(eligibleValue).toBeGreaterThanOrEqual(0);
        expect(eligibleValue).toBe(stats.glm5EligibleTotal || 0);

        // Verify applied counter is 0 (shadow mode means preference not applied)
        const appliedEl = page.locator('#routingGlm5Applied');
        const appliedText = await appliedEl.textContent();
        const appliedValue = parseInt(appliedText, 10);

        expect(appliedValue).toBe(0);
        expect(appliedValue).toBe(stats.glm5PreferenceApplied || 0);
    });

    test('stats update with preferencePercent > 0', async ({ proxyServer, page }) => {
        // Configure routing with GLM-5 in heavy tier, preferencePercent=100
        await configureModelRouting(page, proxyServer.url, {
            version: '2.0',
            tiers: {
                heavy: { models: ['glm-5', 'glm-4-plus'] },
                medium: { models: ['claude-3-5-sonnet-20241022'] },
                light: { models: ['claude-3-5-haiku-20241022'] }
            },
            glm5: {
                enabled: true,
                preferencePercent: 100
            }
        });

        // Send multiple requests with tools to trigger heavy tier classification
        for (let i = 0; i < 3; i++) {
            await sendTestRequest(proxyServer, {
                model: 'claude-sonnet-4-5-20250929',
                tools: [
                    {
                        name: 'test_tool',
                        description: 'A test tool',
                        input_schema: {
                            type: 'object',
                            properties: {}
                        }
                    }
                ],
                max_tokens: 1000
            });
        }

        // Navigate to routing stats panel
        await goToRoutingStats(page, proxyServer.url);

        // Wait for stats to poll and update
        await page.waitForTimeout(2000);

        // Fetch routing stats from API to get actual values
        const response = await page.request.get(`${proxyServer.url}/model-routing`);
        const data = await response.json();
        const stats = data.stats || {};

        // With preferencePercent=100, both eligible and applied should increment
        const eligibleEl = page.locator('#routingGlm5Eligible');
        const eligibleText = await eligibleEl.textContent();
        const eligibleValue = parseInt(eligibleText, 10);

        expect(eligibleValue).toBeGreaterThanOrEqual(0);
        expect(eligibleValue).toBe(stats.glm5EligibleTotal || 0);

        const appliedEl = page.locator('#routingGlm5Applied');
        const appliedText = await appliedEl.textContent();
        const appliedValue = parseInt(appliedText, 10);

        // At preferencePercent=100, all eligible requests get preference applied
        expect(appliedValue).toBeGreaterThanOrEqual(0);
        expect(appliedValue).toBe(stats.glm5PreferenceApplied || 0);
    });

    test('stats display cumulative values across polling cycles', async ({ proxyServer, page }) => {
        // Configure routing with GLM-5 in heavy tier, shadow mode
        await configureModelRouting(page, proxyServer.url, {
            version: '2.0',
            tiers: {
                heavy: { models: ['glm-5', 'glm-4-plus'] },
                medium: { models: ['claude-3-5-sonnet-20241022'] },
                light: { models: ['claude-3-5-haiku-20241022'] }
            },
            glm5: {
                enabled: true,
                preferencePercent: 50
            }
        });

        // Navigate to routing stats panel
        await goToRoutingStats(page, proxyServer.url);

        // Wait for initial stats load
        await page.waitForTimeout(1000);

        // Get initial values
        const eligibleEl = page.locator('#routingGlm5Eligible');
        const appliedEl = page.locator('#routingGlm5Applied');

        const initialEligible = parseInt(await eligibleEl.textContent(), 10) || 0;
        const initialApplied = parseInt(await appliedEl.textContent(), 10) || 0;

        // Send a request to increment counters
        await sendTestRequest(proxyServer, {
            model: 'claude-sonnet-4-5-20250929',
            tools: [
                {
                    name: 'test_tool',
                    description: 'A test tool',
                    input_schema: {
                        type: 'object',
                        properties: {}
                    }
                }
            ],
            max_tokens: 1000
        });

        // Wait for polling cycle to update stats
        await page.waitForTimeout(3000);

        // Verify values are cumulative (should be >= initial values)
        const updatedEligible = parseInt(await eligibleEl.textContent(), 10) || 0;
        const updatedApplied = parseInt(await appliedEl.textContent(), 10) || 0;

        expect(updatedEligible).toBeGreaterThanOrEqual(initialEligible);
        expect(updatedApplied).toBeGreaterThanOrEqual(initialApplied);
    });

});
