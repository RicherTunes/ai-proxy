'use strict';

/**
 * File I/O Safety — Corruption Recovery Tests
 *
 * Tests that modules gracefully handle corrupted JSON on disk:
 * 9.  Config file corruption recovery
 * 10. Stats file corruption recovery (StatsAggregator)
 * 11. History file corruption recovery (HistoryTracker)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

describe('File I/O safety — corruption recovery', () => {
    let testDir;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-io-safety-'));
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    // ── 9. Config file corruption recovery ────────────────────────────
    describe('9 - Config: corrupted api-keys.json', () => {
        it('handles truncated JSON in api-keys.json without crashing', () => {
            // Write a corrupted keys file
            const keysPath = path.join(testDir, 'api-keys.json');
            fs.writeFileSync(keysPath, '{"keys": ["key1", "key2"');  // Truncated — missing ]}

            // Reset singleton before creating a new Config
            const { Config, resetConfig } = require('../lib/config');
            resetConfig();

            // Should not throw — should fall back to empty apiKeys
            let config;
            expect(() => {
                config = new Config({ configDir: testDir, keysFile: 'api-keys.json' });
            }).not.toThrow();

            expect(config.apiKeys).toEqual([]);
            expect(config.hasLoadErrors()).toBe(true);

            const errors = config.flushLoadErrors();
            expect(errors.length).toBeGreaterThan(0);
            expect(errors[0].type).toBe('api_keys');
        });

        it('handles completely invalid content (binary garbage)', () => {
            const keysPath = path.join(testDir, 'api-keys.json');
            fs.writeFileSync(keysPath, Buffer.from([0xFF, 0xFE, 0x00, 0x01, 0xAB, 0xCD]));

            const { Config, resetConfig } = require('../lib/config');
            resetConfig();

            let config;
            expect(() => {
                config = new Config({ configDir: testDir, keysFile: 'api-keys.json' });
            }).not.toThrow();

            expect(config.apiKeys).toEqual([]);
        });

        it('handles empty file', () => {
            const keysPath = path.join(testDir, 'api-keys.json');
            fs.writeFileSync(keysPath, '');

            const { Config, resetConfig } = require('../lib/config');
            resetConfig();

            let config;
            expect(() => {
                config = new Config({ configDir: testDir, keysFile: 'api-keys.json' });
            }).not.toThrow();

            expect(config.apiKeys).toEqual([]);
        });

        it('handles missing keys file gracefully', () => {
            const { Config, resetConfig } = require('../lib/config');
            resetConfig();

            let config;
            expect(() => {
                config = new Config({ configDir: testDir, keysFile: 'nonexistent-keys.json' });
            }).not.toThrow();

            expect(config.apiKeys).toEqual([]);
        });
    });

    // ── 10. Stats file corruption recovery ────────────────────────────
    describe('10 - StatsAggregator: corrupted stats file', () => {
        it('handles truncated JSON in stats file without crashing', () => {
            const statsPath = path.join(testDir, 'stats.json');
            fs.writeFileSync(statsPath, '{"totals":{"requests":100');  // Truncated

            const { StatsAggregator } = require('../lib/stats-aggregator');
            const agg = new StatsAggregator({
                configDir: testDir,
                statsFile: 'stats.json',
                saveInterval: 0  // Disable auto-save for test
            });

            // load() should not throw, should fall back to empty stats
            let result;
            expect(() => {
                result = agg.load();
            }).not.toThrow();

            expect(result).toBe(false);  // Load failed
            expect(agg.stats.totals.requests).toBe(0);  // Fallback to empty
        });

        it('handles completely invalid content', () => {
            const statsPath = path.join(testDir, 'stats.json');
            fs.writeFileSync(statsPath, 'NOT JSON AT ALL!!!');

            const { StatsAggregator } = require('../lib/stats-aggregator');
            const agg = new StatsAggregator({
                configDir: testDir,
                statsFile: 'stats.json',
                saveInterval: 0
            });

            expect(() => agg.load()).not.toThrow();
            expect(agg.stats.totals.requests).toBe(0);
        });

        it('handles empty file', () => {
            const statsPath = path.join(testDir, 'stats.json');
            fs.writeFileSync(statsPath, '');

            const { StatsAggregator } = require('../lib/stats-aggregator');
            const agg = new StatsAggregator({
                configDir: testDir,
                statsFile: 'stats.json',
                saveInterval: 0
            });

            expect(() => agg.load()).not.toThrow();
            expect(agg.stats.totals.requests).toBe(0);
        });

        it('handles missing stats file (first run)', () => {
            const { StatsAggregator } = require('../lib/stats-aggregator');
            const agg = new StatsAggregator({
                configDir: testDir,
                statsFile: 'nonexistent.json',
                saveInterval: 0
            });

            expect(() => agg.load()).not.toThrow();
            expect(agg.stats.totals.requests).toBe(0);
        });

        it('recovers and can write new valid data after corrupt load', async () => {
            const statsPath = path.join(testDir, 'stats-recover.json');
            fs.writeFileSync(statsPath, 'CORRUPTED DATA!!!');

            const { StatsAggregator } = require('../lib/stats-aggregator');
            const agg = new StatsAggregator({
                configDir: testDir,
                statsFile: 'stats-recover.json',
                saveInterval: 0
            });

            // Load fails gracefully
            agg.load();
            expect(agg.stats.totals.requests).toBe(0);

            // Record new data
            agg.recordKeyUsage('test-key', { requests: 5, successes: 4, failures: 1 });
            expect(agg.stats.totals.requests).toBe(5);

            // Save should succeed (overwrite corrupt file with valid data)
            agg.save();
            await agg.flush();

            // Read back — should be valid
            const data = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
            expect(data.totals.requests).toBe(5);
        });

        it('handles stats file with future schema version (best effort)', () => {
            const statsPath = path.join(testDir, 'stats-future.json');
            fs.writeFileSync(statsPath, JSON.stringify({
                schemaVersion: 999,
                firstSeen: '2026-01-01T00:00:00.000Z',
                lastUpdated: '2026-03-19T00:00:00.000Z',
                keys: {},
                totals: { requests: 42, successes: 40, failures: 2, retries: 1 }
            }));

            const { StatsAggregator } = require('../lib/stats-aggregator');
            const agg = new StatsAggregator({
                configDir: testDir,
                statsFile: 'stats-future.json',
                saveInterval: 0
            });

            expect(() => agg.load()).not.toThrow();
            // Should load the data even with unknown schema version (best effort)
            expect(agg.stats.totals.requests).toBe(42);
        });
    });

    // ── 11. History file corruption recovery ──────────────────────────
    describe('11 - HistoryTracker: corrupted history file', () => {
        it('handles truncated JSON in history file without crashing', () => {
            const historyPath = path.join(testDir, 'history.json');
            fs.writeFileSync(historyPath, '{"schemaVersion":2,"points":{"fine":[{"timestamp":');

            const { HistoryTracker } = require('../lib/history-tracker');
            const tracker = new HistoryTracker({
                historyFile: historyPath,
                logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
            });

            // load() should not throw, should fall back to empty data
            expect(() => tracker.load()).not.toThrow();

            // All tiers should be empty after failed load
            expect(tracker.tiers.fine.data.size).toBe(0);
            expect(tracker.tiers.medium.data.size).toBe(0);
            expect(tracker.tiers.coarse.data.size).toBe(0);
        });

        it('handles completely invalid content', () => {
            const historyPath = path.join(testDir, 'history.json');
            fs.writeFileSync(historyPath, 'TOTALLY NOT JSON <><>!@#$');

            const { HistoryTracker } = require('../lib/history-tracker');
            const tracker = new HistoryTracker({
                historyFile: historyPath,
                logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
            });

            expect(() => tracker.load()).not.toThrow();
            expect(tracker.tiers.fine.data.size).toBe(0);
        });

        it('handles empty file', () => {
            const historyPath = path.join(testDir, 'history.json');
            fs.writeFileSync(historyPath, '');

            const { HistoryTracker } = require('../lib/history-tracker');
            const tracker = new HistoryTracker({
                historyFile: historyPath,
                logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
            });

            expect(() => tracker.load()).not.toThrow();
            expect(tracker.tiers.fine.data.size).toBe(0);
        });

        it('handles missing history file (first run)', () => {
            const historyPath = path.join(testDir, 'nonexistent-history.json');

            const { HistoryTracker } = require('../lib/history-tracker');
            const tracker = new HistoryTracker({
                historyFile: historyPath,
                logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
            });

            expect(() => tracker.load()).not.toThrow();
            expect(tracker.tiers.fine.data.size).toBe(0);
        });

        it('logs a warning when loading corrupted data', () => {
            const historyPath = path.join(testDir, 'history.json');
            fs.writeFileSync(historyPath, 'BAD DATA');

            const warnFn = jest.fn();
            const { HistoryTracker } = require('../lib/history-tracker');
            const tracker = new HistoryTracker({
                historyFile: historyPath,
                logger: { info: jest.fn(), warn: warnFn, error: jest.fn() }
            });

            tracker.load();

            expect(warnFn).toHaveBeenCalled();
            expect(warnFn.mock.calls[0][0]).toContain('Could not load history');
        });

        it('clears all tiers on corrupt data (no stale residue)', () => {
            const historyPath = path.join(testDir, 'history.json');

            const { HistoryTracker } = require('../lib/history-tracker');
            const tracker = new HistoryTracker({
                historyFile: historyPath,
                logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
            });

            // Manually push some data into tiers before loading corrupt file
            tracker.tiers.fine.data.push({ timestamp: Date.now(), requests: 1 });
            tracker.tiers.medium.data.push({ timestamp: Date.now(), requests: 10 });
            tracker.tiers.coarse.data.push({ timestamp: Date.now(), requests: 100 });

            // Now write corrupt data and load it
            fs.writeFileSync(historyPath, 'CORRUPTED');
            tracker.load();

            // All pre-existing data should be cleared
            expect(tracker.tiers.fine.data.size).toBe(0);
            expect(tracker.tiers.medium.data.size).toBe(0);
            expect(tracker.tiers.coarse.data.size).toBe(0);
        });

        it('recovers and can collect new data after corrupt load', () => {
            const historyPath = path.join(testDir, 'history.json');
            fs.writeFileSync(historyPath, 'CORRUPTED');

            const { HistoryTracker } = require('../lib/history-tracker');
            const tracker = new HistoryTracker({
                historyFile: historyPath,
                logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
            });

            tracker.load();

            // Simulate a stats source
            tracker.statsSource = () => ({
                totalRequests: 10,
                successRate: 95,
                latency: { avg: 100, p95: 200, p99: 300 },
                activeConnections: 2,
                queue: { current: 0 },
                errors: { timeouts: 0, socketHangups: 0, serverErrors: 0, rateLimited: 0, other: 0 },
                keys: [],
                clientRequests: { total: 10, failed: 0 }
            });

            // Collect a data point — should work despite corrupt history
            expect(() => tracker._collectDataPoint()).not.toThrow();
            expect(tracker.tiers.fine.data.size).toBe(1);
        });
    });
});
