'use strict';

const { DriftDetector, DRIFT_REASON_ENUM } = require('../lib/drift-detector');

describe('DriftDetector', () => {
    let detector;
    let mockRouter;
    let mockKeyManager;
    let mockCounter;

    beforeEach(() => {
        mockCounter = {
            inc: jest.fn()
        };

        detector = new DriftDetector({
            metricsRegistry: {
                createCounter: () => mockCounter
            }
        });

        // Mock router with getPoolSnapshot
        mockRouter = {
            getPoolSnapshot: () => ({
                version: '1.0',
                timestamp: Date.now(),
                models: [
                    {
                        modelId: 'glm-4',
                        tier: 'medium',
                        inFlight: 2,
                        maxConcurrency: 10,
                        isAvailable: true,
                        cooldownUntil: null
                    }
                ]
            })
        };

        // Mock key manager with getKeySnapshot
        mockKeyManager = {
            getKeySnapshot: (idx) => ({
                version: '1.0',
                timestamp: Date.now(),
                keyIndex: idx,
                keyId: 'key1',
                state: 'available',
                inFlight: 2,
                maxConcurrency: 3,
                excludedReason: null
            }),
            getAllKeySnapshots: () => [
                {
                    version: '1.0',
                    timestamp: Date.now(),
                    keyIndex: 0,
                    keyId: 'key1',
                    state: 'available',
                    inFlight: 2,
                    maxConcurrency: 3,
                    excludedReason: null
                }
            ]
        };

        detector.setRouter(mockRouter);
        detector.setKeyManager(mockKeyManager);
    });

    describe('validateRoutingDecision()', () => {
        it('should detect router_available_km_excluded drift', () => {
            const routerState = {
                modelId: 'glm-4',
                tier: 'medium',
                isAvailable: true,
                inFlight: 2
            };

            // Key is excluded but router thinks available
            mockKeyManager.getKeySnapshot = () => ({
                state: 'excluded',
                excludedReason: 'circuit_breaker'
            });

            const drifts = detector.validateRoutingDecision(routerState, 0);

            expect(drifts).toHaveLength(1);
            expect(drifts[0].reason).toBe('router_available_km_excluded');
            expect(mockCounter.inc).toHaveBeenCalledWith({
                tier: 'medium',
                reason: 'router_available_km_excluded'
            });
        });

        it('should detect km_available_router_cooled drift', () => {
            const routerState = {
                modelId: 'glm-4',
                tier: 'medium',
                isAvailable: false, // Router says cooled
                inFlight: 0,
                cooldownUntil: Date.now() - 1000 // Cooldown expired
            };

            mockKeyManager.getKeySnapshot = () => ({
                state: 'available' // KM says available
            });

            const drifts = detector.validateRoutingDecision(routerState, 0);

            expect(drifts).toHaveLength(1);
            expect(drifts[0].reason).toBe('km_available_router_cooled');
        });

        it('should not detect km_available_router_cooled when cooldown active', () => {
            const routerState = {
                modelId: 'glm-4',
                tier: 'medium',
                isAvailable: false,
                inFlight: 0,
                cooldownUntil: Date.now() + 5000 // Cooldown still active
            };

            mockKeyManager.getKeySnapshot = () => ({
                state: 'available'
            });

            const drifts = detector.validateRoutingDecision(routerState, 0);

            expect(drifts).toHaveLength(0);
        });

        it('should detect concurrency_mismatch drift', () => {
            const routerState = {
                modelId: 'glm-4',
                tier: 'medium',
                isAvailable: true,
                inFlight: 50 // Router says 50
            };

            mockKeyManager.getKeySnapshot = () => ({
                state: 'available',
                inFlight: 10 // KM says 10, diff > 5
            });

            const drifts = detector.validateRoutingDecision(routerState, 0);

            expect(drifts).toHaveLength(1);
            expect(drifts[0].reason).toBe('concurrency_mismatch');
            expect(drifts[0].diff).toBe(40);
        });

        it('should not detect concurrency_mismatch within threshold', () => {
            const routerState = {
                modelId: 'glm-4',
                tier: 'medium',
                isAvailable: true,
                inFlight: 5
            };

            mockKeyManager.getKeySnapshot = () => ({
                state: 'available',
                inFlight: 7 // Diff is 2, within threshold
            });

            const drifts = detector.validateRoutingDecision(routerState, 0);

            expect(drifts).toHaveLength(0);
        });

        it('should return empty array when no drift', () => {
            const routerState = {
                modelId: 'glm-4',
                tier: 'medium',
                isAvailable: true,
                inFlight: 2
            };

            mockKeyManager.getKeySnapshot = () => ({
                state: 'available',
                inFlight: 2
            });

            const drifts = detector.validateRoutingDecision(routerState, 0);

            expect(drifts).toHaveLength(0);
        });

        it('should return empty when router/keyManager not set', () => {
            const emptyDetector = new DriftDetector();
            const drifts = emptyDetector.validateRoutingDecision({}, 0);
            expect(drifts).toHaveLength(0);
        });

        it('should return empty when keySnapshot is null', () => {
            mockKeyManager.getKeySnapshot = () => null;

            const routerState = {
                modelId: 'glm-4',
                tier: 'medium',
                isAvailable: true,
                inFlight: 2
            };

            const drifts = detector.validateRoutingDecision(routerState, 0);
            expect(drifts).toHaveLength(0);
        });

        it('should handle light tier', () => {
            const routerState = {
                modelId: 'glm-4-flash',
                tier: 'light',
                isAvailable: true,
                inFlight: 1
            };

            mockKeyManager.getKeySnapshot = () => ({
                state: 'excluded',
                excludedReason: 'rate_limit'
            });

            const drifts = detector.validateRoutingDecision(routerState, 0);

            expect(drifts).toHaveLength(1);
            expect(drifts[0].tier).toBe('light');
            expect(mockCounter.inc).toHaveBeenCalledWith({
                tier: 'light',
                reason: 'router_available_km_excluded'
            });
        });

        it('should handle heavy tier', () => {
            const routerState = {
                modelId: 'glm-4-plus',
                tier: 'heavy',
                isAvailable: true,
                inFlight: 3
            };

            mockKeyManager.getKeySnapshot = () => ({
                state: 'excluded',
                excludedReason: 'manual'
            });

            const drifts = detector.validateRoutingDecision(routerState, 0);

            expect(drifts).toHaveLength(1);
            expect(drifts[0].tier).toBe('heavy');
        });

        it('validates routerState with isAvailable=true from getModelCooldown===0 pattern', () => {
            // Simulate the shape produced by selectModel's new code
            const routerState = {
                modelId: 'glm-4',
                tier: 'medium',
                isAvailable: true, // getModelCooldown() === 0
                inFlight: 2,
                cooldownUntil: null
            };

            const drifts = detector.validateRoutingDecision(routerState, 0);
            expect(drifts).toHaveLength(0); // Both agree available
        });
    });

    describe('validatePoolState()', () => {
        it('should validate all models in pool', () => {
            const summary = detector.validatePoolState();

            expect(summary).toHaveProperty('total');
            expect(summary).toHaveProperty('byTier');
            expect(summary.byTier).toHaveProperty('light');
            expect(summary.byTier).toHaveProperty('medium');
            expect(summary.byTier).toHaveProperty('heavy');
            expect(summary).toHaveProperty('byReason');
        });

        it('should return zero counts when no drift', () => {
            // Key state matches router state
            mockKeyManager.getKeySnapshot = () => ({
                state: 'available',
                inFlight: 2
            });

            const summary = detector.validatePoolState();

            expect(summary.total).toBe(0);
        });

        it('should return empty summary when router/keyManager not set', () => {
            const emptyDetector = new DriftDetector();
            const summary = emptyDetector.validatePoolState();

            expect(summary.total).toBe(0);
            expect(summary.byTier).toEqual({});
            expect(summary.byReason).toEqual({});
        });
    });

    describe('getDriftEvents()', () => {
        it('should return recorded drift events', () => {
            const routerState = { modelId: 'glm-4', tier: 'medium', isAvailable: true };
            mockKeyManager.getKeySnapshot = () => ({ state: 'excluded', excludedReason: 'test' });

            detector.validateRoutingDecision(routerState, 0);
            const events = detector.getDriftEvents();

            expect(events).toHaveLength(1);
            expect(events[0]).toHaveProperty('timestamp');
            expect(events[0].tier).toBe('medium');
        });

        it('should clear events when clearDriftEvents() called', () => {
            const routerState = { modelId: 'glm-4', tier: 'medium', isAvailable: true };
            mockKeyManager.getKeySnapshot = () => ({ state: 'excluded', excludedReason: 'test' });

            detector.validateRoutingDecision(routerState, 0);
            detector.clearDriftEvents();

            expect(detector.getDriftEvents()).toHaveLength(0);
        });
    });

    describe('DRIFT_REASON_ENUM', () => {
        it('should contain all expected reasons', () => {
            expect(DRIFT_REASON_ENUM).toContain('router_available_km_excluded');
            expect(DRIFT_REASON_ENUM).toContain('km_available_router_cooled');
            expect(DRIFT_REASON_ENUM).toContain('concurrency_mismatch');
            expect(DRIFT_REASON_ENUM).toContain('cooldown_mismatch');
        });

        it('should be frozen (immutable)', () => {
            expect(() => {
                DRIFT_REASON_ENUM.push('new_reason');
            }).toThrow();
        });
    });

    describe('getReasonEnum()', () => {
        it('should return the drift reason enum', () => {
            const reasons = DriftDetector.getReasonEnum();
            expect(reasons).toEqual(DRIFT_REASON_ENUM);
        });
    });

    describe('setRouter() and setKeyManager()', () => {
        it('should allow setting router after construction', () => {
            const newDetector = new DriftDetector();
            const router = { getPoolSnapshot: jest.fn() };
            newDetector.setRouter(router);
            expect(newDetector._router).toBe(router);
        });

        it('should allow setting keyManager after construction', () => {
            const newDetector = new DriftDetector();
            const keyManager = { getKeySnapshot: jest.fn() };
            newDetector.setKeyManager(keyManager);
            expect(newDetector._keyManager).toBe(keyManager);
        });
    });

    describe('Logging', () => {
        it('should log drift events when logger provided', () => {
            const mockLogger = { warn: jest.fn() };
            const logDetector = new DriftDetector({ logger: mockLogger });
            logDetector.setRouter(mockRouter);
            logDetector.setKeyManager(mockKeyManager);

            const routerState = {
                modelId: 'glm-4',
                tier: 'medium',
                isAvailable: true
            };
            mockKeyManager.getKeySnapshot = () => ({ state: 'excluded', excludedReason: 'test' });

            logDetector.validateRoutingDecision(routerState, 0);

            expect(mockLogger.warn).toHaveBeenCalledWith(
                'Drift detected',
                expect.objectContaining({
                    tier: 'medium',
                    reason: 'router_available_km_excluded'
                })
            );
        });

        it('should handle missing logger gracefully', () => {
            const noLogDetector = new DriftDetector();
            noLogDetector.setRouter(mockRouter);
            noLogDetector.setKeyManager(mockKeyManager);

            const routerState = {
                modelId: 'glm-4',
                tier: 'medium',
                isAvailable: true
            };
            mockKeyManager.getKeySnapshot = () => ({ state: 'excluded', excludedReason: 'test' });

            expect(() => noLogDetector.validateRoutingDecision(routerState, 0)).not.toThrow();
        });
    });

    describe('Counter integration', () => {
        it('should increment counter with correct labels on drift', () => {
            const routerState = {
                modelId: 'glm-4',
                tier: 'heavy',
                isAvailable: true
            };
            mockKeyManager.getKeySnapshot = () => ({ state: 'excluded', excludedReason: 'circuit_breaker' });

            detector.validateRoutingDecision(routerState, 0);

            expect(mockCounter.inc).toHaveBeenCalledWith({
                tier: 'heavy',
                reason: 'router_available_km_excluded'
            });
        });

        it('should work without metricsRegistry', () => {
            const noMetricsDetector = new DriftDetector();
            noMetricsDetector.setRouter(mockRouter);
            noMetricsDetector.setKeyManager(mockKeyManager);

            const routerState = {
                modelId: 'glm-4',
                tier: 'medium',
                isAvailable: true
            };
            mockKeyManager.getKeySnapshot = () => ({ state: 'excluded', excludedReason: 'test' });

            expect(() => noMetricsDetector.validateRoutingDecision(routerState, 0)).not.toThrow();
        });
    });
});
