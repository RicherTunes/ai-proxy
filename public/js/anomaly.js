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
        this.init();
    }

    AnomalyDetectionManager.prototype.init = function() {
        var self = this;
        window.addEventListener('investigate-anomaly', function(e) {
            self.investigate(e.detail.element);
        });
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
        var width = 60;
        var height = 20;
        var max = Math.max.apply(Math, dataPoints);
        var min = Math.min.apply(Math, dataPoints);
        var range = max - min || 1;

        var points = dataPoints.map(function(val, i) {
            var x = (i / (dataPoints.length - 1)) * width;
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

    // ========== EXPORT ==========
    window.DashboardAnomaly = {
        AnomalyDetectionManager: AnomalyDetectionManager
    };

})(window);
