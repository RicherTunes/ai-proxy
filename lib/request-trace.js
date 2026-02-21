/**
 * Request Tracing Module
 *
 * Provides detailed request lifecycle tracking with spans for each phase:
 * - QUEUED: Request waiting in backpressure queue
 * - KEY_ACQUIRED: Key selected and acquired
 * - UPSTREAM_START: Request sent to upstream
 * - FIRST_BYTE: First response byte received
 * - STREAMING: Response streaming to client
 * - COMPLETE: Request fully completed
 * - ERROR: Error occurred
 *
 * Traces correlate multiple retry attempts under a single traceId.
 */

'use strict';

const crypto = require('crypto');
const { RingBuffer } = require('./ring-buffer');

// =============================================================================
// SPAN TYPES
// =============================================================================

const SpanType = {
    QUEUED: 'queued',
    KEY_ACQUIRED: 'key_acquired',
    UPSTREAM_START: 'upstream_start',
    FIRST_BYTE: 'first_byte',
    STREAMING: 'streaming',
    COMPLETE: 'complete',
    ERROR: 'error',
    RETRY: 'retry',
    TIMEOUT: 'timeout',
    CANCELLED: 'cancelled',
    ADMISSION_HOLD: 'admission_hold'
};

// =============================================================================
// REQUEST SPAN - Single timing point in request lifecycle
// =============================================================================

class RequestSpan {
    constructor(type, options = {}) {
        this.type = type;
        this.startTime = options.startTime ?? Date.now();
        this.endTime = null;
        this.duration = null;

        // Context data
        this.keyIndex = options.keyIndex ?? null;
        this.keyId = options.keyId ?? null;
        this.attempt = options.attempt ?? 0;
        this.status = options.status ?? null;
        this.error = options.error ?? null;
        this.metadata = options.metadata ?? {};
    }

    /**
     * End this span and calculate duration
     */
    end(endTime = Date.now()) {
        this.endTime = endTime;
        this.duration = this.endTime - this.startTime;
        return this;
    }

    /**
     * Mark span as error
     */
    setError(error, status = null) {
        this.error = typeof error === 'string' ? error : error.message;
        this.status = status || 'error';
        return this;
    }

    /**
     * Add metadata to span
     */
    addMetadata(key, value) {
        this.metadata[key] = value;
        return this;
    }

    /**
     * Check if span is still open
     */
    isOpen() {
        return this.endTime === null;
    }

    /**
     * Serialize for JSON output
     */
    toJSON() {
        return {
            type: this.type,
            startTime: this.startTime,
            endTime: this.endTime,
            duration: this.duration,
            keyIndex: this.keyIndex,
            keyId: this.keyId,
            attempt: this.attempt,
            status: this.status,
            error: this.error,
            metadata: Object.keys(this.metadata).length > 0 ? this.metadata : undefined
        };
    }
}

// =============================================================================
// REQUEST ATTEMPT - Single attempt within a trace (may have multiple on retry)
// =============================================================================

class RequestAttempt {
    constructor(attemptNumber, options = {}) {
        this.attempt = attemptNumber;
        this.startTime = options.startTime ?? Date.now();
        this.endTime = null;
        this.duration = null;

        // Key info
        this.keyIndex = options.keyIndex ?? null;
        this.keyId = options.keyId ?? null;
        this.selectionReason = options.selectionReason ?? null;

        // Spans within this attempt
        this.spans = [];

        // Outcome
        this.success = null;
        this.status = null;
        this.error = null;
        this.retryReason = null;
    }

    /**
     * Add a span to this attempt
     */
    addSpan(type, options = {}) {
        const span = new RequestSpan(type, {
            ...options,
            keyIndex: this.keyIndex,
            keyId: this.keyId,
            attempt: this.attempt
        });
        this.spans.push(span);
        return span;
    }

    /**
     * Get the last span of a given type
     */
    getSpan(type) {
        return this.spans.filter(s => s.type === type).pop();
    }

    /**
     * End this attempt
     */
    end(success, status = null, error = null) {
        this.endTime = Date.now();
        this.duration = this.endTime - this.startTime;
        this.success = success;
        this.status = status;
        this.error = error;

        // Close any open spans
        for (const span of this.spans) {
            if (span.isOpen()) {
                span.end(this.endTime);
            }
        }

        return this;
    }

    /**
     * Mark this attempt as triggering a retry
     */
    markRetry(reason) {
        this.retryReason = reason;
        return this;
    }

    /**
     * Calculate time spent in each phase
     */
    getPhaseTiming() {
        const timing = {};

        for (const span of this.spans) {
            if (span.duration !== null) {
                timing[span.type] = (timing[span.type] || 0) + span.duration;
            }
        }

        return timing;
    }

