'use strict';

/**
 * Fixed-size ring buffer with O(1) push operations.
 *
 * When the buffer reaches capacity, new items overwrite the oldest items.
 * This is useful for maintaining bounded memory usage for things like
 * latency samples, recent requests, etc.
 *
 * @example
 * const buffer = new RingBuffer(5);
 * buffer.push(1); buffer.push(2); buffer.push(3);
 * buffer.toArray(); // [1, 2, 3]
 * buffer.push(4); buffer.push(5); buffer.push(6);
 * buffer.toArray(); // [2, 3, 4, 5, 6] - oldest (1) was overwritten
 */
class RingBuffer {
    /**
     * @param {number} capacity - Maximum number of items to store
     */
    constructor(capacity) {
        if (!Number.isInteger(capacity) || capacity < 1) {
            throw new Error('RingBuffer capacity must be a positive integer');
        }
        this.capacity = capacity;
        this.buffer = new Array(capacity);
        this.head = 0;      // Next write position
        this.size = 0;      // Current number of items
    }

    /**
     * Add an item to the buffer. O(1) operation.
     * If at capacity, overwrites the oldest item.
     * @param {*} item - Item to add
     */
    push(item) {
        this.buffer[this.head] = item;
        this.head = (this.head + 1) % this.capacity;
        if (this.size < this.capacity) {
            this.size++;
        }
    }

    /**
     * Convert buffer contents to an array.
     * Returns items in insertion order (oldest first).
     * @returns {Array} Array of items from oldest to newest
     */
    toArray() {
        if (this.size === 0) return [];

        if (this.size < this.capacity) {
            // Buffer not full yet - items are at start of array
            return this.buffer.slice(0, this.size);
        }

        // Buffer is full - head points to oldest item
        // Order: [head..end] + [0..head-1]
        const tail = this.head;
        return [...this.buffer.slice(tail), ...this.buffer.slice(0, tail)];
    }

    /**
     * Get the most recent N items in reverse chronological order (newest first).
     * @param {number} count - Number of items to retrieve
     * @returns {Array} Array of items from newest to oldest
     */
    getRecent(count) {
        if (this.size === 0 || count <= 0) return [];

        const n = Math.min(count, this.size);
        const result = new Array(n);

        // Most recent item is at (head - 1), wrap around
        let idx = (this.head - 1 + this.capacity) % this.capacity;

        for (let i = 0; i < n; i++) {
            result[i] = this.buffer[idx];
            idx = (idx - 1 + this.capacity) % this.capacity;
        }

        return result;
    }

    /**
     * Get the item at a specific index (0 = oldest).
     * @param {number} index - Index from oldest item
     * @returns {*} Item at index, or undefined if out of bounds
     */
    get(index) {
        if (index < 0 || index >= this.size) return undefined;

        if (this.size < this.capacity) {
            return this.buffer[index];
        }

        // Calculate actual position in circular buffer
        const actualIndex = (this.head + index) % this.capacity;
        return this.buffer[actualIndex];
    }

    /**
     * Get the most recent item (newest).
     * @returns {*} Most recent item, or undefined if empty
     */
    peek() {
        if (this.size === 0) return undefined;
        const idx = (this.head - 1 + this.capacity) % this.capacity;
        return this.buffer[idx];
    }

    /**
     * Clear all items from the buffer.
     */
    clear() {
        this.head = 0;
        this.size = 0;
        // Don't need to clear array contents - they'll be overwritten
    }

    /**
     * Check if buffer is empty.
     * @returns {boolean}
     */
    isEmpty() {
        return this.size === 0;
    }

    /**
     * Check if buffer is at capacity.
     * @returns {boolean}
     */
    isFull() {
        return this.size === this.capacity;
    }

    /**
     * Current number of items in buffer.
     * @type {number}
     */
    get length() {
        return this.size;
    }

    /**
     * Iterate over items from oldest to newest.
     */
    *[Symbol.iterator]() {
        if (this.size === 0) return;

        if (this.size < this.capacity) {
            for (let i = 0; i < this.size; i++) {
                yield this.buffer[i];
            }
        } else {
            // Start from head (oldest) and wrap around
            for (let i = 0; i < this.capacity; i++) {
                yield this.buffer[(this.head + i) % this.capacity];
            }
        }
    }

    /**
     * Calculate average of numeric items.
     * @returns {number|null} Average rounded to nearest integer, or null if empty
     */
    average() {
        if (this.size === 0) return null;

        let sum = 0;
        for (const item of this) {
            sum += item;
        }
        return Math.round(sum / this.size);
    }

    /**
     * Get buffer statistics for numeric items.
     * Uses nearest-rank method for percentiles:
     *   index = ceil(percentile * n) - 1
     * @returns {Object} { count, avg, min, max, p50, p95, p99 }
     */
    stats() {
        if (this.size === 0) {
            return { count: 0, avg: null, min: null, max: null, p50: null, p95: null, p99: null };
        }

        const values = this.toArray().sort((a, b) => a - b);
        const n = values.length;
        const sum = values.reduce((a, b) => a + b, 0);

        return {
            count: n,
            avg: Math.round(sum / n),
            min: values[0],
            max: values[n - 1],
            p50: values[Math.ceil(0.5 * n) - 1],
            p95: values[Math.ceil(0.95 * n) - 1],
            p99: values[Math.ceil(0.99 * n) - 1]
        };
    }
}

module.exports = { RingBuffer };
