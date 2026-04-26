'use strict';

const { AdminAuth, generateToken } = require('../lib/admin-auth');

/**
 * Admin Auth Edge-Case Tests
 *
 * Covers: maxSessions eviction, _maxFailedEntries cleanup, session expiry,
 * concurrent auth attempts, token rotation, lockout recovery, getStats
 * accuracy, and empty-state safety.
 */

// Helper: build a minimal mock request
function mockReq(url, headers = {}, remoteAddress = '127.0.0.1') {
    return {
        url,
        headers,
        socket: { remoteAddress }
    };
}

describe('AdminAuth edge cases', () => {
    let auth;

    afterEach(() => {
        if (auth) {
            auth.destroy();
            auth = null;
        }
        jest.useRealTimers();
    });

    // ---------------------------------------------------------------
    // 1. maxSessions eviction
    // ---------------------------------------------------------------
    describe('maxSessions eviction', () => {
        test('oldest session is evicted when maxSessions exceeded', () => {
            const token = generateToken();
            auth = new AdminAuth({
                enabled: true,
                tokens: [token],
                maxSessions: 3,
                sessionTtlMs: 60000
            });

            const sessionIds = [];
            for (let i = 0; i < 4; i++) {
                const req = mockReq('/auth/login', { 'x-admin-token': token }, `10.0.0.${i}`);
                const result = auth.createSessionFromRequest(req);
                expect(result.authenticated).toBe(true);
                sessionIds.push(result.sessionId);
            }

            // After creating 4 sessions with maxSessions=3, the first session
            // should have been evicted by _cleanupSessions inside createSessionFromRequest.
            expect(auth.sessions.size).toBe(3);

            // The oldest session (index 0) must be gone
            expect(auth.sessions.has(sessionIds[0])).toBe(false);

            // The three newest sessions must still exist
            expect(auth.sessions.has(sessionIds[1])).toBe(true);
            expect(auth.sessions.has(sessionIds[2])).toBe(true);
            expect(auth.sessions.has(sessionIds[3])).toBe(true);
        });

        test('exactly maxSessions sessions are retained', () => {
            const token = generateToken();
            auth = new AdminAuth({
                enabled: true,
                tokens: [token],
                maxSessions: 2,
                sessionTtlMs: 60000
            });

            for (let i = 0; i < 5; i++) {
                const req = mockReq('/auth/login', { 'x-admin-token': token }, `10.0.0.${i}`);
                auth.createSessionFromRequest(req);
            }

            expect(auth.sessions.size).toBe(2);
        });
    });

    // ---------------------------------------------------------------
    // 2. _maxFailedEntries cleanup
    // ---------------------------------------------------------------
    describe('_maxFailedEntries cleanup', () => {
        test('failedAttempts map trimmed to cap when many IPs added', () => {
            auth = new AdminAuth({
                enabled: true,
                tokens: ['valid-token-1234567890'],
                maxFailedEntries: 5,
                lockoutDurationMs: 60000 // long, so entries stay fresh
            });

            // Insert 10 entries directly
            for (let i = 0; i < 10; i++) {
                auth.failedAttempts.set(`192.168.1.${i}`, {
                    count: 1,
                    firstAttempt: Date.now(),
                    lastAttempt: Date.now()
                });
            }

            expect(auth.failedAttempts.size).toBe(10);

            auth._cleanupFailedAttempts();

            expect(auth.failedAttempts.size).toBe(5);
            // Oldest five (indices 0-4) evicted, newest five (5-9) kept
            for (let i = 0; i < 5; i++) {
                expect(auth.failedAttempts.has(`192.168.1.${i}`)).toBe(false);
            }
            for (let i = 5; i < 10; i++) {
                expect(auth.failedAttempts.has(`192.168.1.${i}`)).toBe(true);
            }
        });

        test('stale entries removed before size eviction', () => {
            jest.useFakeTimers();
            auth = new AdminAuth({
                enabled: true,
                tokens: ['valid-token-1234567890'],
                maxFailedEntries: 5,
                lockoutDurationMs: 1000
            });

            // 3 stale entries (older than lockoutDurationMs * 2)
            for (let i = 0; i < 3; i++) {
                auth.failedAttempts.set(`stale-${i}`, {
                    count: 1,
                    firstAttempt: Date.now() - 5000,
                    lastAttempt: Date.now() - 5000
                });
            }
            // 4 fresh entries
            for (let i = 0; i < 4; i++) {
                auth.failedAttempts.set(`fresh-${i}`, {
                    count: 1,
                    firstAttempt: Date.now(),
                    lastAttempt: Date.now()
                });
            }

            expect(auth.failedAttempts.size).toBe(7);

            auth._cleanupFailedAttempts();

            // Stale removed first, leaving 4 fresh which is under cap 5
            expect(auth.failedAttempts.size).toBe(4);
            for (let i = 0; i < 3; i++) {
                expect(auth.failedAttempts.has(`stale-${i}`)).toBe(false);
            }
            for (let i = 0; i < 4; i++) {
                expect(auth.failedAttempts.has(`fresh-${i}`)).toBe(true);
            }

            jest.useRealTimers();
        });
    });

    // ---------------------------------------------------------------
    // 3. Session expiry
    // ---------------------------------------------------------------
    describe('session expiry', () => {
        test('session invalid after expiry time', () => {
            jest.useFakeTimers();
            const token = generateToken();
            auth = new AdminAuth({
                enabled: true,
                tokens: [token],
                sessionTtlMs: 5000 // 5 seconds
            });

            // Create session
            const loginReq = mockReq('/auth/login', { 'x-admin-token': token });
            const loginResult = auth.createSessionFromRequest(loginReq);
            expect(loginResult.authenticated).toBe(true);

            const cookieHeader = String(loginResult.sessionCookie).split(';')[0];

            // Verify session works immediately
            const reqBefore = mockReq('/control/pause', { cookie: cookieHeader });
            const beforeResult = auth.authenticate(reqBefore);
            expect(beforeResult.authenticated).toBe(true);
            expect(beforeResult.via).toBe('session');

            // Advance past TTL
            jest.advanceTimersByTime(6000);

            // Session should now be expired
            const reqAfter = mockReq('/control/pause', { cookie: cookieHeader });
            const afterResult = auth.authenticate(reqAfter);
            // Without a valid token header, authentication should fail
            expect(afterResult.authenticated).toBe(false);

            jest.useRealTimers();
        });

        test('session still valid just before expiry', () => {
            jest.useFakeTimers();
            const token = generateToken();
            auth = new AdminAuth({
                enabled: true,
                tokens: [token],
                sessionTtlMs: 10000
            });

            const loginReq = mockReq('/auth/login', { 'x-admin-token': token });
            const loginResult = auth.createSessionFromRequest(loginReq);
            const cookieHeader = String(loginResult.sessionCookie).split(';')[0];

            // Advance to 1ms before expiry
            jest.advanceTimersByTime(9999);

            const req = mockReq('/control/pause', { cookie: cookieHeader });
            const result = auth.authenticate(req);
            expect(result.authenticated).toBe(true);
            expect(result.via).toBe('session');

            jest.useRealTimers();
        });
    });

    // ---------------------------------------------------------------
    // 4. Concurrent auth attempts
    // ---------------------------------------------------------------
    describe('concurrent auth attempts', () => {
        test('simultaneous failures from same IP accumulate correctly', () => {
            const token = generateToken();
            auth = new AdminAuth({
                enabled: true,
                tokens: [token],
                maxAttempts: 5,
                lockoutDurationMs: 60000
            });

            const ip = '10.10.10.10';

            // Simulate 5 concurrent bad auth calls from same IP
            const results = [];
            for (let i = 0; i < 5; i++) {
                const req = mockReq('/control/pause', { 'x-admin-token': 'bad-token-value' }, ip);
                results.push(auth.authenticate(req));
            }

            // All 5 should have been processed (no corruption)
            const invalidCount = results.filter(r => r.error === 'invalid_token').length;
            expect(invalidCount).toBe(5);

            // The entry should show count === 5 and be locked
            const attempts = auth.failedAttempts.get(ip);
            expect(attempts.count).toBe(5);
            expect(attempts.lockoutUntil).toBeGreaterThan(Date.now());

            // Next attempt should be locked out
            const lockedReq = mockReq('/control/pause', { 'x-admin-token': 'bad-token-value' }, ip);
            const lockedResult = auth.authenticate(lockedReq);
            expect(lockedResult.error).toBe('too_many_attempts');
        });

        test('failures from different IPs do not cross-contaminate', () => {
            const token = generateToken();
            auth = new AdminAuth({
                enabled: true,
                tokens: [token],
                maxAttempts: 2,
                lockoutDurationMs: 60000
            });

            // IP-A fails twice -> locked
            for (let i = 0; i < 2; i++) {
                const req = mockReq('/control/pause', { 'x-admin-token': 'bad' }, '10.0.0.1');
                auth.authenticate(req);
            }

            // IP-B fails once -> NOT locked
            const reqB = mockReq('/control/pause', { 'x-admin-token': 'bad' }, '10.0.0.2');
            auth.authenticate(reqB);

            // IP-A should be locked
            const checkA = mockReq('/control/pause', { 'x-admin-token': token }, '10.0.0.1');
            expect(auth.authenticate(checkA).error).toBe('too_many_attempts');

            // IP-B should still be able to authenticate with valid token
            const checkB = mockReq('/control/pause', { 'x-admin-token': token }, '10.0.0.2');
            expect(auth.authenticate(checkB).authenticated).toBe(true);
        });
    });

    // ---------------------------------------------------------------
    // 5. Token rotation
    // ---------------------------------------------------------------
    describe('token rotation', () => {
        test('old and new tokens both work, then only new after removal', () => {
            const oldToken = generateToken();
            const newToken = generateToken();
            auth = new AdminAuth({
                enabled: true,
                tokens: [oldToken]
            });

            // Old token works
            const reqOld = mockReq('/control/pause', { 'x-admin-token': oldToken });
            expect(auth.authenticate(reqOld).authenticated).toBe(true);

            // Add new token
            auth.addToken(newToken);
            expect(auth.tokens.size).toBe(2);

            // Both work
            const reqNew = mockReq('/control/pause', { 'x-admin-token': newToken });
            expect(auth.authenticate(reqNew).authenticated).toBe(true);
            expect(auth.authenticate(reqOld).authenticated).toBe(true);

            // Remove old token
            const removed = auth.removeToken(oldToken);
            expect(removed).toBe(true);
            expect(auth.tokens.size).toBe(1);

            // New still works, old does not
            expect(auth.authenticate(reqNew).authenticated).toBe(true);
            const reqOldAgain = mockReq('/control/pause', { 'x-admin-token': oldToken }, '10.0.0.99');
            expect(auth.authenticate(reqOldAgain).authenticated).toBe(false);
            expect(auth.authenticate(reqOldAgain).error).toBe('invalid_token');
        });

        test('removing a non-existent token returns false', () => {
            auth = new AdminAuth({ enabled: true });
            const result = auth.removeToken('does-not-exist-1234567890');
            expect(result).toBe(false);
        });
    });

    // ---------------------------------------------------------------
    // 6. Lockout recovery
    // ---------------------------------------------------------------
    describe('lockout recovery', () => {
        test('access restored after lockout window expires', () => {
            jest.useFakeTimers();
            const token = generateToken();
            auth = new AdminAuth({
                enabled: true,
                tokens: [token],
                maxAttempts: 2,
                lockoutDurationMs: 10000
            });

            const ip = '172.16.0.1';

            // Trigger lockout
            for (let i = 0; i < 2; i++) {
                const req = mockReq('/control/pause', { 'x-admin-token': 'wrong' }, ip);
                auth.authenticate(req);
            }

            // Verify locked
            const lockedReq = mockReq('/control/pause', { 'x-admin-token': token }, ip);
            expect(auth.authenticate(lockedReq).error).toBe('too_many_attempts');

            // Advance past lockout
            jest.advanceTimersByTime(11000);

            // Access restored with valid token
            const restoredReq = mockReq('/control/pause', { 'x-admin-token': token }, ip);
            const result = auth.authenticate(restoredReq);
            expect(result.authenticated).toBe(true);

            jest.useRealTimers();
        });

        test('still locked 1ms before lockout expires', () => {
            jest.useFakeTimers();
            const token = generateToken();
            auth = new AdminAuth({
                enabled: true,
                tokens: [token],
                maxAttempts: 1,
                lockoutDurationMs: 5000
            });

            const ip = '172.16.0.2';
            const badReq = mockReq('/control/pause', { 'x-admin-token': 'wrong' }, ip);
            auth.authenticate(badReq);

            // Advance to just before expiry
            jest.advanceTimersByTime(4999);

            const req = mockReq('/control/pause', { 'x-admin-token': token }, ip);
            expect(auth.authenticate(req).error).toBe('too_many_attempts');

            // Now advance past expiry
            jest.advanceTimersByTime(2);

            expect(auth.authenticate(req).authenticated).toBe(true);

            jest.useRealTimers();
        });
    });

    // ---------------------------------------------------------------
    // 7. getStats accuracy
    // ---------------------------------------------------------------
    describe('getStats accuracy', () => {
        test('stats reflect correct token count, session count, and locked IPs', () => {
            jest.useFakeTimers();
            const token1 = generateToken();
            const token2 = generateToken();
            auth = new AdminAuth({
                enabled: true,
                tokens: [token1, token2],
                maxAttempts: 1,
                lockoutDurationMs: 60000
            });

            // Create 2 sessions
            auth.createSessionFromRequest(mockReq('/auth/login', { 'x-admin-token': token1 }, '10.0.0.1'));
            auth.createSessionFromRequest(mockReq('/auth/login', { 'x-admin-token': token2 }, '10.0.0.2'));

            // Lock out 3 IPs
            auth.authenticate(mockReq('/control/pause', { 'x-admin-token': 'bad' }, '10.0.0.10'));
            auth.authenticate(mockReq('/control/pause', { 'x-admin-token': 'bad' }, '10.0.0.11'));
            auth.authenticate(mockReq('/control/pause', { 'x-admin-token': 'bad' }, '10.0.0.12'));

            const stats = auth.getStats();

            expect(stats.enabled).toBe(true);
            expect(stats.tokenCount).toBe(2);
            expect(stats.sessionCount).toBe(2);
            expect(stats.lockedClients).toBe(3);

            jest.useRealTimers();
        });

        test('success rate is 100% with only successes', () => {
            const token = generateToken();
            auth = new AdminAuth({
                enabled: true,
                tokens: [token]
            });

            for (let i = 0; i < 5; i++) {
                auth.authenticate(mockReq('/control/pause', { 'x-admin-token': token }));
            }

            const stats = auth.getStats();
            expect(stats.recentAuth.success).toBe(5);
            expect(stats.recentAuth.failure).toBe(0);
            expect(stats.recentAuth.successRate).toBe(100);
        });

        test('success rate is 0% with only failures', () => {
            const token = generateToken();
            auth = new AdminAuth({
                enabled: true,
                tokens: [token],
                maxAttempts: 100 // high so we don't hit lockout
            });

            for (let i = 0; i < 5; i++) {
                auth.authenticate(mockReq('/control/pause', { 'x-admin-token': 'wrong' }, `10.0.${i}.1`));
            }

            const stats = auth.getStats();
            expect(stats.recentAuth.success).toBe(0);
            expect(stats.recentAuth.failure).toBe(5);
            expect(stats.recentAuth.successRate).toBe(0);
        });

        test('stats reflect sessions removed by cleanup', () => {
            jest.useFakeTimers();
            const token = generateToken();
            auth = new AdminAuth({
                enabled: true,
                tokens: [token],
                sessionTtlMs: 3000,
                maxSessions: 100
            });

            auth.createSessionFromRequest(mockReq('/auth/login', { 'x-admin-token': token }, '10.0.0.1'));
            expect(auth.getStats().sessionCount).toBe(1);

            // Expire the session
            jest.advanceTimersByTime(4000);
            auth._cleanupSessions();

            expect(auth.getStats().sessionCount).toBe(0);

            jest.useRealTimers();
        });
    });

    // ---------------------------------------------------------------
    // 8. Empty state safety
    // ---------------------------------------------------------------
    describe('empty state safety', () => {
        test('authenticate with no tokens, no sessions, no failed attempts', () => {
            auth = new AdminAuth({ enabled: true });

            const req = mockReq('/control/pause', {});
            const result = auth.authenticate(req);

            // No tokens configured = allow all (development mode)
            expect(result.authenticated).toBe(true);
            expect(result.warning).toBe('no_tokens_configured');
        });

        test('createSessionFromRequest with no tokens configured', () => {
            auth = new AdminAuth({ enabled: true });

            const req = mockReq('/auth/login', {});
            const result = auth.createSessionFromRequest(req);

            expect(result.authenticated).toBe(true);
            expect(result.warning).toBe('no_tokens_configured');
        });

        test('peekAuthentication with no tokens and no session', () => {
            auth = new AdminAuth({ enabled: true });

            const req = mockReq('/auth-status', {});
            const result = auth.peekAuthentication(req);

            // No valid session, no valid token
            expect(result.authenticated).toBe(false);
        });

        test('getStats on fresh instance', () => {
            auth = new AdminAuth({ enabled: true });

            const stats = auth.getStats();

            expect(stats.enabled).toBe(true);
            expect(stats.tokenCount).toBe(0);
            expect(stats.sessionCount).toBe(0);
            expect(stats.lockedClients).toBe(0);
            expect(stats.recentAuth.success).toBe(0);
            expect(stats.recentAuth.failure).toBe(0);
            expect(stats.recentAuth.successRate).toBe(100);
        });

        test('getAuditLog on fresh instance', () => {
            auth = new AdminAuth({ enabled: true });

            const log = auth.getAuditLog();
            expect(log).toEqual([]);
        });

        test('clearLockouts on fresh instance does not throw', () => {
            auth = new AdminAuth({ enabled: true });
            expect(() => auth.clearLockouts()).not.toThrow();
        });

        test('clearSession with no cookie does not throw', () => {
            auth = new AdminAuth({ enabled: true });
            const req = mockReq('/auth/logout', {});
            expect(() => auth.clearSession(req)).not.toThrow();
        });

        test('_cleanupFailedAttempts on empty map does not throw', () => {
            auth = new AdminAuth({ enabled: true });
            expect(() => auth._cleanupFailedAttempts()).not.toThrow();
            expect(auth.failedAttempts.size).toBe(0);
        });

        test('_cleanupSessions on empty sessions map does not throw', () => {
            auth = new AdminAuth({ enabled: true });
            expect(() => auth._cleanupSessions()).not.toThrow();
            expect(auth.sessions.size).toBe(0);
        });

        test('removeToken when no tokens exist', () => {
            auth = new AdminAuth({ enabled: true });
            expect(auth.removeToken('nonexistent-token-12345')).toBe(false);
        });

        test('extractToken with empty headers', () => {
            auth = new AdminAuth({ enabled: true });
            const req = mockReq('/control/pause', {});
            expect(auth.extractToken(req)).toBeNull();
        });

        test('requiresAuth returns false when disabled even with empty state', () => {
            auth = new AdminAuth({ enabled: false });
            expect(auth.requiresAuth('/control/pause')).toBe(false);
        });
    });
});
