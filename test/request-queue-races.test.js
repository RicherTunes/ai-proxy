'use strict';
/**
 * Race-condition and concurrency tests for RequestQueue
 *
 * Covers:
 * 1. Timeout/dequeue race — no double-resolution
 * 2. Concurrent enqueue — 100 simultaneous calls get unique positions
 * 3. Queue full rejection — immediate reject at maxSize
 * 4. Dequeue with no waiters — signalSlotAvailable() is a no-op
 * 5. Position tracking — 10 items, correct 1-indexed positions
 * 6. Cancel while waiting — cleanup before dequeue
 * 7. Priority ordering — (FIFO; queue has no priority support)
 * 8. Queue stats — size, enqueued, dequeued, timed-out counts
 */

const { RequestQueue } = require('../lib/request-queue');

// ---------------------------------------------------------------------------
// 1. Timeout / dequeue race — no double-resolution
// ---------------------------------------------------------------------------
describe('Race: timeout fires at the same instant as dequeue', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('resolve callback is invoked exactly once when dequeue beats timeout', async () => {
        const queue = new RequestQueue({ maxSize: 5, timeout: 50 });

        const promise = queue.enqueue('race-1');

        // Advance time to 1 ms before timeout, then dequeue
        jest.advanceTimersByTime(49);
        queue.signalSlotAvailable();

        // Now let the timeout fire — it should be a no-op (entry already removed)
        jest.advanceTimersByTime(10);

        const result = await promise;
        expect(result.success).toBe(true);

        // Metrics: 1 enqueued, 1 dequeued, 0 timed-out
        const stats = queue.getStats();
        expect(stats.metrics.totalEnqueued).toBe(1);
        expect(stats.metrics.totalDequeued).toBe(1);
        expect(stats.metrics.totalTimedOut).toBe(0);
    });

    test('reject callback is invoked exactly once when timeout beats dequeue', async () => {
        const queue = new RequestQueue({ maxSize: 5, timeout: 50 });

        const promise = queue.enqueue('race-2');

        // Let timeout fire
        jest.advanceTimersByTime(50);

        // Now try to dequeue — queue should be empty
        const dequeued = queue.signalSlotAvailable();
        expect(dequeued).toBe(false);

        const result = await promise;
        expect(result.success).toBe(false);
        expect(result.reason).toBe('queue_timeout');

        const stats = queue.getStats();
        expect(stats.metrics.totalTimedOut).toBe(1);
        expect(stats.metrics.totalDequeued).toBe(0);
    });

    test('multiple entries — only untimed-out entries are dequeued', async () => {
        const queue = new RequestQueue({ maxSize: 10, timeout: 100 });

        const p1 = queue.enqueue('a', { timeout: 30 });
        const p2 = queue.enqueue('b', { timeout: 200 });
        const p3 = queue.enqueue('c', { timeout: 30 });

        // Advance to 30 ms — a and c time out, b still waiting
        jest.advanceTimersByTime(30);

        expect(queue.length).toBe(1); // only b remains

        queue.signalSlotAvailable();
        jest.advanceTimersByTime(200); // flush remaining timers

        const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
        expect(r1.success).toBe(false);
        expect(r2.success).toBe(true);
        expect(r3.success).toBe(false);

        expect(queue.getStats().metrics.totalTimedOut).toBe(2);
        expect(queue.getStats().metrics.totalDequeued).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// 2. Concurrent enqueue — 100 simultaneous calls, all unique positions
// ---------------------------------------------------------------------------
describe('Concurrent enqueue: 100 simultaneous calls', () => {
    test('all 100 requests get enqueued with unique sequential positions', async () => {
        const queue = new RequestQueue({ maxSize: 200, timeout: 60000 });

        const ids = Array.from({ length: 100 }, (_, i) => `concurrent-${i}`);
        const promises = ids.map(id => queue.enqueue(id));

        expect(queue.length).toBe(100);

        // Every id has a unique 1-indexed position
        const positions = ids.map(id => queue.getPosition(id));
        const uniquePositions = new Set(positions);
        expect(uniquePositions.size).toBe(100);

        // Positions span 1..100
        expect(Math.min(...positions)).toBe(1);
        expect(Math.max(...positions)).toBe(100);

        // Metrics
        expect(queue.getStats().metrics.totalEnqueued).toBe(100);
        expect(queue.getStats().metrics.peakSize).toBe(100);

        // Cleanup — dequeue all
        for (let i = 0; i < 100; i++) {
            queue.signalSlotAvailable();
        }
        const results = await Promise.all(promises);
        results.forEach(r => expect(r.success).toBe(true));
    });

    test('enqueue order matches FIFO dequeue order', async () => {
        const queue = new RequestQueue({ maxSize: 200, timeout: 60000 });

        const order = [];
        const ids = Array.from({ length: 100 }, (_, i) => `fifo-${i}`);
        const promises = ids.map(id =>
            queue.enqueue(id).then(r => { order.push(id); return r; })
        );

        for (let i = 0; i < 100; i++) {
            queue.signalSlotAvailable();
            // Flush the microtask so the .then() records order before next signal
            await Promise.resolve();
        }
        await Promise.all(promises);

        expect(order).toEqual(ids);
    });
});

// ---------------------------------------------------------------------------
// 3. Queue full rejection
// ---------------------------------------------------------------------------
describe('Queue full rejection', () => {
    test('enqueue immediately rejects when queue is at maxSize', async () => {
        const queue = new RequestQueue({ maxSize: 3, timeout: 60000 });

        const p1 = queue.enqueue('fill-1');
        const p2 = queue.enqueue('fill-2');
        const p3 = queue.enqueue('fill-3');

        expect(queue.length).toBe(3);
        expect(queue.hasCapacity()).toBe(false);

        // 4th enqueue returns synchronously with rejection
        const rejection = await queue.enqueue('overflow');
        expect(rejection.success).toBe(false);
        expect(rejection.reason).toBe('queue_full');

        // The rejected request is NOT in the queue
        expect(queue.length).toBe(3);
        expect(queue.getPosition('overflow')).toBe(-1);

        // Metric
        expect(queue.getStats().metrics.totalRejected).toBe(1);

        // Cleanup
        queue.clear('done');
        await Promise.all([p1, p2, p3]);
    });

    test('multiple overflow rejections increment totalRejected correctly', async () => {
        const queue = new RequestQueue({ maxSize: 1, timeout: 60000 });

        const p1 = queue.enqueue('only');
        expect(queue.length).toBe(1);

        const rejections = await Promise.all([
            queue.enqueue('over-1'),
            queue.enqueue('over-2'),
            queue.enqueue('over-3'),
        ]);

        rejections.forEach(r => {
            expect(r.success).toBe(false);
            expect(r.reason).toBe('queue_full');
        });

        expect(queue.getStats().metrics.totalRejected).toBe(3);

        queue.clear('done');
        await p1;
    });
});

// ---------------------------------------------------------------------------
// 4. Dequeue with no waiters — signalSlotAvailable() is a no-op
// ---------------------------------------------------------------------------
describe('Dequeue with no waiters', () => {
    test('signalSlotAvailable on empty queue returns false and changes nothing', () => {
        const queue = new RequestQueue({ maxSize: 5, timeout: 1000 });

        const result = queue.signalSlotAvailable();
        expect(result).toBe(false);

        const stats = queue.getStats();
        expect(stats.current).toBe(0);
        expect(stats.metrics.totalDequeued).toBe(0);
    });

    test('repeated signalSlotAvailable on empty queue is idempotent', () => {
        const queue = new RequestQueue({ maxSize: 5, timeout: 1000 });

        for (let i = 0; i < 50; i++) {
            expect(queue.signalSlotAvailable()).toBe(false);
        }

        expect(queue.getStats().metrics.totalDequeued).toBe(0);
    });

    test('signalSlotAvailable returns false after all entries already dequeued', async () => {
        const queue = new RequestQueue({ maxSize: 5, timeout: 60000 });

        const p1 = queue.enqueue('x');
        queue.signalSlotAvailable();
        await p1;

        // Queue is now empty
        expect(queue.signalSlotAvailable()).toBe(false);
        expect(queue.getStats().metrics.totalDequeued).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// 5. Position tracking — 10 items, correct 1-indexed positions
// ---------------------------------------------------------------------------
describe('Position tracking', () => {
    test('getPosition returns correct 1-indexed values for 10 items', async () => {
        const queue = new RequestQueue({ maxSize: 20, timeout: 60000 });

        const ids = Array.from({ length: 10 }, (_, i) => `pos-${i}`);
        const promises = ids.map(id => queue.enqueue(id));

        for (let i = 0; i < 10; i++) {
            expect(queue.getPosition(`pos-${i}`)).toBe(i + 1);
        }

        // Dequeue first 3 and verify positions shift
        for (let i = 0; i < 3; i++) {
            queue.signalSlotAvailable();
        }
        await Promise.resolve(); // flush microtask

        // pos-0..pos-2 gone
        expect(queue.getPosition('pos-0')).toBe(-1);
        expect(queue.getPosition('pos-1')).toBe(-1);
        expect(queue.getPosition('pos-2')).toBe(-1);

        // pos-3 is now first
        expect(queue.getPosition('pos-3')).toBe(1);
        expect(queue.getPosition('pos-9')).toBe(7);

        // Cleanup
        queue.clear('done');
        await Promise.all(promises);
    });

    test('getPosition returns -1 for unknown id', () => {
        const queue = new RequestQueue({ maxSize: 5, timeout: 1000 });
        expect(queue.getPosition('nope')).toBe(-1);
    });
});

// ---------------------------------------------------------------------------
// 6. Cancel while waiting — cleanup before dequeue
// ---------------------------------------------------------------------------
describe('Cancel while waiting', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('cancel removes entry and rejects with "cancelled"', async () => {
        const queue = new RequestQueue({ maxSize: 5, timeout: 5000 });

        const promise = queue.enqueue('to-cancel');
        expect(queue.length).toBe(1);

        const cancelled = queue.cancel('to-cancel');
        expect(cancelled).toBe(true);
        expect(queue.length).toBe(0);

        const result = await promise;
        expect(result.success).toBe(false);
        expect(result.reason).toBe('cancelled');
    });

    test('cancel clears timeout so it never fires', async () => {
        const queue = new RequestQueue({ maxSize: 5, timeout: 100 });

        const promise = queue.enqueue('cancel-timer');
        queue.cancel('cancel-timer');

        // Advance past the original timeout
        jest.advanceTimersByTime(200);

        const result = await promise;
        expect(result.reason).toBe('cancelled');
        expect(queue.getStats().metrics.totalTimedOut).toBe(0);
    });

    test('cancel middle entry preserves others', async () => {
        const queue = new RequestQueue({ maxSize: 10, timeout: 60000 });

        const p1 = queue.enqueue('keep-1');
        const p2 = queue.enqueue('remove-me');
        const p3 = queue.enqueue('keep-2');

        expect(queue.length).toBe(3);

        queue.cancel('remove-me');
        expect(queue.length).toBe(2);

        // Remaining positions shift
        expect(queue.getPosition('keep-1')).toBe(1);
        expect(queue.getPosition('keep-2')).toBe(2);
        expect(queue.getPosition('remove-me')).toBe(-1);

        // Dequeue remaining
        queue.signalSlotAvailable();
        queue.signalSlotAvailable();

        jest.runAllTimers();

        const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
        expect(r1.success).toBe(true);
        expect(r2.success).toBe(false);
        expect(r3.success).toBe(true);
    });

    test('cancel non-existent id returns false', () => {
        const queue = new RequestQueue({ maxSize: 5, timeout: 1000 });
        expect(queue.cancel('ghost')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 7. Priority ordering (FIFO — queue does not support priority)
// ---------------------------------------------------------------------------
describe('Priority ordering (FIFO verification)', () => {
    test('queue dequeues in strict FIFO order regardless of request id', async () => {
        const queue = new RequestQueue({ maxSize: 20, timeout: 60000 });

        const dequeueOrder = [];
        const ids = ['z-low', 'a-high', 'm-mid', 'b-high', 'y-low'];
        const promises = ids.map(id =>
            queue.enqueue(id).then(r => { dequeueOrder.push(id); return r; })
        );

        for (let i = 0; i < ids.length; i++) {
            queue.signalSlotAvailable();
            await Promise.resolve(); // flush microtask for .then()
        }
        await Promise.all(promises);

        // Strict FIFO: dequeue order matches enqueue order
        expect(dequeueOrder).toEqual(ids);
    });

    test('FIFO preserved even when middle entries are cancelled', async () => {
        const queue = new RequestQueue({ maxSize: 20, timeout: 60000 });

        const dequeueOrder = [];
        const p1 = queue.enqueue('first').then(r => { if (r.success) dequeueOrder.push('first'); return r; });
        const p2 = queue.enqueue('second').then(r => { if (r.success) dequeueOrder.push('second'); return r; });
        const p3 = queue.enqueue('third').then(r => { if (r.success) dequeueOrder.push('third'); return r; });
        const p4 = queue.enqueue('fourth').then(r => { if (r.success) dequeueOrder.push('fourth'); return r; });

        // Cancel second entry
        queue.cancel('second');

        // Dequeue remaining 3
        queue.signalSlotAvailable(); await Promise.resolve();
        queue.signalSlotAvailable(); await Promise.resolve();
        queue.signalSlotAvailable(); await Promise.resolve();

        await Promise.all([p1, p2, p3, p4]);
        expect(dequeueOrder).toEqual(['first', 'third', 'fourth']);
    });
});

// ---------------------------------------------------------------------------
// 8. Queue stats — current size, total enqueued/dequeued/timed-out
// ---------------------------------------------------------------------------
describe('Queue stats', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('stats reflect all operations: enqueue, dequeue, timeout, reject', async () => {
        const queue = new RequestQueue({ maxSize: 3, timeout: 100 });

        // Enqueue 3 (fills queue)
        const p1 = queue.enqueue('s1');
        const p2 = queue.enqueue('s2');
        const p3 = queue.enqueue('s3', { timeout: 50 });

        let stats = queue.getStats();
        expect(stats.current).toBe(3);
        expect(stats.metrics.totalEnqueued).toBe(3);
        expect(stats.metrics.peakSize).toBe(3);

        // Reject one (queue full)
        const rejected = await queue.enqueue('s4');
        expect(rejected.reason).toBe('queue_full');

        stats = queue.getStats();
        expect(stats.metrics.totalRejected).toBe(1);

        // Dequeue one
        queue.signalSlotAvailable();
        await Promise.resolve(); // let resolve propagate

        stats = queue.getStats();
        expect(stats.metrics.totalDequeued).toBe(1);
        expect(stats.current).toBe(2);

        // Timeout one (s3 has 50ms timeout)
        jest.advanceTimersByTime(50);
        await Promise.resolve();

        stats = queue.getStats();
        expect(stats.metrics.totalTimedOut).toBe(1);
        expect(stats.current).toBe(1); // only s2 remains

        // Dequeue last
        queue.signalSlotAvailable();

        jest.runAllTimers();
        await Promise.all([p1, p2, p3]);

        stats = queue.getStats();
        expect(stats.current).toBe(0);
        expect(stats.metrics.totalEnqueued).toBe(3);
        expect(stats.metrics.totalDequeued).toBe(2);
        expect(stats.metrics.totalTimedOut).toBe(1);
        expect(stats.metrics.totalRejected).toBe(1);
        expect(stats.metrics.peakSize).toBe(3);
    });

    test('percentUsed and available are accurate', async () => {
        const queue = new RequestQueue({ maxSize: 4, timeout: 60000 });

        queue.enqueue('u1');
        queue.enqueue('u2');

        const stats = queue.getStats();
        expect(stats.current).toBe(2);
        expect(stats.max).toBe(4);
        expect(stats.available).toBe(2);
        expect(stats.percentUsed).toBe(50);

        queue.clear('done');
    });

    test('resetMetrics zeroes counters but preserves queue contents', async () => {
        const queue = new RequestQueue({ maxSize: 10, timeout: 60000 });

        const p1 = queue.enqueue('m1');
        const p2 = queue.enqueue('m2');
        queue.signalSlotAvailable();
        await Promise.resolve();

        // Before reset
        expect(queue.getStats().metrics.totalEnqueued).toBe(2);
        expect(queue.getStats().metrics.totalDequeued).toBe(1);

        queue.resetMetrics();

        const stats = queue.getStats();
        expect(stats.metrics.totalEnqueued).toBe(0);
        expect(stats.metrics.totalDequeued).toBe(0);
        expect(stats.metrics.totalTimedOut).toBe(0);
        expect(stats.metrics.totalRejected).toBe(0);
        expect(stats.metrics.peakSize).toBe(0);

        // Queue still has m2
        expect(stats.current).toBe(1);

        queue.clear('done');
        await Promise.all([p1, p2]);
    });

    test('oldestWaitMs and avgWaitMs update with fake timers', async () => {
        const queue = new RequestQueue({ maxSize: 10, timeout: 60000 });

        queue.enqueue('w1');
        jest.advanceTimersByTime(100);
        queue.enqueue('w2');
        jest.advanceTimersByTime(50);

        const stats = queue.getStats();
        // w1 waited 150ms, w2 waited 50ms
        expect(stats.oldestWaitMs).toBeGreaterThanOrEqual(150);
        expect(stats.avgWaitMs).toBeGreaterThanOrEqual(100);

        queue.clear('done');
    });
});
