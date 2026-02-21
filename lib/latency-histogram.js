/**
 * Latency Histogram Module
 * Aggregates latency data into time-bucketed histograms for analysis
 */

const { RingBuffer } = require('./ring-buffer');

const DEFAULT_BUCKETS = [0, 100, 500, 1000, 2000, 5000, 10000, 30000, 60000, 120000];

class LatencyHistogram {
    /**
     * Create a new latency histogram
     * @param {Object} options - Configuration options
     * @param {number[]} options.buckets - Bucket boundaries in ms (default: [0, 100, 500, 1000, 5000, 30000])
     * @param {number} options.maxDataPoints - Maximum data points to keep (default: 10000)
     */
    constructor(options = {}) {
        this.buckets = options.buckets || DEFAULT_BUCKETS;
        this.maxDataPoints = options.maxDataPoints || 10000;

        // Store raw latency measurements with timestamps - using RingBuffer directly
        this.dataPoints = new RingBuffer(this.maxDataPoints);

        // Pre-computed bucket counts for efficiency
        this._bucketCounts = new Map();
        this._initBuckets();
    }

    _initBuckets() {
        for (let i = 0; i < this.buckets.length; i++) {
            const label = this._getBucketLabel(i);
            this._bucketCounts.set(label, 0);
        }
    }

    /**
     * Get human-readable bucket label
     * @param {number} index - Bucket index
     * @returns {string} Bucket label
     */
    _getBucketLabel(index) {
        const lower = this.buckets[index];
        const upper = this.buckets[index + 1];

        if (upper === undefined) {
            return `${this._formatMs(lower)}+`;
        }
        return `${this._formatMs(lower)}-${this._formatMs(upper)}`;
    }

    /**
     * Format milliseconds for display
     * @param {number} ms - Milliseconds
     * @returns {string} Formatted string
     */
    _formatMs(ms) {
        if (ms >= 60000) return `${Math.round(ms / 60000)}m`;
        if (ms >= 1000) return `${Math.round(ms / 1000)}s`;
        return `${ms}ms`;
    }

    /**
     * Find which bucket a latency value belongs to
     * @param {number} latencyMs - Latency in milliseconds
     * @returns {number} Bucket index
     */
    _findBucket(latencyMs) {
        for (let i = 0; i < this.buckets.length; i++) {
            if (i === this.buckets.length - 1) {
                return i; // Last bucket catches all above
            }
            if (latencyMs >= this.buckets[i] && latencyMs < this.buckets[i + 1]) {
                return i;
            }
        }
        return 0;
    }

    /**
     * Record a latency measurement
     * @param {number} latencyMs - Latency in milliseconds
     */
    record(latencyMs) {
        if (typeof latencyMs !== 'number' || latencyMs < 0) return;

        const timestamp = Date.now();

        // Add to data points (RingBuffer handles auto-eviction)
        this.dataPoints.push({ latencyMs, timestamp });

        // Recalculate bucket counts from scratch (simpler and correct)
        this._rebuildBucketCounts();
    }

    _rebuildBucketCounts() {
        this._bucketCounts.clear();
        this._initBuckets();
        for (const point of this.dataPoints) {
            const bucketIndex = this._findBucket(point.latencyMs);
            const label = this._getBucketLabel(bucketIndex);
            this._bucketCounts.set(label, (this._bucketCounts.get(label) || 0) + 1);
        }
    }

    /**
     * Get histogram data for a time range
     * @param {string} timeRange - Time range: '5m', '15m', '1h', 'all'
     * @returns {Object} Histogram data
     */
    getHistogram(timeRange = '15m') {
        const now = Date.now();
        let cutoffMs;

        switch (timeRange) {
            case '5m':
                cutoffMs = now - 5 * 60 * 1000;
                break;
            case '15m':
                cutoffMs = now - 15 * 60 * 1000;
                break;
            case '1h':
                cutoffMs = now - 60 * 60 * 1000;
                break;
            case '24h':
                cutoffMs = now - 24 * 60 * 60 * 1000;
                break;
            case 'all':
            default:
                cutoffMs = 0;
        }

        // Filter data points by time range
        const filteredPoints = this.dataPoints.toArray().filter(p => p.timestamp >= cutoffMs);

        // Recompute histogram for filtered points
        const histogram = {};
        for (let i = 0; i < this.buckets.length; i++) {
            histogram[this._getBucketLabel(i)] = 0;
        }

        let total = 0;
        let sum = 0;
        let min = Infinity;
        let max = -Infinity;
        const latencies = [];

        for (const point of filteredPoints) {
            const bucketIndex = this._findBucket(point.latencyMs);
            const label = this._getBucketLabel(bucketIndex);
            histogram[label]++;

            total++;
            sum += point.latencyMs;
            min = Math.min(min, point.latencyMs);
            max = Math.max(max, point.latencyMs);
            latencies.push(point.latencyMs);
        }

        // Calculate percentiles
        latencies.sort((a, b) => a - b);
        const p50 = this._percentile(latencies, 50);
        const p95 = this._percentile(latencies, 95);
        const p99 = this._percentile(latencies, 99);

        return {
            timeRange,
            buckets: histogram,
            stats: {
                count: total,
                avg: total > 0 ? Math.round(sum / total) : 0,
                min: min === Infinity ? 0 : Math.round(min),
                max: max === -Infinity ? 0 : Math.round(max),
                p50: p50 ? Math.round(p50) : 0,
                p95: p95 ? Math.round(p95) : 0,
                p99: p99 ? Math.round(p99) : 0
            },
            bucketLabels: Object.keys(histogram)
        };
    }

