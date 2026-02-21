'use strict';

const { PoolSnapshotSchema } = require('../../lib/schemas/pool-snapshot');

describe('PoolSnapshotSchema', () => {
    describe('validate()', () => {
        it('should accept valid snapshot', () => {
            const snapshot = {
                version: '1.0',
                timestamp: Date.now(),
                models: [{
                    modelId: 'glm-4',
                    tier: 'medium',
                    inFlight: 2,
                    maxConcurrency: 10,
                    isAvailable: true,
                    cooldownUntil: null
                }]
            };
            expect(() => PoolSnapshotSchema.validate(snapshot)).not.toThrow();
        });

        it('should reject missing snapshot', () => {
            expect(() => PoolSnapshotSchema.validate(null))
                .toThrow('PoolSnapshot: snapshot is required');
        });

        it('should reject non-object snapshot', () => {
            expect(() => PoolSnapshotSchema.validate('string'))
                .toThrow('PoolSnapshot: snapshot must be an object');
        });

        it('should reject missing version', () => {
            const snapshot = { timestamp: Date.now(), models: [] };
            expect(() => PoolSnapshotSchema.validate(snapshot))
                .toThrow('missing version field');
        });

        it('should reject incompatible version', () => {
            const snapshot = {
                version: '2.0',
                timestamp: Date.now(),
                models: []
            };
            expect(() => PoolSnapshotSchema.validate(snapshot))
                .toThrow('incompatible version');
        });

        it('should reject invalid timestamp', () => {
            const snapshot = PoolSnapshotSchema.createMock({ timestamp: -1 });
            expect(() => PoolSnapshotSchema.validate(snapshot))
                .toThrow('timestamp must be positive number');
        });

        it('should reject missing models array', () => {
            const snapshot = {
                version: '1.0',
                timestamp: Date.now(),
                models: 'not-array'
            };
            expect(() => PoolSnapshotSchema.validate(snapshot))
                .toThrow('models must be an array');
        });

        it('should reject invalid tier in model', () => {
            const snapshot = PoolSnapshotSchema.createMock({
                models: [{
                    modelId: 'test',
                    tier: 'invalid',
                    inFlight: 0,
                    maxConcurrency: 1,
                    isAvailable: true
                }]
            });
            expect(() => PoolSnapshotSchema.validate(snapshot))
                .toThrow('invalid tier');
        });

        it('should reject negative inFlight', () => {
            const snapshot = PoolSnapshotSchema.createMock({
                models: [{
                    modelId: 'test',
                    tier: 'light',
                    inFlight: -1,
                    maxConcurrency: 1,
                    isAvailable: true
                }]
            });
            expect(() => PoolSnapshotSchema.validate(snapshot))
                .toThrow('inFlight must be non-negative number');
        });

        it('should reject non-positive maxConcurrency', () => {
            const snapshot = PoolSnapshotSchema.createMock({
                models: [{
                    modelId: 'test',
                    tier: 'light',
                    inFlight: 0,
                    maxConcurrency: 0,
                    isAvailable: true
                }]
            });
            expect(() => PoolSnapshotSchema.validate(snapshot))
                .toThrow('maxConcurrency must be positive number');
        });

        it('should reject non-boolean isAvailable', () => {
            const snapshot = PoolSnapshotSchema.createMock({
                models: [{
                    modelId: 'test',
                    tier: 'light',
                    inFlight: 0,
                    maxConcurrency: 1,
                    isAvailable: 'true'
                }]
            });
            expect(() => PoolSnapshotSchema.validate(snapshot))
                .toThrow('isAvailable must be boolean');
        });
    });

    describe('isCompatible()', () => {
        it('should accept compatible version 1.0', () => {
            expect(PoolSnapshotSchema.isCompatible('1.0')).toBe(true);
        });

        it('should accept compatible version 1.5', () => {
            expect(PoolSnapshotSchema.isCompatible('1.5')).toBe(true);
        });

        it('should accept compatible version 1.9', () => {
            expect(PoolSnapshotSchema.isCompatible('1.9')).toBe(true);
        });

        it('should reject incompatible version 2.0', () => {
            expect(PoolSnapshotSchema.isCompatible('2.0')).toBe(false);
        });

        it('should reject incompatible version 0.9', () => {
            expect(PoolSnapshotSchema.isCompatible('0.9')).toBe(false);
        });

        it('should reject version without major', () => {
            expect(PoolSnapshotSchema.isCompatible('.5')).toBe(false);
        });
    });

    describe('createMock()', () => {
        it('should create valid mock snapshot', () => {
            const mock = PoolSnapshotSchema.createMock();
            expect(() => PoolSnapshotSchema.validate(mock)).not.toThrow();
        });

        it('should apply timestamp override', () => {
            const customTime = 1234567890;
            const mock = PoolSnapshotSchema.createMock({ timestamp: customTime });
            expect(mock.timestamp).toBe(customTime);
        });

        it('should apply models override', () => {
            const customModels = [{
                modelId: 'glm-4-flash',
                tier: 'light',
                inFlight: 0,
                maxConcurrency: 5,
                isAvailable: true
            }];
            const mock = PoolSnapshotSchema.createMock({ models: customModels });
            expect(mock.models).toEqual(customModels);
        });

        it('should preserve default version', () => {
            const mock = PoolSnapshotSchema.createMock({ timestamp: 123 });
            expect(mock.version).toBe('1.0');
        });

        it('should merge multiple overrides', () => {
            const mock = PoolSnapshotSchema.createMock({
                version: '1.0',
                timestamp: 999,
                models: []
            });
            expect(mock.version).toBe('1.0');
            expect(mock.timestamp).toBe(999);
            expect(mock.models).toEqual([]);
        });
    });

    describe('VALID_TIERS', () => {
        it('should contain valid tiers', () => {
            expect(PoolSnapshotSchema.VALID_TIERS.has('light')).toBe(true);
            expect(PoolSnapshotSchema.VALID_TIERS.has('medium')).toBe(true);
            expect(PoolSnapshotSchema.VALID_TIERS.has('heavy')).toBe(true);
        });

        it('should not contain invalid tiers', () => {
            expect(PoolSnapshotSchema.VALID_TIERS.has('invalid')).toBe(false);
            expect(PoolSnapshotSchema.VALID_TIERS.has('')).toBe(false);
        });

        it('should be a Set', () => {
            expect(PoolSnapshotSchema.VALID_TIERS).toBeInstanceOf(Set);
        });
    });

    describe('VERSION', () => {
        it('should be 1.0', () => {
            expect(PoolSnapshotSchema.VERSION).toBe('1.0');
        });
    });
});
