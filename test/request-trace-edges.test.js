/**
 * Request Trace Edge-Case Tests
 *
 * Covers 10 edge-case categories for lib/request-trace.js:
 *  1. Trace creation        – unique IDs, timestamps, initial fields
 *  2. Attempt tracking      – ordered attempts with correct metadata
 *  3. Sampling rate         – selective storage simulates 50% sampling
 *  4. Payload size limit    – large metadata truncated / handled
 *  5. Trace serialization   – JSON round-trip without data loss
 *  6. Error recording       – stack traces and error types
 *  7. Timing                – duration calculated correctly
 *  8. Trace lookup          – get by ID, list recent traces
 *  9. Cleanup               – old traces evicted after max retention
 * 10. Disabled tracing      – operations are no-ops (no crash)
 */

'use strict';

const {
    SpanType,
    RequestSpan,
    RequestAttempt,
    RequestTrace,
    TraceStore
} = require('../lib/request-trace');

// ---------------------------------------------------------------------------
// 1. Trace creation
// ---------------------------------------------------------------------------
describe('Trace creation', () => {
    test('new trace has a unique ID starting with "trace_"', () => {
        const t1 = new RequestTrace();
        const t2 = new RequestTrace();

        expect(t1.traceId).toMatch(/^trace_/);
        expect(t2.traceId).toMatch(/^trace_/);
        expect(t1.traceId).not.toBe(t2.traceId);
    });

    test('startTime defaults to approximately now', () => {
        const before = Date.now();
        const trace = new RequestTrace();
        const after = Date.now();

        expect(trace.startTime).toBeGreaterThanOrEqual(before);
        expect(trace.startTime).toBeLessThanOrEqual(after);
    });

    test('initial fields are null / empty before any work', () => {
        const trace = new RequestTrace();

        expect(trace.endTime).toBeNull();
        expect(trace.totalDuration).toBeNull();
        expect(trace.success).toBeNull();
        expect(trace.finalStatus).toBeNull();
        expect(trace.finalError).toBeNull();
        expect(trace.attempts).toEqual([]);
        expect(trace.currentAttempt).toBeNull();
        expect(trace.queuedAt).toBeNull();
        expect(trace.queueDuration).toBeNull();
    });

    test('requestId defaults to traceId when not provided', () => {
        const trace = new RequestTrace();
        expect(trace.requestId).toBe(trace.traceId);
    });

    test('custom requestId is independent of traceId', () => {
        const trace = new RequestTrace({ requestId: 'req-custom-42' });
        expect(trace.requestId).toBe('req-custom-42');
        expect(trace.traceId).not.toBe('req-custom-42');
    });

    test('default method and path are populated', () => {
        const trace = new RequestTrace();
        expect(trace.method).toBe('POST');
        expect(trace.path).toBe('/v1/messages');
    });
});

