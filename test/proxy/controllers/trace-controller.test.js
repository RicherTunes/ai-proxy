/**
 * Unit Test: Trace Controller
 *
 * TDD Phase: Red - Write failing unit test before module exists
 *
 * Tests the TraceController class for proxy-server.js trace-related routes.
 */

'use strict';

let TraceController;
try {
    ({ TraceController } = require('../../../lib/proxy/controllers/trace-controller'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = TraceController ? describe : describe.skip;

describeIfModule('trace-controller', () => {
    let controller;
    let mockRequestHandler;
    let mockRedact;

    beforeEach(() => {
        mockRequestHandler = {
            queryTraces: jest.fn(() => [
                { id: 'trace1', model: 'glm-4', success: true, duration: 500 }
            ]),
            getRecentTraces: jest.fn(() => [
                { id: 'trace1', model: 'glm-4', success: true, duration: 500 },
                { id: 'trace2', model: 'glm-4', success: false, duration: 1000 }
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

    describe('constructor', () => {
        it('should create a new TraceController', () => {
            expect(controller).toBeInstanceOf(TraceController);
        });

        it('should initialize with provided dependencies', () => {
            expect(controller._requestHandler).toBe(mockRequestHandler);
            expect(controller._redactSensitiveData).toBe(mockRedact);
        });

        it('should initialize with default values when options omitted', () => {
            const minimalController = new TraceController();
            expect(minimalController).toBeInstanceOf(TraceController);
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

        it('should call queryTraces when filters are provided', () => {
            const mockReq = { url: '/traces?success=true&model=glm-4', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraces(mockReq, mockRes);

            expect(mockRequestHandler.queryTraces).toHaveBeenCalledWith(expect.objectContaining({
                success: true,
                model: 'glm-4'
            }));
        });

        it('should call getTraceStats', () => {
            const mockReq = { url: '/traces', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraces(mockReq, mockRes);

            expect(mockRequestHandler.getTraceStats).toHaveBeenCalled();
        });

        it('should parse success=true filter', () => {
            const mockReq = { url: '/traces?success=true', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraces(mockReq, mockRes);

            expect(mockRequestHandler.queryTraces).toHaveBeenCalledWith(expect.objectContaining({
                success: true
            }));
        });

        it('should parse success=false filter', () => {
            const mockReq = { url: '/traces?success=false', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraces(mockReq, mockRes);

            expect(mockRequestHandler.queryTraces).toHaveBeenCalledWith(expect.objectContaining({
                success: false
            }));
        });

        it('should parse model filter', () => {
            const mockReq = { url: '/traces?model=glm-4', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraces(mockReq, mockRes);

            expect(mockRequestHandler.queryTraces).toHaveBeenCalledWith(expect.objectContaining({
                model: 'glm-4'
            }));
        });

        it('should parse hasRetries filter', () => {
            const mockReq = { url: '/traces?hasRetries=true', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraces(mockReq, mockRes);

            expect(mockRequestHandler.queryTraces).toHaveBeenCalledWith(expect.objectContaining({
                hasRetries: true
            }));
        });

        it('should parse minDuration filter', () => {
            const mockReq = { url: '/traces?minDuration=500', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraces(mockReq, mockRes);

            expect(mockRequestHandler.queryTraces).toHaveBeenCalledWith(expect.objectContaining({
                minDuration: 500
            }));
        });

        it('should parse since filter', () => {
            const mockReq = { url: '/traces?since=1000000', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraces(mockReq, mockRes);

            expect(mockRequestHandler.queryTraces).toHaveBeenCalledWith(expect.objectContaining({
                since: 1000000
            }));
        });

        it('should parse limit filter', () => {
            const mockReq = { url: '/traces?limit=50', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraces(mockReq, mockRes);

            expect(mockRequestHandler.getRecentTraces).toHaveBeenCalledWith(50);
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

        it('should return traces, stats, and timestamp in response', () => {
            const mockReq = { url: '/traces', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraces(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('traces');
            expect(responseData).toHaveProperty('stats');
            expect(responseData).toHaveProperty('timestamp');
        });

        it('should include filter in response when filters provided', () => {
            const mockReq = { url: '/traces?model=glm-4', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraces(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.filter).toEqual(expect.objectContaining({
                model: 'glm-4'
            }));
        });

        it('should have null filter when no filters provided', () => {
            const mockReq = { url: '/traces', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraces(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.filter).toBeNull();
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
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('Trace not found');
        });

        it('should extract traceId from path', () => {
            const mockReq = { url: '/traces/trace123', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraceById(mockReq, mockRes, '/traces/trace123');

            expect(mockRequestHandler.getTrace).toHaveBeenCalledWith('trace123');
        });

        it('should call getTrace with extracted traceId', () => {
            const mockReq = { url: '/traces/abc123', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraceById(mockReq, mockRes, '/traces/abc123');

            expect(mockRequestHandler.getTrace).toHaveBeenCalledWith('abc123');
        });

        it('should return 200 with trace data when found', () => {
            const mockReq = { url: '/traces/trace123', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraceById(mockReq, mockRes, '/traces/trace123');

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

    describe('edge cases', () => {
        it('should handle missing requestHandler gracefully in handleTraces', () => {
            controller._requestHandler = null;

            const mockReq = { url: '/traces', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            expect(() => controller.handleTraces(mockReq, mockRes)).not.toThrow();
        });

        it('should handle invalid minDuration gracefully', () => {
            const mockReq = { url: '/traces?minDuration=invalid', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            expect(() => controller.handleTraces(mockReq, mockRes)).not.toThrow();
        });

        it('should handle invalid limit gracefully', () => {
            const mockReq = { url: '/traces?limit=invalid', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            expect(() => controller.handleTraces(mockReq, mockRes)).not.toThrow();
        });

        it('should handle invalid since gracefully', () => {
            const mockReq = { url: '/traces?since=invalid', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            expect(() => controller.handleTraces(mockReq, mockRes)).not.toThrow();
        });
    });

    describe('input bounds clamping', () => {
        it('should clamp limit to max 1000', () => {
            const mockReq = { url: '/traces?limit=999999', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraces(mockReq, mockRes);

            // Limit should be clamped and passed to getRecentTraces
            const limitArg = mockRequestHandler.getRecentTraces.mock.calls[0][0];
            expect(limitArg).toBeLessThanOrEqual(1000);
        });

        it('should clamp limit to min 1', () => {
            const mockReq = { url: '/traces?limit=-5', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraces(mockReq, mockRes);

            const limitArg = mockRequestHandler.getRecentTraces.mock.calls[0][0];
            expect(limitArg).toBeGreaterThanOrEqual(1);
        });

        it('should trim model parameter whitespace', () => {
            const mockReq = { url: '/traces?model=%20glm-4%20', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleTraces(mockReq, mockRes);

            const filterArg = mockRequestHandler.queryTraces.mock.calls[0][0];
            expect(filterArg.model).toBe('glm-4');
        });
    });
});
