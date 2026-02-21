'use strict';

/**
 * KeyManager Snapshot Interface Contract Tests (ARCH-02)
 *
 * Tests the snapshot interface for drift detection and unified traces
 */

const { KeyManager } = require('../lib/key-manager');
const { KeySnapshotSchema } = require('../lib/schemas');

describe('KeyManager.getKeySnapshot() - ARCH-02', () => {
    let keyManager;
    const testKeys = [
        'key1-id.secret1',
        'key2-id.secret2',
        'key3-id.secret3'
    ];

    beforeEach(() => {
        keyManager = new KeyManager({
            maxConcurrencyPerKey: 3,
            circuitBreaker: {
                failureThreshold: 3,
                failureWindow: 1000,
                cooldownPeriod: 500
            }
        });
        keyManager.loadKeys(testKeys);
    });

    describe('getKeySnapshot(keyIndex)', () => {
        it('should return valid KeySnapshot for existing key', () => {
            const snapshot = keyManager.getKeySnapshot(0);

            expect(snapshot).not.toBeNull();
            expect(snapshot.version).toBe('1.0');
            expect(snapshot.keyIndex).toBe(0);
            expect(snapshot.keyId).toBe('key1-id');
            expect(snapshot.state).toMatch(/^(available|excluded|rate_limited|circuit_open|at_capacity|unknown)$/);
            expect(typeof snapshot.inFlight).toBe('number');
            expect(snapshot.maxConcurrency).toBe(3);
            expect(snapshot).toHaveProperty('excludedReason');
        });

        it('should return null for invalid index', () => {
            const snapshot = keyManager.getKeySnapshot(999);
            expect(snapshot).toBeNull();
        });

        it('should validate against KeySnapshotSchema', () => {
            const snapshot = keyManager.getKeySnapshot(0);
            expect(() => KeySnapshotSchema.validate(snapshot)).not.toThrow();
        });

        it('should reflect in-flight count correctly', () => {
            // Directly increment inFlight on the first key
            const key = keyManager.keys[0];
            key.inFlight++;

            const snapshot = keyManager.getKeySnapshot(0);
            expect(snapshot.inFlight).toBe(1);

            // Release the slot
            key.inFlight--;
        });

        it('should reflect excluded state when circuit is open', () => {
            const key = keyManager.keys[0];
            // Force circuit open
            key.circuitBreaker.forceState(require('../lib/circuit-breaker').STATES.OPEN);

            const snapshot = keyManager.getKeySnapshot(0);
            expect(snapshot.state).toBe('circuit_open');
            expect(snapshot.excludedReason).toBe('circuit_breaker');
        });
    });

    describe('getAllKeySnapshots()', () => {
        it('should return array of snapshots for all keys', () => {
            const snapshots = keyManager.getAllKeySnapshots();

            expect(Array.isArray(snapshots)).toBe(true);
            expect(snapshots.length).toBe(3);
            snapshots.forEach(s => {
                expect(() => KeySnapshotSchema.validate(s)).not.toThrow();
            });
        });

        it('should include all key indices', () => {
            const snapshots = keyManager.getAllKeySnapshots();

            const indices = snapshots.map(s => s.keyIndex).sort((a, b) => a - b);
            expect(indices).toEqual([0, 1, 2]);
        });

        it('should return empty array when no keys loaded', () => {
            const emptyKm = new KeyManager({ maxConcurrencyPerKey: 3 });
            const snapshots = emptyKm.getAllKeySnapshots();
            expect(snapshots).toEqual([]);
        });
    });

    describe('snapshot consistency', () => {
        it('should maintain consistency between individual and all snapshots', () => {
            const individual = keyManager.getKeySnapshot(0);
            const all = keyManager.getAllKeySnapshots();
            const fromAll = all.find(s => s.keyIndex === 0);

            expect(fromAll).toBeDefined();
            expect(fromAll.keyId).toBe(individual.keyId);
            expect(fromAll.state).toBe(individual.state);
            expect(fromAll.inFlight).toBe(individual.inFlight);
        });
    });
});
