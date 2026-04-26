'use strict';

/**
 * Coverage Test: Model Controller
 *
 * Targets uncovered branches in lib/proxy/controllers/model-controller.js
 * Current uncovered lines: 210, 258-267, 280-290
 *
 * Goal: Raise branch coverage to 98%+ and function coverage to 98%+
 */

const { ModelController } = require('../lib/proxy/controllers/model-controller');
const { ModelRouter } = require('../lib/model-router');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Readable } = require('stream');

describe('model-controller - coverage tests', () => {
    let controller;
    let mockModelRouter;
    let mockModelDiscovery;
    let mockModelMappingManager;
    let mockAdminAuth;
    let mockLogger;
    let mockAddAuditEntry;
    let mockStatsAggregator;
    let tempConfigPath;

    beforeEach(() => {
        mockLogger = {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn()
        };

        mockModelRouter = {
            enabled: true,
            config: {
                enabled: true,
                version: '2.0',
                defaultModel: 'glm-4',
                tiers: {
                    light: { models: ['glm-4-flash'], strategy: 'balanced' },
                    medium: { models: ['glm-4'], strategy: 'balanced' },
                    heavy: { models: ['glm-4-plus'], strategy: 'balanced' }
                },
                rules: []
            },
            toJSON: jest.fn(function() {
                return {
                    enabled: true,
                    version: '2.0',
                    defaultModel: 'glm-4',
                    tiers: {
                        light: { models: ['glm-4-flash'], strategy: 'balanced' },
                        medium: { models: ['glm-4'], strategy: 'balanced' },
                        heavy: { models: ['glm-4-plus'], strategy: 'balanced' }
                    },
                    rules: []
                };
            }),
            updateConfig: jest.fn(),
            reset: jest.fn(),
            getOverrides: jest.fn(() => ({})),
            setOverride: jest.fn(),
            clearOverride: jest.fn(),
            getCooldowns: jest.fn(() => ({})),
            getPoolStatus: jest.fn(() => ({})),
            getModelCooldown: jest.fn(() => 0),
            extractFeatures: jest.fn(() => ({ hasTools: false, messageCount: 1 })),
            classify: jest.fn(() => ({ tier: 'medium', confidence: 0.9 }))
        };

        mockModelDiscovery = {
            getModels: jest.fn(async () => []),
            getModelsByTier: jest.fn(async () => []),
            getCacheStats: jest.fn(() => ({}))
        };

        mockModelMappingManager = {
            enabled: false,
            toConfig: jest.fn(() => ({ mapping: {} })),
            getKeyOverrides: jest.fn(() => ({})),
            getKeyOverride: jest.fn(() => null)
        };

        mockAdminAuth = {
            enabled: false,
            authenticate: jest.fn(() => ({ authenticated: true }))
        };

        mockAddAuditEntry = jest.fn();

        mockStatsAggregator = {
            recordConfigMigrationWriteFailure: jest.fn()
        };

        // Create temp config path
        tempConfigPath = path.join(os.tmpdir(), `model-routing-test-${Date.now()}.json`);

        controller = new ModelController({
            modelRouter: mockModelRouter,
            modelDiscovery: mockModelDiscovery,
            modelMappingManager: mockModelMappingManager,
            adminAuth: mockAdminAuth,
            logger: mockLogger,
            addAuditEntry: mockAddAuditEntry,
            isClusterWorker: false,
            getClientIp: jest.fn(() => '127.0.0.1')
        });

        // Set statsAggregator (not in constructor but referenced in handleModelRouting)
        controller._statsAggregator = mockStatsAggregator;
    });

    afterEach(() => {
        // Clean up temp files
        jest.restoreAllMocks();
        try {
            if (fs.existsSync(tempConfigPath)) fs.unlinkSync(tempConfigPath);
        } catch (_e) { /* ignore */ }
        try {
            if (fs.existsSync(tempConfigPath + '.bak')) fs.unlinkSync(tempConfigPath + '.bak');
        } catch (_e) { /* ignore */ }
        const markerPath = tempConfigPath + '.model-routing.migrated';
        try {
            if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath);
        } catch (_e) { /* ignore */ }
    });

    describe('handleModelRouting PUT - warnings branch (line 210)', () => {
        // Covers line 210: response.warnings = warnings; when warnings.length > 0
        it('should include warnings in response when normalization returns warnings', async () => {
            const { Readable } = require('stream');

            // Config with mixed v1/v2 format to trigger warnings
            const bodyStr = JSON.stringify({
                tiers: {
                    light: {
                        // Mixed format: both v1 (targetModel) and v2 (models) fields
                        targetModel: 'glm-4-flash',
                        models: ['glm-4-flash', 'glm-4-air'],
                        strategy: 'balanced'
                    }
                }
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn(),
                headersSent: false
            };

            // Enable persistence but use a path we control
            controller._routingPersistence = {
                enabled: true,
                configPath: tempConfigPath,
                lastSavedAt: null,
                lastSaveError: null,
                lastLoadError: null
            };

            await controller.handleModelRouting(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.success).toBe(true);
            expect(responseData.warnings).toBeDefined();
            expect(Array.isArray(responseData.warnings)).toBe(true);
            expect(responseData.warnings.length).toBeGreaterThan(0);
            expect(responseData.warnings[0]).toContain('v1 fields');
        });

        // Covers line 210: response.warnings = warnings; for invalid tier config warnings
        it('should include warnings when tier config has invalid structure', async () => {
            const { Readable } = require('stream');

            // Config with invalid tier (null value) to trigger warning
            const bodyStr = JSON.stringify({
                tiers: {
                    invalid_tier: null
                }
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn(),
                headersSent: false
            };

            await controller.handleModelRouting(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.success).toBe(true);
            expect(responseData.warnings).toBeDefined();
            expect(Array.isArray(responseData.warnings)).toBe(true);
        });
    });

    describe('handleModelRouting PUT - paranoia check rollback (lines 258-267)', () => {
        // Covers lines 258-267: rollback path when paranoia check fails
        it('should rollback to backup when paranoia check fails', async () => {
            const { Readable } = require('stream');

            // Create an existing config file to backup
            const originalConfig = JSON.stringify({
                version: '2.0',
                tiers: {
                    light: { models: ['glm-4-flash'], strategy: 'balanced' }
                }
            });
            fs.writeFileSync(tempConfigPath, originalConfig, 'utf8');

            const bodyStr = JSON.stringify({
                tiers: {
                    light: { models: ['glm-4'], strategy: 'balanced' }
                }
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn(),
                headersSent: false
            };

            controller._routingPersistence = {
                enabled: true,
                configPath: tempConfigPath,
                lastSavedAt: null,
                lastSaveError: null,
                lastLoadError: null
            };

            // Mock validateConfig to fail on revalidation (paranoia check)
            jest.spyOn(ModelRouter, 'validateConfig')
                .mockReturnValueOnce({ valid: true })  // Initial validation passes
                .mockReturnValueOnce({ valid: false, error: 'Invalid tier: missing models' });  // Paranoia check fails

            await controller.handleModelRouting(mockReq, mockRes);

            // Verify error response
            expect(mockRes.writeHead).toHaveBeenCalledWith(500, {
                'content-type': 'application/json',
                'cache-control': 'no-store'
            });

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('Config written but failed verification — rolled back to backup');

            // Verify rollback happened - file should be restored to original
            const restoredContent = fs.readFileSync(tempConfigPath, 'utf8');
            expect(restoredContent).toBe(originalConfig);

            // Verify error state was recorded
            expect(controller._routingPersistence.lastSaveError).toContain('Paranoia check failed');
            expect(mockLogger.error).toHaveBeenCalledWith(
                '[ModelRouter] Config persistence paranoia check failed, rolled back'
            );
        });

        // Covers lines 258-263: rollback when backup restore fails (deletes file)
        it('should delete config file when backup restore fails during rollback', async () => {
            const { Readable } = require('stream');
            const { atomicWrite } = require('../lib/atomic-write');

            // Create a config file
            const originalConfig = JSON.stringify({
                version: '2.0',
                tiers: { light: { models: ['glm-4'], strategy: 'balanced' } }
            });
            fs.writeFileSync(tempConfigPath, originalConfig, 'utf8');

            const bodyStr = JSON.stringify({
                tiers: { light: { models: ['glm-4-flash'], strategy: 'balanced' } }
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn(),
                headersSent: false
            };

            controller._routingPersistence = {
                enabled: true,
                configPath: tempConfigPath,
                lastSavedAt: null,
                lastSaveError: null,
                lastLoadError: null
            };

            // Mock validateConfig and atomicWrite
            jest.spyOn(ModelRouter, 'validateConfig')
                .mockReturnValueOnce({ valid: true })
                .mockReturnValueOnce({ valid: false, error: 'Invalid config' });

            // Mock atomicWrite to fail on restore (backup doesn't exist)
            const originalAtomicWrite = atomicWrite;
            let writeCount = 0;
            jest.spyOn(require('../lib/atomic-write'), 'atomicWrite').mockImplementation(async (filePath, data) => {
                writeCount++;
                if (writeCount === 3) {
                    // Third call is the restore attempt - throw to trigger delete path
                    throw new Error('ENOENT: no such file or directory');
                }
                return originalAtomicWrite(filePath, data);
            });

            // Mock fs.readFileSync to fail on backup read (lines 259-260)
            const originalReadFileSync = fs.readFileSync;
            let readCount = 0;
            jest.spyOn(fs, 'readFileSync').mockImplementation((path, opts) => {
                readCount++;
                if (String(path).endsWith('.bak') && readCount > 1) {
                    throw new Error('ENOENT: backup file not found');
                }
                return originalReadFileSync(path, opts);
            });

            await controller.handleModelRouting(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('Config written but failed verification — rolled back to backup');

            jest.restoreAllMocks();
        });
    });

    describe('handleModelRouting PUT - persistence error handling (lines 280-290)', () => {
        // Covers lines 280-290: persistErr catch block
        it('should handle persistence errors gracefully and return response with persistError', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({
                tiers: {
                    light: { models: ['glm-4-flash'], strategy: 'balanced' }
                }
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn(),
                headersSent: false
            };

            controller._routingPersistence = {
                enabled: true,
                configPath: tempConfigPath,
                lastSavedAt: null,
                lastSaveError: null,
                lastLoadError: null
            };

            // Mock fs.readFileSync to throw during persistence (triggers catch block at line 278)
            jest.spyOn(fs, 'readFileSync').mockImplementation((path, opts) => {
                if (String(path).includes(tempConfigPath)) {
                    throw new Error('EACCES: permission denied');
                }
                return fs.readFileSync(path, opts);
            });

            await controller.handleModelRouting(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);

            // Response should still succeed (runtime update worked) but persistence failed
            expect(responseData.success).toBe(true);
            expect(responseData.persisted).toBe(false);
            expect(responseData.persistError).toContain('Failed to persist normalized config');
            expect(responseData.persistError).toContain('EACCES: permission denied');

            // Verify error state was recorded
            expect(controller._routingPersistence.lastSaveError).toContain('Failed to persist normalized config');

            // Verify warning was logged
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringContaining('[ModelRouter] Failed to persist normalized config')
            );

            // Verify metric was recorded
            expect(mockStatsAggregator.recordConfigMigrationWriteFailure).toHaveBeenCalled();

            jest.restoreAllMocks();
        });

        // Covers lines 280-290: persistErr when statsAggregator is not set
        it('should handle persistence errors gracefully when statsAggregator is not set', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({
                tiers: {
                    light: { models: ['glm-4-flash'], strategy: 'balanced' }
                }
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn(),
                headersSent: false
            };

            controller._routingPersistence = {
                enabled: true,
                configPath: tempConfigPath,
                lastSavedAt: null,
                lastSaveError: null,
                lastLoadError: null
            };

            // Remove statsAggregator
            controller._statsAggregator = undefined;

            // Mock fs.readFileSync to throw during persistence
            jest.spyOn(fs, 'readFileSync').mockImplementation((path, opts) => {
                if (String(path).includes(tempConfigPath)) {
                    throw new Error('ENOENT: directory not found');
                }
                return fs.readFileSync(path, opts);
            });

            await controller.handleModelRouting(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);

            expect(responseData.success).toBe(true);
            expect(responseData.persisted).toBe(false);
            expect(responseData.persistError).toContain('Failed to persist normalized config');

            // Should not throw even though statsAggregator is undefined
            expect(mockLogger.warn).toHaveBeenCalled();

            jest.restoreAllMocks();
        });

        // Covers lines 280-290: persistErr when logger is not set
        it('should handle persistence errors gracefully when logger is not set', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({
                tiers: {
                    light: { models: ['glm-4-flash'], strategy: 'balanced' }
                }
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn(),
                headersSent: false
            };

            controller._routingPersistence = {
                enabled: true,
                configPath: tempConfigPath,
                lastSavedAt: null,
                lastSaveError: null,
                lastLoadError: null
            };

            // Remove logger
            controller._logger = null;

            // Mock fs.readFileSync to throw during persistence
            jest.spyOn(fs, 'readFileSync').mockImplementation((path, opts) => {
                if (String(path).includes(tempConfigPath)) {
                    throw new Error('EIO: I/O error');
                }
                return fs.readFileSync(path, opts);
            });

            // Should not throw even though logger is null
            await controller.handleModelRouting(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);

            expect(responseData.success).toBe(true);
            expect(responseData.persisted).toBe(false);
            expect(responseData.persistError).toContain('Failed to persist normalized config');

            jest.restoreAllMocks();
        });
    });

    describe('handleModelRouting PUT - persistence success with warnings (line 210)', () => {
        // Covers line 210: response.warnings added when warnings exist during persistence
        it('should include warnings in response when persistence succeeds with warnings', async () => {
            const { Readable } = require('stream');

            // Config that generates warnings but is valid
            const bodyStr = JSON.stringify({
                tiers: {
                    light: {
                        // Mixed v1/v2 format
                        targetModel: 'glm-4-flash',
                        models: ['glm-4-flash'],
                        strategy: 'balanced'
                    }
                }
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn(),
                headersSent: false
            };

            controller._routingPersistence = {
                enabled: true,
                configPath: tempConfigPath,
                lastSavedAt: null,
                lastSaveError: null,
                lastLoadError: null
            };

            await controller.handleModelRouting(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);

            expect(responseData.success).toBe(true);
            expect(responseData.warnings).toBeDefined();
            expect(Array.isArray(responseData.warnings)).toBe(true);
            expect(responseData.warnings.length).toBeGreaterThan(0);

            // Clean up created file
            try { if (fs.existsSync(tempConfigPath)) fs.unlinkSync(tempConfigPath); } catch (_e) { /* ignore */ }
            try { if (fs.existsSync(tempConfigPath + '.bak')) fs.unlinkSync(tempConfigPath + '.bak'); } catch (_e) { /* ignore */ }
        });
    });

    describe('handleModelRoutingExport', () => {
        // Additional coverage for export endpoint
        it('should export config with adminTokens and apiKeys redacted', async () => {
            // Setup router with sensitive data
            mockModelRouter.toJSON = jest.fn(() => ({
                enabled: true,
                version: '2.0',
                adminTokens: ['secret-token'],
                apiKeys: ['key-1', 'key-2'],
                tiers: { light: { models: ['glm-4'] } }
            }));

            const mockReq = {
                method: 'GET',
                url: '/model-routing/export',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn(),
                headersSent: false
            };

            controller.handleModelRoutingExport(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, {
                'content-type': 'application/json',
                'content-disposition': 'attachment; filename="model-routing-export.json"',
                'cache-control': 'no-store'
            });

            const exportedData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(exportedData.adminTokens).toBeUndefined();
            expect(exportedData.apiKeys).toBeUndefined();
            expect(exportedData.exportedAt).toBeDefined();
            expect(exportedData.version).toBe('1.0');
        });

        // Covers early return when headers already sent
        it('should return early if headers already sent', () => {
            const mockReq = {
                method: 'GET',
                url: '/model-routing/export',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn(),
                headersSent: true  // Already sent
            };

            controller.handleModelRoutingExport(mockReq, mockRes);

            expect(mockRes.writeHead).not.toHaveBeenCalled();
            expect(mockRes.end).not.toHaveBeenCalled();
        });
    });

    describe('handleModelRoutingImportFromMappings', () => {
        // Covers import from mappings with wildcard patterns
        it('should convert wildcard patterns from model-mapping to rules', async () => {
            mockModelMappingManager.toConfig = jest.fn(() => ({
                mapping: {
                    'claude-*': 'glm-4',
                    'gpt-*': 'glm-4-flash',
                    'exact-model': 'glm-4-plus'
                }
            }));

            const mockReq = {
                method: 'GET',
                url: '/model-routing/import-from-mappings',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn(),
                headersSent: false
            };

            await controller.handleModelRoutingImportFromMappings(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, {
                'content-type': 'application/json',
                'cache-control': 'no-store'
            });

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.rules).toBeDefined();
            expect(responseData.count).toBe(2); // Only wildcard patterns are converted
            expect(responseData.source).toBe('model-mapping');

            // Verify wildcard patterns were converted to regex
            const claudeRule = responseData.rules.find(r => r.match.model === 'claude-.*');
            expect(claudeRule).toBeDefined();
            expect(claudeRule.tier).toBe('light');
            expect(claudeRule.source).toBe('imported_from_model_mapping');
        });

        // Covers import when manager.toConfig returns no mapping
        it('should return empty rules when model-mapping has no mapping config', async () => {
            mockModelMappingManager.toConfig = jest.fn(() => ({}));

            const mockReq = {
                method: 'GET',
                url: '/model-routing/import-from-mappings',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn(),
                headersSent: false
            };

            await controller.handleModelRoutingImportFromMappings(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.rules).toEqual([]);
            expect(responseData.count).toBe(0);
        });

        // Covers import with admin auth enabled but authenticated
        it('should require admin auth when enabled', async () => {
            mockAdminAuth.enabled = true;
            mockAdminAuth.authenticate.mockReturnValue({ authenticated: true });

            const mockReq = {
                method: 'GET',
                url: '/model-routing/import-from-mappings',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn(),
                headersSent: false
            };

            await controller.handleModelRoutingImportFromMappings(mockReq, mockRes);

            expect(mockAdminAuth.authenticate).toHaveBeenCalledWith(mockReq);
            expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        });

        // Covers import when admin auth fails
        it('should return 401 when admin auth fails', async () => {
            mockAdminAuth.enabled = true;
            mockAdminAuth.authenticate.mockReturnValue({
                authenticated: false,
                error: 'Invalid token'
            });

            const mockReq = {
                method: 'GET',
                url: '/model-routing/import-from-mappings',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn(),
                headersSent: false
            };

            await controller.handleModelRoutingImportFromMappings(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(401, expect.objectContaining({
                'content-type': 'application/json'
            }));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('Invalid token');
        });

        // Covers import when model router is not available
        it('should return 503 when model router is not available', async () => {
            controller._modelRouter = null;

            const mockReq = {
                method: 'GET',
                url: '/model-routing/import-from-mappings',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn(),
                headersSent: false
            };

            await controller.handleModelRoutingImportFromMappings(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(503, expect.objectContaining({
                'content-type': 'application/json'
            }));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toContain('Model router not available');
        });
    });

    describe('handleModelRoutingEnableSafe - validation errors', () => {
        // Covers validation error when tier missing targetModel
        it('should return validation error when tier is missing targetModel', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({
                addDefaultRules: false,
                updates: {
                    enabled: true,
                    tiers: {
                        light: { strategy: 'balanced' }  // Missing models/targetModel
                    }
                }
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing/enable-safe',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn(),
                headersSent: false
            };

            await controller.handleModelRoutingEnableSafe(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.success).toBe(false);
            expect(responseData.error).toBe('Configuration validation failed');
            expect(responseData.validationErrors).toBeDefined();
            expect(responseData.validationErrors.length).toBeGreaterThan(0);
            expect(responseData.validationErrors[0]).toContain('Tier "light"');
        });

        // Covers validation when ModelRouter.validateConfig fails
        it('should return validation error when ModelRouter validation fails', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({
                addDefaultRules: false,
                updates: {
                    enabled: true,
                    defaultModel: 'valid-model',  // Valid model
                    tiers: {
                        light: { targetModel: 'glm-4-flash', models: ['glm-4-flash'], strategy: 'balanced' },
                        medium: { targetModel: 'glm-4', models: ['glm-4'], strategy: 'balanced' },
                        heavy: { targetModel: 'glm-4-plus', models: ['glm-4-plus'], strategy: 'balanced' }
                    }
                }
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing/enable-safe',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn(),
                headersSent: false
            };

            // Mock ModelRouter.validateConfig to return invalid (after tier validation passes)
            jest.spyOn(ModelRouter, 'validateConfig').mockReturnValue({
                valid: false,
                error: 'Invalid model name: contains special characters'
            });

            await controller.handleModelRoutingEnableSafe(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.success).toBe(false);
            expect(responseData.error).toBe('Configuration validation failed');
            expect(responseData.validationErrors).toEqual(['Invalid model name: contains special characters']);

            jest.restoreAllMocks();
        });
    });

    describe('handleModelRouting PUT - content-type rejection (line 153)', () => {
        // Covers line 153: rejectNonJsonContentType returns true
        it('should return 415 when content-type is not application/json', async () => {
            const mockReq = {
                method: 'PUT',
                url: '/model-routing',
                headers: {
                    host: 'localhost',
                    'content-type': 'text/plain'
                }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn(),
                headersSent: false
            };

            await controller.handleModelRouting(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(415, expect.objectContaining({
                'content-type': 'application/json'
            }));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toContain('Unsupported Media Type');
        });
    });

    describe('handleModelRouting PUT - validation context (lines 176-181)', () => {
        // Covers lines 176-177: rules without defaultModel
        it('should include defaultModel from router when validating rules only', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({
                rules: [{ match: { model: 'claude-*' }, tier: 'light' }]
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn(),
                headersSent: false
            };

            // Mock validateConfig to capture what's passed
            let capturedKeys = null;
            jest.spyOn(ModelRouter, 'validateConfig').mockImplementation((keys) => {
                capturedKeys = keys;
                return { valid: true };
            });

            await controller.handleModelRouting(mockReq, mockRes);

            expect(capturedKeys).toBeDefined();
            expect(capturedKeys.defaultModel).toBe('glm-4');  // From mockModelRouter.config
            expect(capturedKeys.rules).toBeDefined();

            jest.restoreAllMocks();
        });

        // Covers lines 179-181: defaultModel without rules
        it('should include rules from router when validating defaultModel only', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({
                defaultModel: 'glm-4-flash'
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn(),
                headersSent: false
            };

            // Mock validateConfig to capture what's passed
            let capturedKeys = null;
            jest.spyOn(ModelRouter, 'validateConfig').mockImplementation((keys) => {
                capturedKeys = keys;
                return { valid: true };
            });

            await controller.handleModelRouting(mockReq, mockRes);

            expect(capturedKeys).toBeDefined();
            expect(capturedKeys.rules).toEqual([]);  // From mockModelRouter.config
            expect(capturedKeys.defaultModel).toBe('glm-4-flash');

            jest.restoreAllMocks();
        });

        // Covers line 192: tier deep merge
        it('should deep merge tier configs', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({
                tiers: {
                    light: { models: ['new-model'], strategy: 'quality' }
                }
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn(),
                headersSent: false
            };

            jest.spyOn(ModelRouter, 'validateConfig').mockReturnValue({ valid: true });

            await controller.handleModelRouting(mockReq, mockRes);

            // Verify updateConfig was called with merged tiers
            const mergedConfig = mockModelRouter.updateConfig.mock.calls[0][0];
            expect(mergedConfig.tiers.light.models).toEqual(['new-model']);
            // Other tiers should remain from original config
            expect(mergedConfig.tiers.medium).toBeDefined();
            expect(mergedConfig.tiers.heavy).toBeDefined();

            jest.restoreAllMocks();
        });
    });

    describe('_sendJson - headers already sent (line 77)', () => {
        // Covers line 77: early return when headers already sent
        it('should return early if headers already sent', () => {
            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: true
            };

            controller._sendJson(mockRes, 200, { test: 'data' });

            expect(mockRes.writeHead).not.toHaveBeenCalled();
            expect(mockRes.end).not.toHaveBeenCalled();
        });
    });

    describe('handleModelRoutingTest (lines 565-627)', () => {
        // Covers handleModelRoutingTest with various query params
        it('should handle test request with all query parameters', () => {
            mockModelRouter.config.tiers.medium = {
                models: ['glm-4'],
                strategy: 'balanced',
                targetModel: 'glm-4',
                failoverModel: 'glm-4-flash'
            };

            const mockReq = {
                method: 'GET',
                url: '/model-routing/test?model=claude-opus-4&max_tokens=1000&messages=5&tools=true&vision=true&system_length=100',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            controller.handleModelRoutingTest(mockReq, mockRes);

            expect(mockModelRouter.extractFeatures).toHaveBeenCalled();
            const extractedBody = mockModelRouter.extractFeatures.mock.calls[0][0];

            expect(extractedBody.model).toBe('claude-opus-4');
            expect(extractedBody.max_tokens).toBe(1000);
            expect(extractedBody.messages).toHaveLength(5);
            expect(extractedBody.tools).toBeDefined();
            expect(extractedBody.messages[0].content).toBeInstanceOf(Array); // Vision content
            expect(extractedBody.system).toHaveLength(100);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.features).toBeDefined();
            expect(responseData.classification).toBeDefined();
        });

        // Covers line 618-619: defaultModel fallback when tier not found
        it('should use defaultModel when classification tier not in config', () => {
            mockModelRouter.config.tiers = {};  // No tiers configured
            mockModelRouter.config.defaultModel = 'fallback-model';

            const mockReq = {
                method: 'GET',
                url: '/model-routing/test?model=test-model',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            controller.handleModelRoutingTest(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.targetModel).toBe('fallback-model');
            expect(responseData.failoverModel).toBeNull();
        });

        // Covers line 585: NaN max_tokens handling
        it('should handle invalid max_tokens parameter', () => {
            const mockReq = {
                method: 'GET',
                url: '/model-routing/test?max_tokens=invalid',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            controller.handleModelRoutingTest(mockReq, mockRes);

            const extractedBody = mockModelRouter.extractFeatures.mock.calls[0][0];
            expect(extractedBody.max_tokens).toBeUndefined();
        });

        // Covers line 565: URL with missing host header
        it('should handle request with missing host header', () => {
            const mockReq = {
                method: 'GET',
                url: '/model-routing/test',
                headers: {}
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            controller.handleModelRoutingTest(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        });

        // Covers lines 627-629: cooldown response when targetModel exists
        it('should include cooldown info in response', () => {
            mockModelRouter.config.tiers.medium = {
                models: ['glm-4'],
                strategy: 'balanced',
                targetModel: 'glm-4',
                failoverModel: 'glm-4-flash'
            };
            mockModelRouter.getModelCooldown.mockReturnValue(5000);

            const mockReq = {
                method: 'GET',
                url: '/model-routing/test',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            controller.handleModelRoutingTest(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.cooldown).toBeDefined();
            expect(responseData.cooldown.targetMs).toBe(5000);
            expect(responseData.cooldown.failoverMs).toBe(5000);
        });

        // Covers lines 627-629: cooldown null when no targetModel
        it('should return null cooldown when no targetModel resolved', () => {
            mockModelRouter.config.tiers = {};
            mockModelRouter.config.defaultModel = null;

            const mockReq = {
                method: 'GET',
                url: '/model-routing/test',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            controller.handleModelRoutingTest(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.targetModel).toBeNull();
            expect(responseData.cooldown).toBeNull();
        });
    });

    describe('handleModelRoutingOverrides - PUT error handling (lines 654, 674)', () => {
        // Covers line 654: rejectNonJsonContentType in PUT overrides
        it('should reject PUT with wrong content-type', async () => {
            const mockReq = {
                method: 'PUT',
                url: '/model-routing/overrides',
                headers: {
                    host: 'localhost',
                    'content-type': 'text/plain'
                }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await controller.handleModelRoutingOverrides(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(415, expect.objectContaining({
                'content-type': 'application/json'
            }));
        });

        // Covers line 674: catch block in PUT overrides
        it('should handle invalid JSON in PUT request', async () => {
            const { Readable } = require('stream');

            const bodyStr = 'not valid json';

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing/overrides',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await controller.handleModelRoutingOverrides(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(400, expect.objectContaining({
                'content-type': 'application/json'
            }));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toContain('Invalid JSON');
        });

        // Covers line 698: catch block in DELETE overrides
        it('should handle invalid JSON in DELETE request', async () => {
            const { Readable } = require('stream');

            const bodyStr = 'not valid json';

            const mockReq = Object.assign(new Readable(), {
                method: 'DELETE',
                url: '/model-routing/overrides',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await controller.handleModelRoutingOverrides(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(400, expect.objectContaining({
                'content-type': 'application/json'
            }));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toContain('Invalid JSON');
        });
    });

    describe('handleModelRoutingEnableSafe - default rules (lines 874-888)', () => {
        // Covers lines 874-888: addDefaultRules path
        it('should add default rules and tiers when addDefaultRules is true', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({
                addDefaultRules: true
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing/enable-safe',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            jest.spyOn(ModelRouter, 'validateConfig').mockReturnValue({ valid: true });

            await controller.handleModelRoutingEnableSafe(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.success).toBe(true);
            expect(mockModelRouter.updateConfig).toHaveBeenCalled();

            const mergedConfig = mockModelRouter.updateConfig.mock.calls[0][0];
            expect(mergedConfig.tiers.light.targetModel).toBe('glm-4.5-air');
            expect(mergedConfig.tiers.medium.targetModel).toBe('glm-4.6');
            expect(mergedConfig.tiers.heavy.targetModel).toBe('glm-4.7');
            expect(mergedConfig.rules).toHaveLength(4);

            jest.restoreAllMocks();
        });

        // Covers line 848: rejectNonJsonContentType
        it('should reject non-JSON content-type', async () => {
            const mockReq = {
                method: 'PUT',
                url: '/model-routing/enable-safe',
                headers: {
                    host: 'localhost',
                    'content-type': 'text/plain'
                }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await controller.handleModelRoutingEnableSafe(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(415, expect.objectContaining({
                'content-type': 'application/json'
            }));
        });

        // Covers line 945: catch block in enable-safe
        it('should handle invalid JSON body', async () => {
            const { Readable } = require('stream');

            const bodyStr = 'not valid json';

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing/enable-safe',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await controller.handleModelRoutingEnableSafe(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(400, expect.objectContaining({
                'content-type': 'application/json'
            }));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toContain('Invalid JSON body');
        });

        // Covers line 853: auth required when enabled
        it('should require admin auth when enabled', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({ addDefaultRules: true });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing/enable-safe',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            mockAdminAuth.enabled = true;
            mockAdminAuth.authenticate.mockReturnValue({ authenticated: false, error: 'Unauthorized' });

            await controller.handleModelRoutingEnableSafe(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(401, expect.objectContaining({
                'content-type': 'application/json'
            }));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('Unauthorized');

            mockAdminAuth.enabled = false;
        });
    });

    describe('handleModelMapping - adminAuth check (line 398)', () => {
        // Covers line 398: _adminAuth existence check (not enabled)
        it('should call authenticate when _adminAuth is set', async () => {
            const mockReq = {
                method: 'GET',
                url: '/model-mapping',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            // Create controller with _adminAuth set but enabled not checked
            const authController = new ModelController({
                modelRouter: mockModelRouter,
                modelDiscovery: mockModelDiscovery,
                modelMappingManager: mockModelMappingManager,
                adminAuth: {
                    authenticate: jest.fn(() => ({ authenticated: true }))
                },
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry,
                isClusterWorker: false
            });

            await authController.handleModelMapping(mockReq, mockRes);

            expect(authController._adminAuth.authenticate).toHaveBeenCalledWith(mockReq);
            expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        });

        // Covers lines 400-402: auth failed path
        it('should return 401 when auth fails', async () => {
            const mockReq = {
                method: 'GET',
                url: '/model-mapping',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            const authController = new ModelController({
                modelRouter: mockModelRouter,
                modelDiscovery: mockModelDiscovery,
                modelMappingManager: mockModelMappingManager,
                adminAuth: {
                    authenticate: jest.fn(() => ({ authenticated: false, error: 'Invalid token' }))
                },
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry,
                isClusterWorker: false
            });

            await authController.handleModelMapping(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(401, expect.objectContaining({
                'content-type': 'application/json'
            }));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('Invalid token');
        });

        // Covers line 422-427: PUT returns deprecation info
        it('should return deprecation info on PUT', async () => {
            const mockReq = {
                method: 'PUT',
                url: '/model-mapping',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await controller.handleModelMapping(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.deprecated).toBe(true);
            expect(responseData.useInstead).toBe('/model-routing');
            expect(responseData.message).toContain('deprecated');
        });
    });

    describe('handleModelMappingReset - adminAuth check (line 447)', () => {
        // Covers line 447: _adminAuth existence check
        it('should call authenticate when _adminAuth is set', async () => {
            const mockReq = {
                method: 'POST',
                url: '/model-mapping/reset',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            const authController = new ModelController({
                modelRouter: mockModelRouter,
                modelDiscovery: mockModelDiscovery,
                modelMappingManager: mockModelMappingManager,
                adminAuth: {
                    authenticate: jest.fn(() => ({ authenticated: true }))
                },
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry,
                isClusterWorker: false
            });

            await authController.handleModelMappingReset(mockReq, mockRes);

            expect(authController._adminAuth.authenticate).toHaveBeenCalledWith(mockReq);
        });

        // Covers lines 449-451: auth failed path
        it('should return 401 when auth fails', async () => {
            const mockReq = {
                method: 'POST',
                url: '/model-mapping/reset',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            const authController = new ModelController({
                modelRouter: mockModelRouter,
                modelDiscovery: mockModelDiscovery,
                modelMappingManager: mockModelMappingManager,
                adminAuth: {
                    authenticate: jest.fn(() => ({ authenticated: false, error: 'Forbidden' }))
                },
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry,
                isClusterWorker: false
            });

            await authController.handleModelMappingReset(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(401, expect.objectContaining({
                'content-type': 'application/json'
            }));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('Forbidden');
        });
    });

    describe('handleModelMappingKey - adminAuth check (line 475)', () => {
        // Covers line 475: _adminAuth existence check
        it('should call authenticate when _adminAuth is set', async () => {
            const mockReq = {
                method: 'GET',
                url: '/model-mapping/keys/0',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            const authController = new ModelController({
                modelRouter: mockModelRouter,
                modelDiscovery: mockModelDiscovery,
                modelMappingManager: mockModelMappingManager,
                adminAuth: {
                    authenticate: jest.fn(() => ({ authenticated: true }))
                },
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry,
                isClusterWorker: false
            });

            await authController.handleModelMappingKey(mockReq, mockRes, '0');

            expect(authController._adminAuth.authenticate).toHaveBeenCalledWith(mockReq);
        });

        // Covers lines 477-479: auth failed path
        it('should return 401 when auth fails', async () => {
            const mockReq = {
                method: 'GET',
                url: '/model-mapping/keys/0',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            const authController = new ModelController({
                modelRouter: mockModelRouter,
                modelDiscovery: mockModelDiscovery,
                modelMappingManager: mockModelMappingManager,
                adminAuth: {
                    authenticate: jest.fn(() => ({ authenticated: false, error: 'Access denied' }))
                },
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry,
                isClusterWorker: false
            });

            await authController.handleModelMappingKey(mockReq, mockRes, '0');

            expect(mockRes.writeHead).toHaveBeenCalledWith(401, expect.objectContaining({
                'content-type': 'application/json'
            }));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('Access denied');
        });

        // Covers line 494: getKeyOverride call
        it('should return override from manager', async () => {
            const mockReq = {
                method: 'GET',
                url: '/model-mapping/keys/5',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            mockModelMappingManager.getKeyOverride.mockReturnValue({ tier: 'heavy', model: 'custom' });

            await controller.handleModelMappingKey(mockReq, mockRes, '5');

            expect(mockModelMappingManager.getKeyOverride).toHaveBeenCalledWith('5');

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.override).toEqual({ tier: 'heavy', model: 'custom' });
            expect(responseData.deprecated).toBe(true);
        });
    });

    describe('handleModelMapping - no adminAuth', () => {
        // Covers lines 408-416: GET when _adminAuth is null
        it('should return mapping config when _adminAuth is null', async () => {
            const mockReq = {
                method: 'GET',
                url: '/model-mapping',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            const noAuthController = new ModelController({
                modelRouter: mockModelRouter,
                modelDiscovery: mockModelDiscovery,
                modelMappingManager: mockModelMappingManager,
                adminAuth: null,  // No auth
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry,
                isClusterWorker: false
            });

            await noAuthController.handleModelMapping(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
            expect(mockModelMappingManager.toConfig).toHaveBeenCalled();
            expect(mockModelMappingManager.getKeyOverrides).toHaveBeenCalled();
        });
    });

    describe('handleModelRoutingTest - messageCount edge cases (line 568)', () => {
        // Covers line 568: messageCount calculation edge cases
        it('should clamp messageCount to 100 when value exceeds max', () => {
            const mockReq = {
                method: 'GET',
                url: '/model-routing/test?messages=999',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            controller.handleModelRoutingTest(mockReq, mockRes);

            const extractedBody = mockModelRouter.extractFeatures.mock.calls[0][0];
            expect(extractedBody.messages).toHaveLength(100);  // Clamped to max
        });

        // Covers line 568: messageCount with NaN
        it('should default to 1 when messageCount is NaN', () => {
            const mockReq = {
                method: 'GET',
                url: '/model-routing/test?messages=invalid',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            controller.handleModelRoutingTest(mockReq, mockRes);

            const extractedBody = mockModelRouter.extractFeatures.mock.calls[0][0];
            expect(extractedBody.messages).toHaveLength(1);  // Default
        });
    });

    describe('handleModelRouting GET - cluster worker warning (line 136)', () => {
        // Covers line 136: isClusterWorker nested branch
        it('should add worker-specific warning when running as cluster worker', async () => {
            const clusterController = new ModelController({
                modelRouter: mockModelRouter,
                modelDiscovery: mockModelDiscovery,
                modelMappingManager: mockModelMappingManager,
                adminAuth: null,
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry,
                isClusterWorker: true  // This triggers line 136
            });

            const mockReq = {
                method: 'GET',
                url: '/model-routing',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await clusterController.handleModelRouting(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.warnings).toContain('overrides_not_persisted_on_worker');
        });
    });

    describe('handleModelRouting PUT - validation key handling (lines 167-174)', () => {
        // Covers lines 167-174: normalizationResult.warnings and key validation
        it('should handle updates with warnings from normalization', async () => {
            const { Readable } = require('stream');

            // Send updates that will generate warnings but pass validation
            const bodyStr = JSON.stringify({
                enabled: true
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await controller.handleModelRouting(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.success).toBe(true);
        });

        // Covers lines 170-173: keyToValidate building loop
        it('should build keysToValidate from updates', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({
                enabled: true,
                defaultModel: 'glm-4-flash'
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            // Spy on validateConfig to see what's passed
            let capturedKeys = null;
            jest.spyOn(ModelRouter, 'validateConfig').mockImplementation((keys) => {
                capturedKeys = keys;
                return { valid: true };
            });

            await controller.handleModelRouting(mockReq, mockRes);

            expect(capturedKeys).toBeDefined();
            expect(capturedKeys.enabled).toBe(true);
            expect(capturedKeys.defaultModel).toBe('glm-4-flash');

            jest.restoreAllMocks();
        });

        // Covers line 177: rules without defaultModel
        it('should add defaultModel when only rules provided in updates', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({
                rules: [{ match: { model: 'test' }, tier: 'light' }]
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            let capturedKeys = null;
            jest.spyOn(ModelRouter, 'validateConfig').mockImplementation((keys) => {
                capturedKeys = keys;
                return { valid: true };
            });

            await controller.handleModelRouting(mockReq, mockRes);

            expect(capturedKeys).toBeDefined();
            expect(capturedKeys.rules).toBeDefined();
            expect(capturedKeys.defaultModel).toBe('glm-4');  // From router config

            jest.restoreAllMocks();
        });

        // Covers line 192: normalizedUpdates.tiers check
        it('should deep merge tiers when normalizedUpdates has tiers', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({
                tiers: {
                    light: { models: ['new-model'], strategy: 'quality' }
                }
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            jest.spyOn(ModelRouter, 'validateConfig').mockReturnValue({ valid: true });

            await controller.handleModelRouting(mockReq, mockRes);

            const mergedConfig = mockModelRouter.updateConfig.mock.calls[0][0];
            expect(mergedConfig.tiers.light.models).toEqual(['new-model']);
            // Other tiers should remain
            expect(mergedConfig.tiers.medium).toBeDefined();

            jest.restoreAllMocks();
        });
    });

    describe('handleModelRouting PUT - catch block (line 307)', () => {
        // Covers line 307: catch block with statusCode
        it('should return statusCode from error when available', async () => {
            const { Readable } = require('stream');

            const bodyStr = 'invalid json';

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await controller.handleModelRouting(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(400, expect.any(Object));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toContain('Invalid JSON');
        });
    });

    describe('handleModelRoutingImportFromMappings - toConfig check (line 809)', () => {
        // Covers line 809: manager && typeof manager.toConfig === 'function'
        it('should check manager.toConfig is a function before calling', async () => {
            const mockReq = {
                method: 'GET',
                url: '/model-routing/import-from-mappings',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            // Set up manager with toConfig
            mockModelMappingManager.toConfig.mockReturnValue({
                mapping: {
                    'test-*': 'glm-4'
                }
            });

            await controller.handleModelRoutingImportFromMappings(mockReq, mockRes);

            expect(mockModelMappingManager.toConfig).toHaveBeenCalled();
        });

        // Covers line 811-812: config.mapping check
        it('should return empty rules when config has no mapping', async () => {
            const mockReq = {
                method: 'GET',
                url: '/model-routing/import-from-mappings',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            mockModelMappingManager.toConfig.mockReturnValue({
                // No mapping property
                rules: []
            });

            await controller.handleModelRoutingImportFromMappings(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.rules).toEqual([]);
            expect(responseData.count).toBe(0);
        });
    });

    describe('handleModelRoutingEnableSafe - auth check (line 853)', () => {
        // Covers line 853: adminAuth && adminAuth.enabled check
        it('should require auth when adminAuth.enabled is true', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({ addDefaultRules: true });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing/enable-safe',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            // Create controller with enabled auth
            const authController = new ModelController({
                modelRouter: mockModelRouter,
                modelDiscovery: mockModelDiscovery,
                modelMappingManager: mockModelMappingManager,
                adminAuth: {
                    enabled: true,
                    authenticate: jest.fn(() => ({ authenticated: false, error: 'Token required' }))
                },
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry,
                isClusterWorker: false
            });

            await authController.handleModelRoutingEnableSafe(mockReq, mockRes);

            expect(authController._adminAuth.authenticate).toHaveBeenCalled();
            expect(mockRes.writeHead).toHaveBeenCalledWith(401, expect.any(Object));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('Token required');
        });
    });

    describe('handleModelRoutingEnableSafe - default rules (lines 874-888)', () => {
        // Covers lines 874-888: addDefaultRules logic
        it('should add default tiers when tiers object is missing', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({
                addDefaultRules: true,
                updates: {
                    enabled: true
                    // No tiers object
                }
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing/enable-safe',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            jest.spyOn(ModelRouter, 'validateConfig').mockReturnValue({ valid: true });

            await controller.handleModelRoutingEnableSafe(mockReq, mockRes);

            const mergedConfig = mockModelRouter.updateConfig.mock.calls[0][0];
            expect(mergedConfig.tiers.light.targetModel).toBe('glm-4.5-air');
            expect(mergedConfig.tiers.medium.targetModel).toBe('glm-4.6');
            expect(mergedConfig.tiers.heavy.targetModel).toBe('glm-4.7');

            jest.restoreAllMocks();
        });

        // Covers lines 888-895: add default rules when rules array is empty
        it('should add default rules when rules array is empty', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({
                addDefaultRules: true,
                updates: {
                    enabled: true,
                    rules: []  // Empty rules array
                }
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing/enable-safe',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            jest.spyOn(ModelRouter, 'validateConfig').mockReturnValue({ valid: true });

            await controller.handleModelRoutingEnableSafe(mockReq, mockRes);

            const mergedConfig = mockModelRouter.updateConfig.mock.calls[0][0];
            expect(mergedConfig.rules).toBeDefined();
            expect(mergedConfig.rules.length).toBeGreaterThan(0);

            jest.restoreAllMocks();
        });

        // Covers line 945: catch block with statusCode
        it('should handle errors with statusCode in enable-safe', async () => {
            const { Readable } = require('stream');

            const error = new Error('Bad request');
            error.statusCode = 400;

            const bodyStr = 'invalid';

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing/enable-safe',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await controller.handleModelRoutingEnableSafe(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
        });
    });

    describe('handleModelRouting GET - cluster primary with workers (line 136)', () => {
        // Covers line 136: isActuallyClustered=true (cluster.isPrimary && workers) but isClusterWorker=false
        // Tests the branch where the primary has workers but this is not a worker process
        it('should add cooldowns_not_shared warning on primary with workers but not as worker', async () => {
            const cluster = require('cluster');
            const origIsPrimary = cluster.isPrimary;
            const origWorkers = cluster.workers;

            cluster.isPrimary = true;
            cluster.workers = { 1: {} };

            const clusterController = new ModelController({
                modelRouter: mockModelRouter,
                modelDiscovery: mockModelDiscovery,
                modelMappingManager: mockModelMappingManager,
                adminAuth: null,
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry,
                isClusterWorker: false
            });

            const mockReq = {
                method: 'GET',
                url: '/model-routing',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await clusterController.handleModelRouting(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.warnings).toContain('cooldowns_not_shared_in_cluster');
            expect(responseData.warnings).not.toContain('overrides_not_persisted_on_worker');

            cluster.isPrimary = origIsPrimary;
            cluster.workers = origWorkers;
        });
    });

    describe('handleModelRouting PUT - uncovered validation branches (lines 167, 172, 174, 177, 192)', () => {
        // Covers line 167: normalizationResult.warnings is falsy (undefined) → use []
        // Covers line 172: normalizedUpdates[key] is undefined → fall back to updates[key]
        // Covers line 174: normalizedUpdates.version falsy, router version truthy
        // Covers line 177: router config has no defaultModel → use null
        // Covers line 192: normalizedUpdates has no tiers → skip deep merge
        it('should handle normalizer returning no warnings, missing keys, and no defaultModel', async () => {
            jest.resetModules();
            jest.doMock('../lib/model-router-normalizer', () => ({
                normalizeModelRoutingConfig: jest.fn().mockReturnValue({
                    normalizedConfig: { enabled: true }, // no version, no tiers, no warnings returned
                    migrated: false
                    // Intentionally NO warnings property
                }),
                computeConfigHash: jest.fn().mockReturnValue('fake-hash'),
                shouldPersistNormalizedConfig: jest.fn().mockReturnValue(false),
                updateMigrationMarker: jest.fn()
            }));
            jest.doMock('../lib/model-router', () => ({
                ModelRouter: {
                    validateConfig: jest.fn().mockReturnValue({ valid: true })
                }
            }));
            jest.doMock('../lib/body-parser', () => ({
                parseJsonBody: jest.fn().mockResolvedValue({ enabled: true, someExtraKey: 'val' })
            }));
            jest.doMock('../lib/content-type-validator', () => ({
                rejectNonJsonContentType: jest.fn().mockReturnValue(false)
            }));
            jest.doMock('../lib/client-ip', () => ({
                getClientIp: jest.fn().mockReturnValue('127.0.0.1')
            }));
            jest.doMock('../lib/atomic-write', () => ({
                atomicWrite: jest.fn().mockResolvedValue()
            }));

            const { ModelController: FreshController } = require('../lib/proxy/controllers/model-controller');

            const freshRouter = {
                config: {
                    enabled: true,
                    version: '3.0',
                    defaultModel: null, // falsy → line 177 uses null
                    tiers: {
                        light: { models: ['glm-4-flash'], strategy: 'balanced' }
                    },
                    rules: []
                },
                toJSON: jest.fn(function() { return { ...this.config }; }),
                updateConfig: jest.fn()
            };

            const freshController = new FreshController({
                modelRouter: freshRouter,
                modelDiscovery: mockModelDiscovery,
                modelMappingManager: mockModelMappingManager,
                adminAuth: null,
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry,
                isClusterWorker: false,
                getClientIp: jest.fn(() => '127.0.0.1')
            });

            const bodyStr = JSON.stringify({ enabled: true, someExtraKey: 'val' });
            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await freshController.handleModelRouting(mockReq, mockRes);

            // Verify the response was successful
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.success).toBe(true);

            // Verify updateConfig was called with merged config (no tiers deep merge since normalizedUpdates has no tiers)
            expect(freshRouter.updateConfig).toHaveBeenCalledWith(
                expect.objectContaining({
                    enabled: true,
                    version: '3.0' // From router config fallback (line 174)
                })
            );

            jest.restoreAllMocks();
            jest.resetModules();
        });

        // Covers line 174: both normalizedUpdates.version and router config version are falsy → use '2.0'
        it('should fallback to 2.0 when both normalized version and router version are missing', async () => {
            jest.resetModules();
            jest.doMock('../lib/model-router-normalizer', () => ({
                normalizeModelRoutingConfig: jest.fn().mockReturnValue({
                    normalizedConfig: { enabled: true }, // no version
                    migrated: false
                }),
                computeConfigHash: jest.fn().mockReturnValue('fake-hash'),
                shouldPersistNormalizedConfig: jest.fn().mockReturnValue(false),
                updateMigrationMarker: jest.fn()
            }));
            jest.doMock('../lib/model-router', () => ({
                ModelRouter: {
                    validateConfig: jest.fn().mockReturnValue({ valid: true })
                }
            }));
            jest.doMock('../lib/body-parser', () => ({
                parseJsonBody: jest.fn().mockResolvedValue({ enabled: true })
            }));
            jest.doMock('../lib/content-type-validator', () => ({
                rejectNonJsonContentType: jest.fn().mockReturnValue(false)
            }));
            jest.doMock('../lib/client-ip', () => ({
                getClientIp: jest.fn().mockReturnValue('127.0.0.1')
            }));
            jest.doMock('../lib/atomic-write', () => ({
                atomicWrite: jest.fn().mockResolvedValue()
            }));

            const { ModelController: FreshController } = require('../lib/proxy/controllers/model-controller');

            const freshRouter = {
                config: {
                    enabled: true,
                    // no version → undefined
                    defaultModel: 'glm-4',
                    tiers: {
                        light: { models: ['glm-4-flash'], strategy: 'balanced' }
                    },
                    rules: []
                },
                toJSON: jest.fn(function() { return { ...this.config }; }),
                updateConfig: jest.fn()
            };

            const freshController = new FreshController({
                modelRouter: freshRouter,
                modelDiscovery: mockModelDiscovery,
                modelMappingManager: mockModelMappingManager,
                adminAuth: null,
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry,
                isClusterWorker: false,
                getClientIp: jest.fn(() => '127.0.0.1')
            });

            const bodyStr = JSON.stringify({ enabled: true });
            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await freshController.handleModelRouting(mockReq, mockRes);

            // Capture what was passed to validateConfig to verify version fallback
            const { ModelRouter: MockedMR } = require('../lib/model-router');
            expect(MockedMR.validateConfig).toHaveBeenCalledWith(
                expect.objectContaining({
                    version: '2.0' // Fallback when both are missing (line 174)
                })
            );

            jest.restoreAllMocks();
            jest.resetModules();
        });
    });

    describe('handleModelRouting PUT - persistence version branch (line 229)', () => {
        // Covers line 229: mergedConfig.version is falsy → editableFields.version defaults to '2.0'
        it('should use version 2.0 default when mergedConfig has no version', async () => {
            jest.resetModules();
            const writtenFiles = [];
            jest.doMock('../lib/model-router-normalizer', () => ({
                normalizeModelRoutingConfig: jest.fn().mockReturnValue({
                    normalizedConfig: { enabled: true }, // no version
                    migrated: false
                }),
                computeConfigHash: jest.fn().mockReturnValue('hash-abc'),
                shouldPersistNormalizedConfig: jest.fn().mockReturnValue(true),
                updateMigrationMarker: jest.fn()
            }));
            jest.doMock('../lib/model-router', () => ({
                ModelRouter: {
                    validateConfig: jest.fn().mockReturnValue({ valid: true })
                }
            }));
            jest.doMock('../lib/body-parser', () => ({
                parseJsonBody: jest.fn().mockResolvedValue({ enabled: true })
            }));
            jest.doMock('../lib/content-type-validator', () => ({
                rejectNonJsonContentType: jest.fn().mockReturnValue(false)
            }));
            jest.doMock('../lib/client-ip', () => ({
                getClientIp: jest.fn().mockReturnValue('127.0.0.1')
            }));
            jest.doMock('../lib/atomic-write', () => ({
                atomicWrite: jest.fn().mockImplementation(async (filePath, data) => {
                    writtenFiles.push({ path: filePath, data });
                })
            }));

            const { ModelController: FreshController } = require('../lib/proxy/controllers/model-controller');

            const freshRouter = {
                config: {
                    enabled: true,
                    // no version
                    defaultModel: 'glm-4',
                    tiers: {
                        light: { models: ['glm-4-flash'], strategy: 'balanced' }
                    },
                    rules: []
                },
                toJSON: jest.fn(function() { return { ...this.config }; }),
                updateConfig: jest.fn()
            };

            const freshController = new FreshController({
                modelRouter: freshRouter,
                modelDiscovery: mockModelDiscovery,
                modelMappingManager: mockModelMappingManager,
                adminAuth: null,
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry,
                isClusterWorker: false,
                getClientIp: jest.fn(() => '127.0.0.1')
            });

            freshController._routingPersistence = {
                enabled: true,
                configPath: tempConfigPath,
                lastSavedAt: null,
                lastSaveError: null,
                lastLoadError: null
            };

            const bodyStr = JSON.stringify({ enabled: true });
            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await freshController.handleModelRouting(mockReq, mockRes);

            // Verify the persisted file has version: '2.0' (line 229 fallback)
            const configWrite = writtenFiles.find(f => f.path === tempConfigPath);
            expect(configWrite).toBeDefined();
            const persisted = JSON.parse(configWrite.data);
            expect(persisted.version).toBe('2.0');

            jest.restoreAllMocks();
            jest.resetModules();
        });
    });

    describe('handleModelMappingReset - no adminAuth (line 447)', () => {
        // Covers line 447: _adminAuth is falsy → skip auth check entirely
        it('should return deprecation response when adminAuth is null', async () => {
            const noAuthController = new ModelController({
                modelRouter: mockModelRouter,
                modelDiscovery: mockModelDiscovery,
                modelMappingManager: mockModelMappingManager,
                adminAuth: null,
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry,
                isClusterWorker: false
            });

            const mockReq = {
                method: 'POST',
                url: '/model-mapping/reset',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await noAuthController.handleModelMappingReset(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
                'content-type': 'application/json'
            }));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.deprecated).toBe(true);
            expect(responseData.useInstead).toBe('/model-routing');
        });
    });

    describe('handleModelMappingKey - no adminAuth (line 475)', () => {
        // Covers line 475: _adminAuth is falsy → skip auth check entirely
        it('should return deprecation response on GET when adminAuth is null', async () => {
            const noAuthController = new ModelController({
                modelRouter: mockModelRouter,
                modelDiscovery: mockModelDiscovery,
                modelMappingManager: mockModelMappingManager,
                adminAuth: null,
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry,
                isClusterWorker: false
            });

            const mockReq = {
                method: 'GET',
                url: '/model-mapping/keys/0',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await noAuthController.handleModelMappingKey(mockReq, mockRes, '0');

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
                'content-type': 'application/json'
            }));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.deprecated).toBe(true);
            expect(responseData.override).toBeDefined();
        });

        // Covers PUT and DELETE on handleModelMappingKey without adminAuth
        it('should return deprecation response on PUT when adminAuth is null', async () => {
            const noAuthController = new ModelController({
                modelRouter: mockModelRouter,
                modelDiscovery: mockModelDiscovery,
                modelMappingManager: mockModelMappingManager,
                adminAuth: null,
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry,
                isClusterWorker: false
            });

            const mockReq = {
                method: 'PUT',
                url: '/model-mapping/keys/0',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await noAuthController.handleModelMappingKey(mockReq, mockRes, '0');

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.deprecated).toBe(true);
            expect(responseData.message).toContain('deprecated');
        });

        it('should return deprecation response on DELETE when adminAuth is null', async () => {
            const noAuthController = new ModelController({
                modelRouter: mockModelRouter,
                modelDiscovery: mockModelDiscovery,
                modelMappingManager: mockModelMappingManager,
                adminAuth: null,
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry,
                isClusterWorker: false
            });

            const mockReq = {
                method: 'DELETE',
                url: '/model-mapping/keys/0',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await noAuthController.handleModelMappingKey(mockReq, mockRes, '0');

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.deprecated).toBe(true);
            expect(responseData.message).toContain('deprecated');
        });
    });

    describe('handleModelRoutingOverrides - error with custom statusCode (lines 674, 698)', () => {
        // Covers line 674: catch block in PUT with error having custom statusCode
        it('should use custom statusCode from error in PUT overrides', async () => {
            jest.resetModules();
            jest.doMock('../lib/content-type-validator', () => ({
                rejectNonJsonContentType: jest.fn().mockReturnValue(false)
            }));
            jest.doMock('../lib/body-parser', () => ({
                parseJsonBody: jest.fn().mockRejectedValue(Object.assign(new Error('Payload Too Large'), { statusCode: 413 }))
            }));

            const { ModelController: FreshController } = require('../lib/proxy/controllers/model-controller');

            const freshController = new FreshController({
                modelRouter: mockModelRouter,
                modelDiscovery: mockModelDiscovery,
                modelMappingManager: mockModelMappingManager,
                adminAuth: null,
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry,
                isClusterWorker: false,
                getClientIp: jest.fn(() => '127.0.0.1')
            });

            const bodyStr = JSON.stringify({ key: 'test', model: 'glm-4' });
            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing/overrides',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await freshController.handleModelRoutingOverrides(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(413, expect.objectContaining({
                'content-type': 'application/json'
            }));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('Payload Too Large');

            jest.restoreAllMocks();
            jest.resetModules();
        });

        // Covers line 698: catch block in DELETE with error having custom statusCode
        it('should use custom statusCode from error in DELETE overrides', async () => {
            jest.resetModules();
            jest.doMock('../lib/content-type-validator', () => ({
                rejectNonJsonContentType: jest.fn().mockReturnValue(false)
            }));
            jest.doMock('../lib/body-parser', () => ({
                parseJsonBody: jest.fn().mockRejectedValue(Object.assign(new Error('Unsupported Media Type'), { statusCode: 415 }))
            }));

            const { ModelController: FreshController } = require('../lib/proxy/controllers/model-controller');

            const freshController = new FreshController({
                modelRouter: mockModelRouter,
                modelDiscovery: mockModelDiscovery,
                modelMappingManager: mockModelMappingManager,
                adminAuth: null,
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry,
                isClusterWorker: false,
                getClientIp: jest.fn(() => '127.0.0.1')
            });

            const bodyStr = JSON.stringify({ key: 'test' });
            const mockReq = Object.assign(new Readable(), {
                method: 'DELETE',
                url: '/model-routing/overrides',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await freshController.handleModelRoutingOverrides(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(415, expect.objectContaining({
                'content-type': 'application/json'
            }));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('Unsupported Media Type');

            jest.restoreAllMocks();
            jest.resetModules();
        });
    });

    describe('handleModelRouting PUT - error with custom statusCode (line 307)', () => {
        // Covers line 307: catch block with error having custom statusCode
        it('should use custom statusCode from error in handleModelRouting PUT', async () => {
            jest.resetModules();
            jest.doMock('../lib/content-type-validator', () => ({
                rejectNonJsonContentType: jest.fn().mockReturnValue(false)
            }));
            jest.doMock('../lib/body-parser', () => ({
                parseJsonBody: jest.fn().mockRejectedValue(Object.assign(new Error('Request Entity Too Large'), { statusCode: 413 }))
            }));

            const { ModelController: FreshController } = require('../lib/proxy/controllers/model-controller');

            const freshController = new FreshController({
                modelRouter: mockModelRouter,
                modelDiscovery: mockModelDiscovery,
                modelMappingManager: mockModelMappingManager,
                adminAuth: null,
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry,
                isClusterWorker: false,
                getClientIp: jest.fn(() => '127.0.0.1')
            });

            const bodyStr = JSON.stringify({ enabled: true });
            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await freshController.handleModelRouting(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(413, expect.objectContaining({
                'content-type': 'application/json'
            }));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('Request Entity Too Large');

            jest.restoreAllMocks();
            jest.resetModules();
        });
    });

    describe('handleModelRoutingImportFromMappings - manager without toConfig (line 809)', () => {
        // Covers line 809: manager is null or toConfig is not a function
        it('should return empty rules when manager is null', async () => {
            const noManagerController = new ModelController({
                modelRouter: mockModelRouter,
                modelDiscovery: mockModelDiscovery,
                modelMappingManager: null, // null manager
                adminAuth: null,
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry,
                isClusterWorker: false
            });

            const mockReq = {
                method: 'GET',
                url: '/model-routing/import-from-mappings',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await noManagerController.handleModelRoutingImportFromMappings(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.rules).toEqual([]);
            expect(responseData.count).toBe(0);
        });

        // Covers line 809: manager exists but toConfig is not a function
        it('should return empty rules when manager.toConfig is not a function', async () => {
            const badManagerController = new ModelController({
                modelRouter: mockModelRouter,
                modelDiscovery: mockModelDiscovery,
                modelMappingManager: { enabled: false }, // no toConfig method
                adminAuth: null,
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry,
                isClusterWorker: false
            });

            const mockReq = {
                method: 'GET',
                url: '/model-routing/import-from-mappings',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await badManagerController.handleModelRoutingImportFromMappings(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.rules).toEqual([]);
            expect(responseData.count).toBe(0);
        });
    });

    describe('handleModelRoutingEnableSafe - partial user tiers (lines 874-888)', () => {
        // Covers lines 877-885: false branches when user already provides some tiers
        it('should not override user-provided tiers when addDefaultRules is true', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({
                addDefaultRules: true,
                updates: {
                    tiers: {
                        light: { targetModel: 'my-custom-light', clientModelPolicy: 'always-route' },
                        // medium and heavy NOT provided → should get defaults
                        heavy: { targetModel: 'my-custom-heavy', clientModelPolicy: 'rule-match-only' }
                    },
                    rules: [{ match: { model: 'my-model' }, tier: 'heavy' }] // non-empty rules → no defaults added
                }
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing/enable-safe',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            jest.spyOn(ModelRouter, 'validateConfig').mockReturnValue({ valid: true });

            await controller.handleModelRoutingEnableSafe(mockReq, mockRes);

            const mergedConfig = mockModelRouter.updateConfig.mock.calls[0][0];

            // User's custom tiers should be preserved (not overridden by defaults)
            expect(mergedConfig.tiers.light.targetModel).toBe('my-custom-light');
            // Medium was NOT provided → gets default
            expect(mergedConfig.tiers.medium.targetModel).toBe('glm-4.6');
            // Heavy was provided by user → not overridden
            expect(mergedConfig.tiers.heavy.targetModel).toBe('my-custom-heavy');
            // User's rules should be preserved (no default rules added)
            expect(mergedConfig.rules).toEqual([{ match: { model: 'my-model' }, tier: 'heavy' }]);

            jest.restoreAllMocks();
        });

        // Covers lines 874-876: updates has no tiers at all
        it('should create tiers object when updates has no tiers', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({
                addDefaultRules: true,
                updates: {
                    enabled: true
                    // no tiers key at all
                }
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing/enable-safe',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            jest.spyOn(ModelRouter, 'validateConfig').mockReturnValue({ valid: true });

            await controller.handleModelRoutingEnableSafe(mockReq, mockRes);

            const mergedConfig = mockModelRouter.updateConfig.mock.calls[0][0];
            expect(mergedConfig.tiers).toBeDefined();
            expect(mergedConfig.tiers.light.targetModel).toBe('glm-4.5-air');
            expect(mergedConfig.tiers.medium.targetModel).toBe('glm-4.6');
            expect(mergedConfig.tiers.heavy.targetModel).toBe('glm-4.7');

            jest.restoreAllMocks();
        });
    });

    describe('handleModelRoutingEnableSafe - error with custom statusCode (line 945)', () => {
        // Covers line 945: catch block with error having custom statusCode
        it('should use custom statusCode from error in enable-safe', async () => {
            jest.resetModules();
            jest.doMock('../lib/content-type-validator', () => ({
                rejectNonJsonContentType: jest.fn().mockReturnValue(false)
            }));
            jest.doMock('../lib/body-parser', () => ({
                parseJsonBody: jest.fn().mockRejectedValue(Object.assign(new Error('Payload Too Large'), { statusCode: 413 }))
            }));

            const { ModelController: FreshController } = require('../lib/proxy/controllers/model-controller');

            const freshController = new FreshController({
                modelRouter: mockModelRouter,
                modelDiscovery: mockModelDiscovery,
                modelMappingManager: mockModelMappingManager,
                adminAuth: null,
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry,
                isClusterWorker: false,
                getClientIp: jest.fn(() => '127.0.0.1')
            });

            const bodyStr = JSON.stringify({ addDefaultRules: true });
            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing/enable-safe',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await freshController.handleModelRoutingEnableSafe(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(413, expect.objectContaining({
                'content-type': 'application/json'
            }));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('Payload Too Large');

            jest.restoreAllMocks();
            jest.resetModules();
        });
    });

    describe('handleModelRoutingEnableSafe - authenticated with enabled auth (line 853)', () => {
        // Covers line 853: adminAuth.enabled is true and authentication succeeds
        it('should proceed when admin auth is enabled and user is authenticated', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({
                addDefaultRules: false,
                updates: {
                    enabled: true,
                    tiers: {
                        light: { targetModel: 'glm-4-flash', models: ['glm-4-flash'], strategy: 'balanced' },
                        medium: { targetModel: 'glm-4', models: ['glm-4'], strategy: 'balanced' },
                        heavy: { targetModel: 'glm-4-plus', models: ['glm-4-plus'], strategy: 'balanced' }
                    }
                }
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing/enable-safe',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            mockAdminAuth.enabled = true;
            mockAdminAuth.authenticate.mockReturnValue({ authenticated: true });

            jest.spyOn(ModelRouter, 'validateConfig').mockReturnValue({ valid: true });

            await controller.handleModelRoutingEnableSafe(mockReq, mockRes);

            expect(mockAdminAuth.authenticate).toHaveBeenCalledWith(mockReq);
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.success).toBe(true);
            expect(responseData.message).toBe('Model routing enabled successfully');

            mockAdminAuth.enabled = false;
            jest.restoreAllMocks();
        });
    });

    describe('handleModelRouting PUT - defaultModel null fallback (line 177)', () => {
        // Covers line 177: router config has no defaultModel → null fallback
        it('should use null defaultModel when router config has no defaultModel and rules are provided', async () => {
            const { Readable } = require('stream');

            // Set router config with null defaultModel
            mockModelRouter.config.defaultModel = null;

            const bodyStr = JSON.stringify({
                rules: [{ match: { model: 'claude-*' }, tier: 'light' }]
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            // Spy on validateConfig to capture what's passed
            let capturedKeys = null;
            jest.spyOn(ModelRouter, 'validateConfig').mockImplementation((keys) => {
                capturedKeys = keys;
                return { valid: true };
            });

            await controller.handleModelRouting(mockReq, mockRes);

            // Verify defaultModel was set to null from router config (line 177 fallback)
            expect(capturedKeys).toBeDefined();
            expect(capturedKeys.rules).toBeDefined();
            expect(capturedKeys.defaultModel).toBeNull();

            jest.restoreAllMocks();
        });
    });

    describe('handleModelRoutingEnableSafe - all tiers provided by user (line 880)', () => {
        // Covers line 880: false branch when user provides all tiers including medium
        it('should not override user-provided medium tier when all tiers are specified', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({
                addDefaultRules: true,
                updates: {
                    tiers: {
                        light: { targetModel: 'custom-light', clientModelPolicy: 'always-route' },
                        medium: { targetModel: 'custom-medium', clientModelPolicy: 'always-route' },
                        heavy: { targetModel: 'custom-heavy', clientModelPolicy: 'always-route' }
                    }
                }
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing/enable-safe',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            jest.spyOn(ModelRouter, 'validateConfig').mockReturnValue({ valid: true });

            await controller.handleModelRoutingEnableSafe(mockReq, mockRes);

            const mergedConfig = mockModelRouter.updateConfig.mock.calls[0][0];
            // User's medium tier should be preserved (not replaced by default)
            expect(mergedConfig.tiers.medium.targetModel).toBe('custom-medium');
            expect(mergedConfig.tiers.light.targetModel).toBe('custom-light');
            expect(mergedConfig.tiers.heavy.targetModel).toBe('custom-heavy');

            jest.restoreAllMocks();
        });
    });

    describe('handleModelRouting PUT - error without statusCode (line 307)', () => {
        // Covers line 307: e.statusCode is falsy → use 400 fallback
        it('should use 400 fallback when error has no statusCode', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({
                rules: [{ match: { model: 'test' }, tier: 'light' }]
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            // Make validateConfig throw a regular Error (no statusCode)
            jest.spyOn(ModelRouter, 'validateConfig').mockImplementation(() => {
                throw new Error('Internal validation error');
            });

            await controller.handleModelRouting(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(400, expect.objectContaining({
                'content-type': 'application/json'
            }));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('Internal validation error');

            jest.restoreAllMocks();
        });

        // Covers line 307: e.message is falsy → use 'Invalid JSON body' fallback
        it('should use default message when error has no message', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({
                rules: [{ match: { model: 'test' }, tier: 'light' }]
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            // Throw object with statusCode but no message
            jest.spyOn(ModelRouter, 'validateConfig').mockImplementation(() => {
                throw { statusCode: 413 };
            });

            await controller.handleModelRouting(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(413, expect.objectContaining({
                'content-type': 'application/json'
            }));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('Invalid JSON body');

            jest.restoreAllMocks();
        });
    });

    describe('handleModelRoutingOverrides - error fallbacks (lines 674, 698)', () => {
        // Covers line 674: e.statusCode falsy → 400 fallback
        it('should use 400 fallback in PUT overrides when setOverride throws without statusCode', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({ key: 'test-key', model: 'glm-4' });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing/overrides',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            // Make setOverride throw a regular Error (no statusCode)
            mockModelRouter.setOverride.mockImplementationOnce(() => {
                throw new Error('Database connection failed');
            });

            await controller.handleModelRoutingOverrides(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(400, expect.objectContaining({
                'content-type': 'application/json'
            }));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('Database connection failed');
        });

        // Covers line 674: e.message falsy → 'Invalid JSON body' fallback
        it('should use default message in PUT overrides when error has no message', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({ key: 'test-key', model: 'glm-4' });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing/overrides',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            // Throw object with statusCode but no message
            mockModelRouter.setOverride.mockImplementationOnce(() => {
                throw { statusCode: 500 };
            });

            await controller.handleModelRoutingOverrides(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(500, expect.objectContaining({
                'content-type': 'application/json'
            }));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('Invalid JSON body');
        });

        // Covers line 698: e.statusCode falsy → 400 fallback
        it('should use 400 fallback in DELETE overrides when clearOverride throws without statusCode', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({ key: 'test-key' });

            const mockReq = Object.assign(new Readable(), {
                method: 'DELETE',
                url: '/model-routing/overrides',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            // Make clearOverride throw a regular Error (no statusCode)
            mockModelRouter.clearOverride.mockImplementationOnce(() => {
                throw new Error('Delete failed');
            });

            await controller.handleModelRoutingOverrides(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(400, expect.objectContaining({
                'content-type': 'application/json'
            }));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('Delete failed');
        });

        // Covers line 698: e.message falsy → 'Invalid JSON body' fallback
        it('should use default message in DELETE overrides when error has no message', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({ key: 'test-key' });

            const mockReq = Object.assign(new Readable(), {
                method: 'DELETE',
                url: '/model-routing/overrides',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            // Throw object with statusCode but no message
            mockModelRouter.clearOverride.mockImplementationOnce(() => {
                throw { statusCode: 500 };
            });

            await controller.handleModelRoutingOverrides(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(500, expect.objectContaining({
                'content-type': 'application/json'
            }));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('Invalid JSON body');
        });
    });

    describe('handleModelRoutingEnableSafe - error fallbacks (line 945)', () => {
        // Covers line 945: e.statusCode falsy → 400 fallback
        it('should use 400 fallback when validateConfig throws without statusCode', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({
                addDefaultRules: false,
                updates: {
                    enabled: true,
                    tiers: {
                        light: { targetModel: 'glm-4-flash', models: ['glm-4-flash'], strategy: 'balanced' },
                        medium: { targetModel: 'glm-4', models: ['glm-4'], strategy: 'balanced' },
                        heavy: { targetModel: 'glm-4-plus', models: ['glm-4-plus'], strategy: 'balanced' }
                    }
                }
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing/enable-safe',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            // Make validateConfig throw a regular Error (no statusCode)
            jest.spyOn(ModelRouter, 'validateConfig').mockImplementation(() => {
                throw new Error('Tier validation crashed');
            });

            await controller.handleModelRoutingEnableSafe(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(400, expect.objectContaining({
                'content-type': 'application/json'
            }));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('Tier validation crashed');

            jest.restoreAllMocks();
        });

        // Covers line 945: e.message falsy → 'Invalid request body' fallback
        it('should use default message when error has no message', async () => {
            const { Readable } = require('stream');

            const bodyStr = JSON.stringify({
                addDefaultRules: false,
                updates: {
                    enabled: true,
                    tiers: {
                        light: { targetModel: 'glm-4-flash', models: ['glm-4-flash'], strategy: 'balanced' },
                        medium: { targetModel: 'glm-4', models: ['glm-4'], strategy: 'balanced' },
                        heavy: { targetModel: 'glm-4-plus', models: ['glm-4-plus'], strategy: 'balanced' }
                    }
                }
            });

            const mockReq = Object.assign(new Readable(), {
                method: 'PUT',
                url: '/model-routing/enable-safe',
                headers: {
                    host: 'localhost',
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(bodyStr).toString()
                },
                _read() { this.push(bodyStr); this.push(null); }
            });

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            // Make validateConfig throw an object with statusCode but no message
            jest.spyOn(ModelRouter, 'validateConfig').mockImplementation(() => {
                throw { statusCode: 500 };
            });

            await controller.handleModelRoutingEnableSafe(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(500, expect.objectContaining({
                'content-type': 'application/json'
            }));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('Invalid request body');

            jest.restoreAllMocks();
        });
    });

    // DEFAULT FUNCTIONS COVERAGE - Constructor default arrow functions
    // These are on lines 45-46 and only execute when no options are provided

    describe('default modelDiscovery functions (lines 45-46)', () => {
        // Covers line 45: async () => [] default for modelDiscovery.getModels
        it('should use default getModels when modelDiscovery not provided', async () => {
            const controllerNoDiscovery = new ModelController({
                modelRouter: mockModelRouter,
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry
                // No modelDiscovery provided - should use defaults
            });

            const mockReq = {
                method: 'GET',
                url: '/models',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await controllerNoDiscovery.handleModelsRequest(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
                'content-type': 'application/json'
            }));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.models).toEqual([]);
            expect(responseData.count).toBe(0);
            expect(responseData.cacheStats).toEqual({});
        });

        // Covers line 45: async () => [] default for modelDiscovery.getModelsByTier
        it('should use default getModelsByTier when modelDiscovery not provided', async () => {
            const controllerNoDiscovery = new ModelController({
                modelRouter: mockModelRouter,
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry
                // No modelDiscovery provided - should use defaults
            });

            const mockReq = {
                method: 'GET',
                url: '/models?tier=medium',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await controllerNoDiscovery.handleModelsRequest(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
                'content-type': 'application/json'
            }));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.models).toEqual([]);
            expect(responseData.count).toBe(0);
            expect(responseData.cacheStats).toEqual({});
        });

        // Covers line 45: () => ({}) default for modelDiscovery.getCacheStats
        it('should use default getCacheStats when modelDiscovery not provided', async () => {
            const controllerNoDiscovery = new ModelController({
                modelRouter: mockModelRouter,
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry
                // No modelDiscovery provided - should use defaults
            });

            const mockReq = {
                method: 'GET',
                url: '/models',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await controllerNoDiscovery.handleModelsRequest(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            // getCacheStats is called in handleModelsRequest (line 342)
            expect(responseData.cacheStats).toBeDefined();
            expect(responseData.cacheStats).toEqual({});
        });
    });

    describe('default modelMappingManager functions (line 46)', () => {
        // Covers line 46: () => [] default for modelMappingManager.getKeyOverrides
        it('should use default getKeyOverrides when modelMappingManager not provided', async () => {
            const controllerNoMapping = new ModelController({
                modelRouter: mockModelRouter,
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry
                // No modelMappingManager provided - should use defaults
            });

            const mockReq = {
                method: 'GET',
                url: '/model-mapping',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await controllerNoMapping.handleModelMapping(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
                'content-type': 'application/json'
            }));

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            // getKeyOverrides is called in handleModelMapping (line 411)
            expect(responseData.keyOverrides).toBeDefined();
            expect(responseData.keyOverrides).toEqual([]);
        });

        // Covers line 46: () => ({}) default for modelMappingManager.toConfig
        it('should use default toConfig when modelMappingManager not provided', async () => {
            const controllerNoMapping = new ModelController({
                modelRouter: mockModelRouter,
                logger: mockLogger,
                addAuditEntry: mockAddAuditEntry
                // No modelMappingManager provided - should use defaults
            });

            const mockReq = {
                method: 'GET',
                url: '/model-mapping',
                headers: { host: 'localhost' }
            };

            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                headersSent: false
            };

            await controllerNoMapping.handleModelMapping(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            // toConfig is called in handleModelMapping (line 410)
            expect(responseData.config).toBeDefined();
            expect(responseData.config).toEqual({});
        });
    });
});
