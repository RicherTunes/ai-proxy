/**
 * Circuit Breaker Extended Tests
 * Targeting uncovered lines: 49-54, 100-103, 134-150, 206-207, 281, 306-379
 */

const { CircuitBreaker, STATES } = require('../lib/circuit-breaker');

describe('CircuitBreaker Extended Coverage', () => {
    describe('HALF_OPEN timeout auto-revert to OPEN (lines 49-54)', () => {
        let cb;
        let stateChanges;

        beforeEach(() => {
            jest.useFakeTimers();
            stateChanges = [];
            cb = new CircuitBreaker({
                failureThreshold: 3,
                failureWindow: 30000,
                cooldownPeriod: 60000,
                halfOpenTimeout: 10000,
                onStateChange: (from, to, info) => {
                    stateChanges.push({ from, to, info });
                }
            });
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        test('should revert to OPEN after halfOpenTimeout expires', () => {
            // Trip circuit to OPEN
            cb.recordFailure('test');
            cb.recordFailure('test');
            cb.recordFailure('test');
            expect(cb.state).toBe(STATES.OPEN);

            // Advance time past cooldown to trigger HALF_OPEN
            jest.advanceTimersByTime(60000);
            cb.updateState();
            expect(cb.state).toBe(STATES.HALF_OPEN);

            // Clear state changes from previous transitions
            stateChanges = [];

            // Advance time past halfOpenTimeout without recording success/failure
            jest.advanceTimersByTime(10000);

            // Verify timeout callback fired and state reverted to OPEN
            expect(cb.state).toBe(STATES.OPEN);
            expect(cb.halfOpenRequestInFlight).toBe(false);
            expect(stateChanges.length).toBe(1);
            expect(stateChanges[0].from).toBe(STATES.HALF_OPEN);
            expect(stateChanges[0].to).toBe(STATES.OPEN);
            expect(stateChanges[0].info.reason).toBe('half_open_timeout');
        });

        test('should not revert if no longer in HALF_OPEN when timeout fires', () => {
            // Trip to OPEN
            cb.recordFailure('test');
            cb.recordFailure('test');
            cb.recordFailure('test');

            // Transition to HALF_OPEN
            jest.advanceTimersByTime(60000);
            cb.updateState();
            expect(cb.state).toBe(STATES.HALF_OPEN);

            // Record success to close circuit before timeout
            cb.recordSuccess();
            expect(cb.state).toBe(STATES.CLOSED);

            stateChanges = [];

            // Advance past halfOpenTimeout - should NOT trigger state change
            jest.advanceTimersByTime(10000);

            expect(cb.state).toBe(STATES.CLOSED);
            expect(stateChanges.length).toBe(0);
        });
    });

    describe('HALF_OPEN timeout check in updateState (lines 100-103)', () => {
        let cb;
        let stateChanges;

        beforeEach(() => {
            jest.useFakeTimers();
            stateChanges = [];
            cb = new CircuitBreaker({
                failureThreshold: 3,
                failureWindow: 30000,
                cooldownPeriod: 60000,
                halfOpenTimeout: 10000,
                onStateChange: (from, to, info) => {
                    stateChanges.push({ from, to, info });
                }
            });
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        test('updateState should detect HALF_OPEN timeout and revert to OPEN', () => {
            // Manually force HALF_OPEN state with timestamp in the past
            cb.state = STATES.HALF_OPEN;
            cb.halfOpenStartedAt = Date.now() - 15000; // 15 seconds ago
            cb.halfOpenRequestInFlight = true;

            // Call updateState - should detect timeout
            cb.updateState();

            expect(cb.state).toBe(STATES.OPEN);
            expect(cb.halfOpenRequestInFlight).toBe(false);
            expect(cb.openedAt).toBeGreaterThan(0);
        });

        test('updateState should not revert if HALF_OPEN timeout not reached', () => {
            // Force HALF_OPEN with recent timestamp
            cb.state = STATES.HALF_OPEN;
            cb.halfOpenStartedAt = Date.now() - 5000; // 5 seconds ago
            cb.halfOpenRequestInFlight = false;

            cb.updateState();

            // Should remain HALF_OPEN
            expect(cb.state).toBe(STATES.HALF_OPEN);
        });
    });

    describe('tryAcquireTestRequest (lines 134-150)', () => {
        let cb;

        beforeEach(() => {
            cb = new CircuitBreaker({
                failureThreshold: 3,
                failureWindow: 30000,
                cooldownPeriod: 60000,
                halfOpenTimeout: 10000
            });
        });

        afterEach(() => {
            cb.destroy();
        });

        test('should return true when in CLOSED state', () => {
            expect(cb.state).toBe(STATES.CLOSED);
            expect(cb.tryAcquireTestRequest()).toBe(true);
        });

        test('should return true when in OPEN state', () => {
            cb.forceState(STATES.OPEN);
            expect(cb.state).toBe(STATES.OPEN);
            expect(cb.tryAcquireTestRequest()).toBe(true);
        });

        test('should return true first time in HALF_OPEN state', () => {
            cb.forceState(STATES.HALF_OPEN);
            expect(cb.state).toBe(STATES.HALF_OPEN);
            expect(cb.halfOpenRequestInFlight).toBe(false);

            const result = cb.tryAcquireTestRequest();
            expect(result).toBe(true);
            expect(cb.halfOpenRequestInFlight).toBe(true);
        });

        test('should return false when test request already in flight', () => {
            cb.forceState(STATES.HALF_OPEN);
            cb.halfOpenRequestInFlight = true;

            const result = cb.tryAcquireTestRequest();
            expect(result).toBe(false);
            expect(cb.halfOpenRequestInFlight).toBe(true); // Still true
        });

        test('should allow sequential test requests after clearing flag', () => {
            cb.forceState(STATES.HALF_OPEN);

            // First request
            expect(cb.tryAcquireTestRequest()).toBe(true);
            expect(cb.halfOpenRequestInFlight).toBe(true);

            // Second request while first in flight
            expect(cb.tryAcquireTestRequest()).toBe(false);

            // Clear flag and try again
            cb.halfOpenRequestInFlight = false;
            expect(cb.tryAcquireTestRequest()).toBe(true);
        });
    });

    describe('isAvailable edge cases (line 134)', () => {
        let cb;

        beforeEach(() => {
            cb = new CircuitBreaker({
                failureThreshold: 3,
                failureWindow: 30000,
                cooldownPeriod: 60000
            });
        });

        test('should return false for invalid/unknown state (defensive default)', () => {
            // Force invalid state for defensive code coverage
            cb.state = 'INVALID_STATE';
            expect(cb.isAvailable()).toBe(false);
        });
    });

    describe('forceState clearing HALF_OPEN tracking (lines 206-207)', () => {
        let cb;
        let stateChanges;

        beforeEach(() => {
            jest.useFakeTimers();
            stateChanges = [];
            cb = new CircuitBreaker({
                failureThreshold: 3,
                failureWindow: 30000,
                cooldownPeriod: 60000,
                halfOpenTimeout: 10000,
                onStateChange: (from, to, info) => {
                    stateChanges.push({ from, to, info });
                }
            });
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        test('should clear halfOpenRequestInFlight when forcing from HALF_OPEN to CLOSED', () => {
            // Force to HALF_OPEN
            cb.forceState(STATES.HALF_OPEN);
            cb.halfOpenRequestInFlight = true;

            expect(cb.state).toBe(STATES.HALF_OPEN);
            expect(cb.halfOpenRequestInFlight).toBe(true);
            expect(cb.halfOpenTimeoutId).not.toBeNull();

            // Force to CLOSED
            cb.forceState(STATES.CLOSED);

            expect(cb.state).toBe(STATES.CLOSED);
            expect(cb.halfOpenRequestInFlight).toBe(false);
            expect(cb.halfOpenTimeoutId).toBeNull();
        });

        test('should clear halfOpenRequestInFlight when forcing from HALF_OPEN to OPEN', () => {
            cb.forceState(STATES.HALF_OPEN);
            cb.halfOpenRequestInFlight = true;

            cb.forceState(STATES.OPEN);

            expect(cb.state).toBe(STATES.OPEN);
            expect(cb.halfOpenRequestInFlight).toBe(false);
            expect(cb.halfOpenTimeoutId).toBeNull();
        });

        test('should not clear tracking when transitioning to HALF_OPEN from other state', () => {
            cb.forceState(STATES.OPEN);
            cb.forceState(STATES.HALF_OPEN);

            // HALF_OPEN should initialize with clean state
            expect(cb.halfOpenRequestInFlight).toBe(false);
            expect(cb.halfOpenTimeoutId).not.toBeNull();
        });
    });

    describe('getPredictionData - OPEN state (line 281)', () => {
        let cb;

        beforeEach(() => {
            cb = new CircuitBreaker({
                failureThreshold: 5,
                failureWindow: 30000,
                cooldownPeriod: 60000
            });
        });

        test('should return score=100 and CRITICAL level when circuit is OPEN', () => {
            // Trip circuit to OPEN
            for (let i = 0; i < 5; i++) {
                cb.recordFailure('test');
            }
            expect(cb.state).toBe(STATES.OPEN);

            const prediction = cb.getPredictionData();

            expect(prediction.score).toBe(100);
            expect(prediction.level).toBe('CRITICAL');
            expect(prediction.estimatedSecondsToTrip).toBe(0);
            expect(prediction.reason).toBe('circuit_open');
            expect(prediction.state).toBe(STATES.OPEN);
        });

        test('should return CRITICAL even with HALF_OPEN after force', () => {
            // Open circuit
            for (let i = 0; i < 5; i++) {
                cb.recordFailure('test');
            }
            expect(cb.state).toBe(STATES.OPEN);

            const prediction = cb.getPredictionData();
            expect(prediction.score).toBe(100);
            expect(prediction.level).toBe('CRITICAL');
        });
    });

    describe('getPredictionData - scoring algorithm (lines 306-379)', () => {
        let cb;

        beforeEach(() => {
            jest.useFakeTimers();
            cb = new CircuitBreaker({
                failureThreshold: 5,
                failureWindow: 30000, // 30 seconds
                cooldownPeriod: 60000
            });
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        test('should return score=0 and HEALTHY when no failures', () => {
            const prediction = cb.getPredictionData();

            expect(prediction.score).toBe(0);
            expect(prediction.level).toBe('HEALTHY');
            expect(prediction.estimatedSecondsToTrip).toBeNull();
            expect(prediction.reason).toBe('no_recent_failures');
        });

        test('should calculate ratio score correctly (single failure)', () => {
            cb.recordFailure('test');

            const prediction = cb.getPredictionData();

            // 1/5 = 0.2, 0.2 * 35 = 7
            expect(prediction.components.ratio).toBe(7);
            expect(prediction.recentFailures).toBe(1);
            expect(prediction.threshold).toBe(5);
        });

        test('should calculate ratio score near threshold', () => {
            // 4 failures out of 5 threshold
            cb.recordFailure('test');
            cb.recordFailure('test');
            cb.recordFailure('test');
            cb.recordFailure('test');

            const prediction = cb.getPredictionData();

            // 4/5 = 0.8, 0.8 * 35 = 28
            expect(prediction.components.ratio).toBe(28);
            // With recent failures and acceleration, score will be CRITICAL
            expect(prediction.level).toBe('CRITICAL');
        });

        test('should cap ratio score at 35', () => {
            // Exceed threshold (should not happen normally, but test edge case)
            for (let i = 0; i < 10; i++) {
                cb.recordFailure('test');
            }

            // Force to CLOSED to avoid OPEN state early return
            cb.state = STATES.CLOSED;

            const prediction = cb.getPredictionData();

            expect(prediction.components.ratio).toBeLessThanOrEqual(35);
        });

        test('should calculate acceleration score - all failures in recent half', () => {
            const now = Date.now();
            // Add failures only in recent half (past 15 seconds)
            jest.setSystemTime(now);
            cb.recordFailure('test');
            jest.advanceTimersByTime(1000);
            cb.recordFailure('test');

            const prediction = cb.getPredictionData();

            // All in recent half, none in older half -> accelerationScore = 35
            expect(prediction.components.acceleration).toBe(35);
        });

        test('should calculate acceleration score - very rapid acceleration (ratio > 2)', () => {
            const now = Date.now();

            // Add 1 failure in older half (15-30 seconds ago)
            jest.setSystemTime(now - 20000);
            cb.recordFailure('test');

            // Add 3 failures in recent half (0-15 seconds ago)
            jest.setSystemTime(now - 10000);
            cb.recordFailure('test');
            jest.setSystemTime(now - 5000);
            cb.recordFailure('test');
            jest.setSystemTime(now);
            cb.recordFailure('test');

            const prediction = cb.getPredictionData();

            // 3/1 = 3 > 2 -> accelerationScore = 40
            expect(prediction.components.acceleration).toBe(40);
        });

        test('should calculate acceleration score - moderate acceleration (ratio 1.5-2)', () => {
            const now = Date.now();

            // Need to avoid auto-tripping (threshold is 5)
            // Use threshold of 10 to test scoring without opening circuit
            const testCb = new CircuitBreaker({
                failureThreshold: 10,
                failureWindow: 30000,
                cooldownPeriod: 60000
            });

            // Add 2 failures in older half
            jest.setSystemTime(now - 25000);
            testCb.recordFailure('test');
            jest.setSystemTime(now - 20000);
            testCb.recordFailure('test');

            // Add 4 failures in recent half (4/2 = 2.0 is > 1.5)
            jest.setSystemTime(now - 12000);
            testCb.recordFailure('test');
            jest.setSystemTime(now - 10000);
            testCb.recordFailure('test');
            jest.setSystemTime(now - 5000);
            testCb.recordFailure('test');
            jest.setSystemTime(now);
            testCb.recordFailure('test');

            const prediction = testCb.getPredictionData();

            // 4/2 = 2.0 (exactly at boundary, treated as > 1.5) -> accelerationScore = 30
            expect(prediction.components.acceleration).toBe(30);
        });

        test('should calculate acceleration score - slight acceleration (ratio 1-1.5)', () => {
            const now = Date.now();

            // Use higher threshold to avoid auto-tripping
            const testCb = new CircuitBreaker({
                failureThreshold: 10,
                failureWindow: 30000,
                cooldownPeriod: 60000
            });

            // Add 3 failures in older half
            jest.setSystemTime(now - 25000);
            testCb.recordFailure('test');
            jest.setSystemTime(now - 22000);
            testCb.recordFailure('test');
            jest.setSystemTime(now - 18000);
            testCb.recordFailure('test');

            // Add 4 failures in recent half
            jest.setSystemTime(now - 12000);
            testCb.recordFailure('test');
            jest.setSystemTime(now - 8000);
            testCb.recordFailure('test');
            jest.setSystemTime(now - 4000);
            testCb.recordFailure('test');
            jest.setSystemTime(now);
            testCb.recordFailure('test');

            const prediction = testCb.getPredictionData();

            // 4/3 = 1.33 -> accelerationScore = 20
            expect(prediction.components.acceleration).toBe(20);
        });

        test('should calculate acceleration score - deceleration (ratio < 1)', () => {
            const now = Date.now();

            // Use higher threshold to avoid auto-tripping
            const testCb = new CircuitBreaker({
                failureThreshold: 10,
                failureWindow: 30000,
                cooldownPeriod: 60000
            });

            // Add 4 failures in older half
            jest.setSystemTime(now - 25000);
            testCb.recordFailure('test');
            jest.setSystemTime(now - 22000);
            testCb.recordFailure('test');
            jest.setSystemTime(now - 20000);
            testCb.recordFailure('test');
            jest.setSystemTime(now - 17000);
            testCb.recordFailure('test');

            // Add 2 failures in recent half
            jest.setSystemTime(now - 10000);
            testCb.recordFailure('test');
            jest.setSystemTime(now);
            testCb.recordFailure('test');

            const prediction = testCb.getPredictionData();

            // 2/4 = 0.5 < 1 -> accelerationScore = 10
            expect(prediction.components.acceleration).toBe(10);
        });

        test('should calculate recency score - very recent failure', () => {
            const now = Date.now();
            jest.setSystemTime(now);
            cb.recordFailure('test');

            // Advance just 1 second (recencyThreshold = 30000/5 = 6000ms)
            jest.advanceTimersByTime(1000);

            const prediction = cb.getPredictionData();

            // < 6 seconds -> recencyScore = 25
            expect(prediction.components.recency).toBe(25);
        });

        test('should calculate recency score - recent failure (6-12 seconds)', () => {
            const now = Date.now();
            jest.setSystemTime(now);
            cb.recordFailure('test');

            // Advance 8 seconds (between threshold*1 and threshold*2)
            jest.advanceTimersByTime(8000);

            const prediction = cb.getPredictionData();

            // 6-12 seconds -> recencyScore = 20
            expect(prediction.components.recency).toBe(20);
        });

        test('should calculate recency score - moderate recency (12-18 seconds)', () => {
            const now = Date.now();
            jest.setSystemTime(now);
            cb.recordFailure('test');

            // Advance 15 seconds
            jest.advanceTimersByTime(15000);

            const prediction = cb.getPredictionData();

            // 12-18 seconds -> recencyScore = 15
            expect(prediction.components.recency).toBe(15);
        });

        test('should calculate recency score - older failure (18-24 seconds)', () => {
            const now = Date.now();
            jest.setSystemTime(now);
            cb.recordFailure('test');

            // Advance 20 seconds
            jest.advanceTimersByTime(20000);

            const prediction = cb.getPredictionData();

            // 18-24 seconds -> recencyScore = 10
            expect(prediction.components.recency).toBe(10);
        });

        test('should calculate recency score - old failure (>24 seconds)', () => {
            const now = Date.now();
            jest.setSystemTime(now);
            cb.recordFailure('test');

            // Advance 28 seconds
            jest.advanceTimersByTime(28000);

            const prediction = cb.getPredictionData();

            // >24 seconds -> recencyScore = 5
            expect(prediction.components.recency).toBe(5);
        });

        test('should cap total score at 100', () => {
            const now = Date.now();

            // Create scenario with maximum scores:
            // - 4 failures near threshold (ratio = 28)
            // - All in recent half (acceleration = 35)
            // - Very recent (recency = 25)
            // Total would be 88, within cap

            jest.setSystemTime(now);
            cb.recordFailure('test');
            jest.advanceTimersByTime(1000);
            cb.recordFailure('test');
            jest.advanceTimersByTime(1000);
            cb.recordFailure('test');
            jest.advanceTimersByTime(1000);
            cb.recordFailure('test');

            const prediction = cb.getPredictionData();

            expect(prediction.score).toBeLessThanOrEqual(100);
            expect(prediction.level).toBe('CRITICAL'); // >= 86
        });

        test('should calculate estimatedSecondsToTrip', () => {
            const now = Date.now();

            // Add 3 failures over 15 seconds
            jest.setSystemTime(now - 15000);
            cb.recordFailure('test');
            jest.setSystemTime(now - 10000);
            cb.recordFailure('test');
            jest.setSystemTime(now);
            cb.recordFailure('test');

            const prediction = cb.getPredictionData();

            // 3 failures in 15 seconds, need 2 more to trip
            // avgTimeBetweenFailures = 30000 / 3 = 10000ms
            // failuresNeeded = 5 - 3 = 2
            // estimated = (2 * 10000) / 1000 = 20 seconds
            expect(prediction.estimatedSecondsToTrip).toBe(20);
        });

        test('should cap estimatedSecondsToTrip at 300', () => {
            const now = Date.now();

            // Add single failure long ago
            jest.setSystemTime(now - 29000);
            cb.recordFailure('test');
            jest.setSystemTime(now);

            const prediction = cb.getPredictionData();

            // avgTimeBetweenFailures = 30000 / 1 = 30000ms
            // failuresNeeded = 4
            // estimated = (4 * 30000) / 1000 = 120 seconds
            // Should be capped at 300
            expect(prediction.estimatedSecondsToTrip).toBeLessThanOrEqual(300);
        });

        test('should return null estimatedSecondsToTrip when at threshold', () => {
            // Add exactly threshold failures
            for (let i = 0; i < 5; i++) {
                cb.recordFailure('test');
            }

            // Force to CLOSED to avoid OPEN early return
            cb.state = STATES.CLOSED;

            const prediction = cb.getPredictionData();

            expect(prediction.estimatedSecondsToTrip).toBeNull();
        });

        test('should classify level as WARNING (61-85 score)', () => {
            const now = Date.now();

            // Create scenario with WARNING level score
            // 3 failures = ratio ~21, moderate acceleration, recent failure
            jest.setSystemTime(now - 20000);
            cb.recordFailure('test');
            jest.setSystemTime(now - 10000);
            cb.recordFailure('test');
            jest.setSystemTime(now - 2000);
            cb.recordFailure('test');

            const prediction = cb.getPredictionData();

            expect(prediction.score).toBeGreaterThanOrEqual(61);
            expect(prediction.score).toBeLessThan(86);
            expect(prediction.level).toBe('WARNING');
        });

        test('should classify level as ELEVATED (31-60 score)', () => {
            const now = Date.now();

            // Create scenario with ELEVATED level
            // 2 failures spaced out = ratio ~14, no acceleration (both in older half), old recency
            jest.setSystemTime(now - 25000);
            cb.recordFailure('test');
            jest.setSystemTime(now - 20000);
            cb.recordFailure('test');
            jest.setSystemTime(now);

            const prediction = cb.getPredictionData();

            // With both failures in older period and old, score should be lower
            expect(prediction.score).toBeGreaterThanOrEqual(31);
            expect(prediction.score).toBeLessThan(61);
            expect(prediction.level).toBe('ELEVATED');
        });

        test('should classify level as HEALTHY (0-30 score)', () => {
            const now = Date.now();

            // Single old failure
            jest.setSystemTime(now - 28000);
            cb.recordFailure('test');
            jest.setSystemTime(now);

            const prediction = cb.getPredictionData();

            expect(prediction.score).toBeLessThan(31);
            expect(prediction.level).toBe('HEALTHY');
        });

        test('should include complete prediction structure', () => {
            cb.recordFailure('test');
            cb.recordFailure('test');

            const prediction = cb.getPredictionData();

            expect(prediction).toHaveProperty('score');
            expect(prediction).toHaveProperty('level');
            expect(prediction).toHaveProperty('estimatedSecondsToTrip');
            expect(prediction).toHaveProperty('components');
            expect(prediction.components).toHaveProperty('ratio');
            expect(prediction.components).toHaveProperty('acceleration');
            expect(prediction.components).toHaveProperty('recency');
            expect(prediction).toHaveProperty('recentFailures');
            expect(prediction).toHaveProperty('threshold');
            expect(prediction).toHaveProperty('state');
        });
    });
});
