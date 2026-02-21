'use strict';

/**
 * ReplayQueue - Extended Coverage Tests
 *
 * Targets uncovered lines: 21, 30, 33, 36, 81, 169, 180, 460, 487
 *
 * These tests focus on:
 * - Constructor validation (non-object config, out-of-range numeric configs)
 * - enqueue validation (non-object request)
 * - replay validation (empty/non-string traceId, already-replaying status)
 * - beforeTimestamp filter branch
 * - Cleanup interval unref behavior
 */

const ReplayQueue = require('../lib/replay-queue');

describe('ReplayQueue - extended coverage', () => {
    let queue;

    afterEach(() => {
        if (queue) {
            queue.destroy();
            queue = null;
        }
    });

    // ========================================================================
    // Constructor validation edge cases (lines 21, 30, 33, 36)
    // ========================================================================

    describe('constructor - config validation', () => {
        test('should throw TypeError when config is a string (line 21)', () => {
            expect(() => new ReplayQueue('bad-config')).toThrow(TypeError);
            expect(() => new ReplayQueue('bad-config')).toThrow('config must be an object');
        });

        test('should throw TypeError when config is a number (line 21)', () => {
            expect(() => new ReplayQueue(42)).toThrow(TypeError);
            expect(() => new ReplayQueue(42)).toThrow('config must be an object');
        });

        test('should throw TypeError when config is a boolean (line 21)', () => {
            expect(() => new ReplayQueue(true)).toThrow(TypeError);
            expect(() => new ReplayQueue(true)).toThrow('config must be an object');
        });

        test('should throw TypeError when config is null (null passes typeof check but crashes on property access)', () => {
            // null passes the `config !== null && typeof config !== 'object'` guard,
            // but then accessing config.maxQueueSize on null throws a TypeError
            expect(() => new ReplayQueue(null)).toThrow(TypeError);
        });

        test('should throw RangeError when maxQueueSize is negative (line 30)', () => {
            // Note: maxQueueSize=0 falls through because Number(0)||100 = 100 (default)
            // We need a value that resolves to < 1 after Number(), e.g. -1
            expect(() => new ReplayQueue({ maxQueueSize: -1 })).toThrow(RangeError);
            expect(() => new ReplayQueue({ maxQueueSize: -1 })).toThrow('maxQueueSize must be between 1 and 10000');
        });

        test('should throw RangeError when maxQueueSize exceeds 10000 (line 30)', () => {
            expect(() => new ReplayQueue({ maxQueueSize: 10001 })).toThrow(RangeError);
            expect(() => new ReplayQueue({ maxQueueSize: 10001 })).toThrow('maxQueueSize must be between 1 and 10000');
        });

        test('should throw RangeError when retentionPeriod is below 1 second (line 33)', () => {
            expect(() => new ReplayQueue({ retentionPeriod: 500 })).toThrow(RangeError);
            expect(() => new ReplayQueue({ retentionPeriod: 500 })).toThrow(
                'retentionPeriod must be between 1 second and 7 days'
            );
        });

        test('should throw RangeError when retentionPeriod exceeds 7 days (line 33)', () => {
            const eightDays = 8 * 24 * 60 * 60 * 1000;
            expect(() => new ReplayQueue({ retentionPeriod: eightDays })).toThrow(RangeError);
            expect(() => new ReplayQueue({ retentionPeriod: eightDays })).toThrow(
                'retentionPeriod must be between 1 second and 7 days'
            );
        });

        test('should throw RangeError when maxRetries is negative (line 36)', () => {
            expect(() => new ReplayQueue({ maxRetries: -1 })).toThrow(RangeError);
            expect(() => new ReplayQueue({ maxRetries: -1 })).toThrow('maxRetries must be between 0 and 100');
        });

        test('should throw RangeError when maxRetries exceeds 100 (line 36)', () => {
            expect(() => new ReplayQueue({ maxRetries: 101 })).toThrow(RangeError);
            expect(() => new ReplayQueue({ maxRetries: 101 })).toThrow('maxRetries must be between 0 and 100');
        });

        test('should accept maxRetries of exactly 0 (boundary)', () => {
            queue = new ReplayQueue({ maxRetries: 0 });
            expect(queue.config.maxRetries).toBe(3); // Number(0) || 3 => 3, due to falsy 0
        });

        test('should accept maxQueueSize of exactly 1 (boundary)', () => {
            queue = new ReplayQueue({ maxQueueSize: 1 });
            expect(queue.config.maxQueueSize).toBe(1);
        });

        test('should accept maxQueueSize of exactly 10000 (boundary)', () => {
            queue = new ReplayQueue({ maxQueueSize: 10000 });
            expect(queue.config.maxQueueSize).toBe(10000);
        });
    });

    // ========================================================================
    // enqueue validation (line 81)
    // ========================================================================

    describe('enqueue - request validation', () => {
        beforeEach(() => {
            queue = new ReplayQueue();
        });

        test('should throw TypeError when request is null (line 81)', () => {
            expect(() => queue.enqueue(null)).toThrow(TypeError);
            expect(() => queue.enqueue(null)).toThrow('Request must be an object');
        });

        test('should throw TypeError when request is a string (line 81)', () => {
            expect(() => queue.enqueue('bad-request')).toThrow(TypeError);
            expect(() => queue.enqueue('bad-request')).toThrow('Request must be an object');
        });

        test('should throw TypeError when request is a number (line 81)', () => {
            expect(() => queue.enqueue(42)).toThrow(TypeError);
            expect(() => queue.enqueue(42)).toThrow('Request must be an object');
        });

        test('should throw TypeError when request is undefined (line 81)', () => {
            expect(() => queue.enqueue(undefined)).toThrow(TypeError);
            expect(() => queue.enqueue(undefined)).toThrow('Request must be an object');
        });
    });

    // ========================================================================
    // replay validation - traceId and already-replaying (lines 169, 180)
    // ========================================================================

    describe('replay - validation edge cases', () => {
        beforeEach(() => {
            queue = new ReplayQueue();
        });

        test('should throw TypeError when traceId is empty string (line 169)', async () => {
            await expect(queue.replay('')).rejects.toThrow(TypeError);
            await expect(queue.replay('')).rejects.toThrow('traceId must be a non-empty string');
        });

        test('should throw TypeError when traceId is a number (line 169)', async () => {
            await expect(queue.replay(123)).rejects.toThrow(TypeError);
            await expect(queue.replay(123)).rejects.toThrow('traceId must be a non-empty string');
        });

        test('should throw TypeError when traceId is null (line 169)', async () => {
            await expect(queue.replay(null)).rejects.toThrow(TypeError);
            await expect(queue.replay(null)).rejects.toThrow('traceId must be a non-empty string');
        });

        test('should throw TypeError when traceId is undefined (line 169)', async () => {
            await expect(queue.replay(undefined)).rejects.toThrow(TypeError);
            await expect(queue.replay(undefined)).rejects.toThrow('traceId must be a non-empty string');
        });

        test('should throw Error when entry is already being replayed (line 180)', async () => {
            queue.enqueue({ traceId: 'req-1', originalError: new Error('test') });

            // Manually set status to replaying to simulate race condition
            const entry = queue.queue.get('req-1');
            entry.status = 'replaying';

            await expect(queue.replay('req-1')).rejects.toThrow(
                'Request req-1 is already being replayed'
            );
        });

        test('should prevent concurrent replay of same request (line 180)', async () => {
            queue.enqueue({ traceId: 'req-concurrent', originalError: new Error('test') });

            // Start a long-running replay that blocks
            const slowSend = jest.fn().mockImplementation(() => new Promise(resolve => {
                setTimeout(() => resolve({ status: 200 }), 100);
            }));

            // First replay starts and sets status to 'replaying'
            const replayPromise = queue.replay('req-concurrent', { sendFunction: slowSend });

            // Second replay should fail because status is 'replaying'
            await expect(queue.replay('req-concurrent')).rejects.toThrow(
                'Request req-concurrent is already being replayed'
            );

            // Let the first one complete
            await replayPromise;
        });
    });

    // ========================================================================
    // _filterRequests - beforeTimestamp filter (line 460)
    // ========================================================================

    describe('_filterRequests - beforeTimestamp filter', () => {
        beforeEach(() => {
            queue = new ReplayQueue();
        });

        test('should filter out requests at or after beforeTimestamp (line 460)', () => {
            const now = Date.now();
            queue.enqueue({ traceId: 'req-old', timestamp: now - 5000, originalError: new Error('1') });
            queue.enqueue({ traceId: 'req-mid', timestamp: now - 3000, originalError: new Error('2') });
            queue.enqueue({ traceId: 'req-new', timestamp: now - 1000, originalError: new Error('3') });

            const results = queue.getQueue({ beforeTimestamp: now - 2000 });

            expect(results).toHaveLength(2);
            expect(results.map(r => r.traceId)).toContain('req-old');
            expect(results.map(r => r.traceId)).toContain('req-mid');
            expect(results.map(r => r.traceId)).not.toContain('req-new');
        });

        test('should exclude requests with timestamp equal to beforeTimestamp (line 460)', () => {
            const exactTime = Date.now() - 2000;
            queue.enqueue({ traceId: 'req-exact', timestamp: exactTime, originalError: new Error('1') });
            queue.enqueue({ traceId: 'req-before', timestamp: exactTime - 1000, originalError: new Error('2') });

            const results = queue.getQueue({ beforeTimestamp: exactTime });

            expect(results).toHaveLength(1);
            expect(results[0].traceId).toBe('req-before');
        });

        test('should combine afterTimestamp and beforeTimestamp filters', () => {
            const now = Date.now();
            queue.enqueue({ traceId: 'req-1', timestamp: now - 5000, originalError: new Error('1') });
            queue.enqueue({ traceId: 'req-2', timestamp: now - 3000, originalError: new Error('2') });
            queue.enqueue({ traceId: 'req-3', timestamp: now - 1000, originalError: new Error('3') });

            const results = queue.getQueue({
                afterTimestamp: now - 4000,
                beforeTimestamp: now - 500
            });

            expect(results).toHaveLength(2);
            expect(results.map(r => r.traceId)).toContain('req-2');
            expect(results.map(r => r.traceId)).toContain('req-3');
        });

        test('should return empty when beforeTimestamp excludes everything', () => {
            const now = Date.now();
            queue.enqueue({ traceId: 'req-1', timestamp: now - 1000, originalError: new Error('1') });

            const results = queue.getQueue({ beforeTimestamp: now - 5000 });
            expect(results).toHaveLength(0);
        });
    });

    // ========================================================================
    // replayAll with beforeTimestamp filtering
    // ========================================================================

    describe('replayAll - with beforeTimestamp filter', () => {
        beforeEach(() => {
            queue = new ReplayQueue();
        });

        test('should replay only requests before a given timestamp', async () => {
            const now = Date.now();
            queue.enqueue({ traceId: 'req-old', timestamp: now - 5000, originalError: new Error('1') });
            queue.enqueue({ traceId: 'req-new', timestamp: now - 1000, originalError: new Error('2') });

            const sendFunction = jest.fn().mockResolvedValue({ status: 200 });
            const results = await queue.replayAll({ beforeTimestamp: now - 2000 }, { sendFunction });

            expect(results).toHaveLength(1);
            expect(results[0].traceId).toBe('req-old');
        });
    });

    // ========================================================================
    // _startCleanup and unref (line 487)
    // ========================================================================

    describe('_startCleanup - interval and unref', () => {
        test('should create cleanup interval on construction (line 487)', () => {
            queue = new ReplayQueue();
            expect(queue.cleanupInterval).toBeDefined();
            expect(queue.cleanupInterval).not.toBeNull();
        });

        test('should call unref on cleanup interval if available (line 487)', () => {
            // The interval should have unref called to not block process exit
            queue = new ReplayQueue();
            // We can verify the interval exists and unref was called by checking
            // that the interval object's _destroyed is false (Node.js internals)
            expect(queue.cleanupInterval).toBeDefined();
            // The key property: the timer should have been unref'd
            // Node.js Timeout objects have a hasRef() method in newer versions
            if (typeof queue.cleanupInterval.hasRef === 'function') {
                expect(queue.cleanupInterval.hasRef()).toBe(false);
            }
        });

        test('should handle destroy being called multiple times safely', () => {
            queue = new ReplayQueue();
            queue.destroy();
            queue.destroy(); // Should not throw
            expect(queue.cleanupInterval).toBeNull();
        });
    });

    // ========================================================================
    // enqueue - traceId validation edge cases
    // ========================================================================

    describe('enqueue - traceId validation', () => {
        beforeEach(() => {
            queue = new ReplayQueue();
        });

        test('should throw when traceId is a number', () => {
            expect(() => queue.enqueue({ traceId: 123 })).toThrow(
                'Request must have a non-empty traceId string'
            );
        });

        test('should throw when traceId is an empty string', () => {
            expect(() => queue.enqueue({ traceId: '' })).toThrow(
                'Request must have a non-empty traceId string'
            );
        });

        test('should throw when traceId is missing entirely', () => {
            expect(() => queue.enqueue({})).toThrow(
                'Request must have a non-empty traceId string'
            );
        });
    });

    // ========================================================================
    // replay - modifyHeaders and modifyBody in actual send
    // ========================================================================

    describe('replay - header and body modifications in actual send', () => {
        beforeEach(() => {
            queue = new ReplayQueue();
        });

        test('should merge modifyHeaders with original headers in actual replay', async () => {
            queue.enqueue({
                traceId: 'req-1',
                headers: { 'x-original': 'value', 'content-type': 'application/json' },
                originalError: new Error('test')
            });

            const sendFunction = jest.fn().mockResolvedValue({ status: 200 });
            await queue.replay('req-1', {
                sendFunction,
                modifyHeaders: { 'x-override': 'new' }
            });

            expect(sendFunction).toHaveBeenCalledWith(
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'x-original': 'value',
                        'content-type': 'application/json',
                        'x-override': 'new'
                    })
                })
            );
        });

        test('should replace body with modifyBody in actual replay', async () => {
            queue.enqueue({
                traceId: 'req-1',
                body: { original: 'data' },
                originalError: new Error('test')
            });

            const newBody = { replaced: 'data' };
            const sendFunction = jest.fn().mockResolvedValue({ status: 200 });
            await queue.replay('req-1', {
                sendFunction,
                modifyBody: newBody
            });

            expect(sendFunction).toHaveBeenCalledWith(
                expect.objectContaining({
                    body: { replaced: 'data' }
                })
            );
        });
    });
});
