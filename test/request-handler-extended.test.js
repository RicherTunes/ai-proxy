/**
 * Extended RequestHandler tests targeting uncovered lines:
 * - ConnectionHealthMonitor cooldown (152-163)
 * - clearRequestStream (513)
 * - _createAgent / _recreateAgent (522-554)
 * - _calculateTimeout (565-589)
 * - _getErrorStrategy (597-598)
 */

const { RequestHandler, ConnectionHealthMonitor, ERROR_STRATEGIES } = require('../lib/request-handler');
const { KeyManager } = require('../lib/key-manager');

function createKeyManager() {
    const km = new KeyManager({
        maxConcurrencyPerKey: 3,
        circuitBreaker: { failureThreshold: 5, failureWindow: 5000, cooldownPeriod: 1000 }
    });
    km.loadKeys(['key1.secret1', 'key2.secret2']);
    return km;
}

function createHandler(overrides = {}) {
    const km = overrides.keyManager || createKeyManager();
    return new RequestHandler({
        keyManager: km,
        targetHost: 'localhost',
        targetBasePath: '/v1',
        requestTimeout: 30000,
        maxRetries: 2,
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
        statsAggregator: { recordAgentRecreation: jest.fn() },
        ...overrides
    });
}

// ============================================================
// ConnectionHealthMonitor
// ============================================================
describe('ConnectionHealthMonitor cooldown', () => {
    test('shouldRecreateAgent returns false when below threshold', () => {
        const mon = new ConnectionHealthMonitor({ maxConsecutiveHangups: 3 });
        mon.recordHangup();
        mon.recordHangup();
        expect(mon.shouldRecreateAgent()).toBe(false);
    });

    test('shouldRecreateAgent returns true when at threshold and no cooldown', () => {
        const mon = new ConnectionHealthMonitor({ maxConsecutiveHangups: 3 });
        mon.recordHangup();
        mon.recordHangup();
        mon.recordHangup();
        // Force past cooldown
        mon.lastAgentRecreation = 0;
        expect(mon.shouldRecreateAgent()).toBe(true);
    });

    test('shouldRecreateAgent returns false during cooldown period', () => {
        const mon = new ConnectionHealthMonitor({
            maxConsecutiveHangups: 2,
            agentRecreationCooldownMs: 60000
        });
        mon.recordHangup();
        mon.recordHangup();
        // Recently recreated
        mon.lastAgentRecreation = Date.now();
        expect(mon.shouldRecreateAgent()).toBe(false);
    });

    test('markAgentRecreated resets hangups and increments count', () => {
        const mon = new ConnectionHealthMonitor({ maxConsecutiveHangups: 2 });
        mon.recordHangup();
        mon.recordHangup();
        mon.markAgentRecreated();
        expect(mon.consecutiveHangups).toBe(0);
        expect(mon.agentRecreationCount).toBe(1);
    });

    test('getStats returns accurate data', () => {
        const mon = new ConnectionHealthMonitor({ maxConsecutiveHangups: 3 });
        mon.recordHangup();
        mon.recordSuccess();
        mon.recordHangup();
        const stats = mon.getStats();
        expect(stats.totalHangups).toBe(2);
        expect(stats.consecutiveHangups).toBe(1);
        expect(stats.agentRecreationCount).toBe(0);
    });
});

// ============================================================
// clearRequestStream
// ============================================================
describe('clearRequestStream', () => {
    test('clears the request stream array', () => {
        const rh = createHandler();
        rh.requestStream.push({ id: 1 }, { id: 2 });
        expect(rh.requestStream.length).toBe(2);
        rh.clearRequestStream();
        expect(rh.requestStream.length).toBe(0);
    });
});

// ============================================================
// _createAgent and _recreateAgent
// ============================================================
describe('_createAgent', () => {
    test('destroys existing agent before creating new one', () => {
        const rh = createHandler();
        const oldAgent = rh.agent;
        const destroySpy = jest.spyOn(oldAgent, 'destroy');
        rh._createAgent();
        expect(destroySpy).toHaveBeenCalled();
        expect(rh.agent).not.toBe(oldAgent);
    });

    test('agent error handler logs error', () => {
        const rh = createHandler();
        rh.agent.emit('error', new Error('socket error'));
        expect(rh.logger.error).toHaveBeenCalledWith(
            'HTTPS agent error',
            expect.objectContaining({ error: 'socket error' })
        );
    });
});

describe('_recreateAgent', () => {
    test('recreates agent and marks monitor', () => {
        const rh = createHandler();
        const oldAgent = rh.agent;
        rh.connectionMonitor.recordHangup();
        rh._recreateAgent();
        expect(rh.agent).not.toBe(oldAgent);
        expect(rh.connectionMonitor.consecutiveHangups).toBe(0);
        expect(rh.connectionMonitor.agentRecreationCount).toBe(1);
        expect(rh.logger.warn).toHaveBeenCalledWith(
            'Recreating HTTPS agent due to connection issues',
            expect.any(Object)
        );
        expect(rh.statsAggregator.recordAgentRecreation).toHaveBeenCalled();
    });
});

