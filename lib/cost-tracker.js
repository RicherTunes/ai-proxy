/**
 * Cost Tracker Module
 * Tracks API usage costs with budgeting and projection capabilities
 *
 * Features:
 * - Per-model pricing support
 * - Batch recording API for efficiency
 * - Debounced saves for performance
 * - Input validation and sanitization
 * - Metrics and observability
 * - External pricing config loading
 */

const fs = require('fs');
const path = require('path');
const { LRUMap } = require('./lru-map');
const { atomicWrite } = require('./atomic-write');
const { loadPricing, getDefaultPricing } = require('./pricing-loader');

const COST_SCHEMA_VERSION = 2;

// Default pricing fallback (Claude Sonnet 4.5 via z.ai)
const DEFAULT_RATES = {
    inputTokenPer1M: 3.00,   // $3.00 per 1M input tokens
    outputTokenPer1M: 15.00  // $15.00 per 1M output tokens
};

// Model-specific pricing — verified against docs.z.ai/guides/overview/pricing (Feb 2026)
// NOTE: These are fallback defaults. Actual pricing is loaded from config/pricing.json
const DEFAULT_MODEL_RATES = {
    // Claude models (Anthropic pricing via z.ai pass-through)
    'claude-opus-4-6': { inputTokenPer1M: 15.00, outputTokenPer1M: 75.00 },
    'claude-opus-4': { inputTokenPer1M: 15.00, outputTokenPer1M: 75.00 },
    'claude-sonnet-4-6': { inputTokenPer1M: 3.00, outputTokenPer1M: 15.00 },
    'claude-sonnet-4-5': { inputTokenPer1M: 3.00, outputTokenPer1M: 15.00 },
    'claude-haiku-4-5': { inputTokenPer1M: 0.80, outputTokenPer1M: 4.00 },
    'claude-haiku-4': { inputTokenPer1M: 0.80, outputTokenPer1M: 4.00 },
    'claude-opus-3': { inputTokenPer1M: 15.00, outputTokenPer1M: 75.00 },
    'claude-sonnet-3': { inputTokenPer1M: 3.00, outputTokenPer1M: 15.00 },
    'claude-haiku-3': { inputTokenPer1M: 0.25, outputTokenPer1M: 1.25 },
    // GLM Flagship tier (z.ai published pricing Feb 2026)
    'glm-5': { inputTokenPer1M: 1.00, outputTokenPer1M: 3.20 },
    'glm-5-code': { inputTokenPer1M: 1.20, outputTokenPer1M: 5.00 },
    'glm-4.5-x': { inputTokenPer1M: 2.20, outputTokenPer1M: 8.90 },
    // GLM Standard tier
    'glm-4.7': { inputTokenPer1M: 0.60, outputTokenPer1M: 2.20 },
    'glm-4.6': { inputTokenPer1M: 0.60, outputTokenPer1M: 2.20 },
    'glm-4.5': { inputTokenPer1M: 0.60, outputTokenPer1M: 2.20 },
    // GLM Lightweight/Air tier
    'glm-4.5-air': { inputTokenPer1M: 0.20, outputTokenPer1M: 1.10 },
    'glm-4.5-airx': { inputTokenPer1M: 1.10, outputTokenPer1M: 4.50 },
    // GLM Flash tier (free or ultra-low cost)
    'glm-4.7-flash': { inputTokenPer1M: 0.00, outputTokenPer1M: 0.00 },
    'glm-4.7-flashx': { inputTokenPer1M: 0.07, outputTokenPer1M: 0.40 },
    'glm-4.5-flash': { inputTokenPer1M: 0.00, outputTokenPer1M: 0.00 },
    // GLM Vision models
    'glm-4.5v': { inputTokenPer1M: 0.60, outputTokenPer1M: 1.80 },
    'glm-4.6v': { inputTokenPer1M: 0.30, outputTokenPer1M: 0.90 },
    'glm-4.6v-flashx': { inputTokenPer1M: 0.04, outputTokenPer1M: 0.40 },
    'glm-4.6v-flash': { inputTokenPer1M: 0.00, outputTokenPer1M: 0.00 },
    // GLM Open-source
    'glm-4-32b-0414-128k': { inputTokenPer1M: 0.10, outputTokenPer1M: 0.10 }
};

const ALERT_THRESHOLDS = [0.5, 0.8, 0.95, 1.0];

// Constants for validation
const MAX_STRING_LENGTH = 256;
const SLOW_SAVE_THRESHOLD_MS = 100;

/**
 * Load model rates from external config file with fallback to defaults
 * @param {string} configDir - Directory containing the config file
 * @param {string} pricingConfigPath - Path to pricing config (relative or absolute)
 * @returns {Object} Model rates object
 */
