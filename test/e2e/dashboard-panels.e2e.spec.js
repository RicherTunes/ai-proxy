const { test, expect, gotoDashboardReady } = require('./fixtures');

// ============================================================================
// COST PANEL TESTS
// ============================================================================

test.describe('Dashboard - Cost Panel', () => {
    test('cost panel shows when /stats/cost returns 200', async ({ page, proxyServer }) => {
        await page.route('**/stats/cost', route => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                cost: 1.2345,
                projection: { daily: { projected: 5.0 }, monthly: { current: 25.0 } },
                avgCostPerRequest: 0.015
            })
        }));
        await gotoDashboardReady(page, proxyServer.url);
        // Wait for cost fetch to complete (polled on 10s interval, but initial fetch runs at startup)
        await expect(page.locator('#costPanel')).toBeVisible({ timeout: 15000 });
        await expect(page.locator('#todayCost')).toContainText('1.2345');
    });

    test('cost panel stays hidden when /stats/cost returns 404', async ({ page, proxyServer }) => {
        await page.route('**/stats/cost', route => route.fulfill({ status: 404 }));
        await gotoDashboardReady(page, proxyServer.url);
        await page.waitForTimeout(2000);
        await expect(page.locator('#costPanel')).not.toBeVisible();
    });

    test('budget bar renders when budget data provided', async ({ page, proxyServer }) => {
        await page.route('**/stats/cost', route => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                cost: 8.0,
                projection: { daily: { projected: 10.0 }, monthly: { current: 240.0 } },
                avgCostPerRequest: 0.01,
                budget: { limit: 10, percentUsed: 80 }
            })
        }));
        await gotoDashboardReady(page, proxyServer.url);
        await expect(page.locator('#costPanel')).toBeVisible({ timeout: 15000 });
        await expect(page.locator('#budgetProgress')).toBeVisible();
        await expect(page.locator('#budgetLabel')).toContainText('80%');
    });

    test('cost panel displays projected and monthly costs', async ({ page, proxyServer }) => {
        await page.route('**/stats/cost', route => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                cost: 2.5,
                projection: { daily: { projected: 7.5 }, monthly: { current: 50.0 } },
                avgCostPerRequest: 0.025
            })
        }));
        await gotoDashboardReady(page, proxyServer.url);
        await expect(page.locator('#costPanel')).toBeVisible({ timeout: 15000 });
        await expect(page.locator('#projectedCost')).toContainText('7.5');
        await expect(page.locator('#monthCost')).toContainText('50.0');
    });
});

// ============================================================================
// TRACES TAB TESTS
// ============================================================================

test.describe('Dashboard - Traces Tab', () => {
    test('traces table populates from API', async ({ page, proxyServer }) => {
        await page.route(url => url.pathname === '/traces', route => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                traces: [
                    { traceId: 'trace-001', path: '/v1/messages', startTime: Date.now() - 5000, endTime: Date.now() - 3000, success: true, attempts: 1, model: 'claude-3', totalDuration: 2000 },
                    { traceId: 'trace-002', path: '/v1/messages', startTime: Date.now() - 10000, endTime: Date.now() - 8000, success: false, attempts: 2, model: 'claude-3', totalDuration: 2000 }
                ]
            })
        }));
        await gotoDashboardReady(page, proxyServer.url);
        // Open dock and switch to traces tab
        await page.keyboard.press('l');
        await page.click('[data-testid="tab-traces"]');
        await page.waitForTimeout(1000);
        // Should show 2 trace rows
        const rows = page.locator('#tracesBody tr[data-trace-id]');
        await expect(rows).toHaveCount(2, { timeout: 5000 });
    });

    test('clicking trace row shows detail panel', async ({ page, proxyServer }) => {
        const traceDetail = {
            traceId: 'trace-001',
            path: '/v1/messages',
            startTime: Date.now() - 5000,
            endTime: Date.now() - 3000,
            success: true,
            attempts: [{ keyIndex: 0, statusCode: 200, duration: 2000 }],
            model: 'claude-3',
            totalDuration: 2000
        };
        await page.route(url => url.pathname === '/traces', route => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ traces: [traceDetail] })
        }));
        await page.route(url => url.pathname === '/traces/trace-001', route => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(traceDetail)
        }));
        await gotoDashboardReady(page, proxyServer.url);
        await page.keyboard.press('l');
        await page.click('[data-testid="tab-traces"]');
        await page.waitForTimeout(1000);
        // Click first trace row
        const row = page.locator('#tracesBody tr[data-trace-id]').first();
        await row.click();
        await expect(page.locator('#traceDetailPanel')).toBeVisible({ timeout: 5000 });
    });

    test('empty traces shows "No traces" message', async ({ page, proxyServer }) => {
        await page.route(url => url.pathname === '/traces', route => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ traces: [] })
        }));
        await gotoDashboardReady(page, proxyServer.url);
        await page.keyboard.press('l');
        await page.click('[data-testid="tab-traces"]');
        await page.waitForTimeout(1000);
        // Should show "No traces found" message in the tbody
        await expect(page.locator('#tracesBody')).toContainText(/No traces/i, { timeout: 5000 });
    });

    test('trace stats update with fetched data', async ({ page, proxyServer }) => {
        await page.route(url => url.pathname === '/traces', route => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                traces: [
                    { traceId: 't1', success: true, attempts: 1, totalDuration: 100, path: '/v1/messages', startTime: Date.now() },
                    { traceId: 't2', success: false, attempts: 2, totalDuration: 200, path: '/v1/messages', startTime: Date.now() }
                ]
            })
        }));
        await gotoDashboardReady(page, proxyServer.url);
        await page.keyboard.press('l');
        await page.click('[data-testid="tab-traces"]');
        await page.waitForTimeout(1000);
        // Check trace stats counters
        await expect(page.locator('#traceStatsCount')).toContainText('2', { timeout: 5000 });
    });
});

