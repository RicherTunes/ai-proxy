/**
 * History Tracker Tier Validation Tests
 * Tests for backend-to-frontend data validation
 */

const { HistoryTracker } = require('../lib/history-tracker');
const fs = require('fs');
const path = require('path');

describe('HistoryTracker Tier Validation', () => {
    let tracker;
    let testDir;
    let mockLogger;

    beforeEach(() => {
        testDir = path.join(__dirname, `temp-validation-${Date.now()}`);
        if (!fs.existsSync(testDir)) {
            fs.mkdirSync(testDir, { recursive: true });
        }

        mockLogger = {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        };

        tracker = new HistoryTracker({
            interval: 100,
            maxPoints: 100,
            historyFile: path.join(testDir, 'validation-test.json'),
            saveInterval: 5000,
            maxTransitions: 100,
            logger: mockLogger
        });
    });

    afterEach(() => {
        tracker.stop();
        if (fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    describe('tier metadata', () => {
        test('should return tier metadata for fine tier', () => {
            // Add some fine points
            const now = Date.now();
            for (let i = 0; i < 50; i++) {
                tracker.points.fine.push({
                    timestamp: now - (i * 1000),
                    requests: i,
                    errorRate: i % 10
                });
            }

            const result = tracker.getHistory(5); // 5 minutes -> fine tier

            expect(result.tier).toBe('fine');
            expect(result.tierResolution).toBe(1);
            expect(result.expectedInterval).toBe(100);
        });

        test('should return tier metadata for medium tier', () => {
            // Add some medium points
            const now = Date.now();
            for (let i = 0; i < 50; i++) {
                tracker.points.medium.push({
                    timestamp: now - (i * 10000),
                    requests: i * 10,
                    errorRate: i % 10
                });
            }

            const result = tracker.getHistory(120); // 120 minutes -> medium tier

            expect(result.tier).toBe('medium');
            expect(result.tierResolution).toBe(10);
            expect(result.expectedInterval).toBe(1000);
        });

        test('should return tier metadata for coarse tier', () => {
            // Add some coarse points
            const now = Date.now();
            for (let i = 0; i < 50; i++) {
                tracker.points.coarse.push({
                    timestamp: now - (i * 60000),
                    requests: i * 60,
                    errorRate: i % 10
                });
            }

            const result = tracker.getHistory(2000); // 2000 minutes -> coarse tier

            expect(result.tier).toBe('coarse');
            expect(result.tierResolution).toBe(60);
            expect(result.expectedInterval).toBe(6000);
        });

        test('should calculate expected point count correctly', () => {
            const now = Date.now();
            // Add 30 seconds of fine data
            for (let i = 0; i < 30; i++) {
                tracker.points.fine.push({
                    timestamp: now - (i * 1000),
                    requests: i
                });
            }

            const result = tracker.getHistory(0.5); // 0.5 minutes = 30 seconds

            // Expected: 30 points (30 seconds / 1 second resolution)
            expect(result.expectedPointCount).toBe(30);
            expect(result.actualPointCount).toBe(30);
        });

        test('should report data age for most recent point', () => {
            const now = Date.now();
            tracker.points.fine.push({
                timestamp: now - 5000, // 5 seconds ago
                requests: 10
            });

            const result = tracker.getHistory(1);

            expect(result.dataAgeMs).toBeGreaterThanOrEqual(5000);
            expect(result.dataAgeMs).toBeLessThan(6000);
        });

        test('should report infinite data age when no points', () => {
            const result = tracker.getHistory(1);

            expect(result.dataAgeMs).toBe(Infinity);
        });
    });

    describe('downsampling behavior', () => {
        test('should not downsample if under 1000 points', () => {
            const now = Date.now();
            // Add 500 points
            for (let i = 0; i < 500; i++) {
                tracker.points.fine.push({
                    timestamp: now - (i * 1000),
                    requests: i
                });
            }

            const result = tracker.getHistory(10);

            expect(result.pointCount).toBe(500);
            expect(result.points.length).toBe(500);
        });

        test('should downsample if over 1000 points', () => {
            const now = Date.now();
            // Add 1500 points
            for (let i = 0; i < 1500; i++) {
                tracker.points.fine.push({
                    timestamp: now - (i * 1000),
                    requests: i
                });
            }

            const result = tracker.getHistory(30);

            // Should be downsampled to ~1000 points
            expect(result.actualPointCount).toBe(1500);
            expect(result.pointCount).toBeLessThanOrEqual(1000);
            expect(result.pointCount).toBeGreaterThan(500);
        });
    });

    describe('tier selection accuracy', () => {
        test('should select fine tier for <= 60 minutes', () => {
            expect(tracker.getHistory(1).tier).toBe('fine');
            expect(tracker.getHistory(30).tier).toBe('fine');
            expect(tracker.getHistory(60).tier).toBe('fine');
        });

        test('should select medium tier for 61 to 1440 minutes', () => {
            expect(tracker.getHistory(61).tier).toBe('medium');
            expect(tracker.getHistory(500).tier).toBe('medium');
            expect(tracker.getHistory(1440).tier).toBe('medium');
        });

        test('should select coarse tier for > 1440 minutes', () => {
            expect(tracker.getHistory(1441).tier).toBe('coarse');
            expect(tracker.getHistory(2880).tier).toBe('coarse');
            expect(tracker.getHistory(10080).tier).toBe('coarse');
        });
    });

    describe('data integrity', () => {
        test('should include schema version in response', () => {
            const result = tracker.getHistory(5);

            expect(result.schemaVersion).toBe(2);
        });

        test('should return requested minutes in response', () => {
            const result = tracker.getHistory(15);

            expect(result.minutes).toBe(15);
        });

        test('should handle empty data gracefully', () => {
            const result = tracker.getHistory(5);

            expect(result.points).toEqual([]);
            expect(result.pointCount).toBe(0);
        });
    });
});
