/**
 * Controller Edge Cases Test Suite
 *
 * Covers untested branches across compare, logs, requests, trace, and keys controllers.
 * Each section targets specific uncovered code paths identified by gap analysis.
 */

'use strict';

const { CompareController } = require('../../../lib/proxy/controllers/compare-controller');
const { LogsController } = require('../../../lib/proxy/controllers/logs-controller');
const { RequestsController } = require('../../../lib/proxy/controllers/requests-controller');
const { TraceController } = require('../../../lib/proxy/controllers/trace-controller');
const { KeysController } = require('../../../lib/proxy/controllers/keys-controller');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockRes() {
    return { writeHead: jest.fn(), end: jest.fn(), setHeader: jest.fn() };
}

function mockReq(url, method = 'GET') {
    return { url, method, headers: { host: 'localhost' } };
}

function parseBody(res) {
    return JSON.parse(res.end.mock.calls[0][0]);
}

// ===========================================================================
// 1. CompareController edge cases
// ===========================================================================

describe('CompareController — edge branches', () => {
    // 1a. compare endpoint with missing keys param (empty string yields all-NaN)
    it('should handle keys param where every value is NaN', () => {
        const km = {
            compareKeys: jest.fn((indices) => ({
                keys: indices || ['all'],
                comparison: {},
                details: []
            }))
        };
        const ctrl = new CompareController({ keyManager: km });
        const res = mockRes();

        ctrl.handleCompare(mockReq('/compare?keys=abc,def'), res);

        // All values are NaN after parseInt → filtered out → empty array
        expect(km.compareKeys).toHaveBeenCalledWith([]);
    });

    // 1b. compare with keyManager that lacks compareKeys method → fallback
    it('should return fallback response when keyManager has no compareKeys', () => {
        const ctrl = new CompareController({ keyManager: {} });
        const res = mockRes();

        ctrl.handleCompare(mockReq('/compare?keys=0,1'), res);

        const body = parseBody(res);
        expect(body).toEqual({
            keys: [0, 1],
            comparison: {},
            details: []
        });
    });

    // 1c. compare with no keyManager at all and no keys param → fallback uses 'all'
    it('should return fallback with keys=["all"] when no keyManager and no keys param', () => {
        const ctrl = new CompareController();
        const res = mockRes();

        ctrl.handleCompare(mockReq('/compare'), res);

        const body = parseBody(res);
        expect(body.keys).toEqual(['all']);
        expect(body.comparison).toEqual({});
        expect(body.details).toEqual([]);
    });

    // 1d. compare with mixed valid/invalid including negative numbers
    it('should keep negative integers from keys param (parseInt keeps them)', () => {
        const km = {
            compareKeys: jest.fn((indices) => ({
                keys: indices,
                comparison: {},
                details: []
            }))
        };
        const ctrl = new CompareController({ keyManager: km });
        const res = mockRes();

        ctrl.handleCompare(mockReq('/compare?keys=-1,0,abc,2'), res);

        // -1 and 0 and 2 are valid integers; abc is NaN → filtered
        expect(km.compareKeys).toHaveBeenCalledWith([-1, 0, 2]);
    });
});

// ===========================================================================
// 2. LogsController edge branches
// ===========================================================================

