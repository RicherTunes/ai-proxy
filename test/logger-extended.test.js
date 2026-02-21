/**
 * Logger Extended Tests
 * Targets uncovered lines: 63-66, 184
 * Focus: _sanitizeObject bare string API key detection, clearLogs(),
 *        and additional branch coverage for edge cases.
 */

const { Logger, LOG_LEVELS, getLogger, resetLogger, API_KEY_PATTERN } = require('../lib/logger');

describe('Logger Extended Coverage', () => {
    let mockOutput;

    beforeEach(() => {
        mockOutput = {
            log: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        };
        resetLogger();
    });

    // ---------------------------------------------------------------
    // Lines 63-66: _sanitizeObject bare string matching API_KEY_PATTERN
    // ---------------------------------------------------------------
    describe('_sanitizeObject with bare string API key pattern (lines 63-66)', () => {
        let logger;

        beforeEach(() => {
            logger = new Logger({ level: 'DEBUG', output: mockOutput });
        });

        it('should mask a bare string that matches API key pattern', () => {
            // Call _sanitizeObject directly with a string (not an object)
            const apiKeyLike = 'abcdefghijklmnopqrstuvwxyz123456.secretpart1234567890';
            const result = logger._sanitizeObject(apiKeyLike);

            expect(result).toBe('abcdefgh***');
        });

        it('should not mask a bare string that does not match API key pattern', () => {
            const normalString = 'hello world this is a normal string';
            const result = logger._sanitizeObject(normalString);

            expect(result).toBe('hello world this is a normal string');
        });

        it('should mask bare string with exact minimum pattern length', () => {
            // 20+ chars alphanumeric before dot, 10+ chars after
            const minApiKey = 'abcdefghijklmnopqrst.abcdefghij';
            const result = logger._sanitizeObject(minApiKey);

            expect(result).toBe('abcdefgh***');
        });

        it('should return non-string primitives unchanged from _sanitizeObject', () => {
            expect(logger._sanitizeObject(42)).toBe(42);
            expect(logger._sanitizeObject(true)).toBe(true);
            expect(logger._sanitizeObject(null)).toBe(null);
            expect(logger._sanitizeObject(undefined)).toBe(undefined);
        });

        it('should mask API key patterns in arrays at root level', () => {
            const arr = [
                'abcdefghijklmnopqrstuvwxyz123456.secretpart1234567890',
                'normal string',
                42
            ];
            const result = logger._sanitizeObject(arr);

            expect(result[0]).toBe('abcdefgh***');
            expect(result[1]).toBe('normal string');
            expect(result[2]).toBe(42);
        });

        it('should mask bare string API key in _sanitizeContext via log call', () => {
            // This tests that the full chain works: _sanitizeContext -> _sanitizeObject
            // with an array containing a bare API key string
            logger.info('test', {
                items: ['abcdefghijklmnopqrstuvwxyz123456.secretpart1234567890']
            });

            const logs = logger.getLogs();
            expect(logs[0].context.items[0]).toBe('abcdefgh***');
        });

        it('should handle _sanitizeObject with depth exceeding limit', () => {
            // Build object > 10 levels deep and test that it stops recursing
            let deep = { apiKey: 'deepnestedvalue123456' };
            let current = deep;
            for (let i = 0; i < 12; i++) {
                current.child = { apiKey: 'deepvalue_' + i + '_secretkey12345' };
                current = current.child;
            }
            // At depth 11+, it should return the object as-is
            const result = logger._sanitizeObject(deep);
            expect(result).toBeDefined();
            // Top-level should be masked
            expect(result.apiKey).toBe('deepnest***');
        });
    });

    // ---------------------------------------------------------------
    // Line 184: clearLogs() method
    // ---------------------------------------------------------------
    describe('clearLogs() method (line 184)', () => {
        it('should clear all log entries from the buffer', () => {
            const logger = new Logger({ level: 'DEBUG', output: mockOutput });

            logger.info('message 1');
            logger.warn('message 2');
            logger.error('message 3');

            expect(logger.getLogs().length).toBe(3);

            logger.clearLogs();

            expect(logger.getLogs().length).toBe(0);
        });

        it('should allow new logs after clearing', () => {
            const logger = new Logger({ level: 'DEBUG', output: mockOutput });

            logger.info('before clear');
            logger.clearLogs();
            logger.info('after clear');

            const logs = logger.getLogs();
            expect(logs.length).toBe(1);
            expect(logs[0].message).toBe('after clear');
        });

        it('should be safe to call clearLogs on empty buffer', () => {
            const logger = new Logger({ level: 'DEBUG', output: mockOutput });

            expect(() => logger.clearLogs()).not.toThrow();
            expect(logger.getLogs().length).toBe(0);
        });
    });

    // ---------------------------------------------------------------
    // Additional branch coverage
    // ---------------------------------------------------------------
    describe('_log warn fallback when output.warn is undefined', () => {
        it('should fall back to output.log when output.warn is not available', () => {
            const minimalOutput = {
                log: jest.fn(),
                error: jest.fn()
                // No warn method
            };

            const logger = new Logger({ level: 'WARN', output: minimalOutput });
            logger.warn('warning message');

            expect(minimalOutput.log).toHaveBeenCalled();
        });
    });

    describe('getLogs with limit', () => {
        it('should return at most limit entries', () => {
            const logger = new Logger({ level: 'DEBUG', output: mockOutput });

            for (let i = 0; i < 10; i++) {
                logger.info(`message ${i}`);
            }

            const logs = logger.getLogs(3);
            expect(logs.length).toBe(3);
            // Should return the last 3 entries
            expect(logs[0].message).toBe('message 7');
            expect(logs[2].message).toBe('message 9');
        });

        it('should return all entries when limit exceeds total', () => {
            const logger = new Logger({ level: 'DEBUG', output: mockOutput });

            logger.info('only message');

            const logs = logger.getLogs(100);
            expect(logs.length).toBe(1);
        });
    });

    describe('text format with requestId in context', () => {
        it('should include requestId in text output brackets', () => {
            const logger = new Logger({ level: 'INFO', output: mockOutput });
            logger.info('test msg', { requestId: 'req-abc-123', extra: 'val' });

            const output = mockOutput.log.mock.calls[0][0];
            expect(output).toContain('[req-abc-123]');
            expect(output).toContain('extra=');
        });
    });

    describe('json format without prefix', () => {
        it('should omit prefix field in JSON when prefix is empty', () => {
            const logger = new Logger({
                level: 'INFO',
                format: 'json',
                prefix: '',
                output: mockOutput
            });

            logger.info('test');

            const parsed = JSON.parse(mockOutput.log.mock.calls[0][0]);
            expect(parsed.prefix).toBeUndefined();
        });

        it('should include prefix field in JSON when prefix is set', () => {
            const logger = new Logger({
                level: 'INFO',
                format: 'json',
                prefix: 'MYAPP',
                output: mockOutput
            });

            logger.info('test');

            const parsed = JSON.parse(mockOutput.log.mock.calls[0][0]);
            expect(parsed.prefix).toBe('MYAPP');
        });
    });

    describe('child logger without parent prefix', () => {
        it('should use child prefix directly when parent has no prefix', () => {
            const parent = new Logger({ level: 'INFO', output: mockOutput });
            const child = parent.child('CHILD');

            expect(child.prefix).toBe('CHILD');
        });
    });

    describe('setLevel with invalid level', () => {
        it('should default to INFO when invalid level is provided', () => {
            const logger = new Logger({ level: 'DEBUG', output: mockOutput });
            expect(logger.level).toBe(LOG_LEVELS.DEBUG);

            logger.setLevel('INVALID_LEVEL');
            expect(logger.level).toBe(LOG_LEVELS.INFO);
        });

        it('should default to INFO when null is provided', () => {
            const logger = new Logger({ level: 'DEBUG', output: mockOutput });
            logger.setLevel(null);
            expect(logger.level).toBe(LOG_LEVELS.INFO);
        });
    });
});
