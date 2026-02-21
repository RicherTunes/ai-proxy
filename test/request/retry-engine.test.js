/**
 * Unit Test: Retry Engine Interface
 *
 * TDD Phase: Green - Interface created first, full extraction deferred
 *
 * Tests the RetryEngine interface wrapper. Full retry logic extraction
 * is deferred to a future "behavior" PR because it requires fake timers tests.
 */

'use strict';

const { RetryEngine } = require('../../lib/request/retry-engine');

describe('retry-engine', () => {
    describe('RetryEngine class', () => {
        it('should create a new RetryEngine instance', () => {
            const engine = new RetryEngine();
            expect(engine).toBeInstanceOf(RetryEngine);
        });

        it('should store configuration', () => {
            const config = { maxRetries: 5, baseDelayMs: 100 };
            const engine = new RetryEngine({ config });
            expect(engine.getConfig()).toEqual(config);
        });

        it('should allow updating configuration', () => {
            const engine = new RetryEngine({ config: { maxRetries: 3 } });
            engine.setConfig({ maxRetries: 5 });
            expect(engine.getConfig().maxRetries).toBe(5);
        });

        it('should throw when execute is called without executeFn', async () => {
            const engine = new RetryEngine();
            await expect(engine.execute({})).rejects.toThrow('executeFn not provided');
        });

        it('should call executeFn when execute is called', async () => {
            const mockExecuteFn = jest.fn().mockResolvedValue('success');
            const engine = new RetryEngine({ executeFn: mockExecuteFn });

            const params = { req: 'req', res: 'res', body: 'body' };
            await engine.execute(params);

            expect(mockExecuteFn).toHaveBeenCalledWith(
                params.req,
                params.res,
                params.body,
                undefined,  // requestId
                undefined,  // reqLogger
                undefined,  // startTime
                undefined   // trace
            );
        });

        it('should pass all parameters to executeFn', async () => {
            const mockExecuteFn = jest.fn().mockResolvedValue('success');
            const engine = new RetryEngine({ executeFn: mockExecuteFn });

            const params = {
                req: 'req',
                res: 'res',
                body: 'body',
                requestId: 'test-id',
                reqLogger: { info: jest.fn() },
                startTime: Date.now(),
                trace: { test: 'trace' }
            };

            await engine.execute(params);

            expect(mockExecuteFn).toHaveBeenCalledWith(
                params.req,
                params.res,
                params.body,
                params.requestId,
                params.reqLogger,
                params.startTime,
                params.trace
            );
        });

        it('should return the result from executeFn', async () => {
            const expectedResult = { success: true, data: 'test' };
            const mockExecuteFn = jest.fn().mockResolvedValue(expectedResult);
            const engine = new RetryEngine({ executeFn: mockExecuteFn });

            const result = await engine.execute({});
            expect(result).toEqual(expectedResult);
        });
    });

    describe('interface contract', () => {
        it('should have execute method', () => {
            const engine = new RetryEngine();
            expect(typeof engine.execute).toBe('function');
        });

        it('should have getConfig method', () => {
            const engine = new RetryEngine();
            expect(typeof engine.getConfig).toBe('function');
        });

        it('should have setConfig method', () => {
            const engine = new RetryEngine();
            expect(typeof engine.setConfig).toBe('function');
        });
    });
});
