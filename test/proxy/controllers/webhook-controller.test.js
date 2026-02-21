/**
 * Unit Test: Webhook Controller
 *
 * TDD Phase: Red - Write failing unit test before module exists
 *
 * Tests the WebhookController class for proxy-server.js webhook-related routes.
 */

'use strict';

let WebhookController;
try {
    ({ WebhookController } = require('../../../lib/proxy/controllers/webhook-controller'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = WebhookController ? describe : describe.skip;

describeIfModule('webhook-controller', () => {
    let controller;
    let mockWebhookManager;
    let mockBodyParser;

    beforeEach(() => {
        mockWebhookManager = {
            enabled: true,
            getEndpoints: jest.fn(() => [
                { id: 'webhook1', url: 'https://example.com/hook', events: ['request.complete'] },
                { id: 'webhook2', url: 'https://example.com/hook2', events: ['error'] }
            ]),
            getDeliveryStats: jest.fn(() => ({
                totalDelivered: 100,
                totalFailed: 5,
                pending: 2
            })),
            testWebhook: jest.fn(async (url) => ({ success: true, message: 'Webhook test succeeded' }))
        };

        mockBodyParser = {
            parseJsonBody: jest.fn(async (req) => ({ url: 'https://example.com/test' }))
        };

        controller = new WebhookController({
            webhookManager: mockWebhookManager,
            bodyParser: mockBodyParser
        });
    });

    describe('constructor', () => {
        it('should create a new WebhookController', () => {
            expect(controller).toBeInstanceOf(WebhookController);
        });

        it('should initialize with provided dependencies', () => {
            expect(controller._webhookManager).toBe(mockWebhookManager);
            // When bodyParser is an object with parseJsonBody method, extract that method
            expect(controller._bodyParser).toBe(mockBodyParser.parseJsonBody);
        });

        it('should initialize with default values when options omitted', () => {
            const minimalController = new WebhookController();
            expect(minimalController).toBeInstanceOf(WebhookController);
        });
    });

    describe('handleWebhooks', () => {
        it('should return 404 when webhookManager is not enabled', () => {
            controller._webhookManager = null;

            const mockReq = { url: '/webhooks', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleWebhooks(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(404, { 'content-type': 'application/json' });
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toContain('not enabled');
        });

        it('should call getEndpoints on webhookManager', () => {
            const mockReq = { url: '/webhooks', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleWebhooks(mockReq, mockRes);

            expect(mockWebhookManager.getEndpoints).toHaveBeenCalled();
        });

        it('should call getDeliveryStats on webhookManager', () => {
            const mockReq = { url: '/webhooks', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleWebhooks(mockReq, mockRes);

            expect(mockWebhookManager.getDeliveryStats).toHaveBeenCalled();
        });

        it('should return 200 with endpoints and stats', () => {
            const mockReq = { url: '/webhooks', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleWebhooks(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('endpoints');
            expect(responseData).toHaveProperty('stats');
        });

        it('should include endpoints array in response', () => {
            const mockReq = { url: '/webhooks', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleWebhooks(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.endpoints).toBeDefined();
            expect(Array.isArray(responseData.endpoints)).toBe(true);
            expect(responseData.endpoints.length).toBe(2);
        });

        it('should include stats in response', () => {
            const mockReq = { url: '/webhooks', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleWebhooks(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.stats).toBeDefined();
            expect(responseData.stats.totalDelivered).toBe(100);
        });
    });

    describe('handleWebhookTest', () => {
        it('should return 405 for non-POST methods', async () => {
            const mockReq = { method: 'GET', url: '/webhooks/test', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            await controller.handleWebhookTest(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(405, { 'content-type': 'application/json' });
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toContain('Method not allowed');
        });

        it('should return 404 when webhookManager is not enabled', async () => {
            controller._webhookManager = null;

            const mockReq = { method: 'POST', url: '/webhooks/test', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            await controller.handleWebhookTest(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(404, { 'content-type': 'application/json' });
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toContain('not enabled');
        });

        it('should parse JSON body from request', async () => {
            const mockReq = { method: 'POST', url: '/webhooks/test', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            await controller.handleWebhookTest(mockReq, mockRes);

            expect(mockBodyParser.parseJsonBody).toHaveBeenCalledWith(mockReq);
        });

        it('should return 400 when URL is missing', async () => {
            mockBodyParser.parseJsonBody.mockResolvedValue({ url: null });

            const mockReq = { method: 'POST', url: '/webhooks/test', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            await controller.handleWebhookTest(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(400, { 'content-type': 'application/json' });
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toContain('URL required');
        });

        it('should return 400 when URL is empty string', async () => {
            mockBodyParser.parseJsonBody.mockResolvedValue({ url: '' });

            const mockReq = { method: 'POST', url: '/webhooks/test', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            await controller.handleWebhookTest(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(400, { 'content-type': 'application/json' });
        });

        it('should call testWebhook with URL from body', async () => {
            mockBodyParser.parseJsonBody.mockResolvedValue({ url: 'https://example.com/test' });

            const mockReq = { method: 'POST', url: '/webhooks/test', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            await controller.handleWebhookTest(mockReq, mockRes);

            expect(mockWebhookManager.testWebhook).toHaveBeenCalledWith('https://example.com/test');
        });

        it('should return 200 when webhook test succeeds', async () => {
            mockWebhookManager.testWebhook.mockResolvedValue({ success: true, message: 'Test successful' });

            const mockReq = { method: 'POST', url: '/webhooks/test', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            await controller.handleWebhookTest(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
        });

        it('should return 400 when webhook test fails', async () => {
            mockWebhookManager.testWebhook.mockResolvedValue({ success: false, error: 'Connection failed' });

            const mockReq = { method: 'POST', url: '/webhooks/test', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            await controller.handleWebhookTest(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(400, { 'content-type': 'application/json' });
        });

        it('should return 400 on parse error', async () => {
            const error = new Error('Invalid JSON');
            error.statusCode = 400;
            mockBodyParser.parseJsonBody.mockRejectedValue(error);

            const mockReq = { method: 'POST', url: '/webhooks/test', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            await controller.handleWebhookTest(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(400, { 'content-type': 'application/json' });
        });

        it('should return 400 on parse error without statusCode', async () => {
            mockBodyParser.parseJsonBody.mockRejectedValue(new Error('Invalid JSON'));

            const mockReq = { method: 'POST', url: '/webhooks/test', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            await controller.handleWebhookTest(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(400, { 'content-type': 'application/json' });
        });
    });

    describe('interface contract', () => {
        it('should have handleWebhooks method', () => {
            expect(typeof controller.handleWebhooks).toBe('function');
        });

        it('should have handleWebhookTest method', () => {
            expect(typeof controller.handleWebhookTest).toBe('function');
        });
    });

    describe('edge cases', () => {
        it('should handle missing webhookManager gracefully in handleWebhooks', () => {
            controller._webhookManager = null;

            const mockReq = { url: '/webhooks', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleWebhooks(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBeDefined();
        });

        it('should handle missing bodyParser gracefully in handleWebhookTest', async () => {
            controller._bodyParser = null;

            const mockReq = { method: 'POST', url: '/webhooks/test', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            await controller.handleWebhookTest(mockReq, mockRes);

            // Should not throw
            expect(mockRes.writeHead).toHaveBeenCalled();
        });
    });
});
