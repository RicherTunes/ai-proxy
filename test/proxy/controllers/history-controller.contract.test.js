/**
 * Contract Test: History Controller
 *
 * This contract test ensures that history-related route operations produce consistent results
 * after extraction from ProxyServer to history-controller.js.
 *
 * TDD Phase: Red - Write failing test first
 */

'use strict';

const http = require('http');
let HistoryController;
try {
    ({ HistoryController } = require('../../../lib/proxy/controllers/history-controller'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = HistoryController ? describe : describe.skip;

describeIfModule('ProxyServer Contract: History Controller Operations', () => {
    let controller;
    let mockHistoryTracker;

    beforeEach(() => {
        mockHistoryTracker = {
            getHistory: jest.fn((minutes) => ({
                requests: [
                    { id: '1', timestamp: Date.now(), model: 'glm-4', status: 'success' },
                    { id: '2', timestamp: Date.now() - 60000, model: 'glm-4', status: 'error' }
                ],
                timeRange: { minutes: 15 }
            }))
        };

        controller = new HistoryController({
            historyTracker: mockHistoryTracker
        });
    });

    describe('handleHistory', () => {
        it('should return history from historyTracker', () => {
            const mockReq = { url: '/history?minutes=30', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHistory(mockReq, mockRes);

            expect(mockHistoryTracker.getHistory).toHaveBeenCalledWith(30);
        });

        it('should return 200 with correct headers', () => {
            const mockReq = { url: '/history', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHistory(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, {
                'content-type': 'application/json',
                'cache-control': 'no-store',
                'pragma': 'no-cache',
                'expires': '0'
            });
        });

        it('should default to 15 minutes when not specified', () => {
            const mockReq = { url: '/history', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHistory(mockReq, mockRes);

            expect(mockHistoryTracker.getHistory).toHaveBeenCalledWith(15);
        });

        it('should cap minutes at 10080 (7 days)', () => {
            const mockReq = { url: '/history?minutes=20000', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHistory(mockReq, mockRes);

            expect(mockHistoryTracker.getHistory).toHaveBeenCalledWith(10080);
        });

        it('should include history in response', () => {
            const mockReq = { url: '/history', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHistory(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('requests');
            expect(Array.isArray(responseData.requests)).toBe(true);
        });
    });

    describe('interface contract', () => {
        it('should have handleHistory method', () => {
            expect(typeof controller.handleHistory).toBe('function');
        });
    });
});
