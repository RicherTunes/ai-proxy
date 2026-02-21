'use strict';

const { parseJsonBody, parseRawBody } = require('../lib/body-parser');
const { Readable } = require('stream');

function mockReq(data, opts = {}) {
    const readable = new Readable({
        read() {
            if (typeof data === 'string') {
                this.push(Buffer.from(data));
            } else if (Buffer.isBuffer(data)) {
                this.push(data);
            } else if (data !== null) {
                this.push(Buffer.from(JSON.stringify(data)));
            }
            this.push(null);
        }
    });
    readable.destroy = opts.destroy || (() => {});
    return readable;
}

describe('body-parser', () => {
    describe('parseRawBody', () => {
        test('reads full body', async () => {
            const req = mockReq('hello world');
            const body = await parseRawBody(req);
            expect(body).toBe('hello world');
        });

        test('rejects when exceeding maxSize', async () => {
            const bigData = 'x'.repeat(2000);
            const destroyed = jest.fn();
            const req = mockReq(bigData, { destroy: destroyed });

            await expect(parseRawBody(req, { maxSize: 100 }))
                .rejects.toEqual({ statusCode: 413, message: 'Payload too large' });
            expect(destroyed).toHaveBeenCalled();
        });

        test('handles empty body', async () => {
            const req = mockReq('');
            const body = await parseRawBody(req);
            expect(body).toBe('');
        });
    });

    describe('parseJsonBody', () => {
        test('parses valid JSON', async () => {
            const req = mockReq({ key: 'value', num: 42 });
            const result = await parseJsonBody(req);
            expect(result).toEqual({ key: 'value', num: 42 });
        });

        test('returns empty object for empty body when allowEmpty', async () => {
            const req = mockReq('');
            const result = await parseJsonBody(req, { allowEmpty: true });
            expect(result).toEqual({});
        });

        test('rejects invalid JSON', async () => {
            const req = mockReq('not json {{{');
            await expect(parseJsonBody(req))
                .rejects.toEqual({ statusCode: 400, message: 'Invalid JSON body' });
        });

        test('rejects when too large', async () => {
            const bigJson = JSON.stringify({ data: 'x'.repeat(2000) });
            const destroyed = jest.fn();
            const req = mockReq(bigJson, { destroy: destroyed });

            await expect(parseJsonBody(req, { maxSize: 100 }))
                .rejects.toEqual({ statusCode: 413, message: 'Payload too large' });
        });
    });
});
