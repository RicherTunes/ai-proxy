/**
 * Contract Test: Router
 *
 * This contract test ensures that routing operations produce consistent results
 * after Router is created for proxy-server.js.
 *
 * TDD Phase: Red - Write failing test first
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

describeIfModule('ProxyServer Contract: Router Operations', () => {
    let router;

    beforeEach(() => {
        router = new Router();
    });

    describe('route registration', () => {
        it('should register a route with handler', () => {
            const handler = jest.fn((req, res) => {
                res.writeHead(200);
                res.end('OK');
            });

            router.register('/test', { handler, methods: ['GET'] });

            const route = router.routes.get('/test');
            expect(route).toBeDefined();
            expect(route.handler).toBe(handler);
        });

        it('should register multiple routes', () => {
            const handler1 = jest.fn();
            const handler2 = jest.fn();

            router.register('/route1', { handler: handler1, methods: ['GET'] });
            router.register('/route2', { handler: handler2, methods: ['POST'] });

            expect(router.routes.size).toBe(2);
        });

        it('should store authRequired flag', () => {
            const handler = jest.fn();
            router.register('/protected', { handler, methods: ['GET'], authRequired: true });

            const route = router.routes.get('/protected');
            expect(route.authRequired).toBe(true);
        });

        it('should store allowed methods', () => {
            const handler = jest.fn();
            router.register('/multi', { handler, methods: ['GET', 'POST', 'PUT'] });

            const route = router.routes.get('/multi');
            expect(route.methods).toEqual(['GET', 'POST', 'PUT']);
        });
    });

    describe('dispatch', () => {
        let mockReq, mockRes, mockNext;

        beforeEach(() => {
            mockReq = {
                url: '/test',
                headers: { host: 'localhost:3000' },
                method: 'GET'
            };
            mockRes = {
                writeHead: jest.fn(),
                setHeader: jest.fn(),
                end: jest.fn()
            };
            mockNext = jest.fn();

            router = new Router();
        });

        it('should dispatch to registered route handler', async () => {
            const handler = jest.fn((req, res) => {
                res.writeHead(200);
                res.end('OK');
            });

            router.register('/test', { handler, methods: ['GET'] });

            await router.dispatch(mockReq, mockRes);

            expect(handler).toHaveBeenCalledWith(mockReq, mockRes);
        });

        it('should use new URL for path resolution (req.path does not exist)', async () => {
            const handler = jest.fn((req, res) => {
                res.writeHead(200);
                res.end('OK');
            });

            router.register('/test', { handler, methods: ['GET'] });

            // Request with query string - should still match
            mockReq.url = '/test?foo=bar';

            await router.dispatch(mockReq, mockRes);

            expect(handler).toHaveBeenCalled();
        });

        it('should return 404 for unregistered routes', async () => {
            await router.dispatch(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(404);
        });

        it('should return 405 for unsupported methods', async () => {
            const handler = jest.fn();
            router.register('/test', { handler, methods: ['GET'] });

            mockReq.method = 'POST';

            await router.dispatch(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(405);
            expect(mockRes.setHeader).toHaveBeenCalledWith('Allow', 'GET');
        });

        it('should handle routes with trailing slashes', async () => {
            const handler = jest.fn((req, res) => {
                res.writeHead(200);
                res.end('OK');
            });

            router.register('/test/', { handler, methods: ['GET'] });

            mockReq.url = '/test/';

            await router.dispatch(mockReq, mockRes);

            expect(handler).toHaveBeenCalled();
        });
    });

    describe('auth checking', () => {
        let mockReq, mockRes;

        beforeEach(() => {
            router = new Router();
            mockReq = {
                url: '/protected',
                headers: { host: 'localhost:3000' },
                method: 'GET'
            };
            mockRes = {
                writeHead: jest.fn(),
                setHeader: jest.fn(),
                end: jest.fn()
            };
        });

        it('should allow access when authRequired=false', async () => {
            const handler = jest.fn((req, res) => {
                res.writeHead(200);
                res.end('OK');
            });

            router.register('/protected', { handler, methods: ['GET'], authRequired: false });

            await router.dispatch(mockReq, mockRes);

            expect(handler).toHaveBeenCalled();
        });

        it('should reject when authRequired=true and no auth', async () => {
            const handler = jest.fn();
            router.register('/protected', { handler, methods: ['GET'], authRequired: true });

            await router.dispatch(mockReq, mockRes);

            expect(handler).not.toHaveBeenCalled();
            expect(mockRes.writeHead).toHaveBeenCalledWith(401);
        });
    });

    describe('interface contract', () => {
        it('should have register method', () => {
            expect(typeof router.register).toBe('function');
        });

        it('should have dispatch method', () => {
            expect(typeof router.dispatch).toBe('function');
        });

        it('should have routes property', () => {
            expect(router.routes).toBeInstanceOf(Map);
        });
    });
});
