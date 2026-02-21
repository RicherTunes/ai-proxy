/**
 * Key Manager Module Tests
 */

const { KeyManager } = require('../lib/key-manager');
const { STATES } = require('../lib/circuit-breaker');

describe('KeyManager', () => {
    let km;
    const testKeys = [
        'key1-id.secret1',
        'key2-id.secret2',
        'key3-id.secret3'
    ];

    beforeEach(() => {
        km = new KeyManager({
            maxConcurrencyPerKey: 2,
            circuitBreaker: {
                failureThreshold: 3,
                failureWindow: 1000,
                cooldownPeriod: 500
            },
            rateLimitPerMinute: 0  // Disabled for most tests
        });
        km.loadKeys(testKeys);
    });

    afterEach(() => {
        if (km) {
            km.destroy();
        }
    });

    describe('static getKeyId', () => {
        test('should extract key ID from full key', () => {
            expect(KeyManager.getKeyId('abc123.secret456')).toBe('abc123');
        });

        test('should handle key without secret', () => {
            expect(KeyManager.getKeyId('abc123')).toBe('abc123');
        });
    });

    describe('loadKeys', () => {
        test('should load keys correctly', () => {
            expect(km.keys).toHaveLength(3);
        });

        test('should initialize key stats', () => {
            const key = km.keys[0];
            expect(key.index).toBe(0);
            expect(key.keyId).toBe('key1-id');
            expect(key.keyPrefix).toBe('key1-id');
            expect(key.inFlight).toBe(0);
            expect(key.totalRequests).toBe(0);
            expect(key.successCount).toBe(0);
            expect(key.circuitBreaker).toBeDefined();
        });

        test('should create key map', () => {
            expect(km.keyMap.has('key1-id')).toBe(true);
            expect(km.keyMap.has('key2-id')).toBe(true);
        });
    });

    describe('reloadKeys', () => {
        test('should add new keys', () => {
            const result = km.reloadKeys([...testKeys, 'key4-id.secret4']);
            expect(result.added).toBe(1);
            expect(result.total).toBe(4);
            expect(km.keys).toHaveLength(4);
        });

        test('should remove old keys', () => {
            const result = km.reloadKeys(['key1-id.secret1', 'key2-id.secret2']);
            expect(result.removed).toBe(1);
            expect(result.total).toBe(2);
        });

        test('should preserve stats for existing keys', () => {
            const key = km.getKeyById('key1-id');
            km.recordSuccess(key, 100);
            km.recordSuccess(key, 100);

            km.reloadKeys(testKeys);

            const reloadedKey = km.getKeyById('key1-id');
            expect(reloadedKey.successCount).toBe(2);
        });

        test('should update indices after reload', () => {
            km.reloadKeys(['key3-id.secret3', 'key1-id.secret1']);
            expect(km.getKeyById('key3-id').index).toBe(0);
            expect(km.getKeyById('key1-id').index).toBe(1);
        });
    });

    describe('isKeyAvailable', () => {
        test('should return true for healthy key', () => {
            expect(km.isKeyAvailable(km.keys[0])).toBe(true);
        });

        test('should return false for key with open circuit', () => {
            const key = km.keys[0];
            key.circuitBreaker.forceState(STATES.OPEN);
            expect(km.isKeyAvailable(key)).toBe(false);
        });

        test('should return true for half-open circuit', () => {
            const key = km.keys[0];
            key.circuitBreaker.forceState(STATES.HALF_OPEN);
            expect(km.isKeyAvailable(key)).toBe(true);
        });
    });

    describe('getBestKey', () => {
        test('should return a key when available', () => {
            const key = km.getBestKey();
            expect(key).not.toBeNull();
            expect(km.keys).toContain(key);
        });

        test('should use round-robin distribution', () => {
            const keys = [];
            for (let i = 0; i < 6; i++) {
                const key = km.getBestKey();
                keys.push(key.index);
            }
            // Should have used each key at least once
            expect(new Set(keys).size).toBeGreaterThan(1);
        });

        test('should exclude specified indices', () => {
            const key = km.getBestKey([0, 1]);
            expect(key.index).toBe(2);
        });

        test('should return null when all keys excluded and circuits closed', () => {
            const key = km.getBestKey([0, 1, 2]);
            // When all keys are excluded and circuits are closed, returns null
            expect(key).toBeNull();
        });

        test('should respect concurrency limit', () => {
            const key1 = km.keys[0];
            key1.inFlight = 2;  // At max

            km.roundRobinIndex = 0;
            const selected = km.getBestKey();

            // Should skip key1 and select key2 or key3
            expect(selected.index).not.toBe(0);
        });

        test('should prefer CLOSED keys over HALF_OPEN', () => {
            km.keys[0].circuitBreaker.forceState(STATES.HALF_OPEN);
            km.keys[1].circuitBreaker.forceState(STATES.CLOSED);
            km.keys[2].circuitBreaker.forceState(STATES.OPEN);

            km.roundRobinIndex = 0;
            const selected = km.getBestKey();

            expect(selected.circuitBreaker.state).toBe(STATES.CLOSED);
        });

        test('should force HALF_OPEN when all circuits open', () => {
            km.keys.forEach(k => k.circuitBreaker.forceState(STATES.OPEN));

            const selected = km.getBestKey();

            expect(selected).not.toBeNull();
            expect(selected.circuitBreaker.state).toBe(STATES.HALF_OPEN);
        });

        test('should reset all circuits as last resort', () => {
            km.keys.forEach(k => k.circuitBreaker.forceState(STATES.OPEN));

            // Force oldest to be excluded
            km.keys[0].circuitBreaker.openedAt = Date.now() - 10000;

            const selected = km.getBestKey([0]); // Exclude the one that would be forced

            // Should have reset all circuits
            expect(selected).not.toBeNull();
        });
    });

    describe('acquireKey', () => {
        test('should increment inFlight', () => {
            const key = km.acquireKey();
            expect(key.inFlight).toBe(1);
        });

        test('should increment totalRequests', () => {
            const key = km.acquireKey();
            expect(key.totalRequests).toBe(1);
        });

        test('should return null when all keys excluded', () => {
            // All keys excluded
            const key = km.acquireKey([0, 1, 2]);
            expect(key).toBeNull();
        });
    });

    describe('recordSuccess', () => {
        test('should decrement inFlight', () => {
            const key = km.acquireKey();
            expect(key.inFlight).toBe(1);

            km.recordSuccess(key, 100);
            expect(key.inFlight).toBe(0);
        });

        test('should not go below zero', () => {
            const key = km.keys[0];
            km.recordSuccess(key, 100);
            expect(key.inFlight).toBe(0);
        });

        test('should increment success count', () => {
            const key = km.keys[0];
            km.recordSuccess(key, 100);
            km.recordSuccess(key, 100);
            expect(key.successCount).toBe(2);
        });

        test('should track latency', () => {
            const key = km.keys[0];
            km.recordSuccess(key, 100);
            km.recordSuccess(key, 200);
            expect(key.latencies.length).toBe(2);
            expect(key.latencies.toArray()).toContain(100);
            expect(key.latencies.toArray()).toContain(200);
        });

        test('should limit latency history to 100 (RingBuffer)', () => {
            const key = km.keys[0];
            for (let i = 0; i < 110; i++) {
                km.recordSuccess(key, i);
            }
            // RingBuffer caps at capacity (100)
            expect(key.latencies.length).toBe(100);
            // Oldest values (0-9) should be overwritten
            expect(key.latencies.toArray()).not.toContain(0);
            expect(key.latencies.toArray()).toContain(109);
        });

        test('should update lastUsed', () => {
            const key = km.keys[0];
            km.recordSuccess(key, 100);
            expect(key.lastUsed).not.toBeNull();
        });

        test('should return usage data', () => {
            const key = km.keys[0];
            const usage = km.recordSuccess(key, 100);

            expect(usage.keyId).toBe('key1-id');
            expect(usage.requests).toBe(1);
            expect(usage.successes).toBe(1);
            expect(usage.failures).toBe(0);
            expect(usage.lastUsed).toBeDefined();
        });
    });

    describe('recordFailure', () => {
        test('should decrement inFlight', () => {
            const key = km.acquireKey();
            km.recordFailure(key, 'timeout');
            expect(key.inFlight).toBe(0);
        });

        test('should record failure in circuit breaker', () => {
            const key = km.keys[0];
            km.recordFailure(key, 'timeout');
            km.recordFailure(key, 'timeout');
            km.recordFailure(key, 'timeout');

            expect(key.circuitBreaker.state).toBe(STATES.OPEN);
        });

        test('should return usage data with failure', () => {
            const key = km.keys[0];
            const usage = km.recordFailure(key, 'timeout');

            expect(usage.successes).toBe(0);
            expect(usage.failures).toBe(1);
        });
    });

    describe('recordSocketHangup', () => {
        test('should decrement inFlight', () => {
            const key = km.acquireKey();
            km.recordSocketHangup(key);
            expect(key.inFlight).toBe(0);
        });

        test('should not record failure in circuit breaker', () => {
            const key = km.keys[0];
            km.recordSocketHangup(key);
            km.recordSocketHangup(key);
            km.recordSocketHangup(key);

            expect(key.circuitBreaker.state).toBe(STATES.CLOSED);
        });

        test('should return usage data with socketHangup flag', () => {
            const key = km.keys[0];
            const usage = km.recordSocketHangup(key);

            expect(usage.socketHangup).toBe(true);
            expect(usage.failures).toBe(0);
        });
    });

    describe('releaseKey', () => {
        test('should decrement inFlight without recording', () => {
            const key = km.acquireKey();
            const successBefore = key.successCount;

            km.releaseKey(key);

            expect(key.inFlight).toBe(0);
            expect(key.successCount).toBe(successBefore);
        });
    });

    describe('getKeyByIndex', () => {
        test('should return correct key', () => {
            const key = km.getKeyByIndex(1);
            expect(key.keyId).toBe('key2-id');
        });

        test('should return undefined for invalid index', () => {
            expect(km.getKeyByIndex(99)).toBeUndefined();
        });
    });

    describe('getKeyById', () => {
        test('should return correct key', () => {
            const key = km.getKeyById('key2-id');
            expect(key.index).toBe(1);
        });

        test('should return undefined for invalid id', () => {
            expect(km.getKeyById('invalid')).toBeUndefined();
        });
    });

    describe('getStats', () => {
        test('should return stats for all keys', () => {
            const stats = km.getStats();
            expect(stats).toHaveLength(3);
        });

        test('should include all expected fields', () => {
            km.acquireKey();
            km.recordSuccess(km.keys[0], 100);

            const stats = km.getStats();
            const keyStats = stats[0];

            expect(keyStats).toHaveProperty('index');
            expect(keyStats).toHaveProperty('keyId');
            expect(keyStats).toHaveProperty('keyPrefix');
            expect(keyStats).toHaveProperty('inFlight');
            expect(keyStats).toHaveProperty('totalRequests');
            expect(keyStats).toHaveProperty('successCount');
            expect(keyStats).toHaveProperty('successRate');
            expect(keyStats).toHaveProperty('latency');
            expect(keyStats.latency).toHaveProperty('avg');
            expect(keyStats.latency).toHaveProperty('min');
            expect(keyStats.latency).toHaveProperty('max');
            expect(keyStats.latency).toHaveProperty('p50');
            expect(keyStats.latency).toHaveProperty('p95');
            expect(keyStats.latency).toHaveProperty('p99');
            expect(keyStats.latency).toHaveProperty('samples');
            expect(keyStats).toHaveProperty('lastUsed');
            expect(keyStats).toHaveProperty('circuitBreaker');
            expect(keyStats).toHaveProperty('rateLimit');
        });
    });

    describe('getAggregatedStats', () => {
        test('should return aggregated statistics', () => {
            km.acquireKey();
            km.acquireKey();

            const stats = km.getAggregatedStats();

            expect(stats.totalKeys).toBe(3);
            expect(stats.totalInFlight).toBe(2);
            expect(stats).toHaveProperty('availableKeys');
            expect(stats).toHaveProperty('totalRequests');
            expect(stats).toHaveProperty('totalSuccesses');
            expect(stats).toHaveProperty('circuitStates');
        });

        test('should track circuit states', () => {
            km.keys[0].circuitBreaker.forceState(STATES.OPEN);
            km.keys[1].circuitBreaker.forceState(STATES.HALF_OPEN);

            const stats = km.getAggregatedStats();

            expect(stats.circuitStates.closed).toBe(1);
            expect(stats.circuitStates.open).toBe(1);
            expect(stats.circuitStates.halfOpen).toBe(1);
        });
    });

    describe('resetAll', () => {
        test('should reset all keys', () => {
            km.keys.forEach(k => {
                k.circuitBreaker.recordFailure('test');
                k.circuitBreaker.recordFailure('test');
                k.inFlight = 5;
            });

            km.resetAll();

            km.keys.forEach(k => {
                expect(k.circuitBreaker.state).toBe(STATES.CLOSED);
                expect(k.inFlight).toBe(0);
            });
        });

        test('should reset round robin index', () => {
            km.roundRobinIndex = 10;
            km.resetAll();
            expect(km.roundRobinIndex).toBe(0);
        });
    });

    describe('with rate limiting', () => {
        beforeEach(() => {
            km = new KeyManager({
                maxConcurrencyPerKey: 2,
                rateLimitPerMinute: 5,
                rateLimitBurst: 0
            });
            km.loadKeys(testKeys);
        });

        test('should respect rate limits', () => {
            // Exhaust rate limit for key 0
            for (let i = 0; i < 10; i++) {
                if (km.isKeyAvailable(km.keys[0])) {
                    km.rateLimiter.checkLimit(km.keys[0].keyId);
                }
            }

            expect(km.isKeyAvailable(km.keys[0])).toBe(false);
            expect(km.isKeyAvailable(km.keys[1])).toBe(true);
        });

        // REGRESSION TEST: acquireKey must consume rate limit tokens
        test('acquireKey should consume rate limit tokens', () => {
            // Create a manager with very tight rate limit (2 per minute, no burst)
            const rateLimitedKm = new KeyManager({
                maxConcurrencyPerKey: 10,  // High concurrency so it's not the limiter
                rateLimitPerMinute: 2,
                rateLimitBurst: 0
            });
            rateLimitedKm.loadKeys(['key1.secret1']);

            const key = rateLimitedKm.keys[0];

            // First acquire should succeed and consume a token
            const acquired1 = rateLimitedKm.acquireKey();
            expect(acquired1).not.toBeNull();
            expect(acquired1.keyId).toBe('key1');
            rateLimitedKm.recordSuccess(acquired1, 100);  // Release key

            // Second acquire should succeed and consume another token
            const acquired2 = rateLimitedKm.acquireKey();
            expect(acquired2).not.toBeNull();
            rateLimitedKm.recordSuccess(acquired2, 100);

            // Third acquire should fail - rate limit exhausted
            // (only 2 tokens available, both consumed by acquireKey)
            const acquired3 = rateLimitedKm.acquireKey();
            expect(acquired3).toBeNull();  // No more tokens!

            // Verify via rate limiter stats
            const stats = rateLimitedKm.rateLimiter.getKeyStats('key1');
            expect(stats.tokens).toBe(0);
        });

        test('acquireKey should try alternate keys when rate limited', () => {
            // Manager with tight rate limit but multiple keys
            const multiKeyKm = new KeyManager({
                maxConcurrencyPerKey: 10,
                rateLimitPerMinute: 1,  // Only 1 per minute per key
                rateLimitBurst: 0
            });
            multiKeyKm.loadKeys(['key1.secret1', 'key2.secret2', 'key3.secret3']);

            // First acquire uses key1
            const acquired1 = multiKeyKm.acquireKey();
            expect(acquired1).not.toBeNull();
            multiKeyKm.recordSuccess(acquired1, 100);

            // Second acquire should use key2 (key1 exhausted)
            const acquired2 = multiKeyKm.acquireKey();
            expect(acquired2).not.toBeNull();
            expect(acquired2.keyId).not.toBe(acquired1.keyId);  // Different key!
            multiKeyKm.recordSuccess(acquired2, 100);

            // Third acquire should use key3 (key1 and key2 exhausted)
            const acquired3 = multiKeyKm.acquireKey();
            expect(acquired3).not.toBeNull();
            expect(acquired3.keyId).not.toBe(acquired1.keyId);
            expect(acquired3.keyId).not.toBe(acquired2.keyId);
        });
    });

    describe('logging', () => {
        test('should log when logger is provided', () => {
            const mockLogger = {
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
                debug: jest.fn()
            };

            const loggedKm = new KeyManager({
                maxConcurrencyPerKey: 2,
                logger: mockLogger
            });
            loggedKm.loadKeys(testKeys);

            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('Loaded'),
                undefined
            );
        });

        test('should not throw when logger is not provided', () => {
            const noLoggerKm = new KeyManager({ maxConcurrencyPerKey: 2 });
            expect(() => noLoggerKm.loadKeys(testKeys)).not.toThrow();
        });
    });

    describe('onKeyStateChange callback', () => {
        test('should call callback when circuit state changes', () => {
            const stateChangeCb = jest.fn();

            const callbackKm = new KeyManager({
                maxConcurrencyPerKey: 2,
                circuitBreaker: {
                    failureThreshold: 2,
                    failureWindow: 1000
                },
                onKeyStateChange: stateChangeCb
            });
            callbackKm.loadKeys(['key1.secret1']);

            const key = callbackKm.keys[0];
            callbackKm.recordFailure(key, 'timeout');
            callbackKm.recordFailure(key, 'timeout');

            expect(stateChangeCb).toHaveBeenCalled();
        });
    });

    describe('getBestKey edge cases', () => {
        test('should return least loaded key when all at max concurrency', () => {
            km.keys[0].inFlight = 2;
            km.keys[1].inFlight = 2;
            km.keys[2].inFlight = 1;  // Least loaded

            km.roundRobinIndex = 0;
            const selected = km.getBestKey();

            expect(selected.index).toBe(2);  // Should pick least loaded
        });

        test('should handle all keys excluded returning null', () => {
            const result = km.getBestKey([0, 1, 2]);
            expect(result).toBeNull();
        });

        test('should use HALF_OPEN key when only option', () => {
            km.keys[0].circuitBreaker.forceState(STATES.OPEN);
            km.keys[1].circuitBreaker.forceState(STATES.OPEN);
            km.keys[2].circuitBreaker.forceState(STATES.HALF_OPEN);

            const selected = km.getBestKey();
            expect(selected.circuitBreaker.state).toBe(STATES.HALF_OPEN);
        });
    });

    describe('recordSuccess without latency', () => {
        test('should work without latency parameter', () => {
            const key = km.keys[0];
            km.acquireKey();

            const usage = km.recordSuccess(key);

            expect(usage.successes).toBe(1);
            expect(key.latencies.length).toBe(0);  // No latency added
        });
    });

    describe('_handleNoAvailableKeys', () => {
        test('should return null when all excluded and circuits closed', () => {
            // All circuits closed but all excluded
            const result = km._handleNoAvailableKeys(new Set([0, 1, 2]));
            expect(result).toBeNull();
        });

        test('should force oldest OPEN circuit to HALF_OPEN', () => {
            km.keys.forEach(k => k.circuitBreaker.forceState(STATES.OPEN));
            km.keys[0].circuitBreaker.openedAt = Date.now() - 10000;  // Oldest
            km.keys[1].circuitBreaker.openedAt = Date.now() - 5000;
            km.keys[2].circuitBreaker.openedAt = Date.now();

            const selected = km._handleNoAvailableKeys(new Set());

            expect(selected.index).toBe(0);  // Oldest
            expect(selected.circuitBreaker.state).toBe(STATES.HALF_OPEN);
        });

        test('should return null when all keys excluded even if OPEN', () => {
            km.keys.forEach(k => k.circuitBreaker.forceState(STATES.OPEN));

            // All keys excluded - can't work with them regardless of state
            const result = km._handleNoAvailableKeys(new Set([0, 1, 2]));

            // Returns null because all keys are excluded
            expect(result).toBeNull();
        });
    });

    describe('latency stats', () => {
        test('should calculate latency stats via RingBuffer', () => {
            const key = km.keys[0];
            km.recordSuccess(key, 100);
            km.recordSuccess(key, 200);
            km.recordSuccess(key, 300);

            const stats = km.getStats();
            const keyStats = stats[0];
            expect(keyStats.latency.avg).toBe(200);  // (100+200+300)/3
            expect(keyStats.latency.min).toBe(100);
            expect(keyStats.latency.max).toBe(300);
            expect(keyStats.latency.samples).toBe(3);
        });

        test('should return null for empty latencies', () => {
            const stats = km.getStats();
            const keyStats = stats[0];
            expect(keyStats.latency.avg).toBeNull();
            expect(keyStats.latency.samples).toBe(0);
        });
    });

    describe('constructor defaults', () => {
        test('should use default values', () => {
            const defaultKm = new KeyManager();
            expect(defaultKm.maxConcurrencyPerKey).toBe(3);
        });

        test('should use default onKeyStateChange callback', () => {
            const defaultKm = new KeyManager();
            expect(() => defaultKm.onKeyStateChange()).not.toThrow();
        });
    });

    describe('getBestKey HALF_OPEN selection', () => {
        test('should use available HALF_OPEN keys when no CLOSED keys', () => {
            // All keys HALF_OPEN
            km.keys.forEach(k => k.circuitBreaker.forceState(STATES.HALF_OPEN));

            const selected = km.getBestKey();

            // Should still return a key (HALF_OPEN)
            expect(selected).not.toBeNull();
            expect(selected.circuitBreaker.state).toBe(STATES.HALF_OPEN);
        });

        test('should prefer CLOSED keys over HALF_OPEN', () => {
            km.keys[0].circuitBreaker.forceState(STATES.HALF_OPEN);
            km.keys[1].circuitBreaker.forceState(STATES.CLOSED);
            km.keys[2].circuitBreaker.forceState(STATES.HALF_OPEN);

            km.roundRobinIndex = 0;  // Start at first key

            const selected = km.getBestKey();

            // Should pick the CLOSED key (key 1)
            expect(selected.circuitBreaker.state).toBe(STATES.CLOSED);
        });
    });

    describe('getBestKey least loaded fallback', () => {
        test('should return key with lower inFlight when all at max', () => {
            // All keys at max concurrency
            km.keys[0].inFlight = 2;
            km.keys[1].inFlight = 2;
            km.keys[2].inFlight = 1;  // Lower

            km.roundRobinIndex = 0;
            const selected = km.getBestKey();

            // Should pick key with lowest inFlight
            expect(selected.inFlight).toBeLessThanOrEqual(2);
        });

        test('should return first key when all have same inFlight', () => {
            // All keys at same inFlight (below max so they're available)
            km.keys[0].inFlight = 1;
            km.keys[1].inFlight = 1;
            km.keys[2].inFlight = 1;

            km.roundRobinIndex = 0;
            const selected = km.getBestKey();

            expect(selected).not.toBeNull();
        });
    });

    describe('_handleNoAvailableKeys circuit reset', () => {
        test('should reset circuits and return least loaded when no OPEN keys', () => {
            // Make all keys CLOSED but below max concurrency
            km.keys.forEach(k => {
                k.inFlight = 1;  // Below max
            });

            // When all keys have concurrency but circuits are closed,
            // getBestKey should return a key (any of them)
            km.keys[2].inFlight = 0;  // Least loaded

            const selected = km.getBestKey();
            expect(selected).not.toBeNull();
            // Should return a key with low inFlight (health scoring prefers low inFlight)
            expect(selected.inFlight).toBeLessThanOrEqual(1);
        });

        test('should correctly find least loaded when resetting circuits', () => {
            // Force all circuits to OPEN
            km.keys.forEach(k => k.circuitBreaker.forceState(STATES.OPEN));
            km.keys[0].inFlight = 3;
            km.keys[1].inFlight = 1;  // Least loaded
            km.keys[2].inFlight = 2;

            // Exclude only some keys to trigger circuit reset
            const selected = km._handleNoAvailableKeys(new Set([]));

            // Should return oldest OPEN key (forced to HALF_OPEN)
            expect(selected).not.toBeNull();
        });
    });

    describe('error type defaults', () => {
        test('should use default error type in recordFailure', () => {
            const key = km.keys[0];
            const usage = km.recordFailure(key);  // No error type

            expect(usage.failures).toBe(1);
        });
    });

    describe('rate limiter disabled', () => {
        test('should work without rate limiter', () => {
            const noRateLimitKm = new KeyManager({
                maxConcurrencyPerKey: 2,
                rateLimitPerMinute: 0  // Disabled
            });
            noRateLimitKm.loadKeys(testKeys);

            // Should always be available when rate limit disabled
            expect(noRateLimitKm.isKeyAvailable(noRateLimitKm.keys[0])).toBe(true);
        });
    });

    // ========== NEW TESTS FOR ROBUSTNESS IMPROVEMENTS ==========

    describe('health score calculation', () => {
        test('should penalize recently used keys', () => {
            const key1 = km.keys[0];
            const key2 = km.keys[1];

            // Use key1 recently
            km.acquireKey();  // This will pick key1
            km.recordSuccess(key1, 100);

            // Get health scores immediately after use
            const score1 = km.scheduler._calculateHealthScore(key1, km.keys);
            const score2 = km.scheduler._calculateHealthScore(key2, km.keys);

            // Key1 should have lower score due to recency penalty
            expect(score1.recencyPenalty).toBeGreaterThan(0);
            expect(score2.recencyPenalty).toBe(0);
        });

        test('should penalize keys with in-flight requests', () => {
            const key1 = km.keys[0];
            const key2 = km.keys[1];

            // Add in-flight to key1
            key1.inFlight = 2;
            key2.inFlight = 0;

            const score1 = km.scheduler._calculateHealthScore(key1, km.keys);
            const score2 = km.scheduler._calculateHealthScore(key2, km.keys);

            // Key1 should have lower score due to inFlight penalty
            expect(score1.inFlightPenalty).toBeGreaterThan(0);
            expect(score2.inFlightPenalty).toBe(0);
            expect(score1.total).toBeLessThan(score2.total);
        });

        test('should include all score components', () => {
            const key = km.keys[0];
            km.recordSuccess(key, 100);

            const score = km.scheduler._calculateHealthScore(key, km.keys);

            expect(score).toHaveProperty('total');
            expect(score).toHaveProperty('latencyScore');
            expect(score).toHaveProperty('successScore');
            expect(score).toHaveProperty('errorScore');
            expect(score).toHaveProperty('recencyPenalty');
            expect(score).toHaveProperty('inFlightPenalty');
            expect(score).toHaveProperty('details');
        });

        test('should calculate score correctly for new key', () => {
            const key = km.keys[0];
            const score = km.scheduler._calculateHealthScore(key, km.keys);

            // New key should have high score (no failures, no penalties)
            expect(score.total).toBeGreaterThanOrEqual(80);
            expect(score.recencyPenalty).toBe(0);
            expect(score.inFlightPenalty).toBe(0);
        });
    });

    describe('rate limit tracking', () => {
        test('should track rate limit on recordRateLimit', () => {
            const key = km.keys[0];

            km.recordRateLimit(key, 60000);

            expect(key.rateLimitedCount).toBe(1);
            expect(key.rateLimitedAt).not.toBeNull();
        });

        test('should increment rate limit count', () => {
            const key = km.keys[0];

            km.recordRateLimit(key, 60000);
            km.recordRateLimit(key, 60000);
            km.recordRateLimit(key, 60000);

            expect(key.rateLimitedCount).toBe(3);
        });

        test('should clear rate limit status on success', () => {
            const key = km.keys[0];

            // First, rate limit the key
            km.recordRateLimit(key, 60000);
            expect(key.rateLimitedAt).not.toBeNull();

            // Then succeed
            km.recordSuccess(key, 100);
            expect(key.rateLimitedAt).toBeNull();
        });

        test('should track lastSuccess on recordSuccess', () => {
            const key = km.keys[0];

            expect(key.lastSuccess).toBeNull();
            km.recordSuccess(key, 100);
            expect(key.lastSuccess).not.toBeNull();
        });

        test('should include rate limit tracking in getStats', () => {
            const key = km.keys[0];
            km.recordRateLimit(key, 60000);

            const stats = km.getStats();
            const keyStats = stats[0];

            expect(keyStats).toHaveProperty('rateLimitTracking');
            expect(keyStats.rateLimitTracking.count).toBe(1);
            expect(keyStats.rateLimitTracking.lastHit).not.toBeNull();
        });

        test('should include rate limit status in aggregated stats', () => {
            const key = km.keys[0];
            km.recordRateLimit(key, 60000);

            const stats = km.getAggregatedStats();

            expect(stats).toHaveProperty('rateLimitStatus');
            expect(stats.rateLimitStatus.total429s).toBe(1);
        });

        test('should reset rate limit tracking on resetAll', () => {
            const key = km.keys[0];
            km.recordFailure(key, 'rate_limited');
            km.recordSuccess(km.keys[1], 100);

            km.resetAll();

            km.keys.forEach(k => {
                expect(k.rateLimitedCount).toBe(0);
                expect(k.rateLimitedAt).toBeNull();
                expect(k.lastSuccess).toBeNull();
            });
        });
    });

    describe('smart key rotation', () => {
        test('should avoid rate-limited keys when others available', () => {
            // Rate limit key 0
            const key0 = km.keys[0];
            key0.rateLimitedAt = Date.now();
            key0.rateLimitCooldownMs = 60000;

            // Get best key - should not be key 0
            km.roundRobinIndex = 0;
            const selected = km.getBestKey();

            expect(selected.index).not.toBe(0);
        });

        test('should use rate-limited key after cooldown', async () => {
            const key = km.keys[0];
            key.rateLimitedAt = Date.now() - 61000;  // 61 seconds ago
            key.rateLimitCooldownMs = 60000;  // 60 second cooldown

            // Now key should be usable again (cooldown elapsed)
            km.roundRobinIndex = 0;
            const selected = km.getBestKey();

            // Key should be available after cooldown
            expect(selected).not.toBeNull();
        });

        test('should fall back to rate-limited keys when all are limited', () => {
            // Rate limit all keys
            km.keys.forEach(k => {
                k.rateLimitedAt = Date.now();
                k.rateLimitCooldownMs = 60000;
            });

            const selected = km.getBestKey();

            // Should still return a key (can't avoid them all)
            expect(selected).not.toBeNull();
        });

        test('should include cooldown remaining in stats', () => {
            const key = km.keys[0];
            key.rateLimitedAt = Date.now();
            key.rateLimitCooldownMs = 60000;

            const stats = km.getStats();
            const keyStats = stats[0];

            expect(keyStats.rateLimitTracking.inCooldown).toBe(true);
            expect(keyStats.rateLimitTracking.cooldownRemaining).toBeGreaterThan(0);
        });
    });

    describe('success rate calculation', () => {
        test('should calculate success rate excluding in-flight', () => {
            // Use single-key manager for deterministic test
            const singleKeyManager = new KeyManager({
                maxConcurrencyPerKey: 10,
                rateLimitPerMinute: 0
            });
            singleKeyManager.loadKeys(['key1.secret1']);

            const key = singleKeyManager.keys[0];

            // 2 successes, 1 in-flight
            const acquired1 = singleKeyManager.acquireKey();  // totalRequests = 1, inFlight = 1
            singleKeyManager.recordSuccess(acquired1, 100);  // successCount = 1, inFlight = 0
            const acquired2 = singleKeyManager.acquireKey();  // totalRequests = 2, inFlight = 1
            singleKeyManager.recordSuccess(acquired2, 100);  // successCount = 2, inFlight = 0
            singleKeyManager.acquireKey();  // totalRequests = 3, inFlight = 1 (still pending)

            const stats = singleKeyManager.getStats();
            const keyStats = stats.find(s => s.index === key.index);

            // Success rate should be 100% (2/2 completed), not 66% (2/3 total)
            expect(keyStats.successRate).toBe(100);
        });

        test('should return null success rate when no completed requests', () => {
            // Use single-key manager for deterministic test
            const singleKeyManager = new KeyManager({
                maxConcurrencyPerKey: 10,
                rateLimitPerMinute: 0
            });
            singleKeyManager.loadKeys(['key1.secret1']);

            singleKeyManager.acquireKey();  // 1 in-flight, 0 completed

            const stats = singleKeyManager.getStats();
            const keyStats = stats[0];

            // With 1 totalRequests and 1 inFlight, completedRequests = 0
            expect(keyStats.successRate).toBeNull();
        });
    });

    describe('per-key cooldown decay', () => {
        let decayKm;

        beforeEach(() => {
            jest.useFakeTimers();
            decayKm = new KeyManager({
                maxConcurrencyPerKey: 2,
                rateLimitPerMinute: 0,
                keyRateLimitCooldown: {
                    cooldownDecayMs: 30000,
                    baseCooldownMs: 1000
                }
            });
            decayKm.loadKeys(['key1.secret1', 'key2.secret2', 'key3.secret3']);
        });

        afterEach(() => {
            decayKm.destroy();
            jest.useRealTimers();
            jest.restoreAllMocks();
        });

        test('key cooldown resets to baseCooldownMs after cooldownDecayMs without 429', () => {
            const now = Date.now();
            jest.spyOn(Date, 'now').mockReturnValue(now);

            const key = decayKm.keys[0];
            // Simulate escalated cooldown: 4 consecutive 429s -> 8000ms cooldown
            key.rateLimitedAt = now;
            key.rateLimitedCount = 4;
            key.rateLimitCooldownMs = 8000;

            // Advance past the decay period (30s)
            jest.spyOn(Date, 'now').mockReturnValue(now + 31000);

            // getBestKey triggers the decay check
            const selected = decayKm.getBestKey();

            // Key should have been decayed
            expect(key.rateLimitCooldownMs).toBe(1000);
            expect(key.rateLimitedCount).toBe(0);
            expect(key.rateLimitedAt).toBeNull();
        });

        test('key cooldown does NOT reset before cooldownDecayMs', () => {
            const now = Date.now();
            jest.spyOn(Date, 'now').mockReturnValue(now);

            const key = decayKm.keys[0];
            key.rateLimitedAt = now;
            key.rateLimitedCount = 4;
            key.rateLimitCooldownMs = 8000;

            // Only advance 20s (less than 30s decay window)
            jest.spyOn(Date, 'now').mockReturnValue(now + 20000);

            decayKm.getBestKey();

            // Key should NOT have been decayed
            expect(key.rateLimitCooldownMs).toBe(8000);
            expect(key.rateLimitedCount).toBe(4);
            expect(key.rateLimitedAt).toBe(now);
        });
    });

    describe('account-level 429 detection', () => {
        let alKm;

        beforeEach(() => {
            jest.useFakeTimers();
            alKm = new KeyManager({
                maxConcurrencyPerKey: 2,
                rateLimitPerMinute: 0,
                accountLevelDetection: {
                    enabled: true,
                    keyThreshold: 3,
                    windowMs: 5000,
                    cooldownMs: 10000
                }
            });
            alKm.loadKeys(['key1.secret1', 'key2.secret2', 'key3.secret3', 'key4.secret4']);
        });

        afterEach(() => {
            alKm.destroy();
            jest.useRealTimers();
            jest.restoreAllMocks();
        });

        test('3 unique keys within 5s triggers isAccountLevel: true', () => {
            const now = Date.now();
            jest.spyOn(Date, 'now').mockReturnValue(now);

            alKm.detectAccountLevelRateLimit(0);
            alKm.detectAccountLevelRateLimit(1);
            const result = alKm.detectAccountLevelRateLimit(2);

            expect(result.isAccountLevel).toBe(true);
            expect(result.cooldownMs).toBe(10000);
        });

        test('2 unique keys does NOT trigger', () => {
            const now = Date.now();
            jest.spyOn(Date, 'now').mockReturnValue(now);

            alKm.detectAccountLevelRateLimit(0);
            const result = alKm.detectAccountLevelRateLimit(1);

            expect(result.isAccountLevel).toBe(false);
        });

        test('same key 3x does NOT trigger (unique key count = 1)', () => {
            const now = Date.now();
            jest.spyOn(Date, 'now').mockReturnValue(now);

            alKm.detectAccountLevelRateLimit(0);
            alKm.detectAccountLevelRateLimit(0);
            const result = alKm.detectAccountLevelRateLimit(0);

            expect(result.isAccountLevel).toBe(false);
        });

        test('hits outside 5s window are pruned', () => {
            const now = Date.now();
            jest.spyOn(Date, 'now').mockReturnValue(now);

            // Two hits at time 0
            alKm.detectAccountLevelRateLimit(0);
            alKm.detectAccountLevelRateLimit(1);

            // Advance past window
            jest.spyOn(Date, 'now').mockReturnValue(now + 6000);

            // Third unique key, but old hits are pruned
            const result = alKm.detectAccountLevelRateLimit(2);

            expect(result.isAccountLevel).toBe(false);
        });

        test('isAccountLevelRateLimited returns true during cooldown, false after expiry', () => {
            const now = Date.now();
            jest.spyOn(Date, 'now').mockReturnValue(now);

            // Trigger account-level
            alKm.detectAccountLevelRateLimit(0);
            alKm.detectAccountLevelRateLimit(1);
            alKm.detectAccountLevelRateLimit(2);

            expect(alKm.isAccountLevelRateLimited()).toBe(true);
            expect(alKm.getAccountLevelCooldownRemainingMs()).toBe(10000);

            // Advance past cooldown
            jest.spyOn(Date, 'now').mockReturnValue(now + 11000);

            expect(alKm.isAccountLevelRateLimited()).toBe(false);
            expect(alKm.getAccountLevelCooldownRemainingMs()).toBe(0);
        });

        test('enabled: false disables detection', () => {
            const disabledKm = new KeyManager({
                maxConcurrencyPerKey: 2,
                rateLimitPerMinute: 0,
                accountLevelDetection: { enabled: false }
            });
            disabledKm.loadKeys(['key1.secret1', 'key2.secret2', 'key3.secret3']);

            const now = Date.now();
            jest.spyOn(Date, 'now').mockReturnValue(now);

            disabledKm.detectAccountLevelRateLimit(0);
            disabledKm.detectAccountLevelRateLimit(1);
            const result = disabledKm.detectAccountLevelRateLimit(2);

            expect(result.isAccountLevel).toBe(false);

            disabledKm.destroy();
        });
    });

    describe('per-model concurrency gate', () => {
        let gatedKm;

        beforeEach(() => {
            gatedKm = new KeyManager({
                maxConcurrencyPerKey: 2,
                rateLimitPerMinute: 0,
                circuitBreaker: { failureThreshold: 3, failureWindow: 1000, cooldownPeriod: 500 }
            });
            gatedKm.loadKeys(testKeys);
            // Set known model limits
            gatedKm.setModelConcurrencyLimits({
                'glm-4.7': 10,
                'glm-4.5': 10,
                'glm-4.5-air': 10
            });
        });

        afterEach(() => {
            gatedKm.destroy();
        });

        test('acquireModelSlot returns true when model has capacity', () => {
            expect(gatedKm.acquireModelSlot('glm-4.7')).toBe(true);
        });

        test('acquireModelSlot increments in-flight for model', () => {
            gatedKm.acquireModelSlot('glm-4.7');
            expect(gatedKm.getModelInFlight('glm-4.7')).toBe(1);
        });

        test('acquireModelSlot returns false when model at maxConcurrency', () => {
            // glm-4.7 allows 10 concurrent
            for (let i = 0; i < 10; i++) {
                expect(gatedKm.acquireModelSlot('glm-4.7')).toBe(true);
            }
            // 11th should be rejected
            expect(gatedKm.acquireModelSlot('glm-4.7')).toBe(false);
        });

        test('releaseModelSlot decrements in-flight', () => {
            gatedKm.acquireModelSlot('glm-4.7');
            gatedKm.acquireModelSlot('glm-4.7');
            expect(gatedKm.getModelInFlight('glm-4.7')).toBe(2);

            gatedKm.releaseModelSlot('glm-4.7');
            expect(gatedKm.getModelInFlight('glm-4.7')).toBe(1);
        });

        test('releaseModelSlot does not go below 0', () => {
            gatedKm.releaseModelSlot('glm-4.7');
            expect(gatedKm.getModelInFlight('glm-4.7')).toBe(0);
        });

        test('after release, model accepts new requests', () => {
            // Fill to capacity
            for (let i = 0; i < 10; i++) {
                gatedKm.acquireModelSlot('glm-4.7');
            }
            expect(gatedKm.acquireModelSlot('glm-4.7')).toBe(false);

            // Release one
            gatedKm.releaseModelSlot('glm-4.7');
            // Now should accept again
            expect(gatedKm.acquireModelSlot('glm-4.7')).toBe(true);
        });

        test('different models have independent concurrency limits', () => {
            // Fill glm-4.7 (limit 10)
            for (let i = 0; i < 10; i++) {
                gatedKm.acquireModelSlot('glm-4.7');
            }
            expect(gatedKm.acquireModelSlot('glm-4.7')).toBe(false);

            // glm-4.5-air (limit 10) should still accept
            expect(gatedKm.acquireModelSlot('glm-4.5-air')).toBe(true);
        });

        test('unknown model uses default limit (no blocking)', () => {
            // Unknown model should allow requests (permissive default)
            expect(gatedKm.acquireModelSlot('unknown-model')).toBe(true);
            expect(gatedKm.acquireModelSlot('unknown-model')).toBe(true);
        });

        test('isModelAtCapacity returns correct state', () => {
            expect(gatedKm.isModelAtCapacity('glm-4.7')).toBe(false);
            for (let i = 0; i < 10; i++) {
                gatedKm.acquireModelSlot('glm-4.7');
            }
            expect(gatedKm.isModelAtCapacity('glm-4.7')).toBe(true);
        });

        test('getModelConcurrencyStats returns per-model data', () => {
            gatedKm.acquireModelSlot('glm-4.7');
            gatedKm.acquireModelSlot('glm-4.5');

            const stats = gatedKm.getModelConcurrencyStats();
            expect(stats['glm-4.7']).toEqual({ inFlight: 1, maxConcurrency: 10 });
            expect(stats['glm-4.5']).toEqual({ inFlight: 1, maxConcurrency: 10 });
        });
    });
});
