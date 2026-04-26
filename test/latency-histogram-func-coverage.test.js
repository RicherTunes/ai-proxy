'use strict';

/**
 * Latency Histogram Function Coverage Tests
 *
 * Targets specific uncovered lines/branches to achieve 100% function/line coverage
 */

const { LatencyHistogram } = require('../lib/latency-histogram');

describe('LatencyHistogram - Function Coverage', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    describe('_findBucket edge case', () => {
        // Covers line 77: fallback return 0 when buckets array is empty
        test('_findBucket returns 0 for empty buckets array', () => {
            // Create histogram with empty buckets array
            const h = new LatencyHistogram({ buckets: [] });
            expect(h.buckets).toEqual([]);

            // Call _findBucket directly to exercise line 77 fallback path
            const result = h._findBucket(100);
            expect(result).toBe(0);
        });

        test('record with empty buckets still stores data point', () => {
            // Covers line 77 path during normal record operation
            const h = new LatencyHistogram({ buckets: [] });

            // This will internally call _findBucket which falls through to line 77
            h.record(100);

            // The record still adds the data point even with empty buckets
            expect(h.dataPoints.length).toBe(1);
            expect(h.dataPoints.get(0).latencyMs).toBe(100);
        });

        test('getHistogram with empty buckets returns valid structure', () => {
            const h = new LatencyHistogram({ buckets: [] });
            const result = h.getHistogram('all');

            // Should still return valid structure
            expect(result.timeRange).toBe('all');
            expect(result.stats).toBeDefined();
            expect(result.stats.count).toBe(0);
        });
    });

    describe('GlobalHistogramAggregator with empty buckets', () => {
        // Covers similar edge cases for GlobalHistogramAggregator
        test('handles empty buckets configuration', () => {
            const { GlobalHistogramAggregator } = require('../lib/latency-histogram');
            const agg = new GlobalHistogramAggregator({ buckets: [] });

            expect(agg.buckets).toEqual([]);
            expect(agg.keyHistograms.size).toBe(0);
        });

        test('getAggregatedHistogram with empty buckets', () => {
            const { GlobalHistogramAggregator } = require('../lib/latency-histogram');
            const agg = new GlobalHistogramAggregator({ buckets: [] });

            const result = agg.getAggregatedHistogram('all');

            expect(result.timeRange).toBe('all');
            expect(result.stats.count).toBe(0);
            expect(result.keyCount).toBe(0);
        });
    });
});
