/**
 * Request Trace Branch Coverage Tests
 *
 * Targeted tests for uncovered branches in lib/request-trace.js:
 * - Lines 80-81: addMetadata method
 * - Line 515: TraceStore query minDuration filter
 * - Line 521: TraceStore query since filter
 */

const {
    RequestSpan,
    RequestTrace,
    TraceStore
} = require('../lib/request-trace');

describe('RequestSpan - addMetadata branch coverage', () => {
    test('should add metadata to span', () => {
        const span = new RequestSpan('upstream_start');

        // Test lines 80-81: addMetadata assignment
        span.addMetadata('statusCode', 200);
        span.addMetadata('bytesReceived', 1024);

        expect(span.metadata.statusCode).toBe(200);
        expect(span.metadata.bytesReceived).toBe(1024);
    });

    test('should return span for method chaining', () => {
        const span = new RequestSpan('streaming');

        const result = span.addMetadata('duration', 500);

        expect(result).toBe(span);
    });

    test('should include metadata in JSON when present', () => {
        const span = new RequestSpan('complete');
        span.addMetadata('responseSize', 2048);

        const json = span.toJSON();

        expect(json.metadata).toBeDefined();
        expect(json.metadata.responseSize).toBe(2048);
    });
});

describe('TraceStore - query minDuration filter (line 515)', () => {
    let store;

    beforeEach(() => {
        store = new TraceStore({ maxTraces: 100 });
    });

    test('should filter traces by minDuration', () => {
        // Create traces with different durations
        const fastTrace = new RequestTrace({ traceId: 'fast' });
        fastTrace.startAttempt({ index: 0 });
        fastTrace.complete(true, 200);
        // Manually set a short duration
        fastTrace.totalDuration = 50;

        const slowTrace = new RequestTrace({ traceId: 'slow' });
        slowTrace.startAttempt({ index: 0 });
        slowTrace.complete(true, 200);
        // Manually set a long duration
        slowTrace.totalDuration = 500;

        store.store(fastTrace);
        store.store(slowTrace);

        // Test line 515: minDuration filter branch
        const slowOnly = store.query({ minDuration: 100 });

        expect(slowOnly.length).toBe(1);
        expect(slowOnly[0].traceId).toBe('slow');
    });

    test('should include traces exactly at minDuration threshold', () => {
        const trace = new RequestTrace({ traceId: 'exact' });
        trace.startAttempt({ index: 0 });
        trace.complete(true, 200);
        trace.totalDuration = 100;

        store.store(trace);

        const results = store.query({ minDuration: 100 });

        expect(results.length).toBe(1);
        expect(results[0].traceId).toBe('exact');
    });

    test('should handle traces with null duration', () => {
        const incomplete = new RequestTrace({ traceId: 'incomplete' });
        incomplete.startAttempt({ index: 0 });
        // Not completed, so totalDuration is null

        store.store(incomplete);

        // Line 515 handles null duration by treating it as 0
        const results = store.query({ minDuration: 50 });

        expect(results.length).toBe(0);
    });
});

describe('TraceStore - query since filter (line 521)', () => {
    let store;

    beforeEach(() => {
        store = new TraceStore({ maxTraces: 100 });
    });

    test('should filter traces by since timestamp', () => {
        const now = Date.now();
        const hourAgo = now - (60 * 60 * 1000);

        const oldTrace = new RequestTrace({
            traceId: 'old',
            startTime: hourAgo - 1000
        });
        oldTrace.complete(true, 200);

        const recentTrace = new RequestTrace({
            traceId: 'recent',
            startTime: hourAgo + 1000
        });
        recentTrace.complete(true, 200);

        store.store(oldTrace);
        store.store(recentTrace);

        // Test line 521: since filter branch
        const recentOnly = store.query({ since: hourAgo });

        expect(recentOnly.length).toBe(1);
        expect(recentOnly[0].traceId).toBe('recent');
    });

    test('should include traces exactly at since threshold', () => {
        const timestamp = Date.now() - 1000;

        const trace = new RequestTrace({
            traceId: 'exact',
            startTime: timestamp
        });
        trace.complete(true, 200);

        store.store(trace);

        // Traces with startTime >= since should be excluded
        // Line 521: if (filter.since && trace.startTime < filter.since)
        const results = store.query({ since: timestamp });

        expect(results.length).toBe(1);
    });

    test('should combine since with other filters', () => {
        const now = Date.now();
        const hourAgo = now - (60 * 60 * 1000);

        const oldSuccess = new RequestTrace({
            traceId: 'old-success',
            startTime: hourAgo - 1000
        });
        oldSuccess.complete(true, 200);

        const recentSuccess = new RequestTrace({
            traceId: 'recent-success',
            startTime: hourAgo + 1000
        });
        recentSuccess.complete(true, 200);

        const recentFailure = new RequestTrace({
            traceId: 'recent-failure',
            startTime: hourAgo + 2000
        });
        recentFailure.complete(false, 500);

        store.store(oldSuccess);
        store.store(recentSuccess);
        store.store(recentFailure);

        // Combine since + success filters
        const results = store.query({
            since: hourAgo,
            success: true
        });

        expect(results.length).toBe(1);
        expect(results[0].traceId).toBe('recent-success');
    });
});

describe('TraceStore - combined filter coverage', () => {
    let store;

    beforeEach(() => {
        store = new TraceStore({ maxTraces: 100 });
    });

    test('should handle all filters together including minDuration and since', () => {
        const now = Date.now();
        const hourAgo = now - (60 * 60 * 1000);

        // Recent, slow, successful trace with retries
        const perfectMatch = new RequestTrace({
            traceId: 'match',
            model: 'claude-3',
            startTime: hourAgo + 1000
        });
        perfectMatch.startAttempt({ index: 0 });
        perfectMatch.endAttempt(false, 429);
        perfectMatch.startAttempt({ index: 1 });
        perfectMatch.complete(true, 200);
        perfectMatch.totalDuration = 500;

        // Recent but fast
        const tooFast = new RequestTrace({
            traceId: 'fast',
            model: 'claude-3',
            startTime: hourAgo + 2000
        });
        tooFast.startAttempt({ index: 0 });
        tooFast.complete(true, 200);
        tooFast.totalDuration = 50;

        // Slow but old
        const tooOld = new RequestTrace({
            traceId: 'old',
            model: 'claude-3',
            startTime: hourAgo - 1000
        });
        tooOld.startAttempt({ index: 0 });
        tooOld.complete(true, 200);
        tooOld.totalDuration = 500;

        store.store(perfectMatch);
        store.store(tooFast);
        store.store(tooOld);

        // Lines 515 and 521 tested together
        const results = store.query({
            success: true,
            model: 'claude-3',
            minDuration: 100,
            since: hourAgo,
            hasRetries: true
        });

        expect(results.length).toBe(1);
        expect(results[0].traceId).toBe('match');
    });
});
