'use strict';
/**
 * TDD tests for concurrency sanity bugs:
 *
 * Bug 1: x-ratelimit-limit header contains RPM (requests per minute),
 *         but the code treats it as maxConcurrency. This causes models like
 *         glm-5 (RPM 463) and glm-4.7 (RPM 85) to get absurd concurrency.
 *
 * Bug 2: _metadataOverrides in ModelDiscovery are in-memory only.
 *         On restart, known models lose any overrides (availability, source, etc.)
 *         and discovered models lose their refreshed metadata.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// Mock atomicWrite before requiring modules
jest.mock('../lib/atomic-write', () => ({
  atomicWrite: jest.fn(async (filePath, content) => {
    const mockFs = require('fs');
    const mockPath = require('path');
    mockFs.mkdirSync(mockPath.dirname(filePath), { recursive: true });
    mockFs.writeFileSync(filePath, content, 'utf-8');
  })
}));

const { ModelDiscovery, KNOWN_GLM_MODELS, inferModelMetadata } = require('../lib/model-discovery');
const { RateLimitSync } = require('../lib/rate-limit-sync');

// ─── Helpers ──────────────────────────────────────────────────────────────

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'concurrency-sanity-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function freshDiscovery(overrides = {}) {
  const configDir = tmpDir();
  return {
    d: new ModelDiscovery({
      cacheTTL: 60000,
      configDir,
      persistFile: 'test-discovery-cache.json',
      configPath: path.join(configDir, 'nonexistent.json'),
      probeDelayMs: 0,
      probeTimeoutMs: 5000,
      ...overrides
    }),
    configDir
  };
}

const createMockKeyManager = (staticLimits = {}) => {
  const _static = new Map(Object.entries(staticLimits));
  const _effective = new Map(Object.entries(staticLimits));
  return {
    getStaticModelLimit: (model) => _static.get(model),
    getEffectiveModelLimit: (model) => _effective.get(model),
    updateStaticModelLimit: jest.fn((model, newLimit) => {
      const oldStatic = _static.get(model);
      _static.set(model, newLimit);
      _effective.set(model, newLimit);
      return { oldStatic, newStatic: newLimit, effective: newLimit };
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

// ═══════════════════════════════════════════════════════════════════════════
// BUG 1: RPM values treated as concurrency
// ═══════════════════════════════════════════════════════════════════════════

describe('Bug 1: RPM-as-concurrency sanity cap', () => {

  // ---------------------------------------------------------------
  // 1a. _probeModel should clamp absurd header values
  // ---------------------------------------------------------------
  describe('ModelDiscovery._probeModel header clamping', () => {
    let d, configDir;
    afterEach(() => { jest.restoreAllMocks(); cleanup(configDir); });

    test('discovered model with RPM 463 should NOT get maxConcurrency=463', async () => {
      ({ d, configDir } = freshDiscovery());

      // Simulate probe returning RPM value (463) as rateLimitConcurrency
      jest.spyOn(d, '_probeModel').mockResolvedValue({
        modelId: 'glm-5-turbo',
        availability: 'coding_subscription',
        responseTimeMs: 100,
        rateLimitConcurrency: 463   // This is RPM, not concurrency!
      });

      await d.probeModels({
        apiKey: 'test-key',
        probeKnown: false,
        probeCandidates: true,
        userCandidates: ['glm-5-turbo']
      });

      const model = d._discoveredModels.get('glm-5-turbo');
      expect(model).toBeDefined();
      // The maxConcurrency must NOT be the raw RPM value
      expect(model.maxConcurrency).toBeLessThanOrEqual(50);
      expect(model.maxConcurrency).not.toBe(463);
    });

    test('discovered model with RPM 85 should NOT get maxConcurrency=85', async () => {
      ({ d, configDir } = freshDiscovery());

      jest.spyOn(d, '_probeModel').mockResolvedValue({
        modelId: 'glm-4.8',
        availability: 'coding_subscription',
        responseTimeMs: 80,
        rateLimitConcurrency: 85   // RPM, not concurrency
      });

      await d.probeModels({
        apiKey: 'test-key',
        probeKnown: false,
        probeCandidates: true,
        userCandidates: ['glm-4.8']
      });

      const model = d._discoveredModels.get('glm-4.8');
      expect(model).toBeDefined();
      expect(model.maxConcurrency).toBeLessThanOrEqual(50);
      expect(model.maxConcurrency).not.toBe(85);
    });

    test('discovered model with reasonable concurrency (15) should keep it', async () => {
      ({ d, configDir } = freshDiscovery());

      jest.spyOn(d, '_probeModel').mockResolvedValue({
        modelId: 'glm-5-turbo',
        availability: 'coding_subscription',
        responseTimeMs: 50,
        rateLimitConcurrency: 15   // Reasonable — this IS concurrency
      });

      await d.probeModels({
        apiKey: 'test-key',
        probeKnown: false,
        probeCandidates: true,
        userCandidates: ['glm-5-turbo']
      });

      const model = d._discoveredModels.get('glm-5-turbo');
      expect(model).toBeDefined();
      expect(model.maxConcurrency).toBe(15);
    });

    test('discovered model with concurrency=0 should use inferred default', async () => {
      ({ d, configDir } = freshDiscovery());

      jest.spyOn(d, '_probeModel').mockResolvedValue({
        modelId: 'glm-5-turbo',
        availability: 'coding_subscription',
        responseTimeMs: 50,
        rateLimitConcurrency: 0
      });

      await d.probeModels({
        apiKey: 'test-key',
        probeKnown: false,
        probeCandidates: true,
        userCandidates: ['glm-5-turbo']
      });

      const model = d._discoveredModels.get('glm-5-turbo');
      expect(model).toBeDefined();
      // Should use inferModelMetadata default (1), not 0
      expect(model.maxConcurrency).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------
  // 1b. RateLimitSync.recordHeaders should reject RPM values
  // ---------------------------------------------------------------
  describe('RateLimitSync.recordHeaders RPM rejection', () => {
    let keyManager, aimd, modelDiscovery, logger;

    beforeEach(() => {
      jest.clearAllMocks();
      keyManager = createMockKeyManager({ 'glm-5': 2 });
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

    test('header value 463 (RPM) should NOT update concurrency for glm-5', () => {
      const sync = createSync();

      // Simulate 3 consistent RPM observations — would normally trigger quorum
      sync.recordHeaders('glm-5', { 'x-ratelimit-limit': '463' });
      sync.recordHeaders('glm-5', { 'x-ratelimit-limit': '463' });
      sync.recordHeaders('glm-5', { 'x-ratelimit-limit': '463' });

      // Should NOT have updated — 463 is clearly RPM, not concurrency
      expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
    });

    test('header value 85 (RPM) should NOT update concurrency for glm-4.7', () => {
      keyManager = createMockKeyManager({ 'glm-4.7': 10 });
      const sync = createSync({}, { keyManager });

      sync.recordHeaders('glm-4.7', { 'x-ratelimit-limit': '85' });
      sync.recordHeaders('glm-4.7', { 'x-ratelimit-limit': '85' });
      sync.recordHeaders('glm-4.7', { 'x-ratelimit-limit': '85' });

      expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
    });

    test('header value 200 (RPM) should NOT update concurrency', () => {
      keyManager = createMockKeyManager({ 'glm-4.6': 8 });
      const sync = createSync({}, { keyManager });

      sync.recordHeaders('glm-4.6', { 'x-ratelimit-limit': '200' });
      sync.recordHeaders('glm-4.6', { 'x-ratelimit-limit': '200' });
      sync.recordHeaders('glm-4.6', { 'x-ratelimit-limit': '200' });

      expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
    });

    test('header value within per-model ceiling (static+5) SHOULD trigger update', () => {
      keyManager = createMockKeyManager({ 'glm-4.5': 5 });
      const sync = createSync({}, { keyManager });

      // 8 is within ceiling (static 5 + maxAboveStatic 5 = 10)
      sync.recordHeaders('glm-4.5', { 'x-ratelimit-limit': '8' });
      sync.recordHeaders('glm-4.5', { 'x-ratelimit-limit': '8' });
      sync.recordHeaders('glm-4.5', { 'x-ratelimit-limit': '8' });

      expect(keyManager.updateStaticModelLimit).toHaveBeenCalledWith('glm-4.5', 8);
    });

    test('header value at per-model ceiling boundary should still work', () => {
      keyManager = createMockKeyManager({ 'glm-test': 5 });
      const sync = createSync({}, { keyManager });

      // 10 is at ceiling (5 + 5 = 10)
      sync.recordHeaders('glm-test', { 'x-ratelimit-limit': '10' });
      sync.recordHeaders('glm-test', { 'x-ratelimit-limit': '10' });
      sync.recordHeaders('glm-test', { 'x-ratelimit-limit': '10' });

      expect(keyManager.updateStaticModelLimit).toHaveBeenCalledWith('glm-test', 10);
    });

    test('header value exceeding per-model ceiling should be rejected', () => {
      keyManager = createMockKeyManager({ 'glm-test': 5 });
      const sync = createSync({}, { keyManager });

      // 11 exceeds ceiling (5 + 5 = 10)
      sync.recordHeaders('glm-test', { 'x-ratelimit-limit': '11' });
      sync.recordHeaders('glm-test', { 'x-ratelimit-limit': '11' });
      sync.recordHeaders('glm-test', { 'x-ratelimit-limit': '11' });

      expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
    });

    test('RPM value 10 for glm-5 (static=2) should be rejected by per-model ceiling', () => {
      keyManager = createMockKeyManager({ 'glm-5': 2 });
      const sync = createSync({}, { keyManager });

      // 10 exceeds ceiling (2 + 5 = 7), this is RPM not concurrency
      sync.recordHeaders('glm-5', { 'x-ratelimit-limit': '10' });
      sync.recordHeaders('glm-5', { 'x-ratelimit-limit': '10' });
      sync.recordHeaders('glm-5', { 'x-ratelimit-limit': '10' });

      expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
    });

    test('RPM value 15 for glm-4.7 (static=10) should still be accepted (within ceiling)', () => {
      keyManager = createMockKeyManager({ 'glm-4.7': 10 });
      const sync = createSync({}, { keyManager });

      // 15 is within ceiling (10 + 5 = 15)
      sync.recordHeaders('glm-4.7', { 'x-ratelimit-limit': '15' });
      sync.recordHeaders('glm-4.7', { 'x-ratelimit-limit': '15' });
      sync.recordHeaders('glm-4.7', { 'x-ratelimit-limit': '15' });

      expect(keyManager.updateStaticModelLimit).toHaveBeenCalledWith('glm-4.7', 15);
    });

    test('header value 51 (above global cap) should be rejected', () => {
      keyManager = createMockKeyManager({ 'glm-test': 45 });
      const sync = createSync({}, { keyManager });

      sync.recordHeaders('glm-test', { 'x-ratelimit-limit': '51' });
      sync.recordHeaders('glm-test', { 'x-ratelimit-limit': '51' });
      sync.recordHeaders('glm-test', { 'x-ratelimit-limit': '51' });

      expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
    });
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// BUG 2: Metadata overrides lost on restart
// ═══════════════════════════════════════════════════════════════════════════

describe('Bug 2: Metadata override persistence across restart', () => {
  let configDir;

  afterEach(() => {
    jest.restoreAllMocks();
    if (configDir) cleanup(configDir);
  });

  test('metadata overrides should survive save/load cycle', async () => {
    // Instance 1: create overrides and save
    const dir = tmpDir();
    configDir = dir;
    const d1 = new ModelDiscovery({
      cacheTTL: 60000,
      configDir: dir,
      persistFile: 'persist-test-cache.json',
      configPath: path.join(dir, 'nonexistent.json'),
    });

    // Simulate RateLimitSync updating metadata for a known model
    d1.updateModelMetadata('glm-5', {
      maxConcurrency: 5,
      source: 'live',
      lastRefreshedAt: '2026-03-29T00:00:00.000Z'
    });

    // Save to disk
    await d1._saveDiscoveryCache();

    // Instance 2: simulate restart — load from same directory
    const d2 = new ModelDiscovery({
      cacheTTL: 60000,
      configDir: dir,
      persistFile: 'persist-test-cache.json',
      configPath: path.join(dir, 'nonexistent.json'),
    });

    // The override should be restored
    const models = await d2.getModels();
    const glm5 = models.find(m => m.id === 'glm-5');

    expect(glm5).toBeDefined();
    expect(glm5.maxConcurrency).toBe(5);
    expect(glm5.source).toBe('live');
  });

  test('discovered models with overrides should persist correctly', async () => {
    const dir = tmpDir();
    configDir = dir;
    const d1 = new ModelDiscovery({
      cacheTTL: 60000,
      configDir: dir,
      persistFile: 'persist-test-cache2.json',
      configPath: path.join(dir, 'nonexistent.json'),
      probeDelayMs: 0,
    });

    // Simulate discovering a new model via probe
    jest.spyOn(d1, '_probeModel').mockResolvedValue({
      modelId: 'glm-5-turbo',
      availability: 'coding_subscription',
      responseTimeMs: 50,
      rateLimitConcurrency: 10
    });

    await d1.probeModels({
      apiKey: 'test-key',
      probeKnown: false,
      probeCandidates: false,
      userCandidates: ['glm-5-turbo']
    });

    // Also add an override for this discovered model
    d1.updateModelMetadata('glm-5-turbo', {
      maxConcurrency: 8,
      source: 'live',
      lastRefreshedAt: '2026-03-29T00:00:00.000Z'
    });

    await d1._saveDiscoveryCache();

    // Instance 2: simulate restart
    const d2 = new ModelDiscovery({
      cacheTTL: 60000,
      configDir: dir,
      persistFile: 'persist-test-cache2.json',
      configPath: path.join(dir, 'nonexistent.json'),
    });

    const models = await d2.getModels();
    const turbo = models.find(m => m.id === 'glm-5-turbo');

    expect(turbo).toBeDefined();
    expect(turbo.maxConcurrency).toBe(8);
    expect(turbo.source).toBe('live');
  });

  test('empty overrides map should not break save/load', async () => {
    const dir = tmpDir();
    configDir = dir;
    const d1 = new ModelDiscovery({
      cacheTTL: 60000,
      configDir: dir,
      persistFile: 'persist-test-cache3.json',
      configPath: path.join(dir, 'nonexistent.json'),
    });

    // No overrides — just save and load
    await d1._saveDiscoveryCache();

    const d2 = new ModelDiscovery({
      cacheTTL: 60000,
      configDir: dir,
      persistFile: 'persist-test-cache3.json',
      configPath: path.join(dir, 'nonexistent.json'),
    });

    expect(d2._metadataOverrides.size).toBe(0);
    const models = await d2.getModels();
    expect(models.length).toBeGreaterThan(0);
  });

  test('override persistence should not conflict with model-routing tiers', async () => {
    const dir = tmpDir();
    configDir = dir;
    const d1 = new ModelDiscovery({
      cacheTTL: 60000,
      configDir: dir,
      persistFile: 'persist-test-cache4.json',
      configPath: path.join(dir, 'nonexistent.json'),
    });

    // Simulate overrides for multiple models (as would happen in real tier routing)
    d1.updateModelMetadata('glm-5', { maxConcurrency: 4, source: 'live' });
    d1.updateModelMetadata('glm-4.7', { maxConcurrency: 12, source: 'live' });
    d1.updateModelMetadata('glm-4.6', { maxConcurrency: 9, source: 'live' });

    await d1._saveDiscoveryCache();

    // Restart
    const d2 = new ModelDiscovery({
      cacheTTL: 60000,
      configDir: dir,
      persistFile: 'persist-test-cache4.json',
      configPath: path.join(dir, 'nonexistent.json'),
    });

    const models = await d2.getModels();
    const glm5 = models.find(m => m.id === 'glm-5');
    const glm47 = models.find(m => m.id === 'glm-4.7');
    const glm46 = models.find(m => m.id === 'glm-4.6');

    expect(glm5.maxConcurrency).toBe(4);
    expect(glm47.maxConcurrency).toBe(12);
    expect(glm46.maxConcurrency).toBe(9);
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// BUG 3 (from adversarial review): Poisoned caches survive restart
// ═══════════════════════════════════════════════════════════════════════════

describe('Bug 3: Poisoned cache files rejected on reload', () => {

  describe('RateLimitSync._load rejects bogus cached baselines', () => {
    let keyManager, aimd, modelDiscovery, logger;

    beforeEach(() => {
      jest.clearAllMocks();
      keyManager = createMockKeyManager({ 'glm-5': 2, 'glm-4.7': 10, 'glm-4.5-air': 10 });
      aimd = createMockAIMD();
      modelDiscovery = createMockModelDiscovery();
      logger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
    });

    afterEach(() => { jest.clearAllTimers(); });

    test('_load discards baselines with concurrency > MAX_SANE_CONCURRENCY', () => {
      const dir = tmpDir();
      // Write a poisoned cache file
      const cacheFile = path.join(dir, 'rate-limit-cache.json');
      fs.writeFileSync(cacheFile, JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        baselines: {
          'glm-5': { concurrency: 463, source: 'ceiling_probe', discoveredAt: Date.now() },
          'glm-4.7': { concurrency: 85, source: 'ceiling_probe', discoveredAt: Date.now() },
          'glm-4.5-air': { concurrency: 770, source: 'ceiling_probe', discoveredAt: Date.now() },
          'glm-4.6': { concurrency: 12, source: 'header_observed', discoveredAt: Date.now() }
        }
      }));

      const sync = new RateLimitSync(
        { enabled: true, tickIntervalMs: 60000 },
        { logger, keyManager, adaptiveConcurrency: aimd, modelDiscovery, configDir: dir }
      );

      // Only glm-4.6 (concurrency: 12) should have been loaded
      const snap = sync.getSnapshot();
      expect(snap.baselines['glm-5']).toBeUndefined();
      expect(snap.baselines['glm-4.7']).toBeUndefined();
      expect(snap.baselines['glm-4.5-air']).toBeUndefined();
      expect(snap.baselines['glm-4.6']).toBeDefined();
      expect(snap.baselines['glm-4.6'].concurrency).toBe(12);

      cleanup(dir);
    });

    test('_applyCachedBaselines does NOT propagate bogus values to KeyManager', () => {
      const dir = tmpDir();
      const cacheFile = path.join(dir, 'rate-limit-cache.json');
      fs.writeFileSync(cacheFile, JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        baselines: {
          'glm-5': { concurrency: 463, source: 'ceiling_probe', discoveredAt: Date.now() }
        }
      }));

      const sync = new RateLimitSync(
        { enabled: true, tickIntervalMs: 60000 },
        { logger, keyManager, adaptiveConcurrency: aimd, modelDiscovery, configDir: dir }
      );
      sync.start();

      // KeyManager should NOT have been called with 463
      expect(keyManager.updateStaticModelLimit).not.toHaveBeenCalled();
      sync.stop();
      cleanup(dir);
    });

    test('_applyCachedBaselines propagates valid cached values normally', () => {
      const dir = tmpDir();
      const cacheFile = path.join(dir, 'rate-limit-cache.json');
      fs.writeFileSync(cacheFile, JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        baselines: {
          'glm-4.7': { concurrency: 12, source: 'header_observed', discoveredAt: Date.now() }
        }
      }));

      const sync = new RateLimitSync(
        { enabled: true, tickIntervalMs: 60000 },
        { logger, keyManager, adaptiveConcurrency: aimd, modelDiscovery, configDir: dir }
      );
      sync.start();

      expect(keyManager.updateStaticModelLimit).toHaveBeenCalledWith('glm-4.7', 12);
      sync.stop();
      cleanup(dir);
    });
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// C4 Fix: Ceiling probe must not have sliding originalStatic baseline
// ═══════════════════════════════════════════════════════════════════════════

describe('C4: Ceiling probe bounded growth', () => {
  let keyManager, aimd, modelDiscovery, logger;

  beforeEach(() => {
    jest.clearAllMocks();
    keyManager = createMockKeyManager({ 'glm-test': 10 });
    aimd = createMockAIMD();
    modelDiscovery = createMockModelDiscovery();
    logger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
  });

  afterEach(() => { jest.clearAllTimers(); });

  function createSync(configOverrides = {}, depsOverrides = {}) {
    return new RateLimitSync(
      { enabled: true, tickIntervalMs: 60000,
        ceilingProbeCleanTicks: 1, ceilingProbeStep: 1, ceilingProbeMaxAboveStatic: 5,
        ...configOverrides },
      { logger, keyManager, adaptiveConcurrency: aimd, modelDiscovery, ...depsOverrides }
    );
  }

  test('ceiling probe captures originalStatic and does not allow sliding growth', () => {
    const sync = createSync();

    // Set up AIMD window at ceiling with enough clean ticks
    aimd._windows.set('glm-test', {
      staticMax: 10, effectiveMax: 10, consecutiveCleanTicks: 20
    });

    // Tick 1: should bump to 11 (10 + 1)
    sync._tick();
    expect(keyManager.updateStaticModelLimit).toHaveBeenCalledWith('glm-test', 11);

    // Simulate that KeyManager now returns 11 for static limit
    keyManager.updateStaticModelLimit.mockClear();
    aimd._windows.set('glm-test', {
      staticMax: 11, effectiveMax: 11, consecutiveCleanTicks: 20
    });

    // Tick repeatedly — should cap at original(10) + maxAboveStatic(5) = 15
    for (let i = 0; i < 10; i++) {
      sync._tick();
    }

    // Should have been called for 12, 13, 14, 15 but NOT beyond
    const calls = keyManager.updateStaticModelLimit.mock.calls
      .filter(c => c[0] === 'glm-test')
      .map(c => c[1]);

    // Every call should be <= 15 (original 10 + maxAboveStatic 5)
    calls.forEach(v => expect(v).toBeLessThanOrEqual(15));
    // And the absolute cap should also hold
    calls.forEach(v => expect(v).toBeLessThanOrEqual(50));
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// Feature: Startup probe — models refresh on server boot
// ═══════════════════════════════════════════════════════════════════════════

describe('Feature: probeOnStartup config and behavior', () => {
  test('probeOnStartup defaults to false in config (security.modelDiscovery)', () => {
    const { DEFAULT_CONFIG } = require('../lib/config');
    expect(DEFAULT_CONFIG.security.modelDiscovery.probeOnStartup).toBe(false);
  });

  test('probeOnStartup can be overridden to false', () => {
    const { DEFAULT_CONFIG } = require('../lib/config');
    const merged = { ...DEFAULT_CONFIG.security.modelDiscovery, probeOnStartup: false };
    expect(merged.probeOnStartup).toBe(false);
  });

  test('ModelDiscovery.probeModels runs correctly during startup probe flow', async () => {
    const dir = tmpDir();
    const d = new ModelDiscovery({
      cacheTTL: 60000,
      configDir: dir,
      persistFile: 'startup-probe-test.json',
      configPath: path.join(dir, 'nonexistent.json'),
      probeDelayMs: 0,
    });

    // Mock _probeModel to return sane concurrency values
    jest.spyOn(d, '_probeModel').mockImplementation(async (modelId) => ({
      modelId,
      availability: 'coding_subscription',
      responseTimeMs: 50,
      rateLimitConcurrency: 8  // Sane value
    }));

    const result = await d.probeModels({
      apiKey: 'test-key',
      probeKnown: true,
      probeCandidates: true
    });

    expect(result.success).toBe(true);
    expect(result.results.verified.length).toBeGreaterThan(0);
    // Verify no absurd concurrency leaked through
    const models = await d.getModels();
    models.forEach(m => {
      if (m.maxConcurrency !== undefined) {
        expect(m.maxConcurrency).toBeLessThanOrEqual(50);
      }
    });

    jest.restoreAllMocks();
    cleanup(dir);
  });
});
