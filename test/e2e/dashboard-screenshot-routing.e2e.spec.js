/**
 * Month 1 Roadmap Tests:
 * - Item 1.3: Screenshot mode has no fixed-position overlap
 * - Item 1.5: Tier-builder save round-trip
 * - Item 1.6: Model routing enable → disable → re-enable cycle
 */
const { test, expect, liveFlowTest } = require('./fixtures');

// Screenshot tests use default fixture (no routing needed)
test.describe('Screenshot mode: no fixed-position overlap (M1.3)', () => {
    test('screenshot mode hides or de-fixes known fixed-position elements', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard?screenshot=1', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(500);

        // Open the side panel so it is present in the DOM
        await page.evaluate(() => {
            var panel = document.querySelector('.side-panel');
            if (panel) panel.classList.add('open');
        });
        await page.waitForTimeout(200);

        // Allowlist: elements that use position:fixed in normal mode.
        // Each must be either hidden (display:none) or de-fixed (position != fixed) in screenshot mode.
        const results = await page.evaluate(() => {
            var selectors = [
                '.side-panel',
                '.side-panel-backdrop',
                '.bottom-drawer',
                '.toast-container',
                '.shortcuts-help-btn',
                '.context-menu',
                '.modal-overlay'
            ];
            return selectors.map(function(sel) {
                var el = document.querySelector(sel);
                if (!el) return { selector: sel, exists: false, ok: true };
                var style = window.getComputedStyle(el);
                var isHidden = style.display === 'none' || style.visibility === 'hidden';
                var isDeFixed = style.position !== 'fixed';
                return {
                    selector: sel,
                    exists: true,
                    position: style.position,
                    display: style.display,
                    ok: isHidden || isDeFixed
                };
            });
        });

        for (const r of results) {
            expect(r.ok).toBe(true);
        }
    });

    test('side-panel flows in document in screenshot mode', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard?screenshot=1', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(500);

        await page.evaluate(() => {
            var panel = document.querySelector('.side-panel');
            if (panel) panel.classList.add('open');
        });
        await page.waitForTimeout(200);

        const panelStyle = await page.evaluate(() => {
            var panel = document.querySelector('.side-panel');
            if (!panel) return null;
            var style = window.getComputedStyle(panel);
            return { position: style.position, width: style.width };
        });

        expect(panelStyle).not.toBeNull();
        expect(panelStyle.position).not.toBe('fixed');
    });

    test('side-panel-backdrop is hidden in screenshot mode', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard?screenshot=1', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(500);

        const backdropVisible = await page.evaluate(() => {
            var bd = document.querySelector('.side-panel-backdrop');
            if (!bd) return false;
            var style = window.getComputedStyle(bd);
            return style.display !== 'none';
        });

        expect(backdropVisible).toBe(false);
    });
});

// Routing tests use liveFlowTest fixture (has modelRouting enabled with tiers)
liveFlowTest.describe('Model routing enable/disable/re-enable cycle (M1.6)', () => {
    liveFlowTest('disable then re-enable model routing via API', async ({ request, proxyServer }) => {
        const baseUrl = proxyServer.url;

        // Step 1: Verify routing is initially enabled
        const initialRes = await request.get(baseUrl + '/model-routing');
        expect(initialRes.ok()).toBeTruthy();
        const initialConfig = await initialRes.json();
        expect(initialConfig.enabled).toBe(true);

        // Step 2: Disable routing via PUT /model-routing { enabled: false }
        const disableRes = await request.put(baseUrl + '/model-routing', {
            data: { enabled: false }
        });
        expect(disableRes.ok()).toBeTruthy();

        // Step 3: Verify disabled
        const disabledRes = await request.get(baseUrl + '/model-routing');
        const disabledConfig = await disabledRes.json();
        expect(disabledConfig.enabled).toBe(false);

        // Step 4: Re-enable with enable-safe + addDefaultRules
        const enableRes = await request.put(baseUrl + '/model-routing/enable-safe', {
            data: { addDefaultRules: true }
        });
        expect(enableRes.ok()).toBeTruthy();

        // Step 5: Verify re-enabled
        const reenabledRes = await request.get(baseUrl + '/model-routing');
        const reenabledConfig = await reenabledRes.json();
        expect(reenabledConfig.enabled).toBe(true);
    });

    liveFlowTest('enable-safe with addDefaultRules includes catch-all rule', async ({ request, proxyServer }) => {
        const baseUrl = proxyServer.url;

        // Disable first
        await request.put(baseUrl + '/model-routing', { data: { enabled: false } });

        // Re-enable with defaults
        const enableRes = await request.put(baseUrl + '/model-routing/enable-safe', {
            data: { addDefaultRules: true }
        });
        expect(enableRes.ok()).toBeTruthy();
        const result = await enableRes.json();

        // The response should confirm success
        expect(result.success).toBe(true);

        // Fetch current config and verify rules include a catch-all
        const configRes = await request.get(baseUrl + '/model-routing');
        const config = await configRes.json();

        // Rules live under config.rules in the toJSON() response
        const rules = config.config?.rules || config.rules;
        expect(rules).toBeDefined();
        const catchAll = rules.find(r => {
            if (!r.match) return false;
            return Object.keys(r.match).length === 0 || (!r.match.model && !r.match.tokenRange);
        });
        expect(catchAll).toBeDefined();
    });
});

liveFlowTest.describe('Tier-builder save round-trip (M1.5)', () => {
    liveFlowTest('PUT /model-routing updates tiers and GET reflects changes', async ({ request, proxyServer }) => {
        const baseUrl = proxyServer.url;

        // Step 1: Get current routing config
        const originalRes = await request.get(baseUrl + '/model-routing');
        expect(originalRes.ok()).toBeTruthy();
        const original = await originalRes.json();
        expect(original.enabled).toBe(true);

        // Step 2: Update heavy tier to include an additional model
        const putRes = await request.put(baseUrl + '/model-routing', {
            data: {
                tiers: {
                    heavy: {
                        models: ['test-model-heavy', 'extra-model'],
                        strategy: 'balanced',
                        maxConcurrency: 4
                    }
                }
            }
        });
        expect(putRes.ok()).toBeTruthy();

        // Step 3: Re-fetch and verify the change persisted
        const updatedRes = await request.get(baseUrl + '/model-routing');
        const updated = await updatedRes.json();

        // Tiers live under config.tiers in the toJSON() response
        const tiers = updated.config?.tiers || updated.tiers;
        expect(tiers).toBeDefined();
        expect(tiers.heavy.models).toContain('extra-model');
    });

    liveFlowTest('PUT /model-routing with completely invalid body returns error', async ({ request, proxyServer }) => {
        const baseUrl = proxyServer.url;

        // Send a body that should trigger validation failure
        const putRes = await request.put(baseUrl + '/model-routing', {
            headers: { 'Content-Type': 'application/json' },
            data: 'not-json'
        });

        // Should get an error status
        expect(putRes.ok()).toBeFalsy();
    });
});
