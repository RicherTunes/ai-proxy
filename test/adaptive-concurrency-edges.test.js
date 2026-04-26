'use strict';

const { AdaptiveConcurrencyController, ModelWindow, DEFAULT_CONFIG } = require('../lib/adaptive-concurrency');

describe('AdaptiveConcurrencyController — edge cases', () => {
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
    // 1. Observe-only mode: limits tracked but not enforced
    // ---------------------------------------------------------------

    describe('observe_only mode — limits tracked but not enforced', () => {
        test('AIMD adjustments are computed internally but getEffectiveConcurrency returns null', () => {
            createController({ mode: 'observe_only' });
            const w = seedModel(controller, 'model-a', 10);

            controller.recordCongestion('model-a', { retryAfterMs: 2000 });
            controller._tick();

            // Internal window adjusted
            expect(w.effectiveMax).toBe(5);
            // But query API returns null — not enforced
            expect(controller.getEffectiveConcurrency('model-a')).toBeNull();
        });

        test('getObservedConcurrency reflects computed limit in observe_only', () => {
            createController({ mode: 'observe_only' });
            const w = seedModel(controller, 'model-a', 10);

            controller.recordCongestion('model-a', { retryAfterMs: 2000 });
            controller._tick();

            expect(controller.getObservedConcurrency('model-a')).toBe(5);
        });

        test('setEffectiveModelLimit is never called while in observe_only', () => {
            createController({ mode: 'observe_only', minHoldMs: 0, growthCleanTicks: 1, recoveryDelayMs: 0 });
            const w = seedModel(controller, 'model-a', 10);

            // Congestion
            controller.recordCongestion('model-a', { retryAfterMs: 2000 });
            controller._tick();
            expect(w.effectiveMax).toBe(5);

            // Growth
            w.lastCongestionAt = 0;
            controller.recordSuccess('model-a');
            controller._tick();
            expect(w.effectiveMax).toBe(6);

            // Idle decay
            w.lastTrafficAt = Date.now() - 400000;
            w.effectiveMax = 7;
            controller._tick();

            // None of these should have written to KeyManager
            expect(mockKeyManager.setEffectiveModelLimit).not.toHaveBeenCalled();
        });

        test('adjustment history is still recorded in observe_only', () => {
            createController({ mode: 'observe_only' });
            const w = seedModel(controller, 'model-a', 10);

            controller.recordCongestion('model-a', { retryAfterMs: 2000 });
            controller._tick();

            expect(w.history).toHaveLength(1);
            expect(w.history[0].reason).toBe('decrease_congestion');
        });

        test('totalAdjustmentsDown increments in observe_only', () => {
            createController({ mode: 'observe_only' });
            const w = seedModel(controller, 'model-a', 10);

            controller.recordCongestion('model-a', { retryAfterMs: 2000 });
            controller._tick();

            expect(w.totalAdjustmentsDown).toBe(1);
        });
    });

    // ---------------------------------------------------------------
    // 2. Enforce mode: requests actually rejected when over limit
    // ---------------------------------------------------------------

    describe('enforce mode — limits pushed to KeyManager', () => {
        test('decrease writes reduced limit to KeyManager immediately', () => {
            createController({ mode: 'enforce' });
            seedModel(controller, 'model-a', 10);

            controller.recordCongestion('model-a', { retryAfterMs: 2000 });
            controller._tick();

            expect(mockKeyManager.setEffectiveModelLimit).toHaveBeenCalledWith('model-a', 5);
        });

        test('increase writes raised limit to KeyManager', () => {
            createController({ mode: 'enforce', growthCleanTicks: 1, recoveryDelayMs: 0, minHoldMs: 0 });
            const w = seedModel(controller, 'model-a', 10);
            w.effectiveMax = 5;
            w.lastCongestionAt = 0;

            controller.recordSuccess('model-a');
            controller._tick();

            expect(mockKeyManager.setEffectiveModelLimit).toHaveBeenCalledWith('model-a', 6);
        });

        test('getEffectiveConcurrency returns the computed limit in enforce mode', () => {
            createController({ mode: 'enforce' });
            const w = seedModel(controller, 'model-a', 10);

            controller.recordCongestion('model-a', { retryAfterMs: 2000 });
            controller._tick();

            expect(controller.getEffectiveConcurrency('model-a')).toBe(5);
        });

        test('slot acquisition fails when in-flight >= effective limit', () => {
            // Use a realistic key manager that tracks in-flight
            const km = {
                _staticLimits: new Map([['model-a', 10]]),
                _limits: new Map([['model-a', 10]]),
                _inFlight: new Map([['model-a', 0]]),
                setEffectiveModelLimit(model, limit) {
                    this._limits.set(model, limit);
                },
                getStaticModelLimit(model) {
                    return this._staticLimits.get(model);
                },
                restoreStaticLimits() {
                    for (const [m, s] of this._staticLimits) this._limits.set(m, s);
                },
                acquireSlot(model) {
                    const limit = this._limits.get(model) || Infinity;
                    const current = this._inFlight.get(model) || 0;
                    if (current >= limit) return false;
                    this._inFlight.set(model, current + 1);
                    return true;
                },
                releaseSlot(model) {
                    const cur = this._inFlight.get(model) || 0;
                    this._inFlight.set(model, Math.max(0, cur - 1));
                }
            };

            controller = new AdaptiveConcurrencyController(
                { ...DEFAULT_CONFIG, mode: 'enforce', minHoldMs: 0 },
                { keyManager: km, logger: mockLogger }
            );
            const w = controller._getOrCreate('model-a');
            w.lastAdjustAt = Date.now() - 10000;

            // Shrink to 5
            controller.recordCongestion('model-a', { retryAfterMs: 2000 });
            controller._tick();
            expect(km._limits.get('model-a')).toBe(5);

            // Fill 5 slots
            for (let i = 0; i < 5; i++) {
                expect(km.acquireSlot('model-a')).toBe(true);
            }
            // 6th should be rejected
            expect(km.acquireSlot('model-a')).toBe(false);

            // Release one, now one more can enter
            km.releaseSlot('model-a');
            expect(km.acquireSlot('model-a')).toBe(true);
        });
    });

    // ---------------------------------------------------------------
    // 3. Ramp up: sustained load increases concurrency gradually
    // ---------------------------------------------------------------

    describe('ramp up — sustained clean load increases limit', () => {
        test('fixed_ticks: limit ramps from floor to staticMax one step at a time', () => {
            createController({
                minHoldMs: 0,
                growthCleanTicks: 1,
                recoveryDelayMs: 0,
                growthMode: 'fixed_ticks'
            });
            const w = seedModel(controller, 'model-a', 8);
            w.effectiveMax = 3;
            w.lastCongestionAt = 0;

            const limits = [3];
            for (let i = 0; i < 5; i++) {
                controller.recordSuccess('model-a');
                controller._tick();
                limits.push(w.effectiveMax);
            }

            // Should increase by 1 each tick: 3 -> 4 -> 5 -> 6 -> 7 -> 8
            expect(limits).toEqual([3, 4, 5, 6, 7, 8]);
        });

        test('proportional: limit ramps faster with larger staticMax', () => {
            createController({
                minHoldMs: 0,
                growthCleanTicks: 1,
                recoveryDelayMs: 0,
                growthMode: 'proportional'
            });
            const w = seedModel(controller, 'model-a', 50);
            w.effectiveMax = 10;
            w.lastCongestionAt = 0;

            controller.recordSuccess('model-a');
            controller._tick();

            // step = max(1, ceil(50 * 0.1)) = 5
            expect(w.effectiveMax).toBe(15);
        });

        test('growth does not exceed staticMax on the final step', () => {
            createController({
                minHoldMs: 0,
                growthCleanTicks: 1,
                recoveryDelayMs: 0,
                growthMode: 'proportional'
            });
            const w = seedModel(controller, 'model-a', 50);
            w.effectiveMax = 48;
            w.lastCongestionAt = 0;

            controller.recordSuccess('model-a');
            controller._tick();

            // step=5 would go to 53, but capped at staticMax=50
            expect(w.effectiveMax).toBe(50);
        });

        test('growthCleanTicks=3 requires 3 successive clean ticks before increase', () => {
            createController({
                minHoldMs: 0,
                growthCleanTicks: 3,
                recoveryDelayMs: 0,
                growthMode: 'fixed_ticks'
            });
            const w = seedModel(controller, 'model-a', 10);
            w.effectiveMax = 5;
            w.lastCongestionAt = 0;

            // Tick 1
            controller.recordSuccess('model-a');
            controller._tick();
            expect(w.effectiveMax).toBe(5);
            expect(w.consecutiveCleanTicks).toBe(1);

            // Tick 2
            controller.recordSuccess('model-a');
            controller._tick();
            expect(w.effectiveMax).toBe(5);
            expect(w.consecutiveCleanTicks).toBe(2);

            // Tick 3 — growth triggers
            controller.recordSuccess('model-a');
            controller._tick();
            expect(w.effectiveMax).toBe(6);
        });
    });

    // ---------------------------------------------------------------
    // 4. Ramp down: errors cause concurrency limit to decrease
    // ---------------------------------------------------------------

    describe('ramp down — errors decrease limit', () => {
        test('single congestion tick halves the limit', () => {
            createController({ decreaseFactor: 0.5 });
            const w = seedModel(controller, 'model-a', 20);

            controller.recordCongestion('model-a', { retryAfterMs: 2000 });
            controller._tick();

            expect(w.effectiveMax).toBe(10);
        });

        test('successive congestion ticks halve repeatedly', () => {
            createController({ minHoldMs: 0, decreaseFactor: 0.5 });
            const w = seedModel(controller, 'model-a', 16);

            const limits = [16];
            for (let i = 0; i < 4; i++) {
                controller.recordCongestion('model-a', { retryAfterMs: 2000 });
                controller._tick();
                limits.push(w.effectiveMax);
            }

            // 16 -> 8 -> 4 -> 2 -> 1
            expect(limits).toEqual([16, 8, 4, 2, 1]);
        });

        test('decreaseFactor of 0.7 yields floor(current * 0.7)', () => {
            createController({ decreaseFactor: 0.7 });
            const w = seedModel(controller, 'model-a', 10);

            controller.recordCongestion('model-a', { retryAfterMs: 2000 });
            controller._tick();

            // floor(10 * 0.7) = 7
            expect(w.effectiveMax).toBe(7);
        });

        test('congestion resets consecutiveCleanTicks to zero', () => {
            createController({ minHoldMs: 0, growthCleanTicks: 2, recoveryDelayMs: 0 });
            const w = seedModel(controller, 'model-a', 10);
            w.effectiveMax = 5;
            w.lastCongestionAt = 0;

            // Build up clean ticks
            controller.recordSuccess('model-a');
            controller._tick();
            expect(w.consecutiveCleanTicks).toBe(1);

            // Congestion resets
            controller.recordCongestion('model-a', { retryAfterMs: 2000 });
            controller._tick();
            expect(w.consecutiveCleanTicks).toBe(0);
        });
    });

    // ---------------------------------------------------------------
    // 5. Min/max bounds: concurrency never below min or above max
    // ---------------------------------------------------------------

    describe('min/max bounds', () => {
        test('effectiveMax never goes below minWindow=1', () => {
            createController({ minWindow: 1, minHoldMs: 0, decreaseFactor: 0.5 });
            const w = seedModel(controller, 'model-a', 10);
            w.effectiveMax = 2;

            controller.recordCongestion('model-a', { retryAfterMs: 2000 });
            controller._tick();
            // floor(2 * 0.5) = 1 >= floor, ok
            expect(w.effectiveMax).toBe(1);

            // Another decrease attempt — already at floor
            jest.advanceTimersByTime(5000);
            controller.recordCongestion('model-a', { retryAfterMs: 2000 });
            controller._tick();
            expect(w.effectiveMax).toBe(1);
        });

        test('effectiveMax never goes below minWindow=3', () => {
            createController({ minWindow: 3, minHoldMs: 0, decreaseFactor: 0.5 });
            const w = seedModel(controller, 'model-a', 10);
            w.effectiveMax = 5;

            controller.recordCongestion('model-a', { retryAfterMs: 2000 });
            controller._tick();
            // floor(5 * 0.5) = 2, but floor is 3 → clamped to 3
            expect(w.effectiveMax).toBe(3);

            jest.advanceTimersByTime(5000);
            controller.recordCongestion('model-a', { retryAfterMs: 2000 });
            controller._tick();
            // floor(3 * 0.5) = 1, but floor=3 → stays at 3
            expect(w.effectiveMax).toBe(3);
        });

        test('effectiveMax never exceeds staticMax during growth', () => {
            createController({ minHoldMs: 0, growthCleanTicks: 1, recoveryDelayMs: 0 });
            const w = seedModel(controller, 'model-a', 5);
            w.effectiveMax = 4;
            w.lastCongestionAt = 0;

            controller.recordSuccess('model-a');
            controller._tick();
            expect(w.effectiveMax).toBe(5);

            // One more — stays at 5
            controller.recordSuccess('model-a');
            controller._tick();
            expect(w.effectiveMax).toBe(5);
        });

        test('effectiveMax never exceeds staticMax during idle decay', () => {
            createController({ idleTimeoutMs: 1000, minHoldMs: 0, idleDecayStep: 5 });
            const w = seedModel(controller, 'model-a', 10);
            w.effectiveMax = 8;
            w.lastTrafficAt = Date.now() - 2000;

            controller._tick();
            // 8 + 5 = 13, but capped at staticMax=10
            expect(w.effectiveMax).toBe(10);
        });

        test('ModelWindow floor is always respected', () => {
            createController({ minWindow: 2 });
            const w = seedModel(controller, 'model-a', 10);

            expect(w.floor).toBe(2);
        });
    });

    // ---------------------------------------------------------------
    // 6. Cold start: first requests use initial/default concurrency
    // ---------------------------------------------------------------

    describe('cold start — initial concurrency', () => {
        test('newly created window starts at staticMax', () => {
            createController();
            mockKeyManager._staticLimits.set('fresh-model', 12);

            controller.recordSuccess('fresh-model');
            const w = controller._windows.get('fresh-model');

            expect(w.effectiveMax).toBe(12);
            expect(w.staticMax).toBe(12);
        });

        test('getEffectiveConcurrency returns staticMax for fresh window in enforce mode', () => {
            createController({ mode: 'enforce' });
            mockKeyManager._staticLimits.set('fresh-model', 8);

            controller.recordSuccess('fresh-model');

            expect(controller.getEffectiveConcurrency('fresh-model')).toBe(8);
        });

        test('first congestion on a cold model creates window and records signal', () => {
            createController();
            mockKeyManager._staticLimits.set('cold-model', 6);

            controller.recordCongestion('cold-model', { retryAfterMs: 3000 });

            const w = controller._windows.get('cold-model');
            expect(w).toBeDefined();
            expect(w.effectiveMax).toBe(6);  // Not yet ticked
            expect(w.congestionCount).toBe(1);
        });

        test('cold start window has zero adjustment history', () => {
            createController();
            mockKeyManager._staticLimits.set('new-model', 10);

            controller.recordSuccess('new-model');
            const w = controller._windows.get('new-model');

            expect(w.history).toHaveLength(0);
            expect(w.totalAdjustmentsUp).toBe(0);
            expect(w.totalAdjustmentsDown).toBe(0);
            expect(w.lastAdjustReason).toBe('init');
        });

        test('unknown model (no static limit) does not create a window', () => {
            createController();
            // No static limit set
            controller.recordSuccess('phantom-model');
            controller.recordCongestion('phantom-model', { retryAfterMs: 2000 });

            expect(controller._windows.has('phantom-model')).toBe(false);
        });
    });

    // ---------------------------------------------------------------
    // 7. Per-model limits: isolation between models
    // ---------------------------------------------------------------

    describe('per-model limits — isolation between models', () => {
        test('congestion on model-a does not affect model-b', () => {
            createController();
            const wA = seedModel(controller, 'model-a', 10);
            const wB = seedModel(controller, 'model-b', 10);

            controller.recordCongestion('model-a', { retryAfterMs: 2000 });
            controller._tick();

            expect(wA.effectiveMax).toBe(5);
            expect(wB.effectiveMax).toBe(10);  // Unaffected
        });

        test('successes on model-b do not advance model-a growth', () => {
            createController({ minHoldMs: 0, growthCleanTicks: 1, recoveryDelayMs: 0 });
            const wA = seedModel(controller, 'model-a', 10);
            const wB = seedModel(controller, 'model-b', 10);
            wA.effectiveMax = 5;
            wA.lastCongestionAt = 0;
            wB.effectiveMax = 5;
            wB.lastCongestionAt = 0;

            // Only model-b receives success
            controller.recordSuccess('model-b');
            controller._tick();

            expect(wA.effectiveMax).toBe(5);  // No successes → no growth
            expect(wB.effectiveMax).toBe(6);   // Grew
        });

        test('each model tracks its own adjustment counters', () => {
            createController({ minHoldMs: 0, growthCleanTicks: 1, recoveryDelayMs: 0 });
            const wA = seedModel(controller, 'model-a', 10);
            const wB = seedModel(controller, 'model-b', 10);

            // Decrease model-a
            controller.recordCongestion('model-a', { retryAfterMs: 2000 });
            controller._tick();

            // Increase model-b
            wB.effectiveMax = 5;
            wB.lastCongestionAt = 0;
            controller.recordSuccess('model-b');
            controller._tick();

            expect(wA.totalAdjustmentsDown).toBe(1);
            expect(wA.totalAdjustmentsUp).toBe(0);
            expect(wB.totalAdjustmentsDown).toBe(0);
            expect(wB.totalAdjustmentsUp).toBe(1);
        });

        test('per-model windows have independent staticMax values', () => {
            createController();
            const wA = seedModel(controller, 'model-a', 8);
            const wB = seedModel(controller, 'model-b', 20);

            expect(wA.staticMax).toBe(8);
            expect(wB.staticMax).toBe(20);
        });

        test('snapshot contains entries for each model independently', () => {
            createController();
            seedModel(controller, 'model-a', 8);
            seedModel(controller, 'model-b', 12);

            const snapshot = controller.getSnapshot();
            expect(Object.keys(snapshot.models)).toEqual(
                expect.arrayContaining(['model-a', 'model-b'])
            );
            expect(snapshot.models['model-a'].staticMax).toBe(8);
            expect(snapshot.models['model-b'].staticMax).toBe(12);
        });
    });

    // ---------------------------------------------------------------
    // 8. Stats/metrics: controller exposes limit, utilization, history
    // ---------------------------------------------------------------

    describe('stats/metrics — observability', () => {
        test('getSnapshot returns current mode', () => {
            createController({ mode: 'enforce' });
            const snapshot = controller.getSnapshot();
            expect(snapshot.mode).toBe('enforce');
        });

        test('getSnapshot returns per-model effectiveMax and staticMax', () => {
            createController();
            const w = seedModel(controller, 'model-a', 10);
            w.effectiveMax = 7;

            const snapshot = controller.getSnapshot();
            expect(snapshot.models['model-a'].staticMax).toBe(10);
            expect(snapshot.models['model-a'].effectiveMax).toBe(7);
        });

        test('getSnapshot exposes adjustmentsUp and adjustmentsDown counters', () => {
            createController({ minHoldMs: 0, growthCleanTicks: 1, recoveryDelayMs: 0 });
            const w = seedModel(controller, 'model-a', 10);

            // Decrease
            controller.recordCongestion('model-a', { retryAfterMs: 2000 });
            controller._tick();

            // Increase
            w.lastCongestionAt = 0;
            controller.recordSuccess('model-a');
            controller._tick();

            const snapshot = controller.getSnapshot();
            expect(snapshot.models['model-a'].adjustmentsDown).toBe(1);
            expect(snapshot.models['model-a'].adjustmentsUp).toBe(1);
        });

        test('getSnapshot exposes lastAdjustReason', () => {
            createController();
            const w = seedModel(controller, 'model-a', 10);

            controller.recordCongestion('model-a', { retryAfterMs: 2000 });
            controller._tick();

            const snapshot = controller.getSnapshot();
            expect(snapshot.models['model-a'].lastAdjustReason).toBe('decrease_congestion');
        });

        test('getSnapshot exposes isOscillating and consecutiveCleanTicks', () => {
            createController();
            seedModel(controller, 'model-a', 10);

            const snapshot = controller.getSnapshot();
            expect(typeof snapshot.models['model-a'].isOscillating).toBe('boolean');
            expect(typeof snapshot.models['model-a'].consecutiveCleanTicks).toBe('number');
        });

        test('getSnapshot exposes isIdle flag based on idleTimeoutMs', () => {
            createController({ idleTimeoutMs: 5000 });
            const w = seedModel(controller, 'model-a', 10);

            // Recent traffic → not idle
            w.lastTrafficAt = Date.now();
            let snapshot = controller.getSnapshot();
            expect(snapshot.models['model-a'].isIdle).toBe(false);

            // Old traffic → idle
            w.lastTrafficAt = Date.now() - 10000;
            snapshot = controller.getSnapshot();
            expect(snapshot.models['model-a'].isIdle).toBe(true);
        });

        test('getSnapshot exposes history array (last 20 entries)', () => {
            createController({ minHoldMs: 0, growthCleanTicks: 1, recoveryDelayMs: 0 });
            const w = seedModel(controller, 'model-a', 100);
            w.effectiveMax = 1;
            w.lastCongestionAt = 0;

            for (let i = 0; i < 25; i++) {
                controller.recordSuccess('model-a');
                controller._tick();
            }

            const snapshot = controller.getSnapshot();
            expect(snapshot.models['model-a'].history.length).toBeLessThanOrEqual(20);
        });

        test('tick pushes snapshot to statsAggregator', () => {
            createController();
            seedModel(controller, 'model-a', 10);

            controller._tick();

            expect(mockStatsAggregator.recordAdaptiveConcurrency).toHaveBeenCalledTimes(1);
            const arg = mockStatsAggregator.recordAdaptiveConcurrency.mock.calls[0][0];
            expect(arg).toHaveProperty('mode');
            expect(arg).toHaveProperty('models');
        });

        test('global window snapshot includes effectiveMax and sumModelEffective', () => {
            createController({ globalMaxConcurrency: 30 });
            seedModel(controller, 'model-a', 10);
            seedModel(controller, 'model-b', 8);

            const snapshot = controller.getSnapshot();
            expect(snapshot.globalWindow).not.toBeNull();
            expect(snapshot.globalWindow.effectiveMax).toBe(30);
            expect(snapshot.globalWindow.sumModelEffective).toBe(18);
        });
    });

    // ---------------------------------------------------------------
    // 9. Timer cleanup: start()/stop() properly manages intervals
    // ---------------------------------------------------------------

    describe('timer cleanup — start()/stop() lifecycle', () => {
        test('start() creates a tick interval', () => {
            createController();
            expect(controller._tickInterval).toBeNull();

            controller.start();
            expect(controller._tickInterval).not.toBeNull();
        });

        test('stop() clears the tick interval', () => {
            createController();
            controller.start();
            expect(controller._tickInterval).not.toBeNull();

            controller.stop();
            expect(controller._tickInterval).toBeNull();
        });

        test('double start() is idempotent — same interval object retained', () => {
            createController();
            controller.start();
            const first = controller._tickInterval;

            controller.start();
            expect(controller._tickInterval).toBe(first);
        });

        test('double stop() does not throw', () => {
            createController();
            controller.start();
            controller.stop();
            expect(() => controller.stop()).not.toThrow();
            expect(controller._tickInterval).toBeNull();
        });

        test('stop() before start() does not throw', () => {
            createController();
            expect(() => controller.stop()).not.toThrow();
        });

        test('start/stop/start creates a new interval', () => {
            createController();
            controller.start();
            const first = controller._tickInterval;

            controller.stop();
            controller.start();
            const second = controller._tickInterval;

            expect(second).not.toBeNull();
            expect(second).not.toBe(first);
        });

        test('stop() in enforce mode calls restoreStaticLimits', () => {
            createController({ mode: 'enforce' });
            seedModel(controller, 'model-a', 10);

            controller.start();
            controller.stop();

            expect(mockKeyManager.restoreStaticLimits).toHaveBeenCalled();
        });

        test('stop() in observe_only mode does NOT call restoreStaticLimits', () => {
            createController({ mode: 'observe_only' });
            seedModel(controller, 'model-a', 10);

            controller.start();
            controller.stop();

            expect(mockKeyManager.restoreStaticLimits).not.toHaveBeenCalled();
        });

        test('tick fires at configured interval after start()', () => {
            createController({ tickIntervalMs: 3000 });
            seedModel(controller, 'model-a', 10);

            controller.start();
            controller.recordCongestion('model-a', { retryAfterMs: 2000 });

            // Not yet at 3000ms
            jest.advanceTimersByTime(2999);
            expect(controller._windows.get('model-a').effectiveMax).toBe(10);

            // Now at 3000ms
            jest.advanceTimersByTime(1);
            expect(controller._windows.get('model-a').effectiveMax).toBe(5);
        });

        test('no ticks fire after stop()', () => {
            createController({ tickIntervalMs: 1000 });
            seedModel(controller, 'model-a', 10);

            controller.start();
            controller.stop();

            controller.recordCongestion('model-a', { retryAfterMs: 2000 });
            jest.advanceTimersByTime(5000);

            // effectiveMax should remain unchanged — no ticks happened
            expect(controller._windows.get('model-a').effectiveMax).toBe(10);
        });
    });

    // ---------------------------------------------------------------
    // 10. Edge: zero traffic — no division by zero or stale state
    // ---------------------------------------------------------------

    describe('zero traffic — no crashes or stale state', () => {
        test('tick with no windows is a no-op', () => {
            createController();
            expect(() => controller._tick()).not.toThrow();
        });

        test('tick with seeded windows but zero traffic does not throw', () => {
            createController();
            seedModel(controller, 'model-a', 10);

            // No recordSuccess or recordCongestion
            expect(() => controller._tick()).not.toThrow();
        });

        test('many ticks with zero traffic do not accumulate errors', () => {
            createController({ minHoldMs: 0 });
            seedModel(controller, 'model-a', 10);

            for (let i = 0; i < 100; i++) {
                controller._tick();
            }

            // Should still be at staticMax, no NaN or Infinity
            const w = controller._windows.get('model-a');
            expect(w.effectiveMax).toBe(10);
            expect(Number.isFinite(w.effectiveMax)).toBe(true);
        });

        test('snapshot with zero traffic windows does not produce NaN', () => {
            createController();
            seedModel(controller, 'model-a', 10);

            const snapshot = controller.getSnapshot();
            const model = snapshot.models['model-a'];

            expect(Number.isFinite(model.effectiveMax)).toBe(true);
            expect(Number.isFinite(model.staticMax)).toBe(true);
            expect(Number.isFinite(model.congestion429)).toBe(true);
            expect(Number.isFinite(model.success)).toBe(true);
        });

        test('zero traffic for extended period triggers idle decay (not crash)', () => {
            createController({ idleTimeoutMs: 1000, minHoldMs: 0 });
            const w = seedModel(controller, 'model-a', 10);
            w.effectiveMax = 5;
            w.lastTrafficAt = Date.now() - 2000;

            expect(() => controller._tick()).not.toThrow();
            expect(w.effectiveMax).toBe(6);  // Idle decay step
            expect(w.lastAdjustReason).toBe('idle_decay');
        });

        test('idle decay with effectiveMax already at staticMax is a no-op', () => {
            createController({ idleTimeoutMs: 1000, minHoldMs: 0 });
            const w = seedModel(controller, 'model-a', 10);
            w.effectiveMax = 10;
            w.lastTrafficAt = Date.now() - 2000;

            controller._tick();
            expect(w.effectiveMax).toBe(10);
        });

        test('global window with zero-traffic models does not divide by zero', () => {
            createController({ globalMaxConcurrency: 5 });
            // No models seeded — sum is 0, ratio would be 5/0
            expect(() => controller._tick()).not.toThrow();
        });

        test('getSnapshot on empty controller returns valid structure', () => {
            createController();
            const snapshot = controller.getSnapshot();

            expect(snapshot.mode).toBe('enforce');
            expect(snapshot.models).toEqual({});
            expect(snapshot.globalWindow).toBeNull();
        });

        test('accumulators stay at zero across ticks with no traffic', () => {
            createController({ minHoldMs: 0 });
            const w = seedModel(controller, 'model-a', 10);

            controller._tick();
            controller._tick();
            controller._tick();

            expect(w.congestionCount).toBe(0);
            expect(w.successCount).toBe(0);
            expect(w.quotaHitCount).toBe(0);
            expect(w.unknownHitCount).toBe(0);
        });
    });
});
