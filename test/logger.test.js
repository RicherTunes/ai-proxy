/**
 * Logger Module Tests
 */

const { Logger, LOG_LEVELS, SENSITIVE_FIELDS, getLogger, resetLogger, generateRequestId, API_KEY_PATTERN } = require('../lib/logger');

describe('Logger', () => {
    let mockOutput;

    beforeEach(() => {
        mockOutput = {
            log: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        };
        resetLogger();
    });

    describe('constructor', () => {
        test('should create logger with default options', () => {
            const logger = new Logger();
            expect(logger.level).toBe(LOG_LEVELS.INFO);
            expect(logger.format).toBe('text');
            expect(logger.prefix).toBe('');
        });

        test('should create logger with custom options', () => {
            const logger = new Logger({
                level: 'DEBUG',
                format: 'json',
                prefix: 'TEST'
            });
            expect(logger.level).toBe(LOG_LEVELS.DEBUG);
            expect(logger.format).toBe('json');
            expect(logger.prefix).toBe('TEST');
        });

        test('should handle invalid log level', () => {
            const logger = new Logger({ level: 'INVALID' });
            expect(logger.level).toBe(LOG_LEVELS.INFO);
        });
    });

    describe('logging methods', () => {
        test('should log debug messages when level is DEBUG', () => {
            const logger = new Logger({ level: 'DEBUG', output: mockOutput });
            logger.debug('test message');
            expect(mockOutput.log).toHaveBeenCalled();
        });

        test('should not log debug messages when level is INFO', () => {
            const logger = new Logger({ level: 'INFO', output: mockOutput });
            logger.debug('test message');
            expect(mockOutput.log).not.toHaveBeenCalled();
        });

        test('should log info messages', () => {
            const logger = new Logger({ level: 'INFO', output: mockOutput });
            logger.info('test message');
            expect(mockOutput.log).toHaveBeenCalled();
        });

        test('should log warn messages', () => {
            const logger = new Logger({ level: 'INFO', output: mockOutput });
            logger.warn('test message');
            expect(mockOutput.warn).toHaveBeenCalled();
        });

        test('should log error messages', () => {
            const logger = new Logger({ level: 'INFO', output: mockOutput });
            logger.error('test message');
            expect(mockOutput.error).toHaveBeenCalled();
        });

        test('should include context in log messages', () => {
            const logger = new Logger({ level: 'INFO', output: mockOutput });
            logger.info('test message', { foo: 'bar' });
            expect(mockOutput.log).toHaveBeenCalled();
            const loggedMessage = mockOutput.log.mock.calls[0][0];
            expect(loggedMessage).toContain('foo=');
        });
    });

    describe('JSON format', () => {
        test('should output JSON when format is json', () => {
            const logger = new Logger({ level: 'INFO', format: 'json', output: mockOutput });
            logger.info('test message', { requestId: '123' });
            const loggedMessage = mockOutput.log.mock.calls[0][0];
            const parsed = JSON.parse(loggedMessage);
            expect(parsed.message).toBe('test message');
            expect(parsed.level).toBe('INFO');
            expect(parsed.requestId).toBe('123');
        });
    });

    describe('child logger', () => {
        test('should create child logger with combined prefix', () => {
            const parent = new Logger({ prefix: 'PARENT' });
            const child = parent.child('CHILD');
            expect(child.prefix).toBe('PARENT:CHILD');
        });

        test('should inherit log level from parent', () => {
            const parent = new Logger({ level: 'DEBUG' });
            const child = parent.child('CHILD');
            expect(child.level).toBe(LOG_LEVELS.DEBUG);
        });
    });

    describe('forRequest', () => {
        test('should create request-scoped logger with requestId', () => {
            const logger = new Logger({ level: 'INFO', output: mockOutput });
            const reqLogger = logger.forRequest('req-123');
            reqLogger.info('test');
            const loggedMessage = mockOutput.log.mock.calls[0][0];
            expect(loggedMessage).toContain('req-123');
        });
    });

    describe('setLevel', () => {
        test('should change log level', () => {
            const logger = new Logger({ level: 'INFO', output: mockOutput });
            logger.debug('should not log');
            expect(mockOutput.log).not.toHaveBeenCalled();

            logger.setLevel('DEBUG');
            logger.debug('should log');
            expect(mockOutput.log).toHaveBeenCalled();
        });
    });
});

describe('generateRequestId', () => {
    test('should generate unique IDs', () => {
        const id1 = generateRequestId();
        const id2 = generateRequestId();
        expect(id1).not.toBe(id2);
    });

    test('should generate IDs in expected format', () => {
        const id = generateRequestId();
        // Format: timestamp-counter-random
        expect(id).toMatch(/^[a-z0-9]+-[a-f0-9]{4}-[a-z0-9]+$/);
    });
});

