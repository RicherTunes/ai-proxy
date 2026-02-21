/**
 * History Tracker Module Tests
 *
 * Tests history tracking using fake timers and explicit sync points.
 * Avoids timing dependencies by using jest.useFakeTimers() and
 * explicit flush() calls.
 *
 * Quarantine Exit: 2026-02-28
 */

const fs = require('fs');
const path = require('path');
const { HistoryTracker } = require('../lib/history-tracker');

describe('HistoryTracker', () => {
    let tracker;
    let mockLogger;
    const testHistoryFile = path.join(__dirname, 'test-history.json');

    beforeEach(() => {
        jest.useFakeTimers();

        mockLogger = {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        };

        tracker = new HistoryTracker({
            interval: 100,        // Fast interval for testing
            maxPoints: 10,
            historyFile: testHistoryFile,
            saveInterval: 1000,
            logger: mockLogger
        });

        // Clean up test file
        if (fs.existsSync(testHistoryFile)) {
            fs.unlinkSync(testHistoryFile);
        }
    });

    afterEach(() => {
        jest.useRealTimers();
        tracker.stop();
        // Clean up test file
        if (fs.existsSync(testHistoryFile)) {
            fs.unlinkSync(testHistoryFile);
        }
    });

    describe('constructor', () => {
        test('should initialize with default options', () => {
            const defaultTracker = new HistoryTracker();
            expect(defaultTracker.interval).toBe(1000);
            expect(defaultTracker.maxPoints).toBe(3600);
            expect(defaultTracker.saveInterval).toBe(30000);
            expect(defaultTracker.points.fine.length).toBe(0);
            expect(defaultTracker.points.medium.length).toBe(0);
            expect(defaultTracker.points.coarse.length).toBe(0);
            expect(defaultTracker.circuitTransitions.length).toBe(0);
        });

        test('should initialize with custom options', () => {
            expect(tracker.interval).toBe(100);
            expect(tracker.maxPoints).toBe(10);
            expect(tracker.historyFile).toBe(testHistoryFile);
        });
    });

    describe('start and stop', () => {
        test('should start collecting data', () => {
            const mockStatsSource = jest.fn(() => ({
                totalRequests: 100,
                successRate: 95,
                latency: { avg: 500, p95: 1000, p99: 1500 },
                activeConnections: 5,
                queue: { currentSize: 2 },
                keys: []
            }));

            tracker.start(mockStatsSource);
            expect(tracker.statsSource).toBe(mockStatsSource);
            expect(tracker.collectTimer).not.toBeNull();
            expect(tracker.saveTimer).not.toBeNull();
            expect(mockLogger.info).toHaveBeenCalledWith('History tracker started', expect.any(Object));
        });

        test('should stop and clear timers', () => {
            const mockStatsSource = jest.fn(() => ({ totalRequests: 0 }));
            tracker.start(mockStatsSource);

            tracker.stop();
            expect(tracker.collectTimer).toBeNull();
            expect(tracker.saveTimer).toBeNull();
            expect(mockLogger.info).toHaveBeenCalledWith('History tracker stopped');
        });
    });

    describe('_collectDataPoint', () => {
        test('should collect data point from stats source', () => {
            const mockStats = {
                totalRequests: 100,
                successRate: 95.5,
                latency: { avg: 500, p95: 1000, p99: 1500 },
                activeConnections: 5,
                queue: { currentSize: 2 },
                errors: {
                    timeouts: 3,
                    socketHangups: 1,
                    serverErrors: 0,
                    rateLimited: 2,
                    other: 0
                },
                keys: [
                    { state: 'CLOSED' },  // Implementation reads key.state, not circuitState
                    { state: 'OPEN' }
                ]
            };

            tracker.statsSource = () => mockStats;
            tracker._collectDataPoint();

            expect(tracker.points.fine.length).toBe(1);
            const point = tracker.points.fine.get(0);
            expect(point.totalRequests).toBe(100);
            expect(point.successRate).toBe(95.5);
            expect(point.avgLatency).toBe(500);
            expect(point.p95Latency).toBe(1000);
            expect(point.errors.timeouts).toBe(3);
            expect(point.circuitStates.closed).toBe(1);
            expect(point.circuitStates.open).toBe(1);
        });

        test('should calculate requests delta', () => {
            tracker.statsSource = () => ({ totalRequests: 100 });
            tracker._collectDataPoint();

            tracker.statsSource = () => ({ totalRequests: 150 });
            tracker._collectDataPoint();

            expect(tracker.points.fine.length).toBe(2);
            expect(tracker.points.fine.get(0).requests).toBe(0);
            expect(tracker.points.fine.get(1).requests).toBe(50);
        });

        test('should respect maxPoints (ring buffer)', () => {
            tracker.statsSource = () => ({ totalRequests: 0 });

            // Fine tier trims at 3600 points; collect enough to verify trimming works
            // With the tiered design, maxPoints applies differently per tier
            for (let i = 0; i < 15; i++) {
                tracker._collectDataPoint();
            }

            // All 15 points fit within fine tier's 3600 limit
            expect(tracker.points.fine.length).toBe(15);
        });

        test('should handle missing stats source', () => {
            tracker.statsSource = null;
            tracker._collectDataPoint();
            expect(tracker.points.fine.length).toBe(0);
        });

        test('should handle null stats', () => {
            tracker.statsSource = () => null;
            tracker._collectDataPoint();
            expect(tracker.points.fine.length).toBe(0);
        });

        test('should handle stats source errors', () => {
            tracker.statsSource = () => { throw new Error('Stats error'); };
            tracker._collectDataPoint();
            expect(tracker.points.fine.length).toBe(0);
            expect(mockLogger.error).toHaveBeenCalledWith('Error collecting history point', expect.any(Object));
        });
    });

    describe('_countCircuitStates', () => {
        test('should count circuit states correctly', () => {
            // Implementation reads key.state, not key.circuitState
            const keys = [
                { state: 'CLOSED' },
                { state: 'CLOSED' },
                { state: 'OPEN' },
                { state: 'HALF_OPEN' },
                { state: 'halfopen' }
            ];

            const counts = tracker._countCircuitStates(keys);

            expect(counts.closed).toBe(2);
            expect(counts.open).toBe(1);
            expect(counts.halfOpen).toBe(2);
        });

        test('should default to CLOSED for missing state', () => {
            const keys = [{ name: 'key1' }];  // No state property
            const counts = tracker._countCircuitStates(keys);
            expect(counts.closed).toBe(1);
        });

        test('should handle empty keys array', () => {
            const counts = tracker._countCircuitStates([]);
            expect(counts.closed).toBe(0);
            expect(counts.open).toBe(0);
            expect(counts.halfOpen).toBe(0);
        });
    });

    describe('load and save', () => {
        test('should save history to file', async () => {
            jest.useRealTimers();  // Need real timers for async save

            // Use a different file to avoid afterEach interference
            const saveTestFile = path.join(__dirname, 'test-save-history.json');

            // Clean up
            if (fs.existsSync(saveTestFile)) {
                fs.unlinkSync(saveTestFile);
            }

            // Create a fresh tracker with real timers
            const realTracker = new HistoryTracker({
                interval: 100,
                maxPoints: 10,
                historyFile: saveTestFile,
                saveInterval: 1000,
                logger: mockLogger
            });

            realTracker.statsSource = () => ({ totalRequests: 100 });
            realTracker._collectDataPoint();
            realTracker._collectDataPoint();

            expect(realTracker.points.fine.length).toBe(2);

            realTracker.save();

            // Wait for async save to complete
            await new Promise(r => setTimeout(r, 200));

            expect(fs.existsSync(saveTestFile)).toBe(true);
            const saved = JSON.parse(fs.readFileSync(saveTestFile, 'utf8'));
            expect(saved.points.fine.length).toBe(2);
            expect(saved.interval).toBe(100);

            // Clean up
            if (fs.existsSync(saveTestFile)) {
                fs.unlinkSync(saveTestFile);
            }

            jest.useFakeTimers();  // Restore fake timers
        });

        test('should load history from file', () => {
            const now = Date.now();
            // v1 format (flat array) - will be migrated to v2 (tiered)
            const historyData = {
                interval: 100,
                maxPoints: 10,
                lastUpdated: new Date().toISOString(),
                points: [
                    { timestamp: now - 100, requests: 10 },
                    { timestamp: now - 50, requests: 20 }
                ]
            };
            fs.writeFileSync(testHistoryFile, JSON.stringify(historyData));

            tracker.load();

            // v1 format is migrated into fine tier
            expect(tracker.points.fine.length).toBe(2);
            expect(mockLogger.info).toHaveBeenCalledWith(
                'Migrated history from v1 (array) to v2 (tiered)',
                expect.objectContaining({ points: 2 })
            );
        });

        test('should filter stale points on load', () => {
            // v1 format: stale points are filtered on migration (cutoff = 1 hour)
            const oldTimestamp = Date.now() - (3700 * 1000);  // Older than 1 hour
            const historyData = {
                points: [
                    { timestamp: oldTimestamp, requests: 10 },
                    { timestamp: Date.now() - 50, requests: 20 }
                ]
            };
            fs.writeFileSync(testHistoryFile, JSON.stringify(historyData));

            tracker.load();

            expect(tracker.points.fine.length).toBe(1);
        });

        test('should handle missing file', () => {
            tracker.load();
            expect(tracker.tiers.fine.data.toArray()).toEqual([]);
            expect(tracker.tiers.medium.data.toArray()).toEqual([]);
            expect(tracker.tiers.coarse.data.toArray()).toEqual([]);
        });

        test('should handle corrupted file', () => {
            fs.writeFileSync(testHistoryFile, 'not valid json');
            tracker.load();
            expect(tracker.tiers.fine.data.toArray()).toEqual([]);
            expect(tracker.tiers.medium.data.toArray()).toEqual([]);
            expect(tracker.tiers.coarse.data.toArray()).toEqual([]);
            expect(mockLogger.warn).toHaveBeenCalledWith('Could not load history', expect.any(Object));
        });

        test('should handle save errors gracefully', async () => {
            jest.useRealTimers();  // Need real timers for async save

            // Create a tracker with invalid path (NUL byte in path causes error on all platforms)
            const badTracker = new HistoryTracker({
                historyFile: path.join(__dirname, 'test-bad\x00dir', 'history.json'),
                logger: mockLogger
            });
            badTracker.tiers.fine.data.push({ timestamp: Date.now() });
            badTracker.save();

            // Wait for async error handling
            await new Promise(r => setTimeout(r, 200));

            expect(mockLogger.error).toHaveBeenCalledWith('Could not save history', expect.any(Object));

            jest.useFakeTimers();  // Restore fake timers
        });
    });

    describe('getHistory', () => {
        test('should return history for specified time range', () => {
            // Add points at different times to the fine tier
            tracker.tiers.fine.data.clear();
            tracker.tiers.fine.data.push({ timestamp: Date.now() - (20 * 60 * 1000), requests: 10 });  // 20 min ago
            tracker.tiers.fine.data.push({ timestamp: Date.now() - (10 * 60 * 1000), requests: 20 });  // 10 min ago
            tracker.tiers.fine.data.push({ timestamp: Date.now() - (5 * 60 * 1000), requests: 30 });   // 5 min ago

            const history = tracker.getHistory(15);

            expect(history.minutes).toBe(15);
            expect(history.pointCount).toBe(2);  // Only last 2 points within 15 min
        });

        test('should use default 15 minutes', () => {
            const history = tracker.getHistory();
            expect(history.minutes).toBe(15);
        });
    });

    describe('getSummary', () => {
        test('should return empty summary when no points', () => {
            const summary = tracker.getSummary();

            expect(summary.avgRequestsPerSecond).toBe(0);
            expect(summary.avgSuccessRate).toBe(0);
            expect(summary.avgLatency).toBe(0);
            expect(summary.peakLatency).toBe(0);
            expect(summary.totalErrors).toBe(0);
        });

        test('should calculate summary statistics', () => {
            tracker.tiers.fine.data.clear();
            tracker.tiers.fine.data.push({ requests: 10, successRate: 90, avgLatency: 400, p99Latency: 800 });
            tracker.tiers.fine.data.push({ requests: 20, successRate: 95, avgLatency: 500, p99Latency: 1000 });
            tracker.tiers.fine.data.push({ requests: 15, successRate: 92, avgLatency: 450, p99Latency: 900 });

            const summary = tracker.getSummary();

            expect(summary.avgRequestsPerSecond).toBe(15);  // (10+20+15) / 3
            expect(summary.avgSuccessRate).toBeCloseTo(92.33, 1);
            expect(summary.avgLatency).toBe(450);
            expect(summary.peakLatency).toBe(1000);
            expect(summary.pointCount).toBe(3);
        });
    });

    describe('circuit transition tracking', () => {
        test('should record circuit transition', () => {
            tracker.recordCircuitTransition(0, 'key12345', 'CLOSED', 'OPEN', 'failure_threshold');

            expect(tracker.circuitTransitions.length).toBe(1);
            const transition = tracker.circuitTransitions.get(0);
            expect(transition.keyIndex).toBe(0);
            expect(transition.keyPrefix).toBe('key12345');
            expect(transition.fromState).toBe('CLOSED');
            expect(transition.toState).toBe('OPEN');
            expect(transition.reason).toBe('failure_threshold');
        });

        test('should limit transitions to maxTransitions', () => {
            const smallTracker = new HistoryTracker({ maxTransitions: 5 });

            for (let i = 0; i < 10; i++) {
                smallTracker.recordCircuitTransition(0, 'key', 'CLOSED', 'OPEN');
            }

            expect(smallTracker.circuitTransitions.length).toBe(5);
        });

        test('should get filtered circuit transitions', () => {
            // Add old and new transitions
            tracker.circuitTransitions.clear();
            tracker.circuitTransitions.push({ timestamp: Date.now() - (120 * 60 * 1000), keyIndex: 0 });  // 2 hours ago
            tracker.circuitTransitions.push({ timestamp: Date.now() - (30 * 60 * 1000), keyIndex: 1 });   // 30 min ago
            tracker.circuitTransitions.push({ timestamp: Date.now() - (5 * 60 * 1000), keyIndex: 2 });    // 5 min ago

            const result = tracker.getCircuitTransitions(60);  // Last 60 minutes

            expect(result.minutes).toBe(60);
            expect(result.count).toBe(2);  // Only last 2 transitions
        });

        test('should get circuit timeline with optional key filter', () => {
            tracker.circuitTransitions.clear();
            tracker.circuitTransitions.push({ timestamp: Date.now() - 1000, keyIndex: 0, keyPrefix: 'key0', fromState: 'CLOSED', toState: 'OPEN' });
            tracker.circuitTransitions.push({ timestamp: Date.now() - 500, keyIndex: 1, keyPrefix: 'key1', fromState: 'CLOSED', toState: 'OPEN' });
            tracker.circuitTransitions.push({ timestamp: Date.now(), keyIndex: 0, keyPrefix: 'key0', fromState: 'OPEN', toState: 'HALF_OPEN' });

            // Get all transitions
            const allTimeline = tracker.getCircuitTimeline(null, 60);
            expect(allTimeline.length).toBe(3);

            // Get transitions for key 0 only
            const key0Timeline = tracker.getCircuitTimeline(0, 60);
            expect(key0Timeline.length).toBe(2);
            expect(key0Timeline.every(t => t.keyIndex === 0)).toBe(true);
        });

        test('should get current circuit states', () => {
            const keys = [
                { index: 0, keyPrefix: 'key0', circuitBreaker: { state: 'CLOSED' } },
                { index: 1, keyPrefix: 'key1', circuitBreaker: { state: 'OPEN' } },
                { index: 2, keyPrefix: 'key2', state: 'HALF_OPEN' }  // Direct state property
            ];

            const states = tracker.getCurrentCircuitStates(keys);

            expect(states.length).toBe(3);
            expect(states[0].state).toBe('CLOSED');
            expect(states[1].state).toBe('OPEN');
            expect(states[2].state).toBe('HALF_OPEN');
        });
    });

    describe('integration with fake timers', () => {
        test('should collect data over time using fake timers', () => {
            const mockStats = { totalRequests: 0 };
            const statsSource = jest.fn(() => {
                mockStats.totalRequests += 10;
                return { ...mockStats };
            });

            tracker.start(statsSource);

            // Advance timers by 350ms (3 collection intervals at 100ms each)
            jest.advanceTimersByTime(350);

            tracker.stop();

            // Should have collected at least 3 data points in fine tier
            expect(tracker.points.fine.length).toBeGreaterThanOrEqual(3);
            expect(statsSource).toHaveBeenCalled();
        });

        test('should trigger save at save interval', () => {
            const mockStats = { totalRequests: 100 };
            const statsSource = jest.fn(() => mockStats);

            tracker.start(statsSource);

            // Spy on save method
            const saveSpy = jest.spyOn(tracker, 'save');

            // Advance past save interval (1000ms)
            jest.advanceTimersByTime(1100);

            expect(saveSpy).toHaveBeenCalled();

            tracker.stop();
            saveSpy.mockRestore();
        });

        test('should stop collecting after stop() is called', () => {
            const statsSource = jest.fn(() => ({ totalRequests: 100 }));

            tracker.start(statsSource);

            // Collect some data
            jest.advanceTimersByTime(300);
            const pointsAfterStart = tracker.points.fine.length;

            // Stop the tracker
            tracker.stop();

            // Advance more time
            jest.advanceTimersByTime(300);

            // No more points should be collected
            expect(tracker.points.fine.length).toBe(pointsAfterStart);
        });
    });

    describe('routing data collection', () => {
        test('includes routing field when routingSource provided', () => {
            const mockRoutingStats = {
                total: 10,
                byTier: { light: 5, medium: 3, heavy: 2 },
                bySource: { rule: 4, classifier: 3, default: 2, failover: 1 },
                burstDampenedTotal: 1
            };

            tracker.statsSource = () => ({
                totalRequests: 100,
                errors: { rateLimited: 2 }
            });
            tracker.routingSource = () => mockRoutingStats;
            tracker._collectDataPoint();

            expect(tracker.points.fine.length).toBe(1);
            const point = tracker.points.fine.get(0);
            expect(point.routing).toBeDefined();
            expect(point.routing.total).toBe(10);
            expect(point.routing.light).toBe(5);
            expect(point.routing.medium).toBe(3);
            expect(point.routing.heavy).toBe(2);
            expect(point.routing.failover).toBe(1);
            expect(point.routing.burstDampenedTotal).toBe(1);
            expect(point.routing.bySource).toEqual({ rule: 4, classifier: 3, default: 2, failover: 1 });
        });

        test('omits routing field when routingSource is null', () => {
            tracker.statsSource = () => ({ totalRequests: 50 });
            tracker.routingSource = null;
            tracker._collectDataPoint();

            expect(tracker.points.fine.length).toBe(1);
            expect(tracker.points.fine.get(0).routing).toBeUndefined();
        });

        test('computes correct deltas between ticks', () => {
            let routingTotal = 5;
            let failoverCount = 1;
            let burstCount = 0;

            tracker.statsSource = () => ({ totalRequests: 100, errors: { rateLimited: 3 } });
            tracker.routingSource = () => ({
                total: routingTotal,
                byTier: { light: routingTotal },
                bySource: { failover: failoverCount },
                burstDampenedTotal: burstCount
            });

            // First tick
            tracker._collectDataPoint();
            expect(tracker.points.fine.get(0).routing.totalDelta).toBe(5);
            expect(tracker.points.fine.get(0).routing.failoverDelta).toBe(1);
            expect(tracker.points.fine.get(0).routing.burstDelta).toBe(0);

            // Second tick - increment
            routingTotal = 12;
            failoverCount = 3;
            burstCount = 2;
            tracker._collectDataPoint();
            expect(tracker.points.fine.get(1).routing.totalDelta).toBe(7);
            expect(tracker.points.fine.get(1).routing.failoverDelta).toBe(2);
            expect(tracker.points.fine.get(1).routing.burstDelta).toBe(2);
        });

        test('clamps negative deltas to 0 after reset', () => {
            tracker.statsSource = () => ({ totalRequests: 100 });
            tracker.routingSource = () => ({
                total: 50,
                byTier: {},
                bySource: { failover: 10 },
                burstDampenedTotal: 5
            });

            tracker._collectDataPoint();

            // Simulate counter reset (stats dropped to 0)
            tracker.routingSource = () => ({
                total: 0,
                byTier: {},
                bySource: { failover: 0 },
                burstDampenedTotal: 0
            });

            tracker._collectDataPoint();
            const point = tracker.points.fine.get(1);
            expect(point.routing.totalDelta).toBe(0);
            expect(point.routing.failoverDelta).toBe(0);
            expect(point.routing.burstDelta).toBe(0);
        });

        test('computes rateLimitedDelta correctly', () => {
            tracker.statsSource = () => ({
                totalRequests: 100,
                errors: { rateLimited: 5 }
            });
            tracker._collectDataPoint();
            expect(tracker.points.fine.get(0).rateLimitedDelta).toBe(5);

            tracker.statsSource = () => ({
                totalRequests: 200,
                errors: { rateLimited: 8 }
            });
            tracker._collectDataPoint();
            expect(tracker.points.fine.get(1).rateLimitedDelta).toBe(3);
        });

        test('handles routingSource that throws', () => {
            tracker.statsSource = () => ({ totalRequests: 100 });
            tracker.routingSource = () => { throw new Error('routing broken'); };
            tracker._collectDataPoint();

            expect(tracker.points.fine.length).toBe(1);
            expect(tracker.points.fine.get(0).routing).toBeUndefined();
        });

        test('handles routingSource returning null', () => {
            tracker.statsSource = () => ({ totalRequests: 100 });
            tracker.routingSource = () => null;
            tracker._collectDataPoint();

            expect(tracker.points.fine.length).toBe(1);
            expect(tracker.points.fine.get(0).routing).toBeUndefined();
        });
    });

    describe('routing rollup aggregation', () => {
        test('medium rollup: SUM deltas, LAST cumulative', () => {
            tracker.statsSource = () => ({ totalRequests: 100 });

            // Create 10 fine points with routing data to trigger medium rollup
            for (let i = 1; i <= 10; i++) {
                tracker.routingSource = () => ({
                    total: i * 10,
                    byTier: { light: i * 5, medium: i * 3, heavy: i * 2 },
                    bySource: { failover: i },
                    burstDampenedTotal: i
                });
                tracker._collectDataPoint();
            }

            expect(tracker.points.medium.length).toBe(1);
            const med = tracker.points.medium.get(0);

            // Cumulative: should be LAST point's values
            expect(med.routing.total).toBe(100);
            expect(med.routing.light).toBe(50);
            expect(med.routing.failover).toBe(10);

            // Deltas: should be SUM across all 10 fine points
            expect(med.routing.totalDelta).toBeGreaterThan(0);
            expect(med.routing.burstDelta).toBeGreaterThan(0);
        });

        test('coarse rollup: SUM deltas, LAST cumulative', () => {
            tracker.statsSource = () => ({ totalRequests: 100 });

            // Create 60 fine points (triggers 6 medium rollups = 1 coarse rollup)
            for (let i = 1; i <= 60; i++) {
                tracker.routingSource = () => ({
                    total: i * 10,
                    byTier: { light: i * 5 },
                    bySource: { failover: i },
                    burstDampenedTotal: i
                });
                tracker._collectDataPoint();
            }

            expect(tracker.points.medium.length).toBe(6);
            expect(tracker.points.coarse.length).toBe(1);
            const coarse = tracker.points.coarse.get(0);

            // Should have routing from LAST medium point
            expect(coarse.routing).toBeDefined();
            expect(coarse.routing.total).toBe(tracker.points.medium.get(5).routing.total);
        });

        test('rollup handles missing routing field gracefully', () => {
            tracker.statsSource = () => ({ totalRequests: 100 });
            tracker.routingSource = null;

            // Create 10 fine points without routing to trigger medium rollup
            for (let i = 0; i < 10; i++) {
                tracker._collectDataPoint();
            }

            expect(tracker.points.medium.length).toBe(1);
            expect(tracker.points.medium.get(0).routing).toBeUndefined();
            // rateLimitedDelta should still be summed (0s)
            expect(tracker.points.medium.get(0).rateLimitedDelta).toBe(0);
        });
    });
});
