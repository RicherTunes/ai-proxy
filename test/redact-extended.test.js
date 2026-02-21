/**
 * Redact Extended Tests
 * Covers uncovered lines: 66, 78, 95, 119, 146-147, 154
 * Focus on edge cases and untested branches in internal functions
 */

const { redactSensitiveData, REDACTED } = require('../lib/redact');

describe('redact - isSensitiveFieldName non-string input (line 66)', () => {
    test('should handle object with numeric key-like field names gracefully', () => {
        // isSensitiveFieldName receives keys from Object.entries, which are always strings,
        // but the function guards against non-string input
        const input = { normalField: 'value', anotherField: 123 };
        const output = redactSensitiveData(input);

        expect(output.normalField).toBe('value');
        expect(output.anotherField).toBe(123);
    });

    test('should not treat non-sensitive field names as sensitive', () => {
        const input = { username: 'john', email: 'john@example.com' };
        const output = redactSensitiveData(input);

        expect(output.username).toBe('john');
        expect(output.email).toBe('john@example.com');
    });
});

describe('redact - redactKey non-string input (line 78)', () => {
    test('should return non-string sensitive field values as REDACTED', () => {
        const input = {
            token: 42,
            secret: true,
            password: null,
            apikey: { nested: 'obj' }
        };
        const output = redactSensitiveData(input);

        // Non-string values in sensitive fields get REDACTED
        expect(output.token).toBe(REDACTED);
        expect(output.secret).toBe(REDACTED);
        // null gets deep-cloned then hits the sensitive field check as non-string
        expect(output.password).toBe(REDACTED);
        expect(output.apikey).toBe(REDACTED);
    });

    test('should handle sensitive field with array value as REDACTED', () => {
        const input = { token: [1, 2, 3] };
        const output = redactSensitiveData(input);

        expect(output.token).toBe(REDACTED);
    });

    test('should redact short string in sensitive field fully', () => {
        const input = { token: 'short' };
        const output = redactSensitiveData(input);

        // 'short' is 5 chars, <= 10, so redactKey returns REDACTED
        expect(output.token).toBe(REDACTED);
    });

    test('should redact long string in sensitive field with preview', () => {
        const input = { token: 'a-very-long-token-value' };
        const output = redactSensitiveData(input);

        expect(output.token).toBe('a-very-lon...');
    });
});

describe('redact - redactPatterns non-string input (line 95)', () => {
    test('should pass through number values unchanged in non-sensitive fields', () => {
        const input = { count: 42, ratio: 3.14 };
        const output = redactSensitiveData(input);

        expect(output.count).toBe(42);
        expect(output.ratio).toBe(3.14);
    });

    test('should pass through boolean values unchanged in non-sensitive fields', () => {
        const input = { enabled: true, disabled: false };
        const output = redactSensitiveData(input);

        expect(output.enabled).toBe(true);
        expect(output.disabled).toBe(false);
    });

    test('should handle primitive number at top level', () => {
        const output = redactSensitiveData(99);
        expect(output).toBe(99);
    });

    test('should handle primitive boolean at top level', () => {
        const output = redactSensitiveData(false);
        expect(output).toBe(false);
    });
});

describe('redact - redactHeaders null/non-object input (line 119)', () => {
    test('should handle null headers value in object', () => {
        const input = { headers: null, data: 'test' };
        const output = redactSensitiveData(input);

        expect(output.headers).toBeNull();
        expect(output.data).toBe('test');
    });

    test('should handle non-object headers value (string)', () => {
        const input = { headers: 'not-an-object' };
        const output = redactSensitiveData(input);

        // redactHeaders returns non-object input as-is
        expect(output.headers).toBe('not-an-object');
    });

    test('should handle non-object headers value (number)', () => {
        const input = { headers: 42 };
        const output = redactSensitiveData(input);

        expect(output.headers).toBe(42);
    });

    test('should handle undefined headers value', () => {
        const input = { headers: undefined };
        const output = redactSensitiveData(input);

        expect(output.headers).toBeUndefined();
    });
});

