/**
 * Predictions Controller Module
 *
 * Handles prediction-related routes extracted from ProxyServer.
 * Provides endpoints for key circuit breaker predictions and predictive scaling data.
 *
 * TDD Phase: Green - Implementation to make tests pass
 */

'use strict';

/**
 * PredictionsController class for prediction-related HTTP endpoints
 */
class PredictionsController {
    /**
     * @param {Object} options - Configuration options
     * @param {Object} options.keyManager - KeyManager instance
     * @param {Object} options.predictiveScaler - PredictiveScaler instance (optional)
     */
    constructor(options = {}) {
        this._keyManager = options.keyManager || null;
        this._predictiveScaler = options.predictiveScaler || null;
    }

    /**
     * Handle /predictions endpoint
     * GET: Return key predictions and scaling data
     * @param {Object} req - HTTP request
     * @param {Object} res - HTTP response
     */
    handlePredictions(req, res) {
        const keyStats = this._keyManager ? this._keyManager.getStats() : [];
        const keyPredictions = keyStats.map(k => ({
            keyIndex: k.index,
            keyPrefix: k.keyPrefix,
            state: k.circuitBreaker.state,
            prediction: k.prediction
        }));

        // Find any critical predictions
        const criticalKeys = keyPredictions.filter(p =>
            p.prediction.level === 'CRITICAL' || p.prediction.level === 'WARNING'
        );

        // Add predictive scaling data
        let scaling = null;
        if (this._predictiveScaler) {
            scaling = {
                predictions: this._predictiveScaler.predict(),
                recommendations: this._predictiveScaler.getRecommendations(),
                trend: this._predictiveScaler.getTrend(),
                patterns: this._predictiveScaler.getPatterns(),
                stats: this._predictiveScaler.getStats(),
                anomalies: this._predictiveScaler.detectAnomalies()
            };
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            keyPredictions,
            summary: {
                healthy: keyPredictions.filter(p => p.prediction.level === 'HEALTHY').length,
                elevated: keyPredictions.filter(p => p.prediction.level === 'ELEVATED').length,
                warning: keyPredictions.filter(p => p.prediction.level === 'WARNING').length,
                critical: keyPredictions.filter(p => p.prediction.level === 'CRITICAL').length
            },
            criticalKeys,
            scaling,
            timestamp: new Date().toISOString()
        }, null, 2));
    }
}

module.exports = {
    PredictionsController
};