function _loadModelRates(configDir, pricingConfigPath) {
    // Determine the full path to the pricing config
    let fullPath;
    if (pricingConfigPath) {
        fullPath = path.isAbsolute(pricingConfigPath)
            ? pricingConfigPath
            : path.join(configDir, pricingConfigPath);
    } else {
        // Default path
        fullPath = path.join(configDir, 'pricing.json');
    }

    const result = loadPricing(fullPath);

    if (result.loaded) {
        // Successfully loaded from file - use those rates
        return { ...DEFAULT_MODEL_RATES, ...result.pricing.models };
    } else {
        // Failed to load - use defaults
        return { ...DEFAULT_MODEL_RATES };
    }
}

class CostTracker {
    /**
     * Create a new cost tracker
     * @param {Object} options - Configuration options
     * @param {Object} options.rates - Default rates (backward compatible)
     * @param {Object} options.models - Per-model rates (overrides config file)
     * @param {Object} options.budget - Budget settings
     * @param {string} options.persistPath - Path to persist cost data
     * @param {string} options.configDir - Directory for persist file
     * @param {string} options.pricingConfigPath - Path to pricing config file (relative to configDir)
     * @param {Function} options.logger - Logger function
     * @param {Function} options.onBudgetAlert - Budget alert callback
     * @param {number} options.saveDebounceMs - Debounce delay for saves (default: 5000)
     */
    constructor(options = {}) {
        // Support both old `rates` and new `models` pricing structure
        this.rates = { ...DEFAULT_RATES, ...(options.rates || {}) };

        // Load model rates from external config file if available
        const configDir = options.configDir || path.join(__dirname, '..', 'config');
        const loadedModelRates = _loadModelRates(configDir, options.pricingConfigPath);

        // Merge: defaults < loaded from config < explicit options.models
        this.modelRates = { ...loadedModelRates, ...(options.models || {}) };

        this.budget = {
            daily: options.budget?.daily ?? null,
            monthly: options.budget?.monthly ?? null,
            alertThresholds: options.budget?.alertThresholds || ALERT_THRESHOLDS
        };

        this.persistPath = options.persistPath || null;
        this.configDir = options.configDir || __dirname;
        this.logger = options.logger;
        this._pendingSave = null;
        this._saveTimeout = null;
        this.destroyed = false;
        this.saveDebounceMs = options.saveDebounceMs ?? 5000;

        // Cost tracking data
        this.usage = {
            today: this._createEmptyPeriod(),
            thisWeek: this._createEmptyPeriod(),
            thisMonth: this._createEmptyPeriod(),
            allTime: this._createEmptyPeriod()
        };

        // Per-key tracking
        this.byKeyId = new LRUMap(1000);

        // Per-tenant tracking
        this.costsByTenant = new LRUMap(1000);

        // Alert tracking (to avoid duplicate alerts)
        this._alertsFired = {
            daily: new Set(),
            monthly: new Set()
        };

        // Webhook callback for budget alerts
        this.onBudgetAlert = options.onBudgetAlert || (() => {});

        // Period tracking
        this._lastReset = {
            day: this._getDateKey(),
            week: this._getWeekKey(),
            month: this._getMonthKey()
        };

        // Hourly history for projections (last 24 hours)
        this.hourlyHistory = [];
        this.maxHourlyHistory = 24;

        // Per-model cost time-series (hourly buckets, 30 days max)
        // { times: ['2026-02-20 17:00', ...], totals: [cost, ...], byModel: { 'glm-5': [cost, ...] } }
        this.costTimeSeries = { times: [], totals: [], byModel: {} };
        this._maxCostTimeSeriesBuckets = 720; // 30 days

        // Metrics for observability
        this._metrics = {
            recordCount: 0,
            saveCount: 0,
            lastSaveDuration: null,
            errorCount: 0,
            validationWarnings: 0,
            batchRecordCount: 0,
            batchOperations: 0
        };

        // Load persisted data if available
        if (this.persistPath) {
            this._load();
        }
    }

    _createEmptyPeriod() {
        return {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            cost: 0,
            requests: 0,
            startedAt: new Date().toISOString()
        };
    }

    _getDateKey() {
        return new Date().toISOString().split('T')[0];
    }

    _getWeekKey() {
        const now = new Date();
        const startOfYear = new Date(now.getFullYear(), 0, 1);
        const days = Math.floor((now - startOfYear) / (24 * 60 * 60 * 1000));
        return `${now.getFullYear()}-W${Math.ceil((days + startOfYear.getDay() + 1) / 7)}`;
    }

