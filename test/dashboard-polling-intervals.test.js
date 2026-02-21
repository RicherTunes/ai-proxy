/**
 * Dashboard Polling Intervals Tests
 *
 * Tests the registry-driven polling scheduler from data.js:
 * - POLL_FAMILIES registry as single source of truth
 * - clearAllPollingIntervals() clears all families + heartbeat
 * - startAllPolling() creates intervals from registry with idempotent guard
 * - pause/resume/visibility cycles don't leak intervals
 *
 * Mirrors the actual data.js architecture using a test replica.
 */

describe('Polling interval management', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    // Replica of the registry-driven polling scheduler from data.js
    function createPollingManager() {
        var pollIntervalIds = {};
        var pausedHeartbeatId = null;

        var pollingPaused = false;
        var serverPaused = false;
        var tabHidden = false;
        var activeTab = 'overview';
        var pollCounts = {};

        function poll(name) { pollCounts[name] = (pollCounts[name] || 0) + 1; }

        // Registry — mirrors POLL_FAMILIES in data.js
        var POLL_FAMILIES = [
            { name: 'stats',       ms: 2000,  cb: function() { poll('stats'); } },
            { name: 'history',     ms: 2000,  cb: function() { poll('history'); } },
            { name: 'logs',        ms: 2000,  cb: function() { poll('logs'); }, tabOnly: ['live', 'logs'] },
            { name: 'histogram',   ms: 10000, cb: function() { poll('histogram'); } },
            { name: 'cost',        ms: 10000, cb: function() { poll('cost'); } },
            { name: 'comparison',  ms: 15000, cb: function() { poll('comparison'); } },
            { name: 'persistent',  ms: 30000, cb: function() { poll('persistent'); } },
            { name: 'predictions', ms: 30000, cb: function() { poll('predictions'); } },
            { name: 'circuit',     ms: 30000, cb: function() { poll('circuit'); } },
            { name: 'process',     ms: 30000, cb: function() { poll('process'); } },
            { name: 'scheduler',   ms: 30000, cb: function() { poll('scheduler'); } },
            { name: 'replay',      ms: 30000, cb: function() { poll('replay'); } }
        ];

        function clearAllPollingIntervals() {
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
            for (var i = 0; i < POLL_FAMILIES.length; i++) {
                var fam = POLL_FAMILIES[i];
                if (pollIntervalIds[fam.name]) continue; // idempotent guard
                if (fam.tabOnly) {
                    if (fam.tabOnly.indexOf(activeTab) === -1) continue;
                }
                pollIntervalIds[fam.name] = setInterval(fam.cb, fam.ms);
            }
        }

        function pausePolling() {
            if (pollingPaused) return;
            pollingPaused = true;
            clearAllPollingIntervals();

            if (serverPaused) {
                pausedHeartbeatId = setInterval(function() {
                    if (tabHidden) return;
                    if (!serverPaused) {
                        clearInterval(pausedHeartbeatId);
                        pausedHeartbeatId = null;
                        return;
                    }
                    poll('heartbeat');
                }, 10000);
            }
        }

        function resumePolling() {
            if (!pollingPaused) return;
            if (tabHidden || serverPaused) return;
            pollingPaused = false;
            clearAllPollingIntervals();
            startAllPolling();
        }

        function onVisibilityChange(hidden) {
            tabHidden = hidden;
            if (hidden) { pausePolling(); }
            else if (!serverPaused) { resumePolling(); }
        }

        function getActiveIntervalCount() {
            var count = 0;
            for (var i = 0; i < POLL_FAMILIES.length; i++) {
                if (pollIntervalIds[POLL_FAMILIES[i].name]) count++;
            }
            return count;
        }

        return {
            clearAllPollingIntervals: clearAllPollingIntervals,
            startAllPolling: startAllPolling,
            pausePolling: pausePolling,
            resumePolling: resumePolling,
            onVisibilityChange: onVisibilityChange,
            setServerPaused: function(v) { serverPaused = v; },
            setActiveTab: function(v) { activeTab = v; },
            getActiveIntervalCount: getActiveIntervalCount,
            getFamilyCount: function() { return POLL_FAMILIES.length; },
            get pollingPaused() { return pollingPaused; },
            get hasHeartbeat() { return pausedHeartbeatId !== null; },
            hasInterval: function(name) { return !!pollIntervalIds[name]; },
            getPollCount: function(name) { return pollCounts[name] || 0; },
            resetCounts: function() { pollCounts = {}; }
        };
    }

    describe('POLL_FAMILIES registry', () => {
        test('contains exactly 12 families', () => {
            const pm = createPollingManager();
            expect(pm.getFamilyCount()).toBe(12);
        });
    });

    describe('clearAllPollingIntervals', () => {
        test('clears all 12 interval families', () => {
            const pm = createPollingManager();
            pm.startAllPolling();
            expect(pm.getActiveIntervalCount()).toBeGreaterThanOrEqual(11); // logs may be conditional

            pm.clearAllPollingIntervals();
            expect(pm.getActiveIntervalCount()).toBe(0);
        });

        test('clears heartbeat interval', () => {
            const pm = createPollingManager();
            pm.setServerPaused(true);
            pm.pausePolling();
            expect(pm.hasHeartbeat).toBe(true);

            pm.clearAllPollingIntervals();
            expect(pm.hasHeartbeat).toBe(false);
        });

        test('is idempotent — calling twice does not throw', () => {
            const pm = createPollingManager();
            pm.startAllPolling();
            pm.clearAllPollingIntervals();
            pm.clearAllPollingIntervals();
            expect(pm.getActiveIntervalCount()).toBe(0);
        });

        test('no callbacks fire after clearing', () => {
            const pm = createPollingManager();
            pm.startAllPolling();
            pm.resetCounts();
            pm.clearAllPollingIntervals();

            jest.advanceTimersByTime(60000);

            expect(pm.getPollCount('stats')).toBe(0);
            expect(pm.getPollCount('histogram')).toBe(0);
            expect(pm.getPollCount('persistent')).toBe(0);
            expect(pm.getPollCount('replay')).toBe(0);
        });
    });

    describe('startAllPolling', () => {
        test('creates intervals for all non-conditional families', () => {
            const pm = createPollingManager();
            pm.startAllPolling();

            expect(pm.hasInterval('stats')).toBe(true);
            expect(pm.hasInterval('history')).toBe(true);
            expect(pm.hasInterval('histogram')).toBe(true);
            expect(pm.hasInterval('cost')).toBe(true);
            expect(pm.hasInterval('comparison')).toBe(true);
            expect(pm.hasInterval('persistent')).toBe(true);
            expect(pm.hasInterval('predictions')).toBe(true);
            expect(pm.hasInterval('circuit')).toBe(true);
            expect(pm.hasInterval('process')).toBe(true);
            expect(pm.hasInterval('scheduler')).toBe(true);
            expect(pm.hasInterval('replay')).toBe(true);
        });

        test('skips logs when tab is not live/logs', () => {
            const pm = createPollingManager();
            pm.setActiveTab('overview');
            pm.startAllPolling();
            expect(pm.hasInterval('logs')).toBe(false);
        });

        test('includes logs when tab is live', () => {
            const pm = createPollingManager();
            pm.setActiveTab('live');
            pm.startAllPolling();
            expect(pm.hasInterval('logs')).toBe(true);
        });

        test('is idempotent — double call does not create duplicates', () => {
            const pm = createPollingManager();
            pm.startAllPolling();
            const count = pm.getActiveIntervalCount();
            pm.startAllPolling(); // should be no-op
            expect(pm.getActiveIntervalCount()).toBe(count);
        });
    });

    describe('pausePolling', () => {
        test('clears all intervals', () => {
            const pm = createPollingManager();
            pm.startAllPolling();
            pm.pausePolling();
            expect(pm.getActiveIntervalCount()).toBe(0);
            expect(pm.pollingPaused).toBe(true);
        });

        test('starts heartbeat when server is paused', () => {
            const pm = createPollingManager();
            pm.startAllPolling();
            pm.setServerPaused(true);
            pm.pausePolling();
            expect(pm.hasHeartbeat).toBe(true);
        });

        test('no heartbeat when server is not paused', () => {
            const pm = createPollingManager();
            pm.startAllPolling();
            pm.pausePolling();
            expect(pm.hasHeartbeat).toBe(false);
        });

        test('is idempotent', () => {
            const pm = createPollingManager();
            pm.startAllPolling();
            pm.pausePolling();
            pm.pausePolling();
            expect(pm.getActiveIntervalCount()).toBe(0);
        });
    });

    describe('resumePolling', () => {
        test('recreates intervals via registry', () => {
            const pm = createPollingManager();
            pm.startAllPolling();
            pm.pausePolling();
            expect(pm.getActiveIntervalCount()).toBe(0);

            pm.resumePolling();
            expect(pm.getActiveIntervalCount()).toBeGreaterThanOrEqual(11);
            expect(pm.pollingPaused).toBe(false);
        });

        test('does not resume when server is paused', () => {
            const pm = createPollingManager();
            pm.startAllPolling();
            pm.setServerPaused(true);
            pm.pausePolling();

            pm.resumePolling();
            expect(pm.pollingPaused).toBe(true);
        });

        test('does not resume when tab is hidden', () => {
            const pm = createPollingManager();
            pm.startAllPolling();
            pm.onVisibilityChange(true);

            pm.resumePolling();
            expect(pm.pollingPaused).toBe(true);
        });
    });

    describe('visibility change cycles', () => {
        test('hide/show cycle restores intervals', () => {
            const pm = createPollingManager();
            pm.startAllPolling();

            pm.onVisibilityChange(true);
            expect(pm.getActiveIntervalCount()).toBe(0);

            pm.onVisibilityChange(false);
            expect(pm.getActiveIntervalCount()).toBeGreaterThanOrEqual(11);
        });

        test('10 hide/show cycles do not leak intervals', () => {
            const pm = createPollingManager();
            pm.startAllPolling();
            const expected = pm.getActiveIntervalCount();

            for (let i = 0; i < 10; i++) {
                pm.onVisibilityChange(true);
                expect(pm.getActiveIntervalCount()).toBe(0);

                pm.onVisibilityChange(false);
                expect(pm.getActiveIntervalCount()).toBe(expected);
            }
        });

        test('no phantom callbacks fire during paused period', () => {
            const pm = createPollingManager();
            pm.startAllPolling();
            pm.resetCounts();

            pm.onVisibilityChange(true);
            jest.advanceTimersByTime(60000);

            expect(pm.getPollCount('stats')).toBe(0);
            expect(pm.getPollCount('histogram')).toBe(0);
            expect(pm.getPollCount('persistent')).toBe(0);
        });

        test('callbacks resume correctly after show', () => {
            const pm = createPollingManager();
            pm.startAllPolling();
            pm.onVisibilityChange(true);
            pm.onVisibilityChange(false);
            pm.resetCounts();

            jest.advanceTimersByTime(2000);
            expect(pm.getPollCount('stats')).toBe(1);
            expect(pm.getPollCount('history')).toBe(1);
            expect(pm.getPollCount('histogram')).toBe(0); // 10s interval
        });
    });

    describe('interval timing contracts', () => {
        test('fast intervals (2s): stats, history', () => {
            const pm = createPollingManager();
            pm.startAllPolling();
            pm.resetCounts();

            jest.advanceTimersByTime(10000);
            expect(pm.getPollCount('stats')).toBe(5);
            expect(pm.getPollCount('history')).toBe(5);
        });

        test('medium intervals (10s): histogram, cost', () => {
            const pm = createPollingManager();
            pm.startAllPolling();
            pm.resetCounts();

            jest.advanceTimersByTime(30000);
            expect(pm.getPollCount('histogram')).toBe(3);
            expect(pm.getPollCount('cost')).toBe(3);
        });

        test('slow intervals (30s): persistent through replay', () => {
            const pm = createPollingManager();
            pm.startAllPolling();
            pm.resetCounts();

            jest.advanceTimersByTime(90000);
            expect(pm.getPollCount('persistent')).toBe(3);
            expect(pm.getPollCount('predictions')).toBe(3);
            expect(pm.getPollCount('circuit')).toBe(3);
            expect(pm.getPollCount('process')).toBe(3);
            expect(pm.getPollCount('scheduler')).toBe(3);
            expect(pm.getPollCount('replay')).toBe(3);
        });
    });
});
