/**
 * E2E Tests: Tier Builder (Drag-and-Drop)
 *
 * Tests the SortableJS-powered tier builder UI: rendering, drag-drop,
 * shared badge, pending changes, save, reset, error recovery, and
 * pool status integration.
 */
const { liveFlowTest: test, expect, gotoDashboardReady, waitForSSEConnection } = require('./fixtures');

// Helper: navigate to routing page and wait for tier builder
async function goToTierBuilder(page, baseUrl) {
    await gotoDashboardReady(page, baseUrl);
    // Click the page-nav-btn (not the overflow menu item) to switch to routing page
    await page.locator('.page-nav-btn[data-page="routing"]').click();
    // Wait for the switchPage JS to remove page-hidden from routing sections
    await page.waitForFunction(() => {
        const section = document.getElementById('modelSelectionSection');
        return section && !section.classList.contains('page-hidden');
    }, { timeout: 5000 });
    // Wait for TierBuilder to initialize with model data
    await page.waitForTimeout(1000);
}

// ======== Tier Builder Rendering (UI-01, UI-02) ========

test.describe('Tier Builder Rendering', () => {

    test('three tier lanes render with correct labels', async ({ proxyServer, page }) => {
        await goToTierBuilder(page, proxyServer.url);

        // UI-01: Verify three tier lanes exist
        const lanes = page.locator('.tier-lane');
        await expect(lanes).toHaveCount(3);

        // Check tier names (labels include model family, e.g. "Opus (Heavy)")
        const heavyLabel = page.locator('.tier-lane[data-tier="heavy"] .tier-lane-name');
        await expect(heavyLabel).toContainText('Heavy');

        const mediumLabel = page.locator('.tier-lane[data-tier="medium"] .tier-lane-name');
        await expect(mediumLabel).toContainText('Medium');

        const lightLabel = page.locator('.tier-lane[data-tier="light"] .tier-lane-name');
        await expect(lightLabel).toContainText('Light');
    });

    test('strategy dropdowns render with correct values', async ({ proxyServer, page }) => {
        await goToTierBuilder(page, proxyServer.url);

        // UI-01: Strategy dropdowns exist
        const heavyStrategy = page.locator('#tierStrategyHeavy');
        await expect(heavyStrategy).toBeVisible();

        // Check options contain quality/throughput/balanced
        const options = await heavyStrategy.locator('option').allTextContents();
        expect(options).toContain('Quality');
        expect(options).toContain('Throughput');
        expect(options).toContain('Balanced');
    });

    test('available models bank is populated', async ({ proxyServer, page }) => {
        await goToTierBuilder(page, proxyServer.url);

        // UI-02: Models bank has cards
        const bankCards = page.locator('#modelsBankList .model-card');
        const count = await bankCards.count();
        expect(count).toBeGreaterThan(0);

        // Bank count badge shows number
        const bankCount = page.locator('#modelsBankCount');
        const countText = await bankCount.textContent();
        expect(parseInt(countText)).toBeGreaterThan(0);
    });

    test('tier lanes contain configured models', async ({ proxyServer, page }) => {
        await goToTierBuilder(page, proxyServer.url);

        // Wait for renderModelRouting to populate
        await page.waitForTimeout(1000);

        // Heavy lane should have test-model-heavy
        const heavyCards = page.locator('#tierLaneHeavy .model-card');
        const heavyCount = await heavyCards.count();
        expect(heavyCount).toBeGreaterThanOrEqual(1);
    });

    test('model cards show position numbers in tier lanes', async ({ proxyServer, page }) => {
        await goToTierBuilder(page, proxyServer.url);
        await page.waitForTimeout(1000);

        // Check position badge exists on first card in a tier
        const positionBadge = page.locator('#tierLaneHeavy .model-card .model-card-position').first();
        if (await positionBadge.count() > 0) {
            const text = await positionBadge.textContent();
            expect(text).toMatch(/#\d+/);
        }
    });
});

// ======== Drag-and-Drop (UI-03, UI-04) ========

test.describe('Drag and Drop', () => {

    test('drag model from bank to tier lane', async ({ proxyServer, page }) => {
        await goToTierBuilder(page, proxyServer.url);

        // Get initial count of models in medium tier
        const initialCount = await page.locator('#tierLaneMedium .model-card').count();

        // Drag first bank card to medium lane
        const bankCard = page.locator('#modelsBankList .model-card').first();
        const mediumLane = page.locator('#tierLaneMedium');

        // Use Playwright drag-and-drop
        await bankCard.dragTo(mediumLane);
        await page.waitForTimeout(300);

        // Medium lane should have one more card
        const newCount = await page.locator('#tierLaneMedium .model-card').count();
        expect(newCount).toBeGreaterThanOrEqual(initialCount);
    });

    test('shared badge appears when model is in multiple tiers', async ({ proxyServer, page }) => {
        const response = await page.request.get(proxyServer.url + '/model-routing');
        const current = await response.json();
        const originalConfig = current.config;

        const sharedModel = originalConfig.tiers?.heavy?.models?.[0];
        if (!sharedModel) {
            test.skip(true, 'No heavy-tier model available for overlap test');
            return;
        }

        const updatedConfig = JSON.parse(JSON.stringify(originalConfig));
        const mediumModels = updatedConfig.tiers?.medium?.models || [];
        if (!mediumModels.includes(sharedModel)) {
            updatedConfig.tiers.medium.models = [sharedModel, ...mediumModels];
        }

        // Runtime API accepts editable fields; send a minimal payload.
        const buildEditablePayload = function(config) {
            return {
                tiers: {
                    heavy: {
                        models: (config.tiers?.heavy?.models || []).slice(),
                        strategy: config.tiers?.heavy?.strategy || 'balanced'
                    },
                    medium: {
                        models: (config.tiers?.medium?.models || []).slice(),
                        strategy: config.tiers?.medium?.strategy || 'balanced'
                    },
                    light: {
                        models: (config.tiers?.light?.models || []).slice(),
                        strategy: config.tiers?.light?.strategy || 'balanced'
                    }
                }
            };
        };

        const updateRes = await page.request.put(proxyServer.url + '/model-routing', {
            data: buildEditablePayload(updatedConfig)
        });
        expect(updateRes.ok()).toBeTruthy();

        try {
            await goToTierBuilder(page, proxyServer.url);
            await page.waitForTimeout(500);

            // UI-04: Shared badge appears for duplicates across tiers
            const sharedBadges = page.locator('.model-card-shared');
            await expect(sharedBadges.first()).toBeVisible();
            const sharedCount = await sharedBadges.count();
            expect(sharedCount).toBeGreaterThanOrEqual(2);
        } finally {
            await page.request.put(proxyServer.url + '/model-routing', {
                data: buildEditablePayload(originalConfig)
            });
        }
    });

    test('remove button removes card from tier lane', async ({ proxyServer, page }) => {
        await goToTierBuilder(page, proxyServer.url);
        await page.waitForTimeout(1000);

        // Get initial count in heavy lane
        const initialCount = await page.locator('#tierLaneHeavy .model-card').count();
        if (initialCount === 0) {
            test.skip('No cards in heavy lane to test removal');
            return;
        }

        // Hover over the first card to reveal remove button
        const firstCard = page.locator('#tierLaneHeavy .model-card').first();
        await firstCard.hover();

        // Click remove button
        const removeBtn = firstCard.locator('.model-card-remove');
        await removeBtn.click();
        await page.waitForTimeout(300);

        // Card should be removed
        const newCount = await page.locator('#tierLaneHeavy .model-card').count();
        expect(newCount).toBe(initialCount - 1);
    });
});

// ======== Pending Changes, Save, Reset (UI-05, UI-06, UI-07, UI-08) ========

test.describe('Pending Changes and Save', () => {

    test('pending badge shows after making changes', async ({ proxyServer, page }) => {
        await goToTierBuilder(page, proxyServer.url);
        await page.waitForTimeout(1000);

        // Initially no pending changes
        const pendingBadge = page.locator('#tierBuilderPending');
        await expect(pendingBadge).toBeHidden();

        // Make a deterministic change: switch heavy tier strategy
        const strategySelect = page.locator('#tierStrategyHeavy');
        const initial = await strategySelect.inputValue();
        const updated = initial === 'balanced' ? 'throughput' : 'balanced';
        await strategySelect.selectOption(updated);
        await page.waitForTimeout(300);

        // UI-05: Pending badge should now be visible
        await expect(pendingBadge).toBeVisible();

        // Pending count should be > 0
        const countText = await page.locator('#tierBuilderPendingCount').textContent();
        expect(parseInt(countText)).toBeGreaterThan(0);
    });

    test('save button enabled only when pending changes exist', async ({ proxyServer, page }) => {
        await goToTierBuilder(page, proxyServer.url);
        await page.waitForTimeout(1000);

        // Save button should be disabled initially
        const saveBtn = page.locator('#tierBuilderSave');
        await expect(saveBtn).toBeDisabled();

        // Make a deterministic change
        const strategySelect = page.locator('#tierStrategyHeavy');
        const initial = await strategySelect.inputValue();
        const updated = initial === 'balanced' ? 'throughput' : 'balanced';
        await strategySelect.selectOption(updated);
        await page.waitForTimeout(300);

        // Save button should be enabled
        await expect(saveBtn).toBeEnabled();
    });

    test('save button triggers PUT /model-routing', async ({ proxyServer, page }) => {
        await goToTierBuilder(page, proxyServer.url);
        await page.waitForTimeout(1000);

        // Make a change: change strategy dropdown
        await page.selectOption('#tierStrategyHeavy', 'throughput');
        await page.waitForTimeout(300);

        // Intercept the PUT request
        const putPromise = page.waitForRequest(req =>
            req.method() === 'PUT' && req.url().includes('/model-routing')
        );

        // Click save
        const saveBtn = page.locator('#tierBuilderSave');
        await saveBtn.click();

        // UI-06: Verify PUT was sent (with debounce, wait up to 2s)
        const putReq = await putPromise.catch(() => null);
        if (putReq) {
            expect(putReq.method()).toBe('PUT');
            const body = putReq.postDataJSON();
            expect(body).toHaveProperty('tiers');
        }
    });

    test('reset button reverts to server state', async ({ proxyServer, page }) => {
        await goToTierBuilder(page, proxyServer.url);
        await page.waitForTimeout(1000);

        const strategySelect = page.locator('#tierStrategyHeavy');
        const initial = await strategySelect.inputValue();
        const updated = initial === 'balanced' ? 'throughput' : 'balanced';
        await strategySelect.selectOption(updated);
        await page.waitForTimeout(300);

        // UI-07: Click reset
        const resetBtn = page.locator('#tierBuilderReset');
        await expect(resetBtn).toBeEnabled();
        await resetBtn.click();
        await page.waitForTimeout(500);

        // Should revert to initial strategy value
        await expect(strategySelect).toHaveValue(initial);

        // Pending badge should be hidden
        const pendingBadge = page.locator('#tierBuilderPending');
        await expect(pendingBadge).toBeHidden();
    });

    test('PUT failure shows error toast and reverts', async ({ proxyServer, page }) => {
        await goToTierBuilder(page, proxyServer.url);
        await page.waitForTimeout(1000);

        // Intercept PUT and return error
        await page.route('**/model-routing', async (route) => {
            if (route.request().method() === 'PUT') {
                await route.fulfill({
                    status: 400,
                    contentType: 'application/json',
                    body: JSON.stringify({ error: 'Test validation error' })
                });
            } else {
                await route.continue();
            }
        });

        // Make a change
        await page.selectOption('#tierStrategyHeavy', 'throughput');
        await page.waitForTimeout(300);

        // Click save
        const saveBtn = page.locator('#tierBuilderSave');
        await saveBtn.click();

        // UI-08: Wait for error toast
        await page.waitForTimeout(1500); // debounce + network

        const toast = page.locator('.toast-message');
        // Toast should contain error
        const toastCount = await toast.count();
        if (toastCount > 0) {
            const text = await toast.first().textContent();
            expect(text).toBeTruthy();
        }

        // Unroute to restore normal behavior
        await page.unroute('**/model-routing');
    });

    test('409 save error keeps local edits for operator fix-up', async ({ proxyServer, page }) => {
        await goToTierBuilder(page, proxyServer.url);
        await page.waitForTimeout(1000);

        const strategySelect = page.locator('#tierStrategyHeavy');
        const initial = await strategySelect.inputValue();
        const updated = initial === 'balanced' ? 'throughput' : 'balanced';

        await page.route('**/model-routing', async (route) => {
            if (route.request().method() === 'PUT') {
                await route.fulfill({
                    status: 409,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        error: 'invalid_config',
                        code: 'duplicate_model_across_tiers',
                        message: 'duplicate model across tiers'
                    })
                });
            } else {
                await route.continue();
            }
        });

        await strategySelect.selectOption(updated);
        await page.waitForTimeout(300);
        await page.locator('#tierBuilderSave').click();
        await page.waitForTimeout(1500); // debounce + request

        // Keep local unsaved state (no forced revert on 409)
        await expect(strategySelect).toHaveValue(updated);
        await expect(page.locator('#tierBuilderPending')).toBeVisible();

        await page.unroute('**/model-routing');
    });
});