    _getMonthKey() {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    _log(level, message, context) {
        if (this.logger) {
            this.logger[level](message, context);
        }
    }

    /**
     * Validate and sanitize usage data
     * @private
     * @param {string} keyId - API key identifier
     * @param {number} inputTokens - Input token count
     * @param {number} outputTokens - Output token count
     * @param {string} tenantId - Optional tenant identifier
     * @returns {Object|null} Validated data or null if invalid
     */
    _validateUsage(keyId, inputTokens, outputTokens, tenantId = null) {
        // Validate token counts
        if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') {
            this._log('warn', 'Invalid token counts: must be numbers', { keyId, inputTokens, outputTokens });
            this._metrics.validationWarnings++;
            return null;
        }

        if (!isFinite(inputTokens) || !isFinite(outputTokens)) {
            this._log('warn', 'Invalid token counts: must be finite', { keyId, inputTokens, outputTokens });
            this._metrics.validationWarnings++;
            return null;
        }

        if (inputTokens < 0 || outputTokens < 0) {
            this._log('warn', 'Invalid token counts: cannot be negative', { keyId, inputTokens, outputTokens });
            this._metrics.validationWarnings++;
            return null;
        }

        // Sanitize keyId
        if (typeof keyId !== 'string') {
            this._log('warn', 'Invalid keyId: must be string', { keyId });
            this._metrics.validationWarnings++;
            return null;
        }

        const sanitizedKeyId = keyId.trim().slice(0, MAX_STRING_LENGTH);

        // Sanitize tenantId if provided
        let sanitizedTenantId = null;
        if (tenantId !== null && tenantId !== undefined) {
            if (typeof tenantId !== 'string') {
                this._log('warn', 'Invalid tenantId: must be string', { keyId, tenantId });
                this._metrics.validationWarnings++;
                return null;
            }
            sanitizedTenantId = tenantId.trim().slice(0, MAX_STRING_LENGTH);
        }

        return {
            keyId: sanitizedKeyId,
            inputTokens,
            outputTokens,
            tenantId: sanitizedTenantId
        };
    }

    /**
     * Get rates for a specific model
     * @param {string} model - Model identifier
     * @returns {Object} Rates for the model (inputTokenPer1M, outputTokenPer1M)
     */
    getRatesByModel(model) {
        if (!model) return this.rates;

        // Exact match first
        const lowerModel = model.toLowerCase();
        if (this.modelRates[lowerModel]) {
            return this.modelRates[lowerModel];
        }
        if (this.modelRates[model]) {
            return this.modelRates[model];
        }

        // Prefix match: "claude-sonnet-4-5-20250514" → "claude-sonnet-4-5"
        for (const key of Object.keys(this.modelRates)) {
            if (lowerModel.startsWith(key)) {
                return this.modelRates[key];
            }
        }

        // Fall back to default rates
        return this.rates;
    }

    /**
     * Calculate cost from token usage
     * @param {number} inputTokens - Input token count
     * @param {number} outputTokens - Output token count
     * @param {string} model - Optional model identifier for per-model pricing
     * @returns {number} Cost in dollars
     */
    calculateCost(inputTokens, outputTokens, model = null) {
        const rates = model ? this.getRatesByModel(model) : this.rates;
        const inputCost = (inputTokens / 1_000_000) * rates.inputTokenPer1M;
        const outputCost = (outputTokens / 1_000_000) * rates.outputTokenPer1M;
        return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000; // 6 decimal places
    }

    /**
     * Check and reset periods if needed
     */
    _checkPeriodReset() {
        const currentDay = this._getDateKey();
        const currentWeek = this._getWeekKey();
        const currentMonth = this._getMonthKey();

        if (this._lastReset.day !== currentDay) {
            // Archive today's data to hourly history
            this._archiveToHourly();

            // Reset daily
            this.usage.today = this._createEmptyPeriod();
            this._lastReset.day = currentDay;
            this._alertsFired.daily.clear();
            this._log('info', 'Daily cost tracking reset');
        }

        if (this._lastReset.week !== currentWeek) {
            this.usage.thisWeek = this._createEmptyPeriod();
            this._lastReset.week = currentWeek;
        }

        if (this._lastReset.month !== currentMonth) {
            this.usage.thisMonth = this._createEmptyPeriod();
            this._lastReset.month = currentMonth;
            this._alertsFired.monthly.clear();
            this._log('info', 'Monthly cost tracking reset');
        }
    }

    _archiveToHourly() {
        if (this.usage.today.requests > 0) {
            this.hourlyHistory.push({
                timestamp: Date.now(),
                date: this._lastReset.day,
                cost: this.usage.today.cost,
                tokens: this.usage.today.totalTokens,
                requests: this.usage.today.requests
            });

            while (this.hourlyHistory.length > this.maxHourlyHistory) {
                this.hourlyHistory.shift();
            }
        }
    }

