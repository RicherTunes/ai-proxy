/**
 * Model Discovery Module Tests
 */

const os = require('os');
const { ModelDiscovery, KNOWN_GLM_MODELS, CANDIDATE_MODEL_PATTERNS, inferModelMetadata } = require('../lib/model-discovery');

describe('ModelDiscovery', () => {
    let modelDiscovery;

    beforeEach(() => {
        modelDiscovery = new ModelDiscovery({
            cacheTTL: 100, // Short TTL for testing
            configPath: '/tmp/test-model-discovery.json'
        });
    });

    describe('getModels', () => {
        test('should return all known GLM models', async () => {
            const models = await modelDiscovery.getModels();
            
            expect(models).toBeInstanceOf(Array);
            expect(models.length).toBeGreaterThan(0);
            
            // Check that known models are present
            const modelIds = models.map(m => m.id);
            expect(modelIds).toContain('glm-5');
            expect(modelIds).toContain('glm-4.7');
            expect(modelIds).toContain('glm-4.6');
            expect(modelIds).toContain('glm-4.5-air');
        });

        test('should cache results', async () => {
            const result1 = await modelDiscovery.getModels();
            const result2 = await modelDiscovery.getModels();
            
            // Should return same data (cached)
            expect(result1.length).toBe(result2.length);
            expect(result1[0].id).toBe(result2[0].id);
        });
    });

    describe('getModel', () => {
        test('should find GLM-5 by ID with maxConcurrency=3', async () => {
            const model = await modelDiscovery.getModel('glm-5');

            expect(model).not.toBeNull();
            expect(model.id).toBe('glm-5');
            expect(model.tier).toBe('HEAVY');
            expect(model.maxConcurrency).toBe(3);
        });

        test('should find model by ID', async () => {
            const model = await modelDiscovery.getModel('glm-4.7');

            expect(model).not.toBeNull();
            expect(model.id).toBe('glm-4.7');
            expect(model.tier).toBe('HEAVY');
            expect(model.displayName).toBe('GLM 4.7');
            expect(model.maxConcurrency).toBe(10);
            expect(model.pricing).toBeDefined();
            expect(model.pricing.input).toBe(0.60);
        });

        test('should return null for unknown model', async () => {
            const model = await modelDiscovery.getModel('unknown-model');
            
            expect(model).toBeNull();
        });
    });

    describe('getModelsByTier', () => {
        test('should filter by HEAVY tier', async () => {
            const models = await modelDiscovery.getModelsByTier('HEAVY');

            expect(models).toBeInstanceOf(Array);
            models.forEach(m => {
                expect(m.tier).toBe('HEAVY');
            });
        });

        test('should filter by MEDIUM tier', async () => {
            const models = await modelDiscovery.getModelsByTier('MEDIUM');

            expect(models).toBeInstanceOf(Array);
            models.forEach(m => {
                expect(m.tier).toBe('MEDIUM');
            });
        });

        test('should filter by LIGHT tier', async () => {
            const models = await modelDiscovery.getModelsByTier('LIGHT');

            expect(models).toBeInstanceOf(Array);
            models.forEach(m => {
                expect(m.tier).toBe('LIGHT');
            });
        });

        test('should filter by FREE tier', async () => {
            const models = await modelDiscovery.getModelsByTier('FREE');

            expect(models).toBeInstanceOf(Array);
            models.forEach(m => {
                expect(m.tier).toBe('FREE');
            });
        });
    });

    describe('exportForFrontend', () => {
        test('should return frontend-friendly format', async () => {
            const data = await modelDiscovery.exportForFrontend();
            
            expect(data).toHaveProperty('models');
            expect(data).toHaveProperty('tiers');
            expect(data).toHaveProperty('defaultModel');
            expect(data).toHaveProperty('lastUpdated');
            
            expect(data.models).toBeInstanceOf(Array);
            expect(data.models.length).toBeGreaterThan(0);
            
            // Check model structure
            const firstModel = data.models[0];
            expect(firstModel).toHaveProperty('id');
            expect(firstModel).toHaveProperty('tier');
            expect(firstModel).toHaveProperty('description');
        });

        test('should include tier groupings', async () => {
            const data = await modelDiscovery.exportForFrontend();

            expect(data.tiers).toHaveProperty('HEAVY');
            expect(data.tiers).toHaveProperty('MEDIUM');
            expect(data.tiers).toHaveProperty('LIGHT');
            expect(data.tiers).toHaveProperty('FREE');

            expect(data.tiers.HEAVY).toBeInstanceOf(Array);
            expect(data.tiers.MEDIUM).toBeInstanceOf(Array);
            expect(data.tiers.LIGHT).toBeInstanceOf(Array);
            expect(data.tiers.FREE).toBeInstanceOf(Array);
        });

        test('should include new model properties', async () => {
            const data = await modelDiscovery.exportForFrontend();

            // Check first model has new properties
            const firstModel = data.models[0];
            expect(firstModel).toHaveProperty('name');
            expect(firstModel).toHaveProperty('maxConcurrency');
            expect(firstModel).toHaveProperty('supportsVision');
            expect(firstModel).toHaveProperty('type');
        });

        test('should include source and lastRefreshedAt in exported models', async () => {
            const data = await modelDiscovery.exportForFrontend();

            // All models should have source and lastRefreshedAt
            data.models.forEach(model => {
                expect(model).toHaveProperty('source');
                expect(model).toHaveProperty('lastRefreshedAt');
                expect(['static', 'probed', 'live', 'cached']).toContain(model.source);
            });
        });

        test('should have glm-4.6 as default model', async () => {
            const data = await modelDiscovery.exportForFrontend();
            
            expect(data.defaultModel).toBe('glm-4.6');
        });
    });

    describe('getModelCached', () => {
        test('returns null before cache is populated', () => {
            const md = new ModelDiscovery({ cacheTTL: 100 });
            expect(md.getModelCached('glm-5')).toBeNull();
        });

        test('returns model after getModels populates cache', async () => {
            const md = new ModelDiscovery({ cacheTTL: 100 });
            await md.getModels(); // populate cache
            const model = md.getModelCached('glm-5');
            expect(model).not.toBeNull();
            expect(model.id).toBe('glm-5');
            expect(model.contextLength).toBe(200000);
        });

        test('returns null for unknown model even with populated cache', async () => {
            const md = new ModelDiscovery({ cacheTTL: 100 });
            await md.getModels();
            expect(md.getModelCached('nonexistent-model')).toBeNull();
        });
    });

    describe('clearCache', () => {
        test('should clear cached models', async () => {
            // Cache a model
            await modelDiscovery.getModels();
            const stats1 = modelDiscovery.getCacheStats();
            expect(stats1.size).toBeGreaterThan(0);
            
            // Clear cache
            modelDiscovery.clearCache();
            const stats2 = modelDiscovery.getCacheStats();
            expect(stats2.size).toBe(0);
        });
    });

    describe('getCacheStats', () => {
        test('should return cache statistics', () => {
            const stats = modelDiscovery.getCacheStats();
            
            expect(stats).toHaveProperty('size');
            expect(stats).toHaveProperty('keys');
            expect(stats).toHaveProperty('ttl');
            
            expect(typeof stats.size).toBe('number');
            expect(Array.isArray(stats.keys)).toBe(true);
            expect(typeof stats.ttl).toBe('number');
        });
    });
});

