/**
 * Drift Detection Module
 *
 * ARCH-03: Cross-validation drift counters between Router and KeyManager
 * Detects when Router and KeyManager disagree on pool/key state
 *
 * Bounded cardinality: All labels use fixed enums
 */

'use strict';

// Bounded enum for drift reasons (prevents cardinality explosion)
const DRIFT_REASON_ENUM = Object.freeze([
    'router_available_km_excluded',  // Router thinks available, KM excluded key
    'km_available_router_cooled',     // KM thinks available, Router cooled model
    'concurrency_mismatch',            // In-flight counts disagree
    'cooldown_mismatch'               // Cooldown state disagrees
]);

class DriftDetector {
    /**
     * @param {Object} options
     * @param {Object} options.metricsRegistry - Metrics registry for counters
     * @param {Object} options.logger - Optional logger
     */
    constructor(options = {}) {
        this._router = null;
        this._keyManager = null;
        this._logger = options.logger;

        // Create drift counter with bounded labels
        this._counter = null;
        if (options.metricsRegistry && options.metricsRegistry.createCounter) {
            this._counter = options.metricsRegistry.createCounter(
                'glm_proxy_drift_total',
                'Cross-validation drift events between Router and KeyManager',
                {
                    tier: 'light|medium|heavy',
                    reason: DRIFT_REASON_ENUM.join('|')
                }
            );
        }

        // In-memory drift tracking for testing/debug
        this._driftEvents = [];
    }

    /**
     * Set the router instance
     * @param {ModelRouter} router
     */
    setRouter(router) {
        this._router = router;
    }

    /**
     * Set the key manager instance
     * @param {KeyManager} keyManager
     */
    setKeyManager(keyManager) {
        this._keyManager = keyManager;
    }

    /**
     * Validate routing decision for drift
     * Called after each routing decision
     *
     * @param {Object} routerState - Router's view of selected model
     * @param {number} keyIndex - Key index selected
     * @returns {Array<Object>} Array of drift events detected
     */
    validateRoutingDecision(routerState, keyIndex) {
        if (!this._router || !this._keyManager) {
            return [];
        }

        const drifts = [];

        // Get both views of the state
        const keySnapshot = this._keyManager.getKeySnapshot(keyIndex);
        if (!keySnapshot) {
            return []; // Invalid key index, can't validate
        }

        // Check 1: Router says available but KM excluded key
        if (routerState.isAvailable && keySnapshot.state === 'excluded') {
            const drift = {
                tier: routerState.tier,
                reason: 'router_available_km_excluded',
                routerState: { isAvailable: routerState.isAvailable },
                keyState: { state: keySnapshot.state, excludedReason: keySnapshot.excludedReason }
            };
            drifts.push(drift);
            this._recordDrift(drift);
        }

        // Check 2: Router cooled but KM thinks key is available
        // (This can happen if cooldowns aren't synchronized)
        if (!routerState.isAvailable && keySnapshot.state === 'available') {
            // Only flag if not in expected cooldown
            const now = Date.now();
            const cooldownEnd = routerState.cooldownUntil || 0;
            if (now > cooldownEnd) {
                const drift = {
                    tier: routerState.tier,
                    reason: 'km_available_router_cooled',
                    routerState: { isAvailable: routerState.isAvailable, cooldownUntil: cooldownEnd },
                    keyState: { state: keySnapshot.state }
                };
                drifts.push(drift);
                this._recordDrift(drift);
            }
        }

        // Check 3: Concurrency mismatch
        // Router's in-flight vs KeyManager's in-flight for selected key
        if (typeof routerState.inFlight === 'number' && typeof keySnapshot.inFlight === 'number') {
            const diff = Math.abs(routerState.inFlight - keySnapshot.inFlight);
            // Allow small difference due to timing (requests in-flight between checks)
            if (diff > 5) { // Threshold: more than 5 requests difference
                const drift = {
                    tier: routerState.tier,
                    reason: 'concurrency_mismatch',
                    routerInFlight: routerState.inFlight,
                    keyInFlight: keySnapshot.inFlight,
                    diff
                };
                drifts.push(drift);
                this._recordDrift(drift);
            }
        }

        return drifts;
    }

    /**
     * Validate entire pool state for drift
     * Can be called periodically (e.g., every 30 seconds)
     *
     * @returns {Object} Drift summary with counts by tier/reason
     */
    validatePoolState() {
        if (!this._router || !this._keyManager) {
            return { total: 0, byTier: {}, byReason: {} };
        }

        const summary = {
            total: 0,
            byTier: { light: 0, medium: 0, heavy: 0 },
            byReason: Object.fromEntries(DRIFT_REASON_ENUM.map(r => [r, 0]))
        };

        // Get all models from router
        const poolSnapshot = this._router.getPoolSnapshot();

        for (const modelState of poolSnapshot.models) {
            // For each model, check if any associated keys have drift
            // This is a simplified check - in practice, you'd need to know
            // which keys are associated with which models
            const keySnapshot = this._keyManager.getAllKeySnapshots()[0];
            if (!keySnapshot) continue;

            const drifts = this.validateRoutingDecision(modelState, 0);
            for (const drift of drifts) {
                summary.total++;
                summary.byTier[drift.tier]++;
                summary.byReason[drift.reason]++;
            }
        }

        return summary;
    }

    /**
     * Record a drift event
     * @param {Object} drift - Drift event
     * @private
     */
    _recordDrift(drift) {
        // Emit to counter if available
        if (this._counter) {
            this._counter.inc({
                tier: drift.tier,
                reason: drift.reason
            });
        }

        // Log for visibility
        this._logger?.warn('Drift detected', {
            tier: drift.tier,
            reason: drift.reason,
            details: drift
        });

        // Store in memory for testing
        this._driftEvents.push({
            ...drift,
            timestamp: Date.now()
        });
    }

    /**
     * Get recorded drift events (for testing)
     * @returns {Array} Drift events
     */
    getDriftEvents() {
        return [...this._driftEvents];
    }

    /**
     * Clear drift history (for testing)
     */
    clearDriftEvents() {
        this._driftEvents = [];
    }

    /**
     * Get drift reason enum (for metrics registration)
     * @returns {Array<string>} Array of valid drift reasons
     */
    static getReasonEnum() {
        return DRIFT_REASON_ENUM;
    }
}

module.exports = { DriftDetector, DRIFT_REASON_ENUM };