    /**
     * Record cost into per-model hourly time-series
     */
    _recordCostTimeSeries(cost, model) {
        const now = new Date();
        const hourKey = now.getFullYear() + '-' +
            String(now.getMonth() + 1).padStart(2, '0') + '-' +
            String(now.getDate()).padStart(2, '0') + ' ' +
            String(now.getHours()).padStart(2, '0') + ':00';

        const ts = this.costTimeSeries;
        const lastIdx = ts.times.length - 1;

        if (lastIdx >= 0 && ts.times[lastIdx] === hourKey) {
            ts.totals[lastIdx] += cost;
            if (!ts.byModel[model]) ts.byModel[model] = new Array(ts.times.length).fill(0);
            ts.byModel[model][lastIdx] += cost;
        } else {
            ts.times.push(hourKey);
            ts.totals.push(cost);
            // Extend all model arrays with 0 for new bucket
            for (const m of Object.keys(ts.byModel)) {
                ts.byModel[m].push(0);
            }
            if (!ts.byModel[model]) ts.byModel[model] = new Array(ts.times.length).fill(0);
            ts.byModel[model][ts.times.length - 1] = cost;
            // Trim old buckets
            while (ts.times.length > this._maxCostTimeSeriesBuckets) {
                ts.times.shift();
                ts.totals.shift();
                for (const m of Object.keys(ts.byModel)) {
                    ts.byModel[m].shift();
                }
            }
        }
    }

    /**
     * Get cost time-series data for dashboard
     */
    getCostTimeSeries() {
        return {
            times: [...this.costTimeSeries.times],
            totals: [...this.costTimeSeries.totals],
            byModel: Object.fromEntries(
                Object.entries(this.costTimeSeries.byModel).map(([m, arr]) => [m, [...arr]])
            )
        };
    }

    /**
     * Calculate cost from token usage
     * @param {number} inputTokens - Input token count
     * @param {number} outputTokens - Output token count
     * @returns {number} Cost in dollars
     * @deprecated Use calculateCost(inputTokens, outputTokens, model) instead
     */
    calculateCost(inputTokens, outputTokens, model = null) {
        const rates = model ? this.getRatesByModel(model) : this.rates;
        const inputCost = (inputTokens / 1_000_000) * rates.inputTokenPer1M;
        const outputCost = (outputTokens / 1_000_000) * rates.outputTokenPer1M;
        return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000; // 6 decimal places
    }

    /**
     * Record token usage
     * @param {string} keyId - API key identifier
     * @param {number} inputTokens - Input tokens used
     * @param {number} outputTokens - Output tokens used
     * @param {string} model - Model used for per-model pricing
     * @param {string} tenantId - Optional tenant identifier
     * @returns {Object|undefined} Cost breakdown or undefined if validation fails
     */
    recordUsage(keyId, inputTokens, outputTokens, model = 'claude-sonnet', tenantId = null) {
        // Validate input
        const validated = this._validateUsage(keyId, inputTokens, outputTokens, tenantId);
        if (!validated) {
            return undefined;
        }

        // Check for zero tokens after validation
        if (!validated.inputTokens && !validated.outputTokens) {
            return undefined;
        }

        this._checkPeriodReset();

        // Use validated/sanitized values
        const { keyId: sanitizedKeyId, inputTokens: validInput, outputTokens: validOutput, tenantId: sanitizedTenantId } = validated;

        const cost = this.calculateCost(validInput, validOutput, model);
        const totalTokens = validInput + validOutput;

        // Update all periods
        for (const period of Object.values(this.usage)) {
            period.inputTokens += validInput;
            period.outputTokens += validOutput;
            period.totalTokens += totalTokens;
            period.cost += cost;
            period.requests++;
        }

        // Per-key tracking
        if (!this.byKeyId.has(sanitizedKeyId)) {
            this.byKeyId.set(sanitizedKeyId, this._createEmptyPeriod());
        }
        const keyStats = this.byKeyId.get(sanitizedKeyId);
        keyStats.inputTokens += validInput;
        keyStats.outputTokens += validOutput;
        keyStats.totalTokens += totalTokens;
        keyStats.cost += cost;
        keyStats.requests++;

        // Per-tenant tracking
        if (sanitizedTenantId) {
            this.recordCostForTenant(sanitizedTenantId, {
                totalCost: cost,
                inputTokens: validInput,
                outputTokens: validOutput
            }, model);
        }

        // Record in cost time-series
        this._recordCostTimeSeries(cost, model || 'unknown');

        // Update metrics
        this._metrics.recordCount++;

        // Check budget alerts
        this._checkBudgetAlerts();

        return {
            cost,
            totalTokens,
            inputTokens: validInput,
            outputTokens: validOutput
        };
    }

