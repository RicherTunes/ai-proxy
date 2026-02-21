/**
 * Admin Auth Extended Tests
 * Covers uncovered lines: 35, 99, 205, 354-371, 393-444
 */

const { AdminAuth, generateToken, secureCompare } = require('../lib/admin-auth');

describe('AdminAuth Extended Coverage', () => {
    let auth;

    afterEach(() => {
        if (auth) {
            auth.destroy();
        }
    });

    describe('secureCompare edge cases (line 35)', () => {
        test('should return false for non-string types', () => {
            expect(secureCompare(null, 'test')).toBe(false);
            expect(secureCompare('test', null)).toBe(false);
            expect(secureCompare(undefined, 'test')).toBe(false);
            expect(secureCompare('test', undefined)).toBe(false);
            expect(secureCompare(123, 'test')).toBe(false);
            expect(secureCompare('test', 123)).toBe(false);
            expect(secureCompare({}, 'test')).toBe(false);
            expect(secureCompare([], 'test')).toBe(false);
        });

        test('should handle both arguments being non-strings', () => {
            expect(secureCompare(null, null)).toBe(false);
            expect(secureCompare(123, 456)).toBe(false);
            expect(secureCompare({}, {})).toBe(false);
        });
    });

    describe('Logger integration (line 99)', () => {
        test('should call logger when provided', () => {
            const mockLogger = {
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn()
            };

            auth = new AdminAuth({
                enabled: true,
                logger: mockLogger
            });

            // Trigger a log via addToken with too short token
            auth.addToken('short');

            expect(mockLogger.warn).toHaveBeenCalledWith(
                'Token too short, minimum 16 characters required',
                undefined
            );
        });

        test('should not throw when logger is not provided', () => {
            auth = new AdminAuth({
                enabled: true
                // no logger
            });

            // Should not throw
            expect(() => auth.addToken('short')).not.toThrow();
        });

        test('should call logger on lockout', () => {
            const mockLogger = {
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn()
            };

            auth = new AdminAuth({
                enabled: true,
                logger: mockLogger,
                maxAttempts: 2,
                tokens: ['valid-token-1234567890']
            });

            const req = {
                url: '/control/pause',
                headers: { 'x-admin-token': 'invalid-token' },
                socket: { remoteAddress: '127.0.0.1' }
            };

            // First attempt
            auth.authenticate(req);
            // Second attempt - triggers lockout
            auth.authenticate(req);

            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringContaining('Client locked out'),
                expect.objectContaining({
                    attempts: 2
                })
            );
        });

        test('should call logger on clearLockouts', () => {
            const mockLogger = {
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn()
            };

            auth = new AdminAuth({
                enabled: true,
                logger: mockLogger
            });

            auth.clearLockouts();

            expect(mockLogger.info).toHaveBeenCalledWith('Cleared all lockouts', undefined);
        });
    });

    describe('Lockout expiry check (line 205)', () => {
        test('should delete expired lockout entry on check', () => {
            jest.useFakeTimers();

            auth = new AdminAuth({
                enabled: true,
                tokens: ['valid-token-1234567890'],
                lockoutDurationMs: 1000
            });

            // Manually insert an expired lockout
            const clientId = '127.0.0.1';
            auth.failedAttempts.set(clientId, {
                count: 5,
                firstAttempt: Date.now() - 5000,
                lastAttempt: Date.now() - 2000,
                lockoutUntil: Date.now() - 100 // expired 100ms ago
            });

            expect(auth.failedAttempts.has(clientId)).toBe(true);

            // Check lockout status - should delete the expired entry
            const lockout = auth._checkLockout(clientId);

            expect(lockout.locked).toBe(false);
            expect(auth.failedAttempts.has(clientId)).toBe(false);

            jest.useRealTimers();
        });

        test('should return locked status for active lockout', () => {
            jest.useFakeTimers();

            auth = new AdminAuth({
                enabled: true,
                tokens: ['valid-token-1234567890'],
                lockoutDurationMs: 5000
            });

            const clientId = '127.0.0.1';
            auth.failedAttempts.set(clientId, {
                count: 5,
                firstAttempt: Date.now() - 1000,
                lastAttempt: Date.now() - 500,
                lockoutUntil: Date.now() + 4000 // still locked for 4 seconds
            });

            const lockout = auth._checkLockout(clientId);

            expect(lockout.locked).toBe(true);
            expect(lockout.remainingMs).toBeGreaterThan(3900);
            expect(lockout.remainingMs).toBeLessThanOrEqual(4000);
            expect(auth.failedAttempts.has(clientId)).toBe(true);

            jest.useRealTimers();
        });
    });

    describe('Middleware function (lines 354-371)', () => {
        test('should reject with 401 for missing token', () => {
            auth = new AdminAuth({
                enabled: true,
                tokens: ['valid-token-1234567890']
            });

            const req = {
                url: '/control/pause',
                headers: {},
                socket: { remoteAddress: '127.0.0.1' }
            };

            const res = {
                writeHead: jest.fn(),
                setHeader: jest.fn(),
                end: jest.fn()
            };

            const next = jest.fn();

            const middleware = auth.middleware();
            middleware(req, res, next);

            expect(res.writeHead).toHaveBeenCalledWith(401, { 'Content-Type': 'application/json' });
            expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: 'missing_token' }));
            expect(next).not.toHaveBeenCalled();
        });

        test('should reject with 429 for locked out client', () => {
            auth = new AdminAuth({
                enabled: true,
                tokens: ['valid-token-1234567890'],
                maxAttempts: 1,
                lockoutDurationMs: 10000
            });

            const req = {
                url: '/control/pause',
                headers: { 'x-admin-token': 'invalid' },
                socket: { remoteAddress: '127.0.0.1' }
            };

            const res = {
                writeHead: jest.fn(),
                setHeader: jest.fn(),
                end: jest.fn()
            };

            const next = jest.fn();

            const middleware = auth.middleware();

            // First attempt - triggers lockout
            middleware(req, res, next);

            // Reset mocks
            res.writeHead.mockClear();
            res.setHeader.mockClear();
            res.end.mockClear();

            // Second attempt - should return 429
            middleware(req, res, next);

            expect(res.writeHead).toHaveBeenCalledWith(429, { 'Content-Type': 'application/json' });
            expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number));
            expect(res.end).toHaveBeenCalledWith(expect.stringContaining('too_many_attempts'));
            expect(res.end).toHaveBeenCalledWith(expect.stringContaining('retryAfterSeconds'));
            expect(next).not.toHaveBeenCalled();
        });

        test('should call next() for authenticated request', () => {
            const token = generateToken();
            auth = new AdminAuth({
                enabled: true,
                tokens: [token]
            });

            const req = {
                url: '/control/pause',
                headers: { 'x-admin-token': token },
                socket: { remoteAddress: '127.0.0.1' }
            };

            const res = {
                writeHead: jest.fn(),
                setHeader: jest.fn(),
                end: jest.fn()
            };

            const next = jest.fn();

            const middleware = auth.middleware();
            middleware(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(res.writeHead).not.toHaveBeenCalled();
            expect(res.end).not.toHaveBeenCalled();
        });

        test('should call next() for non-protected path', () => {
            auth = new AdminAuth({
                enabled: true,
                tokens: ['valid-token-1234567890']
            });

            const req = {
                url: '/health',
                headers: {},
                socket: { remoteAddress: '127.0.0.1' }
            };

            const res = {
                writeHead: jest.fn(),
                setHeader: jest.fn(),
                end: jest.fn()
            };

            const next = jest.fn();

            const middleware = auth.middleware();
            middleware(req, res, next);

            expect(next).toHaveBeenCalled();
            expect(res.writeHead).not.toHaveBeenCalled();
        });
    });

    describe('Audit log (lines 393-444)', () => {
        test('should limit audit log size via RingBuffer', () => {
            auth = new AdminAuth({
                enabled: true,
                tokens: ['valid-token-1234567890'],
                maxAuditEntries: 5
            });

            // Add 10 audit entries
            for (let i = 0; i < 10; i++) {
                auth._audit('test', `client-${i}`, '/test', true);
            }

            // RingBuffer should limit size to 5
            const allEntries = auth.auditLog.toArray();
            expect(allEntries.length).toBe(5);
            // Should keep the most recent entries (client-5 through client-9)
            expect(allEntries[0].clientId).toBe('client-5');
            expect(allEntries[4].clientId).toBe('client-9');
        });

        test('getAuditLog should return limited entries', () => {
            auth = new AdminAuth({
                enabled: true,
                tokens: ['valid-token-1234567890']
            });

            // Add 150 audit entries
            for (let i = 0; i < 150; i++) {
                auth._audit('test', `client-${i}`, '/test', true);
            }

            const log = auth.getAuditLog(50);

            expect(log.length).toBe(50);
            // Should return the last 50 entries
            expect(log[0].clientId).toBe('client-100');
            expect(log[49].clientId).toBe('client-149');
        });

        test('getAuditLog should default to 100 entries', () => {
            auth = new AdminAuth({
                enabled: true,
                tokens: ['valid-token-1234567890']
            });

            // Add 150 audit entries
            for (let i = 0; i < 150; i++) {
                auth._audit('test', `client-${i}`, '/test', true);
            }

            const log = auth.getAuditLog();

            expect(log.length).toBe(100);
        });

        test('_audit should record all required fields', () => {
            auth = new AdminAuth({
                enabled: true
            });

            auth._audit('success', '127.0.0.1', '/control/pause', true);

            const allEntries = auth.auditLog.toArray();
            expect(allEntries.length).toBe(1);
            const entry = allEntries[0];
            expect(entry).toHaveProperty('timestamp');
            expect(entry.action).toBe('success');
            expect(entry.clientId).toBe('127.0.0.1');
            expect(entry.path).toBe('/control/pause');
            expect(entry.success).toBe(true);
        });
    });

    describe('getStats (lines 410-436)', () => {
        test('should return comprehensive stats', () => {
            const token = generateToken();
            auth = new AdminAuth({
                enabled: true,
                tokens: [token]
            });

            // Trigger some successful auth
            const reqSuccess = {
                url: '/control/pause',
                headers: { 'x-admin-token': token },
                socket: { remoteAddress: '127.0.0.1' }
            };
            auth.authenticate(reqSuccess);

            // Trigger some failed auth
            const reqFail = {
                url: '/control/pause',
                headers: { 'x-admin-token': 'invalid' },
                socket: { remoteAddress: '192.168.1.1' }
            };
            auth.authenticate(reqFail);

            const stats = auth.getStats();

            expect(stats).toHaveProperty('enabled', true);
            expect(stats).toHaveProperty('tokenCount', 1);
            expect(stats).toHaveProperty('lockedClients');
            expect(stats).toHaveProperty('protectedPaths');
            expect(stats).toHaveProperty('recentAuth');
            expect(stats.recentAuth).toHaveProperty('success');
            expect(stats.recentAuth).toHaveProperty('failure');
            expect(stats.recentAuth).toHaveProperty('successRate');
        });

        test('should count locked clients correctly', () => {
            jest.useFakeTimers();

            auth = new AdminAuth({
                enabled: true,
                tokens: ['valid-token-1234567890'],
                maxAttempts: 1
            });

            const req = {
                url: '/control/pause',
                headers: { 'x-admin-token': 'invalid' },
                socket: { remoteAddress: '127.0.0.1' }
            };

            // Trigger lockout
            auth.authenticate(req);

            const stats = auth.getStats();
            expect(stats.lockedClients).toBe(1);

            jest.useRealTimers();
        });

        test('should calculate success rate correctly', () => {
            const token = generateToken();
            auth = new AdminAuth({
                enabled: true,
                tokens: [token]
            });

            // 3 successes
            const reqSuccess = {
                url: '/control/pause',
                headers: { 'x-admin-token': token },
                socket: { remoteAddress: '127.0.0.1' }
            };
            auth.authenticate(reqSuccess);
            auth.authenticate(reqSuccess);
            auth.authenticate(reqSuccess);

            // 1 failure
            const reqFail = {
                url: '/control/pause',
                headers: { 'x-admin-token': 'invalid' },
                socket: { remoteAddress: '192.168.1.1' }
            };
            auth.authenticate(reqFail);

            const stats = auth.getStats();
            expect(stats.recentAuth.success).toBe(3);
            expect(stats.recentAuth.failure).toBe(1);
            expect(stats.recentAuth.successRate).toBe(75);
        });

        test('should handle empty audit log', () => {
            auth = new AdminAuth({
                enabled: true,
                tokens: ['valid-token-1234567890']
            });

            const stats = auth.getStats();
            expect(stats.recentAuth.successRate).toBe(100);
        });
    });

    describe('clearLockouts (lines 442-445)', () => {
        test('should clear all failed attempts', () => {
            auth = new AdminAuth({
                enabled: true,
                tokens: ['valid-token-1234567890'],
                maxAttempts: 1
            });

            const req = {
                url: '/control/pause',
                headers: { 'x-admin-token': 'invalid' },
                socket: { remoteAddress: '127.0.0.1' }
            };

            // Trigger lockout
            auth.authenticate(req);
            expect(auth.failedAttempts.size).toBe(1);

            auth.clearLockouts();

            expect(auth.failedAttempts.size).toBe(0);
        });

        test('should allow previously locked client to authenticate after clear', () => {
            const token = generateToken();
            auth = new AdminAuth({
                enabled: true,
                tokens: [token],
                maxAttempts: 1
            });

            const reqFail = {
                url: '/control/pause',
                headers: { 'x-admin-token': 'invalid' },
                socket: { remoteAddress: '127.0.0.1' }
            };

            // Trigger lockout
            auth.authenticate(reqFail);

            // Verify locked
            let result = auth.authenticate(reqFail);
            expect(result.error).toBe('too_many_attempts');

            // Clear lockouts
            auth.clearLockouts();

            // Now should be able to authenticate with valid token
            const reqSuccess = {
                url: '/control/pause',
                headers: { 'x-admin-token': token },
                socket: { remoteAddress: '127.0.0.1' }
            };
            result = auth.authenticate(reqSuccess);
            expect(result.authenticated).toBe(true);
        });
    });

    describe('Auth disabled mode (line 144)', () => {
        test('should not require auth when disabled', () => {
            auth = new AdminAuth({
                enabled: false,
                tokens: ['valid-token-1234567890']
            });

            const result = auth.requiresAuth('/control/pause');
            expect(result).toBe(false);
        });

        test('should allow all requests when disabled', () => {
            auth = new AdminAuth({
                enabled: false,
                tokens: ['valid-token-1234567890']
            });

            const req = {
                url: '/control/pause',
                headers: {},
                socket: { remoteAddress: '127.0.0.1' }
            };

            const result = auth.authenticate(req);
            expect(result.authenticated).toBe(true);
            expect(result.required).toBe(false);
        });
    });

    describe('Trusted proxies fallback (line 182)', () => {
        test('should handle undefined trustedProxies', () => {
            // Create auth without trustedProxies option
            auth = new AdminAuth({
                enabled: true,
                tokens: ['valid-token-1234567890']
                // trustedProxies is not set, should use || [] fallback
            });

            const req = {
                url: '/control/pause',
                headers: { 'x-admin-token': 'invalid' },
                socket: { remoteAddress: '127.0.0.1' }
            };

            // Should not throw, even though trustedProxies might be undefined
            const result = auth.authenticate(req);
            expect(result.authenticated).toBe(false);
        });

        test('should work with explicitly null trustedProxies', () => {
            auth = new AdminAuth({
                enabled: true,
                tokens: ['valid-token-1234567890'],
                trustedProxies: null
            });

            const req = {
                url: '/control/pause',
                headers: { 'x-admin-token': 'invalid' },
                socket: { remoteAddress: '127.0.0.1' }
            };

            const result = auth.authenticate(req);
            expect(result.authenticated).toBe(false);
        });
    });

    describe('Query parameter token extraction', () => {
        test('should extract token from query parameter', () => {
            const token = generateToken();
            auth = new AdminAuth({
                enabled: true,
                tokens: [token],
                queryParam: 'admin_token'
            });

            const req = {
                url: `/control/pause?admin_token=${token}`,
                headers: {},
                socket: { remoteAddress: '127.0.0.1' }
            };

            const result = auth.authenticate(req);

            expect(result.authenticated).toBe(true);
        });

        test('should prefer header over query parameter', () => {
            const headerToken = generateToken();
            const queryToken = generateToken();

            auth = new AdminAuth({
                enabled: true,
                tokens: [headerToken], // Only header token is valid
                headerName: 'x-admin-token',
                queryParam: 'admin_token'
            });

            const req = {
                url: `/control/pause?admin_token=${queryToken}`,
                headers: { 'x-admin-token': headerToken },
                socket: { remoteAddress: '127.0.0.1' }
            };

            const result = auth.authenticate(req);

            // Should authenticate using header token
            expect(result.authenticated).toBe(true);
        });
    });
});
