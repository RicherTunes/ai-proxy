/**
 * Latency Histogram Module Tests
 *
 * Tests cover:
 * - LatencyHistogram: bucket assignment, percentile calculation, time range filtering
 * - GlobalHistogramAggregator: multi-key aggregation, per-key histograms
 * - Edge cases: empty data, boundary values, large datasets
 */

const { LatencyHistogram, GlobalHistogramAggregator, DEFAULT_BUCKETS } = require('../lib/latency-histogram');

describe('LatencyHistogram', () => {
    describe('module exports', () => {
        test('should export LatencyHistogram class', () => {
            expect(LatencyHistogram).toBeDefined();
            expect(typeof LatencyHistogram).toBe('function');
        });

        test('should export GlobalHistogramAggregator class', () => {
            expect(GlobalHistogramAggregator).toBeDefined();
            expect(typeof GlobalHistogramAggregator).toBe('function');
        });

        test('should export DEFAULT_BUCKETS', () => {
            expect(DEFAULT_BUCKETS).toBeDefined();
            expect(Array.isArray(DEFAULT_BUCKETS)).toBe(true);
            expect(DEFAULT_BUCKETS).toEqual([0, 100, 500, 1000, 2000, 5000, 10000, 30000, 60000, 120000]);
        });
    });

    describe('constructor', () => {
        test('should initialize with default buckets', () => {
            const h = new LatencyHistogram();
            expect(h.buckets).toEqual(DEFAULT_BUCKETS);
        });

        test('should accept custom buckets', () => {
            const customBuckets = [0, 50, 100, 500];
            const h = new LatencyHistogram({ buckets: customBuckets });
            expect(h.buckets).toEqual(customBuckets);
        });

        test('should initialize with default maxDataPoints', () => {
            const h = new LatencyHistogram();
            expect(h.maxDataPoints).toBe(10000);
        });

        test('should accept custom maxDataPoints', () => {
            const h = new LatencyHistogram({ maxDataPoints: 500 });
            expect(h.maxDataPoints).toBe(500);
        });

        test('should initialize empty dataPoints RingBuffer', () => {
            const h = new LatencyHistogram();
            expect(h.dataPoints.length).toBe(0);
            expect(h.dataPoints.toArray()).toEqual([]);
        });

        test('should initialize bucket counts', () => {
            const h = new LatencyHistogram();
            expect(h._bucketCounts).toBeInstanceOf(Map);
            expect(h._bucketCounts.size).toBeGreaterThan(0);
        });
    });

    describe('_formatMs', () => {
        let h;
        beforeEach(() => {
            h = new LatencyHistogram();
        });

        test('should format milliseconds as ms', () => {
            expect(h._formatMs(0)).toBe('0ms');
            expect(h._formatMs(100)).toBe('100ms');
            expect(h._formatMs(999)).toBe('999ms');
        });

        test('should format seconds', () => {
            expect(h._formatMs(1000)).toBe('1s');
            expect(h._formatMs(2000)).toBe('2s');
            expect(h._formatMs(5000)).toBe('5s');
            expect(h._formatMs(30000)).toBe('30s');
        });

        test('should format minutes', () => {
            expect(h._formatMs(60000)).toBe('1m');
            expect(h._formatMs(120000)).toBe('2m');
            expect(h._formatMs(300000)).toBe('5m');
        });

        test('should round properly', () => {
            expect(h._formatMs(1500)).toBe('2s'); // rounds to 2
            expect(h._formatMs(90000)).toBe('2m'); // rounds to 2
        });
    });

    describe('_getBucketLabel', () => {
        test('should return range labels for middle buckets', () => {
            const h = new LatencyHistogram({ buckets: [0, 100, 500, 1000] });

            expect(h._getBucketLabel(0)).toBe('0ms-100ms');
            expect(h._getBucketLabel(1)).toBe('100ms-500ms');
            expect(h._getBucketLabel(2)).toBe('500ms-1s');
        });

        test('should return open-ended label for last bucket', () => {
            const h = new LatencyHistogram({ buckets: [0, 100, 500] });
            expect(h._getBucketLabel(2)).toBe('500ms+');
        });

        test('should format bucket labels with time units', () => {
            const h = new LatencyHistogram({ buckets: [0, 1000, 60000, 120000] });

            expect(h._getBucketLabel(0)).toBe('0ms-1s');
            expect(h._getBucketLabel(1)).toBe('1s-1m');
            expect(h._getBucketLabel(2)).toBe('1m-2m');
            expect(h._getBucketLabel(3)).toBe('2m+');
        });
    });

    describe('_findBucket', () => {
        test('should find correct bucket for value in range', () => {
            const h = new LatencyHistogram({ buckets: [0, 100, 500, 1000] });

            expect(h._findBucket(0)).toBe(0);
            expect(h._findBucket(50)).toBe(0);
            expect(h._findBucket(99)).toBe(0);
            expect(h._findBucket(100)).toBe(1);
            expect(h._findBucket(499)).toBe(1);
            expect(h._findBucket(500)).toBe(2);
        });

        test('should put values >= last boundary in last bucket', () => {
            const h = new LatencyHistogram({ buckets: [0, 100, 500] });

            expect(h._findBucket(500)).toBe(2);
            expect(h._findBucket(1000)).toBe(2);
            expect(h._findBucket(999999)).toBe(2);
        });

        test('should handle DEFAULT_BUCKETS correctly', () => {
            const h = new LatencyHistogram();

            expect(h._findBucket(0)).toBe(0);
            expect(h._findBucket(50)).toBe(0);
            expect(h._findBucket(100)).toBe(1);
            expect(h._findBucket(300)).toBe(1);
            expect(h._findBucket(500)).toBe(2);
            expect(h._findBucket(120000)).toBe(9); // Last bucket
            expect(h._findBucket(999999)).toBe(9); // Last bucket
        });
    });

    describe('record', () => {
        test('should add data point', () => {
            const h = new LatencyHistogram();
            h.record(100);

            expect(h.dataPoints.length).toBe(1);
            expect(h.dataPoints.get(0).latencyMs).toBe(100);
            expect(h.dataPoints.get(0).timestamp).toBeDefined();
        });

        test('should increment bucket count', () => {
            const h = new LatencyHistogram({ buckets: [0, 100, 500] });
            h.record(50);

            expect(h._bucketCounts.get('0ms-100ms')).toBe(1);
        });

        test('should reject negative values', () => {
            const h = new LatencyHistogram();
            h.record(-100);

            expect(h.dataPoints.length).toBe(0);
        });

        test('should reject non-number values', () => {
            const h = new LatencyHistogram();
            h.record('100');
            h.record(null);
            h.record(undefined);
            h.record({});

            expect(h.dataPoints.length).toBe(0);
        });

        test('should accept 0 as valid latency', () => {
            const h = new LatencyHistogram();
            h.record(0);

            expect(h.dataPoints.length).toBe(1);
            expect(h.dataPoints.get(0).latencyMs).toBe(0);
        });

        test('should trim old data points when over limit', () => {
            const h = new LatencyHistogram({ maxDataPoints: 5 });

            for (let i = 0; i < 10; i++) {
                h.record(i * 100);
            }

            expect(h.dataPoints.length).toBe(5);
            // Should have last 5 values (500, 600, 700, 800, 900)
            expect(h.dataPoints.get(0).latencyMs).toBe(500);
            expect(h.dataPoints.get(4).latencyMs).toBe(900);
        });

        test('should update bucket counts when trimming', () => {
            const h = new LatencyHistogram({ buckets: [0, 100, 500], maxDataPoints: 3 });

            // Add 4 values in first bucket
            h.record(10);
            h.record(20);
            h.record(30);
            h.record(40);

            // Should have 3 data points, bucket count should be 3
            expect(h.dataPoints.length).toBe(3);
            expect(h._bucketCounts.get('0ms-100ms')).toBe(3);
        });
    });

    describe('getHistogram', () => {
        test('should return empty histogram when no data', () => {
            const h = new LatencyHistogram({ buckets: [0, 100, 500] });
            const result = h.getHistogram();

            expect(result.stats.count).toBe(0);
            expect(result.stats.avg).toBe(0);
            expect(result.stats.min).toBe(0);
            expect(result.stats.max).toBe(0);
        });

        test('should return correct bucket counts', () => {
            const h = new LatencyHistogram({ buckets: [0, 100, 500, 1000] });

            h.record(50);  // bucket 0
            h.record(75);  // bucket 0
            h.record(200); // bucket 1
            h.record(600); // bucket 2

            const result = h.getHistogram('all');

            expect(result.buckets['0ms-100ms']).toBe(2);
            expect(result.buckets['100ms-500ms']).toBe(1);
            expect(result.buckets['500ms-1s']).toBe(1);
            expect(result.buckets['1s+']).toBe(0);
        });

        test('should calculate correct stats', () => {
            const h = new LatencyHistogram();

            h.record(100);
            h.record(200);
            h.record(300);
            h.record(400);

            const result = h.getHistogram('all');

            expect(result.stats.count).toBe(4);
            expect(result.stats.avg).toBe(250); // (100+200+300+400)/4
            expect(result.stats.min).toBe(100);
            expect(result.stats.max).toBe(400);
        });

        test('should filter by 5m time range', () => {
            const h = new LatencyHistogram();

            // Record with old timestamp manually using RingBuffer's push
            h.dataPoints.push({ latencyMs: 100, timestamp: Date.now() - 10 * 60 * 1000 }); // 10 min ago
            h.dataPoints.push({ latencyMs: 200, timestamp: Date.now() - 2 * 60 * 1000 });  // 2 min ago

            const result = h.getHistogram('5m');

            expect(result.stats.count).toBe(1);
            expect(result.stats.avg).toBe(200);
        });

        test('should filter by 1h time range', () => {
            const h = new LatencyHistogram();

            h.dataPoints.push({ latencyMs: 100, timestamp: Date.now() - 2 * 60 * 60 * 1000 }); // 2 hours ago
            h.dataPoints.push({ latencyMs: 200, timestamp: Date.now() - 30 * 60 * 1000 }); // 30 min ago

            const result = h.getHistogram('1h');

            expect(result.stats.count).toBe(1);
            expect(result.stats.avg).toBe(200);
        });

        test('should filter by 24h time range', () => {
            const h = new LatencyHistogram();

            h.dataPoints.push({ latencyMs: 100, timestamp: Date.now() - 48 * 60 * 60 * 1000 }); // 2 days ago
            h.dataPoints.push({ latencyMs: 200, timestamp: Date.now() - 12 * 60 * 60 * 1000 }); // 12 hours ago

            const result = h.getHistogram('24h');

            expect(result.stats.count).toBe(1);
            expect(result.stats.avg).toBe(200);
        });

        test('should default to all for unknown time range', () => {
            const h = new LatencyHistogram();

            h.dataPoints.push({ latencyMs: 100, timestamp: Date.now() - 365 * 24 * 60 * 60 * 1000 }); // 1 year ago
            h.dataPoints.push({ latencyMs: 200, timestamp: Date.now() });

            const result = h.getHistogram('unknown');

            expect(result.stats.count).toBe(2);
        });

        test('should include timeRange in result', () => {
            const h = new LatencyHistogram();
            const result = h.getHistogram('15m');
            expect(result.timeRange).toBe('15m');
        });

        test('should include bucketLabels in result', () => {
            const h = new LatencyHistogram({ buckets: [0, 100, 500] });
            const result = h.getHistogram();

            expect(result.bucketLabels).toEqual(['0ms-100ms', '100ms-500ms', '500ms+']);
        });
    });

    describe('percentile calculation', () => {
        test('should calculate p50 correctly', () => {
            const h = new LatencyHistogram();

            // Add 10 values: 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000
            for (let i = 1; i <= 10; i++) {
                h.record(i * 100);
            }

            const result = h.getHistogram('all');

            // p50 is the 50th percentile - median
            expect(result.stats.p50).toBe(500);
        });

        test('should calculate p95 correctly', () => {
            const h = new LatencyHistogram();

            for (let i = 1; i <= 100; i++) {
                h.record(i);
            }

            const result = h.getHistogram('all');

            // p95 should be around 95
            expect(result.stats.p95).toBe(95);
        });

        test('should calculate p99 correctly', () => {
            const h = new LatencyHistogram();

            for (let i = 1; i <= 100; i++) {
                h.record(i);
            }

            const result = h.getHistogram('all');

            // p99 should be around 99
            expect(result.stats.p99).toBe(99);
        });

        test('should return 0 for percentiles when no data', () => {
            const h = new LatencyHistogram();
            const result = h.getHistogram();

            expect(result.stats.p50).toBe(0);
            expect(result.stats.p95).toBe(0);
            expect(result.stats.p99).toBe(0);
        });

        test('should handle single data point', () => {
            const h = new LatencyHistogram();
            h.record(500);

            const result = h.getHistogram('all');

            expect(result.stats.p50).toBe(500);
            expect(result.stats.p95).toBe(500);
            expect(result.stats.p99).toBe(500);
        });
    });

    describe('getChartData', () => {
        test('should return labels and values arrays', () => {
            const h = new LatencyHistogram({ buckets: [0, 100, 500] });

            h.record(50);
            h.record(200);

            const result = h.getChartData('all');

            expect(result.labels).toEqual(['0ms-100ms', '100ms-500ms', '500ms+']);
            expect(result.values).toEqual([1, 1, 0]);
        });

        test('should include stats', () => {
            const h = new LatencyHistogram();
            h.record(100);

            const result = h.getChartData();

            expect(result.stats).toBeDefined();
            expect(result.stats.count).toBe(1);
        });

        test('should include timeRange', () => {
            const h = new LatencyHistogram();
            const result = h.getChartData('1h');

            expect(result.timeRange).toBe('1h');
        });
    });

    describe('getSummary', () => {
        test('should return totalPoints', () => {
            const h = new LatencyHistogram();

            h.record(100);
            h.record(200);
            h.record(300);

            const summary = h.getSummary();

            expect(summary.totalPoints).toBe(3);
        });

        test('should return stats for multiple time ranges', () => {
            const h = new LatencyHistogram();
            h.record(100);

            const summary = h.getSummary();

            expect(summary.timeRanges['5m']).toBeDefined();
            expect(summary.timeRanges['15m']).toBeDefined();
            expect(summary.timeRanges['1h']).toBeDefined();
        });
    });

    describe('reset', () => {
        test('should clear all data points', () => {
            const h = new LatencyHistogram();

            h.record(100);
            h.record(200);
            h.reset();

            expect(h.dataPoints.length).toBe(0);
        });

        test('should reset bucket counts', () => {
            const h = new LatencyHistogram({ buckets: [0, 100, 500] });

            h.record(50);
            h.record(200);
            h.reset();

            expect(h._bucketCounts.get('0ms-100ms')).toBe(0);
            expect(h._bucketCounts.get('100ms-500ms')).toBe(0);
        });
    });

    describe('edge cases', () => {
        test('should handle very large latency values', () => {
            const h = new LatencyHistogram();
            h.record(1000000);

            const result = h.getHistogram('all');
            expect(result.stats.count).toBe(1);
            expect(result.stats.max).toBe(1000000);
        });

        test('should handle floating point latency', () => {
            const h = new LatencyHistogram();
            h.record(100.5);

            const result = h.getHistogram('all');
            expect(result.stats.count).toBe(1);
            // Stats are rounded
            expect(result.stats.avg).toBe(101);
        });

        test('should handle large number of data points', () => {
            const h = new LatencyHistogram({ maxDataPoints: 10000 });

            for (let i = 0; i < 10000; i++) {
                h.record(i % 1000);
            }

            expect(h.dataPoints.length).toBe(10000);
            const result = h.getHistogram('all');
            expect(result.stats.count).toBe(10000);
        });

        test('should handle concurrent bucket boundaries', () => {
            const h = new LatencyHistogram({ buckets: [0, 100, 200, 300] });

            h.record(100); // boundary - should be bucket 1
            h.record(200); // boundary - should be bucket 2
            h.record(300); // boundary - should be bucket 3 (last)

            const result = h.getHistogram('all');

            expect(result.buckets['0ms-100ms']).toBe(0);
            expect(result.buckets['100ms-200ms']).toBe(1);
            expect(result.buckets['200ms-300ms']).toBe(1);
            expect(result.buckets['300ms+']).toBe(1);
        });
    });
});

