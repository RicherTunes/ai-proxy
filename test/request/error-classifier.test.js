/**
 * Unit Test: Error Classifier Module
 *
 * TDD Phase: Red - Write failing unit test before module exists
 *
 * Tests the pure function categorizeError() which extracts
 * error categorization logic from RequestHandler.
 */

'use strict';

const { categorizeError } = require('../../lib/request/error-classifier');

describe('error-classifier', () => {
    describe('socket_hangup', () => {
        it('should categorize ECONNRESET as socket_hangup', () => {
            const error = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
            expect(categorizeError(error)).toBe('socket_hangup');
        });

        it('should categorize "socket hang up" message as socket_hangup', () => {
            const error = new Error('socket hang up');
            expect(categorizeError(error)).toBe('socket_hangup');
        });
    });

    describe('broken_pipe', () => {
        it('should categorize EPIPE as broken_pipe', () => {
            const error = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
            expect(categorizeError(error)).toBe('broken_pipe');
        });

        it('should categorize ERR_STREAM_WRITE_AFTER_END as broken_pipe', () => {
            const error = Object.assign(new Error('write after end'), { code: 'ERR_STREAM_WRITE_AFTER_END' });
            expect(categorizeError(error)).toBe('broken_pipe');
        });
    });

    describe('connection_aborted', () => {
        it('should categorize ECONNABORTED as connection_aborted', () => {
            const error = Object.assign(new Error('connection aborted'), { code: 'ECONNABORTED' });
            expect(categorizeError(error)).toBe('connection_aborted');
        });
    });

    describe('stream_premature_close', () => {
        it('should categorize ERR_STREAM_PREMATURE_CLOSE as stream_premature_close', () => {
            const error = Object.assign(new Error('premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
            expect(categorizeError(error)).toBe('stream_premature_close');
        });

        it('should categorize "premature close" message as stream_premature_close', () => {
            const error = new Error('stream premature close');
            expect(categorizeError(error)).toBe('stream_premature_close');
        });
    });

    describe('http_parse_error', () => {
        it('should categorize HPE_ codes as http_parse_error', () => {
            const codes = ['HPE_INVALID_CONSTANT', 'HPE_INVALID_STATUS', 'HPE_INVALID_HEADER_TOKEN'];
            codes.forEach(code => {
                const error = Object.assign(new Error('parse error'), { code });
                expect(categorizeError(error)).toBe('http_parse_error');
            });
        });

        it('should categorize "Parse Error" message as http_parse_error', () => {
            const error = new Error('Parse Error');
            expect(categorizeError(error)).toBe('http_parse_error');
        });
    });

    describe('connection_refused', () => {
        it('should categorize ECONNREFUSED as connection_refused', () => {
            const error = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
            expect(categorizeError(error)).toBe('connection_refused');
        });

        it('should categorize ENETUNREACH as connection_refused', () => {
            const error = Object.assign(new Error('network unreachable'), { code: 'ENETUNREACH' });
            expect(categorizeError(error)).toBe('connection_refused');
        });

        it('should categorize EHOSTUNREACH as connection_refused', () => {
            const error = Object.assign(new Error('host unreachable'), { code: 'EHOSTUNREACH' });
            expect(categorizeError(error)).toBe('connection_refused');
        });
    });

    describe('dns_error', () => {
        it('should categorize ENOTFOUND as dns_error', () => {
            const error = Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
            expect(categorizeError(error)).toBe('dns_error');
        });

        it('should categorize EAI_AGAIN as dns_error', () => {
            const error = Object.assign(new Error('dns timeout'), { code: 'EAI_AGAIN' });
            expect(categorizeError(error)).toBe('dns_error');
        });

        it('should categorize getaddrinfo message as dns_error', () => {
            const error = new Error('getaddrinfo ENOTFOUND example.com');
            expect(categorizeError(error)).toBe('dns_error');
        });
    });

    describe('tls_error', () => {
        it('should categorize ERR_TLS_ codes as tls_error', () => {
            const error = Object.assign(new Error('tls error'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
            expect(categorizeError(error)).toBe('tls_error');
        });

        it('should categorize UNABLE_TO_VERIFY_LEAF_SIGNATURE as tls_error', () => {
            const error = Object.assign(new Error('certificate error'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
            expect(categorizeError(error)).toBe('tls_error');
        });

        it('should categorize EPROTO as tls_error', () => {
            const error = Object.assign(new Error('protocol error'), { code: 'EPROTO' });
            expect(categorizeError(error)).toBe('tls_error');
        });

        it('should categorize certificate message as tls_error', () => {
            const error = new Error('certificate has expired');
            expect(categorizeError(error)).toBe('tls_error');
        });

        it('should categorize SSL message as tls_error', () => {
            const error = new Error('SSL handshake failed');
            expect(categorizeError(error)).toBe('tls_error');
        });

        it('should categorize TLS message as tls_error', () => {
            const error = new Error('TLS protocol error');
            expect(categorizeError(error)).toBe('tls_error');
        });
    });

    describe('timeout', () => {
        it('should categorize ETIMEDOUT as timeout', () => {
            const error = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
            expect(categorizeError(error)).toBe('timeout');
        });

        it('should categorize timeout message as timeout', () => {
            const error = new Error('request timeout');
            expect(categorizeError(error)).toBe('timeout');
        });
    });

    describe('rate_limited', () => {
        it('should categorize 429 message as rate_limited', () => {
            const error = new Error('HTTP 429 Too Many Requests');
            expect(categorizeError(error)).toBe('rate_limited');
        });

        it('should categorize rate limit message as rate_limited', () => {
            const error = new Error('rate limit exceeded');
            expect(categorizeError(error)).toBe('rate_limited');
        });
    });

    describe('other (fallback)', () => {
        it('should categorize unknown errors as other', () => {
            const error = new Error('something completely different');
            expect(categorizeError(error)).toBe('other');
        });

        it('should handle error with no code or message', () => {
            const error = new Error();
            expect(categorizeError(error)).toBe('other');
        });

        it('should handle null input gracefully', () => {
            expect(categorizeError(null)).toBe('other');
        });

        it('should handle undefined input gracefully', () => {
            expect(categorizeError(undefined)).toBe('other');
        });
    });
});