describe('redact - redactHeaders sensitive field names (lines 146-147)', () => {
    test('should redact header with sensitive name (token) and string value', () => {
        const input = {
            headers: {
                'token': 'my-long-secret-token-value',
                'content-type': 'application/json'
            }
        };
        const output = redactSensitiveData(input);

        // 'token' is in SENSITIVE_FIELD_NAMES, value > 10 chars -> first 10 + '...'
        expect(output.headers.token).toBe('my-long-se...');
        expect(output.headers['content-type']).toBe('application/json');
    });

    test('should redact header with sensitive name (secret) and short string value', () => {
        const input = {
            headers: {
                'secret': 'short'
            }
        };
        const output = redactSensitiveData(input);

        // 'secret' is in SENSITIVE_FIELD_NAMES, value <= 10 chars -> REDACTED
        expect(output.headers.secret).toBe(REDACTED);
    });

    test('should redact header with sensitive name (password) and non-string value', () => {
        const input = {
            headers: {
                'password': 12345
            }
        };
        const output = redactSensitiveData(input);

        // non-string value in sensitive header -> REDACTED
        expect(output.headers.password).toBe(REDACTED);
    });

    test('should redact header with sensitive name (auth) and non-string value', () => {
        const input = {
            headers: {
                'auth': { type: 'bearer', token: 'abc' }
            }
        };
        const output = redactSensitiveData(input);

        // 'auth' is in SENSITIVE_FIELD_NAMES, non-string -> REDACTED
        expect(output.headers.auth).toBe(REDACTED);
    });

    test('should redact bearer header (non-authorization) with long token', () => {
        const input = {
            headers: {
                'x-custom-auth': 'Bearer a-very-long-token-here-1234'
            }
        };
        const output = redactSensitiveData(input);

        // Not 'authorization' header, but value starts with 'Bearer '
        // Token after 'Bearer ' is 'a-very-long-token-here-1234' (27 chars), > 10
        // substring(0, 10) = 'a-very-lon'
        expect(output.headers['x-custom-auth']).toBe('Bearer a-very-lon...');
    });

    test('should redact bearer header (non-authorization) with short token', () => {
        const input = {
            headers: {
                'x-custom-auth': 'Bearer tiny'
            }
        };
        const output = redactSensitiveData(input);

        // Token 'tiny' is 4 chars, <= 10 -> 'Bearer [REDACTED]'
        expect(output.headers['x-custom-auth']).toBe('Bearer ' + REDACTED);
    });
});

describe('redact - redactHeaders non-string header value (line 154)', () => {
    test('should pass through non-string, non-sensitive header value as-is', () => {
        const input = {
            headers: {
                'x-retry-count': 3,
                'x-cache-hit': true
            }
        };
        const output = redactSensitiveData(input);

        // Non-string values in non-sensitive headers -> pass through
        expect(output.headers['x-retry-count']).toBe(3);
        expect(output.headers['x-cache-hit']).toBe(true);
    });

    test('should pass through null header value', () => {
        const input = {
            headers: {
                'x-optional': null
            }
        };
        const output = redactSensitiveData(input);

        expect(output.headers['x-optional']).toBeNull();
    });

    test('should pass through array header value as-is', () => {
        const input = {
            headers: {
                'x-multi-value': [1, 2, 3]
            }
        };
        const output = redactSensitiveData(input);

        // Arrays are not strings, so they pass through line 154
        expect(output.headers['x-multi-value']).toEqual([1, 2, 3]);
    });
});

describe('redact - deepClone edge cases', () => {
    test('should deep clone Date objects correctly', () => {
        const date = new Date('2025-06-15T12:00:00Z');
        const input = { created: date, token: 'secret-long-value-here' };

        const output = redactSensitiveData(input);

        // Date should be cloned, not same reference
        expect(output.created).toBeInstanceOf(Date);
        expect(output.created.getTime()).toBe(date.getTime());
        expect(output.created).not.toBe(date);
    });

    test('should deep clone RegExp objects correctly', () => {
        const regex = /pattern/gi;
        const input = { matcher: regex };

        const output = redactSensitiveData(input);

        expect(output.matcher).toBeInstanceOf(RegExp);
        expect(output.matcher.source).toBe('pattern');
        expect(output.matcher.flags).toBe('gi');
        expect(output.matcher).not.toBe(regex);
    });

    test('should deep clone arrays inside objects', () => {
        const input = { items: ['a', 'b', 'c'] };
        const output = redactSensitiveData(input);

        expect(output.items).toEqual(['a', 'b', 'c']);
        expect(output.items).not.toBe(input.items);
    });
});

describe('redact - redactRecursive Date and RegExp branches', () => {
    test('should preserve Date in recursive redaction', () => {
        const input = {
            nested: {
                timestamp: new Date('2025-01-01'),
                secret: 'long-secret-value-here'
            }
        };
        const output = redactSensitiveData(input);

        expect(output.nested.timestamp).toBeInstanceOf(Date);
        // 'secret' is sensitive, value is 21 chars > 10 -> first 10 + '...'
        expect(output.nested.secret).toBe('long-secre...');
    });

    test('should preserve RegExp in recursive redaction', () => {
        const input = {
            nested: {
                pattern: /test/g,
                password: 'long-password-value'
            }
        };
        const output = redactSensitiveData(input);

        expect(output.nested.pattern).toBeInstanceOf(RegExp);
        // 'password' is sensitive, value is 19 chars > 10 -> first 10 + '...'
        expect(output.nested.password).toBe('long-passw...');
    });
});
