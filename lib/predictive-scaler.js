/**
 * Predictive Scaler - Analyzes historical usage patterns and predicts future demand
 *
 * This module provides intelligent scaling recommendations based on:
 * - Historical usage trends
 * - Time-based patterns (hourly, daily)
 * - Anomaly detection
 * - Capacity forecasting
 *
 * @module predictive-scaler
 */

/**
 * @typedef {Object} UsageMetrics
 * @property {number} requests - Number of requests in the period
 * @property {number} queueSize - Current queue size
 * @property {number} latency - Average latency in ms
 * @property {number} keyUtilization - Key utilization percentage (0-100)
 */

/**
 * @typedef {Object} UsageDataPoint
 * @property {number} timestamp - Unix timestamp in ms
 * @property {UsageMetrics} metrics - Usage metrics
 */

/**
 * @typedef {Object} Prediction
 * @property {number} timestamp - Predicted timestamp
 * @property {number} requests - Predicted request volume
 * @property {number} confidence - Confidence level (0-1)
 * @property {string} basis - Prediction basis (trend/seasonal/baseline)
 */

/**
 * @typedef {Object} Recommendation
 * @property {string} type - Recommendation type (scale_up/scale_down/add_keys/increase_limits)
 * @property {number} priority - Priority level (1-5, 5 is highest)
 * @property {string} reason - Explanation of the recommendation
 * @property {Object} details - Additional details
 */

/**
 * @typedef {Object} Pattern
 * @property {string} type - Pattern type (peak/valley/trend)
 * @property {string} description - Pattern description
 * @property {Array<number>} hours - Affected hours (0-23)
 * @property {number} intensity - Pattern strength (0-1)
 */

/**
 * Predictive Scaler for proactive capacity management
 */
class PredictiveScaler {
  /**
   * Create a new PredictiveScaler
   *
   * @param {Object} config - Configuration options
   * @param {number} [config.historyWindow=7200000] - History window in ms (default: 2 hours)
   * @param {number} [config.predictionHorizon=900000] - Prediction horizon in ms (default: 15 minutes)
   * @param {number} [config.minSamples=10] - Minimum samples needed for prediction
   * @param {number} [config.smoothingFactor=0.3] - Exponential smoothing factor (0-1)
   * @param {number} [config.anomalyThreshold=2.5] - Standard deviations for anomaly detection
   * @param {number} [config.scaleUpThreshold=0.8] - Capacity threshold to trigger scale up
   * @param {number} [config.scaleDownThreshold=0.3] - Capacity threshold to trigger scale down
   */
  constructor(config = {}) {
    this.config = {
      historyWindow: config.historyWindow || 7200000, // 2 hours
      predictionHorizon: config.predictionHorizon || 900000, // 15 minutes
      minSamples: config.minSamples || 10,
      smoothingFactor: config.smoothingFactor || 0.3,
      anomalyThreshold: config.anomalyThreshold || 2.5,
      scaleUpThreshold: config.scaleUpThreshold || 0.8,
      scaleDownThreshold: config.scaleDownThreshold || 0.3
    };

    /** @type {Array<UsageDataPoint>} */
    this.history = [];

    /** @type {Map<number, Array<number>>} Hour -> request counts */
    this.hourlyPatterns = new Map();

    /** @type {number|null} Exponential smoothing state */
    this.smoothedValue = null;

    /** @type {number|null} Trend component */
    this.trendValue = null;
  }

  /**
   * Record a usage data point
   *
   * @param {number} timestamp - Unix timestamp in ms
   * @param {UsageMetrics} metrics - Usage metrics
   */
  recordUsage(timestamp, metrics) {
    // Validate metrics
    if (!metrics || typeof metrics.requests !== 'number') {
      throw new Error('Invalid metrics: requests is required');
    }

    // Add to history
    this.history.push({ timestamp, metrics });

    // Update exponential smoothing
    this._updateSmoothing(metrics.requests);

    // Update hourly patterns
    this._updateHourlyPattern(timestamp, metrics.requests);

    // Clean old history
    this._cleanHistory(timestamp);
  }

