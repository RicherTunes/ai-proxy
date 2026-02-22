const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { UsageMonitor } = require('../lib/usage-monitor');

// --- Mock helpers ---

function mockKeyManager(keys = [{ key: 'test-key-1' }, { key: 'test-key-2' }]) {
    return { keys };
}

function mockLogger() {
    return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

/**
 * Setup synchronous https.get mock. Callbacks fire synchronously so that
 * promises resolve within the same microtask boundary as the timer callback,
 * allowing jest.advanceTimersByTimeAsync() to properly flush them.
 */
function setupHttpsMock(responses) {
    const calls = [];
    let callIndex = 0;

    jest.spyOn(https, 'get').mockImplementation((opts, cb) => {
        calls.push(opts);
        const fakeReq = new EventEmitter();
        fakeReq.destroy = jest.fn();

        const responseSpec = responses[callIndex % responses.length];
        callIndex++;

        if (responseSpec instanceof Error) {
            // Emit error on next microtask (so req is returned first)
            Promise.resolve().then(() => fakeReq.emit('error', responseSpec));
        } else if (responseSpec && responseSpec.timeout) {
            Promise.resolve().then(() => fakeReq.emit('timeout'));
        } else {
            const res = new EventEmitter();
            res.statusCode = responseSpec?.statusCode || 200;
            const body = responseSpec?.body || {};
            const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);

            // Call cb synchronously, then emit data/end on next microtask
            Promise.resolve().then(() => {
                cb(res);
                res.emit('data', bodyStr);
                res.emit('end');
            });
        }

        return fakeReq;
    });

    return calls;
}

// Standard mock responses — z.ai envelope format { code, msg, data, success }
const quotaResponse = {
    code: 200, msg: 'Operation successful', success: true,
    data: {
        limits: [
            {
                type: 'TIME_LIMIT', unit: 5, number: 1,
                usage: 4000, currentValue: 85, remaining: 3915, percentage: 2,
                nextResetTime: 1773976185998,
                usageDetails: [
                    { modelCode: 'search-prime', usage: 61 },
                    { modelCode: 'web-reader', usage: 24 }
                ]
            },
            {
                type: 'TOKENS_LIMIT', unit: 3, number: 5,
                percentage: 18, nextResetTime: 1771631247854
            }
        ],
        level: 'max'
    }
};

const modelUsageResponse = {
    code: 200, msg: 'Operation successful', success: true,
    data: {
        x_time: ['2026-02-19 19:00', '2026-02-19 20:00'],
        modelCallCount: [32, 16],
        tokensUsage: [1304455, 337315],
        totalUsage: { totalModelCallCount: 2406, totalTokensUsage: 99930426 }
    }
};

const toolUsageResponse = {
    code: 200, msg: 'Operation successful', success: true,
    data: {
        x_time: ['2026-02-19 19:00', '2026-02-19 20:00'],
        networkSearchCount: [null, null],
        webReadMcpCount: [null, null],
        zreadMcpCount: [null, null],
        totalUsage: {
            totalNetworkSearchCount: 61,
            totalWebReadMcpCount: 24,
            totalZreadMcpCount: 0,
            totalSearchMcpCount: 5,
            toolDetails: []
        }
    }
};

/** Advance fake timers AND flush microtasks */
async function advance(ms) {
    await jest.advanceTimersByTimeAsync(ms);
}

// Default config for tests: lookbackDays=0 disables backfill to avoid interference
const NO_BACKFILL = { lookbackDays: 0 };

// --- Tests ---

