'use strict';

const { AdaptiveConcurrencyController, ModelWindow, DEFAULT_CONFIG } = require('../lib/adaptive-concurrency');

describe('AdaptiveConcurrencyController', () => {
    let controller;
    let mockKeyManager;
    let mockLogger;
    let mockStatsAggregator;

    beforeEach(() => {
        jest.useFakeTimers();
        mockKeyManager = {
            _limits: new Map(),        // effective limits
            _staticLimits: new Map(),  // static baselines
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
        // Set both static and effective limits in mock KeyManager
        mockKeyManager._staticLimits.set(model, staticMax);
        mockKeyManager._limits.set(model, staticMax);
        // Force window creation via _getOrCreate (reads from getStaticModelLimit)
        ctrl._getOrCreate(model);
        const w = ctrl._windows.get(model);
        w.staticMax = staticMax;
        w.effectiveMax = staticMax;
        // Set lastAdjustAt far enough in the past so the first tick isn't blocked
        // by anti-flap hysteresis (minHoldMs check)
        w.lastAdjustAt = Date.now() - 10000;
        return w;
    }

    // ---------------------------------------------------------------
    // AIMD Core
    // ---------------------------------------------------------------

    describe('AIMD core', () => {
        test('clean tick with successes grows window by 1 (fixed_ticks mode)', () => {
            createController({ growthCleanTicks: 2 });
            const w = seedModel(controller, 'glm-4.5', 10);
            w.effectiveMax = 5;  // Start below static max
            w.lastCongestionAt = 0;  // No recent congestion

            // Record successes
            controller.recordSuccess('glm-4.5');
            controller.recordSuccess('glm-4.5');

            // First tick — clean but needs 2 consecutive clean ticks
            controller._tick();
            expect(w.effectiveMax).toBe(5);  // No growth yet
            expect(w.consecutiveCleanTicks).toBe(1);

            // Record more successes for next tick
            controller.recordSuccess('glm-4.5');

            // Advance past minHoldMs
            jest.advanceTimersByTime(4001);

            // Second clean tick
            controller._tick();
            expect(w.effectiveMax).toBe(6);  // +1 growth
            expect(w.totalAdjustmentsUp).toBe(1);
        });

        test('congestion tick shrinks window by decreaseFactor', () => {
            createController();
            const w = seedModel(controller, 'glm-4.5', 10);

            controller.recordCongestion('glm-4.5', { retryAfterMs: 2000 });

            controller._tick();

            expect(w.effectiveMax).toBe(5);  // 10 * 0.5 = 5
            expect(w.totalAdjustmentsDown).toBe(1);
            expect(mockKeyManager.setEffectiveModelLimit).toHaveBeenCalledWith('glm-4.5', 5);
        });

        test('window never drops below minWindow', () => {
            createController({ minWindow: 1 });
            const w = seedModel(controller, 'glm-4.5', 10);
            w.effectiveMax = 1;

            controller.recordCongestion('glm-4.5', { retryAfterMs: 2000 });

            controller._tick();

            expect(w.effectiveMax).toBe(1);  // Floor
        });

        test('window never exceeds staticMax', () => {
            createController({ growthCleanTicks: 1 });
            const w = seedModel(controller, 'glm-4.5', 10);
            w.effectiveMax = 10;
            w.lastCongestionAt = 0;

            controller.recordSuccess('glm-4.5');

            controller._tick();

            expect(w.effectiveMax).toBe(10);  // Already at max
        });

        test('recovery delay: no growth until recoveryDelayMs after last congestion', () => {
            createController({ recoveryDelayMs: 5000, growthCleanTicks: 1 });
            const w = seedModel(controller, 'glm-4.5', 10);
            w.effectiveMax = 5;

            // Record congestion
            controller.recordCongestion('glm-4.5', { retryAfterMs: 2000 });
            controller._tick();
            expect(w.effectiveMax).toBe(2);  // Decreased: floor(5 * 0.5) = 2

            // Advance past minHoldMs but not recoveryDelayMs
            jest.advanceTimersByTime(4500);

            // Record success, try to grow
            controller.recordSuccess('glm-4.5');
            controller._tick();
            expect(w.effectiveMax).toBe(2);  // Still within recovery delay — no growth

            // Advance past recoveryDelayMs total from congestion
            jest.advanceTimersByTime(1000);

            controller.recordSuccess('glm-4.5');
            controller._tick();
            expect(w.effectiveMax).toBe(3);  // Now growth allowed: 2 + 1 = 3
        });
    });

    // ---------------------------------------------------------------
    // Conservative Growth
    // ---------------------------------------------------------------

    describe('conservative growth', () => {
        test('growthCleanTicks: 2 — first clean tick no growth, second +1', () => {
            createController({ growthCleanTicks: 2 });
            const w = seedModel(controller, 'glm-4.5', 10);
            w.effectiveMax = 5;
            w.lastCongestionAt = 0;

            // First clean tick
            controller.recordSuccess('glm-4.5');
            controller._tick();
            expect(w.effectiveMax).toBe(5);

            // Second clean tick (advance past minHoldMs)
            jest.advanceTimersByTime(4001);
            controller.recordSuccess('glm-4.5');
            controller._tick();
            expect(w.effectiveMax).toBe(6);
        });

        test('growthMode proportional: step = max(1, floor(1/effectiveMax))', () => {
            createController({ growthMode: 'proportional', growthCleanTicks: 1 });
            const w = seedModel(controller, 'glm-4.5', 10);
            w.effectiveMax = 5;
            w.lastCongestionAt = 0;

            controller.recordSuccess('glm-4.5');
            controller._tick();

            // floor(1/5) = 0, max(1, 0) = 1
            expect(w.effectiveMax).toBe(6);
        });

        test('congestion resets consecutive clean tick counter', () => {
            createController({ growthCleanTicks: 2 });
            const w = seedModel(controller, 'glm-4.5', 10);
            w.effectiveMax = 5;
            w.lastCongestionAt = 0;

            // First clean tick
            controller.recordSuccess('glm-4.5');
            controller._tick();
            expect(w.consecutiveCleanTicks).toBe(1);

            // Congestion tick
            jest.advanceTimersByTime(4001);
            controller.recordCongestion('glm-4.5', { retryAfterMs: 2000 });
            controller._tick();
            expect(w.consecutiveCleanTicks).toBe(0);
        });
    });

    // ---------------------------------------------------------------
    // Anti-flap Hysteresis
    // ---------------------------------------------------------------

    describe('anti-flap hysteresis', () => {
        test('two adjustments within minHoldMs — second is skipped', () => {
            createController({ minHoldMs: 4000 });
            const w = seedModel(controller, 'glm-4.5', 10);

            // First congestion — adjusts
            controller.recordCongestion('glm-4.5', { retryAfterMs: 2000 });
            controller._tick();
            expect(w.effectiveMax).toBe(5);

            // Immediately another congestion — should skip due to hysteresis
            controller.recordCongestion('glm-4.5', { retryAfterMs: 2000 });
            controller._tick();
            expect(w.effectiveMax).toBe(5);  // Not 2 (skipped)
        });

        test('after minHoldMs passes, adjustment proceeds', () => {
            createController({ minHoldMs: 4000 });
            const w = seedModel(controller, 'glm-4.5', 10);

            controller.recordCongestion('glm-4.5', { retryAfterMs: 2000 });
            controller._tick();
            expect(w.effectiveMax).toBe(5);

            jest.advanceTimersByTime(4001);

            controller.recordCongestion('glm-4.5', { retryAfterMs: 2000 });
            controller._tick();
            expect(w.effectiveMax).toBe(2);  // floor(5 * 0.5) = 2
        });
    });

    // ---------------------------------------------------------------
    // 429 Classification
    // ---------------------------------------------------------------

    describe('429 classification', () => {
        test('retryAfterMs=2000 → congestion → shrink', () => {
            createController();
            const w = seedModel(controller, 'glm-4.5', 10);

            controller.recordCongestion('glm-4.5', { retryAfterMs: 2000 });
            controller._tick();

            expect(w.effectiveMax).toBe(5);
            expect(w.lastAdjustReason).toBe('decrease_congestion');
        });

        test('retryAfterMs=120000 → quota → do not shrink', () => {
            createController();
            const w = seedModel(controller, 'glm-4.5', 10);

            controller.recordCongestion('glm-4.5', { retryAfterMs: 120000 });
            controller._tick();

            expect(w.effectiveMax).toBe(10);  // Not shrunk
            expect(w.lastAdjustReason).toBe('quota_skip');
        });

        test('missing retry-after with treatUnknownAsCongestion=true → shrink', () => {
            createController({ treatUnknownAsCongestion: true });
            const w = seedModel(controller, 'glm-4.5', 10);

            controller.recordCongestion('glm-4.5', { retryAfterMs: null });
            controller._tick();

            expect(w.effectiveMax).toBe(5);
            expect(w.lastAdjustReason).toBe('decrease_unknown');
        });

        test('missing retry-after with treatUnknownAsCongestion=false → do not shrink', () => {
            createController({ treatUnknownAsCongestion: false });
            const w = seedModel(controller, 'glm-4.5', 10);

            controller.recordCongestion('glm-4.5', { retryAfterMs: null });
            controller._tick();

            expect(w.effectiveMax).toBe(10);
            expect(w.lastAdjustReason).toBe('unknown_skip');
        });

        test('error body containing "quota" → quota classification', () => {
            createController();
            const w = seedModel(controller, 'glm-4.5', 10);

            controller.recordCongestion('glm-4.5', {
                retryAfterMs: 2000,
                errorBody: 'You have exceeded your quota limit'
            });
            controller._tick();

            expect(w.effectiveMax).toBe(10);  // Quota → no shrink
            expect(w.quotaHitCount).toBe(0);  // Quota hit was counted but then reset
        });

        test('error code quota_exceeded → quota classification', () => {
            createController();
            const w = seedModel(controller, 'glm-4.5', 10);

            controller.recordCongestion('glm-4.5', {
                retryAfterMs: 2000,
                errorCode: 'quota_exceeded'
            });
            controller._tick();

            expect(w.effectiveMax).toBe(10);  // Quota → no shrink
        });

        test('errorCode=timeout → congestion classification → shrink', () => {
            createController();
            const w = seedModel(controller, 'glm-4.5', 10);

            // Timeout signals have retryAfterMs=null but errorCode='timeout'
            // This avoids the "unknown" bucket (which requires !errorCode)
            controller.recordCongestion('glm-4.5', {
                retryAfterMs: null,
                errorCode: 'timeout',
                errorBody: null
            });
            controller._tick();

            expect(w.effectiveMax).toBe(5);  // Congestion → shrink
            expect(w.lastAdjustReason).toBe('decrease_congestion');
            expect(w.totalAdjustmentsDown).toBe(1);
        });

        test('multiple timeouts in one tick → single decrease', () => {
            createController();
            const w = seedModel(controller, 'glm-4.5', 10);

            // 3 timeouts in the same tick
            for (let i = 0; i < 3; i++) {
                controller.recordCongestion('glm-4.5', {
                    retryAfterMs: null,
                    errorCode: 'timeout'
                });
            }
            controller._tick();

            // Single multiplicative decrease per tick, not per event
            expect(w.effectiveMax).toBe(5);
            expect(w.totalAdjustmentsDown).toBe(1);
        });

        test('mixed 429 and timeout signals → congestion classification', () => {
            createController();
            const w = seedModel(controller, 'glm-4.5', 10);

            // One 429 congestion + two timeouts in same tick
            controller.recordCongestion('glm-4.5', { retryAfterMs: 2000 });
            controller.recordCongestion('glm-4.5', {
                retryAfterMs: null,
                errorCode: 'timeout'
            });
            controller.recordCongestion('glm-4.5', {
                retryAfterMs: null,
                errorCode: 'timeout'
            });
            controller._tick();

            expect(w.effectiveMax).toBe(5);
            expect(w.lastAdjustReason).toBe('decrease_congestion');
        });
    });

    // ---------------------------------------------------------------
    // Idle Decay
    // ---------------------------------------------------------------

    describe('idle decay', () => {
        test('no traffic for idleTimeoutMs → drift back toward staticMax', () => {
            createController({ idleTimeoutMs: 300000, minHoldMs: 0 });
            const w = seedModel(controller, 'glm-4.5', 10);
            w.effectiveMax = 5;
            w.lastTrafficAt = Date.now() - 400000;  // Well past idle timeout

            controller._tick();

            expect(w.effectiveMax).toBe(6);  // +1 idle decay step
            expect(w.lastAdjustReason).toBe('idle_decay');
        });

        test('traffic resumes → idle decay stops', () => {
            createController({ idleTimeoutMs: 300000, minHoldMs: 0 });
            const w = seedModel(controller, 'glm-4.5', 10);
            w.effectiveMax = 5;
            w.lastTrafficAt = Date.now() - 400000;

            // Idle decay should trigger
            controller._tick();
            expect(w.effectiveMax).toBe(6);

            // Now record traffic (success updates lastTrafficAt)
            controller.recordSuccess('glm-4.5');  // This updates lastTrafficAt

            controller._tick();
            // Should not idle-decay since we have success traffic now
            // consecutiveCleanTicks is 1 (need 2 for growth), so stays at 6
            expect(w.effectiveMax).toBe(6);
        });

        test('idle decay stops at staticMax', () => {
            createController({ idleTimeoutMs: 300000 });
            const w = seedModel(controller, 'glm-4.5', 10);
            w.effectiveMax = 10;
            w.lastTrafficAt = Date.now() - 400000;

            controller._tick();

            expect(w.effectiveMax).toBe(10);  // Already at max, no change
        });
    });

    // ---------------------------------------------------------------
    // Shadow / observe_only mode
    // ---------------------------------------------------------------

    describe('shadow/observe_only mode', () => {
        test('getEffectiveConcurrency returns null in observe_only', () => {
            createController({ mode: 'observe_only' });
            seedModel(controller, 'glm-4.5', 10);

            expect(controller.getEffectiveConcurrency('glm-4.5')).toBeNull();
        });

        test('getObservedConcurrency returns computed value in observe_only', () => {
            createController({ mode: 'observe_only' });
            const w = seedModel(controller, 'glm-4.5', 10);
            w.effectiveMax = 5;

            expect(controller.getObservedConcurrency('glm-4.5')).toBe(5);
        });

        test('setEffectiveModelLimit is NOT called in observe_only', () => {
            createController({ mode: 'observe_only' });
            seedModel(controller, 'glm-4.5', 10);

            controller.recordCongestion('glm-4.5', { retryAfterMs: 2000 });
            controller._tick();

            expect(mockKeyManager.setEffectiveModelLimit).not.toHaveBeenCalled();
        });

        test('snapshot shows computed effective values in observe_only', () => {
            createController({ mode: 'observe_only' });
            const w = seedModel(controller, 'glm-4.5', 10);

            controller.recordCongestion('glm-4.5', { retryAfterMs: 2000 });
            controller._tick();

            const snapshot = controller.getSnapshot();
            expect(snapshot.mode).toBe('observe_only');
            expect(snapshot.models['glm-4.5'].effectiveMax).toBe(5);  // Computed even in shadow
        });
    });

    // ---------------------------------------------------------------
    // Shrink-while-inflight
    // ---------------------------------------------------------------

    describe('shrink-while-inflight', () => {
        test('shrink below current inFlight blocks new requests but existing continue', () => {
            // Simulate KeyManager with 8 in-flight and separate static/effective limits
            const realKeyManager = {
                _modelStaticLimits: new Map([['glm-4.5', 10]]),
                _modelLimits: new Map([['glm-4.5', 10]]),
                _modelInFlight: new Map([['glm-4.5', 8]]),
                setEffectiveModelLimit(model, limit) {
                    this._modelLimits.set(model, Math.floor(limit));
                },
                getEffectiveModelLimit(model) {
                    return this._modelLimits.get(model);
                },
                getStaticModelLimit(model) {
                    return this._modelStaticLimits.get(model);
                },
                restoreStaticLimits() {
                    for (const [m, s] of this._modelStaticLimits) this._modelLimits.set(m, s);
                },
                acquireModelSlot(model) {
                    const limit = this._modelLimits.get(model);
                    if (limit === undefined) return true;
                    const current = this._modelInFlight.get(model) || 0;
                    if (current >= limit) return false;
                    this._modelInFlight.set(model, current + 1);
                    return true;
                },
                releaseModelSlot(model) {
                    const current = this._modelInFlight.get(model) || 0;
                    if (current > 1) this._modelInFlight.set(model, current - 1);
                    else this._modelInFlight.delete(model);
                }
            };

            // Create controller with the real key manager
            controller = new AdaptiveConcurrencyController(
                { ...DEFAULT_CONFIG, mode: 'enforce' },
                { keyManager: realKeyManager, logger: mockLogger }
            );

            // Seed window manually
            const w = controller._getOrCreate('glm-4.5');
            w.staticMax = 10;
            w.effectiveMax = 10;
            w.lastAdjustAt = Date.now() - 10000;

            // Trigger congestion → shrink to 5
            controller.recordCongestion('glm-4.5', { retryAfterMs: 2000 });
            controller._tick();

            expect(realKeyManager._modelLimits.get('glm-4.5')).toBe(5);

            // New slot acquisition should fail (8 >= 5)
            expect(realKeyManager.acquireModelSlot('glm-4.5')).toBe(false);

            // Release 4 slots: 8 → 4
            for (let i = 0; i < 4; i++) {
                realKeyManager.releaseModelSlot('glm-4.5');
            }

            // Now 4 < 5, should allow new request
            expect(realKeyManager.acquireModelSlot('glm-4.5')).toBe(true);
        });
    });

    // ---------------------------------------------------------------
    // Global Account Window
    // ---------------------------------------------------------------

    describe('global account window', () => {
        test('proportional reduction when sum exceeds globalMaxConcurrency', () => {
            createController({ globalMaxConcurrency: 15 });

            seedModel(controller, 'model-a', 8);
            seedModel(controller, 'model-b', 8);
            seedModel(controller, 'model-c', 8);

            // Sum = 24 > 15 → proportional reduction
            controller._tick();

            const a = controller._windows.get('model-a');
            const b = controller._windows.get('model-b');
            const c = controller._windows.get('model-c');

            // Each: floor(8 * 15/24) = floor(5.0) = 5
            expect(a.effectiveMax).toBe(5);
            expect(b.effectiveMax).toBe(5);
            expect(c.effectiveMax).toBe(5);

            // Verify total <= globalMax
            expect(a.effectiveMax + b.effectiveMax + c.effectiveMax).toBeLessThanOrEqual(15);
        });

        test('no reduction when sum <= globalMaxConcurrency', () => {
            createController({ globalMaxConcurrency: 30 });

            seedModel(controller, 'model-a', 8);
            seedModel(controller, 'model-b', 8);

            controller._tick();

            expect(controller._windows.get('model-a').effectiveMax).toBe(8);
            expect(controller._windows.get('model-b').effectiveMax).toBe(8);
        });
    });

    // ---------------------------------------------------------------
    // Convergence
    // ---------------------------------------------------------------

    describe('convergence', () => {
        test('repeated congestion converges to floor', () => {
            createController({ minHoldMs: 0 });  // Disable hysteresis for fast convergence
            const w = seedModel(controller, 'glm-4.5', 10);

            // Simulate 5 congestion ticks
            for (let i = 0; i < 5; i++) {
                controller.recordCongestion('glm-4.5', { retryAfterMs: 2000 });
                controller._tick();
            }

            // 10 → 5 → 2 → 1 → 1 → 1
            expect(w.effectiveMax).toBe(1);
        });

        test('recovery from floor to staticMax', () => {
            createController({
                minHoldMs: 0,
                growthCleanTicks: 1,
                recoveryDelayMs: 0
            });
            const w = seedModel(controller, 'glm-4.5', 10);
            w.effectiveMax = 1;
            w.lastCongestionAt = 0;

            // Simulate 9 clean growth ticks
            for (let i = 0; i < 9; i++) {
                controller.recordSuccess('glm-4.5');
                controller._tick();
            }

            // 1 → 2 → 3 → ... → 10
            expect(w.effectiveMax).toBe(10);
        });
    });

    // ---------------------------------------------------------------
    // Interval Lifecycle
    // ---------------------------------------------------------------

    describe('interval lifecycle', () => {
        test('start creates interval', () => {
            createController();
            expect(controller._tickInterval).toBeNull();

            controller.start();
            expect(controller._tickInterval).not.toBeNull();
        });

        test('stop clears interval', () => {
            createController();
            controller.start();
            expect(controller._tickInterval).not.toBeNull();

            controller.stop();
            expect(controller._tickInterval).toBeNull();
        });

        test('double stop does not error', () => {
            createController();
            controller.start();
            controller.stop();
            expect(() => controller.stop()).not.toThrow();
        });

        test('double start is idempotent', () => {
            createController();
            controller.start();
            const first = controller._tickInterval;
            controller.start();
            expect(controller._tickInterval).toBe(first);  // Same interval
        });

        test('tick runs at configured interval', () => {
            createController({ tickIntervalMs: 2000 });
            seedModel(controller, 'glm-4.5', 10);

            controller.start();
            controller.recordCongestion('glm-4.5', { retryAfterMs: 2000 });

            jest.advanceTimersByTime(1999);
            expect(controller._windows.get('glm-4.5').effectiveMax).toBe(10);  // Not ticked yet

            jest.advanceTimersByTime(1);
            expect(controller._windows.get('glm-4.5').effectiveMax).toBe(5);  // Ticked
        });
    });

    // ---------------------------------------------------------------
    // Snapshot / Observability
    // ---------------------------------------------------------------

    describe('snapshot', () => {
        test('returns correct structure', () => {
            createController({ mode: 'enforce', globalMaxConcurrency: 0 });
            seedModel(controller, 'glm-4.5', 10);

            const snapshot = controller.getSnapshot();

            expect(snapshot.mode).toBe('enforce');
            expect(snapshot.globalWindow).toBeNull();
            expect(snapshot.models['glm-4.5']).toBeDefined();
            expect(snapshot.models['glm-4.5']).toEqual(expect.objectContaining({
                staticMax: 10,
                effectiveMax: 10,
                floor: 1,
                adjustmentsUp: 0,
                adjustmentsDown: 0,
                lastAdjustReason: 'init'
            }));
        });

        test('snapshot with global window', () => {
            createController({ globalMaxConcurrency: 20 });
            seedModel(controller, 'glm-4.5', 10);

            const snapshot = controller.getSnapshot();

            expect(snapshot.globalWindow).not.toBeNull();
            expect(snapshot.globalWindow.effectiveMax).toBe(20);
            expect(snapshot.globalWindow.sumModelEffective).toBe(10);
        });

        test('tick pushes snapshot to statsAggregator', () => {
            createController();
            seedModel(controller, 'glm-4.5', 10);

            controller._tick();

            expect(mockStatsAggregator.recordAdaptiveConcurrency).toHaveBeenCalledWith(
                expect.objectContaining({
                    mode: 'enforce',
                    models: expect.objectContaining({
                        'glm-4.5': expect.any(Object)
                    })
                })
            );
        });
    });

    // ---------------------------------------------------------------
    // Query API
    // ---------------------------------------------------------------

    describe('query API', () => {
        test('getEffectiveConcurrency returns value in enforce mode', () => {
            createController({ mode: 'enforce' });
            const w = seedModel(controller, 'glm-4.5', 10);
            w.effectiveMax = 5;

            expect(controller.getEffectiveConcurrency('glm-4.5')).toBe(5);
        });

        test('getEffectiveConcurrency returns null for unknown model', () => {
            createController({ mode: 'enforce' });
            expect(controller.getEffectiveConcurrency('unknown-model')).toBeNull();
        });

        test('getObservedConcurrency returns null for unknown model', () => {
            createController();
            expect(controller.getObservedConcurrency('unknown-model')).toBeNull();
        });
    });

    // ---------------------------------------------------------------
    // Feedback API
    // ---------------------------------------------------------------

    describe('feedback API', () => {
        test('recordCongestion creates window on first call for known model', () => {
            createController();
            mockKeyManager._staticLimits.set('new-model', 8);

            controller.recordCongestion('new-model', { retryAfterMs: 2000 });

            expect(controller._windows.has('new-model')).toBe(true);
            expect(controller._windows.get('new-model').congestionCount).toBe(1);
        });

        test('recordSuccess creates window on first call for known model', () => {
            createController();
            mockKeyManager._staticLimits.set('new-model', 8);

            controller.recordSuccess('new-model');

            expect(controller._windows.has('new-model')).toBe(true);
            expect(controller._windows.get('new-model').successCount).toBe(1);
        });

        test('multiple congestion signals accumulate', () => {
            createController();
            seedModel(controller, 'glm-4.5', 10);

            controller.recordCongestion('glm-4.5', { retryAfterMs: 2000 });
            controller.recordCongestion('glm-4.5', { retryAfterMs: 3000 });
            controller.recordCongestion('glm-4.5', { retryAfterMs: null });

            const w = controller._windows.get('glm-4.5');
            expect(w.congestionCount).toBe(3);
            expect(w.unknownHitCount).toBe(1);
        });
    });

    // ---------------------------------------------------------------
    // Review Findings: Unknown Model Behavior
    // ---------------------------------------------------------------

    describe('unknown model behavior', () => {
        test('recordCongestion for unknown model does not create window', () => {
            createController();
            // No static limit set for 'unknown-model'
            controller.recordCongestion('unknown-model', { retryAfterMs: 2000 });

            expect(controller._windows.has('unknown-model')).toBe(false);
        });

        test('recordSuccess for unknown model does not create window', () => {
            createController();
            controller.recordSuccess('unknown-model');

            expect(controller._windows.has('unknown-model')).toBe(false);
        });

        test('unknown model signals are silently ignored (no throw)', () => {
            createController();
            expect(() => {
                controller.recordCongestion('unknown-model', { retryAfterMs: 2000 });
                controller.recordSuccess('unknown-model');
            }).not.toThrow();
        });
    });

    // ---------------------------------------------------------------
    // Review Findings: Controller Stop Rollback
    // ---------------------------------------------------------------

    describe('controller stop rollback', () => {
        test('stop() restores static limits in enforce mode', () => {
            createController({ mode: 'enforce' });
            seedModel(controller, 'glm-4.5', 10);

            // Shrink the window
            controller.recordCongestion('glm-4.5', { retryAfterMs: 2000 });
            controller._tick();
            expect(mockKeyManager._limits.get('glm-4.5')).toBe(5);

            // Stop → should restore static limits
            controller.stop();
            expect(mockKeyManager.restoreStaticLimits).toHaveBeenCalled();
        });

        test('stop() does not restore static limits in observe_only mode', () => {
            createController({ mode: 'observe_only' });
            seedModel(controller, 'glm-4.5', 10);

            controller.stop();
            expect(mockKeyManager.restoreStaticLimits).not.toHaveBeenCalled();
        });
    });

    // ---------------------------------------------------------------
    // Review Findings: Static vs Effective Limit Separation
    // ---------------------------------------------------------------

    describe('static vs effective limit separation', () => {
        test('_getOrCreate reads from getStaticModelLimit, not getEffectiveModelLimit', () => {
            createController();
            mockKeyManager._staticLimits.set('test-model', 8);
            mockKeyManager._limits.set('test-model', 3);  // Effective is lower

            const w = controller._getOrCreate('test-model');
            expect(w.staticMax).toBe(8);  // Should use static, not effective
        });
    });

    // ---------------------------------------------------------------
    // Review Findings: Proportional Growth Math
    // ---------------------------------------------------------------

    describe('proportional growth math', () => {
        test('proportional step scales with staticMax', () => {
            createController({ growthMode: 'proportional', growthCleanTicks: 1, recoveryDelayMs: 0 });
            const w = seedModel(controller, 'glm-4.5', 20);
            w.effectiveMax = 5;
            w.lastCongestionAt = 0;

            controller.recordSuccess('glm-4.5');
            controller._tick();

            // ceil(20 * 0.1) = 2, so step = 2
            expect(w.effectiveMax).toBe(7);  // 5 + 2
        });

        test('proportional step is at least 1 for small staticMax', () => {
            createController({ growthMode: 'proportional', growthCleanTicks: 1, recoveryDelayMs: 0 });
            const w = seedModel(controller, 'glm-5', 1);
            w.effectiveMax = 1;
            w.lastCongestionAt = 0;

            // staticMax=1, can't grow above 1
            controller.recordSuccess('glm-5');
            controller._tick();
            expect(w.effectiveMax).toBe(1);  // Already at max
        });
    });

    // ---------------------------------------------------------------
    // Review Findings: Anti-flap Signal Retention
    // ---------------------------------------------------------------

    describe('anti-flap signal retention', () => {
        test('signals retained during hold are applied on next eligible tick', () => {
            createController({ minHoldMs: 4000 });
            const w = seedModel(controller, 'glm-4.5', 10);

            // First congestion → adjusts (10 → 5)
            controller.recordCongestion('glm-4.5', { retryAfterMs: 2000 });
            controller._tick();
            expect(w.effectiveMax).toBe(5);

            // Immediately record more congestion — held by hysteresis
            controller.recordCongestion('glm-4.5', { retryAfterMs: 2000 });
            controller._tick();
            expect(w.effectiveMax).toBe(5);  // Held, not applied yet

            // But signals are retained — advance past minHoldMs
            jest.advanceTimersByTime(4001);
            // Don't add more signals — the retained ones should be processed
            controller._tick();
            expect(w.effectiveMax).toBe(2);  // Now applied: floor(5 * 0.5) = 2
        });
    });

    // ---------------------------------------------------------------
    // Review Findings: Stats Reset Correctness
    // ---------------------------------------------------------------

    describe('stats reset correctness', () => {
        test('stats aggregator reset clears adaptive concurrency snapshot', () => {
            const { StatsAggregator } = require('../lib/stats-aggregator');
            const sa = new StatsAggregator();

            sa.recordAdaptiveConcurrency({ mode: 'enforce', models: { 'glm-4.5': {} } });
            expect(sa._adaptiveConcurrencySnapshot).not.toBeNull();

            sa.reset();
            expect(sa._adaptiveConcurrencySnapshot).toBeNull();
        });
    });

    // ---------------------------------------------------------------
    // Review Findings: Enforce Mode Integration
    // ---------------------------------------------------------------

    describe('enforce mode integration', () => {
        test('enforce mode writes effective limits to KeyManager on decrease', () => {
            createController({ mode: 'enforce' });
            seedModel(controller, 'glm-4.5', 10);

            controller.recordCongestion('glm-4.5', { retryAfterMs: 2000 });
            controller._tick();

            expect(mockKeyManager.setEffectiveModelLimit).toHaveBeenCalledWith('glm-4.5', 5);
        });

        test('enforce mode writes effective limits to KeyManager on increase', () => {
            createController({ mode: 'enforce', growthCleanTicks: 1, recoveryDelayMs: 0 });
            const w = seedModel(controller, 'glm-4.5', 10);
            w.effectiveMax = 5;
            w.lastCongestionAt = 0;

            controller.recordSuccess('glm-4.5');
            controller._tick();

            expect(mockKeyManager.setEffectiveModelLimit).toHaveBeenCalledWith('glm-4.5', 6);
        });

        test('observe_only mode never writes to KeyManager', () => {
            createController({ mode: 'observe_only' });
            seedModel(controller, 'glm-4.5', 10);

            controller.recordCongestion('glm-4.5', { retryAfterMs: 2000 });
            controller._tick();

            expect(mockKeyManager.setEffectiveModelLimit).not.toHaveBeenCalled();
        });
    });

    // ---------------------------------------------------------------
    // E2E Canary (documented but skipped)
    // ---------------------------------------------------------------

    describe.skip('E2E canary (manual testing)', () => {
        test('inject synthetic 429s → window decreases → stop → recovery', () => {
            // Spin up proxy with mode: 'enforce'
            // Inject synthetic 429s on specific model
            // Verify window decreases over ticks
            // Stop injecting → verify recovery
            // Compare before/after: success rate, p95 latency, retry count
        });
    });
});