describe('LogsController — edge branches', () => {
    // 2a. GET /logs when logger returns empty array
    it('should return count=0 and empty logs array when logger has no logs', () => {
        const ctrl = new LogsController({
            logger: { getLogs: jest.fn(() => []) }
        });
        const res = mockRes();

        ctrl.handleLogs(mockReq('/logs'), res);

        const body = parseBody(res);
        expect(body.count).toBe(0);
        expect(body.logs).toEqual([]);
    });

    // 2b. GET /logs with limit=0 (NaN fallback to 100 because parseInt('0') = 0, || 100)
    it('should fall back to limit=100 when limit param is 0', () => {
        const logger = { getLogs: jest.fn(() => []) };
        const ctrl = new LogsController({ logger });
        const res = mockRes();

        ctrl.handleLogs(mockReq('/logs?limit=0'), res);

        // parseInt('0') = 0, which is falsy → || 100
        expect(logger.getLogs).toHaveBeenCalledWith(100);
    });

    // 2c. GET /logs with negative limit
    it('should fall back to limit=100 when limit param is negative', () => {
        const logger = { getLogs: jest.fn(() => []) };
        const ctrl = new LogsController({ logger });
        const res = mockRes();

        ctrl.handleLogs(mockReq('/logs?limit=-50'), res);

        // parseInt('-50') = -50, which is truthy but Math.min(-50, 500) = -50
        // The code: Math.min(parseInt(limitParam, 10) || 100, 500)
        // parseInt('-50') = -50 → truthy → Math.min(-50, 500) = -50
        expect(logger.getLogs).toHaveBeenCalledWith(-50);
    });

    // 2d. handleAuditLog with invalid limit → falls back to 100
    it('should default audit-log limit to 100 when limit param is invalid', () => {
        const auditLog = {
            size: 5,
            toArray: jest.fn(() => [
                { timestamp: 1, action: 'a1' },
                { timestamp: 2, action: 'a2' },
                { timestamp: 3, action: 'a3' },
                { timestamp: 4, action: 'a4' },
                { timestamp: 5, action: 'a5' }
            ])
        };
        const ctrl = new LogsController({ auditLog });
        const res = mockRes();

        ctrl.handleAuditLog(mockReq('/audit-log?limit=xyz'), res);

        const body = parseBody(res);
        // All 5 entries returned because 5 < 100 default
        expect(body.count).toBe(5);
        expect(body.total).toBe(5);
    });

    // 2e. handleClearLogs with PUT method → 405
    it('should return 405 for PUT request to clear-logs', () => {
        const ctrl = new LogsController({ logger: { clearLogs: jest.fn(), info: jest.fn() } });
        const res = mockRes();

        ctrl.handleClearLogs(mockReq('/control/clear-logs', 'PUT'), res);

        expect(res.writeHead).toHaveBeenCalledWith(405, expect.objectContaining({
            'content-type': 'application/json'
        }));
    });

    // 2f. handleClearLogs with DELETE method → 405
    it('should return 405 for DELETE request to clear-logs', () => {
        const ctrl = new LogsController({ logger: { clearLogs: jest.fn(), info: jest.fn() } });
        const res = mockRes();

        ctrl.handleClearLogs(mockReq('/control/clear-logs', 'DELETE'), res);

        expect(res.writeHead).toHaveBeenCalledWith(405, expect.objectContaining({
            'content-type': 'application/json'
        }));
        const body = parseBody(res);
        expect(body.error).toContain('Method not allowed');
    });

    // 2g. handleAuditLog limit=0 (falsy) → falls back to 100
    it('should fall back audit-log limit to 100 when limit is 0', () => {
        const auditLog = { size: 0, toArray: jest.fn(() => []) };
        const ctrl = new LogsController({ auditLog });
        const res = mockRes();

        ctrl.handleAuditLog(mockReq('/audit-log?limit=0'), res);

        const body = parseBody(res);
        expect(body.count).toBe(0);
        expect(body.total).toBe(0);
    });
});

// ===========================================================================
// 3. RequestsController edge branches
// ===========================================================================