    /**
     * Serialize for JSON output
     */
    toJSON() {
        return {
            attempt: this.attempt,
            startTime: this.startTime,
            endTime: this.endTime,
            duration: this.duration,
            keyIndex: this.keyIndex,
            keyId: this.keyId,
            selectionReason: this.selectionReason,
            success: this.success,
            status: this.status,
            error: this.error,
            retryReason: this.retryReason,
            spans: this.spans.map(s => s.toJSON()),
            phaseTiming: this.getPhaseTiming()
        };
    }
}

// =============================================================================
// REQUEST TRACE - Full request lifecycle across retries
// =============================================================================

class RequestTrace {
    constructor(options = {}) {
        // Unique trace ID
        this.traceId = options.traceId || RequestTrace.generateTraceId();
        this.requestId = options.requestId || this.traceId;

        // Timing
        this.startTime = options.startTime ?? Date.now();
        this.endTime = null;
        this.totalDuration = null;

        // Request info
        this.method = options.method || 'POST';
        this.path = options.path || '/v1/messages';
        this.model = options.model || null;
        this.mappedModel = options.mappedModel || null;
        this.provider = options.provider || null;
        this.mappedProvider = options.mappedProvider || null;
        this.estimatedCostUsd = options.estimatedCostUsd || null;

        // Attempts (retries)
        this.attempts = [];
        this.currentAttempt = null;

        // Final outcome
        this.success = null;
        this.finalStatus = null;
        this.finalError = null;

        // Queue info
        this.queuedAt = null;
        this.queueDuration = null;
    }

