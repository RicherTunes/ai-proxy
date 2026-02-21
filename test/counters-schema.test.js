'use strict';

const { CounterRegistry, COUNTER_SCHEMA, COUNTER_LABELS } = require('../lib/schemas/counters');

describe('CounterRegistry - ARCH-06', () => {
    let registry;

    beforeEach(() => {
        registry = new CounterRegistry();
    });

    describe('register()', () => {
        it('should register a counter', () => {
            const counter = registry.register('test_counter', 'Test counter', { tier: 'light|medium|heavy' });

            expect(counter).toBeDefined();
            expect(counter.name).toBe('test_counter');
            expect(counter.labels).toHaveProperty('tier');
        });

        it('should register counter with default reset type', () => {
            const counter = registry.register('test_counter', 'Test counter', {});

            expect(counter.resetType).toBe('process');
        });

        it('should register counter with custom reset type', () => {
            const counter = registry.register('test_counter', 'Test counter', {}, 'never');

            expect(counter.resetType).toBe('never');
        });

        it('should warn on unbounded label values', () => {
            const logger = { warn: jest.fn() };
            const warnRegistry = new CounterRegistry({ logger });

            warnRegistry.register('test_counter', 'Test', {
                tier: 'light|medium|heavy|UNBOUNDED'
            });

            expect(logger.warn).toHaveBeenCalled();
            const callArgs = logger.warn.mock.calls[0][0];
            expect(callArgs).toContain('tier');
            expect(callArgs).toContain('unbounded');
            expect(callArgs).toContain('UNBOUNDED');
        });

        it('should not warn for bounded label values', () => {
            const logger = { warn: jest.fn() };
            const warnRegistry = new CounterRegistry({ logger });

            warnRegistry.register('test_counter', 'Test', {
                tier: 'light|medium|heavy'
            });

            expect(logger.warn).not.toHaveBeenCalled();
        });

        it('should accept all valid bounded tier values', () => {
            const logger = { warn: jest.fn() };
            const warnRegistry = new CounterRegistry({ logger });

            warnRegistry.register('test_counter', 'Test', {
                tier: 'light|medium|heavy'
            });

            expect(logger.warn).not.toHaveBeenCalled();
        });

        it('should accept all valid bounded source values', () => {
            const logger = { warn: jest.fn() };
            const warnRegistry = new CounterRegistry({ logger });

            warnRegistry.register('test_counter', 'Test', {
                source: 'override|saved-override|rule|classifier|default|failover|pool'
            });

            expect(logger.warn).not.toHaveBeenCalled();
        });
    });

    describe('get()', () => {
        it('should return registered counter', () => {
            const counter = registry.register('test_counter', 'Test counter', {});

            expect(registry.get('test_counter')).toBe(counter);
        });

        it('should return null for unknown counter', () => {
            expect(registry.get('unknown_counter')).toBeNull();
        });
    });

    describe('getAll()', () => {
        it('should return empty array when no counters registered', () => {
            expect(registry.getAll()).toEqual([]);
        });

        it('should return all registered counters', () => {
            const counter1 = registry.register('counter1', 'First', {});
            const counter2 = registry.register('counter2', 'Second', {});

            const all = registry.getAll();
            expect(all).toHaveLength(2);
            expect(all).toContainEqual(counter1);
            expect(all).toContainEqual(counter2);
        });
    });

    describe('validate()', () => {
        it('should detect missing counters', () => {
            const result = registry.validate();
            expect(result.missing.length).toBeGreaterThan(0);
            expect(result.valid).toBe(false);
        });

        it('should list all counters as missing initially', () => {
            const result = registry.validate();
            const expectedMissing = Object.keys(COUNTER_SCHEMA);
            expect(result.missing).toEqual(expect.arrayContaining(expectedMissing));
        });

        it('should detect unknown counters', () => {
            registry.register('unknown_metric', 'Not in schema');
            const result = registry.validate();
            expect(result.unknown).toContain('unknown_metric');
        });

        it('should detect unknown counters alongside missing ones', () => {
            registry.register('unknown_metric', 'Not in schema');
            const result = registry.validate();

            expect(result.unknown).toContain('unknown_metric');
            expect(result.missing.length).toBeGreaterThan(0);
            expect(result.valid).toBe(false);
        });

        it('should pass when all schema counters registered', () => {
            // Register all schema counters
            for (const [name, def] of Object.entries(COUNTER_SCHEMA)) {
                registry.register(name, def.description, def.labels);
            }
            const result = registry.validate();
            expect(result.valid).toBe(true);
            expect(result.missing).toEqual([]);
            expect(result.unknown).toEqual([]);
        });
    });

    describe('COUNTER_SCHEMA', () => {
        it('should have all required routing counters', () => {
            expect(COUNTER_SCHEMA).toHaveProperty('glm_proxy_routing_total');
            expect(COUNTER_SCHEMA).toHaveProperty('glm_proxy_upgrade_total');
            expect(COUNTER_SCHEMA).toHaveProperty('glm_proxy_fallback_total');
            expect(COUNTER_SCHEMA).toHaveProperty('glm_proxy_model_selected_total');
            expect(COUNTER_SCHEMA).toHaveProperty('glm_proxy_selection_strategy_total');
        });

        it('should have drift detection counter (ARCH-03)', () => {
            expect(COUNTER_SCHEMA).toHaveProperty('glm_proxy_drift_total');
        });

        it('should have GLM-5 rollout counters (Phase 08)', () => {
            expect(COUNTER_SCHEMA).toHaveProperty('glm_proxy_glm5_eligible_total');
            expect(COUNTER_SCHEMA).toHaveProperty('glm_proxy_glm5_applied_total');
            expect(COUNTER_SCHEMA).toHaveProperty('glm_proxy_glm5_shadow_total');
        });

        it('should have trace sampling counters (Phase 10)', () => {
            expect(COUNTER_SCHEMA).toHaveProperty('glm_proxy_trace_sampled_total');
            expect(COUNTER_SCHEMA).toHaveProperty('glm_proxy_trace_included_total');
        });

        it('should have config migration counters (Phase 09)', () => {
            expect(COUNTER_SCHEMA).toHaveProperty('glm_proxy_config_migration_total');
            expect(COUNTER_SCHEMA).toHaveProperty('glm_proxy_config_migration_write_failure_total');
        });

        it('should have request counters', () => {
            expect(COUNTER_SCHEMA).toHaveProperty('glm_proxy_requests_total');
            expect(COUNTER_SCHEMA).toHaveProperty('glm_proxy_errors_total');
        });

        it('should have token/cost counters', () => {
            expect(COUNTER_SCHEMA).toHaveProperty('glm_proxy_tokens_total');
            expect(COUNTER_SCHEMA).toHaveProperty('glm_proxy_cost_total');
        });

        it('should be frozen', () => {
            expect(() => {
                COUNTER_SCHEMA.new_counter = {};
            }).toThrow();
        });

        it('should have required properties for each counter', () => {
            for (const [name, def] of Object.entries(COUNTER_SCHEMA)) {
                expect(def.description).toBeDefined();
                expect(def.labels).toBeDefined();
                expect(def.reset).toMatch(/^(process|never|config)$/);
            }
        });

        it('should have correct reset semantics for cumulative counters', () => {
            expect(COUNTER_SCHEMA['glm_proxy_config_migration_total'].reset).toBe('never');
            expect(COUNTER_SCHEMA['glm_proxy_tokens_total'].reset).toBe('never');
            expect(COUNTER_SCHEMA['glm_proxy_cost_total'].reset).toBe('never');
        });
    });

    describe('COUNTER_LABELS', () => {
        it('should be frozen', () => {
            expect(() => {
                COUNTER_LABELS.newLabel = new Set();
            }).toThrow();
        });

        it('should have bounded tier enum', () => {
            expect(COUNTER_LABELS.tier).toBeInstanceOf(Set);
            expect(COUNTER_LABELS.tier.has('light')).toBe(true);
            expect(COUNTER_LABELS.tier.has('medium')).toBe(true);
            expect(COUNTER_LABELS.tier.has('heavy')).toBe(true);
            expect(COUNTER_LABELS.tier.has('invalid')).toBe(false);
        });

        it('should have bounded source enum', () => {
            expect(COUNTER_LABELS.source).toBeInstanceOf(Set);
            expect(COUNTER_LABELS.source.has('override')).toBe(true);
            expect(COUNTER_LABELS.source.has('saved-override')).toBe(true);
            expect(COUNTER_LABELS.source.has('rule')).toBe(true);
            expect(COUNTER_LABELS.source.has('classifier')).toBe(true);
            expect(COUNTER_LABELS.source.has('default')).toBe(true);
            expect(COUNTER_LABELS.source.has('failover')).toBe(true);
            expect(COUNTER_LABELS.source.has('pool')).toBe(true);
            expect(COUNTER_LABELS.source.has('invalid')).toBe(false);
        });

        it('should have bounded strategy enum', () => {
            expect(COUNTER_LABELS.strategy).toBeInstanceOf(Set);
            expect(COUNTER_LABELS.strategy.has('quality')).toBe(true);
            expect(COUNTER_LABELS.strategy.has('throughput')).toBe(true);
            expect(COUNTER_LABELS.strategy.has('balanced')).toBe(true);
            expect(COUNTER_LABELS.strategy.has('pool')).toBe(true);
        });

        it('should have bounded upgradeReason enum', () => {
            expect(COUNTER_LABELS.upgradeReason).toBeInstanceOf(Set);
            expect(COUNTER_LABELS.upgradeReason.has('has_tools')).toBe(true);
            expect(COUNTER_LABELS.upgradeReason.has('has_vision')).toBe(true);
            expect(COUNTER_LABELS.upgradeReason.has('max_tokens')).toBe(true);
            expect(COUNTER_LABELS.upgradeReason.has('message_count')).toBe(true);
            expect(COUNTER_LABELS.upgradeReason.has('system_length')).toBe(true);
            expect(COUNTER_LABELS.upgradeReason.has('other')).toBe(true);
        });

        it('should have bounded fallbackReason enum', () => {
            expect(COUNTER_LABELS.fallbackReason).toBeInstanceOf(Set);
            expect(COUNTER_LABELS.fallbackReason.has('cooldown')).toBe(true);
            expect(COUNTER_LABELS.fallbackReason.has('at_capacity')).toBe(true);
            expect(COUNTER_LABELS.fallbackReason.has('penalized_429')).toBe(true);
            expect(COUNTER_LABELS.fallbackReason.has('disabled')).toBe(true);
            expect(COUNTER_LABELS.fallbackReason.has('not_in_candidates')).toBe(true);
            expect(COUNTER_LABELS.fallbackReason.has('tier_exhausted')).toBe(true);
            expect(COUNTER_LABELS.fallbackReason.has('downgrade_budget_exhausted')).toBe(true);
        });

        it('should have bounded driftReason enum', () => {
            expect(COUNTER_LABELS.driftReason).toBeInstanceOf(Set);
            expect(COUNTER_LABELS.driftReason.has('router_available_km_excluded')).toBe(true);
            expect(COUNTER_LABELS.driftReason.has('km_available_router_cooled')).toBe(true);
            expect(COUNTER_LABELS.driftReason.has('concurrency_mismatch')).toBe(true);
            expect(COUNTER_LABELS.driftReason.has('cooldown_mismatch')).toBe(true);
        });

        it('should have bounded keyState enum', () => {
            expect(COUNTER_LABELS.keyState).toBeInstanceOf(Set);
            expect(COUNTER_LABELS.keyState.has('available')).toBe(true);
            expect(COUNTER_LABELS.keyState.has('excluded')).toBe(true);
            expect(COUNTER_LABELS.keyState.has('rate_limited')).toBe(true);
            expect(COUNTER_LABELS.keyState.has('circuit_open')).toBe(true);
            expect(COUNTER_LABELS.keyState.has('cooldown')).toBe(true);
            expect(COUNTER_LABELS.keyState.has('unknown')).toBe(true);
        });

        it('should have bounded errorType enum', () => {
            expect(COUNTER_LABELS.errorType).toBeInstanceOf(Set);
            expect(COUNTER_LABELS.errorType.has('upstream')).toBe(true);
            expect(COUNTER_LABELS.errorType.has('timeout')).toBe(true);
            expect(COUNTER_LABELS.errorType.has('rate_limit')).toBe(true);
            expect(COUNTER_LABELS.errorType.has('internal')).toBe(true);
        });

        it('should have bounded migrationResult enum', () => {
            expect(COUNTER_LABELS.migrationResult).toBeInstanceOf(Set);
            expect(COUNTER_LABELS.migrationResult.has('success')).toBe(true);
            expect(COUNTER_LABELS.migrationResult.has('failure')).toBe(true);
        });
    });

    describe('getSchema()', () => {
        it('should return schema with version and timestamp', () => {
            const before = Date.now();
            const schema = registry.getSchema();
            const after = Date.now();

            expect(schema.version).toBe('1.0');
            expect(schema.timestamp).toBeGreaterThanOrEqual(before);
            expect(schema.timestamp).toBeLessThanOrEqual(after);
        });

        it('should return schema with counters', () => {
            const schema = registry.getSchema();

            expect(schema.counters).toEqual(COUNTER_SCHEMA);
        });

        it('should have correct structure', () => {
            const schema = registry.getSchema();

            expect(schema).toHaveProperty('version');
            expect(schema).toHaveProperty('timestamp');
            expect(schema).toHaveProperty('counters');
            expect(typeof schema.counters).toBe('object');
        });
    });

    describe('counter value tracking', () => {
        it('should initialize counter value to 0', () => {
            const counter = registry.register('test_counter', 'Test', {});

            expect(counter.value).toBe(0);
        });

        it('should have _labelValues map for label tracking', () => {
            const counter = registry.register('test_counter', 'Test', { tier: 'light|medium|heavy' });

            expect(counter._labelValues).toBeInstanceOf(Map);
            expect(counter._labelValues.size).toBe(0);
        });
    });
});
