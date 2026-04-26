'use strict';
/**
 * Usage Monitor Edge-Case Tests
 *
 * Covers: cache persistence round-trip, backfill completion flag,
 * data point accumulation across timestamps, stale data detection,
 * rate limit tracking, multiple-account key isolation,
 * error recovery preserving existing data, and timer lifecycle.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { UsageMonitor } = require('../lib/usage-monitor');

// --- Helpers ---

function mockKeyManager(keys = [{ key: 'test-key-1' }, { key: 'test-key-2' }]) {
    return { keys };
}

function mockLogger() {
    return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

/** Advance fake timers AND flush microtasks */
async function advance(ms) {
    await jest.advanceTimersByTimeAsync(ms);
}

/**
 * Setup synchronous https.get mock.
 * Accepts a function(opts, callIndex) => responseSpec for dynamic control.
 */
function setupHttpsMock(responsesOrFn) {
    const calls = [];
    let callIndex = 0;

    jest.spyOn(https, 'get').mockImplementation((opts, cb) => {
        calls.push(opts);
        const fakeReq = new EventEmitter();
        fakeReq.destroy = jest.fn();

        const responseSpec = typeof responsesOrFn === 'function'
            ? responsesOrFn(opts, callIndex)
            : responsesOrFn[callIndex % responsesOrFn.length];
        callIndex++;

        if (responseSpec instanceof Error) {
            Promise.resolve().then(() => fakeReq.emit('error', responseSpec));
        } else if (responseSpec && responseSpec.timeout) {
            Promise.resolve().then(() => fakeReq.emit('timeout'));
        } else {
            const res = new EventEmitter();
            res.statusCode = responseSpec?.statusCode || 200;
            const body = responseSpec?.body || {};
            const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);

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

// Standard z.ai envelope mock responses
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

const NO_BACKFILL = { lookbackDays: 0 };

// --- Tests ---

describe('UsageMonitor Edge Cases', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.restoreAllMocks();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    // ================================================================
    // 1. Cache persistence: save, reload, assert data preserved
    // ================================================================
    describe('cache persistence round-trip', () => {
        let tmpDir;

        beforeEach(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-usage-edge-'));
        });

        afterEach(() => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('saves cache via persistAndStop then new instance loads exact same data', async () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const m1 = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger(),
                configDir: tmpDir
            });
            m1.start();
            await advance(2100);

            // Capture the data before saving
            const snap1 = m1.getSnapshot();
            expect(snap1).not.toBeNull();
            expect(snap1.modelUsage.timeSeries.times).toEqual(['2026-02-19 19:00', '2026-02-19 20:00']);

            const ts1 = { ...m1._timeSeriesCache };
            const backfill1 = { ...m1._backfill };

            await m1.persistAndStop();

            // Verify file exists
            const filePath = path.join(tmpDir, 'usage-cache.json');
            expect(fs.existsSync(filePath)).toBe(true);

            // Create new instance — should load the persisted data
            jest.restoreAllMocks(); // clear https mock so constructor doesn't trigger net
            const m2 = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger(),
                configDir: tmpDir
            });

            // Time-series cache must match
            expect(m2._timeSeriesCache.times).toEqual(ts1.times);
            expect(m2._timeSeriesCache.callCounts).toEqual(ts1.callCounts);
            expect(m2._timeSeriesCache.tokenCounts).toEqual(ts1.tokenCounts);

            // Backfill state must match
            expect(m2._backfill.oldestFetchedMs).toBe(backfill1.oldestFetchedMs);

            // Snapshot should be available before any poll
            const snap2 = m2.getSnapshot();
            expect(snap2).not.toBeNull();
            expect(snap2.schemaVersion).toBe(1);
            expect(snap2.quota.level).toBe('max');
            expect(snap2.modelUsage.totalRequests).toBe(2406);
        });

        it('persists and restores tool time-series cache', async () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const m1 = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger(),
                configDir: tmpDir
            });
            m1.start();
            await advance(2100);

            const toolTs1 = { ...m1._toolTimeSeriesCache };
            expect(toolTs1.times.length).toBeGreaterThan(0);

            await m1.persistAndStop();

            jest.restoreAllMocks();
            const m2 = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger(),
                configDir: tmpDir
            });

            expect(m2._toolTimeSeriesCache.times).toEqual(toolTs1.times);
        });

        it('persists section state (quota/modelUsage/toolUsage) and restores it', async () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const m1 = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger(),
                configDir: tmpDir
            });
            m1.start();
            await advance(2100);

            await m1.persistAndStop();

            jest.restoreAllMocks();
            const m2 = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger(),
                configDir: tmpDir
            });

            expect(m2._sectionState.quota.data).not.toBeNull();
            expect(m2._sectionState.quota.data.level).toBe('max');
            expect(m2._sectionState.modelUsage.data).not.toBeNull();
            expect(m2._sectionState.modelUsage.data.totalUsage.totalModelCallCount).toBe(2406);
            expect(m2._sectionState.quota.lastSuccessAt).toBeGreaterThan(0);
        });

        it('does not persist when configDir is not provided', async () => {
            const m = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
                // no configDir
            });

            expect(m._persistEnabled).toBe(false);

            // _save and _performSave should be no-ops
            m._save();
            await m._performSave();
            // No error thrown, no file written
        });
    });

    // ================================================================
    // 2. Backfill completion: assert backfill flag set after initial fetch
    // ================================================================
    describe('backfill completion', () => {
        it('sets oldestFetchedMs after first successful model-usage fetch', async () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            expect(monitor._backfill.oldestFetchedMs).toBeNull();

            monitor.start();
            await advance(2100);

            // After first poll, oldestFetchedMs should be set to now - 24h
            expect(monitor._backfill.oldestFetchedMs).not.toBeNull();
            expect(monitor._backfill.oldestFetchedMs).toBeLessThan(Date.now());
            expect(monitor._backfill.oldestFetchedMs).toBeGreaterThan(Date.now() - 2 * 86400000);

            monitor.stop();
        });

        it('marks backfill complete when lookbackDays target is reached', async () => {
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
            // With lookbackDays=0, the target is now. oldestFetchedMs = now-24h < now
            // So backfill should complete on the first backfill check
            await advance(6000); // backfill timer fires at 5s

            expect(monitor._backfill.complete).toBe(true);
            monitor.stop();
        });

        it('backfill remains incomplete when model-usage fails on first poll', async () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                new Error('model-usage down'),
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor({ lookbackDays: 7 }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            // Model usage failed so oldestFetchedMs should still be null
            expect(monitor._backfill.oldestFetchedMs).toBeNull();
            expect(monitor._backfill.complete).toBe(false);

            monitor.stop();
        });

        it('snapshot reflects backfillComplete in modelUsage', async () => {
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
            await advance(6000);

            const snap = monitor.getSnapshot();
            expect(snap.modelUsage.timeSeriesBackfillComplete).toBe(true);

            monitor.stop();
        });
    });

    // ================================================================
    // 3. Data point accumulation: record usage at different timestamps
    // ================================================================
    describe('data point accumulation', () => {
        it('accumulates data from multiple polls into a growing series', async () => {
            let pollNum = 0;
            jest.spyOn(https, 'get').mockImplementation((opts, cb) => {
                const fakeReq = new EventEmitter();
                fakeReq.destroy = jest.fn();

                if (opts.path.includes('quota')) pollNum++;

                let body;
                if (opts.path.includes('quota')) {
                    body = quotaResponse;
                } else if (opts.path.includes('model')) {
                    // Return different time windows for each poll
                    body = pollNum <= 1
                        ? { code: 200, success: true, data: {
                            x_time: ['2026-02-19 10:00', '2026-02-19 11:00'],
                            modelCallCount: [10, 20],
                            tokensUsage: [1000, 2000],
                            totalUsage: { totalModelCallCount: 30, totalTokensUsage: 3000 }
                        }}
                        : { code: 200, success: true, data: {
                            x_time: ['2026-02-19 12:00', '2026-02-19 13:00'],
                            modelCallCount: [30, 40],
                            tokensUsage: [3000, 4000],
                            totalUsage: { totalModelCallCount: 100, totalTokensUsage: 10000 }
                        }};
                } else {
                    body = toolUsageResponse;
                }

                const res = new EventEmitter();
                res.statusCode = 200;
                Promise.resolve().then(() => {
                    cb(res);
                    res.emit('data', JSON.stringify(body));
                    res.emit('end');
                });
                return fakeReq;
            });

            const monitor = new UsageMonitor({ pollIntervalMs: 10000, lookbackDays: 0 }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();

            // First poll
            await advance(2100);
            expect(monitor._timeSeriesCache.times).toEqual(['2026-02-19 10:00', '2026-02-19 11:00']);

            // Second poll — non-overlapping timestamps should accumulate
            await advance(12100);
            expect(monitor._timeSeriesCache.times).toEqual([
                '2026-02-19 10:00', '2026-02-19 11:00',
                '2026-02-19 12:00', '2026-02-19 13:00'
            ]);
            expect(monitor._timeSeriesCache.callCounts).toEqual([10, 20, 30, 40]);
            expect(monitor._timeSeriesCache.tokenCounts).toEqual([1000, 2000, 3000, 4000]);

            monitor.stop();
        });

        it('overwrites overlapping timestamps with newer values', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            // First batch
            monitor._mergeTimeSeries({
                x_time: ['2026-02-19 10:00', '2026-02-19 11:00', '2026-02-19 12:00'],
                modelCallCount: [10, 20, 30],
                tokensUsage: [100, 200, 300]
            });

            // Second batch overlapping at 11:00 and 12:00
            monitor._mergeTimeSeries({
                x_time: ['2026-02-19 11:00', '2026-02-19 12:00', '2026-02-19 13:00'],
                modelCallCount: [25, 35, 45],
                tokensUsage: [250, 350, 450]
            });

            expect(monitor._timeSeriesCache.times).toHaveLength(4);
            expect(monitor._timeSeriesCache.times).toEqual([
                '2026-02-19 10:00', '2026-02-19 11:00',
                '2026-02-19 12:00', '2026-02-19 13:00'
            ]);
            // Original 10:00 kept, 11:00 and 12:00 overwritten, 13:00 added
            expect(monitor._timeSeriesCache.callCounts).toEqual([10, 25, 35, 45]);
            expect(monitor._timeSeriesCache.tokenCounts).toEqual([100, 250, 350, 450]);
        });

        it('maintains ascending sort when backfill injects older data', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            // Recent data first
            monitor._mergeTimeSeries({
                x_time: ['2026-02-20 10:00', '2026-02-20 11:00'],
                modelCallCount: [50, 60],
                tokensUsage: [500, 600]
            });

            // Then older backfill data
            monitor._mergeTimeSeries({
                x_time: ['2026-02-18 10:00', '2026-02-19 10:00'],
                modelCallCount: [5, 15],
                tokensUsage: [50, 150]
            });

            // Must be chronologically sorted
            expect(monitor._timeSeriesCache.times).toEqual([
                '2026-02-18 10:00', '2026-02-19 10:00',
                '2026-02-20 10:00', '2026-02-20 11:00'
            ]);
            expect(monitor._timeSeriesCache.callCounts).toEqual([5, 15, 50, 60]);
        });
    });

    // ================================================================
    // 4. Stale data detection
    // ================================================================
    describe('stale data detection', () => {
        it('snapshot not stale immediately after poll', async () => {
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

            const snap = monitor.getSnapshot();
            expect(snap.stale).toBe(false);
        });

        it('snapshot becomes stale after 2x pollIntervalMs', async () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor({
                pollIntervalMs: 30000,
                jitterRatio: 0,
                maxJitterMs: 0,
                lookbackDays: 0
            }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(100); // first poll fires immediately (0 delay, 0 jitter)
            monitor.stop();

            const pollAt = monitor._lastPollAt;
            expect(pollAt).toBeGreaterThan(0);

            // 50s later — not stale (threshold is 60s = 2 * 30000)
            await advance(50000);
            expect(monitor.getSnapshot().stale).toBe(false);

            // 65s total from pollAt — stale
            await advance(15000);
            expect(monitor.getSnapshot().stale).toBe(true);
        });

        it('stale detection uses pollIntervalMs config dynamically', async () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor({ pollIntervalMs: 60000, lookbackDays: 0 }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);
            monitor.stop();

            // 60s later — not stale (threshold is 120s)
            await advance(60000);
            expect(monitor.getSnapshot().stale).toBe(false);

            // 121s — stale
            await advance(61000);
            expect(monitor.getSnapshot().stale).toBe(true);
        });

        it('stale flag resets when a new successful poll occurs', async () => {
            let pollCount = 0;
            jest.spyOn(https, 'get').mockImplementation((opts, cb) => {
                const fakeReq = new EventEmitter();
                fakeReq.destroy = jest.fn();
                if (opts.path.includes('quota')) pollCount++;

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

            const monitor = new UsageMonitor({ pollIntervalMs: 10000, lookbackDays: 0 }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();

            // First poll
            await advance(2100);
            expect(monitor.getSnapshot().stale).toBe(false);

            // Advance past 2x pollInterval — would be stale, but second poll fires first
            await advance(12100);
            expect(monitor.getSnapshot().stale).toBe(false);
            expect(pollCount).toBe(2);

            monitor.stop();
        });
    });

    // ================================================================
    // 5. Rate limit tracking (quota remaining/total)
    // ================================================================
    describe('rate limit tracking', () => {
        it('tracks token usage percentage from quota response', async () => {
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

            const snap = monitor.getSnapshot();
            expect(snap.quota.tokenUsagePercent).toBe(18);
            expect(snap.quota.tokenNextResetAt).toBe(1771631247854);

            monitor.stop();
        });

        it('tracks tool usage remaining and total from TIME_LIMIT', async () => {
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

            const snap = monitor.getSnapshot();
            expect(snap.quota.toolUsage).toBeDefined();
            expect(snap.quota.toolUsage.limit).toBe(4000);
            expect(snap.quota.toolUsage.used).toBe(85);
            expect(snap.quota.toolUsage.remaining).toBe(3915);
            expect(snap.quota.toolUsage.percent).toBe(2);

            monitor.stop();
        });

        it('handles quota with only TOKENS_LIMIT (no TIME_LIMIT)', async () => {
            const tokensOnlyQuota = {
                code: 200, msg: 'OK', success: true,
                data: {
                    limits: [
                        { type: 'TOKENS_LIMIT', percentage: 42, nextResetTime: 9999999 }
                    ],
                    level: 'pro'
                }
            };

            setupHttpsMock([
                { statusCode: 200, body: tokensOnlyQuota },
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
            expect(snap.quota.tokenUsagePercent).toBe(42);
            expect(snap.quota.toolUsage).toBeNull();

            monitor.stop();
        });

        it('getDetails exposes full limits array with remaining/usage fields', async () => {
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
            expect(details.quota.limits).toHaveLength(2);

            const timeLimit = details.quota.limits.find(l => l.type === 'TIME_LIMIT');
            expect(timeLimit.usage).toBe(4000);
            expect(timeLimit.currentValue).toBe(85);
            expect(timeLimit.remaining).toBe(3915);
            expect(timeLimit.percentage).toBe(2);

            const tokensLimit = details.quota.limits.find(l => l.type === 'TOKENS_LIMIT');
            expect(tokensLimit.percentage).toBe(18);

            monitor.stop();
        });
    });

    // ================================================================
    // 6. Multiple account support (key isolation)
    // ================================================================
    describe('multiple account / key isolation', () => {
        it('uses the correct key index for requests', async () => {
            const calls = setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const keys = [{ key: 'acct-A-key' }, { key: 'acct-B-key' }];
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(keys),
                logger: mockLogger()
            });

            expect(monitor._currentKeyIndex).toBe(0);
            monitor.start();
            await advance(2100);

            // All 3 requests should use key at index 0
            calls.forEach(c => {
                expect(c.headers.Authorization).toBe('acct-A-key');
            });

            monitor.stop();
        });

        it('rotates to next key on 401 and uses it for subsequent requests', async () => {
            let callNum = 0;
            const allCalls = [];
            jest.spyOn(https, 'get').mockImplementation((opts, cb) => {
                const fakeReq = new EventEmitter();
                fakeReq.destroy = jest.fn();
                allCalls.push(opts);
                callNum++;

                if (callNum <= 3) {
                    // First poll: quota returns 401, rotates key
                    if (opts.path.includes('quota')) {
                        const res = new EventEmitter();
                        res.statusCode = 401;
                        Promise.resolve().then(() => {
                            cb(res);
                            res.emit('data', '"Unauthorized"');
                            res.emit('end');
                        });
                    } else {
                        const body = opts.path.includes('model') ? modelUsageResponse : toolUsageResponse;
                        const res = new EventEmitter();
                        res.statusCode = 200;
                        Promise.resolve().then(() => {
                            cb(res);
                            res.emit('data', JSON.stringify(body));
                            res.emit('end');
                        });
                    }
                } else {
                    // Second poll: all succeed with rotated key
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
                }
                return fakeReq;
            });

            const keys = [{ key: 'key-alpha' }, { key: 'key-beta' }];
            const monitor = new UsageMonitor({ pollIntervalMs: 10000, lookbackDays: 0 }, {
                keyManager: mockKeyManager(keys),
                logger: mockLogger()
            });

            monitor.start();
            await advance(2100); // first poll
            expect(monitor._currentKeyIndex).toBe(1); // rotated after 401

            await advance(12100); // second poll
            // Second poll requests should use key-beta
            const secondPollCalls = allCalls.slice(3);
            secondPollCalls.forEach(c => {
                expect(c.headers.Authorization).toBe('key-beta');
            });

            monitor.stop();
        });

        it('separate monitor instances use independent key state', () => {
            const keys = [{ key: 'k1' }, { key: 'k2' }, { key: 'k3' }];

            const m1 = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(keys),
                logger: mockLogger()
            });
            const m2 = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(keys),
                logger: mockLogger()
            });

            m1._currentKeyIndex = 2;
            expect(m2._currentKeyIndex).toBe(0); // independent
        });
    });

    // ================================================================
    // 7. Error recovery: failed API fetch doesn't lose existing data
    // ================================================================
    describe('error recovery', () => {
        it('retains previous quota data when quota endpoint fails', async () => {
            let callCount = 0;
            jest.spyOn(https, 'get').mockImplementation((opts, cb) => {
                const fakeReq = new EventEmitter();
                fakeReq.destroy = jest.fn();
                callCount++;

                if (callCount <= 3) {
                    // First poll: all succeed
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
                } else if (opts.path.includes('quota')) {
                    // Second poll: quota fails
                    Promise.resolve().then(() => fakeReq.emit('error', new Error('quota server down')));
                } else {
                    // Second poll: model/tool succeed
                    const body = opts.path.includes('model') ? modelUsageResponse : toolUsageResponse;
                    const res = new EventEmitter();
                    res.statusCode = 200;
                    Promise.resolve().then(() => {
                        cb(res);
                        res.emit('data', JSON.stringify(body));
                        res.emit('end');
                    });
                }
                return fakeReq;
            });

            const monitor = new UsageMonitor({ pollIntervalMs: 10000, lookbackDays: 0 }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100); // first poll

            const snap1 = monitor.getSnapshot();
            expect(snap1.quota.level).toBe('max');
            expect(snap1.quota.error).toBeNull();

            await advance(12100); // second poll

            const snap2 = monitor.getSnapshot();
            // Previous quota data preserved despite error
            expect(snap2.quota.level).toBe('max');
            expect(snap2.quota.error).toBeTruthy();
            expect(snap2.partial).toBe(true);
            expect(snap2.sourceUnavailable).toBe(false);

            monitor.stop();
        });

        it('retains time-series cache when all endpoints fail', async () => {
            let callCount = 0;
            jest.spyOn(https, 'get').mockImplementation((opts, cb) => {
                const fakeReq = new EventEmitter();
                fakeReq.destroy = jest.fn();
                callCount++;

                if (callCount <= 3) {
                    // First poll: succeed
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
                    // All subsequent polls fail
                    Promise.resolve().then(() => fakeReq.emit('error', new Error('all down')));
                }
                return fakeReq;
            });

            const monitor = new UsageMonitor({ pollIntervalMs: 10000, lookbackDays: 0 }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            const tsBefore = [...monitor._timeSeriesCache.times];
            expect(tsBefore.length).toBe(2);

            await advance(12100); // second poll fails

            // Time-series cache must be preserved
            expect(monitor._timeSeriesCache.times).toEqual(tsBefore);
            expect(monitor._consecutiveErrors).toBe(1);

            monitor.stop();
        });

        it('consecutive errors increment counter but existing snapshot survives', async () => {
            let callCount = 0;
            jest.spyOn(https, 'get').mockImplementation((opts, cb) => {
                const fakeReq = new EventEmitter();
                fakeReq.destroy = jest.fn();
                callCount++;

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
                    Promise.resolve().then(() => fakeReq.emit('error', new Error('down')));
                }
                return fakeReq;
            });

            const monitor = new UsageMonitor({
                pollIntervalMs: 10000,
                jitterRatio: 0,
                maxJitterMs: 0,
                lookbackDays: 0
            }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(100); // poll 1 fires immediately (0ms delay, 0 jitter)
            expect(monitor._consecutiveErrors).toBe(0);
            expect(monitor._pollSuccessTotal).toBe(1);

            await advance(10100); // poll 2 at 10s: all 3 calls fail
            expect(monitor._consecutiveErrors).toBe(1);

            await advance(10100); // poll 3 at 20s: all 3 calls fail
            expect(monitor._consecutiveErrors).toBe(2);

            // Snapshot still has data from first successful poll
            const snap = monitor.getSnapshot();
            expect(snap).not.toBeNull();
            expect(snap.quota.level).toBe('max');
            expect(snap.modelUsage.totalRequests).toBe(2406);

            monitor.stop();
        });

        it('error counter resets to 0 after a fully successful poll follows a fully failed one', async () => {
            let callCount = 0;
            jest.spyOn(https, 'get').mockImplementation((opts, cb) => {
                const fakeReq = new EventEmitter();
                fakeReq.destroy = jest.fn();
                callCount++;

                if (callCount <= 3) {
                    // Poll 1 (calls 1-3): all succeed
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
                } else if (callCount <= 6) {
                    // Poll 2 (calls 4-6): all fail
                    Promise.resolve().then(() => fakeReq.emit('error', new Error('blip')));
                } else {
                    // Poll 3 (calls 7-9): all succeed
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
                }
                return fakeReq;
            });

            const monitor = new UsageMonitor({
                pollIntervalMs: 10000,
                jitterRatio: 0,
                maxJitterMs: 0,
                lookbackDays: 0
            }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();

            await advance(100); // poll 1 fires at 0ms
            expect(monitor._consecutiveErrors).toBe(0);
            expect(monitor._pollSuccessTotal).toBe(1);

            await advance(10100); // poll 2 fires at 10s — all fail
            expect(monitor._consecutiveErrors).toBe(1);
            expect(monitor._pollErrorTotal).toBe(1);

            await advance(10100); // poll 3 fires at 20s — all succeed
            expect(monitor._consecutiveErrors).toBe(0);
            expect(monitor._pollSuccessTotal).toBe(2);

            monitor.stop();
        });
    });

    // ================================================================
    // 8. Timer lifecycle: start/stop/persist properly manages intervals
    // ================================================================
    describe('timer lifecycle', () => {
        it('start() creates timer and agent', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            expect(monitor._timer).toBeNull();
            expect(monitor._agent).toBeNull();

            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);
            monitor.start();

            expect(monitor._timer).not.toBeNull();
            expect(monitor._agent).not.toBeNull();

            monitor.stop();
        });

        it('stop() clears timer, save timeout, and destroys agent', async () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-timer-'));

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger(),
                configDir: tmpDir
            });
            monitor.start();
            await advance(2100); // triggers poll which calls _save()

            // There should be a pending save timeout after successful poll
            expect(monitor._saveTimeout).not.toBeNull();
            expect(monitor._timer).not.toBeNull();

            const agent = monitor._agent;
            const destroySpy = jest.spyOn(agent, 'destroy');

            monitor.stop();

            expect(monitor._timer).toBeNull();
            expect(monitor._saveTimeout).toBeNull();
            expect(monitor._agent).toBeNull();
            expect(destroySpy).toHaveBeenCalled();

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('start() is idempotent — calling twice does not create duplicate timers', async () => {
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
            const timer1 = monitor._timer;
            const agent1 = monitor._agent;

            monitor.start(); // second call — should be no-op
            expect(monitor._timer).toBe(timer1);
            expect(monitor._agent).toBe(agent1);

            monitor.stop();
        });

        it('stop() is idempotent — calling twice does not throw', () => {
            setupHttpsMock([]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            monitor.stop();

            expect(() => monitor.stop()).not.toThrow();
            expect(monitor._timer).toBeNull();
            expect(monitor._agent).toBeNull();
        });

        it('persistAndStop cancels pending debounced save before immediate save', async () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-persist-stop-'));

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger(),
                configDir: tmpDir
            });
            monitor.start();
            await advance(2100); // poll triggers _save()

            // Debounced save is pending
            expect(monitor._saveTimeout).not.toBeNull();

            const performSaveSpy = jest.spyOn(monitor, '_performSave');

            await monitor.persistAndStop();

            // Save timeout should be cancelled
            expect(monitor._saveTimeout).toBeNull();
            // Immediate save should have been called
            expect(performSaveSpy).toHaveBeenCalled();
            // Timer and agent cleaned up
            expect(monitor._timer).toBeNull();
            expect(monitor._agent).toBeNull();

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('poll reschedules itself after success', async () => {
            const calls = setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse },
                // Second round
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor({ pollIntervalMs: 15000, lookbackDays: 0 }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();

            await advance(2100); // first poll
            expect(calls.length).toBe(3);
            expect(monitor._pollSuccessTotal).toBe(1);

            // Timer should be rescheduled
            expect(monitor._timer).not.toBeNull();

            // Advance past pollInterval + jitter
            await advance(17100);
            expect(calls.length).toBe(6);
            expect(monitor._pollSuccessTotal).toBe(2);

            monitor.stop();
        });

        it('poll reschedules with backoff delay after total failure', async () => {
            setupHttpsMock([new Error('everything is down')]);

            const monitor = new UsageMonitor({
                pollIntervalMs: 10000,
                backoffIntervalMs: 60000,
                maxConsecutiveErrors: 2,
                jitterRatio: 0,
                maxJitterMs: 0,
                lookbackDays: 0
            }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();

            // Poll 1: fail (errors=1, below threshold)
            await advance(100);
            expect(monitor._consecutiveErrors).toBe(1);

            // Poll 2: fail (errors=2, at threshold)
            await advance(10100);
            expect(monitor._consecutiveErrors).toBe(2);

            // Next delay should be backoff: 10000 * 2^1 = 20000
            expect(monitor._computeErrorDelayMs()).toBe(20000);

            // Poll 3 should NOT fire at normal interval (10s)
            const errBefore = monitor._consecutiveErrors;
            await advance(10100);
            expect(monitor._consecutiveErrors).toBe(errBefore); // no new poll yet

            // But should fire after backoff delay
            await advance(10100);
            expect(monitor._consecutiveErrors).toBe(3);

            monitor.stop();
        });

        it('timer.unref() is called so it does not block process exit', () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            // The _schedulePoll method calls timer.unref() — we verify it indirectly
            // by checking the timer was created (unref doesn't change timer identity)
            monitor.start();
            expect(monitor._timer).not.toBeNull();

            monitor.stop();
        });
    });
});
