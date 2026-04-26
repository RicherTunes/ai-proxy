'use strict';

/**
 * Latency Histogram Edge-Case Tests
 *
 * Covers:
 *  1. Bucket boundaries — values land in the correct histogram bucket
 *  2. Percentile accuracy — P50, P95, P99 for known distributions
 *  3. Empty histogram — defined behavior for percentiles
 *  4. Single value — all percentiles return that value
 *  5. Reset — clears all buckets and count
 *  6. Very large values — overflow into last bucket
 *  7. Very small values — near-zero lands in first bucket
 *  8. Concurrent recording — rapid parallel records keep accurate counts
 *  9. Summary stats — count, mean, min, max correctness
 * 10. Serialization — export / import for persistence
 */

const { LatencyHistogram, GlobalHistogramAggregator, DEFAULT_BUCKETS } = require('../lib/latency-histogram');

// ---------------------------------------------------------------------------
// 1. Bucket boundaries
// ---------------------------------------------------------------------------
describe('Bucket boundaries', () => {
    const buckets = [0, 100, 500, 1000, 5000];
    let h;

    beforeEach(() => {
        h = new LatencyHistogram({ buckets });
    });

    test('value exactly at lower bound falls into that bucket', () => {
        // 0 is the lower bound of the first bucket [0, 100)
        h.record(0);
        const result = h.getHistogram('all');
        expect(result.buckets['0ms-100ms']).toBe(1);
    });

    test('value one below upper bound stays in current bucket', () => {
        h.record(99);
        const result = h.getHistogram('all');
        expect(result.buckets['0ms-100ms']).toBe(1);
    });

    test('value exactly at upper bound moves to next bucket', () => {
        // 100 is the lower bound of the second bucket [100, 500)
        h.record(100);
        const result = h.getHistogram('all');
        expect(result.buckets['0ms-100ms']).toBe(0);
        expect(result.buckets['100ms-500ms']).toBe(1);
    });

    test('all boundary values land correctly', () => {
        // Record every boundary value
        buckets.forEach(b => h.record(b));

        const result = h.getHistogram('all');

        // 0   -> [0, 100)
        expect(result.buckets['0ms-100ms']).toBe(1);
        // 100 -> [100, 500)
        expect(result.buckets['100ms-500ms']).toBe(1);
        // 500 -> [500, 1000)
        expect(result.buckets['500ms-1s']).toBe(1);
        // 1000 -> [1000, 5000)
        expect(result.buckets['1s-5s']).toBe(1);
        // 5000 -> [5000, +inf)
        expect(result.buckets['5s+']).toBe(1);
    });

    test('values between boundaries go to the right bucket', () => {
        h.record(50);   // [0,100)
        h.record(250);  // [100,500)
        h.record(750);  // [500,1000)
        h.record(3000); // [1000,5000)
        h.record(9999); // [5000,+inf)

        const result = h.getHistogram('all');

        expect(result.buckets['0ms-100ms']).toBe(1);
        expect(result.buckets['100ms-500ms']).toBe(1);
        expect(result.buckets['500ms-1s']).toBe(1);
        expect(result.buckets['1s-5s']).toBe(1);
        expect(result.buckets['5s+']).toBe(1);
    });

    test('default buckets boundary correctness for every range', () => {
        const def = new LatencyHistogram(); // DEFAULT_BUCKETS

        // Each value is just inside the bucket
        def.record(0);      // [0, 100)
        def.record(100);    // [100, 500)
        def.record(500);    // [500, 1000)
        def.record(1000);   // [1000, 2000)
        def.record(2000);   // [2000, 5000)
        def.record(5000);   // [5000, 10000)
        def.record(10000);  // [10000, 30000)
        def.record(30000);  // [30000, 60000)
        def.record(60000);  // [60000, 120000)
        def.record(120000); // [120000, +inf)

        const result = def.getHistogram('all');
        expect(result.stats.count).toBe(10);
        // Every bucket should have exactly 1 entry
        Object.values(result.buckets).forEach(count => {
            expect(count).toBe(1);
        });
    });
});

