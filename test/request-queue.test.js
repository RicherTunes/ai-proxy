/**
 * Tests for RequestQueue module
 * Comprehensive coverage for request queuing functionality
 */

const { RequestQueue } = require('../lib/request-queue');

describe('RequestQueue', () => {
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

    describe('constructor', () => {
        test('should use default values', () => {
            const defaultQueue = new RequestQueue();
            expect(defaultQueue.maxSize).toBe(100);
            expect(defaultQueue.timeout).toBe(30000);
            expect(defaultQueue.length).toBe(0);
        });

        test('should accept custom values', () => {
            expect(queue.maxSize).toBe(5);
            expect(queue.timeout).toBe(1000);
        });

        test('should accept logger option', () => {
            const mockLogger = { debug: jest.fn(), warn: jest.fn(), info: jest.fn() };
            const q = new RequestQueue({ logger: mockLogger });
            expect(q.logger).toBe(mockLogger);
        });

        test('should initialize metrics', () => {
            const stats = queue.getStats();
            expect(stats.metrics.totalEnqueued).toBe(0);
            expect(stats.metrics.totalDequeued).toBe(0);
            expect(stats.metrics.totalTimedOut).toBe(0);
            expect(stats.metrics.totalRejected).toBe(0);
            expect(stats.metrics.peakSize).toBe(0);
        });
    });

    describe('length getter', () => {
        test('should return 0 for empty queue', () => {
            expect(queue.length).toBe(0);
        });

        test('should return correct length after enqueue', async () => {
            queue.enqueue('req-1');
            queue.enqueue('req-2');
            expect(queue.length).toBe(2);
            queue.clear('cleanup');
        });
    });

    describe('hasCapacity', () => {
        test('should return true when queue has space', () => {
            expect(queue.hasCapacity()).toBe(true);
        });

        test('should return false when queue is full', async () => {
            const promises = [];
            for (let i = 0; i < 5; i++) {
                promises.push(queue.enqueue(`req-${i}`));
            }

            expect(queue.hasCapacity()).toBe(false);
            expect(queue.length).toBe(5);

            for (let i = 0; i < 5; i++) {
                queue.signalSlotAvailable();
            }
            await Promise.all(promises);
        });

        test('should return true after dequeue', async () => {
            const promises = [];
            for (let i = 0; i < 5; i++) {
                promises.push(queue.enqueue(`req-${i}`));
            }
            expect(queue.hasCapacity()).toBe(false);

            queue.signalSlotAvailable();
            expect(queue.hasCapacity()).toBe(true);

            // Cleanup
            while (queue.length > 0) {
                queue.signalSlotAvailable();
            }
            await Promise.all(promises);
        });
    });

    describe('getPosition', () => {
        test('should return correct position (1-indexed)', async () => {
            queue.enqueue('req-1');
            queue.enqueue('req-2');
            queue.enqueue('req-3');

            expect(queue.getPosition('req-1')).toBe(1);
            expect(queue.getPosition('req-2')).toBe(2);
            expect(queue.getPosition('req-3')).toBe(3);

            queue.clear('test cleanup');
        });

        test('should return -1 for non-existent request', () => {
            expect(queue.getPosition('non-existent')).toBe(-1);
        });

        test('should update positions after dequeue', async () => {
            const p1 = queue.enqueue('req-1');
            queue.enqueue('req-2');
            queue.enqueue('req-3');

            expect(queue.getPosition('req-1')).toBe(1);
            expect(queue.getPosition('req-2')).toBe(2);

            queue.signalSlotAvailable();
            await p1;

            expect(queue.getPosition('req-1')).toBe(-1);
            expect(queue.getPosition('req-2')).toBe(1);
            expect(queue.getPosition('req-3')).toBe(2);

            queue.clear('test cleanup');
        });
    });

    describe('enqueue', () => {
        test('should enqueue request and return promise', async () => {
            const promise = queue.enqueue('req-1');
            expect(queue.length).toBe(1);
            expect(promise).toBeInstanceOf(Promise);

            queue.signalSlotAvailable();
            const result = await promise;
            expect(result.success).toBe(true);
        });

        test('should reject when queue is full', async () => {
            const promises = [];
            for (let i = 0; i < 5; i++) {
                promises.push(queue.enqueue(`req-${i}`));
            }

            const result = await queue.enqueue('overflow-req');
            expect(result.success).toBe(false);
            expect(result.reason).toBe('queue_full');

            // Cleanup
            for (let i = 0; i < 5; i++) {
                queue.signalSlotAvailable();
            }
            await Promise.all(promises);
        });

        test('should track metrics for rejected requests', async () => {
            const promises = [];
            for (let i = 0; i < 5; i++) {
                promises.push(queue.enqueue(`req-${i}`));
            }

            await queue.enqueue('overflow-1');
            await queue.enqueue('overflow-2');

            const stats = queue.getStats();
            expect(stats.metrics.totalRejected).toBe(2);

            // Cleanup
            for (let i = 0; i < 5; i++) {
                queue.signalSlotAvailable();
            }
            await Promise.all(promises);
        });

        test('should track totalEnqueued metric', async () => {
            const p1 = queue.enqueue('req-1');
            const p2 = queue.enqueue('req-2');

            expect(queue.getStats().metrics.totalEnqueued).toBe(2);

            queue.signalSlotAvailable();
            queue.signalSlotAvailable();
            await Promise.all([p1, p2]);
        });

        test('should use custom timeout from options', async () => {
            const shortQueue = new RequestQueue({
                maxSize: 5,
                timeout: 10000  // Long default
            });

            const start = Date.now();
            const result = await shortQueue.enqueue('req-1', { timeout: 50 });
            const elapsed = Date.now() - start;

            expect(result.success).toBe(false);
            expect(result.reason).toBe('queue_timeout');
            expect(elapsed).toBeGreaterThanOrEqual(45); // Relaxed from 50 — setTimeout(50) can fire 1-2ms early on CI
            expect(elapsed).toBeLessThan(1000);
        });

        test('should log when logger is provided', async () => {
            const mockLogger = { debug: jest.fn(), warn: jest.fn(), info: jest.fn() };
            const loggedQueue = new RequestQueue({
                maxSize: 5,
                timeout: 1000,
                logger: mockLogger
            });

            const p = loggedQueue.enqueue('req-1');
            expect(mockLogger.debug).toHaveBeenCalledWith('Request enqueued', expect.any(Object));

            loggedQueue.signalSlotAvailable();
            await p;
            expect(mockLogger.debug).toHaveBeenCalledWith('Request dequeued', expect.any(Object));
        });
    });

    describe('signalSlotAvailable', () => {
        test('should dequeue waiting request', async () => {
            const promise = queue.enqueue('req-1');
            expect(queue.length).toBe(1);

            queue.signalSlotAvailable();

            const result = await promise;
            expect(result.success).toBe(true);
            expect(queue.length).toBe(0);
        });

        test('should return true when request was dequeued', async () => {
            queue.enqueue('req-1');
            const result = queue.signalSlotAvailable();
            expect(result).toBe(true);
        });

        test('should return false when queue is empty', () => {
            expect(queue.signalSlotAvailable()).toBe(false);
        });

        test('should dequeue in FIFO order', async () => {
            const results = [];
            const promise1 = queue.enqueue('req-1').then(r => { results.push('req-1'); return r; });
            const promise2 = queue.enqueue('req-2').then(r => { results.push('req-2'); return r; });
            const promise3 = queue.enqueue('req-3').then(r => { results.push('req-3'); return r; });

            queue.signalSlotAvailable();
            await promise1;
            queue.signalSlotAvailable();
            await promise2;
            queue.signalSlotAvailable();
            await promise3;

            expect(results).toEqual(['req-1', 'req-2', 'req-3']);
        });

        test('should include waitTime in result', async () => {
            const promise = queue.enqueue('req-1');

            await new Promise(resolve => setTimeout(resolve, 50));
            queue.signalSlotAvailable();

            const result = await promise;
            expect(result.success).toBe(true);
            expect(result.waitTime).toBeGreaterThanOrEqual(45); // Relaxed from 50 — setTimeout(50) can fire 1-2ms early on CI
        });

        test('should track totalDequeued metric', async () => {
            const p1 = queue.enqueue('req-1');
            const p2 = queue.enqueue('req-2');

            queue.signalSlotAvailable();
            await p1;

            expect(queue.getStats().metrics.totalDequeued).toBe(1);

            queue.signalSlotAvailable();
            await p2;

            expect(queue.getStats().metrics.totalDequeued).toBe(2);
        });

        test('should clear timeout handle on dequeue', async () => {
            jest.useFakeTimers();

            const promise = queue.enqueue('req-1');
            const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

            queue.signalSlotAvailable();

            jest.runAllTimers();
            const result = await promise;

            expect(result.success).toBe(true);
            expect(clearTimeoutSpy).toHaveBeenCalled();

            jest.useRealTimers();
            clearTimeoutSpy.mockRestore();
        });
    });

    describe('timeout handling', () => {
        test('should timeout after configured duration', async () => {
            const shortQueue = new RequestQueue({
                maxSize: 5,
                timeout: 100
            });

            const start = Date.now();
            const result = await shortQueue.enqueue('timeout-req');
            const elapsed = Date.now() - start;

            expect(result.success).toBe(false);
            expect(result.reason).toBe('queue_timeout');
            expect(result.waitTime).toBeGreaterThanOrEqual(100);
            expect(elapsed).toBeGreaterThanOrEqual(100);
        });

        test('should track timeout metrics', async () => {
            const shortQueue = new RequestQueue({
                maxSize: 5,
                timeout: 50
            });

            await shortQueue.enqueue('timeout-1');
            await shortQueue.enqueue('timeout-2');

            const stats = shortQueue.getStats();
            expect(stats.metrics.totalTimedOut).toBe(2);
        });

        test('should remove from queue on timeout', async () => {
            const shortQueue = new RequestQueue({
                maxSize: 5,
                timeout: 50
            });

            shortQueue.enqueue('timeout-req');
            expect(shortQueue.length).toBe(1);

            await new Promise(resolve => setTimeout(resolve, 100));
            expect(shortQueue.length).toBe(0);
        });

        test('should log warning on timeout', async () => {
            const mockLogger = { debug: jest.fn(), warn: jest.fn(), info: jest.fn() };
            const shortQueue = new RequestQueue({
                maxSize: 5,
                timeout: 50,
                logger: mockLogger
            });

            await shortQueue.enqueue('timeout-req');

            expect(mockLogger.warn).toHaveBeenCalledWith(
                'Queued request timed out',
                expect.objectContaining({ requestId: 'timeout-req' })
            );
        });

        test('should handle timeout of already-dequeued request gracefully', async () => {
            // This tests the race condition guard in _handleTimeout
            const q = new RequestQueue({ maxSize: 5, timeout: 100 });

            const promise = q.enqueue('req-1');
            q.signalSlotAvailable();  // Dequeue before timeout

            const result = await promise;
            expect(result.success).toBe(true);

            // Wait past timeout - should not cause issues
            await new Promise(resolve => setTimeout(resolve, 150));
            expect(q.length).toBe(0);
        });
    });

    describe('cancel', () => {
        test('should cancel a queued request', async () => {
            const promise = queue.enqueue('cancel-req');
            expect(queue.length).toBe(1);

            const cancelled = queue.cancel('cancel-req');
            expect(cancelled).toBe(true);
            expect(queue.length).toBe(0);

            const result = await promise;
            expect(result.success).toBe(false);
            expect(result.reason).toBe('cancelled');
        });

        test('should return false for non-existent request', () => {
            expect(queue.cancel('non-existent')).toBe(false);
        });

        test('should clear timeout handle on cancel', async () => {
            jest.useFakeTimers();

            const promise = queue.enqueue('cancel-req');
            const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

            queue.cancel('cancel-req');

            expect(clearTimeoutSpy).toHaveBeenCalled();

            jest.runAllTimers();
            await promise;

            jest.useRealTimers();
            clearTimeoutSpy.mockRestore();
        });

        test('should include waitTime in cancelled result', async () => {
            const promise = queue.enqueue('cancel-req');
            await new Promise(resolve => setTimeout(resolve, 50));

            queue.cancel('cancel-req');
            const result = await promise;

            expect(result.waitTime).toBeGreaterThanOrEqual(45); // Relaxed from 50 — setTimeout(50) can fire 1-2ms early on CI
        });
    });

    describe('getStats', () => {
        test('should return queue statistics', async () => {
            queue.enqueue('req-1');
            queue.enqueue('req-2');

            const stats = queue.getStats();
            expect(stats.current).toBe(2);
            expect(stats.max).toBe(5);
            expect(stats.available).toBe(3);
            expect(stats.percentUsed).toBe(40);
            expect(stats.metrics.totalEnqueued).toBe(2);

            queue.clear('test cleanup');
        });

        test('should track peak size', async () => {
            const p1 = queue.enqueue('req-1');
            const p2 = queue.enqueue('req-2');
            const p3 = queue.enqueue('req-3');
            const p4 = queue.enqueue('req-4');

            // Peak at 4
            queue.signalSlotAvailable();
            queue.signalSlotAvailable();
            await Promise.all([p1, p2]);

            const stats = queue.getStats();
            expect(stats.current).toBe(2);
            expect(stats.metrics.peakSize).toBe(4);

            queue.clear('test cleanup');
        });

        test('should calculate oldestWaitMs', async () => {
            queue.enqueue('req-1');
            await new Promise(resolve => setTimeout(resolve, 50));
            queue.enqueue('req-2');

            const stats = queue.getStats();
            // Relaxed by 5ms to tolerate CI scheduling jitter
            expect(stats.oldestWaitMs).toBeGreaterThanOrEqual(45);

            queue.clear('test cleanup');
        });

        test('should calculate avgWaitMs', async () => {
            queue.enqueue('req-1');
            await new Promise(resolve => setTimeout(resolve, 30));
            queue.enqueue('req-2');
            await new Promise(resolve => setTimeout(resolve, 30));

            const stats = queue.getStats();
            // First request waited ~60ms, second waited ~30ms, avg ~45ms
            expect(stats.avgWaitMs).toBeGreaterThanOrEqual(30);

            queue.clear('test cleanup');
        });

        test('should return 0 for wait times on empty queue', () => {
            const stats = queue.getStats();
            expect(stats.oldestWaitMs).toBe(0);
            expect(stats.avgWaitMs).toBe(0);
        });
    });

    describe('clear', () => {
        test('should reject all waiting requests', async () => {
            const promises = [
                queue.enqueue('req-1'),
                queue.enqueue('req-2'),
                queue.enqueue('req-3')
            ];

            queue.clear('shutdown');

            const results = await Promise.all(promises);
            results.forEach(result => {
                expect(result.success).toBe(false);
                expect(result.reason).toBe('shutdown');
            });

            expect(queue.length).toBe(0);
        });

        test('should use default reason', async () => {
            const promise = queue.enqueue('req-1');
            queue.clear();

            const result = await promise;
            expect(result.reason).toBe('shutdown');
        });

        test('should clear timeout handles', async () => {
            jest.useFakeTimers();

            const promises = [
                queue.enqueue('req-1'),
                queue.enqueue('req-2')
            ];

            const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

            queue.clear('shutdown');

            expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);

            jest.runAllTimers();
            await Promise.all(promises);

            jest.useRealTimers();
            clearTimeoutSpy.mockRestore();
        });

        test('should work on empty queue', () => {
            expect(() => queue.clear('test')).not.toThrow();
            expect(queue.length).toBe(0);
        });
    });

    describe('resetMetrics', () => {
        test('should reset all metrics to zero', async () => {
            // Generate some metrics
            const p = queue.enqueue('req-1');
            queue.signalSlotAvailable();
            await p;

            const fullQueue = new RequestQueue({ maxSize: 1, timeout: 1000 });
            fullQueue.enqueue('fill-1');
            await fullQueue.enqueue('reject-1');  // Rejected
            fullQueue.clear('cleanup');

            queue.resetMetrics();

            const stats = queue.getStats();
            expect(stats.metrics.totalEnqueued).toBe(0);
            expect(stats.metrics.totalDequeued).toBe(0);
            expect(stats.metrics.totalTimedOut).toBe(0);
            expect(stats.metrics.totalRejected).toBe(0);
            expect(stats.metrics.peakSize).toBe(0);
        });
    });

    describe('concurrent operations', () => {
        test('should handle multiple simultaneous enqueues', async () => {
            const promises = [];
            for (let i = 0; i < 5; i++) {
                promises.push(queue.enqueue(`req-${i}`));
            }

            expect(queue.length).toBe(5);

            // Dequeue all
            for (let i = 0; i < 5; i++) {
                queue.signalSlotAvailable();
            }

            const results = await Promise.all(promises);
            results.forEach(r => expect(r.success).toBe(true));
        });

        test('should handle rapid enqueue/dequeue cycles', async () => {
            for (let i = 0; i < 10; i++) {
                const p = queue.enqueue(`req-${i}`);
                queue.signalSlotAvailable();
                await p;
            }

            expect(queue.length).toBe(0);
            expect(queue.getStats().metrics.totalEnqueued).toBe(10);
            expect(queue.getStats().metrics.totalDequeued).toBe(10);
        });
    });

    describe('edge cases', () => {
        test('should handle requestId with special characters', async () => {
            const specialId = 'req-with/special:chars?and=params';
            const p = queue.enqueue(specialId);

            expect(queue.getPosition(specialId)).toBe(1);

            queue.signalSlotAvailable();
            const result = await p;
            expect(result.success).toBe(true);
        });

        test('should handle empty requestId', async () => {
            const p = queue.enqueue('');
            expect(queue.length).toBe(1);

            queue.signalSlotAvailable();
            await p;
        });

        test('should handle very long timeout', async () => {
            const longTimeoutQueue = new RequestQueue({
                maxSize: 5,
                timeout: 2147483647  // Max 32-bit signed int (avoids TimeoutOverflowWarning)
            });

            const p = longTimeoutQueue.enqueue('req-1');
            longTimeoutQueue.signalSlotAvailable();

            const result = await p;
            expect(result.success).toBe(true);
        });
    });
});
