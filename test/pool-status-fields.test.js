'use strict';

/**
 * Pool Status Fields Wire-Up Tests
 *
 * TDD-driven: tests written FIRST to assert that getModelPoolSnapshot()
 * returns non-null values for recent429, latencyP95, and errorRate
 * when the underlying data exists.  Code is then fixed to make them pass.
 */

jest.mock('../lib/atomic-write', () => ({
    atomicWrite: jest.fn().mockResolvedValue()
}));

const fs = require('fs');

// Mock fs.readFileSync for overrides file
const originalReadFileSync = fs.readFileSync;
jest.spyOn(fs, 'readFileSync').mockImplementation((filePath, encoding) => {
    if (typeof filePath === 'string' && filePath.includes('model-routing-overrides')) {
        return '{}';
    }
    return originalReadFileSync(filePath, encoding);
});

const { ModelRouter } = require('../lib/model-router');

function makeConfig(overrides = {}) {
    return {
        enabled: true,
        version: '2.0',
        tiers: {
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

/** Mock ModelDiscovery — provides both getModel and getMetadata */
const mockModelDiscovery = {
    getModel: jest.fn().mockImplementation((modelId) => {
        const models = {
            'glm-5': { id: 'glm-5', tier: 'heavy', maxConcurrency: 2, pricing: { input: 0.01, output: 0.02 } },
            'glm-5-plus': { id: 'glm-5-plus', tier: 'heavy', maxConcurrency: 2, pricing: { input: 0.015, output: 0.03 } }
        };
        return Promise.resolve(models[modelId] || null);
    }),
    getMetadata: jest.fn().mockImplementation((modelId) => {
        const models = {
            'glm-5': { id: 'glm-5', tier: 'heavy', maxConcurrency: 2, pricing: { input: 0.01, output: 0.02 } },
            'glm-5-plus': { id: 'glm-5-plus', tier: 'heavy', maxConcurrency: 2, pricing: { input: 0.015, output: 0.03 } }
        };
        return Promise.resolve(models[modelId] || null);
    })
};

describe('Pool status fields wire-up', () => {
    let router;

    beforeEach(() => {
        jest.clearAllMocks();
        router = new ModelRouter(makeConfig(), {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery,
            concurrencyMultiplier: 1
        });
    });

    // ─── TEST 1: recent429 is non-null after recording 429s ──────────────
    describe('Test 1: recent429 field', () => {
        test('pool status includes non-null recent429 for models that had 429s', async () => {
            // Record some 429s via the router's tracking
            router.recordPool429('glm-5');
            router.recordPool429('glm-5');
            router.recordPool429('glm-5');

            const snapshot = await router.getModelPoolSnapshot();

            // Find glm-5 entry in the heavy pool
            const glm5Entry = snapshot.pools.heavy.find(e => e.model === 'glm-5');
            expect(glm5Entry).toBeDefined();
            expect(glm5Entry.recent429).not.toBeNull();
            expect(typeof glm5Entry.recent429).toBe('number');
            expect(glm5Entry.recent429).toBeGreaterThanOrEqual(3);

            // glm-5-plus should have 0 (no 429s recorded)
            const glm5PlusEntry = snapshot.pools.heavy.find(e => e.model === 'glm-5-plus');
            expect(glm5PlusEntry).toBeDefined();
            expect(glm5PlusEntry.recent429).toBe(0);
        });
    });

    // ─── TEST 2: latencyP95 is a number when latency data is available ───
    describe('Test 2: latencyP95 field', () => {
        test('pool status includes latencyP95 comment or value (null acceptable if no per-model latency tracker)', async () => {
            // The router does not have a per-model latency tracker (latency is
            // tracked per-key in KeyManager).  After wiring, the field should
            // either be a number (if we can source it) or explicitly null with
            // a NOTE comment in the source explaining why.
            //
            // This test asserts the field exists and is either null or a number.
            const snapshot = await router.getModelPoolSnapshot();
            const entry = snapshot.pools.heavy[0];
            expect(entry).toHaveProperty('latencyP95');
            // Accept null (no per-model tracker) or a number
            if (entry.latencyP95 !== null) {
                expect(typeof entry.latencyP95).toBe('number');
            }
        });
    });

    // ─── TEST 3: errorRate is a number when error data is available ──────
    describe('Test 3: errorRate field', () => {
        test('pool status includes errorRate computed from 429 data when available', async () => {
            // Record 429s and some selections to give a basis for error rate
            router.recordPool429('glm-5');
            router.recordPool429('glm-5');

            // Simulate some selections so there is a denominator
            router._stats.byModel['glm-5'] = 10;

            const snapshot = await router.getModelPoolSnapshot();
            const glm5Entry = snapshot.pools.heavy.find(e => e.model === 'glm-5');
            expect(glm5Entry).toBeDefined();
            expect(glm5Entry.errorRate).not.toBeNull();
            expect(typeof glm5Entry.errorRate).toBe('number');
            expect(glm5Entry.errorRate).toBeGreaterThan(0);
            expect(glm5Entry.errorRate).toBeLessThanOrEqual(1);

            // Model with no errors should have errorRate 0 or null
            const glm5PlusEntry = snapshot.pools.heavy.find(e => e.model === 'glm-5-plus');
            expect(glm5PlusEntry).toBeDefined();
            // 0 is acceptable (no errors, no selections = 0 rate)
            if (glm5PlusEntry.errorRate !== null) {
                expect(glm5PlusEntry.errorRate).toBe(0);
            }
        });
    });
});