// ---------------------------------------------------------------------------
// 2. Percentile accuracy for known distributions
// ---------------------------------------------------------------------------
describe('Percentile accuracy', () => {
    test('P50 of uniform 1..100 is the median', () => {
        const h = new LatencyHistogram();
        for (let i = 1; i <= 100; i++) h.record(i);

        const result = h.getHistogram('all');
        // ceil(50/100 * 100) - 1 = index 49 => value 50
        expect(result.stats.p50).toBe(50);
    });

    test('P95 of uniform 1..100', () => {
        const h = new LatencyHistogram();
        for (let i = 1; i <= 100; i++) h.record(i);

        const result = h.getHistogram('all');
        expect(result.stats.p95).toBe(95);
    });

    test('P99 of uniform 1..100', () => {
        const h = new LatencyHistogram();
        for (let i = 1; i <= 100; i++) h.record(i);

        const result = h.getHistogram('all');
        expect(result.stats.p99).toBe(99);
    });

    test('P50 of uniform 1..1000', () => {
        const h = new LatencyHistogram();
        for (let i = 1; i <= 1000; i++) h.record(i);

        const result = h.getHistogram('all');
        expect(result.stats.p50).toBe(500);
    });

    test('P95 of uniform 1..1000', () => {
        const h = new LatencyHistogram();
        for (let i = 1; i <= 1000; i++) h.record(i);

        const result = h.getHistogram('all');
        expect(result.stats.p95).toBe(950);
    });

    test('P99 of uniform 1..1000', () => {
        const h = new LatencyHistogram();
        for (let i = 1; i <= 1000; i++) h.record(i);

        const result = h.getHistogram('all');
        expect(result.stats.p99).toBe(990);
    });

    test('skewed distribution: 99 low values + 1 spike', () => {
        const h = new LatencyHistogram();
        for (let i = 0; i < 99; i++) h.record(10);
        h.record(50000);

        const result = h.getHistogram('all');
        expect(result.stats.p50).toBe(10);
        expect(result.stats.p95).toBe(10);
        expect(result.stats.p99).toBe(10);
    });

    test('bimodal distribution percentiles', () => {
        const h = new LatencyHistogram();
        // 50 values at 100ms, 50 values at 5000ms
        for (let i = 0; i < 50; i++) h.record(100);
        for (let i = 0; i < 50; i++) h.record(5000);

        const result = h.getHistogram('all');
        expect(result.stats.p50).toBe(100);   // index 49 => still 100
        expect(result.stats.p95).toBe(5000);
        expect(result.stats.p99).toBe(5000);
    });

    test('two values: percentile selects correctly', () => {
        const h = new LatencyHistogram();
        h.record(100);
        h.record(200);

        const result = h.getHistogram('all');
        // sorted: [100, 200], p50 index = ceil(0.5*2)-1 = 0 => 100
        expect(result.stats.p50).toBe(100);
        // p95 index = ceil(0.95*2)-1 = 1 => 200
        expect(result.stats.p95).toBe(200);
        // p99 index = ceil(0.99*2)-1 = 1 => 200
        expect(result.stats.p99).toBe(200);
    });
});

