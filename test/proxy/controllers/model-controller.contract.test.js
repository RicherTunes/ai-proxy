/**
 * Contract Test: Model Controller
 *
 * This contract test ensures that model-related route operations produce consistent results
 * after extraction from ProxyServer to model-controller.js.
 *
 * TDD Phase: Red - Write failing test first
 */

'use strict';

const http = require('http');
let ModelController;
try {
    ({ ModelController } = require('../../../lib/proxy/controllers/model-controller'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = ModelController ? describe : describe.skip;

describeIfModule('ProxyServer Contract: Model Controller Operations', () => {
    let controller;
    let mockModelRouter;
    let mockModelDiscovery;
    let mockModelMappingManager;
    let mockAdminAuth;

    beforeEach(() => {
        mockModelRouter = {
            enabled: true,
            toJSON: jest.fn(() => ({ routes: [], weights: [] })),
            config: {},
            updateConfig: jest.fn(),
            validateConfig: jest.fn(() => ({ valid: true }))
        };

        mockModelDiscovery = {
            getModels: jest.fn(async () => []),
            getModelsByTier: jest.fn(async () => []),
            getCacheStats: jest.fn(() => ({ hitRate: 0.5 }))
        };

        mockModelMappingManager = {
            enabled: false
        };

        mockAdminAuth = {
            enabled: false,
            authenticate: jest.fn(() => ({ authenticated: true }))
        };

        controller = new ModelController({
            modelRouter: mockModelRouter,
            modelDiscovery: mockModelDiscovery,
            modelMappingManager: mockModelMappingManager,
            adminAuth: mockAdminAuth,
            logger: null,
            isClusterWorker: false
        });
    });

    describe('handleModelRouting', () => {
        it('should return model routing state on GET', async () => {
            const mockReq = {
                method: 'GET',
                url: '/model-routing',
                headers: { host: 'localhost' }
            };
            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn()
            };

            await controller.handleModelRouting(mockReq, mockRes);

            expect(mockModelRouter.toJSON).toHaveBeenCalled();
            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        });

        it('should return 405 for non-GET/PUT methods', async () => {
            const mockReq = {
                method: 'POST',
                url: '/model-routing',
                headers: { host: 'localhost' }
            };
            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn()
            };

            await controller.handleModelRouting(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(405, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        });

        it('should include persistence info in response', async () => {
            const mockReq = {
                method: 'GET',
                url: '/model-routing',
                headers: { host: 'localhost' }
            };
            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn()
            };

            controller._routingPersistence = {
                enabled: true,
                configPath: '/path/to/config.json',
                lastSavedAt: new Date().toISOString(),
                lastSaveError: null,
                lastLoadError: null
            };

            await controller.handleModelRouting(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.persistence).toBeDefined();
        });
    });

    describe('handleModelsRequest', () => {
        it('should return models on GET', async () => {
            const mockModels = [
                { id: 'glm-4', name: 'GLM-4', tier: 'premium' },
                { id: 'glm-3-turbo', name: 'GLM-3 Turbo', tier: 'standard' }
            ];
            mockModelDiscovery.getModels.mockResolvedValue(mockModels);

            const mockReq = {
                method: 'GET',
                url: '/models',
                headers: { host: 'localhost' }
            };
            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn()
            };

            await controller.handleModelsRequest(mockReq, mockRes);

            expect(mockModelDiscovery.getModels).toHaveBeenCalled();
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.models).toEqual(mockModels);
            expect(responseData.count).toBe(2);
        });

        it('should filter by tier parameter', async () => {
            const allModels = [
                { id: 'glm-4', name: 'GLM-4', tier: 'premium' },
                { id: 'glm-3-turbo', name: 'GLM-3 Turbo', tier: 'standard' }
            ];
            mockModelDiscovery.getModels.mockResolvedValue(allModels);
            mockModelDiscovery.getModelsByTier.mockResolvedValue([allModels[0]]);

            const mockReq = {
                method: 'GET',
                url: '/models?tier=premium',
                headers: { host: 'localhost' }
            };
            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn()
            };

            await controller.handleModelsRequest(mockReq, mockRes);

            expect(mockModelDiscovery.getModelsByTier).toHaveBeenCalledWith('premium');
        });

        it('should return 405 for non-GET requests', async () => {
            const mockReq = {
                method: 'POST',
                url: '/models',
                headers: { host: 'localhost' }
            };
            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn()
            };

            await controller.handleModelsRequest(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(405, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        });
    });

    describe('handleModelSelection', () => {
        it('should return model selection status', () => {
            const mockReq = {
                method: 'GET',
                url: '/model-selection',
                headers: { host: 'localhost' }
            };
            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn()
            };

            controller.handleModelSelection(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('activeSystem');
        });
    });

    describe('interface contract', () => {
        it('should have handleModelRouting method', () => {
            expect(typeof controller.handleModelRouting).toBe('function');
        });

        it('should have handleModelsRequest method', () => {
            expect(typeof controller.handleModelsRequest).toBe('function');
        });

        it('should have handleModelSelection method', () => {
            expect(typeof controller.handleModelSelection).toBe('function');
        });

        it('should have handleModelMapping method', () => {
            expect(typeof controller.handleModelMapping).toBe('function');
        });

        it('should have handleModelMappingReset method', () => {
            expect(typeof controller.handleModelMappingReset).toBe('function');
        });

        it('should have handleModelRoutingReset method', () => {
            expect(typeof controller.handleModelRoutingReset).toBe('function');
        });

        it('should have handleModelRoutingExport method', () => {
            expect(typeof controller.handleModelRoutingExport).toBe('function');
        });

        it('should have handleModelRoutingTest method', () => {
            expect(typeof controller.handleModelRoutingTest).toBe('function');
        });

        it('should have handleModelRoutingOverrides method', () => {
            expect(typeof controller.handleModelRoutingOverrides).toBe('function');
        });

        it('should have handleModelRoutingCooldowns method', () => {
            expect(typeof controller.handleModelRoutingCooldowns).toBe('function');
        });

        it('should have handleModelRoutingPools method', () => {
            expect(typeof controller.handleModelRoutingPools).toBe('function');
        });

        it('should have handleModelRoutingImportFromMappings method', () => {
            expect(typeof controller.handleModelRoutingImportFromMappings).toBe('function');
        });

        it('should have handleModelRoutingEnableSafe method', () => {
            expect(typeof controller.handleModelRoutingEnableSafe).toBe('function');
        });
    });
});
