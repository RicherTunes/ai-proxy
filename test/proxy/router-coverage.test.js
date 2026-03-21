/**
 * Router Coverage Test - Surgical fix for lines 51, 68
 *
 * Targets:
 * - Line 51: register(pathname, options = {}) - default parameter branch
 * - Line 68: req.headers.host || 'localhost' - fallback branch
 */

'use strict';

const { Router } = require('../../lib/proxy/router');

describe('router - coverage gaps (lines 51, 68)', () => {
    describe('line 51: register with undefined options', () => {
        // Covers line 51: default parameter options = {} when called without options arg
        it('should use default empty options when register called with undefined', () => {
            const router = new Router();

            // Call register without options parameter - triggers options = {} default
            router.register('/no-options');

            const route = router.routes.get('/no-options');
            expect(route).toBeDefined();
            expect(route.handler).toBeUndefined();
            expect(route.methods).toEqual(['GET']);
            expect(route.authRequired).toBe(false);
        });

        // Covers line 51: default parameter options = {} when explicitly passing undefined
        it('should use default empty options when register called with undefined explicitly', () => {
            const router = new Router();

            // Pass undefined explicitly - triggers options = {} default
            router.register('/explicit-undefined', undefined);

            const route = router.routes.get('/explicit-undefined');
            expect(route).toBeDefined();
            expect(route.handler).toBeUndefined();
            expect(route.methods).toEqual(['GET']);
            expect(route.authRequired).toBe(false);
        });
    });

    describe('line 68: dispatch with missing host header', () => {
        let router;
        let mockRes;

        beforeEach(() => {
            router = new Router();
            mockRes = {
                writeHead: jest.fn(),
                setHeader: jest.fn(),
                end: jest.fn()
            };
        });

        afterEach(() => {
            jest.restoreAllMocks();
        });

        // Covers line 68: req.headers.host || 'localhost' - fallback to localhost when host undefined
        it('should use localhost fallback when req.headers.host is undefined', async () => {
            const handler = jest.fn((req, res) => res.end('OK'));
            router.register('/test', { handler, methods: ['GET'] });

            const mockReq = {
                url: '/test',
                headers: {}, // No host property
                method: 'GET'
            };

            await router.dispatch(mockReq, mockRes);

            expect(handler).toHaveBeenCalledWith(mockReq, mockRes);
        });

        // Covers line 68: req.headers.host || 'localhost' - fallback to localhost when host is null
        it('should use localhost fallback when req.headers.host is null', async () => {
            const handler = jest.fn((req, res) => res.end('OK'));
            router.register('/test', { handler, methods: ['GET'] });

            const mockReq = {
                url: '/test',
                headers: { host: null },
                method: 'GET'
            };

            await router.dispatch(mockReq, mockRes);

            expect(handler).toHaveBeenCalledWith(mockReq, mockRes);
        });

        // Covers line 68: req.headers.host || 'localhost' - fallback to localhost when host is empty string
        it('should use localhost fallback when req.headers.host is empty string', async () => {
            const handler = jest.fn((req, res) => res.end('OK'));
            router.register('/test', { handler, methods: ['GET'] });

            const mockReq = {
                url: '/test',
                headers: { host: '' },
                method: 'GET'
            };

            await router.dispatch(mockReq, mockRes);

            expect(handler).toHaveBeenCalledWith(mockReq, mockRes);
        });

        // Covers line 68: request URL with query string and no host header
        it('should handle query strings with localhost fallback', async () => {
            const handler = jest.fn((req, res) => res.end('OK'));
            router.register('/search', { handler, methods: ['GET'] });

            const mockReq = {
                url: '/search?q=test&page=1',
                headers: {}, // No host
                method: 'GET'
            };

            await router.dispatch(mockReq, mockRes);

            expect(handler).toHaveBeenCalledWith(mockReq, mockRes);
        });
    });
});