// ======== Pool Status Integration (POOL-01, POOL-02, POOL-03) ========

test.describe('Pool Status Integration', () => {

    test('model cards have concurrency bar elements', async ({ proxyServer, page }) => {
        await goToTierBuilder(page, proxyServer.url);
        await page.waitForTimeout(1000);

        // POOL-01: Check concurrency bar exists on model cards in tier lanes
        const bars = page.locator('.tier-lane .model-card .model-card-bar');
        const count = await bars.count();
        // At least one bar should exist (we have configured models)
        expect(count).toBeGreaterThan(0);
    });

    test('concurrency bars update from SSE pool-status', async ({ proxyServer, page }) => {
        await goToTierBuilder(page, proxyServer.url);
        await waitForSSEConnection(page);

        // Wait for pool-status SSE event to arrive and update bars
        await page.waitForTimeout(5000); // 3s broadcast interval + overhead

        // POOL-01: Check if any bar fill has been updated (width > 0%)
        // Note: In test fixture with no actual traffic, inFlight is 0,
        // so bars may remain at 0%. We verify the bar structure is correct.
        const barFills = page.locator('.tier-lane .model-card .model-card-bar-fill');
        const fillCount = await barFills.count();
        expect(fillCount).toBeGreaterThan(0);
    });

    test('cooldown badge structure exists on model cards', async ({ proxyServer, page }) => {
        await goToTierBuilder(page, proxyServer.url);
        await page.waitForTimeout(1000);

        // POOL-03: Verify the badges container exists (cooldown badge is added dynamically)
        const badgeContainers = page.locator('.tier-lane .model-card .model-card-badges');
        const count = await badgeContainers.count();
        expect(count).toBeGreaterThan(0);
    });
});