describe('KNOWN_GLM_MODELS', () => {
    test('should have at least 3 known models', () => {
        expect(KNOWN_GLM_MODELS.length).toBeGreaterThanOrEqual(3);
    });

    test('each model should have required properties', () => {
        KNOWN_GLM_MODELS.forEach(model => {
            expect(model).toHaveProperty('id');
            expect(model).toHaveProperty('tier');
            expect(model).toHaveProperty('displayName');
            expect(model).toHaveProperty('description');
            expect(['HEAVY', 'MEDIUM', 'LIGHT', 'FREE']).toContain(model.tier);
        });
    });

    test('each model should have source and lastRefreshedAt fields', () => {
        KNOWN_GLM_MODELS.forEach(model => {
            expect(model).toHaveProperty('source');
            expect(model).toHaveProperty('lastRefreshedAt');
            expect(model.source).toBe('static');
            expect(model.lastRefreshedAt).toBeNull();
        });
    });
});

// ===== MODEL METADATA INTEGRITY (TDD regression guards) =====
// Source of truth: https://docs.z.ai/guides/overview/concept-param
// Last verified: 2026-02-16
describe('KNOWN_GLM_MODELS context windows', () => {
    const byId = Object.fromEntries(KNOWN_GLM_MODELS.map(m => [m.id, m]));

    // --- 200K context models (glm-4.6+, glm-4.7 family) ---
    test.each([
        ['glm-5',          200000],
        ['glm-4.7',        200000],
        ['glm-4.6',        200000],
        ['glm-4.7-flashx', 200000],
        ['glm-4.7-flash',  200000],
    ])('%s should have 200K context window', (id, expected) => {
        expect(byId[id]).toBeDefined();
        expect(byId[id].contextLength).toBe(expected);
    });

    // --- 128K context models (glm-4.5 family, legacy) ---
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
    ])('%s should have 128K context window', (id, expected) => {
        expect(byId[id]).toBeDefined();
        expect(byId[id].contextLength).toBe(expected);
    });

    // --- 64K context models (vision with reduced context) ---
    test('glm-4.5v should have 64K context window', () => {
        expect(byId['glm-4.5v'].contextLength).toBe(64000);
    });

    // --- Bounds check: no model should exceed 200K or be below 1K ---
    test('all chat models with contextLength should be within [1000, 200000]', () => {
        KNOWN_GLM_MODELS
            .filter(m => m.contextLength)
            .forEach(m => {
                expect(m.contextLength).toBeGreaterThanOrEqual(1000);
                expect(m.contextLength).toBeLessThanOrEqual(200000);
            });
    });
});

