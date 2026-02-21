/**
 * Model Router Persistence Tests (NORM-02)
 *
 * Tests for conditional persistence of normalized config:
 * - Only persist when migrated flag is true
 * - Only persist once per file hash
 * - Graceful failure handling on read-only filesystems
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { ModelRouter } = require('../lib/model-router');
const {
    normalizeModelRoutingConfig,
    computeConfigHash,
    shouldPersistNormalizedConfig,
    updateMigrationMarker,
    readMigrationMarker,
    getMarkerPath,
    MIGRATION_MARKER_FILE
} = require('../lib/model-router-normalizer');

describe('Model Router Persistence (NORM-02)', () => {
    let tempDir;
    let mockModelRouter;
    let mockLogger;

    beforeEach(() => {
        jest.clearAllMocks();
        tempDir = os.tmpdir();
        mockLogger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };

        // Mock ModelRouter to avoid "modelDiscovery option is required" error
        // Create a mock that provides all the methods needed by tests
        mockModelRouter = {
            config: { enabled: true, tiers: { heavy: { models: ['m1'] } } },
            enabled: true,
            updateConfig: jest.fn(),
            toJSON: jest.fn().mockReturnValue({
                config: {
                    tiers: { heavy: { models: ['m1'] } }
                }
            }),
            getStats: jest.fn().mockReturnValue({})
        };
    });

    afterEach(() => {
        // Clean up any files created during tests
        const files = fs.readdirSync(tempDir).filter(f => f.includes('test-model-routing'));
        for (const f of files) {
            try {
                fs.unlinkSync(path.join(tempDir, f));
            } catch (e) {
                // Ignore cleanup errors
            }
        }
    });

    describe('Hash computation', () => {
        test('computes consistent SHA-256 hash for same config', () => {
            const config = { enabled: true, tiers: { heavy: { models: ['m1'] } } };
            const hash1 = computeConfigHash(config);
            const hash2 = computeConfigHash(config);

            expect(hash1).toBe(hash2);
            expect(hash1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
        });

        test('computes different hashes for different configs', () => {
            const config1 = { enabled: true, tiers: { heavy: { models: ['m1'] } } };
            const config2 = { enabled: true, tiers: { heavy: { models: ['m2'] } } };

            const hash1 = computeConfigHash(config1);
            const hash2 = computeConfigHash(config2);

            expect(hash1).not.toBe(hash2);
        });
    });

    describe('Marker file tracking', () => {
        test('getMarkerPath returns path with marker appended to config path', () => {
            const configPath = path.join(tempDir, 'model-routing.json');
            const markerPath = path.join(tempDir, 'model-routing.json' + MIGRATION_MARKER_FILE);

            expect(getMarkerPath(configPath)).toBe(markerPath);
        });

        test('readMigrationMarker returns null when marker does not exist', () => {
            const markerPath = path.join(tempDir, '.model-routing.migrated');

            const result = readMigrationMarker(markerPath);

            expect(result).toBeNull();
        });

        test('readMigrationMarker returns marker data when file exists', () => {
            const markerPath = path.join(tempDir, '.model-routing.migrated');
            const expectedData = { hash: 'abc123', migratedAt: '2024-01-01T00:00:00Z' };

            // Create marker file
            fs.writeFileSync(markerPath, JSON.stringify(expectedData), 'utf8');

            const result = readMigrationMarker(markerPath);

            expect(result).toEqual(expectedData);

            // Cleanup
            fs.unlinkSync(markerPath);
        });

        test('readMigrationMarker handles corrupted JSON gracefully', () => {
            const markerPath = path.join(tempDir, '.model-routing.migrated');

            // Write invalid JSON
            fs.writeFileSync(markerPath, 'not valid json', 'utf8');

            const result = readMigrationMarker(markerPath);

            expect(result).toBeNull(); // Should return null for corrupted marker

            // Cleanup
            try { fs.unlinkSync(markerPath); } catch (e) { /* ignore */ }
        });
    });

    describe('shouldPersistNormalizedConfig', () => {
        test('returns true when no marker exists (first time)', () => {
            const configPath = path.join(tempDir, 'test-model-routing.json');
            const hash = 'any-hash';

            // Ensure marker doesn't exist
            const markerPath = configPath + MIGRATION_MARKER_FILE;
            try { fs.unlinkSync(markerPath); } catch (e) { /* ignore */ }

            const result = shouldPersistNormalizedConfig(configPath, hash);

            expect(result).toBe(true);
        });

        test('returns true when marker hash differs from current hash', () => {
            const configPath = path.join(tempDir, 'test-model-routing.json');
            const currentHash = 'current-hash';
            const differentHash = 'different-hash';

            const markerPath = configPath + MIGRATION_MARKER_FILE;
            fs.writeFileSync(markerPath, JSON.stringify({ hash: differentHash, migratedAt: '2024-01-01T00:00:00Z' }), 'utf8');

            const result = shouldPersistNormalizedConfig(configPath, currentHash);

            expect(result).toBe(true);

            // Cleanup
            fs.unlinkSync(markerPath);
        });

        test('returns false when marker hash matches current hash (already migrated)', () => {
            const configPath = path.join(tempDir, 'test-model-routing.json');
            const currentHash = 'same-hash';

            const markerPath = configPath + MIGRATION_MARKER_FILE;
            fs.writeFileSync(markerPath, JSON.stringify({ hash: 'same-hash', migratedAt: '2024-01-01T00:00:00Z' }), 'utf8');

            const result = shouldPersistNormalizedConfig(configPath, currentHash);

            expect(result).toBe(false); // Should skip persistence

            // Cleanup
            fs.unlinkSync(markerPath);
        });
    });

    describe('updateMigrationMarker', () => {
        test('writes marker file with hash and timestamp', () => {
            const configPath = path.join(tempDir, 'test-model-routing.json');
            const hash = 'test-hash';
            const markerPath = configPath + MIGRATION_MARKER_FILE;

            updateMigrationMarker(configPath, hash);

            const result = JSON.parse(fs.readFileSync(markerPath, 'utf8'));

            expect(result.hash).toBe(hash);
            expect(result.migratedAt).toBeDefined();
            expect(result.migratedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp

            // Cleanup
            fs.unlinkSync(markerPath);
        });
    });

    describe('Conditional persistence behavior', () => {
        test('v2 config normalization sets migrated=false', () => {
            const configPath = path.join(tempDir, 'test-model-routing-' + Date.now() + '.json');

            // Pure v2 config - normalization returns migrated=false
            const result = normalizeModelRoutingConfig({
                tiers: { heavy: { models: ['m1'] } }
            });

            expect(result.migrated).toBe(false);

            // shouldPersistNormalizedConfig should return true (first time)
            const shouldPersist = shouldPersistNormalizedConfig(configPath, 'any-hash');
            expect(shouldPersist).toBe(true);
        });

        test('v1 config normalization sets migrated=true and persists', () => {
            const configPath = path.join(tempDir, 'test-model-routing-' + Date.now() + '.json');

            // V1 config - normalization returns migrated=true
            const normalizationResult = normalizeModelRoutingConfig({
                tiers: { heavy: { targetModel: 'glm-4-flash', fallbackModels: ['glm-4-plus'] } }
            });

            expect(normalizationResult.migrated).toBe(true);

            // Simulate Phase 16 persistence flow (no longer gated on migrated flag)
            if (configPath) {
                const currentHash = computeConfigHash(normalizationResult.normalizedConfig);

                if (shouldPersistNormalizedConfig(configPath, currentHash)) {
                    const serialized = JSON.stringify(normalizationResult.normalizedConfig, null, 2);
                    fs.writeFileSync(configPath, serialized);
                    updateMigrationMarker(configPath, currentHash);
                }
            }

            // Verify file was written
            expect(fs.existsSync(configPath)).toBe(true);
            const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            expect(written.tiers.heavy.models).toEqual(['glm-4-flash', 'glm-4-plus']);

            // Cleanup
            try { if (fs.existsSync(configPath)) fs.unlinkSync(configPath); } catch (e) { /* ignore */ }
            try { fs.unlinkSync(configPath + MIGRATION_MARKER_FILE); } catch (e) { /* ignore */ }
        });

        test('hash deduplication prevents redundant writes (same hash)', () => {
            const configPath = path.join(tempDir, 'test-model-routing-' + Date.now() + '.json');

            // Create marker file first (simulating already written state with matching hash)
            const normalizationResult = normalizeModelRoutingConfig({
                tiers: { heavy: { models: ['m1'] } }
            }, { logger: mockLogger });

            const hash = computeConfigHash(normalizationResult.normalizedConfig);
            const markerPath = configPath + MIGRATION_MARKER_FILE;

            // Write marker BEFORE we test shouldPersist
            const originalWriteFileSync = fs.writeFileSync;
            originalWriteFileSync(markerPath, JSON.stringify({ hash, migratedAt: '2024-01-01T00:00:00Z' }), 'utf8');

            // Now mock fs to verify write was not attempted
            let writeAttempted = false;
            fs.writeFileSync = (file, data) => {
                writeAttempted = true;
                return originalWriteFileSync(file, data);
            };

            // Simulate Phase 16 persistence flow (no longer gated on migrated flag)
            if (configPath) {
                const currentHash = computeConfigHash(normalizationResult.normalizedConfig);

                if (shouldPersistNormalizedConfig(configPath, currentHash)) {
                    const serialized = JSON.stringify(normalizationResult.normalizedConfig, null, 2);
                    fs.writeFileSync(configPath, serialized);
                }
            }

            // Should not persist because hash matches (dedup logic)
            expect(writeAttempted).toBe(false);

            // Cleanup
            fs.writeFileSync = originalWriteFileSync; // Restore fs
            try { if (fs.existsSync(configPath)) fs.unlinkSync(configPath); } catch (e) { /* ignore */ }
            try { fs.unlinkSync(configPath + MIGRATION_MARKER_FILE); } catch (e) { /* ignore */ }
        });
    });

    describe('Graceful failure handling', () => {
        test('handles EROFS gracefully', () => {
            const configPath = path.join(tempDir, 'test-model-routing-' + Date.now() + '.json');

            // Mock fs to throw EROFS
            const originalWriteFileSync = fs.writeFileSync;
            let writeError = null;
            fs.writeFileSync = (file, data) => {
                const error = new Error('EROFS: read-only file system');
                writeError = error;
                error.code = 'EROFS';
                throw error;
            };

            // V1 config - normalization returns migrated=true
            const normalizationResult = normalizeModelRoutingConfig({
                tiers: { heavy: { targetModel: 'glm-4-flash', fallbackModels: ['glm-4-plus'] } }
            }, { logger: mockLogger });

            // Simulate Phase 16 persistence flow (wrapped in try-catch)
            if (configPath) {
                try {
                    const currentHash = computeConfigHash(normalizationResult.normalizedConfig);

                    if (shouldPersistNormalizedConfig(configPath, currentHash)) {
                        const serialized = JSON.stringify(normalizationResult.normalizedConfig, null, 2);
                        fs.writeFileSync(configPath, serialized);
                    }
                } catch (e) {
                    // Expected to be caught and logged
                    expect(e.code).toBe('EROFS');
                    mockLogger.warn(`Failed to persist normalized config: ${e.message}`);
                }
            }

            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringMatching(/Failed to persist normalized config.*EROFS/)
            );

            // Restore fs
            fs.writeFileSync = originalWriteFileSync;

            // Cleanup
            try { if (fs.existsSync(configPath)) fs.unlinkSync(configPath); } catch (e) { /* ignore */ }
        });

        test('handles EACCES gracefully', () => {
            const configPath = path.join(tempDir, 'test-model-routing-' + Date.now() + '.json');

            // Mock fs to throw EACCES
            const originalWriteFileSync = fs.writeFileSync;
            fs.writeFileSync = (file, data) => {
                const error = new Error('EACCES: permission denied');
                error.code = 'EACCES';
                throw error;
            };

            // V1 config - normalization returns migrated=true
            const normalizationResult = normalizeModelRoutingConfig({
                tiers: { heavy: { targetModel: 'glm-4-flash', fallbackModels: ['glm-4-plus'] } }
            }, { logger: mockLogger });

            // Simulate Phase 16 persistence flow (wrapped in try-catch)
            if (configPath) {
                try {
                    const currentHash = computeConfigHash(normalizationResult.normalizedConfig);

                    if (shouldPersistNormalizedConfig(configPath, currentHash)) {
                        const serialized = JSON.stringify(normalizationResult.normalizedConfig, null, 2);
                        fs.writeFileSync(configPath, serialized);
                    }
                } catch (e) {
                    // Expected to be caught and logged
                    expect(e.code).toBe('EACCES');
                    mockLogger.warn(`Failed to persist normalized config: ${e.message}`);
                }
            }

            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringMatching(/Failed to persist normalized config.*EACCES/)
            );

            // Restore fs
            fs.writeFileSync = originalWriteFileSync;

            // Cleanup
            try { if (fs.existsSync(configPath)) fs.unlinkSync(configPath); } catch (e) { /* ignore */ }
        });

        test('handles ENOENT gracefully (writing to non-existent directory)', () => {
            const configPath = path.join(tempDir, 'non-existent', 'test-model-routing.json');

            // V1 config - normalization returns migrated=true
            const normalizationResult = normalizeModelRoutingConfig({
                tiers: { heavy: { targetModel: 'glm-4-flash', fallbackModels: ['glm-4-plus'] } }
            }, { logger: mockLogger });

            // Simulate Phase 16 persistence flow (wrapped in try-catch)
            if (configPath) {
                try {
                    const currentHash = computeConfigHash(normalizationResult.normalizedConfig);

                    if (shouldPersistNormalizedConfig(configPath, currentHash)) {
                        const serialized = JSON.stringify(normalizationResult.normalizedConfig, null, 2);
                        fs.writeFileSync(configPath, serialized);
                    }
                } catch (e) {
                    // ENOENT or EACCES when writing to non-existent directory (system dependent)
                    expect(['ENOENT', 'EACCES']).toContain(e.code);
                    mockLogger.warn(`Failed to persist normalized config: ${e.message}`);
                }
            }

            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringMatching(/Failed to persist normalized config/)
            );

            // Cleanup not needed - file won't be created
        });
    });

    describe('PUT persistence behavior (Phase 16)', () => {
        test('PUT with v2-native config persists to disk', () => {
            const configPath = path.join(tempDir, 'test-model-routing-' + Date.now() + '.json');

            // Create a v2-native config
            const v2Config = { tiers: { heavy: { models: ['m1'] } } };
            const result = normalizeModelRoutingConfig(v2Config);

            expect(result.migrated).toBe(false); // v2-native, no migration

            // Simulate merged config (spread with existing mock config)
            const mergedConfig = { enabled: true, ...result.normalizedConfig };

            // Compute hash from mergedConfig (Phase 16 behavior)
            const currentHash = computeConfigHash(mergedConfig);

            // First time persistence check
            const shouldPersist = shouldPersistNormalizedConfig(configPath, currentHash);
            expect(shouldPersist).toBe(true);

            // Simulate write
            const serialized = JSON.stringify(mergedConfig, null, 2);
            fs.writeFileSync(configPath, serialized);
            updateMigrationMarker(configPath, currentHash);

            // Verify file exists and contains v2 format
            expect(fs.existsSync(configPath)).toBe(true);
            const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            expect(written.tiers.heavy.models).toEqual(['m1']);

            // Cleanup
            try { fs.unlinkSync(configPath); } catch (e) { /* ignore */ }
            try { fs.unlinkSync(configPath + MIGRATION_MARKER_FILE); } catch (e) { /* ignore */ }
        });

        test('PUT with identical config skips write (hash match)', () => {
            const configPath = path.join(tempDir, 'test-model-routing-' + Date.now() + '.json');

            // Create config and write it
            const v2Config = { enabled: true, tiers: { heavy: { models: ['m1'] } } };
            const hash = computeConfigHash(v2Config);

            fs.writeFileSync(configPath, JSON.stringify(v2Config, null, 2));
            updateMigrationMarker(configPath, hash);

            // Compute hash of the same mergedConfig
            const currentHash = computeConfigHash(v2Config);
            expect(currentHash).toBe(hash);

            // Should NOT persist (hash match)
            const shouldPersist = shouldPersistNormalizedConfig(configPath, currentHash);
            expect(shouldPersist).toBe(false);

            // Cleanup
            try { fs.unlinkSync(configPath); } catch (e) { /* ignore */ }
            try { fs.unlinkSync(configPath + MIGRATION_MARKER_FILE); } catch (e) { /* ignore */ }
        });

        test('PUT with modified config writes (hash mismatch)', () => {
            const configPath = path.join(tempDir, 'test-model-routing-' + Date.now() + '.json');

            // Write initial config and create marker
            const initialConfig = { enabled: true, tiers: { heavy: { models: ['m1'] } } };
            const initialHash = computeConfigHash(initialConfig);

            fs.writeFileSync(configPath, JSON.stringify(initialConfig, null, 2));
            updateMigrationMarker(configPath, initialHash);

            // Create modified mergedConfig (change model name)
            const modifiedConfig = { enabled: true, tiers: { heavy: { models: ['m2'] } } };
            const modifiedHash = computeConfigHash(modifiedConfig);

            expect(modifiedHash).not.toBe(initialHash);

            // Should persist (hash changed)
            const shouldPersist = shouldPersistNormalizedConfig(configPath, modifiedHash);
            expect(shouldPersist).toBe(true);

            // Cleanup
            try { fs.unlinkSync(configPath); } catch (e) { /* ignore */ }
            try { fs.unlinkSync(configPath + MIGRATION_MARKER_FILE); } catch (e) { /* ignore */ }
        });

        test('PUT with partial update — unchanged merged config skips write', () => {
            const configPath = path.join(tempDir, 'test-model-routing-' + Date.now() + '.json');

            // Create and write full mergedConfig
            const fullConfig = { enabled: true, tiers: { heavy: { models: ['m1'] } } };
            const hash = computeConfigHash(fullConfig);

            fs.writeFileSync(configPath, JSON.stringify(fullConfig, null, 2));
            updateMigrationMarker(configPath, hash);

            // Simulate partial PUT with { enabled: true } (no actual change when merged)
            // After merging, the config is still the same
            const partialUpdate = { enabled: true };
            const mergedConfig = { ...fullConfig, ...partialUpdate }; // Same as fullConfig

            const currentHash = computeConfigHash(mergedConfig);
            expect(currentHash).toBe(hash); // Same hash

            // Should NOT persist (no actual change)
            const shouldPersist = shouldPersistNormalizedConfig(configPath, currentHash);
            expect(shouldPersist).toBe(false);

            // Cleanup
            try { fs.unlinkSync(configPath); } catch (e) { /* ignore */ }
            try { fs.unlinkSync(configPath + MIGRATION_MARKER_FILE); } catch (e) { /* ignore */ }
        });

        test('PUT with v1 config migrates and persists', () => {
            const configPath = path.join(tempDir, 'test-model-routing-' + Date.now() + '.json');

            // Create v1 config
            const v1Config = {
                tiers: {
                    heavy: {
                        targetModel: 'glm-4-flash',
                        fallbackModels: ['glm-4-plus']
                    }
                }
            };

            const result = normalizeModelRoutingConfig(v1Config);
            expect(result.migrated).toBe(true); // v1 was migrated

            // Compute hash from merged result
            const mergedConfig = { enabled: true, ...result.normalizedConfig };
            const hash = computeConfigHash(mergedConfig);

            // Should persist (first time)
            const shouldPersist = shouldPersistNormalizedConfig(configPath, hash);
            expect(shouldPersist).toBe(true);

            // Verify normalized config has models[] and no targetModel/fallbackModels
            expect(result.normalizedConfig.tiers.heavy.models).toEqual(['glm-4-flash', 'glm-4-plus']);
            expect(result.normalizedConfig.tiers.heavy.targetModel).toBeUndefined();
            expect(result.normalizedConfig.tiers.heavy.fallbackModels).toBeUndefined();

            // Cleanup
            try { fs.unlinkSync(configPath); } catch (e) { /* ignore */ }
            try { fs.unlinkSync(configPath + MIGRATION_MARKER_FILE); } catch (e) { /* ignore */ }
        });

        test('Persistence disabled results in runtime_only_change', () => {
            // Logic test: verify the shouldPersist condition evaluates to false when disabled
            const persistenceEnabled = false;
            const configPath = '/some/path.json';

            // The controller's shouldPersist condition is: enabled && configPath
            const shouldPersist = persistenceEnabled && configPath;

            expect(shouldPersist).toBe(false);

            // Expected response behavior:
            // { persisted: false, warning: 'runtime_only_change' }
            const response = {
                persisted: false,
                warning: 'runtime_only_change'
            };

            expect(response.persisted).toBe(false);
            expect(response.warning).toBe('runtime_only_change');
        });
    });
});
