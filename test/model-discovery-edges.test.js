'use strict';
/**
 * Model Discovery Edge-Case Tests
 *
 * Covers: known-model lookup, unknown model safety, cache persistence,
 * stale cache refresh, API error fallback, model-name normalization,
 * pricing accuracy, and context-window accuracy.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const {
  ModelDiscovery,
  KNOWN_GLM_MODELS,
  CLAUDE_MODEL_ALIASES,
  resolveModelAlias,
  inferModelMetadata
} = require('../lib/model-discovery');

// ─── helpers ───────────────────────────────────────────────────────────────
function tmpDiscovery(overrides = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-edge-'));
  return {
    discovery: new ModelDiscovery({
      cacheTTL: overrides.cacheTTL ?? 50,
      configDir,
      persistFile: 'edge-cache.json',
      configPath: path.join(configDir, 'nonexistent.json'),
      ...overrides
    }),
    configDir,
    cacheFile: path.join(configDir, 'edge-cache.json')
  };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Build a lookup map once for the pricing / context / known-model suites
const byId = Object.fromEntries(KNOWN_GLM_MODELS.map(m => [m.id, m]));

// ═══════════════════════════════════════════════════════════════════════════
// 1. Known model lookup — every KNOWN_GLM_MODELS entry returns correct
//    pricing and context window via getModel()
// ═══════════════════════════════════════════════════════════════════════════
describe('Known model lookup', () => {
  let discovery, configDir;

  beforeAll(() => {
    ({ discovery, configDir } = tmpDiscovery({ cacheTTL: 60000 }));
  });
  afterAll(() => cleanup(configDir));

  test.each(KNOWN_GLM_MODELS.map(m => [m.id, m.tier]))(
    '%s is returned by getModel with correct tier (%s)',
    async (id, expectedTier) => {
      const model = await discovery.getModel(id);
      expect(model).not.toBeNull();
      expect(model.id).toBe(id);
      expect(model.tier).toBe(expectedTier);
    }
  );

  test('getModel returns full metadata including pricing when present', async () => {
    for (const known of KNOWN_GLM_MODELS) {
      const model = await discovery.getModel(known.id);
      expect(model).not.toBeNull();
      // pricing may be undefined for tool/image/vision models without pricing
      if (known.pricing) {
        expect(model.pricing).toEqual(known.pricing);
      }
      if (known.contextLength) {
        expect(model.contextLength).toBe(known.contextLength);
      }
    }
  });

  test('getModel returns correct displayName for every known model', async () => {
    for (const known of KNOWN_GLM_MODELS) {
      const model = await discovery.getModel(known.id);
      expect(model.displayName).toBe(known.displayName);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Unknown model — returns null, never throws
// ═══════════════════════════════════════════════════════════════════════════
describe('Unknown model safety', () => {
  let discovery, configDir;

  beforeAll(() => {
    ({ discovery, configDir } = tmpDiscovery());
  });
  afterAll(() => cleanup(configDir));

  test.each([
    'nonexistent-model',
    '',
    'claude-3-opus',
    'claude-3-opus-20240229',
    'gpt-4o',
    'glm-999',
    'GLM-4.7',           // wrong case
    'glm_4_7',           // wrong delimiter
    'null',
    'undefined',
  ])('getModel(%j) returns null without throwing', async (id) => {
    await expect(discovery.getModel(id)).resolves.toBeNull();
  });

  test('getModelCached returns null for unknown model after cache populated', async () => {
    await discovery.getModels(); // populate
    expect(discovery.getModelCached('does-not-exist')).toBeNull();
  });

  test('getModelsByTier returns empty array for non-existent tier', async () => {
    const models = await discovery.getModelsByTier('NONEXISTENT');
    expect(models).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Cache persistence — discovery results saved to disk and reloaded
// ═══════════════════════════════════════════════════════════════════════════
describe('Cache persistence', () => {
  let configDir, cacheFile;

  beforeEach(() => {
    ({ configDir, cacheFile } = tmpDiscovery());
  });
  afterEach(() => cleanup(configDir));

  test('_saveDiscoveryCache writes valid JSON with version=1', async () => {
    const d = new ModelDiscovery({
      configDir,
      persistFile: 'edge-cache.json',
      configPath: path.join(configDir, 'x.json')
    });
    d._discoveredModels.set('glm-save-test', { id: 'glm-save-test', tier: 'LIGHT' });
    d._userCandidates = ['candidate-a'];

    await d._saveDiscoveryCache();

    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    expect(raw.version).toBe(1);
    expect(raw.discoveredModels['glm-save-test']).toBeDefined();
    expect(raw.userCandidates).toContain('candidate-a');
    expect(typeof raw.savedAt).toBe('number');
  });

  test('constructor reloads discovered models from disk', async () => {
    // Write cache
    const cache = {
      version: 1,
      savedAt: Date.now(),
      lastProbeAt: '2026-01-01T00:00:00Z',
      discoveredModels: {
        'glm-reload-test': { id: 'glm-reload-test', tier: 'HEAVY', source: 'probed' }
      },
      userCandidates: ['uc-1']
    };
    fs.writeFileSync(cacheFile, JSON.stringify(cache));

    const d = new ModelDiscovery({
      configDir,
      persistFile: 'edge-cache.json',
      configPath: path.join(configDir, 'x.json')
    });
    expect(d._discoveredModels.has('glm-reload-test')).toBe(true);
    expect(d._userCandidates).toContain('uc-1');
    expect(d._probeState.lastProbeAt).toBe('2026-01-01T00:00:00Z');
  });

  test('reloaded discovered models appear in getModels', async () => {
    const cache = {
      version: 1,
      savedAt: Date.now(),
      discoveredModels: {
        'glm-persisted': { id: 'glm-persisted', tier: 'MEDIUM', source: 'probed' }
      },
      userCandidates: []
    };
    fs.writeFileSync(cacheFile, JSON.stringify(cache));

    const d = new ModelDiscovery({
      configDir,
      persistFile: 'edge-cache.json',
      configPath: path.join(configDir, 'x.json')
    });
    const models = await d.getModels();
    expect(models.find(m => m.id === 'glm-persisted')).toBeDefined();
  });

  test('ignores cache with wrong version', () => {
    fs.writeFileSync(cacheFile, JSON.stringify({ version: 99, discoveredModels: { 'bad': {} } }));

    const d = new ModelDiscovery({
      configDir,
      persistFile: 'edge-cache.json',
      configPath: path.join(configDir, 'x.json')
    });
    expect(d._discoveredModels.size).toBe(0);
  });

  test('handles corrupt JSON gracefully', () => {
    fs.writeFileSync(cacheFile, '{{{{not json}}}}');

    const d = new ModelDiscovery({
      configDir,
      persistFile: 'edge-cache.json',
      configPath: path.join(configDir, 'x.json')
    });
    expect(d._discoveredModels.size).toBe(0);
  });

  test('handles missing cache file gracefully', () => {
    const d = new ModelDiscovery({
      configDir,
      persistFile: 'does-not-exist.json',
      configPath: path.join(configDir, 'x.json')
    });
    expect(d._discoveredModels.size).toBe(0);
    expect(d._userCandidates).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Stale cache — old cache data is refreshed when TTL expires
// ═══════════════════════════════════════════════════════════════════════════
describe('Stale cache refresh', () => {
  let discovery, configDir;

  beforeEach(() => {
    ({ discovery, configDir } = tmpDiscovery({ cacheTTL: 30 })); // 30 ms TTL
  });
  afterEach(() => cleanup(configDir));

  test('in-memory cache serves data within TTL', async () => {
    const first = await discovery.getModels();
    const second = await discovery.getModels();
    // Same reference since we hit the cache
    expect(first).toBe(second);
  });

  test('in-memory cache is invalidated after TTL expires', async () => {
    const first = await discovery.getModels();
    // Wait for TTL to expire
    await new Promise(r => setTimeout(r, 40));
    const second = await discovery.getModels();
    // Different array reference (rebuilt from scratch)
    expect(first).not.toBe(second);
    // But same content
    expect(first.length).toBe(second.length);
  });

  test('getModelCached returns null when TTL expired', async () => {
    await discovery.getModels();
    expect(discovery.getModelCached('glm-5')).not.toBeNull();

    await new Promise(r => setTimeout(r, 40));
    expect(discovery.getModelCached('glm-5')).toBeNull();
  });

  test('clearCache forces fresh rebuild on next getModels', async () => {
    await discovery.getModels();
    expect(discovery.getCacheStats().size).toBeGreaterThan(0);

    discovery.clearCache();
    expect(discovery.getCacheStats().size).toBe(0);

    // Should still work — rebuilds from KNOWN_GLM_MODELS
    const models = await discovery.getModels();
    expect(models.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. API error handling — discovery API failure falls back to cached/known
// ═══════════════════════════════════════════════════════════════════════════
describe('API error handling and fallback', () => {
  let discovery, configDir;

  beforeEach(() => {
    ({ discovery, configDir } = tmpDiscovery());
  });
  afterEach(() => cleanup(configDir));

  test('probeModels returns error when no API key is provided', async () => {
    const result = await discovery.probeModels({});
    expect(result).toEqual({ error: 'no_api_key', message: expect.any(String) });
  });

  test('probeModels prevents concurrent probes', async () => {
    discovery._probeState.inProgress = true;
    const result = await discovery.probeModels({ apiKey: 'key' });
    expect(result).toEqual({ error: 'probe_already_running' });
  });

  test('known models remain accessible even when probing is unavailable', async () => {
    // Even without any probe, all known models should be returned
    const models = await discovery.getModels();
    const knownIds = KNOWN_GLM_MODELS.map(m => m.id);
    for (const id of knownIds) {
      expect(models.find(m => m.id === id)).toBeDefined();
    }
  });

  test('getModel falls back to known data when cache is empty', async () => {
    discovery.clearCache();
    const model = await discovery.getModel('glm-4.7');
    expect(model).not.toBeNull();
    expect(model.id).toBe('glm-4.7');
    expect(model.tier).toBe('HEAVY');
  });

  test('metadata overrides survive cache clear', async () => {
    discovery.updateModelMetadata('glm-5', { maxConcurrency: 99 });
    discovery.clearCache();

    const model = await discovery.getModel('glm-5');
    expect(model.maxConcurrency).toBe(99);
  });

  test('loadCustomModels handles missing config gracefully', async () => {
    // configPath points to nonexistent file
    await discovery.loadCustomModels();
    expect(discovery.customModels).toEqual([]);
  });

  test('loadCustomModels handles invalid JSON config', async () => {
    const badPath = path.join(configDir, 'bad-config.json');
    fs.writeFileSync(badPath, '!!!not json!!!');
    discovery.configPath = badPath;
    const warnCalls = [];
    discovery.logger = { warn: (msg, ctx) => warnCalls.push(msg) };

    await discovery.loadCustomModels();
    expect(discovery.customModels).toEqual([]);
    expect(warnCalls.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Model name normalization — aliases and variant names
// ═══════════════════════════════════════════════════════════════════════════
describe('Model name normalization', () => {
  // --- resolveModelAlias ---
  describe('resolveModelAlias', () => {
    test.each([
      ['sonnet-4.5', 'claude-sonnet-4-5-20250929'],
      ['opus-4.5',   'claude-opus-4-5-20250929'],
      ['haiku-4.5',  'claude-haiku-4-5-20250929'],
      ['sonnet-4.6', 'claude-sonnet-4-6-20250929'],
      ['opus-4.6',   'claude-opus-4-6'],
      ['haiku-4.6',  'claude-haiku-4-6-20250929'],
      ['glm-5',      'glm-5'],
      ['opus-5',     'claude-opus-5'],
      ['sonnet-5',   'claude-sonnet-5'],
    ])('resolveModelAlias(%j) => %j', (alias, expected) => {
      expect(resolveModelAlias(alias)).toBe(expected);
    });

    test('full Claude model names pass through unchanged', () => {
      expect(resolveModelAlias('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5-20250929');
      expect(resolveModelAlias('claude-opus-4-6')).toBe('claude-opus-4-6');
    });

    test('full GLM model names pass through unchanged', () => {
      expect(resolveModelAlias('glm-4.7')).toBe('glm-4.7');
      expect(resolveModelAlias('glm-4.5-air')).toBe('glm-4.5-air');
    });

    test('completely unknown names pass through unchanged', () => {
      expect(resolveModelAlias('gpt-4o')).toBe('gpt-4o');
      expect(resolveModelAlias('mistral-large')).toBe('mistral-large');
    });

    test('null/undefined/empty are handled safely', () => {
      expect(resolveModelAlias(null)).toBeNull();
      expect(resolveModelAlias(undefined)).toBeUndefined();
      expect(resolveModelAlias('')).toBe('');
    });
  });

  // --- Case sensitivity: getModel is case-sensitive, so variants should NOT match ---
  describe('case sensitivity', () => {
    let discovery, configDir;

    beforeAll(() => {
      ({ discovery, configDir } = tmpDiscovery({ cacheTTL: 60000 }));
    });
    afterAll(() => cleanup(configDir));

    test('getModel is case-sensitive (GLM-5 != glm-5)', async () => {
      expect(await discovery.getModel('GLM-5')).toBeNull();
      expect(await discovery.getModel('Glm-4.7')).toBeNull();
      expect(await discovery.getModel('GLM-4.6')).toBeNull();
    });

    test('exact IDs always resolve correctly', async () => {
      for (const known of KNOWN_GLM_MODELS) {
        expect(await discovery.getModel(known.id)).not.toBeNull();
      }
    });
  });

  // --- CLAUDE_MODEL_ALIASES completeness ---
  describe('CLAUDE_MODEL_ALIASES', () => {
    test('all aliases map to non-empty strings', () => {
      for (const [alias, target] of Object.entries(CLAUDE_MODEL_ALIASES)) {
        expect(typeof alias).toBe('string');
        expect(alias.length).toBeGreaterThan(0);
        expect(typeof target).toBe('string');
        expect(target.length).toBeGreaterThan(0);
      }
    });

    test('claude- prefixed targets resolve consistently through resolveModelAlias', () => {
      for (const [alias, target] of Object.entries(CLAUDE_MODEL_ALIASES)) {
        expect(resolveModelAlias(alias)).toBe(target);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Pricing accuracy — token costs match expected values for key models
// ═══════════════════════════════════════════════════════════════════════════
describe('Pricing accuracy', () => {
  // Flagship HEAVY models: $0.60 input, $2.20 output, $0.11 cached
  test.each([
    ['glm-5',   { input: 0.60, output: 2.20, cachedInput: 0.11 }],
    ['glm-4.7', { input: 0.60, output: 2.20, cachedInput: 0.11 }],
    ['glm-4.6', { input: 0.60, output: 2.20, cachedInput: 0.11 }],
    ['glm-4.5', { input: 0.60, output: 2.20, cachedInput: 0.11 }],
  ])('%s flagship pricing', (id, expected) => {
    expect(byId[id]).toBeDefined();
    expect(byId[id].pricing.input).toBeCloseTo(expected.input, 2);
    expect(byId[id].pricing.output).toBeCloseTo(expected.output, 2);
    expect(byId[id].pricing.cachedInput).toBeCloseTo(expected.cachedInput, 2);
  });

  // High-performance glm-4.5-x: $2.20 / $8.90 / $0.45
  test('glm-4.5-x premium pricing', () => {
    const p = byId['glm-4.5-x'].pricing;
    expect(p.input).toBeCloseTo(2.20, 2);
    expect(p.output).toBeCloseTo(8.90, 2);
    expect(p.cachedInput).toBeCloseTo(0.45, 2);
  });

  // Air models: $0.20 / $1.10 / $0.03
  test.each([
    'glm-4.5-air',
    'glm-4.5-airx',
  ])('%s air-tier pricing', (id) => {
    const p = byId[id].pricing;
    expect(p.input).toBeCloseTo(0.20, 2);
    expect(p.output).toBeCloseTo(1.10, 2);
    expect(p.cachedInput).toBeCloseTo(0.03, 2);
  });

  // FlashX (paid): $0.07 / $0.40 / $0.01
  test('glm-4.7-flashx paid flash pricing', () => {
    const p = byId['glm-4.7-flashx'].pricing;
    expect(p.input).toBeCloseTo(0.07, 2);
    expect(p.output).toBeCloseTo(0.40, 2);
    expect(p.cachedInput).toBeCloseTo(0.01, 2);
  });

  // Free models: all zeros
  test.each([
    'glm-4.7-flash',
    'glm-4.5-flash',
    'glm-flash',
  ])('%s free-tier (zero cost)', (id) => {
    const p = byId[id].pricing;
    expect(p.input).toBe(0);
    expect(p.output).toBe(0);
    expect(p.cachedInput).toBe(0);
  });

  // Low-cost models
  test('glm-4.32b-0414-128k pricing ($0.10/$0.10/$0.01)', () => {
    const p = byId['glm-4.32b-0414-128k'].pricing;
    expect(p.input).toBeCloseTo(0.10, 2);
    expect(p.output).toBeCloseTo(0.10, 2);
    expect(p.cachedInput).toBeCloseTo(0.01, 2);
  });

  test('glm-4-plus pricing ($0.05/$0.05/$0.01)', () => {
    const p = byId['glm-4-plus'].pricing;
    expect(p.input).toBeCloseTo(0.05, 2);
    expect(p.output).toBeCloseTo(0.05, 2);
    expect(p.cachedInput).toBeCloseTo(0.01, 2);
  });

  // All pricing objects must have exactly { input, output, cachedInput }
  test('all models with pricing have exactly three numeric fields', () => {
    KNOWN_GLM_MODELS
      .filter(m => m.pricing)
      .forEach(m => {
        expect(Object.keys(m.pricing).sort()).toEqual(['cachedInput', 'input', 'output']);
        expect(typeof m.pricing.input).toBe('number');
        expect(typeof m.pricing.output).toBe('number');
        expect(typeof m.pricing.cachedInput).toBe('number');
        // Prices must be non-negative
        expect(m.pricing.input).toBeGreaterThanOrEqual(0);
        expect(m.pricing.output).toBeGreaterThanOrEqual(0);
        expect(m.pricing.cachedInput).toBeGreaterThanOrEqual(0);
      });
  });

  // cachedInput should never exceed input
  test('cachedInput <= input for all priced models', () => {
    KNOWN_GLM_MODELS
      .filter(m => m.pricing)
      .forEach(m => {
        expect(m.pricing.cachedInput).toBeLessThanOrEqual(m.pricing.input);
      });
  });

  // inferModelMetadata pricing inference
  test('inferModelMetadata infers correct pricing for suffixes', () => {
    const flash = inferModelMetadata('glm-99-flash');
    expect(flash.pricing).toEqual({ input: 0, output: 0, cachedInput: 0 });

    const air = inferModelMetadata('glm-99-air');
    expect(air.pricing).toEqual({ input: 0.20, output: 1.10, cachedInput: 0.03 });

    const turbo = inferModelMetadata('glm-99-turbo');
    expect(turbo.pricing).toEqual({ input: 0.60, output: 2.20, cachedInput: 0.11 });

    const vision = inferModelMetadata('glm-99v');
    expect(vision.pricing).toBeNull();

    const generic = inferModelMetadata('glm-99');
    expect(generic.pricing).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Context window accuracy — sizes match known values
// ═══════════════════════════════════════════════════════════════════════════
describe('Context window accuracy', () => {
  // 200K context: GLM-5, GLM-4.7, GLM-4.6 families
  test.each([
    ['glm-5',          200000],
    ['glm-4.7',        200000],
    ['glm-4.6',        200000],
    ['glm-4.7-flashx', 200000],
    ['glm-4.7-flash',  200000],
  ])('%s has 200K context (%d)', (id, expected) => {
    expect(byId[id]).toBeDefined();
    expect(byId[id].contextLength).toBe(expected);
  });

  // 128K context: GLM-4.5 family, legacy, vision
  test.each([
    ['glm-4.5',              128000],
    ['glm-4.5-x',            128000],
    ['glm-4.5-air',          128000],
    ['glm-4.5-airx',         128000],
    ['glm-4.5-flash',        128000],
    ['glm-4.32b-0414-128k',  128000],
    ['glm-4-plus',           128000],
    ['glm-4.6v',             128000],
    ['glm-4.6v-flashx',      128000],
    ['glm-4.6v-flash',       128000],
    ['glm-flash',            128000],
  ])('%s has 128K context (%d)', (id, expected) => {
    expect(byId[id]).toBeDefined();
    expect(byId[id].contextLength).toBe(expected);
  });

  // 64K context: vision with reduced context
  test('glm-4.5v has 64K context', () => {
    expect(byId['glm-4.5v'].contextLength).toBe(64000);
  });

  // Models without contextLength (tool, image)
  test('glm-ocr and cogview-4 have no contextLength', () => {
    expect(byId['glm-ocr'].contextLength).toBeUndefined();
    expect(byId['cogview-4'].contextLength).toBeUndefined();
  });

  // Bounds: all models with context should be between 1K and 200K
  test('all contextLength values are in [1000, 200000]', () => {
    KNOWN_GLM_MODELS
      .filter(m => m.contextLength != null)
      .forEach(m => {
        expect(m.contextLength).toBeGreaterThanOrEqual(1000);
        expect(m.contextLength).toBeLessThanOrEqual(200000);
      });
  });

  // inferModelMetadata context inference
  test('inferModelMetadata infers 200K for glm-5/4.7/4.8 families', () => {
    expect(inferModelMetadata('glm-5-turbo').contextLength).toBe(200000);
    expect(inferModelMetadata('glm-4.7-air').contextLength).toBe(200000);
    expect(inferModelMetadata('glm-4.8-flash').contextLength).toBe(200000);
  });

  test('inferModelMetadata defaults to 128K for other families', () => {
    expect(inferModelMetadata('glm-4.5-turbo').contextLength).toBe(128000);
    expect(inferModelMetadata('glm-3-air').contextLength).toBe(128000);
  });

  // exportForFrontend preserves context windows
  test('exportForFrontend preserves context windows', async () => {
    const d = new ModelDiscovery({ cacheTTL: 60000 });
    const data = await d.exportForFrontend();

    const glm5 = data.models.find(m => m.id === 'glm-5');
    expect(glm5.contextLength).toBe(200000);

    const glm45v = data.models.find(m => m.id === 'glm-4.5v');
    expect(glm45v.contextLength).toBe(64000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Additional edge cases: updateModelMetadata, probe state, events
// ═══════════════════════════════════════════════════════════════════════════
describe('updateModelMetadata edge cases', () => {
  let discovery, configDir;

  beforeEach(() => {
    ({ discovery, configDir } = tmpDiscovery());
  });
  afterEach(() => cleanup(configDir));

  test('rejects null/undefined/non-object overrides', () => {
    discovery.updateModelMetadata('glm-5', null);
    discovery.updateModelMetadata('glm-5', undefined);
    discovery.updateModelMetadata('glm-5', 'string');
    discovery.updateModelMetadata(null, { maxConcurrency: 1 });
    expect(discovery.getMetadataOverrides()).toEqual({});
  });

  test('merges multiple overrides for same model', async () => {
    discovery.updateModelMetadata('glm-5', { maxConcurrency: 20 });
    discovery.updateModelMetadata('glm-5', { source: 'live' });

    const model = await discovery.getModel('glm-5');
    expect(model.maxConcurrency).toBe(20);
    expect(model.source).toBe('live');
  });

  test('override invalidates cache so next getModels rebuilds', async () => {
    await discovery.getModels();
    expect(discovery.getCacheStats().size).toBe(1);

    discovery.updateModelMetadata('glm-5', { maxConcurrency: 50 });
    expect(discovery.getCacheStats().size).toBe(0); // cache invalidated

    const model = await discovery.getModel('glm-5');
    expect(model.maxConcurrency).toBe(50);
  });

  test('getMetadataOverrides returns current state', () => {
    discovery.updateModelMetadata('glm-5', { maxConcurrency: 7 });
    discovery.updateModelMetadata('glm-4.7', { source: 'live' });

    const overrides = discovery.getMetadataOverrides();
    expect(overrides['glm-5']).toEqual({ maxConcurrency: 7 });
    expect(overrides['glm-4.7']).toEqual({ source: 'live' });
  });
});
