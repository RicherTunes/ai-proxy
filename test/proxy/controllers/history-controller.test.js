/**
 * Unit Test: History Controller
 *
 * TDD Phase: Red - Write failing unit test before module exists
 *
 * Tests the HistoryController class for proxy-server.js history-related routes.
 */

'use strict';

let HistoryController;
try {
    ({ HistoryController } = require('../../../lib/proxy/controllers/history-controller'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = HistoryController ? describe : describe.skip;

describeIfModule('history-controller', () => {
    let controller;
    let mockHistoryTracker;

    beforeEach(() => {
        mockHistoryTracker = {
            getHistory: jest.fn((minutes) => ({
                requests: [
                    { id: '1', timestamp: Date.now(), model: 'glm-4', status: 'success' },
                    { id: '2', timestamp: Date.now() - 60000, model: 'glm-4', status: 'error' }
                ],
                timeRange: { minutes }
            }))
        };

        controller = new HistoryController({
            historyTracker: mockHistoryTracker
        });
    });

    describe('constructor', () => {
        it('should create a new HistoryController', () => {
            expect(controller).toBeInstanceOf(HistoryController);
        });

        it('should initialize with provided dependencies', () => {
            expect(controller._historyTracker).toBe(mockHistoryTracker);
        });

        it('should initialize with default values when options omitted', () => {
            const minimalController = new HistoryController();
            expect(minimalController).toBeInstanceOf(HistoryController);
        });
    });

    describe('handleHistory', () => {
        it('should return 200 with content-type application/json', () => {
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

        it('should call getHistory with minutes from query param', () => {
            const mockReq = { url: '/history?minutes=60', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHistory(mockReq, mockRes);

            expect(mockHistoryTracker.getHistory).toHaveBeenCalledWith(60);
        });

        it('should default to 15 minutes when not specified', () => {
            const mockReq = { url: '/history', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHistory(mockReq, mockRes);

            expect(mockHistoryTracker.getHistory).toHaveBeenCalledWith(15);
        });

        it('should handle invalid minutes by defaulting to 15', () => {
            const mockReq = { url: '/history?minutes=invalid', headers: { host: 'localhost' } };
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

        it('should return history from tracker', () => {
            const mockReq = { url: '/history', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHistory(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('requests');
            expect(Array.isArray(responseData.requests)).toBe(true);
        });

        it('should include timeRange in response', () => {
            const mockReq = { url: '/history?minutes=60', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHistory(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('timeRange');
            expect(responseData.timeRange.minutes).toBe(60);
        });
    });

    describe('interface contract', () => {
        it('should have handleHistory method', () => {
            expect(typeof controller.handleHistory).toBe('function');
        });
    });

    describe('edge cases', () => {
        it('should handle missing historyTracker gracefully', () => {
            controller._historyTracker = null;

            const mockReq = { url: '/history', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleHistory(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toBeDefined();
        });
    });
});
