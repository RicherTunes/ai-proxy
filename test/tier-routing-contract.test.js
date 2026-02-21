'use strict';

/**
 * Tier Routing Contract Tests
 *
 * Classification matrix for real model names (opus/sonnet/haiku, dated variants,
 * unknowns) to prevent tier routing regressions. Guards against:
 * - Sonnet+tools leaking into heavy tier
 * - Unknown models being promoted to heavy via classifier
 * - Catch-all rule missing
 */

const { ModelRouter } = require('../lib/model-router');
const { DEFAULT_CONFIG } = require('../lib/config');

const mockModelDiscovery = {
    getModel: jest.fn().mockResolvedValue(null)
};

/** Create a router using the PRODUCTION config (DEFAULT_CONFIG). */
function createProductionRouter() {
    return new ModelRouter(DEFAULT_CONFIG.modelRouting, {
        persistEnabled: false,
        modelDiscovery: mockModelDiscovery
    });
}

// ── Classification Matrix ────────────────────────────────────────────

describe('Tier routing contract — classification matrix', () => {
    let router;
    beforeAll(() => { router = createProductionRouter(); });

    const baseFeatures = {
        hasTools: false,
        hasVision: false,
        maxTokens: null,
        messageCount: 1,
        systemLength: 0
    };

    // ── Opus variants → always heavy ──
    describe.each([
        ['claude-opus-4-6',             'heavy'],
        ['claude-opus-4-5-20251101',    'heavy'],
        ['claude-opus-4-20250514',      'heavy'],
        ['claude-opus-5-20260101',      'heavy'],   // future variant
        ['claude-3-opus-20240229',      'heavy'],
    ])('%s → %s', (model, expectedTier) => {
        test('without tools', () => {
            const result = router.classify({ ...baseFeatures, model });
            expect(result.tier).toBe(expectedTier);
        });
        test('with tools', () => {
            const result = router.classify({ ...baseFeatures, model, hasTools: true });
            expect(result.tier).toBe(expectedTier);
        });
        test('with tools + vision + high tokens', () => {
            const result = router.classify({
                ...baseFeatures, model,
                hasTools: true, hasVision: true, maxTokens: 16384,
                messageCount: 50, systemLength: 5000
            });
            expect(result.tier).toBe(expectedTier);
        });
    });

    // ── Sonnet variants → always medium (regardless of features) ──
    describe.each([
        ['claude-sonnet-4-5-20250929',  'medium'],
        ['claude-sonnet-4-20250514',    'medium'],
        ['claude-sonnet-5-20260601',    'medium'],  // future variant
        ['claude-3-sonnet-20240229',    'medium'],
        ['claude-3-5-sonnet-20241022',  'medium'],
    ])('%s → %s', (model, expectedTier) => {
        test('without tools', () => {
            const result = router.classify({ ...baseFeatures, model });
            expect(result.tier).toBe(expectedTier);
        });
        test('with tools', () => {
            const result = router.classify({ ...baseFeatures, model, hasTools: true });
            expect(result.tier).toBe(expectedTier);
        });
        test('with tools + vision + high tokens', () => {
            const result = router.classify({
                ...baseFeatures, model,
                hasTools: true, hasVision: true, maxTokens: 16384,
                messageCount: 50, systemLength: 5000
            });
            expect(result.tier).toBe(expectedTier);
        });
    });

    // ── Haiku variants → always light (regardless of features) ──
    describe.each([
        ['claude-haiku-4-5-20251001',   'light'],
        ['claude-haiku-5-20260101',     'light'],   // future variant
        ['claude-3-haiku-20240307',     'light'],
        ['claude-3-5-haiku-20241022',   'light'],
    ])('%s → %s', (model, expectedTier) => {
        test('without tools', () => {
            const result = router.classify({ ...baseFeatures, model });
            expect(result.tier).toBe(expectedTier);
        });
        test('with tools', () => {
            const result = router.classify({ ...baseFeatures, model, hasTools: true });
            expect(result.tier).toBe(expectedTier);
        });
        test('with tools + vision + high tokens', () => {
            const result = router.classify({
                ...baseFeatures, model,
                hasTools: true, hasVision: true, maxTokens: 16384,
                messageCount: 50, systemLength: 5000
            });
            expect(result.tier).toBe(expectedTier);
        });
    });

    // ── Legacy / instant → light ──
    test('claude-instant-v1 → light', () => {
        const result = router.classify({ ...baseFeatures, model: 'claude-instant-v1' });
        expect(result.tier).toBe('light');
    });

    // ── Unknown models → medium (catch-all rule) ──
    describe.each([
        'gpt-4o',
        'unknown-model-v1',
        'deepseek-r1',
        'gemini-2-flash',
    ])('unknown model %s → medium (catch-all)', (model) => {
        test('without tools', () => {
            const result = router.classify({ ...baseFeatures, model });
            expect(result.tier).toBe('medium');
            expect(result.reason).toContain('rule');
        });
        test('with tools (must NOT promote to heavy)', () => {
            const result = router.classify({ ...baseFeatures, model, hasTools: true });
            expect(result.tier).toBe('medium');
            expect(result.tier).not.toBe('heavy');
        });
    });
});

