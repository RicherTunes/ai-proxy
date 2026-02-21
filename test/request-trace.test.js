/**
 * Request Trace Module Tests
 */

const {
    SpanType,
    RequestSpan,
    RequestAttempt,
    RequestTrace,
    TraceStore
} = require('../lib/request-trace');

describe('RequestSpan', () => {
    describe('constructor', () => {
        test('should create span with type and start time', () => {
            const span = new RequestSpan(SpanType.QUEUED);

            expect(span.type).toBe(SpanType.QUEUED);
            expect(span.startTime).toBeDefined();
            expect(span.endTime).toBeNull();
            expect(span.duration).toBeNull();
        });

        test('should accept custom start time', () => {
            const startTime = Date.now() - 1000;
            const span = new RequestSpan(SpanType.KEY_ACQUIRED, { startTime });

            expect(span.startTime).toBe(startTime);
        });

        test('should accept key info', () => {
            const span = new RequestSpan(SpanType.KEY_ACQUIRED, {
                keyIndex: 2,
                keyId: 'key2',
                attempt: 1
            });

            expect(span.keyIndex).toBe(2);
            expect(span.keyId).toBe('key2');
            expect(span.attempt).toBe(1);
        });
    });

    describe('end', () => {
        test('should set end time and calculate duration', () => {
            const startTime = Date.now() - 100;
            const span = new RequestSpan(SpanType.UPSTREAM_START, { startTime });

            span.end();

            expect(span.endTime).toBeDefined();
            expect(span.duration).toBeGreaterThanOrEqual(100);
        });

        test('should accept custom end time', () => {
            const startTime = 1000;
            const endTime = 1500;
            const span = new RequestSpan(SpanType.STREAMING, { startTime });

            span.end(endTime);

            expect(span.endTime).toBe(1500);
            expect(span.duration).toBe(500);
        });
    });

    describe('setError', () => {
        test('should set error message', () => {
            const span = new RequestSpan(SpanType.ERROR);

            span.setError('Connection refused');

            expect(span.error).toBe('Connection refused');
            expect(span.status).toBe('error');
        });

        test('should extract message from Error object', () => {
            const span = new RequestSpan(SpanType.ERROR);

            span.setError(new Error('Timeout occurred'));

            expect(span.error).toBe('Timeout occurred');
        });
    });

    describe('isOpen', () => {
        test('should return true for open span', () => {
            const span = new RequestSpan(SpanType.QUEUED);
            expect(span.isOpen()).toBe(true);
        });

        test('should return false for closed span', () => {
            const span = new RequestSpan(SpanType.QUEUED);
            span.end();
            expect(span.isOpen()).toBe(false);
        });
    });

    describe('toJSON', () => {
        test('should serialize span to JSON', () => {
            const span = new RequestSpan(SpanType.FIRST_BYTE, {
                keyIndex: 1,
                keyId: 'key1',
                attempt: 0
            });
            span.end();

            const json = span.toJSON();

            expect(json.type).toBe(SpanType.FIRST_BYTE);
            expect(json.keyIndex).toBe(1);
            expect(json.keyId).toBe('key1');
            expect(json.duration).toBeDefined();
        });
    });
});

