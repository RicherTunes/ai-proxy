'use strict';

const { test, expect } = require('@playwright/test');

test.describe('Counter Schema Endpoint - ARCH-06', () => {
  const baseUrl = process.env.TEST_BASE_URL || 'http://localhost:3000';

  test('GET /model-routing/counters returns schema', async ({ request }) => {
    const response = await request.get(`${baseUrl}/model-routing/counters`);

    expect(response.ok()).toBeTruthy();

    const body = await response.json();
    expect(body.version).toBe('1.0');
    expect(typeof body.timestamp).toBe('number');
    expect(body.counters).toBeInstanceOf(Object);

    // Verify important counters exist
    expect(body.counters).toHaveProperty('glm_proxy_routing_total');
    expect(body.counters).toHaveProperty('glm_proxy_drift_total');
    expect(body.counters).toHaveProperty('glm_proxy_upgrade_total');
    expect(body.counters).toHaveProperty('glm_proxy_fallback_total');
    expect(body.counters).toHaveProperty('glm_proxy_model_selected_total');
    expect(body.counters).toHaveProperty('glm_proxy_selection_strategy_total');
  });

  test('schema includes all GLM-5 rollout counters', async ({ request }) => {
    const response = await request.get(`${baseUrl}/model-routing/counters`);
    const body = await response.json();

    // GLM-5 rollout counters (Phase 08)
    expect(body.counters).toHaveProperty('glm_proxy_glm5_eligible_total');
    expect(body.counters).toHaveProperty('glm_proxy_glm5_applied_total');
    expect(body.counters).toHaveProperty('glm_proxy_glm5_shadow_total');
  });

  test('schema includes all trace sampling counters', async ({ request }) => {
    const response = await request.get(`${baseUrl}/model-routing/counters`);
    const body = await response.json();

    // Trace sampling counters (Phase 10)
    expect(body.counters).toHaveProperty('glm_proxy_trace_sampled_total');
    expect(body.counters).toHaveProperty('glm_proxy_trace_included_total');
  });

  test('schema includes drift detection counter (ARCH-03)', async ({ request }) => {
    const response = await request.get(`${baseUrl}/model-routing/counters`);
    const body = await response.json();

    // Drift detection counters (Phase 12, ARCH-03)
    expect(body.counters).toHaveProperty('glm_proxy_drift_total');
  });

  test('schema includes config migration counters', async ({ request }) => {
    const response = await request.get(`${baseUrl}/model-routing/counters`);
    const body = await response.json();

    // Config migration counters (Phase 09)
    expect(body.counters).toHaveProperty('glm_proxy_config_migration_total');
    expect(body.counters).toHaveProperty('glm_proxy_config_migration_write_failure_total');
  });

  test('schema includes request counters', async ({ request }) => {
    const response = await request.get(`${baseUrl}/model-routing/counters`);
    const body = await response.json();

    // Request counters
    expect(body.counters).toHaveProperty('glm_proxy_requests_total');
    expect(body.counters).toHaveProperty('glm_proxy_errors_total');
  });

  test('schema includes token/cost counters', async ({ request }) => {
    const response = await request.get(`${baseUrl}/model-routing/counters`);
    const body = await response.json();

    // Token/cost counters
    expect(body.counters).toHaveProperty('glm_proxy_tokens_total');
    expect(body.counters).toHaveProperty('glm_proxy_cost_total');
  });

  test('counters have required properties', async ({ request }) => {
    const response = await request.get(`${baseUrl}/model-routing/counters`);
    const body = await response.json();

    // Verify counters have required properties
    for (const [name, def] of Object.entries(body.counters)) {
      expect(def.description).toBeDefined();
      expect(typeof def.description).toBe('string');
      expect(def.labels).toBeDefined();
      expect(typeof def.labels).toBe('object');
      expect(def.reset).toMatch(/^(process|never|config)$/);
    }
  });

  test('schema has bounded label enums', async ({ request }) => {
    const response = await request.get(`${baseUrl}/model-routing/counters`);
    const body = await response.json();

    // Check that tier labels are bounded
    const routingCounter = body.counters['glm_proxy_routing_total'];
    expect(routingCounter.labels.tier).toBe('light|medium|heavy');

    // Check that upgrade reason labels are bounded
    const upgradeCounter = body.counters['glm_proxy_upgrade_total'];
    expect(upgradeCounter.labels.reason).toBe('has_tools|has_vision|max_tokens|message_count|system_length|other');

    // Check that fallback reason labels are bounded
    const fallbackCounter = body.counters['glm_proxy_fallback_total'];
    expect(fallbackCounter.labels.reason).toBe('cooldown|at_capacity|penalized_429|disabled|not_in_candidates|tier_exhausted|downgrade_budget_exhausted');
  });

  test('drift counter has correct bounded labels', async ({ request }) => {
    const response = await request.get(`${baseUrl}/model-routing/counters`);
    const body = await response.json();

    const driftCounter = body.counters['glm_proxy_drift_total'];
    expect(driftCounter.labels.tier).toBe('light|medium|heavy');
    expect(driftCounter.labels.reason).toContain('router_available_km_excluded');
    expect(driftCounter.labels.reason).toContain('km_available_router_cooled');
    expect(driftCounter.labels.reason).toContain('concurrency_mismatch');
    expect(driftCounter.labels.reason).toContain('cooldown_mismatch');
  });

  test('reset semantics are correct for cumulative counters', async ({ request }) => {
    const response = await request.get(`${baseUrl}/model-routing/counters`);
    const body = await response.json();

    // Cumulative counters should have 'never' reset
    expect(body.counters['glm_proxy_config_migration_total'].reset).toBe('never');
    expect(body.counters['glm_proxy_tokens_total'].reset).toBe('never');
    expect(body.counters['glm_proxy_cost_total'].reset).toBe('never');
  });

  test('timestamp is recent', async ({ request }) => {
    const before = Date.now();
    const response = await request.get(`${baseUrl}/model-routing/counters`);
    const after = Date.now();

    const body = await response.json();
    expect(body.timestamp).toBeGreaterThanOrEqual(before);
    expect(body.timestamp).toBeLessThanOrEqual(after);
  });
});
