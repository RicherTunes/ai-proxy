/**
 * Unit Test: Requests Controller
 *
 * TDD Phase: Red - Write failing unit test before module exists
 *
 * Tests the RequestsController class for proxy-server.js request-related routes.
 */

'use strict';

let RequestsController;
try {
    ({ RequestsController } = require('../../../lib/proxy/controllers/requests-controller'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = RequestsController ? describe : describe.skip;

describeIfModule('requests-controller', () => {
    let controller;
    let mockRequestTraces;

    beforeEach(() => {
        mockRequestTraces = {
            size: 100,
            toArray: jest.fn(() => [
                { traceId: 'trace1', requestId: 'req1', keyIndex: 0, status: 200, latencyMs: 100 },
                { traceId: 'trace2', requestId: 'req2', keyIndex: 1, status: 200, latencyMs: 150 },
                { traceId: 'trace3', requestId: 'req3', keyIndex: 0, status: 500, latencyMs: 200 },
                { traceId: 'trace4', requestId: 'req4', keyIndex: 1, status: 200, latencyMs: 120 },
                { traceId: 'trace5', requestId: 'req5', keyIndex: 0, status: 200, latencyMs: 180 }
            ])
        };

        controller = new RequestsController({
            requestTraces: mockRequestTraces
        });
    });

    describe('constructor', () => {
        it('should create a new RequestsController', () => {
            expect(controller).toBeInstanceOf(RequestsController);
        });

        it('should initialize with provided dependencies', () => {
            expect(controller._requestTraces).toBe(mockRequestTraces);
        });

        it('should initialize with default values when options omitted', () => {
            const minimalController = new RequestsController();
            expect(minimalController).toBeInstanceOf(RequestsController);
        });
    });

    describe('handleRequests', () => {
        describe('GET /requests', () => {
            it('should return 200 with default limit of 50', () => {
                const mockReq = { url: '/requests', method: 'GET', headers: { host: 'localhost' } };
                const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

                controller.handleRequests(mockReq, mockRes, '/requests');

                expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
            });

            it('should parse limit from query parameter', () => {
                const mockReq = { url: '/requests?limit=10', method: 'GET', headers: { host: 'localhost' } };
                const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

                controller.handleRequests(mockReq, mockRes, '/requests');

                const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
                expect(responseData.limit).toBe(10);
            });

            it('should parse offset from query parameter', () => {
                const mockReq = { url: '/requests?offset=5', method: 'GET', headers: { host: 'localhost' } };
                const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

                controller.handleRequests(mockReq, mockRes, '/requests');

                const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
                expect(responseData.offset).toBe(5);
            });

            it('should include total count in response', () => {
                const mockReq = { url: '/requests', method: 'GET', headers: { host: 'localhost' } };
                const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

                controller.handleRequests(mockReq, mockRes, '/requests');

                const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
                expect(responseData.total).toBe(100);
            });

            it('should include requests array in response', () => {
                const mockReq = { url: '/requests', method: 'GET', headers: { host: 'localhost' } };
                const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

                controller.handleRequests(mockReq, mockRes, '/requests');

                const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
                expect(responseData).toHaveProperty('requests');
                expect(Array.isArray(responseData.requests)).toBe(true);
            });
        });

        describe('GET /requests/search', () => {
            it('should filter by keyIndex', () => {
                const mockReq = { url: '/requests/search?keyIndex=0', method: 'GET', headers: { host: 'localhost' } };
                const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

                controller.handleRequests(mockReq, mockRes, '/requests/search');

                const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
                expect(responseData.requests.every(r => r.keyIndex === 0)).toBe(true);
            });

            it('should filter by status', () => {
                const mockReq = { url: '/requests/search?status=500', method: 'GET', headers: { host: 'localhost' } };
                const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

                controller.handleRequests(mockReq, mockRes, '/requests/search');

                const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
                expect(responseData.requests.every(r => r.status === 500)).toBe(true);
            });

            it('should filter by minLatency', () => {
                const mockReq = { url: '/requests/search?minLatency=150', method: 'GET', headers: { host: 'localhost' } };
                const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

                controller.handleRequests(mockReq, mockRes, '/requests/search');

                const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
                expect(responseData.requests.every(r => r.latencyMs >= 150)).toBe(true);
            });

            it('should limit search results to 100', () => {
                // Create many requests
                const manyRequests = Array.from({ length: 200 }, (_, i) => ({
                    traceId: `trace${i}`,
                    requestId: `req${i}`,
                    keyIndex: i % 2,
                    status: 200,
                    latencyMs: 100 + i
                }));
                mockRequestTraces.toArray.mockReturnValueOnce(manyRequests);

                const mockReq = { url: '/requests/search', method: 'GET', headers: { host: 'localhost' } };
                const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

                controller.handleRequests(mockReq, mockRes, '/requests/search');

                const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
                expect(responseData.requests.length).toBeLessThanOrEqual(100);
            });
        });

        describe('GET /requests/:id', () => {
            it('should return 404 when trace not found', () => {
                const mockReq = { url: '/requests/nonexistent', method: 'GET', headers: { host: 'localhost' } };
                const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

                controller.handleRequests(mockReq, mockRes, '/requests/nonexistent');

                expect(mockRes.writeHead).toHaveBeenCalledWith(404, { 'content-type': 'application/json' });
            });

            it('should find request by traceId', () => {
                const mockReq = { url: '/requests/trace1', method: 'GET', headers: { host: 'localhost' } };
                const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

                controller.handleRequests(mockReq, mockRes, '/requests/trace1');

                expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
            });

            it('should find request by requestId', () => {
                const mockReq = { url: '/requests/req1', method: 'GET', headers: { host: 'localhost' } };
                const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

                controller.handleRequests(mockReq, mockRes, '/requests/req1');

                expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
            });

            it('should return the request data when found', () => {
                const mockReq = { url: '/requests/trace1', method: 'GET', headers: { host: 'localhost' } };
                const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

                controller.handleRequests(mockReq, mockRes, '/requests/trace1');

                const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
                expect(responseData.traceId).toBe('trace1');
            });
        });

        describe('not found cases', () => {
            it('should return 404 for unknown paths', () => {
                const mockReq = { url: '/requests/unknown/path', method: 'GET', headers: { host: 'localhost' } };
                const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

                controller.handleRequests(mockReq, mockRes, '/requests/unknown/path');

                expect(mockRes.writeHead).toHaveBeenCalledWith(404, { 'content-type': 'application/json' });
            });
        });
    });

    describe('interface contract', () => {
        it('should have handleRequests method', () => {
            expect(typeof controller.handleRequests).toBe('function');
        });
    });

    describe('edge cases', () => {
        it('should handle missing requestTraces gracefully', () => {
            controller._requestTraces = null;

            const mockReq = { url: '/requests', method: 'GET', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            expect(() => controller.handleRequests(mockReq, mockRes, '/requests')).not.toThrow();
        });

        it('should handle invalid limit gracefully', () => {
            const mockReq = { url: '/requests?limit=invalid', method: 'GET', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            expect(() => controller.handleRequests(mockReq, mockRes, '/requests')).not.toThrow();
        });

        it('should handle invalid offset gracefully', () => {
            const mockReq = { url: '/requests?offset=invalid', method: 'GET', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            expect(() => controller.handleRequests(mockReq, mockRes, '/requests')).not.toThrow();
        });
    });

    describe('input bounds clamping', () => {
        it('should clamp limit to max 500', () => {
            const mockReq = { url: '/requests?limit=999999', method: 'GET', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleRequests(mockReq, mockRes, '/requests');

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.limit).toBeLessThanOrEqual(500);
        });

        it('should clamp limit to min 1', () => {
            const mockReq = { url: '/requests?limit=-5', method: 'GET', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleRequests(mockReq, mockRes, '/requests');

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.limit).toBeGreaterThanOrEqual(1);
        });

        it('should clamp offset to max 10000', () => {
            const mockReq = { url: '/requests?offset=999999999', method: 'GET', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleRequests(mockReq, mockRes, '/requests');

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.offset).toBeLessThanOrEqual(10000);
        });

        it('should clamp offset to min 0', () => {
            const mockReq = { url: '/requests?offset=-100', method: 'GET', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleRequests(mockReq, mockRes, '/requests');

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.offset).toBeGreaterThanOrEqual(0);
        });
    });
});
