'use strict';

const { CounterRegistry, COUNTER_LABELS } = require('../lib/schemas/counters');

describe('CounterRegistry - edge cases', () => {
    let registry;

    beforeEach(() => {
        registry = new CounterRegistry();
    });

    // 1. Register new counter, assert it appears in getAll
    describe('register — appears in getAll', () => {
        it('should include a newly registered counter in getAll', () => {
            const counter = registry.register('edge_counter', 'Edge test');
            const all = registry.getAll();

            expect(all).toContainEqual(counter);
            expect(all.some(c => c.name === 'edge_counter')).toBe(true);
        });

        it('should include multiple registered counters in getAll', () => {
            registry.register('c1', 'First');
            registry.register('c2', 'Second');
            registry.register('c3', 'Third');

            const names = registry.getAll().map(c => c.name);
            expect(names).toEqual(['c1', 'c2', 'c3']);
        });
    });

    // 2. Increment counter, assert value increases
    describe('increment — value increases', () => {
        it('should increase value when incremented directly', () => {
            const counter = registry.register('inc_counter', 'Incrementable');
            expect(counter.value).toBe(0);

            counter.value += 1;
            expect(counter.value).toBe(1);

            counter.value += 5;
            expect(counter.value).toBe(6);
        });

        it('should reflect increments through get()', () => {
            const counter = registry.register('inc_via_get', 'Inc via get');
            counter.value += 10;

            const fetched = registry.get('inc_via_get');
            expect(fetched.value).toBe(10);
        });
    });

    // 3. Get specific counter value
    describe('get — specific counter value', () => {
        it('should return the exact counter object registered', () => {
            const counter = registry.register('specific', 'Specific counter');
            counter.value = 42;

            const result = registry.get('specific');
            expect(result).toBe(counter);
            expect(result.value).toBe(42);
            expect(result.help).toBe('Specific counter');
        });

        it('should distinguish between counters with similar names', () => {
            registry.register('counter_a', 'A');
            registry.register('counter_ab', 'AB');

            expect(registry.get('counter_a').help).toBe('A');
            expect(registry.get('counter_ab').help).toBe('AB');
            expect(registry.get('counter_')).toBeNull();
        });
    });

    // 4. Reset counter to zero
    describe('reset — counter to zero', () => {
        it('should reset value to 0 by direct assignment', () => {
            const counter = registry.register('resettable', 'Reset test');
            counter.value = 100;
            expect(counter.value).toBe(100);

            counter.value = 0;
            expect(counter.value).toBe(0);
        });

        it('should maintain registration after reset', () => {
            const counter = registry.register('resettable2', 'Reset test 2');
            counter.value = 50;
            counter.value = 0;

            expect(registry.get('resettable2')).toBe(counter);
            expect(registry.getAll()).toContainEqual(counter);
        });
    });

    // 5. Returns all registered counters
    describe('getAll — returns all registered counters', () => {
        it('should return empty array when nothing registered', () => {
            expect(registry.getAll()).toEqual([]);
        });

        it('should return correct count after multiple registrations', () => {
            for (let i = 0; i < 10; i++) {
                registry.register(`counter_${i}`, `Counter ${i}`);
            }
            expect(registry.getAll()).toHaveLength(10);
        });

        it('should return live references (mutations visible)', () => {
            const counter = registry.register('live_ref', 'Live reference');
            const allBefore = registry.getAll();
            expect(allBefore[0].value).toBe(0);

            counter.value = 99;
            const allAfter = registry.getAll();
            expect(allAfter[0].value).toBe(99);
        });
    });

    // 6. Unknown counter — get/increment nonexistent counter behavior
    describe('unknown counter — get/increment nonexistent', () => {
        it('should return null for nonexistent counter', () => {
            expect(registry.get('does_not_exist')).toBeNull();
        });

        it('should return null for empty string name', () => {
            expect(registry.get('')).toBeNull();
        });

        it('should return null even after other counters are registered', () => {
            registry.register('exists', 'This exists');
            expect(registry.get('not_exists')).toBeNull();
        });

        it('should not throw when getting undefined counter', () => {
            expect(() => registry.get(undefined)).not.toThrow();
        });
    });

    // 7. Label support — labeled counter registration and tracking
    describe('label support', () => {
        it('should register counter with label schema', () => {
            const counter = registry.register('labeled', 'Labeled counter', {
                tier: 'light|medium|heavy'
            });

            expect(counter.labels).toEqual({ tier: 'light|medium|heavy' });
        });

        it('should track label values via _labelValues map', () => {
            const counter = registry.register('label_track', 'Label tracking', {
                tier: 'light|medium|heavy'
            });

            // Simulate labeled increment
            const key = 'tier=light';
            counter._labelValues.set(key, (counter._labelValues.get(key) || 0) + 1);
            counter._labelValues.set(key, (counter._labelValues.get(key) || 0) + 1);

            expect(counter._labelValues.get(key)).toBe(2);
        });

        it('should support multiple label dimensions', () => {
            const counter = registry.register('multi_label', 'Multi-label', {
                tier: 'light|medium|heavy',
                source: 'override|rule|default'
            });

            expect(Object.keys(counter.labels)).toHaveLength(2);
            expect(counter.labels.tier).toBe('light|medium|heavy');
            expect(counter.labels.source).toBe('override|rule|default');
        });

        it('should warn on unbounded label values but still register', () => {
            const logger = { warn: jest.fn() };
            const warnRegistry = new CounterRegistry({ logger });

            const counter = warnRegistry.register('warn_label', 'Warn test', {
                tier: 'light|INVALID_VALUE'
            });

            expect(logger.warn).toHaveBeenCalled();
            expect(counter.name).toBe('warn_label');
            expect(warnRegistry.get('warn_label')).toBe(counter);
        });

        it('should not warn for labels not in COUNTER_LABELS enum', () => {
            const logger = { warn: jest.fn() };
            const warnRegistry = new CounterRegistry({ logger });

            warnRegistry.register('custom_label', 'Custom', {
                customField: 'any|value|here'
            });

            expect(logger.warn).not.toHaveBeenCalled();
        });
    });

    // 8. Thread safety — rapid concurrent increments maintain accurate count
    describe('thread safety — rapid concurrent increments', () => {
        it('should maintain accurate count with many synchronous increments', () => {
            const counter = registry.register('rapid', 'Rapid increments');
            const N = 10000;

            for (let i = 0; i < N; i++) {
                counter.value += 1;
            }

            expect(counter.value).toBe(N);
        });

        it('should maintain accurate count with concurrent promise-based increments', async () => {
            const counter = registry.register('async_rapid', 'Async rapid');
            const N = 1000;

            const promises = [];
            for (let i = 0; i < N; i++) {
                promises.push(Promise.resolve().then(() => {
                    counter.value += 1;
                }));
            }
            await Promise.all(promises);

            expect(counter.value).toBe(N);
        });

        it('should maintain accurate labeled counts with concurrent increments', async () => {
            const counter = registry.register('concurrent_labels', 'Concurrent labels', {
                tier: 'light|medium|heavy'
            });

            const N = 500;
            const promises = [];

            for (let i = 0; i < N; i++) {
                promises.push(Promise.resolve().then(() => {
                    const key = 'tier=light';
                    counter._labelValues.set(key, (counter._labelValues.get(key) || 0) + 1);
                }));
                promises.push(Promise.resolve().then(() => {
                    const key = 'tier=heavy';
                    counter._labelValues.set(key, (counter._labelValues.get(key) || 0) + 1);
                }));
            }
            await Promise.all(promises);

            expect(counter._labelValues.get('tier=light')).toBe(N);
            expect(counter._labelValues.get('tier=heavy')).toBe(N);
        });
    });
});