// ---------------------------------------------------------------------------
// 2. Attempt tracking
// ---------------------------------------------------------------------------
describe('Attempt tracking', () => {
    test('attempts are appended in order with correct attempt numbers', () => {
        const trace = new RequestTrace();

        const a0 = trace.startAttempt({ index: 0, keyId: 'k0', selectionReason: 'round_robin' });
        trace.endAttempt(false, 429, 'rate limited');

        const a1 = trace.startAttempt({ index: 1, keyId: 'k1', selectionReason: 'health_score' });
        trace.endAttempt(true, 200);

        expect(trace.attempts.length).toBe(2);
        expect(trace.attempts[0]).toBe(a0);
        expect(trace.attempts[1]).toBe(a1);

        // Attempt numbers are sequential starting at 0
        expect(a0.attempt).toBe(0);
        expect(a1.attempt).toBe(1);
    });

    test('each attempt carries its own key metadata', () => {
        const trace = new RequestTrace();

        trace.startAttempt({ index: 3, keyId: 'key-abc', selectionReason: 'least_loaded' });
        const attempt = trace.currentAttempt;

        expect(attempt.keyIndex).toBe(3);
        expect(attempt.keyId).toBe('key-abc');
        expect(attempt.selectionReason).toBe('least_loaded');
    });

    test('spans within an attempt inherit key info', () => {
        const trace = new RequestTrace();
        trace.startAttempt({ index: 5, keyId: 'k5' });

        const span = trace.addSpan(SpanType.UPSTREAM_START);

        expect(span.keyIndex).toBe(5);
        expect(span.keyId).toBe('k5');
        expect(span.attempt).toBe(0);
    });

    test('markRetry records reason on the correct attempt', () => {
        const trace = new RequestTrace();
        trace.startAttempt({ index: 0 });
        trace.endAttempt(false, 429);
        trace.markRetry('rate_limited');

        // markRetry applies to currentAttempt at time of call
        expect(trace.attempts[0].retryReason).toBe('rate_limited');
    });

    test('endAttempt with no current attempt does not throw', () => {
        const trace = new RequestTrace();
        expect(() => trace.endAttempt(true, 200)).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// 3. Sampling rate (selective storage simulates 50% sampling)
// ---------------------------------------------------------------------------
describe('Sampling rate', () => {
    test('at 50% sampling, roughly half of traces are captured', () => {
        const store = new TraceStore({ maxTraces: 10000 });
        const sampleRate = 0.5;
        const total = 2000;
        let stored = 0;

        for (let i = 0; i < total; i++) {
            if (Math.random() < sampleRate) {
                const trace = new RequestTrace();
                trace.complete(true, 200);
                store.store(trace);
                stored++;
            }
        }

        const stats = store.getStats();

        // With 2000 trials at 50%, expect ~1000 stored.
        // Allow generous tolerance (35%-65%) for randomness.
        expect(stats.totalTraces).toBe(stored);
        expect(stored).toBeGreaterThan(total * 0.35);
        expect(stored).toBeLessThan(total * 0.65);
    });

    test('at 0% sampling nothing is stored', () => {
        const store = new TraceStore({ maxTraces: 100 });
        const sampleRate = 0;

        for (let i = 0; i < 100; i++) {
            if (Math.random() < sampleRate) {
                store.store(new RequestTrace());
            }
        }

        expect(store.getStats().totalTraces).toBe(0);
    });

    test('at 100% sampling everything is stored', () => {
        const store = new TraceStore({ maxTraces: 200 });
        const sampleRate = 1;
        let stored = 0;

        for (let i = 0; i < 100; i++) {
            if (Math.random() < sampleRate) {
                store.store(new RequestTrace());
                stored++;
            }
        }

        expect(store.getStats().totalTraces).toBe(100);
        expect(stored).toBe(100);
    });
});

// ---------------------------------------------------------------------------
// 4. Payload size limit (large metadata handling)
// ---------------------------------------------------------------------------
describe('Payload size limit', () => {
    test('large metadata in a span serializes without error', () => {
        const span = new RequestSpan(SpanType.COMPLETE);
        const bigPayload = 'x'.repeat(100_000);
        span.addMetadata('body', bigPayload);

        const json = span.toJSON();
        expect(json.metadata.body.length).toBe(100_000);
    });

    test('many metadata keys do not corrupt serialization', () => {
        const span = new RequestSpan(SpanType.STREAMING);

        for (let i = 0; i < 500; i++) {
            span.addMetadata(`key_${i}`, `value_${i}`);
        }

        const json = span.toJSON();
        expect(Object.keys(json.metadata).length).toBe(500);
        expect(json.metadata.key_0).toBe('value_0');
        expect(json.metadata.key_499).toBe('value_499');
    });

    test('trace with large model and path strings serializes correctly', () => {
        const longModel = 'model-' + 'a'.repeat(5000);
        const longPath = '/' + 'p'.repeat(5000);
        const trace = new RequestTrace({ model: longModel, path: longPath });
        trace.complete(true, 200);

        const json = trace.toJSON();
        expect(json.model).toBe(longModel);
        expect(json.path).toBe(longPath);
    });

    test('empty metadata is omitted from span JSON', () => {
        const span = new RequestSpan(SpanType.QUEUED);
        const json = span.toJSON();

        expect(json.metadata).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// 5. Trace serialization (JSON round-trip)
// ---------------------------------------------------------------------------
describe('Trace serialization', () => {
    test('trace survives JSON stringify/parse without data loss', () => {
        const trace = new RequestTrace({
            traceId: 'trace_rt_001',
            requestId: 'req_rt_001',
            method: 'POST',
            path: '/v1/messages',
            model: 'claude-3-opus',
            mappedModel: 'claude-3-opus-20240229',
            provider: 'anthropic',
            mappedProvider: 'anthropic-direct',
            estimatedCostUsd: 0.042
        });

        trace.markQueued();
        trace.markDequeued();

        const attempt = trace.startAttempt({ index: 0, keyId: 'key-a', selectionReason: 'rr' });
        const span = attempt.addSpan(SpanType.UPSTREAM_START, { startTime: 1000 });
        span.end(1200);
        span.addMetadata('bytesReceived', 4096);
        attempt.addSpan(SpanType.FIRST_BYTE, { startTime: 1200 });
        trace.endAttempt(true, 200);
        trace.complete(true, 200);

        const serialized = JSON.stringify(trace.toJSON());
        const deserialized = JSON.parse(serialized);

        expect(deserialized.traceId).toBe('trace_rt_001');
        expect(deserialized.requestId).toBe('req_rt_001');
        expect(deserialized.model).toBe('claude-3-opus');
        expect(deserialized.mappedModel).toBe('claude-3-opus-20240229');
        expect(deserialized.provider).toBe('anthropic');
        expect(deserialized.mappedProvider).toBe('anthropic-direct');
        expect(deserialized.estimatedCostUsd).toBe(0.042);
        expect(deserialized.success).toBe(true);
        expect(deserialized.finalStatus).toBe(200);
        expect(deserialized.attempts.length).toBe(1);
        expect(deserialized.attempts[0].spans[0].metadata.bytesReceived).toBe(4096);
        expect(deserialized.phaseSummary).toBeDefined();
        expect(deserialized.phaseSummary.phases[SpanType.UPSTREAM_START]).toBe(200);
    });

    test('attempt toJSON includes phaseTiming', () => {
        const attempt = new RequestAttempt(0);
        const s1 = attempt.addSpan(SpanType.UPSTREAM_START, { startTime: 0 });
        s1.end(100);
        const s2 = attempt.addSpan(SpanType.STREAMING, { startTime: 100 });
        s2.end(350);
        attempt.end(true, 200);

        const json = attempt.toJSON();

        expect(json.phaseTiming[SpanType.UPSTREAM_START]).toBe(100);
        expect(json.phaseTiming[SpanType.STREAMING]).toBe(250);
    });

    test('span with error serializes error field', () => {
        const span = new RequestSpan(SpanType.ERROR);
        span.setError('connection refused');
        span.end();

        const json = JSON.parse(JSON.stringify(span.toJSON()));

        expect(json.error).toBe('connection refused');
        expect(json.status).toBe('error');
    });

    test('trace getSummary matches key fields from toJSON', () => {
        const trace = new RequestTrace({
            traceId: 'trace_sum',
            requestId: 'req_sum',
            model: 'opus',
            mappedModel: 'opus-mapped',
            provider: 'prov',
            mappedProvider: 'prov-mapped',
            path: '/v1/chat'
        });
        trace.startAttempt({ index: 0 });
        trace.complete(true, 200);

        const full = trace.toJSON();
        const summary = trace.getSummary();

        expect(summary.traceId).toBe(full.traceId);
        expect(summary.requestId).toBe(full.requestId);
        expect(summary.model).toBe(full.model);
        expect(summary.mappedModel).toBe(full.mappedModel);
        expect(summary.provider).toBe(full.provider);
        expect(summary.mappedProvider).toBe(full.mappedProvider);
        expect(summary.success).toBe(full.success);
        expect(summary.totalDuration).toBe(full.totalDuration);
    });
});

// ---------------------------------------------------------------------------
// 6. Error recording
// ---------------------------------------------------------------------------
describe('Error recording', () => {
    test('span captures Error object message', () => {
        const span = new RequestSpan(SpanType.ERROR);
        const err = new TypeError('Cannot read properties of undefined');

        span.setError(err);

        expect(span.error).toBe('Cannot read properties of undefined');
        expect(span.status).toBe('error');
    });

    test('span captures plain string error', () => {
        const span = new RequestSpan(SpanType.ERROR);
        span.setError('ECONNREFUSED');

        expect(span.error).toBe('ECONNREFUSED');
    });

    test('setError accepts custom status', () => {
        const span = new RequestSpan(SpanType.ERROR);
        span.setError('rate limited', 429);

        expect(span.error).toBe('rate limited');
        expect(span.status).toBe(429);
    });

    test('attempt end records error', () => {
        const attempt = new RequestAttempt(0);
        attempt.end(false, 500, 'Internal server error');

        expect(attempt.success).toBe(false);
        expect(attempt.status).toBe(500);
        expect(attempt.error).toBe('Internal server error');
    });

    test('trace complete records finalError', () => {
        const trace = new RequestTrace();
        trace.startAttempt({ index: 0 });
        trace.complete(false, 502, 'Bad Gateway');

        expect(trace.success).toBe(false);
        expect(trace.finalStatus).toBe(502);
        expect(trace.finalError).toBe('Bad Gateway');
    });

    test('error with stack trace can be stored in metadata', () => {
        const span = new RequestSpan(SpanType.ERROR);
        const err = new Error('timeout');

        span.setError(err);
        span.addMetadata('stack', err.stack);
        span.addMetadata('errorType', err.constructor.name);

        expect(span.metadata.stack).toContain('Error: timeout');
        expect(span.metadata.errorType).toBe('Error');
    });

    test('multiple error spans are recorded independently', () => {
        const attempt = new RequestAttempt(0);

        const s1 = attempt.addSpan(SpanType.ERROR);
        s1.setError('first error');

        const s2 = attempt.addSpan(SpanType.ERROR);
        s2.setError('second error');

        expect(attempt.spans.length).toBe(2);
        expect(attempt.spans[0].error).toBe('first error');
        expect(attempt.spans[1].error).toBe('second error');

        // getSpan returns the last one
        expect(attempt.getSpan(SpanType.ERROR).error).toBe('second error');
    });
});

// ---------------------------------------------------------------------------
// 7. Timing
// ---------------------------------------------------------------------------
describe('Timing', () => {
    test('span duration is endTime minus startTime', () => {
        const span = new RequestSpan(SpanType.STREAMING, { startTime: 1000 });
        span.end(1750);

        expect(span.duration).toBe(750);
    });

    test('trace totalDuration is endTime minus startTime', () => {
        jest.useFakeTimers();
        try {
            const trace = new RequestTrace({ startTime: Date.now() });
            trace.startAttempt({ index: 0 });

            jest.advanceTimersByTime(500);
            trace.complete(true, 200);

            expect(trace.totalDuration).toBe(500);
            expect(trace.endTime - trace.startTime).toBe(500);
        } finally {
            jest.useRealTimers();
        }
    });

    test('queue duration is calculated from markQueued to markDequeued', () => {
        jest.useFakeTimers();
        try {
            const trace = new RequestTrace();
            trace.markQueued();

            jest.advanceTimersByTime(200);
            trace.markDequeued();

            expect(trace.queueDuration).toBe(200);
        } finally {
            jest.useRealTimers();
        }
    });

    test('markDequeued without markQueued leaves queueDuration null', () => {
        const trace = new RequestTrace();
        trace.markDequeued();

        expect(trace.queueDuration).toBeNull();
    });

    test('attempt duration accounts for all spans', () => {
        jest.useFakeTimers();
        try {
            const attempt = new RequestAttempt(0, { startTime: Date.now() });
            attempt.addSpan(SpanType.KEY_ACQUIRED);
            jest.advanceTimersByTime(100);
            attempt.addSpan(SpanType.UPSTREAM_START);
            jest.advanceTimersByTime(200);

            attempt.end(true, 200);

            expect(attempt.duration).toBe(300);
        } finally {
            jest.useRealTimers();
        }
    });

    test('getRetryTime sums duration of all attempts beyond the first', () => {
        const trace = new RequestTrace();

        const a0 = trace.startAttempt({ index: 0 });
        a0.startTime = 0;
        a0.end(false, 429);
        a0.duration = 100; // force known duration

        const a1 = trace.startAttempt({ index: 1 });
        a1.startTime = 100;
        a1.end(false, 429);
        a1.duration = 150;

        const a2 = trace.startAttempt({ index: 2 });
        a2.startTime = 250;
        a2.end(true, 200);
        a2.duration = 200;

        // Retry time = a1.duration + a2.duration = 150 + 200 = 350
        expect(trace.getRetryTime()).toBe(350);
    });

    test('getRetryTime returns 0 when there is one or zero attempts', () => {
        const traceZero = new RequestTrace();
        expect(traceZero.getRetryTime()).toBe(0);

        const traceOne = new RequestTrace();
        traceOne.startAttempt({ index: 0 });
        traceOne.endAttempt(true, 200);
        expect(traceOne.getRetryTime()).toBe(0);
    });

    test('complete closes open spans in the current attempt', () => {
        const trace = new RequestTrace();
        trace.startAttempt({ index: 0 });
        const span = trace.addSpan(SpanType.STREAMING);

        expect(span.isOpen()).toBe(true);

        trace.complete(true, 200);

        expect(span.isOpen()).toBe(false);
        expect(span.endTime).toBeDefined();
        expect(span.duration).toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// 8. Trace lookup
// ---------------------------------------------------------------------------
describe('Trace lookup', () => {
    let store;

    beforeEach(() => {
        store = new TraceStore({ maxTraces: 100 });
    });

    test('get returns trace by traceId', () => {
        const trace = new RequestTrace({ traceId: 'trace_lookup_1' });
        store.store(trace);

        expect(store.get('trace_lookup_1')).toBe(trace);
    });

    test('get returns undefined for unknown traceId', () => {
        expect(store.get('nonexistent')).toBeUndefined();
    });

    test('getByRequestId returns trace by requestId', () => {
        const trace = new RequestTrace({ requestId: 'req-lookup-77' });
        store.store(trace);

        const found = store.getByRequestId('req-lookup-77');
        expect(found).toBe(trace);
    });

    test('getByRequestId returns null for unknown requestId', () => {
        expect(store.getByRequestId('nope')).toBeNull();
    });

    test('getRecent returns traces newest-first', () => {
        for (let i = 0; i < 5; i++) {
            const trace = new RequestTrace({ traceId: `trace_${i}` });
            store.store(trace);
        }

        const recent = store.getRecent(3);

        expect(recent.length).toBe(3);
        expect(recent[0].traceId).toBe('trace_4');
        expect(recent[1].traceId).toBe('trace_3');
        expect(recent[2].traceId).toBe('trace_2');
    });

    test('getRecent with count greater than stored returns all', () => {
        store.store(new RequestTrace({ traceId: 'only_one' }));

        const recent = store.getRecent(100);
        expect(recent.length).toBe(1);
        expect(recent[0].traceId).toBe('only_one');
    });

    test('query with since filter only returns newer traces', () => {
        const cutoff = Date.now();

        const oldTrace = new RequestTrace({ traceId: 'old', startTime: cutoff - 10000 });
        const newTrace = new RequestTrace({ traceId: 'new', startTime: cutoff + 1000 });

        store.store(oldTrace);
        store.store(newTrace);

        const results = store.query({ since: cutoff });
        expect(results.length).toBe(1);
        expect(results[0].traceId).toBe('new');
    });

    test('query with multiple filters narrows results', () => {
        const t1 = new RequestTrace({ traceId: 't1', model: 'opus' });
        t1.complete(true, 200);
        t1.totalDuration = 500;

        const t2 = new RequestTrace({ traceId: 't2', model: 'sonnet' });
        t2.complete(true, 200);
        t2.totalDuration = 500;

        const t3 = new RequestTrace({ traceId: 't3', model: 'opus' });
        t3.complete(false, 500);
        t3.totalDuration = 500;

        store.store(t1);
        store.store(t2);
        store.store(t3);

        const results = store.query({ model: 'opus', success: true });
        expect(results.length).toBe(1);
        expect(results[0].traceId).toBe('t1');
    });
});

// ---------------------------------------------------------------------------
// 9. Cleanup (eviction)
// ---------------------------------------------------------------------------
describe('Cleanup', () => {
    test('traces are evicted when store exceeds maxTraces', () => {
        const store = new TraceStore({ maxTraces: 5 });

        for (let i = 0; i < 10; i++) {
            const trace = new RequestTrace({ traceId: `trace_${i}`, requestId: `req_${i}` });
            store.store(trace);
        }

        const stats = store.getStats();
        expect(stats.totalTraces).toBe(5);

        // Oldest 5 should be gone
        for (let i = 0; i < 5; i++) {
            expect(store.get(`trace_${i}`)).toBeUndefined();
        }

        // Newest 5 should exist
        for (let i = 5; i < 10; i++) {
            expect(store.get(`trace_${i}`)).toBeDefined();
        }
    });

    test('evicted traces are also removed from byRequestId index', () => {
        const store = new TraceStore({ maxTraces: 3 });

        store.store(new RequestTrace({ traceId: 'a', requestId: 'req-a' }));
        store.store(new RequestTrace({ traceId: 'b', requestId: 'req-b' }));
        store.store(new RequestTrace({ traceId: 'c', requestId: 'req-c' }));
        store.store(new RequestTrace({ traceId: 'd', requestId: 'req-d' }));

        expect(store.getByRequestId('req-a')).toBeNull();
        expect(store.getByRequestId('req-d')).not.toBeNull();
    });

    test('clear removes all traces and indices', () => {
        const store = new TraceStore({ maxTraces: 10 });

        for (let i = 0; i < 5; i++) {
            store.store(new RequestTrace({ traceId: `t${i}`, requestId: `r${i}` }));
        }

        store.clear();

        expect(store.getStats().totalTraces).toBe(0);
        expect(store.get('t0')).toBeUndefined();
        expect(store.getByRequestId('r0')).toBeNull();
        expect(store.getRecent(10)).toEqual([]);
    });

    test('store continues to work correctly after eviction cycle', () => {
        const store = new TraceStore({ maxTraces: 3 });

        // Fill and overflow
        store.store(new RequestTrace({ traceId: 'x1' }));
        store.store(new RequestTrace({ traceId: 'x2' }));
        store.store(new RequestTrace({ traceId: 'x3' }));
        store.store(new RequestTrace({ traceId: 'x4' }));
        store.store(new RequestTrace({ traceId: 'x5' }));

        // Should have last 3
        expect(store.getStats().totalTraces).toBe(3);
        expect(store.get('x3')).toBeDefined();
        expect(store.get('x4')).toBeDefined();
        expect(store.get('x5')).toBeDefined();

        // Can still store and retrieve
        store.store(new RequestTrace({ traceId: 'x6' }));
        expect(store.get('x6')).toBeDefined();
        expect(store.get('x3')).toBeUndefined(); // evicted
    });

    test('getStats utilization reflects capacity usage', () => {
        const store = new TraceStore({ maxTraces: 10 });

        store.store(new RequestTrace());
        store.store(new RequestTrace());
        store.store(new RequestTrace());

        const stats = store.getStats();
        expect(stats.capacity).toBe(10);
        expect(stats.utilization).toBe(30); // 3/10 * 100
    });
});

// ---------------------------------------------------------------------------
// 10. Disabled tracing (operations are no-ops / no crash)
// ---------------------------------------------------------------------------
describe('Disabled tracing', () => {
    test('trace lifecycle methods are safe to call without starting an attempt', () => {
        const trace = new RequestTrace();

        // These should not throw even with no attempt
        expect(() => trace.endAttempt(true, 200)).not.toThrow();
        expect(() => trace.markRetry('no_attempt')).not.toThrow();
        expect(() => trace.markDequeued()).not.toThrow();
        expect(() => trace.complete(true, 200)).not.toThrow();
    });

    test('addSpan auto-creates attempt when none exists (graceful fallback)', () => {
        const trace = new RequestTrace();

        // No startAttempt called, addSpan should still work
        const span = trace.addSpan(SpanType.QUEUED);

        expect(span).toBeDefined();
        expect(trace.attempts.length).toBe(1);
    });

    test('completing an already-completed trace does not throw', () => {
        const trace = new RequestTrace();
        trace.startAttempt({ index: 0 });
        trace.complete(true, 200);

        // Second complete overwrites but does not crash
        expect(() => trace.complete(false, 500, 'late error')).not.toThrow();
        expect(trace.success).toBe(false);
    });

    test('toJSON on a bare trace (no attempts) returns valid structure', () => {
        const trace = new RequestTrace();
        const json = trace.toJSON();

        expect(json.traceId).toBeDefined();
        expect(json.attempts).toEqual([]);
        expect(json.phaseSummary).toBeDefined();
        expect(json.phaseSummary.attempts).toBe(0);
        expect(json.phaseSummary.phases).toEqual({});
    });

    test('empty TraceStore operations do not throw', () => {
        const store = new TraceStore({ maxTraces: 10 });

        expect(store.get('nope')).toBeUndefined();
        expect(store.getByRequestId('nope')).toBeNull();
        expect(store.getRecent(10)).toEqual([]);
        expect(store.query({})).toEqual([]);
        expect(() => store.clear()).not.toThrow();

        const stats = store.getStats();
        expect(stats.totalTraces).toBe(0);
        expect(stats.avgDuration).toBeNull();
        expect(stats.utilization).toBe(0);
    });

    test('span operations are safe without ending', () => {
        const span = new RequestSpan(SpanType.QUEUED);

        // isOpen true, toJSON works, addMetadata works
        expect(span.isOpen()).toBe(true);
        expect(() => span.addMetadata('k', 'v')).not.toThrow();
        expect(() => span.toJSON()).not.toThrow();
        expect(() => span.setError('oops')).not.toThrow();
    });

    test('attempt with no spans ends cleanly', () => {
        const attempt = new RequestAttempt(0);

        expect(() => attempt.end(true, 200)).not.toThrow();
        expect(attempt.success).toBe(true);
        expect(attempt.getPhaseTiming()).toEqual({});
    });

    test('admission hold methods are safe on a bare trace', () => {
        const trace = new RequestTrace();

        expect(() => trace.markAdmissionHold('tier-1')).not.toThrow();
        expect(() => trace.markAdmissionHoldRelease(100, true)).not.toThrow();

        expect(trace.admissionHoldTier).toBe('tier-1');
        expect(trace.admissionHoldDuration).toBe(100);
        expect(trace.admissionHoldSucceeded).toBe(true);
    });
});
