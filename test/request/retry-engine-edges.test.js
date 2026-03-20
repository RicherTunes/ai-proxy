/**
 * Edge-case tests for retry engine: backoff timing, retryable classification,
 * key rotation, jitter bounds, and full retry-loop simulation.
 *
 * Tests the exported calculateBackoff / ERROR_STRATEGIES from request-handler.js
 * alongside the RetryEngine interface from retry-engine.js.
 */

'use strict';

const { RetryEngine } = require('../../lib/request/retry-engine');
const {
    calculateBackoff,
    RETRY_CONFIG,
    ERROR_STRATEGIES
} = require('../../lib/request-handler');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal RetryEngine whose executeFn runs an iterative retry loop
 * identical in structure to RequestHandler._proxyWithRetries, but with
 * pluggable per-attempt behaviour.
 *
 * @param {Object} opts
 * @param {number}   opts.maxRetries        - overall retry cap
 * @param {Object}   opts.retryConfig       - calculateBackoff config
 * @param {Function} opts.attemptFn         - (attempt, keyIndex) => result
 *        result: { success: true, data } | { success: false, error, errorType, shouldExcludeKey? }
 * @param {string[]} opts.keys              - pool of API keys
 * @returns {RetryEngine}
 */
function buildRetryLoop(opts) {
    const {
        maxRetries = 3,
        retryConfig = { ...RETRY_CONFIG },
        attemptFn,
        keys = ['key-A', 'key-B', 'key-C']
    } = opts;

    const meta = {
        attempts: [],       // { attempt, key, delayMs }
        finalError: null,
        finalResult: null
    };

    async function executeFn() {
        const excludeKeys = [];
        let lastError = null;
        let lastErrorType = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            // Backoff after first attempt
            let delayMs = 0;
            if (attempt > 0) {
                const strategy = lastErrorType
                    ? (ERROR_STRATEGIES[lastErrorType] || ERROR_STRATEGIES.other)
                    : null;
                const multiplier = strategy?.backoffMultiplier || 1.0;
                const base = calculateBackoff(attempt - 1, retryConfig);
                delayMs = Math.round(base * multiplier);
                if (delayMs > 0) {
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            }

            // Pick next available key (round-robin, skip excluded)
            let keyIdx = attempt % keys.length;
            while (excludeKeys.includes(keyIdx) && excludeKeys.length < keys.length) {
                keyIdx = (keyIdx + 1) % keys.length;
            }

            meta.attempts.push({ attempt, key: keys[keyIdx], delayMs });

            const result = attemptFn(attempt, keyIdx);

            if (result.success) {
                meta.finalResult = result.data;
                return meta;
            }

            // Failure path
            lastError = result.error;
            lastErrorType = result.errorType || 'other';

            const strategy = ERROR_STRATEGIES[lastErrorType] || ERROR_STRATEGIES.other;

            // Non-retryable -> break immediately
            if (!strategy.shouldRetry) {
                break;
            }

            // Key exclusion
            if (result.shouldExcludeKey) {
                excludeKeys.push(keyIdx);
            }

            // If at max retries, loop exits naturally
        }

        meta.finalError = lastError;
        return meta;
    }

    const engine = new RetryEngine({
        executeFn,
        config: { maxRetries, ...retryConfig }
    });

    // Attach meta so tests can inspect it
    engine._meta = meta;
    engine._runLoop = () => engine.execute({});
    return engine;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('retry-engine-edges', () => {
    // ---- Timing tests use fake timers ----
    beforeEach(() => {
        jest.useFakeTimers();
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    // 1. Exponential backoff timing
    describe('1 - exponential backoff timing', () => {
        it('delay doubles between consecutive retries (default config)', () => {
            const cfg = { ...RETRY_CONFIG, jitterPercent: 0 };

            const d0 = calculateBackoff(0, cfg); // baseDelayMs * 2^0 = 100
            const d1 = calculateBackoff(1, cfg); // baseDelayMs * 2^1 = 200
            const d2 = calculateBackoff(2, cfg); // baseDelayMs * 2^2 = 400

            expect(d1).toBe(d0 * cfg.backoffMultiplier);
            expect(d2).toBe(d1 * cfg.backoffMultiplier);
        });

        it('delay is capped at maxDelayMs', () => {
            const cfg = { baseDelayMs: 100, backoffMultiplier: 2, maxDelayMs: 500, jitterPercent: 0 };

            // attempt 10 -> 100 * 2^10 = 102400 -> capped to 500
            const d = calculateBackoff(10, cfg);
            expect(d).toBe(500);
        });
    });

    // 2. Max retries respected
    describe('2 - max retries respected', () => {
        it('stops after maxRetries+1 total attempts and returns last error', async () => {
            const maxRetries = 2;
            const engine = buildRetryLoop({
                maxRetries,
                retryConfig: { baseDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, jitterPercent: 0 },
                attemptFn: (attempt) => ({
                    success: false,
                    error: new Error(`fail-${attempt}`),
                    errorType: 'server_error'
                })
            });

            const runPromise = engine._runLoop();
            // Flush all timers (micro-delays of 1ms each)
            for (let i = 0; i < maxRetries + 2; i++) {
                await Promise.resolve(); // drain microtasks
                jest.advanceTimersByTime(10);
            }
            const meta = await runPromise;

            expect(meta.attempts).toHaveLength(maxRetries + 1); // 0..maxRetries
            expect(meta.finalError.message).toBe(`fail-${maxRetries}`);
        });
    });

    // 3. Per-attempt key rotation
    describe('3 - per-attempt key rotation', () => {
        it('each retry attempt can use a different key', async () => {
            const keys = ['alpha', 'beta', 'gamma'];
            const engine = buildRetryLoop({
                maxRetries: 2,
                keys,
                retryConfig: { baseDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, jitterPercent: 0 },
                attemptFn: (attempt) => ({
                    success: false,
                    error: new Error('fail'),
                    errorType: 'server_error',
                    shouldExcludeKey: true
                })
            });

            const runPromise = engine._runLoop();
            for (let i = 0; i < 5; i++) {
                await Promise.resolve();
                jest.advanceTimersByTime(10);
            }
            const meta = await runPromise;

            // Keys should differ across attempts (excluded keys are skipped)
            const usedKeys = meta.attempts.map(a => a.key);
            expect(usedKeys[0]).toBe('alpha');
            expect(usedKeys[1]).toBe('beta');
            expect(usedKeys[2]).toBe('gamma');
        });
    });

    // 4. Successful retry after failures
    describe('4 - successful retry after failures', () => {
        it('first 2 attempts fail, 3rd succeeds', async () => {
            const engine = buildRetryLoop({
                maxRetries: 3,
                retryConfig: { baseDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, jitterPercent: 0 },
                attemptFn: (attempt) => {
                    if (attempt < 2) {
                        return { success: false, error: new Error('transient'), errorType: 'server_error' };
                    }
                    return { success: true, data: 'ok' };
                }
            });

            const runPromise = engine._runLoop();
            for (let i = 0; i < 5; i++) {
                await Promise.resolve();
                jest.advanceTimersByTime(10);
            }
            const meta = await runPromise;

            expect(meta.attempts).toHaveLength(3); // attempt 0, 1, 2
            expect(meta.finalResult).toBe('ok');
            expect(meta.finalError).toBeNull();
        });
    });

    // 5. Non-retryable error (400 client error → tls_error or context_overflow)
    describe('5 - non-retryable error stops retries immediately', () => {
        it('400-class error (tls_error) breaks out after single attempt', async () => {
            const engine = buildRetryLoop({
                maxRetries: 5,
                retryConfig: { baseDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, jitterPercent: 0 },
                attemptFn: () => ({
                    success: false,
                    error: new Error('tls handshake failed'),
                    errorType: 'tls_error'
                })
            });

            const runPromise = engine._runLoop();
            for (let i = 0; i < 3; i++) {
                await Promise.resolve();
                jest.advanceTimersByTime(10);
            }
            const meta = await runPromise;

            // Should have only 1 attempt because tls_error.shouldRetry === false
            expect(meta.attempts).toHaveLength(1);
            expect(meta.finalError.message).toBe('tls handshake failed');
        });

        it('context_overflow is not retryable', () => {
            expect(ERROR_STRATEGIES.context_overflow.shouldRetry).toBe(false);
            expect(ERROR_STRATEGIES.context_overflow.maxRetries).toBe(0);
        });

        it('rate_limited (static) is not retryable', () => {
            expect(ERROR_STRATEGIES.rate_limited.shouldRetry).toBe(false);
            expect(ERROR_STRATEGIES.rate_limited.maxRetries).toBe(0);
        });

        it('aborted is not retryable', () => {
            expect(ERROR_STRATEGIES.aborted.shouldRetry).toBe(false);
            expect(ERROR_STRATEGIES.aborted.maxRetries).toBe(0);
        });
    });

    // 6. Retryable errors (429/500/503 mapped types)
    describe('6 - retryable error triggers retry', () => {
        it('server_error (500) is retryable', () => {
            expect(ERROR_STRATEGIES.server_error.shouldRetry).toBe(true);
            expect(ERROR_STRATEGIES.server_error.maxRetries).toBeGreaterThan(0);
        });

        it('model_at_capacity (503 mapped) is retryable', () => {
            expect(ERROR_STRATEGIES.model_at_capacity.shouldRetry).toBe(true);
            expect(ERROR_STRATEGIES.model_at_capacity.maxRetries).toBeGreaterThan(0);
        });

        it('timeout is retryable', () => {
            expect(ERROR_STRATEGIES.timeout.shouldRetry).toBe(true);
        });

        it('socket_hangup is retryable', () => {
            expect(ERROR_STRATEGIES.socket_hangup.shouldRetry).toBe(true);
        });

        it('retryable error type leads to multiple attempts', async () => {
            let callCount = 0;
            const engine = buildRetryLoop({
                maxRetries: 3,
                retryConfig: { baseDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, jitterPercent: 0 },
                attemptFn: () => {
                    callCount++;
                    return { success: false, error: new Error('500'), errorType: 'server_error' };
                }
            });

            const runPromise = engine._runLoop();
            for (let i = 0; i < 8; i++) {
                await Promise.resolve();
                jest.advanceTimersByTime(10);
            }
            await runPromise;

            // server_error.maxRetries = 3, global maxRetries = 3
            // expect more than 1 attempt
            expect(callCount).toBeGreaterThan(1);
        });
    });

    // 7. Jitter bounds
    describe('7 - jitter bounds', () => {
        it('actual delay is within expected jitter range', () => {
            const cfg = { baseDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 100000, jitterPercent: 0.2 };
            const attempt = 2;
            const base = cfg.baseDelayMs * Math.pow(cfg.backoffMultiplier, attempt); // 4000

            // With jitter ±20%, range is [4000 - 800, 4000 + 800] = [3200, 4800]
            const samples = [];
            // Math.random is deterministic when seeded; run many iterations
            for (let i = 0; i < 200; i++) {
                samples.push(calculateBackoff(attempt, cfg));
            }

            const min = Math.min(...samples);
            const max = Math.max(...samples);

            // Every sample must be within [base * (1 - jitter), base * (1 + jitter)]
            const lo = base * (1 - cfg.jitterPercent);
            const hi = base * (1 + cfg.jitterPercent);

            expect(min).toBeGreaterThanOrEqual(lo - 1); // rounding tolerance
            expect(max).toBeLessThanOrEqual(hi + 1);

            // Distribution should NOT be constant (jitter is actually applied)
            expect(max - min).toBeGreaterThan(0);
        });

        it('zero jitterPercent produces deterministic delay', () => {
            const cfg = { baseDelayMs: 100, backoffMultiplier: 2, maxDelayMs: 100000, jitterPercent: 0 };

            const d1 = calculateBackoff(3, cfg);
            const d2 = calculateBackoff(3, cfg);
            expect(d1).toBe(d2);
            expect(d1).toBe(100 * Math.pow(2, 3)); // 800
        });
    });

    // 8. Zero max retries
    describe('8 - zero max retries', () => {
        it('exactly one attempt, no retries', async () => {
            const engine = buildRetryLoop({
                maxRetries: 0,
                retryConfig: { baseDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, jitterPercent: 0 },
                attemptFn: () => ({
                    success: false,
                    error: new Error('single-shot'),
                    errorType: 'server_error'
                })
            });

            const runPromise = engine._runLoop();
            await Promise.resolve();
            jest.advanceTimersByTime(10);
            const meta = await runPromise;

            expect(meta.attempts).toHaveLength(1);
            expect(meta.finalError.message).toBe('single-shot');
        });

        it('zero max retries still succeeds on first attempt', async () => {
            const engine = buildRetryLoop({
                maxRetries: 0,
                retryConfig: { baseDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, jitterPercent: 0 },
                attemptFn: () => ({ success: true, data: 'first-try' })
            });

            const meta = await engine._runLoop();
            expect(meta.attempts).toHaveLength(1);
            expect(meta.finalResult).toBe('first-try');
        });
    });

    // 9. Timeout on individual attempt
    describe('9 - timeout on individual attempt', () => {
        it('single attempt times out then next attempt starts', async () => {
            const engine = buildRetryLoop({
                maxRetries: 2,
                retryConfig: { baseDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, jitterPercent: 0 },
                attemptFn: (attempt) => {
                    if (attempt === 0) {
                        return { success: false, error: new Error('timeout'), errorType: 'timeout' };
                    }
                    return { success: true, data: 'recovered' };
                }
            });

            const runPromise = engine._runLoop();
            for (let i = 0; i < 5; i++) {
                await Promise.resolve();
                jest.advanceTimersByTime(10);
            }
            const meta = await runPromise;

            expect(meta.attempts).toHaveLength(2);
            expect(meta.attempts[0].key).toBeDefined();
            expect(meta.finalResult).toBe('recovered');
        });

        it('timeout error type triggers key exclusion', () => {
            expect(ERROR_STRATEGIES.timeout.excludeKey).toBe(true);
        });
    });

    // 10. All attempts fail
    describe('10 - all attempts fail', () => {
        it('returns the final error with correct attempt count', async () => {
            const maxRetries = 4;
            const errors = [];
            const engine = buildRetryLoop({
                maxRetries,
                retryConfig: { baseDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, jitterPercent: 0 },
                attemptFn: (attempt) => {
                    const err = new Error(`attempt-${attempt}`);
                    errors.push(err);
                    return { success: false, error: err, errorType: 'server_error' };
                }
            });

            const runPromise = engine._runLoop();
            for (let i = 0; i < maxRetries + 5; i++) {
                await Promise.resolve();
                jest.advanceTimersByTime(10);
            }
            const meta = await runPromise;

            expect(meta.attempts).toHaveLength(maxRetries + 1);
            expect(meta.finalError).toBe(errors[errors.length - 1]);
            expect(meta.finalError.message).toBe(`attempt-${maxRetries}`);
            expect(meta.finalResult).toBeNull();
        });

        it('attempt metadata records each attempt index', async () => {
            const maxRetries = 3;
            const engine = buildRetryLoop({
                maxRetries,
                retryConfig: { baseDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, jitterPercent: 0 },
                attemptFn: (attempt) => ({
                    success: false,
                    error: new Error('fail'),
                    errorType: 'connection_refused'
                })
            });

            const runPromise = engine._runLoop();
            for (let i = 0; i < maxRetries + 5; i++) {
                await Promise.resolve();
                jest.advanceTimersByTime(10);
            }
            const meta = await runPromise;

            const indices = meta.attempts.map(a => a.attempt);
            expect(indices).toEqual([0, 1, 2, 3]);
        });
    });

    // Bonus: DEFAULT_RETRY_CONFIG sanity
    describe('DEFAULT_RETRY_CONFIG sanity', () => {
        it('has expected shape', () => {
            expect(RETRY_CONFIG).toEqual(expect.objectContaining({
                baseDelayMs: expect.any(Number),
                maxDelayMs: expect.any(Number),
                backoffMultiplier: expect.any(Number),
                jitterPercent: expect.any(Number)
            }));
        });

        it('backoffMultiplier is 2', () => {
            expect(RETRY_CONFIG.backoffMultiplier).toBe(2);
        });

        it('jitterPercent is 0.2', () => {
            expect(RETRY_CONFIG.jitterPercent).toBe(0.2);
        });
    });

    // Bonus: ERROR_STRATEGIES coverage
    describe('ERROR_STRATEGIES completeness', () => {
        const expectedTypes = [
            'socket_hangup', 'timeout', 'server_error', 'rate_limited',
            'model_at_capacity', 'context_overflow', 'context_overflow_transient',
            'connection_refused', 'dns_error', 'tls_error', 'auth_error',
            'broken_pipe', 'connection_aborted', 'stream_premature_close',
            'http_parse_error', 'other', 'aborted'
        ];

        it.each(expectedTypes)('strategy "%s" has shouldRetry, backoffMultiplier, maxRetries', (type) => {
            const s = ERROR_STRATEGIES[type];
            expect(s).toBeDefined();
            expect(typeof s.shouldRetry).toBe('boolean');
            expect(typeof s.backoffMultiplier).toBe('number');
            expect(typeof s.maxRetries).toBe('number');
        });
    });
});