    /**
     * Calculate percentile value
     * @param {number[]} sortedArr - Sorted array of values
     * @param {number} percentile - Percentile (0-100)
     * @returns {number|null} Percentile value
     */
    _percentile(sortedArr, percentile) {
        if (sortedArr.length === 0) return null;
        const index = Math.ceil((percentile / 100) * sortedArr.length) - 1;
        return sortedArr[Math.max(0, index)];
    }

    /**
     * Get histogram formatted for chart display
     * @param {string} timeRange - Time range
     * @returns {Object} Chart-ready data
     */
    getChartData(timeRange = '15m') {
        const histogram = this.getHistogram(timeRange);

        return {
            labels: histogram.bucketLabels,
            values: Object.values(histogram.buckets),
            stats: histogram.stats,
            timeRange
        };
    }

    /**
     * Get summary statistics
     * @returns {Object} Summary stats
     */
    getSummary() {
        return {
            totalPoints: this.dataPoints.size,
            timeRanges: {
                '5m': this.getHistogram('5m').stats,
                '15m': this.getHistogram('15m').stats,
                '1h': this.getHistogram('1h').stats
            }
        };
    }

    /**
     * Clear all data
     */
    reset() {
        this.dataPoints.clear();
        this._initBuckets();
    }
}

/**
 * Global histogram aggregator for combining histograms from multiple keys
 */
class GlobalHistogramAggregator {
    constructor(options = {}) {
        this.buckets = options.buckets || DEFAULT_BUCKETS;
        this.keyHistograms = new Map();
    }

    /**
     * Get or create histogram for a key
     * @param {string} keyId - Key identifier
     * @returns {LatencyHistogram} Histogram instance
     */
    getKeyHistogram(keyId) {
        if (!this.keyHistograms.has(keyId)) {
            this.keyHistograms.set(keyId, new LatencyHistogram({ buckets: this.buckets }));
        }
        return this.keyHistograms.get(keyId);
    }

    /**
     * Record latency for a specific key
     * @param {string} keyId - Key identifier
     * @param {number} latencyMs - Latency in milliseconds
     */
    record(keyId, latencyMs) {
        this.getKeyHistogram(keyId).record(latencyMs);
    }

    /**
     * Get aggregated histogram across all keys
     * @param {string} timeRange - Time range
     * @returns {Object} Aggregated histogram
     */
    getAggregatedHistogram(timeRange = '15m') {
        const aggregated = {
            buckets: {},
            stats: { count: 0, sum: 0, min: Infinity, max: -Infinity },
            allLatencies: []
        };

        // Initialize buckets
        for (let i = 0; i < this.buckets.length; i++) {
            const label = this._getBucketLabel(i);
            aggregated.buckets[label] = 0;
        }

        // Aggregate from all keys
        for (const [keyId, histogram] of this.keyHistograms) {
            const keyHist = histogram.getHistogram(timeRange);

            // Sum bucket counts
            for (const [label, count] of Object.entries(keyHist.buckets)) {
                aggregated.buckets[label] = (aggregated.buckets[label] || 0) + count;
            }

            // Aggregate stats
            aggregated.stats.count += keyHist.stats.count;
            aggregated.stats.min = Math.min(aggregated.stats.min, keyHist.stats.min || Infinity);
            aggregated.stats.max = Math.max(aggregated.stats.max, keyHist.stats.max || -Infinity);
        }

        aggregated.stats.min = aggregated.stats.min === Infinity ? 0 : aggregated.stats.min;
        aggregated.stats.max = aggregated.stats.max === -Infinity ? 0 : aggregated.stats.max;

        return {
            timeRange,
            buckets: aggregated.buckets,
            stats: aggregated.stats,
            bucketLabels: Object.keys(aggregated.buckets),
            keyCount: this.keyHistograms.size
        };
    }

    _getBucketLabel(index) {
        const lower = this.buckets[index];
        const upper = this.buckets[index + 1];

        if (upper === undefined) {
            return `${this._formatMs(lower)}+`;
        }
        return `${this._formatMs(lower)}-${this._formatMs(upper)}`;
    }

    _formatMs(ms) {
        if (ms >= 60000) return `${Math.round(ms / 60000)}m`;
        if (ms >= 1000) return `${Math.round(ms / 1000)}s`;
        return `${ms}ms`;
    }

    /**
     * Get histogram for a specific key
     * @param {number} keyIndex - Key index
     * @param {string} timeRange - Time range
     * @returns {Object|null} Histogram data or null
     */
    getKeyHistogramData(keyIndex, timeRange = '15m') {
        const keyId = Array.from(this.keyHistograms.keys())[keyIndex];
        if (!keyId) return null;
        return this.keyHistograms.get(keyId).getHistogram(timeRange);
    }

    /**
     * Reset all histograms
     */
    reset() {
        this.keyHistograms.clear();
    }
}

module.exports = {
    LatencyHistogram,
    GlobalHistogramAggregator,
    DEFAULT_BUCKETS
};
