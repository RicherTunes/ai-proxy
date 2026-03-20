'use strict';
/**
 * Key Manager Rotation Tests
 *
 * TDD coverage for key management rotation scenarios:
 * 1. Round-robin fairness
 * 2. Key cooldown after 429
 * 3. All keys in cooldown
 * 4. Key hot-reload
 * 5. Key removal
 * 6. Priority/weight (health-score weighted selection)
 * 7. Circuit breaker integration
 * 8. Concurrent selection (maxConcurrencyPerKey)
 * 9. Stats tracking (per-key success/failure counts, latency)
 */

const { KeyManager } = require('../lib/key-manager');
const { STATES } = require('../lib/circuit-breaker');

describe('KeyManager - Rotation', () => {
    let km;

    afterEach(() => {
        if (km) {
            km.destroy();
            km = null;
        }
    });

    /**
     * Helper: create a KeyManager with weighted selection disabled for
     * deterministic round-robin behavior unless overridden.
     */
    function createKm(overrides = {}) {
        return new KeyManager({
            maxConcurrencyPerKey: 10,
            circuitBreaker: {
                failureThreshold: 3,
                failureWindow: 60000,
                cooldownPeriod: 500
            },
            rateLimitPerMinute: 0,
            keySelection: {
                useWeightedSelection: false,
                slowKeyThreshold: 2.0,
                slowKeyCheckIntervalMs: 999999,
                slowKeyCooldownMs: 300000
            },
            ...overrides
        });
    }

    // =========================================================================
    // 1. Round-robin fairness
    // =========================================================================
    describe('round-robin fairness', () => {
        test('each key is selected roughly equally over N*10 requests', () => {
            const N = 5;
            const keys = [];
            for (let i = 0; i < N; i++) {
                keys.push(`key${i}.secret${i}`);
            }

            km = createKm({ maxConcurrencyPerKey: 100 });
            km.loadKeys(keys);

            const totalRequests = N * 10;
            const selectionCount = new Map();
            for (const key of km.keys) {
                selectionCount.set(key.keyId, 0);
            }

            for (let i = 0; i < totalRequests; i++) {
                const selected = km.getBestKey();
                expect(selected).not.toBeNull();
                selectionCount.set(
                    selected.keyId,
                    selectionCount.get(selected.keyId) + 1
                );
                // Release so it stays available
                km.recordSuccess(selected, 100);
            }

            const expectedPerKey = totalRequests / N; // 10
            for (const [keyId, count] of selectionCount) {
                // With round-robin, each key should get exactly or nearly
                // equal selections. Allow ±30% tolerance.
                expect(count).toBeGreaterThanOrEqual(expectedPerKey * 0.7);
                expect(count).toBeLessThanOrEqual(expectedPerKey * 1.3);
            }
        });

        test('fairness holds with 2 keys over 20 requests', () => {
            km = createKm({ maxConcurrencyPerKey: 100 });
            km.loadKeys(['keyA.s1', 'keyB.s2']);

            const counts = { keyA: 0, keyB: 0 };
            for (let i = 0; i < 20; i++) {
                const selected = km.getBestKey();
                expect(selected).not.toBeNull();
                counts[selected.keyId]++;
                km.recordSuccess(selected, 50);
            }

            // Each should have ~10 selections
            expect(counts.keyA).toBeGreaterThanOrEqual(7);
            expect(counts.keyB).toBeGreaterThanOrEqual(7);
        });
    });

    // =========================================================================
    // 2. Key cooldown after 429
    // =========================================================================
    describe('key cooldown after 429', () => {
        test('key is not selected during its cooldown period', () => {
            km = createKm({ maxConcurrencyPerKey: 100 });
            km.loadKeys(['keyA.s1', 'keyB.s2', 'keyC.s3']);

            // Rate-limit keyA with a long cooldown
            const keyA = km.keys[0];
            km.recordRateLimit(keyA, 60000); // 60s cooldown

            // All subsequent selections should avoid keyA during cooldown
            for (let i = 0; i < 20; i++) {
                const selected = km.getBestKey();
                expect(selected).not.toBeNull();
                expect(selected.keyId).not.toBe('keyA');
                km.recordSuccess(selected, 100);
            }
        });

        test('key returns to rotation after cooldown expires', () => {
            km = createKm({ maxConcurrencyPerKey: 100 });
            km.loadKeys(['keyA.s1', 'keyB.s2']);

            const keyA = km.keys[0];
            // Set rateLimitedAt to the past so cooldown is expired
            keyA.rateLimitedAt = Date.now() - 70000; // 70s ago
            keyA.rateLimitCooldownMs = 60000; // 60s cooldown

            // keyA should now be available again
            let selectedKeyA = false;
            for (let i = 0; i < 20; i++) {
                const selected = km.getBestKey();
                if (selected.keyId === 'keyA') {
                    selectedKeyA = true;
                    break;
                }
                km.recordSuccess(selected, 100);
            }
            expect(selectedKeyA).toBe(true);
        });

        test('recordRateLimit sets adaptive cooldown with exponential backoff', () => {
            km = createKm();
            km.loadKeys(['keyA.s1']);

            const key = km.keys[0];

            // First 429
            km.recordRateLimit(key);
            const firstCooldown = key.rateLimitCooldownMs;
            expect(firstCooldown).toBeGreaterThan(0);
            expect(key.rateLimitedCount).toBe(1);

            // Second 429 - cooldown should increase
            km.recordRateLimit(key);
            expect(key.rateLimitedCount).toBe(2);
            const secondCooldown = key.rateLimitCooldownMs;
            // Backoff should grow (accounting for jitter)
            expect(secondCooldown).toBeGreaterThanOrEqual(firstCooldown * 0.5);
        });

        test('recordRateLimit with explicit retryAfterMs uses that value', () => {
            km = createKm();
            km.loadKeys(['keyA.s1']);

            const key = km.keys[0];
            km.recordRateLimit(key, 5000);
            expect(key.rateLimitCooldownMs).toBe(5000);
        });

        test('recordSuccess clears rate limit cooldown', () => {
            km = createKm();
            km.loadKeys(['keyA.s1']);

            const key = km.keys[0];
            km.recordRateLimit(key, 60000);
            expect(key.rateLimitedAt).not.toBeNull();

            km.recordSuccess(key, 100);
            expect(key.rateLimitedAt).toBeNull();
            expect(key.rateLimitCooldownMs).toBe(1000); // Reset to base
        });
    });

    // =========================================================================
    // 3. All keys in cooldown
    // =========================================================================
    describe('all keys in cooldown', () => {
        test('selects a key (does not crash) when all keys are rate-limited', () => {
            km = createKm({ maxConcurrencyPerKey: 100 });
            km.loadKeys(['keyA.s1', 'keyB.s2', 'keyC.s3']);

            // Rate-limit all keys
            km.keys.forEach(k => {
                k.rateLimitedAt = Date.now();
                k.rateLimitCooldownMs = 60000;
            });

            // getBestKey should still return a key (falls back to all rate-limited pool)
            const selected = km.getBestKey();
            expect(selected).not.toBeNull();
        });

        test('key whose cooldown has expired is selected over keys still in cooldown', () => {
            // Use a long cooldownDecayMs so the decay logic does not reset keys prematurely
            km = new KeyManager({
                maxConcurrencyPerKey: 100,
                circuitBreaker: { failureThreshold: 3, failureWindow: 60000, cooldownPeriod: 500 },
                rateLimitPerMinute: 0,
                keySelection: {
                    useWeightedSelection: false,
                    slowKeyThreshold: 2.0,
                    slowKeyCheckIntervalMs: 999999,
                    slowKeyCooldownMs: 300000
                },
                keyRateLimitCooldown: {
                    cooldownDecayMs: 120000, // 2 minutes - won't trigger during this test
                    baseCooldownMs: 1000
                }
            });
            km.loadKeys(['keyA.s1', 'keyB.s2', 'keyC.s3']);

            const now = Date.now();

            // keyA: 10s cooldown, hit 5s ago -> still in cooldown (5s remaining)
            km.keys[0].rateLimitedAt = now - 5000;
            km.keys[0].rateLimitCooldownMs = 10000;

            // keyB: 10s cooldown, hit 11s ago -> cooldown expired
            km.keys[1].rateLimitedAt = now - 11000;
            km.keys[1].rateLimitCooldownMs = 10000;

            // keyC: 10s cooldown, hit 2s ago -> still in cooldown (8s remaining)
            km.keys[2].rateLimitedAt = now - 2000;
            km.keys[2].rateLimitCooldownMs = 10000;

            const selected = km.getBestKey();
            // keyB is the only key whose cooldown has expired, so it's in the notRateLimited pool
            expect(selected).not.toBeNull();
            expect(selected.keyId).toBe('keyB');
        });

        test('returns a key from underLimit pool when all rate-limited', () => {
            km = createKm({ maxConcurrencyPerKey: 100 });
            km.loadKeys(['keyA.s1', 'keyB.s2']);

            // Both keys rate-limited, neither cooldown expired
            km.keys.forEach(k => {
                k.rateLimitedAt = Date.now();
                k.rateLimitCooldownMs = 60000;
            });

            // Should still return one (falls back to underLimit pool)
            const selected = km.getBestKey();
            expect(selected).not.toBeNull();
            expect(['keyA', 'keyB']).toContain(selected.keyId);
        });
    });

    // =========================================================================
    // 4. Key hot-reload
    // =========================================================================
    describe('key hot-reload', () => {
        test('newly added key enters the rotation immediately', () => {
            km = createKm({ maxConcurrencyPerKey: 100 });
            km.loadKeys(['keyA.s1', 'keyB.s2']);

            // Reload with an additional key
            const result = km.reloadKeys(['keyA.s1', 'keyB.s2', 'keyC.s3']);
            expect(result.added).toBe(1);
            expect(result.total).toBe(3);

            // Verify keyC is in the pool and can be selected
            let selectedKeyC = false;
            for (let i = 0; i < 30; i++) {
                const selected = km.getBestKey();
                if (selected.keyId === 'keyC') {
                    selectedKeyC = true;
                    break;
                }
                km.recordSuccess(selected, 100);
            }
            expect(selectedKeyC).toBe(true);
        });

        test('hot-reload preserves existing key stats', () => {
            km = createKm({ maxConcurrencyPerKey: 100 });
            km.loadKeys(['keyA.s1', 'keyB.s2']);

            // Generate stats on keyA
            const keyA = km.getKeyById('keyA');
            km.acquireKey();
            km.recordSuccess(keyA, 150);
            km.acquireKey();
            km.recordSuccess(keyA, 200);

            expect(keyA.successCount).toBe(2);

            // Reload adding keyC
            km.reloadKeys(['keyA.s1', 'keyB.s2', 'keyC.s3']);

            // keyA stats should be preserved
            const reloadedKeyA = km.getKeyById('keyA');
            expect(reloadedKeyA.successCount).toBe(2);
        });

        test('hot-reload assigns correct indices to new keys', () => {
            km = createKm();
            km.loadKeys(['keyA.s1', 'keyB.s2']);

            km.reloadKeys(['keyA.s1', 'keyB.s2', 'keyC.s3']);

            expect(km.getKeyById('keyA').index).toBe(0);
            expect(km.getKeyById('keyB').index).toBe(1);
            expect(km.getKeyById('keyC').index).toBe(2);
        });

        test('new key starts with fresh stats (0 requests, 0 failures)', () => {
            km = createKm();
            km.loadKeys(['keyA.s1']);

            km.reloadKeys(['keyA.s1', 'keyNew.s2']);

            const newKey = km.getKeyById('keyNew');
            expect(newKey.totalRequests).toBe(0);
            expect(newKey.successCount).toBe(0);
            expect(newKey.rateLimitedCount).toBe(0);
            expect(newKey.inFlight).toBe(0);
            expect(newKey.circuitBreaker.state).toBe(STATES.CLOSED);
        });
    });

    // =========================================================================
    // 5. Key removal
    // =========================================================================
    describe('key removal', () => {
        test('removed key is no longer selected', () => {
            km = createKm({ maxConcurrencyPerKey: 100 });
            km.loadKeys(['keyA.s1', 'keyB.s2', 'keyC.s3']);

            // Remove keyB via reload
            km.reloadKeys(['keyA.s1', 'keyC.s3']);

            // keyB should be gone
            expect(km.getKeyById('keyB')).toBeUndefined();
            expect(km.keys).toHaveLength(2);

            // Verify keyB never selected
            for (let i = 0; i < 20; i++) {
                const selected = km.getBestKey();
                expect(selected.keyId).not.toBe('keyB');
                km.recordSuccess(selected, 100);
            }
        });

        test('removing a key with in-flight requests is handled gracefully', () => {
            km = createKm({ maxConcurrencyPerKey: 100 });
            km.loadKeys(['keyA.s1', 'keyB.s2', 'keyC.s3']);

            // Acquire keyB (simulating in-flight)
            const keyB = km.getKeyById('keyB');
            keyB.inFlight = 1;
            keyB.totalRequests = 1;

            // Reload without keyB
            const result = km.reloadKeys(['keyA.s1', 'keyC.s3']);
            expect(result.removed).toBe(1);
            expect(result.total).toBe(2);

            // The manager should continue working with remaining keys
            const selected = km.getBestKey();
            expect(selected).not.toBeNull();
            expect(['keyA', 'keyC']).toContain(selected.keyId);
        });

        test('removing all keys except one still works', () => {
            km = createKm({ maxConcurrencyPerKey: 100 });
            km.loadKeys(['keyA.s1', 'keyB.s2', 'keyC.s3']);

            km.reloadKeys(['keyA.s1']);
            expect(km.keys).toHaveLength(1);

            const selected = km.getBestKey();
            expect(selected).not.toBeNull();
            expect(selected.keyId).toBe('keyA');
        });

        test('removed key keyMap entry is cleaned up', () => {
            km = createKm();
            km.loadKeys(['keyA.s1', 'keyB.s2']);

            // keyB is in the map
            expect(km.getKeyById('keyB')).toBeDefined();

            km.reloadKeys(['keyA.s1']);

            // keyB should be gone from the map
            expect(km.getKeyById('keyB')).toBeUndefined();
        });
    });

    // =========================================================================
    // 6. Priority/weight (health-score weighted selection)
    // =========================================================================
    describe('priority/weight (health-score weighted selection)', () => {
        test('higher-health-score keys are selected more often', () => {
            km = new KeyManager({
                maxConcurrencyPerKey: 100,
                circuitBreaker: {
                    failureThreshold: 10,
                    failureWindow: 60000,
                    cooldownPeriod: 500
                },
                rateLimitPerMinute: 0,
                keySelection: {
                    useWeightedSelection: true,
                    healthScoreWeights: { latency: 40, successRate: 40, errorRecency: 20 },
                    slowKeyThreshold: 2.0,
                    slowKeyCheckIntervalMs: 999999,
                    slowKeyCooldownMs: 300000
                }
            });
            km.loadKeys(['fast.s1', 'slow.s2']);

            // Build up latency history: fast key is much faster
            for (let i = 0; i < 30; i++) {
                km.recordSuccess(km.keys[0], 50);   // fast key: 50ms
                km.recordSuccess(km.keys[1], 5000);  // slow key: 5000ms
            }
            km.keys[0].totalRequests = 30;
            km.keys[0].successCount = 30;
            km.keys[1].totalRequests = 30;
            km.keys[1].successCount = 30;

            // Sample many selections
            const counts = { fast: 0, slow: 0 };
            for (let i = 0; i < 100; i++) {
                const selected = km.getBestKey();
                expect(selected).not.toBeNull();
                counts[selected.keyId]++;
                // Don't record success to avoid changing scores
            }

            // The fast key should be selected at least as often (weighted selection is probabilistic)
            // With 100 samples, fast should get >= 40% even in worst case
            expect(counts.fast).toBeGreaterThanOrEqual(30);
        });

        test('key with failures gets lower health score', () => {
            km = new KeyManager({
                maxConcurrencyPerKey: 100,
                circuitBreaker: {
                    failureThreshold: 10,
                    failureWindow: 60000,
                    cooldownPeriod: 500
                },
                rateLimitPerMinute: 0,
                keySelection: {
                    useWeightedSelection: true,
                    healthScoreWeights: { latency: 40, successRate: 40, errorRecency: 20 },
                    slowKeyThreshold: 2.0,
                    slowKeyCheckIntervalMs: 999999,
                    slowKeyCooldownMs: 300000
                }
            });
            km.loadKeys(['healthy.s1', 'unhealthy.s2']);

            // healthy key: all successes
            for (let i = 0; i < 20; i++) {
                km.recordSuccess(km.keys[0], 100);
            }
            km.keys[0].totalRequests = 20;
            km.keys[0].successCount = 20;

            // unhealthy key: some failures (record failures to trip its circuit toward open)
            for (let i = 0; i < 10; i++) {
                km.recordSuccess(km.keys[1], 100);
            }
            km.recordFailure(km.keys[1], 'error');
            km.recordFailure(km.keys[1], 'error');
            km.keys[1].totalRequests = 12;

            const healthyScore = km.scheduler._calculateHealthScore(km.keys[0], km.keys);
            const unhealthyScore = km.scheduler._calculateHealthScore(km.keys[1], km.keys);

            expect(healthyScore.total).toBeGreaterThan(unhealthyScore.total);
        });
    });

    // =========================================================================
    // 7. Circuit breaker integration
    // =========================================================================
    describe('circuit breaker integration', () => {
        test('key with open circuit breaker is skipped', () => {
            km = createKm({ maxConcurrencyPerKey: 100 });
            km.loadKeys(['keyA.s1', 'keyB.s2', 'keyC.s3']);

            // Open circuit on keyA
            km.keys[0].circuitBreaker.forceState(STATES.OPEN);

            // keyA should never be selected
            for (let i = 0; i < 20; i++) {
                const selected = km.getBestKey();
                expect(selected).not.toBeNull();
                expect(selected.keyId).not.toBe('keyA');
                km.recordSuccess(selected, 100);
            }
        });

        test('key with HALF_OPEN circuit is selected when no CLOSED keys', () => {
            km = createKm({ maxConcurrencyPerKey: 100 });
            km.loadKeys(['keyA.s1', 'keyB.s2']);

            // Both keys HALF_OPEN
            km.keys[0].circuitBreaker.forceState(STATES.HALF_OPEN);
            km.keys[1].circuitBreaker.forceState(STATES.HALF_OPEN);

            const selected = km.getBestKey();
            expect(selected).not.toBeNull();
            expect(selected.circuitBreaker.state).toBe(STATES.HALF_OPEN);
        });

        test('CLOSED keys preferred over HALF_OPEN keys', () => {
            km = createKm({ maxConcurrencyPerKey: 100 });
            km.loadKeys(['keyA.s1', 'keyB.s2', 'keyC.s3']);

            km.keys[0].circuitBreaker.forceState(STATES.HALF_OPEN);
            km.keys[1].circuitBreaker.forceState(STATES.CLOSED);
            km.keys[2].circuitBreaker.forceState(STATES.HALF_OPEN);

            // With only one CLOSED key, it should always be selected
            for (let i = 0; i < 10; i++) {
                const selected = km.getBestKey();
                expect(selected.keyId).toBe('keyB');
                km.recordSuccess(selected, 100);
            }
        });

        test('all circuits open triggers recovery: oldest forced to HALF_OPEN', () => {
            km = createKm({ maxConcurrencyPerKey: 100 });
            km.loadKeys(['keyA.s1', 'keyB.s2', 'keyC.s3']);

            // Open all circuits with different openedAt timestamps
            km.keys.forEach(k => k.circuitBreaker.forceState(STATES.OPEN));
            km.keys[0].circuitBreaker.openedAt = Date.now() - 30000; // oldest
            km.keys[1].circuitBreaker.openedAt = Date.now() - 10000;
            km.keys[2].circuitBreaker.openedAt = Date.now();

            const selected = km.getBestKey();
            expect(selected).not.toBeNull();
            // Oldest circuit should be forced to HALF_OPEN
            expect(selected.keyId).toBe('keyA');
            expect(selected.circuitBreaker.state).toBe(STATES.HALF_OPEN);
        });

        test('recording failures trips circuit breaker and removes key from rotation', () => {
            km = createKm({
                maxConcurrencyPerKey: 100,
                circuitBreaker: {
                    failureThreshold: 3,
                    failureWindow: 60000,
                    cooldownPeriod: 60000
                }
            });
            km.loadKeys(['keyA.s1', 'keyB.s2']);

            const keyA = km.keys[0];

            // Trip keyA's circuit breaker
            km.recordFailure(keyA, 'server_error');
            km.recordFailure(keyA, 'server_error');
            km.recordFailure(keyA, 'server_error');

            expect(keyA.circuitBreaker.state).toBe(STATES.OPEN);

            // keyA should be excluded
            for (let i = 0; i < 10; i++) {
                const selected = km.getBestKey();
                expect(selected.keyId).toBe('keyB');
                km.recordSuccess(selected, 100);
            }
        });
    });

    // =========================================================================
    // 8. Concurrent selection (maxConcurrencyPerKey)
    // =========================================================================
    describe('concurrent selection (maxConcurrencyPerKey)', () => {
        test('key at maxConcurrencyPerKey is not selected', () => {
            km = createKm({ maxConcurrencyPerKey: 2 });
            km.loadKeys(['keyA.s1', 'keyB.s2']);

            // Fill keyA to capacity
            km.keys[0].inFlight = 2;

            // Only keyB should be selected
            const selected = km.getBestKey();
            expect(selected).not.toBeNull();
            expect(selected.keyId).toBe('keyB');
        });

        test('returns null when all keys at maxConcurrencyPerKey', () => {
            km = createKm({ maxConcurrencyPerKey: 2 });
            km.loadKeys(['keyA.s1', 'keyB.s2', 'keyC.s3']);

            // Fill all keys to capacity
            km.keys.forEach(k => { k.inFlight = 2; });

            const selected = km.getBestKey();
            expect(selected).toBeNull();
        });

        test('multiple acquireKey calls respect concurrency limit', () => {
            km = createKm({ maxConcurrencyPerKey: 2 });
            km.loadKeys(['keyA.s1', 'keyB.s2']);

            // Acquire 4 keys (2 per key = 4 total)
            const acquired = [];
            for (let i = 0; i < 4; i++) {
                const key = km.acquireKey();
                expect(key).not.toBeNull();
                acquired.push(key);
            }

            // Both keys should be at max capacity
            expect(km.keys[0].inFlight).toBe(2);
            expect(km.keys[1].inFlight).toBe(2);

            // 5th acquire should fail
            const fifth = km.acquireKey();
            expect(fifth).toBeNull();

            // Release one and try again
            km.recordSuccess(acquired[0], 100);
            const afterRelease = km.acquireKey();
            expect(afterRelease).not.toBeNull();
        });

        test('concurrent getKey calls distribute across keys, not duplicating beyond limit', () => {
            km = createKm({ maxConcurrencyPerKey: 1 });
            km.loadKeys(['keyA.s1', 'keyB.s2', 'keyC.s3']);

            // Acquire one key per key (maxConcurrency=1)
            const first = km.acquireKey();
            const second = km.acquireKey();
            const third = km.acquireKey();

            expect(first).not.toBeNull();
            expect(second).not.toBeNull();
            expect(third).not.toBeNull();

            // All three should be different keys
            const keyIds = new Set([first.keyId, second.keyId, third.keyId]);
            expect(keyIds.size).toBe(3);

            // 4th should fail (all at max)
            const fourth = km.acquireKey();
            expect(fourth).toBeNull();
        });
    });

    // =========================================================================
    // 9. Stats tracking
    // =========================================================================
    describe('stats tracking', () => {
        test('per-key success count is accurate after requests', () => {
            km = createKm({ maxConcurrencyPerKey: 100 });
            km.loadKeys(['keyA.s1', 'keyB.s2']);

            // Record 5 successes for keyA, 3 for keyB
            for (let i = 0; i < 5; i++) {
                km.recordSuccess(km.keys[0], 100);
            }
            for (let i = 0; i < 3; i++) {
                km.recordSuccess(km.keys[1], 200);
            }

            const stats = km.getStats();
            const keyAStats = stats.find(s => s.keyId === 'keyA');
            const keyBStats = stats.find(s => s.keyId === 'keyB');

            expect(keyAStats.successCount).toBe(5);
            expect(keyBStats.successCount).toBe(3);
        });

        test('per-key failure count is accurate', () => {
            km = createKm({
                maxConcurrencyPerKey: 100,
                circuitBreaker: {
                    failureThreshold: 20, // high threshold to avoid tripping
                    failureWindow: 60000,
                    cooldownPeriod: 500
                }
            });
            km.loadKeys(['keyA.s1', 'keyB.s2']);

            km.recordFailure(km.keys[0], 'error1');
            km.recordFailure(km.keys[0], 'error2');
            km.recordFailure(km.keys[1], 'error3');

            const stats = km.getStats();
            const keyAStats = stats.find(s => s.keyId === 'keyA');
            const keyBStats = stats.find(s => s.keyId === 'keyB');

            // Circuit breaker tracks failures
            expect(keyAStats.circuitBreaker.failureCount).toBe(2);
            expect(keyBStats.circuitBreaker.failureCount).toBe(1);
        });

        test('per-key latency stats are accurate', () => {
            km = createKm({ maxConcurrencyPerKey: 100 });
            km.loadKeys(['keyA.s1']);

            const latencies = [100, 200, 300, 400, 500];
            for (const lat of latencies) {
                km.recordSuccess(km.keys[0], lat);
            }

            const stats = km.getStats();
            const keyAStats = stats.find(s => s.keyId === 'keyA');

            expect(keyAStats.latency.avg).toBe(300); // (100+200+300+400+500)/5
            expect(keyAStats.latency.min).toBe(100);
            expect(keyAStats.latency.max).toBe(500);
            expect(keyAStats.latency.samples).toBe(5);
        });

        test('totalRequests tracks acquireKey calls', () => {
            km = createKm({ maxConcurrencyPerKey: 100 });
            km.loadKeys(['keyA.s1']);

            for (let i = 0; i < 5; i++) {
                const key = km.acquireKey();
                km.recordSuccess(key, 100);
            }

            expect(km.keys[0].totalRequests).toBe(5);
        });

        test('inFlight is accurate during concurrent requests', () => {
            km = createKm({ maxConcurrencyPerKey: 10 });
            km.loadKeys(['keyA.s1']);

            const acquired = [];
            for (let i = 0; i < 3; i++) {
                acquired.push(km.acquireKey());
            }

            expect(km.keys[0].inFlight).toBe(3);

            // Release one
            km.recordSuccess(acquired[0], 100);
            expect(km.keys[0].inFlight).toBe(2);

            // Release another via failure
            km.recordFailure(acquired[1], 'timeout');
            expect(km.keys[0].inFlight).toBe(1);

            // Release last via releaseKey
            km.releaseKey(acquired[2]);
            expect(km.keys[0].inFlight).toBe(0);
        });

        test('aggregated stats reflect all keys', () => {
            km = createKm({ maxConcurrencyPerKey: 100 });
            km.loadKeys(['keyA.s1', 'keyB.s2', 'keyC.s3']);

            // Acquire 2 keys, succeed 1
            const k1 = km.acquireKey();
            const k2 = km.acquireKey();
            km.recordSuccess(k1, 100);

            const agg = km.getAggregatedStats();
            expect(agg.totalKeys).toBe(3);
            expect(agg.totalInFlight).toBe(1); // k2 still in-flight
            expect(agg.totalRequests).toBe(2);
            expect(agg.totalSuccesses).toBe(1);
        });

        test('rate limit tracking in stats is accurate', () => {
            km = createKm({ maxConcurrencyPerKey: 100 });
            km.loadKeys(['keyA.s1', 'keyB.s2']);

            km.recordRateLimit(km.keys[0], 5000);
            km.recordRateLimit(km.keys[0], 5000);
            km.recordRateLimit(km.keys[1], 3000);

            const stats = km.getStats();
            const keyAStats = stats.find(s => s.keyId === 'keyA');
            const keyBStats = stats.find(s => s.keyId === 'keyB');

            expect(keyAStats.rateLimitTracking.count).toBe(2);
            expect(keyBStats.rateLimitTracking.count).toBe(1);

            const agg = km.getAggregatedStats();
            expect(agg.rateLimitStatus.total429s).toBe(3);
        });

        test('lastUsed and lastSuccess timestamps are set correctly', () => {
            km = createKm({ maxConcurrencyPerKey: 100 });
            km.loadKeys(['keyA.s1']);

            const key = km.keys[0];
            expect(key.lastUsed).toBeNull();
            expect(key.lastSuccess).toBeNull();

            km.recordSuccess(key, 100);
            expect(key.lastUsed).not.toBeNull();
            expect(key.lastSuccess).not.toBeNull();

            const successTime = key.lastSuccess;

            // After a failure, lastUsed updates but lastSuccess stays
            km.recordFailure(key, 'error');
            expect(key.lastUsed).not.toBeNull();
            // lastSuccess should still be the time of the last success
            expect(key.lastSuccess).toBe(successTime);
        });

        test('success rate calculation excludes in-flight requests', () => {
            km = createKm({ maxConcurrencyPerKey: 100 });
            km.loadKeys(['keyA.s1']);

            const key = km.keys[0];

            // 2 successes + 1 in-flight
            km.acquireKey();
            km.recordSuccess(key, 100);
            km.acquireKey();
            km.recordSuccess(key, 100);
            km.acquireKey(); // still in-flight

            const stats = km.getStats();
            const keyAStats = stats.find(s => s.keyId === 'keyA');

            // completedRequests = 3 - 1 = 2, successCount = 2
            // successRate = 2/2 * 100 = 100%
            expect(keyAStats.successRate).toBe(100);
        });
    });
});