describe('GlobalHistogramAggregator', () => {
    describe('constructor', () => {
        test('should initialize with default buckets', () => {
            const agg = new GlobalHistogramAggregator();
            expect(agg.buckets).toEqual(DEFAULT_BUCKETS);
        });

        test('should accept custom buckets', () => {
            const customBuckets = [0, 50, 100];
            const agg = new GlobalHistogramAggregator({ buckets: customBuckets });
            expect(agg.buckets).toEqual(customBuckets);
        });

        test('should initialize empty keyHistograms map', () => {
            const agg = new GlobalHistogramAggregator();
            expect(agg.keyHistograms).toBeInstanceOf(Map);
            expect(agg.keyHistograms.size).toBe(0);
        });
    });

    describe('getKeyHistogram', () => {
        test('should create new histogram for unknown key', () => {
            const agg = new GlobalHistogramAggregator();
            const h = agg.getKeyHistogram('key1');

            expect(h).toBeInstanceOf(LatencyHistogram);
            expect(agg.keyHistograms.size).toBe(1);
        });

        test('should return existing histogram for known key', () => {
            const agg = new GlobalHistogramAggregator();

            const h1 = agg.getKeyHistogram('key1');
            h1.record(100);

            const h2 = agg.getKeyHistogram('key1');

            expect(h1).toBe(h2);
            expect(h2.dataPoints.length).toBe(1);
        });

        test('should use configured buckets for new histograms', () => {
            const customBuckets = [0, 50, 100];
            const agg = new GlobalHistogramAggregator({ buckets: customBuckets });

            const h = agg.getKeyHistogram('key1');

            expect(h.buckets).toEqual(customBuckets);
        });
    });

    describe('record', () => {
        test('should record latency to key histogram', () => {
            const agg = new GlobalHistogramAggregator();

            agg.record('key1', 100);
            agg.record('key1', 200);

            const h = agg.getKeyHistogram('key1');
            expect(h.dataPoints.length).toBe(2);
        });

        test('should record to separate histograms per key', () => {
            const agg = new GlobalHistogramAggregator();

            agg.record('key1', 100);
            agg.record('key2', 200);

            expect(agg.getKeyHistogram('key1').dataPoints.length).toBe(1);
            expect(agg.getKeyHistogram('key2').dataPoints.length).toBe(1);
        });
    });

    describe('getAggregatedHistogram', () => {
        test('should return empty histogram when no keys', () => {
            const agg = new GlobalHistogramAggregator({ buckets: [0, 100, 500] });
            const result = agg.getAggregatedHistogram();

            expect(result.stats.count).toBe(0);
            expect(result.keyCount).toBe(0);
        });

        test('should aggregate bucket counts from all keys', () => {
            const agg = new GlobalHistogramAggregator({ buckets: [0, 100, 500] });

            agg.record('key1', 50);  // bucket 0
            agg.record('key1', 60);  // bucket 0
            agg.record('key2', 200); // bucket 1

            const result = agg.getAggregatedHistogram('all');

            expect(result.buckets['0ms-100ms']).toBe(2);
            expect(result.buckets['100ms-500ms']).toBe(1);
            expect(result.keyCount).toBe(2);
        });

        test('should aggregate stats from all keys', () => {
            const agg = new GlobalHistogramAggregator();

            agg.record('key1', 100);
            agg.record('key1', 200);
            agg.record('key2', 300);
            agg.record('key2', 400);

            const result = agg.getAggregatedHistogram('all');

            expect(result.stats.count).toBe(4);
            expect(result.stats.min).toBe(100);
            expect(result.stats.max).toBe(400);
        });

        test('should include timeRange in result', () => {
            const agg = new GlobalHistogramAggregator();
            const result = agg.getAggregatedHistogram('15m');
            expect(result.timeRange).toBe('15m');
        });

        test('should include bucketLabels in result', () => {
            const agg = new GlobalHistogramAggregator({ buckets: [0, 100, 500] });
            const result = agg.getAggregatedHistogram();

            expect(result.bucketLabels).toEqual(['0ms-100ms', '100ms-500ms', '500ms+']);
        });

        test('should respect time range filtering', () => {
            const agg = new GlobalHistogramAggregator();

            // Add old data point manually
            const h = agg.getKeyHistogram('key1');
            h.dataPoints.push({ latencyMs: 100, timestamp: Date.now() - 60 * 60 * 1000 }); // 1 hour ago
            h.record(200); // Now

            const result5m = agg.getAggregatedHistogram('5m');
            const resultAll = agg.getAggregatedHistogram('all');

            expect(result5m.stats.count).toBe(1);
            expect(resultAll.stats.count).toBe(2);
        });
    });

    describe('getKeyHistogramData', () => {
        test('should return histogram for key by index', () => {
            const agg = new GlobalHistogramAggregator();

            agg.record('key1', 100);
            agg.record('key2', 200);

            const result = agg.getKeyHistogramData(0, 'all');

            expect(result).toBeDefined();
            expect(result.stats.count).toBe(1);
        });

        test('should return null for invalid index', () => {
            const agg = new GlobalHistogramAggregator();
            agg.record('key1', 100);

            const result = agg.getKeyHistogramData(5);

            expect(result).toBeNull();
        });

        test('should return null for negative index', () => {
            const agg = new GlobalHistogramAggregator();
            agg.record('key1', 100);

            const result = agg.getKeyHistogramData(-1);

            expect(result).toBeNull();
        });
    });

    describe('reset', () => {
        test('should clear all key histograms', () => {
            const agg = new GlobalHistogramAggregator();

            agg.record('key1', 100);
            agg.record('key2', 200);
            agg.reset();

            expect(agg.keyHistograms.size).toBe(0);
        });
    });

    describe('_formatMs', () => {
        test('should format milliseconds correctly', () => {
            const agg = new GlobalHistogramAggregator();

            expect(agg._formatMs(0)).toBe('0ms');
            expect(agg._formatMs(100)).toBe('100ms');
            expect(agg._formatMs(1000)).toBe('1s');
            expect(agg._formatMs(60000)).toBe('1m');
        });
    });

    describe('_getBucketLabel', () => {
        test('should generate correct labels', () => {
            const agg = new GlobalHistogramAggregator({ buckets: [0, 100, 1000, 60000] });

            expect(agg._getBucketLabel(0)).toBe('0ms-100ms');
            expect(agg._getBucketLabel(1)).toBe('100ms-1s');
            expect(agg._getBucketLabel(2)).toBe('1s-1m');
            expect(agg._getBucketLabel(3)).toBe('1m+');
        });
    });

    describe('edge cases', () => {
        test('should handle many keys', () => {
            const agg = new GlobalHistogramAggregator();

            for (let i = 0; i < 100; i++) {
                agg.record(`key${i}`, i * 10);
            }

            expect(agg.keyHistograms.size).toBe(100);

            const result = agg.getAggregatedHistogram('all');
            expect(result.stats.count).toBe(100);
            expect(result.keyCount).toBe(100);
        });

        test('should handle empty key names', () => {
            const agg = new GlobalHistogramAggregator();

            agg.record('', 100);

            expect(agg.keyHistograms.size).toBe(1);
            expect(agg.getKeyHistogram('').dataPoints.length).toBe(1);
        });

        test('should handle min/max with no data', () => {
            const agg = new GlobalHistogramAggregator();
            // Create empty histogram without recording anything
            agg.getKeyHistogram('key1');

            const result = agg.getAggregatedHistogram('all');

            expect(result.stats.min).toBe(0);
            expect(result.stats.max).toBe(0);
        });
    });
});