  /**
   * Update exponential smoothing with new value
   * @private
   */
  _updateSmoothing(value) {
    // Guard against NaN/Infinity - skip invalid values
    if (!Number.isFinite(value)) {
      return;
    }

    const alpha = this.config.smoothingFactor;

    if (this.smoothedValue === null) {
      // Initialize
      this.smoothedValue = value;
      this.trendValue = 0;
    } else {
      // Double exponential smoothing (Holt's method)
      const prevSmoothed = this.smoothedValue;
      this.smoothedValue = alpha * value + (1 - alpha) * (this.smoothedValue + this.trendValue);
      this.trendValue = alpha * (this.smoothedValue - prevSmoothed) + (1 - alpha) * this.trendValue;

      // Safety check: reset if values become invalid
      if (!Number.isFinite(this.smoothedValue) || !Number.isFinite(this.trendValue)) {
        this.smoothedValue = value;
        this.trendValue = 0;
      }
    }
  }

  /**
   * Update hourly pattern tracking
   * @private
   */
  _updateHourlyPattern(timestamp, requests) {
    const hour = new Date(timestamp).getHours();

    if (!this.hourlyPatterns.has(hour)) {
      this.hourlyPatterns.set(hour, []);
    }

    const hourData = this.hourlyPatterns.get(hour);
    hourData.push(requests);

    // Keep last 30 samples per hour
    if (hourData.length > 30) {
      hourData.shift();
    }
  }

  /**
   * Clean old history outside the window
   * @private
   */
  _cleanHistory(currentTime) {
    const cutoff = currentTime - this.config.historyWindow;
    this.history = this.history.filter(point => point.timestamp >= cutoff);
  }

  /**
   * Predict demand for the next N minutes
   *
   * @param {number} [horizon] - Prediction horizon in ms (defaults to config.predictionHorizon)
   * @returns {Array<Prediction>} Array of predictions
   */
  predict(horizon) {
    horizon = horizon || this.config.predictionHorizon;

    if (this.history.length < this.config.minSamples) {
      return [];
    }

    const now = Date.now();
    const predictions = [];
    const intervals = 5; // Generate 5 prediction points
    const step = horizon / intervals;

    for (let i = 1; i <= intervals; i++) {
      const futureTime = now + (step * i);
      const prediction = this._predictAtTime(futureTime);
      predictions.push(prediction);
    }

    return predictions;
  }

  /**
   * Predict value at specific time
   * @private
   * @returns {Prediction}
   */
  _predictAtTime(timestamp) {
    // Combine trend and seasonal components
    const trendPrediction = this._getTrendPrediction();
    const seasonalFactor = this._getSeasonalFactor(timestamp);
    const baseline = this._getBaselineAverage();

    // Weighted combination
    let predictedRequests = 0;
    let basis = 'baseline';
    let confidence = 0.5;

    if (this.smoothedValue !== null && this.trendValue !== null) {
      // Use trend-adjusted prediction
      const minutesAhead = (timestamp - Date.now()) / 60000;
      predictedRequests = this.smoothedValue + (this.trendValue * minutesAhead);

      // Apply seasonal adjustment
      if (seasonalFactor !== 1) {
        predictedRequests *= seasonalFactor;
        basis = 'seasonal';
        confidence = 0.7;
      } else {
        basis = 'trend';
        confidence = 0.6;
      }
    } else {
      // Fallback to baseline with seasonal adjustment
      predictedRequests = baseline * seasonalFactor;
      confidence = 0.5;
    }

    // Ensure non-negative
    predictedRequests = Math.max(0, predictedRequests);

    return {
      timestamp,
      requests: Math.round(predictedRequests),
      confidence,
      basis
    };
  }

  /**
   * Get trend-based prediction
   * @private
   */
  _getTrendPrediction() {
    if (this.history.length < 2) return 0;

    const recent = this.history.slice(-10);
    const values = recent.map(p => p.metrics.requests);

    return this._linearRegression(values);
  }

  /**
   * Get seasonal factor for a given time
   * @private
   */
  _getSeasonalFactor(timestamp) {
    const hour = new Date(timestamp).getHours();
    const hourData = this.hourlyPatterns.get(hour);

    if (!hourData || hourData.length < 3) {
      return 1; // No seasonal adjustment
    }

    const hourAvg = this._average(hourData);
    const overallAvg = this._getBaselineAverage();

    if (overallAvg === 0) return 1;

    return hourAvg / overallAvg;
  }