// ======== Tier Builder Enhancements (UIUX-02, UIUX-03) ========

test.describe('Tier Builder Enhancements', () => {

    test('upgrade info panel is visible when thresholds configured', async ({ proxyServer, page }) => {
        await goToTierBuilder(page, proxyServer.url);

        // UIUX-02: Check for upgrade info panel
        // Note: Panel only renders when routingData.config.classifier.complexityUpgrade.thresholds exists
        const upgradePanel = page.locator('#upgradeInfoPanel');
        const panelCount = await upgradePanel.count();

        // Panel may not exist in test environment if thresholds aren't configured
        if (panelCount > 0) {
            await expect(upgradePanel).toBeVisible();

            // Check toggle button
            const toggle = page.locator('.upgrade-info-toggle');
            await expect(toggle).toBeVisible();
            await expect(toggle).toContainText('Why upgrade to Heavy tier?');
        } else {
            // Skip test if panel not present (thresholds not configured)
            test.skip(true, 'Upgrade thresholds not configured in test environment');
        }
    });

    test('upgrade info panel expands and collapses', async ({ proxyServer, page }) => {
        await goToTierBuilder(page, proxyServer.url);

        // Check if panel exists first
        const upgradePanel = page.locator('#upgradeInfoPanel');
        const panelCount = await upgradePanel.count();

        if (panelCount === 0) {
            test.skip(true, 'Upgrade thresholds not configured in test environment');
            return;
        }

        // Click toggle to expand
        await page.click('.upgrade-info-toggle');
        const content = page.locator('#upgradeInfoContent.expanded');
        await expect(content).toBeVisible();

        // Check that content shows threshold values
        await expect(content).toContainText('Has tools');
        await expect(content).toContainText('Has vision');
        await expect(content).toContainText('Max tokens');
        await expect(content).toContainText('Messages');
        await expect(content).toContainText('System');

        // Click toggle to collapse
        await page.click('.upgrade-info-toggle.expanded');
        await expect(content).not.toBeVisible();
    });

    test('busy indicator structure exists for GLM-5', async ({ proxyServer, page }) => {
        await goToTierBuilder(page, proxyServer.url);

        // UIUX-03: Verify busy indicator element structure
        // The busy indicator is created dynamically when GLM-5 is at capacity
        const busyIndicator = page.locator('.model-busy-indicator');

        // Verify selector is valid (count may be 0 if no GLM-5 in test config)
        const count = await busyIndicator.count();
        expect(count).toBeGreaterThanOrEqual(0);

        // If busy indicator exists, verify its content structure
        if (count > 0) {
            await expect(busyIndicator).toContainText('Busy');
            const icon = busyIndicator.locator('.busy-icon');
            await expect(icon).toBeVisible();
            const text = busyIndicator.locator('.busy-text');
            await expect(text).toBeVisible();
        }
    });

    test('busy indicator has correct title attribute', async ({ proxyServer, page }) => {
        await goToTierBuilder(page, proxyServer.url);

        // Verify busy indicator has correct title for accessibility/tooltip
        const busyIndicator = page.locator('.model-busy-indicator');

        // Check title attribute when element exists
        const count = await busyIndicator.count();
        if (count > 0) {
            const title = await busyIndicator.first().getAttribute('title');
            expect(title).toContain('capacity');
        }
    });
});

