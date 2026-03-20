/**
 * Circuit Breaker Edge Case Tests
 * Covers: state machine completeness, failure window sliding, concurrent HALF_OPEN,
 * reset after idle, custom thresholds, getState accuracy, event emissions.
 */

'use strict';

const { CircuitBreaker, STATES } = require('../lib/circuit-breaker');

describe('CircuitBreaker Edge Cases', () => {
    // ---------------------------------------------------------------
    // 1. State machine completeness
    // ---------------------------------------------------------------
    describe('state machine completeness', () => {
        let cb;
        let stateChanges;

        beforeEach(() => {
            jest.useFakeTimers();
            stateChanges = [];
            cb = new CircuitBreaker({
                failureThreshold: 3,
                failureWindow: 10000,
                cooldownPeriod: 5000,
                halfOpenTimeout: 3000,
                onStateChange: (from, to, info) => {
                    stateChanges.push({ from, to, info });
                }
            });
        });

        afterEach(() => {
            cb.destroy();
            jest.useRealTimers();
        });

        test('CLOSED -> OPEN via failures reaching threshold', () => {
            expect(cb.state).toBe(STATES.CLOSED);
            cb.recordFailure('err');
            cb.recordFailure('err');
            cb.recordFailure('err');
            expect(cb.state).toBe(STATES.OPEN);

            expect(stateChanges).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ from: STATES.CLOSED, to: STATES.OPEN })
                ])
            );
        });

        test('OPEN -> HALF_OPEN via cooldown expiry', () => {
            cb.recordFailure('err');
            cb.recordFailure('err');
            cb.recordFailure('err');
            expect(cb.state).toBe(STATES.OPEN);

            stateChanges = [];
            jest.advanceTimersByTime(5000);
            cb.updateState();

            expect(cb.state).toBe(STATES.HALF_OPEN);
            expect(stateChanges).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ from: STATES.OPEN, to: STATES.HALF_OPEN })
                ])
            );
        });

        test('HALF_OPEN -> CLOSED via recordSuccess', () => {
            cb.recordFailure('err');
            cb.recordFailure('err');
            cb.recordFailure('err');
            jest.advanceTimersByTime(5000);
            cb.updateState();
            expect(cb.state).toBe(STATES.HALF_OPEN);

            stateChanges = [];
            cb.recordSuccess();

            expect(cb.state).toBe(STATES.CLOSED);
            expect(stateChanges).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ from: STATES.HALF_OPEN, to: STATES.CLOSED })
                ])
            );
        });

        test('HALF_OPEN -> OPEN via recordFailure', () => {
            cb.recordFailure('err');
            cb.recordFailure('err');
            cb.recordFailure('err');
            jest.advanceTimersByTime(5000);
            cb.updateState();
            expect(cb.state).toBe(STATES.HALF_OPEN);

            stateChanges = [];
            cb.recordFailure('err');

            expect(cb.state).toBe(STATES.OPEN);
            expect(stateChanges).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ from: STATES.HALF_OPEN, to: STATES.OPEN })
                ])
            );
        });

        test('CLOSED should not transition directly to HALF_OPEN', () => {
            // Record failures below threshold
            cb.recordFailure('err');
            cb.recordFailure('err');
            // Advance time without hitting threshold
            jest.advanceTimersByTime(20000);
            cb.updateState();

            // Should stay CLOSED (failures expired) -- never jumped to HALF_OPEN
            expect(cb.state).toBe(STATES.CLOSED);
            const halfOpenTransitions = stateChanges.filter(
                sc => sc.from === STATES.CLOSED && sc.to === STATES.HALF_OPEN
            );
            expect(halfOpenTransitions).toHaveLength(0);
        });

        test('OPEN should not transition directly to CLOSED', () => {
            cb.recordFailure('err');
            cb.recordFailure('err');
            cb.recordFailure('err');
            expect(cb.state).toBe(STATES.OPEN);

            stateChanges = [];

            // Even after a very long time, updateState should go to HALF_OPEN, not CLOSED
            jest.advanceTimersByTime(100000);
            cb.updateState();

            expect(cb.state).toBe(STATES.HALF_OPEN);
            const directClose = stateChanges.filter(
                sc => sc.from === STATES.OPEN && sc.to === STATES.CLOSED
            );
            expect(directClose).toHaveLength(0);
        });
    });

    // ---------------------------------------------------------------
    // 2. Failure window sliding
    // ---------------------------------------------------------------
    describe('failure window sliding', () => {
        let cb;

        beforeEach(() => {
            jest.useFakeTimers();
            cb = new CircuitBreaker({
                failureThreshold: 3,
                failureWindow: 10000, // 10 seconds
                cooldownPeriod: 5000,
                halfOpenTimeout: 3000
            });
        });

        afterEach(() => {
            cb.destroy();
            jest.useRealTimers();
        });

        test('failures older than window are discarded', () => {
            cb.recordFailure('err');
            cb.recordFailure('err');
            expect(cb.getStats().recentFailures).toBe(2);

            // Advance past the window
            jest.advanceTimersByTime(11000);

            // Old failures should be gone
            expect(cb.getStats().recentFailures).toBe(0);
        });

        test('only recent failures within window count toward threshold', () => {
            // Spread failures across time so oldest ones expire
            cb.recordFailure('err');       // t=0
            jest.advanceTimersByTime(4000);
            cb.recordFailure('err');       // t=4s

            jest.advanceTimersByTime(7000); // t=11s -- first failure now out of window

            // Only second failure remains
            expect(cb.getStats().recentFailures).toBe(1);

            cb.recordFailure('err');       // t=11s
            // 2 failures in window -- still below threshold (3)
            expect(cb.state).toBe(STATES.CLOSED);
        });

        test('staggered failures: some expire while new ones come in', () => {
            cb.recordFailure('err');        // t=0
            jest.advanceTimersByTime(3000);
            cb.recordFailure('err');        // t=3s
            jest.advanceTimersByTime(3000);
            cb.recordFailure('err');        // t=6s -- 3 in window -> OPEN

            expect(cb.state).toBe(STATES.OPEN);
        });

        test('staggered failures that never accumulate to threshold', () => {
            cb.recordFailure('err');        // t=0
            jest.advanceTimersByTime(6000);
            cb.recordFailure('err');        // t=6s

            jest.advanceTimersByTime(5000); // t=11s -- first failure expired
            cb.recordFailure('err');        // t=11s -- only 2 in window

            jest.advanceTimersByTime(5000); // t=16s -- second failure expired
            cb.recordFailure('err');        // t=16s -- only 2 in window

            expect(cb.state).toBe(STATES.CLOSED);
        });
    });

    // ---------------------------------------------------------------
    // 3. Concurrent requests during HALF_OPEN
    // ---------------------------------------------------------------
    describe('concurrent requests during HALF_OPEN', () => {
        let cb;

        beforeEach(() => {
            jest.useFakeTimers();
            cb = new CircuitBreaker({
                failureThreshold: 3,
                failureWindow: 10000,
                cooldownPeriod: 5000,
                halfOpenTimeout: 3000
            });
            // Trip to OPEN, then advance to HALF_OPEN
            cb.recordFailure('err');
            cb.recordFailure('err');
            cb.recordFailure('err');
            jest.advanceTimersByTime(5000);
            cb.updateState();
            expect(cb.state).toBe(STATES.HALF_OPEN);
        });

        afterEach(() => {
            cb.destroy();
            jest.useRealTimers();
        });

        test('first caller acquires the test request', () => {
            expect(cb.tryAcquireTestRequest()).toBe(true);
            expect(cb.halfOpenRequestInFlight).toBe(true);
        });

        test('second concurrent caller is rejected', () => {
            cb.tryAcquireTestRequest(); // first caller
            expect(cb.tryAcquireTestRequest()).toBe(false);
        });

        test('isAvailable blocks after test request acquired', () => {
            expect(cb.isAvailable()).toBe(true);  // first check also sees HALF_OPEN available
            cb.tryAcquireTestRequest();
            expect(cb.isAvailable()).toBe(false);  // in-flight -> not available
        });

        test('multiple rapid isAvailable calls -- only one returns true for test slot', () => {
            // Simulate racing callers: first acquires, rest are blocked
            const first = cb.isAvailable(); // true (no in-flight)
            cb.tryAcquireTestRequest();
            const second = cb.isAvailable();
            const third = cb.isAvailable();

            expect(first).toBe(true);
            expect(second).toBe(false);
            expect(third).toBe(false);
        });

        test('after test request succeeds, circuit closes and is fully available', () => {
            cb.tryAcquireTestRequest();
            cb.recordSuccess();

            expect(cb.state).toBe(STATES.CLOSED);
            expect(cb.isAvailable()).toBe(true);
            expect(cb.halfOpenRequestInFlight).toBe(false);
        });

        test('after test request fails, circuit reopens and rejects all', () => {
            cb.tryAcquireTestRequest();
            cb.recordFailure('err');

            expect(cb.state).toBe(STATES.OPEN);
            expect(cb.isAvailable()).toBe(false);
            expect(cb.halfOpenRequestInFlight).toBe(false);
        });
    });

    // ---------------------------------------------------------------
    // 4. Reset after prolonged idle
    // ---------------------------------------------------------------
    describe('reset after prolonged idle', () => {
        let cb;
        let stateChanges;

        beforeEach(() => {
            jest.useFakeTimers();
            stateChanges = [];
            cb = new CircuitBreaker({
                failureThreshold: 3,
                failureWindow: 10000,
                cooldownPeriod: 5000,
                halfOpenTimeout: 3000,
                onStateChange: (from, to, info) => {
                    stateChanges.push({ from, to, info });
                }
            });
        });

        afterEach(() => {
            cb.destroy();
            jest.useRealTimers();
        });

        test('OPEN circuit transitions to HALF_OPEN on next request after cooldown', () => {
            cb.recordFailure('err');
            cb.recordFailure('err');
            cb.recordFailure('err');
            expect(cb.state).toBe(STATES.OPEN);

            // Prolonged idle -- no requests for a very long time
            jest.advanceTimersByTime(60000);

            // Next isAvailable call should trigger HALF_OPEN
            const available = cb.isAvailable();
            expect(cb.state).toBe(STATES.HALF_OPEN);
            expect(available).toBe(true); // HALF_OPEN allows one test request
        });

        test('cooldown far exceeded still transitions correctly', () => {
            cb.recordFailure('err');
            cb.recordFailure('err');
            cb.recordFailure('err');
            expect(cb.state).toBe(STATES.OPEN);

            // 10x the cooldown period
            jest.advanceTimersByTime(50000);

            cb.updateState();
            expect(cb.state).toBe(STATES.HALF_OPEN);
        });

        test('HALF_OPEN auto-reverts to OPEN after halfOpenTimeout with no activity', () => {
            cb.recordFailure('err');
            cb.recordFailure('err');
            cb.recordFailure('err');
            jest.advanceTimersByTime(5000);
            cb.updateState();
            expect(cb.state).toBe(STATES.HALF_OPEN);

            stateChanges = [];

            // No requests at all during halfOpenTimeout
            jest.advanceTimersByTime(3000);

            expect(cb.state).toBe(STATES.OPEN);
            expect(stateChanges.some(sc => sc.info.reason === 'half_open_timeout')).toBe(true);
        });

        test('full idle cycle: OPEN -> idle -> HALF_OPEN -> timeout -> OPEN -> idle -> HALF_OPEN', () => {
            cb.recordFailure('err');
            cb.recordFailure('err');
            cb.recordFailure('err');
            expect(cb.state).toBe(STATES.OPEN);

            // First cooldown
            jest.advanceTimersByTime(5000);
            cb.updateState();
            expect(cb.state).toBe(STATES.HALF_OPEN);

            // Timeout with no activity
            jest.advanceTimersByTime(3000);
            expect(cb.state).toBe(STATES.OPEN);

            // Second cooldown
            jest.advanceTimersByTime(5000);
            cb.updateState();
            expect(cb.state).toBe(STATES.HALF_OPEN);
        });
    });

    // ---------------------------------------------------------------
    // 5. Custom thresholds
    // ---------------------------------------------------------------
    describe('custom thresholds', () => {
        afterEach(() => {
            jest.useRealTimers();
        });

        test('failureThreshold=1 trips on first failure', () => {
            const cb = new CircuitBreaker({
                failureThreshold: 1,
                failureWindow: 10000,
                cooldownPeriod: 1000
            });
            cb.recordFailure('err');
            expect(cb.state).toBe(STATES.OPEN);
            cb.destroy();
        });

        test('failureThreshold=10 requires 10 failures to trip', () => {
            const cb = new CircuitBreaker({
                failureThreshold: 10,
                failureWindow: 30000,
                cooldownPeriod: 5000
            });
            for (let i = 0; i < 9; i++) {
                cb.recordFailure('err');
            }
            expect(cb.state).toBe(STATES.CLOSED);

            cb.recordFailure('err');
            expect(cb.state).toBe(STATES.OPEN);
            cb.destroy();
        });

        test('very short cooldownPeriod (100ms)', () => {
            jest.useFakeTimers();
            const cb = new CircuitBreaker({
                failureThreshold: 2,
                failureWindow: 5000,
                cooldownPeriod: 100,
                halfOpenTimeout: 50
            });

            cb.recordFailure('err');
            cb.recordFailure('err');
            expect(cb.state).toBe(STATES.OPEN);

            jest.advanceTimersByTime(100);
            cb.updateState();
            expect(cb.state).toBe(STATES.HALF_OPEN);

            cb.destroy();
        });

        test('very long cooldownPeriod (5 minutes)', () => {
            jest.useFakeTimers();
            const cb = new CircuitBreaker({
                failureThreshold: 2,
                failureWindow: 10000,
                cooldownPeriod: 300000,
                halfOpenTimeout: 10000
            });

            cb.recordFailure('err');
            cb.recordFailure('err');
            expect(cb.state).toBe(STATES.OPEN);

            // Advance 4 minutes -- still OPEN
            jest.advanceTimersByTime(240000);
            cb.updateState();
            expect(cb.state).toBe(STATES.OPEN);

            // Advance remaining 1 minute
            jest.advanceTimersByTime(60000);
            cb.updateState();
            expect(cb.state).toBe(STATES.HALF_OPEN);

            cb.destroy();
        });

        test('custom failureWindow: short window (500ms) causes fast expiry', () => {
            jest.useFakeTimers();
            const cb = new CircuitBreaker({
                failureThreshold: 3,
                failureWindow: 500,
                cooldownPeriod: 1000
            });

            cb.recordFailure('err');
            cb.recordFailure('err');
            jest.advanceTimersByTime(600); // window expired
            cb.recordFailure('err');

            // Only 1 failure in window -- should stay CLOSED
            expect(cb.state).toBe(STATES.CLOSED);

            cb.destroy();
        });

        test('default values are used when no options passed', () => {
            const cb = new CircuitBreaker();
            expect(cb.failureThreshold).toBe(5);
            expect(cb.failureWindow).toBe(30000);
            expect(cb.cooldownPeriod).toBe(60000);
            expect(cb.halfOpenTimeout).toBe(10000);
            cb.destroy();
        });
    });

    // ---------------------------------------------------------------
    // 6. getState() / getStats() accuracy
    // ---------------------------------------------------------------
    describe('getStats accuracy', () => {
        let cb;

        beforeEach(() => {
            jest.useFakeTimers();
            cb = new CircuitBreaker({
                failureThreshold: 3,
                failureWindow: 10000,
                cooldownPeriod: 5000,
                halfOpenTimeout: 3000
            });
        });

        afterEach(() => {
            cb.destroy();
            jest.useRealTimers();
        });

        test('reflects correct state name in CLOSED', () => {
            const stats = cb.getStats();
            expect(stats.state).toBe('CLOSED');
        });

        test('reflects correct state name in OPEN', () => {
            cb.recordFailure('err');
            cb.recordFailure('err');
            cb.recordFailure('err');
            expect(cb.getStats().state).toBe('OPEN');
        });

        test('reflects correct state name in HALF_OPEN', () => {
            cb.recordFailure('err');
            cb.recordFailure('err');
            cb.recordFailure('err');
            jest.advanceTimersByTime(5000);
            cb.updateState();
            expect(cb.getStats().state).toBe('HALF_OPEN');
        });

        test('failureCount tracks cumulative failures', () => {
            cb.recordFailure('a');
            cb.recordFailure('b');
            expect(cb.getStats().failureCount).toBe(2);
        });

        test('failureCount decrements on success but not below zero', () => {
            cb.recordFailure('err');
            cb.recordSuccess();
            expect(cb.getStats().failureCount).toBe(0);

            cb.recordSuccess();
            expect(cb.getStats().failureCount).toBe(0);
        });

        test('lastError reflects most recent error type', () => {
            cb.recordFailure('timeout');
            expect(cb.getStats().lastError).toBe('timeout');

            cb.recordFailure('rate_limit');
            expect(cb.getStats().lastError).toBe('rate_limit');
        });

        test('recentFailures only counts failures within window', () => {
            cb.recordFailure('err');
            cb.recordFailure('err');
            jest.advanceTimersByTime(11000);

            const stats = cb.getStats();
            expect(stats.recentFailures).toBe(0);
            // failureCount is cumulative, not windowed
            expect(stats.failureCount).toBe(2);
        });

        test('openedAt is null when CLOSED', () => {
            expect(cb.getStats().openedAt).toBeNull();
        });

        test('openedAt is an ISO string when OPEN', () => {
            cb.recordFailure('err');
            cb.recordFailure('err');
            cb.recordFailure('err');

            const stats = cb.getStats();
            expect(stats.openedAt).not.toBeNull();
            // Should be a valid ISO date string
            expect(() => new Date(stats.openedAt)).not.toThrow();
            expect(new Date(stats.openedAt).toISOString()).toBe(stats.openedAt);
        });

        test('cooldownRemaining is positive when OPEN', () => {
            cb.recordFailure('err');
            cb.recordFailure('err');
            cb.recordFailure('err');

            const stats = cb.getStats();
            expect(stats.cooldownRemaining).toBeGreaterThan(0);
            expect(stats.cooldownRemaining).toBeLessThanOrEqual(5000);
        });

        test('cooldownRemaining is 0 when not OPEN', () => {
            expect(cb.getStats().cooldownRemaining).toBe(0);

            cb.recordFailure('err');
            cb.recordFailure('err');
            cb.recordFailure('err');
            jest.advanceTimersByTime(5000);
            cb.updateState();
            // Now HALF_OPEN
            expect(cb.getStats().cooldownRemaining).toBe(0);
        });

        test('cooldownRemaining decreases over time', () => {
            cb.recordFailure('err');
            cb.recordFailure('err');
            cb.recordFailure('err');

            const before = cb.getCooldownRemaining();
            jest.advanceTimersByTime(2000);
            const after = cb.getCooldownRemaining();

            expect(after).toBeLessThan(before);
            expect(before - after).toBeCloseTo(2000, -2);
        });

        test('successCount increments correctly', () => {
            cb.recordSuccess();
            cb.recordSuccess();
            cb.recordSuccess();
            expect(cb.getStats().successCount).toBe(3);
        });
    });

    // ---------------------------------------------------------------
    // 7. Event emissions (onStateChange callback)
    // ---------------------------------------------------------------
    describe('event emissions via onStateChange', () => {
        let cb;
        let stateChanges;

        beforeEach(() => {
            jest.useFakeTimers();
            stateChanges = [];
            cb = new CircuitBreaker({
                failureThreshold: 3,
                failureWindow: 10000,
                cooldownPeriod: 5000,
                halfOpenTimeout: 3000,
                onStateChange: (from, to, info) => {
                    stateChanges.push({ from, to, info });
                }
            });
        });

        afterEach(() => {
            cb.destroy();
            jest.useRealTimers();
        });

        test('fires on CLOSED -> OPEN with failure count in info', () => {
            cb.recordFailure('err');
            cb.recordFailure('err');
            cb.recordFailure('err');

            expect(stateChanges).toHaveLength(1);
            expect(stateChanges[0].from).toBe(STATES.CLOSED);
            expect(stateChanges[0].to).toBe(STATES.OPEN);
            expect(stateChanges[0].info).toHaveProperty('failures');
            expect(stateChanges[0].info.failures).toBeGreaterThanOrEqual(3);
        });

        test('fires on OPEN -> HALF_OPEN with metadata', () => {
            cb.recordFailure('err');
            cb.recordFailure('err');
            cb.recordFailure('err');
            stateChanges = [];

            jest.advanceTimersByTime(5000);
            cb.updateState();

            expect(stateChanges).toHaveLength(1);
            expect(stateChanges[0].from).toBe(STATES.OPEN);
            expect(stateChanges[0].to).toBe(STATES.HALF_OPEN);
        });

        test('fires on HALF_OPEN -> CLOSED with reason test_succeeded', () => {
            cb.recordFailure('err');
            cb.recordFailure('err');
            cb.recordFailure('err');
            jest.advanceTimersByTime(5000);
            cb.updateState();
            stateChanges = [];

            cb.recordSuccess();

            expect(stateChanges).toHaveLength(1);
            expect(stateChanges[0].from).toBe(STATES.HALF_OPEN);
            expect(stateChanges[0].to).toBe(STATES.CLOSED);
            expect(stateChanges[0].info.reason).toBe('test_succeeded');
        });

        test('fires on HALF_OPEN -> OPEN with reason test_failed and errorType', () => {
            cb.recordFailure('err');
            cb.recordFailure('err');
            cb.recordFailure('err');
            jest.advanceTimersByTime(5000);
            cb.updateState();
            stateChanges = [];

            cb.recordFailure('rate_limit');

            expect(stateChanges).toHaveLength(1);
            expect(stateChanges[0].from).toBe(STATES.HALF_OPEN);
            expect(stateChanges[0].to).toBe(STATES.OPEN);
            expect(stateChanges[0].info.reason).toBe('test_failed');
            expect(stateChanges[0].info.errorType).toBe('rate_limit');
        });

        test('fires on HALF_OPEN timeout with reason half_open_timeout', () => {
            cb.recordFailure('err');
            cb.recordFailure('err');
            cb.recordFailure('err');
            jest.advanceTimersByTime(5000);
            cb.updateState();
            stateChanges = [];

            jest.advanceTimersByTime(3000);

            expect(stateChanges).toHaveLength(1);
            expect(stateChanges[0].from).toBe(STATES.HALF_OPEN);
            expect(stateChanges[0].to).toBe(STATES.OPEN);
            expect(stateChanges[0].info.reason).toBe('half_open_timeout');
        });

        test('fires on forceState with reason forced', () => {
            cb.forceState(STATES.OPEN);

            expect(stateChanges).toHaveLength(1);
            expect(stateChanges[0].info.reason).toBe('forced');
        });

        test('fires on reset with reason reset', () => {
            cb.forceState(STATES.OPEN);
            stateChanges = [];

            cb.reset();

            expect(stateChanges).toHaveLength(1);
            expect(stateChanges[0].from).toBe(STATES.OPEN);
            expect(stateChanges[0].to).toBe(STATES.CLOSED);
            expect(stateChanges[0].info.reason).toBe('reset');
        });

        test('does NOT fire when state does not change', () => {
            // Record success in CLOSED -- state stays CLOSED
            cb.recordSuccess();
            expect(stateChanges).toHaveLength(0);

            // Record failures below threshold -- state stays CLOSED
            cb.recordFailure('err');
            cb.recordFailure('err');
            expect(stateChanges).toHaveLength(0);
        });

        test('does NOT fire on forceState to same state', () => {
            cb.forceState(STATES.CLOSED); // already CLOSED
            expect(stateChanges).toHaveLength(0);
        });

        test('does NOT fire on reset when already CLOSED', () => {
            cb.reset();
            expect(stateChanges).toHaveLength(0);
        });

        test('default onStateChange is a no-op and does not throw', () => {
            const cbNoCallback = new CircuitBreaker({
                failureThreshold: 2,
                failureWindow: 10000,
                cooldownPeriod: 1000
            });

            expect(() => {
                cbNoCallback.recordFailure('err');
                cbNoCallback.recordFailure('err');
            }).not.toThrow();

            expect(cbNoCallback.state).toBe(STATES.OPEN);
            cbNoCallback.destroy();
        });

        test('callback receives sequential events through full lifecycle', () => {
            // Full lifecycle: CLOSED -> OPEN -> HALF_OPEN -> CLOSED
            cb.recordFailure('err');
            cb.recordFailure('err');
            cb.recordFailure('err');               // -> OPEN
            jest.advanceTimersByTime(5000);
            cb.updateState();                       // -> HALF_OPEN
            cb.recordSuccess();                     // -> CLOSED

            expect(stateChanges).toHaveLength(3);
            expect(stateChanges[0]).toMatchObject({ from: STATES.CLOSED, to: STATES.OPEN });
            expect(stateChanges[1]).toMatchObject({ from: STATES.OPEN, to: STATES.HALF_OPEN });
            expect(stateChanges[2]).toMatchObject({ from: STATES.HALF_OPEN, to: STATES.CLOSED });
        });
    });
});
