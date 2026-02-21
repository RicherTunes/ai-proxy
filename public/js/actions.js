/**
 * actions.js — Control Actions, Data Export & Key Override Modal
 * Extracted from data.js Phase 4 split.
 *
 * Dependencies: store.js (STATE, escapeHtml, renderEmptyState),
 *               dom-cache.js (formatNumber),
 *               error-boundary.js (showToast)
 *
 * Call DashboardActions.init(deps) after data.js loads to inject fetch/polling refs.
 */
(function(window) {
    'use strict';

    var DS = window.DashboardStore;
    var STATE = DS.STATE;
    var escapeHtml = DS.escapeHtml;
    var renderEmptyState = DS.renderEmptyState;
    var TIME_RANGES = DS.TIME_RANGES;
    var showToast = window.showToast || function() {};

    // Injected dependencies (set via init())
    var deps = {
        fetchStats: null,
        fetchLogs: null,
        pausePolling: null,
        resumePolling: null,
        setServerPaused: null
    };

    var currentKeyOverrides = null;
    var currentEditingKeyIndex = null;
    var previousIssuesHash = null;

    function init(injected) {
        if (injected.fetchStats) deps.fetchStats = injected.fetchStats;
        if (injected.fetchLogs) deps.fetchLogs = injected.fetchLogs;
        if (injected.pausePolling) deps.pausePolling = injected.pausePolling;
        if (injected.resumePolling) deps.resumePolling = injected.resumePolling;
        if (injected.setServerPaused) deps.setServerPaused = injected.setServerPaused;
        if (injected.previousIssuesHashRef) previousIssuesHash = injected.previousIssuesHashRef;
    }

    // ========== CONTROL ACTIONS ==========
    function controlAction(action) {
        return fetch('/control/' + action, { method: 'POST' }).then(function(res) {
            if (!res.ok) console.error('Control action ' + action + ' failed:', res.status);
            if (action === 'pause' && deps.pausePolling) { deps.pausePolling(); }
            if (action === 'resume') {
                if (deps.setServerPaused) deps.setServerPaused(false);
                if (deps.resumePolling) deps.resumePolling();
            }
            return deps.fetchStats ? deps.fetchStats() : null;
        }).catch(function(err) { console.error('Control action failed:', err); });
    }

    function forceCircuitStateOnKey(keyIndex, state) {
        return fetch('/api/circuit/' + keyIndex, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: state }) })
            .then(function(res) {
                if (res.ok) { showToast('Key ' + (keyIndex + 1) + ' circuit set to ' + state, 'success'); if (deps.fetchStats) deps.fetchStats(); }
                else { showToast('Failed to update circuit state', 'error'); }
            }).catch(function(err) { showToast('Error: ' + err.message, 'error'); });
    }

    // ========== DATA EXPORT ==========
    function exportData() {
        Promise.all([fetch('/stats').then(function(r) { return r.json(); }), fetch('/history?minutes=' + TIME_RANGES[STATE.settings.timeRange].minutes, { cache: 'no-store' }).then(function(r) { return r.json(); })])
            .then(function(results) {
                var stats = results[0];
                var history = results[1];
                var csvContent = generateCSV(stats, history);
                var jsonContent = JSON.stringify({ stats: stats, history: history }, null, 2);
                downloadFile(csvContent, 'glm-proxy-stats.csv', 'text/csv');
                setTimeout(function() { downloadFile(jsonContent, 'glm-proxy-stats.json', 'application/json'); }, 100);
                showToast('Data exported successfully', 'success');
            }).catch(function(err) { console.error('Export failed:', err); showToast('Export failed: ' + err.message, 'error'); });
    }

    function generateCSV(stats, history) {
        var lines = ['Metric,Value'];
        lines.push('Uptime,' + (stats.uptimeFormatted || ''));
        lines.push('Total Requests,' + ((stats.clientRequests && stats.clientRequests.total) || 0));
        lines.push('Success Rate,' + (stats.successRate || 0) + '%');
        lines.push('Avg Latency,' + ((stats.latency && stats.latency.avg) || 0) + 'ms');
        lines.push('');
        lines.push('Key,State,Total Requests,Success Rate,Avg Latency');
        if (stats.keys) {
            for (var i = 0; i < stats.keys.length; i++) {
                var k = stats.keys[i];
                lines.push('K' + k.index + ',' + k.state + ',' + (k.total || 0) + ',' + (k.successRate || 0) + '%,' + ((k.latency && k.latency.avg) || 0) + 'ms');
            }
        }
        lines.push('');
        lines.push('Error Type,Count');
        if (stats.errors) {
            var errKeys = Object.keys(stats.errors);
            for (var j = 0; j < errKeys.length; j++) {
                var type = errKeys[j];
                var count = stats.errors[type];
                if (typeof count === 'number' && count > 0 && type !== 'totalRetries' && type !== 'retriesSucceeded') {
                    lines.push(type + ',' + count);
                }
            }
        }
        return lines.join('\n');
    }

    function downloadFile(content, filename, mimeType) {
        var blob = new Blob([content], { type: mimeType });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // ========== SHARE / DISMISS / CIRCUIT ==========
    function shareURL() {
        navigator.clipboard.writeText(window.location.href).then(function() {
            var btn = document.getElementById('shareUrlBtn');
            var text = document.getElementById('shareUrlText');
            if (btn && text) {
                btn.classList.add('copied');
                text.textContent = 'Copied!';
                setTimeout(function() { btn.classList.remove('copied'); text.textContent = 'Share'; }, 2000);
            }
            showToast('URL copied to clipboard', 'success');
        }).catch(function(err) {
            console.error('Copy failed:', err);
            showToast('Failed to copy URL', 'error');
        });
    }

    function dismissIssues() {
        var panel = document.getElementById('issuesPanel');
        if (panel) panel.classList.remove('has-issues');
        localStorage.setItem('issues-dismissed', JSON.stringify({ hash: previousIssuesHash, dismissedAt: Date.now() }));
        var reopenBadge = document.getElementById('issuesReopenBadge');
        if (reopenBadge) reopenBadge.style.display = 'inline-flex';
        showToast('Issues dismissed', 'info');
    }

    function setPreviousIssuesHash(hash) {
        previousIssuesHash = hash;
    }

    function resetAllCircuits() {
        fetch('/stats').then(function(res) { return res.json(); }).then(function(stats) {
            if (!stats.keys) return;
            var promises = [];
            for (var i = 0; i < stats.keys.length; i++) {
                promises.push(fetch('/api/circuit/' + i, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ state: 'CLOSED' })
                }));
            }
            return Promise.all(promises);
        }).then(function() {
            showToast('All circuits reset to CLOSED', 'success');
            if (deps.fetchStats) deps.fetchStats();
        }).catch(function(err) {
            showToast('Failed to reset circuits: ' + err.message, 'error');
        });
    }

    function clearQueue() {
        showToast('Queue clear requested', 'info');
        if (deps.fetchStats) deps.fetchStats();
    }

    function exportDiagnostics() {
        fetch('/stats').then(function(res) { return res.json(); }).then(function(stats) {
            var diagnostics = {
                timestamp: new Date().toISOString(),
                uptime: stats.uptime,
                uptimeFormatted: stats.uptimeFormatted,
                successRate: stats.successRate,
                latency: stats.latency,
                errors: stats.errors,
                keys: stats.keys ? stats.keys.map(function(k) {
                    return {
                        index: k.index,
                        state: k.circuitState,
                        healthScore: k.healthScore ? k.healthScore.total : null,
                        totalRequests: k.total,
                        successRate: k.successRate
                    };
                }) : [],
                backpressure: stats.backpressure,
                connectionHealth: stats.connectionHealth
            };
            downloadFile(JSON.stringify(diagnostics, null, 2), 'glm-proxy-diagnostics.json', 'application/json');
            showToast('Diagnostics exported', 'success');
        }).catch(function(err) {
            showToast('Failed to export diagnostics: ' + err.message, 'error');
        });
    }

    function forceCircuitState(state) {
        if (STATE.selectedKeyIndex === null) return;
        fetch('/control/circuit/' + STATE.selectedKeyIndex + '/' + state, { method: 'POST' })
            .then(function() { if (deps.fetchStats) deps.fetchStats(); })
            .catch(function(err) { console.error('Force circuit state failed:', err); });
    }

    function forceCircuit(state) {
        if (STATE.selectedKeyIndex !== null && state) {
            fetch('/control/circuit/' + STATE.selectedKeyIndex + '/' + state, { method: 'POST' })
                .then(function() { if (deps.fetchStats) deps.fetchStats(); })
                .catch(function(err) { console.error('Force circuit state failed:', err); });
        }
    }

    function reloadKeys() {
        fetch('/reload', { method: 'POST' }).then(function(res) {
            if (!res.ok) console.error('Reload failed:', res.status);
            return deps.fetchStats ? deps.fetchStats() : null;
        }).catch(function(err) { console.error('Reload failed:', err); });
    }

    function resetStats() {
        fetch('/control/reset-stats', { method: 'POST' }).then(function(res) {
            if (!res.ok) console.error('Reset stats failed:', res.status);
            return deps.fetchStats ? deps.fetchStats() : null;
        }).catch(function(err) { console.error('Reset stats failed:', err); });
    }

    function clearLogs() {
        fetch('/control/clear-logs', { method: 'POST' }).then(function(res) {
            if (!res.ok) console.error('Clear logs failed:', res.status);
            return deps.fetchLogs ? deps.fetchLogs() : null;
        }).catch(function(err) { console.error('Clear logs failed:', err); });
    }

    // ========== KEY OVERRIDE MODAL ==========
    function openKeyOverrideModal(keyIndex) {
        currentEditingKeyIndex = keyIndex;
        if (!STATE.routingData || !STATE.routingData.overrides) {
            showToast('Routing data not available. Please refresh the page.', 'error');
            return;
        }
        var overrides = STATE.routingData.overrides;
        var keyOverrides = overrides[keyIndex] || {};
        var data = { useGlobal: Object.keys(keyOverrides).length === 0, overrides: keyOverrides };
        currentKeyOverrides = data;
        var keyNameEl = document.getElementById('keyOverrideKeyName');
        if (keyNameEl) keyNameEl.textContent = 'Key ' + (keyIndex + 1);
        var useGlobalEl = document.getElementById('useGlobalMapping');
        if (useGlobalEl) useGlobalEl.checked = data.useGlobal;
        var addForm = document.getElementById('addOverrideForm');
        if (addForm) addForm.style.display = data.useGlobal ? 'none' : 'flex';
        renderOverrideList();
        var modal = document.getElementById('keyOverrideModal');
        if (modal) modal.classList.add('visible');
    }

    function closeKeyOverrideModal(event) {
        if (event && event.target && event.target.id !== 'keyOverrideModal' && event.key !== 'Escape') return;
        var modal = document.getElementById('keyOverrideModal');
        if (modal) modal.classList.remove('visible');
        currentEditingKeyIndex = null;
    }

    function renderOverrideList() {
        var listEl = document.getElementById('overrideList');
        if (!listEl) return;
        var overrides = currentKeyOverrides.overrides || {};
        var overrideKeys = Object.keys(overrides);
        if (overrideKeys.length === 0) {
            listEl.innerHTML = renderEmptyState('No overrides configured', { icon: '\u2014' });
            return;
        }
        listEl.innerHTML = overrideKeys.map(function(claude) {
            var glm = overrides[claude];
            return '<div class="override-item">' +
                '<div class="override-models">' +
                    '<span class="mapping-model claude">' + escapeHtml(claude) + '</span>' +
                    '<span class="mapping-arrow">\u2192</span>' +
                    '<span class="mapping-model glm">' + escapeHtml(glm) + '</span>' +
                '</div>' +
                '<button class="override-remove" data-action="remove-override" data-claude="' + escapeHtml(claude) + '" title="Remove override">&times;</button>' +
            '</div>';
        }).join('');
    }

    function addOverride() {
        var claudeInput = document.getElementById('newClaudeModel');
        var glmInput = document.getElementById('newGlmModel');
        var claude = claudeInput ? claudeInput.value.trim() : '';
        var glm = glmInput ? glmInput.value.trim() : '';
        if (!claude || !glm) { showToast('Please enter both model names', 'warning'); return; }
        if (!currentKeyOverrides.overrides) currentKeyOverrides.overrides = {};
        currentKeyOverrides.overrides[claude] = glm;
        renderOverrideList();
        if (claudeInput) claudeInput.value = '';
        if (glmInput) glmInput.value = '';
    }

    function removeOverride(claude) {
        if (currentKeyOverrides.overrides) {
            delete currentKeyOverrides.overrides[claude];
            renderOverrideList();
        }
    }

    function saveKeyOverrides() {
        if (currentEditingKeyIndex === null) return;
        if (!STATE.routingData) { showToast('Routing data not available', 'error'); return; }
        var currentOverrides = STATE.routingData.overrides || {};
        var updatedOverrides = {};
        var keys = Object.keys(currentOverrides);
        for (var i = 0; i < keys.length; i++) updatedOverrides[keys[i]] = currentOverrides[keys[i]];
        if (currentKeyOverrides.useGlobal || Object.keys(currentKeyOverrides.overrides || {}).length === 0) {
            delete updatedOverrides[currentEditingKeyIndex];
        } else {
            updatedOverrides[currentEditingKeyIndex] = currentKeyOverrides.overrides;
        }
        var config = STATE.routingData.config || {};
        var payload = {};
        var configKeys = Object.keys(config);
        for (var j = 0; j < configKeys.length; j++) payload[configKeys[j]] = config[configKeys[j]];
        payload.overrides = updatedOverrides;
        fetch('/model-routing', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(function(res) {
            if (!res.ok) return res.json().then(function(errData) { showToast('Failed to save: ' + (errData.error || res.statusText), 'error'); });
            return res.json().then(function(result) {
                showToast('Overrides saved', 'success');
                var modal = document.getElementById('keyOverrideModal');
                if (modal) modal.classList.remove('visible');
                if (window.DashboardTierBuilder && window.DashboardTierBuilder.fetchModelRouting) {
                    window.DashboardTierBuilder.fetchModelRouting();
                }
                if (deps.fetchStats) deps.fetchStats();
            });
        }).catch(function(err) { showToast('Failed to save overrides: ' + err.message, 'error'); });
    }

    // ========== EXPORT ==========
    window.DashboardActions = {
        init: init,
        controlAction: controlAction,
        forceCircuitStateOnKey: forceCircuitStateOnKey,
        exportData: exportData,
        downloadFile: downloadFile,
        shareURL: shareURL,
        dismissIssues: dismissIssues,
        setPreviousIssuesHash: setPreviousIssuesHash,
        resetAllCircuits: resetAllCircuits,
        clearQueue: clearQueue,
        exportDiagnostics: exportDiagnostics,
        forceCircuitState: forceCircuitState,
        forceCircuit: forceCircuit,
        reloadKeys: reloadKeys,
        resetStats: resetStats,
        clearLogs: clearLogs,
        openKeyOverrideModal: openKeyOverrideModal,
        closeKeyOverrideModal: closeKeyOverrideModal,
        addOverride: addOverride,
        removeOverride: removeOverride,
        saveKeyOverrides: saveKeyOverrides,
        renderOverrideList: renderOverrideList
    };

})(window);
