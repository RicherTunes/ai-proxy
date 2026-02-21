/**
 * Stats Aggregator Extended Tests
 * Covers uncovered lines: 168, 242-245, 315-322, 327-340, 345,
 * 513-531, 706, 746-764, 771, 777-778, 1001-1053, 1076-1103, 1213-1221
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { StatsAggregator } = require('../lib/stats-aggregator');

describe('StatsAggregator - Extended Coverage', () => {
    let sa;
    let testDir;
    const testFile = 'test-extended-stats.json';

    beforeEach(() => {
        testDir = path.join(os.tmpdir(), `sa-ext-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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
        try {
            fs.rmSync(testDir, { recursive: true, force: true });
        } catch (_) {
            // best-effort cleanup
        }
    });

    // ================================================================
    // 1. recordError - extended switch cases (lines 314-345)
    // ================================================================
    describe('recordError extended patterns', () => {
        test('should track dns_error', () => {
            sa.recordError('dns_error');
            sa.recordError('dns_error');
            expect(sa.errors.dnsErrors).toBe(2);
        });

        test('should track tls_error', () => {
            sa.recordError('tls_error');
            expect(sa.errors.tlsErrors).toBe(1);
        });

        test('should track client_disconnect', () => {
            sa.recordError('client_disconnect');
            expect(sa.errors.clientDisconnects).toBe(1);
        });

        test('should track auth_error', () => {
            sa.recordError('auth_error');
            sa.recordError('auth_error');
            sa.recordError('auth_error');
            expect(sa.errors.authErrors).toBe(3);
        });

        test('should track broken_pipe', () => {
            sa.recordError('broken_pipe');
            expect(sa.errors.brokenPipe).toBe(1);
        });

        test('should track connection_aborted', () => {
            sa.recordError('connection_aborted');
            expect(sa.errors.connectionAborted).toBe(1);
        });

        test('should track stream_premature_close', () => {
            sa.recordError('stream_premature_close');
            expect(sa.errors.streamPrematureClose).toBe(1);
        });

        test('should track http_parse_error', () => {
            sa.recordError('http_parse_error');
            expect(sa.errors.httpParseError).toBe(1);
        });

        test('should increment other for unknown type and log errorDetails', () => {
            const logSpy = jest.fn();
            sa.logger = { debug: logSpy, info: jest.fn(), warn: jest.fn(), error: jest.fn() };

            sa.recordError('some_weird_error', { code: 'EFOO', message: 'weird' });

            expect(sa.errors.other).toBe(1);
            expect(logSpy).toHaveBeenCalledWith(
                'Unrecognized error type: some_weird_error',
                { code: 'EFOO', message: 'weird' }
            );
        });

        test('should not log when default case has no errorDetails', () => {
            const logSpy = jest.fn();
            sa.logger = { debug: logSpy, info: jest.fn(), warn: jest.fn(), error: jest.fn() };

            sa.recordError('bizarre_error');

            expect(sa.errors.other).toBe(1);
            expect(logSpy).not.toHaveBeenCalled();
        });
    });

    // ================================================================
    // 2. Connection health: recordSocketHangup, recordConnectionSuccess,
    //    recordAgentRecreation (lines 512-534)
    // ================================================================
    describe('connection health tracking', () => {
        test('recordSocketHangup should increment totalHangups and consecutiveHangups', () => {
            sa.recordSocketHangup();
            sa.recordSocketHangup();

            expect(sa.connectionHealth.totalHangups).toBe(2);
            expect(sa.connectionHealth.consecutiveHangups).toBe(2);
        });

        test('recordConnectionSuccess should reset consecutiveHangups to 0', () => {
            sa.recordSocketHangup();
            sa.recordSocketHangup();
            sa.recordSocketHangup();
            expect(sa.connectionHealth.consecutiveHangups).toBe(3);

            sa.recordConnectionSuccess();
            expect(sa.connectionHealth.consecutiveHangups).toBe(0);
            // totalHangups should not be affected
            expect(sa.connectionHealth.totalHangups).toBe(3);
        });

        test('recordAgentRecreation should update all recreation fields', () => {
            const warnSpy = jest.fn();
            sa.logger = { info: jest.fn(), warn: warnSpy, error: jest.fn(), debug: jest.fn() };

            // Build up some consecutive hangups first
            sa.recordSocketHangup();
            sa.recordSocketHangup();

            sa.recordAgentRecreation();

            expect(sa.connectionHealth.agentRecreations).toBe(1);
            expect(sa.connectionHealth.lastRecreationAt).not.toBeNull();
            // Consecutive hangups reset after recreation
            expect(sa.connectionHealth.consecutiveHangups).toBe(0);
            // Logger should have been called with warning
            expect(warnSpy).toHaveBeenCalledWith('HTTPS agent recreated', { totalRecreations: 1 });
        });

        test('recordAgentRecreation should increment recreation count across multiple calls', () => {
            sa.recordAgentRecreation();
            sa.recordAgentRecreation();
            sa.recordAgentRecreation();

            expect(sa.connectionHealth.agentRecreations).toBe(3);
        });
    });

    // ================================================================
    // 3. getFullStats (lines 727-860)
    // ================================================================
    describe('getFullStats', () => {
        function createMockKeyManager(overrides = {}) {
            return {
                getStats: () => overrides.stats || [{
                    index: 0,
                    totalRequests: 100,
                    successCount: 95,
                    inFlight: 2,
                    successRate: 95,
                    latency: { avg: 500, min: 100, max: 2000, p50: 450, p95: 1500, p99: 1900, samples: 50 },
                    circuitBreaker: { state: 'CLOSED', failureCount: 3, recentFailures: 1, lastError: null, failureTimestamps: [] },
                    healthScore: 85,
                    lastUsed: '2026-02-07T10:00:00Z',
                    lastSuccess: '2026-02-07T10:00:00Z',
                    rateLimit: {},
                    rateLimitTracking: { inCooldown: false, count: 0 }
                }],
                circuitBreakerConfig: overrides.cbConfig || { failureThreshold: 5 },
                getPoolAverageLatency: overrides.poolLatency || (() => 500),
                getPoolRateLimitStats: overrides.poolRateLimit || (() => ({ isRateLimited: false }))
            };
        }

        test('should return full stats object with expected top-level keys', () => {
            const km = createMockKeyManager();
            const result = sa.getFullStats(km, 120);

            expect(result).toHaveProperty('uptime', 120);
            expect(result).toHaveProperty('uptimeFormatted');
            expect(result).toHaveProperty('clientRequests');
            expect(result).toHaveProperty('successRate');
            expect(result).toHaveProperty('keyAttempts');
            expect(result).toHaveProperty('totalRequests');
            expect(result).toHaveProperty('requestsPerMinute');
            expect(result).toHaveProperty('latency');
            expect(result).toHaveProperty('circuitBreaker');
            expect(result).toHaveProperty('keys');
            expect(result).toHaveProperty('errors');
            expect(result).toHaveProperty('tokens');
            expect(result).toHaveProperty('connectionHealth');
            expect(result).toHaveProperty('hangupCauses');
            expect(result).toHaveProperty('telemetry');
            expect(result).toHaveProperty('rateLimitTracking');
            expect(result).toHaveProperty('adaptiveTimeouts');
            expect(result).toHaveProperty('healthScoreDistribution');
            expect(result).toHaveProperty('poolAverageLatency');
            expect(result).toHaveProperty('poolRateLimitStatus');
            expect(result).toHaveProperty('rateLimitStatus');
        });

        test('should compute weighted average latency across multiple keys', () => {
            const km = createMockKeyManager({
                stats: [
                    {
                        index: 0, totalRequests: 100, successCount: 90, inFlight: 0, successRate: 90,
                        latency: { avg: 200, min: 50, max: 800, p50: 180, p95: 700, p99: 780, samples: 40 },
                        circuitBreaker: { state: 'CLOSED', failureCount: 0, recentFailures: 0, lastError: null, failureTimestamps: [] },
                        healthScore: 90, lastUsed: null, lastSuccess: null, rateLimit: {},
                        rateLimitTracking: { inCooldown: false, count: 0 }
                    },
                    {
                        index: 1, totalRequests: 50, successCount: 45, inFlight: 0, successRate: 90,
                        latency: { avg: 600, min: 200, max: 3000, p50: 550, p95: 2500, p99: 2900, samples: 10 },
                        circuitBreaker: { state: 'CLOSED', failureCount: 0, recentFailures: 0, lastError: null, failureTimestamps: [] },
                        healthScore: 80, lastUsed: null, lastSuccess: null, rateLimit: {},
                        rateLimitTracking: { inCooldown: false, count: 0 }
                    }
                ]
            });

            const result = sa.getFullStats(km, 300);

            // Weighted avg: (200*40 + 600*10) / (40+10) = (8000+6000)/50 = 280
            expect(result.latency.avg).toBe(280);
            expect(result.latency.min).toBe(50);
            expect(result.latency.max).toBe(3000);
            expect(result.latency.samples).toBe(50);
        });

        test('should compute weighted percentiles (p50/p95/p99)', () => {
            const km = createMockKeyManager({
                stats: [
                    {
                        index: 0, totalRequests: 80, successCount: 78, inFlight: 1, successRate: 97.5,
                        latency: { avg: 300, min: 100, max: 1000, p50: 250, p95: 900, p99: 950, samples: 30 },
                        circuitBreaker: { state: 'CLOSED', failureCount: 0, recentFailures: 0, lastError: null, failureTimestamps: [] },
                        healthScore: 95, lastUsed: null, lastSuccess: null, rateLimit: {},
                        rateLimitTracking: { inCooldown: false, count: 0 }
                    },
                    {
                        index: 1, totalRequests: 20, successCount: 18, inFlight: 0, successRate: 90,
                        latency: { avg: 700, min: 300, max: 2000, p50: 650, p95: 1800, p99: 1950, samples: 20 },
                        circuitBreaker: { state: 'CLOSED', failureCount: 0, recentFailures: 0, lastError: null, failureTimestamps: [] },
                        healthScore: 70, lastUsed: null, lastSuccess: null, rateLimit: {},
                        rateLimitTracking: { inCooldown: false, count: 0 }
                    }
                ]
            });

            const result = sa.getFullStats(km, 60);

            // Weighted p50: (250*30 + 650*20) / (30+20) = (7500+13000)/50 = 410
            expect(result.latency.p50).toBe(410);
            // Weighted p95: (900*30 + 1800*20) / 50 = (27000+36000)/50 = 1260
            expect(result.latency.p95).toBe(1260);
            // Weighted p99: (950*30 + 1950*20) / 50 = (28500+39000)/50 = 1350
            expect(result.latency.p99).toBe(1350);
        });

        test('should handle keys with zero latency samples', () => {
            const km = createMockKeyManager({
                stats: [{
                    index: 0, totalRequests: 10, successCount: 0, inFlight: 0, successRate: 0,
                    latency: { avg: 0, min: 0, max: 0, p50: null, p95: null, p99: null, samples: 0 },
                    circuitBreaker: { state: 'OPEN', failureCount: 10, recentFailures: 10, lastError: 'timeout', failureTimestamps: [] },
                    healthScore: 0, lastUsed: null, lastSuccess: null, rateLimit: {},
                    rateLimitTracking: { inCooldown: false, count: 0 }
                }]
            });

            const result = sa.getFullStats(km, 60);

            expect(result.latency.avg).toBeNull();
            expect(result.latency.min).toBeNull();
            expect(result.latency.max).toBeNull();
            expect(result.latency.p50).toBeNull();
            expect(result.latency.samples).toBe(0);
        });

        test('should include circuitBreaker config from keyManager', () => {
            const km = createMockKeyManager({ cbConfig: { failureThreshold: 10, cooldownMs: 30000 } });
            const result = sa.getFullStats(km, 60);

            expect(result.circuitBreaker).toEqual({ failureThreshold: 10, cooldownMs: 30000 });
        });

        test('should integrate client request stats as primary success rate', () => {
            sa.recordClientRequestStart();
            sa.recordClientRequestStart();
            sa.recordClientRequestStart();
            sa.recordClientRequestSuccess();
            sa.recordClientRequestSuccess();
            sa.recordClientRequestFailure();

            const km = createMockKeyManager();
            const result = sa.getFullStats(km, 60);

            expect(result.clientRequests.total).toBe(3);
            expect(result.clientRequests.succeeded).toBe(2);
            expect(result.clientRequests.failed).toBe(1);
            expect(result.successRate).toBe(66.7);
            // totalRequests should be client total
            expect(result.totalRequests).toBe(3);
        });

        test('should calculate requestsPerMinute correctly', () => {
            // uptime 120 seconds = 2 minutes
            sa.recordClientRequestStart();
            sa.recordClientRequestStart();
            sa.recordClientRequestStart();
            sa.recordClientRequestStart();

            const km = createMockKeyManager();
            const result = sa.getFullStats(km, 120);

            // 4 requests / 2 minutes = 2.0
            expect(result.requestsPerMinute).toBe(2);
        });

        test('should return 0 requestsPerMinute when uptime is 0', () => {
            sa.recordClientRequestStart();

            const km = createMockKeyManager();
            const result = sa.getFullStats(km, 0);

            expect(result.requestsPerMinute).toBe(0);
        });

        test('should pass through queueStats when provided', () => {
            const km = createMockKeyManager();
            const queueStats = { queued: 5, processing: 2, maxSize: 100 };
            const result = sa.getFullStats(km, 60, queueStats);

            expect(result.queue).toEqual(queueStats);
        });

        test('should map key stats with OPEN circuit breaker fields', () => {
            const km = createMockKeyManager({
                stats: [{
                    index: 0, totalRequests: 50, successCount: 40, inFlight: 0, successRate: 80,
                    latency: { avg: 500, min: 100, max: 2000, p50: 450, p95: 1500, p99: 1900, samples: 30 },
                    circuitBreaker: {
                        state: 'OPEN', failureCount: 5, recentFailures: 5, lastError: 'timeout',
                        failureTimestamps: [], openedAt: '2026-02-07T09:50:00Z', cooldownRemaining: 15000
                    },
                    healthScore: 10, lastUsed: '2026-02-07T10:00:00Z', lastSuccess: '2026-02-07T09:50:00Z',
                    rateLimit: { retryAfter: 10 },
                    rateLimitTracking: { inCooldown: true, count: 3 }
                }]
            });

            const result = sa.getFullStats(km, 60);
            const key = result.keys[0];

            expect(key.state).toBe('OPEN');
            expect(key.openedAt).toBe('2026-02-07T09:50:00Z');
            expect(key.cooldownRemaining).toBe(15); // 15000 / 1000 rounded
            expect(key.lastError).toBe('timeout');
        });

        test('should include latency spread when min and max are available', () => {
            const km = createMockKeyManager();
            const result = sa.getFullStats(km, 60);

            // spread = max / min = 2000 / 100 = 20.0
            expect(result.latency.spread).toBe(20);
        });

        test('should include pool-level stats', () => {
            const km = createMockKeyManager({
                poolLatency: () => 750,
                poolRateLimit: () => ({ isRateLimited: true, cooldownMs: 5000 })
            });
            const result = sa.getFullStats(km, 60);

            expect(result.poolAverageLatency).toBe(750);
            expect(result.poolRateLimitStatus).toEqual({ isRateLimited: true, cooldownMs: 5000 });
        });
    });

    // ================================================================
    // 4. _formatUptime (all branches) - line 887-897
    // ================================================================
    describe('_formatUptime', () => {
        test('should format seconds only (< 1 minute)', () => {
            expect(sa._formatUptime(45)).toBe('45s');
        });

        test('should format 0 seconds', () => {
            expect(sa._formatUptime(0)).toBe('0s');
        });

        test('should format minutes and seconds', () => {
            expect(sa._formatUptime(125)).toBe('2m 5s');
        });

        test('should format hours, minutes, and seconds', () => {
            // 2h 30m 15s = 9015s
            expect(sa._formatUptime(9015)).toBe('2h 30m 15s');
        });

        test('should format days, hours, and minutes', () => {
            // 1d 5h 30m = 86400 + 18000 + 1800 = 106200s
            expect(sa._formatUptime(106200)).toBe('1d 5h 30m');
        });

        test('should handle exact hour boundary', () => {
            expect(sa._formatUptime(3600)).toBe('1h 0m 0s');
        });

        test('should handle exact day boundary', () => {
            expect(sa._formatUptime(86400)).toBe('1d 0h 0m');
        });

        test('should truncate fractional seconds', () => {
            expect(sa._formatUptime(45.7)).toBe('45s');
        });
    });

    // ================================================================
    // 5. resetErrors (lines 1000-1016)
    // ================================================================
    describe('resetErrors', () => {
        test('should reset all error counters to zero', () => {
            sa.recordError('timeout');
            sa.recordError('dns_error');
            sa.recordError('tls_error');
            sa.recordError('auth_error');
            sa.recordError('broken_pipe');
            sa.recordError('connection_aborted');
            sa.recordError('stream_premature_close');
            sa.recordError('http_parse_error');
            sa.recordError('client_disconnect');
            sa.recordError('unknown_thing');
            sa.recordRetry();
            sa.recordRetrySuccess();

            sa.resetErrors();

            // These fields are present in the resetErrors() template
            expect(sa.errors.timeouts).toBe(0);
            expect(sa.errors.dnsErrors).toBe(0);
            expect(sa.errors.tlsErrors).toBe(0);
            expect(sa.errors.authErrors).toBe(0);
            expect(sa.errors.clientDisconnects).toBe(0);
            expect(sa.errors.other).toBe(0);
            expect(sa.errors.totalRetries).toBe(0);
            expect(sa.errors.retriesSucceeded).toBe(0);
            expect(sa.errors.socketHangups).toBe(0);
            expect(sa.errors.connectionRefused).toBe(0);
            expect(sa.errors.serverErrors).toBe(0);
            expect(sa.errors.rateLimited).toBe(0);

            // These 4 fields were missing from resetErrors() — now fixed
            expect(sa.errors.brokenPipe).toBe(0);
            expect(sa.errors.connectionAborted).toBe(0);
            expect(sa.errors.streamPrematureClose).toBe(0);
            expect(sa.errors.httpParseError).toBe(0);
        });

        test('should not affect non-error state (stats, clientRequests, etc.)', () => {
            sa.recordKeyUsage('key1', { requests: 10, successes: 9, failures: 1 });
            sa.recordClientRequestStart();
            sa.recordClientRequestSuccess();
            sa.recordError('timeout');

            sa.resetErrors();

            expect(sa.stats.totals.requests).toBe(10);
            expect(sa.clientRequests.succeeded).toBe(1);
            expect(sa.errors.timeouts).toBe(0);
        });

        test('should log info message when logger is present', () => {
            const infoSpy = jest.fn();
            sa.logger = { info: infoSpy, warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

            sa.resetErrors();

            expect(infoSpy).toHaveBeenCalledWith('Error stats reset', undefined);
        });
    });

    // ================================================================
    // 6. recordTokenUsage + getTokenStats + resetTokenStats
    //    (lines 1025-1103)
    // ================================================================
    describe('token tracking', () => {
        test('recordTokenUsage should accumulate global token counts', () => {
            sa.recordTokenUsage('key-a', { input_tokens: 100, output_tokens: 50 });
            sa.recordTokenUsage('key-a', { input_tokens: 200, output_tokens: 100 });

            expect(sa.tokens.totalInputTokens).toBe(300);
            expect(sa.tokens.totalOutputTokens).toBe(150);
            expect(sa.tokens.totalTokens).toBe(450);
            expect(sa.tokens.requestCount).toBe(2);
        });

        test('recordTokenUsage should accept camelCase keys (inputTokens)', () => {
            sa.recordTokenUsage('key-b', { inputTokens: 50, outputTokens: 25 });

            expect(sa.tokens.totalInputTokens).toBe(50);
            expect(sa.tokens.totalOutputTokens).toBe(25);
        });

        test('recordTokenUsage should skip when total is 0', () => {
            sa.recordTokenUsage('key-c', {});
            sa.recordTokenUsage('key-c', { input_tokens: 0, output_tokens: 0 });

            expect(sa.tokens.requestCount).toBe(0);
            expect(sa.dirty).toBe(false);
        });

        test('recordTokenUsage should track per-key stats', () => {
            sa.recordTokenUsage('key-a', { input_tokens: 100, output_tokens: 50 });
            sa.recordTokenUsage('key-b', { input_tokens: 200, output_tokens: 80 });
            sa.recordTokenUsage('key-a', { input_tokens: 50, output_tokens: 20 });

            const keyA = sa.tokens.byKeyId.get('key-a');
            expect(keyA.totalInputTokens).toBe(150);
            expect(keyA.totalOutputTokens).toBe(70);
            expect(keyA.totalTokens).toBe(220);
            expect(keyA.requestCount).toBe(2);

            const keyB = sa.tokens.byKeyId.get('key-b');
            expect(keyB.totalInputTokens).toBe(200);
            expect(keyB.totalOutputTokens).toBe(80);
            expect(keyB.requestCount).toBe(1);
        });

        test('recordTokenUsage should set dirty flag', () => {
            expect(sa.dirty).toBe(false);
            sa.recordTokenUsage('key-x', { input_tokens: 10, output_tokens: 5 });
            expect(sa.dirty).toBe(true);
        });

        test('getTokenStats should return per-key averages', () => {
            sa.recordTokenUsage('key-a', { input_tokens: 100, output_tokens: 40 });
            sa.recordTokenUsage('key-a', { input_tokens: 200, output_tokens: 60 });

            const stats = sa.getTokenStats();

            expect(stats.byKey['key-a']).toBeDefined();
            expect(stats.byKey['key-a'].avgInputPerRequest).toBe(150);  // (100+200)/2
            expect(stats.byKey['key-a'].avgOutputPerRequest).toBe(50);  // (40+60)/2
        });

        test('getTokenStats should return global averages', () => {
            sa.recordTokenUsage('k1', { input_tokens: 100, output_tokens: 50 });
            sa.recordTokenUsage('k2', { input_tokens: 300, output_tokens: 150 });

            const stats = sa.getTokenStats();

            expect(stats.avgInputPerRequest).toBe(200);   // (100+300)/2
            expect(stats.avgOutputPerRequest).toBe(100);   // (50+150)/2
            expect(stats.avgTotalPerRequest).toBe(300);    // (150+450)/2 = 600/2
        });

        test('getTokenStats should return 0 averages when no requests', () => {
            const stats = sa.getTokenStats();

            expect(stats.avgInputPerRequest).toBe(0);
            expect(stats.avgOutputPerRequest).toBe(0);
            expect(stats.avgTotalPerRequest).toBe(0);
            expect(stats.byKey).toEqual({});
        });

        test('resetTokenStats should clear all token data', () => {
            sa.recordTokenUsage('key-a', { input_tokens: 500, output_tokens: 200 });
            sa.recordTokenUsage('key-b', { input_tokens: 300, output_tokens: 100 });

            sa.resetTokenStats();

            expect(sa.tokens.totalInputTokens).toBe(0);
            expect(sa.tokens.totalOutputTokens).toBe(0);
            expect(sa.tokens.totalTokens).toBe(0);
            expect(sa.tokens.requestCount).toBe(0);
            // byKeyId should be a new empty LRUMap
            expect(sa.tokens.byKeyId.size).toBe(0);
        });

        test('resetTokenStats should log info message', () => {
            const infoSpy = jest.fn();
            sa.logger = { info: infoSpy, warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

            sa.resetTokenStats();

            expect(infoSpy).toHaveBeenCalledWith('Token stats reset', undefined);
        });
    });

    // ================================================================
    // 7. _notifyRequestListeners error handling (line 1213)
    // ================================================================
    describe('_notifyRequestListeners error handling', () => {
        test('a throwing listener should not crash and should not prevent other listeners', () => {
            const errorSpy = jest.fn();
            sa.logger = { info: jest.fn(), warn: jest.fn(), error: errorSpy, debug: jest.fn() };

            const badListener = () => { throw new Error('listener boom'); };
            const goodListener = jest.fn();

            sa.addRequestListener(badListener);
            sa.addRequestListener(goodListener);

            // This should not throw even though badListener throws
            expect(() => sa.recordRequest({ id: 'req_safe' })).not.toThrow();

            // The good listener should still have been called
            expect(goodListener).toHaveBeenCalledWith(expect.objectContaining({ id: 'req_safe' }));

            // The error should have been logged
            expect(errorSpy).toHaveBeenCalledWith(
                'Request listener error',
                { error: 'listener boom' }
            );
        });
    });

    // ================================================================
    // 8. getAggregatedRealtimeStats with multiple workers (line 706 area)
    // ================================================================
    describe('getAggregatedRealtimeStats with workers', () => {
        test('should aggregate multiple workers with overlapping keys', () => {
            sa.updateWorkerStats('w1', {
                totalRequests: 50,
                keys: [
                    { index: 0, inFlight: 2, total: 30, successes: 28, state: 'CLOSED', avgLatency: 200, lastUsed: '2026-02-07T09:00:00Z' },
                    { index: 1, inFlight: 1, total: 20, successes: 19, state: 'CLOSED', avgLatency: 300, lastUsed: '2026-02-07T09:00:00Z' }
                ]
            });
            sa.updateWorkerStats('w2', {
                totalRequests: 40,
                keys: [
                    { index: 0, inFlight: 1, total: 25, successes: 24, state: 'CLOSED', avgLatency: 250, lastUsed: '2026-02-07T09:10:00Z' },
                    { index: 2, inFlight: 0, total: 15, successes: 15, state: 'CLOSED', avgLatency: 150, lastUsed: '2026-02-07T09:10:00Z' }
                ]
            });

            const result = sa.getAggregatedRealtimeStats();

            expect(result.totalRequests).toBe(90);
            // Keys should be sorted by index
            expect(result.keys).toHaveLength(3);
            expect(result.keys[0].index).toBe(0);
            expect(result.keys[1].index).toBe(1);
            expect(result.keys[2].index).toBe(2);

            // Key 0 is aggregated from w1+w2
            expect(result.keys[0].inFlight).toBe(3);       // 2+1
            expect(result.keys[0].totalRequests).toBe(55);  // 30+25
            expect(result.keys[0].successes).toBe(52);      // 28+24

            // Key 1 is only from w1
            expect(result.keys[1].inFlight).toBe(1);
            expect(result.keys[1].totalRequests).toBe(20);

            // Key 2 is only from w2
            expect(result.keys[2].inFlight).toBe(0);
            expect(result.keys[2].totalRequests).toBe(15);
        });

        test('should handle workers with no keys property', () => {
            sa.updateWorkerStats('w1', { totalRequests: 10 });
            sa.setActiveConnections(5);

            const result = sa.getAggregatedRealtimeStats();

            expect(result.totalRequests).toBe(10);
            expect(result.activeConnections).toBe(5);
            expect(result.keys).toEqual([]);
        });
    });

    // ================================================================
    // 9. load with newer schema version (line 167-168)
    // ================================================================
    describe('load with newer schema version', () => {
        test('should log a warning when file has a newer schema version', () => {
            const warnSpy = jest.fn();
            sa.logger = { info: jest.fn(), warn: warnSpy, error: jest.fn(), debug: jest.fn() };

            const futureStats = {
                schemaVersion: 99,
                firstSeen: '2026-01-01T00:00:00Z',
                lastUpdated: '2026-01-02T00:00:00Z',
                keys: { 'sk-abc': { totalRequests: 42, successes: 40, failures: 2, keyPrefix: 'sk-abc' } },
                totals: { requests: 42, successes: 40, failures: 2, retries: 1 }
            };

            fs.writeFileSync(
                path.join(testDir, testFile),
                JSON.stringify(futureStats)
            );

            const result = sa.load();

            expect(result).toBe(true);
            expect(warnSpy).toHaveBeenCalledWith(
                'Stats file has newer schema (v99), loading with best effort',
                undefined
            );
            // Should still load the data
            expect(sa.stats.totals.requests).toBe(42);
            expect(sa.stats.keys['sk-abc'].totalRequests).toBe(42);
        });

        test('should not warn when schema version is current or older', () => {
            const warnSpy = jest.fn();
            sa.logger = { info: jest.fn(), warn: warnSpy, error: jest.fn(), debug: jest.fn() };

            const currentStats = {
                schemaVersion: 1,
                firstSeen: '2026-01-01T00:00:00Z',
                lastUpdated: '2026-01-02T00:00:00Z',
                keys: {},
                totals: { requests: 10, successes: 10, failures: 0, retries: 0 }
            };

            fs.writeFileSync(path.join(testDir, testFile), JSON.stringify(currentStats));

            sa.load();

            // Should NOT have been called with the schema warning
            expect(warnSpy).not.toHaveBeenCalledWith(
                expect.stringContaining('newer schema'),
                expect.anything()
            );
        });
    });

    // ================================================================
    // 10. destroy (lines 242-245)
    // ================================================================
    describe('destroy', () => {
        test('should set destroyed flag, stop auto-save, clear listeners, and flush', async () => {
            sa.startAutoSave();
            const listener = jest.fn();
            sa.addRequestListener(listener);

            sa.recordKeyUsage('key1', { requests: 1 });
            sa.save();

            await sa.destroy();

            expect(sa.destroyed).toBe(true);
            expect(sa.saveTimer).toBeNull();
            expect(sa.requestListeners.size).toBe(0);
        });
    });
});
