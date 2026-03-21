'use strict';
/**
 * Request Trace Function Coverage Tests
 *
 * Target: Push function coverage from 94.32% to 100%
 * Each test targets a specific uncovered function or code path.
 */

const {
    RequestSpan,
    RequestAttempt,
    RequestTrace,
    TraceStore
} = require('../lib/request-trace');

describe('RequestTrace - generateTraceId static function', () => {
    // Covers line 265: RequestTrace.generateTraceId static method
    test('should generate unique trace IDs with correct format', () => {
        const id1 = RequestTrace.generateTraceId();
        const id2 = RequestTrace.generateTraceId();

        expect(id1).toMatch(/^trace_[a-z0-9]+_[a-f0-9]{8}$/);
        expect(id2).toMatch(/^trace_[a-z0-9]+_[a-f0-9]{8}$/);
        expect(id1).not.toBe(id2);
    });

    // Covers line 265: multiple calls produce different values
    test('should generate different IDs on successive calls', () => {
        const ids = new Set();
        for (let i = 0; i < 100; i++) {
            ids.add(RequestTrace.generateTraceId());
        }
        expect(ids.size).toBe(100);
    });
});

describe('RequestTrace - markAdmissionHold function', () => {
    // Covers line 281: markAdmissionHold method
    test('should record admission hold timestamp and tier', () => {
        const trace = new RequestTrace();

        const before = Date.now();
        trace.markAdmissionHold('global');
        const after = Date.now();

        expect(trace.admissionHoldAt).toBeGreaterThanOrEqual(before);
        expect(trace.admissionHoldAt).toBeLessThanOrEqual(after);
        expect(trace.admissionHoldTier).toBe('global');
    });

    // Covers line 281: different tier values
    test('should handle different tier names', () => {
        const trace = new RequestTrace();

        trace.markAdmissionHold('model-claude-3');
        expect(trace.admissionHoldTier).toBe('model-claude-3');
    });
});

describe('RequestTrace - markAdmissionHoldRelease function', () => {
    // Covers line 292: markAdmissionHoldRelease method
    test('should record admission hold duration and success', () => {
        const trace = new RequestTrace();

        trace.markAdmissionHoldRelease(250, true);

        expect(trace.admissionHoldDuration).toBe(250);
        expect(trace.admissionHoldSucceeded).toBe(true);
    });

    // Covers line 292: failed admission hold
    test('should record failed admission hold', () => {
        const trace = new RequestTrace();

        trace.markAdmissionHoldRelease(500, false);

        expect(trace.admissionHoldDuration).toBe(500);
        expect(trace.admissionHoldSucceeded).toBe(false);
    });
});

describe('RequestTrace - admission hold tracking', () => {
    // Covers lines 281-284: markAdmissionHold stores timestamp and tier
    test('should track admission hold state on trace object', () => {
        const trace = new RequestTrace();

        trace.markAdmissionHold('tenant-abc');
        trace.markAdmissionHoldRelease(150, true);

        // These are stored directly on the trace object
        expect(trace.admissionHoldAt).toBeDefined();
        expect(trace.admissionHoldTier).toBe('tenant-abc');
        expect(trace.admissionHoldDuration).toBe(150);
        expect(trace.admissionHoldSucceeded).toBe(true);
    });

    // Covers lines 292-295: markAdmissionHoldRelease method chaining
    test('markAdmissionHoldRelease returns trace for chaining', () => {
        const trace = new RequestTrace();

        const result = trace.markAdmissionHoldRelease(100, false);

        expect(result).toBe(trace);
    });
});

describe('RequestAttempt - markRetry function', () => {
    // Covers line 182: RequestAttempt.markRetry method
    test('should set retry reason on attempt', () => {
        const attempt = new RequestAttempt(0);

        const result = attempt.markRetry('rate_limited');

        expect(attempt.retryReason).toBe('rate_limited');
        expect(result).toBe(attempt); // method chaining
    });

    // Covers line 182: different retry reasons
    test('should handle various retry reasons', () => {
        const attempt = new RequestAttempt(0);

        attempt.markRetry('connection_error');
        expect(attempt.retryReason).toBe('connection_error');

        attempt.markRetry('timeout');
        expect(attempt.retryReason).toBe('timeout');
    });
});