describe('KNOWN_GLM_MODELS vision flags', () => {
    const byId = Object.fromEntries(KNOWN_GLM_MODELS.map(m => [m.id, m]));

    // Vision models: only the *v variants and glm-4.5 (supports vision in thinking mode)
    test.each([
        ['glm-4.6v',        true],
        ['glm-4.5v',        true],
        ['glm-4.6v-flashx', true],
        ['glm-4.6v-flash',  true],
        ['glm-4.5',         true],  // supports vision in thinking mode
    ])('%s should have supportsVision=%s', (id, expected) => {
        expect(byId[id]).toBeDefined();
        expect(byId[id].supportsVision).toBe(expected);
    });

    // Non-vision models: text-only variants must NOT have vision
    test.each([
        'glm-5', 'glm-4.7', 'glm-4.6',
        'glm-4.5-x', 'glm-4.5-air', 'glm-4.5-airx',
        'glm-4.7-flashx', 'glm-4.7-flash', 'glm-4.5-flash',
        'glm-4.32b-0414-128k', 'glm-4-plus', 'glm-flash',
    ])('%s should NOT support vision', (id) => {
        expect(byId[id]).toBeDefined();
        expect(byId[id].supportsVision).toBeFalsy();
    });
});

describe('KNOWN_GLM_MODELS tier assignments', () => {
    const byId = Object.fromEntries(KNOWN_GLM_MODELS.map(m => [m.id, m]));

    test.each([
        ['glm-5',    'HEAVY'],
        ['glm-4.7',  'HEAVY'],
        ['glm-4.6',  'HEAVY'],
        ['glm-4.5-x','HEAVY'],
        ['glm-4.6v', 'HEAVY'],
    ])('%s should be HEAVY tier', (id, tier) => {
        expect(byId[id].tier).toBe(tier);
    });

    test.each([
        ['glm-4.5',         'MEDIUM'],
        ['glm-4.5-air',     'MEDIUM'],
        ['glm-4.5-airx',    'MEDIUM'],
        ['glm-4.5v',        'MEDIUM'],
        ['glm-4.6v-flashx', 'MEDIUM'],
    ])('%s should be MEDIUM tier', (id, tier) => {
        expect(byId[id].tier).toBe(tier);
    });

    test.each([
        ['glm-4.7-flashx',      'LIGHT'],
        ['glm-4.7-flash',       'LIGHT'],
        ['glm-4.5-flash',       'LIGHT'],
        ['glm-4.32b-0414-128k', 'LIGHT'],
        ['glm-4-plus',          'LIGHT'],
        ['glm-4.6v-flash',      'LIGHT'],
    ])('%s should be LIGHT tier', (id, tier) => {
        expect(byId[id].tier).toBe(tier);
    });
});

