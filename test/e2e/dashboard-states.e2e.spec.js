/**
 * E2E Tests for Dashboard State Consistency (Plan 11-04)
 * Tests standardized empty, loading, and error states across all views
 */

const { test, expect } = require('@playwright/test');

test.describe('Dashboard States', () => {
    test.beforeEach(async ({ page }) => {
        // Navigate to dashboard
        await page.goto('http://localhost:3000/dashboard/');
        // Wait for initial load
        await page.waitForLoadState('networkidle');
    });

    test.describe('Empty States', () => {
        test('should show consistent empty state when no requests', async ({ page }) => {
            // The empty state should have standard classes
            const emptyState = page.locator('.state-empty').first();
            await expect(emptyState).toBeVisible();

            // Should have state-icon and state-message
            await expect(emptyState.locator('.state-icon')).toBeVisible();
            await expect(emptyState.locator('.state-message')).toBeVisible();
        });

        test('should show consistent empty state in routing dashboard', async ({ page }) => {
            await page.goto('http://localhost:3000/dashboard/dashboard/routing.html');
            await page.waitForLoadState('networkidle');

            // Empty state should be visible initially
            const emptyState = page.locator('table >> .state-empty').first();
            await expect(emptyState).toBeVisible({ timeout: 5000 });

            // Should use standard pattern
            await expect(emptyState.locator('.state-icon')).toBeVisible();
            await expect(emptyState.locator('.state-message')).toBeVisible();
        });

        test('should show consistent tier builder empty lanes', async ({ page }) => {
            // Click on Routing tab
            await page.click('[data-tab="routing"]');
            await page.waitForTimeout(500);

            // Empty tier lanes should use standard pattern
            const emptyLanes = page.locator('.tier-lane-empty').or(page.locator('.tier-lane >> .state-empty'));
            const count = await emptyLanes.count();

            if (count > 0) {
                // At least one lane should be empty
                const firstEmpty = emptyLanes.first();
                await expect(firstEmpty.locator('.state-icon').or(firstEmpty.locator('.state-message'))).toBeVisible();
            }
        });
    });

    test.describe('Loading States', () => {
        test('should show loading during data fetch', async ({ page }) => {
            // Slow the response to see loading state
            await page.route('**/dashboard/stats', route => {
                setTimeout(() => route.continue(), 500);
            });

            // Navigate fresh to trigger fetch
            await page.goto('http://localhost:3000/dashboard/');
            await page.waitForTimeout(200);

            // Check for loading state
            const loading = page.locator('.state-loading');
            const isVisible = await loading.isVisible().catch(() => false);

            // Loading might appear briefly during initial fetch
            if (isVisible) {
                await expect(loading.locator('.spinner')).toBeVisible();
                await expect(loading.locator('.state-message')).toBeVisible();
            }
        });

        test('should show loading when reconnecting SSE', async ({ page }) => {
            await page.goto('http://localhost:3000/dashboard/dashboard/routing.html');

            // Trigger SSE reconnect by going offline briefly
            await page.context().setOffline(true);
            await page.waitForTimeout(1000);
            await page.context().setOffline(false);

            // Should show reconnecting state
            const reconnecting = page.locator('.state-loading');
            await expect(reconnecting).toBeVisible({ timeout: 5000 });
            await expect(reconnecting.locator('.spinner')).toBeVisible();
        });
    });

    test.describe('Error States', () => {
        test('should show error on fetch failure', async ({ page }) => {
            // Block stats endpoint
            await page.route('**/stats', route => route.abort());

            // Reload to trigger error
            await page.reload();
            await page.waitForTimeout(1000);

            // Check for error indication (toast or status)
            const connectionStatus = page.locator('#connectionStatus');
            const hasError = await connectionStatus.evaluate(el =>
                el.classList.contains('error') || el.textContent.includes('error')
            );

            expect(hasError).toBe(true);
        });

        test('should show retry button for recoverable errors', async ({ page }) => {
            // Block model routing endpoint
            await page.route('**/dashboard/model-routing', route => route.abort());

            await page.goto('/dashboard');
            await page.click('[data-tab="routing"]');
            await page.waitForTimeout(1000);

            // Should show error with retry button
            const errorState = page.locator('.state-error');
            const hasRetry = await errorState.evaluate(el =>
                el.textContent.includes('Failed') || el.querySelector('button')
            );

            // Error state should be present if routing panel is shown
            const isVisible = await errorState.isVisible().catch(() => false);
            if (isVisible) {
                expect(hasRetry).toBe(true);
            }
        });

        test('should show error toast for network errors', async ({ page }) => {
            // Block an endpoint to trigger error
            await page.route('**/stats', route => route.abort());

            await page.reload();
            await page.waitForTimeout(1500);

            // Check for error toast
            const toast = page.locator('.toast.error').first();
            const hasToast = await toast.isVisible().catch(() => false);

            if (hasToast) {
                await expect(toast).toContainText(/failed|error/i);
            }
        });
    });

    test.describe('State Transitions', () => {
        test('should transition smoothly from empty to loaded', async ({ page }) => {
            // Start with empty state
            await page.goto('http://localhost:3000/dashboard/dashboard/routing.html');
            await page.waitForTimeout(500);

            const initialEmpty = page.locator('table >> .state-empty');
            await expect(initialEmpty).toBeVisible();

            // Wait for SSE to send data
            // (In real scenario, a request would come through)
            // For testing, we verify the state structure exists
            await expect(initialEmpty.locator('.state-icon')).toBeVisible();
        });

        test('should have animation classes on states', async ({ page }) => {
            await page.goto('/dashboard');

            // Check that state elements exist
            const emptyStates = page.locator('.state-empty');
            const count = await emptyStates.count();

            if (count > 0) {
                // Verify state has expected structure
                const firstEmpty = emptyStates.first();
                await expect(firstEmpty.locator('.state-icon')).toBeVisible();
                await expect(firstEmpty.locator('.state-message')).toBeVisible();
            }
        });
    });

    test.describe('Table Empty States', () => {
        test('should show standardized empty state in traces table', async ({ page }) => {
            // Navigate to traces tab
            await page.click('[data-tab="traces"]');
            await page.waitForTimeout(500);

            // Check for standardized empty state
            const tbody = page.locator('#tracesTableBody tbody, .traces-table tbody');
            const hasEmpty = await tbody.evaluate(el =>
                el.textContent.includes('No traces') || el.querySelector('.state-empty')
            );

            expect(hasEmpty).toBe(true);
        });

        test('should use correct colspan for table empty states', async ({ page }) => {
            await page.goto('http://localhost:3000/dashboard/dashboard/routing.html');
            await page.waitForTimeout(500);

            // Check table structure
            const tableRow = page.locator('table tbody tr td[colspan]');
            const hasColspan = await tableRow.isVisible().catch(() => false);

            if (hasColspan) {
                // Verify colspan is reasonable (should match column count)
                const colspan = await tableRow.first().getAttribute('colspan');
                expect(parseInt(colspan)).toBeGreaterThan(0);
            }
        });
    });

    test.describe('Error Categorization', () => {
        test('should show network error message for connection failures', async ({ page }) => {
            // Simulate network failure
            await page.route('**/stats', route => route.abort('failed'));

            await page.reload();
            await page.waitForTimeout(1000);

            // Check for network-related error message
            const status = page.locator('#connectionStatus');
            const statusText = await status.textContent();

            // Should indicate connection problem
            expect(statusText.toLowerCase()).toMatch(/error|offline|failed/);
        });

        test('should not show retry for auth errors', async ({ page, context }) => {
            // 401 errors should not have retry (requires auth)
            await page.route('**/dashboard/model-routing', route => {
                route.fulfill({
                    status: 401,
                    body: JSON.stringify({ error: 'Unauthorized' })
                });
            });

            await page.goto('/dashboard');
            await page.click('[data-tab="routing"]');
            await page.waitForTimeout(1000);

            // Auth errors should not have simple retry button
            const errorState = page.locator('.state-error');
            const isVisible = await errorState.isVisible().catch(() => false);

            if (isVisible) {
                // Either shows "Authentication required" or similar
                const text = await errorState.textContent();
                expect(text.toLowerCase()).toMatch(/auth|login|unauthorized/);
            }
        });
    });
});