// ============================================================
// _calculateTimeout
// ============================================================
describe('_calculateTimeout', () => {
    test('returns static requestTimeout when adaptive disabled', () => {
        const rh = createHandler();
        rh.adaptiveTimeoutConfig = { enabled: false };
        const keyInfo = { latencies: { stats: () => ({}) } };
        expect(rh._calculateTimeout(keyInfo, 0)).toBe(rh.requestTimeout);
    });

    test('uses initialMs when insufficient samples', () => {
        const rh = createHandler();
        rh.adaptiveTimeoutConfig = {
            enabled: true,
            minSamples: 10,
            initialMs: 15000,
            latencyMultiplier: 2,
            retryMultiplier: 1.5,
            minMs: 5000,
            maxMs: 120000
        };
        const keyInfo = { latencies: { stats: () => ({ count: 3, p95: 1000 }) } };
        expect(rh._calculateTimeout(keyInfo, 0)).toBe(15000);
    });

    test('uses P95-based timeout with enough samples', () => {
        const rh = createHandler();
        rh.adaptiveTimeoutConfig = {
            enabled: true,
            minSamples: 5,
            initialMs: 15000,
            latencyMultiplier: 2,
            retryMultiplier: 1.5,
            minMs: 5000,
            maxMs: 120000
        };
        const keyInfo = { latencies: { stats: () => ({ count: 10, p95: 8000 }) } };
        // base = max(8000*2, 5000) = 16000, attempt 0 -> 16000 * 1.5^0 = 16000
        expect(rh._calculateTimeout(keyInfo, 0)).toBe(16000);
    });

    test('applies retry multiplier for retries', () => {
        const rh = createHandler();
        rh.adaptiveTimeoutConfig = {
            enabled: true,
            minSamples: 5,
            initialMs: 15000,
            latencyMultiplier: 2,
            retryMultiplier: 2,
            minMs: 5000,
            maxMs: 120000
        };
        const keyInfo = { latencies: { stats: () => ({ count: 10, p95: 5000 }) } };
        // base = max(5000*2, 5000) = 10000, attempt 2 -> 10000 * 2^2 = 40000
        expect(rh._calculateTimeout(keyInfo, 2)).toBe(40000);
    });

    test('clamps to maxMs', () => {
        const rh = createHandler();
        rh.adaptiveTimeoutConfig = {
            enabled: true,
            minSamples: 5,
            initialMs: 15000,
            latencyMultiplier: 2,
            retryMultiplier: 10,
            minMs: 5000,
            maxMs: 60000
        };
        const keyInfo = { latencies: { stats: () => ({ count: 10, p95: 50000 }) } };
        // base = 100000, attempt 1 -> 1000000 -> clamped to 60000
        expect(rh._calculateTimeout(keyInfo, 1)).toBe(60000);
    });
});

// ============================================================
// ERROR_STRATEGIES
// ============================================================
describe('ERROR_STRATEGIES', () => {
    test('broken_pipe strategy allows retry', () => {
        expect(ERROR_STRATEGIES.broken_pipe.shouldRetry).toBe(true);
        expect(ERROR_STRATEGIES.broken_pipe.useFreshConnection).toBe(true);
    });

    test('connection_aborted strategy allows retry', () => {
        expect(ERROR_STRATEGIES.connection_aborted.shouldRetry).toBe(true);
    });

    test('stream_premature_close strategy allows retry', () => {
        expect(ERROR_STRATEGIES.stream_premature_close.shouldRetry).toBe(true);
    });

    test('http_parse_error strategy allows retry with fresh connection', () => {
        expect(ERROR_STRATEGIES.http_parse_error.shouldRetry).toBe(true);
        expect(ERROR_STRATEGIES.http_parse_error.useFreshConnection).toBe(true);
    });

    test('tls_error strategy does not retry', () => {
        expect(ERROR_STRATEGIES.tls_error.shouldRetry).toBe(false);
    });

    test('rate_limited strategy does not retry (429 = quota exhausted)', () => {
        expect(ERROR_STRATEGIES.rate_limited.shouldRetry).toBe(false);
        expect(ERROR_STRATEGIES.rate_limited.excludeKey).toBe(true);
        expect(ERROR_STRATEGIES.rate_limited.maxRetries).toBe(0);
    });

    test('other fallback strategy', () => {
        expect(ERROR_STRATEGIES.other.shouldRetry).toBe(true);
    });
});

// ============================================================
// _getErrorStrategy
// ============================================================
describe('_getErrorStrategy', () => {
    test('returns matching strategy for known type', () => {
        const rh = createHandler();
        expect(rh._getErrorStrategy('broken_pipe')).toBe(ERROR_STRATEGIES.broken_pipe);
    });

    test('falls back to other for unknown type', () => {
        const rh = createHandler();
        expect(rh._getErrorStrategy('totally_unknown_error')).toBe(ERROR_STRATEGIES.other);
    });
});

// ============================================================
// addRequestToStream
// ============================================================
describe('addRequestToStream', () => {
    test('normalizes error status', () => {
        const rh = createHandler();
        rh.addRequestToStream({ error: true, path: '/v1/messages' });
        expect(rh.requestStream[0].status).toBe('error');
    });

    test('normalizes success to completed', () => {
        const rh = createHandler();
        rh.addRequestToStream({ success: true, path: '/v1/messages' });
        expect(rh.requestStream[0].status).toBe('completed');
    });

    test('defaults missing status to pending', () => {
        const rh = createHandler();
        rh.addRequestToStream({ path: '/v1/messages' });
        expect(rh.requestStream[0].status).toBe('pending');
    });

    test('keeps numeric status as-is', () => {
        const rh = createHandler();
        rh.addRequestToStream({ status: 200, path: '/v1/messages' });
        expect(rh.requestStream[0].status).toBe(200);
    });

    test('caps stream at maxStreamSize', () => {
        const rh = createHandler();
        rh.maxStreamSize = 5;
        for (let i = 0; i < 10; i++) {
            rh.addRequestToStream({ id: i, path: '/test' });
        }
        expect(rh.requestStream.length).toBe(5);
    });
});
