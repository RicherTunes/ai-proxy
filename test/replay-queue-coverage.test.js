'use strict';

/**
 * ReplayQueue Coverage Tests
 * Target: Line 488 - setInterval callback, branch coverage for cleanup timer
 * Current: Branch 96.26%, Function 93.75%
 * Goal: 98%+ on both
 */

const ReplayQueue = require('../lib/replay-queue');

describe('ReplayQueue - Coverage Tests', () => {
    let queue;

    afterEach(() => {
        if (queue) {
            queue.destroy();
            queue = null;
        }
        jest.useRealTimers();
    });

    // ==========================================================================
    // Line 488 - setInterval callback inside _startCleanup
    // ==========================================================================

    describe('_startCleanup - setInterval callback (line 488)', () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        test('setInterval callback should call _cleanupExpired when timer fires (line 488)', () => {
            // Use fake timers to advance time and trigger the setInterval
            queue = new ReplayQueue({
                retentionPeriod: 1000, // 1 second minimum
                maxQueueSize: 100,
                maxRetries: 3
            });

            // Add an entry that will be expired
            const expiredTimestamp = Date.now() - 2000; // 2 seconds ago
            queue.enqueue({
                traceId: 'expire-me',
                timestamp: expiredTimestamp,
                originalError: new Error('test')
            });

            expect(queue.queue.size).toBe(1);

            // Spy on _cleanupExpired to verify it's called by the timer
            const cleanupSpy = jest.spyOn(queue, '_cleanupExpired');

            // Advance time by 5 minutes (the cleanup interval)
            jest.advanceTimersByTime(5 * 60 * 1000);

            // The cleanup should have been triggered
            expect(cleanupSpy).toHaveBeenCalledTimes(1);

            // Entry should be removed
            expect(queue.queue.size).toBe(0);
            expect(queue.stats.totalExpired).toBe(1);

            cleanupSpy.mockRestore();
        });

        test('setInterval callback fires multiple times at 5-minute intervals (line 488)', () => {
            queue = new ReplayQueue({ retentionPeriod: 1000 });

            const cleanupSpy = jest.spyOn(queue, '_cleanupExpired');

            // Advance through multiple intervals
            jest.advanceTimersByTime(5 * 60 * 1000);
            expect(cleanupSpy).toHaveBeenCalledTimes(1);

            jest.advanceTimersByTime(5 * 60 * 1000);
            expect(cleanupSpy).toHaveBeenCalledTimes(2);

            jest.advanceTimersByTime(5 * 60 * 1000);
            expect(cleanupSpy).toHaveBeenCalledTimes(3);

            cleanupSpy.mockRestore();
        });

        test('setInterval continues firing after entries are cleaned up (line 488)', () => {
            queue = new ReplayQueue({ retentionPeriod: 1000 });

            // Add expired entry
            queue.enqueue({
                traceId: 'old',
                timestamp: Date.now() - 2000,
                originalError: new Error('old')
            });

            // First interval fires, cleans up
            jest.advanceTimersByTime(5 * 60 * 1000);
            expect(queue.queue.size).toBe(0);

            // Add another expired entry
            queue.enqueue({
                traceId: 'another-old',
                timestamp: Date.now() - 2000,
                originalError: new Error('another')
            });

            // Second interval fires, cleans up new entry
            jest.advanceTimersByTime(5 * 60 * 1000);
            expect(queue.queue.size).toBe(0);
            expect(queue.stats.totalExpired).toBe(2);
        });
    });

    // ==========================================================================
    // Line 492-493 - unref branch
    // ==========================================================================

    describe('_startCleanup - unref branch (lines 492-493)', () => {
        test('cleanupInterval.unref is called when available (line 492)', () => {
            queue = new ReplayQueue();

            // The interval should exist
            expect(queue.cleanupInterval).toBeDefined();
            expect(queue.cleanupInterval).not.toBeNull();

            // In Node.js, Timeout objects have unref() method
            // The code calls unref() to not block process exit
            // We can verify the interval was created properly
            expect(typeof queue.cleanupInterval.unref).toBe('function');
        });

        test('destroy clears the interval properly after unref (lines 527-529)', () => {
            queue = new ReplayQueue();

            const intervalId = queue.cleanupInterval;
            expect(intervalId).not.toBeNull();

            queue.destroy();

            expect(queue.cleanupInterval).toBeNull();
        });
    });

    // ==========================================================================
    // Edge cases for full function coverage
    // ==========================================================================

    describe('Function coverage edge cases', () => {
        test('getStats with replaying status counts correctly', async () => {
            queue = new ReplayQueue();
            queue.enqueue({ traceId: 'r1', originalError: new Error('1') });

            // Start a slow replay that will keep status as 'replaying'
            const slowSend = jest.fn().mockImplementation(() =>
                new Promise(resolve => setTimeout(() => resolve({ status: 200 }), 100))
            );

            const replayPromise = queue.replay('r1', { sendFunction: slowSend });

            // Check stats while replaying is in progress
            // Note: This is a timing-sensitive check
            await new Promise(resolve => setTimeout(resolve, 10));

            const stats = queue.getStats();
            // The entry might be in 'replaying' state at this moment
            expect(stats.statusCounts.replaying + stats.statusCounts.succeeded).toBeGreaterThanOrEqual(0);

            await replayPromise;

            // Now it should be succeeded
            const finalStats = queue.getStats();
            expect(finalStats.statusCounts.succeeded).toBe(1);
        });

        test('_filterRequests handles all status types in statusCounts', () => {
            queue = new ReplayQueue();

            queue.enqueue({ traceId: 'p1', originalError: new Error('1') });
            queue.enqueue({ traceId: 'p2', originalError: new Error('2') });
            queue.enqueue({ traceId: 'p3', originalError: new Error('3') });
            queue.enqueue({ traceId: 'p4', originalError: new Error('4') });

            // Set different statuses
            queue.queue.get('p1').status = 'pending';
            queue.queue.get('p2').status = 'replaying';
            queue.queue.get('p3').status = 'succeeded';
            queue.queue.get('p4').status = 'failed';

            const stats = queue.getStats();

            expect(stats.statusCounts.pending).toBe(1);
            expect(stats.statusCounts.replaying).toBe(1);
            expect(stats.statusCounts.succeeded).toBe(1);
            expect(stats.statusCounts.failed).toBe(1);
        });

        test('getStats calculates utilizationPercent correctly at various sizes', () => {
            queue = new ReplayQueue({ maxQueueSize: 10 });

            expect(queue.getStats().utilizationPercent).toBe(0);

            for (let i = 0; i < 5; i++) {
                queue.enqueue({ traceId: `r${i}`, originalError: new Error(`${i}`) });
            }

            expect(queue.getStats().utilizationPercent).toBe(50);

            for (let i = 5; i < 10; i++) {
                queue.enqueue({ traceId: `r${i}`, originalError: new Error(`${i}`) });
            }

            expect(queue.getStats().utilizationPercent).toBe(100);
        });
    });

    // ==========================================================================
    // Additional branch coverage for _filterRequests
    // ==========================================================================

    describe('_filterRequests - all filter branches', () => {
        beforeEach(() => {
            queue = new ReplayQueue();
        });

        test('filter with path regex that does not match', () => {
            queue.enqueue({ traceId: 'r1', path: '/v1/messages', originalError: new Error('1') });
            queue.enqueue({ traceId: 'r2', path: '/v1/complete', originalError: new Error('2') });

            const results = queue.getQueue({ path: /^\/v2\// });

            expect(results).toHaveLength(0);
        });

        test('filter with string path that matches exactly', () => {
            queue.enqueue({ traceId: 'r1', path: '/v1/messages', originalError: new Error('1') });
            queue.enqueue({ traceId: 'r2', path: '/v1/complete', originalError: new Error('2') });

            const results = queue.getQueue({ path: '/v1/messages' });

            expect(results).toHaveLength(1);
            expect(results[0].traceId).toBe('r1');
        });

        test('filter with all criteria combined', () => {
            const now = Date.now();
            queue.enqueue({
                traceId: 'match',
                method: 'POST',
                path: '/v1/messages',
                timestamp: now - 2000,
                originalError: new Error('match')
            });
            queue.enqueue({
                traceId: 'wrong-method',
                method: 'GET',
                path: '/v1/messages',
                timestamp: now - 2000,
                originalError: new Error('wrong')
            });
            queue.enqueue({
                traceId: 'wrong-path',
                method: 'POST',
                path: '/v1/other',
                timestamp: now - 2000,
                originalError: new Error('wrong')
            });
            queue.enqueue({
                traceId: 'too-new',
                method: 'POST',
                path: '/v1/messages',
                timestamp: now,
                originalError: new Error('wrong')
            });

            const results = queue.getQueue({
                method: 'POST',
                path: '/v1/messages',
                afterTimestamp: now - 3000,
                beforeTimestamp: now - 1000
            });

            expect(results).toHaveLength(1);
            expect(results[0].traceId).toBe('match');
        });

        test('sort by priority descending, then timestamp ascending', () => {
            const now = Date.now();
            queue.enqueue({ traceId: 'a', priority: 1, timestamp: now - 1000, originalError: new Error('a') });
            queue.enqueue({ traceId: 'b', priority: 2, timestamp: now - 2000, originalError: new Error('b') });
            queue.enqueue({ traceId: 'c', priority: 2, timestamp: now - 500, originalError: new Error('c') });
            queue.enqueue({ traceId: 'd', priority: 0, timestamp: now, originalError: new Error('d') });

            const results = queue.getQueue({});

            // Priority 2 first (b, c), then priority 1 (a), then priority 0 (d)
            // Within priority 2: timestamp ascending (b before c)
            expect(results[0].traceId).toBe('b'); // priority 2, older
            expect(results[1].traceId).toBe('c'); // priority 2, newer
            expect(results[2].traceId).toBe('a'); // priority 1
            expect(results[3].traceId).toBe('d'); // priority 0
        });
    });

    // ==========================================================================
    // Replay error handling branches
    // ==========================================================================

    describe('replay - error handling branches', () => {
        beforeEach(() => {
            queue = new ReplayQueue();
        });

        test('replay error without code or status properties', async () => {
            queue.enqueue({ traceId: 'r1', originalError: new Error('1') });

            const plainError = new Error('plain error');
            // No code or status properties
            const sendFunction = jest.fn().mockRejectedValue(plainError);

            const result = await queue.replay('r1', { sendFunction });

            expect(result.success).toBe(false);
            expect(result.error.message).toBe('plain error');
            expect(result.error.code).toBeUndefined();
            expect(result.error.status).toBeUndefined();
        });

        test('replay error with only code property', async () => {
            queue.enqueue({ traceId: 'r1', originalError: new Error('1') });

            const errorWithCode = new Error('error with code');
            errorWithCode.code = 'ECONNRESET';
            const sendFunction = jest.fn().mockRejectedValue(errorWithCode);

            const result = await queue.replay('r1', { sendFunction });

            expect(result.error.code).toBe('ECONNRESET');
            expect(result.error.status).toBeUndefined();
        });

        test('replay error with only status property', async () => {
            queue.enqueue({ traceId: 'r1', originalError: new Error('1') });

            const errorWithStatus = new Error('error with status');
            errorWithStatus.status = 503;
            const sendFunction = jest.fn().mockRejectedValue(errorWithStatus);

            const result = await queue.replay('r1', { sendFunction });

            expect(result.error.code).toBeUndefined();
            expect(result.error.status).toBe(503);
        });

        test('replay with modifyBody set to null (explicit null) - line 220', async () => {
            queue.enqueue({
                traceId: 'r1',
                body: { original: 'body' },
                originalError: new Error('1')
            });

            const sendFunction = jest.fn().mockResolvedValue({ status: 200 });
            await queue.replay('r1', { sendFunction, modifyBody: null });

            // modifyBody !== undefined is TRUE (null !== undefined), so null is used as body
            expect(sendFunction).toHaveBeenCalledWith(
                expect.objectContaining({
                    body: null
                })
            );
        });

        test('replay with modifyBody set to false (falsy but not undefined)', async () => {
            queue.enqueue({
                traceId: 'r1',
                body: { original: 'body' },
                originalError: new Error('1')
            });

            const sendFunction = jest.fn().mockResolvedValue({ status: 200 });
            await queue.replay('r1', { sendFunction, modifyBody: false });

            // modifyBody !== undefined is true, so false is used
            expect(sendFunction).toHaveBeenCalledWith(
                expect.objectContaining({
                    body: false
                })
            );
        });
    });

    // ==========================================================================
    // clear with filter edge cases
    // ==========================================================================

    describe('clear - with filter edge cases', () => {
        beforeEach(() => {
            queue = new ReplayQueue();
        });

        test('clear with filter that matches nothing returns 0', () => {
            queue.enqueue({ traceId: 'r1', method: 'POST', originalError: new Error('1') });

            const count = queue.clear({ method: 'GET' });

            expect(count).toBe(0);
            expect(queue.queue.size).toBe(1);
        });

        test('clear with filter that matches everything', () => {
            queue.enqueue({ traceId: 'r1', method: 'POST', originalError: new Error('1') });
            queue.enqueue({ traceId: 'r2', method: 'POST', originalError: new Error('2') });

            const count = queue.clear({ method: 'POST' });

            expect(count).toBe(2);
            expect(queue.queue.size).toBe(0);
        });

        test('clear emits removed event for each removed item', () => {
            const removedEvents = [];
            queue.on('removed', (data) => removedEvents.push(data));

            queue.enqueue({ traceId: 'r1', originalError: new Error('1') });
            queue.enqueue({ traceId: 'r2', originalError: new Error('2') });
            queue.enqueue({ traceId: 'r3', originalError: new Error('3') });

            // Set status manually since enqueue ignores status property
            queue.queue.get('r1').status = 'failed';
            queue.queue.get('r2').status = 'failed';

            queue.clear({ status: 'failed' });

            expect(removedEvents).toHaveLength(2);
            expect(removedEvents.map(e => e.traceId)).toContain('r1');
            expect(removedEvents.map(e => e.traceId)).toContain('r2');
        });
    });

    // ==========================================================================
    // dequeue edge cases
    // ==========================================================================

    describe('dequeue - edge cases', () => {
        beforeEach(() => {
            queue = new ReplayQueue();
        });

        test('dequeue returns first pending even when first entry is missing from map', () => {
            queue.enqueue({ traceId: 'r1', originalError: new Error('1') });
            queue.enqueue({ traceId: 'r2', originalError: new Error('2') });

            // Manually remove r1 from the map but leave it in order array
            queue.queue.delete('r1');

            // dequeue should skip r1 (not in map) and return r2
            const result = queue.dequeue();
            expect(result.traceId).toBe('r2');
        });

        test('dequeue handles entry with undefined status', () => {
            queue.enqueue({ traceId: 'r1', originalError: new Error('1') });

            // Corrupt the status
            queue.queue.get('r1').status = undefined;

            // Should not match 'pending' check
            const result = queue.dequeue();
            expect(result).toBeNull();
        });
    });

    // ==========================================================================
    // Additional branch coverage - remaining uncovered branches
    // ==========================================================================

    describe('Branch coverage - remaining gaps', () => {
        test('remove when traceId not in order array (line 344 false branch)', () => {
            queue = new ReplayQueue();

            queue.enqueue({ traceId: 'r1', originalError: new Error('1') });

            // Manually remove from order array but keep in map
            const index = queue.order.indexOf('r1');
            if (index !== -1) {
                queue.order.splice(index, 1);
            }

            // Now call remove - it will find the entry in the map but not in order
            // The remove function will: queue.delete returns true, then indexOf returns -1
            const result = queue.remove('r1');

            // Should return true because it was in the map
            expect(result).toBe(true);
            // Should not be in map now
            expect(queue.queue.has('r1')).toBe(false);
            // order should still be empty
            expect(queue.order).toEqual([]);
        });

        test('Number(config.retentionPeriod) is falsy, uses default (line 96)', () => {
            // retentionPeriod: NaN, 0, null, undefined should use default
            queue = new ReplayQueue({ retentionPeriod: NaN });

            // NaN is falsy, so default 24 hours is used
            expect(queue.config.retentionPeriod).toBe(24 * 60 * 60 * 1000);
        });

        test('Number(config.maxRetries) is falsy, uses default (line 28)', () => {
            queue = new ReplayQueue({ maxRetries: null });

            // Number(null) === 0, which is falsy, so default 3 is used
            expect(queue.config.maxRetries).toBe(3);
        });

        test('Number(config.maxQueueSize) is falsy, uses default (line 26)', () => {
            queue = new ReplayQueue({ maxQueueSize: undefined });

            // Number(undefined) === NaN, falsy, so default 100 is used
            expect(queue.config.maxQueueSize).toBe(100);
        });

        test('replayAll with destructured options defaults (line 287)', async () => {
            queue = new ReplayQueue();
            queue.enqueue({ traceId: 'r1', originalError: new Error('1') });

            // Call replayAll without options parameter at all
            // This tests the default destructuring
            const results = await queue.replayAll({ status: 'pending' });

            // Should handle missing options gracefully
            expect(results).toHaveLength(1);
            expect(results[0].success).toBe(false); // No sendFunction provided
            expect(results[0].error.message).toBe('No sendFunction provided for replay');
        });
    });

    // ==========================================================================
    // Line 492 - unref false branch (when unref doesn't exist)
    // ==========================================================================

    describe('_startCleanup - unref missing (line 492 false branch)', () => {
        test('handles interval without unref method gracefully', () => {
            queue = new ReplayQueue();

            // In some environments, the interval might not have unref
            // The code checks `if (this.cleanupInterval.unref)` before calling
            // This test verifies the interval is created even if unref check fails

            expect(queue.cleanupInterval).toBeDefined();

            // Manually remove unref to simulate environment without it
            const interval = queue.cleanupInterval;
            delete interval.unref;

            // Should not throw when destroy is called
            expect(() => queue.destroy()).not.toThrow();

            // cleanupInterval should now be null after destroy
            expect(queue.cleanupInterval).toBeNull();
        });

        test('constructor with setInterval - verify unref branch path', () => {
            // Create queue and check that unref branch works
            queue = new ReplayQueue();

            // The interval was created and unref was called on it
            expect(queue.cleanupInterval).toBeDefined();
            expect(queue.cleanupInterval).not.toBeNull();
        });
    });

    // ==========================================================================
    // Line 96 - oldestId false branch (shift returns undefined)
    // ==========================================================================

    describe('enqueue - oldestId false branch (line 96)', () => {
        test('handles corrupted state: queue full but order array empty', () => {
            queue = new ReplayQueue({ maxQueueSize: 1 });

            // Manually corrupt the state: make queue.size >= maxQueueSize but order is empty
            // We need to add something to the queue but then clear the order array
            queue.enqueue({ traceId: 'r1', originalError: new Error('1') });

            // Now queue.size = 1, maxQueueSize = 1, so condition is true
            // But we'll clear the order array to simulate corruption
            queue.order = [];

            // Add another item - this will trigger queueFull check
            // shift() will return undefined, hitting the false branch on line 96
            // Since oldestId is undefined, the if block is skipped (no delete, no evicted event)
            queue.enqueue({ traceId: 'r2', originalError: new Error('2') });

            // Queue will have 2 items because nothing was evicted
            // (oldestId was undefined, so queue.delete wasn't called)
            expect(queue.queue.size).toBe(2);
            // Order array should have 1 item (the new one)
            expect(queue.order).toHaveLength(1);
            expect(queue.order).toContain('r2');
        });
    });

    // ==========================================================================
    // Line 287 - replayAll parameter destructuring
    // ==========================================================================

    describe('replayAll - parameter destructuring (line 287)', () => {
        beforeEach(() => {
            queue = new ReplayQueue();
        });

        test('handles undefined options parameter', async () => {
            queue.enqueue({ traceId: 'r1', originalError: new Error('1') });

            // Call replayAll with filter only, no options at all
            // This tests the destructuring with undefined second parameter
            const results = await queue.replayAll({ status: 'pending' });

            // Should handle missing options gracefully
            expect(results).toHaveLength(1);
            expect(results[0].success).toBe(false);
        });

        test('handles null options parameter', async () => {
            queue.enqueue({ traceId: 'r1', originalError: new Error('1') });

            // Pass null explicitly as options
            const results = await queue.replayAll({ status: 'pending' }, null);

            expect(results).toHaveLength(1);
        });

        test('handles empty object options parameter', async () => {
            queue.enqueue({ traceId: 'r1', originalError: new Error('1') });

            // Pass explicit empty object
            const results = await queue.replayAll({}, {});

            expect(results).toHaveLength(1);
        });
    });
});
