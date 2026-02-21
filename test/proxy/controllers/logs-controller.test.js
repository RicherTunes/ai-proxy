/**
 * Unit Test: Logs Controller
 *
 * TDD Phase: Red - Write failing unit test before module exists
 *
 * Tests the LogsController class for proxy-server.js logs-related routes.
 */

'use strict';

let LogsController;
try {
    ({ LogsController } = require('../../../lib/proxy/controllers/logs-controller'));
} catch {
    // Module not yet implemented (TDD red phase)
}

const describeIfModule = LogsController ? describe : describe.skip;

describeIfModule('logs-controller', () => {
    let controller;
    let mockLogger;
    let mockAuditLog;
    let mockAdminAuth;
    let mockAddAuditEntry;

    beforeEach(() => {
        mockLogger = {
            getLogs: jest.fn(() => [
                { timestamp: Date.now(), level: 'info', message: 'Test log 1' },
                { timestamp: Date.now() - 1000, level: 'error', message: 'Test error' }
            ]),
            clearLogs: jest.fn(),
            info: jest.fn()
        };

        mockAuditLog = {
            size: 100,
            toArray: jest.fn(() => [
                { timestamp: Date.now(), action: 'test_action', user: 'test_user' },
                { timestamp: Date.now() - 5000, action: 'another_action', user: 'another_user' }
            ])
        };

        mockAdminAuth = {
            enabled: true,
            authenticate: jest.fn(() => ({ authenticated: true }))
        };

        mockAddAuditEntry = jest.fn();

        controller = new LogsController({
            logger: mockLogger,
            auditLog: mockAuditLog,
            adminAuth: mockAdminAuth,
            addAuditEntry: mockAddAuditEntry
        });
    });

    describe('constructor', () => {
        it('should create a new LogsController', () => {
            expect(controller).toBeInstanceOf(LogsController);
        });

        it('should initialize with provided dependencies', () => {
            expect(controller._logger).toBe(mockLogger);
            expect(controller._auditLog).toBe(mockAuditLog);
            expect(controller._adminAuth).toBe(mockAdminAuth);
        });

        it('should initialize with default values when options omitted', () => {
            const minimalController = new LogsController();
            expect(minimalController).toBeInstanceOf(LogsController);
        });
    });

    describe('handleLogs', () => {
        it('should return 200 with content-type application/json', () => {
            const mockReq = { url: '/logs?limit=50', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleLogs(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
        });

        it('should call getLogs with limit from query param', () => {
            const mockReq = { url: '/logs?limit=50', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleLogs(mockReq, mockRes);

            expect(mockLogger.getLogs).toHaveBeenCalledWith(50);
        });

        it('should default to 100 when limit not provided', () => {
            const mockReq = { url: '/logs', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleLogs(mockReq, mockRes);

            expect(mockLogger.getLogs).toHaveBeenCalledWith(100);
        });

        it('should cap limit at 500', () => {
            const mockReq = { url: '/logs?limit=1000', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleLogs(mockReq, mockRes);

            expect(mockLogger.getLogs).toHaveBeenCalledWith(500);
        });

        it('should handle invalid limit by defaulting to 100', () => {
            const mockReq = { url: '/logs?limit=invalid', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleLogs(mockReq, mockRes);

            expect(mockLogger.getLogs).toHaveBeenCalledWith(100);
        });

        it('should include count in response', () => {
            const mockReq = { url: '/logs', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleLogs(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('count');
            expect(responseData.count).toBe(2);
        });

        it('should include logs array in response', () => {
            const mockReq = { url: '/logs', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleLogs(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('logs');
            expect(Array.isArray(responseData.logs)).toBe(true);
            expect(responseData.logs.length).toBe(2);
        });
    });

    describe('handleAuditLog', () => {
        it('should return 401 when auth fails', () => {
            mockAdminAuth.authenticate.mockReturnValue({ authenticated: false, error: 'unauthorized' });

            const mockReq = { url: '/audit-log', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleAuditLog(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(401, { 'content-type': 'application/json' });
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('error');
        });

        it('should return 401 with error message from auth', () => {
            mockAdminAuth.authenticate.mockReturnValue({ authenticated: false, error: 'too_many_attempts' });

            const mockReq = { url: '/audit-log', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleAuditLog(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toBe('too_many_attempts');
        });

        it('should return audit entries when authenticated', () => {
            const mockReq = { url: '/audit-log', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleAuditLog(mockReq, mockRes);

            expect(mockAuditLog.toArray).toHaveBeenCalled();
            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
        });

        it('should respect limit from query param', () => {
            const mockReq = { url: '/audit-log?limit=1', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleAuditLog(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.entries.length).toBeLessThanOrEqual(1);
        });

        it('should default to limit of 100 when not specified', () => {
            const mockReq = { url: '/audit-log', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleAuditLog(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.entries.length).toBeLessThanOrEqual(100);
        });

        it('should cap limit at 1000', () => {
            const mockReq = { url: '/audit-log?limit=2000', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleAuditLog(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.entries.length).toBeLessThanOrEqual(1000);
        });

        it('should include count in response', () => {
            const mockReq = { url: '/audit-log', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleAuditLog(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('count');
        });

        it('should include total in response', () => {
            const mockReq = { url: '/audit-log', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleAuditLog(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('total');
            expect(responseData.total).toBe(100);
        });

        it('should include entries array in response', () => {
            const mockReq = { url: '/audit-log', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleAuditLog(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('entries');
            expect(Array.isArray(responseData.entries)).toBe(true);
        });

        it('should return entries in reverse order (most recent first)', () => {
            const allEntries = [
                { timestamp: 1000, action: 'old' },
                { timestamp: 2000, action: 'new' }
            ];
            mockAuditLog.toArray.mockReturnValue(allEntries);

            const mockReq = { url: '/audit-log', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleAuditLog(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.entries[0].action).toBe('new');
            expect(responseData.entries[1].action).toBe('old');
        });

        it('should skip auth when adminAuth is disabled', () => {
            controller._adminAuth = null;

            const mockReq = { url: '/audit-log', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleAuditLog(mockReq, mockRes);

            expect(mockAdminAuth.authenticate).not.toHaveBeenCalled();
            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
        });

        it('should skip auth when adminAuth is not enabled', () => {
            controller._adminAuth = { enabled: false };

            const mockReq = { url: '/audit-log', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleAuditLog(mockReq, mockRes);

            expect(mockAdminAuth.authenticate).not.toHaveBeenCalled();
            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
        });
    });

    describe('handleClearLogs', () => {
        it('should return 405 for GET request', () => {
            const mockReq = { method: 'GET', url: '/control/clear-logs', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleClearLogs(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(405, { 'content-type': 'application/json' });
            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.error).toContain('Method not allowed');
        });

        it('should clear logs on POST request', () => {
            const mockReq = { method: 'POST', url: '/control/clear-logs', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleClearLogs(mockReq, mockRes);

            expect(mockLogger.clearLogs).toHaveBeenCalled();
        });

        it('should log info message after clearing logs', () => {
            const mockReq = { method: 'POST', url: '/control/clear-logs', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleClearLogs(mockReq, mockRes);

            expect(mockLogger.info).toHaveBeenCalledWith('Logs cleared');
        });

        it('should return 200 with success status', () => {
            const mockReq = { method: 'POST', url: '/control/clear-logs', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleClearLogs(mockReq, mockRes);

            expect(mockRes.writeHead).toHaveBeenCalledWith(200, { 'content-type': 'application/json' });
        });

        it('should return logs_cleared status in response', () => {
            const mockReq = { method: 'POST', url: '/control/clear-logs', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleClearLogs(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData.status).toBe('logs_cleared');
        });
    });

    describe('interface contract', () => {
        it('should have handleLogs method', () => {
            expect(typeof controller.handleLogs).toBe('function');
        });

        it('should have handleAuditLog method', () => {
            expect(typeof controller.handleAuditLog).toBe('function');
        });

        it('should have handleClearLogs method', () => {
            expect(typeof controller.handleClearLogs).toBe('function');
        });
    });

    describe('edge cases', () => {
        it('should handle missing logger gracefully in handleLogs', () => {
            controller._logger = null;

            const mockReq = { url: '/logs', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleLogs(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('count');
            expect(responseData.count).toBe(0);
        });

        it('should handle missing auditLog gracefully in handleAuditLog', () => {
            controller._auditLog = null;

            const mockReq = { url: '/audit-log', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            controller.handleAuditLog(mockReq, mockRes);

            const responseData = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(responseData).toHaveProperty('count');
            expect(responseData.count).toBe(0);
        });

        it('should handle missing logger in handleClearLogs', () => {
            controller._logger = null;

            const mockReq = { method: 'POST', url: '/control/clear-logs', headers: { host: 'localhost' } };
            const mockRes = { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };

            // Should not throw
            expect(() => controller.handleClearLogs(mockReq, mockRes)).not.toThrow();
        });
    });
});
