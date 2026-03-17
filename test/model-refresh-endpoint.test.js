/**
 * Model Refresh Endpoint Tests
 * Tests the _handleModelsRefresh method directly (no HTTP server needed).
 */

const { ModelDiscovery, CANDIDATE_MODEL_PATTERNS } = require('../lib/model-discovery');
const os = require('os');
const path = require('path');
const fs = require('fs');

describe('_handleModelsRefresh logic', () => {
    let discovery;
    const configDir = os.tmpdir();
    const persistFile = 'test-refresh-' + Date.now() + '.json';

    beforeEach(() => {
        discovery = new ModelDiscovery({
            cacheTTL: 100,
            configPath: '/tmp/nonexistent.json',
            configDir,
            persistFile
        });
    });

    afterEach(() => {
        try { fs.unlinkSync(path.join(configDir, persistFile)); } catch {}
    });

    test('probeModels with no candidates returns empty results', async () => {
        const result = await discovery.probeModels({
            apiKey: 'test-key',
            targetHost: '127.0.0.1',
            targetBasePath: '/api/anthropic',
            targetProtocol: 'http:',
            probeKnown: false,
            probeCandidates: false,
            userCandidates: []
        });

        expect(result.success).toBe(true);
        expect(result.results.verified).toEqual([]);
        expect(result.results.discovered).toEqual([]);
        expect(result.results.invalid).toEqual([]);
        expect(result.results.errors).toEqual([]);
        expect(result.duration).toBeDefined();
        expect(result.modelCount.before).toBeGreaterThan(0);
    });

    test('getProbeState reflects lastProbeAt after probe', async () => {
        await discovery.probeModels({
            apiKey: 'test-key',
            targetHost: '127.0.0.1',
            targetBasePath: '/api/anthropic',
            targetProtocol: 'http:',
            probeKnown: false,
            probeCandidates: false
        });

        const state = discovery.getProbeState();
        expect(state.lastProbeAt).toBeTruthy();
        expect(state.inProgress).toBe(false);
    });

    test('concurrent probe guard returns error', async () => {
        discovery._probeState.inProgress = true;
        const result = await discovery.probeModels({
            apiKey: 'test-key',
            targetHost: '127.0.0.1',
            targetBasePath: '/api/anthropic'
        });
        expect(result.error).toBe('probe_already_running');
    });

    test('probeModels without apiKey returns error', async () => {
        const result = await discovery.probeModels({
            targetHost: '127.0.0.1',
            targetBasePath: '/api/anthropic'
        });
        expect(result.error).toBe('no_api_key');
    });

    test('userCandidates from request are persisted', async () => {
        await discovery.probeModels({
            apiKey: 'test-key',
            targetHost: '127.0.0.1',
            targetBasePath: '/api/anthropic',
            targetProtocol: 'http:',
            probeKnown: false,
            probeCandidates: false,
            userCandidates: ['my-custom-model']
        });

        // User candidate should be persisted (even though probe fails)
        expect(discovery._userCandidates).toContain('my-custom-model');
    });

    test('result shape matches expected API contract', async () => {
        const result = await discovery.probeModels({
            apiKey: 'test-key',
            targetHost: '127.0.0.1',
            targetBasePath: '/api/anthropic',
            targetProtocol: 'http:',
            probeKnown: false,
            probeCandidates: false
        });

        // Verify full response shape
        expect(result).toEqual(expect.objectContaining({
            success: true,
            duration: expect.any(Number),
            results: expect.objectContaining({
                verified: expect.any(Array),
                discovered: expect.any(Array),
                unavailable: expect.any(Array),
                invalid: expect.any(Array),
                errors: expect.any(Array)
            }),
            modelCount: expect.objectContaining({
                before: expect.any(Number),
                after: expect.any(Number)
            }),
            lastProbeAt: expect.any(String)
        }));
    });

    test('getProbeState shape matches expected API contract', () => {
        const state = discovery.getProbeState();
        expect(state).toEqual(expect.objectContaining({
            lastProbeAt: null,
            inProgress: false,
            lastResult: null,
            discoveredCount: expect.any(Number),
            userCandidates: expect.any(Array),
            candidatePatterns: expect.any(Number)
        }));
    });
});
