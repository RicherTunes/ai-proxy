'use strict';

const { CircuitBreaker, STATES } = require('../lib/circuit-breaker');

describe('CircuitBreaker Function Coverage', () => {

    // ---------------------------------------------------------------
    // Line 175: recordFailure(errorType = 'unknown') default parameter
    // All existing tests pass an explicit errorType; none exercise the default.
    // ---------------------------------------------------------------
    describe('recordFailure default parameter (line 175)', () => {
        let cb;
        beforeEach(() => {
            cb = new CircuitBreaker({ failureThreshold: 5, failureWindow: 30000 });
        });
        afterEach(() => {
            cb.destroy();
            jest.restoreAllMocks();
            jest.useRealTimers();
        });

        // Covers line 175: calling recordFailure() with no argument triggers default 'unknown'
        test('should use "unknown" as default errorType when called without arguments', () => {
            cb.recordFailure();
            expect(cb.lastError).toBe('unknown');
            expect(cb.failureCount).toBe(1);
            expect(cb.failureTimestamps.length).toBe(1);
        });

        // Covers line 175: default parameter used; verify state transition still works
        test('should trip circuit with default errorType after enough failures', () => {
            cb.recordFailure();
            cb.recordFailure();
            cb.recordFailure();
            cb.recordFailure();
            cb.recordFailure();
            expect(cb.state).toBe(STATES.OPEN);
            expect(cb.lastError).toBe('unknown');
        });

        // Covers line 175: default errorType passed through onStateChange in HALF_OPEN
        test('should report default errorType in HALF_OPEN failure callback', () => {
            jest.useFakeTimers();
            const stateChanges = [];
            cb.destroy();

            cb = new CircuitBreaker({
                failureThreshold: 2,
                failureWindow: 30000,
                cooldownPeriod: 1000,
                halfOpenTimeout: 2000,
                onStateChange: (from, to, info) => stateChanges.push({ from, to, info })
            });

            // Trip to OPEN
            cb.recordFailure();
            cb.recordFailure();
            expect(cb.state).toBe(STATES.OPEN);

            // Transition to HALF_OPEN
            jest.advanceTimersByTime(1001);
            cb.updateState();
            expect(cb.state).toBe(STATES.HALF_OPEN);

            // Fail in HALF_OPEN with no argument
            stateChanges.length = 0;
            cb.recordFailure();

            expect(cb.state).toBe(STATES.OPEN);
            expect(stateChanges.length).toBe(1);
            expect(stateChanges[0].info.reason).toBe('test_failed');
            expect(stateChanges[0].info.errorType).toBe('unknown');
        });
    });

    // ---------------------------------------------------------------
    // Line 50: setTimeout callback in _setHalfOpenTimeout
    // The callback checks if still HALF_OPEN before reverting to OPEN.
    // ---------------------------------------------------------------
    describe('setTimeout callback in _setHalfOpenTimeout (line 50)', () => {
        let cb;
        let stateChanges;
        beforeEach(() => {
            jest.useFakeTimers();
            stateChanges = [];
            cb = new CircuitBreaker({
                failureThreshold: 2,
                failureWindow: 10000,
                cooldownPeriod: 1000,
                halfOpenTimeout: 2000,
                onStateChange: (from, to, info) => stateChanges.push({ from, to, info })
            });
        });
        afterEach(() => {
            cb.destroy();
            jest.restoreAllMocks();
            jest.useRealTimers();
        });

        // Covers line 50: setTimeout fires while state is still HALF_OPEN, reverts to OPEN
        test('should revert to OPEN when halfOpenTimeout fires in HALF_OPEN state', () => {
            cb.recordFailure('err');
            cb.recordFailure('err');
            expect(cb.state).toBe(STATES.OPEN);

            // Advance past cooldown to trigger HALF_OPEN via updateState
            jest.advanceTimersByTime(1001);
            cb.updateState();
            expect(cb.state).toBe(STATES.HALF_OPEN);

            stateChanges.length = 0;

            // Advance past halfOpenTimeout AND run pending timers to execute setTimeout callback
            jest.advanceTimersByTime(2001);
            jest.runOnlyPendingTimers();  // This executes the setTimeout callback

            expect(cb.state).toBe(STATES.OPEN);
            expect(cb.halfOpenRequestInFlight).toBe(false);
            expect(stateChanges.length).toBe(1);
            expect(stateChanges[0].from).toBe(STATES.HALF_OPEN);
            expect(stateChanges[0].to).toBe(STATES.OPEN);
            expect(stateChanges[0].info.reason).toBe('half_open_timeout');
        });

        // Covers line 50: setTimeout fires but state is no longer HALF_OPEN — no-op
        test('should not revert when timeout fires but state already changed', () => {
            cb.recordFailure('err');
            cb.recordFailure('err');
            jest.advanceTimersByTime(1001);
            cb.updateState();
            expect(cb.state).toBe(STATES.HALF_OPEN);

            // Record success before timeout fires — transitions to CLOSED
            cb.recordSuccess();
            expect(cb.state).toBe(STATES.CLOSED);

            stateChanges.length = 0;

            // Advance past where timeout would have fired
            jest.advanceTimersByTime(2001);

            expect(cb.state).toBe(STATES.CLOSED);
            expect(stateChanges.length).toBe(0);
        });

        // Covers line 50: timeout callback refreshes openedAt when reverting
        test('should refresh openedAt timestamp when reverting from HALF_OPEN to OPEN', () => {
            cb.recordFailure('err');
            cb.recordFailure('err');
            const firstOpenedAt = cb.openedAt;

            jest.advanceTimersByTime(1001);
            cb.updateState();
            expect(cb.state).toBe(STATES.HALF_OPEN);

            jest.advanceTimersByTime(2001);

            expect(cb.state).toBe(STATES.OPEN);
            expect(cb.openedAt).toBeGreaterThanOrEqual(firstOpenedAt);
        });
    });

    // ---------------------------------------------------------------
    // Line 216: forceState(HALF_OPEN) branch
    // Initializes halfOpenStartedAt, resets halfOpenRequestInFlight, starts timeout.
    // ---------------------------------------------------------------
    describe('forceState HALF_OPEN branch (line 216)', () => {
        let cb;
        beforeEach(() => {
            jest.useFakeTimers();
            cb = new CircuitBreaker({
                failureThreshold: 3,
                failureWindow: 30000,
                cooldownPeriod: 60000,
                halfOpenTimeout: 5000
            });
        });
        afterEach(() => {
            cb.destroy();
            jest.restoreAllMocks();
            jest.useRealTimers();
        });

        // Covers line 216: forceState(HALF_OPEN) from CLOSED initializes HALF_OPEN tracking
        test('should initialize HALF_OPEN tracking when forced from CLOSED', () => {
            const before = Date.now();
            cb.forceState(STATES.HALF_OPEN);
            const after = Date.now();

            expect(cb.state).toBe(STATES.HALF_OPEN);
            expect(cb.halfOpenStartedAt).toBeGreaterThanOrEqual(before);
            expect(cb.halfOpenStartedAt).toBeLessThanOrEqual(after);
            expect(cb.halfOpenRequestInFlight).toBe(false);
            expect(cb.halfOpenTimeoutId).not.toBeNull();
        });

        // Covers line 216: forceState(HALF_OPEN) from OPEN clears OPEN tracking
        test('should initialize HALF_OPEN tracking when forced from OPEN', () => {
            cb.forceState(STATES.OPEN);
            const openedAt = cb.openedAt;
            expect(openedAt).toBeGreaterThan(0);

            const before = Date.now();
            cb.forceState(STATES.HALF_OPEN);
            const after = Date.now();

            expect(cb.state).toBe(STATES.HALF_OPEN);
            expect(cb.halfOpenStartedAt).toBeGreaterThanOrEqual(before);
            expect(cb.halfOpenStartedAt).toBeLessThanOrEqual(after);
            expect(cb.halfOpenRequestInFlight).toBe(false);
            expect(cb.halfOpenTimeoutId).not.toBeNull();
        });

        // Covers line 216: forceState(HALF_OPEN) fires onStateChange callback
        test('should fire onStateChange with reason "forced" when transitioning to HALF_OPEN', () => {
            const stateChanges = [];
            const cb2 = new CircuitBreaker({
                failureThreshold: 3,
                failureWindow: 30000,
                cooldownPeriod: 60000,
                halfOpenTimeout: 5000,
                onStateChange: (from, to, info) => stateChanges.push({ from, to, info })
            });

            cb2.forceState(STATES.HALF_OPEN);

            expect(stateChanges.length).toBe(1);
            expect(stateChanges[0].from).toBe(STATES.CLOSED);
            expect(stateChanges[0].to).toBe(STATES.HALF_OPEN);
            expect(stateChanges[0].info.reason).toBe('forced');

            cb2.destroy();
        });
    });

    // ---------------------------------------------------------------
    // Line 337: getPredictionData acceleration — all failures in recent half
    // When olderFailures === 0 and newerFailures > 0, accelerationScore = 35
    // ---------------------------------------------------------------
    describe('getPredictionData all-failures-in-recent-half (line 337)', () => {
        let cb;
        beforeEach(() => {
            jest.useFakeTimers();
            cb = new CircuitBreaker({
                failureThreshold: 10,
                failureWindow: 30000,
                cooldownPeriod: 60000
            });
        });
        afterEach(() => {
            cb.destroy();
            jest.restoreAllMocks();
            jest.useRealTimers();
        });

        // Covers line 337: all failures in recent half of window, olderFailures = 0
        test('should set accelerationScore to 35 when all failures are in recent half', () => {
            const now = Date.now();
            jest.setSystemTime(now);

            // Place 3 failures within recent half (0-15s of 30s window)
            cb.recordFailure('err');
            jest.advanceTimersByTime(3000);
            cb.recordFailure('err');
            jest.advanceTimersByTime(3000);
            cb.recordFailure('err');

            const prediction = cb.getPredictionData();

            expect(prediction.components.acceleration).toBe(35);
            expect(prediction.recentFailures).toBe(3);
        });

        // Covers line 337: 2 failures in recent half, 0 in older half
        test('should set accelerationScore to 35 with exactly 2 recent-half failures', () => {
            const now = Date.now();
            jest.setSystemTime(now);

            cb.recordFailure('err');
            jest.advanceTimersByTime(5000);
            cb.recordFailure('err');

            const prediction = cb.getPredictionData();

            expect(prediction.components.acceleration).toBe(35);
            expect(prediction.recentFailures).toBe(2);
        });

        // Covers line 337: verify this path produces correct overall score structure
        test('should include full prediction structure when all failures are recent', () => {
            const now = Date.now();
            jest.setSystemTime(now);

            cb.recordFailure('err');
            jest.advanceTimersByTime(2000);
            cb.recordFailure('err');

            const prediction = cb.getPredictionData();

            expect(prediction.score).toBeGreaterThan(0);
            expect(prediction.components).toEqual({
                ratio: expect.any(Number),
                acceleration: 35,
                recency: expect.any(Number)
            });
            expect(prediction.recentFailures).toBe(2);
            expect(prediction.threshold).toBe(10);
            expect(prediction.state).toBe(STATES.CLOSED);
        });
    });
});
