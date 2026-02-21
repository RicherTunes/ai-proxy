/**
 * Circuit Breaker Module
 * Implements circuit breaker pattern for API key health management
 */

const STATES = {
    CLOSED: 'CLOSED',
    OPEN: 'OPEN',
    HALF_OPEN: 'HALF_OPEN'
};

class CircuitBreaker {
    constructor(options = {}) {
        this.failureThreshold = options.failureThreshold || 5;
        this.failureWindow = options.failureWindow || 30000;
        this.cooldownPeriod = options.cooldownPeriod || 60000;
        this.halfOpenTimeout = options.halfOpenTimeout || 10000;

        this.state = STATES.CLOSED;
        this.failureTimestamps = [];
        this.openedAt = 0;
        this.lastError = null;
        this.successCount = 0;
        this.failureCount = 0;

        // HALF_OPEN state tracking
        this.halfOpenRequestInFlight = false;  // Only allow 1 test request at a time
        this.halfOpenStartedAt = 0;            // When HALF_OPEN started
        this.halfOpenTimeoutId = null;         // Timer for auto-revert

        // Callbacks
        this.onStateChange = options.onStateChange || (() => {});
    }

    /**
     * Clean up old failures outside the window
     */
    _cleanupFailures() {
        const cutoff = Date.now() - this.failureWindow;
        this.failureTimestamps = this.failureTimestamps.filter(ts => ts > cutoff);
    }

    /**
     * Set timeout for HALF_OPEN state auto-revert
     */
    _setHalfOpenTimeout() {
        this._clearHalfOpenTimeout();
        this.halfOpenTimeoutId = setTimeout(() => {
            if (this.state === STATES.HALF_OPEN) {
                const previousState = this.state;
                this.state = STATES.OPEN;
                this.openedAt = Date.now();
                this.halfOpenRequestInFlight = false;
                this.onStateChange(previousState, this.state, { reason: 'half_open_timeout' });
            }
        }, this.halfOpenTimeout);
    }

    /**
     * Clear HALF_OPEN timeout timer
     */
    _clearHalfOpenTimeout() {
        if (this.halfOpenTimeoutId) {
            clearTimeout(this.halfOpenTimeoutId);
            this.halfOpenTimeoutId = null;
        }
    }

    /**
     * Update circuit state based on current conditions
     */
    updateState() {
        const now = Date.now();
        const previousState = this.state;

        this._cleanupFailures();

        switch (this.state) {
            case STATES.CLOSED:
                if (this.failureTimestamps.length >= this.failureThreshold) {
                    this.state = STATES.OPEN;
                    this.openedAt = now;
                }
                break;

            case STATES.OPEN:
                if ((now - this.openedAt) >= this.cooldownPeriod) {
                    this.state = STATES.HALF_OPEN;
                    this.halfOpenStartedAt = now;
                    this.halfOpenRequestInFlight = false;
                    // Set timeout to auto-revert to OPEN if no result within halfOpenTimeout
                    this._setHalfOpenTimeout();
                }
                break;

            case STATES.HALF_OPEN:
                // Check if HALF_OPEN has timed out without a result
                if (this.halfOpenStartedAt && (now - this.halfOpenStartedAt) >= this.halfOpenTimeout) {
                    // Timeout without success - revert to OPEN
                    this.state = STATES.OPEN;
                    this.openedAt = now;
                    this.halfOpenRequestInFlight = false;
                    this._clearHalfOpenTimeout();
                }
                break;
        }

        if (this.state !== previousState) {
            this.onStateChange(previousState, this.state, {
                failures: this.failureTimestamps.length,
                openedAt: this.openedAt
            });
        }

        return this.state;
    }

    /**
     * Check if circuit allows requests
     */
    isAvailable() {
        this.updateState();

        switch (this.state) {
            case STATES.CLOSED:
                return true;
            case STATES.HALF_OPEN:
                // HALF_OPEN: Only allow one test request at a time
                // If a test request is already in flight, reject additional requests
                return !this.halfOpenRequestInFlight;
            case STATES.OPEN:
                return false;
            default:
                return false;
        }
    }

