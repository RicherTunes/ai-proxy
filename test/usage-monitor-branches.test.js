'use strict';

/**
 * Branch coverage tests for lib/usage-monitor.js
 *
 * Targets all uncovered branches identified in the coverage report at 80.15%.
 * Each test group maps to specific uncovered line numbers and branch conditions.
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

async function advance(ms) {
    await jest.advanceTimersByTimeAsync(ms);
}

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

const quotaResponse = {
    code: 200, msg: 'OK', success: true,
    data: {
        limits: [
            {
                type: 'TIME_LIMIT', usage: 4000, currentValue: 85, remaining: 3915, percentage: 2,
                nextResetTime: 9999999,
                usageDetails: [{ modelCode: 'search-prime', usage: 61 }]
            },
            { type: 'TOKENS_LIMIT', percentage: 18, nextResetTime: 9999998 }
        ],
        level: 'max'
    }
};

const modelUsageResponse = {
    code: 200, msg: 'OK', success: true,
    data: {
        x_time: ['2026-02-19 19:00', '2026-02-19 20:00'],
        modelCallCount: [32, 16],
        tokensUsage: [1304455, 337315],
        totalUsage: { totalModelCallCount: 2406, totalTokensUsage: 99930426 }
    }
};

const toolUsageResponse = {
    code: 200, msg: 'OK', success: true,
    data: {
        x_time: ['2026-02-19 19:00', '2026-02-19 20:00'],
        networkSearchCount: [null, null],
        webReadMcpCount: [null, null],
        zreadMcpCount: [null, null],
        searchMcpCount: [null, null],
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

describe('UsageMonitor branch coverage', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.restoreAllMocks();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    // ================================================================
    // Line 31: constructor with no deps object (default = {})
    // ================================================================
    describe('constructor defaults', () => {
        it('handles missing deps object gracefully (line 31)', () => {
            // Constructor destructures with default = {}
            const monitor = new UsageMonitor({});
            expect(monitor._keyManager).toBeUndefined();
            expect(monitor._targetHost).toBe('api.z.ai');
            expect(monitor._persistEnabled).toBe(false);
        });
    });

    // ================================================================
    // Line 171: getSnapshot when _lastPollAt is null (staleness = Infinity)
    // ================================================================
    describe('getSnapshot staleness branch', () => {
        it('marks stale when _lastPollAt is null (line 171)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            // Manually set snapshot without _lastPollAt
            monitor._snapshot = { schemaVersion: 1 };
            monitor._lastPollAt = null;

            const snap = monitor.getSnapshot();
            // staleness = Infinity > any threshold, so stale = true
            expect(snap.stale).toBe(true);
        });

        it('marks stale=false when _lastPollAt is recent (line 171 truthy branch)', () => {
            const monitor = new UsageMonitor({ pollIntervalMs: 60000 }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._snapshot = { schemaVersion: 1 };
            monitor._lastPollAt = Date.now();

            const snap = monitor.getSnapshot();
            expect(snap.stale).toBe(false);
        });
    });

    // ================================================================
    // Lines 212-277: getDetails with partial or empty data
    // ================================================================
    describe('getDetails edge cases', () => {
        it('returns quota with empty limits when qData has no limits (lines 212-213)', () => {
            const monitor = new UsageMonitor({}, { keyManager: mockKeyManager() });
            monitor._sectionState.quota.data = { level: 'free' };
            // no limits array at all

            const details = monitor.getDetails();
            expect(details.quota.limits).toEqual([]);
            expect(details.quota.toolDetails).toEqual([]);
        });

        it('returns toolDetails=[] when TIME_LIMIT has no usageDetails (line 225)', () => {
            const monitor = new UsageMonitor({}, { keyManager: mockKeyManager() });
            monitor._sectionState.quota.data = {
                level: 'pro',
                limits: [{ type: 'TIME_LIMIT', usage: 100 }]
                // TIME_LIMIT exists but no usageDetails
            };

            const details = monitor.getDetails();
            // toolDetails stays empty since usageDetails is absent
            expect(details.quota.toolDetails).toEqual([]);
        });

        it('returns modelUsage with null timeSeries when cache is empty (lines 239-241)', () => {
            const monitor = new UsageMonitor({}, { keyManager: mockKeyManager() });
            monitor._sectionState.modelUsage.data = {
                totalUsage: { totalModelCallCount: 5, totalTokensUsage: 100 }
            };
            // timeSeriesCache is empty (default)

            const details = monitor.getDetails();
            expect(details.modelUsage.timeSeries).toBeNull();
            expect(details.modelUsage.totalRequests).toBe(5);
        });

        it('returns modelUsage with fallback totalUsage when missing (line 235)', () => {
            const monitor = new UsageMonitor({}, { keyManager: mockKeyManager() });
            monitor._sectionState.modelUsage.data = {};
            // no totalUsage

            const details = monitor.getDetails();
            expect(details.modelUsage.totalRequests).toBe(0);
            expect(details.modelUsage.totalTokens).toBe(0);
        });

        it('returns toolUsage with null timeSeries when tool cache is empty (lines 256-258)', () => {
            const monitor = new UsageMonitor({}, { keyManager: mockKeyManager() });
            monitor._sectionState.toolUsage.data = {
                totalUsage: { totalNetworkSearchCount: 3 }
            };
            // toolTimeSeriesCache is empty (default)

            const details = monitor.getDetails();
            expect(details.toolUsage.timeSeries).toBeNull();
            expect(details.toolUsage.tools.networkSearch).toBe(3);
        });

        it('returns toolUsage with fallback totalUsage when missing (line 248)', () => {
            const monitor = new UsageMonitor({}, { keyManager: mockKeyManager() });
            monitor._sectionState.toolUsage.data = {};
            // no totalUsage

            const details = monitor.getDetails();
            expect(details.toolUsage.tools.networkSearch).toBe(0);
            expect(details.toolUsage.toolDetails).toEqual([]);
        });

        it('returns toolUsage with fallback toolDetails when undefined (line 259)', () => {
            const monitor = new UsageMonitor({}, { keyManager: mockKeyManager() });
            monitor._sectionState.toolUsage.data = {
                totalUsage: { totalNetworkSearchCount: 1 }
                // no toolDetails
            };

            const details = monitor.getDetails();
            expect(details.toolUsage.toolDetails).toEqual([]);
        });
    });

    // ================================================================
    // Lines 303-342: _load with partial cache data
    // ================================================================
    describe('_load partial cache', () => {
        let tmpDir;

        beforeEach(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-umbranch-'));
        });

        afterEach(() => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('skips timeSeriesCache restore when not present (line 303 false)', () => {
            const cacheData = {
                version: 1,
                savedAt: Date.now(),
                // no timeSeriesCache
                sectionState: {
                    quota: { data: quotaResponse.data, lastSuccessAt: Date.now() }
                }
            };
            fs.writeFileSync(path.join(tmpDir, 'usage-cache.json'), JSON.stringify(cacheData));

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger(),
                configDir: tmpDir
            });

            // Should still have empty defaults
            expect(monitor._timeSeriesCache.times).toEqual([]);
        });

        it('skips timeSeriesCache when times is not an array (line 303 false)', () => {
            const cacheData = {
                version: 1,
                savedAt: Date.now(),
                timeSeriesCache: { times: 'not-array', callCounts: [], tokenCounts: [] }
            };
            fs.writeFileSync(path.join(tmpDir, 'usage-cache.json'), JSON.stringify(cacheData));

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger(),
                configDir: tmpDir
            });

            expect(monitor._timeSeriesCache.times).toEqual([]);
        });

        it('skips toolTimeSeriesCache restore when not present (line 312 false)', () => {
            const cacheData = {
                version: 1,
                savedAt: Date.now(),
                timeSeriesCache: { times: ['t1'], callCounts: [1], tokenCounts: [10] }
                // no toolTimeSeriesCache
            };
            fs.writeFileSync(path.join(tmpDir, 'usage-cache.json'), JSON.stringify(cacheData));

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger(),
                configDir: tmpDir
            });

            expect(monitor._timeSeriesCache.times).toEqual(['t1']);
            expect(monitor._toolTimeSeriesCache.times).toEqual([]);
        });

        it('skips backfill restore when not present (line 325 false)', () => {
            const cacheData = {
                version: 1,
                savedAt: Date.now(),
                timeSeriesCache: { times: ['t1'], callCounts: [1], tokenCounts: [10] }
                // no backfill
            };
            fs.writeFileSync(path.join(tmpDir, 'usage-cache.json'), JSON.stringify(cacheData));

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger(),
                configDir: tmpDir
            });

            expect(monitor._backfill.oldestFetchedMs).toBeNull();
            expect(monitor._backfill.complete).toBe(false);
        });

        it('skips sectionState restore when not present (line 331 false)', () => {
            const cacheData = {
                version: 1,
                savedAt: Date.now(),
                timeSeriesCache: { times: ['t1'], callCounts: [1], tokenCounts: [10] }
                // no sectionState
            };
            fs.writeFileSync(path.join(tmpDir, 'usage-cache.json'), JSON.stringify(cacheData));

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger(),
                configDir: tmpDir
            });

            expect(monitor._sectionState.quota.data).toBeNull();
        });

        it('skips individual section keys not present in sectionState (line 333 false)', () => {
            const cacheData = {
                version: 1,
                savedAt: Date.now(),
                sectionState: {
                    quota: { data: quotaResponse.data, lastSuccessAt: Date.now() }
                    // no modelUsage or toolUsage
                }
            };
            fs.writeFileSync(path.join(tmpDir, 'usage-cache.json'), JSON.stringify(cacheData));

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger(),
                configDir: tmpDir
            });

            expect(monitor._sectionState.quota.data).not.toBeNull();
            expect(monitor._sectionState.modelUsage.data).toBeNull();
        });

        it('does not rebuild snapshot when no quota or modelUsage data loaded (line 341 false)', () => {
            const cacheData = {
                version: 1,
                savedAt: Date.now(),
                sectionState: {
                    toolUsage: { data: toolUsageResponse.data, lastSuccessAt: Date.now() }
                }
            };
            fs.writeFileSync(path.join(tmpDir, 'usage-cache.json'), JSON.stringify(cacheData));

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger(),
                configDir: tmpDir
            });

            // Snapshot should remain null because neither quota nor modelUsage has data
            expect(monitor._snapshot).toBeNull();
        });

        it('restores callCounts/tokenCounts fallback to empty array when missing (lines 306-307)', () => {
            const cacheData = {
                version: 1,
                savedAt: Date.now(),
                timeSeriesCache: { times: ['t1'] }
                // callCounts and tokenCounts missing
            };
            fs.writeFileSync(path.join(tmpDir, 'usage-cache.json'), JSON.stringify(cacheData));

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger(),
                configDir: tmpDir
            });

            expect(monitor._timeSeriesCache.times).toEqual(['t1']);
            expect(monitor._timeSeriesCache.callCounts).toEqual([]);
            expect(monitor._timeSeriesCache.tokenCounts).toEqual([]);
        });

        it('restores tool fields fallback to empty arrays when missing (lines 315-318)', () => {
            const cacheData = {
                version: 1,
                savedAt: Date.now(),
                toolTimeSeriesCache: { times: ['t1'] }
                // all count fields missing
            };
            fs.writeFileSync(path.join(tmpDir, 'usage-cache.json'), JSON.stringify(cacheData));

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger(),
                configDir: tmpDir
            });

            expect(monitor._toolTimeSeriesCache.times).toEqual(['t1']);
            expect(monitor._toolTimeSeriesCache.networkSearchCount).toEqual([]);
            expect(monitor._toolTimeSeriesCache.webReadMcpCount).toEqual([]);
            expect(monitor._toolTimeSeriesCache.zreadMcpCount).toEqual([]);
            expect(monitor._toolTimeSeriesCache.searchMcpCount).toEqual([]);
        });

        it('restores backfill with null/undefined fields using defaults (lines 326-327)', () => {
            const cacheData = {
                version: 1,
                savedAt: Date.now(),
                backfill: {}
                // no oldestFetchedMs or complete
            };
            fs.writeFileSync(path.join(tmpDir, 'usage-cache.json'), JSON.stringify(cacheData));

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger(),
                configDir: tmpDir
            });

            expect(monitor._backfill.oldestFetchedMs).toBeNull();
            expect(monitor._backfill.complete).toBe(false);
        });
    });

    // ================================================================
    // Lines 417-420: _computeErrorDelayMs with NaN/falsy config
    // ================================================================
    describe('_computeErrorDelayMs fallback branches', () => {
        it('falls back to 1 for NaN pollIntervalMs (line 417)', () => {
            const monitor = new UsageMonitor({
                pollIntervalMs: NaN,
                backoffIntervalMs: 10,
                maxConsecutiveErrors: 1,
                backoffMultiplier: 2
            }, { keyManager: mockKeyManager() });

            monitor._consecutiveErrors = 0;
            expect(monitor._computeErrorDelayMs()).toBe(1);
        });

        it('falls back to basePoll for NaN backoffIntervalMs (line 418)', () => {
            const monitor = new UsageMonitor({
                pollIntervalMs: 100,
                backoffIntervalMs: NaN,
                maxConsecutiveErrors: 1,
                backoffMultiplier: 2
            }, { keyManager: mockKeyManager() });

            monitor._consecutiveErrors = 2;
            // backoffCapMs = max(100, NaN || 100) = 100
            // exp = 2, scaled = 100 * 2^2 = 400, capped at 100
            expect(monitor._computeErrorDelayMs()).toBe(100);
        });

        it('falls back to 1 for NaN maxConsecutiveErrors (line 419)', () => {
            const monitor = new UsageMonitor({
                pollIntervalMs: 100,
                backoffIntervalMs: 500,
                maxConsecutiveErrors: NaN,
                backoffMultiplier: 2
            }, { keyManager: mockKeyManager() });

            // threshold = 1, so errors=1 is AT threshold
            monitor._consecutiveErrors = 1;
            expect(monitor._computeErrorDelayMs()).toBe(200); // 100 * 2^1
        });

        it('falls back to 1 for NaN backoffMultiplier (line 420)', () => {
            const monitor = new UsageMonitor({
                pollIntervalMs: 100,
                backoffIntervalMs: 500,
                maxConsecutiveErrors: 1,
                backoffMultiplier: NaN
            }, { keyManager: mockKeyManager() });

            monitor._consecutiveErrors = 2;
            // multiplier = 1, exp = 2, scaled = 100 * 1^2 = 100
            expect(monitor._computeErrorDelayMs()).toBe(100);
        });

        it('falls back to 0 for undefined config values (line 417-420)', () => {
            const monitor = new UsageMonitor({
                pollIntervalMs: undefined,
                backoffIntervalMs: undefined,
                maxConsecutiveErrors: undefined,
                backoffMultiplier: undefined
            }, { keyManager: mockKeyManager() });

            monitor._consecutiveErrors = 0;
            expect(monitor._computeErrorDelayMs()).toBe(1);
        });
    });

    // ================================================================
    // Lines 468, 491, 509: Error message extraction from rejected promises
    // ================================================================
    describe('poll error message extraction', () => {
        it('handles rejected promise with no .message (fallback to Unknown error)', async () => {
            setupHttpsMock([
                // quota: rejected with Error that has no message
                new Error(),
                new Error(),
                new Error()
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            // All sections should have error strings
            expect(monitor._sectionState.quota.error).toBeTruthy();
            expect(monitor._sectionState.modelUsage.error).toBeTruthy();
            expect(monitor._sectionState.toolUsage.error).toBeTruthy();

            monitor.stop();
        });
    });

    // ================================================================
    // Lines 565-573, 576: _pruneTimeSeries with no entries to prune
    // ================================================================
    describe('_pruneTimeSeries no-prune branches', () => {
        it('skips model prune when all entries are within lookback (line 565 idx=0)', () => {
            const monitor = new UsageMonitor({ lookbackDays: 30 }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            const recent = monitor._formatTime(new Date(Date.now() - 1000));
            monitor._timeSeriesCache = {
                times: [recent],
                callCounts: [10],
                tokenCounts: [100]
            };
            monitor._toolTimeSeriesCache = {
                times: [],
                networkSearchCount: [],
                webReadMcpCount: [],
                zreadMcpCount: [],
                searchMcpCount: []
            };

            monitor._pruneTimeSeries();

            // Nothing pruned
            expect(monitor._timeSeriesCache.times).toEqual([recent]);
        });

        it('skips tool prune when all entries are within lookback (line 576 idx=0)', () => {
            const monitor = new UsageMonitor({ lookbackDays: 30 }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            const recent = monitor._formatTime(new Date(Date.now() - 1000));
            monitor._timeSeriesCache = { times: [], callCounts: [], tokenCounts: [] };
            monitor._toolTimeSeriesCache = {
                times: [recent],
                networkSearchCount: [1],
                webReadMcpCount: [2],
                zreadMcpCount: [0],
                searchMcpCount: [3]
            };

            monitor._pruneTimeSeries();

            expect(monitor._toolTimeSeriesCache.times).toEqual([recent]);
        });

        it('skips model prune when times is empty (line 562 false)', () => {
            const monitor = new UsageMonitor({ lookbackDays: 7 }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._timeSeriesCache = { times: [], callCounts: [], tokenCounts: [] };
            monitor._toolTimeSeriesCache = {
                times: [],
                networkSearchCount: [],
                webReadMcpCount: [],
                zreadMcpCount: [],
                searchMcpCount: []
            };

            monitor._pruneTimeSeries();
            expect(monitor._timeSeriesCache.times).toEqual([]);
        });
    });

    // ================================================================
    // Lines 596-597: _mergeTimeSeries with missing modelCallCount/tokensUsage
    // ================================================================
    describe('_mergeTimeSeries missing fields', () => {
        it('falls back to empty arrays for missing modelCallCount and tokensUsage (lines 596-597)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, { keyManager: mockKeyManager() });

            monitor._mergeTimeSeries({
                x_time: ['2026-02-19 10:00', '2026-02-19 11:00']
                // no modelCallCount or tokensUsage
            });

            expect(monitor._timeSeriesCache.times).toEqual(['2026-02-19 10:00', '2026-02-19 11:00']);
            expect(monitor._timeSeriesCache.callCounts).toEqual([undefined, undefined]);
            expect(monitor._timeSeriesCache.tokenCounts).toEqual([undefined, undefined]);
        });
    });

    // ================================================================
    // Line 682: _doBackfill early return branches
    // ================================================================
    describe('_doBackfill early returns', () => {
        it('returns immediately when backfill is already complete (line 682)', async () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor._backfill.complete = true;

            await monitor._doBackfill();
            // Should return without error
            expect(monitor._backfill.complete).toBe(true);
        });

        it('returns immediately when backfill is already in progress (line 682)', async () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor._backfill.inProgress = true;

            await monitor._doBackfill();
            // Should return without error
            expect(monitor._backfill.inProgress).toBe(true);
        });

        it('returns immediately when agent is null (stopped) (line 683)', async () => {
            const monitor = new UsageMonitor({ lookbackDays: 30 }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor._backfill.oldestFetchedMs = Date.now() - 86400000;
            // _agent is null (not started)

            await monitor._doBackfill();
            expect(monitor._backfill.complete).toBe(false);
        });
    });

    // ================================================================
    // Lines 746-775: _buildSnapshot quota branches
    // ================================================================
    describe('_buildSnapshot quota branches', () => {
        it('handles quota with empty limits array (line 746-748)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._sectionState.quota.data = { limits: [], level: 'basic' };
            monitor._lastPollAt = Date.now();
            const snap = monitor._buildSnapshot(Date.now());

            expect(snap.quota.level).toBe('basic');
            expect(snap.quota.tokenUsagePercent).toBeNull();
            expect(snap.quota.toolUsage).toBeNull();
        });

        it('handles quota with no limits property (line 746)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._sectionState.quota.data = { level: 'free' };
            monitor._lastPollAt = Date.now();
            const snap = monitor._buildSnapshot(Date.now());

            expect(snap.quota.level).toBe('free');
            expect(snap.quota.tokenUsagePercent).toBeNull();
            expect(snap.quota.toolUsage).toBeNull();
        });

        it('handles quota with only TIME_LIMIT but no TOKENS_LIMIT (line 747)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._sectionState.quota.data = {
                limits: [{ type: 'TIME_LIMIT', usage: 100, currentValue: 10, remaining: 90, percentage: 10 }],
                level: 'max'
            };
            monitor._lastPollAt = Date.now();
            const snap = monitor._buildSnapshot(Date.now());

            expect(snap.quota.tokenUsagePercent).toBeNull();
            expect(snap.quota.toolUsage).not.toBeNull();
            expect(snap.quota.toolUsage.limit).toBe(100);
        });

        it('handles TIME_LIMIT with exposeDetails=true and usageDetails (line 768)', () => {
            const monitor = new UsageMonitor({ exposeDetails: true }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._sectionState.quota.data = {
                limits: [{
                    type: 'TIME_LIMIT', usage: 100, currentValue: 10, remaining: 90, percentage: 10,
                    usageDetails: [{ modelCode: 'model-a', usage: 5 }, { modelCode: 'model-b', usage: 5 }]
                }],
                level: 'max'
            };
            monitor._lastPollAt = Date.now();
            const snap = monitor._buildSnapshot(Date.now());

            expect(snap.quota.toolDetails).toHaveLength(2);
            expect(snap.quota.toolDetails[0].model).toBe('model-a');
        });

        it('does not include toolDetails when exposeDetails=false (line 768 false)', () => {
            const monitor = new UsageMonitor({ exposeDetails: false }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._sectionState.quota.data = {
                limits: [{
                    type: 'TIME_LIMIT', usage: 100, currentValue: 10, remaining: 90, percentage: 10,
                    usageDetails: [{ modelCode: 'model-a', usage: 5 }]
                }],
                level: 'max'
            };
            monitor._lastPollAt = Date.now();
            const snap = monitor._buildSnapshot(Date.now());

            expect(snap.quota.toolDetails).toBeUndefined();
        });

        it('builds quota error section when no data but error exists (line 775)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._sectionState.quota.data = null;
            monitor._sectionState.quota.error = 'connection refused';
            monitor._sectionState.quota.lastSuccessAt = 12345;
            monitor._lastPollAt = Date.now();
            const snap = monitor._buildSnapshot(Date.now());

            expect(snap.quota.error).toBe('connection refused');
            expect(snap.quota.lastSuccessAt).toBe(12345);
            expect(snap.quota.level).toBeUndefined();
        });
    });

    // ================================================================
    // Lines 787-809: _buildSnapshot modelUsage branches
    // ================================================================
    describe('_buildSnapshot modelUsage branches', () => {
        it('builds modelUsage without timeSeries when cache is empty (line 796 false)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._sectionState.modelUsage.data = {
                totalUsage: { totalModelCallCount: 50, totalTokensUsage: 10000 }
            };
            monitor._timeSeriesCache = { times: [], callCounts: [], tokenCounts: [] };
            monitor._lastPollAt = Date.now();
            const snap = monitor._buildSnapshot(Date.now());

            expect(snap.modelUsage.totalRequests).toBe(50);
            expect(snap.modelUsage.timeSeries).toBeUndefined();
        });

        it('handles modelUsage with non-object totalUsage (line 787)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._sectionState.modelUsage.data = {
                totalUsage: 'not-an-object'
            };
            monitor._lastPollAt = Date.now();
            const snap = monitor._buildSnapshot(Date.now());

            expect(snap.modelUsage.totalRequests).toBe(0);
            expect(snap.modelUsage.totalTokens).toBe(0);
        });

        it('builds modelUsage error section when no data but error exists (line 804)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._sectionState.modelUsage.data = null;
            monitor._sectionState.modelUsage.error = 'timeout';
            monitor._sectionState.modelUsage.lastSuccessAt = 99999;
            monitor._lastPollAt = Date.now();
            const snap = monitor._buildSnapshot(Date.now());

            expect(snap.modelUsage.error).toBe('timeout');
            expect(snap.modelUsage.lastSuccessAt).toBe(99999);
            expect(snap.modelUsage.totalRequests).toBeUndefined();
        });
    });

    // ================================================================
    // Lines 816-836: _buildSnapshot toolUsage branches
    // ================================================================
    describe('_buildSnapshot toolUsage branches', () => {
        it('handles toolUsage with non-object totalUsage (line 816)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._sectionState.toolUsage.data = {
                totalUsage: 'bad'
            };
            monitor._lastPollAt = Date.now();
            const snap = monitor._buildSnapshot(Date.now());

            expect(snap.toolUsage.tools.networkSearch).toBe(0);
        });

        it('includes toolDetails when exposeDetails=true (line 828)', () => {
            const monitor = new UsageMonitor({ exposeDetails: true }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._sectionState.toolUsage.data = {
                totalUsage: {
                    totalNetworkSearchCount: 5,
                    toolDetails: [{ name: 'tool-a', count: 3 }]
                }
            };
            monitor._lastPollAt = Date.now();
            const snap = monitor._buildSnapshot(Date.now());

            expect(snap.toolUsage.toolDetails).toEqual([{ name: 'tool-a', count: 3 }]);
        });

        it('does not include toolDetails when exposeDetails=false (line 828 false)', () => {
            const monitor = new UsageMonitor({ exposeDetails: false }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._sectionState.toolUsage.data = {
                totalUsage: { toolDetails: [{ name: 'x' }] }
            };
            monitor._lastPollAt = Date.now();
            const snap = monitor._buildSnapshot(Date.now());

            expect(snap.toolUsage.toolDetails).toBeUndefined();
        });

        it('builds toolUsage error section when no data but error exists (line 832)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._sectionState.toolUsage.data = null;
            monitor._sectionState.toolUsage.error = 'server error';
            monitor._sectionState.toolUsage.lastSuccessAt = 77777;
            monitor._lastPollAt = Date.now();
            const snap = monitor._buildSnapshot(Date.now());

            expect(snap.toolUsage.error).toBe('server error');
            expect(snap.toolUsage.lastSuccessAt).toBe(77777);
        });
    });

    // ================================================================
    // Line 857: _computeSourceFlags with null/undefined sectionState
    // ================================================================
    describe('_computeSourceFlags edge cases', () => {
        it('handles null sectionState (line 857)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._sectionState = null;
            const flags = monitor._computeSourceFlags();
            expect(flags.partial).toBe(false);
            expect(flags.sourceUnavailable).toBe(false);
        });

        it('handles undefined sectionState (line 857)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._sectionState = undefined;
            const flags = monitor._computeSourceFlags();
            expect(flags.partial).toBe(false);
            expect(flags.sourceUnavailable).toBe(false);
        });

        it('partial=true when one section has error but others have data', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._sectionState.quota.error = 'fail';
            monitor._sectionState.quota.data = null;
            monitor._sectionState.modelUsage.data = { some: 'data' };
            monitor._sectionState.toolUsage.data = { some: 'data' };

            const flags = monitor._computeSourceFlags();
            expect(flags.partial).toBe(true);
            expect(flags.sourceUnavailable).toBe(false);
        });
    });

    // ================================================================
    // Lines 922-923, 937: _enforceTimeSeriesBounds edge cases
    // ================================================================
    describe('_enforceTimeSeriesBounds edge cases', () => {
        it('returns early when maxTimeSeriesPoints is 0 (line 923)', () => {
            const monitor = new UsageMonitor({ maxTimeSeriesPoints: 0 }, {
                keyManager: mockKeyManager()
            });

            monitor._timeSeriesCache = { times: ['a', 'b', 'c'], callCounts: [1, 2, 3], tokenCounts: [10, 20, 30] };
            monitor._enforceTimeSeriesBounds();

            // Nothing enforced
            expect(monitor._timeSeriesCache.times).toEqual(['a', 'b', 'c']);
        });

        it('returns early when maxTimeSeriesPoints is negative (line 923)', () => {
            const monitor = new UsageMonitor({ maxTimeSeriesPoints: -1 }, {
                keyManager: mockKeyManager()
            });

            monitor._timeSeriesCache = { times: ['a', 'b'], callCounts: [1, 2], tokenCounts: [10, 20] };
            monitor._enforceTimeSeriesBounds();

            expect(monitor._timeSeriesCache.times).toEqual(['a', 'b']);
        });

        it('handles tool cache field being null/undefined (line 937)', () => {
            const monitor = new UsageMonitor({ maxTimeSeriesPoints: 1 }, {
                keyManager: mockKeyManager()
            });

            monitor._toolTimeSeriesCache = {
                times: ['a', 'b'],
                networkSearchCount: null,
                webReadMcpCount: undefined,
                zreadMcpCount: [1, 2],
                searchMcpCount: [3, 4]
            };

            monitor._enforceTimeSeriesBounds();

            expect(monitor._toolTimeSeriesCache.times).toEqual(['b']);
            // null/undefined fields get fallback to empty array, then sliced
            expect(monitor._toolTimeSeriesCache.networkSearchCount).toEqual([]);
            expect(monitor._toolTimeSeriesCache.webReadMcpCount).toEqual([]);
            expect(monitor._toolTimeSeriesCache.zreadMcpCount).toEqual([2]);
            expect(monitor._toolTimeSeriesCache.searchMcpCount).toEqual([4]);
        });
    });

    // ================================================================
    // Line 954: _fetchUnwrapped with envelope code but no data
    // ================================================================
    describe('_fetchUnwrapped envelope handling', () => {
        it('throws on envelope with code but no data (line 954)', async () => {
            setupHttpsMock([
                { statusCode: 200, body: { code: 500, msg: 'Server Error', success: false } },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            // Quota should have an API error
            expect(monitor._sectionState.quota.error).toMatch(/API error.*Server Error/);
            monitor.stop();
        });

        it('handles envelope with code but null msg (line 954 fallback)', async () => {
            setupHttpsMock([
                { statusCode: 200, body: { code: 403 } },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100);

            expect(monitor._sectionState.quota.error).toMatch(/API error.*Unknown/);
            monitor.stop();
        });
    });

    // ================================================================
    // Line 1020: _rotateKey with no keys
    // ================================================================
    describe('_rotateKey edge cases', () => {
        it('does nothing when keyManager has no keys (line 1020)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager([]),
                logger: mockLogger()
            });

            const indexBefore = monitor._currentKeyIndex;
            monitor._rotateKey();
            expect(monitor._currentKeyIndex).toBe(indexBefore);
        });

        it('does nothing when keyManager is undefined (line 1020)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                logger: mockLogger()
            });

            monitor._rotateKey();
            expect(monitor._currentKeyIndex).toBe(0);
        });
    });

    // ================================================================
    // Line 1069: _checkRateJump with one series below minDataPoints
    // ================================================================
    describe('_checkRateJump branch coverage', () => {
        it('skips specific series with fewer than minDataPoints (line 1069)', () => {
            const monitor = new UsageMonitor({
                anomaly: { enabled: true, rateJumpThreshold: 2.5, minDataPoints: 6 }
            }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            const callback = jest.fn();
            monitor.setAnomalyCallback(callback);

            // tokenCounts has 10 points (sufficient), callCounts has 3 (insufficient)
            monitor._timeSeriesCache = {
                times: Array.from({ length: 10 }, (_, i) => `t${i}`),
                tokenCounts: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100],
                callCounts: [10, 10, 10] // only 3 points, below minDataPoints=6
            };

            monitor._checkRateJump({});
            // Only tokenCounts would be checked, callCounts is skipped
            // tokenCounts has no spike so no alert
            expect(callback).not.toHaveBeenCalled();
        });

        it('fires drop alert for negative z-score (lines 1079-1083)', () => {
            const monitor = new UsageMonitor({
                anomaly: { enabled: true, rateJumpThreshold: 2.5, minDataPoints: 6, cooldownMs: 3600000 }
            }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            const callback = jest.fn();
            monitor.setAnomalyCallback(callback);

            // Last value is a big drop
            monitor._timeSeriesCache = {
                times: Array.from({ length: 10 }, (_, i) => `t${i}`),
                tokenCounts: [1000, 1010, 990, 1005, 995, 1000, 1003, 997, 1001, 100],
                callCounts: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10]
            };

            monitor._checkRateJump({});
            expect(callback).toHaveBeenCalled();
            const alert = callback.mock.calls[0][0];
            expect(alert.data.direction).toBe('drop');
            expect(alert.severity).toBe('info');
        });

        it('skips series when stdDev is 0 (line 1075)', () => {
            const monitor = new UsageMonitor({
                anomaly: { enabled: true, rateJumpThreshold: 2.5, minDataPoints: 6 }
            }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            const callback = jest.fn();
            monitor.setAnomalyCallback(callback);

            // All values identical → stdDev = 0
            monitor._timeSeriesCache = {
                times: Array.from({ length: 10 }, (_, i) => `t${i}`),
                tokenCounts: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100],
                callCounts: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10]
            };

            monitor._checkRateJump({});
            expect(callback).not.toHaveBeenCalled();
        });
    });

    // ================================================================
    // Line 1109: _checkStaleFeed with null lastPollAt
    // ================================================================
    describe('_checkStaleFeed staleSinceMs branch', () => {
        it('sets staleSinceMs to null when lastPollAt is null (line 1109)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            const alerts = [];
            monitor.setAnomalyCallback(alert => alerts.push(alert));

            monitor._staleFeedAlerted = false;
            monitor._checkStaleFeed({ stale: true, lastPollAt: null }, null);

            expect(alerts).toHaveLength(1);
            expect(alerts[0].data.staleSinceMs).toBeNull();
            expect(alerts[0].data.lastPollAt).toBeNull();
        });
    });

    // ================================================================
    // Line 1129: _checkQuotaWarning with percent <= 1 (fraction branch)
    // ================================================================
    describe('_checkQuotaWarning fraction branch', () => {
        it('treats percent <= 1 as already a fraction (line 1129)', () => {
            const monitor = new UsageMonitor({
                anomaly: { enabled: true, quotaWarningThresholds: [0.8, 0.95], cooldownMs: 3600000 }
            }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            const callback = jest.fn();
            monitor.setAnomalyCallback(callback);

            // percent = 0.85 → already a fraction, no division by 100
            monitor._checkQuotaWarning({ quota: { tokenUsagePercent: 0.85, level: 'pro' } });

            expect(callback).toHaveBeenCalled();
            const alert = callback.mock.calls[0][0];
            expect(alert.data.currentPercent).toBe(85);
            expect(alert.data.threshold).toBe(0.8);
        });

        it('skips when percent is null (line 1127 null)', () => {
            const monitor = new UsageMonitor({
                anomaly: { enabled: true, quotaWarningThresholds: [0.8] }
            }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            const callback = jest.fn();
            monitor.setAnomalyCallback(callback);

            monitor._checkQuotaWarning({ quota: { tokenUsagePercent: null } });
            expect(callback).not.toHaveBeenCalled();
        });

        it('skips when percent is not a number (line 1127 typeof)', () => {
            const monitor = new UsageMonitor({
                anomaly: { enabled: true, quotaWarningThresholds: [0.8] }
            }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            const callback = jest.fn();
            monitor.setAnomalyCallback(callback);

            monitor._checkQuotaWarning({ quota: { tokenUsagePercent: 'high' } });
            expect(callback).not.toHaveBeenCalled();
        });

        it('skips when quota is missing (line 1126)', () => {
            const monitor = new UsageMonitor({
                anomaly: { enabled: true, quotaWarningThresholds: [0.8] }
            }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            const callback = jest.fn();
            monitor.setAnomalyCallback(callback);

            monitor._checkQuotaWarning({});
            expect(callback).not.toHaveBeenCalled();
        });
    });

    // ================================================================
    // Line 1176: _fireAnomaly with no callback
    // ================================================================
    describe('_fireAnomaly without callback', () => {
        it('records alert even when no callback is set (line 1176 false)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            // No callback set — _onAnomalyAlert is null
            expect(monitor._onAnomalyAlert).toBeNull();

            monitor._fireAnomaly('test.no_cb', 'info', { message: 'test', data: {} });

            const alerts = monitor.getAnomalyAlerts();
            expect(alerts).toHaveLength(1);
            expect(alerts[0].type).toBe('test.no_cb');
        });
    });

    // ================================================================
    // _scheduleBackfill + _doBackfill integration
    // ================================================================
    describe('_scheduleBackfill scheduling', () => {
        it('schedules backfill after initial poll sets oldestFetchedMs', async () => {
            const calls = setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse },
                // backfill chunk
                { statusCode: 200, body: modelUsageResponse }
            ]);

            const monitor = new UsageMonitor({ lookbackDays: 7 }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });
            monitor.start();
            await advance(2100); // regular poll

            expect(monitor._backfill.oldestFetchedMs).not.toBeNull();
            expect(calls.length).toBe(3);

            // Backfill fires 5s later
            await advance(6000);
            expect(calls.length).toBe(4);
            expect(calls[3].path).toContain('model-usage');

            monitor.stop();
        });
    });

    // ================================================================
    // _doBackfill error handling (error in fetch, not in _doBackfill itself)
    // ================================================================
    describe('_doBackfill error during fetch', () => {
        it('handles fetch error without corrupting existing data', async () => {
            let callNum = 0;
            jest.spyOn(https, 'get').mockImplementation((opts, cb) => {
                const fakeReq = new EventEmitter();
                fakeReq.destroy = jest.fn();
                callNum++;

                if (callNum <= 3) {
                    // Regular poll: succeed
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
                    // Backfill fetch: fail
                    Promise.resolve().then(() => fakeReq.emit('error', new Error('backfill network error')));
                }
                return fakeReq;
            });

            const logger = mockLogger();
            const monitor = new UsageMonitor({ lookbackDays: 30 }, {
                keyManager: mockKeyManager(),
                logger
            });

            monitor.start();
            await advance(2100); // regular poll

            const tsBefore = [...(monitor._timeSeriesCache?.times || [])];
            // Time series may or may not have data depending on poll response parsing;
            // the key invariant is that backfill error doesn't corrupt whatever state exists

            await advance(6000); // backfill fails

            // Time-series data must be preserved
            expect(monitor._timeSeriesCache.times).toEqual(tsBefore);
            expect(monitor._backfill.complete).toBe(false);
            expect(monitor._backfill.inProgress).toBe(false);
            expect(logger.warn).toHaveBeenCalledWith(
                'Usage monitor: backfill chunk failed, will retry next cycle',
                expect.objectContaining({ error: 'backfill network error' })
            );

            monitor.stop();
        });
    });

    // ================================================================
    // _doBackfill completion — backfillComplete flag set after all data
    // ================================================================
    describe('_doBackfill completion flag', () => {
        it('sets backfillComplete when oldestFetchedMs already at target', async () => {
            const monitor = new UsageMonitor({ lookbackDays: 1 }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            // Simulate state where we've already fetched beyond the target
            monitor._backfill.oldestFetchedMs = Date.now() - 2 * 86400000; // 2 days ago
            monitor._agent = new https.Agent(); // simulate started

            await monitor._doBackfill();

            expect(monitor._backfill.complete).toBe(true);
            monitor._agent.destroy();
        });
    });

    // ================================================================
    // Line 526: anomaly detection disabled branch in _poll
    // ================================================================
    describe('anomaly detection disabled in poll', () => {
        it('skips _checkAnomalies when disabled', async () => {
            setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor({
                lookbackDays: 0,
                anomaly: { enabled: false }
            }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            const spy = jest.spyOn(monitor, '_checkAnomalies');
            monitor.start();
            await advance(2100);

            expect(spy).not.toHaveBeenCalled();
            monitor.stop();
        });
    });

    // ================================================================
    // Validation: quota.limits non-array branch (line 879-880)
    // ================================================================
    describe('_validateSectionPayload additional branches', () => {
        it('rejects modelUsage.totalUsage as array (line 889)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, { keyManager: mockKeyManager() });
            const result = monitor._validateSectionPayload('modelUsage', { totalUsage: [1, 2] });
            expect(result.valid).toBe(false);
            expect(result.error).toContain('totalUsage must be an object');
        });

        it('rejects toolUsage.totalUsage as array (line 899)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, { keyManager: mockKeyManager() });
            const result = monitor._validateSectionPayload('toolUsage', { totalUsage: [1, 2] });
            expect(result.valid).toBe(false);
            expect(result.error).toContain('totalUsage must be an object');
        });

        it('accepts quota.level as null (line 882)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, { keyManager: mockKeyManager() });
            const result = monitor._validateSectionPayload('quota', { level: null });
            expect(result.valid).toBe(true);
        });

        it('accepts quota.level as undefined (line 882)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, { keyManager: mockKeyManager() });
            const result = monitor._validateSectionPayload('quota', {});
            expect(result.valid).toBe(true);
        });

        it('rejects quota payload that is an array (line 874)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, { keyManager: mockKeyManager() });
            const result = monitor._validateSectionPayload('quota', [1, 2]);
            expect(result.valid).toBe(false);
            expect(result.error).toBe('payload must be an object');
        });
    });

    // ================================================================
    // _mergeToolTimeSeries with missing fields
    // ================================================================
    describe('_mergeToolTimeSeries missing fields', () => {
        it('falls back to empty arrays for missing tool count fields', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, { keyManager: mockKeyManager() });

            monitor._mergeToolTimeSeries({
                x_time: ['2026-01-01 10:00']
                // all count fields missing
            });

            expect(monitor._toolTimeSeriesCache.times).toEqual(['2026-01-01 10:00']);
            expect(monitor._toolTimeSeriesCache.networkSearchCount).toEqual([undefined]);
        });
    });

    // ================================================================
    // Remaining branches: level falsy, persistAndStop without save timer,
    // savedAt falsy, nullish coalescing in TIME_LIMIT fields
    // ================================================================
    describe('remaining branch gaps', () => {
        it('getDetails level falls back to null for empty string (line 212)', () => {
            const monitor = new UsageMonitor({}, { keyManager: mockKeyManager() });
            monitor._sectionState.quota.data = { limits: [], level: '' };

            const details = monitor.getDetails();
            expect(details.quota.level).toBeNull();
        });

        it('persistAndStop works when no saveTimeout is pending (line 277 false)', async () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            // Not started, so no _saveTimeout
            expect(monitor._saveTimeout).toBeNull();

            // Should not throw
            await monitor.persistAndStop();
            expect(monitor._timer).toBeNull();
        });

        it('_load uses Date.now() when savedAt is falsy (line 342)', () => {
            let tmpDir;
            try {
                tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-umbranch-'));

                const cacheData = {
                    version: 1,
                    savedAt: 0, // falsy
                    sectionState: {
                        quota: { data: quotaResponse.data, lastSuccessAt: 100 }
                    }
                };
                fs.writeFileSync(path.join(tmpDir, 'usage-cache.json'), JSON.stringify(cacheData));

                const monitor = new UsageMonitor(NO_BACKFILL, {
                    keyManager: mockKeyManager(),
                    logger: mockLogger(),
                    configDir: tmpDir
                });

                // savedAt=0 is falsy, so _lastPollAt should be Date.now()
                expect(monitor._lastPollAt).toBeGreaterThan(0);
                expect(monitor._snapshot).not.toBeNull();
            } finally {
                if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });

        it('_buildSnapshot level falls back to null for falsy values (line 751)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._sectionState.quota.data = { limits: [], level: 0 };
            monitor._lastPollAt = Date.now();
            const snap = monitor._buildSnapshot(Date.now());

            expect(snap.quota.level).toBeNull();
        });

        it('_buildSnapshot TIME_LIMIT fields fall back via ?? when null (lines 762-765)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._sectionState.quota.data = {
                limits: [{
                    type: 'TIME_LIMIT',
                    usage: null,
                    currentValue: null,
                    remaining: null,
                    percentage: null
                }],
                level: 'max'
            };
            monitor._lastPollAt = Date.now();
            const snap = monitor._buildSnapshot(Date.now());

            expect(snap.quota.toolUsage.limit).toBe(0);
            expect(snap.quota.toolUsage.used).toBe(0);
            expect(snap.quota.toolUsage.remaining).toBe(0);
            expect(snap.quota.toolUsage.percent).toBe(0);
        });

        it('_buildSnapshot TIME_LIMIT fields use actual values when present (lines 762-765)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            monitor._sectionState.quota.data = {
                limits: [{
                    type: 'TIME_LIMIT',
                    usage: 500,
                    currentValue: 50,
                    remaining: 450,
                    percentage: 10
                }],
                level: 'max'
            };
            monitor._lastPollAt = Date.now();
            const snap = monitor._buildSnapshot(Date.now());

            expect(snap.quota.toolUsage.limit).toBe(500);
            expect(snap.quota.toolUsage.used).toBe(50);
            expect(snap.quota.toolUsage.remaining).toBe(450);
            expect(snap.quota.toolUsage.percent).toBe(10);
        });
    });
});