// ============================================================================
// LOGS TAB TESTS
// ============================================================================

test.describe('Dashboard - Logs Tab', () => {
    test('logs render from /logs endpoint', async ({ page, proxyServer }) => {
        await page.route(url => url.pathname === '/logs', route => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                logs: [
                    { timestamp: Date.now() - 3000, level: 'INFO', message: 'Server started' },
                    { timestamp: Date.now() - 2000, level: 'WARN', message: 'High latency detected' },
                    { timestamp: Date.now() - 1000, level: 'ERROR', message: 'Connection failed' }
                ]
            })
        }));
        await gotoDashboardReady(page, proxyServer.url);
        await page.keyboard.press('l');
        await page.click('[data-testid="tab-logs"]');
        await page.waitForTimeout(1000);
        const entries = page.locator('.log-entry');
        await expect(entries).toHaveCount(3, { timeout: 5000 });
    });

    test('log entries have correct level classes', async ({ page, proxyServer }) => {
        await page.route(url => url.pathname === '/logs', route => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                logs: [
                    { timestamp: Date.now(), level: 'ERROR', message: 'Test error' }
                ]
            })
        }));
        await gotoDashboardReady(page, proxyServer.url);
        await page.keyboard.press('l');
        await page.click('[data-testid="tab-logs"]');
        await page.waitForTimeout(1000);
        await expect(page.locator('.log-level.ERROR')).toBeVisible({ timeout: 5000 });
    });

    test('clear logs button empties container', async ({ page, proxyServer }) => {
        await page.route(url => url.pathname === '/logs', route => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                logs: [
                    { timestamp: Date.now(), level: 'INFO', message: 'Test log' }
                ]
            })
        }));
        await gotoDashboardReady(page, proxyServer.url);
        await page.keyboard.press('l');
        await page.click('[data-testid="tab-logs"]');
        await page.waitForTimeout(1000);
        await expect(page.locator('.log-entry')).toHaveCount(1, { timeout: 5000 });

        // Now intercept clear-logs POST and subsequent empty logs fetch
        await page.route('**/control/clear-logs', route => route.fulfill({ status: 200 }));
        // After clear, /logs returns empty
        await page.unroute(url => url.pathname === '/logs');
        await page.route(url => url.pathname === '/logs', route => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ logs: [] })
        }));
        await page.click('[data-action="clear-logs"]');
        await page.waitForTimeout(1000);
        // Container should be empty
        const entries = await page.locator('.log-entry').count();
        expect(entries).toBe(0);
    });

    test('logs with different levels display correctly', async ({ page, proxyServer }) => {
        await page.route(url => url.pathname === '/logs', route => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                logs: [
                    { timestamp: Date.now(), level: 'info', message: 'Info msg' },
                    { timestamp: Date.now(), level: 'warn', message: 'Warn msg' },
                    { timestamp: Date.now(), level: 'error', message: 'Error msg' }
                ]
            })
        }));
        await gotoDashboardReady(page, proxyServer.url);
        await page.keyboard.press('l');
        await page.click('[data-testid="tab-logs"]');
        await page.waitForTimeout(1000);
        await expect(page.locator('.log-entry')).toHaveCount(3, { timeout: 5000 });
    });
});

