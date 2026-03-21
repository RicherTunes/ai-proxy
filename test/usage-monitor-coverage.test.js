'use strict';

/**
 * Coverage tests for lib/usage-monitor.js
 * Targets uncovered lines: 365, 395, 674-675, 859, 875, 883, 893, 903, 908, 914, 1180
 * Also targets uncovered functions: _scheduleBackfill, _doBackfill, backfill setTimeout callback
 */

// Mock atomic-write BEFORE requiring UsageMonitor so the destructured binding gets our mock
jest.mock('../lib/atomic-write', () => ({
    atomicWrite: jest.fn().mockImplementation(async () => {})
}));

const { atomicWrite } = require('../lib/atomic-write');
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
            { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 18, nextResetTime: 1771631247854 }
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

describe('UsageMonitor Coverage', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.restoreAllMocks();
        // Reset atomicWrite mock to default (resolves successfully)
        atomicWrite.mockImplementation(async () => {});
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    // ================================================================
    // Line 395: _performSave catch — atomicWrite rejects
    // ================================================================
    describe('_performSave error handling', () => {
        let tmpDir;

        beforeEach(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-umcov-'));
        });

        afterEach(() => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('logs warning when atomicWrite rejects (line 395)', async () => {
            const logger = mockLogger();
            atomicWrite.mockRejectedValueOnce(new Error('permission denied'));

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger,
                configDir: tmpDir
            });

            await monitor._performSave();

            expect(logger.warn).toHaveBeenCalledWith(
                'Usage monitor: failed to save cache',
                { error: 'permission denied' }
            );
        });
    });

    // ================================================================
    // Line 365: _save debounced callback catch — _performSave rejects
    // ================================================================
    describe('_save debounced error handling', () => {
        let tmpDir;

        beforeEach(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-umcov-'));
        });

        afterEach(() => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('logs warning when debounced save callback fails (line 365)', async () => {
            const logger = mockLogger();
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger,
                configDir: tmpDir
            });

            // Spy on _performSave to reject — bypasses atomicWrite entirely
            jest.spyOn(monitor, '_performSave').mockRejectedValueOnce(new Error('disk full'));

            monitor._save();
            await advance(15000); // Past SAVE_DEBOUNCE_MS (10000ms)

            expect(logger.warn).toHaveBeenCalledWith(
                'Usage monitor: save failed in debounced callback',
                { error: 'disk full' }
            );
        });
    });

    // ================================================================
    // Lines 674-675: _scheduleBackfill catch — _doBackfill rejects
    // ================================================================
    it('logs warning and resets inProgress when backfill fails (lines 674-675)', async () => {
        const logger = mockLogger();
        const monitor = new UsageMonitor({ lookbackDays: 30 }, {
            keyManager: mockKeyManager(),
            logger
        });

        // Set inProgress=true so the assertion that it gets reset is meaningful
        monitor._backfill.inProgress = true;

        // Replace _doBackfill entirely so its internal try/catch doesn't swallow the error
        jest.spyOn(monitor, '_doBackfill').mockRejectedValueOnce(new Error('backfill crash'));

        monitor._scheduleBackfill();
        await advance(6000); // Past the 5000ms backfill delay

        expect(logger.warn).toHaveBeenCalledWith(
            'Usage monitor: backfill failed',
            { error: 'backfill crash' }
        );
        expect(monitor._backfill.inProgress).toBe(false);
    });

    // ================================================================
    // Line 859: _computeSourceFlags — empty sectionState
    // ================================================================
    it('returns both flags false when sectionState is empty (line 859)', () => {
        const monitor = new UsageMonitor(NO_BACKFILL, {
            keyManager: mockKeyManager(),
            logger: mockLogger()
        });

        const origState = monitor._sectionState;
        monitor._sectionState = {};

        const flags = monitor._computeSourceFlags();
        expect(flags.partial).toBe(false);
        expect(flags.sourceUnavailable).toBe(false);

        monitor._sectionState = origState;
    });

    // ================================================================
    // Schema validation branches (lines 875, 883, 893, 903, 908)
    // ================================================================
    describe('_validateSectionPayload branches', () => {
        // Line 875: non-object payload
        it('rejects non-object payload (line 875)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, { keyManager: mockKeyManager() });
            const result = monitor._validateSectionPayload('quota', 'not-an-object');
            expect(result.valid).toBe(false);
            expect(result.error).toBe('payload must be an object');
        });

        // Line 875: null payload (also not an object per _isObject)
        it('rejects null payload (line 875)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, { keyManager: mockKeyManager() });
            const result = monitor._validateSectionPayload('modelUsage', null);
            expect(result.valid).toBe(false);
            expect(result.error).toBe('payload must be an object');
        });

        // Line 883: quota.level is not a string (and not null)
        it('rejects quota payload with numeric level (line 883)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, { keyManager: mockKeyManager() });
            const result = monitor._validateSectionPayload('quota', { level: 123 });
            expect(result.valid).toBe(false);
            expect(result.error).toBe('quota.level must be a string when provided');
        });

        // Line 883: quota.level is an array (not a string)
        it('rejects quota payload with array level (line 883)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, { keyManager: mockKeyManager() });
            const result = monitor._validateSectionPayload('quota', { level: ['max'] });
            expect(result.valid).toBe(false);
            expect(result.error).toBe('quota.level must be a string when provided');
        });

        // Line 893: modelUsage.x_time is not an array
        it('rejects modelUsage payload with string x_time (line 893)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, { keyManager: mockKeyManager() });
            const result = monitor._validateSectionPayload('modelUsage', { x_time: 'bad' });
            expect(result.valid).toBe(false);
            expect(result.error).toBe('modelUsage.x_time must be an array when provided');
        });

        // Line 903: toolUsage.x_time is not an array
        it('rejects toolUsage payload with numeric x_time (line 903)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, { keyManager: mockKeyManager() });
            const result = monitor._validateSectionPayload('toolUsage', { x_time: 42 });
            expect(result.valid).toBe(false);
            expect(result.error).toBe('toolUsage.x_time must be an array when provided');
        });

        // Line 908: unknown section name falls through to default return
        it('returns valid for unknown section name (line 908)', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, { keyManager: mockKeyManager() });
            const result = monitor._validateSectionPayload('unknownSection', { data: 1 });
            expect(result.valid).toBe(true);
        });
    });

    // ================================================================
    // Line 914: _recordSchemaValidationError — unknown section
    // ================================================================
    it('creates counter for previously unknown section (line 914)', () => {
        const logger = mockLogger();
        const monitor = new UsageMonitor(NO_BACKFILL, {
            keyManager: mockKeyManager(),
            logger
        });

        // Add the section to _sectionState so line 917 doesn't crash,
        // but NOT in _schemaValidationBySection so line 914 triggers
        monitor._sectionState.customSection = { data: null, lastSuccessAt: null, error: null };

        monitor._recordSchemaValidationError('customSection', 'bad format');

        expect(monitor._schemaValidationErrorTotal).toBe(1);
        expect(monitor._schemaValidationBySection.customSection).toBe(1);
        expect(monitor._sectionState.customSection.error).toBe('Schema validation failed: bad format');
        expect(logger.warn).toHaveBeenCalledWith(
            'Usage monitor: schema validation failed',
            { section: 'customSection', reason: 'bad format' }
        );
    });

    // ================================================================
    // Line 1180: _fireAnomaly — anomaly callback throws
    // ================================================================
    it('catches and logs error thrown by anomaly callback (line 1180)', () => {
        const logger = mockLogger();
        const monitor = new UsageMonitor(NO_BACKFILL, {
            keyManager: mockKeyManager(),
            logger
        });

        monitor.setAnomalyCallback(() => { throw new Error('callback crashed'); });
        monitor._anomalyCooldowns = {}; // Clear cooldowns so alert fires

        monitor._fireAnomaly('test.cb_error', 'warning', { message: 'test', data: {} });

        expect(logger.error).toHaveBeenCalledWith(
            'Anomaly callback error',
            { error: 'callback crashed' }
        );
        // Alert should still be recorded despite callback error
        const alerts = monitor.getAnomalyAlerts();
        expect(alerts).toHaveLength(1);
        expect(alerts[0].type).toBe('test.cb_error');
        expect(alerts[0].severity).toBe('warning');
    });

    // ================================================================
    // Function coverage: _scheduleBackfill + _doBackfill via normal poll
    // ================================================================
    describe('backfill triggered by poll', () => {
        it('schedules and executes backfill after successful poll', async () => {
            const logger = mockLogger();
            const calls = setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse },
                { statusCode: 200, body: modelUsageResponse }
            ]);

            const monitor = new UsageMonitor({ lookbackDays: 7 }, {
                keyManager: mockKeyManager(),
                logger
            });

            monitor.start();
            await advance(2100); // Regular poll completes

            // 3 calls for quota, model-usage, tool-usage
            expect(calls.length).toBe(3);

            // Advance past backfill delay (5000ms)
            await advance(6000);

            // 1 more call for backfill model-usage fetch
            expect(calls.length).toBe(4);
            expect(calls[3].path).toContain('model-usage');

            // With lookbackDays=7, 1 chunk covers the full lookback window
            expect(monitor._backfill.complete).toBe(true);
            expect(logger.info).toHaveBeenCalledWith(
                'Usage monitor: backfill complete',
                expect.objectContaining({ days: 7 })
            );

            monitor.stop();
        });

        it('schedules additional backfill chunk when first chunk does not complete', async () => {
            const logger = mockLogger();
            const calls = setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse },
                // Multiple backfill chunks (lookbackDays=30 needs ~4 chunks of 7 days)
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: modelUsageResponse }
            ]);

            const monitor = new UsageMonitor({ lookbackDays: 30 }, {
                keyManager: mockKeyManager(),
                logger
            });

            monitor.start();
            await advance(2100); // Regular poll

            // 3 calls for regular poll
            expect(calls.length).toBe(3);

            // Advance through multiple backfill cycles (each 5000ms)
            await advance(6000); // First backfill chunk
            expect(calls.length).toBeGreaterThanOrEqual(4);

            await advance(6000); // Second backfill chunk
            expect(calls.length).toBeGreaterThanOrEqual(5);

            await advance(6000); // Third backfill chunk
            expect(calls.length).toBeGreaterThanOrEqual(6);

            await advance(6000); // Fourth backfill chunk
            expect(calls.length).toBeGreaterThanOrEqual(7);

            monitor.stop();
        });
    });

    // ================================================================
    // Function coverage: _rotateKey via 401 response
    // ================================================================
    describe('_rotateKey via auth failure', () => {
        it('rotates key when receiving 401 response', async () => {
            const logger = mockLogger();
            const calls = setupHttpsMock([
                { statusCode: 401, body: {} },  // quota 401
                { statusCode: 200, body: modelUsageResponse },
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger
            });

            monitor.start();
            await advance(2100);

            // Should have attempted all 3 calls
            expect(calls.length).toBe(3);

            // Key should have rotated after 401
            expect(logger.warn).toHaveBeenCalledWith(
                'Usage monitor: rotating key after auth failure',
                { newKeyIndex: expect.any(Number) }
            );

            monitor.stop();
        });

        it('rotates key when receiving 403 response', async () => {
            const logger = mockLogger();
            const calls = setupHttpsMock([
                { statusCode: 200, body: quotaResponse },
                { statusCode: 403, body: {} },  // model-usage 403
                { statusCode: 200, body: toolUsageResponse }
            ]);

            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger
            });

            monitor.start();
            await advance(2100);

            expect(calls.length).toBe(3);
            expect(logger.warn).toHaveBeenCalledWith(
                'Usage monitor: rotating key after auth failure',
                { newKeyIndex: expect.any(Number) }
            );

            monitor.stop();
        });
    });

    // ================================================================
    // Function coverage: _checkStaleFeed branches
    // ================================================================
    describe('_checkStaleFeed anomaly detection', () => {
        it('fires stale alert when feed becomes stale', () => {
            const logger = mockLogger();
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger
            });

            // Set up callback to capture alerts
            const alerts = [];
            monitor.setAnomalyCallback(alert => alerts.push(alert));

            // Simulate stale snapshot (stale=true for first time)
            monitor._staleFeedAlerted = false;
            monitor._checkStaleFeed({ stale: true, lastPollAt: Date.now() - 300000 }, null);

            expect(alerts.length).toBe(1);
            expect(alerts[0].type).toBe('usage.feed_stale');
            expect(alerts[0].severity).toBe('warning');
            expect(monitor._staleFeedAlerted).toBe(true);
        });

        it('fires recovery alert when feed recovers from stale', () => {
            const logger = mockLogger();
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger
            });

            const alerts = [];
            monitor.setAnomalyCallback(alert => alerts.push(alert));

            // First, trigger stale alert
            monitor._staleFeedAlerted = false;
            monitor._checkStaleFeed({ stale: true, lastPollAt: 1000 }, null);
            expect(alerts.length).toBe(1);

            // Then, trigger recovery
            monitor._checkStaleFeed({ stale: false, lastPollAt: Date.now() }, { stale: true });
            expect(alerts.length).toBe(2);
            expect(alerts[1].type).toBe('usage.feed_recovered');
            expect(alerts[1].severity).toBe('info');
            expect(monitor._staleFeedAlerted).toBe(false);
        });

        it('does not fire stale alert when already alerted', () => {
            const monitor = new UsageMonitor(NO_BACKFILL, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            const alerts = [];
            monitor.setAnomalyCallback(alert => alerts.push(alert));

            // Already alerted
            monitor._staleFeedAlerted = true;
            monitor._checkStaleFeed({ stale: true, lastPollAt: 1000 }, null);

            // Should NOT fire another alert
            expect(alerts.length).toBe(0);
        });
    });

    // ================================================================
    // Function coverage: getDetails with full data
    // ================================================================
    describe('getDetails exercises all map callbacks', () => {
        it('returns quota with limits and toolDetails when data present', () => {
            const monitor = new UsageMonitor({ exposeDetails: true }, {
                keyManager: mockKeyManager(),
                logger: mockLogger()
            });

            // Set up section state with full quota data
            monitor._sectionState.quota.data = {
                level: 'max',
                limits: [
                    {
                        type: 'TIME_LIMIT',
                        usage: 4000,
                        currentValue: 85,
                        remaining: 3915,
                        percentage: 2,
                        nextResetTime: Date.now() + 86400000,
                        usageDetails: [
                            { modelCode: 'search-prime', usage: 61 },
                            { modelCode: 'web-reader', usage: 24 }
                        ]
                    },
                    {
                        type: 'TOKENS_LIMIT',
                        percentage: 18,
                        nextResetTime: Date.now() + 86400000
                    }
                ]
            };

            monitor._sectionState.modelUsage.data = {
                totalUsage: { totalModelCallCount: 100, totalTokensUsage: 5000 },
                x_time: ['2026-02-19 19:00'],
                modelCallCount: [50],
                tokensUsage: [2500]
            };

            monitor._sectionState.toolUsage.data = {
                totalUsage: {
                    totalNetworkSearchCount: 10,
                    totalWebReadMcpCount: 5,
                    totalZreadMcpCount: 0,
                    totalSearchMcpCount: 3,
                    toolDetails: [{ name: 'tool1' }]
                },
                x_time: ['2026-02-19 19:00'],
                networkSearchCount: [5]
            };

            // Populate time-series cache
            monitor._timeSeriesCache = {
                times: ['2026-02-19 19:00'],
                callCounts: [50],
                tokenCounts: [2500]
            };

            monitor._toolTimeSeriesCache = {
                times: ['2026-02-19 19:00'],
                networkSearchCount: [5],
                webReadMcpCount: [2],
                zreadMcpCount: [0],
                searchMcpCount: [1]
            };

            const details = monitor.getDetails();

            // Verify limits map callback was exercised
            expect(details.quota).not.toBeNull();
            expect(details.quota.limits).toHaveLength(2);
            expect(details.quota.limits[0].type).toBe('TIME_LIMIT');
            expect(details.quota.limits[0].usage).toBe(4000);

            // Verify toolDetails map callback was exercised
            expect(details.quota.toolDetails).toHaveLength(2);
            expect(details.quota.toolDetails[0].model).toBe('search-prime');
            expect(details.quota.toolDetails[0].usage).toBe(61);

            // Verify modelUsage time-series
            expect(details.modelUsage).not.toBeNull();
            expect(details.modelUsage.timeSeries).not.toBeNull();
            expect(details.modelUsage.timeSeries.times).toEqual(['2026-02-19 19:00']);

            // Verify toolUsage
            expect(details.toolUsage).not.toBeNull();
            expect(details.toolUsage.tools.networkSearch).toBe(10);
            expect(details.toolUsage.timeSeries).not.toBeNull();
        });
    });
});
