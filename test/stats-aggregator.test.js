/**
 * Stats Aggregator Module Tests
 */

const fs = require('fs');
const path = require('path');
const { StatsAggregator } = require('../lib/stats-aggregator');

describe('StatsAggregator', () => {
    let sa;
    const testDir = path.join(__dirname, 'test-stats');
    const testFile = 'test-stats.json';

    beforeEach(() => {
        // Create test directory
        if (!fs.existsSync(testDir)) {
            fs.mkdirSync(testDir, { recursive: true });
        }

        sa = new StatsAggregator({
            configDir: testDir,
            statsFile: testFile,
            saveInterval: 1000
        });
    });

    afterEach(async () => {
        sa.stopAutoSave();
        // Wait for any pending saves before cleanup
        await sa.flush();
        // Clean up test files
        const testFilePath = path.join(testDir, testFile);
        if (fs.existsSync(testFilePath)) {
            fs.unlinkSync(testFilePath);
        }
    });

    describe('constructor', () => {
        test('should initialize with empty stats', () => {
            expect(sa.stats.totals.requests).toBe(0);
            expect(sa.stats.totals.successes).toBe(0);
            expect(sa.stats.totals.failures).toBe(0);
            expect(Object.keys(sa.stats.keys)).toHaveLength(0);
        });

        test('should initialize error tracking', () => {
            expect(sa.errors.timeouts).toBe(0);
            expect(sa.errors.socketHangups).toBe(0);
            expect(sa.errors.connectionRefused).toBe(0);
            expect(sa.errors.other).toBe(0);
        });
    });

    describe('load', () => {
        test('should return false when file does not exist', () => {
            const result = sa.load();
            expect(result).toBe(false);
        });

        test('should load existing stats from file', () => {
            const existingStats = {
                firstSeen: '2024-01-01T00:00:00Z',
                lastUpdated: '2024-01-02T00:00:00Z',
                keys: {
                    'key1': { totalRequests: 100, successes: 95, failures: 5 }
                },
                totals: { requests: 100, successes: 95, failures: 5, retries: 10 }
            };

            fs.writeFileSync(
                path.join(testDir, testFile),
                JSON.stringify(existingStats)
            );

            const result = sa.load();

            expect(result).toBe(true);
            expect(sa.stats.totals.requests).toBe(100);
            expect(sa.stats.keys.key1.totalRequests).toBe(100);
        });

        test('should handle corrupted file gracefully', () => {
            fs.writeFileSync(path.join(testDir, testFile), 'not valid json');

            const result = sa.load();

            expect(result).toBe(false);
            expect(sa.stats.totals.requests).toBe(0);
        });
    });

    describe('save', () => {
        test('should not save when not dirty', () => {
            const result = sa.save();
            expect(result).toBe(false);
        });

        test('should save when dirty', async () => {
            sa.recordKeyUsage('key1', { requests: 1, successes: 1 });

            const result = sa.save();
            expect(result).toBe(true);

            // Use flush() to wait for async save to complete
            await sa.flush();

            expect(fs.existsSync(path.join(testDir, testFile))).toBe(true);
        });

        test('should update lastUpdated timestamp', async () => {
            sa.recordKeyUsage('key1', { requests: 1 });
            const before = sa.stats.lastUpdated;

            // Small delay to ensure different timestamp
            await new Promise(resolve => setTimeout(resolve, 10));
            sa.dirty = true;  // Ensure save will run
            sa.save();

            expect(sa.stats.lastUpdated).not.toBe(before);
        });

        test('should clear dirty flag after save', () => {
            sa.recordKeyUsage('key1', { requests: 1 });
            expect(sa.dirty).toBe(true);

            sa.save();

            expect(sa.dirty).toBe(false);
        });

        test('flush should resolve immediately when no pending saves', async () => {
            await expect(sa.flush()).resolves.toBeUndefined();
        });

        test('flush should wait for pending saves to complete', async () => {
            sa.recordKeyUsage('key1', { requests: 1, successes: 1 });
            sa.save();  // Starts async save

            // File should not exist yet (async write hasn't completed)
            // flush() should wait for it to complete
            await sa.flush();

            // Now file should exist
            expect(fs.existsSync(path.join(testDir, testFile))).toBe(true);
        });

        test('drain is an alias for flush', async () => {
            sa.recordKeyUsage('key1', { requests: 1, successes: 1 });
            sa.save();

            await sa.drain();  // Use drain alias

            expect(fs.existsSync(path.join(testDir, testFile))).toBe(true);
        });
    });

    describe('recordKeyUsage', () => {
        test('should create new key entry if not exists', () => {
            sa.recordKeyUsage('newkey', { requests: 1, successes: 1 });

            expect(sa.stats.keys.newkey).toBeDefined();
            expect(sa.stats.keys.newkey.totalRequests).toBe(1);
        });

        test('should accumulate stats for existing key', () => {
            sa.recordKeyUsage('key1', { requests: 5, successes: 4, failures: 1 });
            sa.recordKeyUsage('key1', { requests: 3, successes: 3, failures: 0 });

            expect(sa.stats.keys.key1.totalRequests).toBe(8);
            expect(sa.stats.keys.key1.successes).toBe(7);
            expect(sa.stats.keys.key1.failures).toBe(1);
        });

        test('should update totals', () => {
            sa.recordKeyUsage('key1', { requests: 5, successes: 4, failures: 1 });
            sa.recordKeyUsage('key2', { requests: 3, successes: 3, failures: 0 });

            expect(sa.stats.totals.requests).toBe(8);
            expect(sa.stats.totals.successes).toBe(7);
            expect(sa.stats.totals.failures).toBe(1);
        });

        test('should update lastUsed', () => {
            const timestamp = new Date().toISOString();
            sa.recordKeyUsage('key1', { requests: 1, lastUsed: timestamp });

            expect(sa.stats.keys.key1.lastUsed).toBe(timestamp);
        });

        test('should set dirty flag', () => {
            expect(sa.dirty).toBe(false);
            sa.recordKeyUsage('key1', { requests: 1 });
            expect(sa.dirty).toBe(true);
        });

        test('should set keyPrefix', () => {
            sa.recordKeyUsage('abcdefghijklmnop', { requests: 1 });
            expect(sa.stats.keys.abcdefghijklmnop.keyPrefix).toBe('abcdefgh');
        });
    });

    describe('recordError', () => {
        test('should track timeouts', () => {
            sa.recordError('timeout');
            sa.recordError('timeout');
            expect(sa.errors.timeouts).toBe(2);
        });

        test('should track socket hangups', () => {
            sa.recordError('socket_hangup');
            expect(sa.errors.socketHangups).toBe(1);
        });

        test('should track connection refused', () => {
            sa.recordError('connection_refused');
            expect(sa.errors.connectionRefused).toBe(1);
        });

        test('should track server errors', () => {
            sa.recordError('server_error');
            expect(sa.errors.serverErrors).toBe(1);
        });

        test('should track other errors', () => {
            sa.recordError('unknown');
            sa.recordError('something_else');
            expect(sa.errors.other).toBe(2);
        });
    });

    describe('recordRetry', () => {
        test('should increment retry count', () => {
            sa.recordRetry();
            sa.recordRetry();
            expect(sa.errors.totalRetries).toBe(2);
        });

        test('should update totals.retries', () => {
            sa.recordRetry();
            expect(sa.stats.totals.retries).toBe(1);
        });

        test('should set dirty flag', () => {
            sa.recordRetry();
            expect(sa.dirty).toBe(true);
        });
    });

    describe('connection tracking', () => {
        test('should track active connections', () => {
            expect(sa.realtime.activeConnections).toBe(0);

            sa.incrementConnections();
            sa.incrementConnections();
            expect(sa.realtime.activeConnections).toBe(2);

            sa.decrementConnections();
            expect(sa.realtime.activeConnections).toBe(1);
        });

        test('should not go below zero', () => {
            sa.decrementConnections();
            sa.decrementConnections();
            expect(sa.realtime.activeConnections).toBe(0);
        });

        test('should allow setting directly', () => {
            sa.setActiveConnections(10);
            expect(sa.realtime.activeConnections).toBe(10);
        });
    });

    describe('worker stats', () => {
        test('should store worker stats', () => {
            sa.updateWorkerStats(1, { totalRequests: 100, keys: [] });
            sa.updateWorkerStats(2, { totalRequests: 200, keys: [] });

            expect(sa.realtime.workerStats.get(1).totalRequests).toBe(100);
            expect(sa.realtime.workerStats.get(2).totalRequests).toBe(200);
        });

        test('should aggregate worker stats', () => {
            sa.updateWorkerStats(1, {
                totalRequests: 100,
                keys: [{ index: 0, inFlight: 2, total: 50, successes: 48 }]
            });
            sa.updateWorkerStats(2, {
                totalRequests: 100,
                keys: [{ index: 0, inFlight: 1, total: 50, successes: 49 }]
            });

            const aggregated = sa.getAggregatedRealtimeStats();

            expect(aggregated.totalRequests).toBe(200);
            expect(aggregated.keys[0].inFlight).toBe(3);
            expect(aggregated.keys[0].totalRequests).toBe(100);
        });
    });

    describe('getPersistentStats', () => {
        test('should return stats object', () => {
            sa.recordKeyUsage('key1', { requests: 10 });
            const stats = sa.getPersistentStats();

            expect(stats.totals.requests).toBe(10);
            expect(stats).toHaveProperty('firstSeen');
            expect(stats).toHaveProperty('lastUpdated');
            expect(stats).toHaveProperty('keys');
        });
    });

    describe('getErrorStats', () => {
        test('should return copy of error stats', () => {
            sa.recordError('timeout');
            sa.recordError('timeout');

            const errors = sa.getErrorStats();

            expect(errors.timeouts).toBe(2);
        });
    });

    describe('getPersistentStatsResponse', () => {
        test('should format response correctly', () => {
            sa.recordKeyUsage('key1', { requests: 100, successes: 90, failures: 10 });
            sa.recordKeyUsage('key2', { requests: 50, successes: 50, failures: 0 });

            const response = sa.getPersistentStatsResponse(['key1', 'key2', 'key3']);

            expect(response.tracking.totalTrackedKeys).toBe(2);
            expect(response.tracking.totalConfiguredKeys).toBe(3);
            expect(response.totals.requests).toBe(150);
            expect(response.keys).toHaveLength(2);
            expect(response.validation.allKeysUsed).toBe(false);
            expect(response.validation.unusedCount).toBe(1);
        });

        test('should sort keys by total requests descending', () => {
            sa.recordKeyUsage('key1', { requests: 50 });
            sa.recordKeyUsage('key2', { requests: 100 });
            sa.recordKeyUsage('key3', { requests: 75 });

            const response = sa.getPersistentStatsResponse(['key1', 'key2', 'key3']);

            expect(response.keys[0].keyId).toBe('key2');
            expect(response.keys[1].keyId).toBe('key3');
            expect(response.keys[2].keyId).toBe('key1');
        });

        test('should identify unused keys', () => {
            sa.recordKeyUsage('key1', { requests: 10 });

            const response = sa.getPersistentStatsResponse(['key1', 'key2']);

            expect(response.unusedKeys).toHaveLength(1);
            expect(response.unusedKeys[0].keyId).toBe('key2');
        });

        test('should not include unusedKeys when all used', () => {
            sa.recordKeyUsage('key1', { requests: 10 });
            sa.recordKeyUsage('key2', { requests: 10 });

            const response = sa.getPersistentStatsResponse(['key1', 'key2']);

            expect(response.unusedKeys).toBeUndefined();
            expect(response.validation.allKeysUsed).toBe(true);
        });
    });

    describe('auto-save', () => {
        test('should start and stop auto-save', () => {
            expect(sa.saveTimer).toBeNull();

            sa.startAutoSave();
            expect(sa.saveTimer).not.toBeNull();

            sa.stopAutoSave();
            expect(sa.saveTimer).toBeNull();
        });

        test('should not start multiple timers', () => {
            sa.startAutoSave();
            const timer1 = sa.saveTimer;

            sa.startAutoSave();
            expect(sa.saveTimer).toBe(timer1);

            sa.stopAutoSave();
        });
    });

    describe('reset', () => {
        test('should reset all stats', () => {
            sa.recordKeyUsage('key1', { requests: 100, successes: 90, failures: 10 });
            sa.recordError('timeout');
            sa.recordRetry();

            sa.reset();

            expect(sa.stats.totals.requests).toBe(0);
            expect(Object.keys(sa.stats.keys)).toHaveLength(0);
            expect(sa.errors.timeouts).toBe(0);
            expect(sa.dirty).toBe(true);
        });
    });

    // ========== NEW TESTS FOR CLIENT REQUEST TRACKING ==========

    describe('client request tracking', () => {
        test('should initialize client request counters', () => {
            expect(sa.clientRequests).toBeDefined();
            expect(sa.clientRequests.total).toBe(0);
            expect(sa.clientRequests.succeeded).toBe(0);
            expect(sa.clientRequests.failed).toBe(0);
            expect(sa.clientRequests.inFlight).toBe(0);
        });

        test('should track client request start', () => {
            sa.recordClientRequestStart();
            sa.recordClientRequestStart();

            expect(sa.clientRequests.total).toBe(2);
            expect(sa.clientRequests.inFlight).toBe(2);
        });

        test('should track client request success', () => {
            sa.recordClientRequestStart();
            sa.recordClientRequestSuccess();

            expect(sa.clientRequests.succeeded).toBe(1);
            expect(sa.clientRequests.inFlight).toBe(0);
        });

        test('should track client request failure', () => {
            sa.recordClientRequestStart();
            sa.recordClientRequestFailure();

            expect(sa.clientRequests.failed).toBe(1);
            expect(sa.clientRequests.inFlight).toBe(0);
        });

        test('should not go below zero in-flight', () => {
            sa.recordClientRequestSuccess();  // No start, but success

            expect(sa.clientRequests.inFlight).toBe(0);
        });

        test('should calculate client success rate', () => {
            sa.recordClientRequestStart();
            sa.recordClientRequestStart();
            sa.recordClientRequestStart();
            sa.recordClientRequestSuccess();
            sa.recordClientRequestSuccess();
            sa.recordClientRequestFailure();

            const stats = sa.getClientRequestStats();

            expect(stats.total).toBe(3);
            expect(stats.succeeded).toBe(2);
            expect(stats.failed).toBe(1);
            expect(stats.successRate).toBe(66.7);  // 2/3 = 66.67%
        });

        test('should return null success rate when no completed requests', () => {
            sa.recordClientRequestStart();  // 1 in-flight, 0 completed

            const stats = sa.getClientRequestStats();

            expect(stats.successRate).toBeNull();
        });

        test('should return 100% success rate when all succeed', () => {
            sa.recordClientRequestStart();
            sa.recordClientRequestStart();
            sa.recordClientRequestSuccess();
            sa.recordClientRequestSuccess();

            const stats = sa.getClientRequestStats();

            expect(stats.successRate).toBe(100);
        });

        test('should reset client requests on reset', () => {
            sa.recordClientRequestStart();
            sa.recordClientRequestStart();
            sa.recordClientRequestSuccess();
            sa.recordClientRequestFailure();

            sa.reset();

            expect(sa.clientRequests.total).toBe(0);
            expect(sa.clientRequests.succeeded).toBe(0);
            expect(sa.clientRequests.failed).toBe(0);
            expect(sa.clientRequests.inFlight).toBe(0);
        });
    });

    describe('rate limit status aggregation', () => {
        test('should aggregate rate limit status from key stats', () => {
            const mockKeyStats = [
                {
                    index: 0,
                    rateLimitTracking: { count: 2, inCooldown: true, cooldownRemaining: 30000 }
                },
                {
                    index: 1,
                    rateLimitTracking: { count: 0, inCooldown: false, cooldownRemaining: 0 }
                },
                {
                    index: 2,
                    rateLimitTracking: { count: 1, inCooldown: true, cooldownRemaining: 15000 }
                }
            ];

            const status = sa._aggregateRateLimitStatus(mockKeyStats);

            expect(status.keysInCooldown).toBe(2);
            expect(status.keysAvailable).toBe(1);
            expect(status.total429s).toBe(3);
            expect(status.cooldownKeys).toHaveLength(2);
        });

        test('should handle keys without rate limit tracking', () => {
            const mockKeyStats = [
                { index: 0 },  // No rateLimitTracking
                { index: 1, rateLimitTracking: null }  // Explicit null
            ];

            const status = sa._aggregateRateLimitStatus(mockKeyStats);

            expect(status.keysInCooldown).toBe(0);
            expect(status.keysAvailable).toBe(2);
            expect(status.total429s).toBe(0);
        });
    });

    // ========== NEW METHODS TESTS ==========

    describe('telemetry tracking', () => {
        test('recordTelemetry should increment passedThrough counter', () => {
            sa.recordTelemetry(false);

            expect(sa.telemetry.passedThrough).toBe(1);
            expect(sa.telemetry.dropped).toBe(0);
        });

        test('recordTelemetry should increment dropped counter', () => {
            sa.recordTelemetry(true);

            expect(sa.telemetry.dropped).toBe(1);
            expect(sa.telemetry.passedThrough).toBe(0);
        });

        test('recordTelemetry should track both dropped and passed', () => {
            sa.recordTelemetry(false);
            sa.recordTelemetry(false);
            sa.recordTelemetry(true);

            expect(sa.telemetry.passedThrough).toBe(2);
            expect(sa.telemetry.dropped).toBe(1);
        });
    });

    describe('429 rate limit tracking', () => {
        test('recordUpstream429 should increment upstream counter', () => {
            sa.recordUpstream429();

            expect(sa.rateLimitTracking.upstream429s).toBe(1);
            expect(sa.rateLimitTracking.local429s).toBe(0);
        });

        test('recordLocal429 should increment local counter', () => {
            sa.recordLocal429();

            expect(sa.rateLimitTracking.local429s).toBe(1);
            expect(sa.rateLimitTracking.upstream429s).toBe(0);
        });

        test('recordLlm429Retry should increment retry counter', () => {
            sa.recordLlm429Retry();

            expect(sa.rateLimitTracking.llm429Retries).toBe(1);
        });

        test('recordLlm429RetrySuccess should increment success counter', () => {
            sa.recordLlm429RetrySuccess();

            expect(sa.rateLimitTracking.llm429RetrySuccesses).toBe(1);
        });

        test('recordPoolCooldown should increment pool cooldown counter', () => {
            sa.recordPoolCooldown();

            expect(sa.rateLimitTracking.poolCooldowns).toBe(1);
        });

        test('getRateLimitTrackingStats should calculate total 429s', () => {
            sa.recordUpstream429();
            sa.recordUpstream429();
            sa.recordLocal429();
            sa.recordLocal429();
            sa.recordLocal429();

            const stats = sa.getRateLimitTrackingStats();

            expect(stats.total429s).toBe(5);
            expect(stats.upstream429s).toBe(2);
            expect(stats.local429s).toBe(3);
        });

        test('getRateLimitTrackingStats should calculate upstream percent', () => {
            sa.recordUpstream429();
            sa.recordUpstream429();
            sa.recordUpstream429();
            sa.recordLocal429();

            const stats = sa.getRateLimitTrackingStats();

            expect(stats.upstreamPercent).toBe(75);  // 3/4 = 75%
        });

        test('getRateLimitTrackingStats should return null upstream percent when no 429s', () => {
            const stats = sa.getRateLimitTrackingStats();

            expect(stats.upstreamPercent).toBeNull();
        });

        test('getRateLimitTrackingStats should calculate LLM 429 retry success rate', () => {
            sa.recordLlm429Retry();
            sa.recordLlm429Retry();
            sa.recordLlm429Retry();
            sa.recordLlm429RetrySuccess();
            sa.recordLlm429RetrySuccess();

            const stats = sa.getRateLimitTrackingStats();

            expect(stats.llm429RetrySuccessRate).toBe(67);  // 2/3 = 66.7% rounded to 67
        });

        test('getRateLimitTrackingStats should return null retry success rate when no retries', () => {
            const stats = sa.getRateLimitTrackingStats();

            expect(stats.llm429RetrySuccessRate).toBeNull();
        });

        test('getRateLimitTrackingStats should include all counters', () => {
            sa.recordUpstream429();
            sa.recordLocal429();
            sa.recordLlm429Retry();
            sa.recordLlm429RetrySuccess();
            sa.recordPoolCooldown();

            const stats = sa.getRateLimitTrackingStats();

            expect(stats.upstream429s).toBe(1);
            expect(stats.local429s).toBe(1);
            expect(stats.llm429Retries).toBe(1);
            expect(stats.llm429RetrySuccesses).toBe(1);
            expect(stats.poolCooldowns).toBe(1);
        });
    });

    describe('hangup cause tracking', () => {
        test('recordHangupCause should categorize stale socket reuse', () => {
            sa.recordHangupCause({ reusedSocket: true, clientDisconnected: false, keyIndex: 0 });

            expect(sa.hangupCauses.staleSocketReuse).toBe(1);
            expect(sa.hangupCauses.clientAbort).toBe(0);
            expect(sa.hangupCauses.freshSocketHangup).toBe(0);
            expect(sa.hangupCauses.unknown).toBe(0);
        });

        test('recordHangupCause should categorize client abort', () => {
            sa.recordHangupCause({ reusedSocket: false, clientDisconnected: true, keyIndex: 0 });

            expect(sa.hangupCauses.clientAbort).toBe(1);
            expect(sa.hangupCauses.staleSocketReuse).toBe(0);
        });

        test('recordHangupCause should categorize fresh socket hangup', () => {
            sa.recordHangupCause({ reusedSocket: false, clientDisconnected: false, keyIndex: 0 });

            expect(sa.hangupCauses.freshSocketHangup).toBe(1);
            expect(sa.hangupCauses.staleSocketReuse).toBe(0);
        });

        test('recordHangupCause should categorize unknown when null input', () => {
            sa.recordHangupCause(null);

            expect(sa.hangupCauses.unknown).toBe(1);
        });

        test('recordHangupCause should categorize unknown when undefined input', () => {
            sa.recordHangupCause(undefined);

            expect(sa.hangupCauses.unknown).toBe(1);
        });

        test('recordHangupCause should categorize unknown when missing reusedSocket', () => {
            sa.recordHangupCause({ clientDisconnected: false, keyIndex: 0 });

            expect(sa.hangupCauses.unknown).toBe(1);
        });

        test('recordHangupCause should categorize freshSocketHangup when missing clientDisconnected', () => {
            // When clientDisconnected is undefined (falsy) but reusedSocket is explicitly false,
            // the implementation categorizes it as freshSocketHangup (not unknown)
            sa.recordHangupCause({ reusedSocket: false, keyIndex: 0 });

            expect(sa.hangupCauses.freshSocketHangup).toBe(1);
            expect(sa.hangupCauses.unknown).toBe(0);
        });

        test('recordHangupCause should track multiple causes', () => {
            sa.recordHangupCause({ reusedSocket: true, clientDisconnected: false });
            sa.recordHangupCause({ reusedSocket: false, clientDisconnected: true });
            sa.recordHangupCause({ reusedSocket: false, clientDisconnected: false });
            sa.recordHangupCause(null);

            expect(sa.hangupCauses.staleSocketReuse).toBe(1);
            expect(sa.hangupCauses.clientAbort).toBe(1);
            expect(sa.hangupCauses.freshSocketHangup).toBe(1);
            expect(sa.hangupCauses.unknown).toBe(1);
        });
    });

    describe('health score tracking', () => {
        test('recordKeySelection should categorize excellent scores (80-100)', () => {
            sa.recordKeySelection(85);

            expect(sa.healthScores.selectionsByScoreRange.excellent).toBe(1);
            expect(sa.healthScores.selectionsByScoreRange.good).toBe(0);
            expect(sa.healthScores.selectionsByScoreRange.fair).toBe(0);
            expect(sa.healthScores.selectionsByScoreRange.poor).toBe(0);
        });

        test('recordKeySelection should categorize good scores (60-79)', () => {
            sa.recordKeySelection(70);

            expect(sa.healthScores.selectionsByScoreRange.good).toBe(1);
        });

        test('recordKeySelection should categorize fair scores (40-59)', () => {
            sa.recordKeySelection(50);

            expect(sa.healthScores.selectionsByScoreRange.fair).toBe(1);
        });

        test('recordKeySelection should categorize poor scores (0-39)', () => {
            sa.recordKeySelection(25);

            expect(sa.healthScores.selectionsByScoreRange.poor).toBe(1);
        });

        test('recordKeySelection should handle boundary values', () => {
            sa.recordKeySelection(79);  // good (upper boundary)
            sa.recordKeySelection(80);  // excellent (lower boundary)
            sa.recordKeySelection(59);  // fair (upper boundary)
            sa.recordKeySelection(60);  // good (lower boundary)
            sa.recordKeySelection(39);  // poor (upper boundary)
            sa.recordKeySelection(40);  // fair (lower boundary)

            expect(sa.healthScores.selectionsByScoreRange.excellent).toBe(1);
            expect(sa.healthScores.selectionsByScoreRange.good).toBe(2);
            expect(sa.healthScores.selectionsByScoreRange.fair).toBe(2);
            expect(sa.healthScores.selectionsByScoreRange.poor).toBe(1);
        });

        test('recordKeySelection should handle edge cases (0 and 100)', () => {
            sa.recordKeySelection(0);   // poor
            sa.recordKeySelection(100); // excellent

            expect(sa.healthScores.selectionsByScoreRange.poor).toBe(1);
            expect(sa.healthScores.selectionsByScoreRange.excellent).toBe(1);
        });

        test('recordKeySelection should track multiple selections', () => {
            sa.recordKeySelection(85);
            sa.recordKeySelection(85);
            sa.recordKeySelection(45);
            sa.recordKeySelection(20);

            expect(sa.healthScores.selectionsByScoreRange.excellent).toBe(2);
            expect(sa.healthScores.selectionsByScoreRange.fair).toBe(1);
            expect(sa.healthScores.selectionsByScoreRange.poor).toBe(1);
        });
    });

    describe('circuit event history', () => {
        test('recordCircuitEvent should add event to history', () => {
            sa.recordCircuitEvent(0, 'CLOSED', 'OPEN', { reason: 'failures' });

            expect(sa.circuitEvents.size).toBe(1);
            expect(sa.circuitEvents.get(0).keyIndex).toBe(0);
            expect(sa.circuitEvents.get(0).from).toBe('CLOSED');
            expect(sa.circuitEvents.get(0).to).toBe('OPEN');
        });

        test('recordCircuitEvent should include metadata', () => {
            sa.recordCircuitEvent(1, 'OPEN', 'HALF_OPEN', { reason: 'timeout', failureCount: 5 });

            const event = sa.circuitEvents.get(0);
            expect(event.reason).toBe('timeout');
            expect(event.failureCount).toBe(5);
        });

        test('recordCircuitEvent should include timestamp', () => {
            const before = Date.now();
            sa.recordCircuitEvent(0, 'CLOSED', 'OPEN');
            const after = Date.now();

            expect(sa.circuitEvents.get(0).timestamp).toBeGreaterThanOrEqual(before);
            expect(sa.circuitEvents.get(0).timestamp).toBeLessThanOrEqual(after);
        });

        test('getCircuitEvents should return all events by default', () => {
            sa.recordCircuitEvent(0, 'CLOSED', 'OPEN');
            sa.recordCircuitEvent(1, 'OPEN', 'HALF_OPEN');
            sa.recordCircuitEvent(0, 'HALF_OPEN', 'CLOSED');

            const events = sa.getCircuitEvents();

            expect(events).toHaveLength(3);
        });

        test('getCircuitEvents should limit result count', () => {
            for (let i = 0; i < 10; i++) {
                sa.recordCircuitEvent(i, 'CLOSED', 'OPEN');
            }

            const events = sa.getCircuitEvents(5);

            expect(events).toHaveLength(5);
        });

        test('getCircuitEvents should return most recent events', () => {
            for (let i = 0; i < 5; i++) {
                sa.recordCircuitEvent(i, 'CLOSED', 'OPEN');
            }

            const events = sa.getCircuitEvents(3);

            expect(events).toHaveLength(3);
            expect(events[0].keyIndex).toBe(2);  // 3rd most recent
            expect(events[2].keyIndex).toBe(4);  // Most recent
        });

        test('clearCircuitEvents should empty the history', () => {
            sa.recordCircuitEvent(0, 'CLOSED', 'OPEN');
            sa.recordCircuitEvent(1, 'OPEN', 'HALF_OPEN');

            expect(sa.circuitEvents.size).toBe(2);

            sa.clearCircuitEvents();

            expect(sa.circuitEvents.size).toBe(0);
        });

        test('recordCircuitEvent should trim to maxCircuitEvents', () => {
            // Create a new instance with smaller capacity for testing
            const testSa = new StatsAggregator({ maxCircuitEvents: 5 });

            for (let i = 0; i < 10; i++) {
                testSa.recordCircuitEvent(i, 'CLOSED', 'OPEN');
            }

            expect(testSa.circuitEvents.size).toBe(5);
            // Should keep most recent 5
            expect(testSa.circuitEvents.get(0).keyIndex).toBe(5);
            expect(testSa.circuitEvents.get(4).keyIndex).toBe(9);
        });
    });

    describe('live request stream', () => {
        test('recordRequest should add request with timestamp', () => {
            const request = {
                id: 'req_123',
                keyIndex: 0,
                method: 'POST',
                path: '/v1/messages'
            };

            sa.recordRequest(request);

            expect(sa.recentRequests.size).toBe(1);
            expect(sa.recentRequests.get(0).id).toBe('req_123');
            expect(sa.recentRequests.get(0).timestamp).toBeDefined();
        });

        test('recordRequest should add default values', () => {
            const request = { id: 'req_1' };

            sa.recordRequest(request);

            expect(sa.recentRequests.get(0).method).toBe('POST');
            expect(sa.recentRequests.get(0).path).toBe('/v1/messages');
            expect(sa.recentRequests.get(0).status).toBe('pending');
        });

        test('recordRequest should trim to maxRecentRequests', () => {
            const testSa = new StatsAggregator({ maxRecentRequests: 5 });

            for (let i = 0; i < 10; i++) {
                testSa.recordRequest({ id: `req_${i}` });
            }

            expect(testSa.recentRequests.size).toBe(5);
            expect(testSa.recentRequests.get(0).id).toBe('req_5');
            expect(testSa.recentRequests.get(4).id).toBe('req_9');
        });

        test('getRecentRequests should return all by default', () => {
            for (let i = 0; i < 5; i++) {
                sa.recordRequest({ id: `req_${i}` });
            }

            const requests = sa.getRecentRequests();

            expect(requests).toHaveLength(5);
        });

        test('getRecentRequests should limit count', () => {
            for (let i = 0; i < 10; i++) {
                sa.recordRequest({ id: `req_${i}` });
            }

            const requests = sa.getRecentRequests(3);

            expect(requests).toHaveLength(3);
            expect(requests[0].id).toBe('req_7');
            expect(requests[2].id).toBe('req_9');
        });

        test('addRequestListener should add listener', () => {
            const listener = jest.fn();
            const remove = sa.addRequestListener(listener);

            expect(sa.requestListeners.size).toBe(1);
            expect(typeof remove).toBe('function');
        });

        test('addRequestListener should notify on new requests', () => {
            const listener = jest.fn();
            sa.addRequestListener(listener);

            sa.recordRequest({ id: 'req_123' });

            expect(listener).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'req_123' })
            );
        });

        test('removeRequestListener should remove listener', () => {
            const listener = jest.fn();
            sa.addRequestListener(listener);

            expect(sa.requestListeners.size).toBe(1);

            sa.removeRequestListener(listener);

            expect(sa.requestListeners.size).toBe(0);
        });

        test('removeRequestListener should handle non-existent listener', () => {
            const listener = jest.fn();

            expect(() => sa.removeRequestListener(listener)).not.toThrow();
        });
    });

    describe('adaptive timeout tracking', () => {
        test('recordAdaptiveTimeout should track timeout value', () => {
            sa.recordAdaptiveTimeout(5000);

            expect(sa.adaptiveTimeouts.adaptiveTimeoutsUsed).toBe(1);
        });

        test('recordAdaptiveTimeout should update min and max', () => {
            sa.recordAdaptiveTimeout(30000);
            sa.recordAdaptiveTimeout(15000);
            sa.recordAdaptiveTimeout(60000);

            expect(sa.adaptiveTimeouts.minTimeoutUsed).toBe(15000);
            expect(sa.adaptiveTimeouts.maxTimeoutUsed).toBe(60000);
        });

        test('recordAdaptiveTimeout should initialize min to Infinity', () => {
            expect(sa.adaptiveTimeouts.minTimeoutUsed).toBe(Infinity);
        });

        test('recordAdaptiveTimeout should track total requests', () => {
            sa.recordAdaptiveTimeout(5000);
            sa.recordAdaptiveTimeout(10000);

            expect(sa.adaptiveTimeouts.totalRequests).toBe(2);
        });

        test('recordAdaptiveTimeout should maintain timeout values buffer', () => {
            sa.recordAdaptiveTimeout(100);
            sa.recordAdaptiveTimeout(200);
            sa.recordAdaptiveTimeout(300);

            expect(sa.adaptiveTimeouts.timeoutValues.size).toBe(3);
            expect(sa.adaptiveTimeouts.timeoutValues.toArray()).toEqual([100, 200, 300]);
        });

        test('recordAdaptiveTimeout should trim buffer to 100 values', () => {
            for (let i = 0; i < 150; i++) {
                sa.recordAdaptiveTimeout(i);
            }

            expect(sa.adaptiveTimeouts.timeoutValues.size).toBe(100);
            // Should keep most recent 100
            const arr = sa.adaptiveTimeouts.timeoutValues.toArray();
            expect(arr[0]).toBe(50);
            expect(arr[99]).toBe(149);
        });

        test('getAdaptiveTimeoutStats should return current stats', () => {
            sa.recordAdaptiveTimeout(10000);
            sa.recordAdaptiveTimeout(20000);
            sa.recordAdaptiveTimeout(30000);

            const stats = sa.getAdaptiveTimeoutStats();

            expect(stats.totalRequests).toBe(3);
            expect(stats.adaptiveTimeoutsUsed).toBe(3);
            expect(stats.minTimeout).toBe(10000);
            expect(stats.maxTimeout).toBe(30000);
        });

        test('getAdaptiveTimeoutStats should calculate average', () => {
            sa.recordAdaptiveTimeout(10000);
            sa.recordAdaptiveTimeout(20000);
            sa.recordAdaptiveTimeout(30000);

            const stats = sa.getAdaptiveTimeoutStats();

            expect(stats.avgTimeout).toBe(20000);  // (10000+20000+30000)/3
        });

        test('getAdaptiveTimeoutStats should return 0 avg when no timeouts', () => {
            const stats = sa.getAdaptiveTimeoutStats();

            expect(stats.avgTimeout).toBe(0);
        });
    });

    describe('slow key event tracking', () => {
        test('recordSlowKeyEvent should increment counter', () => {
            sa.recordSlowKeyEvent();

            expect(sa.healthScores.slowKeyEvents).toBe(1);
        });

        test('recordSlowKeyRecovery should increment counter', () => {
            sa.recordSlowKeyRecovery();

            expect(sa.healthScores.slowKeyRecoveries).toBe(1);
        });
    });

    describe('give-up tracking (Month 1 metrics)', () => {
        test('recordGiveUp increments total', () => {
            sa.recordGiveUp('max_429_attempts');
            expect(sa.giveUpTracking.total).toBe(1);
        });

        test('recordGiveUp increments correct byReason key', () => {
            sa.recordGiveUp('max_429_attempts');
            sa.recordGiveUp('max_429_window');
            sa.recordGiveUp('max_429_window');
            expect(sa.giveUpTracking.byReason.max_429_attempts).toBe(1);
            expect(sa.giveUpTracking.byReason.max_429_window).toBe(2);
        });

        test('recordGiveUp with unknown reason increments total but not byReason', () => {
            sa.recordGiveUp('unknown_reason');
            expect(sa.giveUpTracking.total).toBe(1);
            expect(sa.giveUpTracking.byReason.max_429_attempts).toBe(0);
            expect(sa.giveUpTracking.byReason.max_429_window).toBe(0);
        });

        test('getGiveUpStats returns raw counters', () => {
            sa.recordGiveUp('max_429_attempts');
            sa.recordGiveUp('max_429_window');
            const stats = sa.getGiveUpStats();
            expect(stats).toEqual({
                total: 2,
                byReason: { max_429_attempts: 1, max_429_window: 1 }
            });
        });

        test('reset clears give-up tracking', () => {
            sa.recordGiveUp('max_429_attempts');
            sa.recordGiveUp('max_429_window');
            sa.reset();
            expect(sa.giveUpTracking.total).toBe(0);
            expect(sa.giveUpTracking.byReason.max_429_attempts).toBe(0);
            expect(sa.giveUpTracking.byReason.max_429_window).toBe(0);
        });
    });

    describe('retry efficiency tracking (Month 1 metrics)', () => {
        test('recordSameModelRetry increments counter', () => {
            sa.recordSameModelRetry();
            sa.recordSameModelRetry();
            expect(sa.retryEfficiency.sameModelRetries).toBe(2);
        });

        test('recordFailedRequestModelStats accumulates correctly', () => {
            sa.recordFailedRequestModelStats(3, 2);  // 3 models tried, 2 switches
            sa.recordFailedRequestModelStats(2, 1);  // 2 models tried, 1 switch
            expect(sa.retryEfficiency.totalModelsTriedOnFailure).toBe(5);
            expect(sa.retryEfficiency.totalModelSwitchesOnFailure).toBe(3);
            expect(sa.retryEfficiency.failedRequestsWithModelStats).toBe(2);
        });

        test('getRetryEfficiencyStats returns raw counters', () => {
            sa.recordSameModelRetry();
            sa.recordFailedRequestModelStats(3, 1);
            const stats = sa.getRetryEfficiencyStats();
            expect(stats).toEqual({
                sameModelRetries: 1,
                totalModelsTriedOnFailure: 3,
                totalModelSwitchesOnFailure: 1,
                failedRequestsWithModelStats: 1
            });
        });

        test('reset clears retry efficiency', () => {
            sa.recordSameModelRetry();
            sa.recordFailedRequestModelStats(3, 2);
            sa.reset();
            expect(sa.retryEfficiency.sameModelRetries).toBe(0);
            expect(sa.retryEfficiency.totalModelsTriedOnFailure).toBe(0);
            expect(sa.retryEfficiency.failedRequestsWithModelStats).toBe(0);
        });
    });

    describe('retry backoff tracking (Month 1 metrics)', () => {
        test('recordRetryBackoff accumulates sum and count', () => {
            sa.recordRetryBackoff(100);
            sa.recordRetryBackoff(250);
            sa.recordRetryBackoff(500);
            expect(sa.retryBackoff.totalDelayMs).toBe(850);
            expect(sa.retryBackoff.delayCount).toBe(3);
        });

        test('getRetryBackoffStats returns raw counters', () => {
            sa.recordRetryBackoff(200);
            sa.recordRetryBackoff(300);
            const stats = sa.getRetryBackoffStats();
            expect(stats).toEqual({
                totalDelayMs: 500,
                delayCount: 2
            });
        });

        test('reset clears retry backoff tracking', () => {
            sa.recordRetryBackoff(100);
            sa.reset();
            expect(sa.retryBackoff.totalDelayMs).toBe(0);
            expect(sa.retryBackoff.delayCount).toBe(0);
        });
    });

    describe('getFullStats includes Month 1 metrics', () => {
        test('getFullStats output contains giveUpTracking, retryEfficiency, retryBackoff', () => {
            sa.recordGiveUp('max_429_attempts');
            sa.recordSameModelRetry();
            sa.recordRetryBackoff(100);

            const mockKeyManager = {
                getStats: () => [],
                circuitBreakerConfig: {},
                getPoolAverageLatency: () => 0,
                getPoolRateLimitStats: () => null
            };

            const fullStats = sa.getFullStats(mockKeyManager, 3600);
            expect(fullStats.giveUpTracking).toBeDefined();
            expect(fullStats.giveUpTracking.total).toBe(1);
            expect(fullStats.retryEfficiency).toBeDefined();
            expect(fullStats.retryEfficiency.sameModelRetries).toBe(1);
            expect(fullStats.retryBackoff).toBeDefined();
            expect(fullStats.retryBackoff.totalDelayMs).toBe(100);
        });
    });

    // ========================================================================
    // Admission hold tracking (Tier-Aware Admission Hold v1)
    // ========================================================================
    describe('admission hold tracking', () => {
        test('recordAdmissionHold increments total and byTier', () => {
            sa.recordAdmissionHold('heavy');
            sa.recordAdmissionHold('heavy');
            sa.recordAdmissionHold('medium');

            const stats = sa.getAdmissionHoldStats();
            expect(stats.total).toBe(3);
            expect(stats.byTier.heavy).toBe(2);
            expect(stats.byTier.medium).toBe(1);
            expect(stats.byTier.light).toBe(0);
        });

        test('recordAdmissionHoldComplete accumulates holdMs for succeeded', () => {
            sa.recordAdmissionHoldComplete(500, true);
            sa.recordAdmissionHoldComplete(1200, true);

            const stats = sa.getAdmissionHoldStats();
            expect(stats.totalHoldMs).toBe(1700);
            expect(stats.succeeded).toBe(2);
            expect(stats.timedOut).toBe(0);
        });

        test('recordAdmissionHoldComplete accumulates for timedOut', () => {
            sa.recordAdmissionHoldComplete(15000, false);
            sa.recordAdmissionHoldComplete(10000, false);

            const stats = sa.getAdmissionHoldStats();
            expect(stats.totalHoldMs).toBe(25000);
            expect(stats.succeeded).toBe(0);
            expect(stats.timedOut).toBe(2);
        });

        test('recordAdmissionHoldRejected increments rejected', () => {
            sa.recordAdmissionHoldRejected();
            sa.recordAdmissionHoldRejected();
            sa.recordAdmissionHoldRejected();

            const stats = sa.getAdmissionHoldStats();
            expect(stats.rejected).toBe(3);
        });

        test('getAdmissionHoldStats returns raw counters', () => {
            sa.recordAdmissionHold('heavy');
            sa.recordAdmissionHoldComplete(500, true);
            sa.recordAdmissionHoldRejected();

            const stats = sa.getAdmissionHoldStats();
            expect(stats).toEqual({
                total: 1,
                totalHoldMs: 500,
                succeeded: 1,
                timedOut: 0,
                rejected: 1,
                byTier: { light: 0, medium: 0, heavy: 1 }
            });
        });

        test('reset clears admission hold tracking', () => {
            sa.recordAdmissionHold('heavy');
            sa.recordAdmissionHoldComplete(500, true);
            sa.recordAdmissionHoldRejected();

            sa.reset();

            const stats = sa.getAdmissionHoldStats();
            expect(stats.total).toBe(0);
            expect(stats.totalHoldMs).toBe(0);
            expect(stats.succeeded).toBe(0);
            expect(stats.timedOut).toBe(0);
            expect(stats.rejected).toBe(0);
            expect(stats.byTier).toEqual({ light: 0, medium: 0, heavy: 0 });
        });
    });

    describe('pool 429 penalty stats', () => {
        test('StatsController handleStats includes pool429Penalty when modelRouter present', () => {
            // Import StatsController
            const { StatsController } = require('../lib/proxy/controllers/stats-controller');

            const mockModelRouter = {
                getPool429PenaltyStats: jest.fn().mockReturnValue({
                    enabled: true,
                    windowMs: 120000,
                    trackedModels: 2,
                    byModel: {
                        'glm-4-plus': { hits: 5, lastSeenMs: 100, decayEtaMs: 60000 },
                        'glm-4.5-air': { hits: 1, lastSeenMs: 200, decayEtaMs: 90000 }
                    }
                }),
                getStats: jest.fn().mockReturnValue({})
            };

            const mockKeyManager = {
                getStats: jest.fn().mockReturnValue([]),
                getPoolRateLimitStats: jest.fn().mockReturnValue({}),
                getPoolAverageLatency: jest.fn().mockReturnValue(0)
            };

            const controller = new StatsController({
                statsAggregator: sa,
                keyManager: mockKeyManager,
                modelRouter: mockModelRouter,
                getUptime: () => 1000,
                config: { poolCooldown: {} }
            });

            let responseBody;
            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn((body) => { responseBody = body; })
            };

            controller.handleStats({ method: 'GET' }, mockRes);

            const stats = JSON.parse(responseBody);
            expect(stats.pool429Penalty).toBeDefined();
            expect(stats.pool429Penalty.enabled).toBe(true);
            expect(stats.pool429Penalty.byModel['glm-4-plus'].hits).toBe(5);
        });

        test('Prometheus metrics include pool_429_penalty_hits gauge', () => {
            const { StatsController, appendMonth1Metrics } = require('../lib/proxy/controllers/stats-controller');

            const stats = {
                giveUpTracking: {},
                retryEfficiency: {},
                retryBackoff: {},
                admissionHold: {},
                pool429Penalty: {
                    enabled: true,
                    windowMs: 120000,
                    trackedModels: 2,
                    byModel: {
                        'glm-4-plus': { hits: 7, lastSeenMs: 50, decayEtaMs: 30000 },
                        'glm-4.5-air': { hits: 2, lastSeenMs: 100, decayEtaMs: 60000 }
                    }
                }
            };

            const lines = [];
            appendMonth1Metrics(lines, stats, null);

            const output = lines.join('\n');
            expect(output).toContain('glm_proxy_pool_429_penalty_hits');
            expect(output).toContain('glm_proxy_pool_429_penalty_hits{model="glm-4-plus"} 7');
            expect(output).toContain('glm_proxy_pool_429_penalty_hits{model="glm-4.5-air"} 2');
        });
    });

    describe('per-model latency tracking', () => {
        test('should track per-model latency in RingBuffer', () => {
            sa.recordModelUsage('glm-5', { success: true, latencyMs: 50000 });
            sa.recordModelUsage('glm-5', { success: true, latencyMs: 60000 });
            sa.recordModelUsage('glm-5', { success: true, latencyMs: 70000 });
            sa.recordModelUsage('glm-5', { success: true, latencyMs: 80000 });
            sa.recordModelUsage('glm-5', { success: true, latencyMs: 90000 });

            const p95 = sa.getModelP95('glm-5');
            expect(p95).toBeDefined();
            expect(p95).toBeGreaterThanOrEqual(80000);
        });

        test('should return null for unknown model', () => {
            expect(sa.getModelP95('unknown-model')).toBeNull();
        });

        test('should return null with insufficient samples', () => {
            sa.recordModelUsage('glm-5', { success: true, latencyMs: 50000 });
            sa.recordModelUsage('glm-5', { success: true, latencyMs: 60000 });
            // Only 2 samples, need at least 5
            expect(sa.getModelP95('glm-5')).toBeNull();
        });

        test('should not track latency for failed requests', () => {
            for (let i = 0; i < 10; i++) {
                sa.recordModelUsage('glm-5', { success: false, latencyMs: 50000 + i * 1000 });
            }
            expect(sa.getModelP95('glm-5')).toBeNull();
        });

        test('should track separate RingBuffers per model', () => {
            // glm-5: heavy (high latency)
            for (let i = 0; i < 10; i++) {
                sa.recordModelUsage('glm-5', { success: true, latencyMs: 70000 + i * 1000 });
            }
            // glm-4.5-air: light (low latency)
            for (let i = 0; i < 10; i++) {
                sa.recordModelUsage('glm-4.5-air', { success: true, latencyMs: 1000 + i * 100 });
            }

            const heavyP95 = sa.getModelP95('glm-5');
            const lightP95 = sa.getModelP95('glm-4.5-air');

            expect(heavyP95).toBeGreaterThan(70000);
            expect(lightP95).toBeLessThan(5000);
        });

        test('should include p95LatencyMs in getModelStats', () => {
            for (let i = 0; i < 10; i++) {
                sa.recordModelUsage('glm-5', { success: true, latencyMs: 50000 + i * 5000 });
            }

            const stats = sa.getModelStats();
            expect(stats['glm-5'].p95LatencyMs).toBeDefined();
            expect(stats['glm-5'].p95LatencyMs).toBeGreaterThan(0);
        });

        test('should not track latency when latencyMs is missing', () => {
            for (let i = 0; i < 10; i++) {
                sa.recordModelUsage('glm-5', { success: true });
            }
            expect(sa.getModelP95('glm-5')).toBeNull();
        });
    });
});
