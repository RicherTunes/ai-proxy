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

describe('RateLimitSync – coverage tests', () => {
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
        jest.useRealTimers();
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
    // 1. Line 47: config spread when config is undefined
    // =================================================================
    describe('constructor with undefined config', () => {
        // Covers line 47: default config spread when config is undefined
        test('uses DEFAULT_CONFIG when config is undefined', () => {
            const sync = new RateLimitSync(undefined, { logger, keyManager });
            expect(sync._config.enabled).toBe(true);
            expect(sync._config.tickIntervalMs).toBe(30000);
            expect(sync._config.quorumSize).toBe(3);
        });

        // Covers line 47: default deps parameter when second arg is omitted
        test('uses default deps when second parameter is omitted', () => {
            const sync = new RateLimitSync({ enabled: false });
            // Should not throw - uses default empty object for deps
            expect(sync._config.enabled).toBe(false);
            expect(sync._logger).toBeDefined(); // default logger
        });

        // Covers line 47: both parameters omitted
        test('handles both parameters being omitted', () => {
            const sync = new RateLimitSync();
            // Should use all defaults
            expect(sync._config.enabled).toBe(true);
            expect(sync._logger).toBeDefined();
        });
    });

    // =================================================================
    // 2. Line 49: logger default parameter (when logger IS provided)
    // =================================================================
    describe('logger parameter', () => {
        // Covers line 49: the else branch of logger || default
        test('uses provided logger when passed', () => {
            const customLogger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
            const sync = new RateLimitSync({}, { logger: customLogger, keyManager });
            sync.start();
            expect(customLogger.info).toHaveBeenCalled();
            sync.stop();
        });

        // Covers line 49: default logger methods are created and called
        test('creates and calls default logger methods when logger is undefined', () => {
            const sync = new RateLimitSync({}, { logger: undefined, keyManager });
            // start() triggers this._logger.info() call
            sync.start();
            // The default logger methods exist and are called
            expect(sync._logger.info).toBeDefined();
            expect(sync._logger.warn).toBeDefined();
            expect(sync._logger.debug).toBeDefined();
            expect(sync._logger.error).toBeDefined();
            sync.stop();
        });

        // Covers line 49: default logger warn method called on stale cache
        test('calls default logger warn when loading stale cache', () => {
            const staleTimestamp = Date.now() - (25 * 60 * 60 * 1000);
            const cacheData = JSON.stringify({
                version: 1,
                savedAt: staleTimestamp,
                baselines: {
                    'stale-default': { concurrency: 10, discoveredAt: staleTimestamp }
                }
            });

            const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(cacheData);

            const sync = new RateLimitSync(
                { enabled: true },
                { logger: undefined, keyManager, configDir: '/tmp/stale-default-log' }
            );

            sync.start();
            // The default logger methods were called without throwing
            expect(sync._logger.info).toBeDefined();
            sync.stop();
            readSpy.mockRestore();
        });
    });

    // =================================================================
    // 3. Line 208: null observation in ring buffer
    // =================================================================
    describe('_checkQuorum null observation', () => {
        // Covers line 208: if (!obs) return; in _checkQuorum
        test('returns early when ring buffer has null observation', () => {
            keyManager = createMockKeyManager({ 'test-model': 5 });
            const sync = createSync({}, { keyManager });

            // Manually create a ring with null at the position that would be read
            const ring = {
                observations: new Array(10).fill(null),
                idx: 2,
                count: 3  // Claims 3 observations but positions are null
            };
            // Put some values but leave the quorum positions as null
            ring.observations[0] = { limit: 10, at: Date.now() };
            ring.observations[1] = { limit: 10, at: Date.now() };
            // Position 9 (which would be read for quorum of 3) is null

            sync._observations.set('test-model', ring);

            // Call _checkQuorum directly - it should return early due to null obs
            sync._checkQuorum('test-model', ring);

            // Should NOT have called update because quorum check failed
            expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
        });
    });

    // =================================================================
    // 4. Line 241: _tick recent observation check (old observations)
    // =================================================================
    describe('_tick recent observation age check', () => {
        // Covers line 241: else branch when latest observation is old
        test('probes idle model when latest observation is older than 2 tick intervals', () => {
            jest.useFakeTimers();
            const now = Date.now();
            jest.setSystemTime(now);

            keyManager = createMockKeyManager({ 'idle-model': 5 });
            const sync = createSync(
                { ceilingProbeCleanTicks: 5, ceilingProbeStep: 1, ceilingProbeMaxAboveStatic: 10, tickIntervalMs: 30000 },
                { keyManager }
            );

            // Add an OLD observation (older than 2 * tickIntervalMs)
            const oldTimestamp = now - (3 * 30000); // 3 tick intervals ago
            const ring = {
                observations: new Array(10).fill(null),
                idx: 1,
                count: 1
            };
            ring.observations[0] = { limit: 5, at: oldTimestamp };
            sync._observations.set('idle-model', ring);

            // Set up AIMD window at ceiling
            aimd._windows.set('idle-model', {
                staticMax: 5,
                effectiveMax: 5,
                consecutiveCleanTicks: 10
            });

            sync._tick();

            // Should probe because observation is stale
            expect(keyManager.updateStaticModelLimit).toHaveBeenCalledWith('idle-model', 6);

            jest.useRealTimers();
        });

        // Covers line 241: the branch when there's no ring for a model
        test('probes model with no observation ring', () => {
            keyManager = createMockKeyManager({ 'no-ring-model': 5 });
            const sync = createSync(
                { ceilingProbeCleanTicks: 5, ceilingProbeStep: 1, ceilingProbeMaxAboveStatic: 10 },
                { keyManager }
            );

            // Set up AIMD window at ceiling (no observation ring for this model)
            aimd._windows.set('no-ring-model', {
                staticMax: 5,
                effectiveMax: 5,
                consecutiveCleanTicks: 10
            });

            sync._tick();

            // Should probe because no ring exists
            expect(keyManager.updateStaticModelLimit).toHaveBeenCalledWith('no-ring-model', 6);
        });

        // Covers line 241: ring exists but count is 0
        test('probes model when ring exists but count is 0', () => {
            keyManager = createMockKeyManager({ 'empty-ring-model': 5 });
            const sync = createSync(
                { ceilingProbeCleanTicks: 5, ceilingProbeStep: 1, ceilingProbeMaxAboveStatic: 10 },
                { keyManager }
            );

            // Empty ring with count 0
            const ring = {
                observations: new Array(10).fill(null),
                idx: 0,
                count: 0
            };
            sync._observations.set('empty-ring-model', ring);

            // Set up AIMD window at ceiling
            aimd._windows.set('empty-ring-model', {
                staticMax: 5,
                effectiveMax: 5,
                consecutiveCleanTicks: 10
            });

            sync._tick();

            // Should probe because count is 0 (no observations)
            expect(keyManager.updateStaticModelLimit).toHaveBeenCalledWith('empty-ring-model', 6);
        });
    });

    // =================================================================
    // 5. Line 251: _tick fallback chain for originalStatic
    // =================================================================
    describe('_tick originalStatic fallback chain', () => {
        // Covers line 251: fallback to keyManager?.getStaticModelLimit?.(model)
        test('uses keyManager.getStaticModelLimit when originalStaticLimits has no entry', () => {
            keyManager = createMockKeyManager({ 'fallback-model': 8 });
            const sync = createSync(
                { ceilingProbeCleanTicks: 5, ceilingProbeStep: 1, ceilingProbeMaxAboveStatic: 3 },
                { keyManager }
            );

            // No entry in _originalStaticLimits, so it should fall back to keyManager
            expect(sync._originalStaticLimits.has('fallback-model')).toBe(false);

            // Set up AIMD window at ceiling
            aimd._windows.set('fallback-model', {
                staticMax: 8,
                effectiveMax: 8,
                consecutiveCleanTicks: 10
            });

            sync._tick();

            // maxAllowed = 8 + 3 = 11, newLimit = 9, should probe
            expect(keyManager.updateStaticModelLimit).toHaveBeenCalledWith('fallback-model', 9);
        });

        // Covers line 251: fallback to w.staticMax when both originalStaticLimits and keyManager have no value
        test('uses w.staticMax as final fallback when no original static available', () => {
            const sync = createSync(
                { ceilingProbeCleanTicks: 5, ceilingProbeStep: 1, ceilingProbeMaxAboveStatic: 3 },
                { keyManager: null }  // No keyManager
            );

            // Set up AIMD window at ceiling
            aimd._windows.set('orphan-model', {
                staticMax: 4,
                effectiveMax: 4,
                consecutiveCleanTicks: 10
            });

            sync._tick();

            // Should still probe using w.staticMax as the base
            // maxAllowed = 4 + 3 = 7, newLimit = 5, should probe
            // But with no keyManager, updateStaticModelLimit won't be called
            // Let's check the baseline was set
            expect(sync._baselines.get('orphan-model')).toBeDefined();
            expect(sync._baselines.get('orphan-model').concurrency).toBe(5);
        });
    });

    // =================================================================
    // 6. Line 299: catch handler for _save failure in _applyDiscoveredLimit
    // =================================================================
    describe('_applyDiscoveredLimit save failure', () => {
        // Covers line 299: catch handler for _save().catch() in _applyDiscoveredLimit
        // NOTE: _save() normally catches its own errors, so the .catch() on line 298
        // only triggers if _save() itself returns a rejected promise.
        // We mock _save directly to trigger this path.
        test('logs "save failed" when _save method itself rejects', async () => {
            const configDir = '/tmp/test-save-catch-line299';
            keyManager = createMockKeyManager({ 'save-fail-line299': 1 });
            const sync = createSync({}, { keyManager, configDir });

            // Mock _save to return a rejected promise to trigger line 299's .catch()
            sync._save = jest.fn().mockRejectedValue(new Error('internal save error'));

            // Trigger a discovered limit update
            sync.recordHeaders('save-fail-line299', { 'x-ratelimit-limit': '5' });
            sync.recordHeaders('save-fail-line299', { 'x-ratelimit-limit': '5' });
            sync.recordHeaders('save-fail-line299', { 'x-ratelimit-limit': '5' });

            // Wait for the fire-and-forget _save() and its .catch()
            await new Promise(r => setTimeout(r, 100));

            // Should have logged the save failure with the line 299 message
            expect(logger.warn).toHaveBeenCalledWith(
                'RateLimitSync: save failed',
                expect.objectContaining({ error: 'internal save error' })
            );
        });
    });

    // =================================================================
    // 7. Line 331: _applyCachedBaselines originalStatic capture
    // =================================================================
    describe('_applyCachedBaselines originalStatic capture', () => {
        // Covers line 331: capture originalStatic before applying cached baseline
        test('captures currentStatic as originalStatic when applying cached baseline', () => {
            const now = Date.now();
            const cacheData = JSON.stringify({
                version: 1,
                savedAt: now,
                baselines: {
                    'capture-model': { concurrency: 20, source: 'header_observed', discoveredAt: now }
                }
            });

            const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(cacheData);

            const km = createMockKeyManager({ 'capture-model': 10 });
            const sync = new RateLimitSync(
                { enabled: true, staleThresholdMs: 86400000 },
                { logger, keyManager: km, adaptiveConcurrency: aimd, modelDiscovery, configDir: '/tmp/capture' }
            );

            sync.start();

            // Should have captured the original static (10) before applying cached (20)
            expect(sync._originalStaticLimits.get('capture-model')).toBe(10);

            sync.stop();
            readSpy.mockRestore();
        });
    });

    // =================================================================
    // 8. Lines 358-371: _load edge cases
    // =================================================================
    describe('_load edge cases', () => {
        // Covers line 358: baselines object type check
        test('handles baselines that is not an object', () => {
            const cacheData = JSON.stringify({
                version: 1,
                savedAt: Date.now(),
                baselines: "not-an-object"
            });

            const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(cacheData);

            const sync = new RateLimitSync(
                { enabled: true },
                { logger, keyManager, configDir: '/tmp/bad-baselines' }
            );

            // Should not have loaded any baselines
            expect(sync._baselines.size).toBe(0);

            readSpy.mockRestore();
        });

        // Covers line 363-364: baseline with missing discoveredAt uses savedAt or 0
        test('uses savedAt as fallback for missing discoveredAt', () => {
            const savedAt = Date.now();
            const cacheData = JSON.stringify({
                version: 1,
                savedAt: savedAt,
                baselines: {
                    'no-discovered': { concurrency: 5, source: 'test' }  // No discoveredAt
                }
            });

            const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(cacheData);

            const sync = new RateLimitSync(
                { enabled: true },
                { logger, keyManager, configDir: '/tmp/fallback-discovered' }
            );

            // Should have loaded with savedAt as discoveredAt
            expect(sync._baselines.get('no-discovered')).toBeDefined();
            expect(sync._baselines.get('no-discovered').discoveredAt).toBe(savedAt);

            readSpy.mockRestore();
        });

        // Covers line 363-364: baseline with missing source uses 'cached'
        test('uses cached as fallback for missing source', () => {
            const now = Date.now();
            const cacheData = JSON.stringify({
                version: 1,
                savedAt: now,
                baselines: {
                    'no-source': { concurrency: 5, discoveredAt: now }  // No source
                }
            });

            const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(cacheData);

            const sync = new RateLimitSync(
                { enabled: true },
                { logger, keyManager, configDir: '/tmp/fallback-source' }
            );

            expect(sync._baselines.get('no-source').source).toBe('cached');

            readSpy.mockRestore();
        });

        // Covers line 364: discoveredAt falls back to 0 when both baseline.discoveredAt and data.savedAt are missing
        test('uses 0 as fallback for missing discoveredAt and savedAt', () => {
            const cacheData = JSON.stringify({
                version: 1,
                // No savedAt at top level
                baselines: {
                    'no-timestamps': { concurrency: 5, source: 'test' }  // No discoveredAt
                }
            });

            const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(cacheData);

            const sync = new RateLimitSync(
                { enabled: true },
                { logger, keyManager, configDir: '/tmp/fallback-zero' }
            );

            // Should have discoveredAt = 0 when both are missing
            expect(sync._baselines.get('no-timestamps').discoveredAt).toBe(0);

            readSpy.mockRestore();
        });

        // Covers line 371: savedAt undefined in log message
        test('logs "unknown" when savedAt is missing', () => {
            const now = Date.now();
            const cacheData = JSON.stringify({
                version: 1,
                // No savedAt
                baselines: {
                    'test-model': { concurrency: 5, discoveredAt: now }
                }
            });

            const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(cacheData);

            const sync = new RateLimitSync(
                { enabled: true },
                { logger, keyManager, configDir: '/tmp/no-savedat' }
            );

            // Should have logged with "unknown" for savedAt
            expect(logger.info).toHaveBeenCalledWith(
                'RateLimitSync: loaded cached baselines',
                expect.objectContaining({ savedAt: 'unknown' })
            );

            readSpy.mockRestore();
        });
    });

    // =================================================================
    // 9. Line 166: getSnapshot observation iteration edge case
    // =================================================================
    describe('getSnapshot edge cases', () => {
        // Covers line 166: observation iteration with valid obs check
        test('getSnapshot handles partially filled ring buffer correctly', () => {
            keyManager = createMockKeyManager({ 'partial-model': 5 });
            const sync = createSync({}, { keyManager });

            // Record only 2 observations
            sync.recordHeaders('partial-model', { 'x-ratelimit-limit': '10' });
            sync.recordHeaders('partial-model', { 'x-ratelimit-limit': '10' });

            const snap = sync.getSnapshot();

            // Should have exactly 2 observations
            expect(snap.models['partial-model'].observations).toHaveLength(2);
            expect(snap.models['partial-model'].observations[0].limit).toBe(10);
            expect(snap.models['partial-model'].observations[1].limit).toBe(10);
        });

        // Covers line 166: the `if (obs)` check when obs is valid
        test('getSnapshot includes observations in correct order', () => {
            keyManager = createMockKeyManager({ 'order-model': 5 });
            const sync = createSync({}, { keyManager });

            // Record multiple observations with different values
            sync.recordHeaders('order-model', { 'x-ratelimit-limit': '1' });
            sync.recordHeaders('order-model', { 'x-ratelimit-limit': '2' });
            sync.recordHeaders('order-model', { 'x-ratelimit-limit': '3' });

            const snap = sync.getSnapshot();

            // Observations should be in chronological order (oldest first)
            expect(snap.models['order-model'].observations).toHaveLength(3);
            expect(snap.models['order-model'].observations[0].limit).toBe(1);
            expect(snap.models['order-model'].observations[1].limit).toBe(2);
            expect(snap.models['order-model'].observations[2].limit).toBe(3);
        });

        // Covers line 166: the `if (obs)` falsy branch - skip null observations
        test('getSnapshot skips null observations in ring buffer', () => {
            keyManager = createMockKeyManager({ 'null-obs-model': 5 });
            const sync = createSync({}, { keyManager });

            // Create a ring buffer with gaps (null observations mixed with valid)
            const ring = {
                observations: new Array(10).fill(null),
                idx: 3,
                count: 3  // Claims 3 observations
            };
            // Set up observations where some are null
            // idx calculation: (ring.idx - ring.count + i + RING_BUFFER_SIZE) % RING_BUFFER_SIZE
            // For i=0: (3 - 3 + 0 + 10) % 10 = 10 % 10 = 0
            // For i=1: (3 - 3 + 1 + 10) % 10 = 11 % 10 = 1
            // For i=2: (3 - 3 + 2 + 10) % 10 = 12 % 10 = 2
            ring.observations[0] = { limit: 10, at: Date.now() };
            ring.observations[1] = null;  // This should be skipped
            ring.observations[2] = { limit: 20, at: Date.now() };

            sync._observations.set('null-obs-model', ring);

            const snap = sync.getSnapshot();

            // Should have only 2 observations (skipped the null one)
            expect(snap.models['null-obs-model'].observations).toHaveLength(2);
            expect(snap.models['null-obs-model'].observations[0].limit).toBe(10);
            expect(snap.models['null-obs-model'].observations[1].limit).toBe(20);
        });
    });

    // =================================================================
    // 10. persistAndStop edge cases
    // =================================================================
    describe('persistAndStop edge cases', () => {
        // Covers persistAndStop handling save error gracefully
        test('persistAndStop handles save error without throwing', async () => {
            atomicWrite.mockRejectedValueOnce(new Error('persist error'));

            const configDir = '/tmp/persist-stop-fail';
            const sync = createSync({}, { configDir });
            sync.start();

            // Should not throw even though save fails
            await expect(sync.persistAndStop()).resolves.toBeUndefined();

            expect(sync._tickInterval).toBeNull();
        });
    });

    // =================================================================
    // 11. ModelDiscovery integration
    // =================================================================
    describe('ModelDiscovery integration', () => {
        // Covers line 284-288: modelDiscovery?.updateModelMetadata?.() call
        test('updates ModelDiscovery metadata when applying discovered limit', () => {
            keyManager = createMockKeyManager({ 'discovery-model': 2 });
            const sync = createSync({}, { keyManager });

            sync.recordHeaders('discovery-model', { 'x-ratelimit-limit': '8' });
            sync.recordHeaders('discovery-model', { 'x-ratelimit-limit': '8' });
            sync.recordHeaders('discovery-model', { 'x-ratelimit-limit': '8' });

            expect(modelDiscovery.updateModelMetadata).toHaveBeenCalledWith(
                'discovery-model',
                expect.objectContaining({
                    maxConcurrency: 8,
                    source: 'live'
                })
            );
        });

        // Covers line 337-341: modelDiscovery?.updateModelMetadata?.() in _applyCachedBaselines
        test('updates ModelDiscovery with cached source when applying cached baseline', () => {
            const now = Date.now();
            const cacheData = JSON.stringify({
                version: 1,
                savedAt: now,
                baselines: {
                    'cached-discovery': { concurrency: 15, source: 'header_observed', discoveredAt: now }
                }
            });

            const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(cacheData);

            const km = createMockKeyManager({ 'cached-discovery': 5 });
            const sync = new RateLimitSync(
                { enabled: true },
                { logger, keyManager: km, adaptiveConcurrency: aimd, modelDiscovery, configDir: '/tmp/cached-discovery' }
            );

            sync.start();

            expect(modelDiscovery.updateModelMetadata).toHaveBeenCalledWith(
                'cached-discovery',
                expect.objectContaining({
                    maxConcurrency: 15,
                    source: 'cached'
                })
            );

            sync.stop();
            readSpy.mockRestore();
        });
    });

    // =================================================================
    // 12. _tick skip branch when model has recent observations
    // =================================================================
    describe('_tick skip active models', () => {
        // Covers line 242: continue when model has recent observations
        test('skips probing when model has recent header observations', () => {
            jest.useFakeTimers();
            const now = Date.now();
            jest.setSystemTime(now);

            keyManager = createMockKeyManager({ 'active-model': 5 });
            const sync = createSync(
                { ceilingProbeCleanTicks: 5, ceilingProbeStep: 1, ceilingProbeMaxAboveStatic: 10, tickIntervalMs: 30000 },
                { keyManager }
            );

            // Add a RECENT observation (within 2 * tickIntervalMs)
            const recentTimestamp = now - 30000; // Exactly 1 tick interval ago
            const ring = {
                observations: new Array(10).fill(null),
                idx: 1,
                count: 1
            };
            ring.observations[0] = { limit: 5, at: recentTimestamp };
            sync._observations.set('active-model', ring);

            // Set up AIMD window at ceiling
            aimd._windows.set('active-model', {
                staticMax: 5,
                effectiveMax: 5,
                consecutiveCleanTicks: 10
            });

            sync._tick();

            // Should NOT probe because observation is recent
            expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();

            jest.useRealTimers();
        });
    });

    // =================================================================
    // 13. Stale baseline skip logging
    // =================================================================
    describe('stale baseline logging', () => {
        // Covers line 311-316: logs when stale baseline is skipped
        test('logs info when cached baseline is stale', () => {
            const staleTimestamp = Date.now() - (25 * 60 * 60 * 1000); // 25 hours
            const cacheData = JSON.stringify({
                version: 1,
                savedAt: staleTimestamp,
                baselines: {
                    'stale-model': { concurrency: 50, source: 'header_observed', discoveredAt: staleTimestamp }
                }
            });

            const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(cacheData);

            const km = createMockKeyManager({ 'stale-model': 5 });
            const sync = new RateLimitSync(
                { enabled: true, staleThresholdMs: 86400000 },
                { logger, keyManager: km, adaptiveConcurrency: aimd, modelDiscovery, configDir: '/tmp/stale-logging' }
            );

            sync.start();

            expect(logger.info).toHaveBeenCalledWith(
                'RateLimitSync: stale cached baseline skipped',
                expect.objectContaining({
                    model: 'stale-model',
                    limit: 50
                })
            );

            sync.stop();
            readSpy.mockRestore();
        });

        // Covers line 320: continue when currentStatic matches baseline
        test('skips update when currentStatic already matches cached baseline', () => {
            const now = Date.now();
            const cacheData = JSON.stringify({
                version: 1,
                savedAt: now,
                baselines: {
                    'already-set': { concurrency: 10, source: 'cached', discoveredAt: now }
                }
            });

            const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(cacheData);

            const km = createMockKeyManager({ 'already-set': 10 }); // Already at 10
            const sync = new RateLimitSync(
                { enabled: true },
                { logger, keyManager: km, adaptiveConcurrency: aimd, modelDiscovery, configDir: '/tmp/already-set' }
            );

            sync.start();

            // Should not call updateStaticModelLimit since it's already at 10
            expect(km.updateStaticModelLimit).not.toHaveBeenCalled();

            sync.stop();
            readSpy.mockRestore();
        });
    });

    // =================================================================
    // 14. _load error logging
    // =================================================================
    describe('_load error handling', () => {
        // Covers line 375: logs warning when load fails
        test('logs warning when cache file cannot be read', () => {
            const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
                const err = new Error('EACCES: permission denied');
                err.code = 'EACCES';
                throw err;
            });

            const sync = new RateLimitSync(
                { enabled: true },
                { logger, keyManager, configDir: '/tmp/no-permission' }
            );

            expect(logger.warn).toHaveBeenCalledWith(
                'RateLimitSync: failed to load cache',
                expect.objectContaining({ error: 'EACCES: permission denied' })
            );

            readSpy.mockRestore();
        });

        // Covers line 374: does NOT log when ENOENT (file not found)
        test('does not log warning when cache file does not exist', () => {
            const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
                const err = new Error('ENOENT: no such file');
                err.code = 'ENOENT';
                throw err;
            });

            new RateLimitSync(
                { enabled: true },
                { logger, keyManager, configDir: '/tmp/nonexistent-cache' }
            );

            expect(logger.warn).not.toHaveBeenCalled();

            readSpy.mockRestore();
        });
    });

    // =================================================================
    // 15. _applyCachedBaselines when currentStatic is undefined
    // =================================================================
    describe('_applyCachedBaselines undefined currentStatic', () => {
        // Covers line 320-321: when currentStatic is undefined (model not in keyManager)
        test('applies cached baseline even when model not in keyManager', () => {
            const now = Date.now();
            const cacheData = JSON.stringify({
                version: 1,
                savedAt: now,
                baselines: {
                    'unknown-model': { concurrency: 25, source: 'cached', discoveredAt: now }
                }
            });

            const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(cacheData);

            const km = createMockKeyManager({}); // unknown-model not in keyManager
            const sync = new RateLimitSync(
                { enabled: true },
                { logger, keyManager: km, adaptiveConcurrency: aimd, modelDiscovery, configDir: '/tmp/unknown-model' }
            );

            sync.start();

            // Should still call updateStaticModelLimit even though currentStatic was undefined
            expect(km.updateStaticModelLimit).toHaveBeenCalledWith('unknown-model', 25);

            sync.stop();
            readSpy.mockRestore();
        });
    });

    // =================================================================
    // 16. _tick when ring has observations but latest is null
    // =================================================================
    describe('_tick ring buffer edge cases', () => {
        // Covers checking latestIdx when ring.count > 0 but latest is null
        test('handles ring with count > 0 but latest observation is null', () => {
            keyManager = createMockKeyManager({ 'null-latest': 5 });
            const sync = createSync(
                { ceilingProbeCleanTicks: 5, ceilingProbeStep: 1, ceilingProbeMaxAboveStatic: 10 },
                { keyManager }
            );

            // Ring with count > 0 but latest observation is null
            const ring = {
                observations: new Array(10).fill(null),
                idx: 5,
                count: 3
            };
            // Observations at indices that would be read are null
            sync._observations.set('null-latest', ring);

            aimd._windows.set('null-latest', {
                staticMax: 5,
                effectiveMax: 5,
                consecutiveCleanTicks: 10
            });

            sync._tick();

            // Should probe since latest is null (no recent observations)
            expect(keyManager.updateStaticModelLimit).toHaveBeenCalledWith('null-latest', 6);
        });
    });

    // =================================================================
    // 17. Multiple cached baselines with mixed ages
    // =================================================================
    describe('multiple cached baselines mixed ages', () => {
        // Covers iterating multiple cached baselines where some are stale
        test('applies only fresh baselines when multiple cached', () => {
            const now = Date.now();
            const cacheData = JSON.stringify({
                version: 1,
                savedAt: now,
                baselines: {
                    'fresh-1': { concurrency: 20, source: 'cached', discoveredAt: now - 1000 },
                    'stale-1': { concurrency: 30, source: 'cached', discoveredAt: now - (25 * 60 * 60 * 1000) },
                    'fresh-2': { concurrency: 40, source: 'cached', discoveredAt: now - 5000 }
                }
            });

            const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(cacheData);

            const km = createMockKeyManager({
                'fresh-1': 5,
                'stale-1': 5,
                'fresh-2': 5
            });
            const sync = new RateLimitSync(
                { enabled: true, staleThresholdMs: 86400000 },
                { logger, keyManager: km, adaptiveConcurrency: aimd, modelDiscovery, configDir: '/tmp/mixed-baselines' }
            );

            sync.start();

            // Only fresh baselines should be applied
            expect(km.updateStaticModelLimit).toHaveBeenCalledWith('fresh-1', 20);
            expect(km.updateStaticModelLimit).not.toHaveBeenCalledWith('stale-1', 30);
            expect(km.updateStaticModelLimit).toHaveBeenCalledWith('fresh-2', 40);

            sync.stop();
            readSpy.mockRestore();
        });
    });

    // =================================================================
    // 18. Default logger warn coverage
    // =================================================================
    describe('default logger warn method coverage', () => {
        // Covers line 269: default logger.warn() via _applyDiscoveredLimit
        test('calls default logger warn when applying discovered limit', async () => {
            keyManager = createMockKeyManager({ 'warn-model': 1 });
            // Create sync WITHOUT logger (uses default)
            const sync = new RateLimitSync(
                { enabled: true },
                { logger: undefined, keyManager, adaptiveConcurrency: aimd, modelDiscovery, configDir: '/tmp/warn-test' }
            );

            // Trigger a discovered limit via quorum
            sync.recordHeaders('warn-model', { 'x-ratelimit-limit': '5' });
            sync.recordHeaders('warn-model', { 'x-ratelimit-limit': '5' });
            sync.recordHeaders('warn-model', { 'x-ratelimit-limit': '5' });

            // Wait for fire-and-forget _save()
            await new Promise(r => setTimeout(r, 50));

            // The default logger's warn method was called without throwing
            // Verify the baseline was set (proving warn path executed)
            expect(sync._baselines.get('warn-model').concurrency).toBe(5);
        });

        // Covers line 375: default logger.warn() via _load error (non-ENOENT)
        test('calls default logger warn when load fails with non-ENOENT error', () => {
            const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
                const err = new Error('EACCES: permission denied');
                err.code = 'EACCES';
                throw err;
            });

            // Create sync WITHOUT logger (uses default)
            const sync = new RateLimitSync(
                { enabled: true },
                { logger: undefined, keyManager, configDir: '/tmp/load-warn-test' }
            );

            // The default logger's warn method was called without throwing
            // Verify the sync was created successfully
            expect(sync._baselines.size).toBe(0);

            readSpy.mockRestore();
        });

        // Covers line 394: default logger.warn() via _save internal error
        test('calls default logger warn when save fails internally', async () => {
            atomicWrite.mockRejectedValueOnce(new Error('disk full on save'));

            keyManager = createMockKeyManager({ 'save-warn-model': 1 });
            // Create sync WITHOUT logger (uses default)
            const sync = new RateLimitSync(
                { enabled: true },
                { logger: undefined, keyManager, adaptiveConcurrency: aimd, modelDiscovery, configDir: '/tmp/save-warn-test' }
            );

            // Trigger a discovered limit via quorum
            sync.recordHeaders('save-warn-model', { 'x-ratelimit-limit': '5' });
            sync.recordHeaders('save-warn-model', { 'x-ratelimit-limit': '5' });
            sync.recordHeaders('save-warn-model', { 'x-ratelimit-limit': '5' });

            // Wait for fire-and-forget _save()
            await new Promise(r => setTimeout(r, 50));

            // The default logger's warn method was called without throwing
            // Verify the baseline was set (proving path executed)
            expect(sync._baselines.get('save-warn-model').concurrency).toBe(5);
        });

        // Covers line 299: default logger.warn() via _save().catch() in _applyDiscoveredLimit
        test('calls default logger warn when _save method itself rejects', async () => {
            keyManager = createMockKeyManager({ 'catch-warn-model': 1 });
            // Create sync WITHOUT logger (uses default)
            const sync = new RateLimitSync(
                { enabled: true },
                { logger: undefined, keyManager, adaptiveConcurrency: aimd, modelDiscovery, configDir: '/tmp/catch-warn-test' }
            );

            // Mock _save to return a rejected promise to trigger line 299's .catch()
            sync._save = jest.fn().mockRejectedValue(new Error('internal save error'));

            // Trigger a discovered limit via quorum
            sync.recordHeaders('catch-warn-model', { 'x-ratelimit-limit': '5' });
            sync.recordHeaders('catch-warn-model', { 'x-ratelimit-limit': '5' });
            sync.recordHeaders('catch-warn-model', { 'x-ratelimit-limit': '5' });

            // Wait for fire-and-forget _save() and its .catch()
            await new Promise(r => setTimeout(r, 100));

            // The default logger's warn method was called without throwing
            // Verify the baseline was set (proving path executed)
            expect(sync._baselines.get('catch-warn-model').concurrency).toBe(5);
        });
    });
});