    /**
     * Mark a test request as started (call before making request in HALF_OPEN)
     * Returns true if the request can proceed, false if another test is in flight
     */
    tryAcquireTestRequest() {
        if (this.state !== STATES.HALF_OPEN) {
            return true; // Not in HALF_OPEN, normal operation
        }
        if (this.halfOpenRequestInFlight) {
            return false; // Another test request is in progress
        }
        this.halfOpenRequestInFlight = true;
        return true;
    }

    /**
     * Record a successful request
     */
    recordSuccess() {
        this.successCount++;
        this.failureCount = Math.max(0, this.failureCount - 1);

        const previousState = this.state;

        if (this.state === STATES.HALF_OPEN) {
            this.state = STATES.CLOSED;
            this.failureTimestamps = [];
            this.halfOpenRequestInFlight = false;
            this._clearHalfOpenTimeout();
            this.onStateChange(previousState, this.state, { reason: 'test_succeeded' });
        }
    }

    /**
     * Record a failed request
     */
    recordFailure(errorType = 'unknown') {
        this.failureCount++;
        this.lastError = errorType;
        this.failureTimestamps.push(Date.now());

        const previousState = this.state;

        if (this.state === STATES.HALF_OPEN) {
            this.state = STATES.OPEN;
            this.openedAt = Date.now();
            this.halfOpenRequestInFlight = false;
            this._clearHalfOpenTimeout();
            this.onStateChange(previousState, this.state, { reason: 'test_failed', errorType });
        } else {
            this.updateState();
        }
    }

    /**
     * Force circuit to specific state (for testing/admin)
     */
    forceState(state) {
        // Validate state
        if (!Object.values(STATES).includes(state)) {
            return; // Ignore invalid states
        }

        const previousState = this.state;
        this.state = state;

        // Clear HALF_OPEN tracking when leaving that state
        if (previousState === STATES.HALF_OPEN && state !== STATES.HALF_OPEN) {
            this.halfOpenRequestInFlight = false;
            this._clearHalfOpenTimeout();
        }

        if (state === STATES.OPEN) {
            this.openedAt = Date.now();
        } else if (state === STATES.CLOSED) {
            this.failureCount = 0;
            this.failureTimestamps = [];
        } else if (state === STATES.HALF_OPEN) {
            this.halfOpenStartedAt = Date.now();
            this.halfOpenRequestInFlight = false;
            this._setHalfOpenTimeout();
        }

        // Trigger callback if state changed
        if (previousState !== state) {
            this.onStateChange(previousState, state, { reason: 'forced' });
        }
    }

    /**
     * Get time remaining in cooldown (ms), 0 if not in OPEN state
     */
    getCooldownRemaining() {
        if (this.state !== STATES.OPEN) return 0;
        const elapsed = Date.now() - this.openedAt;
        return Math.max(0, this.cooldownPeriod - elapsed);
    }

    /**
     * Get statistics
     */
    getStats() {
        this._cleanupFailures();
        return {
            state: this.state,
            successCount: this.successCount,
            failureCount: this.failureCount,
            recentFailures: this.failureTimestamps.length,
            lastError: this.lastError,
            openedAt: this.state === STATES.OPEN ? new Date(this.openedAt).toISOString() : null,
            cooldownRemaining: this.getCooldownRemaining()
        };
    }

    /**
     * Clean up timers for safe disposal (call in test teardown)
     */
    destroy() {
        this._clearHalfOpenTimeout();
    }

    /**
     * Reset circuit breaker
     */
    reset() {
        const previousState = this.state;
        this.state = STATES.CLOSED;
        this.failureTimestamps = [];
        this.openedAt = 0;
        this.lastError = null;
        this.successCount = 0;
        this.failureCount = 0;
        this.halfOpenRequestInFlight = false;
        this._clearHalfOpenTimeout();
        if (previousState !== STATES.CLOSED) {
            this.onStateChange(previousState, STATES.CLOSED, { reason: 'reset' });
        }
    }

