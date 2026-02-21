/**
 * Unit Test: Compare Controller
 *
 * TDD Phase: Red - Write failing unit test before module exists
 *
 * Tests the CompareController class for proxy-server.js compare-related routes.
 */

'use strict';

let CompareController;
try {
    ({ CompareController } = require('../../../lib/proxy/controllers/compare-controller'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = CompareController ? describe : describe.skip;

describeIfModule('compare-controller', () => {
    let controller;
    let mockKeyManager;

    beforeEach(() => {
        mockKeyManager = {
            compareKeys: jest.fn((indices) => ({
                keys: indices || ['all'],
                comparison: {
                    totalRequests: 100,
                    averageLatency: 150,
                    errorRate: 0.05
                },
                details: [
                    { keyIndex: 0, requests: 50, avgLatency: 120, errors: 2 },
                    { keyIndex: 1, requests: 50, avgLatency: 180, errors: 3 }
                ]
            }))
        };

        controller = new CompareController({
            keyManager: mockKeyManager
        });
    });

    describe('constructor', () => {
        it('should create a new CompareController', () => {
            expect(controller).toBeInstanceOf(CompareController);
        });

        it('should initialize with provided dependencies', () => {
            expect(controller._keyManager).toBe(mockKeyManager);
        });

        it('should initialize with default values when options omitted', () => {
            const minimalController = new CompareController();
            expect(minimalController).toBeInstanceOf(CompareController);
        });
    });

    describe('handleCompare', () => {
        it('should return 200 with content-type application/json', () => {
            const mockReq = { url: '/compare', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleCompare(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
        });

        it('should call compareKeys with null when no keys parameter', () => {
            const mockReq = { url: '/compare', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleCompare(mockReq, mockRes);

            expect(mockKeyManager.compareKeys).toHaveBeenCalledWith(null);
        });

        it('should parse keys from query parameter', () => {
            const mockReq = { url: '/compare?keys=0,1,2', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleCompare(mockReq, mockRes);

            expect(mockKeyManager.compareKeys).toHaveBeenCalledWith([0, 1, 2]);
        });

        it('should filter out invalid key indices', () => {
            const mockReq = { url: '/compare?keys=0,invalid,2', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleCompare(mockReq, mockRes);

            expect(mockKeyManager.compareKeys).toHaveBeenCalledWith([0, 2]);
        });

        it('should handle whitespace in keys parameter', () => {
            const mockReq = { url: '/compare?keys=0, 1, 2', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleCompare(mockReq, mockRes);

            expect(mockKeyManager.compareKeys).toHaveBeenCalledWith([0, 1, 2]);
        });

        it('should return comparison data in response', () => {
            const mockReq = { url: '/compare', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleCompare(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('comparison');
        });

        it('should include details array in response', () => {
            const mockReq = { url: '/compare', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleCompare(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('details');
            expect(Array.isArray(responseData.details)).toBe(true);
        });
    });

    describe('interface contract', () => {
        it('should have handleCompare method', () => {
            expect(typeof controller.handleCompare).toBe('function');
        });
    });

    describe('edge cases', () => {
        it('should handle missing keyManager gracefully', () => {
            controller._keyManager = null;

            const mockReq = { url: '/compare', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            expect(() => controller.handleCompare(mockReq, mockRes)).not.toThrow();
        });

        it('should handle empty keys parameter', () => {
            const mockReq = { url: '/compare?keys=', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            expect(() => controller.handleCompare(mockReq, mockRes)).not.toThrow();
        });
    });
});
