// Routing Dashboard JavaScript
// Displays model routing decisions with trace rationale

(function() {
    'use strict';

    // Import escapeHtml from dashboard-utils.js (assuming it's loaded before this file)
    const escapeHtml = window.DashboardUtils?.escapeHtml || function(str) {
        if (str === null || str === undefined) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    };

    // State
    const state = {
        requests: [],
        isPaused: false,
        eventSource: null,
        stats: {
            total: 0,
            withTrace: 0,
            totalLatency: 0
        }
    };

    // DOM Elements
    const elements = {
        requestsBody: null,
        totalRequests: null,
        withTrace: null,
        avgLatency: null,
        refreshBtn: null,
        pauseBtn: null,
        traceModal: null,
        traceContent: null,
        closeTraceModal: null
    };

    // Initialize
    function init() {
        // Cache DOM elements
        elements.requestsBody = document.getElementById('requestsBody');
        elements.totalRequests = document.getElementById('totalRequests');
        elements.withTrace = document.getElementById('withTrace');
        elements.avgLatency = document.getElementById('avgLatency');
        elements.refreshBtn = document.getElementById('refreshBtn');
        elements.pauseBtn = document.getElementById('pauseBtn');
        elements.traceModal = document.getElementById('traceModal');
        elements.traceContent = document.getElementById('traceContent');
        elements.closeTraceModal = document.getElementById('closeTraceModal');

        // Attach event listeners
        if (elements.refreshBtn) {
            elements.refreshBtn.addEventListener('click', refresh);
        }
        if (elements.pauseBtn) {
            elements.pauseBtn.addEventListener('click', togglePause);
        }
        if (elements.closeTraceModal) {
            elements.closeTraceModal.addEventListener('click', closeTraceModal);
        }
        if (elements.traceModal) {
            elements.traceModal.addEventListener('click', (e) => {
                if (e.target === elements.traceModal) {
                    closeTraceModal();
                }
            });
        }

        // Start SSE connection
        connectSSE();
    }

    // Connect to SSE stream
    function connectSSE() {
        if (state.eventSource) {
            state.eventSource.close();
        }

        const url = '/requests/stream';
        state.eventSource = new EventSource(url);

        state.eventSource.addEventListener('request-complete', handleRequestComplete);
        state.eventSource.addEventListener('error', handleSSEError);
        state.eventSource.addEventListener('open', handleSSEOpen);
    }

    // Handle SSE open event
    function handleSSEOpen() {
        if (elements.requestsBody && elements.requestsBody.querySelector('.empty-state')) {
            elements.requestsBody.innerHTML = '<tr><td colspan="7">' + renderEmptyState('Waiting for requests...', { icon: '⋯' }) + '</td></tr>';
        }
    }

    // Handle SSE error event
    function handleSSEError(e) {
        console.error('SSE error:', e);
        if (elements.requestsBody) {
            elements.requestsBody.innerHTML = '<tr><td colspan="7">' + renderLoadingState('Reconnecting...') + '</td></tr>';
        }
    }

    // Handle request complete event
    function handleRequestComplete(e) {
        if (state.isPaused) return;

        try {
            const data = JSON.parse(e.data);
            addRequest(data);
        } catch (err) {
            console.error('Error parsing request data:', err);
        }
    }

    // Add request to table
    function addRequest(data) {
        // Update stats
        state.stats.total++;
        if (data.trace) {
            state.stats.withTrace++;
        }
        if (data.latency) {
            state.stats.totalLatency += data.latency;
        }

        // Add to requests array (keep last 100)
        state.requests.unshift(data);
        if (state.requests.length > 100) {
            state.requests.pop();
        }

        // Update UI
        updateStats();
        renderRequests();
    }

    // Update stats display
    function updateStats() {
        if (elements.totalRequests) {
            elements.totalRequests.textContent = state.stats.total;
        }
        if (elements.withTrace) {
            elements.withTrace.textContent = state.stats.withTrace;
        }
        if (elements.avgLatency && state.stats.total > 0) {
            const avg = Math.round(state.stats.totalLatency / state.stats.total);
            elements.avgLatency.textContent = avg + 'ms';
        }
    }

    // Render requests table
    function renderRequests() {
        if (!elements.requestsBody) return;

        if (state.requests.length === 0) {
            elements.requestsBody.innerHTML = '<tr><td colspan="7">' + renderEmptyState('No requests yet', { icon: '—' }) + '</td></tr>';
            return;
        }

        const rows = state.requests.map(req => renderRequestRow(req)).join('');
        elements.requestsBody.innerHTML = rows;

        // Attach click handlers to Why cells
        attachWhyCellHandlers();
    }

    // Render single request row
    function renderRequestRow(req) {
        const time = formatTime(req.timestamp);
        const model = escapeHtml(req.model || 'N/A');
        const tier = renderTierBadge(req.tier);
        const strategy = escapeHtml(req.strategy || 'N/A');
        const why = renderWhyCell(req.trace);
        const latency = req.latency ? `${req.latency}ms` : '-';
        const status = renderStatusBadge(req.status);

        const traceData = req.trace ? encodeURIComponent(JSON.stringify(req.trace)) : '';

        return `
            <tr data-request-id="${escapeHtml(req.requestId || '')}">
                <td>${time}</td>
                <td>${model}</td>
                <td>${tier}</td>
                <td>${strategy}</td>
                <td class="why-cell ${req.trace ? 'has-trace' : ''}" data-trace="${traceData}">${why}</td>
                <td>${latency}</td>
                <td>${status}</td>
            </tr>
        `;
    }

    // Render Why cell content
    function renderWhyCell(trace) {
        if (!trace) {
            return '<span class="why-unavailable">N/A</span>';
        }

        const reasons = [];

        // Classification reason (upgrade trigger)
        if (trace.classification && trace.classification.upgradeTrigger) {
            reasons.push(`Upgraded: ${escapeHtml(trace.classification.upgradeTrigger)}`);
        }

        // Model selection rationale
        if (trace.modelSelection && trace.modelSelection.rationale) {
            reasons.push(escapeHtml(trace.modelSelection.rationale));
        }

        // Availability reason (in-flight count)
        if (trace.modelSelection) {
            const selectedId = trace.modelSelection.selected;
            const candidates = trace.modelSelection.candidates || [];
            const selected = candidates.find(c => c.modelId === selectedId);
            if (selected && selected.inFlight > 0) {
                reasons.push(`In-flight: ${selected.inFlight}`);
            }
        }

        if (reasons.length === 0) {
            return '<span class="why-default">Standard routing</span>';
        }

        const tooltip = reasons.join('\n');
        const display = reasons[0] + (reasons.length > 1 ? ' (+more)' : '');

        return `<span class="why-reasons" title="${escapeHtml(tooltip)}">${display}</span>`;
    }

    // Render tier badge
    function renderTierBadge(tier) {
        if (!tier) {
            return '<span class="tier-badge">N/A</span>';
        }
        const tierClass = tier === 'heavy' ? 'tier-heavy' : tier === 'medium' ? 'tier-medium' : 'tier-light';
        return `<span class="tier-badge ${tierClass}">${escapeHtml(tier)}</span>`;
    }

    // Render status badge
    function renderStatusBadge(status) {
        const statusClass = status === 'success' ? 'status-success' :
                            status === 'error' ? 'status-error' : 'status-pending';
        return `<span class="status-badge ${statusClass}">${escapeHtml(status || 'pending')}</span>`;
    }

    // Attach click handlers to Why cells with trace data
    function attachWhyCellHandlers() {
        const whyCells = document.querySelectorAll('.why-cell.has-trace');
        whyCells.forEach(cell => {
            cell.addEventListener('click', () => {
                const traceData = cell.getAttribute('data-trace');
                if (traceData) {
                    try {
                        const trace = JSON.parse(decodeURIComponent(traceData));
                        showTraceModal(trace);
                    } catch (e) {
                        console.error('Error parsing trace data:', e);
                    }
                }
            });
        });
    }

    // Show trace modal
    function showTraceModal(trace) {
        if (!elements.traceModal || !elements.traceContent) return;

        elements.traceContent.textContent = JSON.stringify(trace, null, 2);
        elements.traceModal.classList.add('active');
    }

    // Close trace modal
    function closeTraceModal() {
        if (elements.traceModal) {
            elements.traceModal.classList.remove('active');
        }
    }

    // Toggle pause state
    function togglePause() {
        state.isPaused = !state.isPaused;
        if (elements.pauseBtn) {
            elements.pauseBtn.textContent = state.isPaused ? 'Resume' : 'Pause';
        }
    }

    // Refresh (reload data)
    function refresh() {
        // Reconnect to SSE
        connectSSE();
    }

    // Format timestamp
    function formatTime(timestamp) {
        if (!timestamp) return '-';
        const date = new Date(timestamp);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    // HTML escape function
    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    // State utility functions (from dashboard-utils.js)
    function renderEmptyState(message, options) {
        options = options || {};
        const icon = options.icon || '—';
        return `
            <div class="state-empty">
                <span class="state-icon">${icon}</span>
                <span class="state-message">${escapeHtml(message)}</span>
            </div>
        `;
    }

    function renderLoadingState(message) {
        message = message || 'Loading...';
        return `
            <div class="state-loading">
                <div class="spinner"></div>
                <span class="state-message">${escapeHtml(message)}</span>
            </div>
        `;
    }

    function renderErrorState(error, options) {
        options = options || {};
        const retry = options.retryable
            ? '<button class="btn btn-small" onclick="location.reload()">Retry</button>'
            : '';
        return `
            <div class="state-error">
                <span class="state-icon">⚠</span>
                <span class="state-message">${escapeHtml(error)}</span>
                ${retry}
            </div>
        `;
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
