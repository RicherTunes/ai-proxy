/**
 * Contract Test: Keys Controller
 *
 * This contract test ensures that key-related route operations produce consistent results
 * after extraction from ProxyServer to keys-controller.js.
 *
 * TDD Phase: Red - Write failing test first
 */

'use strict';

const http = require('http');
let KeysController;
try {
    ({ KeysController } = require('../../../lib/proxy/controllers/keys-controller'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = KeysController ? describe : describe.skip;

describeIfModule('ProxyServer Contract: Keys Controller Operations', () => {
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
                    0: { selectionCount: 50, lastSelected: Date.now() }
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

        it('should include keys array with scheduler info in response', () => {
            const mockReq = { url: '/debug/keys', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleDebugKeys(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.keys).toBeDefined();
            expect(Array.isArray(responseData.keys)).toBe(true);
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

        it('should extract key index from path and get histogram', () => {
            const mockReq = { url: '/stats/latency-histogram/0', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleKeyLatencyHistogram(mockReq, mockRes, '/stats/latency-histogram/0');

            expect(mockKeyManager.getKeyLatencyHistogram).toHaveBeenCalledWith(0, '15m');
        });

        it('should return 400 when key index is out of bounds', () => {
            const mockReq = { url: '/stats/latency-histogram/999', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleKeyLatencyHistogram(mockReq, mockRes, '/stats/latency-histogram/999');

            expect(mockRes.writeHead).toHaveBeenCalledWith(400, { 'content-type': 'application/json' });
        });

        it('should return 200 with histogram data when found', () => {
            const mockReq = { url: '/stats/latency-histogram/0', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleKeyLatencyHistogram(mockReq, mockRes, '/stats/latency-histogram/0');

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
        });

        it('should include histogram percentiles in response', () => {
            const mockReq = { url: '/stats/latency-histogram/0', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleKeyLatencyHistogram(mockReq, mockRes, '/stats/latency-histogram/0');

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('p50');
            expect(responseData).toHaveProperty('p95');
            expect(responseData).toHaveProperty('p99');
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
});
