/**
 * POOL_SNAPSHOT_SCHEMA v1.0
 *
 * Schema for model pool state snapshots used in /simulate endpoint
 * and drift detection between Router and KeyManager.
 *
 * Version history:
 * - 1.0 (2026-02-12): Initial version with inFlight, maxConcurrency, isAvailable
 *
 * Forward compatibility: Unknown fields are preserved in passthrough
 * Backward compatibility: Missing optional fields default to null/undefined
 */

'use strict';

class PoolSnapshotSchema {
    static VERSION = '1.0';

    static VALID_TIERS = new Set(['light', 'medium', 'heavy']);

    /**
     * Validate a snapshot object
     * @param {Object} snapshot - Snapshot to validate
     * @throws {Error} If snapshot is invalid
     */
    static validate(snapshot) {
        if (!snapshot) {
            throw new Error('PoolSnapshot: snapshot is required');
        }
        if (typeof snapshot !== 'object') {
            throw new Error('PoolSnapshot: snapshot must be an object');
        }
        if (!snapshot.version) {
            throw new Error('PoolSnapshot: missing version field');
        }
        if (!this.isCompatible(snapshot.version)) {
            throw new Error(`PoolSnapshot: incompatible version ${snapshot.version}, expected ${this.VERSION}`);
        }
        if (typeof snapshot.timestamp !== 'number' || snapshot.timestamp <= 0) {
            throw new Error('PoolSnapshot: timestamp must be positive number');
        }
        if (!Array.isArray(snapshot.models)) {
            throw new Error('PoolSnapshot: models must be an array');
        }
        // Validate each model state
        for (let i = 0; i < snapshot.models.length; i++) {
            this.validateModel(snapshot.models[i]);
        }
    }

    /**
     * Validate a single model state
     * @param {Object} model - Model state to validate
     */
    static validateModel(model) {
        if (!model.modelId || typeof model.modelId !== 'string') {
            throw new Error('PoolSnapshotModel: modelId is required string');
        }
        if (!this.VALID_TIERS.has(model.tier)) {
            throw new Error(`PoolSnapshotModel: invalid tier "${model.tier}"`);
        }
        if (typeof model.inFlight !== 'number' || model.inFlight < 0) {
            throw new Error('PoolSnapshotModel: inFlight must be non-negative number');
        }
        if (typeof model.maxConcurrency !== 'number' || model.maxConcurrency <= 0) {
            throw new Error('PoolSnapshotModel: maxConcurrency must be positive number');
        }
        if (typeof model.isAvailable !== 'boolean') {
            throw new Error('PoolSnapshotModel: isAvailable must be boolean');
        }
    }

    /**
     * Check if a version is compatible with current schema
     * @param {string} version - Version string to check
     * @returns {boolean} True if compatible
     */
    static isCompatible(version) {
        const [major] = version.split('.').map(Number);
        return major === 1; // Accept 1.x, reject 2.x
    }

    /**
     * Create a minimal valid snapshot for testing
     * @param {Object} overrides - Fields to override
     * @returns {Object} Valid snapshot
     */
    static createMock(overrides = {}) {
        return {
            version: this.VERSION,
            timestamp: Date.now(),
            models: [],
            ...overrides
        };
    }
}

module.exports = { PoolSnapshotSchema };