describe('RequestAttempt - getSpan function', () => {
    // Covers line 155: RequestAttempt.getSpan method
    test('should return undefined when span type does not exist', () => {
        const attempt = new RequestAttempt(0);

        const result = attempt.getSpan('nonexistent_type');

        expect(result).toBeUndefined();
    });

    // Covers line 155: returns last span of given type
    test('should return last span when multiple spans of same type exist', () => {
        const attempt = new RequestAttempt(0);

        attempt.addSpan('error');
        attempt.addSpan('error');
        attempt.addSpan('error');

        const last = attempt.getSpan('error');

        expect(last).toBe(attempt.spans[2]);
    });
});

describe('TraceStore - store eviction edge cases', () => {
    // Covers line 481-490: eviction when oldestId is null
    test('should handle eviction when ring buffer has no oldest entry', () => {
        const store = new TraceStore({ maxTraces: 2 });

        // First trace fills the buffer
        store.store(new RequestTrace({ traceId: 'first' }));
        // Second trace triggers isFull but oldest may be null during edge case
        store.store(new RequestTrace({ traceId: 'second' }));
        // Third trace triggers eviction
        store.store(new RequestTrace({ traceId: 'third' }));

        expect(store.get('first')).toBeUndefined();
        expect(store.get('second')).toBeDefined();
        expect(store.get('third')).toBeDefined();
    });

    // Covers line 484: when oldTrace is undefined
    test('should handle eviction when trace was already deleted', () => {
        const store = new TraceStore({ maxTraces: 2 });

        store.store(new RequestTrace({ traceId: 't1' }));
        store.store(new RequestTrace({ traceId: 't2' }));

        // Manually delete to simulate edge case
        store.traces.delete('t1');

        // Adding third should not crash
        expect(() => store.store(new RequestTrace({ traceId: 't3' }))).not.toThrow();
    });
});

describe('TraceStore - query limit sorting', () => {
    // Covers line 561: sort by start time descending
    test('should sort query results by start time descending', () => {
        const store = new TraceStore({ maxTraces: 100 });

        const now = Date.now();
        const t1 = new RequestTrace({ traceId: 'old', startTime: now - 5000 });
        const t2 = new RequestTrace({ traceId: 'mid', startTime: now - 2500 });
        const t3 = new RequestTrace({ traceId: 'new', startTime: now - 1000 });

        store.store(t1);
        store.store(t2);
        store.store(t3);

        const results = store.query({});

        expect(results[0].traceId).toBe('new');
        expect(results[1].traceId).toBe('mid');
        expect(results[2].traceId).toBe('old');
    });

    // Covers line 563: limit application after sorting
    test('should apply limit after sorting', () => {
        const store = new TraceStore({ maxTraces: 100 });

        const now = Date.now();
        for (let i = 0; i < 10; i++) {
            store.store(new RequestTrace({
                traceId: `t${i}`,
                startTime: now - (i * 1000)
            }));
        }

        const results = store.query({ limit: 3 });

        expect(results.length).toBe(3);
        expect(results[0].traceId).toBe('t0'); // newest (lowest time offset)
    });
});

describe('RequestTrace - complete with open attempt', () => {
    // Covers line 365: complete closes open spans in current attempt
    test('should close current attempt when completing trace', () => {
        const trace = new RequestTrace();
        const attempt = trace.startAttempt({ index: 0 });

        const openSpan = attempt.addSpan('streaming');
        expect(openSpan.isOpen()).toBe(true);

        trace.complete(true, 200);

        expect(attempt.endTime).toBeDefined();
        expect(attempt.success).toBe(true);
        expect(openSpan.isOpen()).toBe(false);
    });

    // Covers line 365: when currentAttempt has no endTime
    test('should only end attempt with null endTime', () => {
        const trace = new RequestTrace();
        const attempt = trace.startAttempt({ index: 0 });

        // Manually close the attempt first
        attempt.end(false, 500);
        expect(attempt.endTime).toBeDefined();

        // Complete should not override the already-ended attempt
        trace.complete(true, 200);

        expect(attempt.success).toBe(false); // keeps first end() value
        expect(attempt.status).toBe(500);
    });
});

