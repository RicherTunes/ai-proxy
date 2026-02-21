/**
 * Model Cards E2E Tests
 * Tests for enhanced metadata display, sort dropdown, tooltip, and theme support.
 *
 * Strategy: Use gotoDashboardReady to bootstrap, then inject mock model data
 * via page.evaluate() since the test server has no real upstream API.
 * This proves the frontend rendering and event wiring work end-to-end.
 */

const { test, expect } = require('./fixtures');
const { gotoDashboardReady } = require('./fixtures');

// Mock model data matching the structure from /models endpoint
const MOCK_MODELS_DATA = {
    'claude-sonnet-4-5-20250929': {
        displayName: 'Claude Sonnet 4.5',
        tier: 'MEDIUM',
        type: 'chat',
        maxConcurrency: 5,
        contextLength: 200000,
        supportsVision: true,
        supportsStreaming: true,
        description: 'Fast and capable model',
        pricing: { input: 3.00, output: 15.00, cachedInput: 0.30 }
    },
    'claude-opus-4-20250514': {
        displayName: 'Claude Opus 4',
        tier: 'HEAVY',
        type: 'chat',
        maxConcurrency: 2,
        contextLength: 200000,
        supportsVision: true,
        supportsStreaming: true,
        description: 'Most capable model',
        pricing: { input: 15.00, output: 75.00, cachedInput: 1.50 }
    },
    'claude-haiku-3-5-20241022': {
        displayName: 'Claude Haiku 3.5',
        tier: 'LIGHT',
        type: 'chat',
        maxConcurrency: 10,
        contextLength: 200000,
        supportsVision: false,
        supportsStreaming: true,
        description: 'Fast and affordable',
        pricing: { input: 0.80, output: 4.00 }
    },
    'glm-4-flash': {
        displayName: 'GLM-4 Flash',
        tier: 'FREE',
        type: 'chat',
        maxConcurrency: 20,
        contextLength: 128000,
        supportsVision: false,
        supportsStreaming: true,
        description: 'Free tier model',
        pricing: { input: 0, output: 0 }
    }
};

const MOCK_ROUTING_DATA = {
    enabled: true,
    config: {
        version: '2.0',
        tiers: {
            heavy: { models: ['claude-opus-4-20250514'], strategy: 'balanced' },
            medium: { models: ['claude-sonnet-4-5-20250929'], strategy: 'balanced' },
            light: { models: ['claude-haiku-3-5-20241022'], strategy: 'quality' }
        }
    },
    stats: { byModel: {} }
};

// Helper: bootstrap dashboard, navigate to models page, inject mock data and render tier builder
async function setupModelCards(page, baseUrl) {
    await gotoDashboardReady(page, baseUrl);

    // Navigate to models page
    await page.evaluate(() => {
        const btn = document.querySelector('[data-action="switch-page"][data-page="models"]');
        if (btn) btn.click();
    });
    await page.waitForTimeout(300);

    // Inject mock data and trigger tier builder render
    const cardCount = await page.evaluate((args) => {
        const { modelsData, routingData } = args;
        const DS = window.DashboardStore;
        if (DS && DS.STATE) {
            DS.STATE.modelsData = modelsData;
        }

        // Get available model IDs from mock data
        const availableModels = Object.keys(modelsData);

        // Initialize or re-render tier builder with mock data
        if (!window._tierBuilder) {
            const TB = window.DashboardTierBuilder;
            if (TB && TB.TierBuilder) {
                window._tierBuilder = new TB.TierBuilder();
            }
        }

        if (window._tierBuilder) {
            window._tierBuilder.render(routingData, modelsData, availableModels);
        }

        return document.querySelectorAll('#modelsBankList .model-card').length;
    }, { modelsData: MOCK_MODELS_DATA, routingData: MOCK_ROUTING_DATA });

    return cardCount;
}

