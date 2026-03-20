/**
 * History Tracker Edge Case Tests
 *
 * Covers:
 * 1. Data point collection - record metrics, assert they appear in history
 * 2. Time-series tiers - fine/medium/coarse granularity buckets
 * 3. Max points cap - ring buffer overflow per tier
 * 4. Persistence - save/reload round-trip preserves data
 * 5. Query by time range - getHistory for 5min, 1hr, 24hr
 * 6. Empty history - fresh instance returns valid empty structure
 * 7. Concurrent recording - rapid data points don't corrupt structure
 * 8. Timer lifecycle - start/stop manage collection and save intervals
 * 9. Graceful degradation - missing/corrupt history file on load
 * 10. Data compaction - old fine-grained data compacted into medium/coarse
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { HistoryTracker } = require('../lib/history-tracker');

/**
 * Helper: create a tracker with test-friendly defaults
 */
function createTracker(overrides = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ht-edge-'));
    const historyFile = path.join(dir, 'history.json');
    const mockLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    };
    const tracker = new HistoryTracker({
        interval: 100,
        maxPoints: 10,
        historyFile,
        saveInterval: 500,
        logger: mockLogger,
        ...overrides
    });
    return { tracker, historyFile, mockLogger, dir };
}

/**
 * Helper: generate a stats source with incrementing request counter
 */
function incrementingStatsSource(startRequests = 0, step = 10) {
    let total = startRequests;
    return jest.fn(() => {
        total += step;
        return {
            totalRequests: total,
            clientRequests: { total, failed: 0 },
            successRate: 100,
            latency: { avg: 200, p95: 400, p99: 600 },
            activeConnections: 2,
            queue: { current: 0 },
            errors: { timeouts: 0, socketHangups: 0, serverErrors: 0, rateLimited: 0, other: 0 },
            keys: [{ state: 'CLOSED' }]
        };
    });
}

// ============================================================
// 1. Data point collection
// ============================================================
describe('Edge Case: Data point collection', () => {
    let env;

    beforeEach(() => {
        jest.useFakeTimers();
        env = createTracker();
    });

    afterEach(() => {
        env.tracker.stop();
        jest.useRealTimers();
        fs.rmSync(env.dir, { recursive: true, force: true });
    });

    test('recorded metric appears in fine tier with correct fields', () => {
        env.tracker.statsSource = () => ({
            totalRequests: 42,
            clientRequests: { total: 42, failed: 3 },
            successRate: 92.86,
            latency: { avg: 310, p95: 800, p99: 1200 },
            activeConnections: 7,
            queue: { current: 4 },
            errors: { timeouts: 1, socketHangups: 0, serverErrors: 1, rateLimited: 1, other: 0 },
            keys: [{ state: 'CLOSED' }, { state: 'OPEN' }]
        });

        env.tracker._collectDataPoint();

        const pt = env.tracker.tiers.fine.data.get(0);
        expect(pt).toBeDefined();
        expect(pt.timestamp).toBeGreaterThan(0);
        expect(pt.totalRequests).toBe(42);
        expect(pt.successRate).toBe(92.86);
        expect(pt.avgLatency).toBe(310);
        expect(pt.p95Latency).toBe(800);
        expect(pt.p99Latency).toBe(1200);
        expect(pt.activeConnections).toBe(7);
        expect(pt.queueSize).toBe(4);
        expect(pt.errors.timeouts).toBe(1);
        expect(pt.errors.serverErrors).toBe(1);
        expect(pt.errors.rateLimited).toBe(1);
        expect(pt.circuitStates).toEqual({ closed: 1, open: 1, halfOpen: 0 });
    });

    test('multiple points accumulate in history', () => {
        const source = incrementingStatsSource();
        env.tracker.statsSource = source;

        for (let i = 0; i < 5; i++) {
            env.tracker._collectDataPoint();
        }

        expect(env.tracker.tiers.fine.data.length).toBe(5);
        // Verify ordering: timestamps should be non-decreasing
        const arr = env.tracker.tiers.fine.data.toArray();
        for (let i = 1; i < arr.length; i++) {
            expect(arr[i].timestamp).toBeGreaterThanOrEqual(arr[i - 1].timestamp);
        }
    });

    test('error rate is computed from clientRequests deltas', () => {
        // First call: establishes baseline
        env.tracker.statsSource = () => ({
            totalRequests: 100,
            clientRequests: { total: 100, failed: 10 },
            keys: []
        });
        env.tracker._collectDataPoint();

        // Second call: 50 new total, 5 new failed => 10% error rate
        env.tracker.statsSource = () => ({
            totalRequests: 200,
            clientRequests: { total: 150, failed: 15 },
            keys: []
        });
        env.tracker._collectDataPoint();

        const pt = env.tracker.tiers.fine.data.get(1);
        expect(pt.errorRate).toBe(10); // (5 / 50) * 100
    });

    test('negative request delta clamped to zero', () => {
        // Simulate a counter reset mid-stream
        env.tracker.statsSource = () => ({
            totalRequests: 100,
            clientRequests: { total: 100, failed: 0 },
            keys: []
        });
        env.tracker._collectDataPoint();

        // Counter drops (proxy restart)
        env.tracker.statsSource = () => ({
            totalRequests: 5,
            clientRequests: { total: 5, failed: 0 },
            keys: []
        });
        env.tracker._collectDataPoint();

        const pt = env.tracker.tiers.fine.data.get(1);
        // requests delta would be negative but clamped via Math.max(0, ...)
        expect(pt.requests).toBe(0);
    });
});

