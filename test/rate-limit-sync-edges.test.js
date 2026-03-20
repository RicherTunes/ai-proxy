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

// --- Tests ---

describe('RateLimitSync – edge cases', () => {
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

    // =================================================================
    // 1. Header observation – parsing edge cases
    // =================================================================
    describe('header observation', () => {
        test('parses integer x-ratelimit-limit and updates baseline', () => {
            keyManager = createMockKeyManager({ 'claude-sonnet': 2 });
            const sync = createSync({}, { keyManager });

            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '8' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '8' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '8' });

            expect(keyManager.updateStaticModelLimit).toHaveBeenCalledWith('claude-sonnet', 8);
            const snap = sync.getSnapshot();
            expect(snap.baselines['claude-sonnet'].concurrency).toBe(8);
            expect(snap.baselines['claude-sonnet'].source).toBe('header_observed');
        });

        test('ignores missing x-ratelimit-limit header', () => {
            const sync = createSync();

            sync.recordHeaders('claude-sonnet', { 'content-type': 'application/json' });
            sync.recordHeaders('claude-sonnet', { 'content-type': 'application/json' });
            sync.recordHeaders('claude-sonnet', { 'content-type': 'application/json' });

            expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
        });

        test('ignores null and undefined header values', () => {
            const sync = createSync();

            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': null });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': undefined });

            expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
        });

        test('ignores non-numeric header values', () => {
            const sync = createSync();

            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': 'abc' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': 'abc' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': 'abc' });

            expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
        });

        test('ignores zero and negative header values', () => {
            const sync = createSync();

            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '0' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '-5' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '0' });

            expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
        });

        test('ignores Infinity and NaN header values', () => {
            const sync = createSync();

            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': 'Infinity' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': 'NaN' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': 'Infinity' });

            expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
        });

        test('ignores calls with null/undefined model or headers', () => {
            const sync = createSync();

            sync.recordHeaders(null, { 'x-ratelimit-limit': '5' });
            sync.recordHeaders(undefined, { 'x-ratelimit-limit': '5' });
            sync.recordHeaders('claude-sonnet', null);
            sync.recordHeaders('claude-sonnet', undefined);

            expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
        });

        test('captures original static limit on first observation', () => {
            keyManager = createMockKeyManager({ 'claude-sonnet': 4 });
            const sync = createSync({}, { keyManager });

            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });

            expect(sync._originalStaticLimits.get('claude-sonnet')).toBe(4);
        });

        test('does not overwrite original static on subsequent observations', () => {
            keyManager = createMockKeyManager({ 'claude-sonnet': 4 });
            const sync = createSync({}, { keyManager });

            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });
            // After quorum, static will be updated to 10; next observation should keep original=4
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '15' });

            expect(sync._originalStaticLimits.get('claude-sonnet')).toBe(4);
        });
    });

    // =================================================================
    // 2. Ceiling probe – binary-search-like discovery
    // =================================================================
    describe('ceiling probe', () => {
        test('discovers true rate limit by stepping up from static baseline', () => {
            keyManager = createMockKeyManager({ 'claude-haiku': 2 });
            const sync = createSync(
                { ceilingProbeCleanTicks: 5, ceilingProbeStep: 1, ceilingProbeMaxAboveStatic: 10 },
                { keyManager }
            );

            // Simulate multiple tick cycles, each time AIMD is at ceiling
            for (let expected = 3; expected <= 5; expected++) {
                aimd._windows.set('claude-haiku', {
                    staticMax: expected - 1,
                    effectiveMax: expected - 1,
                    consecutiveCleanTicks: 10
                });
                sync._tick();
                expect(keyManager.updateStaticModelLimit).toHaveBeenLastCalledWith('claude-haiku', expected);
            }

            expect(keyManager.updateStaticModelLimit).toHaveBeenCalledTimes(3);
        });

        test('stops probing when effectiveMax < staticMax (AIMD reduced)', () => {
            keyManager = createMockKeyManager({ 'claude-haiku': 5 });
            const sync = createSync(
                { ceilingProbeCleanTicks: 5, ceilingProbeStep: 1, ceilingProbeMaxAboveStatic: 10 },
                { keyManager }
            );

            aimd._windows.set('claude-haiku', {
                staticMax: 5,
                effectiveMax: 3,   // AIMD has backed off
                consecutiveCleanTicks: 20
            });

            sync._tick();

            expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
        });

        test('stops probing when clean ticks are insufficient', () => {
            keyManager = createMockKeyManager({ 'claude-haiku': 5 });
            const sync = createSync(
                { ceilingProbeCleanTicks: 10, ceilingProbeStep: 1, ceilingProbeMaxAboveStatic: 10 },
                { keyManager }
            );

            aimd._windows.set('claude-haiku', {
                staticMax: 5,
                effectiveMax: 5,
                consecutiveCleanTicks: 3   // Below threshold of 10
            });

            sync._tick();

            expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
        });

        test('does nothing when ceilingProbeEnabled is false', () => {
            keyManager = createMockKeyManager({ 'claude-haiku': 1 });
            const sync = createSync(
                { ceilingProbeEnabled: false, ceilingProbeCleanTicks: 1 },
                { keyManager }
            );

            aimd._windows.set('claude-haiku', {
                staticMax: 1,
                effectiveMax: 1,
                consecutiveCleanTicks: 100
            });

            sync._tick();

            expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
        });

        test('does nothing when adaptiveConcurrency is null', () => {
            keyManager = createMockKeyManager({ 'claude-haiku': 1 });
            const sync = createSync(
                { ceilingProbeCleanTicks: 1 },
                { keyManager, adaptiveConcurrency: null }
            );

            // No crash, no update
            sync._tick();

            expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
        });

        test('does nothing when _windows is undefined', () => {
            keyManager = createMockKeyManager({ 'claude-haiku': 1 });
            const badAimd = { updateStaticBaseline: jest.fn() };  // no _windows
            const sync = createSync(
                { ceilingProbeCleanTicks: 1 },
                { keyManager, adaptiveConcurrency: badAimd }
            );

            sync._tick();

            expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
        });
    });

    // =================================================================
    // 3. Baseline persistence – save / load round-trip
    // =================================================================
    describe('baseline persistence', () => {
        test('saves baselines to disk via atomicWrite', async () => {
            const configDir = '/tmp/test-persist';
            keyManager = createMockKeyManager({ 'claude-sonnet': 1 });
            const sync = createSync({}, { keyManager, configDir });

            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '7' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '7' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '7' });

            // Wait for the async fire-and-forget _save()
            await new Promise(r => setTimeout(r, 50));

            expect(atomicWrite).toHaveBeenCalled();
            const [savedPath, savedJson] = atomicWrite.mock.calls[0];
            expect(savedPath).toBe(path.join(configDir, 'rate-limit-cache.json'));

            const data = JSON.parse(savedJson);
            expect(data.version).toBe(1);
            expect(data.savedAt).toBeGreaterThan(0);
            expect(data.baselines['claude-sonnet'].concurrency).toBe(7);
            expect(data.baselines['claude-sonnet'].source).toBe('header_observed');
        });

        test('reloads baselines from disk on construction', () => {
            const configDir = '/tmp/test-reload';
            const now = Date.now();
            const cacheData = JSON.stringify({
                version: 1,
                savedAt: now,
                baselines: {
                    'claude-sonnet': { concurrency: 12, source: 'header_observed', discoveredAt: now }
                }
            });

            const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(cacheData);

            const km = createMockKeyManager({ 'claude-sonnet': 5 });
            const sync = new RateLimitSync(
                { enabled: true },
                { logger, keyManager: km, adaptiveConcurrency: aimd, modelDiscovery, configDir }
            );

            const snap = sync.getSnapshot();
            expect(snap.baselines['claude-sonnet']).toBeDefined();
            expect(snap.baselines['claude-sonnet'].concurrency).toBe(12);

            readSpy.mockRestore();
        });

        test('applies cached baselines on start() if fresh', () => {
            const configDir = '/tmp/test-apply';
            const now = Date.now();
            const cacheData = JSON.stringify({
                version: 1,
                savedAt: now,
                baselines: {
                    'claude-sonnet': { concurrency: 15, source: 'header_observed', discoveredAt: now }
                }
            });

            const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(cacheData);

            const km = createMockKeyManager({ 'claude-sonnet': 5 });
            const sync = new RateLimitSync(
                { enabled: true, tickIntervalMs: 60000 },
                { logger, keyManager: km, adaptiveConcurrency: aimd, modelDiscovery, configDir }
            );

            sync.start();

            // Fresh baseline should be applied
            expect(km.updateStaticModelLimit).toHaveBeenCalledWith('claude-sonnet', 15);
            expect(aimd.updateStaticBaseline).toHaveBeenCalledWith('claude-sonnet', 15);
            expect(modelDiscovery.updateModelMetadata).toHaveBeenCalledWith(
                'claude-sonnet',
                expect.objectContaining({ maxConcurrency: 15, source: 'cached' })
            );

            sync.stop();
            readSpy.mockRestore();
        });

        test('does not persist when configDir is not set', async () => {
            keyManager = createMockKeyManager({ 'claude-sonnet': 1 });
            const sync = createSync({}, { keyManager, configDir: undefined });

            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '7' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '7' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '7' });

            await new Promise(r => setTimeout(r, 50));

            // No persistence, but update still happens
            expect(keyManager.updateStaticModelLimit).toHaveBeenCalledWith('claude-sonnet', 7);
            expect(atomicWrite).not.toHaveBeenCalled();
        });

        test('ignores cache file with wrong version', () => {
            const configDir = '/tmp/test-version';
            const cacheData = JSON.stringify({
                version: 99,
                savedAt: Date.now(),
                baselines: {
                    'claude-sonnet': { concurrency: 100, source: 'header_observed', discoveredAt: Date.now() }
                }
            });

            const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(cacheData);

            const km = createMockKeyManager({ 'claude-sonnet': 5 });
            const sync = new RateLimitSync(
                { enabled: true },
                { logger, keyManager: km, configDir }
            );

            const snap = sync.getSnapshot();
            expect(snap.baselines['claude-sonnet']).toBeUndefined();

            readSpy.mockRestore();
        });

        test('ignores cache entries with invalid concurrency', () => {
            const configDir = '/tmp/test-invalid';
            const cacheData = JSON.stringify({
                version: 1,
                savedAt: Date.now(),
                baselines: {
                    'model-a': { concurrency: -1, source: 'test', discoveredAt: Date.now() },
                    'model-b': { concurrency: 0, source: 'test', discoveredAt: Date.now() },
                    'model-c': { concurrency: 'five', source: 'test', discoveredAt: Date.now() },
                    'model-d': { concurrency: 5, source: 'test', discoveredAt: Date.now() }
                }
            });

            const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(cacheData);

            const km = createMockKeyManager({});
            const sync = new RateLimitSync(
                { enabled: true },
                { logger, keyManager: km, configDir }
            );

            const snap = sync.getSnapshot();
            // Only model-d should be loaded (concurrency 5 is valid, >= 1)
            expect(snap.baselines['model-a']).toBeUndefined();
            expect(snap.baselines['model-b']).toBeUndefined();
            expect(snap.baselines['model-c']).toBeUndefined();
            expect(snap.baselines['model-d']).toBeDefined();
            expect(snap.baselines['model-d'].concurrency).toBe(5);

            readSpy.mockRestore();
        });

        test('handles corrupt JSON in cache file gracefully', () => {
            const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue('NOT VALID JSON{{{');

            expect(() => {
                new RateLimitSync(
                    { enabled: true },
                    { logger, keyManager, configDir: '/tmp/corrupt' }
                );
            }).not.toThrow();

            expect(logger.warn).toHaveBeenCalledWith(
                'RateLimitSync: failed to load cache',
                expect.objectContaining({ error: expect.any(String) })
            );

            readSpy.mockRestore();
        });

        test('save failure does not throw from _applyDiscoveredLimit', async () => {
            atomicWrite.mockRejectedValueOnce(new Error('disk full'));

            const configDir = '/tmp/test-save-fail';
            keyManager = createMockKeyManager({ 'claude-sonnet': 1 });
            const sync = createSync({}, { keyManager, configDir });

            // Should not throw even though save fails
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '5' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '5' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '5' });

            // Wait for the fire-and-forget _save()
            await new Promise(r => setTimeout(r, 50));

            // Update still applied in memory
            expect(keyManager.updateStaticModelLimit).toHaveBeenCalledWith('claude-sonnet', 5);

            // Warning logged
            expect(logger.warn).toHaveBeenCalledWith(
                'RateLimitSync: failed to save cache',
                expect.objectContaining({ error: 'disk full' })
            );
        });
    });

    // =================================================================
    // 4. Stale baseline detection
    // =================================================================
    describe('stale baseline detection', () => {
        test('skips baselines older than staleThresholdMs', () => {
            const staleTimestamp = Date.now() - (25 * 60 * 60 * 1000); // 25 hours
            const cacheData = JSON.stringify({
                version: 1,
                savedAt: staleTimestamp,
                baselines: {
                    'claude-sonnet': { concurrency: 50, source: 'header_observed', discoveredAt: staleTimestamp }
                }
            });

            const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(cacheData);

            const km = createMockKeyManager({ 'claude-sonnet': 5 });
            const sync = new RateLimitSync(
                { enabled: true, staleThresholdMs: 86400000 },
                { logger, keyManager: km, adaptiveConcurrency: aimd, modelDiscovery, configDir: '/tmp/stale' }
            );

            sync.start();

            expect(km.updateStaticModelLimit).not.toHaveBeenCalled();
            expect(logger.info).toHaveBeenCalledWith(
                'RateLimitSync: stale cached baseline skipped',
                expect.objectContaining({ model: 'claude-sonnet' })
            );

            sync.stop();
            readSpy.mockRestore();
        });

        test('applies baselines within staleThresholdMs', () => {
            const freshTimestamp = Date.now() - (1 * 60 * 60 * 1000); // 1 hour ago
            const cacheData = JSON.stringify({
                version: 1,
                savedAt: freshTimestamp,
                baselines: {
                    'claude-sonnet': { concurrency: 50, source: 'header_observed', discoveredAt: freshTimestamp }
                }
            });

            const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(cacheData);

            const km = createMockKeyManager({ 'claude-sonnet': 5 });
            const sync = new RateLimitSync(
                { enabled: true, staleThresholdMs: 86400000 },
                { logger, keyManager: km, adaptiveConcurrency: aimd, modelDiscovery, configDir: '/tmp/fresh' }
            );

            sync.start();

            expect(km.updateStaticModelLimit).toHaveBeenCalledWith('claude-sonnet', 50);

            sync.stop();
            readSpy.mockRestore();
        });

        test('custom short stale threshold flags recent baselines as stale', () => {
            const recentTimestamp = Date.now() - (2 * 60 * 1000); // 2 minutes ago
            const cacheData = JSON.stringify({
                version: 1,
                savedAt: recentTimestamp,
                baselines: {
                    'claude-sonnet': { concurrency: 20, source: 'header_observed', discoveredAt: recentTimestamp }
                }
            });

            const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(cacheData);

            const km = createMockKeyManager({ 'claude-sonnet': 5 });
            const sync = new RateLimitSync(
                { enabled: true, staleThresholdMs: 60000 },   // 1 minute threshold
                { logger, keyManager: km, adaptiveConcurrency: aimd, modelDiscovery, configDir: '/tmp/short-stale' }
            );

            sync.start();

            // 2 minutes old > 1 minute threshold => stale
            expect(km.updateStaticModelLimit).not.toHaveBeenCalled();

            sync.stop();
            readSpy.mockRestore();
        });

        test('mixed fresh and stale baselines: only fresh ones applied', () => {
            const now = Date.now();
            const cacheData = JSON.stringify({
                version: 1,
                savedAt: now,
                baselines: {
                    'claude-sonnet': { concurrency: 20, source: 'header_observed', discoveredAt: now - (25 * 60 * 60 * 1000) },
                    'claude-opus': { concurrency: 30, source: 'header_observed', discoveredAt: now - (1 * 60 * 60 * 1000) }
                }
            });

            const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(cacheData);

            const km = createMockKeyManager({ 'claude-sonnet': 5, 'claude-opus': 5 });
            const sync = new RateLimitSync(
                { enabled: true, staleThresholdMs: 86400000 },
                { logger, keyManager: km, adaptiveConcurrency: aimd, modelDiscovery, configDir: '/tmp/mixed' }
            );

            sync.start();

            // Sonnet is stale (25h), opus is fresh (1h)
            expect(km.updateStaticModelLimit).not.toHaveBeenCalledWith('claude-sonnet', 20);
            expect(km.updateStaticModelLimit).toHaveBeenCalledWith('claude-opus', 30);

            sync.stop();
            readSpy.mockRestore();
        });
    });

    // =================================================================
    // 5. Quorum requirement
    // =================================================================
    describe('quorum requirement', () => {
        test('default quorum of 3: no update with only 2 observations', () => {
            keyManager = createMockKeyManager({ 'claude-sonnet': 1 });
            const sync = createSync({ quorumSize: 3 }, { keyManager });

            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });

            expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
        });

        test('default quorum of 3: updates on 3rd observation', () => {
            keyManager = createMockKeyManager({ 'claude-sonnet': 1 });
            const sync = createSync({ quorumSize: 3 }, { keyManager });

            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });

            expect(keyManager.updateStaticModelLimit).toHaveBeenCalledTimes(1);
            expect(keyManager.updateStaticModelLimit).toHaveBeenCalledWith('claude-sonnet', 10);
        });

        test('quorum of 5: no update with 4 observations', () => {
            keyManager = createMockKeyManager({ 'claude-sonnet': 1 });
            const sync = createSync({ quorumSize: 5 }, { keyManager });

            for (let i = 0; i < 4; i++) {
                sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });
            }

            expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
        });

        test('quorum of 5: updates on 5th observation', () => {
            keyManager = createMockKeyManager({ 'claude-sonnet': 1 });
            const sync = createSync({ quorumSize: 5 }, { keyManager });

            for (let i = 0; i < 5; i++) {
                sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });
            }

            expect(keyManager.updateStaticModelLimit).toHaveBeenCalledTimes(1);
        });

        test('quorum of 1: updates on first observation', () => {
            keyManager = createMockKeyManager({ 'claude-sonnet': 1 });
            const sync = createSync({ quorumSize: 1 }, { keyManager });

            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });

            expect(keyManager.updateStaticModelLimit).toHaveBeenCalledTimes(1);
        });

        test('quorum broken by inconsistent value resets progress', () => {
            keyManager = createMockKeyManager({ 'claude-sonnet': 1 });
            const sync = createSync({ quorumSize: 3 }, { keyManager });

            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '8' });  // breaks quorum

            expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();

            // Need 3 new consistent values
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '8' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '8' });

            expect(keyManager.updateStaticModelLimit).toHaveBeenCalledWith('claude-sonnet', 8);
        });

        test('quorum satisfied but value matches current static: no update', () => {
            keyManager = createMockKeyManager({ 'claude-sonnet': 10 });
            const sync = createSync({ quorumSize: 3 }, { keyManager });

            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });

            expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
        });
    });

    // =================================================================
    // 6. Multiple models – independent tracking
    // =================================================================
    describe('multiple models', () => {
        test('each model has independent observation buffers', () => {
            keyManager = createMockKeyManager({
                'claude-sonnet': 1,
                'claude-opus': 1,
                'claude-haiku': 1
            });
            const sync = createSync({}, { keyManager });

            // Only sonnet reaches quorum
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });

            sync.recordHeaders('claude-opus', { 'x-ratelimit-limit': '20' });
            sync.recordHeaders('claude-opus', { 'x-ratelimit-limit': '20' });
            // opus has only 2 observations

            sync.recordHeaders('claude-haiku', { 'x-ratelimit-limit': '30' });
            // haiku has only 1 observation

            expect(keyManager.updateStaticModelLimit).toHaveBeenCalledTimes(1);
            expect(keyManager.updateStaticModelLimit).toHaveBeenCalledWith('claude-sonnet', 10);
        });

        test('each model has independent baselines', () => {
            keyManager = createMockKeyManager({
                'claude-sonnet': 1,
                'claude-opus': 1
            });
            const sync = createSync({}, { keyManager });

            // Sonnet gets limit 10
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '10' });

            // Opus gets limit 20
            sync.recordHeaders('claude-opus', { 'x-ratelimit-limit': '20' });
            sync.recordHeaders('claude-opus', { 'x-ratelimit-limit': '20' });
            sync.recordHeaders('claude-opus', { 'x-ratelimit-limit': '20' });

            const snap = sync.getSnapshot();
            expect(snap.baselines['claude-sonnet'].concurrency).toBe(10);
            expect(snap.baselines['claude-opus'].concurrency).toBe(20);
        });

        test('ceiling probe targets only idle models, not active ones', () => {
            keyManager = createMockKeyManager({
                'model-active': 5,
                'model-idle': 5
            });
            const sync = createSync(
                { ceilingProbeCleanTicks: 5, ceilingProbeStep: 1, ceilingProbeMaxAboveStatic: 10, tickIntervalMs: 30000 },
                { keyManager }
            );

            // Active model has recent header observations
            sync.recordHeaders('model-active', { 'x-ratelimit-limit': '5' });

            // Both models are at ceiling in AIMD
            aimd._windows.set('model-active', {
                staticMax: 5, effectiveMax: 5, consecutiveCleanTicks: 20
            });
            aimd._windows.set('model-idle', {
                staticMax: 5, effectiveMax: 5, consecutiveCleanTicks: 20
            });

            sync._tick();

            // Only idle model should be probed
            expect(keyManager.updateStaticModelLimit).toHaveBeenCalledWith('model-idle', 6);
            expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalledWith('model-active', expect.any(Number));
        });

        test('snapshot tracks all observed models independently', () => {
            keyManager = createMockKeyManager({
                'model-a': 1,
                'model-b': 2,
                'model-c': 3
            });
            const sync = createSync({}, { keyManager });

            sync.recordHeaders('model-a', { 'x-ratelimit-limit': '10' });
            sync.recordHeaders('model-b', { 'x-ratelimit-limit': '20' });
            sync.recordHeaders('model-c', { 'x-ratelimit-limit': '30' });

            const snap = sync.getSnapshot();
            expect(Object.keys(snap.models)).toHaveLength(3);
            expect(snap.models['model-a'].observations).toHaveLength(1);
            expect(snap.models['model-b'].observations).toHaveLength(1);
            expect(snap.models['model-c'].observations).toHaveLength(1);
        });
    });

    // =================================================================
    // 7. Error handling – failed probe doesn't corrupt baseline
    // =================================================================
    describe('error handling', () => {
        test('failed ceiling probe does not corrupt existing baseline', () => {
            keyManager = createMockKeyManager({ 'claude-haiku': 3 });
            const sync = createSync(
                { ceilingProbeCleanTicks: 5, ceilingProbeStep: 1, ceilingProbeMaxAboveStatic: 10 },
                { keyManager }
            );

            // Establish a baseline via header observation
            sync.recordHeaders('claude-haiku', { 'x-ratelimit-limit': '5' });
            sync.recordHeaders('claude-haiku', { 'x-ratelimit-limit': '5' });
            sync.recordHeaders('claude-haiku', { 'x-ratelimit-limit': '5' });

            expect(sync.getSnapshot().baselines['claude-haiku'].concurrency).toBe(5);

            // Now make updateStaticModelLimit throw on next call
            keyManager.updateStaticModelLimit.mockImplementationOnce(() => {
                throw new Error('update failed');
            });

            // Probe should try to raise to 6
            aimd._windows.set('claude-haiku', {
                staticMax: 5,
                effectiveMax: 5,
                consecutiveCleanTicks: 20
            });

            // _tick calls _applyDiscoveredLimit which will throw, but
            // the baseline map was already set to 5 before the probe
            try {
                sync._tick();
            } catch {
                // Expected to throw
            }

            // Original baseline of 5 should still be intact
            expect(sync._baselines.get('claude-haiku').concurrency).toBe(5);
        });

        test('_applyDiscoveredLimit is no-op when newLimit equals current static', () => {
            keyManager = createMockKeyManager({ 'claude-sonnet': 10 });
            const sync = createSync({}, { keyManager });

            // Directly call _applyDiscoveredLimit with the same value
            sync._applyDiscoveredLimit('claude-sonnet', 10, 'test');

            expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
            expect(aimd.updateStaticBaseline).not.toHaveBeenCalled();
        });

        test('works with no keyManager (optional chaining)', () => {
            const sync = createSync({}, { keyManager: null });

            // Should not throw
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '5' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '5' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '5' });

            // No crash, quorum logic still evaluates (getStaticModelLimit returns undefined)
            const snap = sync.getSnapshot();
            expect(snap.models['claude-sonnet']).toBeDefined();
        });

        test('works with no modelDiscovery (optional chaining)', () => {
            keyManager = createMockKeyManager({ 'claude-sonnet': 1 });
            const sync = createSync({}, { keyManager, modelDiscovery: null });

            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '5' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '5' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '5' });

            expect(keyManager.updateStaticModelLimit).toHaveBeenCalledWith('claude-sonnet', 5);
        });

        test('persistAndStop handles save failure gracefully', async () => {
            atomicWrite.mockRejectedValueOnce(new Error('disk fail'));

            const configDir = '/tmp/test-persist-fail';
            const sync = createSync({}, { configDir });
            sync.start();

            // Should not throw
            await sync.persistAndStop();

            expect(sync._tickInterval).toBeNull();
        });
    });

    // =================================================================
    // 8. Timer lifecycle – start / persistAndStop
    // =================================================================
    describe('timer lifecycle', () => {
        test('start() creates interval, stop() clears it', () => {
            const sync = createSync();

            expect(sync._tickInterval).toBeNull();

            sync.start();
            expect(sync._tickInterval).not.toBeNull();

            sync.stop();
            expect(sync._tickInterval).toBeNull();
        });

        test('start() is idempotent (no duplicate timers)', () => {
            const sync = createSync();

            sync.start();
            const ref1 = sync._tickInterval;

            sync.start();
            const ref2 = sync._tickInterval;

            expect(ref1).toBe(ref2);

            sync.stop();
        });

        test('stop() is idempotent (no error on double stop)', () => {
            const sync = createSync();

            sync.start();
            sync.stop();
            sync.stop();  // second stop should be safe

            expect(sync._tickInterval).toBeNull();
        });

        test('persistAndStop() saves then stops timer', async () => {
            const configDir = '/tmp/test-persist-stop';
            keyManager = createMockKeyManager({ 'claude-sonnet': 1 });
            const sync = createSync({}, { keyManager, configDir });

            // Establish a baseline
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '7' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '7' });
            sync.recordHeaders('claude-sonnet', { 'x-ratelimit-limit': '7' });

            await new Promise(r => setTimeout(r, 50));
            atomicWrite.mockClear();

            sync.start();
            expect(sync._tickInterval).not.toBeNull();

            await sync.persistAndStop();

            expect(sync._tickInterval).toBeNull();
            expect(atomicWrite).toHaveBeenCalled();
        });

        test('start() with enabled=false does not create timer', () => {
            const sync = createSync({ enabled: false });

            sync.start();

            expect(sync._tickInterval).toBeNull();
            expect(sync.getSnapshot().running).toBe(false);
        });

        test('start() logs initialization info', () => {
            const sync = createSync({ tickIntervalMs: 15000, quorumSize: 5, ceilingProbeEnabled: false });

            sync.start();

            expect(logger.info).toHaveBeenCalledWith(
                'RateLimitSync started',
                expect.objectContaining({
                    tickIntervalMs: 15000,
                    quorumSize: 5,
                    ceilingProbeEnabled: false
                })
            );

            sync.stop();
        });

        test('timer calls _tick periodically', () => {
            jest.useFakeTimers();

            const sync = createSync({ tickIntervalMs: 1000 });
            const tickSpy = jest.spyOn(sync, '_tick');

            sync.start();

            jest.advanceTimersByTime(3500);

            expect(tickSpy).toHaveBeenCalledTimes(3);

            sync.stop();
            jest.useRealTimers();
        });

        test('stop() prevents further _tick calls', () => {
            jest.useFakeTimers();

            const sync = createSync({ tickIntervalMs: 1000 });
            const tickSpy = jest.spyOn(sync, '_tick');

            sync.start();
            jest.advanceTimersByTime(2500);
            expect(tickSpy).toHaveBeenCalledTimes(2);

            sync.stop();
            jest.advanceTimersByTime(5000);

            // No additional ticks after stop
            expect(tickSpy).toHaveBeenCalledTimes(2);

            jest.useRealTimers();
        });
    });
});
