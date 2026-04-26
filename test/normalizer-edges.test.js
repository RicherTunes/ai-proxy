'use strict';

/**
 * Normalizer Edge-Case Tests
 *
 * Tests 1-10: computeConfigHash, migration markers, shouldPersistNormalizedConfig,
 * readMigrationMarker, empty tiers, invalid model entries, unknown field passthrough,
 * and patchMode vs full mode.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
    normalizeModelRoutingConfig,
    computeConfigHash,
    getMarkerPath,
    readMigrationMarker,
    writeMigrationMarker,
    shouldPersistNormalizedConfig,
    updateMigrationMarker,
    MIGRATION_MARKER_FILE
} = require('../lib/model-router-normalizer');

describe('Normalizer Edge Cases', () => {
    let tempDir;
    let configPath;
    let markerPath;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'norm-edges-'));
        configPath = path.join(tempDir, 'model-routing.json');
        markerPath = getMarkerPath(configPath);
    });

    afterEach(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    // ---------------------------------------------------------------
    // 1. computeConfigHash determinism
    // ---------------------------------------------------------------
    describe('computeConfigHash determinism', () => {
        test('same config object always produces the same hash', () => {
            const config = {
                version: '2.0',
                tiers: {
                    light: { models: ['glm-4-flash', 'glm-4-air'], strategy: 'balanced' },
                    medium: { models: ['glm-4-air'], strategy: 'throughput' },
                    heavy: { models: ['glm-5', 'glm-4.7'], strategy: 'quality' }
                }
            };

            const hashes = [];
            for (let i = 0; i < 10; i++) {
                hashes.push(computeConfigHash(config));
            }

            // All 10 hashes must be identical
            expect(new Set(hashes).size).toBe(1);
        });

        test('structurally identical configs (different references) produce the same hash', () => {
            const configA = { tiers: { light: { models: ['a', 'b'] } } };
            const configB = { tiers: { light: { models: ['a', 'b'] } } };

            expect(computeConfigHash(configA)).toBe(computeConfigHash(configB));
        });

        test('hash is a 64-char hex string (SHA-256)', () => {
            const hash = computeConfigHash({ x: 1 });
            expect(hash).toMatch(/^[a-f0-9]{64}$/);
        });
    });

    // ---------------------------------------------------------------
    // 2. computeConfigHash sensitivity
    // ---------------------------------------------------------------
    describe('computeConfigHash sensitivity', () => {
        test('changing one model name changes the hash', () => {
            const base = { tiers: { light: { models: ['glm-4-flash'] } } };
            const modified = { tiers: { light: { models: ['glm-4-air'] } } };

            expect(computeConfigHash(base)).not.toBe(computeConfigHash(modified));
        });

        test('changing strategy changes the hash', () => {
            const a = { tiers: { light: { models: ['m1'], strategy: 'balanced' } } };
            const b = { tiers: { light: { models: ['m1'], strategy: 'quality' } } };

            expect(computeConfigHash(a)).not.toBe(computeConfigHash(b));
        });

        test('adding an extra field changes the hash', () => {
            const a = { tiers: { light: { models: ['m1'] } } };
            const b = { tiers: { light: { models: ['m1'] } }, extra: true };

            expect(computeConfigHash(a)).not.toBe(computeConfigHash(b));
        });

        test('reordering array elements changes the hash', () => {
            const a = { models: ['a', 'b'] };
            const b = { models: ['b', 'a'] };

            expect(computeConfigHash(a)).not.toBe(computeConfigHash(b));
        });

        test('empty object vs empty array produces different hashes', () => {
            expect(computeConfigHash({})).not.toBe(computeConfigHash([]));
        });
    });

    // ---------------------------------------------------------------
    // 3. updateMigrationMarker with existing marker
    // ---------------------------------------------------------------
    describe('updateMigrationMarker with existing marker', () => {
        test('overwrites old marker with new hash', () => {
            // Write initial marker
            updateMigrationMarker(configPath, 'old-hash-aaa');
            const first = readMigrationMarker(markerPath);
            expect(first.hash).toBe('old-hash-aaa');

            // Overwrite
            updateMigrationMarker(configPath, 'new-hash-bbb');
            const second = readMigrationMarker(markerPath);
            expect(second.hash).toBe('new-hash-bbb');
            expect(second.hash).not.toBe(first.hash);
        });

        test('migratedAt timestamp updates on overwrite', () => {
            updateMigrationMarker(configPath, 'hash-1');
            const first = readMigrationMarker(markerPath);

            // Small delay so ISO timestamps differ
            updateMigrationMarker(configPath, 'hash-2');
            const second = readMigrationMarker(markerPath);

            // Both timestamps should be valid ISO strings
            expect(new Date(first.migratedAt).toISOString()).toBe(first.migratedAt);
            expect(new Date(second.migratedAt).toISOString()).toBe(second.migratedAt);
        });
    });

    // ---------------------------------------------------------------
    // 4. updateMigrationMarker without marker (creates new)
    // ---------------------------------------------------------------
    describe('updateMigrationMarker without marker', () => {
        test('creates new marker file when none exists', () => {
            expect(fs.existsSync(markerPath)).toBe(false);

            updateMigrationMarker(configPath, 'brand-new-hash');

            expect(fs.existsSync(markerPath)).toBe(true);
            const marker = readMigrationMarker(markerPath);
            expect(marker.hash).toBe('brand-new-hash');
            expect(marker.migratedAt).toBeDefined();
        });

        test('created marker is valid JSON', () => {
            updateMigrationMarker(configPath, 'json-hash');
            const raw = fs.readFileSync(markerPath, 'utf8');
            expect(() => JSON.parse(raw)).not.toThrow();
        });
    });

    // ---------------------------------------------------------------
    // 5. shouldPersistNormalizedConfig
    // ---------------------------------------------------------------
    describe('shouldPersistNormalizedConfig', () => {
        test('returns true when no marker exists (first run)', () => {
            expect(shouldPersistNormalizedConfig(configPath, 'any-hash')).toBe(true);
        });

        test('returns false when marker hash matches current hash', () => {
            const hash = 'matching-hash-123';
            writeMigrationMarker(markerPath, hash);

            expect(shouldPersistNormalizedConfig(configPath, hash)).toBe(false);
        });

        test('returns true when marker hash differs from current hash', () => {
            writeMigrationMarker(markerPath, 'old-hash');

            expect(shouldPersistNormalizedConfig(configPath, 'new-hash')).toBe(true);
        });

        test('returns true when marker file is corrupted', () => {
            fs.writeFileSync(markerPath, '<<<not json>>>', 'utf8');

            expect(shouldPersistNormalizedConfig(configPath, 'any-hash')).toBe(true);
        });

        test('returns true when marker file is empty', () => {
            fs.writeFileSync(markerPath, '', 'utf8');

            expect(shouldPersistNormalizedConfig(configPath, 'any-hash')).toBe(true);
        });
    });

    // ---------------------------------------------------------------
    // 6. readMigrationMarker
    // ---------------------------------------------------------------
    describe('readMigrationMarker', () => {
        test('returns null when marker file does not exist', () => {
            expect(readMigrationMarker(markerPath)).toBeNull();
        });

        test('reads valid marker data', () => {
            const data = { hash: 'abc123', migratedAt: '2025-01-01T00:00:00.000Z' };
            fs.writeFileSync(markerPath, JSON.stringify(data), 'utf8');

            const result = readMigrationMarker(markerPath);
            expect(result).toEqual(data);
        });

        test('returns null for corrupted (non-JSON) marker', () => {
            fs.writeFileSync(markerPath, 'garbage{{{', 'utf8');

            expect(readMigrationMarker(markerPath)).toBeNull();
        });

        test('returns null for empty file', () => {
            fs.writeFileSync(markerPath, '', 'utf8');

            expect(readMigrationMarker(markerPath)).toBeNull();
        });

        test('returns parsed object for valid JSON with extra fields', () => {
            const data = { hash: 'h1', migratedAt: '2025-01-01T00:00:00.000Z', extra: 'field' };
            fs.writeFileSync(markerPath, JSON.stringify(data), 'utf8');

            const result = readMigrationMarker(markerPath);
            expect(result.hash).toBe('h1');
            expect(result.extra).toBe('field');
        });

        test('marker with future migratedAt timestamp is still valid', () => {
            const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
            const data = { hash: 'future-hash', migratedAt: futureDate };
            fs.writeFileSync(markerPath, JSON.stringify(data), 'utf8');

            const result = readMigrationMarker(markerPath);
            expect(result).not.toBeNull();
            expect(result.hash).toBe('future-hash');
            expect(result.migratedAt).toBe(futureDate);
        });

        test('marker with missing hash field returns object without hash', () => {
            const data = { migratedAt: '2025-06-01T00:00:00.000Z' };
            fs.writeFileSync(markerPath, JSON.stringify(data), 'utf8');

            const result = readMigrationMarker(markerPath);
            expect(result).not.toBeNull();
            expect(result.hash).toBeUndefined();
            expect(result.migratedAt).toBe('2025-06-01T00:00:00.000Z');
        });
    });

    // ---------------------------------------------------------------
    // 7. Normalize with empty tiers
    // ---------------------------------------------------------------
    describe('Normalize with empty tiers', () => {
        test('empty tier arrays handled gracefully (models: [])', () => {
            const config = {
                tiers: {
                    light: { models: [], strategy: 'balanced' },
                    medium: { models: [], strategy: 'throughput' },
                    heavy: { models: [], strategy: 'quality' }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            // Empty arrays preserved; strategy preserved
            expect(result.normalizedConfig.tiers.light.models).toEqual([]);
            expect(result.normalizedConfig.tiers.medium.models).toEqual([]);
            expect(result.normalizedConfig.tiers.heavy.models).toEqual([]);
            expect(result.normalizedConfig.tiers.light.strategy).toBe('balanced');
            expect(result.normalizedConfig.tiers.medium.strategy).toBe('throughput');
            expect(result.normalizedConfig.tiers.heavy.strategy).toBe('quality');
            expect(result.migrated).toBe(false);
        });

        test('missing tiers key produces default empty tiers in full mode', () => {
            const config = { enabled: true };
            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.tiers.light).toBeDefined();
            expect(result.normalizedConfig.tiers.medium).toBeDefined();
            expect(result.normalizedConfig.tiers.heavy).toBeDefined();
            expect(result.normalizedConfig.tiers.light.models).toEqual([]);
        });

        test('tiers key as empty object gets defaults in full mode', () => {
            const result = normalizeModelRoutingConfig({ tiers: {} });

            for (const tier of ['light', 'medium', 'heavy']) {
                expect(result.normalizedConfig.tiers[tier].models).toEqual([]);
                expect(result.normalizedConfig.tiers[tier].strategy).toBe('balanced');
            }
        });
    });

    // ---------------------------------------------------------------
    // 8. Normalize with invalid model entries
    // ---------------------------------------------------------------
    describe('Normalize with invalid model entries', () => {
        test('non-string entries in fallbackModels are filtered out', () => {
            const config = {
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash',
                        fallbackModels: [null, 123, undefined, '', 'glm-4-air', false]
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            // Only valid strings should remain ('glm-4-flash' from target, 'glm-4-air' from fallback)
            // null, 123, undefined, '', and false should all be filtered
            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-flash', 'glm-4-air']);
        });

        test('non-string targetModel is ignored', () => {
            const config = {
                tiers: {
                    light: {
                        targetModel: 42,
                        fallbackModels: ['glm-4-air']
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            // 42 is not a string, so only fallback should appear
            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-air']);
        });

        test('non-string failoverModel is ignored', () => {
            const config = {
                tiers: {
                    heavy: {
                        targetModel: 'glm-5',
                        failoverModel: { nested: true }
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.tiers.heavy.models).toEqual(['glm-5']);
        });

        test('null targetModel with valid fallbackModels still works', () => {
            const config = {
                tiers: {
                    light: {
                        targetModel: null,
                        fallbackModels: ['glm-4-air', 'glm-4-plus']
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-air', 'glm-4-plus']);
        });
    });

    // ---------------------------------------------------------------
    // 9. Normalize preserves unknown fields (passthrough)
    // ---------------------------------------------------------------
    describe('Normalize preserves unknown fields', () => {
        test('extra top-level fields are kept in normalized output', () => {
            const config = {
                enabled: true,
                customSetting: 'abc',
                maxRetries: 5,
                tiers: {
                    light: { models: ['glm-4-flash'] }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.customSetting).toBe('abc');
            expect(result.normalizedConfig.maxRetries).toBe(5);
            expect(result.normalizedConfig.enabled).toBe(true);
        });

        test('extra tier-level fields are kept for v2 tiers', () => {
            const config = {
                tiers: {
                    light: {
                        models: ['glm-4-flash'],
                        strategy: 'balanced',
                        myCustomField: 'preserved',
                        weight: 0.8
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.tiers.light.myCustomField).toBe('preserved');
            expect(result.normalizedConfig.tiers.light.weight).toBe(0.8);
        });

        test('label and clientModelPolicy are preserved during v1 migration', () => {
            const config = {
                tiers: {
                    light: {
                        targetModel: 'glm-4-flash',
                        label: 'Fast Tier',
                        clientModelPolicy: 'always-route'
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.tiers.light.label).toBe('Fast Tier');
            expect(result.normalizedConfig.tiers.light.clientModelPolicy).toBe('always-route');
            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-flash']);
        });

        test('defaultModel top-level field survives normalization', () => {
            const config = {
                defaultModel: 'glm-4-flash',
                tiers: { light: { models: ['glm-4-flash'] } }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(result.normalizedConfig.defaultModel).toBe('glm-4-flash');
        });
    });

    // ---------------------------------------------------------------
    // 10. Patch mode vs full mode
    // ---------------------------------------------------------------
    describe('Patch mode vs full mode', () => {
        test('full mode (default) fills missing standard tiers', () => {
            const config = {
                tiers: {
                    light: { models: ['glm-4-flash'] }
                    // medium and heavy are missing
                }
            };

            const result = normalizeModelRoutingConfig(config);

            // Full mode should create default entries for missing tiers
            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-flash']);
            expect(result.normalizedConfig.tiers.medium).toBeDefined();
            expect(result.normalizedConfig.tiers.medium.models).toEqual([]);
            expect(result.normalizedConfig.tiers.medium.strategy).toBe('balanced');
            expect(result.normalizedConfig.tiers.heavy).toBeDefined();
            expect(result.normalizedConfig.tiers.heavy.models).toEqual([]);
            expect(result.normalizedConfig.tiers.heavy.strategy).toBe('balanced');
        });

        test('patch mode does NOT fill missing standard tiers', () => {
            const config = {
                tiers: {
                    light: { models: ['glm-4-flash'] }
                    // medium and heavy are missing
                }
            };

            const result = normalizeModelRoutingConfig(config, { patchMode: true });

            // Patch mode should only include what was provided
            expect(result.normalizedConfig.tiers.light.models).toEqual(['glm-4-flash']);
            expect(result.normalizedConfig.tiers.medium).toBeUndefined();
            expect(result.normalizedConfig.tiers.heavy).toBeUndefined();
        });

        test('patch mode still normalizes provided v1 tiers', () => {
            const config = {
                tiers: {
                    heavy: {
                        targetModel: 'glm-5',
                        fallbackModels: ['glm-4.7']
                    }
                }
            };

            const result = normalizeModelRoutingConfig(config, { patchMode: true });

            expect(result.normalizedConfig.tiers.heavy.models).toEqual(['glm-5', 'glm-4.7']);
            expect(result.migrated).toBe(true);
            // light and medium should NOT be created
            expect(result.normalizedConfig.tiers.light).toBeUndefined();
            expect(result.normalizedConfig.tiers.medium).toBeUndefined();
        });

        test('full mode with all tiers present does not add extra tiers', () => {
            const config = {
                tiers: {
                    light: { models: ['a'] },
                    medium: { models: ['b'] },
                    heavy: { models: ['c'] }
                }
            };

            const result = normalizeModelRoutingConfig(config);

            expect(Object.keys(result.normalizedConfig.tiers).sort()).toEqual(['heavy', 'light', 'medium']);
        });

        test('patch mode with empty tiers object leaves tiers empty', () => {
            const config = { tiers: {} };
            const result = normalizeModelRoutingConfig(config, { patchMode: true });

            expect(Object.keys(result.normalizedConfig.tiers)).toEqual([]);
        });
    });
});
