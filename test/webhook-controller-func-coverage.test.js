/**
 * Function Coverage Tests for webhook-controller.js
 *
 * Target: Push branch coverage from 95.65% to 100%
 * Focus: Line 79 catch block - e.message || 'Invalid JSON body' fallback
 */

'use strict';

const { WebhookController } = require('../lib/proxy/controllers/webhook-controller');

describe('webhook-controller function coverage', () => {
    let controller;
    let mockWebhookManager;
    let mockBodyParser;

    beforeEach(() => {
        mockWebhookManager = {
            enabled: true,
            getEndpoints: jest.fn(() => []),
            getDeliveryStats: jest.fn(() => ({})),
            testWebhook: jest.fn(async () => ({ success: true }))
        };

        mockBodyParser = {
            parseJsonBody: jest.fn(async () => ({ url: 'https://example.com/test' }))
        };

        controller = new WebhookController({
            webhookManager: mockWebhookManager,
            bodyParser: mockBodyParser
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    describe('handleWebhookTest - catch block message fallback', () => {
        // Covers line 79: e.message || 'Invalid JSON body' when error.message is falsy
        it('should use default error message when error has no message property', async () => {
            // Create an error-like object without a message property
            const errorWithoutMessage = { statusCode: 422 };
            mockBodyParser.parseJsonBody.mockRejectedValue(errorWithoutMessage);

            const mockReq = {
                method: 'POST',
                url: '/webhooks/test',
                headers: {
                    'host': 'localhost',
                    'content-type': 'application/json'
                }
            };
            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn()
            };

            await controller.handleWebhookTest(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(
                422,
                expect.objectContaining({
                    'content-type': 'application/json'
                })
            );
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('Invalid JSON body');
        });

        // Covers line 79: e.message || 'Invalid JSON body' when error.message is empty string
        it('should use default error message when error.message is empty string', async () => {
            const errorWithEmptyMessage = new Error();
            errorWithEmptyMessage.message = '';
            errorWithEmptyMessage.statusCode = 422;
            mockBodyParser.parseJsonBody.mockRejectedValue(errorWithEmptyMessage);

            const mockReq = {
                method: 'POST',
                url: '/webhooks/test',
                headers: {
                    'host': 'localhost',
                    'content-type': 'application/json'
                }
            };
            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn()
            };

            await controller.handleWebhookTest(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('Invalid JSON body');
        });

        // Covers line 79: both statusCode and message are missing (double fallback)
        it('should use default status and message when error has neither', async () => {
            // Plain object without statusCode or message
            const plainError = {};
            mockBodyParser.parseJsonBody.mockRejectedValue(plainError);

            const mockReq = {
                method: 'POST',
                url: '/webhooks/test',
                headers: {
                    'host': 'localhost',
                    'content-type': 'application/json'
                }
            };
            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn()
            };

            await controller.handleWebhookTest(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(
                400,
                expect.objectContaining({
                    'content-type': 'application/json'
                })
            );
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('Invalid JSON body');
        });

        // Covers line 79: error with actual message (confirming that path)
        it('should use error message when present', async () => {
            const errorWithMessage = new Error('Custom parse error');
            errorWithMessage.statusCode = 415;
            mockBodyParser.parseJsonBody.mockRejectedValue(errorWithMessage);

            const mockReq = {
                method: 'POST',
                url: '/webhooks/test',
                headers: {
                    'host': 'localhost',
                    'content-type': 'application/json'
                }
            };
            const mockRes = {
                writeHead: jest.fn(),
                end: jest.fn(),
                setHeader: jest.fn()
            };

            await controller.handleWebhookTest(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(
                415,
                expect.objectContaining({
                    'content-type': 'application/json'
                })
            );
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('Custom parse error');
        });
    });
});
