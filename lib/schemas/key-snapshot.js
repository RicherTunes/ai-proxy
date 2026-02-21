/**
 * KEY_SNAPSHOT_SCHEMA v1.0
 *
 * Schema for API key state snapshots used in drift detection
 * and unified decision traces.
 *
 * Version history:
 * - 1.0 (2026-02-12): Initial version
 */

'use strict';

// Bounded enum for key states
const KEY_STATE_ENUM = Object.freeze([
    'available',
    'excluded',
    'rate_limited',
    'circuit_open',
    'cooldown'
]);

// Bounded enum for exclusion reasons
const EXCLUSION_REASON_ENUM = Object.freeze([
    'circuit_breaker',
    'rate_limit',
    'high_latency',
    'manual',
    'account_level_429',
    'none'
]);

class KeySnapshotSchema {
    static VERSION = '1.0';
    static VALID_STATES = new Set(KEY_STATE_ENUM);
    static VALID_REASONS = new Set(EXCLUSION_REASON_ENUM);

    static validate(snapshot) {
        if (!snapshot) {
            throw new Error('KeySnapshot: snapshot is required');
        }
        if (!snapshot.version) {
            throw new Error('KeySnapshot: missing version field');
        }
        if (!this.isCompatible(snapshot.version)) {
            throw new Error(`KeySnapshot: incompatible version ${snapshot.version}`);
        }
        if (typeof snapshot.keyIndex !== 'number' || snapshot.keyIndex < 0) {
            throw new Error('KeySnapshot: keyIndex must be non-negative number');
        }
        if (!this.VALID_STATES.has(snapshot.state)) {
            throw new Error(`KeySnapshot: invalid state "${snapshot.state}"`);
        }
        if (snapshot.excludedReason && !this.VALID_REASONS.has(snapshot.excludedReason)) {
            throw new Error(`KeySnapshot: invalid excludedReason "${snapshot.excludedReason}"`);
        }
    }

    static isCompatible(version) {
        const [major] = version.split('.').map(Number);
        return major === 1;
    }

    static createMock(overrides = {}) {
        return {
            version: this.VERSION,
            timestamp: Date.now(),
            keyIndex: 0,
            keyId: 'test-key',
            state: 'available',
            inFlight: 0,
            maxConcurrency: 3,
            excludedReason: null,
            latency: null,
            ...overrides
        };
    }
}

module.exports = { KeySnapshotSchema, KEY_STATE_ENUM, EXCLUSION_REASON_ENUM };