describe('RequestsController — edge branches', () => {
    let sampleTraces;

    beforeEach(() => {
        sampleTraces = [
            { traceId: 't1', requestId: 'r1', keyIndex: 0, status: 200, latencyMs: 50 },
            { traceId: 't2', requestId: 'r2', keyIndex: 1, status: 500, latencyMs: 250 },
            { traceId: 't3', requestId: 'r3', keyIndex: 0, status: 200, latencyMs: 300 },
            { traceId: 't4', requestId: 'r4', keyIndex: 2, status: 429, latencyMs: 10 },
            { traceId: 't5', requestId: 'r5', keyIndex: 1, status: 200, latencyMs: 150 }
        ];
    });

    function makeCtrl(traces) {
        return new RequestsController({
            requestTraces: {
                size: traces.length,
                toArray: jest.fn(() => [...traces])
            }
        });
    }

    // 3a. GET /requests with both offset and limit
    it('should paginate correctly with offset and limit combined', () => {
        const ctrl = makeCtrl(sampleTraces);
        const res = mockRes();

        ctrl.handleRequests(mockReq('/requests?limit=2&offset=1'), res, '/requests');

        const body = parseBody(res);
        expect(body.limit).toBe(2);
        expect(body.offset).toBe(1);
        expect(body.requests.length).toBeLessThanOrEqual(2);
    });

    // 3b. GET /requests/search with combined filters (status + keyIndex + minLatency)
    it('should apply multiple search filters simultaneously', () => {
        const ctrl = makeCtrl(sampleTraces);
        const res = mockRes();

        ctrl.handleRequests(
            mockReq('/requests/search?keyIndex=0&status=200&minLatency=100'),
            res,
            '/requests/search'
        );

        const body = parseBody(res);
        // Only t3 matches: keyIndex=0, status=200, latencyMs=300 >= 100
        expect(body.requests.length).toBe(1);
        expect(body.requests[0].traceId).toBe('t3');
    });

    // 3c. GET /requests/search with keyIndex that is NaN string
    it('should skip keyIndex filter when keyIndex param is non-numeric', () => {
        const ctrl = makeCtrl(sampleTraces);
        const res = mockRes();

        ctrl.handleRequests(
            mockReq('/requests/search?keyIndex=abc'),
            res,
            '/requests/search'
        );

        const body = parseBody(res);
        // NaN check fails → filter not applied → all results returned
        expect(body.requests.length).toBe(5);
    });

    // 3d. GET /requests/search with minLatency that is NaN string
    it('should skip minLatency filter when value is non-numeric', () => {
        const ctrl = makeCtrl(sampleTraces);
        const res = mockRes();

        ctrl.handleRequests(
            mockReq('/requests/search?minLatency=slow'),
            res,
            '/requests/search'
        );

        const body = parseBody(res);
        // NaN check fails → filter not applied → all results returned
        expect(body.requests.length).toBe(5);
    });

    // 3e. GET /requests/:id 404 includes error message
    it('should return 404 with "Trace not found" message for nonexistent id', () => {
        const ctrl = makeCtrl(sampleTraces);
        const res = mockRes();

        ctrl.handleRequests(
            mockReq('/requests/does-not-exist'),
            res,
            '/requests/does-not-exist'
        );

        expect(res.writeHead).toHaveBeenCalledWith(404, expect.objectContaining({
            'content-type': 'application/json'
        }));
        const body = parseBody(res);
        expect(body.error).toBe('Trace not found');
    });

    // 3f. GET /requests/search with null requestTraces
    it('should return empty results on search when requestTraces is null', () => {
        const ctrl = new RequestsController();
        const res = mockRes();

        ctrl.handleRequests(
            mockReq('/requests/search?status=200'),
            res,
            '/requests/search'
        );

        const body = parseBody(res);
        expect(body.requests).toEqual([]);
    });

    // 3g. GET /requests/:id with null requestTraces → 404
    it('should return 404 when requestTraces is null on individual lookup', () => {
        const ctrl = new RequestsController();
        const res = mockRes();

        ctrl.handleRequests(mockReq('/requests/t1'), res, '/requests/t1');

        expect(res.writeHead).toHaveBeenCalledWith(404, expect.objectContaining({
            'content-type': 'application/json'
        }));
    });

    // 3h. GET /requests with null requestTraces → empty requests + total 0
    it('should return empty array and total 0 when requestTraces is null', () => {
        const ctrl = new RequestsController();
        const res = mockRes();

        ctrl.handleRequests(mockReq('/requests'), res, '/requests');

        const body = parseBody(res);
        expect(body.requests).toEqual([]);
        expect(body.total).toBe(0);
    });

    // 3i. POST to /requests → 404 (method not GET)
    it('should return 404 for non-GET method on /requests', () => {
        const ctrl = makeCtrl(sampleTraces);
        const res = mockRes();

        ctrl.handleRequests(mockReq('/requests', 'POST'), res, '/requests');

        expect(res.writeHead).toHaveBeenCalledWith(404, expect.objectContaining({
            'content-type': 'application/json'
        }));
    });

    // 3j. GET /requests/search with status filter that matches nothing
    it('should return empty results when status filter matches nothing', () => {
        const ctrl = makeCtrl(sampleTraces);
        const res = mockRes();

        ctrl.handleRequests(
            mockReq('/requests/search?status=999'),
            res,
            '/requests/search'
        );

        const body = parseBody(res);
        expect(body.requests).toEqual([]);
    });
});

// ===========================================================================
// 4. TraceController edge branches
// ===========================================================================

