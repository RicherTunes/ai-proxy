/**
 * E2E Tests: GLM-5 Shadow Mode Badge
 *
 * Tests the "Shadow" badge that appears on GLM-5 model cards when
 * GLM-5 is in shadow mode (enabled=true, preferencePercent=0).
 *
 * Phase 15: GLM-5 Shadow Mode Indicator
 */
const { liveFlowTest: test, expect, gotoDashboardReady } = require('./fixtures');

// Helper: navigate to routing page and wait for tier builder
async function goToTierBuilder(page, baseUrl) {
    await gotoDashboardReady(page, baseUrl);
    // Click the page-nav-btn to switch to routing page
    await page.locator('.page-nav-btn[data-page="routing"]').click();
    // Wait for the routing page to be visible
    await page.waitForFunction(() => {
        const section = document.getElementById('modelSelectionSection');
        return section && !section.classList.contains('page-hidden');
    }, { timeout: 5000 });
    // Wait for TierBuilder to initialize with model data
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

test.describe('GLM-5 Shadow Mode Badge', () => {

    test('shadow badge appears when preferencePercent=0', async ({ proxyServer, page }) => {
        // Configure routing with GLM-5 in heavy tier, shadow mode enabled
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

        // Navigate to tier builder
        await goToTierBuilder(page, proxyServer.url);

        // Wait for tier builder to render
        await page.waitForTimeout(1000);

        // Find GLM-5 card in heavy tier
        const glm5Card = page.locator('.model-card[data-model-id*="glm-5"]').first();
        await expect(glm5Card).toBeVisible();

        // Verify shadow badge exists
        const shadowBadge = glm5Card.locator('.model-card-shadow');
        await expect(shadowBadge).toBeVisible();
        await expect(shadowBadge).toHaveText('Shadow');

        // Verify badge has correct title
        const title = await shadowBadge.getAttribute('title');
        expect(title).toContain('Shadow mode');
        expect(title).toContain('0%');
    });

    test('shadow badge absent when preferencePercent > 0', async ({ proxyServer, page }) => {
        // Configure routing with GLM-5 in heavy tier, preferencePercent=50
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

        // Navigate to tier builder
        await goToTierBuilder(page, proxyServer.url);

        // Wait for tier builder to render
        await page.waitForTimeout(1000);

        // Find GLM-5 card in heavy tier
        const glm5Card = page.locator('.model-card[data-model-id*="glm-5"]').first();
        await expect(glm5Card).toBeVisible();

        // Verify shadow badge does NOT exist
        const shadowBadge = glm5Card.locator('.model-card-shadow');
        await expect(shadowBadge).toHaveCount(0);
    });

    test('shadow badge absent when glm5 disabled', async ({ proxyServer, page }) => {
        // Configure routing with GLM-5 in heavy tier, but disabled
        await configureModelRouting(page, proxyServer.url, {
            version: '2.0',
            tiers: {
                heavy: { models: ['glm-5', 'glm-4-plus'] },
                medium: { models: ['claude-3-5-sonnet-20241022'] },
                light: { models: ['claude-3-5-haiku-20241022'] }
            },
            glm5: {
                enabled: false,
                preferencePercent: 0
            }
        });

        // Navigate to tier builder
        await goToTierBuilder(page, proxyServer.url);

        // Wait for tier builder to render
        await page.waitForTimeout(1000);

        // Find GLM-5 card in heavy tier
        const glm5Card = page.locator('.model-card[data-model-id*="glm-5"]').first();
        await expect(glm5Card).toBeVisible();

        // Verify shadow badge does NOT exist (disabled means not in shadow mode)
        const shadowBadge = glm5Card.locator('.model-card-shadow');
        await expect(shadowBadge).toHaveCount(0);
    });

    test('shadow badge removed on config change from 0 to nonzero', async ({ proxyServer, page }) => {
        // Start with shadow mode enabled
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

        // Navigate to tier builder
        await goToTierBuilder(page, proxyServer.url);

        // Wait for tier builder to render
        await page.waitForTimeout(1000);

        // Verify shadow badge exists initially
        const glm5Card = page.locator('.model-card[data-model-id*="glm-5"]').first();
        let shadowBadge = glm5Card.locator('.model-card-shadow');
        await expect(shadowBadge).toBeVisible();

        // Change config to preferencePercent=50
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

        // Reload the page to fetch new config
        // (simulates the dashboard polling cycle or manual refresh)
        await page.reload();
        await page.waitForTimeout(1000);

        // Navigate back to routing page
        await page.locator('.page-nav-btn[data-page="routing"]').click();
        await page.waitForFunction(() => {
            const section = document.getElementById('modelSelectionSection');
            return section && !section.classList.contains('page-hidden');
        }, { timeout: 5000 });
        await page.waitForTimeout(1000);

        // Verify shadow badge is now gone
        const updatedGlm5Card = page.locator('.model-card[data-model-id*="glm-5"]').first();
        shadowBadge = updatedGlm5Card.locator('.model-card-shadow');
        await expect(shadowBadge).toHaveCount(0);
    });

});
