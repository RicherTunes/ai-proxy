/**
 * Content-Type Validation Tests (TDD)
 *
 * Ensures POST/PUT controller endpoints reject non-JSON Content-Type
 * with 415 Unsupported Media Type, while accepting valid JSON types
 * and not requiring Content-Type on GET/DELETE requests.
 */

'use strict';

const { requireJsonContentType } = require('../lib/content-type-validator');
const { WebhookController } = require('../lib/proxy/controllers/webhook-controller');
const { ModelController } = require('../lib/proxy/controllers/model-controller');
const { StatsController } = require('../lib/proxy/controllers/stats-controller');

// ---------- helpers ----------

/** Build a mock request */
function mockReq(method, url, headers = {}, bodyObj = null) {
    const listeners = {};
    const req = {
        method,
        url,
        headers: { host: 'localhost:3100', ...headers },
        socket: { remoteAddress: '127.0.0.1' },
        on(event, cb) { (listeners[event] = listeners[event] || []).push(cb); return req; },
        once(event, cb) { (listeners[event] = listeners[event] || []).push(cb); return req; },
        destroy() {},
        _emit(event, data) {
            (listeners[event] || []).forEach(cb => cb(data));
        }
    };

    // Auto-emit body on next tick if bodyObj provided
    if (bodyObj !== null && bodyObj !== undefined) {
        const bodyStr = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
        process.nextTick(() => {
            req._emit('data', Buffer.from(bodyStr));
            req._emit('end');
        });
    } else {
        process.nextTick(() => req._emit('end'));
    }

    return req;
}

/** Build a mock response that captures writeHead/end */
function mockRes() {
    const res = {
        statusCode: null,
        headers: {},
        body: null,
        headersSent: false,
        writeHead(status, hdrs) {
            res.statusCode = status;
            res.headers = { ...res.headers, ...hdrs };
            res.headersSent = true;
        },
        end(body) {
            res.body = body;
        },
        setHeader(k, v) { res.headers[k] = v; }
    };
    return res;
}

// ==========================================================
// 1. Unit tests for requireJsonContentType helper
// ==========================================================

describe('requireJsonContentType (validation helper)', () => {
    test('returns true for application/json', () => {
        const req = mockReq('POST', '/', { 'content-type': 'application/json' });
        expect(requireJsonContentType(req)).toBe(true);
    });

    test('returns true for application/json; charset=utf-8', () => {
        const req = mockReq('POST', '/', { 'content-type': 'application/json; charset=utf-8' });
        expect(requireJsonContentType(req)).toBe(true);
    });

    test('returns true for APPLICATION/JSON (case-insensitive)', () => {
        const req = mockReq('POST', '/', { 'content-type': 'APPLICATION/JSON' });
        expect(requireJsonContentType(req)).toBe(true);
    });

    test('returns false for text/plain', () => {
        const req = mockReq('POST', '/', { 'content-type': 'text/plain' });
        expect(requireJsonContentType(req)).toBe(false);
    });

    test('returns false for multipart/form-data', () => {
        const req = mockReq('POST', '/', { 'content-type': 'multipart/form-data' });
        expect(requireJsonContentType(req)).toBe(false);
    });

    test('returns false for application/xml', () => {
        const req = mockReq('POST', '/', { 'content-type': 'application/xml' });
        expect(requireJsonContentType(req)).toBe(false);
    });

    test('returns true when Content-Type header is missing (empty body assumed)', () => {
        const req = mockReq('POST', '/', {});
        expect(requireJsonContentType(req)).toBe(true);
    });

    test('returns false for application/x-www-form-urlencoded', () => {
        const req = mockReq('POST', '/', { 'content-type': 'application/x-www-form-urlencoded' });
        expect(requireJsonContentType(req)).toBe(false);
    });
});

// ==========================================================
// 2. Controller integration: POST endpoints reject non-JSON
// ==========================================================

