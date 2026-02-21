'use strict';

const { ProxyServer } = require('../lib/proxy-server');

describe('ProxyServer /requests/:id/payload', () => {
    let server;

    beforeEach(() => {
        server = Object.create(ProxyServer.prototype);
        server.requestHandler = {
            getRequestPayload: jest.fn()
        };
        server.requestTraces = {
            toArray: jest.fn().mockReturnValue([]),
            size: 0
        };
        server._sendJson = jest.fn();
        server._sendError = jest.fn();
    });

    test('returns payload snapshot when available', () => {
        const payload = { json: '{ "hello": "world" }', truncated: false };
        server.requestHandler.getRequestPayload.mockReturnValue(payload);

        const req = {
            method: 'GET',
            url: '/requests/req-123/payload',
            headers: { host: 'localhost:3000' }
        };
        const res = {};

        server._handleRequests(req, res, '/requests/req-123/payload');

        expect(server.requestHandler.getRequestPayload).toHaveBeenCalledWith('req-123');
        expect(server._sendJson).toHaveBeenCalledWith(res, 200, {
            requestId: 'req-123',
            payload
        });
        expect(server._sendError).not.toHaveBeenCalled();
    });

    test('decodes URL-encoded request id', () => {
        const payload = { json: '{ "ok": true }', truncated: false };
        server.requestHandler.getRequestPayload.mockReturnValue(payload);

        const req = {
            method: 'GET',
            url: '/requests/trace%2Fabc/payload',
            headers: { host: 'localhost:3000' }
        };
        const res = {};

        server._handleRequests(req, res, '/requests/trace%2Fabc/payload');

        expect(server.requestHandler.getRequestPayload).toHaveBeenCalledWith('trace/abc');
        expect(server._sendJson).toHaveBeenCalledWith(res, 200, {
            requestId: 'trace/abc',
            payload
        });
    });

    test('returns 404 when payload snapshot is unavailable', () => {
        server.requestHandler.getRequestPayload.mockReturnValue(null);

        const req = {
            method: 'GET',
            url: '/requests/req-missing/payload',
            headers: { host: 'localhost:3000' }
        };
        const res = {};

        server._handleRequests(req, res, '/requests/req-missing/payload');

        expect(server._sendError).toHaveBeenCalledWith(res, 404, 'Payload not found');
        expect(server._sendJson).not.toHaveBeenCalled();
    });
});
