'use strict';
/**
 * Coverage tests for lib/model-discovery.js
 * Targets uncovered branches: _probeModel HTTP paths, probeModels result handling,
 * probeKnown/probeCandidates, user candidate dedup, delay, cache save error,
 * addUserCandidate persistence, mergeWithKnown filtering, expired cache.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const { ModelDiscovery, KNOWN_GLM_MODELS, CANDIDATE_MODEL_PATTERNS } = require('../lib/model-discovery');

// ─── helpers ───────────────────────────────────────────────────────────────
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-cov-'));
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
      persistFile: 'cov-cache.json',
      configPath: path.join(configDir, 'nonexistent.json'),
      probeDelayMs: 0,
      probeTimeoutMs: 5000,
      ...overrides
    }),
    configDir
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. probeModels: probeKnown=true filters chat+vision models (lines 688-691)
// ═══════════════════════════════════════════════════════════════════════════
describe('probeModels with probeKnown', () => {
  let d, configDir;
  afterEach(() => { jest.restoreAllMocks(); cleanup(configDir); });

  // Covers lines 688-691: only chat and vision types are probed, tool/image skipped
  test('probeKnown only includes chat and vision models, skips tool/image', async () => {
    ({ d, configDir } = freshDiscovery());
    const probeSpy = jest.spyOn(d, '_probeModel').mockResolvedValue({
      modelId: 'glm-5',
      availability: 'coding_subscription',
      responseTimeMs: 10,
      rateLimitConcurrency: 0
    });

    await d.probeModels({
      apiKey: 'test-key',
      probeKnown: true,
      probeCandidates: false,
      userCandidates: []
    });

    // glm-ocr (type='tool') and cogview-4 (type='image') should NOT be probed
    const probedIds = probeSpy.mock.calls.map(c => c[0]);
    expect(probedIds).not.toContain('glm-ocr');
    expect(probedIds).not.toContain('cogview-4');
    // glm-5 (type='chat') and glm-4.6v (type='vision') should be probed
    expect(probedIds).toContain('glm-5');
    expect(probedIds).toContain('glm-4.6v');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. probeModels: probeCandidates=true adds candidate patterns (lines 696-698)
// ═══════════════════════════════════════════════════════════════════════════
describe('probeModels with probeCandidates', () => {
  let d, configDir;
  afterEach(() => { jest.restoreAllMocks(); cleanup(configDir); });

  // Covers lines 696-698: candidate patterns not in knownIds are added to probe list
  test('probeCandidates adds candidate patterns not in known models', async () => {
    ({ d, configDir } = freshDiscovery());
    const probeSpy = jest.spyOn(d, '_probeModel').mockResolvedValue({
      modelId: 'x',
      availability: 'invalid',
      responseTimeMs: 5,
      rateLimitConcurrency: 0
    });

    await d.probeModels({
      apiKey: 'test-key',
      probeKnown: false,
      probeCandidates: true,
      userCandidates: []
    });

    const probedIds = probeSpy.mock.calls.map(c => c[0]);
    for (const id of CANDIDATE_MODEL_PATTERNS) {
      expect(probedIds).toContain(id);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. probeModels: result handling — known model verified (lines 731-737)
// ═══════════════════════════════════════════════════════════════════════════
describe('probeModels result: known model verified', () => {
  let d, configDir;
  afterEach(() => { jest.restoreAllMocks(); cleanup(configDir); });

  // Covers lines 731-737: known model with coding_subscription -> results.verified
  test('known model with coding_subscription is added to verified', async () => {
    ({ d, configDir } = freshDiscovery());
    jest.spyOn(d, '_probeModel').mockImplementation(async (modelId) => ({
      modelId,
      availability: 'coding_subscription',
      responseTimeMs: 10,
      rateLimitConcurrency: 0
    }));

    const result = await d.probeModels({
      apiKey: 'test-key',
      probeKnown: true,
      probeCandidates: false,
      userCandidates: []
    });

    expect(result.results.verified).toContain('glm-5');
    expect(result.results.verified).toContain('glm-4.6v');
    expect(result.success).toBe(true);
    expect(typeof result.duration).toBe('number');
    expect(result.modelCount.before).toBe(KNOWN_GLM_MODELS.length);
  });

  // Covers lines 731-737: known model with api_only -> results.verified
  test('known model with api_only is added to verified', async () => {
    ({ d, configDir } = freshDiscovery());
    jest.spyOn(d, '_probeModel').mockImplementation(async (modelId) => ({
      modelId,
      availability: 'api_only',
      responseTimeMs: 10,
      rateLimitConcurrency: 0
    }));

    const result = await d.probeModels({
      apiKey: 'test-key',
      probeKnown: true,
      probeCandidates: false,
      userCandidates: []
    });

    expect(result.results.verified).toContain('glm-4.5-x');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. probeModels: result handling — discovered new model (lines 738-748)
// ═══════════════════════════════════════════════════════════════════════════
describe('probeModels result: new model discovered', () => {
  let d, configDir;
  afterEach(() => { jest.restoreAllMocks(); cleanup(configDir); });

  // Covers lines 738-748: unknown model with coding_subscription -> discovered
  test('unknown model with coding_subscription is discovered', async () => {
    ({ d, configDir } = freshDiscovery());
    jest.spyOn(d, '_probeModel').mockResolvedValue({
      modelId: 'glm-5-turbo',
      availability: 'coding_subscription',
      responseTimeMs: 20,
      rateLimitConcurrency: 0
    });

    const result = await d.probeModels({
      apiKey: 'test-key',
      probeKnown: false,
      probeCandidates: true,
      userCandidates: []
    });

    expect(result.results.discovered).toContain('glm-5-turbo');
    expect(d._discoveredModels.has('glm-5-turbo')).toBe(true);
    expect(d._discoveredModels.get('glm-5-turbo').availability).toBe('coding_subscription');
  });

  // Covers lines 744-746: rate limit concurrency from probe response
  test('discovered model uses rate limit concurrency from response', async () => {
    ({ d, configDir } = freshDiscovery());
    jest.spyOn(d, '_probeModel').mockResolvedValue({
      modelId: 'glm-5-turbo',
      availability: 'api_only',
      responseTimeMs: 20,
      rateLimitConcurrency: 15
    });

    await d.probeModels({
      apiKey: 'test-key',
      probeKnown: false,
      probeCandidates: true,
      userCandidates: []
    });

    expect(d._discoveredModels.get('glm-5-turbo').maxConcurrency).toBe(15);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. probeModels: result handling — invalid and unavailable (lines 749-753)
// ═══════════════════════════════════════════════════════════════════════════
describe('probeModels result: invalid and unavailable', () => {
  let d, configDir;
  afterEach(() => { jest.restoreAllMocks(); cleanup(configDir); });

  // Covers lines 749-750: availability === 'invalid' -> results.invalid
  test('model with invalid availability is added to invalid list', async () => {
    ({ d, configDir } = freshDiscovery());
    jest.spyOn(d, '_probeModel').mockResolvedValue({
      modelId: 'glm-5-turbo',
      availability: 'invalid',
      responseTimeMs: 10,
      rateLimitConcurrency: 0
    });

    const result = await d.probeModels({
      apiKey: 'test-key',
      probeKnown: false,
      probeCandidates: true,
      userCandidates: []
    });

    expect(result.results.invalid).toContain('glm-5-turbo');
  });

  // Covers lines 751-752: other availability -> results.unavailable
  test('model with error availability is added to unavailable list', async () => {
    ({ d, configDir } = freshDiscovery());
    jest.spyOn(d, '_probeModel').mockResolvedValue({
      modelId: 'glm-5-turbo',
      availability: 'error',
      responseTimeMs: 10,
      rateLimitConcurrency: 0
    });

    const result = await d.probeModels({
      apiKey: 'test-key',
      probeKnown: false,
      probeCandidates: true,
      userCandidates: []
    });

    expect(result.results.unavailable).toContain('glm-5-turbo');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. probeModels: known model availability change (lines 756-764)
// ═══════════════════════════════════════════════════════════════════════════
describe('probeModels: known model availability update', () => {
  let d, configDir;
  afterEach(() => { jest.restoreAllMocks(); cleanup(configDir); });

  // Covers lines 756-764: known model's availability changed -> updateModelMetadata called
  test('known model whose availability changed triggers metadata update', async () => {
    ({ d, configDir } = freshDiscovery());
    jest.spyOn(d, '_probeModel').mockImplementation(async (modelId) => ({
      modelId,
      availability: 'invalid', // glm-5 is 'coding_subscription' in static, now changed
      responseTimeMs: 10,
      rateLimitConcurrency: 0
    }));

    await d.probeModels({
      apiKey: 'test-key',
      probeKnown: true,
      probeCandidates: false,
      userCandidates: []
    });

    const overrides = d.getMetadataOverrides();
    expect(overrides['glm-5']).toEqual({
      availability: 'invalid',
      source: 'probed',
      lastRefreshedAt: expect.any(String)
    });
  });

  // Covers lines 758: known model availability same as static -> no metadata update
  test('known model with unchanged availability does not trigger metadata update', async () => {
    ({ d, configDir } = freshDiscovery());
    jest.spyOn(d, '_probeModel').mockImplementation(async (modelId) => {
      const known = KNOWN_GLM_MODELS.find(m => m.id === modelId);
      return {
        modelId,
        availability: known ? known.availability : 'invalid',
        responseTimeMs: 10,
        rateLimitConcurrency: 0
      };
    });

    await d.probeModels({
      apiKey: 'test-key',
      probeKnown: true,
      probeCandidates: false,
      userCandidates: []
    });

    // No overrides should be set since availability matches
    expect(Object.keys(d.getMetadataOverrides()).length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. probeModels: probe error handling (lines 766-768)
// ═══════════════════════════════════════════════════════════════════════════
describe('probeModels: probe errors', () => {
  let d, configDir;
  afterEach(() => { jest.restoreAllMocks(); cleanup(configDir); });

  // Covers lines 766-768: _probeModel throws -> added to errors list
  test('probe failure adds model to errors list', async () => {
    ({ d, configDir } = freshDiscovery());
    const warnCalls = [];
    d.logger = { warn: (msg) => warnCalls.push(msg) };

    jest.spyOn(d, '_probeModel').mockRejectedValue(new Error('connection refused'));

    const result = await d.probeModels({
      apiKey: 'test-key',
      probeKnown: false,
      probeCandidates: true,
      userCandidates: []
    });

    expect(result.results.errors.length).toBeGreaterThan(0);
    expect(result.results.errors[0].modelId).toBe(CANDIDATE_MODEL_PATTERNS[0]);
    expect(result.results.errors[0].error).toBe('connection refused');
    expect(warnCalls.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. probeModels: delay between probes (line 781)
// ═══════════════════════════════════════════════════════════════════════════
describe('probeModels: inter-probe delay', () => {
  let d, configDir;
  afterEach(() => { jest.restoreAllMocks(); cleanup(configDir); });

  // Covers line 781: delay between probes when not last item
  test('delays between probes but not after last probe', async () => {
    ({ d, configDir } = freshDiscovery({ probeDelayMs: 50 }));
    jest.spyOn(d, '_probeModel').mockResolvedValue({
      modelId: 'x',
      availability: 'invalid',
      responseTimeMs: 1,
      rateLimitConcurrency: 0
    });

    const start = Date.now();
    await d.probeModels({
      apiKey: 'test-key',
      probeKnown: false,
      probeCandidates: true,
      userCandidates: []
    });
    const elapsed = Date.now() - start;

    // With CANDIDATE_MODEL_PATTERNS.length probes and delayMs=50,
    // we expect at least (N-1)*50ms of delays
    const expectedMinDelay = (CANDIDATE_MODEL_PATTERNS.length - 1) * 50;
    expect(elapsed).toBeGreaterThanOrEqual(expectedMinDelay - 20); // 20ms tolerance
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. probeModels: save cache error (line 804)
// ═══════════════════════════════════════════════════════════════════════════
describe('probeModels: save cache failure', () => {
  let d, configDir;
  afterEach(() => { jest.restoreAllMocks(); cleanup(configDir); });

  // Covers line 804: _saveDiscoveryCache fails -> logged via logger.warn
  test('save cache failure is logged as warning', async () => {
    ({ d, configDir } = freshDiscovery());
    const warnCalls = [];
    d.logger = { warn: (msg) => warnCalls.push(msg) };

    jest.spyOn(d, '_probeModel').mockResolvedValue({
      modelId: 'glm-5-turbo',
      availability: 'invalid',
      responseTimeMs: 1,
      rateLimitConcurrency: 0
    });
    jest.spyOn(d, '_saveDiscoveryCache').mockRejectedValue(new Error('disk full'));

    const result = await d.probeModels({
      apiKey: 'test-key',
      probeKnown: false,
      probeCandidates: true,
      userCandidates: []
    });

    // Probe should still succeed despite save failure
    expect(result.success).toBe(true);
    expect(warnCalls.length).toBeGreaterThan(0);
    expect(warnCalls[0]).toContain('Failed to save discovery cache');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. probeModels: user candidates (lines 703-712)
// ═══════════════════════════════════════════════════════════════════════════
describe('probeModels: user candidates', () => {
  let d, configDir;
  afterEach(() => { jest.restoreAllMocks(); cleanup(configDir); });

  // Covers lines 703-712: one-off user candidates are probed and persisted
  test('one-off user candidates are probed and persisted', async () => {
    ({ d, configDir } = freshDiscovery());
    const probeSpy = jest.spyOn(d, '_probeModel').mockResolvedValue({
      modelId: 'my-custom-model',
      availability: 'invalid',
      responseTimeMs: 5,
      rateLimitConcurrency: 0
    });

    await d.probeModels({
      apiKey: 'test-key',
      probeKnown: false,
      probeCandidates: false,
      userCandidates: ['my-custom-model']
    });

    expect(probeSpy).toHaveBeenCalledWith('my-custom-model', 'test-key', 'api.z.ai', '/api/anthropic', 'https:');
    // Should be persisted in _userCandidates for future probes
    expect(d._userCandidates).toContain('my-custom-model');
  });

  // Covers lines 704-712: dedup with persisted candidates and normalization
  test('user candidates are deduplicated and normalized', async () => {
    ({ d, configDir } = freshDiscovery());
    // Pre-populate persisted candidates
    d._userCandidates = ['existing-model'];

    const probeSpy = jest.spyOn(d, '_probeModel').mockResolvedValue({
      modelId: 'x',
      availability: 'invalid',
      responseTimeMs: 1,
      rateLimitConcurrency: 0
    });

    await d.probeModels({
      apiKey: 'test-key',
      probeKnown: false,
      probeCandidates: false,
      userCandidates: ['existing-model', 'NEW-MODEL']
    });

    // 'existing-model' should only be probed once (dedup)
    const calls = probeSpy.mock.calls.map(c => c[0]);
    const existingCount = calls.filter(id => id === 'existing-model').length;
    expect(existingCount).toBe(1);
    // 'NEW-MODEL' should be normalized to 'new-model'
    expect(calls).toContain('new-model');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. probeModels: events (lines 718-723, 771-777, 807-815)
// ═══════════════════════════════════════════════════════════════════════════
describe('probeModels: events', () => {
  let d, configDir;
  afterEach(() => { jest.restoreAllMocks(); cleanup(configDir); });

  test('emits probe-status started, probing, and completed events', async () => {
    ({ d, configDir } = freshDiscovery());
    jest.spyOn(d, '_probeModel').mockResolvedValue({
      modelId: 'glm-5-turbo',
      availability: 'coding_subscription',
      responseTimeMs: 1,
      rateLimitConcurrency: 0
    });

    const events = [];
    d.on('probe-status', (evt) => events.push(evt));

    await d.probeModels({
      apiKey: 'test-key',
      probeKnown: false,
      probeCandidates: true,
      userCandidates: []
    });

    expect(events[0].status).toBe('started');
    expect(events[events.length - 1].status).toBe('completed');
    expect(events[events.length - 1].verified).toBe(0);
    expect(events[events.length - 1].discovered).toBeGreaterThan(0);
    // At least one 'probing' event
    const probingEvents = events.filter(e => e.status === 'probing');
    expect(probingEvents.length).toBeGreaterThan(0);
    expect(probingEvents[0].currentModel).toBe('glm-5-turbo');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. probeModels: cache invalidation after probe (line 800)
// ═══════════════════════════════════════════════════════════════════════════
describe('probeModels: cache invalidation', () => {
  let d, configDir;
  afterEach(() => { jest.restoreAllMocks(); cleanup(configDir); });

  test('probeModels invalidates cache so getModels picks up discoveries', async () => {
    ({ d, configDir } = freshDiscovery());
    await d.getModels();
    expect(d.getCacheStats().size).toBe(1);

    jest.spyOn(d, '_probeModel').mockResolvedValue({
      modelId: 'glm-5-turbo',
      availability: 'coding_subscription',
      responseTimeMs: 1,
      rateLimitConcurrency: 5
    });
    jest.spyOn(d, '_saveDiscoveryCache').mockResolvedValue();

    await d.probeModels({
      apiKey: 'test-key',
      probeKnown: false,
      probeCandidates: true,
      userCandidates: []
    });

    // Cache should be invalidated
    expect(d.getCacheStats().size).toBe(0);
    // getModels should now include the discovered model
    const models = await d.getModels();
    expect(models.find(m => m.id === 'glm-5-turbo')).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. probeModels: getProbeState after probe (lines 788-797)
// ═══════════════════════════════════════════════════════════════════════════
describe('probeModels: probe state after completion', () => {
  let d, configDir;
  afterEach(() => { jest.restoreAllMocks(); cleanup(configDir); });

  test('updates probeState with lastResult after successful probe', async () => {
    ({ d, configDir } = freshDiscovery());
    jest.spyOn(d, '_probeModel').mockImplementation(async (modelId) => ({
      modelId,
      availability: 'coding_subscription',
      responseTimeMs: 5,
      rateLimitConcurrency: 3
    }));
    jest.spyOn(d, '_saveDiscoveryCache').mockResolvedValue();

    await d.probeModels({
      apiKey: 'test-key',
      probeKnown: true,
      probeCandidates: false,
      userCandidates: []
    });

    const state = d.getProbeState();
    expect(state.inProgress).toBe(false);
    expect(state.lastProbeAt).not.toBeNull();
    expect(state.lastResult.verified.length).toBeGreaterThan(0);
    expect(typeof state.lastResult.duration).toBe('number');
    expect(typeof state.lastResult.probeCount).toBe('number');
    expect(state.lastResult.knownModelStatus).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 14. _probeModel: HTTP response parsing (lines 866-913)
// ═══════════════════════════════════════════════════════════════════════════
describe('_probeModel HTTP response parsing', () => {
  let d, configDir;
  let httpsSpy, httpSpy;

  afterEach(() => {
    jest.restoreAllMocks();
    cleanup(configDir);
  });

  /**
   * Helper: create a mock HTTP request that simulates server response.
   * @param {Object} response - { statusCode, headers, body }
   * @param {Object} [options] - { delay, simulateTimeout, simulateError }
   */
  function mockTransport(response, options = {}) {
    return jest.fn((reqOptions, callback) => {
      const mockReq = {
        write: jest.fn(),
        end: jest.fn(),
        destroy: jest.fn(),
        setTimeout: jest.fn(),
        on: jest.fn((event, handler) => {
          if (event === 'timeout' && options.simulateTimeout) {
            // Fire timeout after a micro-delay
            setImmediate(() => handler());
          }
          if (event === 'error' && options.simulateError) {
            setImmediate(() => handler(new Error('ECONNREFUSED')));
          }
        })
      };

      if (!options.simulateTimeout && !options.simulateError) {
        setImmediate(() => {
          callback({
            statusCode: response.statusCode,
            headers: response.headers || {},
            on: jest.fn((event, handler) => {
              if (event === 'data' && response.body) {
                setImmediate(() => handler(Buffer.from(response.body)));
              }
              if (event === 'end') {
                setImmediate(() => handler());
              }
            })
          });
        });
      }

      return mockReq;
    });
  }

  // Covers line 848: targetProtocol='https:' -> uses https module
  test('uses https transport for https protocol', async () => {
    ({ d, configDir } = freshDiscovery());
    httpsSpy = mockTransport({ statusCode: 200, body: '{"id":"msg_1"}' });
    jest.spyOn(https, 'request').mockImplementation(httpsSpy);

    const result = await d._probeModel('glm-5', 'key', 'api.z.ai', '/api/anthropic', 'https:');
    expect(result.modelId).toBe('glm-5');
    expect(result.availability).toBe('coding_subscription');
    expect(httpsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: 'api.z.ai', port: 443 }),
      expect.any(Function)
    );
  });

  // Covers line 849: targetProtocol='http:' -> uses http module, port 80
  test('uses http transport for http protocol with port 80', async () => {
    ({ d, configDir } = freshDiscovery());
    httpSpy = mockTransport({ statusCode: 200, body: '{"id":"msg_1"}' });
    jest.spyOn(http, 'request').mockImplementation(httpSpy);

    const result = await d._probeModel('glm-5', 'key', 'localhost', '/v1', 'http:');
    expect(result.modelId).toBe('glm-5');
    expect(result.availability).toBe('coding_subscription');
    expect(httpSpy).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: 'localhost', port: 80 }),
      expect.any(Function)
    );
  });

  // Covers lines 881-884: Anthropic error format with 1211 -> invalid
  test('Anthropic error with error code 1211 returns invalid', async () => {
    ({ d, configDir } = freshDiscovery());
    httpsSpy = mockTransport({
      statusCode: 400,
      headers: {},
      body: JSON.stringify({ error: { type: 'invalid_request_error', message: 'Unknown Model: glm-5-turbo (code 1211)' } })
    });
    jest.spyOn(https, 'request').mockImplementation(httpsSpy);

    const result = await d._probeModel('glm-5-turbo', 'key', 'api.z.ai', '/api/anthropic', 'https:');
    expect(result.availability).toBe('invalid');
    expect(result.modelId).toBe('glm-5-turbo');
  });

  // Covers lines 886-887: Anthropic error with 1113 -> api_only
  test('Anthropic error with error code 1113 returns api_only', async () => {
    ({ d, configDir } = freshDiscovery());
    httpsSpy = mockTransport({
      statusCode: 403,
      headers: {},
      body: JSON.stringify({ error: { type: 'permission_error', message: 'Resource package required (1113)' } })
    });
    jest.spyOn(https, 'request').mockImplementation(httpsSpy);

    const result = await d._probeModel('glm-4.5-x', 'key', 'api.z.ai', '/api/anthropic', 'https:');
    expect(result.availability).toBe('api_only');
  });

  // Covers line 883: "Unknown Model" in message -> invalid
  test('Anthropic error with Unknown Model message returns invalid', async () => {
    ({ d, configDir } = freshDiscovery());
    httpsSpy = mockTransport({
      statusCode: 400,
      headers: {},
      body: JSON.stringify({ error: { type: 'not_found_error', message: 'Unknown Model' } })
    });
    jest.spyOn(https, 'request').mockImplementation(httpsSpy);

    const result = await d._probeModel('glm-bad', 'key', 'api.z.ai', '/api/anthropic', 'https:');
    expect(result.availability).toBe('invalid');
  });

  // Covers line 890: Other Anthropic error -> availability 'error'
  test('Other Anthropic error returns availability error', async () => {
    ({ d, configDir } = freshDiscovery());
    httpsSpy = mockTransport({
      statusCode: 429,
      headers: {},
      body: JSON.stringify({ error: { type: 'rate_limit_error', message: 'Rate limited' } })
    });
    jest.spyOn(https, 'request').mockImplementation(httpsSpy);

    const result = await d._probeModel('glm-5', 'key', 'api.z.ai', '/api/anthropic', 'https:');
    expect(result.availability).toBe('error');
    expect(result.error).toBe('Rate limited');
  });

  // Covers lines 894-895: z.ai native code 1211 -> invalid
  test('z.ai native response with code 1211 returns invalid', async () => {
    ({ d, configDir } = freshDiscovery());
    httpsSpy = mockTransport({
      statusCode: 200,
      headers: {},
      body: JSON.stringify({ code: 1211, msg: 'model not found' })
    });
    jest.spyOn(https, 'request').mockImplementation(httpsSpy);

    const result = await d._probeModel('glm-bad', 'key', 'api.z.ai', '/api/anthropic', 'https:');
    expect(result.availability).toBe('invalid');
  });

  // Covers lines 897-898: z.ai native code 1113 -> api_only
  test('z.ai native response with code 1113 returns api_only', async () => {
    ({ d, configDir } = freshDiscovery());
    httpsSpy = mockTransport({
      statusCode: 200,
      headers: {},
      body: JSON.stringify({ code: 1113, msg: 'resource required' })
    });
    jest.spyOn(https, 'request').mockImplementation(httpsSpy);

    const result = await d._probeModel('glm-4.5-x', 'key', 'api.z.ai', '/api/anthropic', 'https:');
    expect(result.availability).toBe('api_only');
  });

  // Covers lines 900-901: z.ai native other code (not 200 or 0) -> error
  test('z.ai native response with other error code returns error', async () => {
    ({ d, configDir } = freshDiscovery());
    httpsSpy = mockTransport({
      statusCode: 200,
      headers: {},
      body: JSON.stringify({ code: 500, msg: 'server error' })
    });
    jest.spyOn(https, 'request').mockImplementation(httpsSpy);

    const result = await d._probeModel('glm-5', 'key', 'api.z.ai', '/api/anthropic', 'https:');
    expect(result.availability).toBe('error');
    expect(result.error).toBe('server error');
  });

  // Covers lines 900: z.ai native code=0 treated as success
  test('z.ai native response with code 0 is treated as success', async () => {
    ({ d, configDir } = freshDiscovery());
    httpsSpy = mockTransport({
      statusCode: 200,
      headers: {},
      body: JSON.stringify({ code: 0, msg: 'ok' })
    });
    jest.spyOn(https, 'request').mockImplementation(httpsSpy);

    const result = await d._probeModel('glm-5', 'key', 'api.z.ai', '/api/anthropic', 'https:');
    expect(result.availability).toBe('coding_subscription');
  });

  // Covers lines 900: z.ai native code=200 treated as success
  test('z.ai native response with code 200 is treated as success', async () => {
    ({ d, configDir } = freshDiscovery());
    httpsSpy = mockTransport({
      statusCode: 200,
      headers: {},
      body: JSON.stringify({ code: 200, msg: 'ok' })
    });
    jest.spyOn(https, 'request').mockImplementation(httpsSpy);

    const result = await d._probeModel('glm-5', 'key', 'api.z.ai', '/api/anthropic', 'https:');
    expect(result.availability).toBe('coding_subscription');
  });

  // Covers line 905: Successful response (no error field, no code) -> coding_subscription
  test('successful JSON response returns coding_subscription', async () => {
    ({ d, configDir } = freshDiscovery());
    httpsSpy = mockTransport({
      statusCode: 200,
      headers: { 'x-ratelimit-limit': '10' },
      body: JSON.stringify({ id: 'msg_1', type: 'message', content: [] })
    });
    jest.spyOn(https, 'request').mockImplementation(httpsSpy);

    const result = await d._probeModel('glm-5', 'key', 'api.z.ai', '/api/anthropic', 'https:');
    expect(result.availability).toBe('coding_subscription');
    expect(result.rateLimitConcurrency).toBe(10);
  });

  // Covers lines 872-873: rate limit header parsing from x-ratelimit-limit-requests
  test('parses x-ratelimit-limit-requests header for rate limit concurrency', async () => {
    ({ d, configDir } = freshDiscovery());
    httpsSpy = mockTransport({
      statusCode: 200,
      headers: { 'x-ratelimit-limit-requests': '5' },
      body: JSON.stringify({ id: 'msg_1' })
    });
    jest.spyOn(https, 'request').mockImplementation(httpsSpy);

    const result = await d._probeModel('glm-5', 'key', 'api.z.ai', '/api/anthropic', 'https:');
    expect(result.rateLimitConcurrency).toBe(5);
  });

  // Covers lines 908-909: Non-JSON response with 200 -> coding_subscription
  test('non-JSON response with 200 status returns coding_subscription', async () => {
    ({ d, configDir } = freshDiscovery());
    httpsSpy = mockTransport({
      statusCode: 200,
      headers: {},
      body: 'OK'
    });
    jest.spyOn(https, 'request').mockImplementation(httpsSpy);

    const result = await d._probeModel('glm-5', 'key', 'api.z.ai', '/api/anthropic', 'https:');
    expect(result.availability).toBe('coding_subscription');
  });

  // Covers lines 910-911: Non-JSON response with 404 -> invalid
  test('non-JSON response with 404 status returns invalid', async () => {
    ({ d, configDir } = freshDiscovery());
    httpsSpy = mockTransport({
      statusCode: 404,
      headers: {},
      body: 'Not Found'
    });
    jest.spyOn(https, 'request').mockImplementation(httpsSpy);

    const result = await d._probeModel('glm-bad', 'key', 'api.z.ai', '/api/anthropic', 'https:');
    expect(result.availability).toBe('invalid');
  });

  // Covers lines 912-913: Non-JSON response with other status -> error
  test('non-JSON response with 500 status returns error', async () => {
    ({ d, configDir } = freshDiscovery());
    httpsSpy = mockTransport({
      statusCode: 500,
      headers: {},
      body: 'Internal Server Error'
    });
    jest.spyOn(https, 'request').mockImplementation(httpsSpy);

    const result = await d._probeModel('glm-5', 'key', 'api.z.ai', '/api/anthropic', 'https:');
    expect(result.availability).toBe('error');
    expect(result.error).toBe('HTTP 500');
  });

  // Covers lines 920-921: timeout handler
  test('request timeout rejects with timeout error', async () => {
    ({ d, configDir } = freshDiscovery({ probeTimeoutMs: 100 }));
    httpsSpy = mockTransport({}, { simulateTimeout: true });
    jest.spyOn(https, 'request').mockImplementation(httpsSpy);

    await expect(d._probeModel('glm-5', 'key', 'api.z.ai', '/api/anthropic', 'https:'))
      .rejects.toThrow('Probe timeout for glm-5');
  });

  // Covers lines 924-925: network error handler
  test('request error rejects with network error', async () => {
    ({ d, configDir } = freshDiscovery());
    httpsSpy = mockTransport({}, { simulateError: true });
    jest.spyOn(https, 'request').mockImplementation(httpsSpy);

    await expect(d._probeModel('glm-5', 'key', 'api.z.ai', '/api/anthropic', 'https:'))
      .rejects.toThrow('Probe network error for glm-5');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 15. addUserCandidate: persistence and edge cases (lines 639-646)
// ═══════════════════════════════════════════════════════════════════════════
describe('addUserCandidate edge cases', () => {
  let d, configDir;
  afterEach(() => { jest.restoreAllMocks(); cleanup(configDir); });

  // Covers lines 640: non-string input rejected
  test('rejects non-string modelId', () => {
    ({ d, configDir } = freshDiscovery());
    d.addUserCandidate(42);
    d.addUserCandidate(undefined);
    d.addUserCandidate({});
    expect(d._userCandidates).toEqual([]);
  });

  // Covers lines 641: whitespace trimmed, lowercased
  test('trims and lowercases candidate IDs', () => {
    ({ d, configDir } = freshDiscovery());
    jest.spyOn(d, '_saveDiscoveryCache').mockResolvedValue();
    d.addUserCandidate('  GLM-5-Turbo  ');
    expect(d._userCandidates).toEqual(['glm-5-turbo']);
  });

  // Covers lines 642: deduplication
  test('does not add duplicate candidates', () => {
    ({ d, configDir } = freshDiscovery());
    jest.spyOn(d, '_saveDiscoveryCache').mockResolvedValue();
    d.addUserCandidate('glm-5-turbo');
    d.addUserCandidate('glm-5-turbo');
    expect(d._userCandidates).toEqual(['glm-5-turbo']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 16. getModels: expired cache path (line 481-483 vs 487)
// ═══════════════════════════════════════════════════════════════════════════
describe('getModels: expired cache triggers refresh', () => {
  let d, configDir;
  afterEach(() => { cleanup(configDir); });

  // Covers lines 481-483: cache exists but expired -> rebuilds
  test('expired cache triggers rebuild', async () => {
    ({ d, configDir } = freshDiscovery({ cacheTTL: 20 }));
    const first = await d.getModels();
    expect(d.getCacheStats().size).toBe(1);

    // Wait for TTL to expire
    await new Promise(r => setTimeout(r, 30));
    const second = await d.getModels();

    // Should rebuild (different reference) but same length
    expect(first).not.toBe(second);
    expect(first.length).toBe(second.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 17. probeModels: knownModelStatus in lastResult (lines 734-737)
// ═══════════════════════════════════════════════════════════════════════════
describe('probeModels: knownModelStatus tracking', () => {
  let d, configDir;
  afterEach(() => { jest.restoreAllMocks(); cleanup(configDir); });

  test('knownModelStatus records availability and timestamp for verified models', async () => {
    ({ d, configDir } = freshDiscovery());
    jest.spyOn(d, '_probeModel').mockImplementation(async (modelId) => ({
      modelId,
      availability: 'coding_subscription',
      responseTimeMs: 5,
      rateLimitConcurrency: 0
    }));
    jest.spyOn(d, '_saveDiscoveryCache').mockResolvedValue();

    await d.probeModels({
      apiKey: 'test-key',
      probeKnown: true,
      probeCandidates: false,
      userCandidates: []
    });

    const state = d.getProbeState();
    const status = state.lastResult.knownModelStatus;
    expect(status['glm-5']).toEqual({
      availability: 'coding_subscription',
      lastVerifiedAt: expect.any(String)
    });
    // Verify the timestamp is a valid ISO date
    expect(new Date(status['glm-5'].lastVerifiedAt).getTime()).not.toBeNaN();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 18. probeModels: default options (lines 667-675)
// ═══════════════════════════════════════════════════════════════════════════
describe('probeModels: default options', () => {
  let d, configDir;
  afterEach(() => { jest.restoreAllMocks(); cleanup(configDir); });

  test('defaults targetHost, targetBasePath, targetProtocol correctly', async () => {
    ({ d, configDir } = freshDiscovery());
    const probeSpy = jest.spyOn(d, '_probeModel').mockResolvedValue({
      modelId: 'x',
      availability: 'invalid',
      responseTimeMs: 1,
      rateLimitConcurrency: 0
    });

    await d.probeModels({ apiKey: 'test-key' });

    // _probeModel should be called with default host/path/protocol
    const call = probeSpy.mock.calls[0];
    expect(call[2]).toBe('api.z.ai');       // targetHost
    expect(call[3]).toBe('/api/anthropic');  // targetBasePath
    expect(call[4]).toBe('https:');          // targetProtocol
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 19. _probeModel: request body and headers (lines 841-862)
// ═══════════════════════════════════════════════════════════════════════════
describe('_probeModel: request construction', () => {
  let d, configDir;
  afterEach(() => { jest.restoreAllMocks(); cleanup(configDir); });

  test('sends correct request body with model, messages, and max_tokens', async () => {
    ({ d, configDir } = freshDiscovery());
    const capturedOptions = [];
    jest.spyOn(https, 'request').mockImplementation((opts, cb) => {
      capturedOptions.push(opts);
      const mockReq = {
        write: jest.fn(),
        end: jest.fn(),
        destroy: jest.fn(),
        setTimeout: jest.fn(),
        on: jest.fn()
      };
      setImmediate(() => cb({
        statusCode: 200,
        headers: {},
        on: jest.fn((ev, h) => { if (ev === 'end') setImmediate(h); })
      }));
      return mockReq;
    });

    await d._probeModel('glm-test', 'my-api-key', 'api.z.ai', '/v2', 'https:');

    expect(capturedOptions[0].method).toBe('POST');
    expect(capturedOptions[0].path).toBe('/v2/v1/messages');
    expect(capturedOptions[0].headers['x-api-key']).toBe('my-api-key');
    expect(capturedOptions[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(capturedOptions[0].timeout).toBe(5000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 20. probeModels: modelCount after discovery (line 786)
// ═══════════════════════════════════════════════════════════════════════════
describe('probeModels: model count tracking', () => {
  let d, configDir;
  afterEach(() => { jest.restoreAllMocks(); cleanup(configDir); });

  test('modelCount after reflects new discoveries', async () => {
    ({ d, configDir } = freshDiscovery());
    jest.spyOn(d, '_probeModel').mockImplementation(async (modelId) => ({
      modelId,
      availability: 'coding_subscription',
      responseTimeMs: 1,
      rateLimitConcurrency: 0
    }));
    jest.spyOn(d, '_saveDiscoveryCache').mockResolvedValue();

    const result = await d.probeModels({
      apiKey: 'test-key',
      probeKnown: false,
      probeCandidates: true,
      userCandidates: []
    });

    expect(result.modelCount.before).toBe(KNOWN_GLM_MODELS.length);
    expect(result.modelCount.after).toBeGreaterThan(KNOWN_GLM_MODELS.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 21. exportForFrontend: fallback values for missing properties (lines 543, 550-553)
// ═══════════════════════════════════════════════════════════════════════════
describe('exportForFrontend: fallback values', () => {
  let d, configDir;
  afterEach(() => { jest.restoreAllMocks(); cleanup(configDir); });

  // Covers lines 543, 550-553: model without displayName, maxConcurrency, availability, type, source
  test('uses fallback values when model properties are missing', async () => {
    ({ d, configDir } = freshDiscovery());
    // Create a minimal model with only required fields
    d._discoveredModels.set('minimal-model', {
      id: 'minimal-model',
      tier: 'LIGHT'
      // Missing: displayName, maxConcurrency, availability, type, source, lastRefreshedAt
    });

    const exported = await d.exportForFrontend();
    const minimal = exported.models.find(m => m.id === 'minimal-model');

    // Line 543: displayName || m.id
    expect(minimal.name).toBe('minimal-model');
    // Line 550: maxConcurrency || 5
    expect(minimal.maxConcurrency).toBe(5);
    // Line 551: availability || 'coding_subscription'
    expect(minimal.availability).toBe('coding_subscription');
    // Line 552: type || 'chat'
    expect(minimal.type).toBe('chat');
    // Line 553: source || 'static'
    expect(minimal.source).toBe('static');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 22. probeModels: options default parameter (line 662)
// ═══════════════════════════════════════════════════════════════════════════
describe('probeModels: options default parameter', () => {
  let d, configDir;
  afterEach(() => { jest.restoreAllMocks(); cleanup(configDir); });

  // Covers line 662: options = {} default parameter used when called with no args
  test('handles being called with no options argument', async () => {
    ({ d, configDir } = freshDiscovery());
    // When called with no options, options = {} kicks in, then apiKey check fails
    const result = await d.probeModels();
    expect(result.error).toBe('no_api_key');
    expect(result.message).toBe('An API key is required for probing');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 23. probeModels: user candidate deduplication and persistence (lines 704-711)
// ═══════════════════════════════════════════════════════════════════════════
describe('probeModels: user candidate handling', () => {
  let d, configDir;
  afterEach(() => { jest.restoreAllMocks(); cleanup(configDir); });

  // Covers lines 704-706: user candidate already in probeList is skipped
  test('user candidate already in probeList is not duplicated', async () => {
    ({ d, configDir } = freshDiscovery());
    const probeSpy = jest.spyOn(d, '_probeModel').mockResolvedValue({
      modelId: 'x',
      availability: 'invalid',
      responseTimeMs: 1,
      rateLimitConcurrency: 0
    });

    // glm-5-turbo is in CANDIDATE_MODEL_PATTERNS, so will be in probeList
    // Passing same as userCandidate should not add it again
    await d.probeModels({
      apiKey: 'test-key',
      probeKnown: false,
      probeCandidates: true,
      userCandidates: ['glm-5-turbo']
    });

    // Count how many times glm-5-turbo was probed (should be exactly 1)
    const turboCalls = probeSpy.mock.calls.filter(c => c[0] === 'glm-5-turbo');
    expect(turboCalls.length).toBe(1);
  });

  // Covers lines 709-711: new user candidate is persisted to _userCandidates
  test('new user candidate is persisted for future probes', async () => {
    ({ d, configDir } = freshDiscovery());
    jest.spyOn(d, '_probeModel').mockResolvedValue({
      modelId: 'x',
      availability: 'invalid',
      responseTimeMs: 1,
      rateLimitConcurrency: 0
    });
    jest.spyOn(d, '_saveDiscoveryCache').mockResolvedValue();

    await d.probeModels({
      apiKey: 'test-key',
      probeKnown: false,
      probeCandidates: false,
      userCandidates: ['brand-new-model']
    });

    expect(d._userCandidates).toContain('brand-new-model');
  });

  // Covers line 706: empty normalized string is skipped
  test('empty string after normalization is skipped', async () => {
    ({ d, configDir } = freshDiscovery());
    const probeSpy = jest.spyOn(d, '_probeModel').mockResolvedValue({
      modelId: 'x',
      availability: 'invalid',
      responseTimeMs: 1,
      rateLimitConcurrency: 0
    });

    await d.probeModels({
      apiKey: 'test-key',
      probeKnown: false,
      probeCandidates: false,
      userCandidates: ['   '] // Whitespace-only, normalizes to empty
    });

    // Should not probe anything
    expect(probeSpy).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 24. _probeModel: json.code error branch (line 900-901)
// ═══════════════════════════════════════════════════════════════════════════
describe('_probeModel: json.code error handling', () => {
  let d, configDir, httpsSpy;
  afterEach(() => { jest.restoreAllMocks(); cleanup(configDir); });

  function mockTransport(responseBody, opts = {}) {
    return (reqOpts, callback) => {
      const mockReq = {
        write: jest.fn(),
        end: jest.fn(),
        destroy: jest.fn(),
        on: jest.fn()
      };
      setImmediate(() => {
        const mockRes = {
          statusCode: opts.statusCode || 200,
          headers: opts.headers || {},
          on: (event, handler) => {
            if (event === 'data') setImmediate(() => handler(Buffer.from(responseBody)));
            if (event === 'end') setImmediate(handler);
          }
        };
        callback(mockRes);
      });
      return mockReq;
    };
  }

  // Covers lines 900-901: json.code is non-200 and non-0
  test('json.code 500 returns error with message from json.msg', async () => {
    ({ d, configDir } = freshDiscovery());
    const response = JSON.stringify({ code: 500, msg: 'Internal server error' });
    httpsSpy = mockTransport(response);
    jest.spyOn(https, 'request').mockImplementation(httpsSpy);

    const result = await d._probeModel('glm-5', 'key', 'api.z.ai', '/api/anthropic', 'https:');
    expect(result.availability).toBe('error');
    expect(result.error).toBe('Internal server error');
  });

  // Covers line 901: json.code without json.msg uses code in message
  test('json.code without msg uses code in error message', async () => {
    ({ d, configDir } = freshDiscovery());
    const response = JSON.stringify({ code: 503 }); // No msg field
    httpsSpy = mockTransport(response);
    jest.spyOn(https, 'request').mockImplementation(httpsSpy);

    const result = await d._probeModel('glm-5', 'key', 'api.z.ai', '/api/anthropic', 'https:');
    expect(result.availability).toBe('error');
    expect(result.error).toBe('code 503');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 25. _loadDiscoveryCache: loading discoveredModels and userCandidates (lines 948-956)
// ═══════════════════════════════════════════════════════════════════════════
describe('_loadDiscoveryCache: cache file loading', () => {
  let configDir;

  afterEach(() => { cleanup(configDir); });

  // Covers lines 948-951: discoveredModels object iteration
  test('loads discoveredModels from cache file', () => {
    configDir = tmpDir();
    const cachePath = path.join(configDir, 'model-discovery-cache.json');
    const cacheData = {
      version: 1,
      discoveredModels: {
        'discovered-model-a': { id: 'discovered-model-a', tier: 'LIGHT', type: 'chat' },
        'discovered-model-b': { id: 'discovered-model-b', tier: 'HEAVY', type: 'vision' }
      },
      userCandidates: []
    };
    fs.writeFileSync(cachePath, JSON.stringify(cacheData));

    const d = new ModelDiscovery({ configDir });
    expect(d._discoveredModels.has('discovered-model-a')).toBe(true);
    expect(d._discoveredModels.has('discovered-model-b')).toBe(true);
    expect(d._discoveredModels.get('discovered-model-a').tier).toBe('LIGHT');
    expect(d._discoveredModels.get('discovered-model-b').type).toBe('vision');
  });

  // Covers lines 954-956: userCandidates array loading
  test('loads userCandidates from cache file', () => {
    configDir = tmpDir();
    const cachePath = path.join(configDir, 'model-discovery-cache.json');
    const cacheData = {
      version: 1,
      discoveredModels: {},
      userCandidates: ['user-candidate-1', 'user-candidate-2']
    };
    fs.writeFileSync(cachePath, JSON.stringify(cacheData));

    const d = new ModelDiscovery({ configDir });
    expect(d._userCandidates).toEqual(['user-candidate-1', 'user-candidate-2']);
  });

  // Covers line 945: version check rejects wrong version
  test('ignores cache file with wrong version', () => {
    configDir = tmpDir();
    const cachePath = path.join(configDir, 'model-discovery-cache.json');
    const cacheData = {
      version: 2, // Wrong version
      discoveredModels: { 'model-x': { id: 'model-x' } },
      userCandidates: ['should-not-load']
    };
    fs.writeFileSync(cachePath, JSON.stringify(cacheData));

    const d = new ModelDiscovery({ configDir });
    expect(d._discoveredModels.has('model-x')).toBe(false);
    expect(d._userCandidates).toEqual([]);
  });

  // Covers line 948 else branch: cache without discoveredModels field
  test('handles cache file without discoveredModels field', () => {
    configDir = tmpDir();
    const cachePath = path.join(configDir, 'model-discovery-cache.json');
    const cacheData = {
      version: 1,
      // discoveredModels intentionally missing
      userCandidates: ['test-candidate']
    };
    fs.writeFileSync(cachePath, JSON.stringify(cacheData));

    const d = new ModelDiscovery({ configDir });
    expect(d._discoveredModels.size).toBe(0);
    expect(d._userCandidates).toEqual(['test-candidate']);
  });

  // Covers line 948: discoveredModels is not an object (is null)
  test('handles cache with null discoveredModels', () => {
    configDir = tmpDir();
    const cachePath = path.join(configDir, 'model-discovery-cache.json');
    const cacheData = {
      version: 1,
      discoveredModels: null,
      userCandidates: []
    };
    fs.writeFileSync(cachePath, JSON.stringify(cacheData));

    const d = new ModelDiscovery({ configDir });
    expect(d._discoveredModels.size).toBe(0);
  });

  // Covers line 955 else branch: cache without userCandidates field
  test('handles cache file without userCandidates field', () => {
    configDir = tmpDir();
    const cachePath = path.join(configDir, 'model-discovery-cache.json');
    const cacheData = {
      version: 1,
      discoveredModels: { 'model-y': { id: 'model-y' } }
      // userCandidates intentionally missing
    };
    fs.writeFileSync(cachePath, JSON.stringify(cacheData));

    const d = new ModelDiscovery({ configDir });
    expect(d._discoveredModels.has('model-y')).toBe(true);
    expect(d._userCandidates).toEqual([]); // Default empty array
  });

  // Covers line 955: userCandidates is not an array
  test('handles cache with non-array userCandidates', () => {
    configDir = tmpDir();
    const cachePath = path.join(configDir, 'model-discovery-cache.json');
    const cacheData = {
      version: 1,
      discoveredModels: {},
      userCandidates: 'not-an-array'
    };
    fs.writeFileSync(cachePath, JSON.stringify(cacheData));

    const d = new ModelDiscovery({ configDir });
    expect(d._userCandidates).toEqual([]); // Should remain default empty array
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// userCandidates persistence via probeModels (line 710)
// ═══════════════════════════════════════════════════════════════════════════
describe('probeModels userCandidates persistence', () => {
  let d, configDir;
  afterEach(() => { jest.restoreAllMocks(); cleanup(configDir); });

  // Covers line 710: new user candidate persisted to _userCandidates
  test('userCandidates passed to probeModels are persisted', async () => {
    ({ d, configDir } = freshDiscovery());
    expect(d._userCandidates).toEqual([]); // Initially empty

    jest.spyOn(d, '_probeModel').mockResolvedValue({
      modelId: 'custom-user-model',
      availability: 'coding_subscription',
      responseTimeMs: 10,
      rateLimitConcurrency: 5
    });

    const result = await d.probeModels({
      apiKey: 'test-key',
      probeKnown: false,
      probeCandidates: false,
      userCandidates: ['custom-user-model']
    });

    // The candidate should be persisted for future probes
    expect(d._userCandidates).toContain('custom-user-model');
    expect(result.results.discovered).toContain('custom-user-model');
  });
});
