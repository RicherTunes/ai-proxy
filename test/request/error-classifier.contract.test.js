/**
 * Contract Test: Error Classifier
 *
 * This contract test ensures that error classification produces consistent results
 * after extraction from RequestHandler to error-classifier.js.
 *
 * TDD Phase: Red - Write failing test first
 */

'use strict';

const { categorizeError } = require('../../lib/request/error-classifier');

describe('RequestHandler Contract: Error Classification', () => {
    describe('should categorize errors consistently after extraction', () => {
        const testCases = [
            // Socket/connection issues
            {
                error: new Error('socket hang up'),
                expected: 'socket_hangup',
                description: 'Socket hang up message'
            },
            {
                error: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
                expected: 'socket_hangup',
                description: 'ECONNRESET code'
            },
            {
                error: Object.assign(new Error('broken pipe'), { code: 'EPIPE' }),
                expected: 'broken_pipe',
                description: 'EPIPE code'
            },
            {
                error: Object.assign(new Error('write after end'), { code: 'ERR_STREAM_WRITE_AFTER_END' }),
                expected: 'broken_pipe',
                description: 'Stream write after end'
            },
            {
                error: Object.assign(new Error('connection aborted'), { code: 'ECONNABORTED' }),
                expected: 'connection_aborted',
                description: 'ECONNABORTED code'
            },
            {
                error: Object.assign(new Error('premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }),
                expected: 'stream_premature_close',
                description: 'Stream premature close'
            },
            // HTTP parser errors
            {
                error: Object.assign(new Error('parse error'), { code: 'HPE_INVALID_CONSTANT' }),
                expected: 'http_parse_error',
                description: 'HPE_ code (HTTP parser error)'
            },
            {
                error: new Error('Parse Error'),
                expected: 'http_parse_error',
                description: 'Parse Error message'
            },
            // Connection issues
            {
                error: Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
                expected: 'connection_refused',
                description: 'ECONNREFUSED code'
            },
            // DNS errors
            {
                error: Object.assign(new Error('not found'), { code: 'ENOTFOUND' }),
                expected: 'dns_error',
                description: 'ENOTFOUND code'
            },
            {
                error: Object.assign(new Error('dns timeout'), { code: 'EAI_AGAIN' }),
                expected: 'dns_error',
                description: 'EAI_AGAIN code'
            },
            {
                error: new Error('getaddrinfo failed'),
                expected: 'dns_error',
                description: 'getaddrinfo in message'
            },
            // TLS errors
            {
                error: Object.assign(new Error('tls error'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }),
                expected: 'tls_error',
                description: 'ERR_TLS_ code'
            },
            {
                error: Object.assign(new Error('certificate error'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }),
                expected: 'tls_error',
                description: 'Certificate error'
            },
            {
                error: new Error('SSL error'),
                expected: 'tls_error',
                description: 'SSL in message'
            },
            {
                error: new Error('TLS handshake failed'),
                expected: 'tls_error',
                description: 'TLS in message'
            },
            // Timeout
            {
                error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
                expected: 'timeout',
                description: 'ETIMEDOUT code'
            },
            {
                error: new Error('request timeout'),
                expected: 'timeout',
                description: 'timeout in message'
            },
            // Rate limiting
            {
                error: new Error('429 rate limit exceeded'),
                expected: 'rate_limited',
                description: '429 in message'
            },
            {
                error: new Error('rate limit exceeded'),
                expected: 'rate_limited',
                description: 'rate limit in message'
            },
            // Other (fallback)
            {
                error: new Error('unknown error'),
                expected: 'other',
                description: 'Unknown error falls back to other'
            },
            {
                error: Object.assign(new Error('network'), { code: 'ENETUNREACH' }),
                expected: 'connection_refused',
                description: 'ENETUNREACH maps to connection_refused'
            },
            {
                error: Object.assign(new Error('host'), { code: 'EHOSTUNREACH' }),
                expected: 'connection_refused',
                description: 'EHOSTUNREACH maps to connection_refused'
            }
        ];

        testCases.forEach(({ error, expected, description }) => {
            it(`should classify: ${description}`, () => {
                const category = categorizeError(error);
                expect(category).toBe(expected);
            });
        });
    });

    describe('should handle edge cases', () => {
        it('should handle error with no code or message', () => {
            const error = new Error();
            const category = categorizeError(error);
            expect(category).toBe('other');
        });

        it('should handle null/undefined gracefully', () => {
            const category1 = categorizeError(null);
            const category2 = categorizeError(undefined);
            expect(category1).toBe('other');
            expect(category2).toBe('other');
        });

        it('should handle error with only code', () => {
            const error = Object.assign(new Error(), { code: 'ECONNRESET' });
            const category = categorizeError(error);
            expect(category).toBe('socket_hangup');
        });

        it('should handle error with only message', () => {
            const error = new Error('socket hang up');
            const category = categorizeError(error);
            expect(category).toBe('socket_hangup');
        });
    });
});
