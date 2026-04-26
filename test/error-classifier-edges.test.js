'use strict';

const { categorizeError } = require('../lib/request/error-classifier');

describe('error-classifier edge cases', () => {

    describe('ENETUNREACH', () => {
        test('maps to connection_refused', () => {
            const err = new Error('connect ENETUNREACH');
            err.code = 'ENETUNREACH';
            expect(categorizeError(err)).toBe('connection_refused');
        });
    });

    describe('EHOSTUNREACH', () => {
        test('maps to connection_refused', () => {
            const err = new Error('connect EHOSTUNREACH');
            err.code = 'EHOSTUNREACH';
            expect(categorizeError(err)).toBe('connection_refused');
        });
    });

    describe('ETIMEDOUT', () => {
        test('maps to timeout', () => {
            const err = new Error('connect ETIMEDOUT');
            err.code = 'ETIMEDOUT';
            expect(categorizeError(err)).toBe('timeout');
        });

        test('message containing "timeout" maps to timeout', () => {
            const err = new Error('request timeout after 30s');
            expect(categorizeError(err)).toBe('timeout');
        });
    });

    describe('ECONNRESET', () => {
        test('maps to socket_hangup', () => {
            const err = new Error('read ECONNRESET');
            err.code = 'ECONNRESET';
            expect(categorizeError(err)).toBe('socket_hangup');
        });

        test('socket hang up message maps to socket_hangup', () => {
            const err = new Error('socket hang up');
            expect(categorizeError(err)).toBe('socket_hangup');
        });
    });

    describe('TLS errors', () => {
        test('CERT_NOT_YET_VALID via message maps to tls_error', () => {
            const err = new Error('certificate is not yet valid');
            expect(categorizeError(err)).toBe('tls_error');
        });

        test('UNABLE_TO_VERIFY_LEAF_SIGNATURE maps to tls_error', () => {
            const err = new Error('unable to verify the first certificate');
            err.code = 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
            expect(categorizeError(err)).toBe('tls_error');
        });

        test('ERR_TLS_CERT_ALTNAME_INVALID maps to tls_error', () => {
            const err = new Error('hostname mismatch');
            err.code = 'ERR_TLS_CERT_ALTNAME_INVALID';
            expect(categorizeError(err)).toBe('tls_error');
        });

        test('EPROTO maps to tls_error', () => {
            const err = new Error('SSL routines');
            err.code = 'EPROTO';
            expect(categorizeError(err)).toBe('tls_error');
        });

        test('SSL in message maps to tls_error', () => {
            const err = new Error('SSL handshake failed');
            expect(categorizeError(err)).toBe('tls_error');
        });

        test('TLS in message maps to tls_error', () => {
            const err = new Error('TLS connection reset');
            // Note: "TLS" in message but also matches nothing before it
            // TLS check is after ECONNRESET code check, so message-only goes to tls_error
            expect(categorizeError(err)).toBe('tls_error');
        });
    });

    describe('HTTP status codes', () => {
        test('429 in message maps to rate_limited', () => {
            const err = new Error('Request failed with status code 429');
            expect(categorizeError(err)).toBe('rate_limited');
        });

        test('"rate limit" in message maps to rate_limited', () => {
            const err = new Error('rate limit exceeded');
            expect(categorizeError(err)).toBe('rate_limited');
        });

        test('500 error without specific code maps to other', () => {
            // categorizeError doesn't check for 500 specifically — only 429/rate limit
            const err = new Error('Request failed with status code 500');
            expect(categorizeError(err)).toBe('other');
        });

        test('503 error without specific code maps to other', () => {
            const err = new Error('Request failed with status code 503');
            expect(categorizeError(err)).toBe('other');
        });
    });

    describe('unknown error', () => {
        test('unrecognized error code returns other', () => {
            const err = new Error('something weird happened');
            err.code = 'ESOMETHINGWEIRD';
            expect(categorizeError(err)).toBe('other');
        });

        test('error with no code and no matching message returns other', () => {
            const err = new Error('generic failure');
            expect(categorizeError(err)).toBe('other');
        });
    });

    describe('null/undefined error', () => {
        test('null does not crash and returns other', () => {
            expect(() => categorizeError(null)).not.toThrow();
            expect(categorizeError(null)).toBe('other');
        });

        test('undefined does not crash and returns other', () => {
            expect(() => categorizeError(undefined)).not.toThrow();
            expect(categorizeError(undefined)).toBe('other');
        });

        test('empty object does not crash and returns other', () => {
            expect(() => categorizeError({})).not.toThrow();
            expect(categorizeError({})).toBe('other');
        });

        test('number input does not crash', () => {
            // Non-object truthy value — code/message access returns undefined
            expect(() => categorizeError(42)).not.toThrow();
            expect(categorizeError(42)).toBe('other');
        });

        test('string input does not crash', () => {
            expect(() => categorizeError('some string')).not.toThrow();
        });
    });

    describe('error with response body', () => {
        test('error carrying JSON response body with message', () => {
            const err = new Error('Request failed with status code 429');
            err.response = {
                data: { error: { message: 'Rate limit exceeded, retry after 30s' } }
            };
            // categorizeError classifies based on code/message, not response body
            // But it should not crash when response body is present
            expect(categorizeError(err)).toBe('rate_limited');
        });

        test('error with response body containing nested error info', () => {
            const err = new Error('upstream error');
            err.response = {
                statusCode: 500,
                body: JSON.stringify({ error: { type: 'server_error', message: 'Internal server error' } })
            };
            expect(() => categorizeError(err)).not.toThrow();
            expect(categorizeError(err)).toBe('other');
        });
    });

    describe('other known error codes', () => {
        test('ECONNREFUSED maps to connection_refused', () => {
            const err = new Error('connect ECONNREFUSED 127.0.0.1:443');
            err.code = 'ECONNREFUSED';
            expect(categorizeError(err)).toBe('connection_refused');
        });

        test('EPIPE maps to broken_pipe', () => {
            const err = new Error('write EPIPE');
            err.code = 'EPIPE';
            expect(categorizeError(err)).toBe('broken_pipe');
        });

        test('ERR_STREAM_WRITE_AFTER_END maps to broken_pipe', () => {
            const err = new Error('write after end');
            err.code = 'ERR_STREAM_WRITE_AFTER_END';
            expect(categorizeError(err)).toBe('broken_pipe');
        });

        test('ECONNABORTED maps to connection_aborted', () => {
            const err = new Error('connection aborted');
            err.code = 'ECONNABORTED';
            expect(categorizeError(err)).toBe('connection_aborted');
        });

        test('ERR_STREAM_PREMATURE_CLOSE maps to stream_premature_close', () => {
            const err = new Error('premature close');
            err.code = 'ERR_STREAM_PREMATURE_CLOSE';
            expect(categorizeError(err)).toBe('stream_premature_close');
        });

        test('premature close in message maps to stream_premature_close', () => {
            const err = new Error('stream premature close');
            expect(categorizeError(err)).toBe('stream_premature_close');
        });

        test('HPE_INVALID_HEADER_TOKEN maps to http_parse_error', () => {
            const err = new Error('Parse Error');
            err.code = 'HPE_INVALID_HEADER_TOKEN';
            expect(categorizeError(err)).toBe('http_parse_error');
        });

        test('ENOTFOUND maps to dns_error', () => {
            const err = new Error('getaddrinfo ENOTFOUND api.example.com');
            err.code = 'ENOTFOUND';
            expect(categorizeError(err)).toBe('dns_error');
        });

        test('EAI_AGAIN maps to dns_error', () => {
            const err = new Error('getaddrinfo EAI_AGAIN');
            err.code = 'EAI_AGAIN';
            expect(categorizeError(err)).toBe('dns_error');
        });

        test('getaddrinfo in message maps to dns_error', () => {
            const err = new Error('getaddrinfo failed');
            expect(categorizeError(err)).toBe('dns_error');
        });
    });

    describe('priority / ordering edge cases', () => {
        test('ECONNRESET wins over timeout in message', () => {
            // ECONNRESET is checked before timeout
            const err = new Error('connection timeout');
            err.code = 'ECONNRESET';
            expect(categorizeError(err)).toBe('socket_hangup');
        });

        test('ECONNREFUSED wins over ENETUNREACH-like message', () => {
            const err = new Error('network unreachable');
            err.code = 'ECONNREFUSED';
            expect(categorizeError(err)).toBe('connection_refused');
        });
    });
});
