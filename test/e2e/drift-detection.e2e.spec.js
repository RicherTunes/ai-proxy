'use strict';

const { test, expect } = require('@playwright/test');

test.describe('Drift Detection E2E - DRIFT-01', () => {
    const baseUrl = process.env.TEST_BASE_URL || 'http://localhost:3000';

    test('drift counter documented in counter schema (ARCH-03)', async ({ request }) => {
        const response = await request.get(`${baseUrl}/model-routing/counters`);
        expect(response.ok()).toBeTruthy();

        const body = await response.json();
        expect(body.counters).toHaveProperty('glm_proxy_drift_total');

        const driftCounter = body.counters['glm_proxy_drift_total'];
        expect(driftCounter.labels).toBeDefined();
        expect(typeof driftCounter.labels).toBe('object');
        expect(driftCounter.labels).toHaveProperty('tier');
        expect(driftCounter.labels).toHaveProperty('reason');
    });

    test('drift counter has bounded labels matching DRIFT_REASON_ENUM', async ({ request }) => {
        const response = await request.get(`${baseUrl}/model-routing/counters`);
        expect(response.ok()).toBeTruthy();

        const body = await response.json();
        const driftCounter = body.counters['glm_proxy_drift_total'];

        // Verify bounded cardinality - exactly 2 labels
        const labelKeys = Object.keys(driftCounter.labels);
        expect(labelKeys).toContain('tier');
        expect(labelKeys).toContain('reason');
        expect(labelKeys.length).toBe(2); // Only tier and reason

        // Verify description mentions drift/cross-validation
        expect(driftCounter.description.toLowerCase()).toMatch(/drift|cross.?validation/);
    });

    test('model routing stats available in /stats', async ({ request }) => {
        const response = await request.get(`${baseUrl}/stats`);
        expect(response.ok()).toBeTruthy();

        const body = await response.json();
        // Stats endpoint should be operational
        expect(body).toBeDefined();
        expect(typeof body).toBe('object');
        // Verify we have basic stats structure
        expect(body).toHaveProperty('uptime');
        expect(body).toHaveProperty('totalRequests');
    });

    test('model routing metrics available in /metrics', async ({ request }) => {
        const response = await request.get(`${baseUrl}/metrics`);
        expect(response.ok()).toBeTruthy();

        const text = await response.text();
        // Verify model routing metrics are exported
        expect(text).toContain('glm_proxy_model_routing_enabled');
    });

    test('drift counter schema includes tier and reason labels', async ({ request }) => {
        const response = await request.get(`${baseUrl}/model-routing/counters`);
        expect(response.ok()).toBeTruthy();

        const body = await response.json();
        const driftCounter = body.counters['glm_proxy_drift_total'];

        // Counter must have tier (3 values) and reason (4 values) = 12 max time series
        const labelKeys = Object.keys(driftCounter.labels);
        expect(labelKeys).toContain('tier');
        expect(labelKeys).toContain('reason');

        // Verify exactly 2 labels - no unbounded labels allowed
        expect(labelKeys.length).toBe(2);

        // Verify tier enum is bounded to 3 values
        expect(driftCounter.labels.tier).toBe('light|medium|heavy');

        // Verify reason enum is bounded to 4 values from DRIFT_REASON_ENUM
        expect(driftCounter.labels.reason).toBe('router_available_km_excluded|km_available_router_cooled|concurrency_mismatch|cooldown_mismatch');
    });
});