describe('RequestAttempt', () => {
    describe('constructor', () => {
        test('should create attempt with number', () => {
            const attempt = new RequestAttempt(0);

            expect(attempt.attempt).toBe(0);
            expect(attempt.startTime).toBeDefined();
            expect(attempt.spans).toEqual([]);
        });

        test('should accept key info', () => {
            const attempt = new RequestAttempt(1, {
                keyIndex: 2,
                keyId: 'key2',
                selectionReason: 'health_score_winner'
            });

            expect(attempt.keyIndex).toBe(2);
            expect(attempt.keyId).toBe('key2');
            expect(attempt.selectionReason).toBe('health_score_winner');
        });
    });

    describe('addSpan', () => {
        test('should add span with inherited key info', () => {
            const attempt = new RequestAttempt(0, { keyIndex: 1, keyId: 'key1' });

            const span = attempt.addSpan(SpanType.UPSTREAM_START);

            expect(attempt.spans.length).toBe(1);
            expect(span.keyIndex).toBe(1);
            expect(span.keyId).toBe('key1');
            expect(span.attempt).toBe(0);
        });
    });

    describe('getSpan', () => {
        test('should return last span of type', () => {
            const attempt = new RequestAttempt(0);
            attempt.addSpan(SpanType.UPSTREAM_START);
            attempt.addSpan(SpanType.FIRST_BYTE);
            const streamingSpan = attempt.addSpan(SpanType.STREAMING);

            expect(attempt.getSpan(SpanType.STREAMING)).toBe(streamingSpan);
        });

        test('should return undefined for missing type', () => {
            const attempt = new RequestAttempt(0);
            expect(attempt.getSpan(SpanType.ERROR)).toBeUndefined();
        });
    });

    describe('end', () => {
        test('should set end time and outcome', () => {
            const attempt = new RequestAttempt(0);
            attempt.addSpan(SpanType.UPSTREAM_START);

            attempt.end(true, 200);

            expect(attempt.endTime).toBeDefined();
            expect(attempt.success).toBe(true);
            expect(attempt.status).toBe(200);
        });

        test('should close open spans', () => {
            const attempt = new RequestAttempt(0);
            const span = attempt.addSpan(SpanType.STREAMING);

            expect(span.isOpen()).toBe(true);

            attempt.end(true);

            expect(span.isOpen()).toBe(false);
        });
    });

    describe('getPhaseTiming', () => {
        test('should calculate time per phase', () => {
            const attempt = new RequestAttempt(0);

            const span1 = attempt.addSpan(SpanType.KEY_ACQUIRED, { startTime: 0 });
            span1.end(50);

            const span2 = attempt.addSpan(SpanType.UPSTREAM_START, { startTime: 50 });
            span2.end(150);

            const timing = attempt.getPhaseTiming();

            expect(timing[SpanType.KEY_ACQUIRED]).toBe(50);
            expect(timing[SpanType.UPSTREAM_START]).toBe(100);
        });
    });
});

