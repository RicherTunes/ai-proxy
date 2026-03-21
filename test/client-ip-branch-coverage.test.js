'use strict';

const { getClientIp, normalizeIp, parseXff, stripPort } = require('../lib/client-ip');

describe('client-ip branch coverage', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('getClientIp uncovered branches', () => {
        // Covers line 92: default parameter trustedProxies = []
        test('getClientIp without trustedProxies arg uses empty array default', () => {
            const req = {
                socket: { remoteAddress: '192.168.1.1' },
                headers: { 'x-forwarded-for': '10.0.0.1' }
            };
            // No second arg - uses default [] - remoteAddress not trusted
            const result = getClientIp(req);
            expect(result).toBe('192.168.1.1');
        });

        // Covers line 114: normalizedRemote || 'unknown' when trusted proxy, no XFF, no x-real-ip
        test('trusted proxy with empty remoteAddress and no XFF returns unknown', () => {
            const req = {
                socket: { remoteAddress: '127.0.0.1' },
                headers: {}
            };
            // First clear the cache by using a different array reference
            const trustedProxies = ['127.0.0.1'];
            // Test with socket having empty normalizedRemote via mocking
            // Actually, we need to test when remoteAddress itself results in empty
            // We need socket.remoteAddress to be something that normalizes to empty
            const reqEmptyRemote = {
                socket: { remoteAddress: '' },
                headers: {}
            };
            // 127.0.0.1 is trusted, empty remoteAddress normalizes to '', triggers || 'unknown'
            // But '' is not in trusted set, so it would return at line 101
            // We need a scenario where socket.remoteAddress is truthy but normalizes to empty
            // Actually normalizeIp('') returns '' (empty string trimmed is empty)
            // For line 114: trusted proxy + no XFF + no x-real-ip + empty normalizedRemote
            // The only way is if remoteAddress normalizes to '' AND is trusted
            // But '' won't be in the trusted set typically
            // Let's check: normalizedRemote = normalizeIp('') = ''
            // trustedSet.has('') = false unless '' is in trustedProxies
            // So we need to pass '' as a trusted proxy
            const result = getClientIp(reqEmptyRemote, ['']);
            expect(result).toBe('unknown');
        });

        // Covers line 128: normalizedRemote || 'unknown' when all XFF trusted, empty remoteAddress
        test('all XFF trusted with empty remoteAddress returns unknown', () => {
            const req = {
                socket: { remoteAddress: '' },
                headers: { 'x-forwarded-for': '' }
            };
            // '' in XFF normalizes to '' and gets filtered out (empty segments ignored)
            // So xffList will be empty, hitting line 114 not 128
            // We need xffList with entries that are ALL trusted, AND normalizedRemote empty
            const reqWithTrustedXff = {
                socket: { remoteAddress: '' },
                headers: { 'x-forwarded-for': 'trusted.proxy' }
            };
            // '' normalizes to '', need '' in trusted set for line 100 to pass
            // Then chain = ['trusted.proxy', ''], walk right-to-left
            // If 'trusted.proxy' is also trusted, all are trusted, hits line 128
            const result = getClientIp(reqWithTrustedXff, ['', 'trusted.proxy']);
            expect(result).toBe('unknown');
        });
    });
});