  /**
   * Get baseline average from recent history
   * @private
   */
  _getBaselineAverage() {
    if (this.history.length === 0) return 0;

    const values = this.history.map(p => p.metrics.requests);
    return this._average(values);
  }

  /**
   * Get scaling recommendations
   *
   * @returns {Array<Recommendation>} Array of recommendations
   */
  getRecommendations() {
    if (this.history.length < this.config.minSamples) {
      return [];
    }

    const recommendations = [];
    const predictions = this.predict();
    const current = this.history[this.history.length - 1];
    const trend = this.getTrend();

    // Analyze predictions
    if (predictions.length > 0) {
      const avgPredicted = this._average(predictions.map(p => p.requests));
      const currentRequests = current.metrics.requests || 1; // Avoid division by zero

      // Capacity-based recommendations
      if (current.metrics.keyUtilization !== undefined && Number.isFinite(current.metrics.keyUtilization)) {
        const utilization = current.metrics.keyUtilization / 100;
        const predictedGrowth = currentRequests > 0 ? avgPredicted / currentRequests : 1;
        const growthPercent = Math.round((predictedGrowth - 1) * 100);

        if (avgPredicted > currentRequests * 1.3 || utilization > this.config.scaleUpThreshold) {
          recommendations.push({
            type: 'scale_up',
            priority: utilization > 0.9 ? 5 : 3,
            reason: `Predicted demand increase of ${growthPercent}% with ${Math.round(current.metrics.keyUtilization)}% utilization`,
            details: {
              currentUtilization: current.metrics.keyUtilization,
              predictedGrowth
            }
          });
        } else if (avgPredicted < currentRequests * 0.5 && utilization < this.config.scaleDownThreshold) {
          recommendations.push({
            type: 'scale_down',
            priority: 2,
            reason: `Predicted demand decrease with only ${Math.round(current.metrics.keyUtilization)}% utilization`,
            details: {
              currentUtilization: current.metrics.keyUtilization,
              predictedGrowth
            }
          });
        }
      }
    }

    // Latency-based recommendations
    if (current.metrics.latency !== undefined) {
      const latencyTrend = this._getLatencyTrend();

      if (latencyTrend > 1.2) {
        recommendations.push({
          type: 'add_keys',
          priority: 4,
          reason: `Latency trending up by ${Math.round((latencyTrend - 1) * 100)}%`,
          details: {
            currentLatency: current.metrics.latency,
            latencyTrend
          }
        });
      }
    }

    // Queue-based recommendations
    if (current.metrics.queueSize !== undefined && current.metrics.queueSize > 0) {
      const queueTrend = this._getQueueTrend();

      if (queueTrend > 1.5) {
        recommendations.push({
          type: 'increase_limits',
          priority: 5,
          reason: `Queue growing rapidly (${Math.round((queueTrend - 1) * 100)}% increase)`,
          details: {
            currentQueueSize: current.metrics.queueSize,
            queueTrend
          }
        });
      }
    }

    // Trend-based recommendations
    if (trend.direction === 'increasing' && trend.strength > 0.7) {
      recommendations.push({
        type: 'scale_up',
        priority: 3,
        reason: `Strong upward trend detected (${Math.round(trend.strength * 100)}% confidence)`,
        details: {
          trendDirection: trend.direction,
          trendStrength: trend.strength
        }
      });
    }

    // Sort by priority (highest first)
    recommendations.sort((a, b) => b.priority - a.priority);

    return recommendations;
  }

  /**
   * Get latency trend
   * @private
   */
  _getLatencyTrend() {
    if (this.history.length < 5) return 1;

    const recent = this.history.slice(-5).map(p => p.metrics.latency).filter(l => l !== undefined);
    if (recent.length < 2) return 1;

    const firstHalf = this._average(recent.slice(0, Math.floor(recent.length / 2)));
    const secondHalf = this._average(recent.slice(Math.floor(recent.length / 2)));

    if (firstHalf === 0) return 1;
    return secondHalf / firstHalf;
  }

  /**
   * Get queue trend
   * @private
   */
  _getQueueTrend() {
    if (this.history.length < 5) return 1;

    const recent = this.history.slice(-5).map(p => p.metrics.queueSize).filter(q => q !== undefined);
    if (recent.length < 2) return 1;

    const firstHalf = this._average(recent.slice(0, Math.floor(recent.length / 2)));
    const secondHalf = this._average(recent.slice(Math.floor(recent.length / 2)));

    if (firstHalf === 0) return secondHalf > 0 ? 2 : 1;
    return secondHalf / firstHalf;
  }

