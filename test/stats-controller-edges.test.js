'use strict';

/**
 * Stats Controller Edge-Case Tests
 *
 * Tests cover:
 * 1. escapePromLabel parameterized edge cases (quotes, backslashes, newlines, CR, braces, null bytes, empty, long, unicode)
 * 2. appendMonth1Metrics with null routingStats (no crash, non-routing fields present)
 * 3. appendMonth1Metrics with populated routingStats (routing-specific counters)
 * 4. retryEfficiency metrics appear in prometheus output
 * 5. Per-model metrics appear in prometheus output
 */

const { escapePromLabel, appendMonth1Metrics } = require('../lib/proxy/controllers/stats-controller');

// ---------------------------------------------------------------------------
// 1. escapePromLabel parameterized tests
// ---------------------------------------------------------------------------
describe('escapePromLabel', () => {
    test.each([
        ['double quotes', 'hello"world', 'hello\\"world'],
        ['backslashes', 'hello\\world', 'hello\\\\world'],
        ['newlines', 'hello\nworld', 'hello\\nworld'],
        ['carriage returns', 'hello\rworld', 'hello\\rworld'],
        ['closing braces', 'hello}world', 'helloworld'],
        ['null bytes', 'hello\x00world', 'hello\x00world'],  // null bytes are not stripped by escapePromLabel
        ['empty string', '', ''],
        ['very long string (1000 chars)', 'a'.repeat(1000), 'a'.repeat(1000)],
        ['unicode characters', '\u4f60\u597d\u4e16\u754c', '\u4f60\u597d\u4e16\u754c'],
        ['combined special chars', 'a"b\\c\nd\re}f', 'a\\"b\\\\c\\nd\\ref'],
    ])('should handle %s', (_label, input, expected) => {
        expect(escapePromLabel(input)).toBe(expected);
    });

    test('should return empty string for non-string input (number)', () => {
        expect(escapePromLabel(42)).toBe('');
    });

    test('should return empty string for null', () => {
        expect(escapePromLabel(null)).toBe('');
    });

    test('should return empty string for undefined', () => {
        expect(escapePromLabel(undefined)).toBe('');
    });

    test('should return empty string for object', () => {
        expect(escapePromLabel({})).toBe('');
    });

    test('should handle opening braces (not stripped)', () => {
        // Only closing braces are stripped per implementation
        expect(escapePromLabel('hello{world')).toBe('hello{world');
    });

    test('should handle multiple consecutive special chars', () => {
        expect(escapePromLabel('""\\\\}}')).toBe('\\"\\"\\\\\\\\');
    });
});

// ---------------------------------------------------------------------------
// 2. appendMonth1Metrics with null routingStats
// ---------------------------------------------------------------------------
describe('appendMonth1Metrics with null routingStats', () => {
    let lines;

    beforeEach(() => {
        lines = [];
        const stats = {
            requestPayloadStore: { size: 5, maxEntries: 100, retentionMs: 30000, hits: 10, misses: 2, evictedByTtl: 1, evictedBySize: 0, storedTotal: 12 },
            giveUpTracking: { total: 3, byReason: { max_429_attempts: 2, max_429_window: 1 } },
            retryEfficiency: { sameModelRetries: 7, totalModelsTriedOnFailure: 4, totalModelSwitchesOnFailure: 2, failedRequestsWithModelStats: 3 },
            retryBackoff: { totalDelayMs: 1500, delayCount: 5 },
            admissionHold: { total: 10, succeeded: 8, timedOut: 1, rejected: 1, totalHoldMs: 5000 },
        };
        appendMonth1Metrics(lines, stats, null);
    });

    test('should not crash', () => {
        expect(lines.length).toBeGreaterThan(0);
    });

    test('should include payload store metrics', () => {
        const joined = lines.join('\n');
        expect(joined).toContain('glm_proxy_request_payload_store_size 5');
        expect(joined).toContain('glm_proxy_request_payload_store_max_entries 100');
        expect(joined).toContain('glm_proxy_request_payload_store_hits_total 10');
        expect(joined).toContain('glm_proxy_request_payload_store_misses_total 2');
    });

    test('should include give-up counters', () => {
        const joined = lines.join('\n');
        expect(joined).toContain('glm_proxy_give_up_total 3');
        expect(joined).toContain('glm_proxy_give_up_by_reason_total{reason="max_429_attempts"} 2');
        expect(joined).toContain('glm_proxy_give_up_by_reason_total{reason="max_429_window"} 1');
    });

    test('should include retry efficiency counters', () => {
        const joined = lines.join('\n');
        expect(joined).toContain('glm_proxy_same_model_retries_total 7');
        expect(joined).toContain('glm_proxy_models_tried_on_failure_total 4');
    });

    test('should include admission hold counters', () => {
        const joined = lines.join('\n');
        expect(joined).toContain('glm_proxy_admission_hold_total 10');
        expect(joined).toContain('glm_proxy_admission_hold_succeeded_total 8');
    });

    test('should NOT include tier downgrade counters when routingStats is null', () => {
        const joined = lines.join('\n');
        expect(joined).not.toContain('glm_proxy_tier_downgrade_total');
        expect(joined).not.toContain('glm_proxy_context_overflow_total');
    });
});

