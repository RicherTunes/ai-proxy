/**
 * Circuit Breaker Module Tests
 */

const { CircuitBreaker, STATES } = require('../lib/circuit-breaker');

describe('CircuitBreaker', () => {
    let cb;
    let stateChanges;

    beforeEach(() => {
        stateChanges = [];
        cb = new CircuitBreaker({
            failureThreshold: 3,
            failureWindow: 1000,   // 1 second
            cooldownPeriod: 500,   // 0.5 seconds
            onStateChange: (from, to, info) => {
                stateChanges.push({ from, to, info });
            }
        });
    });

    afterEach(() => {
        cb.destroy();
    });

    describe('initial state', () => {
        test('should start in CLOSED state', () => {
            expect(cb.state).toBe(STATES.CLOSED);
        });

        test('should be available initially', () => {
            expect(cb.isAvailable()).toBe(true);
        });

        test('should have zero counts initially', () => {
            const stats = cb.getStats();
            expect(stats.successCount).toBe(0);
            expect(stats.failureCount).toBe(0);
            expect(stats.recentFailures).toBe(0);
        });
    });

    describe('CLOSED -> OPEN transition', () => {
        test('should open after reaching failure threshold', () => {
            cb.recordFailure('test');
            cb.recordFailure('test');
            expect(cb.state).toBe(STATES.CLOSED);

            cb.recordFailure('test');
            expect(cb.state).toBe(STATES.OPEN);
        });

        test('should trigger state change callback', () => {
            cb.recordFailure('test');
            cb.recordFailure('test');
            cb.recordFailure('test');

            expect(stateChanges.length).toBe(1);
            expect(stateChanges[0].from).toBe(STATES.CLOSED);
            expect(stateChanges[0].to).toBe(STATES.OPEN);
        });

        test('should not be available when OPEN', () => {
            cb.recordFailure('test');
            cb.recordFailure('test');
            cb.recordFailure('test');

            expect(cb.isAvailable()).toBe(false);
        });

        test('should track last error', () => {
            cb.recordFailure('timeout');
            expect(cb.getStats().lastError).toBe('timeout');
        });
    });

    describe('failure window', () => {
        test('should not open if failures are outside window', async () => {
            cb.recordFailure('test');
            cb.recordFailure('test');

            // Wait for failures to expire
            await new Promise(resolve => setTimeout(resolve, 1100));

            cb.recordFailure('test');
            expect(cb.state).toBe(STATES.CLOSED);
        });

        test('should clean up old failures on update', async () => {
            cb.recordFailure('test');
            cb.recordFailure('test');

            await new Promise(resolve => setTimeout(resolve, 1100));

            cb.updateState();
            expect(cb.getStats().recentFailures).toBe(0);
        });
    });

    describe('OPEN -> HALF_OPEN transition', () => {
        beforeEach(() => {
            // Open the circuit
            cb.recordFailure('test');
            cb.recordFailure('test');
            cb.recordFailure('test');
        });

        test('should transition to HALF_OPEN after cooldown', async () => {
            expect(cb.state).toBe(STATES.OPEN);

            await new Promise(resolve => setTimeout(resolve, 600));

            cb.updateState();
            expect(cb.state).toBe(STATES.HALF_OPEN);
        });

        test('should be available in HALF_OPEN state', async () => {
            await new Promise(resolve => setTimeout(resolve, 600));
            expect(cb.isAvailable()).toBe(true);
        });

        test('should report cooldown remaining', () => {
            const remaining = cb.getCooldownRemaining();
            expect(remaining).toBeGreaterThan(0);
            expect(remaining).toBeLessThanOrEqual(500);
        });
    });

    describe('HALF_OPEN -> CLOSED transition', () => {
        beforeEach(async () => {
            cb.recordFailure('test');
            cb.recordFailure('test');
            cb.recordFailure('test');
            await new Promise(resolve => setTimeout(resolve, 600));
            cb.updateState(); // Transition to HALF_OPEN
        });

        test('should close on success', () => {
            expect(cb.state).toBe(STATES.HALF_OPEN);
            cb.recordSuccess();
            expect(cb.state).toBe(STATES.CLOSED);
        });

        test('should clear failure window on close', () => {
            cb.recordSuccess();
            expect(cb.getStats().recentFailures).toBe(0);
        });

        test('should trigger state change callback', () => {
            stateChanges = [];
            cb.recordSuccess();
            expect(stateChanges.length).toBe(1);
            expect(stateChanges[0].to).toBe(STATES.CLOSED);
        });
    });

    describe('HALF_OPEN -> OPEN transition', () => {
        beforeEach(async () => {
            cb.recordFailure('test');
            cb.recordFailure('test');
            cb.recordFailure('test');
            await new Promise(resolve => setTimeout(resolve, 600));
            cb.updateState();
        });

        test('should reopen on failure', () => {
            expect(cb.state).toBe(STATES.HALF_OPEN);
            cb.recordFailure('test');
            expect(cb.state).toBe(STATES.OPEN);
        });

        test('should reset openedAt timestamp', () => {
            const firstOpenedAt = cb.openedAt;
            cb.recordFailure('test');
            expect(cb.openedAt).toBeGreaterThanOrEqual(firstOpenedAt);
        });
    });

    describe('recordSuccess', () => {
        test('should increment success count', () => {
            cb.recordSuccess();
            cb.recordSuccess();
            expect(cb.getStats().successCount).toBe(2);
        });

        test('should decrement failure count', () => {
            cb.recordFailure('test');
            cb.recordFailure('test');
            expect(cb.failureCount).toBe(2);

            cb.recordSuccess();
            expect(cb.failureCount).toBe(1);
        });

        test('should not go below zero failures', () => {
            cb.recordSuccess();
            cb.recordSuccess();
            expect(cb.failureCount).toBe(0);
        });
    });

    describe('forceState', () => {
        test('should force circuit to OPEN', () => {
            cb.forceState(STATES.OPEN);
            expect(cb.state).toBe(STATES.OPEN);
            expect(cb.openedAt).toBeGreaterThan(0);
        });

        test('should force circuit to CLOSED and clear failures', () => {
            cb.recordFailure('test');
            cb.recordFailure('test');
            cb.forceState(STATES.CLOSED);
            expect(cb.state).toBe(STATES.CLOSED);
            expect(cb.getStats().recentFailures).toBe(0);
        });

        test('should force circuit to HALF_OPEN', () => {
            cb.forceState(STATES.HALF_OPEN);
            expect(cb.state).toBe(STATES.HALF_OPEN);
        });

        test('should trigger state change callback', () => {
            cb.forceState(STATES.OPEN);
            expect(stateChanges.length).toBe(1);
            expect(stateChanges[0].info.reason).toBe('forced');
        });

        test('should ignore invalid states', () => {
            cb.forceState('INVALID');
            expect(cb.state).toBe(STATES.CLOSED);
        });
    });

    describe('reset', () => {
        test('should reset all state', () => {
            cb.recordFailure('test');
            cb.recordFailure('test');
            cb.recordSuccess();

            cb.reset();

            const stats = cb.getStats();
            expect(stats.state).toBe(STATES.CLOSED);
            expect(stats.successCount).toBe(0);
            expect(stats.failureCount).toBe(0);
            expect(stats.recentFailures).toBe(0);
            expect(stats.lastError).toBeNull();
        });

        test('should trigger state change if not already CLOSED', () => {
            cb.forceState(STATES.OPEN);
            stateChanges = [];

            cb.reset();

            expect(stateChanges.length).toBe(1);
            expect(stateChanges[0].to).toBe(STATES.CLOSED);
            expect(stateChanges[0].info.reason).toBe('reset');
        });
    });

    describe('getStats', () => {
        test('should return comprehensive stats', () => {
            cb.recordSuccess();
            cb.recordFailure('timeout');

            const stats = cb.getStats();

            expect(stats).toHaveProperty('state');
            expect(stats).toHaveProperty('successCount');
            expect(stats).toHaveProperty('failureCount');
            expect(stats).toHaveProperty('recentFailures');
            expect(stats).toHaveProperty('lastError');
            expect(stats).toHaveProperty('openedAt');
            expect(stats).toHaveProperty('cooldownRemaining');
        });

        test('should include openedAt when OPEN', () => {
            cb.recordFailure('test');
            cb.recordFailure('test');
            cb.recordFailure('test');

            const stats = cb.getStats();
            expect(stats.openedAt).not.toBeNull();
        });
    });
});

describe('STATES constant', () => {
    test('should have all expected states', () => {
        expect(STATES.CLOSED).toBe('CLOSED');
        expect(STATES.OPEN).toBe('OPEN');
        expect(STATES.HALF_OPEN).toBe('HALF_OPEN');
    });
});
