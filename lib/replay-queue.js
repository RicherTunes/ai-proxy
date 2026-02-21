const EventEmitter = require('events');

/**
 * ReplayQueue - Manages failed requests for replay and debugging
 *
 * Provides a queue system for capturing, storing, and replaying failed API requests
 * with configurable retry policies and filtering options.
 */
class ReplayQueue extends EventEmitter {
  /**
   * @param {Object} config - Configuration options
   * @param {number} config.maxQueueSize - Maximum number of requests to store (default: 100)
   * @param {number} config.retentionPeriod - How long to keep requests in ms (default: 24 hours)
   * @param {number} config.maxRetries - Maximum retry attempts per request (default: 3)
   */
  constructor(config = {}) {
    super();

    // Validate config
    if (config !== null && typeof config !== 'object') {
      throw new TypeError('config must be an object');
    }

    // Parse and validate numeric configs
    const maxQueueSize = Number(config.maxQueueSize) || 100;
    const retentionPeriod = Number(config.retentionPeriod) || 24 * 60 * 60 * 1000;
    const maxRetries = Number(config.maxRetries) || 3;

    if (maxQueueSize < 1 || maxQueueSize > 10000) {
      throw new RangeError('maxQueueSize must be between 1 and 10000');
    }
    if (retentionPeriod < 1000 || retentionPeriod > 7 * 24 * 60 * 60 * 1000) {
      throw new RangeError('retentionPeriod must be between 1 second and 7 days');
    }
    if (maxRetries < 0 || maxRetries > 100) {
      throw new RangeError('maxRetries must be between 0 and 100');
    }

    this.config = {
      maxQueueSize,
      retentionPeriod,
      maxRetries
    };

    // Map of traceId -> request data
    this.queue = new Map();

    // Ordered list of traceIds for FIFO
    this.order = [];

    // Statistics
    this.stats = {
      totalEnqueued: 0,
      totalReplayed: 0,
      totalSucceeded: 0,
      totalFailed: 0,
      totalExpired: 0
    };

    // Start periodic cleanup
    this._startCleanup();
  }

  /**
   * Add a failed request to the replay queue
   *
   * @param {Object} request - Request details
   * @param {string} request.traceId - Unique trace ID
   * @param {string} request.method - HTTP method
   * @param {string} request.path - Request path
   * @param {Object} request.headers - Request headers
   * @param {*} request.body - Request body
   * @param {Error} request.originalError - Original error that caused failure
   * @param {number} [request.timestamp] - When the request was made (default: now)
   * @param {number} [request.priority] - Priority for replay ordering (default: 0)
   * @returns {boolean} - True if enqueued, false if queue is full
   */
  enqueue(request) {
    // Validate request object
    if (!request || typeof request !== 'object') {
      throw new TypeError('Request must be an object');
    }

    // Validate required fields
    if (typeof request.traceId !== 'string' || request.traceId.length === 0) {
      throw new Error('Request must have a non-empty traceId string');
    }

    // Check queue size limit
    if (this.queue.size >= this.config.maxQueueSize) {
      this.emit('queueFull', { size: this.queue.size, limit: this.config.maxQueueSize });

      // Remove oldest entry to make room
      const oldestId = this.order.shift();
      if (oldestId) {
        this.queue.delete(oldestId);
        this.emit('evicted', { traceId: oldestId, reason: 'queueFull' });
      }
    }

    // Create queue entry
    const entry = {
      traceId: request.traceId,
      method: request.method || 'POST',
      path: request.path || '/v1/messages',
      headers: { ...request.headers },
      body: request.body,
      originalError: {
        message: request.originalError?.message,
        code: request.originalError?.code,
        status: request.originalError?.status,
        stack: request.originalError?.stack
      },
      timestamp: request.timestamp || Date.now(),
      priority: request.priority || 0,
      retryCount: 0,
      lastRetryAt: null,
      status: 'pending' // pending, replaying, succeeded, failed
    };

    // Add to queue
    this.queue.set(entry.traceId, entry);
    this.order.push(entry.traceId);
    this.stats.totalEnqueued++;

    this.emit('enqueued', { traceId: entry.traceId, queueSize: this.queue.size });

    return true;
  }

  /**
   * Get the next request to replay (FIFO)
   *
   * @returns {Object|null} - Next request or null if queue is empty
   */
  dequeue() {
    if (this.order.length === 0) {
      return null;
    }

    // Find first pending request
    for (let i = 0; i < this.order.length; i++) {
      const traceId = this.order[i];
      const entry = this.queue.get(traceId);

      if (entry && entry.status === 'pending') {
        return { ...entry };
      }
    }

    return null;
  }

