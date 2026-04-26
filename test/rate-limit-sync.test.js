'use strict';

const path = require('path');
const fs = require('fs');

// Mock atomicWrite before requiring the module
jest.mock('../lib/atomic-write', () => ({
    atomicWrite: jest.fn().mockResolvedValue(undefined)
}));

const { RateLimitSync } = require('../lib/rate-limit-sync');
const { atomicWrite } = require('../lib/atomic-write');

// --- Helpers ---

const createMockKeyManager = (staticLimits = {}) => {
    const _static = new Map(Object.entries(staticLimits));
    const _effective = new Map(Object.entries(staticLimits));
    return {
        getStaticModelLimit: (model) => _static.get(model),
        getEffectiveModelLimit: (model) => _effective.get(model),
        updateStaticModelLimit: jest.fn((model, newLimit) => {
            const oldStatic = _static.get(model);
            _static.set(model, newLimit);
            const currentEffective = _effective.get(model);
            if (currentEffective === undefined || (oldStatic !== undefined && currentEffective >= oldStatic)) {
                _effective.set(model, newLimit);
            }
            return { oldStatic, newStatic: newLimit, effective: _effective.get(model) };
        }),
        setEffectiveModelLimit: jest.fn((model, limit) => { _effective.set(model, limit); })
    };
};

const createMockAIMD = () => ({
    _windows: new Map(),
    updateStaticBaseline: jest.fn(() => true)
});

const createMockModelDiscovery = () => ({
    updateModelMetadata: jest.fn()
});

const nullLogger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };

// --- Tests ---