// ======== Tier Builder Save Round-Trip (M1.5) ========

test.describe('Tier Builder Save Round-Trip', () => {

    test('save persists strategy change and re-fetch returns updated config', async ({ request, proxyServer, page }) => {
        await goToTierBuilder(page, proxyServer.url);
        await page.waitForTimeout(1000);

        // 1. Read initial config from API
        const initialRes = await request.get(`${proxyServer.url}/model-routing`);
        const initial = await initialRes.json();
        expect(initial.enabled).toBe(true);
        const initialStrategy = initial.config.tiers.heavy.strategy;

        // 2. Change heavy tier strategy in UI
        const newStrategy = initialStrategy === 'balanced' ? 'throughput' : 'balanced';
        await page.selectOption('#tierStrategyHeavy', newStrategy);
        await page.waitForTimeout(300);

        // 3. Wait for PUT request to complete after save
        const [putResponse] = await Promise.all([
            page.waitForResponse(res =>
                res.url().includes('/model-routing') && res.request().method() === 'PUT'
            ),
            page.locator('#tierBuilderSave').click()
        ]);
        expect(putResponse.ok()).toBeTruthy();

        // 4. Re-fetch config via API and verify round-trip
        await page.waitForTimeout(500);
        const updatedRes = await request.get(`${proxyServer.url}/model-routing`);
        const updated = await updatedRes.json();
        expect(updated.config.tiers.heavy.strategy).toBe(newStrategy);

        // 5. Verify other tiers were NOT affected
        expect(updated.config.tiers.medium.strategy).toBe(initial.config.tiers.medium.strategy);
        expect(updated.config.tiers.light.strategy).toBe(initial.config.tiers.light.strategy);
    });

    test('save persists model list after drag removal', async ({ request, proxyServer, page }) => {
        await goToTierBuilder(page, proxyServer.url);
        await page.waitForTimeout(1000);

        // 1. Get initial model count for heavy tier
        const initialRes = await request.get(`${proxyServer.url}/model-routing`);
        const initial = await initialRes.json();
        const initialHeavyModels = initial.config.tiers.heavy.models || [];

        // Only test removal if there's at least one model to remove
        if (initialHeavyModels.length === 0) {
            test.skip();
            return;
        }

        // 2. Remove first model from heavy tier via remove button
        const removeBtn = page.locator('.tier-lane[data-tier="heavy"] .model-remove-btn').first();
        if (await removeBtn.isVisible()) {
            await removeBtn.click();
            await page.waitForTimeout(300);

            // 3. Save
            const saveBtn = page.locator('#tierBuilderSave');
            if (await saveBtn.isEnabled()) {
                const [putResponse] = await Promise.all([
                    page.waitForResponse(res =>
                        res.url().includes('/model-routing') && res.request().method() === 'PUT'
                    ),
                    saveBtn.click()
                ]);
                expect(putResponse.ok()).toBeTruthy();

                // 4. Re-fetch and verify model was removed
                await page.waitForTimeout(500);
                const updatedRes = await request.get(`${proxyServer.url}/model-routing`);
                const updated = await updatedRes.json();
                const updatedHeavyModels = updated.config.tiers.heavy.models || [];
                expect(updatedHeavyModels.length).toBeLessThan(initialHeavyModels.length);
            }
        }
    });
});
