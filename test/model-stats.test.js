/**
 * Per-model stats tracking tests
 * Tests the recordModelUsage and getModelStats methods
 */

const { StatsAggregator } = require('../lib/stats-aggregator');

describe('Model Stats Tracking', () => {
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

    test('recordModelUsage increments requests', () => {
        statsAggregator.recordModelUsage('glm-4-flash', { success: true });
        statsAggregator.recordModelUsage('glm-4-flash', { success: true });
        statsAggregator.recordModelUsage('glm-4-plus', { success: true });

        const stats = statsAggregator.getModelStats();

        expect(stats['glm-4-flash'].requests).toBe(2);
        expect(stats['glm-4-plus'].requests).toBe(1);
    });

    test('recordModelUsage tracks success/failure', () => {
        statsAggregator.recordModelUsage('glm-4-flash', { success: true });
        statsAggregator.recordModelUsage('glm-4-flash', { success: true });
        statsAggregator.recordModelUsage('glm-4-flash', { success: false });

        const stats = statsAggregator.getModelStats();

        expect(stats['glm-4-flash'].successes).toBe(2);
        expect(stats['glm-4-flash'].failures).toBe(1);
        expect(stats['glm-4-flash'].successRate).toBe(66.7); // (2/3)*100 = 66.7%
    });

    test('recordModelUsage tracks 429s', () => {
        statsAggregator.recordModelUsage('glm-4-flash', { success: false, is429: true });
        statsAggregator.recordModelUsage('glm-4-flash', { success: false, is429: true });
        statsAggregator.recordModelUsage('glm-4-flash', { success: false, is429: false });

        const stats = statsAggregator.getModelStats();

        expect(stats['glm-4-flash'].rate429).toBe(2);
        expect(stats['glm-4-flash'].failures).toBe(3);
    });

    test('recordModelUsage accumulates latency', () => {
        statsAggregator.recordModelUsage('glm-4-flash', { latencyMs: 100, success: true });
        statsAggregator.recordModelUsage('glm-4-flash', { latencyMs: 200, success: true });
        statsAggregator.recordModelUsage('glm-4-flash', { latencyMs: 300, success: true });

        const stats = statsAggregator.getModelStats();

        // Average: (100 + 200 + 300) / 3 = 200
        expect(stats['glm-4-flash'].avgLatencyMs).toBe(200);
    });

    test('recordModelUsage accumulates tokens', () => {
        statsAggregator.recordModelUsage('glm-4-flash', {
            success: true,
            inputTokens: 100,
            outputTokens: 50
        });
        statsAggregator.recordModelUsage('glm-4-flash', {
            success: true,
            inputTokens: 200,
            outputTokens: 100
        });

        const stats = statsAggregator.getModelStats();

        expect(stats['glm-4-flash'].inputTokens).toBe(300);
        expect(stats['glm-4-flash'].outputTokens).toBe(150);
    });

    test('getModelStats returns correct averages', () => {
        // Model 1: 3 successes, 1 failure, 400ms total latency
        statsAggregator.recordModelUsage('glm-4-flash', { latencyMs: 100, success: true });
        statsAggregator.recordModelUsage('glm-4-flash', { latencyMs: 150, success: true });
        statsAggregator.recordModelUsage('glm-4-flash', { latencyMs: 150, success: true });
        statsAggregator.recordModelUsage('glm-4-flash', { success: false });

        const stats = statsAggregator.getModelStats();

        expect(stats['glm-4-flash'].requests).toBe(4);
        expect(stats['glm-4-flash'].successes).toBe(3);
        expect(stats['glm-4-flash'].failures).toBe(1);
        expect(stats['glm-4-flash'].avgLatencyMs).toBe(133); // (100+150+150)/3 = 133.33, rounded to 133
        expect(stats['glm-4-flash'].successRate).toBe(75.0); // (3/4)*100 = 75%
    });

    test('getModelStats returns empty object when no data', () => {
        const stats = statsAggregator.getModelStats();

        expect(stats).toEqual({});
    });

    test('reset() clears modelStats', () => {
        statsAggregator.recordModelUsage('glm-4-flash', { success: true });
        statsAggregator.recordModelUsage('glm-4-plus', { success: true });

        let stats = statsAggregator.getModelStats();
        expect(Object.keys(stats).length).toBe(2);

        statsAggregator.reset();

        stats = statsAggregator.getModelStats();
        expect(stats).toEqual({});
    });

    test('Multiple models tracked independently', () => {
        statsAggregator.recordModelUsage('glm-4-flash', {
            latencyMs: 100,
            success: true,
            inputTokens: 50,
            outputTokens: 25
        });
        statsAggregator.recordModelUsage('glm-4-plus', {
            latencyMs: 200,
            success: true,
            inputTokens: 100,
            outputTokens: 50
        });
        statsAggregator.recordModelUsage('glm-4-flash', {
            latencyMs: 150,
            success: false,
            is429: true
        });

        const stats = statsAggregator.getModelStats();

        // glm-4-flash: 2 requests, 1 success, 1 failure
        expect(stats['glm-4-flash'].requests).toBe(2);
        expect(stats['glm-4-flash'].successes).toBe(1);
        expect(stats['glm-4-flash'].failures).toBe(1);
        expect(stats['glm-4-flash'].rate429).toBe(1);
        expect(stats['glm-4-flash'].avgLatencyMs).toBe(100); // Only successful request: 100ms
        expect(stats['glm-4-flash'].inputTokens).toBe(50);
        expect(stats['glm-4-flash'].outputTokens).toBe(25);
        expect(stats['glm-4-flash'].successRate).toBe(50.0);

        // glm-4-plus: 1 request, 1 success, 0 failures
        expect(stats['glm-4-plus'].requests).toBe(1);
        expect(stats['glm-4-plus'].successes).toBe(1);
        expect(stats['glm-4-plus'].failures).toBe(0);
        expect(stats['glm-4-plus'].rate429).toBe(0);
        expect(stats['glm-4-plus'].avgLatencyMs).toBe(200);
        expect(stats['glm-4-plus'].inputTokens).toBe(100);
        expect(stats['glm-4-plus'].outputTokens).toBe(50);
        expect(stats['glm-4-plus'].successRate).toBe(100.0);
    });

    test('avgLatencyMs is null when no successful requests', () => {
        statsAggregator.recordModelUsage('glm-4-flash', { success: false });
        statsAggregator.recordModelUsage('glm-4-flash', { success: false });

        const stats = statsAggregator.getModelStats();

        expect(stats['glm-4-flash'].avgLatencyMs).toBeNull();
    });

    test('successRate is null when no completed requests', () => {
        // This shouldn't happen in practice, but test edge case
        const stats = statsAggregator.getModelStats();

        expect(stats).toEqual({});

        // After recording a request
        statsAggregator.recordModelUsage('glm-4-flash', { success: true });

        const stats2 = statsAggregator.getModelStats();
        expect(stats2['glm-4-flash'].successRate).toBe(100.0);
    });

    test('recordModelUsage ignores null/undefined model', () => {
        statsAggregator.recordModelUsage(null, { success: true });
        statsAggregator.recordModelUsage(undefined, { success: true });
        statsAggregator.recordModelUsage('', { success: true });

        const stats = statsAggregator.getModelStats();

        expect(Object.keys(stats).length).toBe(0);
    });

    test('recordModelUsage handles missing optional fields gracefully', () => {
        statsAggregator.recordModelUsage('glm-4-flash', {});
        statsAggregator.recordModelUsage('glm-4-flash', { success: true });

        const stats = statsAggregator.getModelStats();

        expect(stats['glm-4-flash'].requests).toBe(2);
        expect(stats['glm-4-flash'].successes).toBe(1);
        expect(stats['glm-4-flash'].failures).toBe(1);
        expect(stats['glm-4-flash'].rate429).toBe(0);
    });

    test('modelStats included in getFullStats', () => {
        // Create mock keyManager
        const mockKeyManager = {
            getStats: () => [],
            circuitBreakerConfig: {},
            getPoolAverageLatency: () => 0,
            getPoolRateLimitStats: () => null
        };

        statsAggregator.recordModelUsage('glm-4-flash', {
            latencyMs: 100,
            success: true,
            inputTokens: 50,
            outputTokens: 25
        });

        const fullStats = statsAggregator.getFullStats(mockKeyManager, 60);

        expect(fullStats.modelStats).toBeDefined();
        expect(fullStats.modelStats['glm-4-flash']).toBeDefined();
        expect(fullStats.modelStats['glm-4-flash'].requests).toBe(1);
    });
});
