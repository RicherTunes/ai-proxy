'use strict';

const { KeySnapshotSchema, KEY_STATE_ENUM, EXCLUSION_REASON_ENUM } = require('../../lib/schemas/key-snapshot');

describe('KeySnapshotSchema', () => {
    describe('validate()', () => {
        it('should accept valid snapshot', () => {
            const snapshot = {
                version: '1.0',
                timestamp: Date.now(),
                keyIndex: 0,
                keyId: 'test-key',
                state: 'available',
                inFlight: 0,
                maxConcurrency: 3,
                excludedReason: null,
                latency: null
            };
            expect(() => KeySnapshotSchema.validate(snapshot)).not.toThrow();
        });

        it('should reject missing snapshot', () => {
            expect(() => KeySnapshotSchema.validate(null))
                .toThrow('KeySnapshot: snapshot is required');
        });

        it('should reject missing version', () => {
            const snapshot = {
                timestamp: Date.now(),
                keyIndex: 0,
                state: 'available'
            };
            expect(() => KeySnapshotSchema.validate(snapshot))
                .toThrow('KeySnapshot: missing version field');
        });

        it('should reject incompatible version', () => {
            const snapshot = {
                version: '2.0',
                timestamp: Date.now(),
                keyIndex: 0,
                state: 'available'
            };
            expect(() => KeySnapshotSchema.validate(snapshot))
                .toThrow('KeySnapshot: incompatible version');
        });

        it('should reject negative keyIndex', () => {
            const snapshot = KeySnapshotSchema.createMock({ keyIndex: -1 });
            expect(() => KeySnapshotSchema.validate(snapshot))
                .toThrow('KeySnapshot: keyIndex must be non-negative number');
        });

        it('should reject non-numeric keyIndex', () => {
            const snapshot = KeySnapshotSchema.createMock({ keyIndex: '0' });
            expect(() => KeySnapshotSchema.validate(snapshot))
                .toThrow('KeySnapshot: keyIndex must be non-negative number');
        });

        it('should reject invalid state', () => {
            const snapshot = KeySnapshotSchema.createMock({ state: 'invalid_state' });
            expect(() => KeySnapshotSchema.validate(snapshot))
                .toThrow('KeySnapshot: invalid state');
        });

        it('should reject invalid excludedReason', () => {
            const snapshot = KeySnapshotSchema.createMock({
                excludedReason: 'invalid_reason'
            });
            expect(() => KeySnapshotSchema.validate(snapshot))
                .toThrow('KeySnapshot: invalid excludedReason');
        });

        it('should accept null excludedReason', () => {
            const snapshot = KeySnapshotSchema.createMock({ excludedReason: null });
            expect(() => KeySnapshotSchema.validate(snapshot)).not.toThrow();
        });

        it('should accept all valid states', () => {
            KEY_STATE_ENUM.forEach(state => {
                const snapshot = KeySnapshotSchema.createMock({ state });
                expect(() => KeySnapshotSchema.validate(snapshot)).not.toThrow();
            });
        });

        it('should accept all valid exclusion reasons', () => {
            EXCLUSION_REASON_ENUM.forEach(reason => {
                const snapshot = KeySnapshotSchema.createMock({ excludedReason: reason });
                expect(() => KeySnapshotSchema.validate(snapshot)).not.toThrow();
            });
        });
    });

    describe('isCompatible()', () => {
        it('should accept compatible version 1.0', () => {
            expect(KeySnapshotSchema.isCompatible('1.0')).toBe(true);
        });

        it('should accept compatible version 1.5', () => {
            expect(KeySnapshotSchema.isCompatible('1.5')).toBe(true);
        });

        it('should reject incompatible version 2.0', () => {
            expect(KeySnapshotSchema.isCompatible('2.0')).toBe(false);
        });

        it('should reject incompatible version 0.9', () => {
            expect(KeySnapshotSchema.isCompatible('0.9')).toBe(false);
        });

        it('should reject version without major', () => {
            expect(KeySnapshotSchema.isCompatible('.5')).toBe(false);
        });
    });

    describe('createMock()', () => {
        it('should create valid mock snapshot', () => {
            const mock = KeySnapshotSchema.createMock();
            expect(() => KeySnapshotSchema.validate(mock)).not.toThrow();
        });

        it('should apply timestamp override', () => {
            const customTime = 1234567890;
            const mock = KeySnapshotSchema.createMock({ timestamp: customTime });
            expect(mock.timestamp).toBe(customTime);
        });

        it('should apply keyIndex override', () => {
            const mock = KeySnapshotSchema.createMock({ keyIndex: 5 });
            expect(mock.keyIndex).toBe(5);
        });

        it('should apply state override', () => {
            const mock = KeySnapshotSchema.createMock({ state: 'rate_limited' });
            expect(mock.state).toBe('rate_limited');
        });

        it('should apply excludedReason override', () => {
            const mock = KeySnapshotSchema.createMock({ excludedReason: 'circuit_breaker' });
            expect(mock.excludedReason).toBe('circuit_breaker');
        });

        it('should preserve default version', () => {
            const mock = KeySnapshotSchema.createMock({ state: 'cooldown' });
            expect(mock.version).toBe('1.0');
        });
    });

    describe('VALID_STATES', () => {
        it('should contain all expected states', () => {
            expect(KeySnapshotSchema.VALID_STATES.has('available')).toBe(true);
            expect(KeySnapshotSchema.VALID_STATES.has('excluded')).toBe(true);
            expect(KeySnapshotSchema.VALID_STATES.has('rate_limited')).toBe(true);
            expect(KeySnapshotSchema.VALID_STATES.has('circuit_open')).toBe(true);
            expect(KeySnapshotSchema.VALID_STATES.has('cooldown')).toBe(true);
        });

        it('should be a Set', () => {
            expect(KeySnapshotSchema.VALID_STATES).toBeInstanceOf(Set);
        });
    });

    describe('VALID_REASONS', () => {
        it('should contain all expected reasons', () => {
            expect(KeySnapshotSchema.VALID_REASONS.has('circuit_breaker')).toBe(true);
            expect(KeySnapshotSchema.VALID_REASONS.has('rate_limit')).toBe(true);
            expect(KeySnapshotSchema.VALID_REASONS.has('high_latency')).toBe(true);
            expect(KeySnapshotSchema.VALID_REASONS.has('manual')).toBe(true);
            expect(KeySnapshotSchema.VALID_REASONS.has('account_level_429')).toBe(true);
            expect(KeySnapshotSchema.VALID_REASONS.has('none')).toBe(true);
        });

        it('should be a Set', () => {
            expect(KeySnapshotSchema.VALID_REASONS).toBeInstanceOf(Set);
        });
    });

    describe('VERSION', () => {
        it('should be 1.0', () => {
            expect(KeySnapshotSchema.VERSION).toBe('1.0');
        });
    });

    describe('KEY_STATE_ENUM', () => {
        it('should be a frozen array', () => {
            expect(Array.isArray(KEY_STATE_ENUM)).toBe(true);
            expect(Object.isFrozen(KEY_STATE_ENUM)).toBe(true);
        });

        it('should contain 5 states', () => {
            expect(KEY_STATE_ENUM).toHaveLength(5);
        });

        it('should contain all expected states', () => {
            expect(KEY_STATE_ENUM).toContain('available');
            expect(KEY_STATE_ENUM).toContain('excluded');
            expect(KEY_STATE_ENUM).toContain('rate_limited');
            expect(KEY_STATE_ENUM).toContain('circuit_open');
            expect(KEY_STATE_ENUM).toContain('cooldown');
        });
    });

    describe('EXCLUSION_REASON_ENUM', () => {
        it('should be a frozen array', () => {
            expect(Array.isArray(EXCLUSION_REASON_ENUM)).toBe(true);
            expect(Object.isFrozen(EXCLUSION_REASON_ENUM)).toBe(true);
        });

        it('should contain 6 reasons', () => {
            expect(EXCLUSION_REASON_ENUM).toHaveLength(6);
        });

        it('should contain all expected reasons', () => {
            expect(EXCLUSION_REASON_ENUM).toContain('circuit_breaker');
            expect(EXCLUSION_REASON_ENUM).toContain('rate_limit');
            expect(EXCLUSION_REASON_ENUM).toContain('high_latency');
            expect(EXCLUSION_REASON_ENUM).toContain('manual');
            expect(EXCLUSION_REASON_ENUM).toContain('account_level_429');
            expect(EXCLUSION_REASON_ENUM).toContain('none');
        });
    });
});
