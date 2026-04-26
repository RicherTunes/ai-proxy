'use strict';

/**
 * Tenant Manager Sanitization Security Tests
 *
 * Tests cover:
 * 6.  sanitizeTenantId with null bytes
 * 7.  sanitizeTenantId with pure control chars (falls back to default)
 * 8.  sanitizeTenantId with 200-char ID (truncated to 128)
 * 9.  sanitizeTenantId with curly braces
 * 10. sanitizeTenantId with backslashes
 * 11. sanitizeTenantId with unicode (preserved)
 * 12. sanitizeTenantId with mixed dangerous input
 */

const { sanitizeTenantId, DEFAULT_TENANT_ID, MAX_TENANT_ID_LENGTH } = require('../lib/tenant-manager');

describe('sanitizeTenantId security', () => {
    // 6. Null bytes stripped
    test('should strip null bytes', () => {
        const result = sanitizeTenantId('tenant\x00evil');
        expect(result).toBe('tenantevil');
        expect(result).not.toContain('\x00');
    });

    // 7. Pure control chars -> empty -> falls back to default
    test('should return default for string of pure control characters', () => {
        // Build a string of only control characters (\x00-\x1f, \x7f)
        const controlChars = String.fromCharCode(
            0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
            0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
            0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17,
            0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
            0x7f
        );
        const result = sanitizeTenantId(controlChars);
        expect(result).toBe(DEFAULT_TENANT_ID);
    });

    // 8. 200-char ID truncated to MAX_TENANT_ID_LENGTH (128)
    test('should truncate a 200-character ID to 128 characters', () => {
        const longId = 'x'.repeat(200);
        const result = sanitizeTenantId(longId);
        expect(result.length).toBe(MAX_TENANT_ID_LENGTH);
        expect(result).toBe('x'.repeat(128));
    });

    test('should not truncate a 128-character ID', () => {
        const exactId = 'y'.repeat(128);
        const result = sanitizeTenantId(exactId);
        expect(result.length).toBe(128);
        expect(result).toBe(exactId);
    });

    test('should not truncate a short ID', () => {
        const result = sanitizeTenantId('short');
        expect(result).toBe('short');
    });

    // 9. Curly braces stripped
    test('should strip curly braces from tenant ID', () => {
        const result = sanitizeTenantId('tenant{injection}');
        expect(result).toBe('tenantinjection');
        expect(result).not.toContain('{');
        expect(result).not.toContain('}');
    });

    test('should strip only braces, preserving other characters', () => {
        const result = sanitizeTenantId('a{b}c{d}e');
        expect(result).toBe('abcde');
    });

    // 10. Backslashes stripped
    test('should strip backslashes from tenant ID', () => {
        const result = sanitizeTenantId('tenant\\path');
        expect(result).toBe('tenantpath');
        expect(result).not.toContain('\\');
    });

    test('should strip multiple consecutive backslashes', () => {
        const result = sanitizeTenantId('a\\\\b\\c');
        expect(result).toBe('abc');
    });

    // 11. Valid unicode preserved
    test('should preserve Chinese characters', () => {
        const result = sanitizeTenantId('\u4f60\u597d');
        expect(result).toBe('\u4f60\u597d');
    });

    test('should preserve Arabic characters', () => {
        const result = sanitizeTenantId('\u0645\u0631\u062d\u0628\u0627');
        expect(result).toBe('\u0645\u0631\u062d\u0628\u0627');
    });

    test('should preserve emoji characters', () => {
        const result = sanitizeTenantId('tenant-\ud83d\ude80-id');
        expect(result).toBe('tenant-\ud83d\ude80-id');
    });

    test('should preserve mixed unicode with ASCII', () => {
        const result = sanitizeTenantId('org-\u4f60\u597d-test');
        expect(result).toBe('org-\u4f60\u597d-test');
    });

    // 12. Mixed dangerous input
    test('should sanitize mixed dangerous characters to safe output', () => {
        const result = sanitizeTenantId('\x00{evil}\nid');
        expect(result).toBe('evilid');
    });

    test('should handle all dangerous chars combined', () => {
        // null byte + control chars + quotes + braces + backslash + newline
        const result = sanitizeTenantId('\x00\x01"hello{world}\\foo\nbar\r\x7f');
        expect(result).toBe('helloworldfoobar');
    });

    test('should return default for non-string input (null)', () => {
        expect(sanitizeTenantId(null)).toBe(DEFAULT_TENANT_ID);
    });

    test('should return default for non-string input (undefined)', () => {
        expect(sanitizeTenantId(undefined)).toBe(DEFAULT_TENANT_ID);
    });

    test('should return default for non-string input (number)', () => {
        expect(sanitizeTenantId(42)).toBe(DEFAULT_TENANT_ID);
    });

    test('should return default for non-string input (object)', () => {
        expect(sanitizeTenantId({ toString: () => 'evil' })).toBe(DEFAULT_TENANT_ID);
    });

    test('should strip double quotes', () => {
        const result = sanitizeTenantId('tenant"id');
        expect(result).toBe('tenantid');
    });

    test('should handle string that becomes empty after sanitization', () => {
        // Only forbidden characters
        const result = sanitizeTenantId('"{}\\');
        expect(result).toBe(DEFAULT_TENANT_ID);
    });

    test('should truncate after stripping (strip first, then truncate)', () => {
        // 200 chars but half are braces -> stripped to ~100 safe chars -> no truncation needed
        const input = '{a}'.repeat(67); // 201 chars raw -> stripped to 67 'a' chars
        const result = sanitizeTenantId(input);
        expect(result).toBe('a'.repeat(67));
        expect(result.length).toBeLessThanOrEqual(MAX_TENANT_ID_LENGTH);
    });
});
