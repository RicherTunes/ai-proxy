/**
 * Body Parser Extended Tests
 *
 * Targets uncovered functions and branches:
 * - parseRawBody 'error' event handler (line 37)
 * - parseRawBody 'aborted' event handler (line 38)
 * - DEFAULT_MAX_SIZE export
 * - parseJsonBody with allowEmpty=false and empty body
 * - parseJsonBody with allowEmpty default (true) and null push
 * - Edge cases for size boundary, chunked delivery
 */

'use strict';

const { parseJsonBody, parseRawBody, DEFAULT_MAX_SIZE } = require('../lib/body-parser');
const { Readable } = require('stream');
const { EventEmitter } = require('events');

/** Create a mock request that pushes data then ends. */
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

/**
 * Create a manually-controlled mock request for simulating
 * errors and aborted events.
 */
function manualReq() {
    const emitter = new EventEmitter();
    emitter.destroy = jest.fn();
    return emitter;
}

describe('body-parser extended', () => {
    // ---------------------------------------------------------------
    // DEFAULT_MAX_SIZE export
    // ---------------------------------------------------------------

    describe('DEFAULT_MAX_SIZE', () => {
        test('is exported and equals 1MB', () => {
            expect(DEFAULT_MAX_SIZE).toBe(1 * 1024 * 1024);
        });

        test('is a number', () => {
            expect(typeof DEFAULT_MAX_SIZE).toBe('number');
        });
    });

    // ---------------------------------------------------------------
    // parseRawBody - error and aborted event handlers
    // ---------------------------------------------------------------

    describe('parseRawBody - error event', () => {
        test('rejects with 400 when request emits error event', async () => {
            const req = manualReq();

            const promise = parseRawBody(req);

            // Emit error after a tick
            process.nextTick(() => {
                req.emit('error', new Error('connection reset'));
            });

            await expect(promise).rejects.toEqual({
                statusCode: 400,
                message: 'Request aborted'
            });
        });

        test('rejects with 400 when error occurs after partial data', async () => {
            const req = manualReq();

            const promise = parseRawBody(req);

            process.nextTick(() => {
                req.emit('data', Buffer.from('partial'));
                req.emit('error', new Error('socket hang up'));
            });

            await expect(promise).rejects.toEqual({
                statusCode: 400,
                message: 'Request aborted'
            });
        });
    });

    describe('parseRawBody - aborted event', () => {
        test('rejects with 400 when request is aborted', async () => {
            const req = manualReq();

            const promise = parseRawBody(req);

            process.nextTick(() => {
                req.emit('aborted');
            });

            await expect(promise).rejects.toEqual({
                statusCode: 400,
                message: 'Request aborted'
            });
        });

        test('rejects with 400 when aborted after partial data', async () => {
            const req = manualReq();

            const promise = parseRawBody(req);

            process.nextTick(() => {
                req.emit('data', Buffer.from('some data'));
                req.emit('aborted');
            });

            await expect(promise).rejects.toEqual({
                statusCode: 400,
                message: 'Request aborted'
            });
        });
    });

    // ---------------------------------------------------------------
    // parseRawBody - edge cases
    // ---------------------------------------------------------------

    describe('parseRawBody - edge cases', () => {
        test('handles data delivered in multiple chunks', async () => {
            const req = manualReq();

            const promise = parseRawBody(req);

            process.nextTick(() => {
                req.emit('data', Buffer.from('chunk1'));
                req.emit('data', Buffer.from('chunk2'));
                req.emit('data', Buffer.from('chunk3'));
                req.emit('end');
            });

            const result = await promise;
            expect(result).toBe('chunk1chunk2chunk3');
        });

        test('uses DEFAULT_MAX_SIZE when no maxSize option provided', async () => {
            // A body smaller than 1MB should succeed
            const req = mockReq('small body');
            const result = await parseRawBody(req);
            expect(result).toBe('small body');
        });

        test('rejects at exact boundary when cumulative size exceeds maxSize', async () => {
            const req = manualReq();

            const promise = parseRawBody(req, { maxSize: 10 });

            process.nextTick(() => {
                req.emit('data', Buffer.from('12345'));  // size=5, ok
                req.emit('data', Buffer.from('123456')); // size=11, exceeds 10
            });

            await expect(promise).rejects.toEqual({
                statusCode: 413,
                message: 'Payload too large'
            });
            expect(req.destroy).toHaveBeenCalled();
        });

        test('accepts body at exactly maxSize bytes', async () => {
            const req = manualReq();

            const promise = parseRawBody(req, { maxSize: 10 });

            process.nextTick(() => {
                req.emit('data', Buffer.from('1234567890')); // exactly 10 bytes
                req.emit('end');
            });

            const result = await promise;
            expect(result).toBe('1234567890');
        });

        test('handles null push (empty body stream)', async () => {
            const req = mockReq(null);
            const result = await parseRawBody(req);
            expect(result).toBe('');
        });
    });

    // ---------------------------------------------------------------
    // parseJsonBody - extended coverage
    // ---------------------------------------------------------------

    describe('parseJsonBody - allowEmpty variations', () => {
        test('allowEmpty defaults to true and returns {} for empty body', async () => {
            const req = mockReq('');
            const result = await parseJsonBody(req);
            expect(result).toEqual({});
        });

        test('allowEmpty=false with empty body throws Invalid JSON', async () => {
            const req = mockReq('');
            await expect(parseJsonBody(req, { allowEmpty: false }))
                .rejects.toEqual({ statusCode: 400, message: 'Invalid JSON body' });
        });

        test('allowEmpty=true with valid JSON still parses normally', async () => {
            const req = mockReq({ hello: 'world' });
            const result = await parseJsonBody(req, { allowEmpty: true });
            expect(result).toEqual({ hello: 'world' });
        });

        test('passes maxSize option through to parseRawBody', async () => {
            const bigJson = JSON.stringify({ data: 'x'.repeat(500) });
            const destroyed = jest.fn();
            const req = mockReq(bigJson, { destroy: destroyed });

            await expect(parseJsonBody(req, { maxSize: 50 }))
                .rejects.toEqual({ statusCode: 413, message: 'Payload too large' });
        });
    });

    describe('parseJsonBody - error propagation', () => {
        test('propagates error event from underlying stream', async () => {
            const req = manualReq();

            const promise = parseJsonBody(req);

            process.nextTick(() => {
                req.emit('error', new Error('network failure'));
            });

            await expect(promise).rejects.toEqual({
                statusCode: 400,
                message: 'Request aborted'
            });
        });

        test('propagates aborted event from underlying stream', async () => {
            const req = manualReq();

            const promise = parseJsonBody(req);

            process.nextTick(() => {
                req.emit('aborted');
            });

            await expect(promise).rejects.toEqual({
                statusCode: 400,
                message: 'Request aborted'
            });
        });
    });

    describe('parseJsonBody - various JSON types', () => {
        test('parses JSON array', async () => {
            const req = mockReq('[1, 2, 3]');
            const result = await parseJsonBody(req);
            expect(result).toEqual([1, 2, 3]);
        });

        test('parses JSON string value', async () => {
            const req = mockReq('"hello"');
            const result = await parseJsonBody(req);
            expect(result).toBe('hello');
        });

        test('parses JSON number value', async () => {
            const req = mockReq('42');
            const result = await parseJsonBody(req);
            expect(result).toBe(42);
        });

        test('parses JSON boolean value', async () => {
            const req = mockReq('true');
            const result = await parseJsonBody(req);
            expect(result).toBe(true);
        });

        test('parses JSON null value', async () => {
            const req = mockReq('null');
            const result = await parseJsonBody(req);
            expect(result).toBeNull();
        });
    });
});