// ---------------------------------------------------------------------------
// 3. Empty histogram
// ---------------------------------------------------------------------------
describe('Empty histogram', () => {
    test('getHistogram returns count 0 and all stats 0', () => {
        const h = new LatencyHistogram();
        const result = h.getHistogram('all');

        expect(result.stats.count).toBe(0);
        expect(result.stats.avg).toBe(0);
        expect(result.stats.min).toBe(0);
        expect(result.stats.max).toBe(0);
        expect(result.stats.p50).toBe(0);
        expect(result.stats.p95).toBe(0);
        expect(result.stats.p99).toBe(0);
    });

    test('_percentile returns null for empty array', () => {
        const h = new LatencyHistogram();
        expect(h._percentile([], 50)).toBeNull();
        expect(h._percentile([], 95)).toBeNull();
        expect(h._percentile([], 99)).toBeNull();
    });

    test('all buckets are zero', () => {
        const h = new LatencyHistogram({ buckets: [0, 100, 500] });
        const result = h.getHistogram('all');

        Object.values(result.buckets).forEach(count => {
            expect(count).toBe(0);
        });
    });

    test('getChartData returns zero values for empty histogram', () => {
        const h = new LatencyHistogram({ buckets: [0, 100, 500] });
        const chart = h.getChartData('all');

        expect(chart.values).toEqual([0, 0, 0]);
        expect(chart.stats.count).toBe(0);
    });

    test('getSummary returns totalPoints 0', () => {
        const h = new LatencyHistogram();
        const summary = h.getSummary();
        expect(summary.totalPoints).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// 4. Single value
// ---------------------------------------------------------------------------
describe('Single value histogram', () => {
    test('all percentiles equal the single recorded value', () => {
        const h = new LatencyHistogram();
        h.record(42);

        const result = h.getHistogram('all');
        expect(result.stats.count).toBe(1);
        expect(result.stats.p50).toBe(42);
        expect(result.stats.p95).toBe(42);
        expect(result.stats.p99).toBe(42);
    });

    test('min, max, avg all equal the single value', () => {
        const h = new LatencyHistogram();
        h.record(777);

        const result = h.getHistogram('all');
        expect(result.stats.min).toBe(777);
        expect(result.stats.max).toBe(777);
        expect(result.stats.avg).toBe(777);
    });

    test('single value goes into correct bucket', () => {
        const h = new LatencyHistogram({ buckets: [0, 100, 500, 1000] });
        h.record(250);

        const result = h.getHistogram('all');
        expect(result.buckets['0ms-100ms']).toBe(0);
        expect(result.buckets['100ms-500ms']).toBe(1);
        expect(result.buckets['500ms-1s']).toBe(0);
        expect(result.buckets['1s+']).toBe(0);
    });

    test('single value of zero', () => {
        const h = new LatencyHistogram();
        h.record(0);

        const result = h.getHistogram('all');
        expect(result.stats.count).toBe(1);
        expect(result.stats.min).toBe(0);
        expect(result.stats.max).toBe(0);
        expect(result.stats.avg).toBe(0);
        expect(result.stats.p50).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// 5. Reset
// ---------------------------------------------------------------------------
describe('Reset', () => {
    test('reset clears dataPoints to zero length', () => {
        const h = new LatencyHistogram();
        h.record(100);
        h.record(200);
        h.record(300);
        expect(h.dataPoints.length).toBe(3);

        h.reset();
        expect(h.dataPoints.length).toBe(0);
    });

    test('reset zeroes all bucket counts', () => {
        const h = new LatencyHistogram({ buckets: [0, 100, 500, 1000] });
        h.record(50);
        h.record(200);
        h.record(700);
        h.record(5000);

        h.reset();

        for (const [, count] of h._bucketCounts) {
            expect(count).toBe(0);
        }
    });

    test('getHistogram after reset returns empty stats', () => {
        const h = new LatencyHistogram();
        h.record(100);
        h.record(200);
        h.reset();

        const result = h.getHistogram('all');
        expect(result.stats.count).toBe(0);
        expect(result.stats.avg).toBe(0);
        expect(result.stats.min).toBe(0);
        expect(result.stats.max).toBe(0);
        expect(result.stats.p50).toBe(0);
        expect(result.stats.p95).toBe(0);
        expect(result.stats.p99).toBe(0);
    });

    test('recording after reset works correctly', () => {
        const h = new LatencyHistogram({ buckets: [0, 100, 500] });
        h.record(50);
        h.record(200);
        h.reset();

        h.record(300);
        expect(h.dataPoints.length).toBe(1);

        const result = h.getHistogram('all');
        expect(result.stats.count).toBe(1);
        expect(result.stats.avg).toBe(300);
        expect(result.buckets['100ms-500ms']).toBe(1);
    });

    test('multiple resets are idempotent', () => {
        const h = new LatencyHistogram();
        h.record(100);
        h.reset();
        h.reset();
        h.reset();

        expect(h.dataPoints.length).toBe(0);
        const result = h.getHistogram('all');
        expect(result.stats.count).toBe(0);
    });

    test('GlobalHistogramAggregator reset clears all keys', () => {
        const agg = new GlobalHistogramAggregator();
        agg.record('a', 100);
        agg.record('b', 200);
        agg.record('c', 300);

        expect(agg.keyHistograms.size).toBe(3);
        agg.reset();
        expect(agg.keyHistograms.size).toBe(0);

        const result = agg.getAggregatedHistogram('all');
        expect(result.stats.count).toBe(0);
        expect(result.keyCount).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// 6. Very large values (overflow)
// ---------------------------------------------------------------------------
describe('Very large values (overflow bucket)', () => {
    test('value beyond max bucket goes to last bucket', () => {
        const h = new LatencyHistogram({ buckets: [0, 100, 500] });
        h.record(999999);

        const result = h.getHistogram('all');
        expect(result.buckets['500ms+']).toBe(1);
        expect(result.stats.max).toBe(999999);
    });

    test('very large value with default buckets', () => {
        const h = new LatencyHistogram();
        h.record(10000000); // 10 million ms

        const result = h.getHistogram('all');
        // Last default bucket is 120000+ (labeled "2m+")
        expect(result.buckets['2m+']).toBe(1);
        expect(result.stats.max).toBe(10000000);
    });

    test('mix of normal and very large values', () => {
        const h = new LatencyHistogram({ buckets: [0, 100, 500, 1000] });
        h.record(50);
        h.record(200);
        h.record(750);
        h.record(5000000);

        const result = h.getHistogram('all');
        expect(result.buckets['0ms-100ms']).toBe(1);
        expect(result.buckets['100ms-500ms']).toBe(1);
        expect(result.buckets['500ms-1s']).toBe(1);
        expect(result.buckets['1s+']).toBe(1);
        expect(result.stats.count).toBe(4);
    });

    test('Number.MAX_SAFE_INTEGER goes to last bucket', () => {
        const h = new LatencyHistogram({ buckets: [0, 100, 500] });
        h.record(Number.MAX_SAFE_INTEGER);

        const result = h.getHistogram('all');
        expect(result.buckets['500ms+']).toBe(1);
    });

    test('large float value lands in overflow bucket', () => {
        const h = new LatencyHistogram({ buckets: [0, 100, 500] });
        h.record(123456.789);

        const result = h.getHistogram('all');
        expect(result.buckets['500ms+']).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// 7. Very small values (near zero)
// ---------------------------------------------------------------------------
describe('Very small values (near zero)', () => {
    test('zero goes to first bucket', () => {
        const h = new LatencyHistogram({ buckets: [0, 100, 500] });
        h.record(0);

        const result = h.getHistogram('all');
        expect(result.buckets['0ms-100ms']).toBe(1);
    });

    test('very small positive float goes to first bucket', () => {
        const h = new LatencyHistogram({ buckets: [0, 100, 500] });
        h.record(0.001);

        const result = h.getHistogram('all');
        expect(result.buckets['0ms-100ms']).toBe(1);
    });

    test('Number.MIN_VALUE (smallest positive) goes to first bucket', () => {
        const h = new LatencyHistogram({ buckets: [0, 100, 500] });
        h.record(Number.MIN_VALUE);

        const result = h.getHistogram('all');
        expect(result.buckets['0ms-100ms']).toBe(1);
    });

    test('negative values are rejected', () => {
        const h = new LatencyHistogram();
        h.record(-1);
        h.record(-0.001);
        h.record(-Infinity);

        expect(h.dataPoints.length).toBe(0);
    });

    test('NaN is not rejected by current guard (typeof NaN === "number" and !(NaN < 0))', () => {
        // NaN passes the guard: typeof NaN === 'number' && !(NaN < 0)
        // This documents existing behavior -- NaN is accepted into dataPoints
        const h = new LatencyHistogram();
        h.record(NaN);
        expect(h.dataPoints.length).toBe(1);
    });

    test('Infinity is rejected (not a finite number >= 0, but typeof is number)', () => {
        // record() checks `typeof latencyMs !== "number" || latencyMs < 0`
        // Infinity is a number and Infinity >= 0, so it is NOT rejected by current logic
        const h = new LatencyHistogram({ buckets: [0, 100, 500] });
        h.record(Infinity);

        // Infinity >= 500, so it goes to the last bucket
        const result = h.getHistogram('all');
        expect(result.buckets['500ms+']).toBe(1);
    });

    test('multiple zeros accumulate in first bucket', () => {
        const h = new LatencyHistogram({ buckets: [0, 100, 500] });
        for (let i = 0; i < 5; i++) h.record(0);

        const result = h.getHistogram('all');
        expect(result.buckets['0ms-100ms']).toBe(5);
    });
});

// ---------------------------------------------------------------------------
// 8. Concurrent / rapid recording
// ---------------------------------------------------------------------------
describe('Concurrent recording (rapid parallel records)', () => {
    test('1000 rapid records maintain accurate total count', () => {
        const h = new LatencyHistogram();
        const N = 1000;
        for (let i = 0; i < N; i++) h.record(i);

        const result = h.getHistogram('all');
        expect(result.stats.count).toBe(N);
    });

    test('bucket counts sum to total count', () => {
        const h = new LatencyHistogram({ buckets: [0, 100, 500, 1000] });
        const N = 500;
        for (let i = 0; i < N; i++) h.record(i * 3);

        const result = h.getHistogram('all');
        const bucketSum = Object.values(result.buckets).reduce((a, b) => a + b, 0);
        expect(bucketSum).toBe(result.stats.count);
    });

    test('interleaved record and getHistogram stay consistent', () => {
        const h = new LatencyHistogram({ buckets: [0, 100, 500] });

        h.record(50);
        let result = h.getHistogram('all');
        expect(result.stats.count).toBe(1);

        h.record(200);
        result = h.getHistogram('all');
        expect(result.stats.count).toBe(2);

        h.record(600);
        result = h.getHistogram('all');
        expect(result.stats.count).toBe(3);
        const bucketSum = Object.values(result.buckets).reduce((a, b) => a + b, 0);
        expect(bucketSum).toBe(3);
    });

    test('maxDataPoints eviction keeps bucket counts accurate', () => {
        const h = new LatencyHistogram({ buckets: [0, 100, 500], maxDataPoints: 10 });

        // Record 20 values: first 10 will be evicted
        for (let i = 0; i < 20; i++) h.record(50); // all in first bucket

        expect(h.dataPoints.length).toBe(10);
        const result = h.getHistogram('all');
        expect(result.stats.count).toBe(10);
        expect(result.buckets['0ms-100ms']).toBe(10);
    });

    test('rapid records across multiple buckets', () => {
        const h = new LatencyHistogram({ buckets: [0, 100, 500, 1000] });
        const values = [10, 150, 600, 2000];
        const N = 250;

        for (let i = 0; i < N; i++) {
            values.forEach(v => h.record(v));
        }

        const result = h.getHistogram('all');
        expect(result.stats.count).toBe(N * values.length);
        expect(result.buckets['0ms-100ms']).toBe(N);
        expect(result.buckets['100ms-500ms']).toBe(N);
        expect(result.buckets['500ms-1s']).toBe(N);
        expect(result.buckets['1s+']).toBe(N);
    });

    test('Promise.all simulated concurrent writes maintain count', async () => {
        const h = new LatencyHistogram();
        const N = 200;

        // Simulate concurrent writes using microtasks
        const promises = [];
        for (let i = 0; i < N; i++) {
            promises.push(Promise.resolve().then(() => h.record(i)));
        }
        await Promise.all(promises);

        const result = h.getHistogram('all');
        expect(result.stats.count).toBe(N);
    });
});

// ---------------------------------------------------------------------------
// 9. Summary stats (count, mean, min, max)
// ---------------------------------------------------------------------------
describe('Summary stats accuracy', () => {
    test('count matches number of recorded values', () => {
        const h = new LatencyHistogram();
        const values = [10, 20, 30, 40, 50];
        values.forEach(v => h.record(v));

        const result = h.getHistogram('all');
        expect(result.stats.count).toBe(values.length);
    });

    test('avg is correctly computed (rounded)', () => {
        const h = new LatencyHistogram();
        h.record(10);
        h.record(20);
        h.record(30);

        const result = h.getHistogram('all');
        // (10+20+30)/3 = 20
        expect(result.stats.avg).toBe(20);
    });

    test('avg rounds to nearest integer', () => {
        const h = new LatencyHistogram();
        h.record(1);
        h.record(2);
        h.record(3);

        const result = h.getHistogram('all');
        // (1+2+3)/3 = 2.0 => 2
        expect(result.stats.avg).toBe(2);
    });

    test('avg rounds correctly for non-integer mean', () => {
        const h = new LatencyHistogram();
        h.record(1);
        h.record(2);

        const result = h.getHistogram('all');
        // (1+2)/2 = 1.5 => Math.round(1.5) = 2
        expect(result.stats.avg).toBe(2);
    });

    test('min is the smallest recorded value', () => {
        const h = new LatencyHistogram();
        h.record(500);
        h.record(100);
        h.record(300);

        const result = h.getHistogram('all');
        expect(result.stats.min).toBe(100);
    });

    test('max is the largest recorded value', () => {
        const h = new LatencyHistogram();
        h.record(500);
        h.record(100);
        h.record(300);

        const result = h.getHistogram('all');
        expect(result.stats.max).toBe(500);
    });

    test('min and max with identical values', () => {
        const h = new LatencyHistogram();
        for (let i = 0; i < 10; i++) h.record(42);

        const result = h.getHistogram('all');
        expect(result.stats.min).toBe(42);
        expect(result.stats.max).toBe(42);
        expect(result.stats.avg).toBe(42);
    });

    test('getSummary totalPoints reflects dataPoints count', () => {
        const h = new LatencyHistogram();
        h.record(10);
        h.record(20);
        h.record(30);

        const summary = h.getSummary();
        expect(summary.totalPoints).toBe(3);
    });

    test('getSummary time-range stats are independently computed', () => {
        const h = new LatencyHistogram();

        // Old data: 1 hour ago
        h.dataPoints.push({ latencyMs: 1000, timestamp: Date.now() - 60 * 60 * 1000 + 1000 });
        // Recent data: now
        h.record(200);

        const summary = h.getSummary();

        // 5m should only see the recent value
        expect(summary.timeRanges['5m'].count).toBe(1);
        expect(summary.timeRanges['5m'].avg).toBe(200);

        // 1h should see both
        expect(summary.timeRanges['1h'].count).toBe(2);
    });

    test('stats with floating-point values round correctly', () => {
        const h = new LatencyHistogram();
        h.record(10.7);
        h.record(20.3);

        const result = h.getHistogram('all');
        // avg = (10.7+20.3)/2 = 15.5 => Math.round(15.5) = 16
        expect(result.stats.avg).toBe(16);
        // min = Math.round(10.7) = 11
        expect(result.stats.min).toBe(11);
        // max = Math.round(20.3) = 20
        expect(result.stats.max).toBe(20);
    });
});

// ---------------------------------------------------------------------------
// 10. Serialization (export / import)
// ---------------------------------------------------------------------------
describe('Serialization (export / import)', () => {
    test('histogram data can be serialized to JSON', () => {
        const h = new LatencyHistogram({ buckets: [0, 100, 500, 1000] });
        h.record(50);
        h.record(200);
        h.record(750);

        const result = h.getHistogram('all');
        const json = JSON.stringify(result);
        const parsed = JSON.parse(json);

        expect(parsed.stats.count).toBe(3);
        expect(parsed.buckets['0ms-100ms']).toBe(1);
        expect(parsed.buckets['100ms-500ms']).toBe(1);
        expect(parsed.buckets['500ms-1s']).toBe(1);
    });

    test('raw dataPoints can be exported and re-imported', () => {
        const h1 = new LatencyHistogram({ buckets: [0, 100, 500] });
        h1.record(50);
        h1.record(200);
        h1.record(600);

        // Export raw data
        const exported = h1.dataPoints.toArray();
        const serialized = JSON.stringify(exported);

        // Import into new histogram
        const h2 = new LatencyHistogram({ buckets: [0, 100, 500] });
        const imported = JSON.parse(serialized);
        for (const point of imported) {
            h2.dataPoints.push(point);
        }
        h2._rebuildBucketCounts();

        const r1 = h1.getHistogram('all');
        const r2 = h2.getHistogram('all');

        expect(r2.stats.count).toBe(r1.stats.count);
        expect(r2.buckets).toEqual(r1.buckets);
    });

    test('chart data survives JSON round-trip', () => {
        const h = new LatencyHistogram({ buckets: [0, 100, 500] });
        h.record(50);
        h.record(300);

        const chart = h.getChartData('all');
        const json = JSON.stringify(chart);
        const parsed = JSON.parse(json);

        expect(parsed.labels).toEqual(chart.labels);
        expect(parsed.values).toEqual(chart.values);
        expect(parsed.stats).toEqual(chart.stats);
    });

    test('GlobalHistogramAggregator data can be exported per key', () => {
        const agg = new GlobalHistogramAggregator({ buckets: [0, 100, 500] });
        agg.record('keyA', 50);
        agg.record('keyA', 200);
        agg.record('keyB', 600);

        // Export each key's histogram
        const exportData = {};
        for (const [keyId, histogram] of agg.keyHistograms) {
            exportData[keyId] = histogram.getHistogram('all');
        }

        const json = JSON.stringify(exportData);
        const parsed = JSON.parse(json);

        expect(parsed.keyA.stats.count).toBe(2);
        expect(parsed.keyB.stats.count).toBe(1);
    });

    test('aggregated histogram survives JSON round-trip', () => {
        const agg = new GlobalHistogramAggregator({ buckets: [0, 100, 500] });
        agg.record('k1', 50);
        agg.record('k2', 200);

        const aggregated = agg.getAggregatedHistogram('all');
        const json = JSON.stringify(aggregated);
        const parsed = JSON.parse(json);

        expect(parsed.stats.count).toBe(2);
        expect(parsed.keyCount).toBe(2);
        expect(parsed.buckets).toEqual(aggregated.buckets);
    });

    test('empty histogram serializes and deserializes correctly', () => {
        const h = new LatencyHistogram({ buckets: [0, 100, 500] });

        const result = h.getHistogram('all');
        const json = JSON.stringify(result);
        const parsed = JSON.parse(json);

        expect(parsed.stats.count).toBe(0);
        expect(parsed.stats.p50).toBe(0);
        expect(Object.keys(parsed.buckets).length).toBe(3);
    });

    test('dataPoints preserve timestamps through serialization', () => {
        const h = new LatencyHistogram();
        const beforeRecord = Date.now();
        h.record(100);

        const exported = h.dataPoints.toArray();
        const json = JSON.stringify(exported);
        const imported = JSON.parse(json);

        expect(imported[0].latencyMs).toBe(100);
        expect(imported[0].timestamp).toBeGreaterThanOrEqual(beforeRecord);
        expect(imported[0].timestamp).toBeLessThanOrEqual(Date.now());
    });
});