// ============================================================
// 2. Time-series tiers
// ============================================================
describe('Edge Case: Time-series tiers', () => {
    let env;

    beforeEach(() => {
        jest.useFakeTimers();
        env = createTracker();
        env.tracker.statsSource = incrementingStatsSource();
    });

    afterEach(() => {
        env.tracker.stop();
        jest.useRealTimers();
        fs.rmSync(env.dir, { recursive: true, force: true });
    });

    test('fine tier receives every data point', () => {
        for (let i = 0; i < 9; i++) {
            env.tracker._collectDataPoint();
        }
        expect(env.tracker.tiers.fine.data.length).toBe(9);
    });

    test('medium tier populated after 10 fine ticks', () => {
        for (let i = 0; i < 10; i++) {
            env.tracker._collectDataPoint();
        }
        expect(env.tracker.tiers.medium.data.length).toBe(1);
    });

    test('medium tier NOT populated with fewer than 10 recent fine points', () => {
        for (let i = 0; i < 9; i++) {
            env.tracker._collectDataPoint();
        }
        expect(env.tracker.tiers.medium.data.length).toBe(0);
    });

    test('coarse tier populated after 60 fine ticks', () => {
        for (let i = 0; i < 60; i++) {
            env.tracker._collectDataPoint();
        }
        expect(env.tracker.tiers.medium.data.length).toBe(6);
        expect(env.tracker.tiers.coarse.data.length).toBe(1);
    });

    test('coarse tier NOT populated at 50 fine ticks', () => {
        for (let i = 0; i < 50; i++) {
            env.tracker._collectDataPoint();
        }
        expect(env.tracker.tiers.coarse.data.length).toBe(0);
    });

    test('medium rollup averages latency and sums requests', () => {
        for (let i = 0; i < 10; i++) {
            env.tracker._collectDataPoint();
        }
        const med = env.tracker.tiers.medium.data.get(0);
        expect(med.requests).toBeGreaterThan(0);
        expect(typeof med.avgLatency).toBe('number');
        expect(med.errorRate).toBeGreaterThanOrEqual(0);
        expect(med.errorRate).toBeLessThanOrEqual(100);
    });

    test('multiple medium rollups occur at tick 10, 20, 30', () => {
        for (let i = 0; i < 30; i++) {
            env.tracker._collectDataPoint();
        }
        expect(env.tracker.tiers.medium.data.length).toBe(3);
    });
});

// ============================================================
// 3. Max points cap (ring buffer overflow)
// ============================================================
describe('Edge Case: Max points cap', () => {
    let env;

    beforeEach(() => {
        jest.useFakeTimers();
        // Fine tier defaults to 3600 capacity in HistoryTracker
        env = createTracker();
        env.tracker.statsSource = incrementingStatsSource();
    });

    afterEach(() => {
        env.tracker.stop();
        jest.useRealTimers();
        fs.rmSync(env.dir, { recursive: true, force: true });
    });

    test('fine tier ring buffer does not exceed its capacity (3600)', () => {
        // The fine tier has a RingBuffer(3600). Push well beyond that.
        const capacity = 3600;
        for (let i = 0; i < capacity + 200; i++) {
            env.tracker._collectDataPoint();
        }
        expect(env.tracker.tiers.fine.data.length).toBe(capacity);
    });

    test('medium tier ring buffer does not exceed 8640', () => {
        // medium needs 10 ticks per entry. To fill 8640+, we'd need 86400+ ticks.
        // Instead, push directly to verify the RingBuffer cap.
        const medBuf = env.tracker.tiers.medium.data;
        for (let i = 0; i < 8650; i++) {
            medBuf.push({ timestamp: Date.now() + i, requests: i });
        }
        expect(medBuf.length).toBe(8640);
    });

    test('coarse tier ring buffer does not exceed 10080', () => {
        const coarseBuf = env.tracker.tiers.coarse.data;
        for (let i = 0; i < 10100; i++) {
            coarseBuf.push({ timestamp: Date.now() + i, requests: i });
        }
        expect(coarseBuf.length).toBe(10080);
    });

    test('oldest points are evicted when ring buffer wraps', () => {
        const capacity = 3600;
        for (let i = 0; i < capacity + 50; i++) {
            env.tracker._collectDataPoint();
        }
        // The oldest point's totalRequests should NOT be the very first value
        const oldest = env.tracker.tiers.fine.data.get(0);
        // First point had totalRequests=10, but it's been evicted
        // The 51st point is now the oldest (totalRequests = 510)
        expect(oldest.totalRequests).toBeGreaterThan(10);
    });
});

