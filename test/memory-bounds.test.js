'use strict';

/**
 * Memory bounds tests — verify that unbounded collections in core modules
 * have hard caps to prevent memory leaks under sustained load.
 *
 * TDD: written FIRST, expected to FAIL until caps are added.
 */

const { DriftDetector } = require('../lib/drift-detector');
const { WebhookManager } = require('../lib/webhook-manager');
const { TenantManager } = require('../lib/tenant-manager');
const { PredictiveScaler } = require('../lib/predictive-scaler');
const { CostTracker } = require('../lib/cost-tracker');

// ---------------------------------------------------------------------------
// Test 1: DriftDetector._driftEvents has a size cap
// ---------------------------------------------------------------------------
describe('DriftDetector memory bounds', () => {
    it('should cap _driftEvents at <= 1000 entries', () => {
        const detector = new DriftDetector();

        // Push 2000 drift events directly via _recordDrift
        for (let i = 0; i < 2000; i++) {
            detector._recordDrift({
                tier: 'light',
                reason: 'concurrency_mismatch',
                details: { i }
            });
        }

        expect(detector._driftEvents.length).toBeLessThanOrEqual(1000);
    });
});

// ---------------------------------------------------------------------------
// Test 2: WebhookManager._errorTimestamps has a hard cap
// ---------------------------------------------------------------------------
describe('WebhookManager memory bounds', () => {
    it('should cap _errorTimestamps at <= 10000 entries', () => {
        const wm = new WebhookManager({ enabled: false });

        // Call recordError 15000 times rapidly (all within the spike window)
        for (let i = 0; i < 15000; i++) {
            wm.recordError('test_error');
        }

        expect(wm._errorTimestamps.length).toBeLessThanOrEqual(10000);
    });
});

// ---------------------------------------------------------------------------
// Test 3: TenantManager.globalStats.requestsByTenant has a size limit
// ---------------------------------------------------------------------------
describe('TenantManager memory bounds', () => {
    it('should cap globalStats.requestsByTenant at <= 10000 tenant keys', () => {
        const tm = new TenantManager({ enabled: true });

        // Simulate 20000 requests from unique tenant IDs via getTenantFromRequest
        for (let i = 0; i < 20000; i++) {
            const fakeReq = { headers: { 'x-tenant-id': `tenant-${i}` } };
            tm.getTenantFromRequest(fakeReq);
        }

        expect(
            Object.keys(tm.globalStats.requestsByTenant).length
        ).toBeLessThanOrEqual(10000);
    });
});

// ---------------------------------------------------------------------------
// Test 4: PredictiveScaler.history has a size cap
// ---------------------------------------------------------------------------
describe('PredictiveScaler memory bounds', () => {
    it('should cap history at <= 10000 entries', () => {
        // Use a very large historyWindow so _cleanHistory won't prune by time
        const scaler = new PredictiveScaler({
            historyWindow: Number.MAX_SAFE_INTEGER
        });

        const baseTs = Date.now();
        for (let i = 0; i < 15000; i++) {
            scaler.recordUsage(baseTs + i, { requests: Math.random() * 100 });
        }

        expect(scaler.history.length).toBeLessThanOrEqual(10000);
    });
});

// ---------------------------------------------------------------------------
// Test 5: CostTracker.costTimeSeries.byModel has a model count cap
// ---------------------------------------------------------------------------
describe('CostTracker memory bounds', () => {
    it('should cap costTimeSeries.byModel at <= 100 model keys', () => {
        const tracker = new CostTracker({
            persistPath: null,
            configDir: __dirname
        });

        // Record costs for 200 unique model names
        for (let i = 0; i < 200; i++) {
            const model = `synthetic-model-${i}`;
            tracker.recordUsage(`key-1`, 1000, 500, model);
        }

        const modelCount = Object.keys(tracker.costTimeSeries.byModel).length;
        expect(modelCount).toBeLessThanOrEqual(100);
    });
});

// ---------------------------------------------------------------------------
// Test 6: ProxyServer._rateLimitMap has a size cap
// ---------------------------------------------------------------------------
describe('ProxyServer._rateLimitMap memory bounds', () => {
    it('should have a size guard that prevents unbounded growth', () => {
        // We can't easily instantiate a full ProxyServer, so we read the
        // source and verify the size-cap logic exists.
        const fs = require('fs');
        const src = fs.readFileSync(
            require('path').join(__dirname, '..', 'lib', 'proxy-server.js'),
            'utf8'
        );

        // There should be a size check on _rateLimitMap that deletes or
        // prevents entries beyond a threshold (e.g., 50000).
        const hasSizeCap =
            /(_rateLimitMap\.size\s*[>>=]+\s*\d+|_rateLimitMap\.size\s*>\s*\d+)/.test(src) ||
            /MAX_RATE_LIMIT_ENTRIES|maxRateLimitEntries|_rateLimitMapCap/.test(src);

        expect(hasSizeCap).toBe(true);
    });
});
