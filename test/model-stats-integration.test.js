/**
 * Model stats integration test
 * Verifies that modelStats are properly exposed via the stats API
 */

const { StatsAggregator } = require('../lib/stats-aggregator');

describe('Model Stats Integration', () => {
    let statsAggregator;

    beforeEach(() => {
        statsAggregator = new StatsAggregator({
            statsFile: 'test-stats.json',
            configDir: '/tmp',
            saveInterval: 60000
        });
    });

    afterEach(() => {
        if (statsAggregator) {
            statsAggregator.destroy();
        }
    });

    test('getFullStats includes modelStats', () => {
        // Create mock keyManager
        const mockKeyManager = {
            getStats: () => [
                {
                    index: 0,
                    circuitBreaker: { state: 'CLOSED', failureCount: 0, recentFailures: 0 },
                    inFlight: 0,
                    totalRequests: 10,
                    successCount: 9,
                    successRate: 90,
                    latency: { samples: 10, min: 50, max: 200, avg: 100, p50: 90, p95: 180, p99: 195 },
                    healthScore: 90,
                    lastUsed: new Date().toISOString(),
                    lastSuccess: new Date().toISOString(),
                    rateLimit: null,
                    rateLimitTracking: null
                }
            ],
            circuitBreakerConfig: { threshold: 5, timeout: 30000, halfOpenAttempts: 3 },
            getPoolAverageLatency: () => 100,
            getPoolRateLimitStats: () => null
        };

        // Record some model usage
        statsAggregator.recordModelUsage('glm-4-flash', {
            latencyMs: 100,
            success: true,
            inputTokens: 50,
            outputTokens: 25
        });
        statsAggregator.recordModelUsage('glm-4-flash', {
            latencyMs: 150,
            success: true,
            inputTokens: 75,
            outputTokens: 35
        });
        statsAggregator.recordModelUsage('glm-4-plus', {
            latencyMs: 200,
            success: false,
            is429: true
        });

        const fullStats = statsAggregator.getFullStats(mockKeyManager, 60);

        // Verify modelStats is present
        expect(fullStats).toHaveProperty('modelStats');
        expect(fullStats.modelStats).toBeDefined();

        // Verify glm-4-flash stats
        expect(fullStats.modelStats['glm-4-flash']).toBeDefined();
        expect(fullStats.modelStats['glm-4-flash'].requests).toBe(2);
        expect(fullStats.modelStats['glm-4-flash'].successes).toBe(2);
        expect(fullStats.modelStats['glm-4-flash'].failures).toBe(0);
        expect(fullStats.modelStats['glm-4-flash'].rate429).toBe(0);
        expect(fullStats.modelStats['glm-4-flash'].avgLatencyMs).toBe(125); // (100+150)/2
        expect(fullStats.modelStats['glm-4-flash'].inputTokens).toBe(125);
        expect(fullStats.modelStats['glm-4-flash'].outputTokens).toBe(60);
        expect(fullStats.modelStats['glm-4-flash'].successRate).toBe(100.0);

        // Verify glm-4-plus stats
        expect(fullStats.modelStats['glm-4-plus']).toBeDefined();
        expect(fullStats.modelStats['glm-4-plus'].requests).toBe(1);
        expect(fullStats.modelStats['glm-4-plus'].successes).toBe(0);
        expect(fullStats.modelStats['glm-4-plus'].failures).toBe(1);
        expect(fullStats.modelStats['glm-4-plus'].rate429).toBe(1);
        expect(fullStats.modelStats['glm-4-plus'].avgLatencyMs).toBeNull(); // No successful requests
        expect(fullStats.modelStats['glm-4-plus'].successRate).toBe(0.0);
    });

    test('modelStats is empty object when no model data recorded', () => {
        const mockKeyManager = {
            getStats: () => [],
            circuitBreakerConfig: {},
            getPoolAverageLatency: () => 0,
            getPoolRateLimitStats: () => null
        };

        const fullStats = statsAggregator.getFullStats(mockKeyManager, 60);

        expect(fullStats.modelStats).toEqual({});
    });

    test('modelStats persists across multiple getFullStats calls', () => {
        const mockKeyManager = {
            getStats: () => [],
            circuitBreakerConfig: {},
            getPoolAverageLatency: () => 0,
            getPoolRateLimitStats: () => null
        };

        statsAggregator.recordModelUsage('glm-4-flash', { success: true });

        const stats1 = statsAggregator.getFullStats(mockKeyManager, 60);
        expect(stats1.modelStats['glm-4-flash'].requests).toBe(1);

        statsAggregator.recordModelUsage('glm-4-flash', { success: true });

        const stats2 = statsAggregator.getFullStats(mockKeyManager, 120);
        expect(stats2.modelStats['glm-4-flash'].requests).toBe(2);
    });
});