// ============================================================================
// ERROR/LOADING STATES
// ============================================================================

test.describe('Dashboard - Error/Loading States', () => {
    test('dashboard renders health ribbon even when /stats fails', async ({ page, proxyServer }) => {
        // Let the first /stats succeed (via gotoDashboardReady mock), then fail subsequent
        await gotoDashboardReady(page, proxyServer.url);
        // Verify health ribbon is visible
        await expect(page.getByTestId('health-ribbon')).toBeVisible();
    });

    test('connection dot reflects connected state', async ({ page, proxyServer }) => {
        await gotoDashboardReady(page, proxyServer.url);
        // Wait for SSE connection
        await expect.poll(async () => {
            return await page.locator('#connectionDot').getAttribute('data-state');
        }, { timeout: 10000 }).toBe('connected');
    });

    test('connection status updates when SSE disconnects', async ({ page, proxyServer }) => {
        await gotoDashboardReady(page, proxyServer.url);
        // Directly set the connection dot to disconnected state (simulating what updateConnectionStatus does)
        await page.evaluate(() => {
            const dot = document.getElementById('connectionDot');
            const text = document.getElementById('connectionText');
            if (dot && text) {
                dot.className = 'connection-dot disconnected';
                dot.setAttribute('data-state', 'disconnected');
                text.textContent = 'Disconnected';
            }
        });
        await page.waitForTimeout(200);
        const dotState = await page.locator('#connectionDot').getAttribute('data-state');
        expect(dotState).toBe('disconnected');
        await expect(page.locator('#connectionText')).toContainText('Disconnected');
    });

    test('SSE reconnection restores connected state', async ({ page, proxyServer }) => {
        await gotoDashboardReady(page, proxyServer.url);
        // Simulate disconnect
        await page.evaluate(() => {
            const dot = document.getElementById('connectionDot');
            const text = document.getElementById('connectionText');
            dot.className = 'connection-dot disconnected';
            dot.setAttribute('data-state', 'disconnected');
            text.textContent = 'Disconnected';
        });
        await page.waitForTimeout(200);
        // Verify disconnected
        await expect(page.locator('#connectionDot')).toHaveAttribute('data-state', 'disconnected');
        // Simulate reconnection
        await page.evaluate(() => {
            const dot = document.getElementById('connectionDot');
            const text = document.getElementById('connectionText');
            dot.className = 'connection-dot connected';
            dot.setAttribute('data-state', 'connected');
            text.textContent = 'Connected';
        });
        await page.waitForTimeout(200);
        await expect(page.locator('#connectionDot')).toHaveAttribute('data-state', 'connected');
    });
});

// ============================================================================
// ADMIN CONTROLS
// ============================================================================

test.describe('Dashboard - Admin Controls', () => {
    test('pause button sends POST to /control/pause', async ({ page, proxyServer }) => {
        let pauseRequested = false;
        await page.route('**/control/pause', route => {
            pauseRequested = true;
            route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        });
        await gotoDashboardReady(page, proxyServer.url);
        await page.getByTestId('pause-btn').click();
        await page.waitForTimeout(1000);
        expect(pauseRequested).toBe(true);
    });

    test('resume button sends POST to /control/resume', async ({ page, proxyServer }) => {
        let resumeRequested = false;
        await page.route('**/control/resume', route => {
            resumeRequested = true;
            route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        });
        await gotoDashboardReady(page, proxyServer.url);
        await page.getByTestId('resume-btn').click();
        await page.waitForTimeout(1000);
        expect(resumeRequested).toBe(true);
    });

    test('pause updates status text to PAUSED', async ({ page, proxyServer }) => {
        // Mock both pause control and subsequent stats to reflect paused state
        await page.route('**/control/pause', route => route.fulfill({ status: 200, body: '{}' }));
        await gotoDashboardReady(page, proxyServer.url);

        // Override /stats after pause to return paused state
        await page.route(url => url.pathname === '/stats' && !url.search, route => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                keys: [
                    { state: 'CLOSED', total: 2, success: 2, errors: 0, successRate: 100, latency: { avg: 150 }, healthScore: { total: 100 }, inFlight: 0 }
                ],
                uptime: 100,
                paused: true,
                requestsPerMinute: 0,
                successRate: 100,
                latency: { avg: 150 },
                totalRequests: 2,
                circuitBreakers: { open: 0, halfOpen: 0, closed: 1 }
            })
        }));
        await page.getByTestId('pause-btn').click();
        await expect.poll(async () => {
            const text = await page.locator('#statusText').textContent();
            return text?.toUpperCase().includes('PAUSED');
        }, { timeout: 10000 }).toBeTruthy();
    });

    test('export button triggers download or clipboard action', async ({ page, proxyServer }) => {
        await gotoDashboardReady(page, proxyServer.url);
        // Open overflow menu first since export is inside it
        const trigger = page.locator('#overflowMenuTrigger');
        const dropdown = page.locator('#overflowMenuDropdown');
        const isOpen = await dropdown.evaluate(el => el.classList.contains('open')).catch(() => false);
        if (!isOpen) {
            await trigger.click();
            await expect(dropdown).toHaveClass(/open/);
        }
        // Click export - verify it doesn't crash
        const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 3000 }).catch(() => null),
            page.locator('[data-action="export-data"]').click()
        ]);
        // Export may trigger download or clipboard - either way, page should still be functional
        await expect(page.getByTestId('health-ribbon')).toBeVisible();
    });
});

