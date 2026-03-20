'use strict';
/**
 * Cost Tracker Edge Case Tests
 *
 * Covers uncovered edge-case scenarios:
 * 1.  Unknown model pricing — fallback to default rates
 * 2.  Budget threshold alerts — daily/monthly budget triggers
 * 3.  Cost reset — daily/monthly rollover resets counters
 * 4.  Concurrent cost recording — atomic cost accumulation
 * 5.  Persistence roundtrip — save to disk, new instance, load
 * 6.  Large cost values — many requests, no floating-point drift
 * 7.  Zero-cost requests — 0 tokens tracked but $0 cost
 * 8.  Model pricing hot-update — new pricing mid-flight
 * 9.  Cost breakdown by model — per-model cost tracking accuracy
 * 10. Hourly history cap — maxHourlyHistory enforced
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { CostTracker, DEFAULT_RATES, DEFAULT_MODEL_RATES } = require('../lib/cost-tracker');

describe('CostTracker Edge Cases', () => {
    let testDir;
    const testFile = 'test-cost-edges.json';

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-tracker-edges-'));
    });

    afterEach(() => {
        try {
            const files = fs.readdirSync(testDir);
            for (const file of files) {
                fs.unlinkSync(path.join(testDir, file));
            }
            fs.rmdirSync(testDir);
        } catch (err) {
            // Ignore cleanup errors
        }
    });

    // ──────────────────────────────────────────────────────────────────
    // 1. Unknown model pricing — fallback behavior
    // ──────────────────────────────────────────────────────────────────
    describe('Unknown model pricing fallback', () => {
        test('calculateCost with unknown model returns default-rate cost', () => {
            const ct = new CostTracker();
            const cost = ct.calculateCost(1_000_000, 1_000_000, 'totally-unknown-model');
            // DEFAULT_RATES: $3 input + $15 output = $18
            expect(cost).toBe(18);
        });

        test('getRatesByModel for unknown model returns default rates', () => {
            const ct = new CostTracker();
            const rates = ct.getRatesByModel('nonexistent-model-xyz');
            expect(rates.inputTokenPer1M).toBe(DEFAULT_RATES.inputTokenPer1M);
            expect(rates.outputTokenPer1M).toBe(DEFAULT_RATES.outputTokenPer1M);
        });

        test('recordUsage with unknown model uses default rates for cost', () => {
            const ct = new CostTracker();
            const result = ct.recordUsage('key1', 1_000_000, 1_000_000, 'mystery-model-v9');
            expect(result.cost).toBe(18); // default rates
        });

        test('getRatesByModel with null returns default rates', () => {
            const ct = new CostTracker();
            const rates = ct.getRatesByModel(null);
            expect(rates.inputTokenPer1M).toBe(DEFAULT_RATES.inputTokenPer1M);
        });

        test('getRatesByModel with undefined returns default rates', () => {
            const ct = new CostTracker();
            const rates = ct.getRatesByModel(undefined);
            expect(rates.inputTokenPer1M).toBe(DEFAULT_RATES.inputTokenPer1M);
        });

        test('getRatesByModel with empty string returns default rates', () => {
            const ct = new CostTracker();
            const rates = ct.getRatesByModel('');
            expect(rates.inputTokenPer1M).toBe(DEFAULT_RATES.inputTokenPer1M);
        });

        test('prefix match works for versioned model names', () => {
            const ct = new CostTracker();
            // 'claude-opus-4-6-20260301' should prefix-match 'claude-opus-4-6'
            const rates = ct.getRatesByModel('claude-opus-4-6-20260301');
            expect(rates.inputTokenPer1M).toBe(15.00);
            expect(rates.outputTokenPer1M).toBe(75.00);
        });

        test('case-insensitive exact match for known models', () => {
            const ct = new CostTracker();
            const rates = ct.getRatesByModel('GLM-5');
            // lowercase 'glm-5' is in the table
            expect(rates.inputTokenPer1M).toBe(1.00);
            expect(rates.outputTokenPer1M).toBe(3.20);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // 2. Budget threshold alerts
    // ──────────────────────────────────────────────────────────────────
    describe('Budget threshold alerts', () => {
        test('daily budget fires all four default thresholds in order', () => {
            const alerts = [];
            const ct = new CostTracker({
                budget: { daily: 0.018 }, // exactly the cost of 1M+1M at default rates = $18, so use tiny
                onBudgetAlert: (a) => alerts.push(a)
            });

            // Cost for 1000 in + 1000 out = $0.018
            ct.recordUsage('k', 1000, 1000, 'some-model');

            // $0.018 exceeds $0.018 budget -> all thresholds hit (50%, 80%, 95%, 100%)
            const thresholds = alerts.map(a => a.threshold);
            expect(thresholds).toContain(0.5);
            expect(thresholds).toContain(0.8);
            expect(thresholds).toContain(0.95);
            expect(thresholds).toContain(1.0);
        });

        test('monthly budget fires alert events independently of daily', () => {
            const alerts = [];
            const ct = new CostTracker({
                budget: { daily: 1000, monthly: 0.018 },
                onBudgetAlert: (a) => alerts.push(a)
            });

            ct.recordUsage('k', 1000, 1000, 'model');

            // daily budget is 1000 so no daily alerts
            const dailyAlerts = alerts.filter(a => a.period === 'daily');
            expect(dailyAlerts).toHaveLength(0);

            // monthly budget is 0.018, cost is 0.018 -> all thresholds
            const monthlyAlerts = alerts.filter(a => a.period === 'monthly');
            expect(monthlyAlerts.length).toBeGreaterThanOrEqual(4);
        });

        test('alert type is budget.exceeded when threshold >= 1.0', () => {
            const alerts = [];
            const ct = new CostTracker({
                budget: { daily: 0.001 },
                onBudgetAlert: (a) => alerts.push(a)
            });

            ct.recordUsage('k', 1000, 1000, 'model');

            const exceeded = alerts.filter(a => a.type === 'budget.exceeded');
            expect(exceeded.length).toBeGreaterThanOrEqual(1);
            expect(exceeded[0].threshold).toBe(1.0);
        });

        test('alert type is budget.warning for thresholds < 1.0', () => {
            const alerts = [];
            const ct = new CostTracker({
                budget: { daily: 0.001 },
                onBudgetAlert: (a) => alerts.push(a)
            });

            ct.recordUsage('k', 1000, 1000, 'model');

            const warnings = alerts.filter(a => a.type === 'budget.warning');
            expect(warnings.length).toBeGreaterThanOrEqual(1);
            warnings.forEach(w => {
                expect(w.threshold).toBeLessThan(1.0);
            });
        });

        test('alert includes remaining budget and percentUsed', () => {
            const alerts = [];
            const ct = new CostTracker({
                budget: { daily: 100 },
                onBudgetAlert: (a) => alerts.push(a)
            });

            // Need at least 50% of $100 = $50
            // 1M in + 1M out = $18, need ~3 calls
            ct.recordUsage('k', 1_000_000, 1_000_000, 'model'); // $18
            ct.recordUsage('k', 1_000_000, 1_000_000, 'model'); // $36
            ct.recordUsage('k', 1_000_000, 1_000_000, 'model'); // $54

            expect(alerts.length).toBeGreaterThanOrEqual(1);
            const first = alerts[0];
            expect(first.remaining).toBeDefined();
            expect(typeof first.remaining).toBe('number');
            expect(first.remaining).toBeGreaterThanOrEqual(0);
            expect(first.percentUsed).toBeDefined();
            expect(typeof first.percentUsed).toBe('number');
            expect(first.timestamp).toBeDefined();
        });

        test('same threshold never fires twice within a period', () => {
            const alerts = [];
            const ct = new CostTracker({
                budget: { daily: 0.05 },
                onBudgetAlert: (a) => alerts.push(a)
            });

            // Multiple recordings all exceeding budget
            for (let i = 0; i < 5; i++) {
                ct.recordUsage('k', 1000, 1000, 'model');
            }

            // Each threshold should appear exactly once
            const thresholdCounts = {};
            for (const a of alerts) {
                thresholdCounts[a.threshold] = (thresholdCounts[a.threshold] || 0) + 1;
            }
            for (const count of Object.values(thresholdCounts)) {
                expect(count).toBe(1);
            }
        });

        test('no budget alerts when budget is null', () => {
            const alerts = [];
            const ct = new CostTracker({
                budget: { daily: null, monthly: null },
                onBudgetAlert: (a) => alerts.push(a)
            });

            ct.recordUsage('k', 1_000_000, 1_000_000, 'model');
            expect(alerts).toHaveLength(0);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // 3. Cost reset — daily/monthly rollover
    // ──────────────────────────────────────────────────────────────────
    describe('Cost reset on period rollover', () => {
        test('daily counter resets when day changes', () => {
            const ct = new CostTracker();
            ct.recordUsage('k', 5000, 5000, 'model');
            expect(ct.usage.today.requests).toBe(1);
            const costBefore = ct.usage.today.cost;

            // Simulate day rollover
            ct._lastReset.day = '1999-01-01';
            ct._checkPeriodReset();

            expect(ct.usage.today.requests).toBe(0);
            expect(ct.usage.today.cost).toBe(0);
            expect(ct.usage.today.inputTokens).toBe(0);
            expect(ct.usage.today.outputTokens).toBe(0);
        });

        test('monthly counter resets when month changes', () => {
            const ct = new CostTracker();
            ct.recordUsage('k', 5000, 5000, 'model');
            expect(ct.usage.thisMonth.requests).toBe(1);

            // Simulate month rollover
            ct._lastReset.month = '1999-01';
            ct._checkPeriodReset();

            expect(ct.usage.thisMonth.requests).toBe(0);
            expect(ct.usage.thisMonth.cost).toBe(0);
        });

        test('weekly counter resets when week changes', () => {
            const ct = new CostTracker();
            ct.recordUsage('k', 5000, 5000, 'model');
            expect(ct.usage.thisWeek.requests).toBe(1);

            // Simulate week rollover
            ct._lastReset.week = '1999-W01';
            ct._checkPeriodReset();

            expect(ct.usage.thisWeek.requests).toBe(0);
            expect(ct.usage.thisWeek.cost).toBe(0);
        });

        test('allTime counter survives period resets', () => {
            const ct = new CostTracker();
            ct.recordUsage('k', 5000, 5000, 'model');
            const allTimeCost = ct.usage.allTime.cost;

            // Simulate day + month rollover
            ct._lastReset.day = '1999-01-01';
            ct._lastReset.month = '1999-01';
            ct._lastReset.week = '1999-W01';
            ct._checkPeriodReset();

            expect(ct.usage.allTime.cost).toBe(allTimeCost);
            expect(ct.usage.allTime.requests).toBe(1);
        });

        test('daily alert history clears on day rollover', () => {
            const alerts = [];
            const ct = new CostTracker({
                budget: { daily: 0.001 },
                onBudgetAlert: (a) => alerts.push(a)
            });

            ct.recordUsage('k', 1000, 1000, 'model');
            const alertsFirstDay = alerts.length;
            expect(alertsFirstDay).toBeGreaterThan(0);

            // Simulate day change
            ct._lastReset.day = '1999-01-01';
            ct._checkPeriodReset();

            // Set budget again to trigger fresh alerts in new day
            alerts.length = 0;
            ct.recordUsage('k', 1000, 1000, 'model');
            expect(alerts.length).toBeGreaterThan(0);
        });

        test('monthly alert history clears on month rollover', () => {
            const alerts = [];
            const ct = new CostTracker({
                budget: { monthly: 0.001 },
                onBudgetAlert: (a) => alerts.push(a)
            });

            ct.recordUsage('k', 1000, 1000, 'model');
            expect(alerts.length).toBeGreaterThan(0);

            // Simulate month change
            ct._lastReset.month = '1999-01';
            ct._checkPeriodReset();

            alerts.length = 0;
            ct.recordUsage('k', 1000, 1000, 'model');
            expect(alerts.length).toBeGreaterThan(0);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // 4. Concurrent cost recording — atomic accumulation
    // ──────────────────────────────────────────────────────────────────
    describe('Concurrent cost recording', () => {
        test('many synchronous recordUsage calls accumulate atomically', () => {
            const ct = new CostTracker();
            const N = 500;

            for (let i = 0; i < N; i++) {
                ct.recordUsage(`key-${i % 10}`, 100, 50, 'glm-5');
            }

            expect(ct.usage.today.requests).toBe(N);
            expect(ct.usage.today.inputTokens).toBe(100 * N);
            expect(ct.usage.today.outputTokens).toBe(50 * N);
            expect(ct.usage.allTime.requests).toBe(N);
        });

        test('batch and individual recording combined produces correct totals', () => {
            const ct = new CostTracker();

            ct.recordUsage('k1', 1000, 500, 'model');
            ct.recordBatch([
                { keyId: 'k2', inputTokens: 2000, outputTokens: 1000, model: 'model' },
                { keyId: 'k3', inputTokens: 3000, outputTokens: 1500, model: 'model' }
            ]);
            ct.recordUsage('k4', 4000, 2000, 'model');

            expect(ct.usage.today.inputTokens).toBe(1000 + 2000 + 3000 + 4000);
            expect(ct.usage.today.outputTokens).toBe(500 + 1000 + 1500 + 2000);
            expect(ct.usage.today.requests).toBe(4);
        });

        test('per-key stats are correct after many calls to same key', () => {
            const ct = new CostTracker();
            const N = 100;

            for (let i = 0; i < N; i++) {
                ct.recordUsage('shared-key', 10, 5, 'model');
            }

            const keyStats = ct.byKeyId.get('shared-key');
            expect(keyStats.requests).toBe(N);
            expect(keyStats.inputTokens).toBe(10 * N);
            expect(keyStats.outputTokens).toBe(5 * N);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // 5. Persistence roundtrip
    // ──────────────────────────────────────────────────────────────────
    describe('Persistence roundtrip', () => {
        test('full data survives save-to-disk then load in new instance', async () => {
            const ct1 = new CostTracker({
                configDir: testDir,
                persistPath: testFile,
                budget: { daily: 50, monthly: 500 }
            });

            ct1.recordUsage('alpha', 10000, 5000, 'glm-5');
            ct1.recordUsage('beta', 20000, 10000, 'claude-opus-4');
            ct1.recordUsage('gamma', 5000, 2500, 'glm-4.7', 'tenant-A');

            await ct1.flush();

            // Create fresh instance from same file
            const ct2 = new CostTracker({
                configDir: testDir,
                persistPath: testFile
            });

            // Verify usage periods
            expect(ct2.usage.allTime.inputTokens).toBe(35000);
            expect(ct2.usage.allTime.outputTokens).toBe(17500);
            expect(ct2.usage.allTime.requests).toBe(3);

            // Verify per-key data
            expect(ct2.byKeyId.get('alpha')).toBeDefined();
            expect(ct2.byKeyId.get('alpha').inputTokens).toBe(10000);
            expect(ct2.byKeyId.get('beta').inputTokens).toBe(20000);

            // Verify tenant data
            const tenantA = ct2.getTenantCosts('tenant-A');
            expect(tenantA).not.toBeNull();
            expect(tenantA.inputTokens).toBe(5000);
        });

        test('costTimeSeries survives persistence roundtrip', async () => {
            const ct1 = new CostTracker({
                configDir: testDir,
                persistPath: testFile
            });

            ct1.recordUsage('k', 10000, 5000, 'glm-5');
            await ct1.flush();

            const ct2 = new CostTracker({
                configDir: testDir,
                persistPath: testFile
            });

            expect(ct2.costTimeSeries.times.length).toBeGreaterThan(0);
            expect(ct2.costTimeSeries.totals.length).toBeGreaterThan(0);
        });

        test('metrics survive persistence roundtrip', async () => {
            const ct1 = new CostTracker({
                configDir: testDir,
                persistPath: testFile
            });

            ct1.recordUsage('k', 1000, 500, 'model');
            ct1.recordUsage('k', 2000, 1000, 'model');
            await ct1.flush();

            const ct2 = new CostTracker({
                configDir: testDir,
                persistPath: testFile
            });

            expect(ct2.getMetrics().recordCount).toBe(2);
        });

        test('_lastReset survives persistence roundtrip', async () => {
            const ct1 = new CostTracker({
                configDir: testDir,
                persistPath: testFile
            });

            ct1.recordUsage('k', 1000, 500, 'model');
            const dayBefore = ct1._lastReset.day;
            await ct1.flush();

            const ct2 = new CostTracker({
                configDir: testDir,
                persistPath: testFile
            });

            expect(ct2._lastReset.day).toBe(dayBefore);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // 6. Large cost values — floating-point drift
    // ──────────────────────────────────────────────────────────────────
    describe('Large cost values and floating-point precision', () => {
        test('1000 small recordings do not drift from expected total', () => {
            const ct = new CostTracker();
            const N = 1000;

            for (let i = 0; i < N; i++) {
                ct.recordUsage('k', 100, 50, 'model');
            }

            // Each record: 100 input + 50 output at default rates
            // cost = (100/1e6)*3 + (50/1e6)*15 = 0.0003 + 0.00075 = 0.00105
            const singleCost = ct.calculateCost(100, 50);
            const expectedTotal = singleCost * N;

            // Allow tiny floating-point tolerance
            expect(ct.usage.allTime.cost).toBeCloseTo(expectedTotal, 4);
        });

        test('10000 tiny recordings accumulate without vanishing', () => {
            const ct = new CostTracker();
            const N = 10000;

            for (let i = 0; i < N; i++) {
                ct.recordUsage('k', 1, 1, 'model');
            }

            // Single: 0.000018, total: 0.18
            expect(ct.usage.allTime.cost).toBeCloseTo(0.18, 4);
            expect(ct.usage.allTime.requests).toBe(N);
            expect(ct.usage.allTime.totalTokens).toBe(2 * N);
        });

        test('calculateCost rounds to 6 decimal places', () => {
            const ct = new CostTracker();
            // Deliberately chosen values that produce many decimal digits
            const cost = ct.calculateCost(7, 13);
            // (7/1e6)*3 + (13/1e6)*15 = 0.000021 + 0.000195 = 0.000216
            expect(cost).toBe(0.000216);
            // Verify no extra decimal digits
            const str = cost.toString();
            const decimals = str.split('.')[1] || '';
            expect(decimals.length).toBeLessThanOrEqual(6);
        });

        test('large single request cost is calculated correctly', () => {
            const ct = new CostTracker();
            // 100M tokens each
            const cost = ct.calculateCost(100_000_000, 100_000_000);
            // (100M/1M)*3 + (100M/1M)*15 = 300 + 1500 = 1800
            expect(cost).toBe(1800);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // 7. Zero-cost requests
    // ──────────────────────────────────────────────────────────────────
    describe('Zero-cost requests', () => {
        test('recordUsage with (0, 0) returns undefined (skipped)', () => {
            const ct = new CostTracker();
            const result = ct.recordUsage('k', 0, 0, 'model');
            // Implementation: if (!inputTokens && !outputTokens) return undefined
            expect(result).toBeUndefined();
            expect(ct.usage.today.requests).toBe(0);
        });

        test('free model (0 rates) with real tokens produces $0 cost', () => {
            const ct = new CostTracker();
            // glm-4.7-flash has $0/$0 pricing
            const cost = ct.calculateCost(1_000_000, 1_000_000, 'glm-4.7-flash');
            expect(cost).toBe(0);
        });

        test('recordUsage with free model records usage but $0 cost', () => {
            const ct = new CostTracker();
            // glm-4.5-flash: $0 input, $0 output
            const result = ct.recordUsage('k', 10000, 5000, 'glm-4.5-flash');
            expect(result).toBeDefined();
            expect(result.cost).toBe(0);
            expect(result.totalTokens).toBe(15000);
            expect(ct.usage.today.requests).toBe(1);
            expect(ct.usage.today.totalTokens).toBe(15000);
            expect(ct.usage.today.cost).toBe(0);
        });

        test('batch with mix of free and paid models', () => {
            const ct = new CostTracker();

            const result = ct.recordBatch([
                { keyId: 'k1', inputTokens: 1000, outputTokens: 500, model: 'glm-4.7-flash' }, // free
                { keyId: 'k2', inputTokens: 1000, outputTokens: 500, model: 'claude-opus-4' }   // expensive
            ]);

            expect(result.processed).toBe(2);
            // Only the opus record should contribute cost
            const opusCost = ct.calculateCost(1000, 500, 'claude-opus-4');
            expect(result.totalCost).toBeCloseTo(opusCost, 6);
        });

        test('zero-cost records in batch are still counted (non-zero tokens)', () => {
            const ct = new CostTracker();

            ct.recordBatch([
                { keyId: 'k', inputTokens: 1000, outputTokens: 500, model: 'glm-4.7-flash' }
            ]);

            expect(ct.usage.today.requests).toBe(1);
            expect(ct.usage.today.totalTokens).toBe(1500);
            expect(ct.usage.today.cost).toBe(0);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // 8. Model pricing hot-update
    // ──────────────────────────────────────────────────────────────────
    describe('Model pricing hot-update', () => {
        test('setRates changes default rates for future calculations', () => {
            const ct = new CostTracker();

            const costBefore = ct.calculateCost(1_000_000, 1_000_000);
            expect(costBefore).toBe(18); // $3 + $15

            ct.setRates({ inputTokenPer1M: 10.00, outputTokenPer1M: 50.00 });

            const costAfter = ct.calculateCost(1_000_000, 1_000_000);
            expect(costAfter).toBe(60); // $10 + $50
        });

        test('updating modelRates mid-flight: new requests use new pricing', () => {
            const ct = new CostTracker();

            // Record with original glm-5 pricing
            const result1 = ct.recordUsage('k', 1_000_000, 1_000_000, 'glm-5');
            const originalCost = result1.cost;
            expect(originalCost).toBe(4.2); // $1.00 + $3.20

            // Hot-update the glm-5 rate
            ct.modelRates['glm-5'] = { inputTokenPer1M: 2.00, outputTokenPer1M: 6.40 };

            // New request should use new pricing
            const result2 = ct.recordUsage('k', 1_000_000, 1_000_000, 'glm-5');
            expect(result2.cost).toBe(8.4); // $2.00 + $6.40
        });

        test('old recorded costs are NOT retroactively changed by hot-update', () => {
            const ct = new CostTracker();

            ct.recordUsage('k', 1_000_000, 1_000_000, 'glm-5');
            const costAfterFirst = ct.usage.allTime.cost;

            // Update pricing
            ct.modelRates['glm-5'] = { inputTokenPer1M: 100.00, outputTokenPer1M: 500.00 };

            // allTime.cost should still reflect the old-rate recording
            expect(ct.usage.allTime.cost).toBe(costAfterFirst);

            // Only a new recording changes the total
            ct.recordUsage('k', 1_000_000, 1_000_000, 'glm-5');
            expect(ct.usage.allTime.cost).toBe(costAfterFirst + 600); // $100 + $500
        });

        test('adding a completely new model via modelRates works immediately', () => {
            const ct = new CostTracker();

            // Before adding: falls back to default rates
            const costDefault = ct.calculateCost(1_000_000, 1_000_000, 'brand-new-model');
            expect(costDefault).toBe(18);

            // Add new model
            ct.modelRates['brand-new-model'] = { inputTokenPer1M: 0.50, outputTokenPer1M: 1.00 };

            const costNew = ct.calculateCost(1_000_000, 1_000_000, 'brand-new-model');
            expect(costNew).toBe(1.5); // $0.50 + $1.00
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // 9. Cost breakdown by model
    // ──────────────────────────────────────────────────────────────────
    describe('Cost breakdown by model', () => {
        test('costTimeSeries tracks per-model costs', () => {
            const ct = new CostTracker();

            ct.recordUsage('k1', 1_000_000, 0, 'glm-5');        // input only
            ct.recordUsage('k2', 0, 1_000_000, 'claude-opus-4'); // output only

            const ts = ct.getCostTimeSeries();
            expect(ts.times.length).toBe(1); // same hour bucket
            expect(ts.byModel['glm-5']).toBeDefined();
            expect(ts.byModel['claude-opus-4']).toBeDefined();

            // glm-5: 1M input at $1.00/1M = $1.00
            expect(ts.byModel['glm-5'][0]).toBeCloseTo(1.0, 4);
            // claude-opus-4: 1M output at $75.00/1M = $75.00
            expect(ts.byModel['claude-opus-4'][0]).toBeCloseTo(75.0, 4);

            // total should be sum
            expect(ts.totals[0]).toBeCloseTo(76.0, 4);
        });

        test('getCostTimeSeries returns copies, not references', () => {
            const ct = new CostTracker();
            ct.recordUsage('k', 1000, 500, 'model');

            const ts1 = ct.getCostTimeSeries();
            const ts2 = ct.getCostTimeSeries();

            expect(ts1.times).not.toBe(ts2.times);
            expect(ts1.totals).not.toBe(ts2.totals);

            // Mutating the copy should not affect the original
            ts1.times.push('fake');
            const ts3 = ct.getCostTimeSeries();
            expect(ts3.times).not.toContain('fake');
        });

        test('tenant costByModel breakdown is accurate', () => {
            const ct = new CostTracker();

            ct.recordUsage('k', 10000, 5000, 'glm-5', 'tenantX');
            ct.recordUsage('k', 10000, 5000, 'claude-opus-4', 'tenantX');
            ct.recordUsage('k', 10000, 5000, 'glm-5', 'tenantX');

            const tenantData = ct.getTenantCosts('tenantX');
            expect(tenantData.costByModel['glm-5'].requests).toBe(2);
            expect(tenantData.costByModel['claude-opus-4'].requests).toBe(1);
            expect(tenantData.requestCount).toBe(3);
        });

        test('costTimeSeries accumulates within the same hour bucket', () => {
            const ct = new CostTracker();

            ct.recordUsage('k', 1000, 500, 'glm-5');
            ct.recordUsage('k', 2000, 1000, 'glm-5');

            const ts = ct.getCostTimeSeries();
            expect(ts.times.length).toBe(1); // same hour
            // Costs should be summed
            const expected = ct.calculateCost(1000, 500, 'glm-5') + ct.calculateCost(2000, 1000, 'glm-5');
            expect(ts.totals[0]).toBeCloseTo(expected, 6);
        });

        test('per-key breakdown matches aggregated totals', () => {
            const ct = new CostTracker();

            ct.recordUsage('k1', 10000, 5000, 'glm-5');
            ct.recordUsage('k2', 20000, 10000, 'claude-opus-4');
            ct.recordUsage('k1', 5000, 2500, 'glm-5');

            const byKey = ct.getCostByKey();
            let totalCost = 0;
            let totalTokens = 0;
            for (const stats of Object.values(byKey)) {
                totalCost += stats.cost;
                totalTokens += stats.totalTokens;
            }

            expect(totalTokens).toBe(ct.usage.allTime.totalTokens);
            // Allow small rounding difference from 4dp rounding in getCostByKey
            expect(totalCost).toBeCloseTo(ct.usage.allTime.cost, 3);
        });
    });

    // ──────────────────────────────────────────────────────────────────
    // 10. Hourly history cap
    // ──────────────────────────────────────────────────────────────────
    describe('Hourly history cap (maxHourlyHistory)', () => {
        test('hourly history does not exceed maxHourlyHistory', () => {
            const ct = new CostTracker();
            ct.maxHourlyHistory = 5;

            // Simulate 10 day rollovers, each with data
            for (let i = 0; i < 10; i++) {
                ct.recordUsage('k', 1000, 500, 'model');
                ct._lastReset.day = `2000-01-${String(i + 1).padStart(2, '0')}`;
                ct._checkPeriodReset();
            }

            expect(ct.hourlyHistory.length).toBeLessThanOrEqual(5);
        });

        test('oldest entries are evicted first', () => {
            const ct = new CostTracker();
            ct.maxHourlyHistory = 3;

            for (let i = 0; i < 6; i++) {
                ct.recordUsage('k', (i + 1) * 1000, 500, 'model');
                ct._lastReset.day = `2000-01-${String(i + 1).padStart(2, '0')}`;
                ct._checkPeriodReset();
            }

            expect(ct.hourlyHistory.length).toBe(3);
            // The oldest entries (day 01, 02, 03) should have been evicted
            // Remaining entries should be from the last 3 days
            const dates = ct.hourlyHistory.map(h => h.date);
            expect(dates).not.toContain('2000-01-01');
            expect(dates).not.toContain('2000-01-02');
            expect(dates).not.toContain('2000-01-03');
        });

        test('default maxHourlyHistory is 24', () => {
            const ct = new CostTracker();
            expect(ct.maxHourlyHistory).toBe(24);
        });

        test('costTimeSeries respects _maxCostTimeSeriesBuckets', () => {
            const ct = new CostTracker();
            ct._maxCostTimeSeriesBuckets = 3;

            // Force different hour buckets by manipulating the time-series directly
            for (let h = 0; h < 6; h++) {
                const hourKey = `2026-01-01 ${String(h).padStart(2, '0')}:00`;
                ct.costTimeSeries.times.push(hourKey);
                ct.costTimeSeries.totals.push(h * 1.5);
            }

            // Now record to trigger trim logic
            ct.recordUsage('k', 1000, 500, 'model');

            // After trim: should be at most 3 buckets (+1 for the new record if different hour)
            // The trim loop runs while > max
            expect(ct.costTimeSeries.times.length).toBeLessThanOrEqual(4);
        });

        test('no archive when today has zero requests', () => {
            const ct = new CostTracker();
            expect(ct.usage.today.requests).toBe(0);

            ct._lastReset.day = '1999-01-01';
            ct._checkPeriodReset();

            expect(ct.hourlyHistory.length).toBe(0);
        });
    });
});
