/**
 * dom-cache.js — DOM Cache & Shared Utilities
 * Extracted from data.js Phase 4 split.
 *
 * Provides: DOM element cache, getEl(), format helpers, getAuthHeaders().
 * No dependencies on STATE or other dashboard modules.
 */
(function(window) {
    'use strict';

    // ========== DOM CACHE (hot-path elements) ==========
    var DOM = {
        statusDot: null, statusText: null, pausedBanner: null, pauseBtn: null, resumeBtn: null,
        uptime: null, systemUptime: null,
        requestChart: null, latencyChart: null, errorChart: null, distChart: null,
        routingTierChart: null, routingSourceChart: null, routing429Chart: null, histogramChart: null,
        acctTokenChart: null, acctRequestChart: null,
        tenantSelect: null, tenantSelectorContainer: null, tenantKeyCount: null,
        latencyPercentilesSection: null,
        totalTokens: null, inputTokens: null, outputTokens: null, avgTokensPerReq: null, tokenEmptyHint: null,
        errorBreakdownCard: null, errorTimeouts: null, errorHangups: null, errorServer: null,
        errorRateLimited: null, errorOverloaded: null, errorAuth: null,
        clientRequests: null, clientSuccessRate: null,
        keyAttempts: null, inFlightRequests: null,
        queueSize: null, queueMax: null, queueProgress: null, queuePercent: null,
        connections: null, connectionsMax: null,
        healthTotalHangups: null, healthConsecutive: null, healthAgentRecreations: null, healthPoolAvgLatency: null,
        rlKeysAvailable: null, rlKeysInCooldown: null, rlTotal429s: null, rlCooldownList: null,
        healthScoreCard: null, scoreExcellent: null, scoreGood: null, scoreFair: null, scorePoor: null,
        scoreExcellentCount: null, scoreGoodCount: null, scoreFairCount: null, scorePoorCount: null,
        slowKeyEvents: null, slowKeyRecoveries: null,
        poolStatus: null, activeKeysCount: null,
        headerAccountUsage: null, headerAccountTokenPct: null, headerAccountToolPct: null,
        accountUsagePanel: null, accountUsageLevel: null,
        acctTokenPercent: null, acctTokenFill: null, acctTokenLabel: null,
        acctToolUsed: null, acctToolRemaining: null, acctRequests24h: null, acctResetTime: null,
        acctTokenChartRange: null, acctRequestChartRange: null,
        acctDetailLimits: null, acctTierStatus: null, acctKeyHealth: null,
        acctDetailToolBreakdown: null, acctDetailsSection: null, acctDetailsBtn: null,
        healthScoreBadge: null,
        distChartEmpty: null, distChartCard: null, requestChartEmpty: null
    };

    function cacheDomRefs() {
        var elId;
        for (elId in DOM) {
            if (Object.prototype.hasOwnProperty.call(DOM, elId)) {
                DOM[elId] = document.getElementById(elId);
            }
        }
    }

    function getEl(id) {
        if (DOM[id] !== undefined && DOM[id] !== null) {
            return DOM[id];
        }
        var el = document.getElementById(id);
        if (el) { DOM[id] = el; }
        return el;
    }

    // ========== FORMAT HELPERS ==========
    function formatUptime(seconds) {
        if (seconds < 60) return seconds + 's';
        if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
        var h = Math.floor(seconds / 3600);
        var m = Math.floor((seconds % 3600) / 60);
        return h + 'h ' + m + 'm';
    }

    function formatNumber(num) {
        if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
        if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
        return String(num);
    }

    function formatUptimeShort(seconds) {
        if (!seconds || seconds < 0) return '0s';
        if (seconds < 60) return Math.floor(seconds) + 's';
        if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
        if (seconds < 86400) return Math.floor(seconds / 3600) + 'h';
        return Math.floor(seconds / 86400) + 'd';
    }

    function getHealthScoreClass(score) {
        if (score >= 80) return 'excellent';
        if (score >= 60) return 'good';
        if (score >= 40) return 'fair';
        return 'poor';
    }

    function getAuthHeaders() {
        var headers = {};
        var token = localStorage.getItem('adminToken');
        if (token) headers['x-admin-token'] = token;
        return headers;
    }

    // ========== ANIMATED NUMBERS ==========
    var numberTransitions = new Map();

    function animateNumber(elementId, newValue, suffix, duration) {
        suffix = suffix || '';
        duration = duration || 600;
        var element = document.getElementById(elementId);
        if (!element) return;

        var currentValue = parseFloat(element.textContent) || 0;
        if (currentValue === newValue) return;

        if (numberTransitions.has(elementId)) {
            cancelAnimationFrame(numberTransitions.get(elementId));
        }

        var startTime = performance.now();
        var startValue = currentValue;
        var change = newValue - startValue;

        function update(currentTime) {
            var elapsed = currentTime - startTime;
            var progress = Math.min(elapsed / duration, 1);
            var eased = 1 - Math.pow(1 - progress, 3);
            var current = startValue + change * eased;

            if (Number.isInteger(newValue)) {
                element.textContent = Math.round(current) + suffix;
            } else if (suffix === '%') {
                element.textContent = current.toFixed(1) + suffix;
            } else {
                element.textContent = current.toFixed(0) + suffix;
            }

            if (progress < 1) {
                numberTransitions.set(elementId, requestAnimationFrame(update));
            } else {
                numberTransitions.delete(elementId);
            }
        }

        numberTransitions.set(elementId, requestAnimationFrame(update));
    }

    // ========== FULLSCREEN ==========
    function toggleFullscreen(containerId) {
        var container = document.getElementById(containerId);
        if (container) {
            container.classList.toggle('fullscreen');
            if (container.classList.contains('fullscreen')) {
                document.addEventListener('keydown', function escHandler(e) {
                    if (e.key === 'Escape') {
                        container.classList.remove('fullscreen');
                        document.removeEventListener('keydown', escHandler);
                    }
                });
            }
        }
    }

    // ========== EXPORT ==========
    window.DashboardDOM = {
        DOM: DOM,
        cacheDomRefs: cacheDomRefs,
        getEl: getEl,
        formatUptime: formatUptime,
        formatNumber: formatNumber,
        formatUptimeShort: formatUptimeShort,
        getHealthScoreClass: getHealthScoreClass,
        getAuthHeaders: getAuthHeaders,
        animateNumber: animateNumber,
        toggleFullscreen: toggleFullscreen
    };

})(window);