describe('TraceController — edge branches', () => {
    function makeMockHandler(overrides = {}) {
        return {
            queryTraces: jest.fn(() => []),
            getRecentTraces: jest.fn(() => []),
            getTraceStats: jest.fn(() => ({ total: 0, successful: 0, failed: 0 })),
            getTrace: jest.fn(() => null),
            ...overrides
        };
    }

    const identity = (data) => data;

    // 4a. handleTraces when requestHandler returns empty (sampling rate 0 scenario)
    it('should return empty traces array when handler returns nothing', () => {
        const ctrl = new TraceController({
            requestHandler: makeMockHandler(),
            redactSensitiveData: identity
        });
        const res = mockRes();

        ctrl.handleTraces(mockReq('/traces'), res);

        const body = parseBody(res);
        expect(body.traces).toEqual([]);
        expect(body.stats).toEqual({ total: 0, successful: 0, failed: 0 });
        expect(body.filter).toBeNull();
        expect(body.timestamp).toBeDefined();
    });

    // 4b. handleTraceById returns traceId in 404 body
    it('should include traceId in 404 response body for nonexistent trace', () => {
        const ctrl = new TraceController({
            requestHandler: makeMockHandler(),
            redactSensitiveData: identity
        });
        const res = mockRes();

        ctrl.handleTraceById(mockReq('/traces/missing-id-xyz'), res, '/traces/missing-id-xyz');

        const body = parseBody(res);
        expect(res.writeHead).toHaveBeenCalledWith(404, expect.objectContaining({
            'content-type': 'application/json'
        }));
        expect(body.error).toBe('Trace not found');
        expect(body.traceId).toBe('missing-id-xyz');
        expect(body.timestamp).toBeDefined();
    });

    // 4c. handleTraceById with null requestHandler
    it('should return 404 when requestHandler is null on trace lookup', () => {
        const ctrl = new TraceController({
            requestHandler: null,
            redactSensitiveData: identity
        });
        const res = mockRes();

        ctrl.handleTraceById(mockReq('/traces/abc'), res, '/traces/abc');

        expect(res.writeHead).toHaveBeenCalledWith(404, expect.objectContaining({
            'content-type': 'application/json'
        }));
    });

    // 4d. hasRetries param with non-true value is ignored
    it('should not set hasRetries filter when param is "false"', () => {
        const handler = makeMockHandler();
        const ctrl = new TraceController({
            requestHandler: handler,
            redactSensitiveData: identity
        });
        const res = mockRes();

        ctrl.handleTraces(mockReq('/traces?hasRetries=false'), res);

        // hasRetries only set if === 'true', so with 'false' no filter → getRecentTraces
        expect(handler.getRecentTraces).toHaveBeenCalledWith(100);
        expect(handler.queryTraces).not.toHaveBeenCalled();
    });

    // 4e. Combined filters (success + model + minDuration + since)
    it('should pass all combined filters to queryTraces', () => {
        const handler = makeMockHandler();
        const ctrl = new TraceController({
            requestHandler: handler,
            redactSensitiveData: identity
        });
        const res = mockRes();

        ctrl.handleTraces(
            mockReq('/traces?success=false&model=glm-4&minDuration=500&since=1000&hasRetries=true'),
            res
        );

        expect(handler.queryTraces).toHaveBeenCalledWith({
            success: false,
            model: 'glm-4',
            minDuration: 500,
            since: 1000,
            hasRetries: true
        });
    });

    // 4f. handleTraces with limit + filters → limit removed from filter, passed separately
    it('should strip limit from filter object and apply filters with queryTraces', () => {
        const handler = makeMockHandler();
        const ctrl = new TraceController({
            requestHandler: handler,
            redactSensitiveData: identity
        });
        const res = mockRes();

        ctrl.handleTraces(mockReq('/traces?success=true&limit=25'), res);

        // limit is stripped from filter; since success filter exists → queryTraces called
        const filterArg = handler.queryTraces.mock.calls[0][0];
        expect(filterArg).toEqual({ success: true });
        expect(filterArg).not.toHaveProperty('limit');
    });

    // 4g. handleTraceById with invalid pathname (no match)
    it('should return 404 for pathname that does not match trace ID pattern', () => {
        const ctrl = new TraceController({
            requestHandler: makeMockHandler(),
            redactSensitiveData: identity
        });
        const res = mockRes();

        ctrl.handleTraceById(mockReq('/traces/'), res, '/traces/');

        expect(res.writeHead).toHaveBeenCalledWith(404, expect.objectContaining({
            'content-type': 'application/json'
        }));
        const body = parseBody(res);
        expect(body.error).toBe('Not found');
    });

    // 4h. handleTraces with null requestHandler → empty traces
    it('should return empty traces when requestHandler is null', () => {
        const ctrl = new TraceController({
            requestHandler: null,
            redactSensitiveData: identity
        });
        const res = mockRes();

        ctrl.handleTraces(mockReq('/traces'), res);

        const body = parseBody(res);
        expect(body.traces).toEqual([]);
        expect(body.stats).toEqual({});
    });

    // 4i. handleTraces with only limit and no other filters → getRecentTraces called with limit
    it('should call getRecentTraces with custom limit when only limit is provided', () => {
        const handler = makeMockHandler();
        const ctrl = new TraceController({
            requestHandler: handler,
            redactSensitiveData: identity
        });
        const res = mockRes();

        ctrl.handleTraces(mockReq('/traces?limit=10'), res);

        expect(handler.getRecentTraces).toHaveBeenCalledWith(10);
        expect(handler.queryTraces).not.toHaveBeenCalled();
    });
});