describe('RequestTrace', () => {
    describe('constructor', () => {
        test('should generate trace ID', () => {
            const trace = new RequestTrace();

            expect(trace.traceId).toMatch(/^trace_/);
            expect(trace.requestId).toBe(trace.traceId);
        });

        test('should accept custom trace ID', () => {
            const trace = new RequestTrace({ traceId: 'custom_123' });

            expect(trace.traceId).toBe('custom_123');
        });

        test('should accept request info', () => {
            const trace = new RequestTrace({
                method: 'POST',
                path: '/v1/messages',
                model: 'claude-3-opus'
            });

            expect(trace.method).toBe('POST');
            expect(trace.path).toBe('/v1/messages');
            expect(trace.model).toBe('claude-3-opus');
        });
    });

    describe('queue tracking', () => {
        test('should track queue time', () => {
            jest.useFakeTimers();
            try {
                const trace = new RequestTrace();

                trace.markQueued();
                jest.advanceTimersByTime(50);
                trace.markDequeued();

                expect(trace.queueDuration).toBe(50);
            } finally {
                jest.useRealTimers();
            }
        });
    });

    describe('attempt management', () => {
        test('should start attempt with key info', () => {
            const trace = new RequestTrace();

            const attempt = trace.startAttempt({
                index: 1,
                keyId: 'key1',
                selectionReason: 'round_robin'
            });

            expect(trace.attempts.length).toBe(1);
            expect(attempt.keyIndex).toBe(1);
            expect(attempt.selectionReason).toBe('round_robin');
        });

        test('should track multiple attempts', () => {
            const trace = new RequestTrace();

            trace.startAttempt({ index: 0 });
            trace.endAttempt(false, 429);
            trace.markRetry('rate_limited');

            trace.startAttempt({ index: 1 });
            trace.endAttempt(true, 200);

            expect(trace.attempts.length).toBe(2);
            expect(trace.attempts[0].success).toBe(false);
            expect(trace.attempts[0].retryReason).toBe('rate_limited');
            expect(trace.attempts[1].success).toBe(true);
        });
    });

    describe('addSpan', () => {
        test('should add span to current attempt', () => {
            const trace = new RequestTrace();
            trace.startAttempt({ index: 0 });

            trace.addSpan(SpanType.UPSTREAM_START);
            trace.addSpan(SpanType.FIRST_BYTE);

            expect(trace.currentAttempt.spans.length).toBe(2);
        });

        test('should auto-create attempt if none exists', () => {
            const trace = new RequestTrace();

            trace.addSpan(SpanType.QUEUED);

            expect(trace.attempts.length).toBe(1);
        });
    });

    describe('complete', () => {
        test('should finalize trace', () => {
            const trace = new RequestTrace();
            trace.startAttempt({ index: 0 });
            trace.addSpan(SpanType.COMPLETE);

            trace.complete(true, 200);

            expect(trace.endTime).toBeDefined();
            expect(trace.totalDuration).toBeDefined();
            expect(trace.success).toBe(true);
            expect(trace.finalStatus).toBe(200);
        });
    });

    describe('getAttemptCount', () => {
        test('should return number of attempts', () => {
            const trace = new RequestTrace();

            expect(trace.getAttemptCount()).toBe(0);

            trace.startAttempt({ index: 0 });
            expect(trace.getAttemptCount()).toBe(1);

            trace.startAttempt({ index: 1 });
            expect(trace.getAttemptCount()).toBe(2);
        });
    });

    describe('getRetryTime', () => {
        test('should calculate time spent in retries', () => {
            const trace = new RequestTrace();

            // First attempt
            const attempt1 = trace.startAttempt({ index: 0 });
            attempt1.end(false, 429);

            // Retry attempt
            const attempt2 = trace.startAttempt({ index: 1 });
            attempt2.end(true, 200);

            const retryTime = trace.getRetryTime();

            expect(retryTime).toBeGreaterThanOrEqual(0);
        });

        test('should return 0 for single attempt', () => {
            const trace = new RequestTrace();
            trace.startAttempt({ index: 0 });
            trace.endAttempt(true);

            expect(trace.getRetryTime()).toBe(0);
        });
    });

    describe('getPhaseSummary', () => {
        test('should aggregate timing across attempts', () => {
            const trace = new RequestTrace();
            trace.markQueued();
            trace.markDequeued();

            const attempt = trace.startAttempt({ index: 0 });
            const span = attempt.addSpan(SpanType.UPSTREAM_START, { startTime: 0 });
            span.end(100);

            trace.complete(true);

            const summary = trace.getPhaseSummary();

            expect(summary.attempts).toBe(1);
            expect(summary.phases[SpanType.UPSTREAM_START]).toBe(100);
        });
    });

    describe('toJSON', () => {
        test('should serialize complete trace', () => {
            const trace = new RequestTrace({
                model: 'claude-3',
                path: '/v1/messages'
            });
            trace.startAttempt({ index: 0, keyId: 'key0' });
            trace.addSpan(SpanType.UPSTREAM_START);
            trace.complete(true, 200);

            const json = trace.toJSON();

            expect(json.traceId).toBeDefined();
            expect(json.model).toBe('claude-3');
            expect(json.attempts.length).toBe(1);
            expect(json.success).toBe(true);
            expect(json.phaseSummary).toBeDefined();
        });

        test('should include provider/cost placeholders for forward compatibility', () => {
            const trace = new RequestTrace({
                model: 'claude-3'
            });
            trace.complete(true, 200);

            const json = trace.toJSON();

            expect(json).toHaveProperty('provider', null);
            expect(json).toHaveProperty('mappedProvider', null);
            expect(json).toHaveProperty('estimatedCostUsd', null);
        });
    });

    describe('getSummary', () => {
        test('should include provider placeholders in compact summary', () => {
            const trace = new RequestTrace({
                model: 'claude-3'
            });
            trace.complete(true, 200);

            const summary = trace.getSummary();

            expect(summary).toHaveProperty('provider', null);
            expect(summary).toHaveProperty('mappedProvider', null);
        });
    });
});