// ---------------------------------------------------------------------------
// 3. appendMonth1Metrics with populated routingStats
// ---------------------------------------------------------------------------
describe('appendMonth1Metrics with populated routingStats', () => {
    let lines;

    beforeEach(() => {
        lines = [];
        const stats = {
            requestPayloadStore: {},
            giveUpTracking: {},
            retryEfficiency: {},
            retryBackoff: {},
            admissionHold: {},
            pool429Penalty: {},
        };
        const routingStats = {
            tierDowngradeTotal: 5,
            tierDowngradeShadow: 2,
            tierDowngradeByRoute: { 'heavy->medium': 3, 'medium->light': 2 },
            tierDowngradeShadowByRoute: { 'heavy->light': 1 },
            contextOverflowTotal: 4,
            contextOverflowByTier: { heavy: 3, medium: 1 },
            contextOverflowByModel: { 'gpt-4': 2, 'claude-3': 2 },
        };
        appendMonth1Metrics(lines, stats, routingStats);
    });

    test('should include tier downgrade total', () => {
        const joined = lines.join('\n');
        expect(joined).toContain('glm_proxy_tier_downgrade_total 5');
    });

    test('should include tier downgrade shadow', () => {
        const joined = lines.join('\n');
        expect(joined).toContain('glm_proxy_tier_downgrade_shadow_total 2');
    });

    test('should include tier downgrade by route', () => {
        const joined = lines.join('\n');
        expect(joined).toContain('glm_proxy_tier_downgrade_by_route_total{from="heavy",to="medium"} 3');
        expect(joined).toContain('glm_proxy_tier_downgrade_by_route_total{from="medium",to="light"} 2');
    });

    test('should include tier downgrade shadow by route', () => {
        const joined = lines.join('\n');
        expect(joined).toContain('glm_proxy_tier_downgrade_shadow_by_route_total{from="heavy",to="light"} 1');
    });

    test('should include context overflow total', () => {
        const joined = lines.join('\n');
        expect(joined).toContain('glm_proxy_context_overflow_total 4');
    });

    test('should include context overflow by tier', () => {
        const joined = lines.join('\n');
        expect(joined).toContain('glm_proxy_context_overflow_by_tier_total{tier="heavy"} 3');
        expect(joined).toContain('glm_proxy_context_overflow_by_tier_total{tier="medium"} 1');
    });

    test('should include context overflow by model', () => {
        const joined = lines.join('\n');
        expect(joined).toContain('glm_proxy_context_overflow_by_model_total{model="gpt-4"} 2');
        expect(joined).toContain('glm_proxy_context_overflow_by_model_total{model="claude-3"} 2');
    });
});

