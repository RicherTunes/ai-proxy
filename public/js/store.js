/**
 * store.js — Central State Management
 * Phase 6: Split from dashboard.js
 *
 * Provides: window.DashboardStore (STATE, store, Actions, ActionTypes)
 * Also exposes shared utilities, constants, and helpers used across modules.
 */
(function(window) {
    'use strict';

    // ========== SECURITY UTILITIES ==========
    var escapeHtml = window.DashboardUtils?.escapeHtml || function(str) {
        if (str === null || str === undefined) return '';
        var div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    };

    // ========== MODEL DISPLAY NAME ==========
    var chipModelName = window.DashboardUtils?.chipModelName || function(name) {
        if (!name) return '?';
        var stripped = name.replace(/-\d{8,}$/, '');
        stripped = stripped.replace(/(claude-[a-z]+-\d)-(\d)$/, '$1.$2');
        return stripped;
    };

    // ========== TIME FORMATTING UTILITY ==========
    var formatTimestamp = window.DashboardUtils?.formatTimestamp || function(ts, options) {
        if (ts == null) return '-';
        var d = new Date(ts);
        if (isNaN(d.getTime())) return '-';
        if (options && options.full) return d.toLocaleString();
        if (options && options.compact) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return d.toLocaleTimeString();
    };

    // ========== STATE RENDERERS ==========
    var renderEmptyState = window.DashboardUtils?.renderEmptyState || function(message, options) {
        options = options || {};
        var icon = options.icon || '\u2014';
        return '<div class="state-empty"><span class="state-icon">' + icon +
            '</span><span class="state-message">' + escapeHtml(message) + '</span></div>';
    };

    var renderLoadingState = window.DashboardUtils?.renderLoadingState || function(message) {
        message = message || 'Loading...';
        return '<div class="state-loading"><div class="spinner"></div>' +
            '<span class="state-message">' + escapeHtml(message) + '</span></div>';
    };

    var renderErrorState = window.DashboardUtils?.renderErrorState || function(error, options) {
        options = options || {};
        var retry = options.retryable
            ? '<button class="btn btn-small" onclick="location.reload()">Retry</button>'
            : '';
        return '<div class="state-error"><span class="state-icon">\u26A0</span>' +
            '<span class="state-message">' + escapeHtml(error) + '</span>' + retry + '</div>';
    };

    var renderTableEmptyState = function(columnCount, message, options) {
        return '<tr><td colspan="' + columnCount + '">' + renderEmptyState(message, options) + '</td></tr>';
    };

    // ========== ERROR CATEGORIZATION ==========
    var categorizeError = function(err) {
        if (!err) return 'unknown';
        if (err.name === 'AbortError' || err.message?.includes('abort')) return 'cancelled';
        if (err.message?.includes('fetch') || err.message?.includes('network') || err.message?.includes('ECONNREFUSED')) return 'network';
        if (err.message?.includes('timeout') || err.message?.includes('ETIMEDOUT')) return 'timeout';
        if (err.status || err.statusCode) {
            var status = err.status || err.statusCode;
            if (status >= 500) return 'server';
            if (status === 401 || status === 403) return 'auth';
            if (status === 404) return 'notfound';
            if (status >= 400 && status < 500) return 'client';
        }
        return 'unknown';
    };

    var getErrorMessage = function(err, category) {
        var messages = {
            network: 'Network connection failed. Check your connection.',
            timeout: 'Request timed out. Please try again.',
            server: 'Server error. Please try again later.',
            auth: 'Authentication required. Please log in.',
            notfound: 'Resource not found.',
            client: 'Invalid request. Please check your input.',
            cancelled: 'Request cancelled.',
            unknown: err.message || 'An error occurred'
        };
        return messages[category] || messages.unknown;
    };

    // ========== TIME RANGE CONFIGURATION ==========
    var TIME_RANGES = {
        '5m':  { minutes: 5,     label: '(5 min)',     pollInterval: 10000 },
        '15m': { minutes: 15,    label: '(15 min)',    pollInterval: 10000 },
        '1h':  { minutes: 60,    label: '(1 hour)',    pollInterval: 10000 },
        '6h':  { minutes: 360,   label: '(6 hours)',   pollInterval: 30000 },
        '24h': { minutes: 1440,  label: '(24 hours)',  pollInterval: 60000 },
        '7d':  { minutes: 10080, label: '(7 days)',    pollInterval: 60000 }
    };
    var VALID_RANGES = Object.keys(TIME_RANGES);

    // ========== COMMON CONSTANTS ==========
    var CHART_UPDATE_INTERVAL = 10000;
    var HISTORY_FETCH_TIMEOUT = 30000;
    var MAX_RETRY_ATTEMPTS = 3;
    var TOAST_DISPLAY_DURATION = 3000;
    var TOAST_ANIMATION_DURATION = 300; // slideOut animation time before removal
    var HISTORY_HIDE_DELAY = 200; // delay before hiding search history on blur
    var SEARCH_DEBOUNCE_DELAY = 300; // debounce delay for search input
    var DEFAULT_PAGE_SIZE = 50;
    var MAX_HISTORY_ITEMS = 1000;
    var SPARKLINE_WIDTH = 100;
    var SPARKLINE_HEIGHT = 20;
    var ANOMALY_THRESHOLD = 2;

    // ========== FEATURE DETECTION ==========
    var FEATURES = {
        chartJs: typeof Chart !== 'undefined',
        d3: typeof d3 !== 'undefined',
        sortable: typeof Sortable !== 'undefined'
    };

    Object.entries(FEATURES).forEach(function(entry) {
        var feature = entry[0], available = entry[1];
        if (!available) {
            console.warn(feature + ' is not available - ' + feature + ' features will be degraded');
        }
    });

    // ========== STATE MANAGEMENT ==========
    var STATE = {
        keys: { data: [], selected: null },
        keysData: [],
        selectedKeyIndex: null,
        charts: {
            request: null, latency: null, error: null, dist: null,
            routingTier: null, routingSource: null, routing429: null, histogram: null
        },
        settings: { timeRange: '1h', theme: 'dark', density: 'comfortable', autoScroll: true, activeTab: 'live' },
        connection: { status: 'connected', lastUpdate: null, staleData: false },
        history: { points: [], range: '15m', cache: {}, lastTier: null },
        sse: { eventSource: null, connected: false },
        densityOptions: ['compact', 'comfortable', 'spacious'],
        traces: [],
        apiTraces: [],
        circuitEvents: [],
        requestsHistory: [],
        selectedRequestId: null,
        models: [],
        modelsData: {},
        routingData: null
    };

    // ActionTypes for Redux-style store
    var ActionTypes = {
        SSE_CONNECTED: 'SSE_CONNECTED',
        SSE_DISCONNECTED: 'SSE_DISCONNECTED',
        SSE_MESSAGE_RECEIVED: 'SSE_MESSAGE_RECEIVED',
        REQUEST_RECEIVED: 'REQUEST_RECEIVED',
        KPI_UPDATED: 'KPI_UPDATED',
        SELECT_REQUEST: 'SELECT_REQUEST',
        CLEAR_GAP_DETECTED: 'CLEAR_GAP_DETECTED'
    };

    // Redux-style store for state management
    var store = {
        getState: function() {
            return {
                requests: { items: STATE.requestsHistory },
                connection: {
                    status: STATE.connection.status,
                    clientId: STATE.sse.clientId || null,
                    lastSeq: STATE.sse.lastSeq || 0,
                    lastRequestSeq: STATE.sse.lastRequestSeq || 0,
                    lastTs: STATE.sse.lastTs || null,
                    gapDetected: STATE.sse.gapDetected || false
                },
                selectedRequestId: STATE.selectedRequestId
            };
        },
        dispatch: function(action) {
            switch (action.type) {
                case ActionTypes.SELECT_REQUEST:
                    STATE.selectedRequestId = action.payload;
                    break;
                case ActionTypes.SSE_CONNECTED:
                    STATE.connection.status = 'connected';
                    STATE.sse.clientId = action.payload.clientId;
                    STATE.sse.connected = true;
                    if (action.payload.recentRequests && action.payload.recentRequests.length > 0) {
                        var existingById = new Map(STATE.requestsHistory.map(function(r) {
                            return [r.requestId || (r.timestamp + '-' + (r.keyIndex ?? 0)), r];
                        }));
                        for (var i = 0; i < action.payload.recentRequests.length; i++) {
                            var req = action.payload.recentRequests[i];
                            var id = req.requestId || (req.timestamp + '-' + (req.keyIndex ?? 0));
                            if (!existingById.has(id)) {
                                existingById.set(id, req);
                            }
                        }
                        STATE.requestsHistory = Array.from(existingById.values());
                    }
                    break;
                case ActionTypes.SSE_DISCONNECTED:
                    STATE.connection.status = 'disconnected';
                    STATE.sse.connected = false;
                    STATE.sse.clientId = null;
                    break;
                case ActionTypes.SSE_MESSAGE_RECEIVED: {
                    var seq = action.payload.seq;
                    var ts = action.payload.ts;
                    var eventType = action.payload.eventType;
                    STATE.sse.lastSeq = seq;
                    STATE.sse.lastTs = ts;
                    if (eventType === 'request') {
                        var expectedSeq = (STATE.sse.lastRequestSeq || 0) + 1;
                        if (seq > expectedSeq) {
                            STATE.sse.gapDetected = true;
                        }
                        STATE.sse.lastRequestSeq = seq;
                    }
                    break;
                }
                case ActionTypes.REQUEST_RECEIVED:
                    STATE.requestsHistory.push(action.payload);
                    if (STATE.requestsHistory.length > MAX_HISTORY_ITEMS) {
                        STATE.requestsHistory = STATE.requestsHistory.slice(-MAX_HISTORY_ITEMS);
                    }
                    if (store._onRequestReceived) {
                        store._onRequestReceived(action.payload);
                    }
                    break;
                case ActionTypes.CLEAR_GAP_DETECTED:
                    STATE.sse.gapDetected = false;
                    break;
            }
            return action;
        }
    };

    // Initialize SSE state properties
    STATE.sse.clientId = null;
    STATE.sse.lastSeq = 0;
    STATE.sse.lastRequestSeq = 0;
    STATE.sse.lastTs = null;
    STATE.sse.gapDetected = false;

    var Actions = {
        selectRequest: function(requestId) { return { type: ActionTypes.SELECT_REQUEST, payload: requestId }; },
        sseConnected: function(payload) { return { type: ActionTypes.SSE_CONNECTED, payload: payload }; },
        sseDisconnected: function() { return { type: ActionTypes.SSE_DISCONNECTED }; },
        sseMessageReceived: function(seq, ts, eventType) { return { type: ActionTypes.SSE_MESSAGE_RECEIVED, payload: { seq: seq, ts: ts, eventType: eventType } }; },
        requestReceived: function(request) { return { type: ActionTypes.REQUEST_RECEIVED, payload: request }; },
        clearGapDetected: function() { return { type: ActionTypes.CLEAR_GAP_DETECTED }; }
    };

    // ========== HELPER UTILITIES ==========
    function debounce(fn, delay) {
        var timeoutId;
        return function() {
            var args = arguments;
            var self = this;
            clearTimeout(timeoutId);
            timeoutId = setTimeout(function() { fn.apply(self, args); }, delay);
        };
    }

    function escapeRegex(text) {
        return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function capitalize(str) {
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    function safeParseJson(str, fallback) {
        if (!str) return fallback;
        try { return JSON.parse(str); } catch (e) { return fallback; }
    }

    // Helper to get admin auth token from storage
    function getAdminToken() {
        return sessionStorage.getItem('adminToken') || localStorage.getItem('adminToken') || null;
    }

    // fetchJSON - Consolidated fetch utility with error handling and timeout
    // Options:
    //   - timeout: Request timeout in ms (default 10000)
    //   - requireAuth: If true, include admin auth token header
    //   - headers: Additional headers to include
    async function fetchJSON(url, options) {
        options = options || {};
        var timeout = options.timeout || 10000;
        var requireAuth = options.requireAuth || false;
        delete options.timeout;
        delete options.requireAuth;

        var controller = new AbortController();
        var timeoutId = setTimeout(function() { controller.abort(); }, timeout);

        // Build headers object
        var headers = Object.assign({}, options.headers || {});

        // Add auth token if required and available
        if (requireAuth) {
            var token = getAdminToken();
            if (token) {
                headers['x-admin-token'] = token;
            }
        }

        try {
            var res = await fetch(url, Object.assign({}, options, {
                signal: controller.signal,
                headers: headers
            }));
            clearTimeout(timeoutId);
            if (!res.ok) {
                var errorResult = { __error: true, status: res.status, url: url };
                console.warn('fetchJSON: ' + url + ' returned ' + res.status);
                return errorResult;
            }
            return await res.json();
        } catch (e) {
            if (e.name === 'AbortError') {
                console.warn('fetchJSON: ' + url + ' timed out after ' + timeout + 'ms');
            } else {
                console.warn('fetchJSON: ' + url + ' failed:', e);
            }
            return { __error: true, error: e.message || 'fetch_failed', url: url };
        }
    }

    // Debug mode detection
    var urlParams = new URLSearchParams(window.location.search);
    var debugEnabled = urlParams.get('debug') === '1';

    // Expose for E2E testing and debugging (only when ?debug=1 is present)
    if (debugEnabled) {
        window.__DASHBOARD_STORE__ = store;
        window.__DASHBOARD_ACTIONS__ = Actions;
        window.__DASHBOARD_ACTION_TYPES__ = ActionTypes;
        window.__DASHBOARD_DEBUG__ = window.__DASHBOARD_DEBUG__ || {};
        window.__DASHBOARD_DEBUG__.search = window.__DASHBOARD_DEBUG__.search || { runs: 0, lastQuery: null };
        window.__DASHBOARD_DEBUG__.errors = window.__DASHBOARD_DEBUG__.errors || { toastsShown: 0, lastToast: null };
        window.__DASHBOARD_DEBUG__.loading = window.__DASHBOARD_DEBUG__.loading || { inFlight: 0 };
        console.info('[Dashboard] Debug mode enabled - store exposed on window');
    }

    // ========== EXPORT ==========
    window.DashboardStore = {
        STATE: STATE,
        store: store,
        Actions: Actions,
        ActionTypes: ActionTypes,
        getState: function() { return STATE; },

        // Constants
        TIME_RANGES: TIME_RANGES,
        VALID_RANGES: VALID_RANGES,
        CHART_UPDATE_INTERVAL: CHART_UPDATE_INTERVAL,
        HISTORY_FETCH_TIMEOUT: HISTORY_FETCH_TIMEOUT,
        MAX_RETRY_ATTEMPTS: MAX_RETRY_ATTEMPTS,
        TOAST_DISPLAY_DURATION: TOAST_DISPLAY_DURATION,
        TOAST_ANIMATION_DURATION: TOAST_ANIMATION_DURATION,
        HISTORY_HIDE_DELAY: HISTORY_HIDE_DELAY,
        SEARCH_DEBOUNCE_DELAY: SEARCH_DEBOUNCE_DELAY,
        DEFAULT_PAGE_SIZE: DEFAULT_PAGE_SIZE,
        MAX_HISTORY_ITEMS: MAX_HISTORY_ITEMS,
        SPARKLINE_WIDTH: SPARKLINE_WIDTH,
        SPARKLINE_HEIGHT: SPARKLINE_HEIGHT,
        ANOMALY_THRESHOLD: ANOMALY_THRESHOLD,
        FEATURES: FEATURES,

        // Utilities
        escapeHtml: escapeHtml,
        chipModelName: chipModelName,
        formatTimestamp: formatTimestamp,
        renderEmptyState: renderEmptyState,
        renderLoadingState: renderLoadingState,
        renderErrorState: renderErrorState,
        renderTableEmptyState: renderTableEmptyState,
        categorizeError: categorizeError,
        getErrorMessage: getErrorMessage,
        debounce: debounce,
        escapeRegex: escapeRegex,
        capitalize: capitalize,
        safeParseJson: safeParseJson,
        fetchJSON: fetchJSON,
        getAdminToken: getAdminToken,
        debugEnabled: debugEnabled
    };

})(window);
