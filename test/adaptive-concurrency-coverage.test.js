'use strict';

const {
    AdaptiveConcurrencyController,
    ModelWindow,
    GlobalAccountWindow,
    DEFAULT_CONFIG
} = require('../lib/adaptive-concurrency');

describe('AdaptiveConcurrencyController — coverage gaps', () => {
    let controller;
    let mockKeyManager;
    let mockLogger;
    let mockStatsAggregator;

    beforeEach(() => {
        jest.useFakeTimers();
        mockKeyManager = {
            _limits: new Map(),
            _staticLimits: new Map(),
            setEffectiveModelLimit: jest.fn((model, limit) => {
                mockKeyManager._limits.set(model, limit);
            }),
            getEffectiveModelLimit: jest.fn((model) => {
                return mockKeyManager._limits.get(model);
            }),
            getStaticModelLimit: jest.fn((model) => {
                return mockKeyManager._staticLimits.get(model);
            }),
            restoreStaticLimits: jest.fn(() => {
                for (const [model, staticLimit] of mockKeyManager._staticLimits) {
                    mockKeyManager._limits.set(model, staticLimit);
                }
            })
        };
        mockLogger = {
            info: jest.fn(),
            warn: jest.fn(),
            debug: jest.fn(),
            error: jest.fn()
        };
        mockStatsAggregator = {
            recordAdaptiveConcurrency: jest.fn()
        };
    });

    afterEach(() => {
        controller?.stop();
        jest.useRealTimers();
    });

    function createController(configOverrides = {}) {
        const config = {
            enabled: true,
            mode: 'enforce',
            tickIntervalMs: 2000,
            decreaseFactor: 0.5,
            recoveryDelayMs: 5000,
            minWindow: 1,
            growthCleanTicks: 2,
            growthMode: 'fixed_ticks',
            minHoldMs: 4000,
            idleTimeoutMs: 300000,
            idleDecayStep: 1,
            quotaRetryAfterMs: 60000,
            treatUnknownAsCongestion: true,
            globalMaxConcurrency: 0,
            ...configOverrides
        };
        controller = new AdaptiveConcurrencyController(config, {
            keyManager: mockKeyManager,
            logger: mockLogger,
            statsAggregator: mockStatsAggregator
        });
        return controller;
    }

    function seedModel(ctrl, model, staticMax) {
        mockKeyManager._staticLimits.set(model, staticMax);
        mockKeyManager._limits.set(model, staticMax);
        ctrl._getOrCreate(model);
        const w = ctrl._windows.get(model);
        w.staticMax = staticMax;
        w.effectiveMax = staticMax;
        w.lastAdjustAt = Date.now() - 10000;
        return w;
    }

    // ---------------------------------------------------------------
    // Line 133: recordCongestion with global window
    // ---------------------------------------------------------------

    describe('global window — congestion tracking', () => {
        // Covers line 133: _globalWindow.congestionCount++ in recordCongestion
        test('recordCongestion increments global window congestionCount when globalMaxConcurrency > 0', () => {
            createController({ globalMaxConcurrency: 100 });
            seedModel(controller, 'model-a', 10);

            controller.recordCongestion('model-a', { retryAfterMs: 2000 });

            expect(controller._globalWindow.congestionCount).toBe(1);
        });

        // Covers line 133: ensures global window congestion is tracked across multiple calls
        test('recordCongestion accumulates congestion in global window across models', () => {
            createController({ globalMaxConcurrency: 100 });
            seedModel(controller, 'model-a', 10);
            seedModel(controller, 'model-b', 10);

            controller.recordCongestion('model-a', { retryAfterMs: 2000 });
            controller.recordCongestion('model-b', { retryAfterMs: 3000 });

            expect(controller._globalWindow.congestionCount).toBe(2);
        });
    });

    // ---------------------------------------------------------------
    // Line 149: recordSuccess with global window
    // ---------------------------------------------------------------

    describe('global window — success tracking', () => {
        // Covers line 149: _globalWindow.successCount++ in recordSuccess
        test('recordSuccess increments global window successCount when globalMaxConcurrency > 0', () => {
            createController({ globalMaxConcurrency: 100 });
            seedModel(controller, 'model-a', 10);

            controller.recordSuccess('model-a');

            expect(controller._globalWindow.successCount).toBe(1);
        });

        // Covers line 149: ensures global window success is tracked across multiple calls
        test('recordSuccess accumulates successes in global window across models', () => {
            createController({ globalMaxConcurrency: 100 });
            seedModel(controller, 'model-a', 10);
            seedModel(controller, 'model-b', 10);

            controller.recordSuccess('model-a');
            controller.recordSuccess('model-b');
            controller.recordSuccess('model-a');

            expect(controller._globalWindow.successCount).toBe(3);
        });
    });

    // ---------------------------------------------------------------
    // Line 486: oscillation detection during idle decay
    // ---------------------------------------------------------------

    describe('idle decay — oscillation detection', () => {
        // Covers line 486: oscillation warning in idle decay path
        test('oscillation warning logged when idle decay triggers rapid adjustments', () => {
            createController({
                idleTimeoutMs: 1000,
                minHoldMs: 0,
                idleDecayStep: 1
            });
            const w = seedModel(controller, 'model-a', 10);
            w.effectiveMax = 5;

            // Create oscillation by having 4+ recent adjustments within 30 seconds
            const now = Date.now();
            // Push 4 adjustment timestamps to trigger oscillation (>3 in 30s)
            w.adjustTimestamps = [now - 25000, now - 20000, now - 15000, now - 10000];

            // Trigger idle decay
            w.lastTrafficAt = now - 2000;

            controller._tick();

            // Oscillation warning should be logged
            expect(mockLogger.warn).toHaveBeenCalledWith(
                'AIMD oscillation detected',
                expect.objectContaining({
                    model: 'model-a',
                    reason: 'idle_decay'
                })
            );
        });

        // Covers line 486: verifies adjustTimestamps ring buffer management during idle decay
        test('idle decay oscillation maintains adjustTimestamps ring buffer size', () => {
            createController({
                idleTimeoutMs: 1000,
                minHoldMs: 0,
                idleDecayStep: 1
            });
            const w = seedModel(controller, 'model-a', 10);
            w.effectiveMax = 5;

            // Fill adjustTimestamps with 10 entries (max)
            const now = Date.now();
            w.adjustTimestamps = [];
            for (let i = 0; i < 10; i++) {
                w.adjustTimestamps.push(now - (30000 - i * 1000));
            }

            w.lastTrafficAt = now - 2000;
            controller._tick();

            // Should still have at most 10 entries (shift happens when > 10)
            expect(w.adjustTimestamps.length).toBeLessThanOrEqual(10);
        });
    });

    // ---------------------------------------------------------------
    // Additional branch coverage: updateStaticBaseline when effectiveMax >= oldStatic
    // ---------------------------------------------------------------

    describe('updateStaticBaseline — effectiveMax at ceiling', () => {
        // Covers line 282-283: raises effectiveMax when it was at or above old static
        test('updateStaticBaseline raises effectiveMax when it was at old staticMax', () => {
            createController({ mode: 'enforce' });
            const w = seedModel(controller, 'model-a', 10);
            // effectiveMax is at staticMax (10)
            expect(w.effectiveMax).toBe(10);

            const result = controller.updateStaticBaseline('model-a', 15);

            expect(result).toBe(true);
            expect(w.effectiveMax).toBe(15); // Raised to new staticMax
            expect(w.staticMax).toBe(15);
        });

        // Covers line 282-283: does not raise effectiveMax when below old static
        test('updateStaticBaseline does not raise effectiveMax when below old staticMax', () => {
            createController({ mode: 'enforce' });
            const w = seedModel(controller, 'model-a', 10);
            w.effectiveMax = 5; // Below staticMax

            const result = controller.updateStaticBaseline('model-a', 15);

            expect(result).toBe(true);
            expect(w.effectiveMax).toBe(5); // Unchanged
            expect(w.staticMax).toBe(15);
        });

        // Covers line 278: returns false for unknown model
        test('updateStaticBaseline returns false for unknown model', () => {
            createController();

            const result = controller.updateStaticBaseline('unknown-model', 10);

            expect(result).toBe(false);
        });

        // Covers line 285-286: writes to keyManager in enforce mode
        test('updateStaticBaseline writes to keyManager in enforce mode', () => {
            createController({ mode: 'enforce' });
            seedModel(controller, 'model-a', 10);

            controller.updateStaticBaseline('model-a', 15);

            expect(mockKeyManager.setEffectiveModelLimit).toHaveBeenCalledWith('model-a', 15);
        });
    });

    // ---------------------------------------------------------------
    // Branch: _getOrCreate returns null when staticMax is undefined
    // ---------------------------------------------------------------

    describe('_getOrCreate — unknown model handling', () => {
        // Covers line 307: returns null when staticMax is undefined
        test('_getOrCreate returns null when keyManager has no static limit', () => {
            createController();
            // getStaticModelLimit returns undefined for unknown model
            mockKeyManager.getStaticModelLimit.mockReturnValue(undefined);

            const result = controller._getOrCreate('phantom-model');

            expect(result).toBeNull();
            expect(controller._windows.has('phantom-model')).toBe(false);
        });

        // Covers line 307: ensures recordCongestion handles null from _getOrCreate
        test('recordCongestion does not create window for unknown model', () => {
            createController();
            mockKeyManager.getStaticModelLimit.mockReturnValue(undefined);

            controller.recordCongestion('phantom-model', { retryAfterMs: 2000 });

            expect(controller._windows.has('phantom-model')).toBe(false);
        });

        // Covers line 307: ensures recordSuccess handles null from _getOrCreate
        test('recordSuccess does not create window for unknown model', () => {
            createController();
            mockKeyManager.getStaticModelLimit.mockReturnValue(undefined);

            controller.recordSuccess('phantom-model');

            expect(controller._windows.has('phantom-model')).toBe(false);
        });
    });

    // ---------------------------------------------------------------
    // Branch: _enforceGlobalWindow proportional reduction
    // ---------------------------------------------------------------

    describe('global window enforcement', () => {
        // Covers line 567-587: global window enforcement when sum exceeds max
        test('_enforceGlobalWindow proportionally reduces model limits when sum exceeds globalMax', () => {
            createController({ globalMaxConcurrency: 15 });
            const wA = seedModel(controller, 'model-a', 10);
            const wB = seedModel(controller, 'model-b', 10);
            // Sum = 20, globalMax = 15, ratio = 15/20 = 0.75

            controller._tick();

            // model-a: floor(10 * 0.75) = 7
            expect(wA.effectiveMax).toBe(7);
            // model-b: floor(10 * 0.75) = 7
            expect(wB.effectiveMax).toBe(7);
        });

        // Covers line 567: does nothing when sum <= globalMax
        test('_enforceGlobalWindow does nothing when sum is within globalMax', () => {
            createController({ globalMaxConcurrency: 100 });
            const w = seedModel(controller, 'model-a', 10);

            controller._tick();

            expect(w.effectiveMax).toBe(10);
        });

        // Covers line 579-581: writes to keyManager in enforce mode during global enforcement
        test('global enforcement writes to keyManager in enforce mode', () => {
            createController({ globalMaxConcurrency: 15, mode: 'enforce' });
            seedModel(controller, 'model-a', 10);
            seedModel(controller, 'model-b', 10);

            controller._tick();

            expect(mockKeyManager.setEffectiveModelLimit).toHaveBeenCalledWith('model-a', 7);
            expect(mockKeyManager.setEffectiveModelLimit).toHaveBeenCalledWith('model-b', 7);
        });
    });

    // ---------------------------------------------------------------
    // Branch: unknown 429 classification when treatUnknownAsCongestion = false
    // ---------------------------------------------------------------

    describe('unknown 429 classification', () => {
        // Covers line 411-417: unknown_skip when treatUnknownAsCongestion = false
        test('unknown 429 is skipped when treatUnknownAsCongestion is false', () => {
            createController({ treatUnknownAsCongestion: false });
            const w = seedModel(controller, 'model-a', 10);

            // Unknown 429: no retryAfter, no errorCode
            controller.recordCongestion('model-a', { retryAfterMs: null, errorCode: null });
            controller._tick();

            // Window should NOT decrease
            expect(w.effectiveMax).toBe(10);
            expect(w.lastAdjustReason).toBe('unknown_skip');
        });

        // Covers line 413-416: debug log for unknown skip
        test('unknown skip logs debug message', () => {
            createController({ treatUnknownAsCongestion: false });
            seedModel(controller, 'model-a', 10);

            controller.recordCongestion('model-a', { retryAfterMs: null, errorCode: null });
            controller._tick();

            expect(mockLogger.debug).toHaveBeenCalledWith(
                'Unknown 429 classification, not shrinking',
                expect.objectContaining({ model: 'model-a' })
            );
        });
    });

    // ---------------------------------------------------------------
    // Branch: quota classification with error body
    // ---------------------------------------------------------------

    describe('quota 429 detection', () => {
        // Covers line 126-128: quota detection via error body containing "quota"
        test('quota is detected when errorBody contains "quota" string', () => {
            createController();
            const w = seedModel(controller, 'model-a', 10);

            // Quota signal via error body
            controller.recordCongestion('model-a', {
                retryAfterMs: 2000,
                errorCode: null,
                errorBody: 'exceeded your quota limit'
            });
            controller._tick();

            // Quota skip — no decrease
            expect(w.effectiveMax).toBe(10);
            expect(w.lastAdjustReason).toBe('quota_skip');
        });

        // Covers line 126: quota detection via errorCode
        test('quota is detected when errorCode is quota_exceeded', () => {
            createController();
            const w = seedModel(controller, 'model-a', 10);

            controller.recordCongestion('model-a', {
                retryAfterMs: 2000,
                errorCode: 'quota_exceeded'
            });
            controller._tick();

            expect(w.effectiveMax).toBe(10);
            expect(w.lastAdjustReason).toBe('quota_skip');
        });

        // Covers line 119-120: quota detection via high retryAfter
        test('quota is detected when retryAfterMs exceeds quotaRetryAfterMs', () => {
            createController({ quotaRetryAfterMs: 60000 });
            const w = seedModel(controller, 'model-a', 10);

            // High retry-after indicates quota, not congestion
            controller.recordCongestion('model-a', { retryAfterMs: 120000 });
            controller._tick();

            expect(w.effectiveMax).toBe(10);
            expect(w.lastAdjustReason).toBe('quota_skip');
        });
    });

    // ---------------------------------------------------------------
    // Branch: setMode transitions
    // ---------------------------------------------------------------

    describe('setMode transitions', () => {
        // Covers line 253-257: enforce mode transition pushes limits
        test('setMode to enforce pushes current windows to keyManager', () => {
            createController({ mode: 'observe_only' });
            const w = seedModel(controller, 'model-a', 10);
            w.effectiveMax = 7;

            controller.setMode('enforce');

            expect(mockKeyManager.setEffectiveModelLimit).toHaveBeenCalledWith('model-a', 7);
        });

        // Covers line 260-261: observe_only transition restores static limits
        test('setMode to observe_only restores static limits', () => {
            createController({ mode: 'enforce' });
            seedModel(controller, 'model-a', 10);

            controller.setMode('observe_only');

            expect(mockKeyManager.restoreStaticLimits).toHaveBeenCalled();
        });

        // Covers line 247-248: invalid mode throws error
        test('setMode throws for invalid mode', () => {
            createController();

            expect(() => controller.setMode('invalid')).toThrow('Invalid mode: invalid');
        });

        // Covers line 250-251: same mode returns previous mode
        test('setMode returns previous and current mode', () => {
            createController({ mode: 'observe_only' });

            const result = controller.setMode('enforce');

            expect(result).toEqual({ previousMode: 'observe_only', currentMode: 'enforce' });
        });
    });

    // ---------------------------------------------------------------
    // Branch: invalid mode coerced to observe_only
    // ---------------------------------------------------------------

    describe('invalid mode coercion', () => {
        // Covers line 86-88: invalid mode coerced to observe_only
        test('constructor coerces invalid mode to observe_only', () => {
            createController({ mode: 'invalid_mode' });

            expect(controller.config.mode).toBe('observe_only');
        });

        // Covers line 86-88: null mode coerced to observe_only
        test('constructor coerces null mode to observe_only', () => {
            createController({ mode: null });

            expect(controller.config.mode).toBe('observe_only');
        });
    });

    // ---------------------------------------------------------------
    // Branch: _classify429 classification logic
    // ---------------------------------------------------------------

    describe('_classify429 classification', () => {
        // Covers line 516: quota classification
        test('_classify429 returns quota when quotaHitCount > 0', () => {
            createController();
            const w = seedModel(controller, 'model-a', 10);
            w.quotaHitCount = 1;
            w.congestionCount = 5;

            const result = controller._classify429(w);

            expect(result).toBe('quota');
        });

        // Covers line 517: unknown classification
        test('_classify429 returns unknown when all hits are unknown', () => {
            createController();
            const w = seedModel(controller, 'model-a', 10);
            w.unknownHitCount = 3;
            w.congestionCount = 3; // All congestion is unknown
            w.quotaHitCount = 0;

            const result = controller._classify429(w);

            expect(result).toBe('unknown');
        });

        // Covers line 518: congestion classification
        test('_classify429 returns congestion when mixed hits', () => {
            createController();
            const w = seedModel(controller, 'model-a', 10);
            w.unknownHitCount = 1;
            w.congestionCount = 5; // Not all unknown
            w.quotaHitCount = 0;

            const result = controller._classify429(w);

            expect(result).toBe('congestion');
        });
    });

    // ---------------------------------------------------------------
    // Branch: _recordHistory ring buffer
    // ---------------------------------------------------------------

    describe('_recordHistory ring buffer', () => {
        // Covers line 555-556: history caps at 100 entries
        test('_recordHistory caps history at 100 entries', () => {
            createController();
            const w = seedModel(controller, 'model-a', 10);

            // Fill history with 100 entries
            for (let i = 0; i < 105; i++) {
                controller._recordHistory(w, Date.now() + i, 10 - i, 10 - i + 1, 'test', null);
            }

            expect(w.history.length).toBeLessThanOrEqual(100);
        });
    });

    // ---------------------------------------------------------------
    // Line 69: GlobalAccountWindow with falsy globalMax
    // ---------------------------------------------------------------

    describe('GlobalAccountWindow — falsy globalMax', () => {
        // Covers line 69: globalMax || Infinity when globalMax is 0
        test('GlobalAccountWindow uses Infinity when globalMax is 0', () => {
            const { GlobalAccountWindow } = require('../lib/adaptive-concurrency');
            const gw = new GlobalAccountWindow(0);

            expect(gw.effectiveMax).toBe(Infinity);
        });

        // Covers line 69: globalMax || Infinity when globalMax is null
        test('GlobalAccountWindow uses Infinity when globalMax is null', () => {
            const { GlobalAccountWindow } = require('../lib/adaptive-concurrency');
            const gw = new GlobalAccountWindow(null);

            expect(gw.effectiveMax).toBe(Infinity);
        });
    });

    // ---------------------------------------------------------------
    // Line 90: default logger when none provided
    // ---------------------------------------------------------------

    describe('default logger', () => {
        // Covers line 90: logger defaults to no-op object when not provided
        test('controller uses default no-op logger when none provided', () => {
            controller = new AdaptiveConcurrencyController(
                { mode: 'enforce' },
                { keyManager: mockKeyManager } // No logger
            );

            // Should not throw when logging
            expect(() => controller._logger.info('test')).not.toThrow();
            expect(() => controller._logger.warn('test')).not.toThrow();
            expect(() => controller._logger.debug('test')).not.toThrow();
            expect(() => controller._logger.error('test')).not.toThrow();
        });
    });

    // ---------------------------------------------------------------
    // Line 390: adjustTimestamps ring buffer shift during congestion decrease
    // ---------------------------------------------------------------

    describe('adjustTimestamps ring buffer — congestion path', () => {
        // Covers line 390: adjustTimestamps.shift() when length > 10 during decrease
        test('congestion decrease shifts adjustTimestamps when length exceeds 10', () => {
            createController({ minHoldMs: 0 });
            const w = seedModel(controller, 'model-a', 10);

            // Pre-fill adjustTimestamps with exactly 10 entries
            const baseTime = Date.now() - 50000;
            w.adjustTimestamps = [];
            for (let i = 0; i < 10; i++) {
                w.adjustTimestamps.push(baseTime + i * 1000);
            }
            const firstTimestamp = w.adjustTimestamps[0];

            controller.recordCongestion('model-a', { retryAfterMs: 2000 });
            controller._tick();

            // Should have shifted one and added one, still 10 entries
            expect(w.adjustTimestamps.length).toBe(10);
            expect(w.adjustTimestamps[0]).not.toBe(firstTimestamp);
        });
    });

    // ---------------------------------------------------------------
    // Line 433 & 444: proportional growth and effectiveMax change
    // ---------------------------------------------------------------

    describe('proportional growth — effectiveMax change', () => {
        // Covers line 433: growthAllowed = true in proportional mode
        // Covers line 444: effectiveMax !== prev check during growth
        test('proportional growth sets growthAllowed=true and changes effectiveMax', () => {
            createController({
                growthMode: 'proportional',
                minHoldMs: 0,
                recoveryDelayMs: 0
            });
            const w = seedModel(controller, 'model-a', 50);
            w.effectiveMax = 10;
            w.lastCongestionAt = 0;

            controller.recordSuccess('model-a');
            controller._tick();

            // Growth step = max(1, ceil(50 * 0.1)) = 5
            // effectiveMax should change from 10 to 15
            expect(w.effectiveMax).toBe(15);
            expect(w.totalAdjustmentsUp).toBe(1);
            expect(w.lastAdjustReason).toBe('additive_increase');
        });

        // Covers line 444: effectiveMax === prev (no change) during growth
        test('growth does not increment counters when effectiveMax unchanged', () => {
            createController({
                growthMode: 'fixed_ticks',
                growthCleanTicks: 1,
                minHoldMs: 0,
                recoveryDelayMs: 0
            });
            const w = seedModel(controller, 'model-a', 10);
            w.effectiveMax = 10; // Already at staticMax
            w.lastCongestionAt = 0;

            controller.recordSuccess('model-a');
            controller._tick();

            // Already at staticMax, no change
            expect(w.effectiveMax).toBe(10);
            expect(w.totalAdjustmentsUp).toBe(0);
        });
    });

    // ---------------------------------------------------------------
    // Line 479: idle decay effectiveMax !== prev
    // ---------------------------------------------------------------

    describe('idle decay — effectiveMax change check', () => {
        // Covers line 479: effectiveMax !== prev during idle decay
        test('idle decay updates counters only when effectiveMax actually changes', () => {
            createController({ idleTimeoutMs: 1000, minHoldMs: 0, idleDecayStep: 1 });
            const w = seedModel(controller, 'model-a', 10);
            w.effectiveMax = 9;
            w.lastTrafficAt = Date.now() - 2000;

            controller._tick();

            // effectiveMax should increase from 9 to 10
            expect(w.effectiveMax).toBe(10);
            expect(w.lastAdjustReason).toBe('idle_decay');
        });

        // Covers line 479: effectiveMax === prev during idle decay (no change)
        test('idle decay does nothing when effectiveMax already at staticMax', () => {
            createController({ idleTimeoutMs: 1000, minHoldMs: 0 });
            const w = seedModel(controller, 'model-a', 10);
            w.effectiveMax = 10; // Already at staticMax
            w.lastTrafficAt = Date.now() - 2000;

            controller._tick();

            // No change
            expect(w.effectiveMax).toBe(10);
            // lastAdjustReason should remain unchanged from initial
        });
    });

    // ---------------------------------------------------------------
    // Line 452: adjustTimestamps ring buffer during growth
    // ---------------------------------------------------------------

    describe('adjustTimestamps ring buffer — growth path', () => {
        // Covers line 452: adjustTimestamps.shift() when length > 10 during growth
        test('growth shifts adjustTimestamps when length exceeds 10', () => {
            createController({
                growthMode: 'proportional',
                minHoldMs: 0,
                recoveryDelayMs: 0
            });
            const w = seedModel(controller, 'model-a', 100);
            w.effectiveMax = 10;
            w.lastCongestionAt = 0;

            // Pre-fill adjustTimestamps with 10 entries
            const baseTime = Date.now() - 50000;
            w.adjustTimestamps = [];
            for (let i = 0; i < 10; i++) {
                w.adjustTimestamps.push(baseTime + i * 1000);
            }

            controller.recordSuccess('model-a');
            controller._tick();

            // Should have shifted and added, still 10
            expect(w.adjustTimestamps.length).toBe(10);
        });
    });

    // ---------------------------------------------------------------
    // Oscillation detection in congestion decrease path
    // ---------------------------------------------------------------

    describe('oscillation detection — congestion decrease', () => {
        // Covers line 391-397: oscillation warning during congestion decrease
        test('congestion decrease logs oscillation warning when detected', () => {
            createController({ minHoldMs: 0 });
            const w = seedModel(controller, 'model-a', 10);

            // Create oscillation: 4+ recent adjustments
            const now = Date.now();
            w.adjustTimestamps = [now - 5000, now - 4000, now - 3000, now - 2000];

            controller.recordCongestion('model-a', { retryAfterMs: 2000 });
            controller._tick();

            expect(mockLogger.warn).toHaveBeenCalledWith(
                'AIMD oscillation detected',
                expect.objectContaining({
                    model: 'model-a',
                    reason: 'decrease_congestion'
                })
            );
        });
    });

    // ---------------------------------------------------------------
    // Oscillation detection in growth path
    // ---------------------------------------------------------------

    describe('oscillation detection — growth', () => {
        // Covers line 453-459: oscillation warning during growth
        test('growth logs oscillation warning when detected', () => {
            createController({
                minHoldMs: 0,
                growthCleanTicks: 1,
                recoveryDelayMs: 0
            });
            const w = seedModel(controller, 'model-a', 10);
            w.effectiveMax = 5;
            w.lastCongestionAt = 0;

            // Create oscillation: 4+ recent adjustments
            const now = Date.now();
            w.adjustTimestamps = [now - 5000, now - 4000, now - 3000, now - 2000];

            controller.recordSuccess('model-a');
            controller._tick();

            expect(mockLogger.warn).toHaveBeenCalledWith(
                'AIMD oscillation detected',
                expect.objectContaining({
                    model: 'model-a',
                    reason: 'additive_increase'
                })
            );
        });
    });

    // ---------------------------------------------------------------
    // StatsAggregator optional
    // ---------------------------------------------------------------

    describe('optional statsAggregator', () => {
        // Covers line 91: statsAggregator defaults to null
        test('controller works without statsAggregator', () => {
            controller = new AdaptiveConcurrencyController(
                { mode: 'enforce' },
                { keyManager: mockKeyManager, logger: mockLogger }
            );
            seedModel(controller, 'model-a', 10);

            // Should not throw during tick
            expect(() => controller._tick()).not.toThrow();
        });
    });

    // ---------------------------------------------------------------
    // Decrease path: effectiveMax unchanged when already at floor
    // ---------------------------------------------------------------

    describe('decrease when already at floor', () => {
        // Covers line 382: effectiveMax !== prev check during decrease
        test('decrease does not update counters when effectiveMax already at floor', () => {
            createController({ minWindow: 5, minHoldMs: 0, decreaseFactor: 0.5 });
            const w = seedModel(controller, 'model-a', 10);
            w.effectiveMax = 5; // Already at floor

            controller.recordCongestion('model-a', { retryAfterMs: 2000 });
            controller._tick();

            // floor(5 * 0.5) = 2, clamped to floor 5, no change
            expect(w.effectiveMax).toBe(5);
            expect(w.totalAdjustmentsDown).toBe(0);
        });
    });

    // ---------------------------------------------------------------
    // Module exports coverage
    // ---------------------------------------------------------------

    describe('module exports', () => {
        // Covers exported ModelWindow class
        test('ModelWindow class is exported and instantiable', () => {
            const w = new ModelWindow('model-x', 10, 1);

            expect(w.model).toBe('model-x');
            expect(w.staticMax).toBe(10);
            expect(w.effectiveMax).toBe(10);
            expect(w.floor).toBe(1);
            expect(w.congestionCount).toBe(0);
            expect(w.successCount).toBe(0);
            expect(w.quotaHitCount).toBe(0);
            expect(w.unknownHitCount).toBe(0);
            expect(w.consecutiveCleanTicks).toBe(0);
            expect(w.totalAdjustmentsUp).toBe(0);
            expect(w.totalAdjustmentsDown).toBe(0);
            expect(w.lastAdjustReason).toBe('init');
            expect(w.adjustTimestamps).toEqual([]);
            expect(w.history).toEqual([]);
        });

        // Covers exported GlobalAccountWindow class
        test('GlobalAccountWindow class is exported and instantiable', () => {
            const gw = new GlobalAccountWindow(100);

            expect(gw.effectiveMax).toBe(100);
            expect(gw.congestionCount).toBe(0);
            expect(gw.successCount).toBe(0);
        });

        // Covers exported DEFAULT_CONFIG
        test('DEFAULT_CONFIG is exported with expected values', () => {
            expect(DEFAULT_CONFIG).toBeDefined();
            expect(DEFAULT_CONFIG.enabled).toBe(true);
            expect(DEFAULT_CONFIG.mode).toBe('observe_only');
            expect(DEFAULT_CONFIG.tickIntervalMs).toBe(2000);
            expect(DEFAULT_CONFIG.decreaseFactor).toBe(0.5);
            expect(DEFAULT_CONFIG.recoveryDelayMs).toBe(5000);
            expect(DEFAULT_CONFIG.minWindow).toBe(1);
            expect(DEFAULT_CONFIG.growthCleanTicks).toBe(2);
            expect(DEFAULT_CONFIG.growthMode).toBe('fixed_ticks');
            expect(DEFAULT_CONFIG.minHoldMs).toBe(4000);
            expect(DEFAULT_CONFIG.idleTimeoutMs).toBe(300000);
            expect(DEFAULT_CONFIG.idleDecayStep).toBe(1);
            expect(DEFAULT_CONFIG.quotaRetryAfterMs).toBe(60000);
            expect(DEFAULT_CONFIG.treatUnknownAsCongestion).toBe(true);
            expect(DEFAULT_CONFIG.globalMaxConcurrency).toBe(0);
        });

        // Covers exported AdaptiveConcurrencyController class
        test('AdaptiveConcurrencyController class is exported', () => {
            expect(AdaptiveConcurrencyController).toBeDefined();
            expect(typeof AdaptiveConcurrencyController).toBe('function');
        });
    });

    // ---------------------------------------------------------------
    // Destructuring defaults - calling without opts object
    // ---------------------------------------------------------------

    describe('destructuring defaults', () => {
        // Covers line 111: recordCongestion without details object (undefined)
        test('recordCongestion handles undefined details object', () => {
            createController();
            const w = seedModel(controller, 'model-a', 10);

            // Call with undefined details (or no second arg)
            controller.recordCongestion('model-a', undefined);

            expect(w.congestionCount).toBe(1);
        });

        // Covers line 111: recordCongestion with empty details object
        test('recordCongestion handles empty details object', () => {
            createController();
            const w = seedModel(controller, 'model-a', 10);

            controller.recordCongestion('model-a', {});

            expect(w.congestionCount).toBe(1);
        });

        // Covers line 83: constructor without deps object
        test('constructor handles missing deps object', () => {
            // No second argument at all
            const ctrl = new AdaptiveConcurrencyController({ mode: 'enforce' });

            expect(ctrl._keyManager).toBeUndefined();
            expect(ctrl._logger).toBeDefined();
            expect(ctrl._statsAggregator).toBeNull();
        });

        // Covers line 83: constructor with empty deps object
        test('constructor handles empty deps object', () => {
            const ctrl = new AdaptiveConcurrencyController({ mode: 'enforce' }, {});

            expect(ctrl._keyManager).toBeUndefined();
            expect(ctrl._logger).toBeDefined();
            expect(ctrl._statsAggregator).toBeNull();
        });
    });

    // ---------------------------------------------------------------
    // Line 285: updateStaticBaseline in observe_only mode
    // ---------------------------------------------------------------

    describe('updateStaticBaseline — observe_only mode', () => {
        // Covers line 285: does NOT write to keyManager in observe_only mode
        test('updateStaticBaseline does not write to keyManager in observe_only mode', () => {
            createController({ mode: 'observe_only' });
            seedModel(controller, 'model-a', 10);

            controller.updateStaticBaseline('model-a', 15);

            expect(mockKeyManager.setEffectiveModelLimit).not.toHaveBeenCalled();
        });
    });

    // ---------------------------------------------------------------
    // Line 575-579: global enforcement in observe_only mode
    // ---------------------------------------------------------------

    describe('global enforcement — observe_only mode', () => {
        // Covers lines 575-579: does NOT write to keyManager in observe_only mode
        test('_enforceGlobalWindow does not write to keyManager in observe_only mode', () => {
            createController({ globalMaxConcurrency: 15, mode: 'observe_only' });
            const wA = seedModel(controller, 'model-a', 10);
            const wB = seedModel(controller, 'model-b', 10);

            controller._tick();

            // Limits should be reduced
            expect(wA.effectiveMax).toBe(7);
            expect(wB.effectiveMax).toBe(7);
            // But no calls to keyManager
            expect(mockKeyManager.setEffectiveModelLimit).not.toHaveBeenCalled();
        });
    });

    // ---------------------------------------------------------------
    // Lines 433, 444: growth mode when NOT proportional
    // ---------------------------------------------------------------

    describe('growth mode branches', () => {
        // Covers line 431-432: fixed_ticks mode (NOT proportional)
        test('fixed_ticks mode requires consecutive clean ticks', () => {
            createController({
                growthMode: 'fixed_ticks',
                growthCleanTicks: 3,
                minHoldMs: 0,
                recoveryDelayMs: 0
            });
            const w = seedModel(controller, 'model-a', 10);
            w.effectiveMax = 5;
            w.lastCongestionAt = 0;

            // Only 2 clean ticks, not enough for growthCleanTicks=3
            controller.recordSuccess('model-a');
            controller._tick();
            controller.recordSuccess('model-a');
            controller._tick();

            expect(w.effectiveMax).toBe(5); // No growth yet
            expect(w.consecutiveCleanTicks).toBe(2);
        });
    });

    // ---------------------------------------------------------------
    // Line 444: growth when effectiveMax === prev (at staticMax)
    // ---------------------------------------------------------------

    describe('growth when at staticMax', () => {
        // Covers line 444: effectiveMax !== prev is false (no change)
        test('growth does nothing when effectiveMax already at staticMax', () => {
            createController({
                growthMode: 'proportional',
                minHoldMs: 0,
                recoveryDelayMs: 0
            });
            const w = seedModel(controller, 'model-a', 10);
            w.effectiveMax = 10; // Already at staticMax
            w.lastCongestionAt = 0;

            controller.recordSuccess('model-a');
            controller._tick();

            // No change, counters not updated
            expect(w.effectiveMax).toBe(10);
            expect(w.totalAdjustmentsUp).toBe(0);
            expect(w.lastIncreaseAt).toBe(0);
        });
    });

    // ---------------------------------------------------------------
    // Line 479: idle decay when effectiveMax === prev (no change)
    // ---------------------------------------------------------------

    describe('idle decay edge cases', () => {
        // Covers line 479: effectiveMax !== prev is false
        test('idle decay when effectiveMax already at staticMax does not update', () => {
            createController({ idleTimeoutMs: 1000, minHoldMs: 0 });
            const w = seedModel(controller, 'model-a', 10);
            w.effectiveMax = 10; // Already at staticMax
            w.lastTrafficAt = Date.now() - 2000;

            controller._tick();

            expect(w.effectiveMax).toBe(10);
            // lastAdjustReason should not change from initial value
        });
    });

    // ---------------------------------------------------------------
    // Growth mode not matching fixed_ticks or proportional
    // ---------------------------------------------------------------

    describe('growth mode — neither fixed_ticks nor proportional', () => {
        // When growthMode is neither fixed_ticks nor proportional,
        // growthAllowed stays false
        test('unknown growth mode does not allow growth', () => {
            createController({
                growthMode: 'unknown_mode',
                minHoldMs: 0,
                recoveryDelayMs: 0
            });
            const w = seedModel(controller, 'model-a', 10);
            w.effectiveMax = 5;
            w.lastCongestionAt = 0;

            controller.recordSuccess('model-a');
            controller._tick();

            // No growth allowed
            expect(w.effectiveMax).toBe(5);
        });
    });

    // ---------------------------------------------------------------
    // Line 444: growth effectiveMax change true branch
    // ---------------------------------------------------------------

    describe('growth effectiveMax change true branch', () => {
        // Covers line 444: effectiveMax !== prev TRUE branch in growth
        test('growth updates counters and writes to keyManager when effectiveMax changes', () => {
            createController({
                mode: 'enforce',
                growthMode: 'proportional',
                minHoldMs: 0,
                recoveryDelayMs: 0
            });
            const w = seedModel(controller, 'model-a', 50);
            w.effectiveMax = 10;
            w.lastCongestionAt = 0;

            controller.recordSuccess('model-a');
            controller._tick();

            // Growth happened, effectiveMax changed
            expect(w.effectiveMax).toBe(15);
            expect(w.totalAdjustmentsUp).toBe(1);
            expect(w.lastIncreaseAt).toBeGreaterThan(0);
            // KeyManager was called because mode is enforce
            expect(mockKeyManager.setEffectiveModelLimit).toHaveBeenCalledWith('model-a', 15);
        });
    });

    // ---------------------------------------------------------------
    // Line 479: idle decay effectiveMax change true branch
    // ---------------------------------------------------------------

    describe('idle decay effectiveMax change true branch', () => {
        // Covers line 479: effectiveMax !== prev TRUE branch in idle decay
        test('idle decay updates counters and writes to keyManager when effectiveMax changes', () => {
            createController({
                mode: 'enforce',
                idleTimeoutMs: 1000,
                minHoldMs: 0,
                idleDecayStep: 3
            });
            const w = seedModel(controller, 'model-a', 10);
            w.effectiveMax = 5;
            w.lastTrafficAt = Date.now() - 2000;

            controller._tick();

            // Idle decay happened, effectiveMax changed
            expect(w.effectiveMax).toBe(8);
            expect(w.lastAdjustAt).toBeGreaterThan(0);
            expect(w.lastAdjustReason).toBe('idle_decay');
            // KeyManager was called because mode is enforce
            expect(mockKeyManager.setEffectiveModelLimit).toHaveBeenCalledWith('model-a', 8);
        });
    });

    // ---------------------------------------------------------------
    // Line 575: global enforcement effectiveMax change true branch
    // ---------------------------------------------------------------

    describe('global enforcement effectiveMax change true branch', () => {
        // Covers line 575: effectiveMax !== prev TRUE branch in global enforcement
        // Also covers line 579: mode === enforce TRUE branch
        test('global enforcement updates counters and writes to keyManager when effectiveMax changes', () => {
            createController({
                mode: 'enforce',
                globalMaxConcurrency: 15
            });
            const wA = seedModel(controller, 'model-a', 10);
            const wB = seedModel(controller, 'model-b', 10);

            controller._tick();

            // Both reduced
            expect(wA.effectiveMax).toBe(7);
            expect(wB.effectiveMax).toBe(7);
            expect(wA.lastAdjustReason).toBe('global_cap');
            expect(wB.lastAdjustReason).toBe('global_cap');
            // KeyManager was called because mode is enforce
            expect(mockKeyManager.setEffectiveModelLimit).toHaveBeenCalledWith('model-a', 7);
            expect(mockKeyManager.setEffectiveModelLimit).toHaveBeenCalledWith('model-b', 7);
        });

        // Covers line 575: effectiveMax !== prev FALSE branch (no change)
        test('global enforcement does not update when effectiveMax unchanged', () => {
            createController({
                mode: 'enforce',
                globalMaxConcurrency: 100 // Sum=20, limit=100, no reduction needed
            });
            const w = seedModel(controller, 'model-a', 10);

            const initialReason = w.lastAdjustReason;
            controller._tick();

            // No change
            expect(w.effectiveMax).toBe(10);
            expect(w.lastAdjustReason).toBe(initialReason);
        });

        // Covers line 575: effectiveMax !== prev FALSE when model is at floor
        test('global enforcement does not update when effectiveMax already at floor', () => {
            createController({
                mode: 'enforce',
                globalMaxConcurrency: 3, // Very low global max
                minWindow: 1
            });
            const wA = seedModel(controller, 'model-a', 10);
            const wB = seedModel(controller, 'model-b', 10);
            // Set model-a to floor so global enforcement can't reduce further
            wA.effectiveMax = 1;

            controller._tick();

            // model-a stays at floor
            expect(wA.effectiveMax).toBe(1);
            expect(wA.lastAdjustReason).toBe('init'); // Not updated because no change
        });
    });
});