describe('getLogger singleton', () => {
    beforeEach(() => {
        resetLogger();
    });

    test('should return singleton instance', () => {
        const logger1 = getLogger();
        const logger2 = getLogger();
        expect(logger1).toBe(logger2);
    });

    test('should create new instance with options', () => {
        const logger1 = getLogger({ level: 'DEBUG' });
        expect(logger1.level).toBe(LOG_LEVELS.DEBUG);
    });

    test('should reset singleton', () => {
        const logger1 = getLogger({ level: 'DEBUG' });
        resetLogger();
        const logger2 = getLogger({ level: 'ERROR' });
        expect(logger2.level).toBe(LOG_LEVELS.ERROR);
    });
});

// ========== SENSITIVE DATA SANITIZATION TESTS ==========

describe('Logger sensitive data sanitization', () => {
    let mockOutput;
    let logger;

    beforeEach(() => {
        mockOutput = {
            log: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        };
        logger = new Logger({ level: 'DEBUG', output: mockOutput });
    });

    describe('_maskValue', () => {
        test('should mask long strings showing first 8 chars', () => {
            const result = logger._maskValue('abcdefghijklmnop');
            expect(result).toBe('abcdefgh***');
        });

        test('should fully mask short strings', () => {
            const result = logger._maskValue('short');
            expect(result).toBe('***');
        });

        test('should return non-strings unchanged', () => {
            expect(logger._maskValue(123)).toBe(123);
            expect(logger._maskValue(null)).toBe(null);
            expect(logger._maskValue(undefined)).toBe(undefined);
        });

        test('should mask exactly 8 character strings', () => {
            const result = logger._maskValue('12345678');
            expect(result).toBe('***');
        });
    });

    describe('_sanitizeContext', () => {
        test('should mask api key fields', () => {
            const context = {
                key: 'abc123def456ghi789jkl012mno345',
                apiKey: 'secret12345678901234567890',
                api_key: 'another_secret_value_here'
            };
            const sanitized = logger._sanitizeContext(context);

            expect(sanitized.key).toBe('abc123de***');
            expect(sanitized.apiKey).toBe('secret12***');
            expect(sanitized.api_key).toBe('another_***');
        });

        test('should mask authorization and token fields', () => {
            const context = {
                authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
                token: 'some_secret_token_value_here',
                password: 'super_secret_password'
            };
            const sanitized = logger._sanitizeContext(context);

            expect(sanitized.authorization).toBe('Bearer e***');
            expect(sanitized.token).toBe('some_sec***');
            expect(sanitized.password).toBe('super_se***');
        });

        test('should mask nested sensitive fields', () => {
            const context = {
                user: {
                    name: 'John',
                    credentials: {
                        apiKey: 'nested_api_key_value_here'
                    }
                }
            };
            const sanitized = logger._sanitizeContext(context);

            expect(sanitized.user.name).toBe('John');
            expect(sanitized.user.credentials.apiKey).toBe('nested_a***');
        });

        test('should detect and mask API key patterns in values', () => {
            const context = {
                data: 'abcdefghijklmnopqrstuvwxyz123456.secretpart1234567890'
            };
            const sanitized = logger._sanitizeContext(context);

            // Should detect the pattern and mask it
            expect(sanitized.data).toBe('abcdefgh***');
        });

        test('should handle arrays with sensitive data', () => {
            const context = {
                keys: [
                    { key: 'key1_secret_value_here' },
                    { key: 'key2_secret_value_here' }
                ]
            };
            const sanitized = logger._sanitizeContext(context);

            expect(sanitized.keys[0].key).toBe('key1_sec***');
            expect(sanitized.keys[1].key).toBe('key2_sec***');
        });

        test('should preserve non-sensitive fields', () => {
            const context = {
                statusCode: 200,
                method: 'POST',
                path: '/api/messages',
                duration: 1234
            };
            const sanitized = logger._sanitizeContext(context);

            expect(sanitized.statusCode).toBe(200);
            expect(sanitized.method).toBe('POST');
            expect(sanitized.path).toBe('/api/messages');
            expect(sanitized.duration).toBe(1234);
        });

        test('should handle null and undefined', () => {
            expect(logger._sanitizeContext(null)).toBe(null);
            expect(logger._sanitizeContext(undefined)).toBe(undefined);
        });

        test('should prevent deep recursion', () => {
            const deep = {};
            let current = deep;
            for (let i = 0; i < 15; i++) {
                current.nested = { key: 'secret_value_' + i };
                current = current.nested;
            }

            // Should not throw even with very deep nesting
            expect(() => logger._sanitizeContext(deep)).not.toThrow();
        });
    });

    describe('log output sanitization', () => {
        test('should sanitize context in log buffer', () => {
            logger.info('Test message', { apiKey: 'supersecretkey12345' });

            const logs = logger.getLogs();
            expect(logs.length).toBe(1);
            expect(logs[0].context.apiKey).toBe('supersec***');
        });

        test('should sanitize context in formatted output', () => {
            logger.info('Test message', { token: 'mysecrettoken123456' });

            const loggedMessage = mockOutput.log.mock.calls[0][0];
            expect(loggedMessage).not.toContain('mysecrettoken123456');
            expect(loggedMessage).toContain('mysecret***');
        });

        test('should sanitize JSON format output', () => {
            const jsonLogger = new Logger({
                level: 'DEBUG',
                format: 'json',
                output: mockOutput
            });

            jsonLogger.info('Test', { password: 'mypassword12345' });

            const loggedMessage = mockOutput.log.mock.calls[0][0];
            const parsed = JSON.parse(loggedMessage);
            expect(parsed.password).toBe('mypasswo***');
        });
    });

    describe('sanitization can be disabled', () => {
        test('should not sanitize when disabled', () => {
            const unsafeLogger = new Logger({
                level: 'DEBUG',
                output: mockOutput,
                sanitizeLogs: false
            });

            unsafeLogger.info('Test', { apiKey: 'fullkey12345678' });

            const logs = unsafeLogger.getLogs();
            expect(logs[0].context.apiKey).toBe('fullkey12345678');
        });
    });

    describe('case insensitive field matching', () => {
        test('should match uppercase sensitive fields', () => {
            const context = {
                API_KEY: 'secret_value_here_123',
                TOKEN: 'another_secret_token'
            };
            const sanitized = logger._sanitizeContext(context);

            expect(sanitized.API_KEY).toBe('secret_v***');
            expect(sanitized.TOKEN).toBe('another_***');
        });

        test('should match mixed case sensitive fields', () => {
            const context = {
                ApiKey: 'mixed_case_secret_val',
                userToken: 'user_token_secret_val'
            };
            const sanitized = logger._sanitizeContext(context);

            expect(sanitized.ApiKey).toBe('mixed_ca***');
            expect(sanitized.userToken).toBe('user_tok***');
        });
    });
});