// ---------------------------------------------------------------------------
// 4. retryEfficiency metrics in prometheus output
// ---------------------------------------------------------------------------
describe('retryEfficiency metrics', () => {
    test('should emit all retry efficiency counters', () => {
        const lines = [];
        const stats = {
            retryEfficiency: {
                sameModelRetries: 12,
                totalModelsTriedOnFailure: 8,
                totalModelSwitchesOnFailure: 5,
                failedRequestsWithModelStats: 6,
            },
        };
        appendMonth1Metrics(lines, stats, null);
        const joined = lines.join('\n');

        expect(joined).toContain('glm_proxy_same_model_retries_total 12');
        expect(joined).toContain('glm_proxy_models_tried_on_failure_total 8');
        expect(joined).toContain('glm_proxy_model_switches_on_failure_total 5');
        expect(joined).toContain('glm_proxy_failed_requests_with_model_stats_total 6');
    });

    test('should default to 0 when retryEfficiency is missing', () => {
        const lines = [];
        appendMonth1Metrics(lines, {}, null);
        const joined = lines.join('\n');

        expect(joined).toContain('glm_proxy_same_model_retries_total 0');
        expect(joined).toContain('glm_proxy_models_tried_on_failure_total 0');
        expect(joined).toContain('glm_proxy_model_switches_on_failure_total 0');
        expect(joined).toContain('glm_proxy_failed_requests_with_model_stats_total 0');
    });
});

// ---------------------------------------------------------------------------
// 5. Per-model metrics (pool 429 penalty)
// ---------------------------------------------------------------------------
describe('Per-model metrics (pool429Penalty)', () => {
    test('should emit per-model 429 penalty hits', () => {
        const lines = [];
        const stats = {
            pool429Penalty: {
                trackedModels: 2,
                byModel: {
                    'gpt-4': { hits: 10 },
                    'claude-3-opus': { hits: 5 },
                },
            },
        };
        appendMonth1Metrics(lines, stats, null);
        const joined = lines.join('\n');

        expect(joined).toContain('glm_proxy_pool_429_penalty_hits{model="gpt-4"} 10');
        expect(joined).toContain('glm_proxy_pool_429_penalty_hits{model="claude-3-opus"} 5');
        expect(joined).toContain('glm_proxy_pool_429_penalty_tracked_models 2');
    });

    test('should handle numeric entry values (non-object)', () => {
        const lines = [];
        const stats = {
            pool429Penalty: {
                trackedModels: 1,
                byModel: {
                    'gpt-4': 7,  // plain number, not object
                },
            },
        };
        appendMonth1Metrics(lines, stats, null);
        const joined = lines.join('\n');

        expect(joined).toContain('glm_proxy_pool_429_penalty_hits{model="gpt-4"} 7');
    });

    test('should compute max hits across models', () => {
        const lines = [];
        const stats = {
            pool429Penalty: {
                trackedModels: 3,
                byModel: {
                    'model-a': { hits: 2 },
                    'model-b': { hits: 15 },
                    'model-c': { hits: 8 },
                },
            },
        };
        appendMonth1Metrics(lines, stats, null);
        const joined = lines.join('\n');

        expect(joined).toContain('glm_proxy_pool_429_penalty_max_hits 15');
    });

    test('should emit 0 for max hits when no models tracked', () => {
        const lines = [];
        appendMonth1Metrics(lines, {}, null);
        const joined = lines.join('\n');

        expect(joined).toContain('glm_proxy_pool_429_penalty_max_hits 0');
        expect(joined).toContain('glm_proxy_pool_429_penalty_tracked_models 0');
    });

    test('should escape special chars in model names', () => {
        const lines = [];
        const stats = {
            pool429Penalty: {
                trackedModels: 1,
                byModel: {
                    'model"with\\special': { hits: 3 },
                },
            },
        };
        appendMonth1Metrics(lines, stats, null);
        const joined = lines.join('\n');

        expect(joined).toContain('model\\"with\\\\special');
    });
});
