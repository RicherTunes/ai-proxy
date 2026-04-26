'use strict';
/**
 * Coverage test for lib/model-discovery.js line 697
 * Tests the branch where a candidate pattern IS in knownIds and is skipped.
 *
 * Uses Set prototype mocking to simulate the overlap condition.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const { ModelDiscovery, CANDIDATE_MODEL_PATTERNS } = require('../lib/model-discovery');

// ─── helpers ───────────────────────────────────────────────────────────────
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'md-697-'));
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════
// Line 697: candidate pattern already in knownIds is skipped
// ═══════════════════════════════════════════════════════════════════════════
describe('probeModels line 697: overlapping candidate skipped', () => {
  let configDir;

  afterEach(() => {
    jest.restoreAllMocks();
    cleanup(configDir);
  });

  // Covers line 697: when knownIds.has(id) is true, candidate is NOT probed
  // We simulate this by mocking Set.prototype.has for the specific candidate
  test('candidate pattern that is already a known model is skipped', async () => {
    configDir = tmpDir();
    const d = new ModelDiscovery({
      cacheTTL: 60000,
      configDir,
      persistFile: 'cov-cache.json',
      configPath: path.join(configDir, 'nonexistent.json'),
      probeDelayMs: 0,
      probeTimeoutMs: 5000
    });

    const probeSpy = jest.spyOn(d, '_probeModel').mockResolvedValue({
      modelId: 'x',
      availability: 'invalid',
      responseTimeMs: 5,
      rateLimitConcurrency: 0
    });

    // Mock Set.prototype.has to return true for the first candidate pattern
    // This simulates the condition where a candidate IS in knownIds (line 697 else branch)
    const firstCandidate = CANDIDATE_MODEL_PATTERNS[0];
    const originalHas = Set.prototype.has;
    const hasSpy = jest.spyOn(Set.prototype, 'has').mockImplementation(function(id) {
      // Identify the knownIds Set: it contains 'glm-5' (from KNOWN_GLM_MODELS)
      // When it checks the first candidate, return true to simulate overlap
      if (id === firstCandidate && originalHas.call(this, 'glm-5')) {
        return true;
      }
      return originalHas.call(this, id);
    });

    await d.probeModels({
      apiKey: 'test-key',
      probeKnown: false,
      probeCandidates: true,
      userCandidates: []
    });

    hasSpy.mockRestore();

    const probedIds = probeSpy.mock.calls.map(c => c[0]);

    // First candidate should be skipped because we mocked knownIds.has() to return true
    expect(probedIds).not.toContain(firstCandidate);

    // Other candidates should still be probed
    expect(probedIds.length).toBe(CANDIDATE_MODEL_PATTERNS.length - 1);
  });
});
