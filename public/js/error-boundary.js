/**
 * error-boundary.js — Error Boundary
 * Phase 6: Split from dashboard.js
 *
 * Provides: window.DashboardErrorBoundary
 * Handles error catching, deduplication, toast display, and benign error filtering.
 * Also includes toast notifications and animated numbers.
 */
(function(window) {
    'use strict';

    var DS = window.DashboardStore;
    var escapeHtml = DS.escapeHtml;
    var TOAST_DISPLAY_DURATION = DS.TOAST_DISPLAY_DURATION;
    var TOAST_ANIMATION_DURATION = DS.TOAST_ANIMATION_DURATION;

    // ========== ERROR BOUNDARY ==========
    function ErrorBoundary() {
        this.lastErrors = new Map();
        this.dedupeWindow = TOAST_DISPLAY_DURATION;
    }

    ErrorBoundary.prototype.run = function(component, fn) {
        try {
            return fn();
        } catch (error) {
            this.handleError(error, component);
        }
    };

    ErrorBoundary.prototype.runAsync = async function(component, fn) {
        try {
            return await fn();
        } catch (error) {
            this.handleError(error, component);
        }
    };

    ErrorBoundary.prototype.handleError = function(error, component) {
        var message = error.message || 'Unknown error';
        var now = Date.now();
        var lastTime = this.lastErrors.get(component + ':' + message);

        if (lastTime && now - lastTime < this.dedupeWindow) {
            return;
        }

        this.lastErrors.set(component + ':' + message, now);

        // Filter benign errors
        if (this.isBenign(error)) {
            console.warn('[ErrorBoundary] Benign error filtered:', error);
            return;
        }

        // Show toast
        if (typeof showToast === 'function') {
            showToast(message.slice(0, 100), 'error');
        }

        if (window.__DASHBOARD_DEBUG__) {
            window.__DASHBOARD_DEBUG__.errors.toastsShown++;
            window.__DASHBOARD_DEBUG__.errors.lastToast = message;
        }

        console.error('[ErrorBoundary]', component, error);
    };

    ErrorBoundary.prototype.isBenign = function(error) {
        var benign = ['AbortError', 'Chart.js', 'ResizeObserver', 'Script error'];
        return benign.some(function(pattern) {
            return error.message?.includes(pattern) || error.name?.includes(pattern);
        });
    };

    var errorBoundary = new ErrorBoundary();

    // ========== TOAST NOTIFICATIONS ==========
    var showToast = window.DashboardUtils?.showToast || function(message, type, duration) {
        type = type || 'info';
        duration = duration || TOAST_DISPLAY_DURATION;
        var container = document.getElementById('toastContainer');
        if (!container) return;
        var toast = document.createElement('div');
        toast.className = 'toast ' + type;

        var icons = {
            success: '\u2713',
            error: '\u2715',
            warning: '\u26A0',
            info: '\u24D8'
        };

        toast.innerHTML = '<div class="toast-icon">' + (icons[type] || icons.info) + '</div>' +
            '<div class="toast-message">' + escapeHtml(message) + '</div>' +
            '<button class="toast-close" data-action="close-toast">\u00D7</button>';

        container.appendChild(toast);

        setTimeout(function() {
            toast.classList.add('removing');
            setTimeout(function() { toast.remove(); }, TOAST_ANIMATION_DURATION);
        }, duration);
    };

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

    // ========== FULLSCREEN CHARTS ==========
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

    // Expose utilities for testing when debug mode is enabled
    if (DS.debugEnabled) {
        window.errorBoundary = errorBoundary;
        window.escapeRegex = DS.escapeRegex;
        window.debounce = DS.debounce;
    }

    // Make showToast globally available
    window.showToast = showToast;

    // ========== EXPORT ==========
    window.DashboardErrorBoundary = {
        ErrorBoundary: ErrorBoundary,
        errorBoundary: errorBoundary,
        showToast: showToast,
        animateNumber: animateNumber,
        toggleFullscreen: toggleFullscreen
    };

})(window);
