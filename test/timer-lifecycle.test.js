/**
 * Timer Lifecycle Cleanup Tests (TDD)
 *
 * Verifies that all classes using setInterval properly store interval handles
 * and clear them in stop()/destroy() methods. Also verifies that
 * ProxyServer.shutdown() calls stop/destroy on all sub-components.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================================
// Test 1: PredictiveScaler has a stop/destroy method
// ============================================================================
describe('PredictiveScaler timer lifecycle', () => {
    const { PredictiveScaler } = require('../lib/predictive-scaler');

    test('has a stop() or destroy() method', () => {
        const scaler = new PredictiveScaler();
        const hasStop = typeof scaler.stop === 'function';
        const hasDestroy = typeof scaler.destroy === 'function';
        expect(hasStop || hasDestroy).toBe(true);
    });

    test('stop/destroy clears any running timers', () => {
        // PredictiveScaler itself does not start timers internally;
        // the proxy-server creates a _scalerInterval externally.
        // But PredictiveScaler should still have a stop/destroy for
        // clean resource release if it ever gains internal timers.
        const scaler = new PredictiveScaler();
        // Should not throw when called
        if (typeof scaler.stop === 'function') {
            expect(() => scaler.stop()).not.toThrow();
        }
        if (typeof scaler.destroy === 'function') {
            expect(() => scaler.destroy()).not.toThrow();
        }
    });

    test('calling stop/destroy twice is safe (idempotent)', () => {
        const scaler = new PredictiveScaler();
        const method = scaler.stop || scaler.destroy;
        expect(() => {
            method.call(scaler);
            method.call(scaler);
        }).not.toThrow();
    });
});

// ============================================================================
// Test 2: HistoryTracker has a proper stop method
// ============================================================================
describe('HistoryTracker timer lifecycle', () => {
    const { HistoryTracker } = require('../lib/history-tracker');

    test('has a stop() method', () => {
        const tracker = new HistoryTracker({
            historyFile: path.join(__dirname, '__temp_history_lifecycle.json')
        });
        expect(typeof tracker.stop).toBe('function');
    });

    test('stop() clears collectTimer and saveTimer', () => {
        const tracker = new HistoryTracker({
            historyFile: path.join(__dirname, '__temp_history_lifecycle.json'),
            interval: 100000,
            saveInterval: 100000
        });

        // Start with a dummy source
        tracker.start(() => ({
            totalRequests: 0,
            successRate: 100,
            latency: { avg: 0, p95: 0, p99: 0 },
            activeConnections: 0,
            queue: { current: 0 },
            errors: {},
            keys: []
        }));

        // Verify timers were created
        expect(tracker.collectTimer).not.toBeNull();
        expect(tracker.saveTimer).not.toBeNull();

        // Stop
        tracker.stop();

        // Verify timers were cleared
        expect(tracker.collectTimer).toBeNull();
        expect(tracker.saveTimer).toBeNull();

        // Cleanup
        try { fs.unlinkSync(path.join(__dirname, '__temp_history_lifecycle.json')); } catch (_) {}
    });

    test('has a destroy() method that calls stop()', () => {
        const tracker = new HistoryTracker({
            historyFile: path.join(__dirname, '__temp_history_lifecycle2.json'),
            interval: 100000,
            saveInterval: 100000
        });

        expect(typeof tracker.destroy).toBe('function');

        tracker.start(() => ({
            totalRequests: 0,
            successRate: 100,
            latency: { avg: 0, p95: 0, p99: 0 },
            activeConnections: 0,
            queue: { current: 0 },
            errors: {},
            keys: []
        }));

        tracker.destroy();

        expect(tracker.collectTimer).toBeNull();
        expect(tracker.saveTimer).toBeNull();

        // Cleanup
        try { fs.unlinkSync(path.join(__dirname, '__temp_history_lifecycle2.json')); } catch (_) {}
    });
});

// ============================================================================
// Test 3: CostTracker has a stop/destroy method
// ============================================================================
describe('CostTracker timer lifecycle', () => {
    const { CostTracker } = require('../lib/cost-tracker');

    test('has a destroy() method', () => {
        const tracker = new CostTracker();
        expect(typeof tracker.destroy).toBe('function');
    });

    test('destroy() clears the debounced _saveTimeout', async () => {
        const tracker = new CostTracker({ saveDebounceMs: 100000 });

        // Trigger a debounced save by calling _save()
        tracker.persistPath = 'dummy.json';
        tracker._save();

        // The debounce timer should be set
        expect(tracker._saveTimeout).not.toBeNull();

        // Destroy should clear it
        await tracker.destroy();

        expect(tracker._saveTimeout).toBeNull();
        expect(tracker.destroyed).toBe(true);
    });

    test('destroy() is idempotent', async () => {
        const tracker = new CostTracker();
        await tracker.destroy();
        await tracker.destroy(); // should not throw
        expect(tracker.destroyed).toBe(true);
    });
});

// ============================================================================
// Test 4: All classes with setInterval have matching clearInterval in stop/destroy
// ============================================================================
describe('All setInterval calls have matching clearInterval in stop/destroy', () => {
    // These files are known to call setInterval. We verify each one stores
    // the handle and clears it in a stop/destroy method.

    const filesToCheck = [
        { file: 'history-tracker.js', intervals: ['collectTimer', 'saveTimer'], cleanup: 'stop' },
        { file: 'upstream-health.js', intervals: ['_probeTimer'], cleanup: 'stop' },
        { file: 'adaptive-concurrency.js', intervals: ['_tickInterval'], cleanup: 'stop' },
        { file: 'rate-limit-sync.js', intervals: ['_tickInterval'], cleanup: 'stop' },
        { file: 'replay-queue.js', intervals: ['cleanupInterval'], cleanup: 'destroy' },
        { file: 'request-store.js', intervals: ['_cleanupInterval'], cleanup: 'destroy' },
        { file: 'admin-auth.js', intervals: ['_cleanupInterval'], cleanup: 'destroy' },
        { file: 'key-manager.js', intervals: ['_slowKeyCheckInterval'], cleanup: 'destroy' },
        { file: 'stats-aggregator.js', intervals: ['saveTimer'], cleanup: 'stopAutoSave' },
    ];

    for (const { file, intervals, cleanup } of filesToCheck) {
        test(`${file}: setInterval handles [${intervals.join(', ')}] are cleared in ${cleanup}()`, () => {
            const source = fs.readFileSync(path.join(__dirname, '..', 'lib', file), 'utf8');

            // Verify each interval variable is assigned from setInterval
            for (const varName of intervals) {
                const assignmentPattern = new RegExp(`this\\.${varName}\\s*=\\s*setInterval`);
                expect(source).toMatch(assignmentPattern);
            }

            // Verify cleanup method exists
            const cleanupPattern = new RegExp(`${cleanup}\\s*\\(`);
            expect(source).toMatch(cleanupPattern);

            // Verify each interval is cleared in some method via clearInterval
            for (const varName of intervals) {
                const clearPattern = new RegExp(`clearInterval\\(this\\.${varName}\\)`);
                expect(source).toMatch(clearPattern);
            }
        });
    }

    test('predictive-scaler.js: has a stop() or destroy() method', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'lib', 'predictive-scaler.js'), 'utf8'
        );
        // PredictiveScaler should have stop() or destroy()
        const hasStop = /stop\s*\(/.test(source);
        const hasDestroy = /destroy\s*\(/.test(source);
        expect(hasStop || hasDestroy).toBe(true);
    });

    test('cost-tracker.js: _saveTimeout is cleared in destroy()', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'lib', 'cost-tracker.js'), 'utf8'
        );
        // destroy() should exist and clear the timeout
        expect(source).toMatch(/destroy\s*\(/);
        expect(source).toMatch(/clearTimeout\(this\._saveTimeout\)/);
    });
});

// ============================================================================
// Test 5: ProxyServer.shutdown() calls stop/destroy on all sub-components
// ============================================================================
describe('ProxyServer.shutdown() sub-component cleanup', () => {
    test('shutdown method calls stop/destroy on all timer-owning sub-components', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'lib', 'proxy-server.js'), 'utf8'
        );

        // Extract the shutdown method body
        // We look for the actual cleanup calls within the file
        const requiredCleanups = [
            // Sub-component stop/destroy calls
            { pattern: /this\.historyTracker[.\s\S]*?\.stop\(\)/, name: 'historyTracker.stop()' },
            { pattern: /this\.costTracker[.\s\S]*?\.destroy\(\)/, name: 'costTracker.destroy()' },
            { pattern: /this\.upstreamHealth[.\s\S]*?\.stop\(\)/, name: 'upstreamHealth.stop()' },
            { pattern: /this\.usageMonitor[.\s\S]*?\.persistAndStop\(\)/, name: 'usageMonitor.persistAndStop()' },
            { pattern: /this\.rateLimitSync[.\s\S]*?\.persistAndStop\(\)/, name: 'rateLimitSync.persistAndStop()' },
            { pattern: /this\.webhookManager[.\s\S]*?\.drain\(/, name: 'webhookManager.drain()' },
            // Intervals owned directly by ProxyServer
            { pattern: /clearInterval\(this\._scalerInterval\)/, name: 'clearInterval(_scalerInterval)' },
            { pattern: /clearInterval\(this\._rateLimitCleanupInterval\)/, name: 'clearInterval(_rateLimitCleanupInterval)' },
            { pattern: /clearInterval\(this\._auditFlushTimer\)/, name: 'clearInterval(_auditFlushTimer)' },
            // PredictiveScaler cleanup - either via scaler.stop() or clearInterval(_scalerInterval)
            { pattern: /this\._scalerInterval/, name: '_scalerInterval cleanup' },
        ];

        for (const { pattern, name } of requiredCleanups) {
            expect(source).toMatch(pattern);
        }
    });

    test('shutdown cleans up predictiveScaler (via _scalerInterval or scaler.stop())', () => {
        const source = fs.readFileSync(
            path.join(__dirname, '..', 'lib', 'proxy-server.js'), 'utf8'
        );

        // The proxy clears the externally-managed scaler interval
        const clearsScalerInterval = /clearInterval\(this\._scalerInterval\)/.test(source);
        // OR it calls predictiveScaler.stop()
        const callsScalerStop = /this\.predictiveScaler\.stop\(\)/.test(source);

        expect(clearsScalerInterval || callsScalerStop).toBe(true);
    });
});
