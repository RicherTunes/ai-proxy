/**
 * COUNTER_SCHEMA v1.0
 *
 * Central registry of all counters emitted by GLM Proxy.
 * ARCH-06: Counters schema formalized with types, reset semantics, cardinality bounds
 *
 * Reset semantics:
 * - "process" - Reset on proxy restart
 * - "never" - Never reset (cumulative)
 * - "config" - Reset on config reload
 *
 * Label cardinality bounds enforced via enums.
 */

'use strict';

// Bounded label enums for counters
const COUNTER_LABELS = Object.freeze({
    tier: new Set(['light', 'medium', 'heavy']),
    source: new Set(['override', 'saved-override', 'rule', 'classifier', 'default', 'failover', 'pool']),
    strategy: new Set(['quality', 'throughput', 'balanced', 'pool']),
    upgradeReason: new Set(['has_tools', 'has_vision', 'max_tokens', 'message_count', 'system_length', 'other']),
    fallbackReason: new Set(['cooldown', 'at_capacity', 'penalized_429', 'disabled', 'not_in_candidates', 'tier_exhausted', 'downgrade_budget_exhausted']),
    driftReason: new Set(['router_available_km_excluded', 'km_available_router_cooled', 'concurrency_mismatch', 'cooldown_mismatch']),
    keyState: new Set(['available', 'excluded', 'rate_limited', 'circuit_open', 'cooldown', 'unknown']),
    errorType: new Set(['upstream', 'timeout', 'rate_limit', 'internal']),
    migrationResult: new Set(['success', 'failure'])
});

/**
 * CounterRegistry - Central registry for all proxy counters
 */
class CounterRegistry {
    /**
     * @param {Object} options
     * @param {Object} options.logger - Optional logger
     */
    constructor(options = {}) {
        this._logger = options.logger;
        this._counters = new Map();
        this._staticSchema = COUNTER_SCHEMA;
    }

    /**
     * Register a counter
     * @param {string} name - Counter name
     * @param {string} help - Description
     * @param {Object} labels - Label schema { labelName: 'enum|...' }
     * @param {string} resetType - Reset semantics
     * @returns {Object} Counter instance
     */
    register(name, help, labels = {}, resetType = 'process') {
        // Validate labels against bounded enums
        for (const [labelName, labelEnum] of Object.entries(labels)) {
            // Check if label name exists in COUNTER_LABELS (case-sensitive match)
            if (COUNTER_LABELS[labelName]) {
                const validValues = COUNTER_LABELS[labelName];
                // Verify enum string matches bounded set
                const enumValues = labelEnum.split('|').map(v => v.trim());
                for (const value of enumValues) {
                    if (!validValues.has(value)) {
                        this._logger?.warn(`Counter ${name}: label ${labelName} has unbounded value "${value}"`);
                    }
                }
            }
        }

        const counter = {
            name,
            help,
            labels,
            resetType,
            value: 0,
            _labelValues: new Map() // Store actual label values used
        };

        this._counters.set(name, counter);
        return counter;
    }

    /**
     * Get counter by name
     * @param {string} name
     * @returns {Object|null} Counter or null
     */
    get(name) {
        return this._counters.get(name) || null;
    }

    /**
     * Get all registered counters
     * @returns {Array<Object>} Array of counter definitions
     */
    getAll() {
        return Array.from(this._counters.values());
    }

    /**
     * Validate that all runtime counters are registered
     * @returns {Object} Validation result with missing/unknown counters
     */
    validate() {
        const registeredNames = new Set(this._counters.keys());
        const declaredNames = new Set(Object.keys(this._staticSchema));

        const missing = [];
        const unknown = [];

        for (const name of declaredNames) {
            if (!registeredNames.has(name)) {
                missing.push(name);
            }
        }

        for (const name of registeredNames) {
            if (!declaredNames.has(name)) {
                unknown.push(name);
            }
        }

        return { missing, unknown, valid: missing.length === 0 && unknown.length === 0 };
    }

