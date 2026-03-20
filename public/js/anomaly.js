/**
 * anomaly.js — Anomaly Detection Manager
 * Phase 6: Split from dashboard.js
 *
 * Provides: window.DashboardAnomaly
 * Handles anomaly investigation, sparkline generation, and statistical detection.
 */
(function(window) {
    'use strict';

    function AnomalyDetectionManager() {
        this._abortController = null;
        this.init();
    }

    AnomalyDetectionManager.prototype.init = function() {
        var self = this;

        // Abort any previous listeners before attaching new ones
        if (self._abortController) {
            self._abortController.abort();
        }
        self._abortController = new AbortController();
        var signal = self._abortController.signal;

        self._onInvestigateAnomaly = function(e) {
            self.investigate(e.detail.element);
        };
        window.addEventListener('investigate-anomaly', self._onInvestigateAnomaly, { signal: signal });
    };

    AnomalyDetectionManager.prototype.investigate = function(element) {
        var traceId = element.dataset.traceId || element.dataset.id;
        if (!traceId) return;

        if (typeof window.showToast === 'function') {
            window.showToast('Investigating anomaly for request: ' + traceId);
        }

        window.dispatchEvent(new CustomEvent('open-request-details', {
            detail: { traceId: traceId, focusAnomaly: true }
        }));
    };

    AnomalyDetectionManager.prototype.createSparkline = function(dataPoints) {
        if (dataPoints.length === 0) return '';
        var width = 60;
        var height = 20;
        var max = Math.max.apply(Math, dataPoints);
        var min = Math.min.apply(Math, dataPoints);
        var range = max - min || 1;

        var denominator = Math.max(1, dataPoints.length - 1);
        var points = dataPoints.map(function(val, i) {
            var x = (i / denominator) * width;
            var y = height - ((val - min) / range) * height;
            return x + ',' + y;
        }).join(' ');

        return '<svg class="anomaly-sparkline" viewBox="0 0 ' + width + ' ' + height + '">' +
            '<path d="M' + points + '" />' +
            '</svg>';
    };

    AnomalyDetectionManager.prototype.detectAnomaly = function(value, baseline, threshold) {
        if (threshold === undefined) threshold = 2;
        var stdDev = Math.sqrt(baseline.reduce(function(sum, val) {
            return sum + Math.pow(val - value, 2);
        }, 0) / baseline.length);
        var mean = baseline.reduce(function(sum, val) { return sum + val; }, 0) / baseline.length;
        return Math.abs(value - mean) > threshold * stdDev;
    };

    AnomalyDetectionManager.prototype.destroy = function() {
        if (this._abortController) {
            this._abortController.abort();
            this._abortController = null;
        }
    };

    // ========== EXPORT ==========
    window.DashboardAnomaly = {
        AnomalyDetectionManager: AnomalyDetectionManager
    };

})(window);
