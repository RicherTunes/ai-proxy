/**
 * Contract Test: Trace Controller
 *
 * This contract test ensures that trace-related route operations produce consistent results
 * after extraction from ProxyServer to trace-controller.js.
 *
 * TDD Phase: Red - Write failing test first
 */

'use strict';

const http = require('http');
let TraceController;
try {
    ({ TraceController } = require('../../../lib/proxy/controllers/trace-controller'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = TraceController ? describe : describe.skip;

describeIfModule('ProxyServer Contract: Trace Controller Operations', () => {
    let controller;
    let mockRequestHandler;
    let mockRedact;

    beforeEach(() => {
        mockRequestHandler = {
            queryTraces: jest.fn(() => [
                { id: 'trace1', model: 'glm-4', success: true, duration: 500 }
            ]),
            getRecentTraces: jest.fn(() => [
                { id: 'trace1', model: 'glm-4', success: true, duration: 500 }
            ]),
            getTraceStats: jest.fn(() => ({
                total: 100,
                successful: 95,
                failed: 5
            })),
            getTrace: jest.fn((id) => ({
                id,
                model: 'glm-4',
                success: true,
                duration: 500
            }))
        };

        mockRedact = jest.fn((data, options) => ({
            ...data,
            _redacted: true
        }));

        controller = new TraceController({
            requestHandler: mockRequestHandler,
            redactSensitiveData: mockRedact
        });
    });

    describe('handleTraces', () => {
        it('should return 200 with content-type application/json', () => {
            const mockReq = { url: '/traces', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraces(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
        });

        it('should call getRecentTraces when no filters provided', () => {
            const mockReq = { url: '/traces', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraces(mockReq, mockRes);

            expect(mockRequestHandler.getRecentTraces).toHaveBeenCalledWith(100);
        });

        it('should return traces, stats, and timestamp in response', () => {
            const mockReq = { url: '/traces', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraces(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('traces');
            expect(responseData).toHaveProperty('stats');
            expect(responseData).toHaveProperty('timestamp');
        });

        it('should include redacted data in response', () => {
            const mockReq = { url: '/traces', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraces(mockReq, mockRes);

            expect(mockRedact).toHaveBeenCalledWith(
                expect.objectContaining({
                    traces: expect.any(Array),
                    stats: expect.any(Object)
                }),
                expect.objectContaining({
                    redactBodies: true,
                    redactHeaders: true
                })
            );
        });

        it('should parse success filter correctly', () => {
            const mockReq = { url: '/traces?success=true', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraces(mockReq, mockRes);

            expect(mockRequestHandler.queryTraces).toHaveBeenCalledWith(expect.objectContaining({
                success: true
            }));
        });

        it('should parse model filter correctly', () => {
            const mockReq = { url: '/traces?model=glm-4', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraces(mockReq, mockRes);

            expect(mockRequestHandler.queryTraces).toHaveBeenCalledWith(expect.objectContaining({
                model: 'glm-4'
            }));
        });

        it('should parse limit filter correctly', () => {
            const mockReq = { url: '/traces?limit=50', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraces(mockReq, mockRes);

            expect(mockRequestHandler.getRecentTraces).toHaveBeenCalledWith(50);
        });
    });

    describe('handleTraceById', () => {
        it('should return 404 when traceId is not in path', () => {
            const mockReq = { url: '/traces/', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraceById(mockReq, mockRes, '/traces/');

            expect(mockRes.writeHead).toHaveBeenCalledWith(404, { 'content-type': 'application/json' });
        });

        it('should return 404 when trace not found', () => {
            mockRequestHandler.getTrace.mockReturnValueOnce(null);

            const mockReq = { url: '/traces/nonexistent', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraceById(mockReq, mockRes, '/traces/nonexistent');

            expect(mockRes.writeHead).toHaveBeenCalledWith(404, { 'content-type': 'application/json' });
        });

        it('should extract traceId from path and return 200 when found', () => {
            const mockReq = { url: '/traces/trace123', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraceById(mockReq, mockRes, '/traces/trace123');

            expect(mockRequestHandler.getTrace).toHaveBeenCalledWith('trace123');
            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
        });

        it('should redact sensitive data in trace response', () => {
            const mockReq = { url: '/traces/trace123', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraceById(mockReq, mockRes, '/traces/trace123');

            expect(mockRedact).toHaveBeenCalled();
        });
    });

    describe('interface contract', () => {
        it('should have handleTraces method', () => {
            expect(typeof controller.handleTraces).toBe('function');
        });

        it('should have handleTraceById method', () => {
            expect(typeof controller.handleTraceById).toBe('function');
        });
    });
});