describe('RateLimitSync', () => {
    let keyManager;
    let aimd;
    let modelDiscovery;
    let logger;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.restoreAllMocks();
        keyManager = createMockKeyManager({ 'claude-sonnet': 10 });
        aimd = createMockAIMD();
        modelDiscovery = createMockModelDiscovery();
        logger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
    });

    afterEach(() => {
        // Safety: clear any timers left by tests
        jest.clearAllTimers();
    });

    function createSync(configOverrides = {}, depsOverrides = {}) {
        return new RateLimitSync(
            { enabled: true, tickIntervalMs: 60000, ...configOverrides },
            {
                logger,
                keyManager,
                adaptiveConcurrency: aimd,
                modelDiscovery,
                ...depsOverrides
            }
        );
    }

    // ---------------------------------------------------------------
    // 1. Ring buffer accumulation
    // ---------------------------------------------------------------
    test('accumulates header observations in ring buffer (max 10)', () => {
        const sync = createSync();

        // Record 12 observations — buffer should keep only last 10
        for (let i = 1; i <= 12; i++) {
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });
        }

        const snap = sync.getSnapshot();
        expect(snap.models['claude-sonnet'].observations).toHaveLength(10);
    });

    // ---------------------------------------------------------------
    // 2. Quorum triggers update
    // ---------------------------------------------------------------
    test('triggers update when quorum of 3 consistent values reached', () => {
        keyManager = createMockKeyManager({ 'claude-sonnet': 3 });
        const sync = createSync({}, { keyManager });

        sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '5' });
        sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '5' });
        sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '5' });

        expect(keyManager.updateStaticModelLimit).toHaveBeenCalledWith('claude-sonnet', 5);
    });

    // ---------------------------------------------------------------
    // 3. Mixed values — no quorum
    // ---------------------------------------------------------------
    test('does not update when quorum not met (mixed values)', () => {
        keyManager = createMockKeyManager({ 'claude-sonnet': 1 });
        const sync = createSync({}, { keyManager });

        sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '5' });
        sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '3' });
        sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '5' });

        expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
    });

    // ---------------------------------------------------------------
    // 4. Quorum matches current static — no update
    // ---------------------------------------------------------------
    test('does not update when quorum matches current static', () => {
        keyManager = createMockKeyManager({ 'claude-sonnet': 10 });
        const sync = createSync({}, { keyManager });

        sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });
        sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });
        sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });

        expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
    });

    // ---------------------------------------------------------------
    // 5. Immediate update — no tick wait
    // ---------------------------------------------------------------
    test('handles immediate update on first quorum (no tick wait)', () => {
        keyManager = createMockKeyManager({ 'claude-sonnet': 3 });
        const sync = createSync({}, { keyManager });

        // Three consistent observations should trigger immediately,
        // without needing to wait for a _tick() call.
        sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '7' });
        sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '7' });
        sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '7' });

        expect(keyManager.updateStaticModelLimit).toHaveBeenCalledTimes(1);
        expect(keyManager.updateStaticModelLimit).toHaveBeenCalledWith('claude-sonnet', 7);
    });

    // ---------------------------------------------------------------
    // 6. Ceiling probe for low-traffic models
    // ---------------------------------------------------------------
    test('ceiling probe triggers for low-traffic models', () => {
        keyManager = createMockKeyManager({ 'claude-haiku': 1 });
        const sync = createSync(
            { ceilingProbeCleanTicks: 10, ceilingProbeStep: 1, ceilingProbeMaxAboveStatic: 5 },
            { keyManager }
        );

        // Set up AIMD window: at ceiling, enough clean ticks
        aimd._windows.set('claude-haiku', {
            staticMax: 1,
            effectiveMax: 1,
            consecutiveCleanTicks: 15
        });

        // No recent header observations for this model → probe eligible
        sync._tick();

        expect(keyManager.updateStaticModelLimit).toHaveBeenCalledWith('claude-haiku', 2);
    });

    // ---------------------------------------------------------------
    // 7. Ceiling probe respects maxAboveStatic cap
    // ---------------------------------------------------------------
    test('ceiling probe respects maxAboveStatic cap', () => {
        // Original static = 1, but current static already pushed to 6 (5 above original).
        keyManager = createMockKeyManager({ 'claude-haiku': 6 });
        const sync = createSync(
            { ceilingProbeCleanTicks: 10, ceilingProbeStep: 1, ceilingProbeMaxAboveStatic: 5 },
            { keyManager }
        );

        // Capture original static as 1 (before the key manager was bumped to 6)
        sync._originalStaticLimits.set('claude-haiku', 1);

        aimd._windows.set('claude-haiku', {
            staticMax: 6,
            effectiveMax: 6,
            consecutiveCleanTicks: 20
        });

        sync._tick();

        // newLimit would be 7, maxAllowed = 1 + 5 = 6 → should NOT probe
        expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
    });

    // ---------------------------------------------------------------
    // 8. Ceiling probe skips models with recent observations
    // ---------------------------------------------------------------
    test('ceiling probe skips models with recent header observations', () => {
        keyManager = createMockKeyManager({ 'claude-haiku': 1 });
        const sync = createSync(
            { ceilingProbeCleanTicks: 10, ceilingProbeStep: 1, tickIntervalMs: 30000 },
            { keyManager }
        );

        aimd._windows.set('claude-haiku', {
            staticMax: 1,
            effectiveMax: 1,
            consecutiveCleanTicks: 15
        });

        // Add a recent observation (well within 2 * tickIntervalMs)
        sync.recordHeaders('claude-haiku', { 'x-ratelimit-limit': '1' });

        sync._tick();

        // Should skip because the model has recent traffic
        expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
    });

    // ---------------------------------------------------------------
    // 9. Propagates to KeyManager, AIMD, and ModelDiscovery
    // ---------------------------------------------------------------
    test('propagates to KeyManager, AIMD, and ModelDiscovery', () => {
        keyManager = createMockKeyManager({ 'claude-opus': 5 });
        const sync = createSync({}, { keyManager });

        sync.recordHeaders('claude-opus', { 'x-ratelimit-limit': '8' });
        sync.recordHeaders('claude-opus', { 'x-ratelimit-limit': '8' });
        sync.recordHeaders('claude-opus', { 'x-ratelimit-limit': '8' });

        // KeyManager
        expect(keyManager.updateStaticModelLimit).toHaveBeenCalledWith('claude-opus', 8);

        // AIMD
        expect(aimd.updateStaticBaseline).toHaveBeenCalledWith('claude-opus', 8);

        // ModelDiscovery
        expect(modelDiscovery.updateModelMetadata).toHaveBeenCalledWith(
            'claude-opus',
            expect.objectContaining({ maxConcurrency: 8, source: 'header_observed' })
        );
    });

    // ---------------------------------------------------------------
    // 10. Persistence round-trip (save/load)
    // ---------------------------------------------------------------
    test('persistence round-trip (save/load)', async () => {
        const configDir = '/tmp/test-rls';
        keyManager = createMockKeyManager({ 'claude-sonnet': 3 });
        const sync = createSync({}, { keyManager, configDir });

        // Trigger a baseline update via quorum
        sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '5' });
        sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '5' });
        sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '5' });

        // Wait for the fire-and-forget _save()
        await new Promise(r => setTimeout(r, 50));

        // atomicWrite should have been called with the cache file
        expect(atomicWrite).toHaveBeenCalled();
        const [savedPath, savedJson] = atomicWrite.mock.calls[0];
        expect(savedPath).toContain('rate-limit-cache.json');

        const savedData = JSON.parse(savedJson);
        expect(savedData.version).toBe(1);
        expect(savedData.baselines['claude-sonnet'].concurrency).toBe(5);

        // Now simulate loading: mock fs.readFileSync to return the saved data
        const readFileSyncSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(savedJson);

        const keyManager2 = createMockKeyManager({ 'claude-sonnet': 1 });
        const sync2 = new RateLimitSync(
            { enabled: true },
            { logger, keyManager: keyManager2, adaptiveConcurrency: aimd, modelDiscovery, configDir }
        );

        // Baselines should have been loaded
        const snap2 = sync2.getSnapshot();
        expect(snap2.baselines['claude-sonnet']).toBeDefined();
        expect(snap2.baselines['claude-sonnet'].concurrency).toBe(5);

        readFileSyncSpy.mockRestore();
    });

    // ---------------------------------------------------------------
    // 11. First run with no cache file (graceful)
    // ---------------------------------------------------------------
    test('first run with no cache file (graceful)', () => {
        const readFileSyncSpy = jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
            const err = new Error('ENOENT: no such file or directory');
            err.code = 'ENOENT';
            throw err;
        });

        expect(() => {
            new RateLimitSync(
                { enabled: true },
                { logger, keyManager, configDir: '/tmp/nonexistent' }
            );
        }).not.toThrow();

        readFileSyncSpy.mockRestore();
    });

    // ---------------------------------------------------------------
    // 12. Stale cache handling (baselines older than 24h)
    // ---------------------------------------------------------------
    test('stale cache handling (baselines older than 24h)', () => {
        const staleTimestamp = Date.now() - (25 * 60 * 60 * 1000); // 25 hours ago
        const cacheData = JSON.stringify({
            version: 1,
            savedAt: staleTimestamp,
            baselines: {
                'claude-sonnet': {
                    concurrency: 20,
                    source: 'header_observed',
                    discoveredAt: staleTimestamp
                }
            }
        });

        const readFileSyncSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(cacheData);

        keyManager = createMockKeyManager({ 'claude-sonnet': 5 });
        const sync = new RateLimitSync(
            { enabled: true },
            { logger, keyManager, adaptiveConcurrency: aimd, modelDiscovery, configDir: '/tmp/stale-test' }
        );

        // Start to trigger _applyCachedBaselines
        sync.start();

        // Stale baseline should NOT be applied
        expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();

        sync.stop();
        readFileSyncSpy.mockRestore();
    });

    // ---------------------------------------------------------------
    // 13. Max probe cap enforcement
    // ---------------------------------------------------------------
    test('max probe cap enforcement', () => {
        // originalStatic=2, ceilingProbeMaxAboveStatic=3, static already at 5 (= 2+3)
        keyManager = createMockKeyManager({ 'claude-haiku': 5 });
        const sync = createSync(
            { ceilingProbeCleanTicks: 10, ceilingProbeStep: 1, ceilingProbeMaxAboveStatic: 3 },
            { keyManager }
        );

        sync._originalStaticLimits.set('claude-haiku', 2);

        aimd._windows.set('claude-haiku', {
            staticMax: 5,
            effectiveMax: 5,
            consecutiveCleanTicks: 20
        });

        sync._tick();

        // newLimit = 5 + 1 = 6, maxAllowed = 2 + 3 = 5 → should NOT probe
        expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
    });

    // ---------------------------------------------------------------
    // 14. Multiple models tracked concurrently
    // ---------------------------------------------------------------
    test('multiple models tracked concurrently', () => {
        keyManager = createMockKeyManager({
            'claude-sonnet': 3,
            'claude-opus': 5,
            'claude-haiku': 6
        });
        const sync = createSync({}, { keyManager });

        // Record headers for 3 different models (values within per-model ceiling: static+5)
        for (const [model, limit] of [['claude-sonnet', '5'], ['claude-opus', '8'], ['claude-haiku', '10']]) {
            sync.recordHeaders(model, { 'x-ratelimit-limit': limit });
            sync.recordHeaders(model, { 'x-ratelimit-limit': limit });
            sync.recordHeaders(model, { 'x-ratelimit-limit': limit });
        }

        // All three should have been updated independently
        expect(keyManager.updateStaticModelLimit).toHaveBeenCalledWith('claude-sonnet', 5);
        expect(keyManager.updateStaticModelLimit).toHaveBeenCalledWith('claude-opus', 8);
        expect(keyManager.updateStaticModelLimit).toHaveBeenCalledWith('claude-haiku', 10);

        const snap = sync.getSnapshot();
        expect(Object.keys(snap.models)).toHaveLength(3);
    });

    // ---------------------------------------------------------------
    // 15. Decrease detection (z.ai lowers limit)
    // ---------------------------------------------------------------
    test('decrease detection (z.ai lowers limit)', () => {
        keyManager = createMockKeyManager({ 'claude-sonnet': 10 });
        const sync = createSync({}, { keyManager });

        // Headers now report a lower limit
        sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '5' });
        sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '5' });
        sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '5' });

        expect(keyManager.updateStaticModelLimit).toHaveBeenCalledWith('claude-sonnet', 5);
    });

    // ---------------------------------------------------------------
    // 16. getSnapshot returns complete state
    // ---------------------------------------------------------------
    test('getSnapshot returns complete state', () => {
        const sync = createSync();
        sync.start();

        sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });

        const snap = sync.getSnapshot();

        // Top-level keys
        expect(snap).toHaveProperty('enabled', true);
        expect(snap).toHaveProperty('running', true);
        expect(snap).toHaveProperty('config');
        expect(snap).toHaveProperty('models');
        expect(snap).toHaveProperty('baselines');

        // Config sub-keys
        expect(snap.config).toHaveProperty('quorumSize');
        expect(snap.config).toHaveProperty('tickIntervalMs');
        expect(snap.config).toHaveProperty('ceilingProbeEnabled');
        expect(snap.config).toHaveProperty('ceilingProbeMaxAboveStatic');
        expect(snap.config).toHaveProperty('staleThresholdMs');

        // Model entry
        const modelSnap = snap.models['claude-sonnet'];
        expect(modelSnap).toBeDefined();
        expect(modelSnap).toHaveProperty('observations');
        expect(modelSnap).toHaveProperty('currentBaseline');
        expect(modelSnap).toHaveProperty('originalStatic');
        expect(modelSnap).toHaveProperty('currentStatic');
        expect(modelSnap).toHaveProperty('currentEffective');

        sync.stop();
    });

    // ---------------------------------------------------------------
    // 17. start/stop lifecycle
    // ---------------------------------------------------------------
    test('start/stop lifecycle', () => {
        const sync = createSync();

        // Not running initially
        expect(sync.getSnapshot().running).toBe(false);

        // Start creates interval
        sync.start();
        expect(sync.getSnapshot().running).toBe(true);

        // Double-start is idempotent (no second timer created)
        const tickRef = sync._tickInterval;
        sync.start();
        expect(sync._tickInterval).toBe(tickRef);

        // Stop clears interval
        sync.stop();
        expect(sync.getSnapshot().running).toBe(false);
        expect(sync._tickInterval).toBeNull();
    });

    // ---------------------------------------------------------------
    // 18. Disabled config prevents start
    // ---------------------------------------------------------------
    test('disabled config prevents start', () => {
        const sync = createSync({ enabled: false });

        sync.start();

        expect(sync._tickInterval).toBeNull();
        expect(sync.getSnapshot().running).toBe(false);
    });
});