  /**
   * Replay a specific request
   *
   * @param {string} traceId - Request trace ID
   * @param {Object} options - Replay options
   * @param {string} [options.targetKey] - Force specific API key
   * @param {Object} [options.modifyHeaders] - Override headers
   * @param {*} [options.modifyBody] - Modify request body
   * @param {boolean} [options.dryRun] - Simulate without actually sending
   * @param {Function} [options.sendFunction] - Custom function to send request
   * @returns {Promise<Object>} - Replay result
   */
  async replay(traceId, options = {}) {
    // Validate traceId
    if (typeof traceId !== 'string' || traceId.length === 0) {
      throw new TypeError('traceId must be a non-empty string');
    }

    const entry = this.queue.get(traceId);

    if (!entry) {
      throw new Error(`Request ${traceId} not found in queue`);
    }

    // Check if already being replayed (race condition protection)
    if (entry.status === 'replaying') {
      throw new Error(`Request ${traceId} is already being replayed`);
    }

    // Check retry limit
    if (entry.retryCount >= this.config.maxRetries) {
      throw new Error(`Request ${traceId} has exceeded max retries (${this.config.maxRetries})`);
    }

    // Update status
    entry.status = 'replaying';
    entry.retryCount++;
    entry.lastRetryAt = Date.now();
    this.stats.totalReplayed++;

    this.emit('replayStart', { traceId, attempt: entry.retryCount });

    try {
      // Dry run mode
      if (options.dryRun) {
        const result = {
          traceId,
          dryRun: true,
          wouldReplay: {
            method: entry.method,
            path: entry.path,
            headers: options.modifyHeaders || entry.headers,
            body: options.modifyBody || entry.body
          }
        };

        this.emit('replayDryRun', result);
        return result;
      }

      // Prepare request
      const replayRequest = {
        method: entry.method,
        path: entry.path,
        headers: { ...entry.headers, ...(options.modifyHeaders || {}) },
        body: options.modifyBody !== undefined ? options.modifyBody : entry.body,
        targetKey: options.targetKey
      };

      // Send request
      let response;
      if (options.sendFunction && typeof options.sendFunction === 'function') {
        response = await options.sendFunction(replayRequest);
      } else {
        // No sender provided, can't actually replay
        throw new Error('No sendFunction provided for replay');
      }

      // Success
      entry.status = 'succeeded';
      this.stats.totalSucceeded++;

      const result = {
        traceId,
        success: true,
        response,
        attempts: entry.retryCount
      };

      this.emit('replaySuccess', result);

      return result;

    } catch (error) {
      // Failure
      const isFinalAttempt = entry.retryCount >= this.config.maxRetries;
      entry.status = isFinalAttempt ? 'failed' : 'pending';

      if (isFinalAttempt) {
        this.stats.totalFailed++;
      }

      const result = {
        traceId,
        success: false,
        error: {
          message: error.message,
          code: error.code,
          status: error.status
        },
        attempts: entry.retryCount,
        canRetry: !isFinalAttempt
      };

      this.emit('replayError', result);

      return result;
    }
  }

  /**
   * Replay all requests matching filter
   *
   * @param {Object} filter - Filter criteria
   * @param {string} [filter.status] - Filter by status
   * @param {string} [filter.method] - Filter by HTTP method
   * @param {string} [filter.path] - Filter by path (supports regex)
   * @param {number} [filter.afterTimestamp] - Only requests after this time
   * @param {number} [filter.beforeTimestamp] - Only requests before this time
   * @param {Object} options - Replay options (same as replay())
   * @returns {Promise<Object[]>} - Array of replay results
   */
  async replayAll(filter = {}, options = {}) {
    const requests = this._filterRequests(filter);

    this.emit('replayAllStart', { count: requests.length, filter });

    const results = [];

    for (const request of requests) {
      try {
        const result = await this.replay(request.traceId, options);
        results.push(result);
      } catch (error) {
        results.push({
          traceId: request.traceId,
          success: false,
          error: { message: error.message }
        });
      }
    }

    this.emit('replayAllComplete', { results, filter });

    return results;
  }

  /**
   * Get all queued requests
   *
   * @param {Object} filter - Optional filter criteria
   * @returns {Object[]} - Array of request entries
   */
  getQueue(filter = {}) {
    return this._filterRequests(filter);
  }