describe('RequestSpan - setError with status parameter', () => {
    // Covers line 74: setError with custom status
    test('should set custom status when provided', () => {
        const span = new RequestSpan('error');

        span.setError('timeout', 504);

        expect(span.error).toBe('timeout');
        expect(span.status).toBe(504);
    });

    // Covers line 74: setError defaults status to 'error'
    test('should default status to error when not provided', () => {
        const span = new RequestSpan('error');

        span.setError('failure');

        expect(span.status).toBe('error');
    });
});

describe('RequestTrace - getPhaseSummary', () => {
    // Covers line 395: getPhaseSummary aggregates phase timing
    test('should aggregate timing across all attempts', () => {
        const trace = new RequestTrace({ startTime: 0 });
        trace.queuedAt = 0;
        trace.queueDuration = 50; // manually set for predictable timing

        const a1 = trace.startAttempt({ index: 0 });
        const s1 = a1.addSpan('upstream_start', { startTime: 0 });
        s1.end(100);

        const a2 = trace.startAttempt({ index: 1 });
        const s2 = a2.addSpan('upstream_start', { startTime: 100 });
        s2.end(200);

        trace.complete(true);
        trace.totalDuration = 300; // ensure non-zero total

        const summary = trace.getPhaseSummary();

        expect(summary.queue).toBe(50);
        expect(summary.total).toBe(300);
        expect(summary.attempts).toBe(2);
        expect(summary.phases.upstream_start).toBe(200); // 100 + 100
    });

    // Covers line 395: empty attempts
    test('should handle trace with no attempts', () => {
        const trace = new RequestTrace();

        const summary = trace.getPhaseSummary();

        expect(summary.attempts).toBe(0);
        expect(summary.phases).toEqual({});
    });
});

describe('RequestAttempt - getPhaseTiming with null duration spans', () => {
    // Covers line 194: getPhaseTiming skips spans with null duration
    test('should skip spans with null duration in phase timing', () => {
        const attempt = new RequestAttempt(0);

        // Add an unclosed span (duration is null)
        attempt.addSpan('streaming');
        // Add a closed span - set startTime and end explicitly
        const closed = attempt.addSpan('upstream_start', { startTime: 0 });
        closed.end(100);

        const timing = attempt.getPhaseTiming();

        // Only the closed span should contribute to timing
        expect(timing.upstream_start).toBe(100);
        expect(timing.streaming).toBeUndefined();
    });

    // Covers line 195: accumulates timing for multiple spans of same type
    test('should accumulate timing for multiple spans of same type', () => {
        const attempt = new RequestAttempt(0);

        const s1 = attempt.addSpan('upstream_start', { startTime: 0 });
        s1.end(50);

        const s2 = attempt.addSpan('upstream_start', { startTime: 50 });
        s2.end(100);

        const timing = attempt.getPhaseTiming();

        expect(timing.upstream_start).toBe(100); // 50 + 50
    });
});

describe('RequestTrace - admission hold method chaining', () => {
    // Covers line 284: markAdmissionHold returns this for chaining
    test('markAdmissionHold returns trace for chaining', () => {
        const trace = new RequestTrace();

        const result = trace.markAdmissionHold('global');

        expect(result).toBe(trace);
    });

    // Covers line 282-283: stores admission hold timestamp and tier
    test('markAdmissionHold stores timestamp and tier on trace', () => {
        const before = Date.now();
        const trace = new RequestTrace();
        trace.markAdmissionHold('tenant-xyz');
        const after = Date.now();

        expect(trace.admissionHoldAt).toBeGreaterThanOrEqual(before);
        expect(trace.admissionHoldAt).toBeLessThanOrEqual(after);
        expect(trace.admissionHoldTier).toBe('tenant-xyz');
    });
});