  /**
   * Detect usage patterns
   *
   * @returns {Array<Pattern>} Detected patterns
   */
  getPatterns() {
    if (this.history.length < this.config.minSamples) {
      return [];
    }

    const patterns = [];

    // Detect peak hours
    const peakHours = this._detectPeakHours();
    if (peakHours.hours.length > 0) {
      patterns.push({
        type: 'peak',
        description: `High usage during hours ${peakHours.hours.join(', ')}`,
        hours: peakHours.hours,
        intensity: peakHours.intensity
      });
    }

    // Detect valley hours
    const valleyHours = this._detectValleyHours();
    if (valleyHours.hours.length > 0) {
      patterns.push({
        type: 'valley',
        description: `Low usage during hours ${valleyHours.hours.join(', ')}`,
        hours: valleyHours.hours,
        intensity: valleyHours.intensity
      });
    }

    // Detect overall trend
    const trend = this.getTrend();
    if (trend.strength > 0.5) {
      patterns.push({
        type: 'trend',
        description: `${trend.direction} trend with ${Math.round(trend.strength * 100)}% confidence`,
        hours: [],
        intensity: trend.strength
      });
    }

    return patterns;
  }

  /**
   * Detect peak hours
   * @private
   */
  _detectPeakHours() {
    const hourAverages = new Map();
    let totalAvg = 0;
    let count = 0;

    // Calculate average for each hour
    for (const [hour, values] of this.hourlyPatterns.entries()) {
      if (values.length >= 3) {
        const avg = this._average(values);
        hourAverages.set(hour, avg);
        totalAvg += avg;
        count++;
      }
    }

    if (count === 0) return { hours: [], intensity: 0 };
    totalAvg /= count;

    // Find hours above threshold
    const threshold = totalAvg * 1.3;
    const peakHours = [];

    for (const [hour, avg] of hourAverages.entries()) {
      if (avg > threshold) {
        peakHours.push(hour);
      }
    }

    return {
      hours: peakHours.sort((a, b) => a - b),
      intensity: peakHours.length > 0 ? Math.min(1, peakHours.length / 24) : 0
    };
  }

  /**
   * Detect valley hours
   * @private
   */
  _detectValleyHours() {
    const hourAverages = new Map();
    let totalAvg = 0;
    let count = 0;

    // Calculate average for each hour
    for (const [hour, values] of this.hourlyPatterns.entries()) {
      if (values.length >= 3) {
        const avg = this._average(values);
        hourAverages.set(hour, avg);
        totalAvg += avg;
        count++;
      }
    }

    if (count === 0) return { hours: [], intensity: 0 };
    totalAvg /= count;

    // Find hours below threshold
    const threshold = totalAvg * 0.5;
    const valleyHours = [];

    for (const [hour, avg] of hourAverages.entries()) {
      if (avg < threshold) {
        valleyHours.push(hour);
      }
    }

    return {
      hours: valleyHours.sort((a, b) => a - b),
      intensity: valleyHours.length > 0 ? Math.min(1, valleyHours.length / 24) : 0
    };
  }

  /**
   * Get current trend
   *
   * @returns {Object} Trend information
   * @property {string} direction - 'increasing', 'decreasing', or 'stable'
   * @property {number} strength - Trend strength (0-1)
   * @property {number} rate - Rate of change (requests per minute)
   */
  getTrend() {
    if (this.history.length < this.config.minSamples) {
      return { direction: 'stable', strength: 0, rate: 0 };
    }

    const values = this.history.map(p => p.metrics.requests);
    const slope = this._linearRegression(values);

    // Calculate trend strength using R-squared
    const strength = this._calculateRSquared(values);

    let direction = 'stable';
    if (Math.abs(slope) > 0.1) {
      direction = slope > 0 ? 'increasing' : 'decreasing';
    }

    return {
      direction,
      strength,
      rate: slope
    };
  }