  /**
   * Get a specific request by trace ID
   *
   * @param {string} traceId - Request trace ID
   * @returns {Object|null} - Request entry or null
   */
  getByTraceId(traceId) {
    const entry = this.queue.get(traceId);
    return entry ? { ...entry } : null;
  }

  /**
   * Remove a request from the queue
   *
   * @param {string} traceId - Request trace ID
   * @returns {boolean} - True if removed, false if not found
   */
  remove(traceId) {
    const existed = this.queue.delete(traceId);

    if (existed) {
      const index = this.order.indexOf(traceId);
      if (index !== -1) {
        this.order.splice(index, 1);
      }

      this.emit('removed', { traceId });
    }

    return existed;
  }

  /**
   * Clear the entire queue
   *
   * @param {Object} filter - Optional filter to clear only matching requests
   * @returns {number} - Number of requests cleared
   */
  clear(filter = {}) {
    if (Object.keys(filter).length === 0) {
      // Clear all
      const count = this.queue.size;
      this.queue.clear();
      this.order = [];

      this.emit('cleared', { count });

      return count;
    } else {
      // Clear filtered
      const toRemove = this._filterRequests(filter);

      for (const request of toRemove) {
        this.remove(request.traceId);
      }

      return toRemove.length;
    }
  }

  /**
   * Get queue statistics
   *
   * @returns {Object} - Statistics object
   */
  getStats() {
    const now = Date.now();
    const statusCounts = {
      pending: 0,
      replaying: 0,
      succeeded: 0,
      failed: 0
    };

    let oldestTimestamp = now;
    let newestTimestamp = 0;

    for (const entry of this.queue.values()) {
      statusCounts[entry.status]++;

      if (entry.timestamp < oldestTimestamp) {
        oldestTimestamp = entry.timestamp;
      }
      if (entry.timestamp > newestTimestamp) {
        newestTimestamp = entry.timestamp;
      }
    }

    return {
      ...this.stats,
      currentSize: this.queue.size,
      maxSize: this.config.maxQueueSize,
      utilizationPercent: (this.queue.size / this.config.maxQueueSize) * 100,
      statusCounts,
      oldestEntry: this.queue.size > 0 ? new Date(oldestTimestamp).toISOString() : null,
      newestEntry: this.queue.size > 0 ? new Date(newestTimestamp).toISOString() : null
    };
  }

  /**
   * Filter requests based on criteria
   *
   * @private
   * @param {Object} filter - Filter criteria
   * @returns {Object[]} - Filtered requests
   */
  _filterRequests(filter) {
    const results = [];

    for (const entry of this.queue.values()) {
      let match = true;

      // Status filter
      if (filter.status && entry.status !== filter.status) {
        match = false;
      }

      // Method filter
      if (filter.method && entry.method !== filter.method) {
        match = false;
      }

      // Path filter (supports regex)
      if (filter.path) {
        if (filter.path instanceof RegExp) {
          if (!filter.path.test(entry.path)) {
            match = false;
          }
        } else if (entry.path !== filter.path) {
          match = false;
        }
      }

      // Time range filters
      if (filter.afterTimestamp && entry.timestamp <= filter.afterTimestamp) {
        match = false;
      }

      if (filter.beforeTimestamp && entry.timestamp >= filter.beforeTimestamp) {
        match = false;
      }

      if (match) {
        results.push({ ...entry });
      }
    }

    // Sort by priority (descending) then timestamp (ascending)
    results.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return a.timestamp - b.timestamp;
    });

    return results;
  }

  /**
   * Start periodic cleanup of expired entries
   *
   * @private
   */
  _startCleanup() {
    // Run cleanup every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this._cleanupExpired();
    }, 5 * 60 * 1000);

    // Don't block process exit
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Remove expired entries from queue
   *
   * @private
   */
  _cleanupExpired() {
    const now = Date.now();
    const expirationTime = now - this.config.retentionPeriod;
    const toRemove = [];

    for (const entry of this.queue.values()) {
      if (entry.timestamp < expirationTime) {
        toRemove.push(entry.traceId);
      }
    }

    for (const traceId of toRemove) {
      this.remove(traceId);
      this.stats.totalExpired++;
    }

    if (toRemove.length > 0) {
      this.emit('expired', { count: toRemove.length, traceIds: toRemove });
    }
  }

  /**
   * Stop cleanup interval
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

module.exports = ReplayQueue;
