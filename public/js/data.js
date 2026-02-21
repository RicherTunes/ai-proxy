/**
 * data.js — Data Fetching, Rendering & Init Orchestration
 * Phase 6: Split from dashboard.js
 * Phase 7: Extracted dom-cache.js, polling.js, traces.js, actions.js
 *
 * Handles: fetchStats, fetchHistory, fetchLogs, fetchModels, fetchTenants,
 * updateUI, updateCharts, initCharts, DOMContentLoaded init handler,
 * issue detection, alert bar, key heatmap, health scoring, account usage.
 *
 * Delegated modules:
 *   dom-cache.js  — DOM cache, format helpers, animateNumber, toggleFullscreen
 *   polling.js    — POLL_FAMILIES registry, backoff, pause/resume lifecycle
 *   traces.js     — Trace table, detail panel, search, export
 *   actions.js    — Control actions, data export, key override modal
 *
 * Dependencies: store.js (STATE), sse.js (connectRequestStream),
 * filters.js (populateModelFilter, initFilterListeners),
 * tier-builder.js (fetchModelRouting, updatePoolCooldownKPI),
 * live-flow.js (renderFallbackChains, renderPoolStatus, etc.),
 * error-boundary.js (showToast)
 */
(function(window) {
    'use strict';

    var DS = window.DashboardStore;
    var STATE = DS.STATE;
    var escapeHtml = DS.escapeHtml;
    var formatTimestamp = DS.formatTimestamp;
    var renderEmptyState = DS.renderEmptyState;
    var renderErrorState = DS.renderErrorState;
    var renderTableEmptyState = DS.renderTableEmptyState;
    var categorizeError = DS.categorizeError;
    var getErrorMessage = DS.getErrorMessage;
    var TIME_RANGES = DS.TIME_RANGES;
    var VALID_RANGES = DS.VALID_RANGES;
    var FEATURES = DS.FEATURES;
    var fetchJSON = DS.fetchJSON;

    var showToast = window.showToast || function() {};

    // Extracted modules (Phase 4 split)
    var DDOM = window.DashboardDOM;
    var cacheDomRefs = DDOM.cacheDomRefs;
    var getEl = DDOM.getEl;
    var formatUptime = DDOM.formatUptime;
    var formatNumber = DDOM.formatNumber;
    var formatUptimeShort = DDOM.formatUptimeShort;
    var getHealthScoreClass = DDOM.getHealthScoreClass;
    var getAuthHeaders = DDOM.getAuthHeaders;
    var animateNumber = DDOM.animateNumber;
    var toggleFullscreen = DDOM.toggleFullscreen;
    var DTraces = window.DashboardTraces;
    var DActions = window.DashboardActions;
    var DPolling = window.DashboardPolling;

    // ========== LOCAL STATE ==========
    // (numberTransitions → dom-cache.js, pollIntervalIds/backoff → polling.js,
    //  currentKeyOverrides/currentEditingKeyIndex → actions.js, currentTraceData → traces.js)
    var historyFetchController = null;
    var historyUpdatePending = false;
    var lastHistoryFetchId = 0;
    var previousIssuesHash = '';
    var lastIssuesStats = null;
    var currentTenant = null;
    var tenantsData = null;
    var autoScrollLogs = true;
    var startupFetchTimeoutIds = [];

    // Chart instances
    var requestChart = null;
    var latencyChart = null;
    var errorChart = null;
    var distChart = null;
    var routingTierChart = null;
    var routingSourceChart = null;
    var routing429Chart = null;
    var histogramChart = null;
    var currentHistogramRange = '15m';
    var acctTokenChart = null;
    var acctRequestChart = null;
    var modelTokenChart = null;
    var costTimeChart = null;

    // Account chart viewport state for horizontal navigation
    var acctChartViewport = {
        windowSize: 168,  // 7 days = 168 hours
        offset: 0         // 0 = latest data, positive = looking at older data
    };

    // Cost chart viewport
    var costChartViewport = {
        windowSize: 168,  // 7 days
        offset: 0
    };

    // Cached cost time-series data (persisted between fetches for nav)
    var costTimeSeriesData = null;

    // Model routing data (local ref)
    var modelRoutingData = null;

    // DOM cache, helpers, animated numbers, fullscreen → extracted to dom-cache.js
    var DOM = DDOM.DOM;
    var getHistoryPollIntervalMs = DPolling.getHistoryPollIntervalMs;

    // ========== CHART THEME ==========
    // Read live CSS variable values for theme-aware chart colors.
    // Falls back to dark theme defaults if getComputedStyle is unavailable.
    function getCSSColor(varName, fallback) {
        try {
            var val = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
            return val || fallback;
        } catch (e) { return fallback; }
    }
    function toRgba(color, alpha) {
        if (color.charAt(0) === '#') {
            var r = parseInt(color.slice(1, 3), 16);
            var g = parseInt(color.slice(3, 5), 16);
            var b = parseInt(color.slice(5, 7), 16);
            return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
        }
        return color.replace(')', ', ' + alpha + ')').replace('rgb(', 'rgba(');
    }
    function getChartColors() {
        return {
            accent:    getCSSColor('--accent', '#06b6d4'),
            accentBg:  toRgba(getCSSColor('--accent', '#06b6d4'), 0.1),
            success:   getCSSColor('--success', '#22c55e'),
            successBg: toRgba(getCSSColor('--success', '#22c55e'), 0.1),
            error:     getCSSColor('--error', '#ef4444'),
            errorBg:   toRgba(getCSSColor('--error', '#ef4444'), 0.1),
            warning:   getCSSColor('--warning', '#f59e0b'),
            warningBg: toRgba(getCSSColor('--warning', '#f59e0b'), 0.1),
            accentSecondary: getCSSColor('--accent-secondary', '#8b5cf6')
        };
    }

    var CHART_THEME = {
        dark:  { grid: 'rgba(255,255,255,0.1)', tick: '#aaa', legendLabel: '#aaa' },
        light: { grid: 'rgba(0,0,0,0.1)',       tick: '#666', legendLabel: '#444' }
    };
    function getChartTheme() {
        return CHART_THEME[STATE.settings.theme] || CHART_THEME.dark;
    }

    function updateChartTheme(theme) {
        var colors = CHART_THEME[theme] || CHART_THEME.dark;
        var cc = getChartColors();
        // Line/bar charts (have scales) — update grid, ticks, AND dataset colors
        [requestChart, latencyChart, errorChart, routing429Chart, histogramChart, acctTokenChart, acctRequestChart, modelTokenChart, costTimeChart].forEach(function(chart) {
            if (!chart || !chart.options.scales) return;
            ['x', 'y'].forEach(function(axis) {
                if (chart.options.scales[axis]) {
                    if (chart.options.scales[axis].grid) chart.options.scales[axis].grid.color = colors.grid;
                    if (chart.options.scales[axis].ticks) chart.options.scales[axis].ticks.color = colors.tick;
                }
            });
        });
        // Update line chart dataset colors to match theme
        if (requestChart && requestChart.data.datasets[0]) {
            requestChart.data.datasets[0].borderColor = cc.accent;
            requestChart.data.datasets[0].backgroundColor = cc.accentBg;
        }
        if (latencyChart && latencyChart.data.datasets[0]) {
            latencyChart.data.datasets[0].borderColor = cc.success;
            latencyChart.data.datasets[0].backgroundColor = cc.successBg;
        }
        if (errorChart && errorChart.data.datasets[0]) {
            errorChart.data.datasets[0].borderColor = cc.error;
            errorChart.data.datasets[0].backgroundColor = cc.errorBg;
        }
        if (routing429Chart && routing429Chart.data.datasets[0]) {
            routing429Chart.data.datasets[0].borderColor = cc.error;
            routing429Chart.data.datasets[0].backgroundColor = cc.errorBg;
            if (routing429Chart.data.datasets[1]) {
                routing429Chart.data.datasets[1].borderColor = cc.warning;
                routing429Chart.data.datasets[1].backgroundColor = cc.warningBg;
            }
        }
        if (histogramChart && histogramChart.data.datasets[0]) {
            histogramChart.data.datasets[0].backgroundColor = cc.accentBg;
            histogramChart.data.datasets[0].borderColor = cc.accent;
        }
        // Update all line/bar charts
        [requestChart, latencyChart, errorChart, routing429Chart, histogramChart, acctTokenChart, acctRequestChart, modelTokenChart, costTimeChart].forEach(function(chart) {
            if (chart) chart.update('none');
        });
        // Doughnut charts (legend labels only)
        [distChart, routingTierChart, routingSourceChart].forEach(function(chart) {
            if (!chart) return;
            try { chart.options.plugins.legend.labels.color = colors.legendLabel; } catch(e) {}
            chart.update('none');
        });
    }

    // ========== CHART LOADING SKELETONS ==========
    function setupChartLoadingSkeletons() {
        // Find all canvas elements with chart IDs and wrap them with skeleton
        var chartIds = [
            'requestChart', 'latencyChart', 'errorChart', 'distChart',
            'routingTierChart', 'routingSourceChart', 'routing429Chart',
            'acctTokenChart', 'acctRequestChart', 'modelTokenChart',
            'costTimeChart', 'histogramChart'
        ];

        chartIds.forEach(function(id) {
            var canvas = document.getElementById(id);
            if (!canvas) return;
            var container = canvas.parentElement;
            if (!container) return;

            // Add loading class to container
            container.classList.add('chart-loading');

            // Create skeleton element
            var skeleton = document.createElement('div');
            skeleton.className = 'chart-skeleton';
            skeleton.id = id + '_skeleton';
            skeleton.innerHTML = '<div class="skeleton-spinner"></div><div class="skeleton-text">Loading chart...</div>';

            // Insert skeleton before canvas
            container.insertBefore(skeleton, canvas);
        });
    }

    // ========== INTERSECTION OBSERVER FOR LAZY CHART RENDERING ==========
    var chartLazyInitObserver = null;
    var pendingChartInits = {};
    var chartsInitialized = false;

    function setupLazyChartInit() {
        if (!('IntersectionObserver' in window)) {
            // Fallback: initialize all charts immediately
            initCharts();
            return;
        }

        var chartContainers = document.querySelectorAll('.chart-container, [data-chart-container]');
        if (chartContainers.length === 0) {
            // No chart containers found, initialize immediately
            initCharts();
            return;
        }

        chartLazyInitObserver = new IntersectionObserver(function(entries) {
            entries.forEach(function(entry) {
                if (entry.isIntersecting) {
                    var container = entry.target;
                    var canvas = container.querySelector('canvas');
                    if (canvas && canvas.id && pendingChartInits[canvas.id]) {
                        // Mark this chart as ready to init
                        pendingChartInits[canvas.id].visible = true;
                    }
                    chartLazyInitObserver.unobserve(container);
                }
            });

            // Check if any visible charts need initialization
            tryInitVisibleCharts();
        }, {
            rootMargin: '100px', // Start loading 100px before entering viewport
            threshold: 0.1
        });

        // Track all chart canvases
        var chartIds = [
            'requestChart', 'latencyChart', 'errorChart', 'distChart',
            'routingTierChart', 'routingSourceChart', 'routing429Chart',
            'acctTokenChart', 'acctRequestChart', 'modelTokenChart',
            'costTimeChart', 'histogramChart'
        ];

        chartIds.forEach(function(id) {
            pendingChartInits[id] = { visible: false };
        });

        // Observe all chart containers
        chartContainers.forEach(function(container) {
            chartLazyInitObserver.observe(container);
        });

        // Initialize charts on first data update regardless
        // This ensures charts are ready when data arrives
        setTimeout(function() {
            if (!chartsInitialized) {
                initCharts();
            }
        }, 1000);
    }

    function tryInitVisibleCharts() {
        if (chartsInitialized) return;

        // If any chart is visible, initialize all charts
        // (simpler than per-chart initialization)
        var hasVisible = Object.keys(pendingChartInits).some(function(id) {
            return pendingChartInits[id].visible;
        });

        if (hasVisible) {
            initCharts();
        }
    }

    function markChartLoaded(canvas) {
        if (!canvas) return;
        var container = canvas.parentElement;
        if (!container) return;

        // Remove loading class
        container.classList.remove('chart-loading');

        // Remove skeleton
        var skeletonId = canvas.id + '_skeleton';
        var skeleton = document.getElementById(skeletonId);
        if (skeleton) {
            skeleton.style.opacity = '0';
            setTimeout(function() { skeleton.remove(); }, 300);
        }

        // Fade in canvas
        canvas.style.opacity = '0';
        setTimeout(function() { canvas.style.transition = 'opacity 0.3s'; canvas.style.opacity = '1'; }, 50);
    }

    // ========== CHART INITIALIZATION ==========
    function initCharts() {
        if (!FEATURES.chartJs) {
            console.warn('Chart.js not available - charts will show degraded tabular data');
            return;
        }

        // Set up loading skeletons for all chart canvases
        setupChartLoadingSkeletons();

        var theme = getChartTheme();
        var chartOptions = {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: {
                    grid: { color: theme.grid },
                    ticks: { color: theme.tick, maxTicksLimit: 8 }
                },
                y: {
                    grid: { color: theme.grid },
                    ticks: { color: theme.tick },
                    beginAtZero: true
                }
            }
        };

        var reqEl = document.getElementById('requestChart');
        if (reqEl) {
            requestChart = new Chart(reqEl, {
                type: 'line',
                data: { labels: [], datasets: [{ data: [], borderColor: '#06b6d4', backgroundColor: 'rgba(6, 182, 212, 0.1)', fill: true, tension: 0.3 }] },
                options: chartOptions
            });
            STATE.charts.request = requestChart;
            markChartLoaded(reqEl);
        }

        var latEl = document.getElementById('latencyChart');
        if (latEl) {
            latencyChart = new Chart(latEl, {
                type: 'line',
                data: { labels: [], datasets: [{ data: [], borderColor: '#22c55e', backgroundColor: 'rgba(34, 197, 94, 0.1)', fill: true, tension: 0.3 }] },
                options: chartOptions
            });
            STATE.charts.latency = latencyChart;
            markChartLoaded(latEl);
        }

        var errEl = document.getElementById('errorChart');
        if (errEl) {
            errorChart = new Chart(errEl, {
                type: 'line',
                data: { labels: [], datasets: [{ data: [], borderColor: '#ef4444', backgroundColor: 'rgba(239, 68, 68, 0.1)', fill: true, tension: 0.3 }] },
                options: Object.assign({}, chartOptions, {
                    scales: Object.assign({}, chartOptions.scales, {
                        y: Object.assign({}, chartOptions.scales.y, {
                            max: 100,
                            ticks: { color: theme.tick, callback: function(value) { return value + '%'; } }
                        })
                    })
                })
            });
            STATE.charts.error = errorChart;
            markChartLoaded(errEl);
        }

        var distEl = document.getElementById('distChart');
        if (distEl) {
            distChart = new Chart(distEl, {
                type: 'doughnut',
                data: { labels: [], datasets: [{ data: [], backgroundColor: ['#06b6d4', '#8b5cf6', '#22c55e', '#f59e0b', '#ef4444', '#ec4899', '#6366f1', '#14b8a6'] }] },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, position: 'right', labels: { color: theme.legendLabel, font: { size: 11 } } } } }
            });
            STATE.charts.dist = distChart;
            markChartLoaded(distEl);
        }

        var tierEl = document.getElementById('routingTierChart');
        if (tierEl) {
            routingTierChart = new Chart(tierEl, {
                type: 'doughnut',
                data: { labels: ['Light', 'Medium', 'Heavy'], datasets: [{ data: [0, 0, 0], backgroundColor: ['#06b6d4', '#f59e0b', '#ef4444'] }] },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, position: 'right', labels: { color: theme.legendLabel, font: { size: 10 } } } } }
            });
            STATE.charts.routingTier = routingTierChart;
            markChartLoaded(tierEl);
        }

        var srcEl = document.getElementById('routingSourceChart');
        if (srcEl) {
            routingSourceChart = new Chart(srcEl, {
                type: 'doughnut',
                data: { labels: ['Override', 'Rule', 'Classifier', 'Default', 'Failover'], datasets: [{ data: [0, 0, 0, 0, 0], backgroundColor: ['#8b5cf6', '#06b6d4', '#22c55e', '#64748b', '#ef4444'] }] },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, position: 'right', labels: { color: theme.legendLabel, font: { size: 10 } } } } }
            });
            STATE.charts.routingSource = routingSourceChart;
            markChartLoaded(srcEl);
        }

        var r429El = document.getElementById('routing429Chart');
        if (r429El) {
            routing429Chart = new Chart(r429El, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [
                        { label: '429s', data: [], borderColor: '#ef4444', backgroundColor: 'rgba(239, 68, 68, 0.1)', fill: true, tension: 0.3 },
                        { label: 'Burst Dampened', data: [], borderColor: '#f59e0b', backgroundColor: 'rgba(245, 158, 11, 0.1)', fill: true, tension: 0.3 }
                    ]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { display: true, position: 'top', labels: { color: theme.legendLabel, font: { size: 10 } } } },
                    scales: {
                        x: { grid: { color: theme.grid }, ticks: { color: theme.tick, maxTicksLimit: 8 } },
                        y: { grid: { color: theme.grid }, ticks: { color: theme.tick }, beginAtZero: true }
                    }
                }
            });
            STATE.charts.routing429 = routing429Chart;
            markChartLoaded(r429El);
        }

        // Account Usage charts
        var acctTokenEl = document.getElementById('acctTokenChart');
        if (acctTokenEl) {
            acctTokenChart = new Chart(acctTokenEl, {
                type: 'line',
                data: { labels: [], datasets: [{ label: 'Tokens', data: [], borderColor: '#8b5cf6', backgroundColor: 'rgba(139, 92, 246, 0.1)', fill: true, tension: 0.3, pointRadius: 0 }] },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { grid: { color: theme.grid }, ticks: { color: theme.tick, maxTicksLimit: 10, maxRotation: 45 } },
                        y: { grid: { color: theme.grid }, ticks: { color: theme.tick, callback: function(v) { if (v >= 1000000) return (v/1000000).toFixed(1)+'M'; if (v >= 1000) return (v/1000).toFixed(0)+'K'; return v; } }, beginAtZero: true }
                    }
                }
            });
            STATE.charts.acctToken = acctTokenChart;
            markChartLoaded(acctTokenEl);
        }

        var acctReqEl = document.getElementById('acctRequestChart');
        if (acctReqEl) {
            acctRequestChart = new Chart(acctReqEl, {
                type: 'line',
                data: { labels: [], datasets: [{ label: 'Requests', data: [], borderColor: '#06b6d4', backgroundColor: 'rgba(6, 182, 212, 0.1)', fill: true, tension: 0.3, pointRadius: 0 }] },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { grid: { color: theme.grid }, ticks: { color: theme.tick, maxTicksLimit: 10, maxRotation: 45 } },
                        y: { grid: { color: theme.grid }, ticks: { color: theme.tick }, beginAtZero: true }
                    }
                }
            });
            STATE.charts.acctRequest = acctRequestChart;
            markChartLoaded(acctReqEl);
        }

        // Per-model token breakdown chart (stacked bar)
        var modelTokenEl = document.getElementById('modelTokenChart');
        if (modelTokenEl) {
            modelTokenChart = new Chart(modelTokenEl, {
                type: 'bar',
                data: { labels: [], datasets: [] },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: {
                        legend: { display: true, position: 'bottom', labels: { color: theme.tick, boxWidth: 10, font: { size: 10 } } }
                    },
                    scales: {
                        x: { stacked: true, grid: { color: theme.grid }, ticks: { color: theme.tick, maxTicksLimit: 12, maxRotation: 45 } },
                        y: { stacked: true, grid: { color: theme.grid }, ticks: { color: theme.tick, callback: function(v) { if (v >= 1000000) return (v/1000000).toFixed(1)+'M'; if (v >= 1000) return (v/1000).toFixed(0)+'K'; return v; } }, beginAtZero: true }
                    }
                }
            });
            STATE.charts.modelToken = modelTokenChart;
            markChartLoaded(modelTokenEl);
        }

        // Cost over time chart (stacked bar by model)
        var costTimeEl = document.getElementById('costTimeChart');
        if (costTimeEl) {
            costTimeChart = new Chart(costTimeEl, {
                type: 'bar',
                data: { labels: [], datasets: [] },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: {
                        legend: { display: true, position: 'bottom', labels: { color: theme.tick, boxWidth: 10, font: { size: 10 } } },
                        tooltip: { callbacks: { label: function(ctx) { return ctx.dataset.label + ': $' + (ctx.parsed.y || 0).toFixed(6); } } }
                    },
                    scales: {
                        x: { stacked: true, grid: { color: theme.grid }, ticks: { color: theme.tick, maxTicksLimit: 12, maxRotation: 45 } },
                        y: { stacked: true, grid: { color: theme.grid }, ticks: { color: theme.tick, callback: function(v) { return '$' + v.toFixed(4); } }, beginAtZero: true }
                    }
                }
            });
            STATE.charts.costTime = costTimeChart;
            markChartLoaded(costTimeEl);
        }
    }

    // ========== TENANT MANAGEMENT ==========
    function fetchTenants() {
        return fetch('/tenants').then(function(res) {
            if (res.ok) return res.json();
            return null;
        }).then(function(data) {
            if (data) { tenantsData = data; updateTenantSelector(); }
        }).catch(function() {
            // Multi-tenant not enabled
        });
    }

    function updateTenantSelector() {
        var select = document.getElementById('tenantSelect');
        var container = document.getElementById('tenantSelectorContainer');
        if (!select || !tenantsData || !tenantsData.enabled) {
            if (container) container.style.display = 'none';
            return;
        }
        if (container) container.style.display = 'flex';
        while (select.options.length > 1) { select.remove(1); }
        var tenants = tenantsData.tenants || {};
        var tenantIds = Object.keys(tenants).sort();
        for (var i = 0; i < tenantIds.length; i++) {
            var opt = document.createElement('option');
            opt.value = tenantIds[i];
            opt.textContent = tenantIds[i];
            if (tenantIds[i] === currentTenant) opt.selected = true;
            select.appendChild(opt);
        }
        updateTenantInfo();
    }

    function selectTenant(tenantId) {
        currentTenant = tenantId || null;
        updateTenantInfo();
        fetchStats();
    }

    function updateTenantInfo() {
        var infoEl = document.getElementById('tenantKeyCount');
        if (!infoEl || !tenantsData) return;
        if (currentTenant && tenantsData.tenants && tenantsData.tenants[currentTenant]) {
            var t = tenantsData.tenants[currentTenant];
            infoEl.textContent = '(' + t.keyCount + ' keys, ' + t.requestCount + ' reqs)';
        } else {
            infoEl.textContent = '(' + (tenantsData.tenantCount || 0) + ' tenants)';
        }
    }

    // ========== DATA FETCHING ==========
    function fetchStats(opts) {
        opts = opts || {};
        var statsUrl = currentTenant ? '/stats?tenant=' + encodeURIComponent(currentTenant) : '/stats';
        return fetch(statsUrl).then(function(res) {
            if (!res.ok) {
                console.error('Stats endpoint returned:', res.status);
                if (window.DashboardSSE) window.DashboardSSE.updateConnectionStatus('error');
                return false;
            }
            return res.json();
        }).then(function(stats) {
            if (!stats || stats === false) return false;
            if (window.DashboardSSE) window.DashboardSSE.updateConnectionStatus('connected');
            STATE.connection.staleData = false;
            STATE.connection.lastRefreshed = Date.now();
            updateUI(stats);
            if (window.DashboardTierBuilder && window.DashboardTierBuilder.updatePoolCooldownKPI) {
                window.DashboardTierBuilder.updatePoolCooldownKPI(stats);
            }
            return true;
        }).catch(function(err) {
            console.error('Failed to fetch stats:', err);
            if (window.DashboardSSE) window.DashboardSSE.updateConnectionStatus('error');
            if (!opts.silent) {
                var category = categorizeError(err);
                var message = getErrorMessage(err, category);
                if (typeof showToast === 'function') showToast(message, 'error');
            }
            return false;
        });
    }

    function fetchModels() {
        return fetchJSON('/models').then(function(data) {
            if (data && data.models) {
                STATE.models = data.models.map(function(m) { return typeof m === 'string' ? m : m.id; });
                STATE.modelsData = {};
                for (var i = 0; i < data.models.length; i++) {
                    var m = data.models[i];
                    var id = typeof m === 'string' ? m : m.id;
                    STATE.modelsData[id] = typeof m === 'string' ? { id: id } : m;
                }
                // Model data loaded into STATE.modelsData
                if (window.DashboardFilters && window.DashboardFilters.populateModelFilter) {
                    window.DashboardFilters.populateModelFilter();
                }
            }
        });
    }

    function fetchHistory() {
        if (historyUpdatePending) return Promise.resolve(true);

        var fetchId = ++lastHistoryFetchId;
        historyUpdatePending = true;

        var range = STATE.settings.timeRange;
        var minutes = TIME_RANGES[range].minutes;

        if (historyFetchController) { historyFetchController.abort(); }
        historyFetchController = new AbortController();
        var signal = historyFetchController.signal;

        var cacheKey = 'history_v3_' + range;
        var cached = STATE.history.cache[cacheKey];
        var now = Date.now();
        var cacheAge = cached ? now - cached.time : Infinity;
        var tierChanged = STATE.history.lastTier !== (cached && cached.data ? cached.data.tier : undefined);

        if (cached && cacheAge < 1000 && !tierChanged) {
            historyUpdatePending = false;
            updateCharts(cached.data);
            return Promise.resolve(true);
        }

        return fetch('/history?minutes=' + minutes, { cache: 'no-store', signal: signal })
            .then(function(res) {
                if (fetchId !== lastHistoryFetchId) return false;
                if (!res.ok) { console.error('History endpoint returned:', res.status); return false; }
                return res.json();
            })
            .then(function(history) {
                if (fetchId !== lastHistoryFetchId) return false;
                if (!history || history === false) return false;
                if (history) {
                    if (!validateHistoryData(history, minutes)) {
                        console.warn('History data validation failed, re-fetching...');
                        STATE.history.cache[cacheKey] = null;
                        return false;
                    }
                    STATE.history.cache[cacheKey] = { time: now, data: history };
                    STATE.history.lastTier = history.tier;
                    updateCharts(history);
                    return true;
                }
                return false;
            })
            .catch(function(err) {
                if (err.name === 'AbortError') return true;
                console.error('Failed to fetch history:', err);
                return false;
            })
            .finally(function() {
                if (fetchId === lastHistoryFetchId) {
                    historyFetchController = null;
                    historyUpdatePending = false;
                }
            });
    }

    function validateHistoryData(history, requestedMinutes) {
        if (!history || !history.points) { console.warn('Invalid history: missing points'); return false; }
        if (history.schemaVersion !== 2) { console.warn('Invalid history: schema version mismatch'); return false; }
        if (history.pointCount === 0) return true;
        var expectedTier;
        if (requestedMinutes <= 60) expectedTier = 'fine';
        else if (requestedMinutes <= 1440) expectedTier = 'medium';
        else expectedTier = 'coarse';
        if (history.tier !== expectedTier) {
            console.warn('Tier mismatch: expected ' + expectedTier + ', got ' + history.tier);
        }
        if (history.tier === 'fine' && history.dataAgeMs > 5000) {
            console.warn('Fine tier data is stale:', history.dataAgeMs, 'ms old');
        }
        return true;
    }

    function fetchLogs() {
        return fetch('/logs?limit=100').then(function(res) {
            if (!res.ok) { console.error('Logs endpoint returned:', res.status); return false; }
            return res.json();
        }).then(function(data) {
            if (data && data.logs) {
                updateLogs(data.logs);
                return true;
            }
            return false;
        }).catch(function(err) {
            console.error('Failed to fetch logs:', err);
            return false;
        });
    }

    // ========== UI RENDERING: updateUI ==========
    function updateUI(stats) {
        STATE.statsData = stats;

        // Status (use cached DOM)
        var isPaused = stats.paused;
        var statusDot = getEl('statusDot');
        var statusText = getEl('statusText');
        if (statusDot) statusDot.className = 'status-dot ' + (isPaused ? 'paused' : 'active');
        if (statusText) statusText.textContent = isPaused ? 'PAUSED' : 'ACTIVE';

        // Track server paused state for smart polling (delegated to polling.js)
        var wasPaused = DPolling.isServerPaused ? DPolling.isServerPaused() : false;
        DPolling.setServerPaused(!!isPaused);
        if (isPaused && !DPolling.isPollingPaused()) pausePolling();
        // Detect external resume: server was paused, now it's not — resume full polling
        if (wasPaused && !isPaused && DPolling.isPollingPaused()) resumePolling();

        // Toggle paused banner
        var pausedBanner = getEl('pausedBanner');
        if (pausedBanner) pausedBanner.style.display = isPaused ? '' : 'none';

        // Toggle body class for dimming
        if (isPaused) {
            document.body.classList.add('proxy-paused');
        } else {
            document.body.classList.remove('proxy-paused');
        }

        // Toggle button visibility (show only relevant button)
        var pauseBtn = getEl('pauseBtn');
        var resumeBtn = getEl('resumeBtn');
        if (pauseBtn) pauseBtn.style.display = isPaused ? 'none' : '';
        if (resumeBtn) resumeBtn.style.display = isPaused ? '' : 'none';

        // Welcome banner — hide after first request
        var welcomeBanner = document.getElementById('welcomeBanner');
        if (welcomeBanner) {
            welcomeBanner.style.display = (stats.totalRequests || 0) === 0 ? '' : 'none';
        }

        // Uptime
        var uptime = stats.uptime || 0;
        var uptimeEl = getEl('uptime');
        if (uptimeEl) uptimeEl.textContent = formatUptime(uptime);
        var systemUptimeEl = getEl('systemUptime');
        if (systemUptimeEl) systemUptimeEl.textContent = formatUptime(uptime);

        // KPIs
        animateNumber('requestsPerMin', stats.requestsPerMinute || 0, '');
        animateNumber('successRate', stats.successRate || 0, '%');
        animateNumber('avgLatency', (stats.latency && stats.latency.avg) ? stats.latency.avg : 0, 'ms');

        // KPI conditional coloring
        var sr = stats.successRate || 100;
        var srEl = document.getElementById('successRate');
        if (srEl) srEl.style.color = sr >= 98 ? 'var(--success)' : sr >= 90 ? 'var(--warning)' : 'var(--danger)';

        var lat = (stats.latency && stats.latency.avg) || 0;
        var latEl = document.getElementById('avgLatency');
        if (latEl) latEl.style.color = lat < 1000 ? 'var(--success)' : lat < 3000 ? 'var(--warning)' : 'var(--danger)';

        var circVal = parseInt((document.getElementById('circuitsRibbonCount') || {}).textContent) || 0;
        var circEl = document.getElementById('circuitsRibbonCount');
        if (circEl) circEl.style.color = circVal > 0 ? 'var(--danger)' : '';

        // Health score badge
        updateHealthScoreBadge(stats);

        // Latency percentiles — dim before first request
        var hasLatency = stats.latency && (stats.latency.p50 || stats.latency.p95 || stats.latency.p99);
        var latencySection = getEl('latencyPercentilesSection');
        if (latencySection) latencySection.style.opacity = hasLatency ? '1' : '0.35';
        animateNumber('p50Latency', (stats.latency && stats.latency.p50) ? stats.latency.p50 : 0, '');
        animateNumber('p95Latency', (stats.latency && stats.latency.p95) ? stats.latency.p95 : 0, '');
        animateNumber('p99Latency', (stats.latency && stats.latency.p99) ? stats.latency.p99 : 0, '');

        // Token usage (use cached DOM)
        var tokens = stats.tokens || {};
        var el;
        el = getEl('totalTokens'); if (el) el.textContent = formatNumber(tokens.totalTokens || 0);
        el = getEl('inputTokens'); if (el) el.textContent = formatNumber(tokens.totalInputTokens || 0);
        el = getEl('outputTokens'); if (el) el.textContent = formatNumber(tokens.totalOutputTokens || 0);
        el = getEl('avgTokensPerReq'); if (el) el.textContent = formatNumber(tokens.avgTotalPerRequest || 0);

        var tokenHint = document.getElementById('tokenEmptyHint');
        if (tokenHint) {
            tokenHint.style.display = (tokens.totalTokens || 0) > 0 ? 'none' : 'block';
        }

        // Error breakdown — hide card when all zeros
        var errors = stats.errors || {};
        var totalErrors = (errors.timeouts || 0) + (errors.socketHangups || 0) + (errors.serverErrors || 0) +
            (errors.rateLimited || 0) + (errors.connectionRefused || 0) + (errors.authErrors || 0);
        var errorCard = document.getElementById('errorBreakdownCard');
        if (errorCard) {
            if (totalErrors === 0) {
                errorCard.classList.add('empty-state-card');
            } else {
                errorCard.classList.remove('empty-state-card');
            }
        }
        el = document.getElementById('errorTimeouts'); if (el) el.textContent = errors.timeouts || 0;
        el = document.getElementById('errorHangups'); if (el) el.textContent = errors.socketHangups || 0;
        el = document.getElementById('errorServer'); if (el) el.textContent = errors.serverErrors || 0;
        el = document.getElementById('errorRateLimited'); if (el) el.textContent = errors.rateLimited || 0;
        el = document.getElementById('errorOverloaded'); if (el) el.textContent = errors.connectionRefused || 0;
        el = document.getElementById('errorAuth'); if (el) el.textContent = errors.authErrors || 0;
        el = document.getElementById('errorRetrySuccessRate'); if (el) el.textContent = (errors.retrySuccessRate != null) ? errors.retrySuccessRate + '%' : '-';
        // Extended error categories
        el = document.getElementById('errorDns'); if (el) el.textContent = errors.dnsErrors || 0;
        el = document.getElementById('errorTls'); if (el) el.textContent = errors.tlsErrors || 0;
        el = document.getElementById('errorBrokenPipe'); if (el) el.textContent = errors.brokenPipe || 0;
        el = document.getElementById('errorStreamClose'); if (el) el.textContent = errors.streamPrematureClose || 0;
        el = document.getElementById('errorHttpParse'); if (el) el.textContent = errors.httpParseError || 0;
        el = document.getElementById('errorClientDisconnect'); if (el) el.textContent = errors.clientDisconnects || 0;
        el = document.getElementById('errorModelCapacity'); if (el) el.textContent = errors.modelAtCapacity || 0;
        el = document.getElementById('errorGiveUps'); if (el) el.textContent = stats.giveUpTracking ? stats.giveUpTracking.total || 0 : 0;

        // AIMD concurrency update
        updateAIMD(stats);

        // Distribution chart
        updateDistributionChart(stats);

        // Request semantics
        var clientReq = stats.clientRequests || {};
        var keyAttempts = stats.keyAttempts || {};
        el = document.getElementById('clientRequests'); if (el) el.textContent = formatNumber(clientReq.total || 0);
        el = document.getElementById('clientSuccessRate'); if (el) el.textContent = (clientReq.successRate || 100) + '%';
        el = document.getElementById('keyAttempts'); if (el) el.textContent = formatNumber(keyAttempts.total || 0);
        el = document.getElementById('inFlightRequests'); if (el) el.textContent = clientReq.inFlight || 0;

        // Queue & backpressure
        var bp = stats.backpressure || {};
        var queue = bp.queue || {};
        el = document.getElementById('queueSize'); if (el) el.textContent = queue.current || 0;
        el = document.getElementById('queueMax'); if (el) el.textContent = queue.max || 100;
        el = document.getElementById('connections'); if (el) el.textContent = bp.activeConnections || 0;
        el = document.getElementById('connectionsMax'); if (el) el.textContent = bp.maxConnections || 100;

        var queuePercent = queue.max > 0 ? (queue.current / queue.max * 100) : 0;
        var queueProgressEl = document.getElementById('queueProgress');
        if (queueProgressEl) {
            queueProgressEl.style.width = queuePercent + '%';
            // Update color based on fill level
            queueProgressEl.className = 'progress-fill';
            if (queuePercent >= 80) {
                queueProgressEl.classList.add('critical');
            } else if (queuePercent >= 50) {
                queueProgressEl.classList.add('warning');
            }
        }
        el = document.getElementById('queuePercent'); if (el) el.textContent = queuePercent.toFixed(0) + '%';

        // Admission hold
        var ah = stats.admissionHold || {};
        el = document.getElementById('admHoldTotal'); if (el) el.textContent = ah.total || 0;
        el = document.getElementById('admHoldSucceeded'); if (el) el.textContent = ah.succeeded || 0;
        el = document.getElementById('admHoldTimedOut'); if (el) el.textContent = ah.timedOut || 0;
        el = document.getElementById('admHoldRejected'); if (el) el.textContent = ah.rejected || 0;
        var ahTier = ah.byTier || {};
        el = document.getElementById('admHoldLight'); if (el) el.textContent = ahTier.light || 0;
        el = document.getElementById('admHoldMedium'); if (el) el.textContent = ahTier.medium || 0;
        el = document.getElementById('admHoldHeavy'); if (el) el.textContent = ahTier.heavy || 0;
        el = document.getElementById('admHoldAvgMs');
        if (el) el.textContent = (ah.total > 0) ? (Math.round(ah.totalHoldMs / ah.total) + 'ms') : '-';

        // Connection health
        var connectionHealth = stats.connectionHealth || {};
        el = document.getElementById('healthTotalHangups'); if (el) el.textContent = connectionHealth.totalHangups || 0;
        el = document.getElementById('healthConsecutive'); if (el) el.textContent = connectionHealth.consecutiveHangups || 0;
        el = document.getElementById('healthAgentRecreations'); if (el) el.textContent = connectionHealth.agentRecreations || 0;
        el = document.getElementById('healthPoolAvgLatency');
        if (el) el.textContent = stats.poolAverageLatency ? (stats.poolAverageLatency.toFixed(0) + 'ms') : '-';

        // Hangup causes breakdown
        var hc = stats.hangupCauses || {};
        el = document.getElementById('hangupStale'); if (el) el.textContent = hc.staleSocketReuse || 0;
        el = document.getElementById('hangupClientAbort'); if (el) el.textContent = hc.clientAbort || 0;
        el = document.getElementById('hangupFresh'); if (el) el.textContent = hc.freshSocketHangup || 0;
        el = document.getElementById('hangupUnknown'); if (el) el.textContent = hc.unknown || 0;

        // Adaptive timeouts
        var at = stats.adaptiveTimeouts || {};
        el = document.getElementById('atAvgTimeout'); if (el) el.textContent = at.avgTimeout ? (Math.round(at.avgTimeout / 1000) + 's') : '-';
        el = document.getElementById('atMinTimeout'); if (el) el.textContent = at.minTimeout ? (Math.round(at.minTimeout / 1000) + 's') : '-';
        el = document.getElementById('atMaxTimeout'); if (el) el.textContent = at.maxTimeout ? (Math.round(at.maxTimeout / 1000) + 's') : '-';
        el = document.getElementById('atUsedCount'); if (el) el.textContent = at.adaptiveTimeoutsUsed || 0;

        // Empty state for connection health
        var connHealthCard = document.querySelector('.info-card:has(#healthTotalHangups)');
        if (!connHealthCard) {
            // Fallback: find by traversal
            var htu = document.getElementById('healthTotalHangups');
            if (htu) connHealthCard = htu.closest('.info-card');
        }
        if (connHealthCard) {
            var totalHangups = connectionHealth.totalHangups || 0;
            if (totalHangups === 0 && (connectionHealth.agentRecreations || 0) === 0) {
                connHealthCard.classList.add('empty-state-card');
            } else {
                connHealthCard.classList.remove('empty-state-card');
            }
        }

        // Retry analytics
        var re = stats.retryEfficiency || {};
        el = document.getElementById('retryTotal'); if (el) el.textContent = errors.totalRetries || 0;
        el = document.getElementById('retrySucceeded'); if (el) el.textContent = errors.retriesSucceeded || 0;
        el = document.getElementById('retryRate'); if (el) el.textContent = (errors.retrySuccessRate != null) ? errors.retrySuccessRate + '%' : '-';
        el = document.getElementById('retrySameModel'); if (el) el.textContent = re.sameModelRetries || 0;
        el = document.getElementById('retryModelSwitches'); if (el) el.textContent = re.totalModelSwitchesOnFailure || 0;
        el = document.getElementById('retryModelsTried'); if (el) el.textContent = re.totalModelsTriedOnFailure || 0;
        el = document.getElementById('retryFailedWithStats'); if (el) el.textContent = re.failedRequestsWithModelStats || 0;
        el = document.getElementById('retryGiveUps'); if (el) el.textContent = stats.giveUpTracking ? stats.giveUpTracking.total || 0 : 0;

        // Retry backoff
        var rb = stats.retryBackoff || {};
        el = document.getElementById('retryAvgBackoff');
        if (el) el.textContent = (rb.delayCount > 0) ? (Math.round(rb.totalDelayMs / rb.delayCount) + 'ms') : '-';

        // Give-up reasons
        var gu = stats.giveUpTracking || {};
        var guReasons = gu.byReason || {};
        el = document.getElementById('giveupMax429Attempts'); if (el) el.textContent = guReasons.max_429_attempts || 0;
        el = document.getElementById('giveupMax429Window'); if (el) el.textContent = guReasons.max_429_window || 0;

        // Telemetry
        var telem = stats.telemetry || {};
        el = document.getElementById('telemetryDropped'); if (el) el.textContent = telem.dropped || 0;
        el = document.getElementById('telemetryPassed'); if (el) el.textContent = telem.passedThrough || 0;

        // Empty state for retry analytics card
        var retryCard = document.getElementById('retryAnalyticsCard');
        if (retryCard) {
            if ((errors.totalRetries || 0) === 0) {
                retryCard.classList.add('empty-state-card');
            } else {
                retryCard.classList.remove('empty-state-card');
            }
        }

        // Rate limit status
        var rlStatus = stats.rateLimitStatus || {};
        el = document.getElementById('rlKeysAvailable'); if (el) el.textContent = rlStatus.keysAvailable || (stats.keys ? stats.keys.length : 0);
        el = document.getElementById('rlKeysInCooldown'); if (el) el.textContent = rlStatus.keysInCooldown || 0;
        el = document.getElementById('rlTotal429s'); if (el) el.textContent = rlStatus.total429s || 0;

        // Cooldown list
        var cooldownList = document.getElementById('rlCooldownList');
        if (cooldownList) {
            if (rlStatus.cooldownKeys && rlStatus.cooldownKeys.length > 0) {
                cooldownList.innerHTML = 'Cooldown: ' + rlStatus.cooldownKeys
                    .map(function(k) { return 'K' + k.index + ' (' + Math.ceil(k.remainingMs / 1000) + 's)'; })
                    .join(', ');
                cooldownList.style.color = 'var(--warning)';
            } else {
                cooldownList.innerHTML = 'All keys available';
                cooldownList.style.color = 'var(--success)';
            }
        }

        // Rate limit tracking details
        var rlt = stats.rateLimitTracking || {};
        el = document.getElementById('rlUpstream429s'); if (el) el.textContent = rlt.upstream429s || 0;
        el = document.getElementById('rlLocal429s'); if (el) el.textContent = rlt.local429s || 0;

        // Health score distribution — hide when no selections yet
        var scoreDist = stats.healthScoreDistribution || {};
        var scoreRanges = scoreDist.selectionsByScoreRange || {};
        var scoreTotal = (scoreRanges.excellent || 0) + (scoreRanges.good || 0) + (scoreRanges.fair || 0) + (scoreRanges.poor || 0);
        var healthScoreCard = document.getElementById('healthScoreCard');
        if (healthScoreCard) {
            if (scoreTotal === 0 && !(scoreDist.slowKeyEvents || 0) && !(scoreDist.slowKeyRecoveries || 0)) {
                healthScoreCard.classList.add('empty-state-card');
            } else {
                healthScoreCard.classList.remove('empty-state-card');
            }
        }
        if (scoreTotal > 0) {
            el = document.getElementById('scoreExcellent'); if (el) el.style.width = ((scoreRanges.excellent / scoreTotal) * 100) + '%';
            el = document.getElementById('scoreGood'); if (el) el.style.width = ((scoreRanges.good / scoreTotal) * 100) + '%';
            el = document.getElementById('scoreFair'); if (el) el.style.width = ((scoreRanges.fair / scoreTotal) * 100) + '%';
            el = document.getElementById('scorePoor'); if (el) el.style.width = ((scoreRanges.poor / scoreTotal) * 100) + '%';
        }
        el = document.getElementById('scoreExcellentCount'); if (el) el.textContent = scoreRanges.excellent || 0;
        el = document.getElementById('scoreGoodCount'); if (el) el.textContent = scoreRanges.good || 0;
        el = document.getElementById('scoreFairCount'); if (el) el.textContent = scoreRanges.fair || 0;
        el = document.getElementById('scorePoorCount'); if (el) el.textContent = scoreRanges.poor || 0;
        el = document.getElementById('slowKeyEvents'); if (el) el.textContent = scoreDist.slowKeyEvents || 0;
        el = document.getElementById('slowKeyRecoveries'); if (el) el.textContent = scoreDist.slowKeyRecoveries || 0;

        // Update health radial indicator
        updateHealthRadial(scoreRanges, scoreTotal);

        // Update heartbeat indicator
        updateHeartbeatIndicator(scoreRanges, scoreTotal);

        // Pool & Keys KPIs (wire to actual data)
        var keysArr = stats.keys || [];
        var inFlightTotal = 0;
        for (var ki = 0; ki < keysArr.length; ki++) {
            inFlightTotal += (keysArr[ki].inFlight || 0);
        }
        el = document.getElementById('poolStatus'); if (el) el.textContent = inFlightTotal + ' active';
        el = document.getElementById('activeKeysCount'); if (el) el.textContent = keysArr.length;

        // Keys heatmap
        STATE.keysData = keysArr;
        updateKeysHeatmap(STATE.keysData);

        if (STATE.selectedKeyIndex !== null && STATE.keysData[STATE.selectedKeyIndex]) {
            updateKeyDetails(STATE.keysData[STATE.selectedKeyIndex]);
        }

        // Account usage (z.ai subscription)
        updateAccountUsage(stats);

        // Per-model breakdown (proxy-level tracking)
        updateModelBreakdown(stats);

        // Tab content
        updateTabContent(stats);

        // Issues panel
        updateIssuesPanel(stats);

        // Alert bar
        updateAlertBar(stats);

        // Last refreshed indicator
        var refreshEl = document.getElementById('lastRefreshedAt');
        if (refreshEl && STATE.connection.lastRefreshed) {
            var ago = Math.round((Date.now() - STATE.connection.lastRefreshed) / 1000);
            if (ago < 5) refreshEl.textContent = 'Live';
            else refreshEl.textContent = ago + 's ago';
            refreshEl.style.color = ago > 10 ? 'var(--warning)' : '';
        }

        // Requests page summary
        updateRequestsPageSummary(stats);
    }

    // ========== ACCOUNT USAGE ==========
    function updateHeaderAccountUsage(au) {
        var pill = document.getElementById('headerAccountUsage');
        if (!pill) return;

        var tokenEl = document.getElementById('headerAccountTokenPct');
        var toolEl = document.getElementById('headerAccountToolPct');
        var tokenPct = 0;
        var toolPct = 0;

        if (!au || !au.quota) {
            if (tokenEl) tokenEl.textContent = '--';
            if (toolEl) toolEl.textContent = '--';
            pill.classList.remove('ok', 'warning', 'danger');
            pill.classList.add('unknown');
            pill.title = 'z.ai usage unavailable';
            return;
        }

        if (au.sourceUnavailable) {
            if (tokenEl) tokenEl.textContent = '--';
            if (toolEl) toolEl.textContent = '--';
            pill.classList.remove('ok', 'warning', 'danger', 'unknown');
            pill.classList.add('danger');
            pill.title = 'z.ai usage source unavailable (all monitor sections failed)';
            return;
        }

        tokenPct = au.quota.tokenUsagePercent || 0;
        toolPct = (au.quota.toolUsage && au.quota.toolUsage.percent) || 0;
        if (tokenEl) tokenEl.textContent = tokenPct + '%T';
        if (toolEl) toolEl.textContent = toolPct + '%U';

        var level = 'ok';
        if (tokenPct >= 90 || toolPct >= 90) level = 'danger';
        else if (tokenPct >= 70 || toolPct >= 70) level = 'warning';
        if (au.partial && level !== 'danger') level = 'warning';
        if (au.stale && level === 'ok') level = 'warning';

        pill.classList.remove('ok', 'warning', 'danger', 'unknown');
        pill.classList.add(level);
        var stateBits = [];
        if (au.partial) stateBits.push('partial');
        if (au.stale) stateBits.push('stale');
        var stateSuffix = stateBits.length ? ' (' + stateBits.join(', ') + ')' : '';
        pill.title = 'z.ai usage — Token: ' + tokenPct + '%, Tools: ' + toolPct + '%' + stateSuffix;
    }

    function updateAccountUsage(stats) {
        var panel = document.getElementById('accountUsagePanel');
        var au = stats.accountUsage;
        updateHeaderAccountUsage(au);

        if (!panel) return;
        if (!au || au.stale === undefined) {
            panel.style.display = 'none';
            return;
        }
        panel.style.display = '';

        var el;
        // Level badge
        el = document.getElementById('accountUsageLevel');
        if (el) el.textContent = au.quota && au.quota.level ? au.quota.level.toUpperCase() : '';

        // Token quota
        var tokenPct = au.quota ? (au.quota.tokenUsagePercent || 0) : 0;
        el = document.getElementById('acctTokenPercent');
        if (el) el.textContent = tokenPct + '%';

        // Progress bar with inline value
        el = document.getElementById('acctTokenFill');
        if (el) {
            el.style.width = Math.min(tokenPct, 100) + '%';
            el.className = 'budget-fill ' + (tokenPct > 80 ? 'danger' : tokenPct > 50 ? 'warning' : 'ok');
            // Show percentage inside bar when wide enough
            var showInline = tokenPct >= 30;
            el.innerHTML = showInline ? '<span class="budget-fill-text">' + tokenPct + '%</span>' : '';
        }
        el = document.getElementById('acctTokenLabel');
        if (el) el.textContent = tokenPct + '% token quota';

        // Tool usage
        var tu = au.quota && au.quota.toolUsage;
        el = document.getElementById('acctToolUsed');
        if (el) el.textContent = tu ? formatNumber(tu.used) : '-';
        el = document.getElementById('acctToolRemaining');
        if (el) el.textContent = tu ? formatNumber(tu.remaining) : '-';

        // Requests 24h
        el = document.getElementById('acctRequests24h');
        if (el) el.textContent = au.modelUsage ? formatNumber(au.modelUsage.totalRequests || 0) : '-';

        // Reset time
        el = document.getElementById('acctResetTime');
        if (el) {
            if (au.quota && au.quota.tokenNextResetAt) {
                var reset = new Date(au.quota.tokenNextResetAt);
                var now = new Date();
                var diffMs = reset - now;
                if (diffMs > 0) {
                    var hours = Math.floor(diffMs / 3600000);
                    var mins = Math.floor((diffMs % 3600000) / 60000);
                    el.textContent = 'Token quota resets in ' + hours + 'h ' + mins + 'm';
                } else {
                    el.textContent = 'Token quota reset pending';
                }
            } else {
                el.textContent = '';
            }
        }

        // Data source health status
        var statusEl = document.getElementById('acctUsageStatus');
        if (statusEl) {
            statusEl.classList.remove('warning', 'danger');
            statusEl.style.display = 'none';
            if (au.sourceUnavailable) {
                statusEl.textContent = 'Usage source unavailable — monitor endpoints failed.';
                statusEl.classList.add('danger');
                statusEl.style.display = '';
            } else if (au.partial) {
                statusEl.textContent = 'Partial usage data — one or more monitor sections failed.';
                statusEl.classList.add('warning');
                statusEl.style.display = '';
            } else if (au.stale) {
                statusEl.textContent = 'Usage data is stale — waiting for a successful refresh.';
                statusEl.classList.add('warning');
                statusEl.style.display = '';
            } else {
                statusEl.textContent = '';
            }
        }

        // Update time-series charts
        var ts = au.modelUsage && au.modelUsage.timeSeries;
        if (ts && ts.times && ts.times.length > 0) {
            // Trim leading nulls so charts start at first activity
            var startIdx = 0;
            var tokens = ts.tokenCounts || [];
            var calls = ts.callCounts || [];
            for (var si = 0; si < tokens.length; si++) {
                if ((tokens[si] !== null && tokens[si] > 0) || (calls[si] !== null && calls[si] > 0)) {
                    startIdx = si;
                    break;
                }
            }
            var trimTimes = ts.times.slice(startIdx);
            var trimTokens = tokens.slice(startIdx);
            var trimCalls = calls.slice(startIdx);

            // Apply viewport window for horizontal navigation
            var totalPoints = trimTimes.length;
            // Clamp offset so viewport doesn't drift past available data
            var maxOffset = Math.max(0, totalPoints - acctChartViewport.windowSize);
            if (acctChartViewport.offset > maxOffset) acctChartViewport.offset = maxOffset;
            var viewEnd = totalPoints - acctChartViewport.offset;
            var viewStart = Math.max(0, viewEnd - acctChartViewport.windowSize);
            viewEnd = Math.min(totalPoints, viewStart + acctChartViewport.windowSize);

            var viewTimes = trimTimes.slice(viewStart, viewEnd);
            var viewTokens = trimTokens.slice(viewStart, viewEnd);
            var viewCalls = trimCalls.slice(viewStart, viewEnd);

            // Format labels: "Feb 20 10:00" from "2026-02-20 10:00"
            var labels = viewTimes.map(function(t) {
                var parts = t.split(' ');
                if (parts.length < 2) return t;
                var dateParts = parts[0].split('-');
                var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                var monthLabel = months[parseInt(dateParts[1], 10) - 1] || dateParts[1];
                return monthLabel + ' ' + parseInt(dateParts[2], 10) + ' ' + parts[1].substring(0, 5);
            });

            // Update range indicator
            var tokenRangeEl = document.getElementById('acctTokenChartRange');
            if (tokenRangeEl && labels.length) {
                tokenRangeEl.textContent = labels[0] + ' \u2014 ' + labels[labels.length - 1];
            }
            var reqRangeEl = document.getElementById('acctRequestChartRange');
            if (reqRangeEl && labels.length) {
                reqRangeEl.textContent = labels[0] + ' \u2014 ' + labels[labels.length - 1];
            }

            if (acctTokenChart) {
                acctTokenChart.data.labels = labels;
                acctTokenChart.data.datasets[0].data = viewTokens;
                acctTokenChart.update('none');
            }
            if (acctRequestChart) {
                acctRequestChart.data.labels = labels;
                acctRequestChart.data.datasets[0].data = viewCalls;
                acctRequestChart.update('none');
            }
        }
    }

    // ========== PER-MODEL BREAKDOWN ==========
    var MODEL_COLORS = [
        '#06b6d4', '#8b5cf6', '#22c55e', '#f59e0b', '#ef4444',
        '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16'
    ];

    function updateModelBreakdown(stats) {
        var section = document.getElementById('modelBreakdownSection');
        if (!section) return;

        var ms = stats.modelStats;
        var mts = stats.modelTimeSeries;

        // Check if we have any per-model data
        var modelNames = ms ? Object.keys(ms) : [];
        var modelHint = document.getElementById('modelBreakdownHint');
        if (modelNames.length === 0) {
            if (modelHint) modelHint.style.display = 'block';
            return;
        }
        if (modelHint) modelHint.style.display = 'none';

        // Update count badge
        var countEl = document.getElementById('modelBreakdownCount');
        if (countEl) countEl.textContent = modelNames.length + ' model' + (modelNames.length > 1 ? 's' : '');

        // Update table
        var tbody = document.getElementById('modelBreakdownBody');
        if (tbody) {
            var html = '';
            // Sort by requests descending
            modelNames.sort(function(a, b) { return (ms[b].requests || 0) - (ms[a].requests || 0); });
            for (var i = 0; i < modelNames.length; i++) {
                var name = modelNames[i];
                var m = ms[name];
                html += '<tr>' +
                    '<td class="model-name">' + escapeHtml(name) + '</td>' +
                    '<td>' + formatNumber(m.requests || 0) + '</td>' +
                    '<td>' + formatNumber(m.inputTokens || 0) + '</td>' +
                    '<td>' + formatNumber(m.outputTokens || 0) + '</td>' +
                    '<td>' + (m.successRate != null ? m.successRate + '%' : '-') + '</td>' +
                    '<td>' + (m.avgLatencyMs != null ? formatNumber(m.avgLatencyMs) + 'ms' : '-') + '</td>' +
                    '<td>' + (m.p95LatencyMs != null ? formatNumber(m.p95LatencyMs) + 'ms' : '-') + '</td>' +
                    '<td>' + (m.rate429 != null ? m.rate429 + '%' : '-') + '</td>' +
                    '</tr>';
            }
            tbody.innerHTML = html;
        }

        // Update stacked bar chart with per-model time-series
        if (modelTokenChart && mts) {
            // Collect all unique time labels across all models
            var allTimes = {};
            for (var mi = 0; mi < modelNames.length; mi++) {
                var series = mts[modelNames[mi]];
                if (!series || !series.times) continue;
                for (var ti = 0; ti < series.times.length; ti++) {
                    allTimes[series.times[ti]] = true;
                }
            }
            var sortedTimes = Object.keys(allTimes).sort();

            // Format labels
            var labels = sortedTimes.map(function(t) {
                var parts = t.split(' ');
                if (parts.length < 2) return t;
                var dateParts = parts[0].split('-');
                var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                var monthLabel = months[parseInt(dateParts[1], 10) - 1] || dateParts[1];
                return monthLabel + ' ' + parseInt(dateParts[2], 10) + ' ' + parts[1].substring(0, 5);
            });

            // Build one dataset per model
            var datasets = [];
            for (var di = 0; di < modelNames.length; di++) {
                var mName = modelNames[di];
                var mSeries = mts[mName];
                // Build lookup from time→tokens
                var lookup = {};
                if (mSeries && mSeries.times) {
                    for (var li = 0; li < mSeries.times.length; li++) {
                        lookup[mSeries.times[li]] = mSeries.tokens[li] || 0;
                    }
                }
                // Map to sorted times array
                var data = sortedTimes.map(function(t) { return lookup[t] || 0; });
                var color = MODEL_COLORS[di % MODEL_COLORS.length];
                datasets.push({
                    label: mName,
                    data: data,
                    backgroundColor: color + '99', // 60% opacity
                    borderColor: color,
                    borderWidth: 1
                });
            }

            modelTokenChart.data.labels = labels;
            modelTokenChart.data.datasets = datasets;
            modelTokenChart.update('none');
        }
    }

    // ========== ACCOUNT DETAILS (ON-DEMAND) ==========
    function fetchAccountDetails() {
        var limitsEl = document.getElementById('acctDetailLimits');
        if (limitsEl) limitsEl.textContent = 'Loading...';
        fetch('/stats/account-details').then(function(res) { return res.json(); })
        .then(function(details) {
            // Render tier status
            var tierEl = document.getElementById('acctTierStatus');
            if (tierEl && details.tierStatus) {
                var tierNames = { light: 'Lite', medium: 'Pro', heavy: 'Max' };
                var tierHtml = '';
                var tiers = ['light', 'medium', 'heavy'];
                for (var i = 0; i < tiers.length; i++) {
                    var tier = tiers[i];
                    var ts = details.tierStatus[tier];
                    if (!ts) continue;
                    var dotClass = ts.status || 'operational';
                    tierHtml += '<div class="tier-status-card">' +
                        '<div class="tier-status-header">' +
                        '<span class="tier-status-dot ' + dotClass + '"></span>' +
                        '<span class="tier-status-name">' + escapeHtml(tierNames[tier] || tier) + '</span>' +
                        '</div><div class="tier-status-models">';
                    if (ts.models) {
                        for (var m = 0; m < ts.models.length; m++) {
                            var mdl = ts.models[m];
                            tierHtml += '<div class="tier-model-line"><span>' + escapeHtml(mdl.model) +
                                '</span><span>' + mdl.inFlight + '/' + mdl.maxConcurrency + '</span></div>';
                        }
                    }
                    tierHtml += '</div></div>';
                }
                tierEl.innerHTML = tierHtml;
            }

            // Render quota limits
            if (details.quota && details.quota.limits) {
                var limitsHtml = '';
                for (var i = 0; i < details.quota.limits.length; i++) {
                    var l = details.quota.limits[i];
                    var label = l.type === 'TOKENS_LIMIT' ? 'Token Quota' :
                                l.type === 'TIME_LIMIT' ? 'Tool Call Limit' : escapeHtml(l.type);
                    var value = (l.percentage || 0) + '% used';
                    if (l.usage) value += ' (' + formatNumber(l.currentValue || 0) + ' / ' + formatNumber(l.usage) + ')';
                    var resetStr = '';
                    if (l.nextResetTime) {
                        var resetDate = new Date(l.nextResetTime);
                        var now = Date.now();
                        var diffH = Math.max(0, Math.round((l.nextResetTime - now) / 3600000));
                        resetStr = diffH > 24 ? Math.round(diffH / 24) + 'd' : diffH + 'h';
                        resetStr = ' (resets in ' + resetStr + ')';
                    }
                    limitsHtml += '<div class="limit-row"><span>' + label + '</span><span>' +
                        value + resetStr + '</span></div>';
                }
                var el = document.getElementById('acctDetailLimits');
                if (el) el.innerHTML = limitsHtml;
            }

            // Render key health
            var keyEl = document.getElementById('acctKeyHealth');
            if (keyEl && details.keyHealth) {
                var kh = details.keyHealth;
                var keyHtml = '<span>' + kh.total + ' key' + (kh.total !== 1 ? 's' : '') + ': </span>';
                keyHtml += '<span style="color:var(--success)">' + kh.healthy + ' healthy</span>';
                if (kh.halfOpen > 0) keyHtml += ', <span style="color:var(--warning)">' + kh.halfOpen + ' recovering</span>';
                if (kh.open > 0) keyHtml += ', <span style="color:var(--error)">' + kh.open + ' tripped</span>';
                keyEl.innerHTML = keyHtml;
            }

            // Render tool breakdown
            var toolEl = document.getElementById('acctDetailToolBreakdown');
            if (toolEl) {
                var toolHtml = '';
                if (details.quota && details.quota.toolDetails && details.quota.toolDetails.length) {
                    toolHtml = '<div class="text-xs text-secondary font-semibold" style="margin-bottom:4px;">Tool Usage by Model</div>';
                    for (var t = 0; t < details.quota.toolDetails.length; t++) {
                        var td = details.quota.toolDetails[t];
                        toolHtml += '<span style="display:inline-block;padding:2px 6px;margin:2px;background:var(--surface-overlay);border-radius:var(--radius-sm);font-size:11px;">' +
                            escapeHtml(td.model || '') + ': ' + (td.usage || 0) + '</span>';
                    }
                }
                toolEl.innerHTML = toolHtml;
            }
        }).catch(function() {
            if (limitsEl) limitsEl.textContent = 'Failed to load details';
        });
    }

    function toggleAccountDetails() {
        var section = document.getElementById('acctDetailsSection');
        var btn = document.getElementById('acctDetailsBtn');
        if (!section) return;
        if (section.style.display === 'none') {
            section.style.display = '';
            if (btn) btn.innerHTML = 'Details &#x25BE;';
            fetchAccountDetails();
        } else {
            section.style.display = 'none';
            if (btn) btn.innerHTML = 'Details &#x25B8;';
        }
    }

    function navigateAccountChart(chartName, direction) {
        // Handle cost chart navigation
        if (chartName === 'costTime') {
            var ctsTotalPoints = costTimeSeriesData ? costTimeSeriesData.times.length : 0;
            var ctsMaxOffset = Math.max(0, ctsTotalPoints - costChartViewport.windowSize);
            var ctsStep = Math.floor(costChartViewport.windowSize / 4);
            if (direction === 'left') costChartViewport.offset = Math.min(costChartViewport.offset + ctsStep, ctsMaxOffset);
            else if (direction === 'right') costChartViewport.offset = Math.max(0, costChartViewport.offset - ctsStep);
            else if (direction === 'reset') costChartViewport.offset = 0;
            if (costTimeSeriesData) renderCostChart(costTimeSeriesData);
            return;
        }

        // Account usage chart navigation
        var ts = STATE.statsData && STATE.statsData.accountUsage &&
                 STATE.statsData.accountUsage.modelUsage &&
                 STATE.statsData.accountUsage.modelUsage.timeSeries;
        var totalPoints = ts ? ts.times.length : 0;
        var maxOffset = Math.max(0, totalPoints - acctChartViewport.windowSize);
        var step = Math.floor(acctChartViewport.windowSize / 4);

        if (direction === 'left') {
            acctChartViewport.offset = Math.min(acctChartViewport.offset + step, maxOffset);
        } else if (direction === 'right') {
            acctChartViewport.offset = Math.max(0, acctChartViewport.offset - step);
        } else if (direction === 'reset') {
            acctChartViewport.offset = 0;
        }
        if (STATE.statsData) updateAccountUsage(STATE.statsData);
    }

    // ========== HEALTH SCORE BADGE ==========
    function updateHealthScoreBadge(stats) {
        var badge = document.getElementById('healthScoreBadge');
        if (!badge) return;
        var keys = stats.keys || [];
        if (keys.length === 0) {
            badge.textContent = '100';
            badge.className = 'health-score-badge excellent';
            return;
        }
        var totalScore = 0;
        var keyCount = 0;
        for (var i = 0; i < keys.length; i++) {
            if (keys[i].healthScore && typeof keys[i].healthScore.total === 'number') {
                totalScore += keys[i].healthScore.total;
                keyCount++;
            }
        }
        var avgScore = keyCount > 0 ? Math.round(totalScore / keyCount) : 100;
        badge.textContent = avgScore;
        badge.className = 'health-score-badge ' + getHealthScoreClass(avgScore);
    }

    // ========== DISTRIBUTION CHART ==========
    function updateDistributionChart(stats) {
        if (!STATE.charts.dist) return;
        var clientReq = stats.clientRequests || {};
        var errors = stats.errors || {};
        var labels = [];
        var data = [];
        var colors = [];

        if (clientReq.succeeded > 0) { labels.push('Success'); data.push(clientReq.succeeded); colors.push('#22c55e'); }

        var errorTypes = [
            { key: 'timeouts', label: 'Timeouts', color: '#f59e0b' },
            { key: 'socketHangups', label: 'Hangups', color: '#ef4444' },
            { key: 'serverErrors', label: 'Server Errors', color: '#dc2626' },
            { key: 'rateLimited', label: 'Rate Limited', color: '#f97316' },
            { key: 'connectionRefused', label: 'Connection Refused', color: '#b91c1c' },
            { key: 'authErrors', label: 'Auth Errors', color: '#7c3aed' },
            { key: 'clientDisconnects', label: 'Client Disconnects', color: '#6366f1' },
            { key: 'modelAtCapacity', label: 'Model at Capacity', color: '#a855f7' },
            { key: 'brokenPipe', label: 'Broken Pipe', color: '#e11d48' },
            { key: 'streamPrematureClose', label: 'Stream Close', color: '#fb923c' },
            { key: 'dnsErrors', label: 'DNS Errors', color: '#0ea5e9' },
            { key: 'tlsErrors', label: 'TLS Errors', color: '#14b8a6' },
            { key: 'httpParseError', label: 'HTTP Parse', color: '#64748b' },
            { key: 'other', label: 'Other', color: '#94a3b8' }
        ];
        for (var i = 0; i < errorTypes.length; i++) {
            var count = errors[errorTypes[i].key] || 0;
            if (count > 0) { labels.push(errorTypes[i].label); data.push(count); colors.push(errorTypes[i].color); }
        }

        STATE.charts.dist.data.labels = labels;
        STATE.charts.dist.data.datasets[0].data = data;
        STATE.charts.dist.data.datasets[0].backgroundColor = colors;
        STATE.charts.dist.update('none');

        var distEmptyEl = document.getElementById('distChartEmpty');
        if (distEmptyEl) distEmptyEl.style.display = data.length > 0 ? 'none' : 'block';
        var distCard = document.getElementById('distChartCard');
        if (distCard) {
            if (data.length === 0) distCard.classList.add('empty-state-card');
            else distCard.classList.remove('empty-state-card');
        }
    }

    // ========== UPDATE CHARTS ==========
    function updateCharts(history) {
        if (!requestChart) return;
        var points = history.points || [];
        if (points.length === 0) return;

        var tierResolution = history.tierResolution || 1;
        var formatTimeForTier = function(timestamp) {
            if (tierResolution >= 60) return formatTimestamp(timestamp, { compact: true });
            return formatTimestamp(timestamp);
        };

        var chartPoints = points;
        var maxChartPoints = 200;
        if (points.length > maxChartPoints) {
            var step = Math.ceil(points.length / maxChartPoints);
            chartPoints = points.filter(function(_, i) { return i % step === 0; });
        }

        var labels = chartPoints.map(function(p) { return formatTimeForTier(p.timestamp); });
        updateDataQualityIndicator(history, chartPoints.length);

        requestChart.data.labels = labels;
        requestChart.data.datasets[0].data = chartPoints.map(function(p) { return p.requests || 0; });
        requestChart.update('none');

        latencyChart.data.labels = labels;
        latencyChart.data.datasets[0].data = chartPoints.map(function(p) { return p.avgLatency || 0; });
        latencyChart.update('none');

        if (STATE.charts.error && chartPoints.length > 0) {
            STATE.charts.error.data.labels = labels;
            STATE.charts.error.data.datasets[0].data = chartPoints.map(function(p) { return p.errorRate || 0; });
            STATE.charts.error.update('none');
        }

        // Toggle chart empty states
        var reqEmpty = document.getElementById('requestChartEmpty');
        var latEmpty = document.getElementById('latencyChartEmpty');
        var errEmpty = document.getElementById('errorChartEmpty');
        if (reqEmpty) reqEmpty.style.display = requestChart.data.datasets[0].data.length > 0 ? 'none' : 'block';
        if (latEmpty) latEmpty.style.display = latencyChart.data.datasets[0].data.length > 0 ? 'none' : 'block';
        if (errEmpty) errEmpty.style.display = (STATE.charts.error && STATE.charts.error.data.datasets[0].data.length > 0) ? 'none' : 'block';

        // Routing observability from history
        if (window.DashboardTierBuilder && window.DashboardTierBuilder.updateRoutingObsKPIs) {
            window.DashboardTierBuilder.updateRoutingObsKPIs(history);
        }
    }

    function updateDataQualityIndicator(history, chartPointCount) {
        var tier = history.tier;
        var pointCount = history.pointCount;
        var expectedPointCount = history.expectedPointCount;
        var minutes = history.minutes;
        var coverage = expectedPointCount > 0 ? pointCount / expectedPointCount : 1;
        var quality = 'good';
        var message = '';
        if (tier === 'fine') {
            if (coverage < 0.5 && minutes > 30) { quality = 'warning'; message = 'Limited fine-grain data'; }
            else { message = 'Real-time data'; }
        } else if (tier === 'medium') { message = '10s resolution'; }
        else if (tier === 'coarse') { message = '60s resolution'; }

        var ids = ['dataQualityIndicator', 'dataQualityIndicator2', 'dataQualityIndicator3'];
        for (var i = 0; i < ids.length; i++) {
            var indicator = document.getElementById(ids[i]);
            if (indicator) { indicator.textContent = message; indicator.className = 'data-quality-indicator ' + quality; }
        }
    }

    // ========== LOGS ==========
    function updateLogs(logs) {
        var container = document.getElementById('logsContainer');
        if (!container) return;
        var wasAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 50;

        container.innerHTML = logs.map(function(log) {
            var time = formatTimestamp(log.timestamp);
            var level = (log.level || 'INFO').toUpperCase();
            return '<div class="log-entry"><span class="log-time">' + time + '</span>' +
                '<span class="log-level ' + level + '">' + level + '</span>' +
                '<span class="log-message">' + escapeHtml(log.message || '') + '</span></div>';
        }).join('');

        if (autoScrollLogs && wasAtBottom) { container.scrollTop = container.scrollHeight; }
    }

    // ========== ALERT BAR ==========
    function updateAlertBar(stats) {
        var statusEl = document.getElementById('alertStatus');
        var statusContainer = document.getElementById('alertStatusContainer');
        var isPaused = stats.paused;
        if (statusEl) statusEl.textContent = isPaused ? 'PAUSED' : 'ACTIVE';
        if (statusContainer) statusContainer.className = 'alert-item status ' + (isPaused ? 'paused' : '');

        var issuesCount = calculateIssuesCount(stats);
        var issuesEl = document.getElementById('alertIssues');
        var issuesContainer = document.getElementById('alertIssuesContainer');
        if (issuesEl) issuesEl.textContent = issuesCount;
        if (issuesContainer) {
            issuesContainer.className = 'alert-item issues';
            if (issuesCount > 0) issuesContainer.classList.add(issuesCount >= 4 ? 'critical' : 'has-alert');
        }

        var openCircuits = calculateOpenCircuits(stats);
        var circuitsEl = document.getElementById('alertCircuits');
        var circuitsContainer = document.getElementById('alertCircuitsContainer');
        if (circuitsEl) circuitsEl.textContent = openCircuits;
        if (circuitsContainer) {
            circuitsContainer.className = 'alert-item circuits';
            if (openCircuits > 0) circuitsContainer.classList.add(openCircuits >= 2 ? 'critical' : 'has-alert');
        }

        var bp = stats.backpressure || {};
        var queue = bp.queue || {};
        var queueDepth = queue.current || 0;
        var queueEl = document.getElementById('alertQueue');
        var queueContainer = document.getElementById('alertQueueContainer');
        if (queueEl) queueEl.textContent = queueDepth;
        if (queueContainer) {
            queueContainer.className = 'alert-item queue';
            if (queueDepth > 10) queueContainer.classList.add('critical');
            else if (queueDepth > 0) queueContainer.classList.add('has-alert');
        }

        var uptimeEl = document.getElementById('alertUptime');
        if (uptimeEl) uptimeEl.textContent = formatUptimeShort(stats.uptime || 0);

        var circuitsRibbon = document.getElementById('circuitsRibbonCount');
        if (circuitsRibbon) circuitsRibbon.textContent = String(openCircuits);
        var queueRibbon = document.getElementById('queueRibbonCount');
        if (queueRibbon) queueRibbon.textContent = String(queueDepth);
        var queueInCircuits = document.getElementById('queueInCircuits');
        if (queueInCircuits) queueInCircuits.textContent = String(queueDepth);
    }

    function calculateIssuesCount(stats) {
        var issues = 0;
        if (stats.rateLimitStatus && stats.rateLimitStatus.keysInCooldown > 0) issues++;
        if (calculateOpenCircuits(stats) > 0) issues++;
        var bp = stats.backpressure || {};
        var queue = bp.queue || {};
        if (queue.current > 0) issues++;
        if (stats.healthScore < 80) issues++;
        return issues;
    }

    function calculateOpenCircuits(stats) {
        if (!stats.keys || !Array.isArray(stats.keys)) return 0;
        var count = 0;
        for (var i = 0; i < stats.keys.length; i++) {
            var s = (stats.keys[i].state || stats.keys[i].circuitState || '').toUpperCase();
            if (s === 'OPEN' || s === 'HALF_OPEN' || s === 'HALF-OPEN') count++;
        }
        return count;
    }

    // ========== ISSUE DETECTION ==========
    function detectIssues(stats) {
        var issues = [];
        if (stats.keys) {
            for (var idx = 0; idx < stats.keys.length; idx++) {
                var key = stats.keys[idx];
                if (key.circuitState === 'OPEN') {
                    issues.push({ severity: 'critical', icon: 'X', title: 'Key ' + (idx + 1) + ' Circuit Open', description: 'Circuit breaker is open.', action: 'resetCircuit', actionLabel: 'Reset Circuit', actionData: idx });
                }
                if (key.healthScore && key.healthScore.total < 40) {
                    issues.push({ severity: 'critical', icon: '!', title: 'Key ' + (idx + 1) + ' Health Critical', description: 'Health score is ' + key.healthScore.total + '/100', action: null });
                }
            }
        }
        var errorRate = stats.successRate !== undefined ? (100 - stats.successRate) : 0;
        if (errorRate > 5) {
            issues.push({ severity: 'warning', icon: '!', title: 'High Error Rate', description: 'Error rate is ' + errorRate.toFixed(1) + '%', action: null });
        }
        var recent429s = (stats.errors && stats.errors.rateLimited) ? stats.errors.rateLimited : 0;
        if (recent429s > 10) {
            issues.push({ severity: 'warning', icon: '!', title: 'Rate Limiting Active', description: recent429s + ' recent 429 responses', action: null });
        }
        var queue = (stats.backpressure && stats.backpressure.queue) ? stats.backpressure.queue : {};
        if (queue.max > 0 && (queue.current / queue.max) > 0.8) {
            issues.push({ severity: 'warning', icon: '!', title: 'Queue Nearly Full', description: Math.round((queue.current / queue.max) * 100) + '% full', action: null });
        }
        if (stats.latency && stats.latency.p99 > 5000) {
            issues.push({ severity: 'warning', icon: '!', title: 'High P99 Latency', description: 'P99 is ' + stats.latency.p99 + 'ms', action: null });
        }
        return issues;
    }

    function updateIssuesPanel(stats) {
        var issues = detectIssues(stats);
        lastIssuesStats = stats;
        var panel = document.getElementById('issuesPanel');
        var issuesList = document.getElementById('issuesList');
        var issuesBadge = document.getElementById('issuesCountBadge');
        var issuesBadgeInScore = document.getElementById('issuesBadge');
        if (!panel || !issuesList) return;

        var currentHash = issues.map(function(i) { return i.severity + '-' + i.title; }).join('|');
        var hasNewIssues = currentHash !== previousIssuesHash && currentHash !== '';
        previousIssuesHash = currentHash;
        DActions.setPreviousIssuesHash(currentHash);

        if (issuesBadge) {
            issuesBadge.textContent = issues.length;
            issuesBadge.className = 'issues-badge ' + (issues.length === 0 ? 'none' : issues.length >= 3 ? 'critical' : 'warning');
            issuesBadge.style.display = 'inline-flex';
        }
        if (issuesBadgeInScore) {
            issuesBadgeInScore.textContent = issues.length > 0 ? issues.length : '';
            issuesBadgeInScore.style.display = issues.length > 0 ? 'inline-flex' : 'none';
        }

        if (issues.length === 0) {
            panel.classList.remove('has-issues', 'critical', 'warning', 'info');
            panel.style.display = 'none';
            return;
        }
        panel.style.display = '';

        panel.classList.add('has-issues');
        var hasCritical = issues.some(function(i) { return i.severity === 'critical'; });
        panel.className = 'issues-panel has-issues ' + (hasCritical ? 'critical' : 'warning');

        issuesList.innerHTML = issues.map(function(issue) {
            var actionHtml = '';
            if (issue.action === 'resetCircuit') {
                actionHtml = '<button class="issue-action" data-action="handle-issue-action" data-issue-action="resetCircuit" data-issue-data="' + escapeHtml(String(issue.actionData || '')) + '">' + escapeHtml(issue.actionLabel || 'Reset') + '</button>';
            }
            return '<div class="issue-item ' + issue.severity + (hasNewIssues ? ' new-issue' : '') + '">' +
                '<span class="issue-icon">' + issue.icon + '</span>' +
                '<div class="issue-details"><div class="issue-title">' + escapeHtml(issue.title) + '</div>' +
                '<div class="issue-description">' + escapeHtml(issue.description) + '</div></div>' +
                actionHtml + '</div>';
        }).join('');

        if (hasNewIssues && hasCritical) { showToast(issues.length + ' active issue' + (issues.length > 1 ? 's' : '') + ' detected', 'error'); }
        else if (hasNewIssues) { showToast(issues.length + ' issue' + (issues.length > 1 ? 's' : '') + ' detected', 'warning'); }
    }

    // ========== REQUESTS PAGE SUMMARY ==========
    function updateRequestsPageSummary(stats) {
        var setEl = function(id, val) { var e = document.getElementById(id); if (e) e.textContent = val; };
        var clientReq = stats.clientRequests || {};
        setEl('reqPageTotal', String(clientReq.total || stats.totalRequests || 0));
        setEl('reqPageSuccessRate', (stats.successRate || 0).toFixed(1) + '%');
        setEl('reqPageAvgLatency', ((stats.latency && stats.latency.avg) ? stats.latency.avg : 0).toFixed(0) + 'ms');

        var errCount = 0;
        var inFlight = clientReq.inFlight || 0;
        if (stats.keys) {
            for (var i = 0; i < stats.keys.length; i++) { errCount += (stats.keys[i].errors || 0); }
        }
        if (errCount === 0 && stats.errors) {
            var eo = stats.errors;
            errCount = (eo.timeouts || 0) + (eo.socketHangups || 0) + (eo.serverErrors || 0) + (eo.rateLimited || 0) + (eo.connectionRefused || 0) + (eo.authErrors || 0);
        }
        setEl('reqPageErrors', String(errCount));
        setEl('reqPageInFlight', String(inFlight));

        // Also update recent requests table (via SSE module)
        if (window.DashboardSSE && window.DashboardSSE.updateRecentRequestsTable) {
            window.DashboardSSE.updateRecentRequestsTable();
        }
    }

    // ========== HEALTH RADIAL & HEARTBEAT ==========
    function updateHealthRadial(scoreRanges, scoreTotal) {
        var radialFill = document.getElementById('healthRadialFill');
        var radialValue = document.getElementById('healthRadialValue');

        if (!radialFill || !radialValue || scoreTotal === 0) {
            if (radialValue) radialValue.innerHTML = '--<span class="score-max"></span>';
            return;
        }

        // Calculate weighted average score
        var weightedScore = (
            (scoreRanges.excellent || 0) * 90 +
            (scoreRanges.good || 0) * 70 +
            (scoreRanges.fair || 0) * 50 +
            (scoreRanges.poor || 0) * 25
        ) / scoreTotal;

        // Update radial fill (circumference = 2 * PI * 15.915 ≈ 100)
        var circumference = 100;
        var offset = circumference - ((weightedScore / 100) * circumference);
        radialFill.style.strokeDashoffset = offset + '%';

        // Update color based on score
        radialFill.className = 'radial-fill ' + getHealthScoreClass(weightedScore);

        // Update value display with max score
        radialValue.innerHTML = Math.round(weightedScore) + '<span class="score-max">/100</span>';
    }

    function updateHeartbeatIndicator(scoreRanges, scoreTotal) {
        var indicator = document.getElementById('heartbeatIndicator');
        var status = document.getElementById('heartbeatStatus');

        if (!indicator || !status || scoreTotal === 0) return;

        var poorRatio = scoreTotal > 0 ? (scoreRanges.poor || 0) / scoreTotal : 0;
        var fairRatio = scoreTotal > 0 ? (scoreRanges.fair || 0) / scoreTotal : 0;

        indicator.className = 'heartbeat-indicator';
        status.textContent = 'Healthy';

        if (poorRatio > 0.3 || fairRatio > 0.5) {
            indicator.classList.add('unhealthy');
            status.textContent = 'Unhealthy';
        } else if (poorRatio > 0.1 || fairRatio > 0.3) {
            indicator.classList.add('degraded');
            status.textContent = 'Degraded';
        } else {
            indicator.classList.add('healthy');
        }
    }

    // ========== KEYS HEATMAP ==========
    function updateKeysHeatmap(keys) {
        var heatmap = document.getElementById('keysHeatmap');
        if (!heatmap) return;
        heatmap.innerHTML = keys.map(function(key, index) {
            var healthScore = (key.healthScore && typeof key.healthScore.total === 'number') ? key.healthScore.total : 100;
            var healthClass = getHealthScoreClass(healthScore);
            var selected = index === STATE.selectedKeyIndex ? 'selected' : '';
            var inCooldown = (key.rateLimitTracking && key.rateLimitTracking.inCooldown) ? 'cooldown' : '';
            var inFl = key.inFlight || 0;
            var hasInFlight = inFl > 0 ? 'has-in-flight' : '';
            return '<div class="heatmap-cell ' + healthClass + ' ' + selected + ' ' + inCooldown + ' ' + hasInFlight + '"' +
                ' data-action="select-key" data-key-index="' + index + '"' +
                ' data-mouseenter="show-heatmap-tooltip" data-key-index-tooltip="' + index + '"' +
                ' data-mouseleave="hide-heatmap-tooltip"' +
                ' title="K' + index + ': Score ' + healthScore + ', ' + inFl + ' in-flight">' +
                '<span class="cell-label">K' + index + '</span>' +
                '<span class="cell-score">' + healthScore + '</span>' +
                (hasInFlight ? '<span class="in-flight-badge">' + inFl + '</span>' : '') +
                '</div>';
        }).join('');
    }

    function showHeatmapTooltip(event, index) {
        var key = STATE.keysData[index];
        if (!key) return;
        hideHeatmapTooltip();
        var tooltip = document.createElement('div');
        tooltip.className = 'heatmap-tooltip';
        tooltip.id = 'heatmapTooltip';
        var hs = (key.healthScore && key.healthScore.total) ? key.healthScore.total : 100;
        tooltip.innerHTML = '<div style="font-weight:600;margin-bottom:4px;">Key K' + index + '</div>' +
            '<div class="tooltip-row"><span class="tooltip-label">Health:</span><span class="tooltip-value">' + hs + '/100</span></div>' +
            '<div class="tooltip-row"><span class="tooltip-label">State:</span><span class="tooltip-value">' + (key.state || 'CLOSED') + '</span></div>' +
            '<div class="tooltip-row"><span class="tooltip-label">Success:</span><span class="tooltip-value">' + (key.successRate || 0).toFixed(1) + '%</span></div>' +
            '<div class="tooltip-row"><span class="tooltip-label">Latency:</span><span class="tooltip-value">' + ((key.latency && key.latency.avg) ? key.latency.avg.toFixed(0) : 0) + 'ms</span></div>' +
            '<div class="tooltip-row"><span class="tooltip-label">In Flight:</span><span class="tooltip-value">' + (key.inFlight || 0) + '</span></div>' +
            '<div class="tooltip-row"><span class="tooltip-label">Total:</span><span class="tooltip-value">' + (key.total || 0) + '</span></div>';
        document.body.appendChild(tooltip);
        var rect = event.target.getBoundingClientRect();
        tooltip.style.top = (rect.bottom + 8) + 'px';
        tooltip.style.left = (rect.left - 20) + 'px';
    }

    function hideHeatmapTooltip() {
        var tooltip = document.getElementById('heatmapTooltip');
        if (tooltip) tooltip.remove();
    }
    window.showHeatmapTooltip = showHeatmapTooltip;
    window.hideHeatmapTooltip = hideHeatmapTooltip;

    // ========== KEY DETAILS ==========
    function selectKey(index) {
        STATE.selectedKeyIndex = index;
        var key = STATE.keysData[index];
        if (key) {
            var detailsEl = document.getElementById('keyDetails');
            if (detailsEl) detailsEl.classList.add('visible');
            var titleEl = document.getElementById('keyDetailsTitle');
            if (titleEl) titleEl.textContent = 'Key K' + index;
            updateKeyDetails(key);
        }
        updateKeysHeatmap(STATE.keysData);
    }

    function updateKeyDetails(key) {
        var setEl = function(id, val) { var e = document.getElementById(id); if (e) e.textContent = val; };
        setEl('detailCircuitState', key.state || 'CLOSED');
        setEl('detailTotalRequests', key.total || 0);
        setEl('detailSuccessRate', (key.successRate || 0).toFixed(1) + '%');
        setEl('detailLatency', ((key.latency && key.latency.avg) ? key.latency.avg.toFixed(0) : 0) + 'ms');
        setEl('detailActiveRequests', key.inFlight || 0);
        setEl('detailFailures', key.failures || 0);

        var hs = key.healthScore || { total: 100, latency: 40, success: 40, errorRecency: 20 };
        setEl('detailHealthScore', hs.total + '/100');
        setEl('detailHealthLatency', hs.latency + '/40');
        setEl('detailHealthSuccess', hs.success + '/40');
        setEl('detailHealthRecency', hs.errorRecency + '/20');

        var slowBadge = document.getElementById('detailSlowKeyBadge');
        if (slowBadge) slowBadge.style.display = hs.isSlowKey ? 'inline-block' : 'none';

        var rlt = key.rateLimitTracking || { count: 0, lastHit: null, inCooldown: false, cooldownRemaining: 0 };
        var statusEl = document.getElementById('detailRateLimitStatus');
        if (statusEl) {
            if (rlt.inCooldown) { statusEl.textContent = 'IN COOLDOWN'; statusEl.style.color = 'var(--danger)'; }
            else if (rlt.count > 0) { statusEl.textContent = 'OK (had 429s)'; statusEl.style.color = 'var(--warning)'; }
            else { statusEl.textContent = 'OK'; statusEl.style.color = 'var(--success)'; }
        }
        setEl('detailRateLimit429s', rlt.count || 0);
        setEl('detailRateLimitLastHit', formatTimestamp(rlt.lastHit));
        setEl('detailRateLimitCooldown', rlt.inCooldown ? Math.ceil(rlt.cooldownRemaining / 1000) + 's' : '-');
    }

    function closeKeyDetails() {
        STATE.selectedKeyIndex = null;
        var el = document.getElementById('keyDetails');
        if (el) el.classList.remove('visible');
        updateKeysHeatmap(STATE.keysData);
    }

    // ========== TAB CONTENT ==========
    function updateTabContent(stats) {
        var bp = stats.backpressure || {};
        var queue = bp.queue || {};
        var el;
        el = document.getElementById('queueSizeTab'); if (el) el.textContent = queue.current || 0;
        el = document.getElementById('queueMaxTab'); if (el) el.textContent = queue.max || 100;
        el = document.getElementById('connectionsTab'); if (el) el.textContent = bp.activeConnections || 0;
        el = document.getElementById('connectionsMaxTab'); if (el) el.textContent = bp.maxConnections || 100;
        var qp = queue.max > 0 ? (queue.current / queue.max * 100) : 0;
        el = document.getElementById('queueProgressTab'); if (el) el.style.width = qp + '%';
        el = document.getElementById('queuePercentTab'); if (el) el.textContent = qp.toFixed(0) + '%';

        var backpressureStatus = document.getElementById('backpressureStatus');
        if (backpressureStatus) {
            if (queue.current > queue.max * 0.8) { backpressureStatus.textContent = 'High queue usage - backpressure active'; backpressureStatus.style.color = 'var(--warning)'; }
            else if (queue.current > queue.max * 0.5) { backpressureStatus.textContent = 'Moderate queue usage'; backpressureStatus.style.color = 'var(--text-secondary)'; }
            else { backpressureStatus.textContent = 'Normal operation'; backpressureStatus.style.color = 'var(--success)'; }
        }

        var scoreDist = stats.healthScoreDistribution || {};
        var scoreRanges = scoreDist.selectionsByScoreRange || {};
        var scoreTotal = (scoreRanges.excellent || 0) + (scoreRanges.good || 0) + (scoreRanges.fair || 0) + (scoreRanges.poor || 0);
        if (scoreTotal > 0) {
            el = document.getElementById('tabScoreExcellent'); if (el) el.style.width = ((scoreRanges.excellent / scoreTotal) * 100) + '%';
            el = document.getElementById('tabScoreGood'); if (el) el.style.width = ((scoreRanges.good / scoreTotal) * 100) + '%';
            el = document.getElementById('tabScoreFair'); if (el) el.style.width = ((scoreRanges.fair / scoreTotal) * 100) + '%';
            el = document.getElementById('tabScorePoor'); if (el) el.style.width = ((scoreRanges.poor / scoreTotal) * 100) + '%';
        }
        el = document.getElementById('tabScoreExcellentCount'); if (el) el.textContent = scoreRanges.excellent || 0;
        el = document.getElementById('tabScoreGoodCount'); if (el) el.textContent = scoreRanges.good || 0;
        el = document.getElementById('tabScoreFairCount'); if (el) el.textContent = scoreRanges.fair || 0;
        el = document.getElementById('tabScorePoorCount'); if (el) el.textContent = scoreRanges.poor || 0;
    }

    // Traces → traces.js, Control Actions + Data Export → actions.js
    var updateTracesTable = DTraces.updateTracesTable;
    var loadTracesFromAPI = DTraces.loadTracesFromAPI;
    var downloadFile = DActions.downloadFile;
    var controlAction = DActions.controlAction;
    var forceCircuitStateOnKey = DActions.forceCircuitStateOnKey;

    // ========== HISTOGRAM & COST ==========
    function fetchHistogram() {
        return fetchJSON('/stats/latency-histogram?range=' + currentHistogramRange).then(function(data) {
            if (data && !data.__error) {
                updateHistogram(data);
                return true;
            }
            return false;
        }).catch(function() {
            return false;
        });
    }

    function updateHistogram(data) {
        var labels = data.bucketLabels || Object.keys(data.buckets || {});
        var values = [];
        var bucketValues = data.buckets || {};
        var bKeys = Object.keys(bucketValues);
        for (var i = 0; i < bKeys.length; i++) { values.push(bucketValues[bKeys[i]]); }

        if (!histogramChart) {
            var el = document.getElementById('histogramChart');
            if (!el || !FEATURES.chartJs) return;
            var hTheme = getChartTheme();
            histogramChart = new Chart(el.getContext('2d'), {
                type: 'bar',
                data: { labels: labels, datasets: [{ label: 'Requests', data: values, backgroundColor: 'rgba(6,182,212,0.6)', borderColor: 'rgba(6,182,212,1)', borderWidth: 1 }] },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { color: hTheme.tick }, grid: { color: hTheme.grid } }, x: { ticks: { color: hTheme.tick, maxRotation: 45 }, grid: { display: false } } } }
            });
            STATE.charts.histogram = histogramChart;
            markChartLoaded(el);
        } else {
            histogramChart.data.labels = labels;
            histogramChart.data.datasets[0].data = values;
            histogramChart.update();
        }

        var stats = data.stats || {};
        var setEl = function(id, val) { var e = document.getElementById(id); if (e) e.textContent = val; };
        setEl('histogramCount', stats.count || 0);
        setEl('histogramAvg', (stats.avg || 0) + 'ms');
        setEl('histogramP50', (stats.p50 || 0) + 'ms');
        setEl('histogramP95', (stats.p95 || 0) + 'ms');
        setEl('histogramP99', (stats.p99 || 0) + 'ms');
    }

    function formatTimeLabel(t) {
        var parts = t.split(' ');
        if (parts.length < 2) return t;
        var dateParts = parts[0].split('-');
        var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        var monthLabel = months[parseInt(dateParts[1], 10) - 1] || dateParts[1];
        return monthLabel + ' ' + parseInt(dateParts[2], 10) + ' ' + parts[1].substring(0, 5);
    }

    function renderCostChart(cts) {
        var costChartCard = document.getElementById('costChartCard');
        if (!cts || !cts.times || cts.times.length === 0 || !costTimeChart) {
            if (costChartCard) costChartCard.style.display = 'none';
            return;
        }
        if (costChartCard) costChartCard.style.display = '';

        // Apply viewport window
        var totalPoints = cts.times.length;
        var maxOffset = Math.max(0, totalPoints - costChartViewport.windowSize);
        if (costChartViewport.offset > maxOffset) costChartViewport.offset = maxOffset;
        var viewEnd = totalPoints - costChartViewport.offset;
        var viewStart = Math.max(0, viewEnd - costChartViewport.windowSize);
        viewEnd = Math.min(totalPoints, viewStart + costChartViewport.windowSize);

        var viewTimes = cts.times.slice(viewStart, viewEnd);
        var labels = viewTimes.map(formatTimeLabel);

        // Update range indicator
        var rangeEl = document.getElementById('costChartRange');
        if (rangeEl && labels.length) {
            rangeEl.textContent = labels[0] + ' \u2014 ' + labels[labels.length - 1];
        }

        var modelNames = Object.keys(cts.byModel || {});
        var datasets = [];
        for (var i = 0; i < modelNames.length; i++) {
            var color = MODEL_COLORS[i % MODEL_COLORS.length];
            datasets.push({
                label: modelNames[i],
                data: (cts.byModel[modelNames[i]] || []).slice(viewStart, viewEnd),
                backgroundColor: color + '99',
                borderColor: color,
                borderWidth: 1
            });
        }
        costTimeChart.data.labels = labels;
        costTimeChart.data.datasets = datasets;
        costTimeChart.update('none');
    }

    function renderCostModelTable(cts, modelStats) {
        var tbody = document.getElementById('costModelBody');
        var tableWrap = document.getElementById('costModelTable');
        if (!tbody || !tableWrap) return;

        // Calculate per-model cost totals from time-series
        var modelCosts = {};
        var totalCost = 0;
        if (cts && cts.byModel) {
            var modelNames = Object.keys(cts.byModel);
            for (var i = 0; i < modelNames.length; i++) {
                var sum = 0;
                var arr = cts.byModel[modelNames[i]];
                for (var j = 0; j < arr.length; j++) sum += (arr[j] || 0);
                modelCosts[modelNames[i]] = sum;
                totalCost += sum;
            }
        }

        // Merge with modelStats for request/token counts
        var allModels = Object.keys(modelCosts);
        if (allModels.length === 0) {
            tableWrap.style.display = 'none';
            return;
        }
        tableWrap.style.display = '';

        // Sort by cost descending
        allModels.sort(function(a, b) { return (modelCosts[b] || 0) - (modelCosts[a] || 0); });

        var html = '';
        for (var k = 0; k < allModels.length; k++) {
            var name = allModels[k];
            var cost = modelCosts[name] || 0;
            var pct = totalCost > 0 ? Math.round((cost / totalCost) * 1000) / 10 : 0;
            var ms = modelStats && modelStats[name];
            var tokens = ms ? formatNumber((ms.inputTokens || 0) + (ms.outputTokens || 0)) : '-';
            var reqs = ms ? formatNumber(ms.requests || 0) : '-';
            html += '<tr>' +
                '<td class="model-name">' + escapeHtml(name) + '</td>' +
                '<td>$' + cost.toFixed(6) + '</td>' +
                '<td>' + pct + '%</td>' +
                '<td>' + tokens + '</td>' +
                '<td>' + reqs + '</td>' +
                '</tr>';
        }
        // Total row
        html += '<tr style="border-top: 1px solid var(--border); font-weight: 600;">' +
            '<td>Total</td>' +
            '<td>$' + totalCost.toFixed(6) + '</td>' +
            '<td>100%</td>' +
            '<td></td><td></td></tr>';
        tbody.innerHTML = html;
    }

    function fetchCostStats() {
        // Fetch both today's stats and full report in parallel
        return Promise.all([
            fetchJSON('/stats/cost'),
            fetchJSON('/stats/cost/history')
        ]).then(function(results) {
            var data = results[0];
            var fullReport = results[1];
            if (!data || data.__error) return false;
            if (fullReport && fullReport.__error) fullReport = null;
            var costPanel = document.getElementById('costPanel');
            if (costPanel) costPanel.style.display = 'block';
            var setEl = function(id, val) { var e = document.getElementById(id); if (e) e.textContent = val; };
            setEl('todayCost', '$' + (data.cost || 0).toFixed(4));
            setEl('projectedCost', '$' + ((data.projection && data.projection.daily && data.projection.daily.projected) || 0).toFixed(4));
            // Weekly cost from full report
            var weekCost = fullReport && fullReport.periods && fullReport.periods.thisWeek
                ? fullReport.periods.thisWeek.cost : 0;
            setEl('weekCost', '$' + (weekCost || 0).toFixed(4));
            setEl('monthCost', '$' + ((data.projection && data.projection.monthly && data.projection.monthly.current) || 0).toFixed(4));
            setEl('avgCostPerReq', '$' + (data.avgCostPerRequest || 0).toFixed(6));
            setEl('costRequests', formatNumber(data.requests || 0));
            var costHint = document.getElementById('costEmptyHint');
            if (costHint) costHint.style.display = (data.cost || 0) > 0 ? 'none' : 'block';
            if (data.budget && data.budget.limit) {
                var prog = document.getElementById('budgetProgress');
                if (prog) prog.style.display = 'block';
                var pct = Math.min(100, data.budget.percentUsed || 0);
                var fill = document.getElementById('budgetFill');
                if (fill) {
                    fill.style.width = pct + '%';
                    fill.className = 'budget-fill ' + (pct < 50 ? 'ok' : pct < 80 ? 'warning' : 'danger');
                    // Show percentage inside bar when wide enough
                    var showInline = pct >= 30;
                    fill.innerHTML = showInline ? '<span class="budget-fill-text">' + pct + '%</span>' : '';
                }
                var budgetLabel = document.getElementById('budgetLabel');
                if (budgetLabel) budgetLabel.textContent = pct + '% of $' + data.budget.limit + ' budget';
            }

            // Cache and render cost chart with viewport
            if (data.costTimeSeries) {
                costTimeSeriesData = data.costTimeSeries;
                renderCostChart(costTimeSeriesData);
            }

            // Per-model cost breakdown table
            renderCostModelTable(data.costTimeSeries, STATE.statsData ? STATE.statsData.modelStats : null);

            return true;
        }).catch(function() {
            return false;
        });
    }

    // ========== PERSISTENT STATS ==========
    function fetchPersistentStats() {
        return fetchJSON('/persistent-stats').then(function(data) {
            if (!data || data.__error) return false;
            var setEl = function(id, val) { var e = document.getElementById(id); if (e) e.textContent = val; };
            if (data.tracking) {
                var since = new Date(data.tracking.since);
                setEl('psTrackingSince', since.toLocaleDateString());
            }
            if (data.totals) {
                setEl('psTotalRequests', formatNumber(data.totals.requests || 0));
                setEl('psTotalSuccesses', formatNumber(data.totals.successes || 0));
                setEl('psTotalFailures', formatNumber(data.totals.failures || 0));
                setEl('psTotalRetries', formatNumber(data.totals.retries || 0));
            }
            if (data.tracking) {
                setEl('psKeysUsed', (data.tracking.totalTrackedKeys || 0) + '/' + (data.tracking.totalConfiguredKeys || 0));
            }
            var warn = document.getElementById('psUnusedWarning');
            if (warn && data.validation && !data.validation.allKeysUsed) {
                warn.style.display = '';
                warn.textContent = data.validation.unusedCount + ' unused key(s) detected';
            }
            return true;
        }).catch(function() { return false; });
    }

    // ========== AIMD CONCURRENCY ==========
    function updateAIMD(stats) {
        var ac = stats && stats.adaptiveConcurrency;
        var setEl = function(id, val) { var e = document.getElementById(id); if (e) e.textContent = val; };
        setEl('aimdMode', ac ? ac.mode || '-' : '-');
        var list = document.getElementById('aimdModelsList');
        var hint = document.getElementById('aimdEmptyHint');
        if (!ac || !ac.models || Object.keys(ac.models).length === 0) {
            if (list) list.innerHTML = '';
            if (hint) hint.style.display = '';
            return;
        }
        if (hint) hint.style.display = 'none';
        var models = ac.models;
        var html = '<div class="info-grid">';
        var names = Object.keys(models);
        for (var i = 0; i < names.length; i++) {
            var m = models[names[i]];
            html += '<div class="info-item">' +
                '<div class="label">' + escapeHtml(names[i]) + '</div>' +
                '<div class="value">' + (m.effectiveMax || m.staticMax || '-') + '</div>' +
                '<div class="info-note">floor=' + (m.floor || 0) + ' 429s=' + ((m.congestion429 || 0) + (m.quota429 || 0)) + '</div>' +
                '</div>';
        }
        html += '</div>';
        if (list) list.innerHTML = html;
    }

    // ========== PREDICTIONS ==========
    function fetchPredictions() {
        return fetchJSON('/predictions').then(function(data) {
            if (!data || data.__error) return false;
            var setEl = function(id, val) { var e = document.getElementById(id); if (e) e.textContent = val; };
            setEl('predCriticalKeys', (data.criticalKeys || []).length);
            var trend = data.scaling && data.scaling.trend ? data.scaling.trend.direction || 'stable' : 'stable';
            setEl('predTrend', trend);
            var anomalyCount = data.scaling && data.scaling.anomalies ? data.scaling.anomalies.length : 0;
            setEl('predAnomalies', anomalyCount);
            var recsEl = document.getElementById('predRecommendations');
            var hint = document.getElementById('predEmptyHint');
            var recs = data.scaling && data.scaling.recommendations ? data.scaling.recommendations : [];
            if (recsEl && recs.length > 0) {
                recsEl.innerHTML = recs.map(function(r) { return '<div class="insight info">' + escapeHtml(r) + '</div>'; }).join('');
                if (hint) hint.style.display = 'none';
            } else if (hint && (data.criticalKeys || []).length === 0 && anomalyCount === 0) {
                hint.style.display = '';
            } else if (hint) {
                hint.style.display = 'none';
            }
            return true;
        }).catch(function() { return false; });
    }

    function fetchCircuitHistory() {
        return fetchJSON('/circuit-history').then(function(data) {
            if (!data || data.__error) return false;
            var el = document.getElementById('circuitTimeline');
            if (!el) return false;

            if (data.totalTransitions === 0) {
                var states = data.currentStates || [];
                var allClosed = states.every(function(s) { return s.state === 'CLOSED'; });
                el.innerHTML = '<div class="text-secondary text-center p-20">' +
                    (allClosed ? 'All ' + states.length + ' keys CLOSED' : states.length + ' keys active') +
                    ' — no transitions in ' + (data.minutes || 60) + ' min</div>';
                return true;
            }

            var transitions = data.transitions || [];
            var html = '';
            for (var i = transitions.length - 1; i >= 0; i--) {
                var t = transitions[i];
                var time = new Date(t.time);
                var timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                var color = t.to === 'CLOSED' ? 'var(--success)' : t.to === 'OPEN' ? 'var(--danger)' : 'var(--warning)';
                html += '<div style="padding: 4px 0; border-bottom: 1px solid var(--border); color: ' + color + ';">' +
                    '<span class="text-secondary">[' + timeStr + ']</span> ' +
                    'Key #' + t.keyIndex + ': ' + t.from + ' → <strong>' + t.to + '</strong>' +
                    (t.reason ? ' <span class="text-secondary">(' + escapeHtml(t.reason) + ')</span>' : '') +
                    '</div>';
            }
            el.innerHTML = html || '<div class="text-secondary text-center p-20">No transitions</div>';
            return true;
        }).catch(function() { return false; });
    }

    function fetchProcessHealth() {
        // /health/deep requires auth - pass requireAuth flag
        return fetchJSON('/health/deep', { requireAuth: true }).then(function(data) {
            var el;

            // Handle error responses (auth failures, network errors)
            if (data && data.__error) {
                el = document.getElementById('processHealthStatus');
                if (el) {
                    if (data.status === 401 || data.status === 403) {
                        el.textContent = 'Auth Required';
                        el.className = 'badge text-xs warning';
                    } else {
                        el.textContent = 'Error';
                        el.className = 'badge text-xs error';
                    }
                }
                // Set error state for all fields
                el = document.getElementById('phHeapUsed'); if (el) el.textContent = '-';
                el = document.getElementById('phHeapTotal'); if (el) el.textContent = '-';
                el = document.getElementById('phMemPercent'); if (el) { el.textContent = '-'; el.style.color = ''; }
                el = document.getElementById('phRss'); if (el) el.textContent = '-';
                el = document.getElementById('phPid'); if (el) el.textContent = '-';
                el = document.getElementById('phNodeVersion'); if (el) el.textContent = '-';
                el = document.getElementById('phTracesStored'); if (el) el.textContent = '-';
                el = document.getElementById('phTraceCapacity'); if (el) el.textContent = '-';
                return false;
            }

            if (!data || data.error) return false;
            var checks = data.checks || {};
            var mem = checks.memory || {};
            var traces = checks.traces || {};
            var proc = data.process || {};

            el = document.getElementById('processHealthStatus');
            if (el) {
                el.textContent = data.status || '-';
                el.className = 'badge text-xs ' + (data.status === 'healthy' ? 'success' : data.status === 'degraded' ? 'warning' : 'error');
            }

            el = document.getElementById('phHeapUsed'); if (el) el.textContent = mem.heapUsed ? (mem.heapUsed + 'MB') : '-';
            el = document.getElementById('phHeapTotal'); if (el) el.textContent = mem.heapTotal ? (mem.heapTotal + 'MB') : '-';
            el = document.getElementById('phMemPercent');
            if (el) {
                var pct = mem.percentUsed || 0;
                el.textContent = pct + '%';
                el.style.color = pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--warning)' : 'var(--success)';
            }
            el = document.getElementById('phRss'); if (el) el.textContent = mem.rss ? (mem.rss + 'MB') : '-';

            el = document.getElementById('phPid'); if (el) el.textContent = proc.pid || '-';
            el = document.getElementById('phNodeVersion'); if (el) el.textContent = proc.nodeVersion || '-';
            el = document.getElementById('phTracesStored'); if (el) el.textContent = traces.stored || 0;
            el = document.getElementById('phTraceCapacity'); if (el) el.textContent = traces.capacity || '-';

            return true;
        }).catch(function() { return false; });
    }

    function fetchScheduler() {
        return fetchJSON('/stats/scheduler', { requireAuth: true }).then(function(data) {
            var el;

            // Handle error responses
            if (data && data.__error) {
                el = document.getElementById('schedulerPoolState');
                if (el) {
                    if (data.status === 401 || data.status === 403) {
                        el.textContent = 'Auth Required';
                        el.className = 'badge text-xs warning';
                    } else {
                        el.textContent = 'Error';
                        el.className = 'badge text-xs error';
                    }
                }
                // Set error state for all fields
                el = document.getElementById('schedFairness'); if (el) { el.textContent = '-'; el.style.color = ''; }
                el = document.getElementById('schedAvgLatency'); if (el) el.textContent = '-';
                el = document.getElementById('schedWeighted'); if (el) el.textContent = '-';
                el = document.getElementById('schedRoundRobin'); if (el) el.textContent = '-';
                return false;
            }

            if (!data || data.error) return false;
            var pool = data.poolState || {};
            var sched = data.scheduler || {};
            var decisions = sched.decisions || {};
            var dist = decisions.reasonDistribution || {};
            var fairness = decisions.fairness || {};

            el = document.getElementById('schedulerPoolState');
            if (el) {
                var state = pool.state || '-';
                el.textContent = state;
                el.className = 'badge text-xs ' + (state === 'healthy' ? 'success' : state === 'degraded' ? 'warning' : 'error');
            }

            el = document.getElementById('schedFairness');
            if (el) {
                var score = fairness.fairnessScore;
                el.textContent = score != null ? score.toFixed(2) : '-';
                if (score != null) el.style.color = score < 0.5 ? 'var(--danger)' : score < 0.7 ? 'var(--warning)' : 'var(--success)';
            }

            el = document.getElementById('schedAvgLatency');
            if (el) el.textContent = pool.avgLatency ? (formatNumber(Math.round(pool.avgLatency)) + 'ms') : '-';

            var total = (dist.weighted || 0) + (dist.roundRobin || 0) + (dist.fallback || 0);
            el = document.getElementById('schedWeighted');
            if (el) el.textContent = total > 0 ? Math.round((dist.weighted || 0) / total * 100) + '%' : '-';
            el = document.getElementById('schedRoundRobin');
            if (el) el.textContent = total > 0 ? Math.round((dist.roundRobin || 0) / total * 100) + '%' : '-';

            return true;
        }).catch(function() { return false; });
    }

    function fetchReplayQueue() {
        return fetchJSON('/replay-queue/stats').then(function(data) {
            if (!data || data.__error || data.error) return false;
            var section = document.getElementById('replayQueueSection');
            if (section) section.style.display = '';

            var el;
            el = document.getElementById('rqCurrent'); if (el) el.textContent = data.currentSize || 0;
            el = document.getElementById('rqSucceeded'); if (el) el.textContent = data.totalSucceeded || 0;
            el = document.getElementById('rqFailed');
            if (el) {
                el.textContent = data.totalFailed || 0;
                el.style.color = (data.totalFailed || 0) > 0 ? 'var(--danger)' : '';
            }
            el = document.getElementById('rqUtilization');
            if (el) el.textContent = (data.utilizationPercent || 0) + '%';
            return true;
        }).catch(function() { return false; });
    }

    function fetchComparison() {
        return fetch('/compare').then(function(res) {
            if (res.ok) return res.json();
            return false;
        }).then(function(data) {
            if (!data || data === false) return false;
            var grid = document.getElementById('comparisonGrid');
            if (!grid) return false;
            var keys = data.keys || [];
            grid.innerHTML = keys.map(function(k, i) {
                var rank = i + 1;
                var isTopPerformer = i === 0;
                var rankClass = rank <= 3 ? 'rank-' + rank : '';
                var rankBadge = rank <= 3 ? '<span class="key-rank ' + rankClass + '">' + rank + '</span>' : '<span class="key-rank" style="opacity:0.5;font-size:8px;">' + rank + '</span>';
                var norm = k.normalized || {};
                var healthClass = k.overallScore >= 80 ? 'excellent' : k.overallScore >= 60 ? 'good' : k.overallScore >= 40 ? 'fair' : 'poor';
                var healthLabel = k.overallScore >= 80 ? 'Excellent' : k.overallScore >= 60 ? 'Good' : k.overallScore >= 40 ? 'Fair' : 'Poor';
                return '<div class="comparison-card' + (isTopPerformer ? ' top-performer' : '') + '" data-action="select-key" data-key-index="' + k.keyIndex + '">' +
                    '<div class="key-name">' + rankBadge + 'K' + k.keyIndex + '</div>' +
                    '<div class="key-score">' + k.overallScore + '<span class="score-max">/100</span></div>' +
                    '<div class="key-latency">' + (k.avgLatency ? Math.round(k.avgLatency) + 'ms avg' : '') + (k.successRate !== undefined ? ' · ' + k.successRate.toFixed(1) + '% success' : '') + '</div>' +
                    '<div class="key-progress" data-value="' + k.overallScore + '%" style="position:relative;"><div class="key-progress-fill ' + healthClass + '" style="width:' + (k.overallScore || 0) + '%"></div></div>' +
                    '</div>';
            }).join('');
            var compHint = document.getElementById('comparisonEmptyHint');
            if (compHint) compHint.style.display = keys.length > 0 ? 'none' : '';
            var insightsList = document.getElementById('insightsList');
            if (insightsList) {
                var insights = data.insights || [];
                insightsList.innerHTML = insights.map(function(ins) { return '<div class="insight ' + ins.type + '">' + ins.message + '</div>'; }).join('');
            }
            return true;
        }).catch(function() { /* Silently ignore - comparison endpoint may not exist */
            return false;
        });
    }

    // ========== ARIA INIT ==========
    function initARIA() {
        var activePageBtn = document.querySelector('.page-nav-btn.active');
        if (activePageBtn) {
            activePageBtn.setAttribute('aria-selected', 'true');
            activePageBtn.setAttribute('tabindex', '0');
        }
        var searchInput = document.getElementById('globalSearchInput');
        if (searchInput && !searchInput.getAttribute('aria-label')) {
            searchInput.setAttribute('aria-label', 'Search requests');
            searchInput.setAttribute('aria-controls', 'searchResults');
        }
        var dockTabs = document.querySelectorAll('.dock-tab');
        for (var i = 0; i < dockTabs.length; i++) {
            var isActive = dockTabs[i].classList.contains('active');
            dockTabs[i].setAttribute('aria-selected', String(isActive));
            dockTabs[i].setAttribute('tabindex', isActive ? '0' : '-1');
        }
    }

    // ========== CLEANUP ==========
    function clearStartupFetchTimeouts() {
        for (var i = 0; i < startupFetchTimeoutIds.length; i++) {
            clearTimeout(startupFetchTimeoutIds[i]);
        }
        startupFetchTimeoutIds = [];
    }

    function scheduleStartupFetch(delayMs, pollName, fetchFn) {
        var timeoutId = setTimeout(function() {
            var idx = startupFetchTimeoutIds.indexOf(timeoutId);
            if (idx >= 0) startupFetchTimeoutIds.splice(idx, 1);
            if (DPolling.isPollingPaused() || document.hidden) return;
            runPolledFetch(pollName, fetchFn);
        }, delayMs);
        startupFetchTimeoutIds.push(timeoutId);
    }

    function cleanup() {
        clearStartupFetchTimeouts();
        clearAllPollingIntervals();
        resetAllPollBackoff();

        if (historyFetchController) { historyFetchController.abort(); historyFetchController = null; }

        if (requestChart) { requestChart.destroy(); requestChart = null; }
        if (latencyChart) { latencyChart.destroy(); latencyChart = null; }
        if (errorChart) { errorChart.destroy(); errorChart = null; }
        if (distChart) { distChart.destroy(); distChart = null; }
        if (routingTierChart) { routingTierChart.destroy(); routingTierChart = null; }
        if (routingSourceChart) { routingSourceChart.destroy(); routingSourceChart = null; }
        if (routing429Chart) { routing429Chart.destroy(); routing429Chart = null; }
        if (histogramChart) { histogramChart.destroy(); histogramChart = null; }
        if (acctTokenChart) { acctTokenChart.destroy(); acctTokenChart = null; }
        if (acctRequestChart) { acctRequestChart.destroy(); acctRequestChart = null; }
        if (modelTokenChart) { modelTokenChart.destroy(); modelTokenChart = null; }
        if (costTimeChart) { costTimeChart.destroy(); costTimeChart = null; }

        if (STATE.charts) {
            STATE.charts.request = null;
            STATE.charts.latency = null;
            STATE.charts.error = null;
            STATE.charts.dist = null;
            STATE.charts.routingTier = null;
            STATE.charts.routingSource = null;
            STATE.charts.routing429 = null;
            STATE.charts.histogram = null;
            STATE.charts.acctToken = null;
            STATE.charts.acctRequest = null;
        }
    }

    // ========== DELEGATED: actions.js, traces.js, polling.js ==========
    // Share/Dismiss/Control Actions → DashboardActions
    var exportData = DActions.exportData;
    var shareURL = DActions.shareURL;
    var dismissIssues = DActions.dismissIssues;
    var resetAllCircuits = DActions.resetAllCircuits;
    var clearQueue = DActions.clearQueue;
    var exportDiagnostics = DActions.exportDiagnostics;
    var forceCircuitState = DActions.forceCircuitState;
    var forceCircuit = DActions.forceCircuit;
    var reloadKeys = DActions.reloadKeys;
    var resetStats = DActions.resetStats;
    var clearLogs = DActions.clearLogs;
    // Trace Detail → DashboardTraces
    var showTraceDetail = DTraces.showTraceDetail;
    var renderTraceTimeline = DTraces.renderTraceTimeline;
    var renderTraceAttempts = DTraces.renderTraceAttempts;
    var closeTraceDetail = DTraces.closeTraceDetail;
    var searchTraceById = DTraces.searchTraceById;
    var exportTraces = DTraces.exportTraces;
    var clearTraceFilters = DTraces.clearTraceFilters;
    var copyTraceId = DTraces.copyTraceId;
    var copyTraceJson = DTraces.copyTraceJson;
    // Key Override Modal → DashboardActions
    var openKeyOverrideModal = DActions.openKeyOverrideModal;
    var closeKeyOverrideModal = DActions.closeKeyOverrideModal;
    var renderOverrideList = DActions.renderOverrideList;
    var addOverride = DActions.addOverride;
    var removeOverride = DActions.removeOverride;
    var saveKeyOverrides = DActions.saveKeyOverrides;
    // Smart Polling → DashboardPolling
    var clearAllPollingIntervals = DPolling.clearAllPollingIntervals;
    var startAllPolling = DPolling.startAllPolling;
    var pausePolling = DPolling.pausePolling;
    var resumePolling = DPolling.resumePolling;
    var resetAllPollBackoff = DPolling.resetAllPollBackoff;
    var runPolledFetch = DPolling.runPolledFetch;

    // ========== INIT ORCHESTRATION ==========
    function initData() {
        // Cache DOM references for hot-path elements
        cacheDomRefs();

        // Initialize extracted modules with dependency injection
        DPolling.init({
            fetchStats: fetchStats,
            fetchHistory: fetchHistory,
            fetchLogs: fetchLogs,
            fetchHistogram: fetchHistogram,
            fetchCostStats: fetchCostStats,
            fetchComparison: fetchComparison,
            fetchPersistentStats: fetchPersistentStats,
            fetchPredictions: fetchPredictions,
            fetchCircuitHistory: fetchCircuitHistory,
            fetchProcessHealth: fetchProcessHealth,
            fetchScheduler: fetchScheduler,
            fetchReplayQueue: fetchReplayQueue
        });
        DActions.init({
            fetchStats: fetchStats,
            fetchLogs: fetchLogs,
            pausePolling: DPolling.pausePolling,
            resumePolling: DPolling.resumePolling,
            setServerPaused: DPolling.setServerPaused
        });

        // Ensure chart initialization uses persisted theme even if init.js runs later.
        var persistedTheme = localStorage.getItem('dashboard-theme');
        if (persistedTheme === 'dark' || persistedTheme === 'light') {
            STATE.settings.theme = persistedTheme;
            document.documentElement.setAttribute('data-theme', persistedTheme);
        }

        // Initialize charts
        initCharts();
        initARIA();

        // Initial data fetches, then start all polling intervals
        Promise.all([fetchStats(), fetchHistory(), fetchLogs(), fetchTenants()])
            .then(function() {
                startAllPolling();
            })
            .catch(function(err) {
                console.error('Initial data fetch failed:', err);
                // Start polling anyway so dashboard recovers
                startAllPolling();
            });

        // Connect SSE request stream
        if (window.DashboardSSE && window.DashboardSSE.connectRequestStream) {
            window.DashboardSSE.connectRequestStream();
        }

        // Initialize filter listeners
        if (window.DashboardFilters && window.DashboardFilters.initFilterListeners) {
            window.DashboardFilters.initFilterListeners();
        }

        // Fetch additional data (staggered to avoid 429s from too many concurrent requests)
        fetchHistogram();
        fetchCostStats();
        scheduleStartupFetch(2000, 'comparison', fetchComparison);
        scheduleStartupFetch(4000, 'persistentStats', fetchPersistentStats);
        scheduleStartupFetch(6000, 'predictions', fetchPredictions);
        scheduleStartupFetch(8000, 'circuit', fetchCircuitHistory);
        scheduleStartupFetch(10000, 'process', fetchProcessHealth);
        scheduleStartupFetch(12000, 'scheduler', fetchScheduler);
        scheduleStartupFetch(14000, 'replay', fetchReplayQueue);
        fetchModels().then(function() {
            // Fetch model routing after models loaded
            if (window.DashboardTierBuilder && window.DashboardTierBuilder.fetchModelRouting) {
                window.DashboardTierBuilder.fetchModelRouting();
            }
        });

        // Restore routing tab
        var savedRoutingTab = localStorage.getItem('dashboard-routing-tab');
        if (savedRoutingTab && window.DashboardInit && window.DashboardInit.switchRoutingTab) {
            window.DashboardInit.switchRoutingTab(savedRoutingTab);
        }

    }

    // Register DOMContentLoaded
    document.addEventListener('DOMContentLoaded', initData);
    window.addEventListener('beforeunload', cleanup);
    window.addEventListener('pagehide', cleanup);

    // ========== EXPORT ==========
    window.DashboardData = {
        // Data fetching
        fetchStats: fetchStats,
        fetchHistory: fetchHistory,
        fetchLogs: fetchLogs,
        fetchModels: fetchModels,
        fetchTenants: fetchTenants,
        fetchHistogram: fetchHistogram,
        fetchCostStats: fetchCostStats,
        fetchComparison: fetchComparison,
        fetchCircuitHistory: fetchCircuitHistory,
        fetchProcessHealth: fetchProcessHealth,
        fetchScheduler: fetchScheduler,
        fetchReplayQueue: fetchReplayQueue,

        // UI updates
        updateUI: updateUI,
        updateCharts: updateCharts,
        updateChartTheme: updateChartTheme,
        animateNumber: animateNumber,
        updateKeysHeatmap: updateKeysHeatmap,
        selectKey: selectKey,
        closeKeyDetails: closeKeyDetails,

        // Actions (delegated → actions.js)
        exportData: exportData,
        toggleFullscreen: toggleFullscreen,
        controlAction: controlAction,
        shareURL: shareURL,
        dismissIssues: dismissIssues,
        resetAllCircuits: resetAllCircuits,
        clearQueue: clearQueue,
        exportDiagnostics: exportDiagnostics,
        forceCircuitState: forceCircuitState,
        forceCircuit: forceCircuit,
        reloadKeys: reloadKeys,
        resetStats: resetStats,
        clearLogs: clearLogs,
        selectTenant: selectTenant,

        // Trace detail (delegated → traces.js)
        loadTracesFromAPI: loadTracesFromAPI,
        showTraceDetail: showTraceDetail,
        closeTraceDetail: closeTraceDetail,
        searchTraceById: searchTraceById,
        exportTraces: exportTraces,
        clearTraceFilters: clearTraceFilters,
        copyTraceId: copyTraceId,
        copyTraceJson: copyTraceJson,

        // Key override modal (delegated → actions.js)
        openKeyOverrideModal: openKeyOverrideModal,
        closeKeyOverrideModal: closeKeyOverrideModal,
        addOverride: addOverride,
        removeOverride: removeOverride,
        saveKeyOverrides: saveKeyOverrides,
        renderOverrideList: renderOverrideList,

        // Account details & chart navigation
        toggleAccountDetails: toggleAccountDetails,
        navigateAccountChart: navigateAccountChart,
        fetchAccountDetails: fetchAccountDetails,

        // Polling controls (delegated → polling.js)
        pausePolling: DPolling.pausePolling,
        resumePolling: DPolling.resumePolling,
        getPollingBackoffState: DPolling.getPollingBackoffState,
        onTabChanged: DPolling.onTabChanged,
        onTimeRangeChanged: function(range) {
            DPolling.onTimeRangeChanged(range);
            if (historyFetchController) { historyFetchController.abort(); historyFetchController = null; }
        },

        // Cleanup
        cleanup: cleanup,
        clearAllPollingIntervals: DPolling.clearAllPollingIntervals,
        startAllPolling: DPolling.startAllPolling,

        // DOM caching utilities (for testing/internals)
        cacheDomRefs: cacheDomRefs,
        getCachedEl: getEl
    };

})(window);
