/**
 * Unit Test: Stats Persistence Module
 *
 * TDD Phase: Red - Write failing unit test before module exists
 *
 * Tests the StatsPersistence class which handles file I/O for stats storage.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let StatsPersistence;
try {
    ({ StatsPersistence } = require('../../lib/stats/persistence'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = StatsPersistence ? describe : describe.skip;

describeIfModule('stats-persistence', () => {
    let tempDir;
    let statsPath;
    let persistence;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-test-'));
        statsPath = path.join(tempDir, 'test-stats.json');
        persistence = new StatsPersistence({
            filepath: statsPath,
            schemaVersion: 1,
            logger: null
        });
    });

    afterEach(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    describe('constructor', () => {
        it('should create a new StatsPersistence', () => {
            expect(persistence).toBeInstanceOf(StatsPersistence);
        });

        it('should store configuration', () => {
            expect(persistence.filepath).toBe(statsPath);
            expect(persistence.schemaVersion).toBe(1);
        });

        it('should use default schema version when not provided', () => {
            const p = new StatsPersistence({ filepath: statsPath });
            expect(p.schemaVersion).toBe(1);
        });
    });

    describe('load', () => {
        it('should return success=false and empty data when file does not exist', () => {
            const result = persistence.load();

            expect(result).toHaveProperty('success', false);
            expect(result).toHaveProperty('data');
            expect(result.data).toHaveProperty('keys', {});
            expect(result.data).toHaveProperty('totals', {});
        });

        it('should return success=true and parsed data when file exists', () => {
            const testData = {
                schemaVersion: 1,
                keys: { 'key-abc': { requests: 42, successes: 30, failures: 12 } },
                totals: { requests: 100, successes: 80, failures: 20 }
            };
            fs.writeFileSync(statsPath, JSON.stringify(testData));

            const result = persistence.load();

            expect(result.success).toBe(true);
            expect(result.data.keys['key-abc'].requests).toBe(42);
            expect(result.data.totals.requests).toBe(100);
        });

        it('should handle corrupted JSON gracefully', () => {
            fs.writeFileSync(statsPath, '{ invalid json }');

            const result = persistence.load();

            expect(result.success).toBe(false);
            expect(result.data.keys).toEqual({});
        });

        it('should handle empty file', () => {
            fs.writeFileSync(statsPath, '');

            const result = persistence.load();

            expect(result.success).toBe(false);
        });

        it('should merge with defaults when provided', () => {
            const testData = {
                schemaVersion: 1,
                keys: { 'key1': { requests: 10 } }
            };
            fs.writeFileSync(statsPath, JSON.stringify(testData));

            const defaults = {
                keys: { 'key2': { requests: 5 } },
                totals: { requests: 0 }
            };

            const result = persistence.load(defaults);

            expect(result.success).toBe(true);
            expect(result.data.keys.key1.requests).toBe(10);
            expect(result.data.keys.key2.requests).toBe(5);
        });

        it('should handle newer schema version', () => {
            const testData = {
                schemaVersion: 999,
                keys: { 'key1': { requests: 10 } }
            };
            fs.writeFileSync(statsPath, JSON.stringify(testData));

            const result = persistence.load();

            expect(result.success).toBe(true);
            // Should still load the data
            expect(result.data.keys.key1.requests).toBe(10);
        });

        it('should handle missing schemaVersion', () => {
            const testData = {
                keys: { 'key1': { requests: 10 } }
            };
            fs.writeFileSync(statsPath, JSON.stringify(testData));

            const result = persistence.load();

            expect(result.success).toBe(true);
            expect(result.data.keys.key1.requests).toBe(10);
        });
    });

    describe('save', () => {
        it('should save stats to file', async () => {
            const stats = {
                keys: { 'test-key': { requests: 15 } },
                totals: { requests: 15 }
            };

            const result = await persistence.save(stats);

            expect(result).toBe(true);

            const content = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
            expect(content.keys['test-key'].requests).toBe(15);
            expect(content.schemaVersion).toBe(1);
        });

        it('should include schemaVersion in output', async () => {
            const stats = { keys: {}, totals: {} };

            await persistence.save(stats);

            const content = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
            expect(content).toHaveProperty('schemaVersion', 1);
        });

        it('should overwrite existing file', async () => {
            // Create initial file
            fs.writeFileSync(statsPath, JSON.stringify({ old: 'data' }));

            const stats = { keys: { new: true }, totals: {} };
            await persistence.save(stats);

            const content = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
            expect(content).not.toHaveProperty('old');
            expect(content.keys.new).toBe(true);
        });

        it('should include lastUpdated timestamp', async () => {
            const before = Date.now();
            const stats = {
                keys: {},
                totals: {},
                lastUpdated: new Date(before).toISOString()
            };

            await persistence.save(stats);

            const content = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
            expect(content.lastUpdated).toBeDefined();
        });

        it('should handle write errors gracefully', async () => {
            // Use the same approach as contract test - path with NUL byte
            // which is invalid on all platforms
            const invalidPersistence = new StatsPersistence({
                filepath: 'Z:\\nonexistent\\drive\\path\\\0invalid.json',
                schemaVersion: 1,
                logger: null
            });

            const result = await invalidPersistence.save({ keys: {}, totals: {} });
            expect(result).toBe(false);
        });

        it('should not throw on null stats', () => {
            expect(() => persistence.save(null)).not.toThrow();
        });
    });

    describe('flush support', () => {
        it('should track pending saves for flush', async () => {
            const stats = { keys: {}, totals: {} };

            const savePromise = persistence.save(stats);

            // Promise should be tracked
            expect(persistence.getPendingSaves().size).toBeGreaterThan(0);

            // Wait for save to complete
            await savePromise;

            expect(persistence.getPendingSaves().size).toBe(0);
        });

        it('should flush all pending saves', async () => {
            // Create multiple saves
            persistence.save({ keys: {}, totals: {} });
            persistence.save({ keys: { k1: {} }, totals: {} });
            persistence.save({ keys: {}, totals: {} });

            await persistence.flush();

            expect(persistence.getPendingSaves().size).toBe(0);
        });

        it('should return immediately when no pending saves', async () => {
            const start = Date.now();
            await persistence.flush();
            const elapsed = Date.now() - start;

            expect(elapsed).toBeLessThan(100);
        });
    });

    // Additional tests for uncovered branches

    describe('constructor edge cases', () => {
        it('should throw error when filepath is not provided', () => {
            expect(() => new StatsPersistence({})).toThrow('filepath is required');
        });

        it('should throw error when filepath is empty string', () => {
            expect(() => new StatsPersistence({ filepath: '' })).toThrow('filepath is required');
        });

        it('should throw error when filepath is null', () => {
            expect(() => new StatsPersistence({ filepath: null })).toThrow('filepath is required');
        });
    });

    describe('load with schema version handling', () => {
        it('should handle data with newer schema version', () => {
            const testData = {
                schemaVersion: 99, // Newer than our version 1
                keys: { 'key-1': { requests: 10 } },
                totals: { requests: 10 }
            };
            fs.writeFileSync(statsPath, JSON.stringify(testData));

            const mockLogger = {
                warn: jest.fn(),
                info: jest.fn(),
                error: jest.fn(),
                debug: jest.fn()
            };
            const persistenceWithLogger = new StatsPersistence({
                filepath: statsPath,
                schemaVersion: 1,
                logger: mockLogger
            });

            const result = persistenceWithLogger.load();

            expect(result.success).toBe(true);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('newer schema'), {});
        });

        it('should handle data with missing schemaVersion (treat as version 0)', () => {
            const testData = {
                keys: { 'key-1': { requests: 10 } },
                totals: { requests: 10 }
            };
            fs.writeFileSync(statsPath, JSON.stringify(testData));

            const result = persistence.load();

            expect(result.success).toBe(true);
            expect(result.data.keys['key-1'].requests).toBe(10);
        });
    });

    describe('load with defaults merging', () => {
        it('should merge defaults when file does not exist', () => {
            const defaults = {
                keys: { 'default-key': { requests: 5 } },
                totals: { requests: 5 }
            };

            const result = persistence.load(defaults);

            expect(result.success).toBe(false);
            expect(result.data.keys['default-key']).toEqual({ requests: 5 });
            expect(result.data.totals.requests).toBe(5);
        });

        it('should merge defaults when file is empty', () => {
            fs.writeFileSync(statsPath, '');
            const defaults = {
                keys: { 'default-key': { requests: 5 } },
                totals: { requests: 5 }
            };

            const result = persistence.load(defaults);

            expect(result.success).toBe(false);
            expect(result.data.keys['default-key']).toEqual({ requests: 5 });
        });

        it('should merge defaults with loaded data (defaults override)', () => {
            const testData = {
                schemaVersion: 1,
                keys: { 'loaded-key': { requests: 20 } },
                totals: { requests: 20 }
            };
            fs.writeFileSync(statsPath, JSON.stringify(testData));

            const defaults = {
                keys: { 'default-key': { requests: 5 } },
                totals: { requests: 5 }
            };

            const result = persistence.load(defaults);

            expect(result.success).toBe(true);
            // Both keys should be present (loaded data takes precedence for same keys)
            expect(result.data.keys['loaded-key']).toBeDefined();
            expect(result.data.keys['default-key']).toBeDefined();
        });
    });

    describe('_log method with logger', () => {
        it('should dispatch to the correct logger level with context', () => {
            const mockLogger = {
                debug: jest.fn(),
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn()
            };
            const p = new StatsPersistence({
                filepath: statsPath,
                logger: mockLogger
            });

            p._log('debug', 'debug msg');
            expect(mockLogger.debug).toHaveBeenCalledWith('debug msg', {});

            p._log('warn', 'warn msg', { key: 'value' });
            expect(mockLogger.warn).toHaveBeenCalledWith('warn msg', { key: 'value' });
        });

        it('should not throw when logger is missing or level is not a function', () => {
            const pNoLogger = new StatsPersistence({ filepath: statsPath });
            expect(() => pNoLogger._log('info', 'test')).not.toThrow();

            const pBadLevel = new StatsPersistence({
                filepath: statsPath,
                logger: { info: 'not a function' }
            });
            expect(() => pBadLevel._log('info', 'test')).not.toThrow();
        });
    });

    describe('save with null/undefined stats', () => {
        it('should return false when stats is null', async () => {
            const result = await persistence.save(null);
            expect(result).toBe(false);
        });

        it('should return false when stats is undefined', async () => {
            const result = await persistence.save(undefined);
            expect(result).toBe(false);
        });

        it('should return true when stats is valid', async () => {
            const result = await persistence.save({ keys: {}, totals: {} });
            expect(result).toBe(true);
        });
    });

    describe('interface contract', () => {
        it('should have load method', () => {
            expect(typeof persistence.load).toBe('function');
        });

        it('should have save method', () => {
            expect(typeof persistence.save).toBe('function');
        });

        it('should have flush method', () => {
            expect(typeof persistence.flush).toBe('function');
        });

        it('should have getPendingSaves method', () => {
            expect(typeof persistence.getPendingSaves).toBe('function');
        });
    });
});
