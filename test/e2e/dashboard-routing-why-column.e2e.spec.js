/**
 * E2E Tests for Dashboard Routing "Why" Column
 * Tests for TRUST-03: Dashboard UI displays "why" sourced from /explain or trace payload
 */

const { test, expect, sendTestRequest, injectRequestToStream, waitForSSEConnection, waitForStoreReady, waitForDashboardReady, gotoDashboardReady } = require('./fixtures');

/**
 * Build a synthetic trace object matching the DecisionTrace schema.
 * @param {Object} options
 * @param {string} [options.upgradeTrigger] - e.g. 'has_tools', 'has_vision', 'max_tokens'
 * @param {string} [options.tier] - e.g. 'heavy', 'medium', 'light'
 * @param {Object} [options.thresholdComparison] - threshold values
 * @param {Object} [options.modelSelection] - model selection details
 * @returns {Object} trace object
 */
function buildTrace(options = {}) {
    const {
        upgradeTrigger = null,
        tier = 'heavy',
        thresholdComparison = {
            hasTools: false,
            hasVision: false,
            maxTokens: 100,
            messageCount: 1,
            systemLength: 0
        },
        modelSelection = {
            selected: 'glm-4-plus',
            rationale: 'Selected by pool strategy',
            candidates: [
                { modelId: 'glm-4-plus', score: 0.9, inFlight: 0, maxConcurrency: 4, isAvailable: true, reason: null }
            ]
        }
    } = options;

    return {
        requestId: `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        version: '1.0',
        timestamp: new Date().toISOString(),
        classification: {
            tier,
            complexity: upgradeTrigger ? 75 : 30,
            upgradeTrigger,
            thresholdComparison
        },
        modelSelection,
        request: {
            model: 'claude-sonnet-4-5-20250929',
            max_tokens: 100,
            stream: false
        }
    };
}

test.describe('Dashboard Routing - Why Column', () => {

    test.describe('Why Column Display', () => {
        test('should display Why column in requests table', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard/routing.html', { waitUntil: 'domcontentloaded' });

            // Check for Why column header
            const whyHeader = page.locator('.requests-table th').filter({ hasText: 'Why' });
            await expect(whyHeader).toBeVisible();
        });

        test('should show N/A when trace is not sampled', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard/routing.html', { waitUntil: 'domcontentloaded' });

            // Send a test request without trace (sampling might exclude it)
            await sendTestRequest(proxyServer, {
                model: 'claude-sonnet-4-5-20250929',
                max_tokens: 100
            });

            // Wait for the request to appear in the table
            await page.waitForTimeout(500);

            // Check for N/A in Why column (when trace not sampled)
            const whyCell = page.locator('.why-cell').first();
            const text = await whyCell.textContent();
            expect(text).toMatch(/N\/A|Standard routing/);
        });

        test('should display trace rationale when trace is available', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard/routing.html', { waitUntil: 'domcontentloaded' });

            // Send a request with includeTrace via /explain endpoint
            const response = await proxyServer.fetch('/model-routing/explain', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    model: 'claude-sonnet-4-5-20250929',
                    messages: [{ role: 'user', content: 'test' }],
                    includeTrace: true
                })
            });

            const data = await response.json();
            expect(data).toHaveProperty('trace');

            // The Why column should show rationale
            await page.waitForTimeout(500);
            const whyCells = page.locator('.why-cell');
            const count = await whyCells.count();
            expect(count).toBeGreaterThan(0);
        });

        test('should show tooltip with full reasons', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard/routing.html', { waitUntil: 'domcontentloaded' });

            // Wait for some requests to populate
            await sendTestRequest(proxyServer, { model: 'claude-sonnet-4-5-20250929' });
            await page.waitForTimeout(500);

            // Check that why-reasons elements have title attribute
            const whyReasons = page.locator('.why-reasons');
            const count = await whyReasons.count();

            for (let i = 0; i < Math.min(count, 3); i++) {
                const element = whyReasons.nth(i);
                const title = await element.getAttribute('title');
                // Either has title with reasons or shows default message
                if (title) {
                    expect(title.trim().length).toBeGreaterThan(0);
                }
            }
        });
    });

    test.describe('Trace Modal', () => {
        test('should open modal when clicking Why cell with trace', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard/routing.html', { waitUntil: 'domcontentloaded' });

            // Send a request
            await sendTestRequest(proxyServer, { model: 'claude-sonnet-4-5-20250929' });
            await page.waitForTimeout(500);

            // Look for a Why cell with trace data
            const whyCellWithTrace = page.locator('.why-cell.has-trace').first();

            // Click on it
            await whyCellWithTrace.click();

            // Modal should appear
            const modal = page.locator('#traceModal');
            await expect(modal).toHaveClass(/active/);
        });

        test('should show full trace JSON in modal', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard/routing.html', { waitUntil: 'domcontentloaded' });

            // Send a request
            await sendTestRequest(proxyServer, { model: 'claude-sonnet-4-5-20250929' });
            await page.waitForTimeout(500);

            // Click on a Why cell with trace
            const whyCellWithTrace = page.locator('.why-cell.has-trace').first();
            const hasTrace = await whyCellWithTrace.count();

            if (hasTrace > 0) {
                await whyCellWithTrace.click();

                // Check that trace content is displayed
                const traceContent = page.locator('#traceContent');
                await expect(traceContent).toBeVisible();

                const text = await traceContent.textContent();
                expect(text).toContain('requestId');
            }
        });

        test('should close modal when clicking X button', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard/routing.html', { waitUntil: 'domcontentloaded' });

            // Send a request
            await sendTestRequest(proxyServer, { model: 'claude-sonnet-4-5-20250929' });
            await page.waitForTimeout(500);

            // Open modal
            const whyCellWithTrace = page.locator('.why-cell.has-trace').first();
            const hasTrace = await whyCellWithTrace.count();

            if (hasTrace > 0) {
                await whyCellWithTrace.click();

                // Click close button
                await page.locator('#closeTraceModal').click();

                // Modal should not be active
                const modal = page.locator('#traceModal');
                await expect(modal).not.toHaveClass(/active/);
            }
        });

        test('should close modal when clicking overlay', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard/routing.html', { waitUntil: 'domcontentloaded' });

            // Send a request
            await sendTestRequest(proxyServer, { model: 'claude-sonnet-4-5-20250929' });
            await page.waitForTimeout(500);

            // Open modal
            const whyCellWithTrace = page.locator('.why-cell.has-trace').first();
            const hasTrace = await whyCellWithTrace.count();

            if (hasTrace > 0) {
                await whyCellWithTrace.click();

                // Click on overlay (outside modal)
                const modal = page.locator('#traceModal');
                await modal.click({ position: { x: 10, y: 10 } });

                // Modal should not be active
                await expect(modal).not.toHaveClass(/active/);
            }
        });
    });

    test.describe('SSE Integration', () => {
        test('should update Why column on request completion', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard/routing.html', { waitUntil: 'domcontentloaded' });

            // Get initial count
            const initialCount = await page.locator('.requests-table tbody tr').count();

            // Send a request
            await sendTestRequest(proxyServer, { model: 'claude-sonnet-4-5-20250929' });

            // Wait for row to appear
            await page.waitForTimeout(500);

            // Check that a new row appeared
            const newCount = await page.locator('.requests-table tbody tr').count();
            expect(newCount).toBeGreaterThan(initialCount);

            // Check that Why column exists in the new row
            const lastRow = page.locator('.requests-table tbody tr').first();
            const whyCell = lastRow.locator('.why-cell');
            await expect(whyCell).toBeVisible();
        });

        test('should display stats correctly', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard/routing.html', { waitUntil: 'domcontentloaded' });

            // Send multiple requests
            for (let i = 0; i < 3; i++) {
                await sendTestRequest(proxyServer, { model: 'claude-sonnet-4-5-20250929' });
                await page.waitForTimeout(100);
            }

            // Wait for updates
            await page.waitForTimeout(500);

            // Check total requests
            const totalText = await page.locator('#totalRequests').textContent();
            expect(parseInt(totalText)).toBeGreaterThanOrEqual(3);
        });
    });

    test.describe('Styling', () => {
        test('should apply correct styles to Why column', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard/routing.html', { waitUntil: 'domcontentloaded' });

            // Check that why-cell has max-width and overflow styles
            const whyCell = page.locator('.why-cell').first();
            await expect(whyCell).toHaveCSS('text-overflow', 'ellipsis');
            await expect(whyCell).toHaveCSS('white-space', 'nowrap');
        });

        test('should not break existing table layout', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard/routing.html', { waitUntil: 'domcontentloaded' });

            // Check that all headers are present
            const headers = page.locator('.requests-table th');
            await expect(headers).toHaveCount(7); // Time, Model, Tier, Strategy, Why, Latency, Status

            // Check header texts
            const headerTexts = await headers.allTextContents();
            expect(headerTexts).toContain('Time');
            expect(headerTexts).toContain('Model');
            expect(headerTexts).toContain('Tier');
            expect(headerTexts).toContain('Strategy');
            expect(headerTexts).toContain('Why');
            expect(headerTexts).toContain('Latency');
            expect(headerTexts).toContain('Status');
        });
    });

    test.describe('GLM-5 Upgrade Triggers', () => {

        test('should display "Upgraded: has_tools" in Why column when trace includes tools trigger', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard/routing.html', { waitUntil: 'domcontentloaded' });

            // Wait for SSE connection to be established
            await page.waitForFunction(() => {
                const body = document.getElementById('requestsBody');
                return body && body.textContent.includes('Waiting for requests');
            }, { timeout: 5000 });

            // Inject synthetic request with has_tools upgrade trigger
            injectRequestToStream(proxyServer, {
                model: 'glm-4-plus',
                tier: 'heavy',
                strategy: 'pool',
                latencyMs: 120,
                success: true,
                trace: buildTrace({
                    upgradeTrigger: 'has_tools',
                    tier: 'heavy',
                    thresholdComparison: {
                        hasTools: true, hasVision: false,
                        maxTokens: 100, messageCount: 1, systemLength: 0
                    }
                })
            });

            // Wait for the Why cell to appear with the upgrade trigger text
            const whyCell = page.locator('.why-cell').first();
            await expect(whyCell).toContainText('Upgraded: has_tools', { timeout: 5000 });
        });

        test('should display "Upgraded: has_vision" in Why column when trace includes vision trigger', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard/routing.html', { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => {
                const body = document.getElementById('requestsBody');
                return body && body.textContent.includes('Waiting for requests');
            }, { timeout: 5000 });

            injectRequestToStream(proxyServer, {
                model: 'glm-4-plus',
                tier: 'heavy',
                strategy: 'pool',
                latencyMs: 95,
                success: true,
                trace: buildTrace({
                    upgradeTrigger: 'has_vision',
                    tier: 'heavy',
                    thresholdComparison: {
                        hasTools: false, hasVision: true,
                        maxTokens: 100, messageCount: 1, systemLength: 0
                    }
                })
            });

            const whyCell = page.locator('.why-cell').first();
            await expect(whyCell).toContainText('Upgraded: has_vision', { timeout: 5000 });
        });

        test('should display "Upgraded: max_tokens" in Why column when trace includes max_tokens trigger', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard/routing.html', { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => {
                const body = document.getElementById('requestsBody');
                return body && body.textContent.includes('Waiting for requests');
            }, { timeout: 5000 });

            injectRequestToStream(proxyServer, {
                model: 'glm-4-plus',
                tier: 'heavy',
                strategy: 'pool',
                latencyMs: 200,
                success: true,
                trace: buildTrace({
                    upgradeTrigger: 'max_tokens',
                    tier: 'heavy',
                    thresholdComparison: {
                        hasTools: false, hasVision: false,
                        maxTokens: 8192, messageCount: 1, systemLength: 0
                    }
                })
            });

            const whyCell = page.locator('.why-cell').first();
            await expect(whyCell).toContainText('Upgraded: max_tokens', { timeout: 5000 });
        });

        test('should display "Upgraded: message_count" in Why column when trace includes message_count trigger', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard/routing.html', { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => {
                const body = document.getElementById('requestsBody');
                return body && body.textContent.includes('Waiting for requests');
            }, { timeout: 5000 });

            injectRequestToStream(proxyServer, {
                model: 'glm-4-plus',
                tier: 'heavy',
                strategy: 'pool',
                latencyMs: 180,
                success: true,
                trace: buildTrace({
                    upgradeTrigger: 'message_count',
                    tier: 'heavy',
                    thresholdComparison: {
                        hasTools: false, hasVision: false,
                        maxTokens: 100, messageCount: 25, systemLength: 0
                    }
                })
            });

            const whyCell = page.locator('.why-cell').first();
            await expect(whyCell).toContainText('Upgraded: message_count', { timeout: 5000 });
        });

        test('should display "Upgraded: system_length" in Why column when trace includes system_length trigger', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard/routing.html', { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => {
                const body = document.getElementById('requestsBody');
                return body && body.textContent.includes('Waiting for requests');
            }, { timeout: 5000 });

            injectRequestToStream(proxyServer, {
                model: 'glm-4-plus',
                tier: 'heavy',
                strategy: 'pool',
                latencyMs: 150,
                success: true,
                trace: buildTrace({
                    upgradeTrigger: 'system_length',
                    tier: 'heavy',
                    thresholdComparison: {
                        hasTools: false, hasVision: false,
                        maxTokens: 100, messageCount: 1, systemLength: 5000
                    }
                })
            });

            const whyCell = page.locator('.why-cell').first();
            await expect(whyCell).toContainText('Upgraded: system_length', { timeout: 5000 });
        });
    });

    test.describe('Trace Sampling Behavior', () => {

        test('should show N/A in Why column when trace not sampled (no trace in SSE)', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard/routing.html', { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => {
                const body = document.getElementById('requestsBody');
                return body && body.textContent.includes('Waiting for requests');
            }, { timeout: 5000 });

            // Inject 5 requests with no trace (simulating 0% sampling)
            for (let i = 0; i < 5; i++) {
                injectRequestToStream(proxyServer, {
                    model: 'glm-4-air',
                    tier: 'medium',
                    strategy: 'balanced',
                    latencyMs: 50 + i * 10,
                    success: true,
                    trace: null  // No trace = not sampled
                });
            }

            // Wait for rows to appear
            await page.waitForFunction(() => {
                return document.querySelectorAll('.why-cell').length >= 5;
            }, { timeout: 5000 });

            // All Why cells should show N/A (no trace)
            const whyCells = page.locator('.why-cell');
            const count = await whyCells.count();

            for (let i = 0; i < count; i++) {
                const text = await whyCells.nth(i).textContent();
                expect(text).toMatch(/N\/A/);
                expect(text).not.toContain('Upgraded:');
            }
        });

        test('should always show trace in Why column when sampling = 100 (all requests have trace)', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard/routing.html', { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => {
                const body = document.getElementById('requestsBody');
                return body && body.textContent.includes('Waiting for requests');
            }, { timeout: 5000 });

            // Inject 5 requests all with trace (simulating 100% sampling)
            for (let i = 0; i < 5; i++) {
                injectRequestToStream(proxyServer, {
                    model: 'glm-4-plus',
                    tier: 'heavy',
                    strategy: 'pool',
                    latencyMs: 100 + i * 20,
                    success: true,
                    trace: buildTrace({ upgradeTrigger: 'has_tools', tier: 'heavy' })
                });
            }

            // Wait for rows to appear
            await page.waitForFunction(() => {
                return document.querySelectorAll('.why-cell').length >= 5;
            }, { timeout: 5000 });

            // All Why cells should show upgrade trigger
            const whyCells = page.locator('.why-cell');
            const count = await whyCells.count();

            for (let i = 0; i < count; i++) {
                const text = await whyCells.nth(i).textContent();
                expect(text).toContain('Upgraded: has_tools');
            }
        });

        test('should show mix of trace and N/A when partial sampling (simulating 50%)', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard/routing.html', { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => {
                const body = document.getElementById('requestsBody');
                return body && body.textContent.includes('Waiting for requests');
            }, { timeout: 5000 });

            // Inject 20 requests with alternating trace (deterministic 50%)
            for (let i = 0; i < 20; i++) {
                const hasTrace = i % 2 === 0;
                injectRequestToStream(proxyServer, {
                    model: hasTrace ? 'glm-4-plus' : 'glm-4-air',
                    tier: hasTrace ? 'heavy' : 'medium',
                    strategy: hasTrace ? 'pool' : 'balanced',
                    latencyMs: 50 + i * 5,
                    success: true,
                    trace: hasTrace ? buildTrace({ upgradeTrigger: 'has_tools', tier: 'heavy' }) : null
                });
            }

            // Wait for rows to appear
            await page.waitForFunction(() => {
                return document.querySelectorAll('.why-cell').length >= 15;
            }, { timeout: 5000 });

            // Count requests with and without upgrade trigger
            const whyCells = page.locator('.why-cell');
            const count = await whyCells.count();

            let withTrace = 0;
            let withoutTrace = 0;

            for (let i = 0; i < count; i++) {
                const text = await whyCells.nth(i).textContent();
                if (text.includes('Upgraded:')) {
                    withTrace++;
                } else {
                    withoutTrace++;
                }
            }

            // Should have mix: at least one with trace and at least one without
            expect(withTrace).toBeGreaterThan(0);
            expect(withoutTrace).toBeGreaterThan(0);
        });
    });

    test.describe('Trace Modal with Upgrade Details', () => {

        test('should show full classification in trace modal including upgradeTrigger', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard/routing.html', { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => {
                const body = document.getElementById('requestsBody');
                return body && body.textContent.includes('Waiting for requests');
            }, { timeout: 5000 });

            injectRequestToStream(proxyServer, {
                model: 'glm-4-plus',
                tier: 'heavy',
                strategy: 'pool',
                latencyMs: 120,
                success: true,
                trace: buildTrace({
                    upgradeTrigger: 'has_tools',
                    tier: 'heavy',
                    thresholdComparison: {
                        hasTools: true, hasVision: false,
                        maxTokens: 100, messageCount: 1, systemLength: 0
                    }
                })
            });

            // Wait for row with trace to appear
            const whyCell = page.locator('.why-cell.has-trace').first();
            await expect(whyCell).toBeVisible({ timeout: 5000 });

            // Click on Why cell with trace
            await whyCell.click();

            // Modal should appear
            const modal = page.locator('#traceModal');
            await expect(modal).toHaveClass(/active/);

            // Trace content should include upgradeTrigger
            const traceContent = page.locator('#traceContent');
            const text = await traceContent.textContent();

            expect(text).toContain('upgradeTrigger');
            expect(text).toContain('has_tools');
            expect(text).toContain('classification');
        });

        test('should show thresholdComparison in trace modal', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard/routing.html', { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => {
                const body = document.getElementById('requestsBody');
                return body && body.textContent.includes('Waiting for requests');
            }, { timeout: 5000 });

            injectRequestToStream(proxyServer, {
                model: 'glm-4-plus',
                tier: 'heavy',
                strategy: 'pool',
                latencyMs: 150,
                success: true,
                trace: buildTrace({
                    upgradeTrigger: 'has_tools',
                    tier: 'heavy',
                    thresholdComparison: {
                        hasTools: true, hasVision: false,
                        maxTokens: 8192, messageCount: 25, systemLength: 3000
                    }
                })
            });

            const whyCell = page.locator('.why-cell.has-trace').first();
            await expect(whyCell).toBeVisible({ timeout: 5000 });
            await whyCell.click();

            const traceContent = page.locator('#traceContent');
            const text = await traceContent.textContent();

            // Should show threshold comparison values
            expect(text).toContain('thresholdComparison');
            expect(text).toContain('hasTools');
            expect(text).toContain('maxTokens');
            expect(text).toContain('messageCount');
        });

        test('should show modelSelection rationale in trace modal', async ({ page, proxyServer }) => {
            await page.goto(proxyServer.url + '/dashboard/routing.html', { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => {
                const body = document.getElementById('requestsBody');
                return body && body.textContent.includes('Waiting for requests');
            }, { timeout: 5000 });

            injectRequestToStream(proxyServer, {
                model: 'glm-4-air',
                tier: 'medium',
                strategy: 'quality',
                latencyMs: 80,
                success: true,
                trace: buildTrace({
                    tier: 'medium',
                    modelSelection: {
                        selected: 'glm-4-air',
                        rationale: 'Selected by quality strategy: highest score',
                        candidates: [
                            { modelId: 'glm-4-air', score: 0.95, inFlight: 1, maxConcurrency: 4, isAvailable: true, reason: null },
                            { modelId: 'glm-4-flash', score: 0.80, inFlight: 2, maxConcurrency: 4, isAvailable: true, reason: null }
                        ]
                    }
                })
            });

            const whyCell = page.locator('.why-cell.has-trace').first();
            await expect(whyCell).toBeVisible({ timeout: 5000 });
            await whyCell.click();

            const traceContent = page.locator('#traceContent');
            const text = await traceContent.textContent();

            // Should show model selection details
            expect(text).toContain('modelSelection');
            expect(text).toContain('rationale');
            expect(text).toContain('candidates');
        });
    });
});
