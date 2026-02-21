/**
 * Unit Test: Keys Controller
 *
 * TDD Phase: Red - Write failing unit test before module exists
 *
 * Tests the KeysController class for proxy-server.js key-related routes.
 */

'use strict';

let KeysController;
try {
    ({ KeysController } = require('../../../lib/proxy/controllers/keys-controller'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = KeysController ? describe : describe.skip;

describeIfModule('keys-controller', () => {
    let controller;
    let mockKeyManager;
    let mockRedact;

    beforeEach(() => {
        mockKeyManager = {
            keys: [
                { index: 0, key: 'sk-test1', tier: 'free', model: 'glm-4' },
                { index: 1, key: 'sk-test2', tier: 'premium', model: 'glm-4' }
            ],
            getStats: jest.fn(() => [
                { index: 0, key: 'sk-test1', tier: 'free', model: 'glm-4' },
                { index: 1, key: 'sk-test2', tier: 'premium', model: 'glm-4' }
            ]),
            getSchedulerStats: jest.fn(() => ({
                perKeyStats: {
                    0: { selectionCount: 50, lastSelected: Date.now() },
                    1: { selectionCount: 75, lastSelected: Date.now() - 1000 }
                }
            })),
            getKeyLatencyHistogram: jest.fn((index, range) => ({
                keyIndex: index,
                range,
                p50: 100,
                p95: 200,
                p99: 300
            }))
        };

        mockRedact = jest.fn((data, options) => ({
            ...data,
            _redacted: true
        }));

        controller = new KeysController({
            keyManager: mockKeyManager,
            redactSensitiveData: mockRedact
        });
    });

    describe('constructor', () => {
        it('should create a new KeysController', () => {
            expect(controller).toBeInstanceOf(KeysController);
        });

        it('should initialize with provided dependencies', () => {
            expect(controller._keyManager).toBe(mockKeyManager);
            expect(controller._redactSensitiveData).toBe(mockRedact);
        });

        it('should initialize with default values when options omitted', () => {
            const minimalController = new KeysController();
            expect(minimalController).toBeInstanceOf(KeysController);
        });
    });

    describe('handleDebugKeys', () => {
        it('should call getStats on keyManager', () => {
            const mockReq = { url: '/debug/keys', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleDebugKeys(mockReq, mockRes);

            expect(mockKeyManager.getStats).toHaveBeenCalled();
        });

        it('should call getSchedulerStats on keyManager', () => {
            const mockReq = { url: '/debug/keys', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleDebugKeys(mockReq, mockRes);

            expect(mockKeyManager.getSchedulerStats).toHaveBeenCalled();
        });

        it('should return 200 with content-type application/json', () => {
            const mockReq = { url: '/debug/keys', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleDebugKeys(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
        });

        it('should include timestamp in response', () => {
            const mockReq = { url: '/debug/keys', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleDebugKeys(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('timestamp');
        });

        it('should include count in response', () => {
            const mockReq = { url: '/debug/keys', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleDebugKeys(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('count');
        });

        it('should include keys array in response', () => {
            const mockReq = { url: '/debug/keys', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleDebugKeys(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('keys');
            expect(Array.isArray(responseData.keys)).toBe(true);
        });

        it('should include scheduler info in response', () => {
            const mockReq = { url: '/debug/keys', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleDebugKeys(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('scheduler');
        });

        it('should redact sensitive data', () => {
            const mockReq = { url: '/debug/keys', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleDebugKeys(mockReq, mockRes);

            expect(mockRedact).toHaveBeenCalledWith(
                expect.objectContaining({
                    keys: expect.any(Array)
                }),
                expect.objectContaining({
                    redactBodies: true,
                    redactHeaders: true
                })
            );
        });
    });

    describe('handleKeyLatencyHistogram', () => {
        it('should return 404 when path does not match pattern', () => {
            const mockReq = { url: '/stats/latency-histogram/', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleKeyLatencyHistogram(mockReq, mockRes, '/stats/latency-histogram/');

            expect(mockRes.writeHead).toHaveBeenCalledWith(404, { 'content-type': 'application/json' });
        });

        it('should return 400 when key index is out of bounds', () => {
            const mockReq = { url: '/stats/latency-histogram/999', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleKeyLatencyHistogram(mockReq, mockRes, '/stats/latency-histogram/999');

            expect(mockRes.writeHead).toHaveBeenCalledWith(400, { 'content-type': 'application/json' });
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toContain('Invalid key index');
        });

        it('should extract key index from path', () => {
            const mockReq = { url: '/stats/latency-histogram/0', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleKeyLatencyHistogram(mockReq, mockRes, '/stats/latency-histogram/0');

            expect(mockKeyManager.getKeyLatencyHistogram).toHaveBeenCalledWith(0, '15m');
        });

        it('should use default range of 15m when not specified', () => {
            const mockReq = { url: '/stats/latency-histogram/0', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleKeyLatencyHistogram(mockReq, mockRes, '/stats/latency-histogram/0');

            expect(mockKeyManager.getKeyLatencyHistogram).toHaveBeenCalledWith(0, '15m');
        });

        it('should parse range from query parameter', () => {
            const mockReq = { url: '/stats/latency-histogram/0?range=1h', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleKeyLatencyHistogram(mockReq, mockRes, '/stats/latency-histogram/0');

            expect(mockKeyManager.getKeyLatencyHistogram).toHaveBeenCalledWith(0, '1h');
        });

        it('should return 404 when histogram not found', () => {
            mockKeyManager.getKeyLatencyHistogram.mockReturnValueOnce(null);

            const mockReq = { url: '/stats/latency-histogram/0', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleKeyLatencyHistogram(mockReq, mockRes, '/stats/latency-histogram/0');

            expect(mockRes.writeHead).toHaveBeenCalledWith(404, { 'content-type': 'application/json' });
        });

        it('should return 200 with histogram data when found', () => {
            const mockReq = { url: '/stats/latency-histogram/0', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleKeyLatencyHistogram(mockReq, mockRes, '/stats/latency-histogram/0');

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
        });

        it('should return histogram with keyIndex', () => {
            const mockReq = { url: '/stats/latency-histogram/1', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleKeyLatencyHistogram(mockReq, mockRes, '/stats/latency-histogram/1');

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.keyIndex).toBe(1);
        });
    });

    describe('interface contract', () => {
        it('should have handleDebugKeys method', () => {
            expect(typeof controller.handleDebugKeys).toBe('function');
        });

        it('should have handleKeyLatencyHistogram method', () => {
            expect(typeof controller.handleKeyLatencyHistogram).toBe('function');
        });
    });

    describe('edge cases', () => {
        it('should handle missing keyManager gracefully in handleDebugKeys', () => {
            controller._keyManager = null;

            const mockReq = { url: '/debug/keys', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            expect(() => controller.handleDebugKeys(mockReq, mockRes)).not.toThrow();
        });

        it('should handle missing keyManager gracefully in handleKeyLatencyHistogram', () => {
            controller._keyManager = { keys: [] };

            const mockReq = { url: '/stats/latency-histogram/0', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            expect(() => controller.handleKeyLatencyHistogram(mockReq, mockRes, '/stats/latency-histogram/0')).not.toThrow();
        });
    });
});
