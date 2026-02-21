'use strict';

/**
 * ModelRouter Snapshot Interface Contract Tests (ARCH-01)
 *
 * Tests the snapshot interface for drift detection and unified traces
 */

jest.mock('../lib/atomic-write', () => ({
    atomicWrite: jest.fn().mockResolvedValue()
}));

const fs = require('fs');
const { atomicWrite } = require('../lib/atomic-write');

// Mock fs.readFileSync to return '{}' by default
const originalReadFileSync = fs.readFileSync;
jest.spyOn(fs, 'readFileSync').mockImplementation((filePath, encoding) => {
    if (typeof filePath === 'string' && filePath.includes('model-routing-overrides')) {
        return '{}';
    }
    return originalReadFileSync(filePath, encoding);
});

const { ModelRouter } = require('../lib/model-router');
const { PoolSnapshotSchema } = require('../lib/schemas');

function makeConfig(overrides = {}) {
    return {
        enabled: true,
        version: '2.0',
        tiers: {
            light: {
                models: ['glm-3', 'glm-3-turbo'],
                strategy: 'throughput'
            },
            medium: {
                models: ['glm-4', 'glm-4-flash'],
                strategy: 'balanced'
            },
            heavy: {
                models: ['glm-5', 'glm-5-plus'],
                strategy: 'quality'
            }
        },
        cooldown: {
            defaultMs: 5000,
            maxMs: 30000,
            decayMs: 60000
        },
        ...overrides
    };
}

/** Mock ModelDiscovery instance */
const mockModelDiscovery = {
    getMetadata: jest.fn().mockImplementation((modelId) => {
        const models = {
            'glm-3': { tier: 'light', maxConcurrency: 5, pricing: { input: 0.001, output: 0.002 } },
            'glm-3-turbo': { tier: 'light', maxConcurrency: 5, pricing: { input: 0.0015, output: 0.003 } },
            'glm-4': { tier: 'medium', maxConcurrency: 10, pricing: { input: 0.002, output: 0.004 } },
            'glm-4-flash': { tier: 'medium', maxConcurrency: 10, pricing: { input: 0.0025, output: 0.005 } },
            'glm-5': { tier: 'heavy', maxConcurrency: 1, pricing: { input: 0.01, output: 0.02 } },
            'glm-5-plus': { tier: 'heavy', maxConcurrency: 1, pricing: { input: 0.015, output: 0.03 } }
        };
        return Promise.resolve(models[modelId] || null);
    })
};

describe('ModelRouter Snapshot Interface - ARCH-01', () => {
    let router;

    beforeEach(() => {
        jest.clearAllMocks();
        router = new ModelRouter(makeConfig(), {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery,
            concurrencyMultiplier: 2
        });
    });

    describe('getModelPoolSnapshotById(modelId)', () => {
        it('should return valid PoolSnapshotModel for existing model', async () => {
            const snapshot = await router.getModelPoolSnapshotById('glm-4');

            expect(snapshot).not.toBeNull();
            expect(snapshot.version).toBe('1.0');
            expect(snapshot.modelId).toBe('glm-4');
            expect(snapshot.tier).toBe('medium');
            expect(typeof snapshot.inFlight).toBe('number');
            expect(snapshot.maxConcurrency).toBe(20); // 10 * 2 (multiplier)
            expect(typeof snapshot.isAvailable).toBe('boolean');
            expect(snapshot).toHaveProperty('cooldownUntil');
        });

        it('should return null for unknown model', async () => {
            const snapshot = await router.getModelPoolSnapshotById('unknown-model');
            expect(snapshot).toBeNull();
        });

        it('should validate against PoolSnapshotSchema', async () => {
            const snapshot = await router.getModelPoolSnapshotById('glm-4');
            expect(() => PoolSnapshotSchema.validateModel(snapshot)).not.toThrow();
        });

        it('should reflect correct in-flight count', async () => {
            // Acquire some model slots
            router.acquireModel('glm-4');
            router.acquireModel('glm-4');

            const snapshot = await router.getModelPoolSnapshotById('glm-4');
            expect(snapshot.inFlight).toBe(2);

            // Release slots
            router.releaseModel('glm-4');
            router.releaseModel('glm-4');
        });

        it('should reflect cooldown state correctly', async () => {
            // Set a cooldown
            router.recordModelCooldown('glm-5', 5000);

            const snapshot = await router.getModelPoolSnapshotById('glm-5');
            expect(snapshot.isAvailable).toBe(false);
            expect(snapshot.cooldownUntil).toBeGreaterThan(Date.now());
        });
    });

    describe('getTierSnapshot(tier)', () => {
        it('should return array of PoolSnapshotModel objects for light tier', async () => {
            const snapshots = await router.getTierSnapshot('light');

            expect(Array.isArray(snapshots)).toBe(true);
            expect(snapshots.length).toBe(2);
            snapshots.forEach(s => {
                expect(s.tier).toBe('light');
                expect(() => PoolSnapshotSchema.validateModel(s)).not.toThrow();
            });
        });

        it('should return empty array for unknown tier', async () => {
            const snapshots = await router.getTierSnapshot('unknown');
            expect(snapshots).toEqual([]);
        });

        it('should return all snapshots for medium tier', async () => {
            const snapshots = await router.getTierSnapshot('medium');

            expect(snapshots.length).toBeGreaterThan(0);
            snapshots.forEach(s => {
                expect(s.tier).toBe('medium');
                expect(s.version).toBe('1.0');
            });
        });
    });

    describe('getPoolSnapshotAll()', () => {
        it('should return complete pool snapshot with all tiers', async () => {
            const snapshot = await router.getPoolSnapshotAll();

            expect(snapshot.version).toBe('1.0');
            expect(typeof snapshot.timestamp).toBe('number');
            expect(Array.isArray(snapshot.models)).toBe(true);
            expect(snapshot.models.length).toBeGreaterThan(0);
        });

        it('should include models from all configured tiers', async () => {
            const snapshot = await router.getPoolSnapshotAll();

            const tierSet = new Set(snapshot.models.map(m => m.tier));
            expect(tierSet.has('light')).toBe(true);
            expect(tierSet.has('medium')).toBe(true);
            expect(tierSet.has('heavy')).toBe(true);
        });

        it('should validate against PoolSnapshotSchema', async () => {
            const snapshot = await router.getPoolSnapshotAll();
            expect(() => PoolSnapshotSchema.validate(snapshot)).not.toThrow();
        });
    });

    describe('snapshot consistency', () => {
        it('should maintain consistency across snapshot methods', async () => {
            // Set some state
            router.acquireModel('glm-4');
            router.acquireModel('glm-5');

            const byId = await router.getModelPoolSnapshotById('glm-4');
            const byTier = await router.getTierSnapshot('medium');
            const all = await router.getPoolSnapshotAll();

            // Find glm-4 in all snapshot
            const glm4InAll = all.models.find(m => m.modelId === 'glm-4');
            expect(glm4InAll).toBeDefined();
            expect(glm4InAll.inFlight).toBe(byId.inFlight);

            // Find glm-4 in tier snapshot
            const glm4InTier = byTier.find(m => m.modelId === 'glm-4');
            expect(glm4InTier).toBeDefined();
            expect(glm4InTier.inFlight).toBe(byId.inFlight);
        });
    });
});