    /**
     * Record multiple usage records in a single batch
     * More efficient than calling recordUsage multiple times
     * @param {Array<Object>} records - Array of usage records
     * @param {string} records[].keyId - API key identifier
     * @param {number} records[].inputTokens - Input tokens used
     * @param {number} records[].outputTokens - Output tokens used
     * @param {string} records[].model - Model used
     * @param {string} records[].tenantId - Optional tenant identifier
     * @returns {Object} Batch summary with stats
     */
    recordBatch(records) {
        if (!Array.isArray(records) || records.length === 0) {
            this._log('warn', 'recordBatch called with empty or invalid records');
            return {
                processed: 0,
                skipped: 0,
                totalCost: 0,
                totalTokens: 0,
                errors: 0
            };
        }

        this._checkPeriodReset();
        this._metrics.batchOperations++;

        let processed = 0;
        let skipped = 0;
        let totalCost = 0;
        let totalTokens = 0;
        let errors = 0;

        for (const record of records) {
            // Validate record structure
            if (!record || typeof record !== 'object') {
                errors++;
                this._metrics.validationWarnings++;
                continue;
            }

            const { keyId, inputTokens, outputTokens, model = 'claude-sonnet', tenantId = null } = record;

            // Validate input
            const validated = this._validateUsage(keyId, inputTokens, outputTokens, tenantId);
            if (!validated) {
                skipped++;
                errors++;
                continue;
            }

            // Check for zero tokens
            if (!validated.inputTokens && !validated.outputTokens) {
                skipped++;
                continue;
            }

            // Use validated/sanitized values
            const { keyId: sanitizedKeyId, inputTokens: validInput, outputTokens: validOutput, tenantId: sanitizedTenantId } = validated;

            const cost = this.calculateCost(validInput, validOutput, model);
            const recordTokens = validInput + validOutput;

            // Update all periods
            for (const period of Object.values(this.usage)) {
                period.inputTokens += validInput;
                period.outputTokens += validOutput;
                period.totalTokens += recordTokens;
                period.cost += cost;
                period.requests++;
            }

            // Per-key tracking
            if (!this.byKeyId.has(sanitizedKeyId)) {
                this.byKeyId.set(sanitizedKeyId, this._createEmptyPeriod());
            }
            const keyStats = this.byKeyId.get(sanitizedKeyId);
            keyStats.inputTokens += validInput;
            keyStats.outputTokens += validOutput;
            keyStats.totalTokens += recordTokens;
            keyStats.cost += cost;
            keyStats.requests++;

            // Per-tenant tracking
            if (sanitizedTenantId) {
                this.recordCostForTenant(sanitizedTenantId, {
                    totalCost: cost,
                    inputTokens: validInput,
                    outputTokens: validOutput
                }, model);
            }

            totalCost += cost;
            totalTokens += recordTokens;
            processed++;
        }

        this._metrics.recordCount += processed;
        this._metrics.batchRecordCount += processed;

        // Check budget alerts once after batch
        this._checkBudgetAlerts();

        return {
            processed,
            skipped,
            totalCost: Math.round(totalCost * 1_000_000) / 1_000_000,
            totalTokens,
            errors
        };
    }

    /**
     * Check and fire budget alerts
     */
    _checkBudgetAlerts() {
        // Daily budget alerts
        if (this.budget.daily) {
            const dailyPct = this.usage.today.cost / this.budget.daily;

            for (const threshold of this.budget.alertThresholds) {
                if (dailyPct >= threshold && !this._alertsFired.daily.has(threshold)) {
                    this._alertsFired.daily.add(threshold);
                    this._fireBudgetAlert('daily', threshold, this.usage.today.cost, this.budget.daily);
                }
            }
        }

        // Monthly budget alerts
        if (this.budget.monthly) {
            const monthlyPct = this.usage.thisMonth.cost / this.budget.monthly;

            for (const threshold of this.budget.alertThresholds) {
                if (monthlyPct >= threshold && !this._alertsFired.monthly.has(threshold)) {
                    this._alertsFired.monthly.add(threshold);
                    this._fireBudgetAlert('monthly', threshold, this.usage.thisMonth.cost, this.budget.monthly);
                }
            }
        }
    }

