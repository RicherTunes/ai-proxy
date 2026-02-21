'use strict';

/**
 * LRUMap - A Map with LRU eviction when max size is exceeded.
 * Evicts least-recently-used entries when size exceeds maxSize.
 */
class LRUMap {
    /**
     * @param {number} maxSize - Maximum number of entries before eviction
     * @param {Object} options - { logger, onEvict }
     */
    constructor(maxSize = 1000, options = {}) {
        this._maxSize = maxSize;
        this._map = new Map();
        this._logger = options.logger || null;
        this._onEvict = options.onEvict || null;
        this._evictions = 0;
    }

    get size() {
        return this._map.size;
    }

    has(key) {
        return this._map.has(key);
    }

    get(key) {
        if (!this._map.has(key)) return undefined;
        // Move to end (most recently used)
        const value = this._map.get(key);
        this._map.delete(key);
        this._map.set(key, value);
        return value;
    }

    set(key, value) {
        // If key exists, delete first (to update insertion order)
        if (this._map.has(key)) {
            this._map.delete(key);
        }
        this._map.set(key, value);
        // Evict oldest entries if over capacity
        this._evict();
        return this;
    }

    delete(key) {
        return this._map.delete(key);
    }

    clear() {
        this._map.clear();
    }

    keys() {
        return this._map.keys();
    }

    values() {
        return this._map.values();
    }

    entries() {
        return this._map.entries();
    }

    forEach(callback, thisArg) {
        this._map.forEach(callback, thisArg);
    }

    [Symbol.iterator]() {
        return this._map[Symbol.iterator]();
    }

    _evict() {
        while (this._map.size > this._maxSize) {
            const oldestKey = this._map.keys().next().value;
            const oldestValue = this._map.get(oldestKey);
            this._map.delete(oldestKey);
            this._evictions++;
            if (this._onEvict) {
                this._onEvict(oldestKey, oldestValue);
            }
            if (this._logger && this._evictions % 100 === 0) {
                this._logger.debug('LRUMap eviction milestone', {
                    evictions: this._evictions,
                    maxSize: this._maxSize
                });
            }
        }
    }

    getStats() {
        return {
            size: this._map.size,
            maxSize: this._maxSize,
            evictions: this._evictions
        };
    }
}

module.exports = { LRUMap };
