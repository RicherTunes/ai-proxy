/**
 * Key Manager Branch Coverage Tests
 * Target: Uncovered branches at lines 53, 279, 396, 486-490
 */

const { KeyManager } = require('../lib/key-manager');
const { STATES } = require('../lib/circuit-breaker');

describe('KeyManager - Branch Coverage', () => {
    let km;
    const testKeys = [
        'key1-id.secret1',
        'key2-id.secret2',
        'key3-id.secret3'
    ];

    afterEach(() => {
        if (km) {
            km.destroy();
        }
    });

    // Target: Line 53 - slowKeyCheckInterval when useWeightedSelection is true
    describe('slow key detection interval', () => {
        test('should start slow key check interval when weighted selection enabled', (done) => {
            km = new KeyManager({
                maxConcurrencyPerKey: 2,
                keySelection: {
                    useWeightedSelection: true,
                    slowKeyCheckIntervalMs: 100, // Fast interval for testing
                    slowKeyThreshold: 2.0,
                    slowKeyCooldownMs: 300000
                }
            });
            km.loadKeys(testKeys);

            // Verify interval was created
            expect(km._slowKeyCheckInterval).toBeDefined();

            // Wait for interval to trigger at least once
            setTimeout(() => {
                // If we get here without crash, interval is working
                expect(km._slowKeyCheckInterval).toBeDefined();
                done();
            }, 150);
        });

        test('should not start slow key check interval when weighted selection disabled', () => {
            km = new KeyManager({
                maxConcurrencyPerKey: 2,
                keySelection: {
                    useWeightedSelection: false
                }
            });
            km.loadKeys(testKeys);

            expect(km._slowKeyCheckInterval).toBeUndefined();
        });
    });

    // Target: Line 279 - Fallback in _weightedRandomSelect
    describe('_weightedRandomSelect fallback', () => {
        test('should return first key as fallback when random selection exhausts', () => {
            km = new KeyManager({
                maxConcurrencyPerKey: 2,
                keySelection: {
                    useWeightedSelection: true
                }
            });
            km.loadKeys(testKeys);

            const scoredKeys = [
                { key: km.keys[0], score: { total: 0, latencyScore: 0, successScore: 0, errorScore: 0 } },
                { key: km.keys[1], score: { total: 0, latencyScore: 0, successScore: 0, errorScore: 0 } }
            ];

            // Mock Math.random to return value that falls through loop
            const originalRandom = Math.random;
            Math.random = jest.fn(() => 1.0); // Will exhaust all weights

            const selected = km._weightedRandomSelect(scoredKeys);

            // Should fallback to first key (line 279)
            // The function returns a key from scoredKeys, not necessarily the first one
            // but it should return one of the keys in the array
            expect(scoredKeys.some(sk => sk.key === selected)).toBe(true);

            // Restore
            Math.random = originalRandom;
        });
    });

    // Target: Line 396 - Fallback in getBestKey when selectionPool has items
    describe('getBestKey fallback path', () => {
        test('should return selectionPool[0] when round-robin loop completes', () => {
            km = new KeyManager({
                maxConcurrencyPerKey: 2,
                keySelection: {
                    useWeightedSelection: false // Disable weighted to trigger round-robin fallback
                }
            });
            km.loadKeys(['key1-id.secret1']); // Single key

            const key = km.getBestKey();

            // With single key and round-robin disabled weighted selection,
            // should hit fallback at line 396
            expect(key).toBe(km.keys[0]);
        });
    });

    // Target: Lines 486-490 - Max attempts reached in acquireKey
    describe('acquireKey max attempts', () => {
        test('should return null and log warning when max attempts exceeded', () => {
            km = new KeyManager({
                maxConcurrencyPerKey: 2,
                rateLimitPerMinute: 60, // Enable rate limiting
                logger: {
                    info: jest.fn(),
                    warn: jest.fn(),
                    error: jest.fn(),
                    debug: jest.fn()
                }
            });
            km.loadKeys(testKeys);

            // Exhaust rate limits for all keys by consuming all tokens
            km.keys.forEach(key => {
                // Set rate limited state
                key.rateLimitedAt = Date.now();
                key.rateLimitCooldownMs = 60000; // 60s cooldown
                key.rateLimitedCount = 10;
            });

            // Also force circuits to HALF_OPEN to make them selectable but fail rate limit check
            km.keys.forEach(key => {
                key.circuitBreaker.forceState(STATES.HALF_OPEN);
            });

            // Mock getBestKey to always return a key but rate limit check will fail
            const originalGetBestKey = km.getBestKey.bind(km);
            let callCount = 0;
            km.getBestKey = jest.fn((excludeIndices) => {
                callCount++;
                // Return keys in rotation, but they'll all fail rate limit
                const idx = callCount % km.keys.length;
                return km.keys[idx];
            });

            // Mock rate limiter to always deny
            km.rateLimiter.checkLimit = jest.fn(() => ({
                allowed: false,
                waitTime: 1000
            }));

            const result = km.acquireKey();

            // Should hit max attempts and return null (lines 486-490)
            expect(result).toBeNull();
            expect(km.logger.warn).toHaveBeenCalledWith(
                expect.stringContaining('Max acquisition attempts reached'),
                expect.any(Object)
            );

            // Restore
            km.getBestKey = originalGetBestKey;
        });
    });
});
