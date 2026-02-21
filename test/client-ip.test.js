'use strict';

const { getClientIp, normalizeIp, parseXff, stripPort } = require('../lib/client-ip');

describe('client-ip', () => {
    describe('normalizeIp', () => {
        test('maps IPv4-mapped IPv6 to plain IPv4', () => {
            expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
            expect(normalizeIp('::ffff:192.168.1.1')).toBe('192.168.1.1');
        });

        test('leaves plain IPv4 unchanged', () => {
            expect(normalizeIp('192.168.1.1')).toBe('192.168.1.1');
        });

        test('leaves plain IPv6 unchanged', () => {
            expect(normalizeIp('::1')).toBe('::1');
            expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
        });

        test('handles null and undefined', () => {
            expect(normalizeIp(null)).toBe('');
            expect(normalizeIp(undefined)).toBe('');
        });
    });

    describe('stripPort', () => {
        test('strips IPv4 port suffix', () => {
            expect(stripPort('1.2.3.4:1234')).toBe('1.2.3.4');
        });

        test('strips bracketed IPv6 port', () => {
            expect(stripPort('[::1]:1234')).toBe('::1');
        });

        test('leaves plain IPv4 unchanged', () => {
            expect(stripPort('1.2.3.4')).toBe('1.2.3.4');
        });

        test('leaves plain IPv6 unchanged', () => {
            expect(stripPort('::1')).toBe('::1');
        });
    });

    describe('parseXff', () => {
        test('parses comma-separated IPs', () => {
            expect(parseXff('10.0.0.1, 10.0.0.2, 127.0.0.1')).toEqual(['10.0.0.1', '10.0.0.2', '127.0.0.1']);
        });

        test('ignores empty segments', () => {
            expect(parseXff('10.0.0.1, , 10.0.0.2')).toEqual(['10.0.0.1', '10.0.0.2']);
        });

        test('handles undefined/empty', () => {
            expect(parseXff(undefined)).toEqual([]);
            expect(parseXff('')).toEqual([]);
        });

        test('strips port suffixes', () => {
            expect(parseXff('1.2.3.4:8080, 5.6.7.8')).toEqual(['1.2.3.4', '5.6.7.8']);
        });
    });

    describe('getClientIp', () => {
        function makeReq(remoteAddress, headers = {}) {
            return {
                socket: { remoteAddress },
                headers
            };
        }

        test('untrusted proxy spoof ignored: returns remoteAddress', () => {
            const req = makeReq('192.168.1.100', {
                'x-forwarded-for': '10.0.0.1'
            });
            expect(getClientIp(req, ['127.0.0.1'])).toBe('192.168.1.100');
        });

        test('trusted proxy honored: returns XFF client IP', () => {
            const req = makeReq('127.0.0.1', {
                'x-forwarded-for': '10.0.0.1'
            });
            expect(getClientIp(req, ['127.0.0.1'])).toBe('10.0.0.1');
        });

        test('IPv4-mapped IPv6 remote treated as trusted', () => {
            const req = makeReq('::ffff:127.0.0.1', {
                'x-forwarded-for': '10.0.0.1'
            });
            expect(getClientIp(req, ['127.0.0.1'])).toBe('10.0.0.1');
        });

        test('multi-entry XFF right-to-left walk strips trusted', () => {
            const req = makeReq('127.0.0.1', {
                'x-forwarded-for': '10.0.0.1, 10.0.0.2, 127.0.0.1'
            });
            // Chain: [10.0.0.1, 10.0.0.2, 127.0.0.1, 127.0.0.1(remote)]
            // Walk right-to-left: skip 127.0.0.1, skip 127.0.0.1, 10.0.0.2 is untrusted
            expect(getClientIp(req, ['127.0.0.1'])).toBe('10.0.0.2');
        });

        test('no forwarded headers returns remoteAddress', () => {
            const req = makeReq('127.0.0.1', {});
            expect(getClientIp(req, ['127.0.0.1'])).toBe('127.0.0.1');
        });

        test('x-real-ip fallback when XFF absent', () => {
            const req = makeReq('127.0.0.1', {
                'x-real-ip': '10.0.0.5'
            });
            expect(getClientIp(req, ['127.0.0.1'])).toBe('10.0.0.5');
        });

        test('empty/whitespace XFF segments ignored', () => {
            const req = makeReq('127.0.0.1', {
                'x-forwarded-for': '10.0.0.1, , ,  '
            });
            expect(getClientIp(req, ['127.0.0.1'])).toBe('10.0.0.1');
        });

        test('IPv4 port suffixes stripped', () => {
            const req = makeReq('127.0.0.1', {
                'x-forwarded-for': '1.2.3.4:1234'
            });
            expect(getClientIp(req, ['127.0.0.1'])).toBe('1.2.3.4');
        });

        test('bracketed IPv6 port stripped', () => {
            const req = makeReq('127.0.0.1', {
                'x-forwarded-for': '[::1]:1234, 10.0.0.1'
            });
            // ::1 is trusted when in trustedProxies
            expect(getClientIp(req, ['127.0.0.1', '::1'])).toBe('10.0.0.1');
        });

        test('all XFF trusted returns remoteAddress', () => {
            const req = makeReq('127.0.0.1', {
                'x-forwarded-for': '127.0.0.1, ::1'
            });
            expect(getClientIp(req, ['127.0.0.1', '::1'])).toBe('127.0.0.1');
        });

        test('no trusted proxies configured returns remoteAddress', () => {
            const req = makeReq('192.168.1.1', {
                'x-forwarded-for': '10.0.0.1'
            });
            expect(getClientIp(req, [])).toBe('192.168.1.1');
        });

        test('missing socket returns unknown', () => {
            const req = { socket: {}, headers: {} };
            expect(getClientIp(req, [])).toBe('unknown');
        });
    });
});
