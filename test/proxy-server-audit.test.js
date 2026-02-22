'use strict';

const { ProxyServer } = require('../lib/proxy-server');

function createMockServer() {
    const server = Object.create(ProxyServer.prototype);
    server.config = { security: { auditLog: { enabled: true } } };
    server.logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    server.costTracker = {
        rates: { inputTokenPer1M: 3, outputTokenPer1M: 15 },
        modelRates: {},
        budget: { daily: 10, monthly: 100, alertThresholds: [0.8] },
        saveDebounceMs: 5000,
        persistPath: '/tmp/costs.json',
        setRates: jest.fn(),
        setBudget: jest.fn()
    };
    server._auditLog = { push: jest.fn() };
    server._auditFileBuffer = [];
    return server;
}

function mockReq(body) {
    const chunks = [Buffer.from(JSON.stringify(body))];
    return {
        method: 'POST',
        socket: { remoteAddress: '10.0.0.1' },
        headers: {},
        [Symbol.asyncIterator]() {
            let i = 0;
            return {
                next() {
                    if (i < chunks.length) return Promise.resolve({ value: chunks[i++], done: false });
                    return Promise.resolve({ value: undefined, done: true });
                }
            };
        }
    };
}

function mockRes() {
    const res = {
        statusCode: null,
        headers: {},
        body: '',
        writeHead(code, hdrs) { res.statusCode = code; Object.assign(res.headers, hdrs); },
        end(data) { res.body = data || ''; }
    };
    return res;
}

describe('Cost-tracking config audit entries (COST-09)', () => {
    let server;

    beforeEach(() => {
        server = createMockServer();
    });

    test('rates update creates audit entry', async () => {
        const req = mockReq({ rates: { inputTokenPer1M: 5, outputTokenPer1M: 20 } });
        const res = mockRes();
        await server._handleCostTrackingConfig(req, res);
        expect(res.statusCode).toBe(200);
        const calls = server._auditLog.push.mock.calls;
        const entry = calls.find(c => c[0].event === 'cost_tracking_rates_updated');
        expect(entry).toBeTruthy();
        expect(entry[0].ip).toBe('10.0.0.1');
        expect(entry[0].changes).toEqual({ inputTokenPer1M: 5, outputTokenPer1M: 20 });
    });

    test('model rates update creates audit entry', async () => {
        const req = mockReq({ modelRates: { 'gpt-4': { inputTokenPer1M: 30 } } });
        const res = mockRes();
        await server._handleCostTrackingConfig(req, res);
        expect(res.statusCode).toBe(200);
        const calls = server._auditLog.push.mock.calls;
        const entry = calls.find(c => c[0].event === 'cost_tracking_model_rates_updated');
        expect(entry).toBeTruthy();
        expect(entry[0].models).toEqual(['gpt-4']);
    });

    test('budget update creates audit entry', async () => {
        const req = mockReq({ budget: { daily: 50, monthly: 500, alertThresholds: [0.9] } });
        const res = mockRes();
        await server._handleCostTrackingConfig(req, res);
        expect(res.statusCode).toBe(200);
        const calls = server._auditLog.push.mock.calls;
        const entry = calls.find(c => c[0].event === 'cost_tracking_budget_updated');
        expect(entry).toBeTruthy();
        expect(entry[0].changes.daily).toBe(50);
    });

    test('saveDebounceMs update creates audit entry', async () => {
        const req = mockReq({ saveDebounceMs: 10000 });
        const res = mockRes();
        await server._handleCostTrackingConfig(req, res);
        expect(res.statusCode).toBe(200);
        const calls = server._auditLog.push.mock.calls;
        const entry = calls.find(c => c[0].event === 'cost_tracking_config_updated');
        expect(entry).toBeTruthy();
        expect(entry[0].changes.saveDebounceMs).toBe(10000);
    });

    test('empty update produces no audit entries', async () => {
        const req = mockReq({});
        const res = mockRes();
        await server._handleCostTrackingConfig(req, res);
        expect(res.statusCode).toBe(200);
        expect(server._auditLog.push).not.toHaveBeenCalled();
    });

    test('rates + budget update produces two audit entries', async () => {
        const req = mockReq({
            rates: { inputTokenPer1M: 7 },
            budget: { daily: 25 }
        });
        const res = mockRes();
        await server._handleCostTrackingConfig(req, res);
        expect(res.statusCode).toBe(200);
        const calls = server._auditLog.push.mock.calls;
        const events = calls.map(c => c[0].event);
        expect(events).toContain('cost_tracking_rates_updated');
        expect(events).toContain('cost_tracking_budget_updated');
        expect(calls.length).toBe(2);
    });
});