describe('POST/PUT endpoints reject non-JSON Content-Type with 415', () => {

    test('WebhookController.handleWebhookTest rejects text/plain with 415', async () => {
        const controller = new WebhookController({
            webhookManager: { testWebhook: jest.fn() },
            bodyParser: async () => ({ url: 'http://example.com' })
        });

        const req = mockReq('POST', '/webhooks/test', { 'content-type': 'text/plain' }, '{"url":"http://example.com"}');
        const res = mockRes();

        await controller.handleWebhookTest(req, res);

        expect(res.statusCode).toBe(415);
        const body = JSON.parse(res.body);
        expect(body.error).toMatch(/Unsupported Media Type|content-type/i);
    });

    test('ModelController.handleModelRouting PUT rejects text/plain with 415', async () => {
        const mockRouter = {
            config: { enabled: true, version: '2.0' },
            toJSON: () => ({ enabled: true }),
            updateConfig: jest.fn(),
            getOverrides: () => ({})
        };

        const controller = new ModelController({
            modelRouter: mockRouter,
            config: {}
        });

        const req = mockReq('PUT', '/model-routing', { 'content-type': 'text/plain' }, '{"enabled":true}');
        const res = mockRes();

        await controller.handleModelRouting(req, res);

        expect(res.statusCode).toBe(415);
        const body = JSON.parse(res.body);
        expect(body.error).toMatch(/Unsupported Media Type|content-type/i);
    });

    test('ModelController.handleModelRoutingOverrides PUT rejects multipart/form-data with 415', async () => {
        const mockRouter = {
            config: { enabled: true },
            getOverrides: () => ({}),
            setOverride: jest.fn()
        };

        const controller = new ModelController({ modelRouter: mockRouter });

        const req = mockReq('PUT', '/model-routing/overrides', { 'content-type': 'multipart/form-data' }, '{"key":"k","model":"m"}');
        const res = mockRes();

        await controller.handleModelRoutingOverrides(req, res);

        expect(res.statusCode).toBe(415);
        const body = JSON.parse(res.body);
        expect(body.error).toMatch(/Unsupported Media Type|content-type/i);
    });

    test('ModelController.handleModelRoutingEnableSafe PUT rejects application/xml with 415', async () => {
        const mockRouter = {
            config: { enabled: false, version: '2.0' },
            toJSON: () => ({}),
            updateConfig: jest.fn()
        };

        const controller = new ModelController({ modelRouter: mockRouter });

        const req = mockReq('PUT', '/model-routing/enable-safe', { 'content-type': 'application/xml' }, '{"addDefaultRules":true}');
        const res = mockRes();

        await controller.handleModelRoutingEnableSafe(req, res);

        expect(res.statusCode).toBe(415);
        const body = JSON.parse(res.body);
        expect(body.error).toMatch(/Unsupported Media Type|content-type/i);
    });
});

// ==========================================================
// 3. POST/PUT endpoints accept application/json
// ==========================================================

describe('POST/PUT endpoints accept application/json', () => {

    test('WebhookController.handleWebhookTest accepts application/json', async () => {
        const controller = new WebhookController({
            webhookManager: { testWebhook: jest.fn().mockResolvedValue({ success: true }) }
        });

        const req = mockReq('POST', '/webhooks/test', { 'content-type': 'application/json' }, { url: 'http://example.com' });
        const res = mockRes();

        await controller.handleWebhookTest(req, res);

        expect(res.statusCode).not.toBe(415);
    });

    test('ModelController.handleModelRouting PUT accepts application/json', async () => {
        const mockRouter = {
            config: { enabled: true, version: '2.0', tiers: {}, rules: [], defaultModel: 'test' },
            toJSON: () => ({ enabled: true }),
            updateConfig: jest.fn(),
            getOverrides: () => ({})
        };

        const controller = new ModelController({ modelRouter: mockRouter });

        const req = mockReq('PUT', '/model-routing', { 'content-type': 'application/json' }, { enabled: true });
        const res = mockRes();

        await controller.handleModelRouting(req, res);

        // Should not be 415 — it may be 200 or 400 depending on validation, but never 415
        expect(res.statusCode).not.toBe(415);
    });

    test('ModelController.handleModelRoutingOverrides PUT accepts application/json', async () => {
        const mockRouter = {
            config: { enabled: true },
            getOverrides: () => ({}),
            setOverride: jest.fn()
        };

        const controller = new ModelController({ modelRouter: mockRouter });

        const req = mockReq('PUT', '/model-routing/overrides', { 'content-type': 'application/json' }, { key: 'k', model: 'm' });
        const res = mockRes();

        await controller.handleModelRoutingOverrides(req, res);

        expect(res.statusCode).not.toBe(415);
    });
});

// ==========================================================
// 4. POST endpoints accept application/json; charset=utf-8
// ==========================================================