describe('API_KEY_PATTERN regression test', () => {
    let mockOutput;

    beforeEach(() => {
        mockOutput = {
            log: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        };
        resetLogger();
    });

    test('should API_KEY_PATTERN not have global flag (/g)', () => {
        // The regex pattern should not use /g flag to avoid stateful behavior
        // with .test() which updates lastIndex and can cause intermittent false negatives
        const patternString = API_KEY_PATTERN.toString();
        expect(patternString).not.toContain('/g');
        expect(patternString).toContain('/');
    });

    test('should detect API key patterns correctly without global flag interference', () => {
        const logger = new Logger({ level: 'DEBUG', output: mockOutput });

        // Test multiple API key detections without global flag interference
        const validApiKeys = [
            'abcdefghijklmnopqrstuvwxyz123456.secretpart1234567890',
            'averylongkeyprefix123456.anotherlongkeypart789012',
            'testkey12345678901234567890.testkeypart987654321'
        ];

        const invalidApiKeys = [
            'shortkey123.secret456789', // Too short before dot
            'anotherkey789012.keypart3456789012', // Too short before dot
            'not.an.api.key', // Doesn't match pattern
            'this.is.not.a.valid.key.format' // Wrong format
        ];

        // Test valid API keys
        validApiKeys.forEach((testCase) => {
            const result = API_KEY_PATTERN.test(testCase);
            expect(result).toBe(true);
            expect(logger._maskValue(testCase)).toBe(testCase.substring(0, 8) + '***');
        });

        // Test invalid API keys
        invalidApiKeys.forEach((testCase) => {
            const result = API_KEY_PATTERN.test(testCase);
            expect(result).toBe(false);
        });

        // Verify no state carryover between tests by testing the same pattern multiple times
        const firstTest = API_KEY_PATTERN.test(validApiKeys[0]);
        const secondTest = API_KEY_PATTERN.test(validApiKeys[0]);
        expect(firstTest).toBe(true);
        expect(secondTest).toBe(true);
    });
});

describe('SENSITIVE_FIELDS export', () => {
    test('should export sensitive fields list', () => {
        expect(Array.isArray(SENSITIVE_FIELDS)).toBe(true);
        expect(SENSITIVE_FIELDS).toContain('key');
        expect(SENSITIVE_FIELDS).toContain('apiKey');
        expect(SENSITIVE_FIELDS).toContain('token');
        expect(SENSITIVE_FIELDS).toContain('password');
    });
});