    _fireBudgetAlert(period, threshold, current, limit) {
        const eventType = threshold >= 1.0 ? 'budget.exceeded' : 'budget.warning';
        const pctUsed = Math.round((current / limit) * 100);

        this._log('warn', `Budget alert: ${period} ${pctUsed}% used`, {
            period,
            threshold,
            current: current.toFixed(4),
            limit: limit.toFixed(2)
        });

        this.onBudgetAlert({
            type: eventType,
            period,
            threshold,
            percentUsed: pctUsed,
            currentCost: current,
            budgetLimit: limit,
            remaining: Math.max(0, limit - current),
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Get usage statistics for a period
     * @param {string} period - 'today', 'this_week', 'this_month', 'all_time'
     * @returns {Object} Usage stats
     */
    getStats(period = 'today') {
        this._checkPeriodReset();

        const periodMap = {
            'today': 'today',
            'this_week': 'thisWeek',
            'this_month': 'thisMonth',
            'all_time': 'allTime'
        };

        const usageData = this.usage[periodMap[period] || 'today'];

        return {
            period,
            ...usageData,
            cost: Math.round(usageData.cost * 10000) / 10000, // 4 decimal places
            avgCostPerRequest: usageData.requests > 0
                ? Math.round((usageData.cost / usageData.requests) * 10000) / 10000
                : 0,
            budget: this._getBudgetInfo(period),
            rates: { ...this.rates },
            modelRates: { ...this.modelRates }
        };
    }

    _getBudgetInfo(period) {
        let limit = null;
        let current = 0;

        if (period === 'today' && this.budget.daily) {
            limit = this.budget.daily;
            current = this.usage.today.cost;
        } else if (period === 'this_month' && this.budget.monthly) {
            limit = this.budget.monthly;
            current = this.usage.thisMonth.cost;
        }

        if (!limit) return null;

        return {
            limit,
            used: current,
            remaining: Math.max(0, limit - current),
            percentUsed: Math.round((current / limit) * 100)
        };
    }


    /**
     * Get cost projection for end of period
     * @returns {Object} Projections
     */
    getProjection() {
        this._checkPeriodReset();

        const now = new Date();
        const startOfDay = new Date(now);
        startOfDay.setHours(0, 0, 0, 0);

        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);

        // Calculate time elapsed as fraction
        const hoursIntoDay = (now - startOfDay) / (1000 * 60 * 60);
        const daysIntoMonth = (now - startOfMonth) / (1000 * 60 * 60 * 24);
        const daysInMonth = endOfMonth.getDate();

        // Project based on current rate
        const hourlyRate = hoursIntoDay > 0 ? this.usage.today.cost / hoursIntoDay : 0;
        const dailyRate = daysIntoMonth > 0 ? this.usage.thisMonth.cost / daysIntoMonth : 0;

        const projectedDaily = hourlyRate * 24;
        const projectedMonthly = dailyRate * daysInMonth;

        return {
            daily: {
                current: Math.round(this.usage.today.cost * 10000) / 10000,
                projected: Math.round(projectedDaily * 10000) / 10000,
                hourlyRate: Math.round(hourlyRate * 10000) / 10000,
                hoursElapsed: Math.round(hoursIntoDay * 10) / 10,
                budget: this.budget.daily,
                willExceed: this.budget.daily ? projectedDaily > this.budget.daily : null
            },
            monthly: {
                current: Math.round(this.usage.thisMonth.cost * 10000) / 10000,
                projected: Math.round(projectedMonthly * 10000) / 10000,
                dailyRate: Math.round(dailyRate * 10000) / 10000,
                daysElapsed: Math.round(daysIntoMonth * 10) / 10,
                daysRemaining: Math.round((daysInMonth - daysIntoMonth) * 10) / 10,
                budget: this.budget.monthly,
                willExceed: this.budget.monthly ? projectedMonthly > this.budget.monthly : null
            }
        };
    }

    /**
     * Get historical cost data
     * @param {number} days - Number of days of history
     * @returns {Array} Daily cost history
     */
    getHistory(days = 7) {
        return this.hourlyHistory.slice(-days);
    }

    /**
     * Update budget settings
     * @param {Object} newBudget - New budget settings
     */
    setBudget(newBudget) {
        if (newBudget.daily !== undefined) {
            this.budget.daily = newBudget.daily;
        }
        if (newBudget.monthly !== undefined) {
            this.budget.monthly = newBudget.monthly;
        }
        if (newBudget.alertThresholds) {
            this.budget.alertThresholds = newBudget.alertThresholds;
        }

        this._log('info', 'Budget updated', this.budget);
        this._save();
    }

    /**
     * Update pricing rates
     * @param {Object} newRates - New rate settings
     */
    setRates(newRates) {
        Object.assign(this.rates, newRates);
        this._log('info', 'Rates updated', this.rates);
    }

    /**
     * Record cost for a specific tenant
     * @param {string} tenantId - Tenant identifier
     * @param {Object} cost - Cost object with totalCost, inputTokens, outputTokens
     * @param {string} model - Model name
     */
    recordCostForTenant(tenantId, cost, model) {
        if (!this.costsByTenant.has(tenantId)) {
            this.costsByTenant.set(tenantId, {
                totalCost: 0,
                requestCount: 0,
                inputTokens: 0,
                outputTokens: 0,
                costByModel: {}
            });
        }

        const tenantCost = this.costsByTenant.get(tenantId);
        tenantCost.totalCost += cost.totalCost || 0;
        tenantCost.requestCount++;
        tenantCost.inputTokens += cost.inputTokens || 0;
        tenantCost.outputTokens += cost.outputTokens || 0;

        const modelName = model || 'unknown';
        if (!tenantCost.costByModel[modelName]) {
            tenantCost.costByModel[modelName] = { cost: 0, requests: 0 };
        }
        tenantCost.costByModel[modelName].cost += cost.totalCost || 0;
        tenantCost.costByModel[modelName].requests++;
    }

    /**
     * Get cost data for a specific tenant
     * @param {string} tenantId - Tenant identifier
     * @returns {Object|null} Tenant cost data or null if not found
     */
    getTenantCosts(tenantId) {
        return this.costsByTenant.get(tenantId) || null;
    }

    /**
     * Get cost data for all tenants
     * @returns {Object} All tenant cost data
     */
    getAllTenantCosts() {
        const result = {};
        for (const [tenantId, costs] of this.costsByTenant) {
            result[tenantId] = { ...costs };
        }
        return result;
    }

    /**
     * Get per-key cost breakdown
     * @returns {Object} Cost by key
     */
    getCostByKey() {
        const result = {};
        for (const [keyId, stats] of this.byKeyId) {
            result[keyId] = {
                ...stats,
                cost: Math.round(stats.cost * 10000) / 10000
            };
        }
        return result;
    }

    /**
     * Get full cost report
     * @returns {Object} Complete cost report
     */
    getFullReport() {
        return {
            periods: {
                today: this.getStats('today'),
                thisWeek: this.getStats('this_week'),
                thisMonth: this.getStats('this_month'),
                allTime: this.getStats('all_time')
            },
            projection: this.getProjection(),
            byKey: this.getCostByKey(),
            tenantCosts: this.getAllTenantCosts(),
            history: this.getHistory(),
            rates: { ...this.rates },
            modelRates: { ...this.modelRates },
            budget: { ...this.budget },
            metrics: this.getMetrics()
        };
    }

    /**
     * Save to disk (with debouncing for performance)
     * Debouncing reduces I/O operations while ensuring data persistence
     * @private
     */
    _save() {
        if (!this.persistPath || this.destroyed) return;

        // Clear existing timeout to reset debounce
        if (this._saveTimeout) {
            clearTimeout(this._saveTimeout);
        }

        // Schedule debounced save
        this._saveTimeout = setTimeout(() => {
            this._performSave();
            this._saveTimeout = null;
        }, this.saveDebounceMs);
    }

    /**
     * Perform the actual save operation immediately
     * @private
     */
    async _performSave() {
        if (!this.persistPath || this.destroyed) return;
        if (this._pendingSave) return;

        const startTime = Date.now();

        try {
            const data = {
                schemaVersion: COST_SCHEMA_VERSION,
                usage: this.usage,
                byKeyId: Object.fromEntries(this.byKeyId),
                costsByTenant: Object.fromEntries(this.costsByTenant),
                hourlyHistory: this.hourlyHistory,
                costTimeSeries: this.costTimeSeries,
                _lastReset: this._lastReset,
                metrics: this._metrics,
                savedAt: new Date().toISOString()
            };

            const fullPath = path.join(this.configDir, this.persistPath);
            this._pendingSave = atomicWrite(fullPath, JSON.stringify(data, null, 2))
                .then(() => {
                    const duration = Date.now() - startTime;
                    this._metrics.lastSaveDuration = duration;
                    this._metrics.saveCount++;

                    if (duration > SLOW_SAVE_THRESHOLD_MS) {
                        this._log('warn', `Slow save detected: ${duration}ms`, { duration });
                    } else {
                        this._log('debug', 'Cost data saved', { duration, ms: duration });
                    }
                })
                .catch((err) => {
                    this._metrics.errorCount++;
                    this._log('error', `Failed to save cost data: ${err.message}`);
                })
                .finally(() => {
                    this._pendingSave = null;
                });
        } catch (err) {
            this._metrics.errorCount++;
            this._log('error', `Failed to serialize cost data: ${err.message}`);
        }
    }

    /**
     * Wait for any pending save to complete and perform immediate save
     */
    async flush() {
        // Cancel any debounced save and perform immediate save
        if (this._saveTimeout) {
            clearTimeout(this._saveTimeout);
            this._saveTimeout = null;
        }

        // Wait for any in-flight save to complete first, then do a fresh
        // save with the latest data.  Without this ordering, _performSave()
        // would early-return (line 794) when _pendingSave is set, silently
        // discarding data accumulated since the in-flight save began.
        if (this._pendingSave) {
            await this._pendingSave;
        }

        if (this.persistPath && !this.destroyed) {
            await this._performSave();
        }

        // Wait for the save we just triggered
        if (this._pendingSave) {
            await this._pendingSave;
        }
    }

    /**
     * Destroy the tracker, flushing any pending writes
     */
    async destroy() {
        // Cancel any debounced save
        if (this._saveTimeout) {
            clearTimeout(this._saveTimeout);
            this._saveTimeout = null;
        }

        // Flush BEFORE marking destroyed so the final save goes through
        await this.flush();
        this.destroyed = true;
    }

    /**
     * Load from disk
     */
    _load() {
        if (!this.persistPath) return;

        try {
            const fullPath = path.join(this.configDir, this.persistPath);
            if (fs.existsSync(fullPath)) {
                const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));

                const version = data.schemaVersion || 0;
                if (version > COST_SCHEMA_VERSION) {
                    this._log('warn', `Cost data has newer schema (v${version}), loading with best effort`);
                }

                try {
                    this.usage = data.usage || this.usage;
                    const loadedByKeyId = new LRUMap(1000);
                    for (const [k, v] of Object.entries(data.byKeyId || {})) loadedByKeyId.set(k, v);
                    this.byKeyId = loadedByKeyId;
                    const loadedTenants = new LRUMap(1000);
                    for (const [k, v] of Object.entries(data.costsByTenant || {})) loadedTenants.set(k, v);
                    this.costsByTenant = loadedTenants;
                    this.hourlyHistory = data.hourlyHistory || [];
                    if (data.costTimeSeries && data.costTimeSeries.times) {
                        this.costTimeSeries = data.costTimeSeries;
                    }
                    this._lastReset = data._lastReset || this._lastReset;

                    // Load metrics if available (schema v2+)
                    if (data.metrics) {
                        this._metrics = { ...this._metrics, ...data.metrics };
                    }

                    this._log('info', 'Loaded cost data from disk');
                } catch (loadErr) {
                    this._log('warn', `Cost data has corrupted fields, using defaults: ${loadErr.message}`);
                }

                // Check for period resets after loading
                this._checkPeriodReset();
            }
        } catch (err) {
            this._metrics.errorCount++;
            this._log('error', `Failed to load cost data: ${err.message}`);
        }
    }

