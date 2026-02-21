/**
 * Dashboard Utilities Module
 * Reusable UI utilities extracted from dashboard.js
 *
 * This module creates a global DashboardUtils object for compatibility
 * with the existing non-module dashboard.js
 *
 * Utilities extracted:
 * - Security utilities (XSS prevention)
 * - Model name formatting
 * - Time formatting
 * - Toast notifications
 * - State renderers (empty, loading, error)
 * - Fetch wrapper with retry and error handling
 */

// Wrap in IIFE to avoid polluting global scope
// (dashboard.js declares its own const fallbacks for these names)
(function() {
'use strict';

// Create global namespace for utilities
window.DashboardUtils = {};

// ========== SECURITY UTILITIES ==========

/**
 * HTML escape function to prevent XSS attacks
 * @param {string} str - String to escape
 * @returns {string} Escaped HTML string
 */
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}
// Export to global namespace
window.DashboardUtils.escapeHtml = escapeHtml;

// ========== MODEL DISPLAY NAME ==========

/**
 * Compact display name for routing chips: strips date suffixes, normalizes separators
 * @param {string} name - Model name
 * @returns {string} Compact model name
 *
 * Examples:
 * - "claude-sonnet-4-5-20250929" → "claude-sonnet-4.5"
 * - "claude-opus-4-6" → "claude-opus-4.6"
 * - "glm-4.5-air" → "glm-4.5-air" (unchanged)
 */
function chipModelName(name) {
    if (!name) return '?';
    // Strip date suffix (8+ digit suffix like -20250929 or -20251001)
    let stripped = name.replace(/-\d{8,}$/, '');
    // Normalize version separators for claude models: "claude-sonnet-4-5" → "claude-sonnet-4.5"
    stripped = stripped.replace(/(claude-[a-z]+-\d)-(\d)$/, '$1.$2');
    return stripped;
}
// Export to global namespace
window.DashboardUtils.chipModelName = chipModelName;

// ========== TIME FORMATTING UTILITY ==========

/**
 * Format timestamp for display
 * @param {number|string|Date} ts - Timestamp
 * @param {Object} options - Formatting options
 * @param {boolean} options.full - Full date/time string
 * @param {boolean} options.compact - Compact time only (HH:MM)
 * @returns {string} Formatted time string
 */
function formatTimestamp(ts, options) {
    if (ts == null) return '-';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '-';
    if (options && options.full) return d.toLocaleString();
    if (options && options.compact) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleTimeString();
}
// Export to global namespace
window.DashboardUtils.formatTimestamp = formatTimestamp;

// ========== TOAST NOTIFICATIONS ==========

var TOAST_DISPLAY_DURATION = 3000;
var TOAST_ANIMATION_DURATION = 300; // slideOut animation time before removal

/**
 * Show toast notification
 * @param {string} message - Message to display
 * @param {string} type - Toast type: success, error, warning, info
 * @param {number} duration - Display duration in ms
 */
function showToast(message, type, duration) {
    type = type || 'info';
    duration = duration || TOAST_DISPLAY_DURATION;
    const container = document.getElementById('toastContainer');
    if (!container) {
        console.error('Toast container not found');
        return;
    }

    const toast = document.createElement('div');
    toast.className = 'toast ' + type;

    const icons = {
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
}
// Export to global namespace
window.DashboardUtils.showToast = showToast;

// ========== STATE RENDERERS ==========

/**
 * Render empty state with consistent styling
 * @param {string} message - Message to display
 * @param {Object} options - Optional config
 * @param {string} options.icon - Icon character (default: '—')
 * @returns {string} HTML string
 */
function renderEmptyState(message, options) {
    options = options || {};
    var icon = options.icon || '\u2014';
    return '<div class="state-empty">' +
        '<span class="state-icon">' + icon + '</span>' +
        '<span class="state-message">' + escapeHtml(message) + '</span>' +
        '</div>';
}
// Export to global namespace
window.DashboardUtils.renderEmptyState = renderEmptyState;

/**
 * Render loading state
 * @param {string} message - Optional message (default: 'Loading...')
 * @returns {string} HTML string
 */
function renderLoadingState(message) {
    message = message || 'Loading...';
    return '<div class="state-loading">' +
        '<div class="spinner"></div>' +
        '<span class="state-message">' + escapeHtml(message) + '</span>' +
        '</div>';
}
// Export to global namespace
window.DashboardUtils.renderLoadingState = renderLoadingState;

/**
 * Render error state
 * @param {string} error - Error message
 * @param {Object} options - Optional config
 * @param {boolean} options.retryable - Show retry button (default: false)
 * @returns {string} HTML string
 */
function renderErrorState(error, options) {
    options = options || {};
    var retry = options.retryable
        ? '<button class="btn btn-small" data-action="reload-page">Retry</button>'
        : '';
    return '<div class="state-error">' +
        '<span class="state-icon">\u26A0</span>' +
        '<span class="state-message">' + escapeHtml(error) + '</span>' +
        retry +
        '</div>';
}
// Export to global namespace
window.DashboardUtils.renderErrorState = renderErrorState;

// ========== FETCH WRAPPER ==========

/**
 * Fetch wrapper with retry and error handling
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} retries - Number of retries (default: 3)
 * @param {number} options.timeout - Request timeout in ms (default: 30000)
 * @returns {Promise<Response>} Fetch response
 * @throws {Error} On final failure after all retries
 */
async function fetchWithRetry(url, options, retries) {
    options = options || {};
    retries = retries !== undefined ? retries : 3;
    const timeout = options.timeout || 30000;
    const controller = new AbortController();
    const timeoutId = setTimeout(function() { controller.abort(); }, timeout);

    try {
        for (let i = 0; i <= retries; i++) {
            try {
                const response = await fetch(url, Object.assign({}, options, {
                    signal: controller.signal
                }));
                clearTimeout(timeoutId);

                if (!response.ok) {
                    throw new Error('HTTP ' + response.status + ': ' + response.statusText);
                }
                return response;
            } catch (err) {
                if (i === retries) throw err;
                if (err.name === 'AbortError') throw err;
                // Exponential backoff
                await new Promise(function(r) { setTimeout(r, Math.pow(2, i) * 1000); });
            }
        }
    } finally {
        clearTimeout(timeoutId);
    }
}
// Export to global namespace
window.DashboardUtils.fetchWithRetry = fetchWithRetry;

})();
