/**
 * polling.js — Smart Polling Scheduler
 * Extracted from data.js Phase 4 split.
 *
 * Owns: POLL_FAMILIES registry, backoff state, pause/resume lifecycle.
 * Dependencies: store.js (STATE, TIME_RANGES)
 *
 * Call DashboardPolling.init(deps) after data.js loads to inject fetch refs.
 */
(function(window) {
    'use strict';

    var DS = window.DashboardStore;
    var STATE = DS.STATE;
    var TIME_RANGES = DS.TIME_RANGES;

    // ========== POLLING STATE ==========
    var pollIntervalIds = {};
    var POLL_BACKOFF_MAX_MS = 30000;
    var pollBackoffState = {};
    var pollingPaused = false;
    var serverPaused = false;
    var pausedHeartbeatId = null;

    // Injected fetch function references (set via init())
    var fetchRefs = {};

    // ========== BACKOFF HELPERS ==========
    function getHistoryPollIntervalMs() {
        var range = STATE.settings.timeRange;
        return (TIME_RANGES[range] && TIME_RANGES[range].pollInterval) || 2000;
    }

    function getPollBaseIntervalMs(name) {
        switch (name) {
            case 'stats': return 2000;
            case 'history': return getHistoryPollIntervalMs();
            case 'logs': return 2000;
            case 'histogram': return 10000;
            case 'cost': return 10000;
            case 'comparison': return 15000;
            default: return 2000;
        }
    }

    function getPollState(name) {
        if (!pollBackoffState[name]) {
            pollBackoffState[name] = { failures: 0, nextAllowedAt: 0 };
        }
        return pollBackoffState[name];
    }

    function resetPollBackoff(name) {
        var st = getPollState(name);
        st.failures = 0;
        st.nextAllowedAt = 0;
    }

    function resetAllPollBackoff() {
        var keys = Object.keys(pollBackoffState);
        for (var i = 0; i < keys.length; i++) {
            resetPollBackoff(keys[i]);
        }
    }

    function applyPollBackoff(name, succeeded) {
        var st = getPollState(name);
        if (succeeded) {
            st.failures = 0;
            st.nextAllowedAt = 0;
            return;
        }
        st.failures = Math.min(st.failures + 1, 8);
        var base = getPollBaseIntervalMs(name);
        var delay = Math.min(base * Math.pow(2, st.failures), POLL_BACKOFF_MAX_MS);
        st.nextAllowedAt = Date.now() + delay;
    }

    var pollInFlight = {};

    function runPolledFetch(name, fetchFn) {
        if (pollingPaused || document.hidden) return Promise.resolve(false);
        if (pollInFlight[name]) return Promise.resolve(false);
        var st = getPollState(name);
        if (st.nextAllowedAt > Date.now()) return Promise.resolve(false);

        pollInFlight[name] = true;
        return Promise.resolve()
            .then(fetchFn)
            .then(function(ok) {
                pollInFlight[name] = false;
                var succeeded = ok !== false;
                applyPollBackoff(name, succeeded);
                return succeeded;
            })
            .catch(function() {
                pollInFlight[name] = false;
                applyPollBackoff(name, false);
                return false;
            });
    }

    // ========== POLL WRAPPERS ==========
    function pollStats() {
        return runPolledFetch('stats', function() { return fetchRefs.fetchStats({ silent: true }); });
    }

    function pollHistory() {
        return runPolledFetch('history', function() { return fetchRefs.fetchHistory(); });
    }

    function pollLogs() {
        return runPolledFetch('logs', function() { return fetchRefs.fetchLogs(); });
    }

    function pollHistogram() {
        return runPolledFetch('histogram', function() { return fetchRefs.fetchHistogram(); });
    }

    function pollCostStats() {
        return runPolledFetch('cost', function() { return fetchRefs.fetchCostStats(); });
    }

    function pollComparison() {
        return runPolledFetch('comparison', function() { return fetchRefs.fetchComparison(); });
    }

    // ========== POLL FAMILIES REGISTRY ==========
    // Built lazily after init() provides fetch references
    var POLL_FAMILIES = null;

    function ensureRegistry() {
        if (POLL_FAMILIES) return;
        POLL_FAMILIES = [
            { name: 'stats',       ms: 2000,  cb: pollStats },
            { name: 'history',     ms: 0,     cb: pollHistory },
            { name: 'logs',        ms: 2000,  cb: pollLogs, tabOnly: ['live', 'logs'] },
            { name: 'histogram',   ms: 10000, cb: pollHistogram },
            { name: 'cost',        ms: 10000, cb: pollCostStats },
            { name: 'comparison',  ms: 15000, cb: pollComparison },
            { name: 'persistent',  ms: 30000, cb: function() { return runPolledFetch('persistentStats', fetchRefs.fetchPersistentStats); } },
            { name: 'predictions', ms: 30000, cb: function() { return runPolledFetch('predictions', fetchRefs.fetchPredictions); } },
            { name: 'circuit',     ms: 30000, cb: function() { return fetchRefs.fetchCircuitHistory(); } },
            { name: 'process',     ms: 30000, cb: function() { return fetchRefs.fetchProcessHealth(); } },
            { name: 'scheduler',   ms: 30000, cb: function() { return fetchRefs.fetchScheduler(); } },
            { name: 'replay',      ms: 30000, cb: function() { return fetchRefs.fetchReplayQueue(); } }
        ];
    }

    // ========== LIFECYCLE ==========
    function clearAllPollingIntervals() {
        ensureRegistry();
        for (var i = 0; i < POLL_FAMILIES.length; i++) {
            var name = POLL_FAMILIES[i].name;
            if (pollIntervalIds[name]) {
                clearInterval(pollIntervalIds[name]);
                pollIntervalIds[name] = null;
            }
        }
        if (pausedHeartbeatId) {
            clearInterval(pausedHeartbeatId);
            pausedHeartbeatId = null;
        }
    }

    function startAllPolling() {
        ensureRegistry();
        for (var i = 0; i < POLL_FAMILIES.length; i++) {
            var fam = POLL_FAMILIES[i];
            if (pollIntervalIds[fam.name]) continue; // idempotent guard
            if (fam.tabOnly) {
                var tab = STATE.settings.activeTab;
                if (fam.tabOnly.indexOf(tab) === -1) continue;
            }
            var ms = fam.ms || getHistoryPollIntervalMs(); // 0 = dynamic (history)
            pollIntervalIds[fam.name] = setInterval(fam.cb, ms);
        }
    }

    function pausePolling() {
        if (pollingPaused) return;
        pollingPaused = true;
        clearAllPollingIntervals();

        // Keep a slow heartbeat to detect external resume
        if (serverPaused && fetchRefs.fetchStats) {
            pausedHeartbeatId = setInterval(function() {
                if (document.hidden) return;
                if (!serverPaused) {
                    clearInterval(pausedHeartbeatId);
                    pausedHeartbeatId = null;
                    return;
                }
                fetchRefs.fetchStats();
            }, 10000);
        }
    }

    function resumePolling() {
        if (!pollingPaused) return;
        if (document.hidden || serverPaused) return;
        pollingPaused = false;
        clearAllPollingIntervals();
        resetAllPollBackoff();
        if (fetchRefs.fetchStats) fetchRefs.fetchStats();
        if (fetchRefs.fetchHistory) fetchRefs.fetchHistory();
        if ((STATE.settings.activeTab === 'live' || STATE.settings.activeTab === 'logs') && fetchRefs.fetchLogs) {
            fetchRefs.fetchLogs();
        }
        startAllPolling();
    }

    // ========== VISIBILITY CHANGE ==========
    document.addEventListener('visibilitychange', function() {
        if (document.hidden) { pausePolling(); }
        else if (!serverPaused) { resumePolling(); }
    });

    // ========== TAB/TIME RANGE HANDLERS ==========
    function onTabChanged(tabName) {
        if (pollingPaused) return;
        if ((tabName === 'live' || tabName === 'logs') && !pollIntervalIds.logs) {
            if (fetchRefs.fetchLogs) fetchRefs.fetchLogs();
            pollIntervalIds.logs = setInterval(pollLogs, 2000);
        } else if (tabName !== 'live' && tabName !== 'logs' && pollIntervalIds.logs) {
            clearInterval(pollIntervalIds.logs);
            pollIntervalIds.logs = null;
        }
    }

    function onTimeRangeChanged(range) {
        if (pollIntervalIds.history) clearInterval(pollIntervalIds.history);
        resetPollBackoff('history');
        pollIntervalIds.history = setInterval(pollHistory, getHistoryPollIntervalMs());
        if (fetchRefs.fetchHistory) fetchRefs.fetchHistory();
    }

    // ========== INIT ==========
    function init(refs) {
        fetchRefs = refs;
        ensureRegistry();
    }

    // ========== EXPORT ==========
    window.DashboardPolling = {
        init: init,
        clearAllPollingIntervals: clearAllPollingIntervals,
        startAllPolling: startAllPolling,
        pausePolling: pausePolling,
        resumePolling: resumePolling,
        runPolledFetch: runPolledFetch,
        onTabChanged: onTabChanged,
        onTimeRangeChanged: onTimeRangeChanged,
        resetPollBackoff: resetPollBackoff,
        resetAllPollBackoff: resetAllPollBackoff,
        getHistoryPollIntervalMs: getHistoryPollIntervalMs,
        isPollingPaused: function() { return pollingPaused; },
        isServerPaused: function() { return serverPaused; },
        setServerPaused: function(v) { serverPaused = v; },
        getPollingBackoffState: function() {
            return JSON.parse(JSON.stringify(pollBackoffState));
        }
    };

})(window);
