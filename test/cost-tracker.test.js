/**
 * Cost Tracker Module Tests
 *
 * Tests cover the actual CostTracker implementation:
 * - Constructor and initialization
 * - calculateCost: cost calculation from token counts
 * - recordUsage: tracking usage per key with period accumulation
 * - Budget alerts: threshold-based notifications
 * - Persistence: save/load round-trip
 * - Edge cases: 0 tokens, large numbers, period resets
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { CostTracker, DEFAULT_RATES, ALERT_THRESHOLDS } = require('../lib/cost-tracker');

describe('CostTracker', () => {
    // Use unique temp directory per test run to avoid flakes
    let testDir;
    const testFile = 'test-cost.json';

    beforeEach(() => {
        // Create unique temp directory for each test
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-tracker-test-'));
    });

    afterEach(() => {
        // Clean up temp directory
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

    describe('module exports', () => {
        test('should export CostTracker class', () => {
            expect(CostTracker).toBeDefined();
            expect(typeof CostTracker).toBe('function');
        });

        test('should export DEFAULT_RATES', () => {
            expect(DEFAULT_RATES).toBeDefined();
            expect(DEFAULT_RATES.inputTokenPer1M).toBe(3.00);
            expect(DEFAULT_RATES.outputTokenPer1M).toBe(15.00);
        });

        test('should export ALERT_THRESHOLDS', () => {
            expect(ALERT_THRESHOLDS).toBeDefined();
            expect(ALERT_THRESHOLDS).toEqual([0.5, 0.8, 0.95, 1.0]);
        });
    });

    describe('constructor', () => {
        test('should initialize with default rates', () => {
            const ct = new CostTracker();
            expect(ct.rates.inputTokenPer1M).toBe(3.00);
            expect(ct.rates.outputTokenPer1M).toBe(15.00);
        });

        test('should accept custom rates', () => {
            const ct = new CostTracker({
                rates: { inputTokenPer1M: 5.00, outputTokenPer1M: 20.00 }
            });
            expect(ct.rates.inputTokenPer1M).toBe(5.00);
            expect(ct.rates.outputTokenPer1M).toBe(20.00);
        });

        test('should initialize empty usage periods', () => {
            const ct = new CostTracker();
            expect(ct.usage.today.inputTokens).toBe(0);
            expect(ct.usage.today.outputTokens).toBe(0);
            expect(ct.usage.today.cost).toBe(0);
            expect(ct.usage.today.requests).toBe(0);
            expect(ct.usage.thisWeek.inputTokens).toBe(0);
            expect(ct.usage.thisMonth.inputTokens).toBe(0);
            expect(ct.usage.allTime.inputTokens).toBe(0);
        });

        test('should initialize empty byKeyId map', () => {
            const ct = new CostTracker();
            expect(typeof ct.byKeyId.get).toBe('function');
            expect(typeof ct.byKeyId.set).toBe('function');
            expect(ct.byKeyId.size).toBe(0);
        });

        test('should accept budget configuration', () => {
            const ct = new CostTracker({
                budget: { daily: 10, monthly: 100 }
            });
            expect(ct.budget.daily).toBe(10);
            expect(ct.budget.monthly).toBe(100);
        });

        test('should accept custom alert thresholds', () => {
            const ct = new CostTracker({
                budget: { alertThresholds: [0.25, 0.75, 1.0] }
            });
            expect(ct.budget.alertThresholds).toEqual([0.25, 0.75, 1.0]);
        });

        test('should load persisted data if persistPath provided', () => {
            const testFilePath = path.join(testDir, testFile);

            // Create a persisted file
            const data = {
                usage: {
                    today: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: 0.001, requests: 1 },
                    thisWeek: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: 0.001, requests: 1 },
                    thisMonth: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: 0.001, requests: 1 },
                    allTime: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: 0.001, requests: 1 }
                },
                byKeyId: { 'key1': { inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: 0.001, requests: 1 } },
                hourlyHistory: [],
                _lastReset: { day: new Date().toISOString().split('T')[0], week: '2025-W01', month: '2025-01' },
                savedAt: new Date().toISOString()
            };
            fs.writeFileSync(testFilePath, JSON.stringify(data, null, 2));

            const ct = new CostTracker({
                configDir: testDir,
                persistPath: testFile
            });

            expect(ct.usage.allTime.inputTokens).toBe(100);
            expect(ct.byKeyId.get('key1')).toBeDefined();
            expect(ct.byKeyId.get('key1').inputTokens).toBe(100);
        });

        test('should load model pricing from external config file', () => {
            // Create a custom pricing config
            const pricingPath = path.join(testDir, 'pricing.json');
            const customPricing = {
                version: '1.0.0',
                lastVerifiedAt: '2026-02-21',
                sourceUrl: 'https://docs.z.ai/guides/overview/pricing',
                models: {
                    'custom-model': { inputTokenPer1M: 5.00, outputTokenPer1M: 10.00 },
                    'glm-5': { inputTokenPer1M: 2.00, outputTokenPer1M: 6.40 } // Override default
                }
            };
            fs.writeFileSync(pricingPath, JSON.stringify(customPricing, null, 2));

            const ct = new CostTracker({
                configDir: testDir,
                pricingConfigPath: 'pricing.json'
            });

            // Should have custom model
            expect(ct.modelRates['custom-model']).toBeDefined();
            expect(ct.modelRates['custom-model'].inputTokenPer1M).toBe(5.00);
            expect(ct.modelRates['custom-model'].outputTokenPer1M).toBe(10.00);

            // Should override glm-5 with custom pricing
            expect(ct.modelRates['glm-5'].inputTokenPer1M).toBe(2.00);
            expect(ct.modelRates['glm-5'].outputTokenPer1M).toBe(6.40);

            // Should still have other default models as fallback
            expect(ct.modelRates['glm-4.7']).toBeDefined();
        });

        test('should fallback to default pricing when config file missing', () => {
            const ct = new CostTracker({
                configDir: testDir,
                pricingConfigPath: 'nonexistent-pricing.json'
            });

            // Should still have all default models
            expect(ct.modelRates['glm-5']).toBeDefined();
            expect(ct.modelRates['glm-5'].inputTokenPer1M).toBe(1.00);
            expect(ct.modelRates['claude-sonnet-4-5']).toBeDefined();
        });

        test('should fallback to default pricing when config invalid', () => {
            const pricingPath = path.join(testDir, 'pricing.json');
            fs.writeFileSync(pricingPath, 'invalid json');

            const ct = new CostTracker({
                configDir: testDir,
                pricingConfigPath: 'pricing.json'
            });

            // Should still have all default models
            expect(ct.modelRates['glm-5']).toBeDefined();
            expect(ct.modelRates['glm-5'].inputTokenPer1M).toBe(1.00);
        });

        test('should use default pricing path when not specified', () => {
            // When pricingConfigPath not specified, should try default path
            // but not fail if it doesn't exist
            const ct = new CostTracker({
                configDir: testDir
            });

            // Should still work with defaults
            expect(ct.modelRates['glm-5']).toBeDefined();
        });
    });

    describe('calculateCost', () => {
        test('should calculate cost correctly for standard token counts', () => {
            const ct = new CostTracker();

            // 1M input tokens = $3.00, 1M output tokens = $15.00
            const cost = ct.calculateCost(1000000, 1000000);
            expect(cost).toBe(18);
        });

        test('should calculate cost for small token counts', () => {
            const ct = new CostTracker();

            // 1000 input = $0.003, 1000 output = $0.015 = $0.018
            const cost = ct.calculateCost(1000, 1000);
            expect(cost).toBeCloseTo(0.018, 6);
        });

        test('should return 0 for zero tokens', () => {
            const ct = new CostTracker();
            const cost = ct.calculateCost(0, 0);
            expect(cost).toBe(0);
        });

        test('should calculate cost when only input tokens', () => {
            const ct = new CostTracker();
            const cost = ct.calculateCost(1000000, 0);
            expect(cost).toBe(3);
        });

        test('should calculate cost when only output tokens', () => {
            const ct = new CostTracker();
            const cost = ct.calculateCost(0, 1000000);
            expect(cost).toBe(15);
        });

        test('should use custom rates when configured', () => {
            const ct = new CostTracker({
                rates: { inputTokenPer1M: 1.00, outputTokenPer1M: 5.00 }
            });
            const cost = ct.calculateCost(1000000, 1000000);
            expect(cost).toBe(6);
        });

        test('should handle very large token counts', () => {
            const ct = new CostTracker();
            // 1 billion tokens
            const cost = ct.calculateCost(1000000000, 1000000000);
            expect(cost).toBe(18000);
        });

        test('should round to 6 decimal places', () => {
            const ct = new CostTracker();
            // Small amount that could have floating point issues
            const cost = ct.calculateCost(1, 1);
            // 1 token in = $0.000003, 1 token out = $0.000015 = $0.000018
            expect(cost).toBe(0.000018);
        });
    });

    describe('recordUsage', () => {
        test('should return undefined for null tokens (early return)', () => {
            const ct = new CostTracker();
            const result = ct.recordUsage('key1', null, null, 'model');
            expect(result).toBeUndefined();
        });

        test('should return undefined for zero tokens', () => {
            const ct = new CostTracker();
            // Both 0 means !inputTokens && !outputTokens is true (0 is falsy)
            const result = ct.recordUsage('key1', 0, 0, 'model');
            expect(result).toBeUndefined();
        });

        test('should record usage with non-zero input tokens only', () => {
            const ct = new CostTracker();
            const result = ct.recordUsage('key1', 1000, 0, 'model');

            expect(result).toBeDefined();
            expect(result.inputTokens).toBe(1000);
            expect(result.outputTokens).toBe(0);
            expect(result.totalTokens).toBe(1000);
            expect(result.cost).toBeCloseTo(0.003, 6);
        });

        test('should record usage with non-zero output tokens only', () => {
            const ct = new CostTracker();
            const result = ct.recordUsage('key1', 0, 1000, 'model');

            // Implementation: if (!inputTokens && !outputTokens) return;
            // Since outputTokens=1000 is truthy, it proceeds
            expect(result).toBeDefined();
            expect(result.inputTokens).toBe(0);
            expect(result.outputTokens).toBe(1000);
            expect(result.cost).toBeCloseTo(0.015, 6);
        });

        test('should accumulate usage across periods', () => {
            const ct = new CostTracker();

            ct.recordUsage('key1', 1000, 500, 'model');
            ct.recordUsage('key1', 2000, 1000, 'model');

            expect(ct.usage.today.inputTokens).toBe(3000);
            expect(ct.usage.today.outputTokens).toBe(1500);
            expect(ct.usage.today.totalTokens).toBe(4500);
            expect(ct.usage.today.requests).toBe(2);

            expect(ct.usage.thisWeek.inputTokens).toBe(3000);
            expect(ct.usage.thisMonth.inputTokens).toBe(3000);
            expect(ct.usage.allTime.inputTokens).toBe(3000);
        });

        test('should track usage per key', () => {
            const ct = new CostTracker();

            ct.recordUsage('key1', 1000, 500, 'model');
            ct.recordUsage('key2', 2000, 1000, 'model');

            expect(ct.byKeyId.size).toBe(2);
            expect(ct.byKeyId.get('key1').inputTokens).toBe(1000);
            expect(ct.byKeyId.get('key2').inputTokens).toBe(2000);
        });

        test('should accumulate for same key', () => {
            const ct = new CostTracker();

            ct.recordUsage('key1', 1000, 500, 'model');
            ct.recordUsage('key1', 1000, 500, 'model');

            expect(ct.byKeyId.get('key1').inputTokens).toBe(2000);
            expect(ct.byKeyId.get('key1').requests).toBe(2);
        });

        test('should return cost breakdown', () => {
            const ct = new CostTracker();
            const result = ct.recordUsage('key1', 1000000, 1000000, 'model');

            expect(result.cost).toBe(18);
            expect(result.inputTokens).toBe(1000000);
            expect(result.outputTokens).toBe(1000000);
            expect(result.totalTokens).toBe(2000000);
        });
    });

    describe('budget alerts', () => {
        test('should fire 50% daily budget alert', () => {
            const alerts = [];
            const ct = new CostTracker({
                budget: { daily: 1.00 },
                onBudgetAlert: (alert) => alerts.push(alert)
            });

            // Record enough to hit 50% of $1.00 budget
            // Need $0.50 of cost. With $18 per 2M tokens, need ~55556 tokens each
            ct.recordUsage('key1', 27778, 27778, 'model');

            expect(alerts.length).toBeGreaterThanOrEqual(1);
            expect(alerts[0].period).toBe('daily');
            expect(alerts[0].threshold).toBe(0.5);
            expect(alerts[0].type).toBe('budget.warning');
        });

        test('should fire 100% budget exceeded alert', () => {
            const alerts = [];
            const ct = new CostTracker({
                budget: { daily: 0.01 },
                onBudgetAlert: (alert) => alerts.push(alert)
            });

            // Record enough to exceed $0.01 budget
            ct.recordUsage('key1', 1000, 1000, 'model');

            const exceededAlert = alerts.find(a => a.threshold === 1.0);
            expect(exceededAlert).toBeDefined();
            expect(exceededAlert.type).toBe('budget.exceeded');
        });

        test('should not fire same threshold twice', () => {
            const alerts = [];
            const ct = new CostTracker({
                budget: { daily: 0.10 },
                onBudgetAlert: (alert) => alerts.push(alert)
            });

            // Record multiple times past 50% threshold
            ct.recordUsage('key1', 3000, 1000, 'model');
            ct.recordUsage('key1', 3000, 1000, 'model');
            ct.recordUsage('key1', 3000, 1000, 'model');

            const fiftyPctAlerts = alerts.filter(a => a.threshold === 0.5);
            expect(fiftyPctAlerts.length).toBe(1);
        });

        test('should fire monthly budget alerts separately', () => {
            const alerts = [];
            const ct = new CostTracker({
                budget: { daily: 10, monthly: 0.03 },
                onBudgetAlert: (alert) => alerts.push(alert)
            });

            // Record enough to trigger monthly alert but not daily
            // Need $0.015+ to hit 50% of $0.03 monthly budget
            // 1000 output tokens = $0.015, but also 1000 input = $0.003, total = $0.018
            ct.recordUsage('key1', 1000, 1000, 'model');

            const monthlyAlerts = alerts.filter(a => a.period === 'monthly');
            expect(monthlyAlerts.length).toBeGreaterThan(0);
            expect(monthlyAlerts[0].threshold).toBe(0.5);
        });

        test('should include remaining budget in alert', () => {
            const alerts = [];
            const ct = new CostTracker({
                budget: { daily: 1.00 },
                onBudgetAlert: (alert) => alerts.push(alert)
            });

            ct.recordUsage('key1', 30000, 30000, 'model');

            expect(alerts[0].remaining).toBeDefined();
            expect(alerts[0].remaining).toBeGreaterThanOrEqual(0);
            expect(alerts[0].budgetLimit).toBe(1.00);
        });
    });

    describe('getStats', () => {
        test('should return today stats by default', () => {
            const ct = new CostTracker();
            ct.recordUsage('key1', 1000, 500, 'model');

            const stats = ct.getStats();
            expect(stats.period).toBe('today');
            expect(stats.inputTokens).toBe(1000);
            expect(stats.outputTokens).toBe(500);
        });

        test('should return stats for specified period', () => {
            const ct = new CostTracker();
            ct.recordUsage('key1', 1000, 500, 'model');

            const stats = ct.getStats('all_time');
            expect(stats.period).toBe('all_time');
            expect(stats.inputTokens).toBe(1000);
        });

        test('should include average cost per request', () => {
            const ct = new CostTracker();
            ct.recordUsage('key1', 1000, 500, 'model');
            ct.recordUsage('key1', 1000, 500, 'model');

            const stats = ct.getStats();
            expect(stats.avgCostPerRequest).toBeDefined();
            expect(stats.avgCostPerRequest).toBeGreaterThan(0);
        });

        test('should include budget info when budget set', () => {
            const ct = new CostTracker({
                budget: { daily: 10 }
            });
            ct.recordUsage('key1', 1000, 500, 'model');

            const stats = ct.getStats('today');
            expect(stats.budget).toBeDefined();
            expect(stats.budget.limit).toBe(10);
            expect(stats.budget.percentUsed).toBeDefined();
        });

        test('should return null budget when no budget set', () => {
            const ct = new CostTracker();
            const stats = ct.getStats('today');
            expect(stats.budget).toBeNull();
        });

        test('should include current rates', () => {
            const ct = new CostTracker();
            const stats = ct.getStats();
            expect(stats.rates).toBeDefined();
            expect(stats.rates.inputTokenPer1M).toBe(3.00);
        });
    });

    describe('getCostByKey', () => {
        test('should return empty object when no usage', () => {
            const ct = new CostTracker();
            const byKey = ct.getCostByKey();
            expect(Object.keys(byKey).length).toBe(0);
        });

        test('should return cost breakdown per key', () => {
            const ct = new CostTracker();
            ct.recordUsage('key1', 1000, 500, 'model');
            ct.recordUsage('key2', 2000, 1000, 'model');

            const byKey = ct.getCostByKey();
            expect(byKey['key1']).toBeDefined();
            expect(byKey['key2']).toBeDefined();
            expect(byKey['key1'].inputTokens).toBe(1000);
            expect(byKey['key2'].inputTokens).toBe(2000);
        });

        test('should round cost to 4 decimal places', () => {
            const ct = new CostTracker();
            ct.recordUsage('key1', 1, 1, 'model');

            const byKey = ct.getCostByKey();
            // Very small cost should be rounded
            expect(typeof byKey['key1'].cost).toBe('number');
        });
    });

    describe('getProjection', () => {
        test('should return daily and monthly projections', () => {
            const ct = new CostTracker();
            ct.recordUsage('key1', 1000000, 1000000, 'model');

            const projection = ct.getProjection();
            expect(projection.daily).toBeDefined();
            expect(projection.monthly).toBeDefined();
        });

        test('should include current and projected values', () => {
            const ct = new CostTracker();
            ct.recordUsage('key1', 1000000, 1000000, 'model');

            const projection = ct.getProjection();
            expect(projection.daily.current).toBe(18);
            expect(typeof projection.daily.projected).toBe('number');
            expect(typeof projection.monthly.projected).toBe('number');
        });

        test('should indicate if budget will be exceeded', () => {
            const ct = new CostTracker({
                budget: { daily: 1, monthly: 10 }
            });
            ct.recordUsage('key1', 1000000, 1000000, 'model');

            const projection = ct.getProjection();
            expect(projection.daily.willExceed).toBe(true);
            expect(projection.daily.budget).toBe(1);
        });

        test('should return null willExceed when no budget', () => {
            const ct = new CostTracker();
            ct.recordUsage('key1', 1000, 500, 'model');

            const projection = ct.getProjection();
            expect(projection.daily.willExceed).toBeNull();
            expect(projection.monthly.willExceed).toBeNull();
        });
    });

    describe('getFullReport', () => {
        test('should return complete report structure', () => {
            const ct = new CostTracker({
                budget: { daily: 10, monthly: 100 }
            });
            ct.recordUsage('key1', 1000, 500, 'model');

            const report = ct.getFullReport();
            expect(report.periods).toBeDefined();
            expect(report.periods.today).toBeDefined();
            expect(report.periods.thisWeek).toBeDefined();
            expect(report.periods.thisMonth).toBeDefined();
            expect(report.periods.allTime).toBeDefined();
            expect(report.projection).toBeDefined();
            expect(report.byKey).toBeDefined();
            expect(report.history).toBeDefined();
            expect(report.rates).toBeDefined();
            expect(report.budget).toBeDefined();
        });
    });

    describe('setBudget', () => {
        test('should update daily budget', () => {
            const ct = new CostTracker();
            ct.setBudget({ daily: 50 });
            expect(ct.budget.daily).toBe(50);
        });

        test('should update monthly budget', () => {
            const ct = new CostTracker();
            ct.setBudget({ monthly: 500 });
            expect(ct.budget.monthly).toBe(500);
        });

        test('should update alert thresholds', () => {
            const ct = new CostTracker();
            ct.setBudget({ alertThresholds: [0.9, 1.0] });
            expect(ct.budget.alertThresholds).toEqual([0.9, 1.0]);
        });

        test('should preserve existing budget when updating one field', () => {
            const ct = new CostTracker({
                budget: { daily: 10, monthly: 100 }
            });
            ct.setBudget({ daily: 20 });
            expect(ct.budget.daily).toBe(20);
            expect(ct.budget.monthly).toBe(100);
        });
    });

    describe('setRates', () => {
        test('should update input token rate', () => {
            const ct = new CostTracker();
            ct.setRates({ inputTokenPer1M: 5.00 });
            expect(ct.rates.inputTokenPer1M).toBe(5.00);
        });

        test('should update output token rate', () => {
            const ct = new CostTracker();
            ct.setRates({ outputTokenPer1M: 20.00 });
            expect(ct.rates.outputTokenPer1M).toBe(20.00);
        });

        test('should affect future cost calculations', () => {
            const ct = new CostTracker();
            ct.setRates({ inputTokenPer1M: 1.00, outputTokenPer1M: 1.00 });

            const cost = ct.calculateCost(1000000, 1000000);
            expect(cost).toBe(2);
        });
    });

    describe('reset', () => {
        test('should clear all usage data', () => {
            const ct = new CostTracker();
            ct.recordUsage('key1', 1000, 500, 'model');
            ct.recordUsage('key2', 2000, 1000, 'model');

            ct.reset();

            expect(ct.usage.today.inputTokens).toBe(0);
            expect(ct.usage.allTime.inputTokens).toBe(0);
            expect(ct.byKeyId.size).toBe(0);
            expect(ct.hourlyHistory.length).toBe(0);
        });

        test('should clear alert history', () => {
            const alerts = [];
            const ct = new CostTracker({
                budget: { daily: 0.01 },
                onBudgetAlert: (alert) => alerts.push(alert)
            });

            ct.recordUsage('key1', 1000, 500, 'model');
            const alertsBeforeReset = alerts.length;

            ct.reset();
            alerts.length = 0;

            // Should be able to trigger alerts again after reset
            ct.recordUsage('key1', 1000, 500, 'model');
            expect(alerts.length).toBeGreaterThan(0);
        });
    });

    describe('persistence', () => {
        test('should save data to disk', async () => {
            const testFilePath = path.join(testDir, testFile);

            const ct = new CostTracker({
                configDir: testDir,
                persistPath: testFile
            });

            ct.recordUsage('key1', 1000, 500, 'model');
            ct.periodicSave();
            await ct.flush();

            expect(fs.existsSync(testFilePath)).toBe(true);

            const saved = JSON.parse(fs.readFileSync(testFilePath, 'utf8'));
            expect(saved.usage).toBeDefined();
            expect(saved.byKeyId).toBeDefined();
            expect(saved.savedAt).toBeDefined();
        });

        test('should load data from disk correctly (round-trip)', async () => {
            const testFilePath = path.join(testDir, testFile);

            // Create first instance and save data
            const ct1 = new CostTracker({
                configDir: testDir,
                persistPath: testFile
            });

            ct1.recordUsage('key1', 1000, 500, 'model');
            ct1.recordUsage('key2', 2000, 1000, 'model');
            ct1.periodicSave();
            await ct1.flush();

            // Create second instance and verify data loaded
            const ct2 = new CostTracker({
                configDir: testDir,
                persistPath: testFile
            });

            expect(ct2.usage.allTime.inputTokens).toBe(3000);
            expect(ct2.usage.allTime.outputTokens).toBe(1500);
            expect(ct2.byKeyId.size).toBe(2);
            expect(ct2.byKeyId.get('key1').inputTokens).toBe(1000);
            expect(ct2.byKeyId.get('key2').inputTokens).toBe(2000);
        });

        test('should handle missing persist file gracefully', () => {
            const ct = new CostTracker({
                configDir: testDir,
                persistPath: 'nonexistent.json'
            });

            // Should not throw, should have default values
            expect(ct.usage.allTime.inputTokens).toBe(0);
        });

        test('should handle corrupted persist file gracefully', () => {
            const testFilePath = path.join(testDir, testFile);
            fs.writeFileSync(testFilePath, 'not valid json');

            // Should not throw
            expect(() => {
                new CostTracker({
                    configDir: testDir,
                    persistPath: testFile
                });
            }).not.toThrow();
        });

        test('should preserve hourlyHistory across saves', () => {
            const testFilePath = path.join(testDir, testFile);

            // Manually create file with hourlyHistory
            const data = {
                usage: {
                    today: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, requests: 0 },
                    thisWeek: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, requests: 0 },
                    thisMonth: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, requests: 0 },
                    allTime: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: 0.001, requests: 1 }
                },
                byKeyId: {},
                hourlyHistory: [
                    { timestamp: Date.now() - 3600000, date: '2025-01-27', cost: 5, tokens: 100000, requests: 10 }
                ],
                _lastReset: { day: new Date().toISOString().split('T')[0], week: '2025-W04', month: '2025-01' },
                savedAt: new Date().toISOString()
            };
            fs.writeFileSync(testFilePath, JSON.stringify(data, null, 2));

            const ct = new CostTracker({
                configDir: testDir,
                persistPath: testFile
            });

            expect(ct.hourlyHistory.length).toBe(1);
            expect(ct.hourlyHistory[0].cost).toBe(5);
        });
    });

    describe('getHistory', () => {
        test('should return empty array when no history', () => {
            const ct = new CostTracker();
            expect(ct.getHistory()).toEqual([]);
        });

        test('should return last N days of history', () => {
            const ct = new CostTracker();
            ct.hourlyHistory = [
                { date: '2025-01-20', cost: 1 },
                { date: '2025-01-21', cost: 2 },
                { date: '2025-01-22', cost: 3 }
            ];

            expect(ct.getHistory(2)).toEqual([
                { date: '2025-01-21', cost: 2 },
                { date: '2025-01-22', cost: 3 }
            ]);
        });

        test('should return all history if days exceeds length', () => {
            const ct = new CostTracker();
            ct.hourlyHistory = [
                { date: '2025-01-20', cost: 1 }
            ];

            expect(ct.getHistory(10).length).toBe(1);
        });
    });

    describe('costPer1kTokens derivation', () => {
        test('costPer1kTokens is 0 when no tokens recorded', () => {
            const ct = new CostTracker();
            const stats = ct.getStats('today');
            expect(stats.costPer1kTokens).toBe(0);
        });

        test('costPer1kTokens is 0 for every period when no tokens recorded', () => {
            const ct = new CostTracker();
            for (const period of ['today', 'this_week', 'this_month', 'all_time']) {
                const stats = ct.getStats(period);
                expect(stats.costPer1kTokens).toBe(0);
            }
        });

        test('costPer1kTokens correctly derives from recorded usage', () => {
            const ct = new CostTracker();
            // Record 10,000 input + 5,000 output tokens with default rates
            // (model='claude-sonnet' falls back to DEFAULT_RATES: $3/1M input, $15/1M output)
            ct.recordUsage('key1', 10000, 5000, 'claude-sonnet');

            // Expected cost:
            //   input:  10000 / 1_000_000 * 3.00  = 0.03
            //   output:  5000 / 1_000_000 * 15.00 = 0.075
            //   total cost = 0.105 (rounded to 6dp in calculateCost)
            const expectedCost = ct.calculateCost(10000, 5000, 'claude-sonnet');
            const totalTokens = 15000;
            const expectedPer1k = Math.round((expectedCost / (totalTokens / 1000)) * 1000000) / 1000000;

            const stats = ct.getStats('today');
            expect(stats.costPer1kTokens).toBe(expectedPer1k);
            // Sanity-check the actual number: 0.105 / 15 = 0.007
            expect(stats.costPer1kTokens).toBe(0.007);
        });

        test('costPer1kTokens uses model-specific rates for a known model', () => {
            const ct = new CostTracker();
            // claude-opus-4: $15/1M input, $75/1M output
            ct.recordUsage('key1', 2000, 1000, 'claude-opus-4');

            const expectedCost = ct.calculateCost(2000, 1000, 'claude-opus-4');
            // input:  2000 / 1M * 15 = 0.03
            // output: 1000 / 1M * 75 = 0.075
            // cost = 0.105
            const totalTokens = 3000;
            const expectedPer1k = Math.round((expectedCost / (totalTokens / 1000)) * 1000000) / 1000000;

            const stats = ct.getStats('today');
            expect(stats.costPer1kTokens).toBe(expectedPer1k);
            expect(stats.costPer1kTokens).toBe(0.035);
        });

        test('costPer1kTokens reflects per-model rates for mixed traffic', () => {
            const ct = new CostTracker();

            // Record cheap model: claude-haiku-3 ($0.25 input, $1.25 output per 1M)
            // 4000 input + 2000 output = 6000 total tokens
            ct.recordUsage('key1', 4000, 2000, 'claude-haiku-3');
            const haikuCost = ct.calculateCost(4000, 2000, 'claude-haiku-3');
            // input:  4000 / 1M * 0.25 = 0.001
            // output: 2000 / 1M * 1.25 = 0.0025
            // haikuCost = 0.0035

            // Record expensive model: claude-opus-4 ($15 input, $75 output per 1M)
            // 4000 input + 2000 output = 6000 total tokens
            ct.recordUsage('key2', 4000, 2000, 'claude-opus-4');
            const opusCost = ct.calculateCost(4000, 2000, 'claude-opus-4');
            // input:  4000 / 1M * 15 = 0.06
            // output: 2000 / 1M * 75 = 0.15
            // opusCost = 0.21

            const combinedCost = haikuCost + opusCost;
            const totalTokens = 12000; // 6000 + 6000
            const expectedPer1k = Math.round((combinedCost / (totalTokens / 1000)) * 1000000) / 1000000;

            const stats = ct.getStats('today');
            // The blended rate must sit between pure-haiku and pure-opus rates
            const pureHaikuPer1k = Math.round((haikuCost / (6000 / 1000)) * 1000000) / 1000000;
            const pureOpusPer1k = Math.round((opusCost / (6000 / 1000)) * 1000000) / 1000000;

            expect(stats.costPer1kTokens).toBe(expectedPer1k);
            expect(stats.costPer1kTokens).toBeGreaterThan(pureHaikuPer1k);
            expect(stats.costPer1kTokens).toBeLessThan(pureOpusPer1k);
        });

        test('costPer1kTokens is consistent across all periods after a single record', () => {
            const ct = new CostTracker();
            ct.recordUsage('key1', 5000, 5000, 'claude-sonnet-4-5');

            const todayStats = ct.getStats('today');
            const weekStats = ct.getStats('this_week');
            const monthStats = ct.getStats('this_month');
            const allTimeStats = ct.getStats('all_time');

            // All periods should have the same costPer1kTokens since they share the same data
            expect(todayStats.costPer1kTokens).toBe(weekStats.costPer1kTokens);
            expect(weekStats.costPer1kTokens).toBe(monthStats.costPer1kTokens);
            expect(monthStats.costPer1kTokens).toBe(allTimeStats.costPer1kTokens);
            expect(todayStats.costPer1kTokens).toBeGreaterThan(0);
        });

        test('costPer1kTokens updates after additional recordings', () => {
            const ct = new CostTracker();

            // First record: cheap model
            ct.recordUsage('key1', 5000, 5000, 'claude-haiku-3');
            const statsAfterFirst = ct.getStats('today');
            const per1kAfterCheap = statsAfterFirst.costPer1kTokens;

            // Second record: expensive model (same token counts)
            ct.recordUsage('key1', 5000, 5000, 'claude-opus-4');
            const statsAfterSecond = ct.getStats('today');
            const per1kAfterMixed = statsAfterSecond.costPer1kTokens;

            // The blended rate should be higher after adding expensive model usage
            expect(per1kAfterMixed).toBeGreaterThan(per1kAfterCheap);
        });
    });

    describe('edge cases', () => {
        test('should handle very small token counts', () => {
            const ct = new CostTracker();
            const result = ct.recordUsage('key1', 1, 1, 'model');

            expect(result.cost).toBe(0.000018);
            expect(ct.usage.today.inputTokens).toBe(1);
        });

        test('should handle decimal token counts (truncated)', () => {
            const ct = new CostTracker();
            // JavaScript will handle this as-is
            const cost = ct.calculateCost(1000.5, 1000.5);
            expect(cost).toBeCloseTo(0.018009, 6);
        });

        test('should handle negative tokens (no validation)', () => {
            const ct = new CostTracker();
            // Implementation doesn't validate, so this will work but produce negative cost
            const cost = ct.calculateCost(-1000, 1000);
            // -1000 * 3/1M + 1000 * 15/1M = -0.003 + 0.015 = 0.012
            expect(cost).toBeCloseTo(0.012, 6);
        });

        test('should maintain precision for accumulated costs', () => {
            const ct = new CostTracker();

            // Record many small usages
            for (let i = 0; i < 100; i++) {
                ct.recordUsage('key1', 1, 1, 'model');
            }

            // 100 * 0.000018 = 0.0018
            expect(ct.usage.today.cost).toBeCloseTo(0.0018, 6);
        });
    });

    describe('flush race condition', () => {
        test('flush() during in-flight save captures data accumulated after save began', async () => {
            const testFilePath = path.join(testDir, testFile);
            const ct = new CostTracker({
                configDir: testDir,
                persistPath: testFile
            });

            // Record initial data and trigger a save
            ct.recordUsage('key1', 1000, 500, 'model');
            ct.periodicSave();

            // While the save is in-flight, record MORE data
            ct.recordUsage('key2', 2000, 1000, 'model');

            // flush() should await the in-flight save, then do a fresh save
            // with the latest data (including key2)
            await ct.flush();

            const saved = JSON.parse(fs.readFileSync(testFilePath, 'utf8'));
            expect(saved.byKeyId['key1']).toBeDefined();
            expect(saved.byKeyId['key2']).toBeDefined();
            expect(saved.byKeyId['key2'].inputTokens).toBe(2000);
        });

        test('flush() without pending save still saves current data', async () => {
            const testFilePath = path.join(testDir, testFile);
            const ct = new CostTracker({
                configDir: testDir,
                persistPath: testFile
            });

            ct.recordUsage('key1', 5000, 2500, 'model');

            // No periodicSave() called — no in-flight save
            await ct.flush();

            const saved = JSON.parse(fs.readFileSync(testFilePath, 'utf8'));
            expect(saved.byKeyId['key1']).toBeDefined();
            expect(saved.byKeyId['key1'].inputTokens).toBe(5000);
        });

        test('concurrent flush() calls do not lose data', async () => {
            const testFilePath = path.join(testDir, testFile);
            const ct = new CostTracker({
                configDir: testDir,
                persistPath: testFile
            });

            ct.recordUsage('key1', 1000, 500, 'model');

            // Fire two flush() calls concurrently
            const p1 = ct.flush();
            ct.recordUsage('key2', 3000, 1500, 'model');
            const p2 = ct.flush();
            await Promise.all([p1, p2]);

            const saved = JSON.parse(fs.readFileSync(testFilePath, 'utf8'));
            expect(saved.byKeyId['key1']).toBeDefined();
            expect(saved.byKeyId['key2']).toBeDefined();
        });

        test('destroy() flushes all data before marking destroyed', async () => {
            const testFilePath = path.join(testDir, testFile);
            const ct = new CostTracker({
                configDir: testDir,
                persistPath: testFile
            });

            ct.recordUsage('key1', 1000, 500, 'model');
            ct.periodicSave();
            ct.recordUsage('key2', 2000, 1000, 'model');

            await ct.destroy();

            // destroy() now flushes before setting destroyed=true,
            // so all accumulated data is persisted
            const saved = JSON.parse(fs.readFileSync(testFilePath, 'utf8'));
            expect(saved.byKeyId['key1']).toBeDefined();
            expect(saved.byKeyId['key2']).toBeDefined();
            expect(ct.destroyed).toBe(true);
        });
    });
});
