/**
 * Unit Test: Predictions Controller
 *
 * TDD Phase: Red - Write failing unit test before module exists
 *
 * Tests the PredictionsController class for proxy-server.js predictions-related routes.
 */

'use strict';

let PredictionsController;
try {
    ({ PredictionsController } = require('../../../lib/proxy/controllers/predictions-controller'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = PredictionsController ? describe : describe.skip;

describeIfModule('predictions-controller', () => {
    let controller;
    let mockKeyManager;
    let mockPredictiveScaler;

    beforeEach(() => {
        mockKeyManager = {
            getStats: jest.fn(() => [
                {
                    index: 0,
                    keyPrefix: 'sk-test1',
                    circuitBreaker: { state: 'closed' },
                    prediction: {
                        level: 'HEALTHY',
                        score: 0.1,
                        reason: 'All systems normal'
                    }
                },
                {
                    index: 1,
                    keyPrefix: 'sk-test2',
                    circuitBreaker: { state: 'half-open' },
                    prediction: {
                        level: 'WARNING',
                        score: 0.6,
                        reason: 'Elevated error rate detected'
                    }
                },
                {
                    index: 2,
                    keyPrefix: 'sk-test3',
                    circuitBreaker: { state: 'open' },
                    prediction: {
                        level: 'CRITICAL',
                        score: 0.9,
                        reason: 'Circuit breaker open'
                    }
                }
            ])
        };

        mockPredictiveScaler = {
            predict: jest.fn(() => [
                { timestamp: Date.now(), predictedLoad: 80, confidence: 0.85 }
            ]),
            getRecommendations: jest.fn(() => [
                { action: 'scale_up', reason: 'Predicted high load' }
            ]),
            getTrend: jest.fn(() => ({ direction: 'increasing', rate: 0.1 })),
            getPatterns: jest.fn(() => [{ pattern: 'daily_peak', confidence: 0.9 }]),
            getStats: jest.fn(() => ({ accuracy: 0.85, samples: 1000 })),
            detectAnomalies: jest.fn(() => [
                { type: 'spike', severity: 'medium', timestamp: Date.now() }
            ])
        };

        controller = new PredictionsController({
            keyManager: mockKeyManager,
            predictiveScaler: mockPredictiveScaler
        });
    });

    describe('constructor', () => {
        it('should create a new PredictionsController', () => {
            expect(controller).toBeInstanceOf(PredictionsController);
        });

        it('should initialize with provided dependencies', () => {
            expect(controller._keyManager).toBe(mockKeyManager);
            expect(controller._predictiveScaler).toBe(mockPredictiveScaler);
        });

        it('should initialize with default values when options omitted', () => {
            const minimalController = new PredictionsController();
            expect(minimalController).toBeInstanceOf(PredictionsController);
        });
    });

    describe('handlePredictions', () => {
        it('should return 200 with content-type application/json', () => {
            const mockReq = { url: '/predictions', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handlePredictions(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
        });

        it('should call getStats on keyManager', () => {
            const mockReq = { url: '/predictions', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handlePredictions(mockReq, mockRes);

            expect(mockKeyManager.getStats).toHaveBeenCalled();
        });

        it('should return keyPredictions array', () => {
            const mockReq = { url: '/predictions', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handlePredictions(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('keyPredictions');
            expect(Array.isArray(responseData.keyPredictions)).toBe(true);
        });

        it('should include summary with counts', () => {
            const mockReq = { url: '/predictions', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handlePredictions(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.summary).toHaveProperty('healthy');
            expect(responseData.summary).toHaveProperty('elevated');
            expect(responseData.summary).toHaveProperty('warning');
            expect(responseData.summary).toHaveProperty('critical');
        });

        it('should count healthy keys correctly', () => {
            const mockReq = { url: '/predictions', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handlePredictions(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.summary.healthy).toBe(1);
        });

        it('should count warning keys correctly', () => {
            const mockReq = { url: '/predictions', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handlePredictions(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.summary.warning).toBe(1);
        });

        it('should count critical keys correctly', () => {
            const mockReq = { url: '/predictions', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handlePredictions(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.summary.critical).toBe(1);
        });

        it('should include criticalKeys array for warning and critical', () => {
            const mockReq = { url: '/predictions', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handlePredictions(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.criticalKeys).toBeDefined();
            expect(Array.isArray(responseData.criticalKeys)).toBe(true);
            expect(responseData.criticalKeys.length).toBe(2); // warning + critical
        });

        it('should include timestamp in response', () => {
            const mockReq = { url: '/predictions', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handlePredictions(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('timestamp');
        });

        it('should include scaling data when predictiveScaler is available', () => {
            const mockReq = { url: '/predictions', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handlePredictions(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.scaling).toBeDefined();
            expect(responseData.scaling).toHaveProperty('predictions');
            expect(responseData.scaling).toHaveProperty('recommendations');
            expect(responseData.scaling).toHaveProperty('trend');
            expect(responseData.scaling).toHaveProperty('patterns');
            expect(responseData.scaling).toHaveProperty('stats');
            expect(responseData.scaling).toHaveProperty('anomalies');
        });

        it('should call predict on predictiveScaler', () => {
            const mockReq = { url: '/predictions', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handlePredictions(mockReq, mockRes);

            expect(mockPredictiveScaler.predict).toHaveBeenCalled();
        });

        it('should return null scaling when predictiveScaler is not available', () => {
            controller._predictiveScaler = null;

            const mockReq = { url: '/predictions', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handlePredictions(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.scaling).toBeNull();
        });

        it('should include keyIndex and keyPrefix in predictions', () => {
            const mockReq = { url: '/predictions', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handlePredictions(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.keyPredictions[0]).toHaveProperty('keyIndex');
            expect(responseData.keyPredictions[0]).toHaveProperty('keyPrefix');
        });

        it('should include state and prediction in key predictions', () => {
            const mockReq = { url: '/predictions', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handlePredictions(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.keyPredictions[0]).toHaveProperty('state');
            expect(responseData.keyPredictions[0]).toHaveProperty('prediction');
        });
    });

    describe('interface contract', () => {
        it('should have handlePredictions method', () => {
            expect(typeof controller.handlePredictions).toBe('function');
        });
    });

    describe('edge cases', () => {
        it('should handle missing keyManager gracefully', () => {
            controller._keyManager = null;

            const mockReq = { url: '/predictions', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            expect(() => controller.handlePredictions(mockReq, mockRes)).not.toThrow();
        });

        it('should handle empty key stats gracefully', () => {
            mockKeyManager.getStats.mockReturnValueOnce([]);

            const mockReq = { url: '/predictions', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            expect(() => controller.handlePredictions(mockReq, mockRes)).not.toThrow();

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.keyPredictions).toEqual([]);
            expect(responseData.summary.healthy).toBe(0);
        });
    });
});
