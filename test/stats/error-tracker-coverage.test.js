/**
 * Error Tracker Coverage Tests
 *
 * Surgical tests to hit uncovered branches in lib/stats/error-tracker.js
 * Target: lines 61, 115
 */

'use strict';

const { ErrorTracker } = require('../../lib/stats/error-tracker');

describe('ErrorTracker - Coverage Gaps', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('_log method', () => {
        // Covers line 61: logger[level] is called when logger exists and has the method
        it('should call logger method when logger is configured with the level function', () => {
            const mockLogger = {
                debug: jest.fn(),
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn()
            };
            const tracker = new ErrorTracker({ logger: mockLogger });

            // Call _log via resetErrors which uses _log internally
            tracker.resetErrors();

            expect(mockLogger.info).toHaveBeenCalledWith('Error stats reset', {});
        });

        // Covers line 61: different log levels
        it('should call logger with different levels', () => {
            const mockLogger = {
                debug: jest.fn(),
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn()
            };
            const tracker = new ErrorTracker({ logger: mockLogger });

            // Trigger debug log via unrecognized error with details (line 115 also covered)
            tracker.recordError('unknown_type', { code: 500, message: 'test error' });

            expect(mockLogger.debug).toHaveBeenCalledWith(
                'Unrecognized error type: unknown_type',
                { code: 500, message: 'test error' }
            );
        });
    });

    describe('recordError with unrecognized types and details', () => {
        // Covers line 115: _log is called for unrecognized error type when errorDetails is truthy
        it('should log unrecognized error type when errorDetails is provided', () => {
            const mockLogger = {
                debug: jest.fn(),
                info: jest.fn()
            };
            const tracker = new ErrorTracker({ logger: mockLogger });

            tracker.recordError('strange_new_error', { code: 'EUNKNOWN', retryable: false });

            const stats = tracker.getErrorStats();
            expect(stats.other).toBe(1);
            expect(mockLogger.debug).toHaveBeenCalledWith(
                'Unrecognized error type: strange_new_error',
                { code: 'EUNKNOWN', retryable: false }
            );
        });

        // Covers line 115: with object errorDetails
        it('should log with object errorDetails containing multiple properties', () => {
            const mockLogger = {
                debug: jest.fn()
            };
            const tracker = new ErrorTracker({ logger: mockLogger });

            const details = {
                statusCode: 418,
                message: 'I am a teapot',
                stack: 'Error: teapot',
                timestamp: Date.now()
            };
            tracker.recordError('custom_error', details);

            expect(mockLogger.debug).toHaveBeenCalledWith(
                'Unrecognized error type: custom_error',
                details
            );
        });

        // Covers line 115: with string errorDetails
        it('should log with string errorDetails', () => {
            const mockLogger = {
                debug: jest.fn()
            };
            const tracker = new ErrorTracker({ logger: mockLogger });

            tracker.recordError('random_error', 'something went wrong');

            expect(mockLogger.debug).toHaveBeenCalledWith(
                'Unrecognized error type: random_error',
                'something went wrong'
            );
        });

        // Covers line 115: with array errorDetails
        it('should log with array errorDetails', () => {
            const mockLogger = {
                debug: jest.fn()
            };
            const tracker = new ErrorTracker({ logger: mockLogger });

            const details = ['error1', 'error2', 'error3'];
            tracker.recordError('multiple_errors', details);

            expect(mockLogger.debug).toHaveBeenCalledWith(
                'Unrecognized error type: multiple_errors',
                details
            );
        });

        // Covers line 115: does NOT log when errorDetails is falsy
        it('should not log unrecognized error type when errorDetails is null', () => {
            const mockLogger = {
                debug: jest.fn()
            };
            const tracker = new ErrorTracker({ logger: mockLogger });

            tracker.recordError('unknown_no_details', null);

            expect(mockLogger.debug).not.toHaveBeenCalled();
        });

        // Covers line 115: does NOT log when errorDetails is undefined
        it('should not log unrecognized error type when errorDetails is undefined', () => {
            const mockLogger = {
                debug: jest.fn()
            };
            const tracker = new ErrorTracker({ logger: mockLogger });

            tracker.recordError('unknown_no_details');

            expect(mockLogger.debug).not.toHaveBeenCalled();
        });

        // Covers line 115: does NOT log when errorDetails is empty string
        it('should not log unrecognized error type when errorDetails is empty string', () => {
            const mockLogger = {
                debug: jest.fn()
            };
            const tracker = new ErrorTracker({ logger: mockLogger });

            tracker.recordError('unknown_empty', '');

            expect(mockLogger.debug).not.toHaveBeenCalled();
        });
    });

    describe('logger with non-function level', () => {
        // Covers the branch where logger exists but logger[level] is not a function (line 61 NOT executed)
        it('should not crash when logger level is not a function', () => {
            const badLogger = {
                debug: 'not a function',
                info: 42
            };
            const tracker = new ErrorTracker({ logger: badLogger });

            expect(() => tracker.resetErrors()).not.toThrow();
            expect(() => tracker.recordError('unknown', { details: true })).not.toThrow();
        });
    });
});
