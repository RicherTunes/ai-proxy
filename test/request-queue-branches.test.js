/**
 * Tests targeting uncovered branches in RequestQueue
 * Lines: 116, 142, 168, 202
 */

const { RequestQueue } = require('../lib/request-queue');

describe('RequestQueue - Branch Coverage', () => {
    let queue;

    beforeEach(() => {
        queue = new RequestQueue({
            maxSize: 5,
            timeout: 1000
        });
    });

    afterEach(() => {
        queue.clear('test cleanup');
    });

    describe('_handleTimeout - line 116 (already dequeued)', () => {
        test('should handle timeout firing after entry already dequeued', async () => {
            // This tests the "if (index === -1) return;" branch at line 116
            const q = new RequestQueue({ maxSize: 5, timeout: 100 });

            const promise = q.enqueue('req-1');

            // Dequeue immediately before timeout fires
            q.signalSlotAvailable();

            const result = await promise;
            expect(result.success).toBe(true);

            // Wait for timeout to fire - should hit the index === -1 branch
            await new Promise(resolve => setTimeout(resolve, 150));

            // Should not affect metrics or throw error
            expect(q.length).toBe(0);
        });
    });

    describe('signalSlotAvailable - line 142 (timeoutHandle check)', () => {
        test('should clear timeout handle when dequeuing', async () => {
            const promise = queue.enqueue('req-1');

            // Entry will have a timeoutHandle
            const dequeued = queue.signalSlotAvailable();

            expect(dequeued).toBe(true);
            const result = await promise;
            expect(result.success).toBe(true);

            // Timeout handle should have been cleared (line 142-144 executed)
            // We verify by waiting past timeout - should not cause issues
            await new Promise(resolve => setTimeout(resolve, 1100));
            expect(queue.getStats().metrics.totalTimedOut).toBe(0);
        });

        test('should handle entry without timeout handle', async () => {
            // Create an entry and manually clear its timeout
            const promise = queue.enqueue('req-1');

            // Access the internal queue entry and clear timeout
            const entry = queue.queue[0];
            if (entry.timeoutHandle) {
                clearTimeout(entry.timeoutHandle);
                entry.timeoutHandle = null;
            }

            // Should still dequeue successfully even with null timeoutHandle
            queue.signalSlotAvailable();
            const result = await promise;
            expect(result.success).toBe(true);
        });
    });

    describe('cancel - line 168 (timeoutHandle check)', () => {
        test('should clear timeout handle when cancelling', async () => {
            const promise = queue.enqueue('cancel-req');

            // Entry will have a timeoutHandle
            const cancelled = queue.cancel('cancel-req');

            expect(cancelled).toBe(true);
            const result = await promise;
            expect(result.success).toBe(false);
            expect(result.reason).toBe('cancelled');

            // Timeout handle should have been cleared (line 168-170 executed)
            // Verify by waiting past timeout
            await new Promise(resolve => setTimeout(resolve, 1100));
            expect(queue.getStats().metrics.totalTimedOut).toBe(0);
        });

        test('should handle entry without timeout handle in cancel', async () => {
            const promise = queue.enqueue('cancel-req');

            // Manually clear timeout handle
            const entry = queue.queue[0];
            if (entry.timeoutHandle) {
                clearTimeout(entry.timeoutHandle);
                entry.timeoutHandle = null;
            }

            // Should still cancel successfully
            const cancelled = queue.cancel('cancel-req');
            expect(cancelled).toBe(true);

            const result = await promise;
            expect(result.success).toBe(false);
        });
    });

    describe('clear - line 202 (timeoutHandle check)', () => {
        test('should clear timeout handles for all entries', async () => {
            const promises = [
                queue.enqueue('req-1'),
                queue.enqueue('req-2'),
                queue.enqueue('req-3')
            ];

            expect(queue.length).toBe(3);

            // All entries will have timeout handles
            queue.clear('shutdown');

            const results = await Promise.all(promises);
            results.forEach(result => {
                expect(result.success).toBe(false);
                expect(result.reason).toBe('shutdown');
            });

            // All timeout handles should have been cleared (line 202-204 executed)
            expect(queue.length).toBe(0);

            // Wait past timeout - no timeouts should fire
            await new Promise(resolve => setTimeout(resolve, 1100));
            expect(queue.getStats().metrics.totalTimedOut).toBe(0);
        });

        test('should handle entries without timeout handles in clear', async () => {
            const promises = [
                queue.enqueue('req-1'),
                queue.enqueue('req-2')
            ];

            // Manually clear timeout handles from entries
            queue.queue.forEach(entry => {
                if (entry.timeoutHandle) {
                    clearTimeout(entry.timeoutHandle);
                    entry.timeoutHandle = null;
                }
            });

            // Should still clear successfully
            queue.clear('test');

            const results = await Promise.all(promises);
            results.forEach(result => {
                expect(result.success).toBe(false);
                expect(result.reason).toBe('test');
            });

            expect(queue.length).toBe(0);
        });
    });

    describe('combined branch coverage scenarios', () => {
        test('should handle rapid operations covering all timeout handle branches', async () => {
            const q = new RequestQueue({ maxSize: 10, timeout: 200 });

            // Enqueue multiple
            const p1 = q.enqueue('req-1');
            const p2 = q.enqueue('req-2');
            const p3 = q.enqueue('req-3');
            const p4 = q.enqueue('req-4');

            // Dequeue one (tests line 142)
            q.signalSlotAvailable();
            await p1;

            // Cancel one (tests line 168)
            q.cancel('req-3');

            // Clear remaining (tests line 202)
            q.clear('cleanup');

            const results = await Promise.all([p2, p3, p4]);
            expect(results[0].reason).toBe('cleanup');
            expect(results[1].reason).toBe('cancelled');
            expect(results[2].reason).toBe('cleanup');

            // Verify no dangling timeouts
            await new Promise(resolve => setTimeout(resolve, 250));
            expect(q.length).toBe(0);
        });
    });
});
