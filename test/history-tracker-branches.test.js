/**
 * History Tracker Branch Coverage Tests
 *
 * Targeted tests for uncovered branches in lib/history-tracker.js:
 * - Lines 106-107: destroy() method and destroyed flag
 */

const { HistoryTracker } = require('../lib/history-tracker');
const path = require('path');
const os = require('os');
const fs = require('fs');

describe('HistoryTracker - destroy method coverage', () => {
    let tracker;
    let mockLogger;
    const testHistoryFile = path.join(os.tmpdir(), 'test-destroy-history.json');

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
        jest.useRealTimers();
        // Clean up test file
        if (fs.existsSync(testHistoryFile)) {
            fs.unlinkSync(testHistoryFile);
        }
    });

    test('should set destroyed flag to true', async () => {
        expect(tracker.destroyed).toBeUndefined();

        // Test lines 106-107: destroyed flag assignment
        await tracker.destroy();

        expect(tracker.destroyed).toBe(true);
    });

    test('should call stop() when destroyed', async () => {
        const mockStatsSource = jest.fn(() => ({ totalRequests: 100 }));
        tracker.start(mockStatsSource);

        expect(tracker.collectTimer).not.toBeNull();
        expect(tracker.saveTimer).not.toBeNull();

        await tracker.destroy();

        expect(tracker.collectTimer).toBeNull();
        expect(tracker.saveTimer).toBeNull();
        expect(tracker.destroyed).toBe(true);
    });

    test('should save final state before destroying', async () => {
        jest.useRealTimers();

        const realTracker = new HistoryTracker({
            interval: 100,
            maxPoints: 10,
            historyFile: testHistoryFile,
            saveInterval: 1000,
            logger: mockLogger
        });

        realTracker.statsSource = () => ({ totalRequests: 100 });
        realTracker._collectDataPoint();

        await realTracker.destroy();

        // Poll for file existence with timeout (more robust than fixed wait)
        const maxWait = 2000;
        const pollInterval = 50;
        let elapsed = 0;
        while (!fs.existsSync(testHistoryFile) && elapsed < maxWait) {
            await new Promise(r => setTimeout(r, pollInterval));
            elapsed += pollInterval;
        }

        expect(fs.existsSync(testHistoryFile)).toBe(true);
        expect(realTracker.destroyed).toBe(true);

        jest.useFakeTimers();
    });

    test('should be idempotent - can call destroy multiple times', async () => {
        const mockStatsSource = jest.fn(() => ({ totalRequests: 100 }));
        tracker.start(mockStatsSource);

        await tracker.destroy();
        expect(tracker.destroyed).toBe(true);

        // Call destroy again - should not throw
        await tracker.destroy();
        expect(tracker.destroyed).toBe(true);
    });

    test('should work when called without starting tracker', async () => {
        // Tracker never started
        expect(tracker.collectTimer).toBeNull();
        expect(tracker.saveTimer).toBeNull();

        await tracker.destroy();

        expect(tracker.destroyed).toBe(true);
    });

    test('destroyed flag persists after destroy', async () => {
        tracker.statsSource = () => ({ totalRequests: 50 });
        tracker._collectDataPoint();

        expect(tracker.points.fine.length).toBe(1);

        await tracker.destroy();

        expect(tracker.destroyed).toBe(true);

        // Try to collect more data - destroyed flag is set
        tracker._collectDataPoint();

        // Flag should still be true
        expect(tracker.destroyed).toBe(true);
    });
});