describe('TraceStore - getRecent with count parameter', () => {
    // Covers line 522: getRecent default count parameter
    test('should use default count of 100 when not specified', () => {
        const store = new TraceStore({ maxTraces: 100 });

        // Add 10 traces
        for (let i = 0; i < 10; i++) {
            store.store(new RequestTrace({ traceId: `t${i}` }));
        }

        // Should return all 10 when count not specified
        const recent = store.getRecent();

        expect(recent.length).toBe(10);
        expect(recent[0].traceId).toBe('t9');
    });

    // Covers line 523: slice with count
    test('should respect count parameter for limiting results', () => {
        const store = new TraceStore({ maxTraces: 100 });

        // Add 10 traces
        for (let i = 0; i < 10; i++) {
            store.store(new RequestTrace({ traceId: `t${i}` }));
        }

        const recent = store.getRecent(3);

        expect(recent.length).toBe(3);
        expect(recent.map(r => r.traceId)).toEqual(['t9', 't8', 't7']);
    });

    // Covers line 524-527: map and filter pipeline
    test('should filter out undefined traces from results', () => {
        const store = new TraceStore({ maxTraces: 100 });

        store.store(new RequestTrace({ traceId: 't1' }));

        // Manually corrupt the traces map to simulate undefined trace
        store.traceOrder.push('nonexistent');

        const recent = store.getRecent(10);

        // Should only return the valid trace
        expect(recent.length).toBe(1);
        expect(recent[0].traceId).toBe('t1');
    });
});

describe('TraceStore - query with default filter', () => {
    // Covers line 533: query with empty default filter
    test('should return all traces when no filter provided', () => {
        const store = new TraceStore({ maxTraces: 100 });

        store.store(new RequestTrace({ traceId: 't1' }));
        store.store(new RequestTrace({ traceId: 't2' }));

        const results = store.query();

        expect(results.length).toBe(2);
    });

    // Covers line 533: query with empty object filter
    test('should handle empty object filter', () => {
        const store = new TraceStore({ maxTraces: 100 });

        store.store(new RequestTrace({ traceId: 't1' }));

        const results = store.query({});

        expect(results.length).toBe(1);
    });
});

describe('RequestTrace - getSummary function', () => {
    // Covers lines 414-429: getSummary returns compact trace info
    test('should return compact summary with all key fields', () => {
        const trace = new RequestTrace({
            traceId: 'trace_123',
            requestId: 'req_456',
            model: 'claude-3',
            mappedModel: 'claude-3-opus',
            provider: 'anthropic',
            mappedProvider: 'anthropic-direct',
            path: '/v1/chat'
        });
        trace.markQueued();
        trace.markDequeued();
        trace.complete(true, 200);

        const summary = trace.getSummary();

        expect(summary.traceId).toBe('trace_123');
        expect(summary.requestId).toBe('req_456');
        expect(summary.model).toBe('claude-3');
        expect(summary.mappedModel).toBe('claude-3-opus');
        expect(summary.provider).toBe('anthropic');
        expect(summary.mappedProvider).toBe('anthropic-direct');
        expect(summary.path).toBe('/v1/chat');
        expect(summary.success).toBe(true);
        expect(summary.finalStatus).toBe(200);
        expect(summary.attempts).toBe(0); // no attempts started
        expect(summary.totalDuration).toBeDefined();
        expect(summary.queueDuration).toBeDefined();
    });
});

describe('TraceStore - constructor default options', () => {
    // Covers line 466: constructor defaults maxTraces to 1000
    test('should default maxTraces to 1000 when not provided', () => {
        const store = new TraceStore();

        expect(store.maxTraces).toBe(1000);
        expect(store.traces).toBeInstanceOf(Map);
        expect(store.byRequestId).toBeInstanceOf(Map);
    });

    // Covers line 466: constructor uses provided maxTraces
    test('should use provided maxTraces value', () => {
        const store = new TraceStore({ maxTraces: 500 });

        expect(store.maxTraces).toBe(500);
    });
});

