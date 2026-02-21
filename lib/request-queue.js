/**
 * Request Queue Module
 * Handles queuing of requests when all API keys are at capacity
 *
 * Features:
 * - FIFO queue with configurable max size
 * - Configurable timeout for queued requests
 * - Proper cleanup on timeout/cancellation
 * - Metrics for monitoring queue health
 */

class RequestQueue {
    constructor(options = {}) {
        this.maxSize = options.maxSize || 100;
        this.timeout = options.timeout || 30000; // 30 seconds default
        this.queue = [];
        this.logger = options.logger;

        // Metrics
        this.metrics = {
            totalEnqueued: 0,
            totalDequeued: 0,
            totalTimedOut: 0,
            totalRejected: 0,  // Queue was full
            peakSize: 0
        };
    }

    /**
     * Get current queue length
     */
    get length() {
        return this.queue.length;
    }

    /**
     * Check if queue has capacity
     */
    hasCapacity() {
        return this.queue.length < this.maxSize;
    }

    /**
     * Get queue position for a request (1-indexed)
     */
    getPosition(requestId) {
        const index = this.queue.findIndex(item => item.requestId === requestId);
        return index === -1 ? -1 : index + 1;
    }

    /**
     * Enqueue a request and wait for a slot
     * @param {string} requestId - Unique request identifier
     * @param {Object} options - Additional options
     * @returns {Promise<boolean>} - Resolves true when slot available, false on timeout/rejection
     */
    async enqueue(requestId, options = {}) {
        const timeout = options.timeout || this.timeout;

        // Check capacity
        if (!this.hasCapacity()) {
            this.metrics.totalRejected++;
            this.logger?.warn('Queue full, rejecting request', {
                requestId,
                queueSize: this.queue.length,
                maxSize: this.maxSize
            });
            return { success: false, reason: 'queue_full' };
        }

        // Create queue entry
        const entry = {
            requestId,
            enqueuedAt: Date.now(),
            resolve: null,
            reject: null,
            timeoutHandle: null
        };

        // Create promise that resolves when slot is available
        const slotPromise = new Promise((resolve, reject) => {
            entry.resolve = resolve;
            entry.reject = reject;
        });

        // Set timeout
        entry.timeoutHandle = setTimeout(() => {
            this._handleTimeout(entry);
        }, timeout);

        // Add to queue
        this.queue.push(entry);
        this.metrics.totalEnqueued++;
        this.metrics.peakSize = Math.max(this.metrics.peakSize, this.queue.length);

        this.logger?.debug('Request enqueued', {
            requestId,
            position: this.queue.length,
            timeout
        });

        // Wait for slot
        try {
            const result = await slotPromise;
            return { success: true, waitTime: Date.now() - entry.enqueuedAt, ...result };
        } catch (err) {
            return { success: false, reason: err.message, waitTime: Date.now() - entry.enqueuedAt };
        }
    }

    /**
     * Handle timeout for a queued request
     */
    _handleTimeout(entry) {
        const index = this.queue.indexOf(entry);
        if (index === -1) return; // Already dequeued

        this.queue.splice(index, 1);
        this.metrics.totalTimedOut++;

        this.logger?.warn('Queued request timed out', {
            requestId: entry.requestId,
            waitTime: Date.now() - entry.enqueuedAt
        });

        entry.reject(new Error('queue_timeout'));
    }

    /**
     * Signal that a slot is available - wake up next queued request
     * @returns {boolean} - True if a request was dequeued
     */
    signalSlotAvailable() {
        if (this.queue.length === 0) {
            return false;
        }

        const entry = this.queue.shift();
        this.metrics.totalDequeued++;

        // Clear timeout
        if (entry.timeoutHandle) {
            clearTimeout(entry.timeoutHandle);
        }

        const waitTime = Date.now() - entry.enqueuedAt;
        this.logger?.debug('Request dequeued', {
            requestId: entry.requestId,
            waitTime,
            remainingQueue: this.queue.length
        });

        // Wake up the waiting request
        entry.resolve({ waitTime });
        return true;
    }

    /**
     * Cancel a specific queued request
     * @param {string} requestId - Request to cancel
     * @returns {boolean} - True if request was found and cancelled
     */
    cancel(requestId) {
        const index = this.queue.findIndex(item => item.requestId === requestId);
        if (index === -1) return false;

        const entry = this.queue.splice(index, 1)[0];
        if (entry.timeoutHandle) {
            clearTimeout(entry.timeoutHandle);
        }
        entry.reject(new Error('cancelled'));
        return true;
    }

    /**
     * Get queue statistics
     */
    getStats() {
        const now = Date.now();
        const waitTimes = this.queue.map(e => now - e.enqueuedAt);

        return {
            current: this.queue.length,
            max: this.maxSize,
            available: this.maxSize - this.queue.length,
            percentUsed: Math.round((this.queue.length / this.maxSize) * 100),
            oldestWaitMs: waitTimes.length > 0 ? Math.max(...waitTimes) : 0,
            avgWaitMs: waitTimes.length > 0
                ? Math.round(waitTimes.reduce((a, b) => a + b, 0) / waitTimes.length)
                : 0,
            metrics: { ...this.metrics }
        };
    }

    /**
     * Clear all queued requests (for shutdown)
     * @param {string} reason - Reason for clearing
     */
    clear(reason = 'shutdown') {
        while (this.queue.length > 0) {
            const entry = this.queue.shift();
            if (entry.timeoutHandle) {
                clearTimeout(entry.timeoutHandle);
            }
            entry.reject(new Error(reason));
        }
    }

    /**
     * Reset metrics (for testing)
     */
    resetMetrics() {
        this.metrics = {
            totalEnqueued: 0,
            totalDequeued: 0,
            totalTimedOut: 0,
            totalRejected: 0,
            peakSize: 0
        };
    }
}

module.exports = { RequestQueue };