    /**
     * Get schema as JSON for documentation
     * @returns {Object} Schema object
     */
    getSchema() {
        return {
            version: '1.0',
            timestamp: Date.now(),
            counters: this._staticSchema
        };
    }
}

/**
 * Static schema definition for all counters
 * This is the source of truth for counter documentation
 */
const COUNTER_SCHEMA = Object.freeze({
    // Routing counters
    'glm_proxy_routing_total': {
        description: 'Total routing decisions by tier',
        labels: { tier: 'light|medium|heavy' },
        reset: 'process'
    },
    'glm_proxy_upgrade_total': {
        description: 'Total upgrades to heavy tier by reason',
        labels: { reason: 'has_tools|has_vision|max_tokens|message_count|system_length|other' },
        reset: 'process'
    },
    'glm_proxy_fallback_total': {
        description: 'Total fallbacks by reason',
        labels: { reason: 'cooldown|at_capacity|penalized_429|disabled|not_in_candidates|tier_exhausted|downgrade_budget_exhausted' },
        reset: 'process'
    },
    'glm_proxy_model_selected_total': {
        description: 'Model selections by tier and model',
        labels: { tier: 'light|medium|heavy', model: '<bounded to tier members>' },
        reset: 'process'
    },
    'glm_proxy_selection_strategy_total': {
        description: 'Selection strategy usage',
        labels: { strategy: 'quality|throughput|balanced|pool' },
        reset: 'process'
    },

    // GLM-5 rollout counters (Phase 08)
    'glm_proxy_glm5_eligible_total': {
        description: 'Requests eligible for GLM-5 routing',
        labels: {},
        reset: 'process'
    },
    'glm_proxy_glm5_applied_total': {
        description: 'Requests routed to GLM-5 via preference',
        labels: {},
        reset: 'process'
    },
    'glm_proxy_glm5_shadow_total': {
        description: 'Requests where GLM-5 was shadowed',
        labels: {},
        reset: 'process'
    },

    // Trace sampling counters (Phase 10)
    'glm_proxy_trace_sampled_total': {
        description: 'Total requests sampled for trace',
        labels: {},
        reset: 'process'
    },
    'glm_proxy_trace_included_total': {
        description: 'Sampled traces actually included (not truncated)',
        labels: {},
        reset: 'process'
    },

    // Drift detection counters (Phase 12, ARCH-03)
    'glm_proxy_drift_total': {
        description: 'Router/KeyManager drift events',
        labels: { tier: 'light|medium|heavy', reason: 'router_available_km_excluded|km_available_router_cooled|concurrency_mismatch|cooldown_mismatch' },
        reset: 'process'
    },

    // Config migration counter (Phase 09)
    'glm_proxy_config_migration_total': {
        description: 'Config v1 to v2 migrations performed',
        labels: { result: 'success|failure' },
        reset: 'never'
    },
    'glm_proxy_config_migration_write_failure_total': {
        description: 'Failed attempts to write migrated config',
        labels: {},
        reset: 'never'
    },

    // Request counters
    'glm_proxy_requests_total': {
        description: 'Total proxy requests',
        labels: { tier: 'light|medium|heavy', source: 'override|saved-override|rule|classifier|default|failover|pool' },
        reset: 'process'
    },
    'glm_proxy_errors_total': {
        description: 'Total proxy errors',
        labels: { type: 'upstream|timeout|rate_limit|internal' },
        reset: 'process'
    },

    // Token counters (from cost tracking)
    'glm_proxy_tokens_total': {
        description: 'Total tokens processed',
        labels: { tier: 'light|medium|heavy', model: '<per-tier>' },
        reset: 'never'
    },
    'glm_proxy_cost_total': {
        description: 'Total estimated cost',
        labels: { tier: 'light|medium|heavy' },
        reset: 'never'
    }
});

module.exports = {
    CounterRegistry,
    COUNTER_SCHEMA,
    COUNTER_LABELS
};
