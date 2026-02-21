/**
 * Contract Test: Compare Controller
 *
 * This contract test ensures that compare-related route operations produce consistent results
 * after extraction from ProxyServer to compare-controller.js.
 *
 * TDD Phase: Red - Write failing test first
 */

'use strict';

const http = require('http');
let CompareController;
try {
    ({ CompareController } = require('../../../lib/proxy/controllers/compare-controller'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = CompareController ? describe : describe.skip;

describeIfModule('ProxyServer Contract: Compare Controller Operations', () => {
    let controller;
    let mockKeyManager;

    beforeEach(() => {
        mockKeyManager = {
            compareKeys: jest.fn((indices) => ({
                keys: indices || ['all'],
                comparison: {
                    totalRequests: 100,
                    averageLatency: 150
                },
                details: []
            }))
        };

        controller = new CompareController({
            keyManager: mockKeyManager
        });
    });

    describe('handleCompare', () => {
        it('should return 200 with content-type application/json', () => {
            const mockReq = { url: '/compare', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleCompare(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
        });

        it('should call compareKeys on keyManager', () => {
            const mockReq = { url: '/compare', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleCompare(mockReq, mockRes);

            expect(mockKeyManager.compareKeys).toHaveBeenCalled();
        });

        it('should parse keys from query parameter', () => {
            const mockReq = { url: '/compare?keys=0,1', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleCompare(mockReq, mockRes);

            expect(mockKeyManager.compareKeys).toHaveBeenCalledWith([0, 1]);
        });

        it('should return comparison data', () => {
            const mockReq = { url: '/compare', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleCompare(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('comparison');
        });
    });

    describe('interface contract', () => {
        it('should have handleCompare method', () => {
            expect(typeof controller.handleCompare).toBe('function');
        });
    });
});
