/**
 * Replay Queue Branch Coverage Tests
 * Target: Uncovered line 487 - _cleanupExpired function
 */

const ReplayQueue = require('../lib/replay-queue');

describe('ReplayQueue - Branch Coverage', () => {
    let queue;

    afterEach(() => {
        if (queue) {
            queue.destroy();
        }
    });

    // Target: Line 487 - _cleanupExpired function via manual trigger
    describe('_cleanupExpired', () => {
        test('should remove expired entries when cleanup runs', (done) => {
            const shortRetention = 1000; // 1000ms (minimum allowed)
            queue = new ReplayQueue({
                maxQueueSize: 100,
                retentionPeriod: shortRetention,
                maxRetries: 3
            });

            // Add a request with timestamp in the past (already expired)
            const oldTimestamp = Date.now() - (shortRetention + 100);
            const request = {
                traceId: 'expired-123',
                method: 'POST',
                path: '/v1/messages',
                headers: { 'content-type': 'application/json' },
                body: { message: 'test' },
                originalError: new Error('Test error'),
                timestamp: oldTimestamp
            };

            queue.enqueue(request);

            expect(queue.queue.size).toBe(1);
            expect(queue.stats.totalExpired).toBe(0);

            // Listen for expired event
            let expiredCount = 0;
            queue.on('expired', (data) => {
                expiredCount = data.count;
            });

            // Manually trigger cleanup (line 487)
            queue._cleanupExpired();

            // Expired entry should be removed
            expect(queue.queue.size).toBe(0);
            expect(queue.stats.totalExpired).toBe(1);
            expect(expiredCount).toBe(1);

            done();
        });

        test('should not remove non-expired entries', () => {
            queue = new ReplayQueue({
                maxQueueSize: 100,
                retentionPeriod: 60000, // 60 seconds
                maxRetries: 3
            });

            const request = {
                traceId: 'fresh-123',
                method: 'POST',
                path: '/v1/messages',
                headers: { 'content-type': 'application/json' },
                body: { message: 'test' },
                originalError: new Error('Test error')
                // Current timestamp will be used
            };

            queue.enqueue(request);

            expect(queue.queue.size).toBe(1);

            // Manually trigger cleanup
            queue._cleanupExpired();

            // Entry should still be there
            expect(queue.queue.size).toBe(1);
            expect(queue.stats.totalExpired).toBe(0);
        });

        test('should remove multiple expired entries', () => {
            const shortRetention = 1000;
            queue = new ReplayQueue({
                maxQueueSize: 100,
                retentionPeriod: shortRetention,
                maxRetries: 3
            });

            const oldTimestamp = Date.now() - (shortRetention + 100);

            // Add multiple expired requests
            for (let i = 0; i < 3; i++) {
                queue.enqueue({
                    traceId: `expired-${i}`,
                    method: 'POST',
                    path: '/v1/messages',
                    headers: {},
                    body: {},
                    originalError: new Error('Test error'),
                    timestamp: oldTimestamp
                });
            }

            expect(queue.queue.size).toBe(3);

            // Manually trigger cleanup
            queue._cleanupExpired();

            expect(queue.queue.size).toBe(0);
            expect(queue.stats.totalExpired).toBe(3);
        });

        test('should emit expired event with trace IDs', (done) => {
            const shortRetention = 1000;
            queue = new ReplayQueue({
                maxQueueSize: 100,
                retentionPeriod: shortRetention,
                maxRetries: 3
            });

            const oldTimestamp = Date.now() - (shortRetention + 100);

            queue.enqueue({
                traceId: 'exp-1',
                method: 'POST',
                path: '/v1/messages',
                headers: {},
                body: {},
                originalError: new Error('Test error'),
                timestamp: oldTimestamp
            });

            queue.enqueue({
                traceId: 'exp-2',
                method: 'POST',
                path: '/v1/messages',
                headers: {},
                body: {},
                originalError: new Error('Test error'),
                timestamp: oldTimestamp
            });

            queue.on('expired', (data) => {
                expect(data.count).toBe(2);
                expect(data.traceIds).toContain('exp-1');
                expect(data.traceIds).toContain('exp-2');
                done();
            });

            queue._cleanupExpired();
        });

        test('should not emit expired event when no entries expired', () => {
            queue = new ReplayQueue({
                maxQueueSize: 100,
                retentionPeriod: 60000,
                maxRetries: 3
            });

            // Add fresh request
            queue.enqueue({
                traceId: 'fresh-1',
                method: 'POST',
                path: '/v1/messages',
                headers: {},
                body: {},
                originalError: new Error('Test error')
            });

            let expiredEmitted = false;
            queue.on('expired', () => {
                expiredEmitted = true;
            });

            queue._cleanupExpired();

            expect(expiredEmitted).toBe(false);
        });
    });

    describe('cleanup interval integration', () => {
        test('should start cleanup interval on construction', () => {
            queue = new ReplayQueue();
            expect(queue.cleanupInterval).toBeDefined();
        });

        test('should stop cleanup interval on destroy', () => {
            queue = new ReplayQueue();
            const intervalId = queue.cleanupInterval;
            expect(intervalId).toBeDefined();

            queue.destroy();
            expect(queue.cleanupInterval).toBeNull();
        });
    });
});
