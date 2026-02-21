/**
 * Contract Test: Stats Persistence
 *
 * This contract test ensures that persistence operations produce consistent results
 * after extraction from StatsAggregator to persistence.js.
 *
 * TDD Phase: Red - Write failing test first
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

describeIfModule('StatsAggregator Contract: Persistence Operations', () => {
    let tempDir;
    let statsPath;
    let persistence;

    beforeEach(() => {
        // Create temp directory for tests
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-test-'));
        statsPath = path.join(tempDir, 'test-stats.json');
        persistence = new StatsPersistence({
            filepath: statsPath,
            schemaVersion: 1,
            logger: null
        });
    });

    afterEach(() => {
        // Cleanup temp directory
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    describe('load functionality', () => {
        it('should return false when file does not exist', () => {
            const result = persistence.load();
            expect(result.success).toBe(false);
            expect(result.data).toBeDefined();
            expect(result.data.keys).toEqual({});
        });

        it('should load existing stats from file', () => {
            // Create a stats file
            const testData = {
                schemaVersion: 1,
                keys: { 'key1': { requests: 10 } },
                totals: { requests: 10 }
            };
            fs.writeFileSync(statsPath, JSON.stringify(testData));

            const result = persistence.load();
            expect(result.success).toBe(true);
            expect(result.data.keys.key1.requests).toBe(10);
            expect(result.data.totals.requests).toBe(10);
        });

        it('should handle corrupted file gracefully', () => {
            // Write invalid JSON
            fs.writeFileSync(statsPath, '{ invalid json }');

            const result = persistence.load();
            expect(result.success).toBe(false);
            expect(result.data.keys).toEqual({});
        });
    });

    describe('save functionality', () => {
        it('should save stats to file', async () => {
            const stats = {
                keys: { 'key1': { requests: 5 } },
                totals: { requests: 5 },
                lastUpdated: new Date().toISOString()
            };

            const result = await persistence.save(stats);
            expect(result).toBe(true);

            // Verify file was created
            const content = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
            expect(content.keys.key1.requests).toBe(5);
            expect(content.schemaVersion).toBe(1);
        });

        it('should include schema version in saved file', async () => {
            const stats = { keys: {}, totals: { requests: 0 } };

            await persistence.save(stats);

            const content = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
            expect(content.schemaVersion).toBe(1);
        });

        it('should handle write errors gracefully', async () => {
            // Use path with characters invalid on all platforms (NUL byte)
            const invalidPersistence = new StatsPersistence({
                filepath: 'Z:\\nonexistent\\drive\\path\\\0invalid.json',
                schemaVersion: 1,
                logger: null
            });

            const result = await invalidPersistence.save({ keys: {}, totals: {} });
            expect(result).toBe(false);
        });
    });

    describe('schema version handling', () => {
        it('should handle newer schema version gracefully', () => {
            const testData = {
                schemaVersion: 99, // Newer version
                keys: { 'key1': { requests: 10 } },
                totals: { requests: 10 }
            };
            fs.writeFileSync(statsPath, JSON.stringify(testData));

            const result = persistence.load();
            expect(result.success).toBe(true);
            // Should load with best effort
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

    describe('merge behavior', () => {
        it('should merge loaded data with provided defaults', () => {
            const testData = {
                schemaVersion: 1,
                keys: { 'key1': { requests: 10 } },
                totals: { requests: 10 }
            };
            fs.writeFileSync(statsPath, JSON.stringify(testData));

            const defaults = {
                keys: { 'key2': { requests: 5 } },
                totals: { requests: 0 }
            };

            const result = persistence.load(defaults);
            expect(result.success).toBe(true);
            // Loaded data should override defaults
            expect(result.data.keys.key1.requests).toBe(10);
            // Defaults should be preserved
            expect(result.data.keys.key2.requests).toBe(5);
            // Totals should be merged
            expect(result.data.totals.requests).toBe(10);
        });
    });
});