describe('TraceStore', () => {
    let store;

    beforeEach(() => {
        store = new TraceStore({ maxTraces: 100 });
    });

    describe('store', () => {
        test('should store and retrieve trace', () => {
            const trace = new RequestTrace();
            trace.complete(true);

            store.store(trace);

            expect(store.get(trace.traceId)).toBe(trace);
        });

        test('should evict oldest when at capacity', () => {
            const smallStore = new TraceStore({ maxTraces: 3 });

            const trace1 = new RequestTrace({ traceId: 'trace1' });
            const trace2 = new RequestTrace({ traceId: 'trace2' });
            const trace3 = new RequestTrace({ traceId: 'trace3' });
            const trace4 = new RequestTrace({ traceId: 'trace4' });

            smallStore.store(trace1);
            smallStore.store(trace2);
            smallStore.store(trace3);
            smallStore.store(trace4);

            expect(smallStore.get('trace1')).toBeUndefined();
            expect(smallStore.get('trace4')).toBe(trace4);
        });
    });

    describe('getByRequestId', () => {
        test('should find trace by request ID', () => {
            const trace = new RequestTrace({ requestId: 'req-123' });
            store.store(trace);

            expect(store.getByRequestId('req-123')).toBe(trace);
        });
    });

    describe('getRecent', () => {
        test('should return recent traces in reverse order', () => {
            const trace1 = new RequestTrace({ traceId: 'trace1' });
            const trace2 = new RequestTrace({ traceId: 'trace2' });
            const trace3 = new RequestTrace({ traceId: 'trace3' });

            store.store(trace1);
            store.store(trace2);
            store.store(trace3);

            const recent = store.getRecent(2);

            expect(recent.length).toBe(2);
            expect(recent[0].traceId).toBe('trace3');
            expect(recent[1].traceId).toBe('trace2');
        });
    });

    describe('query', () => {
        test('should filter by success', () => {
            const successTrace = new RequestTrace({ traceId: 'success' });
            successTrace.complete(true);

            const failTrace = new RequestTrace({ traceId: 'fail' });
            failTrace.complete(false);

            store.store(successTrace);
            store.store(failTrace);

            const successes = store.query({ success: true });

            expect(successes.length).toBe(1);
            expect(successes[0].traceId).toBe('success');
        });

        test('should filter by model', () => {
            const opusTrace = new RequestTrace({ traceId: 'opus', model: 'opus' });
            const sonnetTrace = new RequestTrace({ traceId: 'sonnet', model: 'sonnet' });

            store.store(opusTrace);
            store.store(sonnetTrace);

            const opusOnly = store.query({ model: 'opus' });

            expect(opusOnly.length).toBe(1);
            expect(opusOnly[0].traceId).toBe('opus');
        });

        test('should filter by hasRetries', () => {
            const noRetry = new RequestTrace({ traceId: 'noretry' });
            noRetry.startAttempt({ index: 0 });
            noRetry.complete(true);

            const withRetry = new RequestTrace({ traceId: 'retry' });
            withRetry.startAttempt({ index: 0 });
            withRetry.startAttempt({ index: 1 });
            withRetry.complete(true);

            store.store(noRetry);
            store.store(withRetry);

            const retriedOnly = store.query({ hasRetries: true });

            expect(retriedOnly.length).toBe(1);
            expect(retriedOnly[0].traceId).toBe('retry');
        });

        test('should limit results', () => {
            for (let i = 0; i < 10; i++) {
                const trace = new RequestTrace({ traceId: `trace${i}` });
                store.store(trace);
            }

            const limited = store.query({ limit: 5 });

            expect(limited.length).toBe(5);
        });
    });

    describe('getStats', () => {
        test('should calculate store statistics', () => {
            const success1 = new RequestTrace();
            success1.complete(true);

            const success2 = new RequestTrace();
            success2.complete(true);

            const failure = new RequestTrace();
            failure.complete(false);

            const withRetry = new RequestTrace();
            withRetry.startAttempt({ index: 0 });
            withRetry.startAttempt({ index: 1 });
            withRetry.complete(true);

            store.store(success1);
            store.store(success2);
            store.store(failure);
            store.store(withRetry);

            const stats = store.getStats();

            expect(stats.totalTraces).toBe(4);
            expect(stats.successCount).toBe(3); // success1 + success2 + withRetry
            expect(stats.failureCount).toBe(1);
            expect(stats.retryCount).toBe(1);
        });
    });

    describe('clear', () => {
        test('should remove all traces', () => {
            store.store(new RequestTrace());
            store.store(new RequestTrace());

            store.clear();

            expect(store.getStats().totalTraces).toBe(0);
        });
    });
});

describe('SpanType', () => {
    test('should have all expected types', () => {
        expect(SpanType.QUEUED).toBe('queued');
        expect(SpanType.KEY_ACQUIRED).toBe('key_acquired');
        expect(SpanType.UPSTREAM_START).toBe('upstream_start');
        expect(SpanType.FIRST_BYTE).toBe('first_byte');
        expect(SpanType.STREAMING).toBe('streaming');
        expect(SpanType.COMPLETE).toBe('complete');
        expect(SpanType.ERROR).toBe('error');
        expect(SpanType.RETRY).toBe('retry');
        expect(SpanType.TIMEOUT).toBe('timeout');
    });
});