test.describe('Model Cards - Enhanced Metadata & Sort', () => {
    test('metadata row renders with tier, slots, price, vision', async ({ page, proxyServer }) => {
        const cardCount = await setupModelCards(page, proxyServer.url);
        expect(cardCount).toBeGreaterThan(0);

        // Verify .model-card-meta exists
        const metaCount = await page.locator('.model-card-meta').count();
        expect(metaCount).toBeGreaterThan(0);

        // Check tier badges exist with proper classes
        const tierBadges = await page.evaluate(() => {
            const badges = document.querySelectorAll('.model-card-tier');
            return Array.from(badges).map(b => ({
                text: b.textContent,
                classes: b.className
            }));
        });
        expect(tierBadges.length).toBeGreaterThan(0);
        const tierTexts = tierBadges.map(b => b.text);
        expect(tierTexts).toContain('Heavy');
        expect(tierTexts).toContain('Medium');
        expect(tierTexts).toContain('Light');
        expect(tierTexts).toContain('Free');

        // Check concurrency slots rendered
        const slotsCount = await page.locator('.model-card-slots').count();
        expect(slotsCount).toBeGreaterThan(0);

        // Check pricing rendered
        const prices = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('.model-card-price'))
                .map(p => p.textContent);
        });
        expect(prices).toContain('Free');
        expect(prices.some(p => p.startsWith('$'))).toBe(true);

        // Check vision indicator exists (opus and sonnet support vision; cards appear in bank + tier lanes)
        const visionCount = await page.locator('.model-card-vision').count();
        expect(visionCount).toBeGreaterThanOrEqual(2);
    });

    test('sort dropdown exists and has all 5 options', async ({ page, proxyServer }) => {
        await setupModelCards(page, proxyServer.url);

        const sortSelect = page.locator('#modelsBankSort');
        await expect(sortSelect).toBeVisible();

        const options = await sortSelect.locator('option').allTextContents();
        expect(options.length).toBe(5);
        expect(options[0]).toBe('Name');
        expect(options[1]).toBe('Tier');
    });

    test('sort by tier reorders cards: HEAVY first, FREE last', async ({ page, proxyServer }) => {
        await setupModelCards(page, proxyServer.url);

        // Get initial name-sorted order
        const nameOrder = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('#modelsBankList .model-card'))
                .map(c => c.dataset.modelId);
        });

        // Sort by tier via the dropdown (tests event delegation wiring)
        await page.selectOption('#modelsBankSort', 'tier');
        await page.waitForTimeout(200);

        const tierOrder = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('#modelsBankList .model-card'))
                .map(c => c.dataset.modelId);
        });

        // First card should be HEAVY (opus), last should be FREE (glm-4-flash)
        expect(tierOrder[0]).toBe('claude-opus-4-20250514');
        expect(tierOrder[tierOrder.length - 1]).toBe('glm-4-flash');
        expect(tierOrder.length).toBe(nameOrder.length);
    });

    test('sort by price-asc puts free models first', async ({ page, proxyServer }) => {
        await setupModelCards(page, proxyServer.url);

        await page.selectOption('#modelsBankSort', 'price-asc');
        await page.waitForTimeout(200);

        const order = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('#modelsBankList .model-card'))
                .map(c => c.dataset.modelId);
        });

        // GLM-4 Flash (free) should be first, Opus (most expensive) should be last
        expect(order[0]).toBe('glm-4-flash');
        expect(order[order.length - 1]).toBe('claude-opus-4-20250514');
    });

    test('sort by concurrency puts highest first', async ({ page, proxyServer }) => {
        await setupModelCards(page, proxyServer.url);

        await page.selectOption('#modelsBankSort', 'concurrency');
        await page.waitForTimeout(200);

        const order = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('#modelsBankList .model-card'))
                .map(c => c.dataset.modelId);
        });

        // GLM-4 Flash has 20 concurrency, should be first
        expect(order[0]).toBe('glm-4-flash');
        // Opus has 2, should be last
        expect(order[order.length - 1]).toBe('claude-opus-4-20250514');
    });

    test('tooltip shows on hover with correct content', async ({ page, proxyServer }) => {
        await setupModelCards(page, proxyServer.url);

        // Hover over the first bank card
        const firstCard = page.locator('#modelsBankList .model-card').first();
        await firstCard.hover();
        await page.waitForTimeout(300);

        // Check tooltip appeared
        const tooltipInfo = await page.evaluate(() => {
            const tip = document.getElementById('modelCardTooltip');
            if (!tip || tip.style.display === 'none') return null;
            return {
                visible: true,
                text: tip.textContent,
                hasHeader: !!tip.querySelector('.tooltip-header'),
                hasRows: tip.querySelectorAll('.tooltip-row').length,
                role: tip.getAttribute('role')
            };
        });

        expect(tooltipInfo).not.toBeNull();
        expect(tooltipInfo.visible).toBe(true);
        expect(tooltipInfo.hasHeader).toBe(true);
        expect(tooltipInfo.hasRows).toBeGreaterThan(3);
        expect(tooltipInfo.role).toBe('tooltip');
        // Should contain pricing or tier info
        expect(tooltipInfo.text).toContain('Tier');

        // Move away — tooltip should hide
        await page.mouse.move(0, 0);
        await page.waitForTimeout(200);

        const hidden = await page.evaluate(() => {
            const tip = document.getElementById('modelCardTooltip');
            return !tip || tip.style.display === 'none';
        });
        expect(hidden).toBe(true);
    });

    test('sort persists after data re-render', async ({ page, proxyServer }) => {
        await setupModelCards(page, proxyServer.url);

        // Sort by tier first
        await page.selectOption('#modelsBankSort', 'tier');
        await page.waitForTimeout(200);

        const tierOrderBefore = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('#modelsBankList .model-card'))
                .map(c => c.dataset.modelId);
        });

        // Simulate a data refresh (re-render)
        await page.evaluate((args) => {
            const { modelsData, routingData } = args;
            const availableModels = Object.keys(modelsData);
            if (window._tierBuilder) {
                window._tierBuilder.render(routingData, modelsData, availableModels);
            }
        }, { modelsData: MOCK_MODELS_DATA, routingData: MOCK_ROUTING_DATA });
        await page.waitForTimeout(200);

        const tierOrderAfter = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('#modelsBankList .model-card'))
                .map(c => c.dataset.modelId);
        });

        // Order should be the same after re-render
        expect(tierOrderAfter).toEqual(tierOrderBefore);

        // Dropdown should still show 'tier'
        const sortValue = await page.evaluate(() => {
            return document.getElementById('modelsBankSort')?.value;
        });
        expect(sortValue).toBe('tier');
    });

    test('model cards have tabindex=0 for keyboard accessibility', async ({ page, proxyServer }) => {
        await setupModelCards(page, proxyServer.url);

        const tabIndexes = await page.evaluate(() => {
            const cards = document.querySelectorAll('#modelsBankList .model-card');
            return Array.from(cards).map(c => c.getAttribute('tabindex'));
        });

        expect(tabIndexes.length).toBeGreaterThan(0);
        tabIndexes.forEach(t => expect(t).toBe('0'));
    });

    test('keyboard focus triggers tooltip via focusin', async ({ page, proxyServer }) => {
        await setupModelCards(page, proxyServer.url);

        // Focus the first model card via keyboard (Tab)
        const firstCard = page.locator('#modelsBankList .model-card').first();
        await firstCard.focus();
        await page.waitForTimeout(300);

        // Check tooltip appeared
        const tooltipVisible = await page.evaluate(() => {
            const tip = document.getElementById('modelCardTooltip');
            return tip && tip.style.display !== 'none';
        });
        expect(tooltipVisible).toBe(true);

        // Blur — tooltip should hide
        await page.evaluate(() => {
            const card = document.querySelector('#modelsBankList .model-card');
            if (card) card.blur();
        });
        await page.waitForTimeout(200);

        const tooltipHidden = await page.evaluate(() => {
            const tip = document.getElementById('modelCardTooltip');
            return !tip || tip.style.display === 'none';
        });
        expect(tooltipHidden).toBe(true);
    });

    test('tooltip is positioned within viewport bounds', async ({ page, proxyServer }) => {
        await setupModelCards(page, proxyServer.url);

        // Hover first card
        const firstCard = page.locator('#modelsBankList .model-card').first();
        await firstCard.hover();
        await page.waitForTimeout(300);

        const positioning = await page.evaluate(() => {
            const tip = document.getElementById('modelCardTooltip');
            if (!tip || tip.style.display === 'none') return null;

            const tipRect = tip.getBoundingClientRect();
            const container = tip.closest('.tier-builder');
            const containerStyle = container ? getComputedStyle(container).position : 'none';

            return {
                left: parseFloat(tip.style.left),
                top: parseFloat(tip.style.top),
                tipWidth: tipRect.width,
                tipHeight: tipRect.height,
                containerPosition: containerStyle,
                containerWidth: container ? container.clientWidth : 0,
                noNegativeLeft: parseFloat(tip.style.left) >= 0,
                noNegativeTop: tipRect.top >= 0
            };
        });

        expect(positioning).not.toBeNull();
        // Container must have position:relative for correct tooltip math
        expect(positioning.containerPosition).toBe('relative');
        expect(positioning.noNegativeLeft).toBe(true);
        // Tooltip should not extend beyond container right edge
        expect(positioning.left + positioning.tipWidth).toBeLessThanOrEqual(positioning.containerWidth + 10);
    });

    test('cards retain data-model-id after sort (drag-drop safe)', async ({ page, proxyServer }) => {
        await setupModelCards(page, proxyServer.url);

        // Sort by price-desc
        await page.selectOption('#modelsBankSort', 'price-desc');
        await page.waitForTimeout(200);

        const allHaveIds = await page.evaluate(() => {
            const cards = document.querySelectorAll('#modelsBankList .model-card');
            return cards.length > 0 && Array.from(cards).every(c => !!c.dataset.modelId);
        });
        expect(allHaveIds).toBe(true);
    });
});
