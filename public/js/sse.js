/**
 * sse.js — Server-Sent Events (SSE) Connection Management
 * Phase 6: Split from dashboard.js
 *
 * Handles: EventSource setup, reconnection, SSE message handling,
 * request stream rendering, virtual scroll, connection status,
 * request polling fallback.
 */
(function(window) {
    'use strict';

    var DS = window.DashboardStore;
    var STATE = DS.STATE;
    var store = DS.store;
    var Actions = DS.Actions;
    var escapeHtml = DS.escapeHtml;
    var chipModelName = DS.chipModelName;
    var formatTimestamp = DS.formatTimestamp;
    var renderEmptyState = DS.renderEmptyState;

    var requestPollingIntervalId = null;
    var staleCheckIntervalId = null;

    // ========== VIRTUAL SCROLL RENDERER ==========
    var VIRTUAL_ROW_HEIGHT = 28;
    var VIRTUAL_BUFFER = 20;
    var virtualScrollRAF = null;

    function scheduleVirtualRender() {
        if (virtualScrollRAF) return;
        virtualScrollRAF = requestAnimationFrame(function() {
            virtualScrollRAF = null;
            renderVirtualRequestList();
        });
    }

    function renderVirtualRequestList() {
        var viewport = document.querySelector('.virtual-scroll-viewport');
        var container = document.getElementById('liveStreamRequestList');
        if (!viewport || !container) return;

        // Skip rendering if viewport is not visible (IntersectionObserver will re-trigger when visible)
        if (!isViewportVisible) return;

        var items = (window.DashboardFilters && window.DashboardFilters.getFilteredRequests)
            ? window.DashboardFilters.getFilteredRequests()
            : STATE.requestsHistory;
        var totalItems = items.length;
        if (totalItems === 0) return;

        var ordering = window.DashboardInit?.getTabOrdering ? window.DashboardInit.getTabOrdering('live') : 'desc';
        var isDescending = ordering === 'desc';

        var viewportHeight = viewport.clientHeight || 400;
        var scrollTop = viewport.scrollTop;

        var visibleCount = Math.ceil(viewportHeight / VIRTUAL_ROW_HEIGHT);
        var startIndex = Math.floor(scrollTop / VIRTUAL_ROW_HEIGHT);
        var bufferedStart = Math.max(0, startIndex - VIRTUAL_BUFFER);
        var endIndex = Math.min(startIndex + visibleCount + VIRTUAL_BUFFER, totalItems);

        var totalHeight = totalItems * VIRTUAL_ROW_HEIGHT;
        container.style.height = totalHeight + 'px';
        container.style.position = 'relative';

        var fragment = document.createDocumentFragment();
        for (var displayIdx = bufferedStart; displayIdx < endIndex; displayIdx++) {
            var arrayIdx;
            if (isDescending) {
                arrayIdx = totalItems - 1 - displayIdx;
            } else {
                arrayIdx = displayIdx;
            }
            if (arrayIdx < 0 || arrayIdx >= totalItems) break;
            var item = items[arrayIdx];

            var tmp = document.createElement('div');
            tmp.innerHTML = renderRequestRow(item);
            var rowEl = tmp.firstElementChild;
            if (rowEl) {
                rowEl.style.position = 'absolute';
                rowEl.style.top = (displayIdx * VIRTUAL_ROW_HEIGHT) + 'px';
                rowEl.style.left = '0';
                rowEl.style.right = '0';
                rowEl.style.height = VIRTUAL_ROW_HEIGHT + 'px';
                // Preserve selection state across virtual re-renders
                if (STATE.selectedRequestId && rowEl.dataset.requestId === STATE.selectedRequestId) {
                    rowEl.classList.add('selected');
                }
                fragment.appendChild(rowEl);
            }
        }

        container.innerHTML = '';
        container.appendChild(fragment);
    }

    // Attach scroll listener after a tick to ensure DOM is ready
    setTimeout(function() {
        var viewport = document.querySelector('.virtual-scroll-viewport');
        if (viewport) {
            viewport.addEventListener('scroll', scheduleVirtualRender, { passive: true });
        }
    }, 0);

    // ========== VISIBILITY OPTIMIZATION ==========
    // Use IntersectionObserver to pause/resume virtual scroll rendering when not visible
    var viewportVisibilityObserver = null;
    var isViewportVisible = true;

    function setupViewportVisibilityObserver() {
        if (!('IntersectionObserver' in window)) return;

        var viewport = document.querySelector('.virtual-scroll-viewport');
        if (!viewport) return;

        viewportVisibilityObserver = new IntersectionObserver(function(entries) {
            entries.forEach(function(entry) {
                var wasVisible = isViewportVisible;
                isViewportVisible = entry.isIntersecting;

                // When viewport becomes visible again, re-render to update
                if (!wasVisible && isViewportVisible) {
                    scheduleVirtualRender();
                }
            });
        }, {
            threshold: 0.1
        });

        viewportVisibilityObserver.observe(viewport);
    }

    // Initialize visibility observer after DOM is ready
    setTimeout(setupViewportVisibilityObserver, 0);

    function updateRequestCountBadge(count) {
        var badge = document.getElementById('requestCountBadge');
        if (badge) badge.textContent = String(count || 0);
    }

    function formatCompactNumber(value) {
        var num = Number(value) || 0;
        if (num >= 1000000) return (num / 1000000).toFixed(num >= 10000000 ? 0 : 1) + 'M';
        if (num >= 1000) return (num / 1000).toFixed(num >= 10000 ? 0 : 1) + 'K';
        return String(Math.round(num));
    }

    function formatCompactCost(totalCost) {
        var cost = Number(totalCost) || 0;
        if (cost <= 0) return '$0';
        if (cost < 0.0001) return '<$0.0001';
        if (cost < 0.01) return '$' + cost.toFixed(5);
        if (cost < 1) return '$' + cost.toFixed(4);
        return '$' + cost.toFixed(3);
    }

    function updateLiveSummary() {
        var summaryEl = document.getElementById('liveStreamSummary');
        if (!summaryEl) return;

        var history = STATE.requestsHistory || [];
        if (history.length === 0) {
            summaryEl.textContent = 'No requests yet';
            return;
        }

        var sample = history.slice(-40);
        var success = 0;
        var completed = 0;
        var latencyTotal = 0;
        var latencyCount = 0;
        var tokenTotal = 0;
        var costTotal = 0;

        for (var i = 0; i < sample.length; i++) {
            var req = sample[i] || {};
            var statusCode = Number(req.statusCode);
            var isError = !!req.error;
            var isCompleted = isError || req.status === 'completed' || (Number.isFinite(statusCode) && statusCode > 0);
            if (isCompleted) {
                completed++;
                if (!isError && (!Number.isFinite(statusCode) || (statusCode >= 200 && statusCode < 400))) {
                    success++;
                }
            }

            var latency = Number(req.latency || req.latencyMs);
            if (Number.isFinite(latency) && latency > 0) {
                latencyTotal += latency;
                latencyCount++;
            }

            tokenTotal += Number(req.inputTokens || 0) + Number(req.outputTokens || 0);
            if (req.cost && Number(req.cost.total) > 0) {
                costTotal += Number(req.cost.total);
            }
        }

        var successRate = completed > 0 ? Math.round((success / completed) * 100) : 100;
        var avgLatency = latencyCount > 0 ? Math.round(latencyTotal / latencyCount) + 'ms' : '--';
        summaryEl.textContent =
            sample.length + ' req · ' +
            successRate + '% ok · ' +
            avgLatency + ' avg · ' +
            formatCompactNumber(tokenTotal) + ' tok · ' +
            formatCompactCost(costTotal);
        summaryEl.title = 'Last ' + sample.length + ' live requests';
    }

    function renderRequestRow(request) {
        var time = formatTimestamp(request.timestamp);
        var statusClass = request.error ? 'error' : request.status === 'completed' ? 'success' : 'pending';
        var statusText = request.error ? 'ERR' : request.latency ? request.latency + 'ms' : '...';
        var safePath = escapeHtml(request.path || '/v1/messages');
        var requestId = request.requestId || (request.timestamp + '-' + (request.keyIndex ?? 0));
        var model = request.originalModel || request.mappedModel || '';

        var rd = request.routingDecision;
        var originalDisplay = chipModelName(request.originalModel);
        var mappedDisplay = chipModelName(request.mappedModel);
        var fullTitle = rd
            ? (request.originalModel || '?') + ' \u2192 ' + (request.mappedModel || '?') + ' | ' + (rd.reason || '')
            : (request.originalModel || '') + ' \u2192 ' + (request.mappedModel || '');
        var chipInner = '<span class="chip-src">' + escapeHtml(originalDisplay) + '</span><span class="chip-arrow">\u2192</span><span class="chip-dst">' + escapeHtml(mappedDisplay) + '</span>';
        var hasChip = !!(rd || request.mappedModel);
        var routingChip = rd
            ? '<span class="routing-chip routing-chip--' + escapeHtml(rd.source || 'default') + '" title="' + escapeHtml(fullTitle) + '">' + chipInner + '</span>'
            : (request.mappedModel ? '<span class="routing-chip routing-chip--legacy" title="' + escapeHtml(fullTitle) + '">' + chipInner + '</span>' : '');
        var pathStyle = hasChip ? '' : ' style="grid-column: span 2;"';

        // Cost & tokens display (always render spans so grid stays aligned)
        var inTok = request.inputTokens || 0;
        var outTok = request.outputTokens || 0;
        var tokensHtml = (inTok || outTok)
            ? '<span class="request-tokens" title="Input ' + inTok + ' tokens · Output ' + outTok + ' tokens">' +
                '<span class="request-token-part in">I ' + formatCompactNumber(inTok) + '</span>' +
                '<span class="request-token-sep">\u00B7</span>' +
                '<span class="request-token-part out">O ' + formatCompactNumber(outTok) + '</span>' +
              '</span>'
            : '<span class="request-tokens empty" title="No token usage captured">\u2014</span>';

        var costHtml = '';
        if (request.cost && request.cost.total > 0) {
            var costStr = formatCompactCost(request.cost.total);
            var costTitle = 'Input: $' + (request.cost.inputCost || 0).toFixed(6) +
                ' (' + (request.cost.inputRate || 0) + '/1M)' +
                '\nOutput: $' + (request.cost.outputCost || 0).toFixed(6) +
                ' (' + (request.cost.outputRate || 0) + '/1M)' +
                '\nModel: ' + (request.cost.model || '?');
            costHtml = '<span class="request-cost" title="' + escapeHtml(costTitle) + '">' + costStr + '</span>';
        } else {
            costHtml = '<span class="request-cost empty" title="No cost captured">\u2014</span>';
        }

        return '<div class="request-row" data-action="view-request" data-request-id="' + escapeHtml(requestId) + '" data-testid="request-row"' +
            ' data-status="' + statusClass + '" data-key-index="' + (request.keyIndex ?? '') + '" data-model="' + escapeHtml(model) + '">' +
            '<span class="request-time">' + time + '</span>' +
            '<span class="request-key">K' + (request.keyIndex ?? '?') + '</span>' +
            routingChip +
            '<span class="request-path"' + pathStyle + '>' + safePath + '</span>' +
            tokensHtml +
            costHtml +
            '<span class="request-status ' + statusClass + '">' + statusText + '</span>' +
            '</div>';
    }

    // ========== LIVE REQUEST STREAM (SSE) ==========
    var isReconnecting = false;

    function connectRequestStream() {
        // Prevent multiple concurrent reconnection attempts
        if (isReconnecting) {
            return;
        }
        isReconnecting = true;

        if (STATE.sse.eventSource) {
            STATE.sse.eventSource.close();
        }

        try {
            // Reset reconnection attempts on new connection
            STATE.sse.reconnectAttempts = 0;
            STATE.sse.eventSource = new EventSource('/requests/stream');

            STATE.sse.eventSource.onopen = function() {
                STATE.sse.connected = true;
                updateConnectionStatus('connected');
                isReconnecting = false;
                var clientId = 'sse-' + Date.now();
                if (DS.debugEnabled) console.log('SSE connection established (client:', clientId + ')');
                store.dispatch(Actions.sseConnected({ clientId: clientId, recentRequests: [] }));

                if (window._liveFlowViz) {
                    window._liveFlowViz._sseAttached = false;
                    window._liveFlowViz._stopFallbackPolling();
                    window._liveFlowViz._attachSSE();
                }
            };

            STATE.sse.eventSource.onmessage = function(e) {
                try {
                    var data = JSON.parse(e.data);
                    if (data.type === 'init') {
                        if (DS.debugEnabled) console.log('SSE init:', data.requests.length, 'requests');
                        renderInitialRequests(data.requests);
                    } else {
                        addRequestToStream(data);
                    }
                } catch (err) {
                    console.error('SSE parse error:', err);
                }
            };

            // Listen for named 'request-complete' events (new requests)
            STATE.sse.eventSource.addEventListener('request-complete', function(e) {
                try {
                    var data = JSON.parse(e.data);
                    if (DS.debugEnabled) console.log('SSE request-complete:', data.path || 'unknown');
                    addRequestToStream(data);
                } catch (err) {
                    if (DS.debugEnabled) console.error('SSE request-complete parse error:', err);
                }
            });

            STATE.sse.eventSource.onerror = function() {
                isReconnecting = false;  // Allow next reconnection attempt
                STATE.sse.connected = false;
                updateConnectionStatus('error');
                store.dispatch(Actions.sseDisconnected());

                if (window._liveFlowViz && !window._liveFlowViz._usePolling) {
                    window._liveFlowViz._sseAttached = false;
                    window._liveFlowViz._setStatus('error');
                    window._liveFlowViz._startFallbackPolling();
                }

                // Implement exponential backoff with jitter
                var baseDelay = DS.debugEnabled ? 500 : 5000;
                var backoffMultiplier = Math.min(STATE.sse.reconnectAttempts || 1, 10);
                var jitter = Math.random() * 1000;  // Add random jitter (0-1s)
                var reconnectDelay = Math.min(baseDelay * Math.pow(1.5, backoffMultiplier - 1) + jitter, 30000);

                // Track reconnection attempts
                STATE.sse.reconnectAttempts = (STATE.sse.reconnectAttempts || 0) + 1;

                if (DS.debugEnabled) console.log('SSE reconnecting in', Math.round(reconnectDelay / 1000) + 's (attempt', STATE.sse.reconnectAttempts + ')');

                setTimeout(connectRequestStream, reconnectDelay);
            };

        } catch (err) {
            isReconnecting = false;
            if (DS.debugEnabled) console.error('SSE connection failed:', err);
            startRequestPolling();
        }
    }

    function renderInitialRequests(requests) {
        var container = document.getElementById('liveStreamRequestList');
        if (!requests || requests.length === 0) {
            container.innerHTML = renderEmptyState('No requests yet', { icon: '\u2014' });
            updateRequestCountBadge(0);
            updateLiveSummary();
            return;
        }

        var existingById = new Map(STATE.requestsHistory.map(function(r) {
            return [r.requestId || (r.timestamp + '-' + (r.keyIndex ?? 0)), r];
        }));
        for (var i = 0; i < requests.length; i++) {
            var req = requests[i];
            var id = req.requestId || (req.timestamp + '-' + (req.keyIndex ?? 0));
            if (!existingById.has(id)) {
                existingById.set(id, req);
            }
        }
        STATE.requestsHistory = Array.from(existingById.values());

        // Sort requests according to tab ordering preference
        var ordering = window.DashboardInit?.getTabOrdering ? window.DashboardInit.getTabOrdering('live') : 'desc';
        var sortedRequests = STATE.requestsHistory.slice().sort(function(a, b) {
            var tsA = a.timestamp || 0;
            var tsB = b.timestamp || 0;
            return ordering === 'desc' ? tsB - tsA : tsA - tsB;
        });

        container.innerHTML = sortedRequests.map(function(r) { return renderRequestRow(r); }).join('');
        updateRequestCountBadge(sortedRequests.length);
        updateLiveSummary();

        STATE.traces = requests.slice(0, 100).map(function(r) {
            return {
                timestamp: r.timestamp,
                keyIndex: r.keyIndex,
                path: r.path,
                status: r.error ? 'error' : r.status === 'completed' ? 'success' : 'pending',
                latency: r.latency
            };
        });
        if (typeof window.updateTracesTable === 'function') {
            window.updateTracesTable(requests[0]);
        }
    }

    function addRequestToStream(request) {
        store.dispatch(Actions.requestReceived(request));
        updateRequestCountBadge(STATE.requestsHistory.length);
        updateLiveSummary();
        scheduleVirtualRender();
        updateRecentRequestsTable();
        if (typeof window.updateTracesTable === 'function') {
            window.updateTracesTable(request);
        }
    }

    // Store callback — clear placeholder, schedule virtual scroll render
    store._onRequestReceived = function(request) {
        var container = document.getElementById('liveStreamRequestList');
        if (!container) return;

        var placeholderText = container.textContent || '';
        if (placeholderText.includes('No requests') || placeholderText.includes('Connecting')) {
            container.innerHTML = '';
        }

        scheduleVirtualRender();
        updateRequestCountBadge(STATE.requestsHistory.length);
        updateLiveSummary();
    };

    if (DS.debugEnabled) {
        window.__DASHBOARD_DEBUG__.addRequestToStream = addRequestToStream;
    }

    function startRequestPolling() {
        var lastSeenTimestamp = 0;
        requestPollingIntervalId = setInterval(async function() {
            if (STATE.sse.connected) return;

            // Fetch recent requests, only adding genuinely new ones
            try {
                var res = await fetch('/requests?limit=20');
                if (res.ok) {
                    var data = await res.json();
                    if (data && data.requests && data.requests.length > 0) {
                        var newRequests = data.requests.filter(function(req) {
                            return (req.timestamp || 0) > lastSeenTimestamp;
                        });
                        if (newRequests.length > 0) {
                            newRequests.forEach(function(req) {
                                addRequestToStream(req);
                            });
                            lastSeenTimestamp = Math.max.apply(null, newRequests.map(function(r) {
                                return r.timestamp || 0;
                            }));
                        }
                    }
                }
            } catch (err) {
                // Heartbeat fallback
                try { await fetch('/stats'); } catch (_) { /* ignore */ }
            }
        }, 5000);
    }

    // ========== CONNECTION STATUS ==========
    function updateConnectionStatus(status) {
        STATE.connection.status = status;
        STATE.connection.lastUpdate = Date.now();

        var dot = document.getElementById('connectionDot');
        var text = document.getElementById('connectionText');
        var statusContainer = document.getElementById('connectionStatus');

        if (dot) {
            dot.className = 'connection-dot ' + status;
            dot.setAttribute('data-state', status);
        }

        if (text) {
            switch(status) {
                case 'connected':
                    text.textContent = 'Connected';
                    text.className = 'connection-text';
                    // Remove retry button if present
                    var retryBtn = document.getElementById('connectionRetryBtn');
                    if (retryBtn) retryBtn.remove();
                    break;
                case 'error':
                    text.textContent = 'Connection Error';
                    text.className = 'connection-text stale';
                    addRetryButton(statusContainer);
                    break;
                case 'stale':
                    text.textContent = 'Stale Data';
                    text.className = 'connection-text stale';
                    addRetryButton(statusContainer);
                    break;
            }
        }
    }

    function addRetryButton(container) {
        if (!container) return;
        // Don't add if already present
        if (document.getElementById('connectionRetryBtn')) return;

        var retryBtn = document.createElement('button');
        retryBtn.id = 'connectionRetryBtn';
        retryBtn.className = 'btn btn-small btn-secondary';
        retryBtn.style.marginLeft = '8px';
        retryBtn.style.padding = '2px 8px';
        retryBtn.style.fontSize = '11px';
        retryBtn.textContent = 'Retry';
        retryBtn.title = 'Reconnect to server';
        retryBtn.addEventListener('click', function() {
            reconnectSSE();
        });
        container.appendChild(retryBtn);
    }

    function reconnectSSE() {
        var retryBtn = document.getElementById('connectionRetryBtn');
        if (retryBtn) retryBtn.textContent = 'Connecting...';

        // Reset state and try to reconnect
        STATE.connection.lastUpdate = Date.now();

        // Try to fetch stats to verify connection
        if (window.DashboardData && window.DashboardData.fetchStats) {
            window.DashboardData.fetchStats().then(function() {
                updateConnectionStatus('connected');
            }).catch(function() {
                var btn = document.getElementById('connectionRetryBtn');
                if (btn) btn.textContent = 'Retry';
            });
        }
    }

    function checkStaleData() {
        if (STATE.connection.lastUpdate && Date.now() - STATE.connection.lastUpdate > 10000) {
            updateConnectionStatus('stale');
            STATE.connection.staleData = true;
        }
    }

    staleCheckIntervalId = setInterval(checkStaleData, 5000);

    // ========== RECENT REQUESTS TABLE (Requests page "Table" tab) ==========
    function updateRecentRequestsTable() {
        var tbody = document.getElementById('recentRequestsBody');
        if (!tbody) return;

        var history = STATE.requestsHistory || [];
        if (history.length === 0) return;

        var recent = history.slice(-20).reverse();
        var rows = [];
        for (var i = 0; i < recent.length; i++) {
            var r = recent[i];
            var time = formatTimestamp(r.timestamp || Date.now());
            var key = 'K' + (r.keyIndex != null ? r.keyIndex : '?');
            var modelDisplay;
            if (r.mappedModel && r.mappedModel !== r.originalModel) {
                modelDisplay = escapeHtml(r.originalModel || '') + ' &rarr; ' + escapeHtml(r.mappedModel || '');
            } else {
                modelDisplay = escapeHtml(r.originalModel || r.mappedModel || '-');
            }
            var isSuccess = !r.error && (r.status === 'completed' || (r.statusCode >= 200 && r.statusCode < 300));
            var statusHtml = isSuccess
                ? '<span style="color: var(--success, #22c55e);">OK ' + escapeHtml(String(r.statusCode || '')) + '</span>'
                : '<span style="color: var(--error, #ef4444);">ERR ' + escapeHtml(String(r.statusCode || r.status || '')) + '</span>';
            var latency = (r.latency || r.latencyMs || 0) + 'ms';
            rows.push(
                '<tr style="border-bottom: 1px solid var(--border);">' +
                '<td style="padding: 4px 8px; white-space: nowrap;">' + escapeHtml(time) + '</td>' +
                '<td style="padding: 4px 8px;">' + escapeHtml(key) + '</td>' +
                '<td style="padding: 4px 8px;">' + modelDisplay + '</td>' +
                '<td style="padding: 4px 8px;">' + statusHtml + '</td>' +
                '<td style="padding: 4px 8px; text-align: right;">' + escapeHtml(latency) + '</td>' +
                '</tr>'
            );
        }
        tbody.innerHTML = rows.join('');
    }

    // ========== EXPORT ==========
    window.DashboardSSE = {
        connectRequestStream: connectRequestStream,
        updateConnectionStatus: updateConnectionStatus,
        addRequestToStream: addRequestToStream,
        renderRequestRow: renderRequestRow,
        scheduleVirtualRender: scheduleVirtualRender,
        updateRequestCountBadge: updateRequestCountBadge,
        updateRecentRequestsTable: updateRecentRequestsTable,
        updateLiveSummary: updateLiveSummary,
        startRequestPolling: startRequestPolling,
        cleanup: function() {
            if (requestPollingIntervalId) clearInterval(requestPollingIntervalId);
            if (staleCheckIntervalId) clearInterval(staleCheckIntervalId);
            if (virtualScrollRAF) { cancelAnimationFrame(virtualScrollRAF); virtualScrollRAF = null; }
        }
    };

})(window);
