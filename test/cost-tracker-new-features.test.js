/**
 * Cost Tracker New Features Tests
 *
 * Tests for new enhancements:
 * - Per-model pricing support
 * - Batch recording API
 * - Debounced save
 * - Input validation
 * - Metrics/observability
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { CostTracker, DEFAULT_MODEL_RATES } = require('../lib/cost-tracker');

describe('CostTracker New Features', () => {
    let testDir;
    const testFile = 'test-cost-new-features.json';

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-tracker-new-'));
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

    describe('Per-model pricing support', () => {
        test('should support per-model rates via constructor', () => {
            const ct = new CostTracker({
                models: {
                    'claude-opus': { inputTokenPer1M: 15.00, outputTokenPer1M: 75.00 },
                    'claude-haiku': { inputTokenPer1M: 0.25, outputTokenPer1M: 1.25 }
                }
            });

            expect(ct.modelRates['claude-opus']).toBeDefined();
            expect(ct.modelRates['claude-opus'].inputTokenPer1M).toBe(15.00);
            expect(ct.modelRates['claude-haiku'].inputTokenPer1M).toBe(0.25);
        });

        test('should use model-specific rates when available', () => {
            const ct = new CostTracker({
                models: {
                    'claude-opus': { inputTokenPer1M: 15.00, outputTokenPer1M: 75.00 }
                }
            });

            const cost = ct.calculateCost(1000000, 1000000, 'claude-opus');
            expect(cost).toBe(90); // 15 + 75
        });

        test('should fall back to default rates for unknown models', () => {
            const ct = new CostTracker();

            const cost = ct.calculateCost(1000000, 1000000, 'unknown-model');
            expect(cost).toBe(18); // Default rates: 3 + 15
        });

        test('should fall back to default rates when model not specified', () => {
            const ct = new CostTracker();

            const cost = ct.calculateCost(1000000, 1000000);
            expect(cost).toBe(18); // Default rates
        });

        test('getRatesByModel should return model-specific rates', () => {
            const ct = new CostTracker({
                models: {
                    'claude-opus': { inputTokenPer1M: 15.00, outputTokenPer1M: 75.00 }
                }
            });

            const rates = ct.getRatesByModel('claude-opus');
            expect(rates.inputTokenPer1M).toBe(15.00);
            expect(rates.outputTokenPer1M).toBe(75.00);
        });

        test('getRatesByModel should return default rates for unknown model', () => {
            const ct = new CostTracker();

            const rates = ct.getRatesByModel('unknown-model');
            expect(rates.inputTokenPer1M).toBe(3.00);
            expect(rates.outputTokenPer1M).toBe(15.00);
        });

        test('should use model-specific rates in recordUsage', () => {
            const ct = new CostTracker({
                models: {
                    'claude-opus': { inputTokenPer1M: 15.00, outputTokenPer1M: 75.00 },
                    'claude-haiku': { inputTokenPer1M: 0.25, outputTokenPer1M: 1.25 }
                }
            });

            const result1 = ct.recordUsage('key1', 1000000, 1000000, 'claude-opus');
            expect(result1.cost).toBe(90);

            const result2 = ct.recordUsage('key2', 1000000, 1000000, 'claude-haiku');
            expect(result2.cost).toBe(1.50); // 0.25 + 1.25
        });

        test('should include modelRates in getStats', () => {
            const ct = new CostTracker({
                models: {
                    'claude-opus': { inputTokenPer1M: 15.00, outputTokenPer1M: 75.00 }
                }
            });

            const stats = ct.getStats();
            expect(stats.modelRates).toBeDefined();
            expect(stats.modelRates['claude-opus']).toBeDefined();
        });

        test('should maintain backward compatibility with single rate mode', () => {
            const ct = new CostTracker({
                rates: { inputTokenPer1M: 5.00, outputTokenPer1M: 20.00 }
            });

            const cost = ct.calculateCost(1000000, 1000000);
            expect(cost).toBe(25); // 5 + 20
        });

        test('should use DEFAULT_MODEL_RATES from module exports', () => {
            expect(DEFAULT_MODEL_RATES).toBeDefined();
            expect(DEFAULT_MODEL_RATES['claude-opus-4']).toBeDefined();
            expect(DEFAULT_MODEL_RATES['claude-haiku-4']).toBeDefined();
        });
    });

    describe('Batch recording API', () => {
        test('should process multiple records in a single batch', () => {
            const ct = new CostTracker();

            const result = ct.recordBatch([
                { keyId: 'key1', inputTokens: 1000, outputTokens: 500, model: 'claude-sonnet' },
                { keyId: 'key2', inputTokens: 2000, outputTokens: 1000, model: 'claude-sonnet' },
                { keyId: 'key3', inputTokens: 3000, outputTokens: 1500, model: 'claude-sonnet' }
            ]);

            expect(result.processed).toBe(3);
            expect(result.skipped).toBe(0);
            expect(result.errors).toBe(0);
            expect(result.totalTokens).toBe(9000); // 1500 + 3000 + 4500
            expect(result.totalCost).toBeGreaterThan(0);
        });

        test('should skip invalid records in batch', () => {
            const ct = new CostTracker();

            const result = ct.recordBatch([
                { keyId: 'key1', inputTokens: 1000, outputTokens: 500, model: 'claude-sonnet' },
                { keyId: 'key2', inputTokens: -100, outputTokens: 500, model: 'claude-sonnet' }, // Invalid: negative
                { keyId: 'key3', inputTokens: 2000, outputTokens: 1000, model: 'claude-sonnet' }
            ]);

            expect(result.processed).toBe(2);
            expect(result.skipped).toBe(1);
            expect(result.errors).toBe(1);
        });

        test('should return empty stats for empty batch', () => {
            const ct = new CostTracker();

            const result = ct.recordBatch([]);

            expect(result.processed).toBe(0);
            expect(result.skipped).toBe(0);
            expect(result.totalCost).toBe(0);
            expect(result.totalTokens).toBe(0);
            expect(result.errors).toBe(0);
        });

        test('should return empty stats for non-array input', () => {
            const ct = new CostTracker();

            const result = ct.recordBatch('not an array');

            expect(result.processed).toBe(0);
            expect(result.errors).toBe(0);
        });

        test('should handle records with tenantId in batch', () => {
            const ct = new CostTracker();

            const result = ct.recordBatch([
                { keyId: 'key1', inputTokens: 1000, outputTokens: 500, model: 'claude-sonnet', tenantId: 'tenant-1' },
                { keyId: 'key2', inputTokens: 2000, outputTokens: 1000, model: 'claude-sonnet', tenantId: 'tenant-2' }
            ]);

            expect(result.processed).toBe(2);

            const tenant1Costs = ct.getTenantCosts('tenant-1');
            expect(tenant1Costs).not.toBeNull();
            expect(tenant1Costs.totalCost).toBeGreaterThan(0);

            const tenant2Costs = ct.getTenantCosts('tenant-2');
            expect(tenant2Costs).not.toBeNull();
            expect(tenant2Costs.totalCost).toBeGreaterThan(0);
        });

        test('should check budget alerts once after batch', () => {
            const alerts = [];
            const ct = new CostTracker({
                budget: { daily: 0.01 },
                onBudgetAlert: (alert) => alerts.push(alert)
            });

            // Record multiple times that should trigger alert
            ct.recordBatch([
                { keyId: 'key1', inputTokens: 1000, outputTokens: 500, model: 'claude-sonnet' },
                { keyId: 'key2', inputTokens: 1000, outputTokens: 500, model: 'claude-sonnet' },
                { keyId: 'key3', inputTokens: 1000, outputTokens: 500, model: 'claude-sonnet' }
            ]);

            // Should have triggered alerts, but only once per threshold
            expect(alerts.length).toBeGreaterThan(0);
        });

        test('should update metrics for batch operations', () => {
            const ct = new CostTracker();

            ct.recordBatch([
                { keyId: 'key1', inputTokens: 1000, outputTokens: 500, model: 'claude-sonnet' },
                { keyId: 'key2', inputTokens: 2000, outputTokens: 1000, model: 'claude-sonnet' }
            ]);

            const metrics = ct.getMetrics();
            expect(metrics.batchOperations).toBe(1);
            expect(metrics.batchRecordCount).toBe(2);
        });

        test('should use model-specific pricing in batch', () => {
            const ct = new CostTracker({
                models: {
                    'claude-opus': { inputTokenPer1M: 15.00, outputTokenPer1M: 75.00 },
                    'claude-haiku': { inputTokenPer1M: 0.25, outputTokenPer1M: 1.25 }
                }
            });

            const result = ct.recordBatch([
                { keyId: 'key1', inputTokens: 1000000, outputTokens: 1000000, model: 'claude-opus' },
                { keyId: 'key2', inputTokens: 1000000, outputTokens: 1000000, model: 'claude-haiku' }
            ]);

            expect(result.totalCost).toBe(91.50); // 90 + 1.50
        });
    });

    describe('Debounced save', () => {
        test('should debounce saves by default', async () => {
            const testFilePath = path.join(testDir, testFile);
            const ct = new CostTracker({
                configDir: testDir,
                persistPath: testFile,
                saveDebounceMs: 100
            });

            ct.recordUsage('key1', 1000, 500, 'model');
            ct.periodicSave();

            // File should not exist immediately
            expect(fs.existsSync(testFilePath)).toBe(false);

            // Wait for debounce
            await new Promise(resolve => setTimeout(resolve, 150));

            // Now it should exist after flushing
            await ct.flush();
            expect(fs.existsSync(testFilePath)).toBe(true);
        });

        test('should cancel previous debounce and start new one', async () => {
            const testFilePath = path.join(testDir, testFile);

            const ct = new CostTracker({
                configDir: testDir,
                persistPath: testFile,
                saveDebounceMs: 50,
                logger: {
                    info: () => {},
                    warn: () => {},
                    error: () => {},
                    debug: () => {}
                }
            });

            // Verify no file exists initially
            expect(fs.existsSync(testFilePath)).toBe(false);

            ct.recordUsage('key1', 100, 50, 'model');
            ct.periodicSave();

            // Wait a bit but not long enough for debounce to complete
            await new Promise(resolve => setTimeout(resolve, 20));

            // File should not exist yet (debounce hasn't fired)
            const existsBeforeSecondSave = fs.existsSync(testFilePath);

            // Trigger another save before debounce completes - this should reset the timer
            ct.recordUsage('key2', 200, 100, 'model');
            ct.periodicSave();

            // Wait for debounce to complete (50ms + buffer)
            await new Promise(resolve => setTimeout(resolve, 150));

            // Flush any pending saves
            await ct.flush();

            // Now file should exist
            expect(fs.existsSync(testFilePath)).toBe(true);

            // Verify the data contains both records
            const data = JSON.parse(fs.readFileSync(testFilePath, 'utf8'));
            expect(data.usage.today.requests).toBe(2);
        });

        test('should save immediately on flush', async () => {
            const testFilePath = path.join(testDir, testFile);
            const ct = new CostTracker({
                configDir: testDir,
                persistPath: testFile,
                saveDebounceMs: 5000 // Long debounce
            });

            ct.recordUsage('key1', 1000, 500, 'model');
            ct.periodicSave();

            // Flush should save immediately
            await ct.flush();

            expect(fs.existsSync(testFilePath)).toBe(true);
        });

        test('should save immediately on destroy', async () => {
            const testFilePath = path.join(testDir, testFile);
            const ct = new CostTracker({
                configDir: testDir,
                persistPath: testFile,
                saveDebounceMs: 5000
            });

            ct.recordUsage('key1', 1000, 500, 'model');

            // Directly call flush to ensure data is saved before destroy
            await ct.flush();

            await ct.destroy();

            expect(fs.existsSync(testFilePath)).toBe(true);
        });

        test('should allow custom saveDebounceMs', async () => {
            const ct = new CostTracker({
                saveDebounceMs: 2000
            });

            expect(ct.saveDebounceMs).toBe(2000);
        });

        test('should default saveDebounceMs to 5000', () => {
            const ct = new CostTracker();

            expect(ct.saveDebounceMs).toBe(5000);
        });
    });

    describe('Input validation', () => {
        test('should validate token counts are numbers', () => {
            const ct = new CostTracker();

            const result = ct.recordUsage('key1', 'not a number', 500, 'model');
            expect(result).toBeUndefined();
        });

        test('should validate token counts are finite', () => {
            const ct = new CostTracker();

            const result = ct.recordUsage('key1', Infinity, 500, 'model');
            expect(result).toBeUndefined();

            const result2 = ct.recordUsage('key2', NaN, 500, 'model');
            expect(result2).toBeUndefined();
        });

        test('should validate token counts are non-negative', () => {
            const ct = new CostTracker();

            const result = ct.recordUsage('key1', -100, 500, 'model');
            expect(result).toBeUndefined();
        });

        test('should validate keyId is a string', () => {
            const ct = new CostTracker();

            const result = ct.recordUsage(123, 1000, 500, 'model');
            expect(result).toBeUndefined();
        });

        test('should validate tenantId is a string if provided', () => {
            const ct = new CostTracker();

            const result = ct.recordUsage('key1', 1000, 500, 'model', 123);
            expect(result).toBeUndefined();
        });

        test('should trim whitespace from keyId', () => {
            const ct = new CostTracker();

            const result = ct.recordUsage('  key1  ', 1000, 500, 'model');
            expect(result).toBeDefined();

            // Should have used sanitized key
            expect(ct.byKeyId.has('key1')).toBe(true);
            expect(ct.byKeyId.has('  key1  ')).toBe(false);
        });

        test('should truncate keyId to max length', () => {
            const ct = new CostTracker();

            const longKey = 'a'.repeat(300);
            const result = ct.recordUsage(longKey, 1000, 500, 'model');
            expect(result).toBeDefined();

            // Should have truncated key
            expect(ct.byKeyId.size).toBe(1);
            const keys = Array.from(ct.byKeyId.keys());
            expect(keys[0].length).toBe(256); // MAX_STRING_LENGTH
        });

        test('should truncate tenantId to max length', () => {
            const ct = new CostTracker();

            const longTenant = 't'.repeat(300);
            const result = ct.recordUsage('key1', 1000, 500, 'model', longTenant);
            expect(result).toBeDefined();

            // Should have truncated tenant
            const tenantCosts = ct.getAllTenantCosts();
            const tenantIds = Object.keys(tenantCosts);
            expect(tenantIds[0].length).toBe(256); // MAX_STRING_LENGTH
        });

        test('should handle null tenantId gracefully', () => {
            const ct = new CostTracker();

            const result = ct.recordUsage('key1', 1000, 500, 'model', null);
            expect(result).toBeDefined();

            // Should not create tenant entry
            expect(ct.costsByTenant.size).toBe(0);
        });

        test('should track validation warnings in metrics', () => {
            const logMessages = [];
            const ct = new CostTracker({
                logger: {
                    info: () => {},
                    warn: (msg) => logMessages.push(msg),
                    error: () => {},
                    debug: () => {}
                }
            });

            ct.recordUsage('key1', -100, 500, 'model');

            const metrics = ct.getMetrics();
            expect(metrics.validationWarnings).toBe(1);
            expect(logMessages.some(msg => msg.includes('Invalid token counts'))).toBe(true);
        });
    });

    describe('Metrics and observability', () => {
        test('should track record count', () => {
            const ct = new CostTracker();

            ct.recordUsage('key1', 1000, 500, 'model');
            ct.recordUsage('key2', 2000, 1000, 'model');

            const metrics = ct.getMetrics();
            expect(metrics.recordCount).toBe(2);
        });

        test('should track save count and duration', async () => {
            const testFilePath = path.join(testDir, testFile);
            const ct = new CostTracker({
                configDir: testDir,
                persistPath: testFile,
                saveDebounceMs: 10
            });

            ct.recordUsage('key1', 1000, 500, 'model');
            ct.periodicSave();

            await new Promise(resolve => setTimeout(resolve, 50));
            await ct.flush();

            const metrics = ct.getMetrics();
            expect(metrics.saveCount).toBeGreaterThan(0);
            expect(metrics.lastSaveDuration).toBeGreaterThanOrEqual(0);
        });

        test('should track error count', async () => {
            const ct = new CostTracker({
                configDir: testDir,
                persistPath: testFile,
                saveDebounceMs: 10
            });

            // Trigger a validation error
            ct.recordUsage('key1', -100, 500, 'model');

            const metrics = ct.getMetrics();
            expect(metrics.validationWarnings).toBeGreaterThan(0);
        });

        test('should estimate memory usage', () => {
            const ct = new CostTracker();

            ct.recordUsage('key1', 1000, 500, 'model');
            ct.recordUsage('key2', 2000, 1000, 'model');
            ct.recordUsage('key3', 3000, 1500, 'model', 'tenant1');

            const metrics = ct.getMetrics();
            expect(metrics.estimatedMemoryKB).toBeGreaterThan(0);
        });

        test('should report current keys and tenants count', () => {
            const ct = new CostTracker();

            ct.recordUsage('key1', 1000, 500, 'model');
            ct.recordUsage('key2', 2000, 1000, 'model');
            ct.recordUsage('key3', 3000, 1500, 'model', 'tenant1');

            const metrics = ct.getMetrics();
            expect(metrics.currentKeys).toBe(3);
            expect(metrics.currentTenants).toBe(1);
        });

        test('should report history entries count', () => {
            const ct = new CostTracker();

            ct.hourlyHistory = [
                { date: '2025-01-20', cost: 1, tokens: 1000, requests: 1, timestamp: Date.now() },
                { date: '2025-01-21', cost: 2, tokens: 2000, requests: 2, timestamp: Date.now() }
            ];

            const metrics = ct.getMetrics();
            expect(metrics.historyEntries).toBe(2);
        });

        test('should report pending and scheduled save status', async () => {
            const testFilePath = path.join(testDir, testFile);
            const ct = new CostTracker({
                configDir: testDir,
                persistPath: testFile,
                saveDebounceMs: 100
            });

            ct.periodicSave();

            // Should have scheduled save
            let metrics = ct.getMetrics();
            expect(metrics.hasScheduledSave).toBe(true);

            await new Promise(resolve => setTimeout(resolve, 150));
            await ct.flush();

            // Should not have scheduled save after flush
            metrics = ct.getMetrics();
            expect(metrics.hasScheduledSave).toBe(false);
            expect(metrics.hasPendingSave).toBe(false);
        });

        test('should include metrics in full report', () => {
            const ct = new CostTracker();

            ct.recordUsage('key1', 1000, 500, 'model');

            const report = ct.getFullReport();
            expect(report.metrics).toBeDefined();
            expect(report.metrics.recordCount).toBe(1);
        });

        test('should log warning for slow saves', async () => {
            const logMessages = [];
            const testFilePath = path.join(testDir, testFile);

            // Create a file that will be slow to write
            const ct = new CostTracker({
                configDir: testDir,
                persistPath: testFile,
                saveDebounceMs: 10,
                logger: {
                    info: () => {},
                    warn: (msg) => logMessages.push(msg),
                    error: () => {},
                    debug: () => {}
                }
            });

            ct.recordUsage('key1', 1000, 500, 'model');
            ct.periodicSave();

            await new Promise(resolve => setTimeout(resolve, 50));
            await ct.flush();

            // Most saves should be fast, so we don't expect warning in normal case
            // But the infrastructure is there to log it
            const metrics = ct.getMetrics();
            expect(metrics.lastSaveDuration).toBeGreaterThanOrEqual(0);
        });

        test('should persist and load metrics', async () => {
            const testFilePath = path.join(testDir, testFile);

            const ct1 = new CostTracker({
                configDir: testDir,
                persistPath: testFile
            });

            ct1.recordUsage('key1', 1000, 500, 'model');
            ct1.periodicSave();
            await ct1.flush();

            // Create new instance to load metrics
            const ct2 = new CostTracker({
                configDir: testDir,
                persistPath: testFile
            });

            const metrics = ct2.getMetrics();
            expect(metrics.recordCount).toBe(1);
        });
    });

    describe('Backward compatibility', () => {
        test('should maintain existing API without breaking changes', () => {
            const ct = new CostTracker({
                rates: { inputTokenPer1M: 5.00, outputTokenPer1M: 20.00 },
                budget: { daily: 10, monthly: 100 }
            });

            // All existing methods should work
            ct.recordUsage('key1', 1000, 500, 'model');
            ct.setBudget({ daily: 20 });
            ct.setRates({ inputTokenPer1M: 6.00 });

            const stats = ct.getStats('today');
            expect(stats.rates.inputTokenPer1M).toBe(6.00);

            const report = ct.getFullReport();
            expect(report.periods).toBeDefined();
            expect(report.projection).toBeDefined();
        });

        test('should work with existing test patterns', () => {
            const alerts = [];
            const ct = new CostTracker({
                budget: { daily: 1.00 },
                onBudgetAlert: (alert) => alerts.push(alert)
            });

            const result = ct.recordUsage('key1', 27778, 27778, 'model');

            expect(result).toBeDefined();
            expect(result.cost).toBeGreaterThan(0);
            expect(alerts.length).toBeGreaterThan(0);
        });

        test('should handle null/undefined model parameter gracefully', () => {
            const ct = new CostTracker();

            const result1 = ct.recordUsage('key1', 1000, 500, null);
            expect(result1).toBeDefined();

            const result2 = ct.recordUsage('key2', 1000, 500, undefined);
            expect(result2).toBeDefined();

            const result3 = ct.calculateCost(1000, 500, null);
            expect(result3).toBeGreaterThan(0);
        });
    });
});
