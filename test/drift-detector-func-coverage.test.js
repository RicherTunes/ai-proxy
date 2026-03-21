'use strict';

/**
 * Function coverage tests for lib/drift-detector.js
 *
 * STEP 1: BEFORE coverage
 * -----------------------
 * drift-detector.js | 100 | 97.43 | 100 | 100 | 103
 *
 * GOAL: Cover branch at line 103 (now > cooldownEnd comparison)
 *
 * Line 103: if (now > cooldownEnd) { - the else branch when cooldown is still active
 */

const { DriftDetector, DRIFT_REASON_ENUM } = require('../lib/drift-detector');

describe('DriftDetector - branch coverage for line 103', () => {
    let detector;
    let mockRouter;
    let mockKeyManager;
    let mockCounter;

    beforeEach(() => {
        mockCounter = { inc: jest.fn() };

        detector = new DriftDetector({
            metricsRegistry: { createCounter: () => mockCounter }
        });

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

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    // Covers line 103: when cooldown is active (now <= cooldownEnd), no drift should be detected
    describe('line 103 branch - cooldown timing', () => {
        it('should NOT detect drift when router is unavailable but cooldown is still active', () => {
            const routerState = {
                modelId: 'glm-4',
                tier: 'medium',
                isAvailable: false,      // Router says unavailable
                inFlight: 0,
                cooldownUntil: Date.now() + 10000  // Cooldown ends in 10 seconds
            };

            mockKeyManager.getKeySnapshot = () => ({
                state: 'available',       // Key manager thinks key is available
                inFlight: 0
            });

            const drifts = detector.validateRoutingDecision(routerState, 0);

            // No drift should be detected because cooldown is still active
            // This covers the else branch of line 103: now <= cooldownEnd
            expect(drifts).toHaveLength(0);
            expect(mockCounter.inc).not.toHaveBeenCalled();
        });

        it('should NOT detect drift when cooldownUntil is exactly equal to now', () => {
            // Freeze time to test the boundary condition
            jest.useFakeTimers();
            const frozenTime = Date.now();
            jest.spyOn(Date, 'now').mockReturnValue(frozenTime);

            const routerState = {
                modelId: 'glm-4',
                tier: 'medium',
                isAvailable: false,
                inFlight: 0,
                cooldownUntil: frozenTime  // Exactly equal to now
            };

            mockKeyManager.getKeySnapshot = () => ({
                state: 'available',
                inFlight: 0
            });

            const drifts = detector.validateRoutingDecision(routerState, 0);

            // now === cooldownEnd, so now > cooldownEnd is false
            // This covers the else branch of line 103
            expect(drifts).toHaveLength(0);
        });

        it('should detect drift when cooldown has expired (now > cooldownEnd)', () => {
            const routerState = {
                modelId: 'glm-4',
                tier: 'heavy',
                isAvailable: false,
                inFlight: 0,
                cooldownUntil: Date.now() - 5000  // Expired 5 seconds ago
            };

            mockKeyManager.getKeySnapshot = () => ({
                state: 'available',
                inFlight: 0
            });

            const drifts = detector.validateRoutingDecision(routerState, 0);

            // Drift SHOULD be detected because cooldown expired
            // This covers the true branch of line 103: now > cooldownEnd
            expect(drifts).toHaveLength(1);
            expect(drifts[0].reason).toBe('km_available_router_cooled');
            expect(drifts[0].tier).toBe('heavy');
            expect(mockCounter.inc).toHaveBeenCalledWith({
                tier: 'heavy',
                reason: 'km_available_router_cooled'
            });
        });

        it('should detect drift when cooldownUntil is 0 and router unavailable', () => {
            const routerState = {
                modelId: 'glm-4',
                tier: 'light',
                isAvailable: false,
                inFlight: 0,
                cooldownUntil: 0  // Treated as expired (now > 0 is always true)
            };

            mockKeyManager.getKeySnapshot = () => ({
                state: 'available',
                inFlight: 0
            });

            const drifts = detector.validateRoutingDecision(routerState, 0);

            // Drift detected because now > 0 is always true
            expect(drifts).toHaveLength(1);
            expect(drifts[0].reason).toBe('km_available_router_cooled');
        });

        it('should NOT detect drift when router is unavailable, key available, but in cooldown', () => {
            // This test explicitly targets the branch:
            // if (!routerState.isAvailable && keySnapshot.state === 'available') {
            //     const now = Date.now();
            //     const cooldownEnd = routerState.cooldownUntil || 0;
            //     if (now > cooldownEnd) {  // LINE 103
            //         // drift detected
            //     }
            // }
            // When now <= cooldownEnd, we should NOT detect drift

            const routerState = {
                modelId: 'glm-4',
                tier: 'medium',
                isAvailable: false,      // First condition true
                inFlight: 5,
                cooldownUntil: Date.now() + 99999  // Far in future
            };

            mockKeyManager.getKeySnapshot = () => ({
                state: 'available',       // Second condition true
                inFlight: 5
            });

            const drifts = detector.validateRoutingDecision(routerState, 0);

            // Outer conditions are met, but inner condition at line 103 is false
            // because cooldown is still active
            expect(drifts).toHaveLength(0);
        });
    });

    // Additional edge cases around line 103
    describe('line 103 edge cases', () => {
        it('should handle undefined cooldownUntil as 0 (expired)', () => {
            const routerState = {
                modelId: 'glm-4',
                tier: 'medium',
                isAvailable: false,
                inFlight: 0,
                cooldownUntil: undefined  // Should be treated as 0
            };

            mockKeyManager.getKeySnapshot = () => ({
                state: 'available',
                inFlight: 0
            });

            const drifts = detector.validateRoutingDecision(routerState, 0);

            // cooldownUntil || 0 results in 0, and now > 0 is true
            expect(drifts).toHaveLength(1);
            expect(drifts[0].reason).toBe('km_available_router_cooled');
        });

        it('should handle null cooldownUntil as 0 (expired)', () => {
            const routerState = {
                modelId: 'glm-4',
                tier: 'light',
                isAvailable: false,
                inFlight: 0,
                cooldownUntil: null  // Should be treated as 0
            };

            mockKeyManager.getKeySnapshot = () => ({
                state: 'available',
                inFlight: 0
            });

            const drifts = detector.validateRoutingDecision(routerState, 0);

            // null || 0 results in 0, and now > 0 is true
            expect(drifts).toHaveLength(1);
        });

        it('should NOT enter branch when router is available (outer condition false)', () => {
            const routerState = {
                modelId: 'glm-4',
                tier: 'medium',
                isAvailable: true,       // First condition is false - short circuit
                inFlight: 0,
                cooldownUntil: Date.now() - 5000
            };

            mockKeyManager.getKeySnapshot = () => ({
                state: 'available',
                inFlight: 0
            });

            const drifts = detector.validateRoutingDecision(routerState, 0);

            // The entire check is skipped because router is available
            expect(drifts).toHaveLength(0);
        });

        it('should NOT enter branch when key is not available (outer condition false)', () => {
            const routerState = {
                modelId: 'glm-4',
                tier: 'medium',
                isAvailable: false,      // First condition true
                inFlight: 0,
                cooldownUntil: Date.now() - 5000
            };

            mockKeyManager.getKeySnapshot = () => ({
                state: 'excluded',       // Second condition false - short circuit
                excludedReason: 'test',
                inFlight: 0
            });

            const drifts = detector.validateRoutingDecision(routerState, 0);

            // The entire check is skipped because key is excluded
            expect(drifts).toHaveLength(0);
        });
    });
});
