/**
 * Coverage Test: lib/stats/persistence.js
 *
 * Targets uncovered branches to achieve 98%+ branch and function coverage.
 * Focus: save/load error paths, file not found handling, corrupt JSON,
 *         atomic write failure recovery, edge cases with defaults and data merging.
 *
 * TDD Phase: Coverage improvement
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { StatsPersistence, _createEmptyStats } = require('../lib/stats/persistence');

describe('persistence-coverage: uncovered branches', () => {
    let tempDir;
    let statsPath;
    let persistence;
    let mockLogger;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-cov-'));
        statsPath = path.join(tempDir, 'test-stats.json');

        mockLogger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        };

        persistence = new StatsPersistence({
            filepath: statsPath,
            schemaVersion: 1,
            logger: mockLogger
        });
    });

    afterEach(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
        jest.restoreAllMocks();
    });

    describe('load: file content edge cases', () => {
        // Covers line 80: content.trim() === '' branch (whitespace-only file)
        it('should handle whitespace-only file content', () => {
            fs.writeFileSync(statsPath, '   \n\t  \r\n  ');

            const result = persistence.load();

            expect(result.success).toBe(false);
            expect(result.data.keys).toEqual({});
            expect(result.data.totals).toEqual({});
            expect(mockLogger.warn).toHaveBeenCalledWith('Stats file is empty', {});
        });

        // Covers line 80: !content branch (explicit empty string)
        it('should handle empty string content', () => {
            fs.writeFileSync(statsPath, '');

            const result = persistence.load();

            expect(result.success).toBe(false);
            expect(mockLogger.warn).toHaveBeenCalledWith('Stats file is empty', {});
        });

        // Covers line 80: content with only spaces (no newline)
        it('should handle file with only spaces', () => {
            fs.writeFileSync(statsPath, '     ');

            const result = persistence.load();

            expect(result.success).toBe(false);
            expect(mockLogger.warn).toHaveBeenCalledWith('Stats file is empty', {});
        });
    });

    describe('load: schema version handling', () => {
        // Covers line 92: else branch when version === this.schemaVersion (no warning)
        it('should not warn when schema version matches current version', () => {
            const testData = {
                schemaVersion: 1, // Same as persistence.schemaVersion
                keys: { 'key1': { requests: 10 } },
                totals: { requests: 10 }
            };
            fs.writeFileSync(statsPath, JSON.stringify(testData));

            const result = persistence.load();

            expect(result.success).toBe(true);
            expect(result.data.keys.key1.requests).toBe(10);
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        // Covers line 92: else branch when version < this.schemaVersion (no warning)
        it('should not warn when schema version is older than current version', () => {
            const persistenceV5 = new StatsPersistence({
                filepath: statsPath,
                schemaVersion: 5,
                logger: mockLogger
            });

            const testData = {
                schemaVersion: 2, // Older than persistence.schemaVersion
                keys: { 'key1': { requests: 10 } },
                totals: { requests: 10 }
            };
            fs.writeFileSync(statsPath, JSON.stringify(testData));

            const result = persistenceV5.load();

            expect(result.success).toBe(true);
            expect(result.data.keys.key1.requests).toBe(10);
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        // Covers line 91: data.schemaVersion || 0 (undefined schemaVersion uses 0)
        it('should treat undefined schemaVersion as version 0', () => {
            const testData = {
                keys: { 'key1': { requests: 10 } },
                totals: { requests: 10 }
            };
            fs.writeFileSync(statsPath, JSON.stringify(testData));

            const result = persistence.load();

            expect(result.success).toBe(true);
            expect(mockLogger.warn).not.toHaveBeenCalled(); // Version 0 < 1, no warning
        });
    });

    describe('load: data merging edge cases', () => {
        // Covers lines 152-153: data.keys || {} and data.totals || {} when undefined
        it('should handle data with missing keys and totals properties', () => {
            const testData = {
                schemaVersion: 1
                // No keys or totals properties
            };
            fs.writeFileSync(statsPath, JSON.stringify(testData));

            const result = persistence.load();

            expect(result.success).toBe(true);
            expect(result.data.keys).toEqual({});
            expect(result.data.totals).toEqual({});
        });

        // Covers lines 152-153: data.keys || {} when keys is null
        it('should handle data with null keys property', () => {
            const testData = {
                schemaVersion: 1,
                keys: null,
                totals: { requests: 5 }
            };
            fs.writeFileSync(statsPath, JSON.stringify(testData));

            const result = persistence.load();

            expect(result.success).toBe(true);
            expect(result.data.keys).toEqual({});
            expect(result.data.totals.requests).toBe(5);
        });

        // Covers lines 152-153: data.totals || {} when totals is null
        it('should handle data with null totals property', () => {
            const testData = {
                schemaVersion: 1,
                keys: { 'key1': { requests: 10 } },
                totals: null
            };
            fs.writeFileSync(statsPath, JSON.stringify(testData));

            const result = persistence.load();

            expect(result.success).toBe(true);
            expect(result.data.keys.key1.requests).toBe(10);
            expect(result.data.totals).toEqual({});
        });

        // Covers lines 152-153: both keys and totals are null
        it('should handle data with both keys and totals as null', () => {
            const testData = {
                schemaVersion: 1,
                keys: null,
                totals: null
            };
            fs.writeFileSync(statsPath, JSON.stringify(testData));

            const result = persistence.load();

            expect(result.success).toBe(true);
            expect(result.data.keys).toEqual({});
            expect(result.data.totals).toEqual({});
        });
    });

    describe('load: defaults merging edge cases', () => {
        // Covers line 157: else branch when defaults is null
        it('should merge data without defaults when defaults is null', () => {
            const testData = {
                schemaVersion: 1,
                keys: { 'key1': { requests: 10 } },
                totals: { requests: 10 }
            };
            fs.writeFileSync(statsPath, JSON.stringify(testData));

            const result = persistence.load(null);

            expect(result.success).toBe(true);
            expect(result.data.keys.key1.requests).toBe(10);
            expect(result.data.totals.requests).toBe(10);
        });

        // Covers line 158: else branch when defaults.keys is undefined
        it('should merge defaults when keys is undefined but totals exists', () => {
            const testData = {
                schemaVersion: 1,
                keys: { 'loadedKey': { requests: 5 } },
                totals: { requests: 5 }
            };
            fs.writeFileSync(statsPath, JSON.stringify(testData));

            const defaults = {
                totals: { requests: 100, successes: 50 }
                // No keys property
            };

            const result = persistence.load(defaults);

            expect(result.success).toBe(true);
            expect(result.data.keys.loadedKey.requests).toBe(5);
            expect(result.data.totals.requests).toBe(5); // Loaded data takes precedence
            expect(result.data.totals.successes).toBe(50);
        });

        // Covers line 161: else branch when defaults.totals is undefined
        it('should merge defaults when totals is undefined but keys exists', () => {
            const testData = {
                schemaVersion: 1,
                keys: { 'loadedKey': { requests: 5 } },
                totals: { requests: 5 }
            };
            fs.writeFileSync(statsPath, JSON.stringify(testData));

            const defaults = {
                keys: { 'defaultKey': { requests: 20 } }
                // No totals property
            };

            const result = persistence.load(defaults);

            expect(result.success).toBe(true);
            expect(result.data.keys.loadedKey.requests).toBe(5);
            expect(result.data.keys.defaultKey.requests).toBe(20);
            expect(result.data.totals.requests).toBe(5);
        });

        // Covers line 158: defaults.keys is null
        it('should handle defaults with null keys property', () => {
            const testData = {
                schemaVersion: 1,
                keys: { 'loadedKey': { requests: 5 } },
                totals: { requests: 5 }
            };
            fs.writeFileSync(statsPath, JSON.stringify(testData));

            const defaults = {
                keys: null,
                totals: { requests: 100 }
            };

            const result = persistence.load(defaults);

            expect(result.success).toBe(true);
            expect(result.data.keys.loadedKey.requests).toBe(5);
            expect(result.data.totals.requests).toBe(5);
        });

        // Covers line 161: defaults.totals is null
        it('should handle defaults with null totals property', () => {
            const testData = {
                schemaVersion: 1,
                keys: { 'loadedKey': { requests: 5 } },
                totals: { requests: 5 }
            };
            fs.writeFileSync(statsPath, JSON.stringify(testData));

            const defaults = {
                keys: { 'defaultKey': { requests: 20 } },
                totals: null
            };

            const result = persistence.load(defaults);

            expect(result.success).toBe(true);
            expect(result.data.keys.defaultKey.requests).toBe(20);
            expect(result.data.totals.requests).toBe(5);
        });
    });

    describe('_createEmptyData: defaults edge cases', () => {
        // Covers line 131: else branch when defaults is null
        it('should create empty data without defaults', () => {
            const result = persistence._createEmptyData(null);

            expect(result.keys).toEqual({});
            expect(result.totals).toEqual({});
        });

        // Covers line 132: else branch when defaults.keys is undefined
        it('should create empty data with defaults but no keys', () => {
            const defaults = {
                totals: { requests: 100 }
            };

            const result = persistence._createEmptyData(defaults);

            expect(result.keys).toEqual({});
            expect(result.totals.requests).toBe(100);
        });

        // Covers line 135: else branch when defaults.totals is undefined
        it('should create empty data with defaults but no totals', () => {
            const defaults = {
                keys: { 'key1': { requests: 10 } }
            };

            const result = persistence._createEmptyData(defaults);

            expect(result.keys.key1.requests).toBe(10);
            expect(result.totals).toEqual({});
        });

        // Covers line 132: defaults.keys is null
        it('should handle defaults with null keys', () => {
            const defaults = {
                keys: null,
                totals: { requests: 100 }
            };

            const result = persistence._createEmptyData(defaults);

            expect(result.keys).toEqual({});
            expect(result.totals.requests).toBe(100);
        });

        // Covers line 135: defaults.totals is null
        it('should handle defaults with null totals', () => {
            const defaults = {
                keys: { 'key1': { requests: 10 } },
                totals: null
            };

            const result = persistence._createEmptyData(defaults);

            expect(result.keys.key1.requests).toBe(10);
            expect(result.totals).toEqual({});
        });
    });

    describe('_mergeData: edge cases', () => {
        // Covers lines 159, 162: when data has null/undefined properties
        it('should merge data with null keys and totals', () => {
            const data = {
                keys: null,
                totals: null
            };
            const defaults = {
                keys: { 'defaultKey': { requests: 5 } },
                totals: { requests: 5 }
            };

            const result = persistence._mergeData(data, defaults);

            // When data.keys is null, data.keys || {} = {}, then defaults.keys spreads over it
            expect(result.keys).toEqual({ 'defaultKey': { requests: 5 } });
            expect(result.totals).toEqual({ requests: 5 });
        });

        // Covers line 159: when defaults.keys is spread over empty keys
        it('should spread defaults.keys when data.keys is empty', () => {
            const data = {
                keys: {},
                totals: { requests: 10 }
            };
            const defaults = {
                keys: { 'defaultKey': { requests: 5 } },
                totals: { requests: 0 }
            };

            const result = persistence._mergeData(data, defaults);

            expect(result.keys.defaultKey.requests).toBe(5);
            expect(result.totals.requests).toBe(10);
        });
    });

    describe('save: edge cases', () => {
        // Covers line 177: else branch when stats is truthy
        it('should save when stats is a valid object', async () => {
            const stats = {
                keys: { 'key1': { requests: 10 } },
                totals: { requests: 10 }
            };

            const result = await persistence.save(stats);

            expect(result).toBe(true);
            expect(mockLogger.info).toHaveBeenCalledWith(`Saved persistent stats to ${statsPath}`, {});
        });

        // Covers line 183: stats object merging
        it('should merge stats with schemaVersion and lastUpdated', async () => {
            const stats = {
                keys: { 'key1': { requests: 10 } },
                totals: { requests: 10 },
                customField: 'custom'
            };

            await persistence.save(stats);

            const content = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
            expect(content.schemaVersion).toBe(1);
            expect(content.customField).toBe('custom');
            expect(content.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        });
    });

    describe('logger: null and missing method cases', () => {
        // Covers line 64: else branch when this.logger is null
        it('should not throw when logger is null', () => {
            const noLoggerPersistence = new StatsPersistence({
                filepath: statsPath,
                schemaVersion: 1,
                logger: null
            });

            expect(() => noLoggerPersistence._log('warn', 'test message')).not.toThrow();
        });

        // Covers line 64: else branch when typeof this.logger[level] is not function
        it('should not throw when logger[level] is not a function', () => {
            const badLoggerPersistence = new StatsPersistence({
                filepath: statsPath,
                schemaVersion: 1,
                logger: {
                    warn: 'not a function',
                    info: () => {}
                }
            });

            expect(() => badLoggerPersistence._log('warn', 'test message')).not.toThrow();
        });

        // Covers line 64: when logger[level] exists and is called
        it('should call logger[level] when it is a function', () => {
            persistence._log('warn', 'test message', { key: 'value' });

            expect(mockLogger.warn).toHaveBeenCalledWith('test message', { key: 'value' });
        });

        // Covers line 64: when logger exists but level method doesn't
        it('should handle logger with missing level method', () => {
            const partialLogger = {
                info: jest.fn()
                // No warn, error, debug methods
            };
            const partialPersistence = new StatsPersistence({
                filepath: statsPath,
                schemaVersion: 1,
                logger: partialLogger
            });

            expect(() => partialPersistence._log('warn', 'test')).not.toThrow();
            expect(() => partialPersistence._log('error', 'test')).not.toThrow();
        });
    });

    describe('flush: edge cases', () => {
        // Covers line 215: when pendingSaves.size === 0
        it('should return immediately when no pending saves', async () => {
            const result = persistence.flush();

            expect(result).resolves.toBeUndefined();
        });

        // Covers line 219: Promise.all with pending saves
        it('should wait for all pending saves', async () => {
            const stats = { keys: {}, totals: {} };
            persistence.save(stats);
            persistence.save(stats);

            await persistence.flush();

            expect(persistence.getPendingSaves().size).toBe(0);
        });
    });

    describe('load: error handling', () => {
        // Covers line 108: catch block for JSON parse errors
        it('should handle JSON parse error and log it', () => {
            fs.writeFileSync(statsPath, '{ invalid json }');

            const result = persistence.load();

            expect(result.success).toBe(false);
            expect(mockLogger.error).toHaveBeenCalled();
            const errorMessage = mockLogger.error.mock.calls[0][0];
            expect(errorMessage).toContain('Failed to load');
        });

        // Covers line 108: catch block for readFileSync errors
        it('should handle file read error gracefully', () => {
            // Make the file unreadable by changing to a directory
            fs.rmSync(statsPath, { force: true });
            fs.mkdirSync(statsPath);

            const result = persistence.load();

            expect(result.success).toBe(false);
            expect(mockLogger.error).toHaveBeenCalled();
            const errorMessage = mockLogger.error.mock.calls[0][0];
            expect(errorMessage).toContain('Failed to load');
        });
    });

    describe('save: atomic write error handling', () => {
        // Covers line 197: catch block for atomicWrite errors
        it('should handle atomic write failure and log error', async () => {
            jest.spyOn(require('../lib/atomic-write'), 'atomicWrite')
                .mockRejectedValue(new Error('EACCES: permission denied'));

            const stats = { keys: {}, totals: {} };
            const result = await persistence.save(stats);

            expect(result).toBe(false);
            expect(mockLogger.error).toHaveBeenCalled();
            const errorMessage = mockLogger.error.mock.calls[0][0];
            expect(errorMessage).toContain('Failed to save');
        });

        // Covers line 202: finally block cleanup
        it('should remove save promise from pendingSaves in finally block', async () => {
            const stats = { keys: {}, totals: {} };
            const savePromise = persistence.save(stats);

            expect(persistence.getPendingSaves().size).toBeGreaterThan(0);

            await savePromise;

            expect(persistence.getPendingSaves().size).toBe(0);
        });

        // Covers line 202: finally runs even on error
        it('should clean up pendingSaves even when save fails', async () => {
            jest.spyOn(require('../lib/atomic-write'), 'atomicWrite')
                .mockRejectedValue(new Error('Write failed'));

            const stats = { keys: {}, totals: {} };
            const savePromise = persistence.save(stats);

            expect(persistence.getPendingSaves().size).toBeGreaterThan(0);

            await savePromise;

            expect(persistence.getPendingSaves().size).toBe(0);
        });
    });

    describe('constructor: default schema version', () => {
        // Covers line 51: ?? operator with undefined schemaVersion
        it('should use DEFAULT_SCHEMA_VERSION when schemaVersion is undefined', () => {
            const p = new StatsPersistence({
                filepath: statsPath
            });

            expect(p.schemaVersion).toBe(1);
        });

        // Covers line 51: ?? operator with null schemaVersion
        it('should use DEFAULT_SCHEMA_VERSION when schemaVersion is null', () => {
            const p = new StatsPersistence({
                filepath: statsPath,
                schemaVersion: null
            });

            expect(p.schemaVersion).toBe(1);
        });

        // Covers line 51: when schemaVersion is provided
        it('should use provided schemaVersion', () => {
            const p = new StatsPersistence({
                filepath: statsPath,
                schemaVersion: 5
            });

            expect(p.schemaVersion).toBe(5);
        });

        // Covers line 52: || operator when logger is false (falsy but not null)
        it('should treat false logger as null', () => {
            const p = new StatsPersistence({
                filepath: statsPath,
                logger: false
            });

            expect(p.logger).toBe(null);
        });

        // Covers line 52: || operator when logger is 0 (falsy but not null)
        it('should treat 0 logger as null', () => {
            const p = new StatsPersistence({
                filepath: statsPath,
                logger: 0
            });

            expect(p.logger).toBe(null);
        });

        // Covers line 52: || operator when logger is empty string
        it('should treat empty string logger as null', () => {
            const p = new StatsPersistence({
                filepath: statsPath,
                logger: ''
            });

            expect(p.logger).toBe(null);
        });

        // Covers line 52: || operator when logger is provided
        it('should use provided logger when truthy', () => {
            const testLogger = { info: () => {} };
            const p = new StatsPersistence({
                filepath: statsPath,
                logger: testLogger
            });

            expect(p.logger).toBe(testLogger);
        });
    });

    describe('_createEmptyStats: exported function', () => {
        // Covers lines 21-33: _createEmptyStats function
        it('should create empty stats structure with default values', () => {
            const stats = _createEmptyStats();

            expect(stats).toHaveProperty('firstSeen');
            expect(stats).toHaveProperty('lastUpdated');
            expect(stats).toHaveProperty('keys', {});
            expect(stats).toHaveProperty('totals');
            expect(stats.totals).toHaveProperty('requests', 0);
            expect(stats.totals).toHaveProperty('successes', 0);
            expect(stats.totals).toHaveProperty('failures', 0);
            expect(stats.totals).toHaveProperty('retries', 0);
        });

        it('should create ISO timestamp strings for firstSeen and lastUpdated', () => {
            const stats = _createEmptyStats();

            expect(stats.firstSeen).toMatch(/^\d{4}-\d{2}-\d{2}T/);
            expect(stats.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        });

        it('should create independent instances on each call', () => {
            const stats1 = _createEmptyStats();
            const stats2 = _createEmptyStats();

            expect(stats1).not.toBe(stats2);
            expect(stats1.keys).not.toBe(stats2.keys);
            expect(stats1.totals).not.toBe(stats2.totals);
        });
    });
});
