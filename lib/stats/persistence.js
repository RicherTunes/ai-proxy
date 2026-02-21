/**
 * Stats Persistence Module
 *
 * Handles file I/O for stats storage.
 * Extracted from StatsAggregator as part of the god class refactoring.
 *
 * TDD Phase: Green - Implementation to make tests pass
 */

'use strict';

const fs = require('fs');
const atomicWriteModule = require('../atomic-write');

const DEFAULT_SCHEMA_VERSION = 1;

/**
 * Creates empty stats structure
 * @returns {Object} Empty stats object
 */
function _createEmptyStats() {
    return {
        firstSeen: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        keys: {},
        totals: {
            requests: 0,
            successes: 0,
            failures: 0,
            retries: 0
        }
    };
}

/**
 * StatsPersistence class
 * Handles persistent stats storage with atomic writes
 */
class StatsPersistence {
    /**
     * @param {Object} options - Configuration options
     * @param {string} options.filepath - Full path to stats file
     * @param {number} options.schemaVersion - Schema version for data format
     * @param {Object} options.logger - Logger instance with debug/info/warn/error methods
     */
    constructor(options = {}) {
        if (!options.filepath) {
            throw new Error('filepath is required');
        }
        this.filepath = options.filepath;
        this.schemaVersion = options.schemaVersion ?? DEFAULT_SCHEMA_VERSION;
        this.logger = options.logger || null;
        this.pendingSaves = new Set();
    }

    /**
     * Log message if logger is available
     * @param {string} level - Log level
     * @param {string} message - Log message
     * @param {Object} context - Additional context
     * @private
     */
    _log(level, message, context = {}) {
        if (this.logger && typeof this.logger[level] === 'function') {
            this.logger[level](message, context);
        }
    }

    /**
     * Load stats from file
     * @param {Object} defaults - Default values to merge with loaded data
     * @returns {Object} { success: boolean, data: Object }
     */
    load(defaults = null) {
        try {
            if (fs.existsSync(this.filepath)) {
                const content = fs.readFileSync(this.filepath, 'utf8');

                // Handle empty file
                if (!content || content.trim() === '') {
                    this._log('warn', 'Stats file is empty');
                    return {
                        success: false,
                        data: this._createEmptyData(defaults)
                    };
                }

                const data = JSON.parse(content);

                // Schema version handling
                const version = data.schemaVersion || 0;
                if (version > this.schemaVersion) {
                    this._log('warn', `Stats file has newer schema (v${version}), loading with best effort`);
                }

                // Remove schemaVersion from the data before merging
                const { schemaVersion, ...statsData } = data;

                // Merge with loaded data and defaults
                const merged = this._mergeData(statsData, defaults);

                this._log('info', `Loaded persistent stats: ${Object.keys(merged.keys).length} keys tracked`);
                return {
                    success: true,
                    data: merged
                };
            }
        } catch (err) {
            this._log('error', `Failed to load persistent stats: ${err.message}`);
        }

        // File doesn't exist or error occurred
        return {
            success: false,
            data: this._createEmptyData(defaults)
        };
    }

    /**
     * Create empty data structure
     * @param {Object} defaults - Optional default values
     * @returns {Object} Empty data object
     * @private
     */
    _createEmptyData(defaults) {
        const empty = {
            keys: {},
            totals: {}
        };

        if (defaults) {
            if (defaults.keys) {
                empty.keys = { ...defaults.keys };
            }
            if (defaults.totals) {
                empty.totals = { ...defaults.totals };
            }
        }

        return empty;
    }

    /**
     * Merge loaded data with defaults
     * @param {Object} data - Loaded data
     * @param {Object} defaults - Default values
     * @returns {Object} Merged data
     * @private
     */
    _mergeData(data, defaults) {
        let merged = {
            keys: data.keys || {},
            totals: data.totals || {}
        };

        // Apply additional defaults if provided
        if (defaults) {
            if (defaults.keys) {
                merged.keys = { ...defaults.keys, ...merged.keys };
            }
            if (defaults.totals) {
                merged.totals = { ...defaults.totals, ...merged.totals };
            }
        }

        return merged;
    }

    /**
     * Save stats to file (async with atomic write via temp + rename)
     * Returns a promise that resolves when save is complete
     * Promise is also tracked internally for flush() support
     * @param {Object} stats - Stats object to save
     * @returns {Promise<boolean>} Promise resolving to true on success, false on failure
     */
    save(stats) {
        if (!stats) {
            this._log('warn', 'Cannot save null stats');
            return Promise.resolve(false);
        }

        // Update timestamp
        const dataToSave = {
            schemaVersion: this.schemaVersion,
            ...stats,
            lastUpdated: new Date().toISOString()
        };

        const jsonString = JSON.stringify(dataToSave, null, 2);

        // Async save - returns promise for caller and tracks internally for flush()
        const savePromise = atomicWriteModule.atomicWrite(this.filepath, jsonString)
            .then(() => {
                this._log('info', `Saved persistent stats to ${this.filepath}`);
                return true;
            })
            .catch((err) => {
                this._log('error', `Failed to save persistent stats: ${err.message}`);
                return false;
            })
            .finally(() => {
                this.pendingSaves.delete(savePromise);
            });

        this.pendingSaves.add(savePromise);
        return savePromise;
    }

    /**
     * Flush all pending saves to disk
     * Returns a promise that resolves when all pending saves complete
     * @returns {Promise<void>}
     */
    async flush() {
        if (this.pendingSaves.size === 0) {
            return; // No pending saves
        }
        // Wait for all pending save promises to settle
        await Promise.all(Array.from(this.pendingSaves));
    }

    /**
     * Get pending saves for testing
     * @returns {Set} Set of pending save promises
     */
    getPendingSaves() {
        return this.pendingSaves;
    }
}

// Export the class and empty stats creator for testing
module.exports = {
    StatsPersistence,
    _createEmptyStats
};
