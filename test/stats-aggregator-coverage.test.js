'use strict';
/**
 * Stats Aggregator Coverage Tests
 * Target: Uncovered lines 259-260, 362-368, 447-449, 541-542, 600-601
 *
 * Covers:
 * - atomicWrite failure handling (lines 259-260)
 * - model tracking limit (lines 362-368)
 * - time series trimming (lines 447-449)
 * - model_at_capacity error case (lines 541-542)
 * - configMigration write failure (lines 600-601)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { StatsAggregator } = require('../lib/stats-aggregator');

describe('StatsAggregator - Coverage Tests', () => {
    let sa;
    let testDir;
    const testFile = 'test-coverage-stats.json';

    beforeEach(() => {
        testDir = path.join(
            os.tmpdir(),
            `sa-cov-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        );
        fs.mkdirSync(testDir, { recursive: true });

        sa = new StatsAggregator({
            configDir: testDir,
            statsFile: testFile,
            saveInterval: 60000
        });
    });

    afterEach(async () => {
        sa.stopAutoSave();
        await sa.flush();
        jest.restoreAllMocks();
        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch (_) {
            // best-effort cleanup
        }
    });

    // ================================================================
    // 1. atomicWrite failure handling (lines 259-260)
    // ================================================================
    describe('save failure handling', () => {
        test('should re-set dirty flag and log error when atomicWrite fails', async () => {
            // Target: lines 259-260 - error handling in save()
            const errorSpy = jest.fn();
            sa.logger = { info: jest.fn(), warn: jest.fn(), error: errorSpy, debug: jest.fn() };

            // Mock fs.promises functions to simulate write failure
            const originalWriteFile = fs.promises.writeFile;
            jest.spyOn(fs.promises, 'writeFile').mockRejectedValue(new Error('disk full'));

            sa.recordKeyUsage('key1', { requests: 10, successes: 9, failures: 1 });
            expect(sa.dirty).toBe(true);

            const result = sa.save();
            expect(result).toBe(true); // save() returns true when it initiates save

            // Wait for the async save to complete
            await sa.flush();

            // dirty should be re-set to true on failure (line 259)
            expect(sa.dirty).toBe(true);
            // error should be logged (line 260)
            expect(errorSpy).toHaveBeenCalledWith(
                'Failed to save persistent stats: disk full',
                undefined
            );

            fs.promises.writeFile = originalWriteFile;
        });
    });

    // ================================================================
    // 2. Model tracking limit (lines 362-368)
    // ================================================================
    describe('model tracking limit', () => {
        test('should warn and ignore new model when MAX_TRACKED_MODELS reached', () => {
            // Target: lines 362-368 - model limit enforcement
            const warnSpy = jest.fn();
            sa.logger = { info: jest.fn(), warn: warnSpy, error: jest.fn(), debug: jest.fn() };

            // Add MAX_TRACKED_MODELS (500) models
            for (let i = 0; i < 500; i++) {
                sa.recordModelUsage(`model-${i}`, { success: true, latencyMs: 100 });
            }
            expect(sa.modelStats.size).toBe(500);

            // The 501st model should be ignored
            sa.recordModelUsage('model-overflow', { success: true, latencyMs: 200 });

            // Should still have exactly 500 models
            expect(sa.modelStats.size).toBe(500);
            // Should not have the overflow model
            expect(sa.modelStats.has('model-overflow')).toBe(false);
            // Should have logged a warning (lines 363-366)
            expect(warnSpy).toHaveBeenCalledWith(
                'Model tracking limit reached (500), ignoring new model: model-overflow'
            );
        });

        test('should only warn once when model limit reached', () => {
            // Target: lines 362-363 - _modelLimitWarned flag
            const warnSpy = jest.fn();
            sa.logger = { info: jest.fn(), warn: warnSpy, error: jest.fn(), debug: jest.fn() };

            // Fill up the model tracking
            for (let i = 0; i < 500; i++) {
                sa.recordModelUsage(`model-${i}`, { success: true, latencyMs: 100 });
            }

            // Try to add several more models
            sa.recordModelUsage('model-overflow-1', { success: true, latencyMs: 100 });
            sa.recordModelUsage('model-overflow-2', { success: true, latencyMs: 100 });
            sa.recordModelUsage('model-overflow-3', { success: true, latencyMs: 100 });

            // Should only have warned once
            expect(warnSpy).toHaveBeenCalledTimes(1);
        });

        test('should not warn when logger is not provided at limit', () => {
            // Target: lines 364-366 - conditional logger check
            // No logger set

            // Fill up the model tracking
            for (let i = 0; i < 500; i++) {
                sa.recordModelUsage(`model-${i}`, { success: true, latencyMs: 100 });
            }

            // This should not throw even without logger
            expect(() => {
                sa.recordModelUsage('model-overflow', { success: true, latencyMs: 100 });
            }).not.toThrow();

            expect(sa.modelStats.size).toBe(500);
        });
    });

    // ================================================================
    // 3. Time series trimming (lines 447-449)
    // ================================================================
    describe('model time series trimming', () => {
        test('should trim old buckets when exceeding _maxTimeSeriesBuckets (720)', () => {
            // Target: lines 446-449 - while loop that trims old buckets
            jest.useFakeTimers();

            // Set a base time
            const baseTime = new Date('2025-01-01T00:00:00Z').getTime();
            jest.setSystemTime(baseTime);

            // Add more than 720 hourly buckets to trigger trimming
            for (let i = 0; i < 725; i++) {
                // Advance time by 1 hour for each record
                jest.setSystemTime(baseTime + i * 3600 * 1000);
                sa.recordModelUsage('trim-model', {
                    success: true,
                    latencyMs: 100 + i,
                    inputTokens: 10,
                    outputTokens: 5
                });
            }

            jest.useRealTimers();

            const timeSeries = sa.getModelTimeSeries();
            const series = timeSeries['trim-model'];

            // Should be trimmed to exactly 720 buckets
            expect(series.times.length).toBe(720);
            expect(series.tokens.length).toBe(720);
            expect(series.requests.length).toBe(720);
        });

        test('should trim multiple buckets when far exceeding limit', () => {
            // Target: lines 446-449 - while loop continues until within limit
            jest.useFakeTimers();

            const baseTime = new Date('2025-01-01T00:00:00Z').getTime();

            // Add 800 buckets (80 over the limit)
            for (let i = 0; i < 800; i++) {
                jest.setSystemTime(baseTime + i * 3600 * 1000);
                sa.recordModelUsage('trim-model-2', {
                    success: true,
                    latencyMs: 100,
                    inputTokens: 5,
                    outputTokens: 5
                });
            }

            jest.useRealTimers();

            const timeSeries = sa.getModelTimeSeries();
            const series = timeSeries['trim-model-2'];

            // Should be trimmed to exactly 720 buckets
            expect(series.times.length).toBe(720);
        });
    });

    // ================================================================
    // 4. model_at_capacity error case (lines 541-542)
    // ================================================================
    describe('recordError model_at_capacity case', () => {
        test('should track model_at_capacity errors', () => {
            // Target: lines 541-542 - model_at_capacity case
            sa.recordError('model_at_capacity');
            sa.recordError('model_at_capacity');
            sa.recordError('model_at_capacity');

            expect(sa.errors.modelAtCapacity).toBe(3);
        });

        test('model_at_capacity should not affect other error counters', () => {
            sa.recordError('timeout');
            sa.recordError('model_at_capacity');
            sa.recordError('server_error');

            expect(sa.errors.timeouts).toBe(1);
            expect(sa.errors.modelAtCapacity).toBe(1);
            expect(sa.errors.serverErrors).toBe(1);
        });
    });

    // ================================================================
    // 5. recordConfigMigrationWriteFailure (lines 600-601)
    // ================================================================
    describe('configMigration write failure tracking', () => {
        test('recordConfigMigrationWriteFailure should increment counter and set dirty', () => {
            // Target: lines 600-601
            expect(sa.configMigration.writeFailures).toBe(0);
            expect(sa.dirty).toBe(false);

            sa.recordConfigMigrationWriteFailure();

            expect(sa.configMigration.writeFailures).toBe(1);
            expect(sa.dirty).toBe(true);
        });

        test('recordConfigMigrationWriteFailure should accumulate', () => {
            sa.recordConfigMigrationWriteFailure();
            sa.recordConfigMigrationWriteFailure();
            sa.recordConfigMigrationWriteFailure();

            expect(sa.configMigration.writeFailures).toBe(3);
        });
    });
});
