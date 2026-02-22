const { test, expect, gotoDashboardReady } = require('./fixtures');

test.describe('Virtualization-native Filtering (M4)', () => {
    test.beforeEach(async ({ page }) => {
        // Abort SSE streams to prevent interference with injected test data
        await page.route('**/events', route => route.abort());
        await page.route('**/requests/stream', route => route.abort());
    });

    test('filter reduces visible rows in virtual list', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1000);

        // Inject test data directly into STATE.requestsHistory
        await page.evaluate(() => {
            var STATE = window.DashboardStore?.STATE;
            if (!STATE) return;
            for (var i = 0; i < 20; i++) {
                var req = {
                    requestId: 'filter-test-' + i,
                    timestamp: Date.now() - i * 1000,
                    keyIndex: 0,
                    path: '/v1/messages',
                    originalModel: 'claude-sonnet-4-20250514',
                    mappedModel: 'claude-sonnet-4-20250514',
                    status: i % 2 === 0 ? 'completed' : 'pending',
                    error: i >= 16 ? 'test error' : null,
                    latency: 100 + i * 10
                };
                STATE.requestsHistory.push(req);
            }
            if (window.DashboardSSE?.scheduleVirtualRender) {
                window.DashboardSSE.scheduleVirtualRender();
            }
        });
        await page.waitForTimeout(500);

        // Count initial rows
        const initialCount = await page.locator('#liveStreamRequestList .request-row').count();
        expect(initialCount).toBeGreaterThan(0);

        // Apply status filter to 'success' (completed)
        const filterStatus = page.locator('#filterStatus');
        if (await filterStatus.count() > 0 && await filterStatus.isVisible()) {
            await filterStatus.selectOption('success');
            await page.waitForTimeout(300);

            const filteredCount = await page.locator('#liveStreamRequestList .request-row').count();
            // Should have fewer rows after filtering
            expect(filteredCount).toBeLessThan(initialCount);
        }
    });

    test('clear filters restores all rows', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1000);

        // Inject test data
        await page.evaluate(() => {
            var STATE = window.DashboardStore?.STATE;
            if (!STATE) return;
            for (var i = 0; i < 10; i++) {
                STATE.requestsHistory.push({
                    requestId: 'clear-test-' + i,
                    timestamp: Date.now() - i * 1000,
                    keyIndex: 0,
                    path: '/v1/messages',
                    originalModel: 'claude-sonnet-4-20250514',
                    mappedModel: 'claude-sonnet-4-20250514',
                    status: i < 5 ? 'completed' : 'pending',
                    error: null,
                    latency: 100 + i * 10
                });
            }
            if (window.DashboardSSE?.scheduleVirtualRender) {
                window.DashboardSSE.scheduleVirtualRender();
            }
        });
        await page.waitForTimeout(500);

        const initialCount = await page.locator('#liveStreamRequestList .request-row').count();

        // Apply a filter first
        const filterStatus = page.locator('#filterStatus');
        if (await filterStatus.count() > 0 && await filterStatus.isVisible()) {
            await filterStatus.selectOption('success');
            await page.waitForTimeout(300);
        }

        // Clear filters via the clearFilters function
        await page.evaluate(() => {
            if (window.DashboardFilters?.clearFilters) {
                window.DashboardFilters.clearFilters();
            }
        });
        await page.waitForTimeout(300);

        // All rows should be visible again (unfiltered)
        const totalRows = await page.locator('#liveStreamRequestList .request-row').count();
        expect(totalRows).toBeGreaterThanOrEqual(initialCount);
    });

    test('getFilteredRequests returns correct subset', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1000);

        // Inject test data and verify data-driven filtering
        const result = await page.evaluate(() => {
            var STATE = window.DashboardStore?.STATE;
            if (!STATE) return { error: 'no state' };

            // Clear existing data
            STATE.requestsHistory = [];
            for (var i = 0; i < 10; i++) {
                STATE.requestsHistory.push({
                    requestId: 'data-test-' + i,
                    timestamp: Date.now() - i * 1000,
                    keyIndex: i % 3,
                    path: '/v1/messages',
                    originalModel: i < 5 ? 'claude-sonnet-4-20250514' : 'claude-opus-4-20250514',
                    mappedModel: i < 5 ? 'claude-sonnet-4-20250514' : 'claude-opus-4-20250514',
                    status: i % 2 === 0 ? 'completed' : 'pending',
                    error: null,
                    latency: 100
                });
            }

            // Test with no filters
            STATE.filters = { status: '', key: '', model: '' };
            var all = window.DashboardFilters?.getFilteredRequests();

            // Test with status filter
            STATE.filters = { status: 'success', key: '', model: '' };
            var successOnly = window.DashboardFilters?.getFilteredRequests();

            // Test with model filter
            STATE.filters = { status: '', key: '', model: 'opus' };
            var opusOnly = window.DashboardFilters?.getFilteredRequests();

            // Test with key filter
            STATE.filters = { status: '', key: '0', model: '' };
            var key0Only = window.DashboardFilters?.getFilteredRequests();

            // Reset filters
            STATE.filters = { status: '', key: '', model: '' };

            return {
                totalCount: all ? all.length : -1,
                successCount: successOnly ? successOnly.length : -1,
                opusCount: opusOnly ? opusOnly.length : -1,
                key0Count: key0Only ? key0Only.length : -1
            };
        });

        expect(result.totalCount).toBe(10);
        expect(result.successCount).toBe(5);  // i=0,2,4,6,8 are 'completed' -> 'success'
        expect(result.opusCount).toBe(5);     // i=5,6,7,8,9 have 'opus'
        expect(result.key0Count).toBe(4);     // i=0,3,6,9 have keyIndex 0
    });

    test('keyboard j/k navigates and selects rows', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1000);

        // Inject test data
        await page.evaluate(() => {
            var STATE = window.DashboardStore?.STATE;
            if (!STATE) return;
            STATE.requestsHistory = [];
            for (var i = 0; i < 5; i++) {
                STATE.requestsHistory.push({
                    requestId: 'nav-test-' + i,
                    timestamp: Date.now() - i * 1000,
                    keyIndex: 0,
                    path: '/v1/messages',
                    originalModel: 'claude-sonnet-4-20250514',
                    mappedModel: 'claude-sonnet-4-20250514',
                    status: 'completed',
                    error: null,
                    latency: 100
                });
            }
            if (window.DashboardSSE?.scheduleVirtualRender) {
                window.DashboardSSE.scheduleVirtualRender();
            }
        });
        await page.waitForTimeout(500);

        // Navigate down with navigateRequestList
        await page.evaluate(() => {
            if (window.DashboardFilters?.navigateRequestList) {
                window.DashboardFilters.navigateRequestList(1);
            }
        });
        await page.waitForTimeout(100);

        const hasSelection = await page.evaluate(() => {
            return !!document.querySelector('#liveStreamRequestList .request-row.selected');
        });
        expect(hasSelection).toBe(true);

        // Navigate again and check selection moved
        await page.evaluate(() => {
            if (window.DashboardFilters?.navigateRequestList) {
                window.DashboardFilters.navigateRequestList(1);
            }
        });
        await page.waitForTimeout(100);

        const selectedId = await page.evaluate(() => {
            var sel = document.querySelector('#liveStreamRequestList .request-row.selected');
            return sel ? sel.dataset.requestId : null;
        });
        expect(selectedId).not.toBeNull();
    });

    test('selection survives virtual re-render', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1000);

        // Inject test data
        await page.evaluate(() => {
            var STATE = window.DashboardStore?.STATE;
            if (!STATE) return;
            STATE.requestsHistory = [];
            for (var i = 0; i < 5; i++) {
                STATE.requestsHistory.push({
                    requestId: 'persist-test-' + i,
                    timestamp: Date.now() - i * 1000,
                    keyIndex: 0,
                    path: '/v1/messages',
                    originalModel: 'claude-sonnet-4-20250514',
                    mappedModel: 'claude-sonnet-4-20250514',
                    status: 'completed',
                    error: null,
                    latency: 100
                });
            }
            if (window.DashboardSSE?.scheduleVirtualRender) {
                window.DashboardSSE.scheduleVirtualRender();
            }
        });
        await page.waitForTimeout(500);

        // Select a row via STATE
        const selectedRequestId = await page.evaluate(() => {
            var STATE = window.DashboardStore?.STATE;
            if (!STATE) return null;
            STATE.selectedRequestId = 'persist-test-2';
            // Trigger re-render
            if (window.DashboardSSE?.scheduleVirtualRender) {
                window.DashboardSSE.scheduleVirtualRender();
            }
            return STATE.selectedRequestId;
        });
        await page.waitForTimeout(300);

        // Verify the row has the 'selected' class after re-render
        const isSelected = await page.evaluate(() => {
            var row = document.querySelector('#liveStreamRequestList .request-row[data-request-id="persist-test-2"]');
            return row ? row.classList.contains('selected') : false;
        });
        expect(isSelected).toBe(true);

        // Trigger another re-render
        await page.evaluate(() => {
            if (window.DashboardSSE?.scheduleVirtualRender) {
                window.DashboardSSE.scheduleVirtualRender();
            }
        });
        await page.waitForTimeout(300);

        // Selection should still be there
        const stillSelected = await page.evaluate(() => {
            var row = document.querySelector('#liveStreamRequestList .request-row[data-request-id="persist-test-2"]');
            return row ? row.classList.contains('selected') : false;
        });
        expect(stillSelected).toBe(true);
    });

    test('jumpToLatest scrolls viewport to top', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1000);

        // Inject enough data to need scrolling
        await page.evaluate(() => {
            var STATE = window.DashboardStore?.STATE;
            if (!STATE) return;
            STATE.requestsHistory = [];
            for (var i = 0; i < 100; i++) {
                STATE.requestsHistory.push({
                    requestId: 'scroll-test-' + i,
                    timestamp: Date.now() - i * 1000,
                    keyIndex: 0,
                    path: '/v1/messages',
                    originalModel: 'claude-sonnet-4-20250514',
                    mappedModel: 'claude-sonnet-4-20250514',
                    status: 'completed',
                    error: null,
                    latency: 100
                });
            }
            if (window.DashboardSSE?.scheduleVirtualRender) {
                window.DashboardSSE.scheduleVirtualRender();
            }
        });
        await page.waitForTimeout(500);

        // Scroll down
        await page.evaluate(() => {
            var vp = document.querySelector('.virtual-scroll-viewport');
            if (vp) vp.scrollTop = 500;
        });
        await page.waitForTimeout(200);

        // Jump to latest
        await page.evaluate(() => {
            if (window.DashboardFilters?.jumpToLatest) {
                window.DashboardFilters.jumpToLatest();
            }
        });
        await page.waitForTimeout(200);

        const scrollTop = await page.evaluate(() => {
            var vp = document.querySelector('.virtual-scroll-viewport');
            return vp ? vp.scrollTop : -1;
        });
        expect(scrollTop).toBe(0);
    });

    test('filter count badge updates correctly', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1000);

        // Inject test data
        await page.evaluate(() => {
            var STATE = window.DashboardStore?.STATE;
            if (!STATE) return;
            STATE.requestsHistory = [];
            for (var i = 0; i < 10; i++) {
                STATE.requestsHistory.push({
                    requestId: 'badge-test-' + i,
                    timestamp: Date.now() - i * 1000,
                    keyIndex: 0,
                    path: '/v1/messages',
                    originalModel: 'claude-sonnet-4-20250514',
                    mappedModel: 'claude-sonnet-4-20250514',
                    status: i < 6 ? 'completed' : 'pending',
                    error: null,
                    latency: 100
                });
            }
        });

        // Call updateFilterCount and verify
        const badgeResult = await page.evaluate(() => {
            var countEl = document.getElementById('filterCount');
            if (!countEl) return { exists: false };

            // Simulate filter active
            window.DashboardFilters?.updateFilterCount(6, 10);
            var text = countEl.textContent;
            var display = countEl.style.display;

            // Simulate no filter
            window.DashboardFilters?.updateFilterCount(10, 10);
            var textAfterClear = countEl.textContent;
            var displayAfterClear = countEl.style.display;

            return {
                exists: true,
                filteredText: text,
                filteredDisplay: display,
                clearedText: textAfterClear,
                clearedDisplay: displayAfterClear
            };
        });

        if (badgeResult.exists) {
            expect(badgeResult.filteredText).toBe('6/10');
            expect(badgeResult.filteredDisplay).not.toBe('none');
            expect(badgeResult.clearedText).toBe('');
            expect(badgeResult.clearedDisplay).toBe('none');
        }
    });

    test('virtual renderer uses filtered data source', async ({ page, proxyServer }) => {
        await page.goto(proxyServer.url + '/dashboard?debug=1', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1000);

        // Inject data with different statuses and apply filter
        const result = await page.evaluate(() => {
            var STATE = window.DashboardStore?.STATE;
            if (!STATE) return { error: 'no state' };

            STATE.requestsHistory = [];
            for (var i = 0; i < 20; i++) {
                STATE.requestsHistory.push({
                    requestId: 'vr-test-' + i,
                    timestamp: Date.now() - i * 1000,
                    keyIndex: 0,
                    path: '/v1/messages',
                    originalModel: 'claude-sonnet-4-20250514',
                    mappedModel: 'claude-sonnet-4-20250514',
                    status: i < 8 ? 'completed' : 'pending',
                    error: null,
                    latency: 100
                });
            }

            // Apply filter to show only 'success' (completed) requests
            STATE.filters = { status: 'success', key: '', model: '' };
            if (window.DashboardSSE?.scheduleVirtualRender) {
                window.DashboardSSE.scheduleVirtualRender();
            }

            return {
                totalHistory: STATE.requestsHistory.length,
                filteredCount: window.DashboardFilters?.getFilteredRequests()?.length || -1
            };
        });
        await page.waitForTimeout(500);

        expect(result.totalHistory).toBe(20);
        expect(result.filteredCount).toBe(8);

        // Verify that rendered rows reflect filtered count (not raw count)
        const renderedCount = await page.locator('#liveStreamRequestList .request-row').count();
        // All rendered rows should be from the filtered set
        expect(renderedCount).toBeLessThanOrEqual(result.filteredCount);
    });
});