  /**
   * Get seasonality information
   *
   * @returns {Object} Seasonality data
   * @property {boolean} detected - Whether seasonality is detected
   * @property {Array<Object>} hourlyFactors - Seasonal factors by hour
   */
  getSeasonality() {
    if (this.hourlyPatterns.size < 12) {
      return { detected: false, hourlyFactors: [] };
    }

    const overallAvg = this._getBaselineAverage();
    if (overallAvg === 0) {
      return { detected: false, hourlyFactors: [] };
    }

    const hourlyFactors = [];
    let variationSum = 0;

    for (let hour = 0; hour < 24; hour++) {
      const hourData = this.hourlyPatterns.get(hour);

      if (hourData && hourData.length >= 3) {
        const hourAvg = this._average(hourData);
        const factor = hourAvg / overallAvg;

        hourlyFactors.push({
          hour,
          factor,
          sampleSize: hourData.length
        });

        variationSum += Math.abs(factor - 1);
      }
    }

    // Detect if there's significant variation
    const avgVariation = variationSum / Math.max(1, hourlyFactors.length);
    const detected = avgVariation > 0.2; // 20% variation threshold

    return {
      detected,
      hourlyFactors
    };
  }

  /**
   * Calculate simple moving average
   * @private
   */
  _average(values) {
    if (values.length === 0) return 0;
    return values.reduce((sum, val) => sum + val, 0) / values.length;
  }

  /**
   * Calculate linear regression slope
   * @private
   */
  _linearRegression(values) {
    const n = values.length;
    if (n < 2) return 0;

    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumX2 = 0;

    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += values[i];
      sumXY += i * values[i];
      sumX2 += i * i;
    }

    const denominator = (n * sumX2 - sumX * sumX);
    if (denominator === 0) return 0;

    return (n * sumXY - sumX * sumY) / denominator;
  }

  /**
   * Calculate R-squared for trend strength
   * @private
   */
  _calculateRSquared(values) {
    const n = values.length;
    if (n < 2) return 0;

    const mean = this._average(values);
    const slope = this._linearRegression(values);

    let ssTotal = 0;
    let ssResidual = 0;

    for (let i = 0; i < n; i++) {
      const predicted = mean + slope * (i - n / 2);
      ssTotal += Math.pow(values[i] - mean, 2);
      ssResidual += Math.pow(values[i] - predicted, 2);
    }

    if (ssTotal === 0) return 0;

    return Math.max(0, 1 - (ssResidual / ssTotal));
  }

  /**
   * Detect anomalies in recent data
   *
   * @returns {Array<Object>} Detected anomalies
   */
  detectAnomalies() {
    if (this.history.length < this.config.minSamples) {
      return [];
    }

    const values = this.history.map(p => p.metrics.requests);
    const mean = this._average(values);
    const stdDev = this._standardDeviation(values, mean);

    const anomalies = [];

    for (let i = 0; i < this.history.length; i++) {
      const point = this.history[i];
      const value = point.metrics.requests;
      const zScore = stdDev > 0 ? Math.abs(value - mean) / stdDev : 0;

      if (zScore > this.config.anomalyThreshold) {
        anomalies.push({
          timestamp: point.timestamp,
          value,
          zScore,
          type: value > mean ? 'spike' : 'drop'
        });
      }
    }

    return anomalies;
  }

  /**
   * Calculate standard deviation
   * @private
   */
  _standardDeviation(values, mean) {
    if (values.length === 0) return 0;

    const squaredDiffs = values.map(val => Math.pow(val - mean, 2));
    const variance = this._average(squaredDiffs);

    return Math.sqrt(variance);
  }

  /**
   * Get summary statistics
   *
   * @returns {Object} Summary statistics
   */
  getStats() {
    if (this.history.length === 0) {
      return {
        sampleCount: 0,
        timeSpan: 0,
        baseline: 0,
        peak: 0,
        valley: 0
      };
    }

    const values = this.history.map(p => p.metrics.requests);
    const timestamps = this.history.map(p => p.timestamp);

    return {
      sampleCount: this.history.length,
      timeSpan: Math.max(...timestamps) - Math.min(...timestamps),
      baseline: this._average(values),
      peak: Math.max(...values),
      valley: Math.min(...values),
      trend: this.getTrend(),
      seasonality: this.getSeasonality()
    };
  }

  /**
   * Clear all history and reset state
   */
  reset() {
    this.history = [];
    this.hourlyPatterns.clear();
    this.smoothedValue = null;
    this.trendValue = null;
  }
}

module.exports = { PredictiveScaler };