// ============================================================
// 4. Persistence - save + reload round-trip
// ============================================================
describe('Edge Case: Persistence', () => {
    test('save then reload preserves fine/medium/coarse data', async () => {
        jest.useRealTimers();
        const { tracker, historyFile, dir } = createTracker();

        tracker.statsSource = incrementingStatsSource();

        // Collect 60 points to populate all three tiers
        for (let i = 0; i < 60; i++) {
            tracker._collectDataPoint();
        }

        const fineBefore = tracker.tiers.fine.data.length;
        const mediumBefore = tracker.tiers.medium.data.length;
        const coarseBefore = tracker.tiers.coarse.data.length;

        expect(fineBefore).toBe(60);
        expect(mediumBefore).toBe(6);
        expect(coarseBefore).toBe(1);

        // Save
        tracker.save();

        // Wait for async write to complete
        const maxWait = 3000;
        const poll = 50;
        let elapsed = 0;
        while (!fs.existsSync(historyFile) && elapsed < maxWait) {
            await new Promise(r => setTimeout(r, poll));
            elapsed += poll;
        }
        expect(fs.existsSync(historyFile)).toBe(true);

        // Verify file is valid JSON with v2 schema
        const raw = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
        expect(raw.schemaVersion).toBe(2);
        expect(raw.points.fine.length).toBe(60);
        expect(raw.points.medium.length).toBe(6);
        expect(raw.points.coarse.length).toBe(1);

        // Reload into a fresh tracker
        const { tracker: tracker2, dir: dir2 } = createTracker({ historyFile });
        tracker2.load();

        expect(tracker2.tiers.fine.data.length).toBe(fineBefore);
        expect(tracker2.tiers.medium.data.length).toBe(mediumBefore);
        expect(tracker2.tiers.coarse.data.length).toBe(coarseBefore);

        // Verify timestamps match
        const origFine = tracker.tiers.fine.data.toArray();
        const loadedFine = tracker2.tiers.fine.data.toArray();
        expect(loadedFine[0].timestamp).toBe(origFine[0].timestamp);
        expect(loadedFine[loadedFine.length - 1].timestamp).toBe(origFine[origFine.length - 1].timestamp);

        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(dir2, { recursive: true, force: true });
    });

    test('stale fine points are filtered out on reload', async () => {
        jest.useRealTimers();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ht-stale-'));
        const historyFile = path.join(dir, 'history.json');

        const now = Date.now();
        const data = {
            schemaVersion: 2,
            interval: 100,
            lastUpdated: new Date().toISOString(),
            points: {
                fine: [
                    { timestamp: now - (3700 * 1000), requests: 1 }, // > 1hr old, should be filtered
                    { timestamp: now - 60000, requests: 2 }          // fresh
                ],
                medium: [
                    { timestamp: now - (90000 * 1000), requests: 3 }, // > 24hr old, should be filtered
                    { timestamp: now - 1000, requests: 4 }            // fresh
                ],
                coarse: [
                    { timestamp: now - (8 * 86400 * 1000), requests: 5 }, // > 7 days old, filtered
                    { timestamp: now - 1000, requests: 6 }                 // fresh
                ]
            }
        };
        fs.writeFileSync(historyFile, JSON.stringify(data));

        const { tracker } = createTracker({ historyFile });
        tracker.load();

        expect(tracker.tiers.fine.data.length).toBe(1);
        expect(tracker.tiers.fine.data.get(0).requests).toBe(2);
        expect(tracker.tiers.medium.data.length).toBe(1);
        expect(tracker.tiers.medium.data.get(0).requests).toBe(4);
        expect(tracker.tiers.coarse.data.length).toBe(1);
        expect(tracker.tiers.coarse.data.get(0).requests).toBe(6);

        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('v1 array format is migrated to v2 tiered format', () => {
        jest.useFakeTimers();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ht-v1-'));
        const historyFile = path.join(dir, 'history.json');

        const now = Date.now();
        // v1: bare array
        const v1Data = [
            { timestamp: now - 500, requests: 10 },
            { timestamp: now - 200, requests: 20 }
        ];
        fs.writeFileSync(historyFile, JSON.stringify(v1Data));

        const { tracker, mockLogger } = createTracker({ historyFile });
        tracker.load();

        expect(tracker.tiers.fine.data.length).toBe(2);
        expect(mockLogger.info).toHaveBeenCalledWith(
            'Migrated history from v1 (array) to v2 (tiered)',
            expect.objectContaining({ points: 2 })
        );

        jest.useRealTimers();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('save is suppressed after destroy', async () => {
        jest.useRealTimers();

        // Use a distinct directory so the destroy-save writes there
        const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'ht-destroy1-'));
        const historyFile1 = path.join(dir1, 'history.json');
        const { tracker } = createTracker({ historyFile: historyFile1 });

        tracker.statsSource = incrementingStatsSource();
        tracker._collectDataPoint();

        await tracker.destroy();

        // Wait for any in-flight writes from destroy's save to finish
        await new Promise(r => setTimeout(r, 500));

        // Now use a fresh file path that does NOT exist
        const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ht-destroy2-'));
        const freshFile = path.join(dir2, 'history.json');
        tracker.historyFile = freshFile;

        // save() should be a no-op because destroyed=true
        tracker.save();

        await new Promise(r => setTimeout(r, 300));
        expect(fs.existsSync(freshFile)).toBe(false);

        fs.rmSync(dir1, { recursive: true, force: true });
        fs.rmSync(dir2, { recursive: true, force: true });
    });
});

// ============================================================
// 5. Query by time range
// ============================================================
describe('Edge Case: Query by time range', () => {
    let env;

    beforeEach(() => {
        jest.useFakeTimers();
        env = createTracker();
    });

    afterEach(() => {
        env.tracker.stop();
        jest.useRealTimers();
        fs.rmSync(env.dir, { recursive: true, force: true });
    });

    test('getHistory(5) returns fine tier with only last 5 minutes', () => {
        const now = Date.now();
        env.tracker.tiers.fine.data.push({ timestamp: now - (10 * 60 * 1000), requests: 1 }); // 10min ago
        env.tracker.tiers.fine.data.push({ timestamp: now - (4 * 60 * 1000), requests: 2 });  // 4min ago
        env.tracker.tiers.fine.data.push({ timestamp: now - (1 * 60 * 1000), requests: 3 });  // 1min ago

        const h = env.tracker.getHistory(5);
        expect(h.tier).toBe('fine');
        expect(h.minutes).toBe(5);
        expect(h.pointCount).toBe(2); // only 4min and 1min ago
        expect(h.points.every(p => p.timestamp > now - (5 * 60 * 1000))).toBe(true);
    });

    test('getHistory(60) selects fine tier', () => {
        const h = env.tracker.getHistory(60);
        expect(h.tier).toBe('fine');
        expect(h.tierResolution).toBe(1);
    });

    test('getHistory(120) selects medium tier', () => {
        const h = env.tracker.getHistory(120);
        expect(h.tier).toBe('medium');
        expect(h.tierResolution).toBe(10);
    });

    test('getHistory(1440) selects medium tier (24hr boundary)', () => {
        const h = env.tracker.getHistory(1440);
        expect(h.tier).toBe('medium');
    });

    test('getHistory(1441) selects coarse tier', () => {
        const h = env.tracker.getHistory(1441);
        expect(h.tier).toBe('coarse');
        expect(h.tierResolution).toBe(60);
    });

    test('getHistory(10080) for 7 days uses coarse tier', () => {
        const h = env.tracker.getHistory(10080);
        expect(h.tier).toBe('coarse');
    });

    test('default getHistory() returns 15-minute window', () => {
        const h = env.tracker.getHistory();
        expect(h.minutes).toBe(15);
        expect(h.tier).toBe('fine');
    });

    test('getHistory returns metadata fields', () => {
        env.tracker.tiers.fine.data.push({ timestamp: Date.now(), requests: 1 });
        const h = env.tracker.getHistory(5);

        expect(h).toHaveProperty('schemaVersion', 2);
        expect(h).toHaveProperty('interval');
        expect(h).toHaveProperty('tier');
        expect(h).toHaveProperty('tierResolution');
        expect(h).toHaveProperty('expectedInterval');
        expect(h).toHaveProperty('pointCount');
        expect(h).toHaveProperty('expectedPointCount');
        expect(h).toHaveProperty('actualPointCount');
        expect(h).toHaveProperty('dataAgeMs');
        expect(h).toHaveProperty('points');
    });

    test('getHistory downsamples if > 1000 points', () => {
        // Inject 1500 fine points all within the last 15 minutes
        const now = Date.now();
        for (let i = 0; i < 1500; i++) {
            env.tracker.tiers.fine.data.push({ timestamp: now - (14 * 60 * 1000) + i * 500, requests: i });
        }

        const h = env.tracker.getHistory(15);
        expect(h.pointCount).toBeLessThanOrEqual(1000);
        expect(h.actualPointCount).toBe(1500);
    });

    test('getHistory does NOT downsample at exactly 1000 points', () => {
        const now = Date.now();
        for (let i = 0; i < 1000; i++) {
            env.tracker.tiers.fine.data.push({ timestamp: now - (14 * 60 * 1000) + i * 800, requests: i });
        }

        const h = env.tracker.getHistory(15);
        expect(h.pointCount).toBe(1000);
    });
});

// ============================================================
// 6. Empty history
// ============================================================
describe('Edge Case: Empty history', () => {
    let env;

    beforeEach(() => {
        env = createTracker();
    });

    afterEach(() => {
        env.tracker.stop();
        fs.rmSync(env.dir, { recursive: true, force: true });
    });

    test('fresh tracker has zero-length tiers', () => {
        expect(env.tracker.tiers.fine.data.length).toBe(0);
        expect(env.tracker.tiers.medium.data.length).toBe(0);
        expect(env.tracker.tiers.coarse.data.length).toBe(0);
    });

    test('getHistory on empty tracker returns valid structure', () => {
        const h = env.tracker.getHistory(15);
        expect(h.pointCount).toBe(0);
        expect(h.points).toEqual([]);
        expect(h.tier).toBe('fine');
        expect(h.schemaVersion).toBe(2);
    });

    test('getSummary on empty tracker returns zero stats', () => {
        const s = env.tracker.getSummary();
        expect(s.avgRequestsPerSecond).toBe(0);
        expect(s.avgSuccessRate).toBe(0);
        expect(s.avgLatency).toBe(0);
        expect(s.peakLatency).toBe(0);
        expect(s.totalErrors).toBe(0);
    });

    test('getCircuitTransitions on empty tracker returns empty', () => {
        const ct = env.tracker.getCircuitTransitions(60);
        expect(ct.count).toBe(0);
        expect(ct.transitions).toEqual([]);
    });

    test('getCircuitTimeline on empty tracker returns empty array', () => {
        const tl = env.tracker.getCircuitTimeline(null, 60);
        expect(tl).toEqual([]);
    });

    test('points property accessor works on empty tracker', () => {
        const pts = env.tracker.points;
        expect(pts.fine.length).toBe(0);
        expect(pts.medium.length).toBe(0);
        expect(pts.coarse.length).toBe(0);
    });
});

// ============================================================
// 7. Concurrent recording (rapid-fire data points)
// ============================================================
describe('Edge Case: Concurrent recording', () => {
    let env;

    beforeEach(() => {
        jest.useFakeTimers();
        env = createTracker();
    });

    afterEach(() => {
        env.tracker.stop();
        jest.useRealTimers();
        fs.rmSync(env.dir, { recursive: true, force: true });
    });

    test('1000 rapid data points do not corrupt structure', () => {
        let counter = 0;
        env.tracker.statsSource = () => {
            counter++;
            return {
                totalRequests: counter * 5,
                clientRequests: { total: counter * 5, failed: 0 },
                successRate: 100,
                latency: { avg: 100, p95: 200, p99: 300 },
                activeConnections: 1,
                queue: { current: 0 },
                errors: { timeouts: 0, socketHangups: 0, serverErrors: 0, rateLimited: 0, other: 0 },
                keys: []
            };
        };

        for (let i = 0; i < 1000; i++) {
            env.tracker._collectDataPoint();
        }

        // Fine tier caps at 3600, all 1000 should fit
        expect(env.tracker.tiers.fine.data.length).toBe(1000);
        // Medium tier gets a rollup every 10 ticks
        expect(env.tracker.tiers.medium.data.length).toBe(100);
        // Coarse tier gets a rollup every 60 ticks
        expect(env.tracker.tiers.coarse.data.length).toBe(16); // floor(1000/60)=16

        // Verify data integrity: all fine points should have timestamps
        const arr = env.tracker.tiers.fine.data.toArray();
        for (const p of arr) {
            expect(typeof p.timestamp).toBe('number');
            expect(p.timestamp).toBeGreaterThan(0);
            expect(typeof p.requests).toBe('number');
        }
    });

    test('interleaved stats source changes do not corrupt data', () => {
        let mode = 'low';
        env.tracker.statsSource = () => {
            if (mode === 'low') {
                return { totalRequests: 10, latency: { avg: 50 }, keys: [] };
            }
            return { totalRequests: 1000, latency: { avg: 5000 }, keys: [] };
        };

        // Alternate between modes rapidly
        for (let i = 0; i < 20; i++) {
            mode = i % 2 === 0 ? 'low' : 'high';
            env.tracker._collectDataPoint();
        }

        expect(env.tracker.tiers.fine.data.length).toBe(20);
        // No crashes, no NaN
        const arr = env.tracker.tiers.fine.data.toArray();
        for (const p of arr) {
            expect(Number.isFinite(p.avgLatency)).toBe(true);
            expect(Number.isFinite(p.errorRate)).toBe(true);
        }
    });

    test('tickCount advances correctly through rapid collection', () => {
        env.tracker.statsSource = () => ({ totalRequests: 0, keys: [] });

        for (let i = 0; i < 100; i++) {
            env.tracker._collectDataPoint();
        }
        expect(env.tracker._tickCount).toBe(100);
    });
});

// ============================================================
// 8. Timer lifecycle
// ============================================================
describe('Edge Case: Timer lifecycle', () => {
    let env;

    beforeEach(() => {
        jest.useFakeTimers();
        env = createTracker();
    });

    afterEach(() => {
        jest.useRealTimers();
        fs.rmSync(env.dir, { recursive: true, force: true });
    });

    test('start() creates both collect and save timers', () => {
        const source = incrementingStatsSource();
        env.tracker.start(source);

        expect(env.tracker.collectTimer).not.toBeNull();
        expect(env.tracker.saveTimer).not.toBeNull();

        env.tracker.stop();
    });

    test('stop() clears both timers and calls save', () => {
        const source = incrementingStatsSource();
        env.tracker.start(source);

        const saveSpy = jest.spyOn(env.tracker, 'save');
        env.tracker.stop();

        expect(env.tracker.collectTimer).toBeNull();
        expect(env.tracker.saveTimer).toBeNull();
        expect(saveSpy).toHaveBeenCalled();
        saveSpy.mockRestore();
    });

    test('stop() is safe to call when not started', () => {
        // No start() call
        expect(() => env.tracker.stop()).not.toThrow();
        expect(env.tracker.collectTimer).toBeNull();
        expect(env.tracker.saveTimer).toBeNull();
    });

    test('stop() is safe to call twice', () => {
        const source = incrementingStatsSource();
        env.tracker.start(source);
        env.tracker.stop();
        expect(() => env.tracker.stop()).not.toThrow();
    });

    test('collection timer fires at correct interval', () => {
        const source = incrementingStatsSource();
        env.tracker.start(source);

        // Advance exactly 3 intervals (100ms each)
        jest.advanceTimersByTime(300);

        // At least 3 data points should have been collected
        expect(env.tracker.tiers.fine.data.length).toBeGreaterThanOrEqual(3);

        env.tracker.stop();
    });

    test('save timer fires at correct interval', () => {
        const source = incrementingStatsSource();
        env.tracker.start(source);

        const saveSpy = jest.spyOn(env.tracker, 'save');

        // saveInterval is 500ms, advance past it
        jest.advanceTimersByTime(600);

        // save() should have been called at least once by the timer
        expect(saveSpy).toHaveBeenCalled();

        env.tracker.stop();
        saveSpy.mockRestore();
    });

    test('no more data points after stop()', () => {
        const source = incrementingStatsSource();
        env.tracker.start(source);

        jest.advanceTimersByTime(300);
        const countBeforeStop = env.tracker.tiers.fine.data.length;

        env.tracker.stop();
        jest.advanceTimersByTime(500);

        expect(env.tracker.tiers.fine.data.length).toBe(countBeforeStop);
    });

    test('start sets statsSource and routingSource', () => {
        const stats = jest.fn(() => ({ totalRequests: 0 }));
        const routing = jest.fn(() => null);

        env.tracker.start(stats, routing);

        expect(env.tracker.statsSource).toBe(stats);
        expect(env.tracker.routingSource).toBe(routing);

        env.tracker.stop();
    });

    test('start loads existing history', () => {
        const loadSpy = jest.spyOn(env.tracker, 'load');
        const source = incrementingStatsSource();

        env.tracker.start(source);
        expect(loadSpy).toHaveBeenCalledTimes(1);

        env.tracker.stop();
        loadSpy.mockRestore();
    });
});

// ============================================================
// 9. Graceful degradation
// ============================================================
describe('Edge Case: Graceful degradation', () => {
    test('load with non-existent file does not throw', () => {
        const { tracker, dir } = createTracker({
            historyFile: path.join(os.tmpdir(), 'nonexistent-' + Date.now(), 'history.json')
        });

        expect(() => tracker.load()).not.toThrow();
        expect(tracker.tiers.fine.data.length).toBe(0);
        expect(tracker.tiers.medium.data.length).toBe(0);
        expect(tracker.tiers.coarse.data.length).toBe(0);

        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('load with corrupted JSON clears tiers and warns', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ht-corrupt-'));
        const historyFile = path.join(dir, 'history.json');
        fs.writeFileSync(historyFile, '{{{not valid json');

        const { tracker, mockLogger } = createTracker({ historyFile });
        tracker.load();

        expect(tracker.tiers.fine.data.length).toBe(0);
        expect(tracker.tiers.medium.data.length).toBe(0);
        expect(tracker.tiers.coarse.data.length).toBe(0);
        expect(mockLogger.warn).toHaveBeenCalledWith('Could not load history', expect.any(Object));

        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('load with empty JSON object does not crash', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ht-empty-'));
        const historyFile = path.join(dir, 'history.json');
        fs.writeFileSync(historyFile, '{}');

        const { tracker } = createTracker({ historyFile });
        expect(() => tracker.load()).not.toThrow();
        expect(tracker.tiers.fine.data.length).toBe(0);

        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('load with v2 schema but empty points does not crash', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ht-v2empty-'));
        const historyFile = path.join(dir, 'history.json');
        fs.writeFileSync(historyFile, JSON.stringify({
            schemaVersion: 2,
            points: { fine: [], medium: [], coarse: [] }
        }));

        const { tracker } = createTracker({ historyFile });
        expect(() => tracker.load()).not.toThrow();
        expect(tracker.tiers.fine.data.length).toBe(0);

        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('load with v2 schema but missing tier arrays does not crash', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ht-v2missing-'));
        const historyFile = path.join(dir, 'history.json');
        fs.writeFileSync(historyFile, JSON.stringify({
            schemaVersion: 2,
            points: {} // all tier arrays missing
        }));

        const { tracker } = createTracker({ historyFile });
        expect(() => tracker.load()).not.toThrow();
        expect(tracker.tiers.fine.data.length).toBe(0);
        expect(tracker.tiers.medium.data.length).toBe(0);
        expect(tracker.tiers.coarse.data.length).toBe(0);

        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('statsSource returning partial stats does not crash', () => {
        jest.useFakeTimers();
        const { tracker, dir } = createTracker();

        tracker.statsSource = () => ({
            // minimal: only totalRequests, everything else missing
            totalRequests: 5
        });

        expect(() => tracker._collectDataPoint()).not.toThrow();
        expect(tracker.tiers.fine.data.length).toBe(1);

        const pt = tracker.tiers.fine.data.get(0);
        expect(pt.avgLatency).toBe(0);
        expect(pt.p95Latency).toBe(0);
        expect(pt.activeConnections).toBe(0);
        expect(pt.queueSize).toBe(0);
        expect(pt.errors.timeouts).toBe(0);

        jest.useRealTimers();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('statsSource throwing error is caught gracefully', () => {
        jest.useFakeTimers();
        const { tracker, mockLogger, dir } = createTracker();

        tracker.statsSource = () => { throw new TypeError('Cannot read property'); };
        tracker._collectDataPoint();

        expect(tracker.tiers.fine.data.length).toBe(0);
        expect(mockLogger.error).toHaveBeenCalledWith(
            'Error collecting history point',
            expect.objectContaining({ error: expect.any(String) })
        );

        jest.useRealTimers();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('routingSource throwing error does not prevent data collection', () => {
        jest.useFakeTimers();
        const { tracker, dir } = createTracker();

        tracker.statsSource = () => ({ totalRequests: 50, keys: [] });
        tracker.routingSource = () => { throw new Error('routing down'); };

        tracker._collectDataPoint();

        expect(tracker.tiers.fine.data.length).toBe(1);
        // Point should exist without routing field
        expect(tracker.tiers.fine.data.get(0).routing).toBeUndefined();

        jest.useRealTimers();
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

// ============================================================
// 10. Data compaction (rollup from fine -> medium -> coarse)
// ============================================================
describe('Edge Case: Data compaction', () => {
    let env;

    beforeEach(() => {
        jest.useFakeTimers();
        env = createTracker();
    });

    afterEach(() => {
        env.tracker.stop();
        jest.useRealTimers();
        fs.rmSync(env.dir, { recursive: true, force: true });
    });

    test('medium rollup sums requests from 10 fine points', () => {
        let reqCounter = 0;
        env.tracker.statsSource = () => {
            reqCounter += 10;
            return {
                totalRequests: reqCounter,
                clientRequests: { total: reqCounter, failed: 0 },
                latency: { avg: 100 },
                keys: []
            };
        };

        for (let i = 0; i < 10; i++) {
            env.tracker._collectDataPoint();
        }

        const med = env.tracker.tiers.medium.data.get(0);
        // Each fine point has requests delta = 10 (except first = 0), so sum = 0+10+10+...+10 = 90
        // Actually: first point delta=0 (no lastStats), subsequent = 10 each
        // Total: 9 * 10 = 90
        expect(med.requests).toBe(90);
    });

    test('medium rollup averages latency correctly', () => {
        let latency = 100;
        env.tracker.statsSource = () => {
            latency += 10;
            return {
                totalRequests: 100,
                clientRequests: { total: 100, failed: 0 },
                latency: { avg: latency },
                keys: []
            };
        };

        for (let i = 0; i < 10; i++) {
            env.tracker._collectDataPoint();
        }

        const med = env.tracker.tiers.medium.data.get(0);
        // latencies were 110,120,...,200 => avg = 155
        expect(med.avgLatency).toBe(155);
    });

    test('coarse rollup sums requests from 6 medium points', () => {
        let counter = 0;
        env.tracker.statsSource = () => {
            counter += 1;
            return {
                totalRequests: counter,
                clientRequests: { total: counter, failed: 0 },
                latency: { avg: 100 },
                keys: []
            };
        };

        // 60 fine ticks => 6 medium => 1 coarse
        for (let i = 0; i < 60; i++) {
            env.tracker._collectDataPoint();
        }

        expect(env.tracker.tiers.coarse.data.length).toBe(1);
        const coarse = env.tracker.tiers.coarse.data.get(0);
        // Coarse sums the 6 medium rollup request totals
        expect(coarse.requests).toBeGreaterThan(0);
        expect(typeof coarse.avgLatency).toBe('number');
    });

    test('coarse rollup uses last medium point timestamp', () => {
        env.tracker.statsSource = incrementingStatsSource();

        for (let i = 0; i < 60; i++) {
            env.tracker._collectDataPoint();
        }

        const lastMed = env.tracker.tiers.medium.data.get(5);
        const coarse = env.tracker.tiers.coarse.data.get(0);
        expect(coarse.timestamp).toBe(lastMed.timestamp);
    });

    test('rollup does not trigger when insufficient fine points', () => {
        env.tracker.statsSource = incrementingStatsSource();

        // Only 9 ticks - not enough for medium rollup
        for (let i = 0; i < 9; i++) {
            env.tracker._collectDataPoint();
        }

        expect(env.tracker.tiers.medium.data.length).toBe(0);
    });

    test('rollup skips medium-to-coarse when fewer than 6 medium entries', () => {
        env.tracker.statsSource = incrementingStatsSource();

        // 50 ticks => 5 medium rollups, not enough for coarse
        for (let i = 0; i < 50; i++) {
            env.tracker._collectDataPoint();
        }

        expect(env.tracker.tiers.medium.data.length).toBe(5);
        expect(env.tracker.tiers.coarse.data.length).toBe(0);
    });

    test('routing deltas are summed in medium rollup', () => {
        let routingTotal = 0;
        env.tracker.statsSource = () => ({ totalRequests: 100, keys: [] });
        env.tracker.routingSource = () => {
            routingTotal += 5;
            return {
                total: routingTotal,
                byTier: { light: routingTotal },
                bySource: { failover: 0 },
                burstDampenedTotal: 0
            };
        };

        for (let i = 0; i < 10; i++) {
            env.tracker._collectDataPoint();
        }

        const med = env.tracker.tiers.medium.data.get(0);
        expect(med.routing).toBeDefined();
        // totalDelta should be sum of all 10 fine points' totalDelta
        expect(med.routing.totalDelta).toBe(50); // 5*10
        // Cumulative should be last point's value
        expect(med.routing.total).toBe(50);
    });

    test('rateLimitedDelta is summed in medium rollup', () => {
        let rl = 0;
        env.tracker.statsSource = () => {
            rl += 2;
            return {
                totalRequests: 100,
                errors: { rateLimited: rl },
                keys: []
            };
        };

        for (let i = 0; i < 10; i++) {
            env.tracker._collectDataPoint();
        }

        const med = env.tracker.tiers.medium.data.get(0);
        // Each point has rateLimitedDelta=2 (first=2, rest=2 each)
        expect(med.rateLimitedDelta).toBe(20);
    });

    test('error rate in rollup is correctly bounded [0, 100]', () => {
        let counter = 0;
        env.tracker.statsSource = () => {
            counter++;
            return {
                totalRequests: counter * 10,
                clientRequests: { total: counter * 10, failed: counter * 10 }, // 100% failure
                latency: { avg: 100 },
                keys: []
            };
        };

        for (let i = 0; i < 10; i++) {
            env.tracker._collectDataPoint();
        }

        const med = env.tracker.tiers.medium.data.get(0);
        expect(med.errorRate).toBeGreaterThanOrEqual(0);
        expect(med.errorRate).toBeLessThanOrEqual(100);
    });
});