describe('TraceStore - store eviction full cycle', () => {
    // Covers line 483: eviction when oldestId exists and oldTrace exists
    test('should properly evict oldest trace when buffer is full', () => {
        const store = new TraceStore({ maxTraces: 3 });

        // Fill the store to capacity
        store.store(new RequestTrace({ traceId: 't1', requestId: 'r1' }));
        store.store(new RequestTrace({ traceId: 't2', requestId: 'r2' }));
        store.store(new RequestTrace({ traceId: 't3', requestId: 'r3' }));

        // Verify buffer is full
        expect(store.traceOrder.isFull()).toBe(true);

        // This should trigger eviction of t1 (oldestId is truthy, oldTrace exists)
        store.store(new RequestTrace({ traceId: 't4', requestId: 'r4' }));

        // t1 should be evicted from both maps
        expect(store.get('t1')).toBeUndefined();
        expect(store.getByRequestId('r1')).toBeNull();

        // t2, t3, t4 should exist
        expect(store.get('t2')).toBeDefined();
        expect(store.get('t3')).toBeDefined();
        expect(store.get('t4')).toBeDefined();
    });

    // Covers line 483: when oldestId is returned by get(0)
    test('should read oldest ID before eviction', () => {
        const store = new TraceStore({ maxTraces: 2 });

        store.store(new RequestTrace({ traceId: 'first' }));
        store.store(new RequestTrace({ traceId: 'second' }));

        // Buffer is now full, next store will trigger eviction
        expect(store.traceOrder.isFull()).toBe(true);

        // Store third, which should evict first
        store.store(new RequestTrace({ traceId: 'third' }));

        expect(store.get('first')).toBeUndefined();
        expect(store.get('second')).toBeDefined();
        expect(store.get('third')).toBeDefined();
    });

    // Covers line 483-488: full eviction cycle with oldTrace
    test('should delete trace from both maps during eviction', () => {
        const store = new TraceStore({ maxTraces: 2 });

        const t1 = new RequestTrace({ traceId: 'evict_me', requestId: 'req_evict' });
        store.store(t1);
        store.store(new RequestTrace({ traceId: 't2' }));

        // Trigger eviction
        store.store(new RequestTrace({ traceId: 't3' }));

        // Verify both maps are cleaned up for evicted trace
        expect(store.traces.has('evict_me')).toBe(false);
        expect(store.byRequestId.has('req_evict')).toBe(false);
        expect(store.traces.size).toBe(2);
        // t2 and t3 both have requestIds (defaults to traceId)
        expect(store.byRequestId.size).toBe(2);
    });

    // Covers line 483: when oldestId is falsy (edge case)
    test('should handle eviction when oldestId is falsy', () => {
        const store = new TraceStore({ maxTraces: 2 });

        // Fill the buffer with traces
        store.store(new RequestTrace({ traceId: 't1' }));
        store.store(new RequestTrace({ traceId: 't2' }));

        // Manually set first buffer slot to null to simulate edge case
        // This tests the if (oldestId) branch with falsy value
        store.traceOrder.buffer[store.traceOrder.head] = null;

        // This should not crash even though oldestId is null
        expect(() => store.store(new RequestTrace({ traceId: 't3' }))).not.toThrow();
    });
});

describe('TraceStore - store with and without requestId', () => {
    // Covers line 497: store indexes by requestId when present
    test('should index trace by requestId when provided', () => {
        const store = new TraceStore({ maxTraces: 100 });

        const trace = new RequestTrace({ traceId: 't1', requestId: 'req-abc' });
        store.store(trace);

        expect(store.getByRequestId('req-abc')).toBe(trace);
    });

    // Covers line 497: does not index when requestId is missing
    test('should not crash when trace has no requestId', () => {
        const store = new TraceStore({ maxTraces: 100 });

        // Create trace with traceId but no requestId
        const trace = new RequestTrace({ traceId: 't1' });
        trace.requestId = null; // explicitly null

        // Should not throw
        expect(() => store.store(trace)).not.toThrow();
        expect(store.get('t1')).toBe(trace);
        expect(store.getByRequestId(null)).toBeNull();
    });

    // Covers line 497: trace without requestId is still stored
    test('should store trace even when requestId is undefined', () => {
        const store = new TraceStore({ maxTraces: 100 });

        const trace = new RequestTrace({ traceId: 't_no_req' });
        delete trace.requestId; // remove requestId entirely

        store.store(trace);

        expect(store.get('t_no_req')).toBe(trace);
    });
});
