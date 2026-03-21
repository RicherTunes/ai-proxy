'use strict';

/**
 * Coverage tests for lib/proxy/controllers/response-helpers.js
 *
 * BASELINE COVERAGE:
 * - Statements: 83.33%
 * - Branches: 50%
 * - Functions: 100%
 * - Lines: 100%
 * - Uncovered: line 20 (res.headersSent early return branch)
 */

const { sendJson, sendError } = require('../lib/proxy/controllers/response-helpers');

describe('response-helpers - coverage tests', () => {
    let mockRes;

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('sendJson', () => {
        // Covers line 20: res.headersSent is true - should return early
        it('should return early without writing when res.headersSent is true', () => {
            mockRes = {
                headersSent: true,
                writeHead: jest.fn(),
                end: jest.fn()
            };

            sendJson(mockRes, 200, { data: 'test' });

            expect(mockRes.writeHead).not.toHaveBeenCalled();
            expect(mockRes.end).not.toHaveBeenCalled();
        });

        // Covers normal path through sendJson (line 21-25)
        it('should write JSON response with correct headers when headersSent is false', () => {
            mockRes = {
                headersSent: false,
                writeHead: jest.fn(),
                end: jest.fn()
            };

            sendJson(mockRes, 201, { id: 123, name: 'test' });

            expect(mockRes.writeHead).toHaveBeenCalledWith(201, {
                'content-type': 'application/json',
                'cache-control': 'no-store'
            });
            expect(mockRes.end).toHaveBeenCalledWith('{"id":123,"name":"test"}');
        });

        // Covers line 21-25: various status codes
        it('should handle 500 status code correctly', () => {
            mockRes = {
                headersSent: false,
                writeHead: jest.fn(),
                end: jest.fn()
            };

            sendJson(mockRes, 500, { error: 'Internal Server Error' });

            expect(mockRes.writeHead).toHaveBeenCalledWith(500, {
                'content-type': 'application/json',
                'cache-control': 'no-store'
            });
            expect(mockRes.end).toHaveBeenCalledWith('{"error":"Internal Server Error"}');
        });

        // Covers line 25: null data serialization
        it('should serialize null data correctly', () => {
            mockRes = {
                headersSent: false,
                writeHead: jest.fn(),
                end: jest.fn()
            };

            sendJson(mockRes, 200, null);

            expect(mockRes.end).toHaveBeenCalledWith('null');
        });

        // Covers line 25: array data serialization
        it('should serialize array data correctly', () => {
            mockRes = {
                headersSent: false,
                writeHead: jest.fn(),
                end: jest.fn()
            };

            sendJson(mockRes, 200, [1, 2, 3]);

            expect(mockRes.end).toHaveBeenCalledWith('[1,2,3]');
        });
    });

    describe('sendError', () => {
        // Covers line 35: sendError calls sendJson with error object
        it('should call sendJson with error object wrapped correctly', () => {
            mockRes = {
                headersSent: false,
                writeHead: jest.fn(),
                end: jest.fn()
            };

            sendError(mockRes, 400, 'Bad Request');

            expect(mockRes.writeHead).toHaveBeenCalledWith(400, {
                'content-type': 'application/json',
                'cache-control': 'no-store'
            });
            expect(mockRes.end).toHaveBeenCalledWith('{"error":"Bad Request"}');
        });

        // Covers line 20 via sendError: early return when headersSent
        it('should return early without writing when res.headersSent is true', () => {
            mockRes = {
                headersSent: true,
                writeHead: jest.fn(),
                end: jest.fn()
            };

            sendError(mockRes, 404, 'Not Found');

            expect(mockRes.writeHead).not.toHaveBeenCalled();
            expect(mockRes.end).not.toHaveBeenCalled();
        });

        // Covers line 35: various error status codes
        it('should handle 401 unauthorized status code', () => {
            mockRes = {
                headersSent: false,
                writeHead: jest.fn(),
                end: jest.fn()
            };

            sendError(mockRes, 401, 'Unauthorized');

            expect(mockRes.writeHead).toHaveBeenCalledWith(401, {
                'content-type': 'application/json',
                'cache-control': 'no-store'
            });
            expect(mockRes.end).toHaveBeenCalledWith('{"error":"Unauthorized"}');
        });

        // Covers line 35: 403 forbidden
        it('should handle 403 forbidden status code', () => {
            mockRes = {
                headersSent: false,
                writeHead: jest.fn(),
                end: jest.fn()
            };

            sendError(mockRes, 403, 'Forbidden');

            expect(mockRes.writeHead).toHaveBeenCalledWith(403, {
                'content-type': 'application/json',
                'cache-control': 'no-store'
            });
            expect(mockRes.end).toHaveBeenCalledWith('{"error":"Forbidden"}');
        });

        // Covers line 35: 503 service unavailable
        it('should handle 503 service unavailable status code', () => {
            mockRes = {
                headersSent: false,
                writeHead: jest.fn(),
                end: jest.fn()
            };

            sendError(mockRes, 503, 'Service Unavailable');

            expect(mockRes.writeHead).toHaveBeenCalledWith(503, {
                'content-type': 'application/json',
                'cache-control': 'no-store'
            });
            expect(mockRes.end).toHaveBeenCalledWith('{"error":"Service Unavailable"}');
        });
    });
});
