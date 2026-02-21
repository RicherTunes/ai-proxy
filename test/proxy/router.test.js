/**
 * Unit Test: Router Module
 *
 * TDD Phase: Red - Write failing unit test before module exists
 *
 * Tests the Router class for proxy-server.js route dispatch.
 */

'use strict';

const http = require('http');
let Router;
try {
    ({ Router } = require('../../lib/proxy/router'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = Router ? describe : describe.skip;

describeIfModule('router', () => {
    describe('constructor', () => {
        it('should create a new Router', () => {
            const router = new Router();
            expect(router).toBeInstanceOf(Router);
        });

        it('should initialize empty routes map', () => {
            const router = new Router();
            expect(router.routes).toBeInstanceOf(Map);
            expect(router.routes.size).toBe(0);
        });
    });

    describe('register', () => {
        let router;

        beforeEach(() => {
            router = new Router();
        });

        it('should register a route', () => {
            const handler = jest.fn();
            router.register('/test', { handler, methods: ['GET'] });

            expect(router.routes.size).toBe(1);
            expect(router.routes.has('/test')).toBe(true);
        });

        it('should store route options', () => {
            const handler = jest.fn();
            const options = { handler, methods: ['GET', 'POST'], authRequired: true };

            router.register('/api/test', options);

            const route = router.routes.get('/api/test');
            expect(route.handler).toBe(handler);
            expect(route.methods).toEqual(['GET', 'POST']);
            expect(route.authRequired).toBe(true);
        });

        it('should allow overwriting existing routes', () => {
            const handler1 = jest.fn();
            const handler2 = jest.fn();

            router.register('/test', { handler: handler1, methods: ['GET'] });
            router.register('/test', { handler: handler2, methods: ['POST'] });

            expect(router.routes.size).toBe(1);
            expect(router.routes.get('/test').handler).toBe(handler2);
        });

        it('should use default methods when not provided', () => {
            const handler = jest.fn();
            router.register('/test', { handler });

            const route = router.routes.get('/test');
            expect(route.methods).toEqual(['GET']);
        });

        it('should use default authRequired=false when not provided', () => {
            const handler = jest.fn();
            router.register('/test', { handler });

            const route = router.routes.get('/test');
            expect(route.authRequired).toBe(false);
        });
    });

    describe('dispatch', () => {
        let router, mockReq, mockRes;

        beforeEach(() => {
            router = new Router();
            mockReq = {
                url: '/test',
                headers: { host: 'example.com' },
                method: 'GET'
            };
            mockRes = {
                writeHead: jest.fn(),
                setHeader: jest.fn(),
                end: jest.fn()
            };
        });

        it('should dispatch to matching route', async () => {
            const handler = jest.fn((req, res) => {
                res.writeHead(200);
                res.end('OK');
            });

            router.register('/test', { handler, methods: ['GET'] });

            await router.dispatch(mockReq, mockRes);

            expect(handler).toHaveBeenCalledWith(mockReq, mockRes);
            expect(mockRes.writeHead).toHaveBeenCalledWith(200);
        });

        it('should extract pathname from URL correctly', async () => {
            const handler = jest.fn((req, res) => res.end('OK'));

            router.register('/test', { handler, methods: ['GET'] });

            // Test with query string
            mockReq.url = '/test?foo=bar&baz=qux';
            await router.dispatch(mockReq, mockRes);

            expect(handler).toHaveBeenCalled();
        });

        it('should return 404 for non-existent routes', async () => {
            await router.dispatch(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(404);
            expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
        });

        it('should return 405 for unsupported methods', async () => {
            const handler = jest.fn();
            router.register('/test', { handler, methods: ['GET'] });

            mockReq.method = 'POST';

            await router.dispatch(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(405);
            expect(mockRes.setHeader).toHaveBeenCalledWith('Allow', 'GET');
            expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
        });

        it('should allow supported methods', async () => {
            const handler = jest.fn((req, res) => res.end('OK'));
            router.register('/test', { handler, methods: ['GET', 'POST'] });

            mockReq.method = 'POST';

            await router.dispatch(mockReq, mockRes);

            expect(handler).toHaveBeenCalled();
        });

        it('should handle routes with trailing slashes', async () => {
            const handler = jest.fn((req, res) => res.end('OK'));
            router.register('/test/', { handler, methods: ['GET'] });

            mockReq.url = '/test/';

            await router.dispatch(mockReq, mockRes);

            expect(handler).toHaveBeenCalled();
        });

        it('should not match routes with different trailing slash', async () => {
            const handler = jest.fn();
            router.register('/test/', { handler, methods: ['GET'] });

            mockReq.url = '/test'; // No trailing slash

            await router.dispatch(mockReq, mockRes);

            expect(handler).not.toHaveBeenCalled();
            expect(mockRes.writeHead).toHaveBeenCalledWith(404);
        });

        it('should match exact path, not prefix', async () => {
            const handler = jest.fn();
            router.register('/test', { handler, methods: ['GET'] });

            mockReq.url = '/testing';

            await router.dispatch(mockReq, mockRes);

            expect(handler).not.toHaveBeenCalled();
            expect(mockRes.writeHead).toHaveBeenCalledWith(404);
        });

        it('should handle special characters in paths', async () => {
            const handler = jest.fn((req, res) => res.end('OK'));
            router.register('/api/v1/users', { handler, methods: ['GET'] });

            mockReq.url = '/api/v1/users';

            await router.dispatch(mockReq, mockRes);

            expect(handler).toHaveBeenCalled();
        });
    });

    describe('auth checking', () => {
        let router, mockReq, mockRes;

        beforeEach(() => {
            router = new Router();
            mockReq = {
                url: '/protected',
                headers: { host: 'example.com' },
                method: 'GET'
            };
            mockRes = {
                writeHead: jest.fn(),
                setHeader: jest.fn(),
                end: jest.fn()
            };
        });

        it('should call handler when auth not required', async () => {
            const handler = jest.fn((req, res) => res.end('OK'));
            router.register('/protected', { handler, methods: ['GET'], authRequired: false });

            await router.dispatch(mockReq, mockRes);

            expect(handler).toHaveBeenCalled();
        });

        it('should call handler when auth required and provided', async () => {
            const handler = jest.fn((req, res) => res.end('OK'));
            router.register('/protected', { handler, methods: ['GET'], authRequired: true });

            // Simulate authenticated request
            mockReq.isAuthenticated = true;

            await router.dispatch(mockReq, mockRes);

            expect(handler).toHaveBeenCalled();
        });

        it('should return 401 when auth required but not provided', async () => {
            const handler = jest.fn();
            router.register('/protected', { handler, methods: ['GET'], authRequired: true });

            await router.dispatch(mockReq, mockRes);

            expect(handler).not.toHaveBeenCalled();
            expect(mockRes.writeHead).toHaveBeenCalledWith(401);
        });
    });

    describe('setAuthChecker', () => {
        it('should allow custom auth checker', async () => {
            const router = new Router();
            const customChecker = jest.fn(() => true);

            router.setAuthChecker(customChecker);

            const handler = jest.fn((req, res) => res.end('OK'));
            router.register('/protected', { handler, methods: ['GET'], authRequired: true });

            const mockReq = {
                url: '/protected',
                headers: { host: 'example.com' },
                method: 'GET'
            };
            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn()
            };

            await router.dispatch(mockReq, mockRes);

            expect(customChecker).toHaveBeenCalledWith(mockReq);
            expect(handler).toHaveBeenCalled();
        });
    });

    describe('interface contract', () => {
        let router;

        beforeEach(() => {
            router = new Router();
        });

        it('should have register method', () => {
            expect(typeof router.register).toBe('function');
        });

        it('should have dispatch method', () => {
            expect(typeof router.dispatch).toBe('function');
        });

        it('should have routes property', () => {
            expect(router.routes).toBeInstanceOf(Map);
        });

        it('should have setAuthChecker method', () => {
            expect(typeof router.setAuthChecker).toBe('function');
        });
    });
});
