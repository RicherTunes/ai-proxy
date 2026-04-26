'use strict';

const { DriftDetector, DRIFT_REASON_ENUM } = require('../lib/drift-detector');

describe('DriftDetector edge cases', () => {
    let detector;
    let mockCounter;
    let mockRouter;
    let mockKeyManager;

    beforeEach(() => {
        mockCounter = { inc: jest.fn() };

        detector = new DriftDetector({
            metricsRegistry: { createCounter: () => mockCounter }
        });

        mockRouter = {
            getPoolSnapshot: () => ({
                version: '1.0',
                timestamp: Date.now(),
                models: []
            })
        };

        mockKeyManager = {
            getKeySnapshot: () => ({
                state: 'available',
                inFlight: 0,
                excludedReason: null
            }),
            getAllKeySnapshots: () => []
        };

        detector.setRouter(mockRouter);
        detector.setKeyManager(mockKeyManager);
    });

    // ---------------------------------------------------------------
    // 8. _driftEvents eviction at 1000
    // ---------------------------------------------------------------
    describe('_driftEvents eviction at 1000', () => {
        it('should trim to 500 when exceeding 1000 events', () => {
            // Set up to always produce a drift (router_available_km_excluded)
            mockKeyManager.getKeySnapshot = () => ({
                state: 'excluded',
                excludedReason: 'test'
            });

            const routerState = {
                tier: 'medium',
                isAvailable: true,
                inFlight: 0
            };

            // Push 1500 drift events
            for (let i = 0; i < 1500; i++) {
                detector.validateRoutingDecision(routerState, 0);
            }

            const events = detector.getDriftEvents();

            // After exceeding 1000, it slices to last 500.
            // But events keep being added after the trim, so the final
            // count depends on when the trim triggers.
            // The code trims when length > 1000 to last 500.
            // After 1001 events → trim to 500. Then 1002..1500 adds 499 more → 999.
            // So final length should be <= 1000.
            expect(events.length).toBeLessThanOrEqual(1000);
            expect(events.length).toBeGreaterThan(0);
        });

        it('oldest events should be removed after eviction', () => {
            mockKeyManager.getKeySnapshot = () => ({
                state: 'excluded',
                excludedReason: 'test'
            });

            // Directly populate _driftEvents with 1000 entries
            // to control timestamps precisely
            detector._driftEvents = [];
            for (let i = 0; i < 1000; i++) {
                detector._driftEvents.push({
                    tier: 'medium',
                    reason: 'router_available_km_excluded',
                    timestamp: 1000 + i  // timestamps 1000..1999
                });
            }

            // Push one more via the real path to trigger eviction
            const routerState = {
                tier: 'light',
                isAvailable: true,
                inFlight: 0
            };
            detector.validateRoutingDecision(routerState, 0);

            const events = detector.getDriftEvents();

            // _recordDrift pushes first (1001 items), then slice(-500) trims to 500.
            expect(events.length).toBe(500);

            // The slice(-500) keeps indices 501..1000 of the 1001-element array.
            // Index 501 corresponds to original item at position 501 (0-based),
            // which had timestamp 1000 + 501 = 1501.
            expect(events[0].timestamp).toBe(1501);

            // The last item is the newly pushed drift event (light tier)
            expect(events[events.length - 1].tier).toBe('light');
        });
    });

    // ---------------------------------------------------------------
    // 9. validatePoolState with empty snapshot
    // ---------------------------------------------------------------
    describe('validatePoolState with empty snapshot', () => {
        it('should not crash when getPoolSnapshot returns empty models', () => {
            mockRouter.getPoolSnapshot = () => ({
                version: '1.0',
                timestamp: Date.now(),
                models: []
            });

            mockKeyManager.getAllKeySnapshots = () => [];

            expect(() => {
                const summary = detector.validatePoolState();
                expect(summary.total).toBe(0);
            }).not.toThrow();
        });

        it('should not crash when getAllKeySnapshots returns empty array', () => {
            mockRouter.getPoolSnapshot = () => ({
                version: '1.0',
                timestamp: Date.now(),
                models: [
                    { modelId: 'glm-4', tier: 'medium', isAvailable: true, inFlight: 0 }
                ]
            });

            mockKeyManager.getAllKeySnapshots = () => [];

            expect(() => {
                const summary = detector.validatePoolState();
                // getAllKeySnapshots()[0] is undefined → continue skips it
                expect(summary.total).toBe(0);
            }).not.toThrow();
        });
    });

    // ---------------------------------------------------------------
    // 10. Drift detection sensitivity — small drifts below threshold
    // ---------------------------------------------------------------
    describe('drift detection sensitivity', () => {
        it('should not flag concurrency mismatch within threshold (diff <= 5)', () => {
            const routerState = {
                tier: 'medium',
                isAvailable: true,
                inFlight: 10
            };

            mockKeyManager.getKeySnapshot = () => ({
                state: 'available',
                inFlight: 7  // diff = 3, below threshold of 5
            });

            const drifts = detector.validateRoutingDecision(routerState, 0);
            expect(drifts).toHaveLength(0);
        });

        it('should not flag concurrency mismatch at exact threshold (diff = 5)', () => {
            const routerState = {
                tier: 'medium',
                isAvailable: true,
                inFlight: 10
            };

            mockKeyManager.getKeySnapshot = () => ({
                state: 'available',
                inFlight: 5  // diff = 5, at threshold (condition is diff > 5)
            });

            const drifts = detector.validateRoutingDecision(routerState, 0);
            expect(drifts).toHaveLength(0);
        });

        it('should not flag when both sides agree on state', () => {
            const routerState = {
                tier: 'medium',
                isAvailable: true,
                inFlight: 3
            };

            mockKeyManager.getKeySnapshot = () => ({
                state: 'available',
                inFlight: 3
            });

            const drifts = detector.validateRoutingDecision(routerState, 0);
            expect(drifts).toHaveLength(0);
        });
    });

    // ---------------------------------------------------------------
    // 11. Drift detection above threshold
    // ---------------------------------------------------------------
    describe('drift detection above threshold', () => {
        it('should flag concurrency mismatch when diff > 5', () => {
            const routerState = {
                tier: 'heavy',
                isAvailable: true,
                inFlight: 20
            };

            mockKeyManager.getKeySnapshot = () => ({
                state: 'available',
                inFlight: 5  // diff = 15
            });

            const drifts = detector.validateRoutingDecision(routerState, 0);
            expect(drifts).toHaveLength(1);
            expect(drifts[0].reason).toBe('concurrency_mismatch');
            expect(drifts[0].diff).toBe(15);
            expect(drifts[0].routerInFlight).toBe(20);
            expect(drifts[0].keyInFlight).toBe(5);
        });

        it('should flag router_available_km_excluded with details', () => {
            const routerState = {
                tier: 'light',
                isAvailable: true,
                inFlight: 1
            };

            mockKeyManager.getKeySnapshot = () => ({
                state: 'excluded',
                excludedReason: 'circuit_breaker'
            });

            const drifts = detector.validateRoutingDecision(routerState, 0);
            expect(drifts).toHaveLength(1);
            expect(drifts[0].reason).toBe('router_available_km_excluded');
            expect(drifts[0].routerState.isAvailable).toBe(true);
            expect(drifts[0].keyState.state).toBe('excluded');
            expect(drifts[0].keyState.excludedReason).toBe('circuit_breaker');
        });

        it('should flag km_available_router_cooled with expired cooldown', () => {
            const routerState = {
                tier: 'medium',
                isAvailable: false,
                inFlight: 0,
                cooldownUntil: Date.now() - 5000  // expired 5s ago
            };

            mockKeyManager.getKeySnapshot = () => ({
                state: 'available',
                inFlight: 0
            });

            const drifts = detector.validateRoutingDecision(routerState, 0);
            expect(drifts).toHaveLength(1);
            expect(drifts[0].reason).toBe('km_available_router_cooled');
        });
    });

    // ---------------------------------------------------------------
    // 12. Multiple simultaneous drifts
    // ---------------------------------------------------------------
    describe('multiple simultaneous drifts', () => {
        it('should detect both router_available_km_excluded AND concurrency_mismatch', () => {
            const routerState = {
                tier: 'heavy',
                isAvailable: true,
                inFlight: 50
            };

            mockKeyManager.getKeySnapshot = () => ({
                state: 'excluded',
                excludedReason: 'rate_limit',
                inFlight: 2  // diff = 48
            });

            const drifts = detector.validateRoutingDecision(routerState, 0);

            const reasons = drifts.map(d => d.reason);
            expect(reasons).toContain('router_available_km_excluded');
            expect(reasons).toContain('concurrency_mismatch');
            expect(drifts.length).toBe(2);
        });

        it('should track different drift types independently in events', () => {
            // Generate router_available_km_excluded drift
            mockKeyManager.getKeySnapshot = () => ({
                state: 'excluded',
                excludedReason: 'manual'
            });

            detector.validateRoutingDecision(
                { tier: 'medium', isAvailable: true, inFlight: 0 }, 0
            );

            // Generate km_available_router_cooled drift
            mockKeyManager.getKeySnapshot = () => ({
                state: 'available',
                inFlight: 0
            });

            detector.validateRoutingDecision(
                { tier: 'light', isAvailable: false, inFlight: 0, cooldownUntil: Date.now() - 1000 }, 0
            );

            const events = detector.getDriftEvents();
            const reasons = events.map(e => e.reason);
            expect(reasons).toContain('router_available_km_excluded');
            expect(reasons).toContain('km_available_router_cooled');
            expect(events).toHaveLength(2);
        });
    });

    // ---------------------------------------------------------------
    // 13. Drift reset — clearDriftEvents clears state
    // ---------------------------------------------------------------
    describe('drift reset', () => {
        it('should clear all drift state via clearDriftEvents', () => {
            // Generate some drifts
            mockKeyManager.getKeySnapshot = () => ({
                state: 'excluded',
                excludedReason: 'test'
            });

            for (let i = 0; i < 10; i++) {
                detector.validateRoutingDecision(
                    { tier: 'medium', isAvailable: true, inFlight: 0 }, 0
                );
            }

            expect(detector.getDriftEvents().length).toBe(10);

            // Clear
            detector.clearDriftEvents();

            expect(detector.getDriftEvents()).toHaveLength(0);
        });

        it('should allow new drifts after reset', () => {
            mockKeyManager.getKeySnapshot = () => ({
                state: 'excluded',
                excludedReason: 'test'
            });

            detector.validateRoutingDecision(
                { tier: 'medium', isAvailable: true, inFlight: 0 }, 0
            );

            detector.clearDriftEvents();

            detector.validateRoutingDecision(
                { tier: 'heavy', isAvailable: true, inFlight: 0 }, 0
            );

            const events = detector.getDriftEvents();
            expect(events).toHaveLength(1);
            expect(events[0].tier).toBe('heavy');
        });

        it('fresh DriftDetector instance has no drift events', () => {
            const fresh = new DriftDetector();
            expect(fresh.getDriftEvents()).toHaveLength(0);
        });
    });

    // ---------------------------------------------------------------
    // 14. getDriftSummary equivalent via validatePoolState
    // ---------------------------------------------------------------
    describe('getDriftSummary (validatePoolState)', () => {
        it('should return structured summary with byTier and byReason', () => {
            // Set up router with multiple models
            mockRouter.getPoolSnapshot = () => ({
                version: '1.0',
                timestamp: Date.now(),
                models: [
                    { modelId: 'fast', tier: 'light', isAvailable: true, inFlight: 0 },
                    { modelId: 'mid', tier: 'medium', isAvailable: true, inFlight: 0 }
                ]
            });

            // Keys are excluded → generates drift for each model
            mockKeyManager.getKeySnapshot = () => ({
                state: 'excluded',
                excludedReason: 'circuit_breaker',
                inFlight: 0
            });
            mockKeyManager.getAllKeySnapshots = () => [
                { state: 'excluded', excludedReason: 'circuit_breaker', inFlight: 0 }
            ];

            const summary = detector.validatePoolState();

            expect(summary).toHaveProperty('total');
            expect(summary).toHaveProperty('byTier');
            expect(summary).toHaveProperty('byReason');

            // Both models should trigger router_available_km_excluded
            expect(summary.total).toBe(2);
            expect(summary.byTier.light).toBe(1);
            expect(summary.byTier.medium).toBe(1);
            expect(summary.byReason.router_available_km_excluded).toBe(2);
        });

        it('should return zero-filled summary when no drift', () => {
            mockRouter.getPoolSnapshot = () => ({
                version: '1.0',
                timestamp: Date.now(),
                models: [
                    { modelId: 'ok', tier: 'medium', isAvailable: true, inFlight: 2 }
                ]
            });

            mockKeyManager.getKeySnapshot = () => ({
                state: 'available',
                inFlight: 2
            });
            mockKeyManager.getAllKeySnapshots = () => [
                { state: 'available', inFlight: 2 }
            ];

            const summary = detector.validatePoolState();
            expect(summary.total).toBe(0);

            // All reason counts should be 0
            for (const reason of DRIFT_REASON_ENUM) {
                expect(summary.byReason[reason]).toBe(0);
            }
        });

        it('should include all DRIFT_REASON_ENUM keys in byReason', () => {
            const summary = detector.validatePoolState();
            for (const reason of DRIFT_REASON_ENUM) {
                expect(summary.byReason).toHaveProperty(reason);
            }
        });
    });
});
