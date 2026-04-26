'use strict';

const { AdminAuth } = require('../lib/admin-auth');

describe('AdminAuth — branch coverage for uncovered lines', () => {
    let auth;

    afterEach(() => {
        if (auth) auth.destroy();
        jest.restoreAllMocks();
    });

    // ------------------------------------------------------------------ //
    // Line 207: _parseCookies catch — decodeURIComponent throws
    // ------------------------------------------------------------------ //
    describe('_parseCookies with malformed cookie value (line 207)', () => {
        it('falls back to raw value when decodeURIComponent throws', () => {
            auth = new AdminAuth({});
            // %E0%A4%A is an incomplete multi-byte UTF-8 sequence
            // that decodeURIComponent cannot decode → throws URIError
            const req = {
                headers: {
                    cookie: 'sid=%E0%A4%A; lang=en'
                }
            };
            const cookies = auth._parseCookies(req);
            // Covers line 207: catch branch stores raw value
            expect(cookies.sid).toBe('%E0%A4%A');
            expect(cookies.lang).toBe('en');
        });
    });

    // ------------------------------------------------------------------ //
    // Line 350: _serializeSessionCookie appends Secure for encrypted reqs
    // ------------------------------------------------------------------ //
    describe('session cookie Secure flag (line 350)', () => {
        it('includes Secure attribute when request is over TLS', () => {
            auth = new AdminAuth({});
            const req = { socket: { encrypted: true } };
            const cookie = auth._serializeSessionCookie('abc123', req, {});
            // Covers line 350: Secure branch
            expect(cookie).toContain('Secure');
            expect(cookie).toContain('HttpOnly');
            expect(cookie).toContain('SameSite=Strict');
        });

        it('omits Secure attribute when request is plain HTTP', () => {
            auth = new AdminAuth({});
            const req = { socket: { encrypted: false } };
            const cookie = auth._serializeSessionCookie('abc123', req, {});
            expect(cookie).not.toContain('Secure');
        });
    });

    // ------------------------------------------------------------------ //
    // Lines 362-363: createSessionFromRequest when client is locked out
    // ------------------------------------------------------------------ //
    describe('createSessionFromRequest lockout path (lines 362-363)', () => {
        it('returns too_many_attempts when client is locked out', () => {
            auth = new AdminAuth({ maxAttempts: 3, lockoutDurationMs: 60000 });
            auth.addToken('super-secret-admin-token-16c');

            const req = {
                url: '/control/pause',
                headers: {},
                socket: { remoteAddress: '1.2.3.4' },
                connection: { remoteAddress: '1.2.3.4' }
            };

            // Saturate failed attempts to trigger lockout
            for (let i = 0; i < 3; i++) {
                auth.createSessionFromRequest(req);
            }

            const result = auth.createSessionFromRequest(req);
            // Covers lines 362-363: audit + return in lockout branch
            expect(result.authenticated).toBe(false);
            expect(result.error).toBe('too_many_attempts');
            expect(result.retryAfterMs).toBeGreaterThan(0);
        });
    });

    // ------------------------------------------------------------------ //
    // Lines 381-383: createSessionFromRequest missing token
    // ------------------------------------------------------------------ //
    describe('createSessionFromRequest missing token (lines 381-383)', () => {
        it('returns missing_token error when no header token is provided', () => {
            auth = new AdminAuth({});
            auth.addToken('super-secret-admin-token-16c');

            const req = {
                url: '/control/resume',
                headers: {},
                socket: { remoteAddress: '10.0.0.1' },
                connection: { remoteAddress: '10.0.0.1' }
            };

            const result = auth.createSessionFromRequest(req);
            // Covers lines 381-383: _recordFailure + _audit + return
            expect(result.authenticated).toBe(false);
            expect(result.error).toBe('missing_token');
        });
    });

    // ------------------------------------------------------------------ //
    // Lines 390-392: createSessionFromRequest invalid token
    // ------------------------------------------------------------------ //
    describe('createSessionFromRequest invalid token (lines 390-392)', () => {
        it('returns invalid_token error when token does not match', () => {
            auth = new AdminAuth({});
            auth.addToken('super-secret-admin-token-16c');

            const req = {
                url: '/control/reset',
                headers: { 'x-admin-token': 'wrong-token-not-valid' },
                socket: { remoteAddress: '10.0.0.2' },
                connection: { remoteAddress: '10.0.0.2' }
            };

            const result = auth.createSessionFromRequest(req);
            // Covers lines 390-392: _recordFailure + _audit + return
            expect(result.authenticated).toBe(false);
            expect(result.error).toBe('invalid_token');
        });
    });
});