    /**
     * Get prediction data for circuit trip likelihood (#5)
     * Score = Acceleration (40) + Ratio (35) + Recency (25)
     * @returns {Object} Prediction data
     */
    getPredictionData() {
        this._cleanupFailures();
        const now = Date.now();

        // If circuit is already open, return critical status
        if (this.state === STATES.OPEN) {
            return {
                score: 100,
                level: 'CRITICAL',
                estimatedSecondsToTrip: 0,
                reason: 'circuit_open',
                state: this.state
            };
        }

        const recentFailures = this.failureTimestamps.length;
        const threshold = this.failureThreshold;

        // No failures = healthy
        if (recentFailures === 0) {
            return {
                score: 0,
                level: 'HEALTHY',
                estimatedSecondsToTrip: null,
                reason: 'no_recent_failures',
                state: this.state
            };
        }

        // 1. Failure Ratio Score (0-35 points)
        // How close are we to the threshold?
        const ratioScore = Math.min(35, Math.round((recentFailures / threshold) * 35));

        // 2. Acceleration Score (0-40 points)
        // Are failures happening faster? Compare first half to second half of window
        let accelerationScore = 0;
        if (recentFailures >= 2) {
            const halfWindow = this.failureWindow / 2;
            const recentHalfCutoff = now - halfWindow;

            const olderFailures = this.failureTimestamps.filter(ts => ts < recentHalfCutoff).length;
            const newerFailures = this.failureTimestamps.filter(ts => ts >= recentHalfCutoff).length;

            if (olderFailures > 0) {
                const accelerationRatio = newerFailures / olderFailures;
                if (accelerationRatio > 2) {
                    accelerationScore = 40; // Very rapid acceleration
                } else if (accelerationRatio > 1.5) {
                    accelerationScore = 30;
                } else if (accelerationRatio > 1) {
                    accelerationScore = 20;
                } else {
                    accelerationScore = 10; // Decelerating (still bad but improving)
                }
            } else if (newerFailures > 0) {
                // All failures in recent half = high acceleration
                accelerationScore = 35;
            }
        }

        // 3. Recency Score (0-25 points)
        // How recent was the last failure?
        const lastFailure = this.failureTimestamps[this.failureTimestamps.length - 1];
        const msSinceLastFailure = now - lastFailure;
        const recencyThreshold = this.failureWindow / 5; // 6 seconds for 30s window

        let recencyScore = 0;
        if (msSinceLastFailure < recencyThreshold) {
            recencyScore = 25; // Very recent
        } else if (msSinceLastFailure < recencyThreshold * 2) {
            recencyScore = 20;
        } else if (msSinceLastFailure < recencyThreshold * 3) {
            recencyScore = 15;
        } else if (msSinceLastFailure < recencyThreshold * 4) {
            recencyScore = 10;
        } else {
            recencyScore = 5;
        }

        const totalScore = Math.min(100, ratioScore + accelerationScore + recencyScore);

        // Determine level
        let level;
        if (totalScore >= 86) {
            level = 'CRITICAL';
        } else if (totalScore >= 61) {
            level = 'WARNING';
        } else if (totalScore >= 31) {
            level = 'ELEVATED';
        } else {
            level = 'HEALTHY';
        }

        // Estimate time to trip based on current failure rate
        let estimatedSecondsToTrip = null;
        if (recentFailures > 0 && recentFailures < threshold) {
            const failuresNeeded = threshold - recentFailures;
            const avgTimeBetweenFailures = this.failureWindow / recentFailures;
            estimatedSecondsToTrip = Math.round((failuresNeeded * avgTimeBetweenFailures) / 1000);

            // Cap at reasonable maximum
            estimatedSecondsToTrip = Math.min(estimatedSecondsToTrip, 300);
        }

        return {
            score: totalScore,
            level,
            estimatedSecondsToTrip,
            components: {
                ratio: ratioScore,
                acceleration: accelerationScore,
                recency: recencyScore
            },
            recentFailures,
            threshold,
            state: this.state
        };
    }
}

module.exports = {
    CircuitBreaker,
    STATES
};