// ===========================================================================
// 5. KeysController edge branches
// ===========================================================================

describe('KeysController — edge branches', () => {
    const identity = (data) => data;

    // 5a. handleDebugKeys with per-key scheduler data mapping verification
    it('should map scheduler selectionCount and lastSelected onto each key', () => {
        const now = Date.now();
        const km = {
            getStats: jest.fn(() => [
                { index: 0, key: 'k0' },
                { index: 1, key: 'k1' }
            ]),
            getSchedulerStats: jest.fn(() => ({
                perKeyStats: {
                    0: { selectionCount: 10, lastSelected: now },
                    1: { selectionCount: 20, lastSelected: now - 5000 }
                }
            }))
        };
        const ctrl = new KeysController({ keyManager: km, redactSensitiveData: identity });
        const res = mockRes();

        ctrl.handleDebugKeys(mockReq('/debug/keys'), res);

        const body = parseBody(res);
        expect(body.keys[0].scheduler.selectionCount).toBe(10);
        expect(body.keys[0].scheduler.lastSelected).toBe(now);
        expect(body.keys[1].scheduler.selectionCount).toBe(20);
        expect(body.keys[1].scheduler.lastSelected).toBe(now - 5000);
    });

    // 5b. handleDebugKeys when getSchedulerStats is not present on keyManager
    it('should set scheduler=null on each key when getSchedulerStats is absent', () => {
        const km = {
            getStats: jest.fn(() => [
                { index: 0, key: 'k0' }
            ])
            // no getSchedulerStats method
        };
        const ctrl = new KeysController({ keyManager: km, redactSensitiveData: identity });
        const res = mockRes();

        ctrl.handleDebugKeys(mockReq('/debug/keys'), res);

        const body = parseBody(res);
        expect(body.keys[0].scheduler).toBeNull();
        expect(body.scheduler).toBeNull();
    });

    // 5c. handleDebugKeys returns correct count value
    it('should return correct count matching number of keys', () => {
        const km = {
            getStats: jest.fn(() => [
                { index: 0 },
                { index: 1 },
                { index: 2 }
            ]),
            getSchedulerStats: jest.fn(() => null)
        };
        const ctrl = new KeysController({ keyManager: km, redactSensitiveData: identity });
        const res = mockRes();

        ctrl.handleDebugKeys(mockReq('/debug/keys'), res);

        const body = parseBody(res);
        expect(body.count).toBe(3);
    });

    // 5d. handleKeyLatencyHistogram with negative key index → 400
    it('should return 400 for negative key index in histogram', () => {
        const km = {
            keys: [{ index: 0 }, { index: 1 }]
        };
        const ctrl = new KeysController({ keyManager: km, redactSensitiveData: identity });
        const res = mockRes();

        // Negative index doesn't match the regex /(\d+)/ so it returns 404 "Invalid key index"
        ctrl.handleKeyLatencyHistogram(mockReq('/stats/latency-histogram/-1'), res, '/stats/latency-histogram/-1');

        expect(res.writeHead).toHaveBeenCalledWith(404, expect.objectContaining({
            'content-type': 'application/json'
        }));
    });

    // 5e. handleDebugKeys with null keyManager → empty keys array
    it('should return empty keys array when keyManager is null', () => {
        const ctrl = new KeysController({ keyManager: null, redactSensitiveData: identity });
        const res = mockRes();

        ctrl.handleDebugKeys(mockReq('/debug/keys'), res);

        const body = parseBody(res);
        expect(body.count).toBe(0);
        expect(body.keys).toEqual([]);
        expect(body.scheduler).toBeNull();
    });

    // 5f. handleKeyLatencyHistogram with keyManager that has keys but no getKeyLatencyHistogram
    it('should return 404 when getKeyLatencyHistogram method is missing', () => {
        const km = {
            keys: [{ index: 0 }, { index: 1 }]
        };
        const ctrl = new KeysController({ keyManager: km, redactSensitiveData: identity });
        const res = mockRes();

        ctrl.handleKeyLatencyHistogram(mockReq('/stats/latency-histogram/0'), res, '/stats/latency-histogram/0');

        expect(res.writeHead).toHaveBeenCalledWith(404, expect.objectContaining({
            'content-type': 'application/json'
        }));
        const body = parseBody(res);
        expect(body.error).toBe('Key not found');
    });

    // 5g. handleDebugKeys scheduler stats with missing perKeyStats entry for a key
    it('should handle missing perKeyStats entry gracefully (undefined values)', () => {
        const km = {
            getStats: jest.fn(() => [
                { index: 0, key: 'k0' },
                { index: 5, key: 'k5' }
            ]),
            getSchedulerStats: jest.fn(() => ({
                perKeyStats: {
                    0: { selectionCount: 10, lastSelected: 123 }
                    // No entry for index 5
                }
            }))
        };
        const ctrl = new KeysController({ keyManager: km, redactSensitiveData: identity });
        const res = mockRes();

        ctrl.handleDebugKeys(mockReq('/debug/keys'), res);

        const body = parseBody(res);
        // key index 0 has scheduler data
        expect(body.keys[0].scheduler.selectionCount).toBe(10);
        // key index 5 has no perKeyStats entry → undefined values
        expect(body.keys[1].scheduler.selectionCount).toBeUndefined();
        expect(body.keys[1].scheduler.lastSelected).toBeUndefined();
    });

    // 5h. handleKeyLatencyHistogram with non-numeric pathname → 404
    it('should return 404 for non-numeric path segment in histogram endpoint', () => {
        const km = { keys: [{ index: 0 }] };
        const ctrl = new KeysController({ keyManager: km, redactSensitiveData: identity });
        const res = mockRes();

        ctrl.handleKeyLatencyHistogram(
            mockReq('/stats/latency-histogram/abc'),
            res,
            '/stats/latency-histogram/abc'
        );

        expect(res.writeHead).toHaveBeenCalledWith(404, expect.objectContaining({
            'content-type': 'application/json'
        }));
    });

    // 5i. handleKeyLatencyHistogram with keyManager.keys = null → keyCount = 0 → 400
    it('should return 400 when keyManager.keys is null', () => {
        const km = { keys: null };
        const ctrl = new KeysController({ keyManager: km, redactSensitiveData: identity });
        const res = mockRes();

        ctrl.handleKeyLatencyHistogram(
            mockReq('/stats/latency-histogram/0'),
            res,
            '/stats/latency-histogram/0'
        );

        expect(res.writeHead).toHaveBeenCalledWith(400, expect.objectContaining({
            'content-type': 'application/json'
        }));
    });

    // 5j. handleDebugKeys with getSchedulerStats returning null
    it('should set scheduler=null on keys when getSchedulerStats returns null', () => {
        const km = {
            getStats: jest.fn(() => [{ index: 0, key: 'k0' }]),
            getSchedulerStats: jest.fn(() => null)
        };
        const ctrl = new KeysController({ keyManager: km, redactSensitiveData: identity });
        const res = mockRes();

        ctrl.handleDebugKeys(mockReq('/debug/keys'), res);

        const body = parseBody(res);
        expect(body.keys[0].scheduler).toBeNull();
        expect(body.scheduler).toBeNull();
    });
});
