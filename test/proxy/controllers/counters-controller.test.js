'use strict';

const { CountersController } = require('../../../lib/proxy/controllers/counters-controller');
const { COUNTER_SCHEMA } = require('../../../lib/schemas/counters');

describe('CountersController', () => {
    let controller;
    let mockRes;

    beforeEach(() => {
        controller = new CountersController();
        mockRes = {
            setHeader: jest.fn(),
            writeHead: jest.fn(),
            end: jest.fn()
        };
    });

    describe('getSchema()', () => {
        test('sets Content-Type to application/json', () => {
            controller.getSchema({}, mockRes);
            expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
        });

        test('responds with 200 status', () => {
            controller.getSchema({}, mockRes);
            expect(mockRes.writeHead).toHaveBeenCalledWith(200);
        });

        test('returns valid JSON body', () => {
            controller.getSchema({}, mockRes);
            const body = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(body).toHaveProperty('version', '1.0');
            expect(body).toHaveProperty('timestamp');
            expect(body).toHaveProperty('counters');
        });

        test('includes COUNTER_SCHEMA in response', () => {
            controller.getSchema({}, mockRes);
            const body = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(body.counters).toEqual(COUNTER_SCHEMA);
        });

        test('timestamp is a recent epoch millisecond', () => {
            const before = Date.now();
            controller.getSchema({}, mockRes);
            const after = Date.now();
            const body = JSON.parse(mockRes.end.mock.calls[0][0]);
            expect(body.timestamp).toBeGreaterThanOrEqual(before);
            expect(body.timestamp).toBeLessThanOrEqual(after);
        });

        test('body is pretty-printed with 2-space indent', () => {
            controller.getSchema({}, mockRes);
            const raw = mockRes.end.mock.calls[0][0];
            expect(raw).toContain('\n');
            const body = JSON.parse(raw);
            expect(raw).toBe(JSON.stringify(body, null, 2));
        });
    });
});
