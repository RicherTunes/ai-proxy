'use strict';

const { AdminAuth } = require('../lib/admin-auth');

describe('AdminAuth failedAttempts cleanup', () => {
    let auth;

    afterEach(() => {
        if (auth) {
            auth.destroy();
        }
        jest.useRealTimers();
    });

    function createAuth(opts = {}) {
        auth = new AdminAuth({
            enabled: true,
            tokens: ['test-token-1234567890'],
            ...opts
        });
        return auth;
    }

    test('expired lockout entries removed on cleanup', () => {
        jest.useFakeTimers();
        const a = createAuth({ lockoutDurationMs: 1000 });

        // Simulate a failed attempt entry with expired lockout
        a.failedAttempts.set('192.168.1.1', {
            count: 5,
            firstAttempt: Date.now() - 5000,
            lastAttempt: Date.now() - 2000,
            lockoutUntil: Date.now() - 1 // already expired
        });

        a._cleanupFailedAttempts();

        expect(a.failedAttempts.size).toBe(0);
    });

    test('entries older than lockoutDurationMs * 2 removed', () => {
        jest.useFakeTimers();
        const a = createAuth({ lockoutDurationMs: 1000 });

        a.failedAttempts.set('192.168.1.1', {
            count: 2,
            firstAttempt: Date.now() - 3000, // 3x lockout duration
            lastAttempt: Date.now() - 2000
        });

        a._cleanupFailedAttempts();

        expect(a.failedAttempts.size).toBe(0);
    });

    test('entries older than 24h always removed', () => {
        jest.useFakeTimers();
        const a = createAuth({ lockoutDurationMs: 86400000 * 2 }); // very long lockout

        a.failedAttempts.set('192.168.1.1', {
            count: 1,
            firstAttempt: Date.now() - (25 * 60 * 60 * 1000), // 25h ago
            lastAttempt: Date.now() - 1000
        });

        a._cleanupFailedAttempts();

        expect(a.failedAttempts.size).toBe(0);
    });

    test('size bound enforced: oldest entries evicted when exceeded', () => {
        jest.useFakeTimers();
        const a = createAuth({ maxFailedEntries: 3 });

        // Add entries in order (Map preserves insertion order)
        for (let i = 0; i < 5; i++) {
            a.failedAttempts.set(`client-${i}`, {
                count: 1,
                firstAttempt: Date.now(),
                lastAttempt: Date.now()
            });
        }

        expect(a.failedAttempts.size).toBe(5);

        a._cleanupFailedAttempts();

        expect(a.failedAttempts.size).toBe(3);
        // Oldest (client-0, client-1) should be evicted
        expect(a.failedAttempts.has('client-0')).toBe(false);
        expect(a.failedAttempts.has('client-1')).toBe(false);
        // Newest should remain
        expect(a.failedAttempts.has('client-2')).toBe(true);
        expect(a.failedAttempts.has('client-3')).toBe(true);
        expect(a.failedAttempts.has('client-4')).toBe(true);
    });

    test('cleanup interval is unref-ed (does not keep Node alive)', () => {
        const a = createAuth();
        expect(a._cleanupInterval).toBeDefined();
        // Timer.hasRef() returns false for unref-ed timers
        expect(a._cleanupInterval.hasRef()).toBe(false);
    });

    test('cleanup runs on interval tick', () => {
        jest.useFakeTimers();
        const a = createAuth();

        // Add a stale entry
        a.failedAttempts.set('stale-client', {
            count: 1,
            firstAttempt: Date.now() - (25 * 60 * 60 * 1000), // 25h old
            lastAttempt: Date.now() - (25 * 60 * 60 * 1000)
        });

        expect(a.failedAttempts.size).toBe(1);

        // Advance time by 5 minutes (cleanup interval)
        jest.advanceTimersByTime(5 * 60 * 1000);

        expect(a.failedAttempts.size).toBe(0);
    });

    test('destroy clears interval', () => {
        const a = createAuth();
        expect(a._cleanupInterval).not.toBeNull();

        a.destroy();

        expect(a._cleanupInterval).toBeNull();
    });

    test('destroy with clearState clears map and audit log', () => {
        const a = createAuth();
        a.failedAttempts.set('test', { count: 1, firstAttempt: Date.now() });
        a.auditLog.push({ action: 'test' });

        a.destroy({ clearState: true });

        expect(a.failedAttempts.size).toBe(0);
        expect(a.auditLog.length).toBe(0);
    });

    test('fresh entries not removed by cleanup', () => {
        jest.useFakeTimers();
        const a = createAuth({ lockoutDurationMs: 60000 });

        a.failedAttempts.set('fresh-client', {
            count: 2,
            firstAttempt: Date.now(),
            lastAttempt: Date.now()
        });

        a._cleanupFailedAttempts();

        expect(a.failedAttempts.size).toBe(1);
        expect(a.failedAttempts.has('fresh-client')).toBe(true);
    });
});
