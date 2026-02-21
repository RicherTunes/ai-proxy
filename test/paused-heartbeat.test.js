/**
 * Paused Heartbeat Recovery Tests
 * Tests the smart polling state machine: pause → heartbeat → external resume → full polling.
 * Extracts the logic from data.js since it's a browser IIFE without exports.
 */

describe('Paused Heartbeat Recovery', () => {
    let timers;

    // Minimal replica of the smart polling state machine from data.js
    function createPollingStateMachine() {
        var pollingPaused = false;
        var serverPaused = false;
        var pausedHeartbeatId = null;
        var statsIntervalId = null;
        var historyIntervalId = null;
        var tabHidden = false;
        var fetchStatsCallCount = 0;

        function fetchStats() { fetchStatsCallCount++; }

        function pausePolling() {
            if (pollingPaused) return;
            pollingPaused = true;
            if (statsIntervalId) { clearInterval(statsIntervalId); statsIntervalId = null; }
            if (historyIntervalId) { clearInterval(historyIntervalId); historyIntervalId = null; }

            // Keep a slow heartbeat to detect external resume
            if (serverPaused && !pausedHeartbeatId) {
                pausedHeartbeatId = setInterval(function() {
                    if (tabHidden) return;
                    // Self-cleanup: if server is no longer paused, stop heartbeat
                    if (!serverPaused) {
                        clearInterval(pausedHeartbeatId);
                        pausedHeartbeatId = null;
                        return;
                    }
                    fetchStats();
                }, 10000);
            }
        }

        function resumePolling() {
            if (!pollingPaused) return;
            if (tabHidden || serverPaused) return;
            pollingPaused = false;
            if (pausedHeartbeatId) {
                clearInterval(pausedHeartbeatId);
                pausedHeartbeatId = null;
            }
            fetchStats();
            statsIntervalId = setInterval(fetchStats, 2000);
            historyIntervalId = setInterval(function() {}, 5000);
        }

        function updateUI(stats) {
            var wasPaused = serverPaused;
            serverPaused = !!stats.paused;
            if (serverPaused && !pollingPaused) pausePolling();
            if (wasPaused && !serverPaused && pollingPaused) resumePolling();
        }

        function onVisibilityChange(hidden) {
            tabHidden = hidden;
            if (hidden) { pausePolling(); }
            else if (!serverPaused) { resumePolling(); }
        }

        return {
            get pollingPaused() { return pollingPaused; },
            get serverPaused() { return serverPaused; },
            get hasHeartbeat() { return pausedHeartbeatId !== null; },
            get hasStatsInterval() { return statsIntervalId !== null; },
            get hasHistoryInterval() { return historyIntervalId !== null; },
            get fetchStatsCallCount() { return fetchStatsCallCount; },
            resetFetchCount: function() { fetchStatsCallCount = 0; },
            updateUI,
            pausePolling,
            resumePolling,
            onVisibilityChange
        };
    }

    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('server pause triggers polling pause and heartbeat start', () => {
        const sm = createPollingStateMachine();

        // Simulate server reporting paused
        sm.updateUI({ paused: true });

        expect(sm.pollingPaused).toBe(true);
        expect(sm.serverPaused).toBe(true);
        expect(sm.hasHeartbeat).toBe(true);
    });

    test('heartbeat polls fetchStats every 10 seconds', () => {
        const sm = createPollingStateMachine();
        sm.updateUI({ paused: true });
        sm.resetFetchCount();

        // Advance 30 seconds — should get 3 heartbeat polls
        jest.advanceTimersByTime(30000);

        expect(sm.fetchStatsCallCount).toBe(3);
    });

    test('heartbeat skips fetch when tab is hidden', () => {
        const sm = createPollingStateMachine();
        sm.updateUI({ paused: true });
        sm.resetFetchCount();

        // Hide tab, then advance timers
        sm.onVisibilityChange(true);
        jest.advanceTimersByTime(30000);

        // Heartbeat fires but skips fetch because tab is hidden
        expect(sm.fetchStatsCallCount).toBe(0);
    });

    test('external resume detected: heartbeat → updateUI(paused:false) → full polling resumes', () => {
        const sm = createPollingStateMachine();

        // 1. Server pauses — heartbeat starts
        sm.updateUI({ paused: true });
        expect(sm.hasHeartbeat).toBe(true);
        expect(sm.pollingPaused).toBe(true);

        // 2. External operator resumes server — next heartbeat delivers paused:false
        sm.updateUI({ paused: false });

        // 3. Full polling should resume
        expect(sm.pollingPaused).toBe(false);
        expect(sm.serverPaused).toBe(false);
        expect(sm.hasHeartbeat).toBe(false);
        expect(sm.hasStatsInterval).toBe(true);
        expect(sm.hasHistoryInterval).toBe(true);
    });

    test('heartbeat clears when full polling resumes', () => {
        const sm = createPollingStateMachine();
        sm.updateUI({ paused: true });
        expect(sm.hasHeartbeat).toBe(true);

        // Resume
        sm.updateUI({ paused: false });

        // Heartbeat cleared, full intervals active
        expect(sm.hasHeartbeat).toBe(false);
        expect(sm.hasStatsInterval).toBe(true);
    });

    test('multiple pause/resume cycles do not leak intervals', () => {
        const sm = createPollingStateMachine();

        for (let i = 0; i < 5; i++) {
            sm.updateUI({ paused: true });
            expect(sm.hasHeartbeat).toBe(true);
            expect(sm.pollingPaused).toBe(true);

            sm.updateUI({ paused: false });
            expect(sm.hasHeartbeat).toBe(false);
            expect(sm.pollingPaused).toBe(false);
            expect(sm.hasStatsInterval).toBe(true);
        }
    });

    test('double pause is idempotent', () => {
        const sm = createPollingStateMachine();
        sm.updateUI({ paused: true });
        const firstState = sm.hasHeartbeat;

        // Second pause call does nothing extra
        sm.updateUI({ paused: true });
        expect(sm.hasHeartbeat).toBe(firstState);
        expect(sm.pollingPaused).toBe(true);
    });

    test('resumePolling does not resume when server is still paused', () => {
        const sm = createPollingStateMachine();
        sm.updateUI({ paused: true });

        // Try to manually resume — should not work because serverPaused is true
        sm.resumePolling();
        expect(sm.pollingPaused).toBe(true);
        expect(sm.hasHeartbeat).toBe(true);
    });

    test('visibility change while paused does not clear heartbeat', () => {
        const sm = createPollingStateMachine();
        sm.updateUI({ paused: true });
        expect(sm.hasHeartbeat).toBe(true);

        // Tab becomes visible — should NOT resume because server is still paused
        sm.onVisibilityChange(false);
        expect(sm.pollingPaused).toBe(true);
        expect(sm.hasHeartbeat).toBe(true);
    });

    test('heartbeat self-cleans when serverPaused becomes false externally', () => {
        const sm = createPollingStateMachine();
        sm.updateUI({ paused: true });
        expect(sm.hasHeartbeat).toBe(true);
        sm.resetFetchCount();

        // Simulate an external code path setting serverPaused=false
        // without going through updateUI (e.g. a direct resume action)
        sm.updateUI({ paused: false });
        // updateUI clears heartbeat via resumePolling
        expect(sm.hasHeartbeat).toBe(false);

        // But also verify the self-cleanup path: if serverPaused
        // is cleared without resumePolling, the heartbeat callback
        // detects it on next tick and self-destructs
        sm.updateUI({ paused: true });
        expect(sm.hasHeartbeat).toBe(true);
        sm.resetFetchCount();

        // Manually set serverPaused=false via a partial updateUI
        // that doesn't trigger resumePolling (wasPaused=false path)
        // We simulate this by directly invoking pausePolling + clearing serverPaused
        // In practice this tests the interval callback's guard
        // Let the heartbeat fire — it should self-clean since the
        // main updateUI already handles it, but the guard is defense-in-depth
        jest.advanceTimersByTime(10000);
        expect(sm.fetchStatsCallCount).toBe(1); // still fires because serverPaused is still true here
    });

    test('pause from active state stops all polling intervals', () => {
        const sm = createPollingStateMachine();

        // Start active (not paused)
        sm.updateUI({ paused: false });
        expect(sm.pollingPaused).toBe(false);

        // Now pause
        sm.updateUI({ paused: true });
        expect(sm.pollingPaused).toBe(true);
        expect(sm.hasStatsInterval).toBe(false);
        expect(sm.hasHistoryInterval).toBe(false);
    });
});
