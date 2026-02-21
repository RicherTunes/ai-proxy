const ReplayQueue = require('../lib/replay-queue');

describe('ReplayQueue', () => {
  let queue;

  beforeEach(() => {
    queue = new ReplayQueue();
  });

  afterEach(() => {
    if (queue) {
      queue.destroy();
    }
  });

  // ============================================================================
  // 1. Constructor Tests
  // ============================================================================

  describe('Constructor', () => {
    test('should initialize with default config', () => {
      const q = new ReplayQueue();
      expect(q.config.maxQueueSize).toBe(100);
      expect(q.config.retentionPeriod).toBe(24 * 60 * 60 * 1000); // 24 hours
      expect(q.config.maxRetries).toBe(3);
      expect(q.queue.size).toBe(0);
      expect(q.order).toEqual([]);
      q.destroy();
    });

    test('should initialize with custom config', () => {
      const customConfig = {
        maxQueueSize: 50,
        retentionPeriod: 12 * 60 * 60 * 1000, // 12 hours
        maxRetries: 5
      };
      const q = new ReplayQueue(customConfig);
      expect(q.config.maxQueueSize).toBe(50);
      expect(q.config.retentionPeriod).toBe(12 * 60 * 60 * 1000);
      expect(q.config.maxRetries).toBe(5);
      q.destroy();
    });

    test('should initialize stats to zero', () => {
      expect(queue.stats.totalEnqueued).toBe(0);
      expect(queue.stats.totalReplayed).toBe(0);
      expect(queue.stats.totalSucceeded).toBe(0);
      expect(queue.stats.totalFailed).toBe(0);
      expect(queue.stats.totalExpired).toBe(0);
    });

    test('should extend EventEmitter', () => {
      expect(queue.on).toBeDefined();
      expect(queue.emit).toBeDefined();
      expect(typeof queue.on).toBe('function');
      expect(typeof queue.emit).toBe('function');
    });
  });

  // ============================================================================
  // 2. enqueue Tests
  // ============================================================================

  describe('enqueue', () => {
    test('should add request to queue', () => {
      const request = {
        traceId: 'test-123',
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
        body: { message: 'test' },
        originalError: new Error('Test error')
      };

      const result = queue.enqueue(request);

      expect(result).toBe(true);
      expect(queue.queue.size).toBe(1);
      expect(queue.order).toContain('test-123');
      expect(queue.stats.totalEnqueued).toBe(1);
    });

    test('should throw error if traceId is missing', () => {
      const request = {
        method: 'POST',
        path: '/v1/messages',
        body: { message: 'test' }
      };

      expect(() => queue.enqueue(request)).toThrow('Request must have a non-empty traceId string');
    });

    test('should use default values for optional fields', () => {
      const request = {
        traceId: 'test-123',
        originalError: new Error('Test error')
      };

      queue.enqueue(request);
      const entry = queue.getByTraceId('test-123');

      expect(entry.method).toBe('POST');
      expect(entry.path).toBe('/v1/messages');
      expect(entry.priority).toBe(0);
      expect(entry.status).toBe('pending');
      expect(entry.retryCount).toBe(0);
      expect(entry.lastRetryAt).toBeNull();
    });

    test('should set timestamp to current time if not provided', () => {
      const beforeTime = Date.now();
      const request = {
        traceId: 'test-123',
        originalError: new Error('Test error')
      };

      queue.enqueue(request);
      const entry = queue.getByTraceId('test-123');
      const afterTime = Date.now();

      expect(entry.timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(entry.timestamp).toBeLessThanOrEqual(afterTime);
    });

    test('should preserve custom timestamp', () => {
      const customTimestamp = Date.now() - 10000;
      const request = {
        traceId: 'test-123',
        timestamp: customTimestamp,
        originalError: new Error('Test error')
      };

      queue.enqueue(request);
      const entry = queue.getByTraceId('test-123');

      expect(entry.timestamp).toBe(customTimestamp);
    });

    test('should handle queue full by evicting oldest entry', () => {
      const smallQueue = new ReplayQueue({ maxQueueSize: 2 });
      const queueFullEvents = [];
      const evictedEvents = [];

      smallQueue.on('queueFull', (data) => queueFullEvents.push(data));
      smallQueue.on('evicted', (data) => evictedEvents.push(data));

      // Fill queue
      smallQueue.enqueue({ traceId: 'req-1', originalError: new Error('1') });
      smallQueue.enqueue({ traceId: 'req-2', originalError: new Error('2') });

      // This should evict req-1
      smallQueue.enqueue({ traceId: 'req-3', originalError: new Error('3') });

      expect(smallQueue.queue.size).toBe(2);
      expect(smallQueue.getByTraceId('req-1')).toBeNull();
      expect(smallQueue.getByTraceId('req-2')).not.toBeNull();
      expect(smallQueue.getByTraceId('req-3')).not.toBeNull();
      expect(queueFullEvents.length).toBe(1);
      expect(evictedEvents.length).toBe(1);
      expect(evictedEvents[0].traceId).toBe('req-1');

      smallQueue.destroy();
    });

    test('should emit enqueued event', () => {
      const events = [];
      queue.on('enqueued', (data) => events.push(data));

      queue.enqueue({ traceId: 'test-123', originalError: new Error('Test') });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        traceId: 'test-123',
        queueSize: 1
      });
    });

    test('should serialize error object', () => {
      const error = new Error('Original error');
      error.code = 'ECONNREFUSED';
      error.status = 500;

      const request = {
        traceId: 'test-123',
        originalError: error
      };

      queue.enqueue(request);
      const entry = queue.getByTraceId('test-123');

      expect(entry.originalError.message).toBe('Original error');
      expect(entry.originalError.code).toBe('ECONNREFUSED');
      expect(entry.originalError.status).toBe(500);
      expect(entry.originalError.stack).toBeDefined();
    });

    test('should handle undefined originalError', () => {
      const request = {
        traceId: 'test-123',
        originalError: undefined
      };

      queue.enqueue(request);
      const entry = queue.getByTraceId('test-123');

      expect(entry.originalError).toEqual({
        message: undefined,
        code: undefined,
        status: undefined,
        stack: undefined
      });
    });

    test('should maintain FIFO order in order array', () => {
      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });
      queue.enqueue({ traceId: 'req-2', originalError: new Error('2') });
      queue.enqueue({ traceId: 'req-3', originalError: new Error('3') });

      expect(queue.order).toEqual(['req-1', 'req-2', 'req-3']);
    });
  });

  // ============================================================================
  // 3. dequeue Tests
  // ============================================================================

  describe('dequeue', () => {
    test('should return null for empty queue', () => {
      const result = queue.dequeue();
      expect(result).toBeNull();
    });

    test('should return first pending request in FIFO order', () => {
      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });
      queue.enqueue({ traceId: 'req-2', originalError: new Error('2') });
      queue.enqueue({ traceId: 'req-3', originalError: new Error('3') });

      const result = queue.dequeue();
      expect(result.traceId).toBe('req-1');
    });

    test('should skip non-pending requests', () => {
      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });
      queue.enqueue({ traceId: 'req-2', originalError: new Error('2') });
      queue.enqueue({ traceId: 'req-3', originalError: new Error('3') });

      // Manually mark first request as succeeded
      const entry = queue.queue.get('req-1');
      entry.status = 'succeeded';

      const result = queue.dequeue();
      expect(result.traceId).toBe('req-2');
    });

    test('should return copy of entry, not reference', () => {
      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });

      const result = queue.dequeue();
      result.traceId = 'modified';

      const actual = queue.getByTraceId('req-1');
      expect(actual.traceId).toBe('req-1');
    });

    test('should return null if all requests are non-pending', () => {
      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });
      queue.enqueue({ traceId: 'req-2', originalError: new Error('2') });

      // Mark all as succeeded
      for (const entry of queue.queue.values()) {
        entry.status = 'succeeded';
      }

      const result = queue.dequeue();
      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // 4. replay Tests
  // ============================================================================

  describe('replay', () => {
    test('should throw error if request not found', async () => {
      await expect(queue.replay('non-existent')).rejects.toThrow(
        'Request non-existent not found in queue'
      );
    });

    test('should throw error if max retries exceeded', async () => {
      const q = new ReplayQueue({ maxRetries: 2 });
      q.enqueue({ traceId: 'req-1', originalError: new Error('1') });

      // Manually set retry count to max
      const entry = q.queue.get('req-1');
      entry.retryCount = 2;

      await expect(q.replay('req-1')).rejects.toThrow(
        'Request req-1 has exceeded max retries (2)'
      );

      q.destroy();
    });

    test('should perform dry run without sending', async () => {
      queue.enqueue({
        traceId: 'req-1',
        method: 'POST',
        path: '/v1/messages',
        headers: { 'x-test': 'value' },
        body: { message: 'test' },
        originalError: new Error('1')
      });

      const result = await queue.replay('req-1', { dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(result.traceId).toBe('req-1');
      expect(result.wouldReplay).toMatchObject({
        method: 'POST',
        path: '/v1/messages',
        headers: { 'x-test': 'value' },
        body: { message: 'test' }
      });
    });

    test('should apply header modifications in dry run', async () => {
      queue.enqueue({
        traceId: 'req-1',
        headers: { 'x-original': 'value' },
        originalError: new Error('1')
      });

      const result = await queue.replay('req-1', {
        dryRun: true,
        modifyHeaders: { 'x-modified': 'new-value' }
      });

      // In dry run, modifyHeaders replaces headers entirely (not merged)
      expect(result.wouldReplay.headers).toEqual({
        'x-modified': 'new-value'
      });
    });

    test('should apply body modifications in dry run', async () => {
      queue.enqueue({
        traceId: 'req-1',
        body: { original: 'body' },
        originalError: new Error('1')
      });

      const result = await queue.replay('req-1', {
        dryRun: true,
        modifyBody: { modified: 'body' }
      });

      expect(result.wouldReplay.body).toEqual({ modified: 'body' });
    });

    test('should return error result if no sendFunction provided', async () => {
      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });

      const result = await queue.replay('req-1');
      expect(result.success).toBe(false);
      expect(result.error.message).toBe('No sendFunction provided for replay');
    });

    test('should successfully replay with sendFunction', async () => {
      queue.enqueue({
        traceId: 'req-1',
        method: 'POST',
        path: '/v1/messages',
        body: { message: 'test' },
        originalError: new Error('1')
      });

      const mockResponse = { status: 200, data: 'success' };
      const sendFunction = jest.fn().mockResolvedValue(mockResponse);

      const result = await queue.replay('req-1', { sendFunction });

      expect(result.success).toBe(true);
      expect(result.traceId).toBe('req-1');
      expect(result.response).toEqual(mockResponse);
      expect(result.attempts).toBe(1);
      expect(sendFunction).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          path: '/v1/messages',
          body: { message: 'test' }
        })
      );
    });

    test('should update status and stats on success', async () => {
      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });

      const sendFunction = jest.fn().mockResolvedValue({ status: 200 });
      await queue.replay('req-1', { sendFunction });

      const entry = queue.queue.get('req-1');
      expect(entry.status).toBe('succeeded');
      expect(queue.stats.totalReplayed).toBe(1);
      expect(queue.stats.totalSucceeded).toBe(1);
    });

    test('should handle replay failure', async () => {
      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });

      const sendFunction = jest.fn().mockRejectedValue(new Error('Replay failed'));

      const result = await queue.replay('req-1', { sendFunction });

      expect(result.success).toBe(false);
      expect(result.error.message).toBe('Replay failed');
      expect(result.canRetry).toBe(true);
      expect(result.attempts).toBe(1);
    });

    test('should mark as pending after non-final failure', async () => {
      const q = new ReplayQueue({ maxRetries: 3 });
      q.enqueue({ traceId: 'req-1', originalError: new Error('1') });

      const sendFunction = jest.fn().mockRejectedValue(new Error('Failed'));
      await q.replay('req-1', { sendFunction });

      const entry = q.queue.get('req-1');
      expect(entry.status).toBe('pending');
      expect(entry.retryCount).toBe(1);

      q.destroy();
    });

    test('should mark as failed after final failure', async () => {
      const q = new ReplayQueue({ maxRetries: 1 });
      q.enqueue({ traceId: 'req-1', originalError: new Error('1') });

      const sendFunction = jest.fn().mockRejectedValue(new Error('Failed'));
      await q.replay('req-1', { sendFunction });

      const entry = q.queue.get('req-1');
      expect(entry.status).toBe('failed');
      expect(entry.retryCount).toBe(1);
      expect(q.stats.totalFailed).toBe(1);

      q.destroy();
    });

    test('should emit replayStart event', async () => {
      const events = [];
      queue.on('replayStart', (data) => events.push(data));

      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });
      const sendFunction = jest.fn().mockResolvedValue({ status: 200 });

      await queue.replay('req-1', { sendFunction });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        traceId: 'req-1',
        attempt: 1
      });
    });

    test('should emit replaySuccess event', async () => {
      const events = [];
      queue.on('replaySuccess', (data) => events.push(data));

      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });
      const sendFunction = jest.fn().mockResolvedValue({ status: 200 });

      await queue.replay('req-1', { sendFunction });

      expect(events).toHaveLength(1);
      expect(events[0].success).toBe(true);
      expect(events[0].traceId).toBe('req-1');
    });

    test('should emit replayError event', async () => {
      const events = [];
      queue.on('replayError', (data) => events.push(data));

      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });
      const sendFunction = jest.fn().mockRejectedValue(new Error('Failed'));

      await queue.replay('req-1', { sendFunction });

      expect(events).toHaveLength(1);
      expect(events[0].success).toBe(false);
      expect(events[0].traceId).toBe('req-1');
    });

    test('should update lastRetryAt timestamp', async () => {
      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });

      const beforeTime = Date.now();
      const sendFunction = jest.fn().mockResolvedValue({ status: 200 });
      await queue.replay('req-1', { sendFunction });
      const afterTime = Date.now();

      const entry = queue.queue.get('req-1');
      expect(entry.lastRetryAt).toBeGreaterThanOrEqual(beforeTime);
      expect(entry.lastRetryAt).toBeLessThanOrEqual(afterTime);
    });

    test('should pass targetKey to sendFunction', async () => {
      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });

      const sendFunction = jest.fn().mockResolvedValue({ status: 200 });
      await queue.replay('req-1', {
        sendFunction,
        targetKey: 'custom-key-123'
      });

      expect(sendFunction).toHaveBeenCalledWith(
        expect.objectContaining({
          targetKey: 'custom-key-123'
        })
      );
    });
  });

  // ============================================================================
  // 5. replayAll Tests
  // ============================================================================

  describe('replayAll', () => {
    test('should replay all pending requests', async () => {
      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });
      queue.enqueue({ traceId: 'req-2', originalError: new Error('2') });
      queue.enqueue({ traceId: 'req-3', originalError: new Error('3') });

      const sendFunction = jest.fn().mockResolvedValue({ status: 200 });
      const results = await queue.replayAll({}, { sendFunction });

      expect(results).toHaveLength(3);
      expect(sendFunction).toHaveBeenCalledTimes(3);
    });

    test('should filter by status', async () => {
      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });
      queue.enqueue({ traceId: 'req-2', originalError: new Error('2') });

      // Mark first as succeeded
      queue.queue.get('req-1').status = 'succeeded';

      const sendFunction = jest.fn().mockResolvedValue({ status: 200 });
      const results = await queue.replayAll({ status: 'pending' }, { sendFunction });

      expect(results).toHaveLength(1);
      expect(results[0].traceId).toBe('req-2');
    });

    test('should filter by method', async () => {
      queue.enqueue({ traceId: 'req-1', method: 'POST', originalError: new Error('1') });
      queue.enqueue({ traceId: 'req-2', method: 'GET', originalError: new Error('2') });

      const sendFunction = jest.fn().mockResolvedValue({ status: 200 });
      const results = await queue.replayAll({ method: 'POST' }, { sendFunction });

      expect(results).toHaveLength(1);
      expect(results[0].traceId).toBe('req-1');
    });

    test('should filter by path', async () => {
      queue.enqueue({ traceId: 'req-1', path: '/v1/messages', originalError: new Error('1') });
      queue.enqueue({ traceId: 'req-2', path: '/v1/complete', originalError: new Error('2') });

      const sendFunction = jest.fn().mockResolvedValue({ status: 200 });
      const results = await queue.replayAll({ path: '/v1/messages' }, { sendFunction });

      expect(results).toHaveLength(1);
      expect(results[0].traceId).toBe('req-1');
    });

    test('should filter by path regex', async () => {
      queue.enqueue({ traceId: 'req-1', path: '/v1/messages', originalError: new Error('1') });
      queue.enqueue({ traceId: 'req-2', path: '/v1/complete', originalError: new Error('2') });
      queue.enqueue({ traceId: 'req-3', path: '/v2/messages', originalError: new Error('3') });

      const sendFunction = jest.fn().mockResolvedValue({ status: 200 });
      const results = await queue.replayAll({ path: /\/v1\// }, { sendFunction });

      expect(results).toHaveLength(2);
      expect(results.map(r => r.traceId)).toContain('req-1');
      expect(results.map(r => r.traceId)).toContain('req-2');
    });

    test('should filter by time range', async () => {
      const now = Date.now();
      queue.enqueue({ traceId: 'req-1', timestamp: now - 3000, originalError: new Error('1') });
      queue.enqueue({ traceId: 'req-2', timestamp: now - 2000, originalError: new Error('2') });
      queue.enqueue({ traceId: 'req-3', timestamp: now - 1000, originalError: new Error('3') });

      const sendFunction = jest.fn().mockResolvedValue({ status: 200 });
      const results = await queue.replayAll(
        { afterTimestamp: now - 2500 },
        { sendFunction }
      );

      expect(results).toHaveLength(2);
      expect(results.map(r => r.traceId)).toContain('req-2');
      expect(results.map(r => r.traceId)).toContain('req-3');
    });

    test('should handle mixed success and failure', async () => {
      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });
      queue.enqueue({ traceId: 'req-2', originalError: new Error('2') });

      const sendFunction = jest.fn()
        .mockResolvedValueOnce({ status: 200 })
        .mockRejectedValueOnce(new Error('Failed'));

      const results = await queue.replayAll({}, { sendFunction });

      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
    });

    test('should catch and return errors from replay calls', async () => {
      const q = new ReplayQueue({ maxRetries: 3 });
      q.enqueue({ traceId: 'req-1', originalError: new Error('1') });

      // Set retryCount to exceed limit, causing replay() to throw
      q.queue.get('req-1').retryCount = 3;

      const results = await q.replayAll({}, {});

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error.message).toContain('exceeded max retries');

      q.destroy();
    });

    test('should emit replayAllStart event', async () => {
      const events = [];
      queue.on('replayAllStart', (data) => events.push(data));

      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });
      queue.enqueue({ traceId: 'req-2', originalError: new Error('2') });

      const sendFunction = jest.fn().mockResolvedValue({ status: 200 });
      await queue.replayAll({}, { sendFunction });

      expect(events).toHaveLength(1);
      expect(events[0].count).toBe(2);
    });

    test('should emit replayAllComplete event', async () => {
      const events = [];
      queue.on('replayAllComplete', (data) => events.push(data));

      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });

      const sendFunction = jest.fn().mockResolvedValue({ status: 200 });
      await queue.replayAll({}, { sendFunction });

      expect(events).toHaveLength(1);
      expect(events[0].results).toHaveLength(1);
    });
  });

  // ============================================================================
  // 6. getQueue / getByTraceId Tests
  // ============================================================================

  describe('getQueue and getByTraceId', () => {
    test('should return all requests without filter', () => {
      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });
      queue.enqueue({ traceId: 'req-2', originalError: new Error('2') });
      queue.enqueue({ traceId: 'req-3', originalError: new Error('3') });

      const results = queue.getQueue();
      expect(results).toHaveLength(3);
    });

    test('should return empty array for empty queue', () => {
      const results = queue.getQueue();
      expect(results).toEqual([]);
    });

    test('should filter by status', () => {
      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });
      queue.enqueue({ traceId: 'req-2', originalError: new Error('2') });

      queue.queue.get('req-1').status = 'succeeded';

      const results = queue.getQueue({ status: 'pending' });
      expect(results).toHaveLength(1);
      expect(results[0].traceId).toBe('req-2');
    });

    test('should filter by method', () => {
      queue.enqueue({ traceId: 'req-1', method: 'POST', originalError: new Error('1') });
      queue.enqueue({ traceId: 'req-2', method: 'GET', originalError: new Error('2') });

      const results = queue.getQueue({ method: 'GET' });
      expect(results).toHaveLength(1);
      expect(results[0].traceId).toBe('req-2');
    });

    test('should sort by priority then timestamp', () => {
      const now = Date.now();
      queue.enqueue({ traceId: 'req-1', priority: 0, timestamp: now - 3000, originalError: new Error('1') });
      queue.enqueue({ traceId: 'req-2', priority: 2, timestamp: now - 2000, originalError: new Error('2') });
      queue.enqueue({ traceId: 'req-3', priority: 1, timestamp: now - 1000, originalError: new Error('3') });

      const results = queue.getQueue();

      expect(results[0].traceId).toBe('req-2'); // priority 2
      expect(results[1].traceId).toBe('req-3'); // priority 1
      expect(results[2].traceId).toBe('req-1'); // priority 0
    });

    test('should return copy of entries, not references', () => {
      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });

      const results = queue.getQueue();
      results[0].traceId = 'modified';

      const actual = queue.getByTraceId('req-1');
      expect(actual.traceId).toBe('req-1');
    });

    test('getByTraceId should return request by traceId', () => {
      queue.enqueue({ traceId: 'req-1', method: 'POST', originalError: new Error('1') });

      const result = queue.getByTraceId('req-1');
      expect(result).not.toBeNull();
      expect(result.traceId).toBe('req-1');
      expect(result.method).toBe('POST');
    });

    test('getByTraceId should return null if not found', () => {
      const result = queue.getByTraceId('non-existent');
      expect(result).toBeNull();
    });

    test('getByTraceId should return copy, not reference', () => {
      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });

      const result = queue.getByTraceId('req-1');
      result.traceId = 'modified';

      const actual = queue.getByTraceId('req-1');
      expect(actual.traceId).toBe('req-1');
    });
  });

  // ============================================================================
  // 7. remove / clear Tests
  // ============================================================================

  describe('remove and clear', () => {
    test('remove should delete request from queue', () => {
      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });
      queue.enqueue({ traceId: 'req-2', originalError: new Error('2') });

      const result = queue.remove('req-1');

      expect(result).toBe(true);
      expect(queue.queue.size).toBe(1);
      expect(queue.getByTraceId('req-1')).toBeNull();
      expect(queue.order).not.toContain('req-1');
    });

    test('remove should return false if not found', () => {
      const result = queue.remove('non-existent');
      expect(result).toBe(false);
    });

    test('remove should emit removed event', () => {
      const events = [];
      queue.on('removed', (data) => events.push(data));

      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });
      queue.remove('req-1');

      expect(events).toHaveLength(1);
      expect(events[0].traceId).toBe('req-1');
    });

    test('clear should remove all requests', () => {
      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });
      queue.enqueue({ traceId: 'req-2', originalError: new Error('2') });
      queue.enqueue({ traceId: 'req-3', originalError: new Error('3') });

      const count = queue.clear();

      expect(count).toBe(3);
      expect(queue.queue.size).toBe(0);
      expect(queue.order).toEqual([]);
    });

    test('clear should return 0 for empty queue', () => {
      const count = queue.clear();
      expect(count).toBe(0);
    });

    test('clear should emit cleared event', () => {
      const events = [];
      queue.on('cleared', (data) => events.push(data));

      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });
      queue.enqueue({ traceId: 'req-2', originalError: new Error('2') });

      queue.clear();

      expect(events).toHaveLength(1);
      expect(events[0].count).toBe(2);
    });

    test('clear with filter should remove only matching requests', () => {
      queue.enqueue({ traceId: 'req-1', method: 'POST', originalError: new Error('1') });
      queue.enqueue({ traceId: 'req-2', method: 'GET', originalError: new Error('2') });
      queue.enqueue({ traceId: 'req-3', method: 'POST', originalError: new Error('3') });

      const count = queue.clear({ method: 'POST' });

      expect(count).toBe(2);
      expect(queue.queue.size).toBe(1);
      expect(queue.getByTraceId('req-2')).not.toBeNull();
    });

    test('clear with filter should emit removed events for each', () => {
      const events = [];
      queue.on('removed', (data) => events.push(data));

      queue.enqueue({ traceId: 'req-1', status: 'pending', originalError: new Error('1') });
      queue.enqueue({ traceId: 'req-2', status: 'pending', originalError: new Error('2') });

      queue.queue.get('req-1').status = 'failed';

      queue.clear({ status: 'failed' });

      expect(events).toHaveLength(1);
      expect(events[0].traceId).toBe('req-1');
    });
  });

  // ============================================================================
  // 8. getStats Tests
  // ============================================================================

  describe('getStats', () => {
    test('should return accurate statistics', () => {
      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });
      queue.enqueue({ traceId: 'req-2', originalError: new Error('2') });

      const stats = queue.getStats();

      expect(stats.totalEnqueued).toBe(2);
      expect(stats.currentSize).toBe(2);
      expect(stats.maxSize).toBe(100);
      expect(stats.utilizationPercent).toBe(2);
    });

    test('should count requests by status', () => {
      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });
      queue.enqueue({ traceId: 'req-2', originalError: new Error('2') });
      queue.enqueue({ traceId: 'req-3', originalError: new Error('3') });

      queue.queue.get('req-1').status = 'succeeded';
      queue.queue.get('req-2').status = 'failed';

      const stats = queue.getStats();

      expect(stats.statusCounts.pending).toBe(1);
      expect(stats.statusCounts.succeeded).toBe(1);
      expect(stats.statusCounts.failed).toBe(1);
      expect(stats.statusCounts.replaying).toBe(0);
    });

    test('should track oldest and newest entries', () => {
      const now = Date.now();
      queue.enqueue({ traceId: 'req-1', timestamp: now - 3000, originalError: new Error('1') });
      queue.enqueue({ traceId: 'req-2', timestamp: now - 1000, originalError: new Error('2') });

      const stats = queue.getStats();

      expect(new Date(stats.oldestEntry).getTime()).toBe(now - 3000);
      expect(new Date(stats.newestEntry).getTime()).toBe(now - 1000);
    });

    test('should return null for oldest/newest in empty queue', () => {
      const stats = queue.getStats();

      expect(stats.oldestEntry).toBeNull();
      expect(stats.newestEntry).toBeNull();
    });

    test('should calculate utilization percent correctly', () => {
      const q = new ReplayQueue({ maxQueueSize: 50 });

      for (let i = 0; i < 25; i++) {
        q.enqueue({ traceId: `req-${i}`, originalError: new Error(`${i}`) });
      }

      const stats = q.getStats();
      expect(stats.utilizationPercent).toBe(50);

      q.destroy();
    });

    test('should include all stat counters', () => {
      const stats = queue.getStats();

      expect(stats).toHaveProperty('totalEnqueued');
      expect(stats).toHaveProperty('totalReplayed');
      expect(stats).toHaveProperty('totalSucceeded');
      expect(stats).toHaveProperty('totalFailed');
      expect(stats).toHaveProperty('totalExpired');
      expect(stats).toHaveProperty('currentSize');
      expect(stats).toHaveProperty('maxSize');
      expect(stats).toHaveProperty('utilizationPercent');
      expect(stats).toHaveProperty('statusCounts');
      expect(stats).toHaveProperty('oldestEntry');
      expect(stats).toHaveProperty('newestEntry');
    });
  });

  // ============================================================================
  // 9. Expiration Tests
  // ============================================================================

  describe('Expiration', () => {
    test('should cleanup expired entries', () => {
      const q = new ReplayQueue({ retentionPeriod: 1000 }); // 1 second

      const oldTimestamp = Date.now() - 2000; // 2 seconds ago
      q.enqueue({ traceId: 'req-old', timestamp: oldTimestamp, originalError: new Error('old') });
      q.enqueue({ traceId: 'req-new', originalError: new Error('new') });

      // Manually trigger cleanup
      q._cleanupExpired();

      expect(q.queue.size).toBe(1);
      expect(q.getByTraceId('req-old')).toBeNull();
      expect(q.getByTraceId('req-new')).not.toBeNull();
      expect(q.stats.totalExpired).toBe(1);

      q.destroy();
    });

    test('should emit expired event with details', () => {
      const q = new ReplayQueue({ retentionPeriod: 1000 });
      const events = [];
      q.on('expired', (data) => events.push(data));

      const oldTimestamp = Date.now() - 2000;
      q.enqueue({ traceId: 'req-1', timestamp: oldTimestamp, originalError: new Error('1') });
      q.enqueue({ traceId: 'req-2', timestamp: oldTimestamp, originalError: new Error('2') });

      q._cleanupExpired();

      expect(events).toHaveLength(1);
      expect(events[0].count).toBe(2);
      expect(events[0].traceIds).toContain('req-1');
      expect(events[0].traceIds).toContain('req-2');

      q.destroy();
    });

    test('should not cleanup entries within retention period', () => {
      const q = new ReplayQueue({ retentionPeriod: 10000 }); // 10 seconds

      const recentTimestamp = Date.now() - 5000; // 5 seconds ago
      q.enqueue({ traceId: 'req-1', timestamp: recentTimestamp, originalError: new Error('1') });

      q._cleanupExpired();

      expect(q.queue.size).toBe(1);
      expect(q.getByTraceId('req-1')).not.toBeNull();

      q.destroy();
    });

    test('should not emit expired event if nothing expired', () => {
      const q = new ReplayQueue({ retentionPeriod: 10000 });
      const events = [];
      q.on('expired', (data) => events.push(data));

      q.enqueue({ traceId: 'req-1', originalError: new Error('1') });
      q._cleanupExpired();

      expect(events).toHaveLength(0);

      q.destroy();
    });

    test('should have cleanup interval running', () => {
      const q = new ReplayQueue();
      expect(q.cleanupInterval).toBeDefined();
      q.destroy();
    });

    test('destroy should clear cleanup interval', () => {
      const q = new ReplayQueue();
      const interval = q.cleanupInterval;

      q.destroy();

      expect(q.cleanupInterval).toBeNull();
    });

    test('should handle multiple cleanup calls safely', () => {
      const q = new ReplayQueue({ retentionPeriod: 1000 });

      const oldTimestamp = Date.now() - 2000;
      q.enqueue({ traceId: 'req-1', timestamp: oldTimestamp, originalError: new Error('1') });

      q._cleanupExpired();
      q._cleanupExpired();
      q._cleanupExpired();

      expect(q.queue.size).toBe(0);
      expect(q.stats.totalExpired).toBe(1);

      q.destroy();
    });
  });

  // ============================================================================
  // Additional Edge Cases
  // ============================================================================

  describe('Edge cases', () => {
    test('should handle empty body', () => {
      queue.enqueue({ traceId: 'req-1', body: undefined, originalError: new Error('1') });
      const entry = queue.getByTraceId('req-1');
      expect(entry.body).toBeUndefined();
    });

    test('should handle empty headers', () => {
      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });
      const entry = queue.getByTraceId('req-1');
      expect(entry.headers).toEqual({});
    });

    test('should handle complex body objects', () => {
      const complexBody = {
        nested: { data: 'value' },
        array: [1, 2, 3],
        null: null,
        number: 42
      };

      queue.enqueue({ traceId: 'req-1', body: complexBody, originalError: new Error('1') });
      const entry = queue.getByTraceId('req-1');
      expect(entry.body).toEqual(complexBody);
    });

    test('should handle concurrent enqueue operations', () => {
      for (let i = 0; i < 10; i++) {
        queue.enqueue({ traceId: `req-${i}`, originalError: new Error(`${i}`) });
      }

      expect(queue.queue.size).toBe(10);
      expect(queue.order).toHaveLength(10);
      expect(queue.stats.totalEnqueued).toBe(10);
    });

    test('should maintain data integrity after remove', () => {
      queue.enqueue({ traceId: 'req-1', originalError: new Error('1') });
      queue.enqueue({ traceId: 'req-2', originalError: new Error('2') });
      queue.enqueue({ traceId: 'req-3', originalError: new Error('3') });

      queue.remove('req-2');

      expect(queue.queue.size).toBe(2);
      expect(queue.order).toEqual(['req-1', 'req-3']);
      expect(queue.getByTraceId('req-1')).not.toBeNull();
      expect(queue.getByTraceId('req-3')).not.toBeNull();
    });

    test('should handle filter with multiple criteria', () => {
      const now = Date.now();
      queue.enqueue({
        traceId: 'req-1',
        method: 'POST',
        path: '/v1/messages',
        timestamp: now - 3000,
        originalError: new Error('1')
      });
      queue.enqueue({
        traceId: 'req-2',
        method: 'POST',
        path: '/v1/complete',
        timestamp: now - 2000,
        originalError: new Error('2')
      });
      queue.enqueue({
        traceId: 'req-3',
        method: 'GET',
        path: '/v1/messages',
        timestamp: now - 1000,
        originalError: new Error('3')
      });

      const results = queue.getQueue({
        method: 'POST',
        path: /messages/,
        afterTimestamp: now - 4000
      });

      expect(results).toHaveLength(1);
      expect(results[0].traceId).toBe('req-1');
    });
  });
});
