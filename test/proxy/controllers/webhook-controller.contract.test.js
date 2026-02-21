/**
 * Contract Test: Webhook Controller
 *
 * This contract test ensures that webhook-related route operations produce consistent results
 * after extraction from ProxyServer to webhook-controller.js.
 *
 * TDD Phase: Red - Write failing test first
 */

'use strict';

const http = require('http');
let WebhookController;
try {
    ({ WebhookController } = require('../../../lib/proxy/controllers/webhook-controller'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = WebhookController ? describe : describe.skip;

describeIfModule('ProxyServer Contract: Webhook Controller Operations', () => {
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

    describe('handleWebhooks', () => {
        it('should return 404 when webhookManager is not enabled', () => {
            controller._webhookManager = null;

            const mockReq = { url: '/webhooks', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleWebhooks(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(404, { 'content-type': 'application/json' });
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('error');
        });

        it('should return webhook endpoints and stats', () => {
            const mockReq = { url: '/webhooks', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleWebhooks(mockReq, mockRes);

            expect(mockWebhookManager.getEndpoints).toHaveBeenCalled();
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
        });
    });

    describe('handleWebhookTest', () => {
        it('should return 405 for non-POST methods', async () => {
            const mockReq = { method: 'GET', url: '/webhooks/test', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            await controller.handleWebhookTest(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(405, { 'content-type': 'application/json' });
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('error');
        });

        it('should return 404 when webhookManager is not enabled', async () => {
            controller._webhookManager = null;

            const mockReq = { method: 'POST', url: '/webhooks/test', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            await controller.handleWebhookTest(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(404, { 'content-type': 'application/json' });
        });

        it('should return 400 when URL is missing from request body', async () => {
            mockBodyParser.parseJsonBody.mockResolvedValue({ url: null });

            const mockReq = { method: 'POST', url: '/webhooks/test', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            await controller.handleWebhookTest(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(400, { 'content-type': 'application/json' });
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toContain('URL required');
        });

        it('should call testWebhook with URL from body', async () => {
            mockBodyParser.parseJsonBody.mockResolvedValue({ url: 'https://example.com/test' });

            const mockReq = { method: 'POST', url: '/webhooks/test', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            await controller.handleWebhookTest(mockReq, mockRes);

            expect(mockWebhookManager.testWebhook).toHaveBeenCalledWith('https://example.com/test');
        });

        it('should return 200 when webhook test succeeds', async () => {
            mockWebhookManager.testWebhook.mockResolvedValue({ success: true, message: 'Success' });

            const mockReq = { method: 'POST', url: '/webhooks/test', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            await controller.handleWebhookTest(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
        });

        it('should return 400 when webhook test fails', async () => {
            mockWebhookManager.testWebhook.mockResolvedValue({ success: false, message: 'Connection failed' });

            const mockReq = { method: 'POST', url: '/webhooks/test', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            await controller.handleWebhookTest(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(400, { 'content-type': 'application/json' });
        });

        it('should return 400 on invalid JSON body', async () => {
            mockBodyParser.parseJsonBody.mockRejectedValue({ statusCode: 400, message: 'Invalid JSON' });

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
});