describe('KNOWN_GLM_MODELS consistency checks', () => {
    test('every chat model with contextLength should have pricing', () => {
        KNOWN_GLM_MODELS
            .filter(m => m.type === 'chat' && m.contextLength)
            .forEach(m => {
                expect(m.pricing).toBeDefined();
                expect(typeof m.pricing.input).toBe('number');
                expect(typeof m.pricing.output).toBe('number');
            });
    });

    test('every chat model should have maxConcurrency > 0', () => {
        KNOWN_GLM_MODELS
            .filter(m => m.type === 'chat')
            .forEach(m => {
                expect(m.maxConcurrency).toBeGreaterThan(0);
            });
    });

    test('no two models should share the same id', () => {
        const ids = KNOWN_GLM_MODELS.map(m => m.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('200K models should all be in 4.6+ or 4.7 family', () => {
        KNOWN_GLM_MODELS
            .filter(m => m.contextLength === 200000)
            .forEach(m => {
                expect(m.id).toMatch(/glm-(5|4\.[67])/);
            });
    });
});

describe('resolveModelAlias', () => {
    const { resolveModelAlias, CLAUDE_MODEL_ALIASES } = require('../lib/model-discovery');

    test('should resolve short alias to full Claude model name', () => {
        expect(resolveModelAlias('sonnet-4.5')).toBe('claude-sonnet-4-5-20250929');
        expect(resolveModelAlias('opus-4.6')).toBe('claude-opus-4-6');
        expect(resolveModelAlias('haiku-4.5')).toBe('claude-haiku-4-5-20250929');
    });

    test('should return GLM models as-is', () => {
        expect(resolveModelAlias('glm-4.7')).toBe('glm-4.7');
        expect(resolveModelAlias('glm-4.6')).toBe('glm-4.6');
    });

    test('should return unknown models as-is', () => {
        expect(resolveModelAlias('unknown-model-x')).toBe('unknown-model-x');
        expect(resolveModelAlias('')).toBe('');
    });

    test('should have all required aliases defined', () => {
        // Verify key aliases exist using direct property access
        expect(CLAUDE_MODEL_ALIASES['sonnet-4.5']).toBe('claude-sonnet-4-5-20250929');
        expect(CLAUDE_MODEL_ALIASES['opus-4.6']).toBe('claude-opus-4-6');
        expect(CLAUDE_MODEL_ALIASES['haiku-4.5']).toBe('claude-haiku-4-5-20250929');
        expect(CLAUDE_MODEL_ALIASES['glm-5']).toBe('glm-5');
    });
});

describe('loadCustomModels - config file loading', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');

    let tempDir;
    let configPath;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-discovery-test-'));
        configPath = path.join(tempDir, 'test-model-discovery.json');
    });

    afterEach(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('should load custom models from config file', async () => {
        const testConfig = {
            customModels: [
                { id: 'custom-model-1', tier: 'MEDIUM', maxConcurrency: 5 },
                { id: 'custom-model-2', tier: 'LIGHT', maxConcurrency: 10 }
            ]
        };
        fs.writeFileSync(configPath, JSON.stringify(testConfig));

        const discovery = new ModelDiscovery({ configPath });
        await discovery.loadCustomModels();

        expect(discovery.customModels).toEqual(testConfig.customModels);
    });

    test('should handle missing config file gracefully', async () => {
        const discovery = new ModelDiscovery({ configPath: '/nonexistent/path/config.json' });
        const mockLogger = { warn: jest.fn() };
        discovery.logger = mockLogger;

        await discovery.loadCustomModels();

        expect(discovery.customModels).toEqual([]);
        expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('should handle invalid JSON in config file', async () => {
        fs.writeFileSync(configPath, '{ invalid json }');

        // Create a proper logger that supports optional chaining
        const warnCalls = [];
        const mockLogger = {
            warn: (msg, ctx) => { warnCalls.push({ msg, ctx }); }
        };
        const discovery = new ModelDiscovery({ configPath, logger: mockLogger });
        // Ensure logger is set (the constructor doesn't set it, so we set it manually)
        discovery.logger = mockLogger;

        await discovery.loadCustomModels();

        expect(discovery.customModels).toEqual([]);
        // JSON.parse error doesn't have code='ENOENT', so warn should be called
        expect(warnCalls.length).toBeGreaterThan(0);
        expect(warnCalls[0].msg).toBe('Failed to load custom models config');
    });

    test('should handle missing customModels array', async () => {
        const testConfig = { otherField: 'value' };
        fs.writeFileSync(configPath, JSON.stringify(testConfig));

        const discovery = new ModelDiscovery({ configPath });
        await discovery.loadCustomModels();

        expect(discovery.customModels).toEqual([]);
    });

    test('should handle non-array customModels', async () => {
        const testConfig = { customModels: 'not-an-array' };
        fs.writeFileSync(configPath, JSON.stringify(testConfig));

        const discovery = new ModelDiscovery({ configPath });
        await discovery.loadCustomModels();

        expect(discovery.customModels).toEqual([]);
    });

    test('should include custom models in getModels', async () => {
        const testConfig = {
            customModels: [
                { id: 'custom-1', tier: 'MEDIUM', maxConcurrency: 5 }
            ]
        };
        fs.writeFileSync(configPath, JSON.stringify(testConfig));

        const discovery = new ModelDiscovery({ configPath });
        const models = await discovery.getModels();

        const customModel = models.find(m => m.id === 'custom-1');
        expect(customModel).toBeDefined();
        expect(customModel.tier).toBe('MEDIUM');
    });
});

describe('inferModelMetadata', () => {
    test('should infer LIGHT tier for -flash suffix', () => {
        const meta = inferModelMetadata('glm-5-flash');
        expect(meta.tier).toBe('LIGHT');
        expect(meta.pricing.input).toBe(0);
        expect(meta.source).toBe('probed');
    });

    test('should infer MEDIUM tier for -air suffix', () => {
        const meta = inferModelMetadata('glm-5-air');
        expect(meta.tier).toBe('MEDIUM');
        expect(meta.pricing.input).toBe(0.20);
    });

    test('should infer HEAVY tier for -turbo suffix', () => {
        const meta = inferModelMetadata('glm-5-turbo');
        expect(meta.tier).toBe('HEAVY');
        expect(meta.pricing.input).toBe(0.60);
    });

    test('should infer vision type for -v suffix', () => {
        const meta = inferModelMetadata('glm-5v');
        expect(meta.type).toBe('vision');
        expect(meta.supportsVision).toBe(true);
        expect(meta.supportsStreaming).toBe(false);
    });

    test('should set 200K context for glm-5 family', () => {
        const meta = inferModelMetadata('glm-5-turbo');
        expect(meta.contextLength).toBe(200000);
    });

    test('should generate displayName from model ID', () => {
        const meta = inferModelMetadata('glm-5-turbo');
        expect(meta.displayName).toBe('GLM 5 Turbo');
    });

    test('should set source to probed', () => {
        const meta = inferModelMetadata('glm-anything');
        expect(meta.source).toBe('probed');
        expect(meta.lastRefreshedAt).toBeTruthy();
        expect(meta.discoveredAt).toBeTruthy();
    });
});

describe('CANDIDATE_MODEL_PATTERNS', () => {
    test('should be an array of strings', () => {
        expect(Array.isArray(CANDIDATE_MODEL_PATTERNS)).toBe(true);
        expect(CANDIDATE_MODEL_PATTERNS.length).toBeGreaterThan(0);
        for (const id of CANDIDATE_MODEL_PATTERNS) {
            expect(typeof id).toBe('string');
        }
    });

    test('should not overlap with KNOWN_GLM_MODELS', () => {
        const knownIds = new Set(KNOWN_GLM_MODELS.map(m => m.id));
        for (const id of CANDIDATE_MODEL_PATTERNS) {
            expect(knownIds.has(id)).toBe(false);
        }
    });

    test('should include glm-5-turbo', () => {
        expect(CANDIDATE_MODEL_PATTERNS).toContain('glm-5-turbo');
    });
});

describe('ModelDiscovery probing', () => {
    let discovery;

    beforeEach(() => {
        discovery = new ModelDiscovery({
            cacheTTL: 100,
            configPath: '/tmp/test-probe.json',
            configDir: os.tmpdir(),
            persistFile: 'test-discovery-cache-' + Date.now() + '.json'
        });
    });

    test('getProbeState returns initial state', () => {
        const state = discovery.getProbeState();
        expect(state.lastProbeAt).toBeNull();
        expect(state.inProgress).toBe(false);
        expect(state.discoveredCount).toBe(0);
        expect(state.candidatePatterns).toBe(CANDIDATE_MODEL_PATTERNS.length);
    });

    test('addUserCandidate adds and deduplicates', () => {
        discovery.addUserCandidate('test-model-1');
        discovery.addUserCandidate('test-model-1'); // duplicate
        discovery.addUserCandidate('test-model-2');
        expect(discovery._userCandidates).toEqual(['test-model-1', 'test-model-2']);
    });

    test('addUserCandidate rejects invalid input', () => {
        discovery.addUserCandidate('');
        discovery.addUserCandidate(null);
        discovery.addUserCandidate(123);
        expect(discovery._userCandidates).toEqual([]);
    });

    test('probeModels returns error when no API key', async () => {
        const result = await discovery.probeModels({});
        expect(result.error).toBe('no_api_key');
    });

    test('probeModels prevents concurrent probes', async () => {
        discovery._probeState.inProgress = true;
        const result = await discovery.probeModels({ apiKey: 'test' });
        expect(result.error).toBe('probe_already_running');
    });

    test('discovered models appear in getModels', async () => {
        // Manually add a discovered model
        discovery._discoveredModels.set('glm-test-new', {
            id: 'glm-test-new',
            tier: 'MEDIUM',
            displayName: 'GLM Test New',
            source: 'probed'
        });

        const models = await discovery.getModels();
        const found = models.find(m => m.id === 'glm-test-new');
        expect(found).toBeDefined();
        expect(found.source).toBe('probed');
    });

    test('discovered models do not duplicate known models', async () => {
        // Add a model with the same ID as a known model
        discovery._discoveredModels.set('glm-4.7', {
            id: 'glm-4.7',
            tier: 'HEAVY',
            source: 'probed'
        });

        const models = await discovery.getModels();
        const matches = models.filter(m => m.id === 'glm-4.7');
        expect(matches.length).toBe(1); // Should not duplicate
        expect(matches[0].source).toBe('static'); // Known model takes priority
    });
});

describe('ModelDiscovery persistence', () => {
    const os = require('os');
    const fsSync = require('fs');
    const persistFile = 'test-persist-' + Date.now() + '.json';
    const configDir = os.tmpdir();
    const filePath = require('path').join(configDir, persistFile);

    afterEach(() => {
        try { fsSync.unlinkSync(filePath); } catch {}
    });

    test('saveDiscoveryCache writes valid JSON', async () => {
        const discovery = new ModelDiscovery({
            configDir,
            persistFile,
            configPath: '/tmp/nonexistent.json'
        });

        discovery._discoveredModels.set('glm-test', { id: 'glm-test', tier: 'MEDIUM' });
        discovery._userCandidates = ['custom-probe'];
        discovery._probeState.lastProbeAt = '2026-03-15T12:00:00.000Z';

        await discovery._saveDiscoveryCache();

        const data = JSON.parse(fsSync.readFileSync(filePath, 'utf-8'));
        expect(data.version).toBe(1);
        expect(data.discoveredModels['glm-test']).toBeDefined();
        expect(data.userCandidates).toContain('custom-probe');
        expect(data.lastProbeAt).toBe('2026-03-15T12:00:00.000Z');
    });

    test('loadDiscoveryCache restores state', async () => {
        // Write cache manually
        const cache = {
            version: 1,
            savedAt: Date.now(),
            lastProbeAt: '2026-03-15T12:00:00.000Z',
            discoveredModels: { 'glm-cached': { id: 'glm-cached', tier: 'LIGHT', source: 'probed' } },
            userCandidates: ['user-model']
        };
        fsSync.writeFileSync(filePath, JSON.stringify(cache));

        const discovery = new ModelDiscovery({
            configDir,
            persistFile,
            configPath: '/tmp/nonexistent.json'
        });

        expect(discovery._discoveredModels.has('glm-cached')).toBe(true);
        expect(discovery._userCandidates).toContain('user-model');
        expect(discovery._probeState.lastProbeAt).toBe('2026-03-15T12:00:00.000Z');
    });

    test('loadDiscoveryCache handles missing file gracefully', () => {
        const discovery = new ModelDiscovery({
            configDir,
            persistFile: 'nonexistent-' + Date.now() + '.json',
            configPath: '/tmp/nonexistent.json'
        });

        expect(discovery._discoveredModels.size).toBe(0);
        expect(discovery._userCandidates).toEqual([]);
    });

    test('cached discovered models survive round-trip', async () => {
        // Save
        const discovery1 = new ModelDiscovery({ configDir, persistFile, configPath: '/tmp/nonexistent.json' });
        discovery1._discoveredModels.set('glm-roundtrip', { id: 'glm-roundtrip', tier: 'HEAVY', source: 'probed' });
        await discovery1._saveDiscoveryCache();

        // Load
        const discovery2 = new ModelDiscovery({ configDir, persistFile, configPath: '/tmp/nonexistent.json' });
        const models = await discovery2.getModels();
        const found = models.find(m => m.id === 'glm-roundtrip');
        expect(found).toBeDefined();
        expect(found.tier).toBe('HEAVY');
        expect(found.source).toBe('probed');
    });
});