    /**
     * Get metrics and observability data
     * @returns {Object} Metrics including record counts, save stats, errors
     */
    getMetrics() {
        // Estimate memory usage (rough approximation)
        const estimatedMemoryBytes =
            (this.byKeyId.size * 200) + // Approx 200 bytes per key entry
            (this.costsByTenant.size * 300) + // Approx 300 bytes per tenant entry
            (this.hourlyHistory.length * 150) + // Approx 150 bytes per history entry
            1000; // Base overhead

        return {
            ...this._metrics,
            estimatedMemoryKB: Math.round(estimatedMemoryBytes / 1024),
            currentKeys: this.byKeyId.size,
            currentTenants: this.costsByTenant.size,
            historyEntries: this.hourlyHistory.length,
            hasPendingSave: !!this._pendingSave,
            hasScheduledSave: !!this._saveTimeout
        };
    }

    /**
     * Periodically save data (call this from stats auto-save)
     * Now uses debounced saving for better performance
     */
    periodicSave() {
        this._save();
    }

    /**
     * Reset all cost tracking
     */
    reset() {
        this.usage = {
            today: this._createEmptyPeriod(),
            thisWeek: this._createEmptyPeriod(),
            thisMonth: this._createEmptyPeriod(),
            allTime: this._createEmptyPeriod()
        };
        this.byKeyId.clear();
        this.costsByTenant.clear();
        this.hourlyHistory = [];
        this.costTimeSeries = { times: [], totals: [], byModel: {} };
        this._alertsFired = { daily: new Set(), monthly: new Set() };
        this._save();
        this._log('info', 'Cost tracking reset');
    }
}

module.exports = {
    CostTracker,
    DEFAULT_RATES,
    DEFAULT_MODEL_RATES,
    ALERT_THRESHOLDS
};
