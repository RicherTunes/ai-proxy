'use strict';

const { Router } = require('../lib/proxy/router');

/**
 * Helper to create mock req/res pairs for Router dispatch tests.
 */
function createMocks(url = '/test', method = 'GET', extras = {}) {
    const req = {
        url,
        method,
        headers: { host: 'localhost:3000' },
        ...extras
    };
    const res = {
        writeHead: jest.fn(),
        setHeader: jest.fn(),
        end: jest.fn(),
        _body: null
    };
    // Capture body written via res.end
    res.end.mockImplementation((body) => { res._body = body; });
    return { req, res };
}

describe('Router dispatch — edge cases', () => {
    let router;

    beforeEach(() => {
        router = new Router();
    });

    // 9. Prefix matching — /control/ registered, /control/clear-logs dispatches correctly
    describe('prefix matching — exact-match semantics', () => {
        it('should dispatch /control/ when registered and requested exactly', async () => {
            const handler = jest.fn((req, res) => { res.writeHead(200); res.end('ok'); });
            router.register('/control/', { handler, methods: ['GET'] });

            const { req, res } = createMocks('/control/', 'GET');
            await router.dispatch(req, res);

            expect(handler).toHaveBeenCalled();
        });

        it('should NOT match /control/clear-logs when only /control/ is registered (exact match)', async () => {
            const handler = jest.fn();
            router.register('/control/', { handler, methods: ['GET'] });

            const { req, res } = createMocks('/control/clear-logs', 'GET');
            await router.dispatch(req, res);

            expect(handler).not.toHaveBeenCalled();
            expect(res.writeHead).toHaveBeenCalledWith(404);
        });

        it('should dispatch /control/clear-logs when registered explicitly', async () => {
            const parentHandler = jest.fn((req, res) => { res.writeHead(200); res.end('parent'); });
            const childHandler = jest.fn((req, res) => { res.writeHead(200); res.end('child'); });

            router.register('/control/', { handler: parentHandler, methods: ['GET'] });
            router.register('/control/clear-logs', { handler: childHandler, methods: ['POST'] });

            const { req, res } = createMocks('/control/clear-logs', 'POST');
            await router.dispatch(req, res);

            expect(childHandler).toHaveBeenCalled();
            expect(parentHandler).not.toHaveBeenCalled();
        });
    });

    // 10. Wrong method — route registered for GET, POST request returns 405
    describe('wrong method — returns 405', () => {
        it('should return 405 when POST is sent to a GET-only route', async () => {
            const handler = jest.fn();
            router.register('/api/data', { handler, methods: ['GET'] });

            const { req, res } = createMocks('/api/data', 'POST');
            await router.dispatch(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(405);
            expect(res.setHeader).toHaveBeenCalledWith('Allow', 'GET');
            expect(handler).not.toHaveBeenCalled();
        });

        it('should return 405 with correct Allow header for multi-method routes', async () => {
            const handler = jest.fn();
            router.register('/api/data', { handler, methods: ['GET', 'POST'] });

            const { req, res } = createMocks('/api/data', 'DELETE');
            await router.dispatch(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(405);
            expect(res.setHeader).toHaveBeenCalledWith('Allow', 'GET, POST');
        });

        it('should return 405 body as JSON with error message', async () => {
            const handler = jest.fn();
            router.register('/api/data', { handler, methods: ['GET'] });

            const { req, res } = createMocks('/api/data', 'PUT');
            await router.dispatch(req, res);

            const body = JSON.parse(res._body);
            expect(body.error).toBe('Method Not Allowed');
        });
    });

    // 11. No matching route — unknown path returns 404
    describe('no matching route — returns 404', () => {
        it('should return 404 for completely unknown path', async () => {
            const { req, res } = createMocks('/nonexistent', 'GET');
            await router.dispatch(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(404);
            const body = JSON.parse(res._body);
            expect(body.error).toBe('Not Found');
        });

        it('should return 404 when router has no routes at all', async () => {
            const { req, res } = createMocks('/', 'GET');
            await router.dispatch(req, res);

            expect(res.writeHead).toHaveBeenCalledWith(404);
        });

        it('should return 404 for path that is substring of registered route', async () => {
            const handler = jest.fn();
            router.register('/api/users/list', { handler, methods: ['GET'] });

            const { req, res } = createMocks('/api/users', 'GET');
            await router.dispatch(req, res);

            expect(handler).not.toHaveBeenCalled();
            expect(res.writeHead).toHaveBeenCalledWith(404);
        });
    });

    // 12. Auth checking — route with auth requirement checks credentials
    describe('auth checking — credentials verification', () => {
        it('should return 401 when auth required but request is unauthenticated', async () => {
            const handler = jest.fn();
            router.register('/admin', { handler, methods: ['GET'], authRequired: true });

            const { req, res } = createMocks('/admin', 'GET');
            await router.dispatch(req, res);

            expect(handler).not.toHaveBeenCalled();
            expect(res.writeHead).toHaveBeenCalledWith(401);
            const body = JSON.parse(res._body);
            expect(body.error).toBe('Unauthorized');
        });

        it('should dispatch when auth required and isAuthenticated is true', async () => {
            const handler = jest.fn((req, res) => { res.writeHead(200); res.end('ok'); });
            router.register('/admin', { handler, methods: ['GET'], authRequired: true });

            const { req, res } = createMocks('/admin', 'GET', { isAuthenticated: true });
            await router.dispatch(req, res);

            expect(handler).toHaveBeenCalled();
        });

        it('should use custom authChecker when provided', async () => {
            const customChecker = jest.fn((req) => req.headers['x-api-key'] === 'secret');
            const authedRouter = new Router({ authChecker: customChecker });

            const handler = jest.fn((req, res) => { res.writeHead(200); res.end('ok'); });
            authedRouter.register('/secure', { handler, methods: ['GET'], authRequired: true });

            // Without key — rejected
            const { req: req1, res: res1 } = createMocks('/secure', 'GET');
            await authedRouter.dispatch(req1, res1);
            expect(handler).not.toHaveBeenCalled();
            expect(res1.writeHead).toHaveBeenCalledWith(401);

            // With key — accepted
            const { req: req2, res: res2 } = createMocks('/secure', 'GET', {
                headers: { host: 'localhost', 'x-api-key': 'secret' }
            });
            await authedRouter.dispatch(req2, res2);
            expect(handler).toHaveBeenCalledTimes(1);
            expect(customChecker).toHaveBeenCalledTimes(2);
        });

        it('should check method before auth (405 takes precedence over 401)', async () => {
            const handler = jest.fn();
            router.register('/admin', { handler, methods: ['GET'], authRequired: true });

            const { req, res } = createMocks('/admin', 'DELETE');
            await router.dispatch(req, res);

            // Method check happens before auth check
            expect(res.writeHead).toHaveBeenCalledWith(405);
        });
    });

    // 13. Multiple routes — multiple routes registered, correct one dispatched
    describe('multiple routes — correct dispatch', () => {
        it('should dispatch to the correct handler among many routes', async () => {
            const handlers = {};
            for (const path of ['/a', '/b', '/c', '/d', '/e']) {
                handlers[path] = jest.fn((req, res) => { res.writeHead(200); res.end(path); });
                router.register(path, { handler: handlers[path], methods: ['GET'] });
            }

            const { req, res } = createMocks('/c', 'GET');
            await router.dispatch(req, res);

            expect(handlers['/c']).toHaveBeenCalled();
            expect(handlers['/a']).not.toHaveBeenCalled();
            expect(handlers['/b']).not.toHaveBeenCalled();
            expect(handlers['/d']).not.toHaveBeenCalled();
            expect(handlers['/e']).not.toHaveBeenCalled();
        });

        it('should handle routes with different methods independently', async () => {
            const getHandler = jest.fn((req, res) => { res.writeHead(200); res.end('get'); });
            const postHandler = jest.fn((req, res) => { res.writeHead(200); res.end('post'); });

            // Note: Router uses Map.set — last registration for same path wins
            router.register('/api', { handler: getHandler, methods: ['GET'] });
            router.register('/api/create', { handler: postHandler, methods: ['POST'] });

            const { req: req1, res: res1 } = createMocks('/api', 'GET');
            await router.dispatch(req1, res1);
            expect(getHandler).toHaveBeenCalled();

            const { req: req2, res: res2 } = createMocks('/api/create', 'POST');
            await router.dispatch(req2, res2);
            expect(postHandler).toHaveBeenCalled();
        });
    });

    // 14. Route priority — more specific route vs prefix (exact match semantics)
    describe('route priority — exact match only', () => {
        it('should match the exact path, not a shorter prefix', async () => {
            const prefixHandler = jest.fn((req, res) => { res.writeHead(200); res.end('prefix'); });
            const specificHandler = jest.fn((req, res) => { res.writeHead(200); res.end('specific'); });

            router.register('/api', { handler: prefixHandler, methods: ['GET'] });
            router.register('/api/users', { handler: specificHandler, methods: ['GET'] });

            const { req, res } = createMocks('/api/users', 'GET');
            await router.dispatch(req, res);

            expect(specificHandler).toHaveBeenCalled();
            expect(prefixHandler).not.toHaveBeenCalled();
        });

        it('should not fall back to prefix when specific route is not registered', async () => {
            const prefixHandler = jest.fn();
            router.register('/api', { handler: prefixHandler, methods: ['GET'] });

            const { req, res } = createMocks('/api/users', 'GET');
            await router.dispatch(req, res);

            // No prefix fallback — it's exact match only
            expect(prefixHandler).not.toHaveBeenCalled();
            expect(res.writeHead).toHaveBeenCalledWith(404);
        });
    });

    // 15. Dynamic path params — Router uses exact Map lookup, no dynamic params
    describe('dynamic path params — not supported (exact match)', () => {
        it('should NOT match /keys/123 when /keys/:id is registered (no param capture)', async () => {
            const handler = jest.fn();
            router.register('/keys/:id', { handler, methods: ['GET'] });

            const { req, res } = createMocks('/keys/123', 'GET');
            await router.dispatch(req, res);

            // Router does exact string match — /keys/:id !== /keys/123
            expect(handler).not.toHaveBeenCalled();
            expect(res.writeHead).toHaveBeenCalledWith(404);
        });

        it('should match /keys/:id only when literally requested as /keys/:id', async () => {
            const handler = jest.fn((req, res) => { res.writeHead(200); res.end('ok'); });
            router.register('/keys/:id', { handler, methods: ['GET'] });

            const { req, res } = createMocks('/keys/:id', 'GET');
            await router.dispatch(req, res);

            expect(handler).toHaveBeenCalled();
        });
    });

    // 16. Case sensitivity — route matching is case-sensitive
    describe('case sensitivity — case-sensitive matching', () => {
        it('should not match /API when /api is registered', async () => {
            const handler = jest.fn();
            router.register('/api', { handler, methods: ['GET'] });

            const { req, res } = createMocks('/API', 'GET');
            await router.dispatch(req, res);

            expect(handler).not.toHaveBeenCalled();
            expect(res.writeHead).toHaveBeenCalledWith(404);
        });

        it('should not match /Api/Users when /api/users is registered', async () => {
            const handler = jest.fn();
            router.register('/api/users', { handler, methods: ['GET'] });

            const { req, res } = createMocks('/Api/Users', 'GET');
            await router.dispatch(req, res);

            expect(handler).not.toHaveBeenCalled();
            expect(res.writeHead).toHaveBeenCalledWith(404);
        });

        it('should match exact case', async () => {
            const handler = jest.fn((req, res) => { res.writeHead(200); res.end('ok'); });
            router.register('/Api/Users', { handler, methods: ['GET'] });

            const { req, res } = createMocks('/Api/Users', 'GET');
            await router.dispatch(req, res);

            expect(handler).toHaveBeenCalled();
        });

        it('should treat method check as case-sensitive', async () => {
            const handler = jest.fn();
            router.register('/test', { handler, methods: ['GET'] });

            // HTTP methods are uppercase by convention; lowercase should not match
            const { req, res } = createMocks('/test', 'get');
            await router.dispatch(req, res);

            expect(handler).not.toHaveBeenCalled();
            expect(res.writeHead).toHaveBeenCalledWith(405);
        });
    });
});
