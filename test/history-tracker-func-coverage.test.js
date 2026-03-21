'use strict';

/**
 * History Tracker Function Coverage Tests
 *
 * Targets uncovered functions and branches to reach 100% function coverage:
 * - Line 174: srcObj usage in routing source handling
 * - Line 220-223: Error handling catch block in _collectDataPoint
 * - Line 229-231: _rollupToMedium early return when < 10 points
 * - Line 274: _rollupToCoarse early return when < 6 points
 * - Line 301-303: Coarse tier routing rollup
 * - Line 321: halfopen (lowercase) case in _countCircuitStates
 * - Line 341-361: v2 loading with logger.info calls
 * - Line 355-365: Logger.info and catch block in load()
 * - Line 395: Save error logging in catch block
 * - Line 488: peakLatency calculation when p99Latency is missing
 * - Lines 527-544: getCircuitTransitions
 * - Lines 544-560: getCircuitTimeline
 * - Lines 567-573: getCurrentCircuitStates
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { HistoryTracker } = require('../lib/history-tracker');

describe('HistoryTracker - Function Coverage', () => {
    let tracker;
    let mockLogger;
    const testHistoryFile = path.join(os.tmpdir(), 'test-func-coverage-history.json');

    beforeEach(() => {
        jest.useFakeTimers();

        mockLogger = {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        };

        tracker = new HistoryTracker({
            interval: 100,
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
        jest.restoreAllMocks();
        jest.useRealTimers();
        tracker.stop();

        // Clean up test file
        if (fs.existsSync(testHistoryFile)) {
            fs.unlinkSync(testHistoryFile);
        }
    });

    // ============================================================
    // Coverage for line 321: halfopen (lowercase) case in _countCircuitStates
    // ============================================================
    describe('_countCircuitStates - lowercase halfopen variant', () => {
        test('should count half_open and halfopen as halfOpen', () => {
            // Covers line 321: halfopen lowercase handling
            const keys = [
                { state: 'CLOSED' },
                { state: 'OPEN' },
                { state: 'half_open' },
                { state: 'halfopen' }
            ];

            const counts = tracker._countCircuitStates(keys);

            expect(counts.closed).toBe(1);
            expect(counts.open).toBe(1);
            expect(counts.halfOpen).toBe(2);
        });
    });

    // ============================================================
    // Coverage for lines 229-231: _rollupToMedium early return
    // ============================================================
    describe('_rollupToMedium - early return', () => {
        test('should return early when fewer than 10 fine points', () => {
            // Covers lines 229-231: early return in _rollupToMedium
            tracker.statsSource = () => ({ totalRequests: 100, keys: [] });

            // Only add 5 points
            for (let i = 0; i < 5; i++) {
                tracker._collectDataPoint();
            }

            // Manually call _rollupToMedium to test early return path
            tracker._rollupToMedium();

            expect(tracker.tiers.medium.data.length).toBe(0);
        });
    });

    // ============================================================
    // Coverage for line 274: _rollupToCoarse early return
    // ============================================================
    describe('_rollupToCoarse - early return', () => {
        test('should return early when fewer than 6 medium points', () => {
            // Covers line 274: early return in _rollupToCoarse
            tracker.statsSource = () => ({ totalRequests: 100, keys: [] });

            // Add 30 points (3 medium rollups)
            for (let i = 0; i < 30; i++) {
                tracker._collectDataPoint();
            }

            expect(tracker.tiers.medium.data.length).toBe(3);

            // Manually call _rollupToCoarse with only 3 medium points
            tracker._rollupToCoarse();

            expect(tracker.tiers.coarse.data.length).toBe(0);
        });
    });

    // ============================================================
    // Coverage for lines 301-303: Coarse tier routing rollup
    // ============================================================
    describe('Coarse tier routing rollup', () => {
        test('should include routing data in coarse rollup', () => {
            // Covers lines 301-303: routing rollup in coarse tier
            let routingTotal = 0;
            tracker.statsSource = () => ({ totalRequests: 100, keys: [] });
            tracker.routingSource = () => {
                routingTotal += 10;
                return {
                    total: routingTotal,
                    byTier: { light: routingTotal, medium: routingTotal, heavy: routingTotal },
                    bySource: { failover: routingTotal },
                    burstDampenedTotal: routingTotal
                };
            };

            // 60 ticks = 6 medium = 1 coarse with routing
            for (let i = 0; i < 60; i++) {
                tracker._collectDataPoint();
            }

            expect(tracker.tiers.coarse.data.length).toBe(1);
            const coarse = tracker.tiers.coarse.data.get(0);

            expect(coarse.routing).toBeDefined();
            expect(coarse.routing.total).toBe(600);
            expect(coarse.routing.light).toBe(600);
            expect(coarse.routing.medium).toBe(600);
            expect(coarse.routing.heavy).toBe(600);
            expect(coarse.routing.failover).toBe(600);
            expect(coarse.routing.burstDampenedTotal).toBe(600);
            // Deltas should be summed
            expect(coarse.routing.totalDelta).toBeGreaterThan(0);
        });
    });

    // ============================================================
    // Coverage for line 174: srcObj usage in routing source
    // ============================================================
    describe('Routing source - srcObj handling', () => {
        test('should use bySource from routing stats', () => {
            // Covers line 174: srcObj usage
            tracker.statsSource = () => ({ totalRequests: 100, keys: [] });
            tracker.routingSource = () => ({
                total: 100,
                byTier: { light: 50, medium: 30, heavy: 20 },
                bySource: { rule: 40, classifier: 25, default: 20, failover: 15 },
                burstDampenedTotal: 90
            });

            tracker._collectDataPoint();

            const point = tracker.tiers.fine.data.get(0);
            expect(point.routing.bySource).toEqual({
                rule: 40,
                classifier: 25,
                default: 20,
                failover: 15
            });
        });
    });

    // ============================================================
    // Coverage for lines 220-223: Error handling in _collectDataPoint
    // ============================================================
    describe('_collectDataPoint - error handling', () => {
        test('should catch and log errors when statsSource throws', () => {
            // Covers lines 220-223: catch block in _collectDataPoint
            tracker.statsSource = () => {
                throw new Error('Stats collection failed');
            };

            tracker._collectDataPoint();

            expect(tracker.tiers.fine.data.length).toBe(0);
            expect(mockLogger.error).toHaveBeenCalledWith(
                'Error collecting history point',
                { error: 'Stats collection failed' }
            );
        });
    });

    // ============================================================
    // Coverage for lines 341-361: v2 loading with logger.info
    // ============================================================
    describe('load - v2 format with tiered data', () => {
        test('should load v2 format and log tier counts', () => {
            // Covers lines 341-361: v2 loading path with logger.info
            jest.useRealTimers();
            const now = Date.now();
            const v2Data = {
                schemaVersion: 2,
                interval: 1000,
                lastUpdated: new Date().toISOString(),
                points: {
                    fine: [
                        { timestamp: now - 1000, requests: 10 },
                        { timestamp: now - 500, requests: 20 }
                    ],
                    medium: [
                        { timestamp: now - 10000, requests: 100 }
                    ],
                    coarse: [
                        { timestamp: now - 60000, requests: 500 }
                    ]
                }
            };
            fs.writeFileSync(testHistoryFile, JSON.stringify(v2Data));

            tracker.load();

            expect(tracker.tiers.fine.data.length).toBe(2);
            expect(tracker.tiers.medium.data.length).toBe(1);
            expect(tracker.tiers.coarse.data.length).toBe(1);
            expect(mockLogger.info).toHaveBeenCalledWith(
                'History loaded (v2)',
                { fine: 2, medium: 1, coarse: 1 }
            );

            jest.useFakeTimers();
        });
    });

    // ============================================================
    // Coverage for lines 355-365: Logger.info and catch in load
    // ============================================================
    describe('load - error handling', () => {
        test('should catch JSON parse errors and clear tiers', () => {
            // Covers lines 365-371: catch block in load
            fs.writeFileSync(testHistoryFile, '{ invalid json }');

            tracker.load();

            expect(tracker.tiers.fine.data.length).toBe(0);
            expect(tracker.tiers.medium.data.length).toBe(0);
            expect(tracker.tiers.coarse.data.length).toBe(0);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                'Could not load history',
                expect.any(Object)
            );
        });
    });

    // ============================================================
    // Coverage for line 395: Save error logging in catch
    // ============================================================
    describe('save - error handling', () => {
        test('should log errors when atomic write fails', async () => {
            // Covers line 395: error logging in save catch block
            jest.useRealTimers();

            // Create tracker with invalid path
            const badTracker = new HistoryTracker({
                historyFile: path.join(__dirname, 'invalid\x00path.json'),
                logger: mockLogger
            });

            badTracker.tiers.fine.data.push({ timestamp: Date.now(), requests: 10 });
            badTracker.save();

            // Wait for async error
            await new Promise(r => setTimeout(r, 500));

            expect(mockLogger.error).toHaveBeenCalledWith(
                'Could not save history',
                expect.any(Object)
            );

            jest.useFakeTimers();
        });
    });

    // ============================================================
    // Coverage for line 488: peakLatency calculation when p99Latency missing
    // ============================================================
    describe('getSummary - peakLatency fallback', () => {
        test('should use avgLatency when p99Latency is missing', () => {
            // Covers line 488: peakLatency fallback to avgLatency
            tracker.tiers.fine.data.push({ requests: 10, avgLatency: 300 });
            tracker.tiers.fine.data.push({ requests: 20, avgLatency: 500 });
            tracker.tiers.fine.data.push({ requests: 15, avgLatency: 400 });

            const summary = tracker.getSummary();

            expect(summary.peakLatency).toBe(500);
        });

        test('should prefer p99Latency over avgLatency when available', () => {
            tracker.tiers.fine.data.push({ requests: 10, avgLatency: 300, p99Latency: 800 });
            tracker.tiers.fine.data.push({ requests: 20, avgLatency: 500, p99Latency: 1200 });
            tracker.tiers.fine.data.push({ requests: 15, avgLatency: 600, p99Latency: 900 });

            const summary = tracker.getSummary();

            expect(summary.peakLatency).toBe(1200);
        });
    });

    // ============================================================
    // Coverage for lines 527-544: getCircuitTransitions
    // ============================================================
    describe('getCircuitTransitions', () => {
        test('should return filtered transitions within time range', () => {
            // Covers lines 527-536: getCircuitTransitions function
            const now = Date.now();
            tracker.circuitTransitions.push({
                timestamp: now - (120 * 60 * 1000),
                keyIndex: 0,
                keyPrefix: 'key0',
                fromState: 'CLOSED',
                toState: 'OPEN',
                reason: 'timeout'
            });
            tracker.circuitTransitions.push({
                timestamp: now - (30 * 60 * 1000),
                keyIndex: 1,
                keyPrefix: 'key1',
                fromState: 'OPEN',
                toState: 'HALF_OPEN',
                reason: 'recovery'
            });
            tracker.circuitTransitions.push({
                timestamp: now - 1000,
                keyIndex: 2,
                keyPrefix: 'key2',
                fromState: 'HALF_OPEN',
                toState: 'CLOSED',
                reason: 'success'
            });

            const result = tracker.getCircuitTransitions(60);

            expect(result.minutes).toBe(60);
            expect(result.count).toBe(2);
            expect(result.transitions).toHaveLength(2);
            expect(result.transitions[0].keyIndex).toBe(1);
            expect(result.transitions[1].keyIndex).toBe(2);
        });

        test('should use default 60 minute window', () => {
            tracker.circuitTransitions.push({
                timestamp: Date.now() - 1000,
                keyIndex: 0,
                keyPrefix: 'key',
                fromState: 'CLOSED',
                toState: 'OPEN'
            });

            const result = tracker.getCircuitTransitions();

            expect(result.minutes).toBe(60);
            expect(result.count).toBe(1);
        });

        test('should return empty result when no transitions', () => {
            const result = tracker.getCircuitTransitions(30);

            expect(result.minutes).toBe(30);
            expect(result.count).toBe(0);
            expect(result.transitions).toEqual([]);
        });
    });

    // ============================================================
    // Coverage for lines 544-560: getCircuitTimeline
    // ============================================================
    describe('getCircuitTimeline', () => {
        test('should return timeline with ISO timestamps', () => {
            // Covers lines 544-560: getCircuitTimeline function
            const now = Date.now();
            tracker.circuitTransitions.push({
                timestamp: now - 5000,
                keyIndex: 0,
                keyPrefix: 'key0',
                fromState: 'CLOSED',
                toState: 'OPEN',
                reason: 'timeout'
            });
            tracker.circuitTransitions.push({
                timestamp: now - 1000,
                keyIndex: 1,
                keyPrefix: 'key1',
                fromState: 'OPEN',
                toState: 'HALF_OPEN',
                reason: 'recovery'
            });

            const timeline = tracker.getCircuitTimeline(null, 60);

            expect(timeline).toHaveLength(2);
            expect(timeline[0].time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
            expect(timeline[0].keyIndex).toBe(0);
            expect(timeline[0].keyPrefix).toBe('key0');
            expect(timeline[0].from).toBe('CLOSED');
            expect(timeline[0].to).toBe('OPEN');
            expect(timeline[0].reason).toBe('timeout');
            expect(timeline[1].from).toBe('OPEN');
            expect(timeline[1].to).toBe('HALF_OPEN');
        });

        test('should filter by keyIndex when provided', () => {
            const now = Date.now();
            tracker.circuitTransitions.push({
                timestamp: now - 5000,
                keyIndex: 0,
                keyPrefix: 'key0',
                fromState: 'CLOSED',
                toState: 'OPEN'
            });
            tracker.circuitTransitions.push({
                timestamp: now - 4000,
                keyIndex: 1,
                keyPrefix: 'key1',
                fromState: 'CLOSED',
                toState: 'OPEN'
            });
            tracker.circuitTransitions.push({
                timestamp: now - 1000,
                keyIndex: 0,
                keyPrefix: 'key0',
                fromState: 'OPEN',
                toState: 'HALF_OPEN'
            });

            const timeline = tracker.getCircuitTimeline(0, 60);

            expect(timeline).toHaveLength(2);
            expect(timeline.every(t => t.keyIndex === 0)).toBe(true);
        });

        test('should filter by time range', () => {
            const now = Date.now();
            tracker.circuitTransitions.push({
                timestamp: now - (120 * 60 * 1000),
                keyIndex: 0,
                keyPrefix: 'key',
                fromState: 'CLOSED',
                toState: 'OPEN'
            });
            tracker.circuitTransitions.push({
                timestamp: now - 1000,
                keyIndex: 0,
                keyPrefix: 'key',
                fromState: 'OPEN',
                toState: 'HALF_OPEN'
            });

            const timeline = tracker.getCircuitTimeline(null, 60);

            expect(timeline).toHaveLength(1);
            expect(timeline[0].from).toBe('OPEN');
        });

        test('should return empty array when no transitions', () => {
            const timeline = tracker.getCircuitTimeline(null, 60);

            expect(timeline).toEqual([]);
        });
    });

    // ============================================================
    // Coverage for lines 567-573: getCurrentCircuitStates
    // ============================================================
    describe('getCurrentCircuitStates', () => {
        test('should return states for all keys with uppercase conversion', () => {
            // Covers lines 567-573: getCurrentCircuitStates function
            const keys = [
                { index: 0, keyPrefix: 'key0', state: 'closed' },
                { index: 1, keyPrefix: 'key1', state: 'open' },
                { index: 2, keyPrefix: 'key2', circuitBreaker: { state: 'half_open' } },
                { index: 3, keyPrefix: 'key3', circuitBreaker: { state: 'CLOSED' } }
            ];

            const states = tracker.getCurrentCircuitStates(keys);

            expect(states).toHaveLength(4);
            expect(states[0]).toEqual({ index: 0, keyPrefix: 'key0', state: 'CLOSED' });
            expect(states[1]).toEqual({ index: 1, keyPrefix: 'key1', state: 'OPEN' });
            expect(states[2]).toEqual({ index: 2, keyPrefix: 'key2', state: 'HALF_OPEN' });
            expect(states[3]).toEqual({ index: 3, keyPrefix: 'key3', state: 'CLOSED' });
        });

        test('should default to CLOSED when state is missing', () => {
            const keys = [
                { index: 0, keyPrefix: 'key0' },
                { index: 1, keyPrefix: 'key1', otherProp: 'value' }
            ];

            const states = tracker.getCurrentCircuitStates(keys);

            expect(states).toHaveLength(2);
            expect(states[0].state).toBe('CLOSED');
            expect(states[1].state).toBe('CLOSED');
        });

        test('should return empty array for empty keys', () => {
            const states = tracker.getCurrentCircuitStates([]);

            expect(states).toEqual([]);
        });
    });
});
