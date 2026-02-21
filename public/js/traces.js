/**
 * traces.js — Trace Table & Detail Panel
 * Extracted from data.js Phase 4 split.
 *
 * Dependencies: store.js (STATE, escapeHtml, formatTimestamp, renderTableEmptyState),
 *               dom-cache.js (getAuthHeaders),
 *               error-boundary.js (showToast)
 */
(function(window) {
    'use strict';

    var DS = window.DashboardStore;
    var STATE = DS.STATE;
    var escapeHtml = DS.escapeHtml;
    var formatTimestamp = DS.formatTimestamp;
    var renderTableEmptyState = DS.renderTableEmptyState;
    var getAuthHeaders = window.DashboardDOM.getAuthHeaders;
    var showToast = window.showToast || function() {};

    var currentTraceData = null;

    // ========== TRACE TABLE ==========
    function updateTracesTable(request) {
        STATE.traces.unshift({
            timestamp: request.timestamp, keyIndex: request.keyIndex, path: request.path,
            status: request.error ? 'error' : request.status === 'completed' ? 'success' : 'pending',
            latency: request.latency, traceId: request.requestId || null, attempts: 1, queueDuration: null
        });
        if (STATE.traces.length > 100) STATE.traces = STATE.traces.slice(0, 100);
        renderTracesTable();
    }
    window.updateTracesTable = updateTracesTable;

    function renderTracesTable() {
        var tbody = document.getElementById('tracesBody');
        if (!tbody) return;
        tbody.innerHTML = STATE.traces.map(function(t) {
            var time = formatTimestamp(t.timestamp);
            var statusClass = t.status === 'success' ? 'success' : t.status === 'error' ? 'error' : 'pending';
            var statusIcon = t.status === 'success' ? 'OK' : t.status === 'error' ? 'ERR' : '...';
            return '<tr data-trace-id="' + escapeHtml(t.traceId || '') + '" data-action="show-trace" style="cursor:pointer;">' +
                '<td class="monospace">' + time + '</td>' +
                '<td class="monospace" title="' + escapeHtml(t.traceId || '') + '">' + (t.traceId ? t.traceId.substring(0, 12) + '...' : '-') + '</td>' +
                '<td>' + escapeHtml(t.path || '/v1/messages') + '</td>' +
                '<td>' + (t.attempts || 1) + '</td>' +
                '<td class="monospace">' + (t.queueDuration ? t.queueDuration + 'ms' : '-') + '</td>' +
                '<td class="monospace">' + (t.latency ? t.latency + 'ms' : '-') + '</td>' +
                '<td><span class="trace-status ' + statusClass + '"></span>' + statusIcon + '</td></tr>';
        }).join('');
    }

    function loadTracesFromAPI() {
        var params = new URLSearchParams();
        var sf = document.getElementById('traceFilterStatus');
        var rf = document.getElementById('traceFilterRetries');
        var tf = document.getElementById('traceFilterTimeRange');
        var lf = document.getElementById('traceFilterLatency');
        var pf = document.getElementById('traceFilterPath');
        if (sf && sf.value) params.set('success', sf.value);
        if (rf && rf.value === 'true') params.set('hasRetries', 'true');
        if (lf && lf.value) params.set('minDuration', lf.value);
        if (tf && tf.value) { params.set('since', new Date(Date.now() - parseInt(tf.value, 10) * 60000).toISOString()); }
        params.set('limit', '100');

        var url = '/traces' + (params.toString() ? '?' + params.toString() : '');
        fetch(url, { headers: getAuthHeaders() })
            .then(function(res) { if (!res.ok) throw new Error('Failed to fetch traces'); return res.json(); })
            .then(function(data) {
                var traces = data.traces || [];
                if (pf && pf.value && pf.value.trim()) {
                    var fl = pf.value.toLowerCase().trim();
                    traces = traces.filter(function(t) { return (t.path || '').toLowerCase().indexOf(fl) >= 0; });
                }
                STATE.apiTraces = traces;
                var successCount = traces.filter(function(t) { return t.success; }).length;
                var failedCount = traces.filter(function(t) { return !t.success; }).length;
                var retryCount = traces.filter(function(t) { return (t.attempts || 1) > 1; }).length;
                var avgLatency = traces.length > 0 ? Math.round(traces.reduce(function(s, t) { return s + (t.totalDuration || 0); }, 0) / traces.length) : 0;

                var el;
                el = document.getElementById('traceStatsCount'); if (el) el.textContent = traces.length + ' traces';
                el = document.getElementById('traceStatsSuccess'); if (el) el.textContent = successCount + ' success';
                el = document.getElementById('traceStatsFailed'); if (el) el.textContent = failedCount + ' failed';
                el = document.getElementById('traceStatsRetries'); if (el) el.textContent = retryCount + ' with retries';
                el = document.getElementById('traceStatsAvgLatency'); if (el) el.textContent = 'Avg: ' + avgLatency + 'ms';

                renderAPITracesTable();
            })
            .catch(function(err) {
                console.error('Failed to load traces:', err);
                showToast('Failed to load traces: ' + err.message, 'error');
            });
    }
    window.loadTracesFromAPI = loadTracesFromAPI;

    function renderAPITracesTable() {
        var tbody = document.getElementById('tracesBody');
        if (!tbody) return;
        var traces = STATE.apiTraces || [];
        if (traces.length === 0) { tbody.innerHTML = renderTableEmptyState(8, 'No traces found'); return; }
        tbody.innerHTML = traces.map(function(t) {
            var time = formatTimestamp(t.startTime);
            var statusClass = t.success ? 'success' : 'error';
            var statusIcon = t.success ? 'OK' : 'ERR';
            var safePath = escapeHtml(t.path || '/v1/messages');
            var shortId = t.traceId ? t.traceId.substring(0, 12) + '...' : '-';
            var model = t.model ? escapeHtml(t.model.split('/').pop().substring(0, 12)) : '-';
            var attempts = t.attempts || 1;
            return '<tr data-trace-id="' + escapeHtml(t.traceId) + '" data-action="show-trace" style="cursor:pointer;">' +
                '<td class="monospace">' + time + '</td>' +
                '<td class="monospace" title="' + escapeHtml(t.traceId) + '">' + shortId + '</td>' +
                '<td title="' + safePath + '">' + (safePath.length > 25 ? safePath.substring(0, 25) + '...' : safePath) + '</td>' +
                '<td class="monospace" style="font-size:0.7rem;" title="' + escapeHtml(t.model || '') + '">' + model + '</td>' +
                '<td' + (attempts > 1 ? ' style="color:var(--warning);"' : '') + '>' + attempts + '</td>' +
                '<td class="monospace">' + (t.queueDuration ? t.queueDuration + 'ms' : '-') + '</td>' +
                '<td class="monospace">' + (t.totalDuration ? t.totalDuration + 'ms' : '-') + '</td>' +
                '<td><span class="trace-status ' + statusClass + '"></span>' + statusIcon + '</td></tr>';
        }).join('');
    }

    // ========== TRACE DETAIL ==========
    function showTraceDetail(traceId) {
        if (!traceId) return;
        var panel = document.getElementById('traceDetailPanel');
        if (panel) panel.style.display = 'block';

        document.getElementById('traceDetailId').textContent = traceId;
        var fields = ['traceDetailStatus', 'traceDetailModel', 'traceDetailDuration', 'traceDetailAttempts', 'traceDetailQueue', 'traceDetailKey'];
        var defaults = ['Loading...', '-', '-', '-', '-', '-'];
        for (var i = 0; i < fields.length; i++) {
            var el = document.getElementById(fields[i]);
            if (el) el.textContent = defaults[i];
        }
        var timeline = document.getElementById('traceTimeline');
        if (timeline) timeline.innerHTML = '<div style="color: var(--text-secondary);">Loading...</div>';
        var attemptsList = document.getElementById('traceAttemptsList');
        if (attemptsList) attemptsList.innerHTML = '';
        var errorSection = document.getElementById('traceErrorSection');
        if (errorSection) errorSection.style.display = 'none';
        var rawEl = document.getElementById('traceDetailRaw');
        if (rawEl) rawEl.textContent = '';

        fetch('/traces/' + encodeURIComponent(traceId), { headers: getAuthHeaders() })
            .then(function(res) {
                if (!res.ok) throw new Error('Trace not found');
                return res.json();
            })
            .then(function(data) {
                var trace = data.trace;
                currentTraceData = trace;
                var statusEl = document.getElementById('traceDetailStatus');
                if (statusEl) {
                    statusEl.textContent = trace.success ? 'Success' : 'Failed';
                    statusEl.style.color = trace.success ? 'var(--success)' : 'var(--danger)';
                }
                var modelEl = document.getElementById('traceDetailModel');
                if (modelEl) modelEl.textContent = trace.model || 'N/A';
                var durEl = document.getElementById('traceDetailDuration');
                if (durEl) durEl.textContent = trace.totalDuration ? trace.totalDuration + 'ms' : '-';
                var attEl = document.getElementById('traceDetailAttempts');
                if (attEl) attEl.textContent = (trace.attempts ? trace.attempts.length : 1) + ' attempt(s)';
                var queueEl = document.getElementById('traceDetailQueue');
                if (queueEl) queueEl.textContent = trace.queueDuration ? trace.queueDuration + 'ms' : '-';
                var lastAttempt = trace.attempts && trace.attempts.length > 0 ? trace.attempts[trace.attempts.length - 1] : null;
                var keyEl = document.getElementById('traceDetailKey');
                if (keyEl) keyEl.textContent = lastAttempt ? '#' + lastAttempt.keyIndex + ' (' + (lastAttempt.keyId || 'unknown').substring(0, 12) + ')' : '-';
                renderTraceTimeline(trace);
                renderTraceAttempts(trace);
                if (!trace.success && trace.finalError) {
                    var errSec = document.getElementById('traceErrorSection');
                    if (errSec) errSec.style.display = 'block';
                    var errContent = document.getElementById('traceErrorContent');
                    if (errContent) errContent.textContent = trace.finalError;
                }
                var rawDataEl = document.getElementById('traceDetailRaw');
                if (rawDataEl) rawDataEl.textContent = JSON.stringify(trace, null, 2);
            })
            .catch(function(err) {
                var s = document.getElementById('traceDetailStatus');
                if (s) { s.textContent = 'Error'; s.style.color = 'var(--danger)'; }
                var t = document.getElementById('traceTimeline');
                if (t) t.innerHTML = '<div style="color: var(--danger);">Error: ' + escapeHtml(err.message) + '</div>';
            });
    }

    function renderTraceTimeline(trace) {
        var container = document.getElementById('traceTimeline');
        if (!container) return;
        if (!trace.totalDuration || trace.totalDuration === 0) {
            container.innerHTML = '<div style="color: var(--text-secondary); font-size: 0.7rem;">No timing data available</div>';
            return;
        }
        var total = trace.totalDuration;
        var queueTime = trace.queueDuration || 0;
        var queuePct = Math.min((queueTime / total) * 100, 100);
        var segments = [];
        if (queueTime > 0) segments.push({ type: 'queue', pct: queuePct, label: 'Queue ' + queueTime + 'ms' });
        if (trace.attempts && trace.attempts.length > 0) {
            var processingTime = total - queueTime;
            var remainingPct = 100 - queuePct;
            for (var i = 0; i < trace.attempts.length; i++) {
                var attempt = trace.attempts[i];
                var attemptDuration = attempt.duration || 0;
                var attemptPct = processingTime > 0 ? (attemptDuration / processingTime) * remainingPct : remainingPct / trace.attempts.length;
                var type = attempt.success ? 'success' : (i < trace.attempts.length - 1 ? 'retry' : 'processing');
                segments.push({ type: type, pct: Math.max(attemptPct, 2), label: 'Attempt ' + (i + 1) + ': ' + attemptDuration + 'ms' });
            }
        } else {
            segments.push({ type: trace.success ? 'success' : 'processing', pct: 100 - queuePct, label: 'Processing' });
        }
        var barsHtml = segments.map(function(s) {
            return '<div class="trace-timeline-bar ' + s.type + '" style="width: ' + s.pct + '%; flex-shrink: 0;" title="' + escapeHtml(s.label) + '"></div>';
        }).join('');
        container.innerHTML =
            '<div class="trace-timeline-label start">' + formatTimestamp(trace.startTime) + '</div>' +
            '<div class="trace-timeline-label end">' + (trace.endTime ? formatTimestamp(trace.endTime) : 'In Progress') + '</div>' +
            '<div style="display: flex; width: 100%; gap: 2px; margin-top: 8px;">' + barsHtml + '</div>' +
            '<div style="font-size: 0.6rem; color: var(--text-secondary); margin-top: 4px; display: flex; gap: 12px;">' +
                '<span><span style="display: inline-block; width: 8px; height: 8px; background: var(--warning); border-radius: 2px;"></span> Queue</span>' +
                '<span><span style="display: inline-block; width: 8px; height: 8px; background: var(--primary); border-radius: 2px;"></span> Processing</span>' +
                '<span><span style="display: inline-block; width: 8px; height: 8px; background: var(--success); border-radius: 2px;"></span> Success</span>' +
                '<span><span style="display: inline-block; width: 8px; height: 8px; background: var(--danger); opacity: 0.7; border-radius: 2px;"></span> Retry</span>' +
            '</div>';
    }

    function renderTraceAttempts(trace) {
        var container = document.getElementById('traceAttemptsList');
        if (!container) return;
        if (!trace.attempts || trace.attempts.length === 0) {
            container.innerHTML = '<div style="color: var(--text-secondary); font-size: 0.7rem;">No attempt data available</div>';
            return;
        }
        var html = '';
        for (var i = 0; i < trace.attempts.length; i++) {
            var attempt = trace.attempts[i];
            var isLast = i === trace.attempts.length - 1;
            var statusClass = attempt.success ? 'success' : (isLast ? 'failed' : 'retried');
            var statusText = attempt.success ? 'Success' : (isLast ? 'Failed' : 'Retried');
            html += '<div class="trace-attempt-card ' + statusClass + '">' +
                '<div class="trace-attempt-header">' +
                    '<span class="attempt-num">Attempt ' + (i + 1) + '</span>' +
                    '<span class="attempt-status ' + (attempt.success ? 'success' : 'failed') + '">' + statusText + '</span>' +
                '</div>' +
                '<div class="trace-attempt-details">' +
                    '<div class="trace-attempt-detail"><span class="label">Key</span><span>#' + attempt.keyIndex + ' (' + escapeHtml((attempt.keyId || 'unknown').substring(0, 12)) + ')</span></div>' +
                    '<div class="trace-attempt-detail"><span class="label">Duration</span><span>' + (attempt.duration ? attempt.duration + 'ms' : '-') + '</span></div>' +
                    '<div class="trace-attempt-detail"><span class="label">Selection</span><span>' + escapeHtml(attempt.selectionReason || 'N/A') + '</span></div>' +
                    (attempt.error ? '<div class="trace-attempt-detail" style="grid-column: 1 / -1;"><span class="label">Error</span><span style="color: var(--danger);">' + escapeHtml(attempt.error) + '</span></div>' : '') +
                    (attempt.retryReason ? '<div class="trace-attempt-detail"><span class="label">Retry Reason</span><span>' + escapeHtml(attempt.retryReason) + '</span></div>' : '') +
                '</div></div>';
        }
        container.innerHTML = html;
    }

    function closeTraceDetail() {
        var panel = document.getElementById('traceDetailPanel');
        if (panel) panel.style.display = 'none';
        currentTraceData = null;
    }

    function searchTraceById() {
        var searchInput = document.getElementById('traceSearchId');
        var traceId = searchInput ? (searchInput.value || '').trim() : '';
        var notFound = document.getElementById('traceNotFound');
        if (notFound) notFound.style.display = 'none';
        if (traceId && traceId.length >= 8) {
            showTraceDetail(traceId);
            setTimeout(function() {
                var detailPanel = document.getElementById('traceDetailPanel');
                if (detailPanel && detailPanel.style.display === 'none' && notFound) {
                    notFound.style.display = 'block';
                }
            }, 500);
        }
    }

    function exportTraces() {
        var traces = STATE.apiTraces || [];
        if (traces.length === 0) { showToast('No traces to export', 'warning'); return; }
        var data = { exportedAt: new Date().toISOString(), count: traces.length, traces: traces };
        var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'traces-export-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('Exported ' + traces.length + ' traces', 'success');
    }

    function clearTraceFilters() {
        var ids = ['traceFilterStatus', 'traceFilterRetries', 'traceFilterTimeRange', 'traceFilterLatency', 'traceFilterPath', 'traceSearchId'];
        for (var i = 0; i < ids.length; i++) {
            var el = document.getElementById(ids[i]);
            if (el) el.value = '';
        }
        loadTracesFromAPI();
    }

    function copyTraceId() {
        if (currentTraceData && currentTraceData.traceId) {
            navigator.clipboard.writeText(currentTraceData.traceId).then(function() { showToast('Trace ID copied', 'success'); }).catch(function() { showToast('Failed to copy', 'error'); });
        }
    }

    function copyTraceJson() {
        if (currentTraceData) {
            navigator.clipboard.writeText(JSON.stringify(currentTraceData, null, 2)).then(function() { showToast('Trace JSON copied', 'success'); }).catch(function() { showToast('Failed to copy', 'error'); });
        }
    }

    // ========== EXPORT ==========
    window.DashboardTraces = {
        updateTracesTable: updateTracesTable,
        renderTracesTable: renderTracesTable,
        loadTracesFromAPI: loadTracesFromAPI,
        showTraceDetail: showTraceDetail,
        closeTraceDetail: closeTraceDetail,
        searchTraceById: searchTraceById,
        exportTraces: exportTraces,
        clearTraceFilters: clearTraceFilters,
        copyTraceId: copyTraceId,
        copyTraceJson: copyTraceJson
    };

})(window);