// ── Guard: Sonnet+tools stays medium ─────────────────────────────────

describe('Guard: Sonnet+tools must stay medium unless explicit upgrade rule exists', () => {
    test('production config has no Sonnet complexity upgrade rules', () => {
        const rules = DEFAULT_CONFIG.modelRouting.rules;
        const sonnetHeavyRules = rules.filter(r =>
            r.tier === 'heavy' &&
            r.match?.model?.includes('sonnet') &&
            (r.match.hasTools || r.match.hasVision || r.match.maxTokensGte)
        );
        expect(sonnetHeavyRules).toHaveLength(0);
    });

    test('Sonnet with every complexity signal stays medium', () => {
        const router = createProductionRouter();
        const result = router.classify({
            model: 'claude-sonnet-4-5-20250929',
            hasTools: true,
            hasVision: true,
            maxTokens: 32768,
            messageCount: 100,
            systemLength: 10000
        });
        expect(result.tier).toBe('medium');
    });

    test('heavy tier clientModelPolicy is rule-match-only', () => {
        expect(DEFAULT_CONFIG.modelRouting.tiers.heavy.clientModelPolicy).toBe('rule-match-only');
    });

    test('classifier cannot promote to heavy when all tiers are rule-match-only', () => {
        const router = createProductionRouter();
        // Unknown model with heavy features — should NOT reach classifier
        const result = router.classify({
            model: 'totally-unknown-model',
            hasTools: true,
            hasVision: true,
            maxTokens: 32768,
            messageCount: 100,
            systemLength: 10000
        });
        // Must match catch-all rule, not classifier
        expect(result.tier).toBe('medium');
        expect(result.reason).toContain('rule');
        expect(result.reason).not.toContain('classifier');
    });
});

// ── Warmup metric gating ─────────────────────────────────────────────

describe('Cold-start warmup metric gating', () => {
    test('failovers during warmup window are tagged in stats', () => {
        const router = new ModelRouter({
            ...DEFAULT_CONFIG.modelRouting,
            // Use a short warmup for testing
        }, {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery,
            warmupDurationMs: 5000
        });

        // Manually record a failover stat during warmup
        router._stats.bySource.failover++;
        router._stats.failoverWarmupTotal++;

        const stats = router.getStats();
        expect(stats.failoverWarmupTotal).toBe(1);
        expect(stats.isWarmingUp).toBe(true);
    });

    test('isWarmingUp becomes false after warmup window', () => {
        const router = new ModelRouter(DEFAULT_CONFIG.modelRouting, {
            persistEnabled: false,
            modelDiscovery: mockModelDiscovery,
            warmupDurationMs: 1 // 1ms warmup for instant expiry
        });

        // Wait for warmup to expire
        router._startedAt = Date.now() - 100;

        const stats = router.getStats();
        expect(stats.isWarmingUp).toBe(false);
    });
});