describe('UsageMonitor', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.restoreAllMocks();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('constructor', () => {
        it('uses default config when none provided', () => {
            const monitor = new UsageMonitor({}, { keyManager: mockKeyManager() });
            expect(monitor._config.pollIntervalMs).toBe(60000);
            expect(monitor._config.timeoutMs).toBe(10000);
            expect(monitor._config.jitterRatio).toBe(0.1);
            expect(monitor._config.maxJitterMs).toBe(2000);
            expect(monitor._config.backoffMultiplier).toBe(2);
            expect(monitor._config.backoffIntervalMs).toBe(300000);
            expect(monitor._config.maxConsecutiveErrors).toBe(5);
            expect(monitor._config.exposeDetails).toBe(false);
            expect(monitor._config.lookbackDays).toBe(30);
            expect(monitor._config.maxTimeSeriesPoints).toBe(10000);
        });

        it('merges custom config with defaults', () => {
            const monitor = new UsageMonitor(
                { pollIntervalMs: 30000, exposeDetails: true },
                { keyManager: mockKeyManager() }
            );
            expect(monitor._config.pollIntervalMs).toBe(30000);
            expect(monitor._config.exposeDetails).toBe(true);
            expect(monitor._config.timeoutMs).toBe(10000);
        });
    });

    describe('start() and stop()', () => {
        it('schedules first poll immediately on start()', async () => {
            const calls = setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            expect(calls.length).toBe(3);
            monitor.stop();
        });

        it('start() is idempotent (double start does not double poll)', async () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            monitor.start(); // second call is no-op

            await advance(2100);
            expect(https.get).toHaveBeenCalledTimes(3);
            monitor.stop();
        });

        it('stop() clears timer and destroys agent', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            expect(monitor._timer).not.toBeNull();
            expect(monitor._agent).not.toBeNull();

            const agent = monitor._agent;
            const destroySpy = jest.spyOn(agent, 'destroy');

            monitor.stop();
            expect(monitor._timer).toBeNull();
            expect(monitor._agent).toBeNull();
            expect(destroySpy).toHaveBeenCalled();
        });

        it('double stop() does not throw', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            monitor.stop();
            expect(() => monitor.stop()).not.toThrow();
        });
    });

    describe('polling and snapshot', () => {
        it('fetches all 3 endpoints with correct paths and auth', async () => {
            const calls = setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager([{ key: 'my-key' }]),
                logger: mockLogger(),
                targetHost: 'api.z.ai'
            });
            monitor.start();
            await advance(2100);

            expect(calls.length).toBe(3);
            expect(calls[0].path).toBe('/api/monitor/usage/quota/limit');
            expect(calls[1].path).toMatch(/^\/api\/monitor\/usage\/model-usage\?startTime=\d{4}-\d{2}-\d{2}/);
            expect(calls[2].path).toMatch(/^\/api\/monitor\/usage\/tool-usage\?startTime=\d{4}-\d{2}-\d{2}/);

            calls.forEach(c => {
                expect(c.headers.Authorization).toBe('my-key');
                expect(c.hostname).toBe('api.z.ai');
            });
            monitor.stop();
        });

        it('builds correct snapshot from successful responses', async () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            const snapshot = monitor.getSnapshot();
            expect(snapshot).not.toBeNull();
            expect(snapshot.schemaVersion).toBe(1);
            expect(snapshot.stale).toBe(false);
            expect(snapshot.partial).toBe(false);
            expect(snapshot.sourceUnavailable).toBe(false);
            expect(snapshot.lastPollAt).toBeGreaterThan(0);

            // Quota
            expect(snapshot.quota.level).toBe('max');
            expect(snapshot.quota.tokenUsagePercent).toBe(18);
            expect(snapshot.quota.tokenNextResetAt).toBe(1771631247854);
            expect(snapshot.quota.toolUsage.limit).toBe(4000);
            expect(snapshot.quota.toolUsage.used).toBe(85);
            expect(snapshot.quota.toolUsage.remaining).toBe(3915);
            expect(snapshot.quota.toolUsage.percent).toBe(2);
            expect(snapshot.quota.error).toBeNull();

            // Model usage — aggregate totals (z.ai returns time-series, not per-model)
            expect(snapshot.modelUsage.totalRequests).toBe(2406);
            expect(snapshot.modelUsage.totalTokens).toBe(99930426);
            expect(snapshot.modelUsage.error).toBeNull();
            // timeSeries always included for dashboard charts
            expect(snapshot.modelUsage.timeSeries).toBeDefined();
            expect(snapshot.modelUsage.timeSeries.times).toHaveLength(2);

            // Tool usage — aggregate counts
            expect(snapshot.toolUsage.tools.networkSearch).toBe(61);
            expect(snapshot.toolUsage.tools.webRead).toBe(24);
            expect(snapshot.toolUsage.tools.zread).toBe(0);
            expect(snapshot.toolUsage.tools.search).toBe(5);

            // Monitor health
            expect(snapshot._monitor.pollSuccessTotal).toBe(1);
            expect(snapshot._monitor.pollErrorTotal).toBe(0);

            monitor.stop();
        });

        it('returns null snapshot before first poll', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, { keyManager: mockKeyManager() });
            expect(monitor.getSnapshot()).toBeNull();
        });

        it('caches snapshot between polls', async () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            const snap1 = monitor.getSnapshot();
            const snap2 = monitor.getSnapshot();
            expect(snap1.lastPollAt).toBe(snap2.lastPollAt);
            expect(snap1.schemaVersion).toBe(snap2.schemaVersion);

            monitor.stop();
        });
    });

    describe('setTimeout-based scheduling', () => {
        it('schedules next poll at pollIntervalMs after success', async () => {
            const httpsCalls = setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse },
                // Second poll
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor({ pollIntervalMs: 30000, lookbackDays: 0 }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();

            // First poll
            await advance(2100);
            expect(httpsCalls.length).toBe(3);

            // Wait pollIntervalMs + jitter
            await advance(32100);
            expect(httpsCalls.length).toBe(6);

            monitor.stop();
        });

        it('uses bounded exponential delay after maxConsecutiveErrors', async () => {
            setupHttpsMock([new Error('connection refused')]);

            const monitor = new UsageMonitor({
                pollIntervalMs: 10000,
                backoffIntervalMs: 60000,
                maxConsecutiveErrors: 3,
                jitterRatio: 0,
                maxJitterMs: 0,
                lookbackDays: 0
            }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();

            // Polls 1-3: normal interval (10s)
            await advance(100);
            await advance(10100);
            await advance(10100);
            expect(monitor._consecutiveErrors).toBe(3);

            // After threshold, next error delay becomes 20s (10s * 2^1)
            expect(monitor._computeErrorDelayMs()).toBe(20000);
            const callsBefore = https.get.mock.calls.length;
            await advance(15000);
            expect(https.get.mock.calls.length).toBe(callsBefore);

            // Cross the 20s mark → next poll happens
            await advance(6000);
            expect(https.get.mock.calls.length).toBeGreaterThan(callsBefore);

            monitor.stop();
        });

        it('recovers from backoff after success', async () => {
            let pollCount = 0;
            jest.spyOn(https, 'get').mockImplementation((opts, cb) => {
                const fakeReq = new EventEmitter();
                fakeReq.destroy = jest.fn();

                // Track polls (each poll makes 3 calls, count by quota endpoint)
                if (opts.path.includes('quota')) pollCount++;

                // First 4 polls fail, then succeed
                if (pollCount <= 4) {
                    Promise.resolve().then(() => fakeReq.emit('error', new Error('fail')));
                } else {
                    const body = opts.path.includes('quota') ? quotaResponse
                        : opts.path.includes('model') ? modelUsageResponse
                        : toolUsageResponse;
                    const bodyStr = JSON.stringify(body);
                    const res = new EventEmitter();
                    res.statusCode = 200;
                    Promise.resolve().then(() => {
                        cb(res);
                        res.emit('data', bodyStr);
                        res.emit('end');
                    });
                }
                return fakeReq;
            });

            const monitor = new UsageMonitor({
                pollIntervalMs: 60000,
                backoffIntervalMs: 120000,
                maxConsecutiveErrors: 3,
                lookbackDays: 0
            }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();

            // Poll 1-3: fail at normal interval (60s each)
            await advance(2100);   // poll 1
            await advance(62100);  // poll 2
            await advance(62100);  // poll 3
            expect(monitor._consecutiveErrors).toBe(3);

            // Poll 4: backoff interval (120s), still fails
            await advance(122100);
            expect(monitor._consecutiveErrors).toBe(4);

            // Poll 5: backoff interval, now succeeds
            await advance(122100);
            expect(monitor._consecutiveErrors).toBe(0);
            expect(monitor._pollSuccessTotal).toBeGreaterThan(0);

            monitor.stop();
        });
    });

    describe('partial failure semantics', () => {
        it('quota fails, model/tool succeed → snapshot.quota has error, others populated', async () => {
            setupHttpsMock([
                { statusCode: 500, body: 'Internal Error' },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            const snapshot = monitor.getSnapshot();
            expect(snapshot.quota.error).toBeTruthy();
            expect(snapshot.modelUsage.totalRequests).toBe(2406);
            expect(snapshot.toolUsage.tools.networkSearch).toBe(61);
            expect(snapshot._monitor.pollSuccessTotal).toBe(1);
            expect(snapshot.partial).toBe(true);
            expect(snapshot.sourceUnavailable).toBe(false);

            monitor.stop();
        });

        it('per-section lastSuccessAt tracked independently', async () => {
            let callCount = 0;
            jest.spyOn(https, 'get').mockImplementation((opts, cb) => {
                const fakeReq = new EventEmitter();
                fakeReq.destroy = jest.fn();
                callCount++;

                if (callCount <= 3) {
                    // Poll 1: all succeed
                    const body = opts.path.includes('quota') ? quotaResponse
                        : opts.path.includes('model') ? modelUsageResponse
                        : toolUsageResponse;
                    const bodyStr = JSON.stringify(body);
                    const res = new EventEmitter();
                    res.statusCode = 200;
                    Promise.resolve().then(() => { cb(res); res.emit('data', bodyStr); res.emit('end'); });
                } else if (opts.path.includes('quota')) {
                    // Poll 2: quota fails
                    Promise.resolve().then(() => fakeReq.emit('error', new Error('quota down')));
                } else {
                    // Poll 2: model/tool succeed
                    const body = opts.path.includes('model') ? modelUsageResponse : toolUsageResponse;
                    const bodyStr = JSON.stringify(body);
                    const res = new EventEmitter();
                    res.statusCode = 200;
                    Promise.resolve().then(() => { cb(res); res.emit('data', bodyStr); res.emit('end'); });
                }
                return fakeReq;
            });

            const monitor = new UsageMonitor({ pollIntervalMs: 10000, lookbackDays: 0 }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();

            // Poll 1
            await advance(2100);
            const snap1 = monitor.getSnapshot();
            const quotaSuccess1 = snap1.quota.lastSuccessAt;
            expect(quotaSuccess1).toBeGreaterThan(0);

            // Poll 2 (quota fails)
            await advance(12100);
            const snap2 = monitor.getSnapshot();
            expect(snap2.quota.lastSuccessAt).toBe(quotaSuccess1);
            expect(snap2.quota.error).toBeTruthy();
            expect(snap2.modelUsage.lastSuccessAt).toBeGreaterThan(quotaSuccess1);

            monitor.stop();
        });

        it('retains previous successful data on error (not nulled)', async () => {
            let callCount = 0;
            jest.spyOn(https, 'get').mockImplementation((opts, cb) => {
                const fakeReq = new EventEmitter();
                fakeReq.destroy = jest.fn();
                callCount++;

                if (callCount <= 3) {
                    const body = opts.path.includes('quota') ? quotaResponse
                        : opts.path.includes('model') ? modelUsageResponse
                        : toolUsageResponse;
                    const bodyStr = JSON.stringify(body);
                    const res = new EventEmitter();
                    res.statusCode = 200;
                    Promise.resolve().then(() => { cb(res); res.emit('data', bodyStr); res.emit('end'); });
                } else {
                    Promise.resolve().then(() => fakeReq.emit('error', new Error('network down')));
                }
                return fakeReq;
            });

            const monitor = new UsageMonitor({ pollIntervalMs: 10000, lookbackDays: 0 }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();

            await advance(2100);
            const snap1 = monitor.getSnapshot();
            expect(snap1.quota.level).toBe('max');

            await advance(12100);
            const snap2 = monitor.getSnapshot();
            expect(snap2.quota.level).toBe('max');
            expect(snap2.quota.error).toBeTruthy();
            expect(snap2.partial).toBe(true);
            expect(snap2.sourceUnavailable).toBe(false);

            monitor.stop();
        });

        it('all usage endpoints failing marks sourceUnavailable=true and partial=false', async () => {
            setupHttpsMock([
                new Error('quota down'),
                new Error('model down'),
                new Error('tool down')
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            const snapshot = monitor.getSnapshot();
            expect(snapshot).not.toBeNull();
            expect(snapshot.sourceUnavailable).toBe(true);
            expect(snapshot.partial).toBe(false);

            monitor.stop();
        });

        it('computeJitterMs respects maxJitterMs bound', () => {
            const monitor = new UsageMonitor({
                jitterRatio: 0.5,      // 50% of base delay
                maxJitterMs: 300
            }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.9999);
            const jitter = monitor._computeJitterMs(10000); // 5000 before cap
            expect(jitter).toBeLessThan(300);
            expect(jitter).toBeGreaterThanOrEqual(0);
            randomSpy.mockRestore();
        });

        it('computeErrorDelayMs uses bounded exponential backoff after threshold', () => {
            const monitor = new UsageMonitor({
                pollIntervalMs: 10000,
                maxConsecutiveErrors: 3,
                backoffMultiplier: 2,
                backoffIntervalMs: 45000
            }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._consecutiveErrors = 1;
            expect(monitor._computeErrorDelayMs()).toBe(10000); // below threshold

            monitor._consecutiveErrors = 3;
            expect(monitor._computeErrorDelayMs()).toBe(20000); // 10k * 2^1

            monitor._consecutiveErrors = 4;
            expect(monitor._computeErrorDelayMs()).toBe(40000); // 10k * 2^2

            monitor._consecutiveErrors = 5;
            expect(monitor._computeErrorDelayMs()).toBe(45000); // capped
        });
    });

    describe('stale detection', () => {
        it('snapshot is stale when lastPollAt exceeds 2x pollIntervalMs', async () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor({ pollIntervalMs: 10000, lookbackDays: 0 }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            monitor.stop();

            const snap1 = monitor.getSnapshot();
            expect(snap1.stale).toBe(false);

            await advance(25000);
            const snap2 = monitor.getSnapshot();
            expect(snap2.stale).toBe(true);
        });
    });

    describe('key rotation', () => {
        it('rotates key on 401 response', async () => {
            setupHttpsMock([
                { statusCode: 401, body: 'Unauthorized' },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const km = mockKeyManager([{ key: 'key-0' }, { key: 'key-1' }]);
            const logger = mockLogger();
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: km,
                logger,
                targetHost: 'api.z.ai'
            });

            expect(monitor._currentKeyIndex).toBe(0);
            monitor.start();
            await advance(2100);

            expect(monitor._currentKeyIndex).toBe(1);
            expect(logger.warn).toHaveBeenCalledWith(
                expect.stringContaining('rotating key'),
                expect.any(Object)
            );

            monitor.stop();
        });

        it('rotates key on 403 response', async () => {
            setupHttpsMock([
                { statusCode: 403, body: 'Forbidden' },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager([{ key: 'k0' }, { key: 'k1' }, { key: 'k2' }]),
                logger: mockLogger()
            });

            monitor.start();
            await advance(2100);

            expect(monitor._currentKeyIndex).toBe(1);
            monitor.stop();
        });

        it('cycles through all keys on repeated auth failures', async () => {
            setupHttpsMock([{ statusCode: 401, body: 'Unauthorized' }]);

            const keys = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
            const monitor = new UsageMonitor({ pollIntervalMs: 5000, lookbackDays: 0 }, {
                keyManager: mockKeyManager(keys),
                logger: mockLogger()
            });

            monitor.start();
            await advance(2100);

            // 3 requests, each 401 → 3 rotations: 0→1, 1→2, 2→0
            expect(monitor._currentKeyIndex).toBe(0);
            monitor.stop();
        });
    });

    describe('payload control (exposeDetails)', () => {
        it('exposeDetails=false → no toolDetails in quota, top-5 models only', async () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor({ exposeDetails: false, lookbackDays: 0 }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            const snapshot = monitor.getSnapshot();
            expect(snapshot.quota.toolDetails).toBeUndefined();
            // timeSeries is always included (no longer gated by exposeDetails)
            expect(snapshot.modelUsage.timeSeries).toBeDefined();

            monitor.stop();
        });

        it('exposeDetails=true → includes toolDetails and time series', async () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor({ exposeDetails: true, lookbackDays: 0 }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            const snapshot = monitor.getSnapshot();
            expect(snapshot.quota.toolDetails).toBeDefined();
            expect(snapshot.quota.toolDetails).toHaveLength(2);
            expect(snapshot.quota.toolDetails[0].model).toBe('search-prime');
            expect(snapshot.modelUsage.timeSeries).toBeDefined();
            expect(snapshot.modelUsage.timeSeries.times).toHaveLength(2);

            monitor.stop();
        });
    });

    describe('error handling', () => {
        it('handles request timeout (req.destroy called)', async () => {
            setupHttpsMock([{ timeout: true }]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            const mockReqs = https.get.mock.results;
            mockReqs.forEach(r => {
                if (r.value?.destroy) {
                    expect(r.value.destroy).toHaveBeenCalled();
                }
            });

            const snapshot = monitor.getSnapshot();
            expect(snapshot).not.toBeNull();
            expect(snapshot.quota.error).toBeTruthy();

            monitor.stop();
        });

        it('handles malformed JSON gracefully', async () => {
            setupHttpsMock([
                { statusCode: 200, body: 'not-json{{{' },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            const snapshot = monitor.getSnapshot();
            expect(snapshot.quota.error).toMatch(/Invalid JSON/);
            expect(snapshot.modelUsage.totalRequests).toBe(2406);

            monitor.stop();
        });

        it('handles no API keys gracefully', async () => {
            setupHttpsMock([]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager([]),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            const snapshot = monitor.getSnapshot();
            expect(snapshot).not.toBeNull();
            expect(snapshot.quota.error).toMatch(/No API keys/);

            monitor.stop();
        });
    });

    describe('health metrics', () => {
        it('returns correct health metrics', async () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            const health0 = monitor.getHealthMetrics();
            expect(health0.pollSuccessTotal).toBe(0);
            expect(health0.lastSuccessAt).toBeNull();
            expect(health0.staleSeconds).toBeNull();

            monitor.start();
            await advance(2100);

            const health1 = monitor.getHealthMetrics();
            expect(health1.pollSuccessTotal).toBe(1);
            expect(health1.pollErrorTotal).toBe(0);
            expect(health1.consecutiveErrors).toBe(0);
            expect(health1.lastSuccessAt).toBeGreaterThan(0);
            expect(health1.currentKeyIndex).toBe(0);

            monitor.stop();
        });
    });

    describe('snapshot shape', () => {
        it('always includes schemaVersion: 1', async () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            expect(monitor.getSnapshot().schemaVersion).toBe(1);
            monitor.stop();
        });

        it('model usage captures aggregate totals from z.ai time-series', async () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            const mu = monitor.getSnapshot().modelUsage;
            expect(mu.totalRequests).toBe(2406);
            expect(mu.totalTokens).toBe(99930426);

            monitor.stop();
        });

        it('handles non-envelope response gracefully (forward-compat)', async () => {
            // If an endpoint returns raw data without {code, data} envelope
            const rawData = { limits: [{ type: 'TOKENS_LIMIT', percentage: 50, nextResetTime: 999 }], level: 'pro' };

            setupHttpsMock([
                { statusCode: 200, body: rawData },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            const snap = monitor.getSnapshot();
            expect(snap.quota.level).toBe('pro');
            expect(snap.quota.tokenUsagePercent).toBe(50);

            monitor.stop();
        });

        it('handles API error code in envelope', async () => {
            const errorEnvelope = { code: 500, msg: 'Internal Error', success: false };

            setupHttpsMock([
                { statusCode: 200, body: errorEnvelope },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            const snap = monitor.getSnapshot();
            expect(snap.quota.error).toMatch(/API error/);
            expect(snap.modelUsage.totalRequests).toBe(2406);

            monitor.stop();
        });

        it('flags malformed quota payload as schema validation failure', async () => {
            const malformedQuota = { limits: 'not-an-array', level: 'max' };

            setupHttpsMock([
                { statusCode: 200, body: malformedQuota },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            const snap = monitor.getSnapshot();
            expect(snap.quota.error).toMatch(/Schema validation failed/i);
            expect(snap.modelUsage.totalRequests).toBe(2406);
            expect(snap.toolUsage.tools.search).toBe(5);
            expect(snap.partial).toBe(true);
            expect(snap.sourceUnavailable).toBe(false);

            const health = monitor.getHealthMetrics();
            expect(health.schemaValidationErrorTotal).toBeGreaterThan(0);
            expect(health.schemaValidationBySection.quota).toBeGreaterThan(0);

            monitor.stop();
        });

        it('flags sourceUnavailable when all fulfilled payloads fail schema validation', async () => {
            setupHttpsMock([
                { statusCode: 200, body: { limits: 'bad' } }, // malformed quota
                { statusCode: 200, body: { totalUsage: 'bad' } }, // malformed model usage
                { statusCode: 200, body: { totalUsage: 'bad' } } // malformed tool usage
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            const snap = monitor.getSnapshot();
            expect(snap.sourceUnavailable).toBe(true);
            expect(snap.partial).toBe(false);
            expect(snap.quota.error).toMatch(/Schema validation failed/i);
            expect(snap.modelUsage.error).toMatch(/Schema validation failed/i);
            expect(snap.toolUsage.error).toMatch(/Schema validation failed/i);

            monitor.stop();
        });
    });

    describe('progressive backfill', () => {
        it('merges time-series data from regular polls into cache', async () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            // Time-series cache should contain data from the first poll
            expect(monitor._timeSeriesCache.times).toEqual(['2026-02-19 19:00', '2026-02-19 20:00']);
            expect(monitor._timeSeriesCache.callCounts).toEqual([32, 16]);
            expect(monitor._timeSeriesCache.tokenCounts).toEqual([1304455, 337315]);

            monitor.stop();
        });

        it('deduplicates overlapping timestamps on merge', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            // Simulate first fetch
            monitor._mergeTimeSeries({
                x_time: ['2026-02-19 18:00', '2026-02-19 19:00', '2026-02-19 20:00'],
                modelCallCount: [10, 20, 30],
                tokensUsage: [100, 200, 300]
            });

            // Simulate second fetch with overlapping timestamps — new values overwrite old
            monitor._mergeTimeSeries({
                x_time: ['2026-02-19 19:00', '2026-02-19 20:00', '2026-02-19 21:00'],
                modelCallCount: [25, 35, 40],
                tokensUsage: [250, 350, 400]
            });

            expect(monitor._timeSeriesCache.times).toEqual([
                '2026-02-19 18:00', '2026-02-19 19:00', '2026-02-19 20:00', '2026-02-19 21:00'
            ]);
            // 19:00 and 20:00 should use newer values
            expect(monitor._timeSeriesCache.callCounts).toEqual([10, 25, 35, 40]);
            expect(monitor._timeSeriesCache.tokenCounts).toEqual([100, 250, 350, 400]);
        });

        it('sorts time-series after merge', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            // Add newer data first
            monitor._mergeTimeSeries({
                x_time: ['2026-02-20 10:00', '2026-02-20 11:00'],
                modelCallCount: [50, 60],
                tokensUsage: [500, 600]
            });

            // Then add older data (backfill)
            monitor._mergeTimeSeries({
                x_time: ['2026-02-19 10:00', '2026-02-19 11:00'],
                modelCallCount: [10, 20],
                tokensUsage: [100, 200]
            });

            // Should be sorted chronologically
            expect(monitor._timeSeriesCache.times).toEqual([
                '2026-02-19 10:00', '2026-02-19 11:00', '2026-02-20 10:00', '2026-02-20 11:00'
            ]);
            expect(monitor._timeSeriesCache.callCounts).toEqual([10, 20, 50, 60]);
        });

        it('skips merge when no x_time in response', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._mergeTimeSeries({ totalUsage: { totalModelCallCount: 100 } });
            expect(monitor._timeSeriesCache.times).toEqual([]);
        });

        it('backfill marks complete when lookbackDays=0', async () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor({ lookbackDays: 0 }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            // With lookbackDays=0, backfill should be immediately complete
            // (oldestFetchedMs is set to now-24h which is before the target of now)
            await advance(6000); // wait for backfill timer
            expect(monitor._backfill.complete).toBe(true);

            monitor.stop();
        });

        it('snapshot includes timeSeriesBackfillComplete flag', async () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor({ lookbackDays: 0 }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);
            await advance(6000); // wait for backfill completion

            const snap = monitor.getSnapshot();
            expect(snap.modelUsage.timeSeriesBackfillComplete).toBe(true);

            monitor.stop();
        });

        it('backfill fetches chunks progressively', async () => {
            const fetchedPaths = [];
            jest.spyOn(https, 'get').mockImplementation((opts, cb) => {
                const fakeReq = new EventEmitter();
                fakeReq.destroy = jest.fn();
                fetchedPaths.push(opts.path);

                const body = opts.path.includes('quota') ? quotaResponse
                    : opts.path.includes('model') ? modelUsageResponse
                    : toolUsageResponse;
                const res = new EventEmitter();
                res.statusCode = 200;
                Promise.resolve().then(() => {
                    cb(res);
                    res.emit('data', JSON.stringify(body));
                    res.emit('end');
                });
                return fakeReq;
            });

            const monitor = new UsageMonitor({
                lookbackDays: 10,  // 10 days = needs ~2 backfill chunks (7d + 3d)
                pollIntervalMs: 60000
            }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();

            // First poll (3 calls: quota + model-usage + tool-usage)
            await advance(2100);
            expect(fetchedPaths.length).toBe(3);

            // Backfill chunk 1 fires at ~5s (1 call: model-usage for days 1-8)
            await advance(6000);
            const backfillCalls = fetchedPaths.filter(p => p.includes('model-usage'));
            expect(backfillCalls.length).toBeGreaterThanOrEqual(2); // 1 from poll + 1+ from backfill

            // Backfill chunk 2 fires at ~10s
            await advance(6000);
            expect(monitor._backfill.complete).toBe(true);

            monitor.stop();
        });

        it('backfill failure does not crash — retries on next poll cycle', async () => {
            let callCount = 0;
            jest.spyOn(https, 'get').mockImplementation((opts, cb) => {
                const fakeReq = new EventEmitter();
                fakeReq.destroy = jest.fn();
                callCount++;

                // First 3 calls (regular poll): succeed
                if (callCount <= 3) {
                    const body = opts.path.includes('quota') ? quotaResponse
                        : opts.path.includes('model') ? modelUsageResponse
                        : toolUsageResponse;
                    const res = new EventEmitter();
                    res.statusCode = 200;
                    Promise.resolve().then(() => {
                        cb(res);
                        res.emit('data', JSON.stringify(body));
                        res.emit('end');
                    });
                } else {
                    // Backfill call: fail
                    Promise.resolve().then(() => fakeReq.emit('error', new Error('backfill timeout')));
                }
                return fakeReq;
            });

            const logger = mockLogger();
            const monitor = new UsageMonitor({ lookbackDays: 10 }, {
                keyManager: mockKeyManager(),
                logger
            });
            monitor.start();
            await advance(2100);  // poll succeeds
            await advance(6000);  // backfill attempt fails

            // Backfill should not be marked complete
            expect(monitor._backfill.complete).toBe(false);
            expect(monitor._backfill.inProgress).toBe(false); // released
            expect(logger.warn).toHaveBeenCalledWith(
                expect.stringContaining('backfill chunk failed'),
                expect.any(Object)
            );

            monitor.stop();
        });
    });

    describe('cache persistence', () => {
        let tmpDir;

        beforeEach(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-usage-persist-'));
        });

        afterEach(() => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('_load() restores time-series cache from file', () => {
            const cacheData = {
                version: 1,
                savedAt: Date.now(),
                timeSeriesCache: {
                    times: ['2026-02-19 10:00', '2026-02-19 11:00'],
                    callCounts: [10, 20],
                    tokenCounts: [1000, 2000]
                },
                toolTimeSeriesCache: { times: [], networkSearchCount: [], webReadMcpCount: [], zreadMcpCount: [], searchMcpCount: [] },
                backfill: { oldestFetchedMs: Date.now() - 86400000, complete: true },
                sectionState: {
                    quota: { data: quotaResponse.data, lastSuccessAt: Date.now() - 30000 },
                    modelUsage: { data: modelUsageResponse.data, lastSuccessAt: Date.now() - 30000 },
                    toolUsage: { data: null, lastSuccessAt: null }
                }
            };
            fs.writeFileSync(path.join(tmpDir, 'usage-cache.json'), JSON.stringify(cacheData));

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger(),
                configDir: tmpDir
            });

            expect(monitor._timeSeriesCache.times).toEqual(['2026-02-19 10:00', '2026-02-19 11:00']);
            expect(monitor._timeSeriesCache.callCounts).toEqual([10, 20]);
            expect(monitor._timeSeriesCache.tokenCounts).toEqual([1000, 2000]);
            expect(monitor._backfill.complete).toBe(true);
        });

        it('_load() handles missing file gracefully (start fresh)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger(),
                configDir: tmpDir
            });

            expect(monitor._timeSeriesCache.times).toEqual([]);
            expect(monitor._backfill.complete).toBe(false);
        });

        it('_load() handles corrupt JSON gracefully', () => {
            fs.writeFileSync(path.join(tmpDir, 'usage-cache.json'), '{not valid json!!!');

            const logger = mockLogger();
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger,
                configDir: tmpDir
            });

            expect(monitor._timeSeriesCache.times).toEqual([]);
            expect(logger.warn).toHaveBeenCalledWith(
                expect.stringContaining('failed to load cache'),
                expect.any(Object)
            );
        });

        it('_load() ignores cache with unknown version', () => {
            const cacheData = { version: 99, timeSeriesCache: { times: ['t1'], callCounts: [1], tokenCounts: [1] } };
            fs.writeFileSync(path.join(tmpDir, 'usage-cache.json'), JSON.stringify(cacheData));

            const logger = mockLogger();
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger,
                configDir: tmpDir
            });

            expect(monitor._timeSeriesCache.times).toEqual([]);
            expect(logger.warn).toHaveBeenCalledWith(
                expect.stringContaining('unknown version'),
                expect.any(Object)
            );
        });

        it('_save() is debounced (multiple triggers = single write)', async () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger(),
                configDir: tmpDir
            });

            const saveSpy = jest.spyOn(monitor, '_performSave').mockResolvedValue();

            // Trigger multiple saves
            monitor._save();
            monitor._save();
            monitor._save();

            // Not yet fired (debounced)
            expect(saveSpy).not.toHaveBeenCalled();

            // Advance past debounce period (10s)
            await advance(11000);

            // Should have been called exactly once despite 3 triggers
            expect(saveSpy).toHaveBeenCalledTimes(1);
        });

        it('persistAndStop() performs immediate save + cleanup', async () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger(),
                configDir: tmpDir
            });
            monitor.start();
            await advance(2100);

            // Should have data now
            expect(monitor.getSnapshot()).not.toBeNull();

            await monitor.persistAndStop();

            // File should exist with cached data
            expect(fs.existsSync(path.join(tmpDir, 'usage-cache.json'))).toBe(true);
            const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, 'usage-cache.json'), 'utf8'));
            expect(saved.version).toBe(1);
            expect(saved.timeSeriesCache.times).toHaveLength(2);

            // Timer and agent should be cleaned up
            expect(monitor._timer).toBeNull();
            expect(monitor._agent).toBeNull();
        });

        it('loaded data survives into getSnapshot() before first poll', () => {
            const cacheData = {
                version: 1,
                savedAt: Date.now() - 5000,
                timeSeriesCache: {
                    times: ['2026-02-19 10:00'],
                    callCounts: [50],
                    tokenCounts: [5000]
                },
                toolTimeSeriesCache: { times: [], networkSearchCount: [], webReadMcpCount: [], zreadMcpCount: [], searchMcpCount: [] },
                backfill: { oldestFetchedMs: Date.now() - 86400000, complete: false },
                sectionState: {
                    quota: { data: quotaResponse.data, lastSuccessAt: Date.now() - 10000 },
                    modelUsage: { data: modelUsageResponse.data, lastSuccessAt: Date.now() - 10000 },
                    toolUsage: { data: null, lastSuccessAt: null }
                }
            };
            fs.writeFileSync(path.join(tmpDir, 'usage-cache.json'), JSON.stringify(cacheData));

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger(),
                configDir: tmpDir
            });

            // Should have a snapshot from loaded data, before any poll
            const snap = monitor.getSnapshot();
            expect(snap).not.toBeNull();
            expect(snap.schemaVersion).toBe(1);
            expect(snap.quota.level).toBe('max');
            expect(snap.modelUsage.timeSeries.times).toEqual(['2026-02-19 10:00']);
        });
    });

    describe('getDetails()', () => {
        it('returns full limits array from quota data', async () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            const details = monitor.getDetails();
            expect(details.quota).not.toBeNull();
            expect(details.quota.limits).toHaveLength(2);
            expect(details.quota.limits[0].type).toBe('TIME_LIMIT');
            expect(details.quota.limits[1].type).toBe('TOKENS_LIMIT');
            expect(details.quota.level).toBe('max');

            monitor.stop();
        });

        it('returns tool details regardless of exposeDetails setting', async () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor({ exposeDetails: false, lookbackDays: 0 }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            const details = monitor.getDetails();
            expect(details.quota.toolDetails).toBeDefined();
            expect(details.quota.toolDetails).toHaveLength(2);
            expect(details.quota.toolDetails[0].model).toBe('search-prime');

            monitor.stop();
        });

        it('returns null sections when no data available', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            const details = monitor.getDetails();
            expect(details.quota).toBeNull();
            expect(details.modelUsage).toBeNull();
            expect(details.toolUsage).toBeNull();
            expect(details._monitor).toBeDefined();
        });

        it('includes model usage time-series and backfill status', async () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            const details = monitor.getDetails();
            expect(details.modelUsage.timeSeries).not.toBeNull();
            expect(details.modelUsage.timeSeries.times).toHaveLength(2);
            expect(details.modelUsage.totalRequests).toBe(2406);
            expect(typeof details.modelUsage.backfillComplete).toBe('boolean');

            monitor.stop();
        });
    });

    describe('tool time-series cache', () => {
        it('merges tool usage time-series from polls', async () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            expect(monitor._toolTimeSeriesCache.times).toEqual(['2026-02-19 19:00', '2026-02-19 20:00']);

            monitor.stop();
        });

        it('deduplicates overlapping tool timestamps', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._mergeToolTimeSeries({
                x_time: ['2026-02-19 18:00', '2026-02-19 19:00'],
                networkSearchCount: [1, 2],
                webReadMcpCount: [3, 4],
                zreadMcpCount: [0, 0],
                searchMcpCount: [5, 6]
            });

            monitor._mergeToolTimeSeries({
                x_time: ['2026-02-19 19:00', '2026-02-19 20:00'],
                networkSearchCount: [10, 20],
                webReadMcpCount: [30, 40],
                zreadMcpCount: [0, 0],
                searchMcpCount: [50, 60]
            });

            expect(monitor._toolTimeSeriesCache.times).toEqual([
                '2026-02-19 18:00', '2026-02-19 19:00', '2026-02-19 20:00'
            ]);
            // 19:00 should use newer values
            expect(monitor._toolTimeSeriesCache.networkSearchCount).toEqual([1, 10, 20]);
            expect(monitor._toolTimeSeriesCache.webReadMcpCount).toEqual([3, 30, 40]);
        });

        it('skips merge when no x_time in tool response', () => {
            jest.restoreAllMocks(); // clear any lingering https mock
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._mergeToolTimeSeries({ totalUsage: {} });
            expect(monitor._toolTimeSeriesCache.times).toEqual([]);
        });
    });

    describe('time-series pruning', () => {
        it('prunes entries older than lookbackDays', () => {
            const monitor = new UsageMonitor({ lookbackDays: 7 }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            const now = Date.now();
            const recent = monitor._formatTime(new Date(now - 2 * 24 * 60 * 60 * 1000)); // 2 days ago
            const old = monitor._formatTime(new Date(now - 10 * 24 * 60 * 60 * 1000)); // 10 days ago

            monitor._timeSeriesCache = {
                times: [old, recent],
                callCounts: [100, 200],
                tokenCounts: [1000, 2000]
            };
            monitor._toolTimeSeriesCache = {
                times: [old, recent],
                networkSearchCount: [1, 2],
                webReadMcpCount: [3, 4],
                zreadMcpCount: [0, 0],
                searchMcpCount: [5, 6]
            };

            monitor._pruneTimeSeries();

            expect(monitor._timeSeriesCache.times).toEqual([recent]);
            expect(monitor._timeSeriesCache.callCounts).toEqual([200]);
            expect(monitor._timeSeriesCache.tokenCounts).toEqual([2000]);
            expect(monitor._toolTimeSeriesCache.times).toEqual([recent]);
            expect(monitor._toolTimeSeriesCache.networkSearchCount).toEqual([2]);
        });

        it('skips pruning when lookbackDays is 0', () => {
            const monitor = new UsageMonitor({ lookbackDays: 0 }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._timeSeriesCache = {
                times: ['2020-01-01 00:00'],
                callCounts: [1],
                tokenCounts: [10]
            };

            monitor._pruneTimeSeries();

            // Should not prune anything
            expect(monitor._timeSeriesCache.times).toEqual(['2020-01-01 00:00']);
        });

        it('caps model time-series to maxTimeSeriesPoints keeping newest entries', () => {
            const monitor = new UsageMonitor({ lookbackDays: 0, maxTimeSeriesPoints: 3 }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._mergeTimeSeries({
                x_time: [
                    '2026-02-20 10:00',
                    '2026-02-20 11:00',
                    '2026-02-20 12:00',
                    '2026-02-20 13:00',
                    '2026-02-20 14:00'
                ],
                modelCallCount: [10, 11, 12, 13, 14],
                tokensUsage: [100, 110, 120, 130, 140]
            });

            expect(monitor._timeSeriesCache.times).toEqual([
                '2026-02-20 12:00',
                '2026-02-20 13:00',
                '2026-02-20 14:00'
            ]);
            expect(monitor._timeSeriesCache.callCounts).toEqual([12, 13, 14]);
            expect(monitor._timeSeriesCache.tokenCounts).toEqual([120, 130, 140]);
        });

        it('caps tool time-series to maxTimeSeriesPoints keeping newest entries', () => {
            const monitor = new UsageMonitor({ lookbackDays: 0, maxTimeSeriesPoints: 2 }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._mergeToolTimeSeries({
                x_time: [
                    '2026-02-20 10:00',
                    '2026-02-20 11:00',
                    '2026-02-20 12:00'
                ],
                networkSearchCount: [1, 2, 3],
                webReadMcpCount: [4, 5, 6],
                zreadMcpCount: [0, 1, 2],
                searchMcpCount: [7, 8, 9]
            });

            expect(monitor._toolTimeSeriesCache.times).toEqual([
                '2026-02-20 11:00',
                '2026-02-20 12:00'
            ]);
            expect(monitor._toolTimeSeriesCache.networkSearchCount).toEqual([2, 3]);
            expect(monitor._toolTimeSeriesCache.webReadMcpCount).toEqual([5, 6]);
            expect(monitor._toolTimeSeriesCache.zreadMcpCount).toEqual([1, 2]);
            expect(monitor._toolTimeSeriesCache.searchMcpCount).toEqual([8, 9]);
        });
    });

    describe('anomaly detection (COST-07)', () => {
        let monitor;
        let callback;

        beforeEach(() => {
            monitor = new UsageMonitor(
                { anomaly: { enabled: true, rateJumpThreshold: 2.5, minDataPoints: 6, cooldownMs: 3600000, quotaWarningThresholds: [0.8, 0.95] } },
                { logger: mockLogger(), keyManager: mockKeyManager() }
            );
            callback = jest.fn();
            monitor.setAnomalyCallback(callback);
        });

        test('rate jump fires above threshold', () => {
            monitor._timeSeriesCache = {
                times: Array.from({ length: 10 }, (_, i) => `t${i}`),
                tokenCounts: [100, 102, 98, 101, 99, 100, 103, 97, 101, 500],
                callCounts: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10]
            };
            monitor._checkRateJump({});
            expect(callback).toHaveBeenCalled();
            const alert = callback.mock.calls[0][0];
            expect(alert.type).toBe('usage.rate_jump');
            expect(alert.data.direction).toBe('spike');
            expect(alert.data.metric).toBe('tokenCounts');
        });

        test('rate jump silent below threshold', () => {
            monitor._timeSeriesCache = {
                times: Array.from({ length: 10 }, (_, i) => `t${i}`),
                tokenCounts: [100, 102, 98, 101, 99, 100, 103, 97, 101, 103],
                callCounts: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10]
            };
            monitor._checkRateJump({});
            expect(callback).not.toHaveBeenCalled();
        });

        test('rate jump requires minDataPoints', () => {
            monitor._timeSeriesCache = {
                times: ['t0', 't1', 't2'],
                tokenCounts: [100, 100, 500],
                callCounts: [10, 10, 10]
            };
            monitor._checkRateJump({});
            expect(callback).not.toHaveBeenCalled();
        });

        test('stale feed alert on false to true', () => {
            monitor._checkStaleFeed({ stale: true, lastPollAt: Date.now() - 120000 }, { stale: false });
            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback.mock.calls[0][0].type).toBe('usage.feed_stale');
        });

        test('stale feed deduplicates', () => {
            monitor._checkStaleFeed({ stale: true, lastPollAt: Date.now() - 120000 }, { stale: false });
            monitor._anomalyCooldowns = {};
            monitor._checkStaleFeed({ stale: true, lastPollAt: Date.now() - 120000 }, { stale: true });
            expect(callback).toHaveBeenCalledTimes(1);
        });

        test('stale recovery on true to false', () => {
            monitor._staleFeedAlerted = true;
            monitor._checkStaleFeed({ stale: false }, { stale: true });
            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback.mock.calls[0][0].type).toBe('usage.feed_recovered');
        });

        test('quota warning at 80%', () => {
            monitor._checkQuotaWarning({ quota: { tokenUsagePercent: 82, level: 'tier-1' } });
            expect(callback).toHaveBeenCalledTimes(1);
            const alert = callback.mock.calls[0][0];
            expect(alert.type).toBe('usage.quota_warning');
            expect(alert.data.threshold).toBe(0.8);
        });

        test('quota warning at 95% separately', () => {
            monitor._quotaThresholdsFired.add(0.8);
            monitor._checkQuotaWarning({ quota: { tokenUsagePercent: 96, level: 'tier-1' } });
            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback.mock.calls[0][0].data.threshold).toBe(0.95);
            expect(callback.mock.calls[0][0].severity).toBe('critical');
        });

        test('quota warning deduplicates', () => {
            monitor._checkQuotaWarning({ quota: { tokenUsagePercent: 85, level: 'tier-1' } });
            monitor._anomalyCooldowns = {};
            monitor._checkQuotaWarning({ quota: { tokenUsagePercent: 87, level: 'tier-1' } });
            expect(callback).toHaveBeenCalledTimes(1);
        });

        test('cooldown prevents re-fire', () => {
            monitor._timeSeriesCache = {
                times: Array.from({ length: 10 }, (_, i) => `t${i}`),
                tokenCounts: [100, 102, 98, 101, 99, 100, 103, 97, 101, 500],
                callCounts: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10]
            };
            monitor._checkRateJump({});
            expect(callback).toHaveBeenCalledTimes(1);
            monitor._checkRateJump({});
            expect(callback).toHaveBeenCalledTimes(1);
        });

        test('callback receives structured alert', () => {
            monitor._checkStaleFeed({ stale: true, lastPollAt: Date.now() - 120000 }, { stale: false });
            const alert = callback.mock.calls[0][0];
            expect(alert).toHaveProperty('type');
            expect(alert).toHaveProperty('severity');
            expect(alert).toHaveProperty('message');
            expect(alert).toHaveProperty('data');
            expect(alert).toHaveProperty('timestamp');
        });

        test('getAnomalyAlerts bounded to 100', () => {
            for (let i = 0; i < 150; i++) {
                monitor._anomalyCooldowns = {};
                monitor._fireAnomaly('usage.rate_jump', 'warning', {
                    message: `alert ${i}`,
                    data: { index: i }
                });
            }
            const alerts = monitor.getAnomalyAlerts();
            expect(alerts.length).toBe(100);
        });

        test('disabled anomaly detection produces no alerts', () => {
            monitor._anomalyConfig.enabled = false;
            monitor._timeSeriesCache = {
                times: Array.from({ length: 10 }, (_, i) => `t${i}`),
                tokenCounts: [100, 102, 98, 101, 99, 100, 103, 97, 101, 500],
                callCounts: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10]
            };
            monitor._checkAnomalies({ stale: true, quota: { tokenUsagePercent: 90 } }, null);
            expect(callback).not.toHaveBeenCalled();
        });

        test('poll integration triggers anomaly detection', () => {
            const spy = jest.spyOn(monitor, '_checkAnomalies');
            monitor._snapshot = {};
            monitor._lastPollAt = Date.now();
            const enriched = monitor.getSnapshot();
            monitor._checkAnomalies(enriched, monitor._prevSnapshot);
            monitor._prevSnapshot = enriched;
            expect(spy).toHaveBeenCalledTimes(1);
            spy.mockRestore();
        });
    });
});