describe('POST/PUT endpoints accept application/json with charset', () => {

    test('WebhookController.handleWebhookTest accepts application/json; charset=utf-8', async () => {
        const controller = new WebhookController({
            webhookManager: { testWebhook: jest.fn().mockResolvedValue({ success: true }) }
        });

        const req = mockReq('POST', '/webhooks/test', { 'content-type': 'application/json; charset=utf-8' }, { url: 'http://example.com' });
        const res = mockRes();

        await controller.handleWebhookTest(req, res);

        expect(res.statusCode).not.toBe(415);
    });

    test('ModelController.handleModelRouting PUT accepts application/json; charset=utf-8', async () => {
        const mockRouter = {
            config: { enabled: true, version: '2.0', tiers: {}, rules: [], defaultModel: 'test' },
            toJSON: () => ({ enabled: true }),
            updateConfig: jest.fn(),
            getOverrides: () => ({})
        };

        const controller = new ModelController({ modelRouter: mockRouter });

        const req = mockReq('PUT', '/model-routing', { 'content-type': 'application/json; charset=utf-8' }, { enabled: true });
        const res = mockRes();

        await controller.handleModelRouting(req, res);

        expect(res.statusCode).not.toBe(415);
    });

    test('ModelController.handleModelRoutingEnableSafe PUT accepts application/json; charset=utf-8', async () => {
        const mockRouter = {
            config: { enabled: false, version: '2.0', tiers: {}, rules: [] },
            toJSON: () => ({}),
            updateConfig: jest.fn()
        };

        const controller = new ModelController({ modelRouter: mockRouter });

        const req = mockReq('PUT', '/model-routing/enable-safe', { 'content-type': 'application/json; charset=utf-8' }, { addDefaultRules: true });
        const res = mockRes();

        await controller.handleModelRoutingEnableSafe(req, res);

        expect(res.statusCode).not.toBe(415);
    });
});

// ==========================================================
// 5. GET/DELETE endpoints don't require Content-Type
// ==========================================================

describe('GET/DELETE endpoints do not require Content-Type', () => {

    test('WebhookController.handleWebhooks GET works without Content-Type', () => {
        const controller = new WebhookController({
            webhookManager: { getEndpoints: () => [], getDeliveryStats: () => ({}) }
        });

        const req = mockReq('GET', '/webhooks', {});
        const res = mockRes();

        controller.handleWebhooks(req, res);

        expect(res.statusCode).toBe(200);
    });

    test('ModelController.handleModelRouting GET works without Content-Type', async () => {
        const mockRouter = {
            config: { enabled: true, version: '2.0' },
            toJSON: () => ({ enabled: true }),
        };

        const controller = new ModelController({ modelRouter: mockRouter });

        const req = mockReq('GET', '/model-routing', {});
        const res = mockRes();

        await controller.handleModelRouting(req, res);

        expect(res.statusCode).toBe(200);
    });

    test('ModelController.handleModelRoutingOverrides GET works without Content-Type', async () => {
        const mockRouter = {
            config: { enabled: true },
            getOverrides: () => ({ key1: 'model1' })
        };

        const controller = new ModelController({ modelRouter: mockRouter });

        const req = mockReq('GET', '/model-routing/overrides', {});
        const res = mockRes();

        await controller.handleModelRoutingOverrides(req, res);

        expect(res.statusCode).toBe(200);
    });

    test('ModelController.handleModelsRequest GET works without Content-Type', async () => {
        const controller = new ModelController({
            modelDiscovery: { getModels: async () => ['a'], getCacheStats: () => ({}) }
        });

        const req = mockReq('GET', '/models', {});
        const res = mockRes();

        await controller.handleModelsRequest(req, res);

        expect(res.statusCode).toBe(200);
    });

    test('ModelController.handleModelRoutingOverrides DELETE works without Content-Type header', async () => {
        const mockRouter = {
            config: { enabled: true },
            getOverrides: () => ({}),
            clearOverride: jest.fn()
        };

        const controller = new ModelController({ modelRouter: mockRouter });

        // DELETE still needs body but does not require Content-Type header
        const req = mockReq('DELETE', '/model-routing/overrides', {}, { key: 'k' });
        const res = mockRes();

        await controller.handleModelRoutingOverrides(req, res);

        // Should not be 415 - DELETE is not a body-carrying method we validate
        expect(res.statusCode).not.toBe(415);
    });
});