    /**
     * Generate a unique trace ID
     */
    static generateTraceId() {
        return `trace_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    }

    /**
     * Mark request as queued (waiting for key)
     */
    markQueued() {
        this.queuedAt = Date.now();
        return this;
    }

    /**
     * Mark request as entering admission hold
     * @param {string} tier - The tier that triggered the hold
     */
    markAdmissionHold(tier) {
        this.admissionHoldAt = Date.now();
        this.admissionHoldTier = tier;
        return this;
    }

    /**
     * Mark admission hold release
     * @param {number} holdMs - Duration of the hold
     * @param {boolean} succeeded - Whether capacity recovered
     */
    markAdmissionHoldRelease(holdMs, succeeded) {
        this.admissionHoldDuration = holdMs;
        this.admissionHoldSucceeded = succeeded;
        return this;
    }

    /**
     * Mark request as dequeued
     */
    markDequeued() {
        if (this.queuedAt) {
            this.queueDuration = Date.now() - this.queuedAt;
        }
        return this;
    }

    /**
     * Start a new attempt
     */
    startAttempt(keyInfo = {}) {
        const attemptNumber = this.attempts.length;

        this.currentAttempt = new RequestAttempt(attemptNumber, {
            keyIndex: keyInfo.index,
            keyId: keyInfo.keyId,
            selectionReason: keyInfo.selectionReason
        });

        this.attempts.push(this.currentAttempt);
        return this.currentAttempt;
    }

    /**
     * Add a span to the current attempt
     */
    addSpan(type, options = {}) {
        if (!this.currentAttempt) {
            this.startAttempt();
        }
        return this.currentAttempt.addSpan(type, options);
    }

    /**
     * End current attempt and optionally start retry
     */
    endAttempt(success, status = null, error = null) {
        if (this.currentAttempt) {
            this.currentAttempt.end(success, status, error);
        }
        return this;
    }

    /**
     * Mark current attempt as retry trigger
     */
    markRetry(reason) {
        if (this.currentAttempt) {
            this.currentAttempt.markRetry(reason);
        }
        return this;
    }

    /**
     * Complete the trace
     */
    complete(success, status = null, error = null) {
        this.endTime = Date.now();
        this.totalDuration = this.endTime - this.startTime;
        this.success = success;
        this.finalStatus = status;
        this.finalError = error;

        // End current attempt if still open
        if (this.currentAttempt && this.currentAttempt.endTime === null) {
            this.currentAttempt.end(success, status, error);
        }

        return this;
    }

    /**
     * Get attempt count
     */
    getAttemptCount() {
        return this.attempts.length;
    }

    /**
     * Get total time spent in retries
     */
    getRetryTime() {
        if (this.attempts.length <= 1) return 0;

        return this.attempts.slice(1).reduce((sum, attempt) => {
            return sum + (attempt.duration || 0);
        }, 0);
    }

    /**
     * Get summary of time spent in each phase across all attempts
     */
    getPhaseSummary() {
        const summary = {
            queue: this.queueDuration || 0,
            total: this.totalDuration || 0,
            attempts: this.attempts.length,
            phases: {}
        };

        for (const attempt of this.attempts) {
            const timing = attempt.getPhaseTiming();
            for (const [phase, duration] of Object.entries(timing)) {
                summary.phases[phase] = (summary.phases[phase] || 0) + duration;
            }
        }

        return summary;
    }

    /**
     * Get compact summary for listing
     */
    getSummary() {
        return {
            traceId: this.traceId,
            requestId: this.requestId,
            startTime: this.startTime,
            totalDuration: this.totalDuration,
            success: this.success,
            finalStatus: this.finalStatus,
            attempts: this.attempts.length,
            model: this.model,
            mappedModel: this.mappedModel,
            provider: this.provider,
            mappedProvider: this.mappedProvider,
            path: this.path,
            queueDuration: this.queueDuration
        };
    }

    /**
     * Serialize for JSON output
     */
    toJSON() {
        return {
            traceId: this.traceId,
            requestId: this.requestId,
            startTime: this.startTime,
            endTime: this.endTime,
            totalDuration: this.totalDuration,
            method: this.method,
            path: this.path,
            model: this.model,
            mappedModel: this.mappedModel,
            provider: this.provider,
            mappedProvider: this.mappedProvider,
            estimatedCostUsd: this.estimatedCostUsd,
            queuedAt: this.queuedAt,
            queueDuration: this.queueDuration,
            success: this.success,
            finalStatus: this.finalStatus,
            finalError: this.finalError,
            attempts: this.attempts.map(a => a.toJSON()),
            phaseSummary: this.getPhaseSummary()
        };
    }
}

// =============================================================================
// TRACE STORE - In-memory storage for recent traces
// =============================================================================

class TraceStore {
    constructor(options = {}) {
        this.maxTraces = options.maxTraces || 1000;
        this.traces = new Map();
        this.traceOrder = new RingBuffer(this.maxTraces); // O(1) eviction tracking

        // Index for quick lookup
        this.byRequestId = new Map();
    }

    /**
     * Store a trace
     */
    store(trace) {
        const traceId = trace.traceId;

        // Evict oldest if at capacity - read before RingBuffer overwrites it
        if (this.traceOrder.isFull()) {
            const oldestId = this.traceOrder.get(0);
            if (oldestId) {
                const oldTrace = this.traces.get(oldestId);
                if (oldTrace) {
                    this.traces.delete(oldestId);
                    this.byRequestId.delete(oldTrace.requestId);
                }
            }
        }

        // Store trace (RingBuffer auto-evicts the oldest slot)
        this.traces.set(traceId, trace);
        this.traceOrder.push(traceId);

        // Index by requestId
        if (trace.requestId) {
            this.byRequestId.set(trace.requestId, traceId);
        }

        return trace;
    }

    /**
     * Get trace by ID
     */
    get(traceId) {
        return this.traces.get(traceId);
    }

    /**
     * Get trace by request ID
     */
    getByRequestId(requestId) {
        const traceId = this.byRequestId.get(requestId);
        return traceId ? this.traces.get(traceId) : null;
    }

    /**
     * Get recent traces
     */
    getRecent(count = 100) {
        const recentIds = this.traceOrder.toArray().slice(-count).reverse();
        return recentIds
            .map(id => this.traces.get(id))
            .filter(t => t !== undefined)
            .map(t => t.getSummary());
    }

    /**
     * Get traces matching filter
     */
    query(filter = {}) {
        const results = [];

        for (const trace of this.traces.values()) {
            let match = true;

            if (filter.success !== undefined && trace.success !== filter.success) {
                match = false;
            }
            if (filter.model && trace.model !== filter.model) {
                match = false;
            }
            if (filter.minDuration && (trace.totalDuration || 0) < filter.minDuration) {
                match = false;
            }
            if (filter.hasRetries && trace.attempts.length <= 1) {
                match = false;
            }
            if (filter.since && trace.startTime < filter.since) {
                match = false;
            }

            if (match) {
                results.push(trace.getSummary());
            }
        }

        // Sort by start time descending
        results.sort((a, b) => b.startTime - a.startTime);

        return filter.limit ? results.slice(0, filter.limit) : results;
    }

    /**
     * Get statistics
     */
    getStats() {
        let successCount = 0;
        let failureCount = 0;
        let retryCount = 0;
        let totalDuration = 0;
        let completedCount = 0;

        for (const trace of this.traces.values()) {
            if (trace.success === true) successCount++;
            if (trace.success === false) failureCount++;
            if (trace.attempts.length > 1) retryCount++;
            if (trace.totalDuration !== null) {
                totalDuration += trace.totalDuration;
                completedCount++;
            }
        }

        return {
            totalTraces: this.traces.size,
            successCount,
            failureCount,
            retryCount,
            avgDuration: completedCount > 0 ? Math.round(totalDuration / completedCount) : null,
            capacity: this.maxTraces,
            utilization: Math.round((this.traces.size / this.maxTraces) * 100)
        };
    }

    /**
     * Clear all traces
     */
    clear() {
        this.traces.clear();
        this.traceOrder.clear();
        this.byRequestId.clear();
    }
}

module.exports = {
    SpanType,
    RequestSpan,
    RequestAttempt,
    RequestTrace,
    TraceStore
};