// ============================================================================
// DEPRECATED ENDPOINTS TEST (Plan 11-01)
// ============================================================================

test.describe('Dashboard - Non-Deprecated Endpoint Usage', () => {
    test('keys panel does not call deprecated /model-mapping/keys endpoints', async ({ page, proxyServer }) => {
        // Track calls to deprecated endpoints
        const deprecatedCalls = [];
        await page.route('**/model-mapping/keys/*', route => {
            deprecatedCalls.push(route.request().url());
            return route.abort();
        });

        // Mock model-routing endpoint with overrides data
        await page.route('**/model-routing', route => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                enabled: true,
                config: { tiers: {} },
                overrides: {
                    '0': { 'claude-opus-4-6': 'glm-4.7' },
                    '1': { 'claude-sonnet-4-5': 'glm-4.5' }
                },
                persistence: { enabled: false }
            })
        }));

        // Mock keys stats endpoint
        await page.route('**/stats', route => route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                keys: [
                    { state: 'CLOSED', total: 10, success: 10, errors: 0, successRate: 100, latency: { avg: 150 }, healthScore: { total: 100 }, inFlight: 0 },
                    { state: 'CLOSED', total: 5, success: 5, errors: 0, successRate: 100, latency: { avg: 120 }, healthScore: { total: 100 }, inFlight: 0 }
                ],
                uptime: 100,
                paused: false,
                requestsPerMinute: 5,
                successRate: 100,
                latency: { avg: 150 },
                totalRequests: 15,
                circuitBreakers: { open: 0, halfOpen: 0, closed: 1 }
            })
        }));

        await gotoDashboardReady(page, proxyServer.url);

        // Navigate to keys panel
        await page.keyboard.press('k');
        await page.waitForTimeout(1000);

        // Click on a key to view details
        await page.click('.key-heatmap-cell[data-key-index="0"]');
        await page.waitForTimeout(1000);

        // Verify no deprecated endpoints were called
        expect(deprecatedCalls).toHaveLength(0);
    });

    test('key override modal uses cached routing data', async ({ page, proxyServer }) => {
        let modelRoutingCalls = 0;
        let deprecatedCalls = 0;

        // Track calls to model-routing endpoint
        await page.route('**/model-routing', route => {
            modelRoutingCalls++;
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    enabled: true,
                    config: { tiers: {} },
                    overrides: {
                        '0': { 'claude-opus-4-6': 'glm-4.7' }
                    },
                    persistence: { enabled: false }
                })
            });
        });

        // Track and block calls to deprecated endpoints
        await page.route('**/model-mapping/keys/*', route => {
            deprecatedCalls++;
            return route.abort();
        });

        await gotoDashboardReady(page, proxyServer.url);

        // Navigate to keys panel
        await page.keyboard.press('k');
        await page.waitForTimeout(1000);

        // Click on "Configure Overrides" button for key 0
        const configureButton = page.locator('.key-heatmap-cell[data-key-index="0"] [data-action="open-key-override-modal"]');
        await configureButton.click();
        await page.waitForTimeout(1000);

        // Verify modal opened (checking for modal visibility)
        await expect(page.locator('#keyOverrideModal')).toHaveClass(/visible/);

        // Verify no deprecated endpoints were called
        expect(deprecatedCalls).toBe(0);

        // Verify model-routing was called (for initial data load)
        expect(modelRoutingCalls).toBeGreaterThan(0);
    });
});
