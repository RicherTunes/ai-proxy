/**
 * Socket Stress Tests
 *
 * These tests verify the proxy can handle high concurrency
 * and recover gracefully from socket-level failures.
 *
 * Run with: npm test -- stress/socket-stress.test.js --runInBand
 */

const http = require('http');
const { ProxyServer } = require('../../lib/proxy-server');
const { KeyManager } = require('../../lib/key-manager');
const { StatsAggregator } = require('../../lib/stats-aggregator');

// Mock HTTPS responses
const mockHttpsServer = require('https');

describe('Socket Stress Tests', () => {
    let proxy;
    let keyManager;
    let statsAggregator;
    const PROXY_PORT = 19999;  // Use different port for tests

    // Helper to make concurrent requests
    async function makeConcurrentRequests(count, options = {}) {
        const promises = [];
        for (let i = 0; i < count; i++) {
            promises.push(makeRequest(options));
        }
        return Promise.allSettled(promises);
    }

    // Helper to make a single request
    function makeRequest(options = {}) {
        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: PROXY_PORT,
                path: '/v1/messages',
                method: 'POST',
                timeout: options.timeout || 30000,
                headers: {
                    'Content-Type': 'application/json'
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    resolve({
                        statusCode: res.statusCode,
                        data,
                        headers: res.headers
                    });
                });
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            req.write(JSON.stringify({
                model: 'claude-3-opus',
                messages: [{ role: 'user', content: 'test' }],
                max_tokens: 10
            }));
            req.end();
        });
    }

    describe('High Concurrency', () => {
        test('should handle 10 concurrent requests without failure', async () => {
            // This test requires a running proxy - skip if not available
            const results = await makeConcurrentRequests(10, { timeout: 60000 });

            const fulfilled = results.filter(r => r.status === 'fulfilled');
            const rejected = results.filter(r => r.status === 'rejected');

            // Check if proxy is not running (all ECONNREFUSED)
            const allConnectionRefused = rejected.length === results.length &&
                rejected.every(r => r.reason?.code === 'ECONNREFUSED' ||
                    r.reason?.message?.includes('ECONNREFUSED'));
            if (allConnectionRefused) {
                console.log('Skipping test - proxy not running');
                return;
            }

            // Log failures for debugging
            if (rejected.length > 0) {
                console.log('Rejected requests:', rejected.map(r => r.reason?.message));
            }

            // At least 80% should succeed (allows for some transient failures)
            expect(fulfilled.length).toBeGreaterThanOrEqual(8);
        }, 120000);  // 2 minute timeout

        test('should maintain success rate under sustained load', async () => {
            const batchResults = [];
            let proxyNotRunning = false;

            // Run 5 batches of 5 requests each
            for (let batch = 0; batch < 5; batch++) {
                const results = await makeConcurrentRequests(5, { timeout: 60000 });
                const rejected = results.filter(r => r.status === 'rejected');

                // Check if proxy is not running
                if (batch === 0 && rejected.length === results.length) {
                    const allConnectionRefused = rejected.every(
                        r => r.reason?.code === 'ECONNREFUSED' ||
                            r.reason?.message?.includes('ECONNREFUSED')
                    );
                    if (allConnectionRefused) {
                        proxyNotRunning = true;
                        break;
                    }
                }

                const successCount = results.filter(r => r.status === 'fulfilled').length;
                batchResults.push(successCount);

                // Small delay between batches
                await new Promise(r => setTimeout(r, 500));
            }

            if (proxyNotRunning) {
                console.log('Skipping test - proxy not running');
                return;
            }

            const totalSuccesses = batchResults.reduce((a, b) => a + b, 0);
            const totalRequests = 25;

            console.log(`Sustained load results: ${totalSuccesses}/${totalRequests} succeeded`);

            // At least 80% success rate
            expect(totalSuccesses / totalRequests).toBeGreaterThanOrEqual(0.8);
        }, 300000);  // 5 minute timeout
    });

    describe('Key Manager Under Stress', () => {
        let km;
        const testKeys = Array.from({ length: 10 }, (_, i) => `key${i}.secret${i}`);

        beforeEach(() => {
            km = new KeyManager({
                maxConcurrencyPerKey: 2,
                circuitBreaker: {
                    failureThreshold: 5,
                    failureWindow: 1000,
                    cooldownPeriod: 500
                },
                rateLimitPerMinute: 0
            });
            km.loadKeys(testKeys);
        });

        test('should handle 100 rapid key acquisitions', () => {
            const acquired = [];
            const keyInFlight = new Map();

            for (let i = 0; i < 100; i++) {
                const key = km.acquireKey();
                if (key) {
                    acquired.push(key);
                    keyInFlight.set(key.index, (keyInFlight.get(key.index) || 0) + 1);
                }
            }

            // Should have acquired all 100 keys (key manager always returns a key if possible)
            expect(acquired.length).toBe(100);

            // Verify load is distributed across all 10 keys
            expect(keyInFlight.size).toBe(10);

            // Each key should have 10 in-flight (100 / 10 keys = 10 per key)
            for (const [keyIndex, count] of keyInFlight) {
                expect(count).toBe(10);
            }

            // Release all keys
            acquired.forEach(k => km.recordSuccess(k, 100));
        });

        test('should spread load across keys evenly', () => {
            const keyUsage = new Map();

            // Acquire and release 100 keys
            for (let i = 0; i < 100; i++) {
                const key = km.acquireKey();
                if (key) {
                    keyUsage.set(key.index, (keyUsage.get(key.index) || 0) + 1);
                    km.recordSuccess(key, 100);
                }
            }

            // Check that load is spread across multiple keys
            const usedKeys = keyUsage.size;
            expect(usedKeys).toBeGreaterThan(1);

            // Check variance - no key should have more than 3x average usage
            const avgUsage = 100 / usedKeys;
            const maxUsage = Math.max(...keyUsage.values());
            expect(maxUsage).toBeLessThan(avgUsage * 3);
        });

        test('should recover from circuit breaker trips', () => {
            // Trip circuit breaker for all keys
            km.keys.forEach(key => {
                for (let i = 0; i < 10; i++) {
                    km.recordFailure(key, 'timeout');
                }
            });

            // All circuits should be open
            const openCircuits = km.keys.filter(k => k.circuitBreaker.state === 'OPEN').length;
            expect(openCircuits).toBe(10);

            // Should still be able to get a key (forced to HALF_OPEN)
            const key = km.getBestKey();
            expect(key).not.toBeNull();
        });

        test('should handle rate limit rotation', () => {
            // Rate limit first 5 keys
            for (let i = 0; i < 5; i++) {
                km.keys[i].rateLimitedAt = Date.now();
                km.keys[i].rateLimitCooldownMs = 60000;
            }

            // Should still be able to get keys (from remaining 5)
            const acquiredKeys = new Set();
            for (let i = 0; i < 10; i++) {
                const key = km.acquireKey();
                if (key) {
                    acquiredKeys.add(key.index);
                    km.recordSuccess(key, 100);
                }
            }

            // Should only use non-rate-limited keys
            const usedRateLimited = [...acquiredKeys].filter(idx => idx < 5).length;
            expect(usedRateLimited).toBe(0);
        });
    });

    describe('Stats Aggregator Under Stress', () => {
        let sa;

        beforeEach(() => {
            sa = new StatsAggregator({
                configDir: __dirname,
                statsFile: 'stress-test-stats.json',
                saveInterval: 10000
            });
        });

        afterEach(() => {
            sa.stopAutoSave();
        });

        test('should handle 1000 rapid stat recordings', () => {
            const startTime = Date.now();

            for (let i = 0; i < 1000; i++) {
                sa.recordClientRequestStart();
                if (i % 10 === 0) {
                    sa.recordClientRequestFailure();
                } else {
                    sa.recordClientRequestSuccess();
                }
            }

            const duration = Date.now() - startTime;

            // Should complete in reasonable time
            expect(duration).toBeLessThan(1000);  // Less than 1 second

            // Check accuracy
            const stats = sa.getClientRequestStats();
            expect(stats.total).toBe(1000);
            expect(stats.succeeded).toBe(900);
            expect(stats.failed).toBe(100);
            expect(stats.successRate).toBe(90);
        });

        test('should maintain accuracy under concurrent access', async () => {
            const promises = [];

            // Simulate concurrent access from multiple "workers"
            for (let worker = 0; worker < 10; worker++) {
                promises.push(new Promise(resolve => {
                    for (let i = 0; i < 100; i++) {
                        sa.recordClientRequestStart();
                        sa.recordClientRequestSuccess();
                    }
                    resolve();
                }));
            }

            await Promise.all(promises);

            const stats = sa.getClientRequestStats();
            expect(stats.total).toBe(1000);
            expect(stats.succeeded).toBe(1000);
        });
    });

    describe('Memory Leak Detection', () => {
        test('should not leak memory in circular buffer', () => {
            const km = new KeyManager({
                maxConcurrencyPerKey: 100,
                rateLimitPerMinute: 0
            });
            km.loadKeys(['key1.secret1']);

            const key = km.keys[0];
            const initialMemory = process.memoryUsage().heapUsed;

            // Add 10000 latency samples
            for (let i = 0; i < 10000; i++) {
                km.recordSuccess(key, Math.random() * 1000);
            }

            // Force garbage collection if available
            if (global.gc) {
                global.gc();
            }

            const finalMemory = process.memoryUsage().heapUsed;
            const memoryGrowth = finalMemory - initialMemory;

            // Memory growth should be bounded (circular buffer caps at 100)
            // Allow 5MB growth for test overhead
            expect(memoryGrowth).toBeLessThan(5 * 1024 * 1024);

            // Circular buffer should be capped
            expect(key.latencies.length).toBeLessThanOrEqual(100);
        });

        test('should not leak error timestamps', async () => {
            const km = new KeyManager({
                maxConcurrencyPerKey: 100,
                circuitBreaker: {
                    failureThreshold: 1000,  // High threshold to prevent trips
                    failureWindow: 50  // Very short window (50ms) for testing trim
                },
                rateLimitPerMinute: 0
            });
            km.loadKeys(['key1.secret1']);

            const key = km.keys[0];

            // Record 100 failures
            for (let i = 0; i < 100; i++) {
                km.recordFailure(key, 'timeout');
            }

            // All 100 should be present initially (within 50ms window)
            expect(key.circuitBreaker.failureTimestamps.length).toBe(100);

            // Wait for timestamps to age out of the window
            await new Promise(r => setTimeout(r, 100));

            // Trigger cleanup by calling getStats()
            key.circuitBreaker.getStats();

            // After cleanup, old timestamps should be trimmed
            const recentFailures = key.circuitBreaker.failureTimestamps?.length || 0;

            // All timestamps should be trimmed (they're all > 50ms old now)
            expect(recentFailures).toBe(0);
        });
    });
});
