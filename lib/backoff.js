/**
 * Shared exponential backoff with jitter utility.
 *
 * Used by key-manager (per-key 429 cooldown) and pool-manager (per-model cooldown)
 * to ensure consistent backoff behavior across the codebase.
 *
 * @module backoff
 */

const DEFAULT_JITTER_FACTOR = 0.2;

/**
 * Calculate exponential backoff with jitter.
 *
 * @param {Object} options
 * @param {number} options.baseMs      - Base cooldown in ms (e.g. 1000)
 * @param {number} options.capMs       - Maximum cooldown in ms (e.g. 10000)
 * @param {number} options.attempt     - Current attempt number (1-based)
 * @param {number} [options.jitter=0.2] - Jitter factor (0-1). 0.2 = +/- 20%
 * @returns {number} Rounded cooldown in ms
 */
function exponentialBackoff({ baseMs, capMs, attempt, jitter = DEFAULT_JITTER_FACTOR }) {
    const clamped = Math.max(1, attempt);
    const raw = Math.min(baseMs * Math.pow(2, clamped - 1), capMs);
    const jitterAmount = raw * jitter * (Math.random() * 2 - 1);
    return Math.round(raw + jitterAmount);
}

module.exports = { exponentialBackoff, DEFAULT_JITTER_FACTOR };
