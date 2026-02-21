'use strict';

/**
 * Observability Endpoints Tests (Week 3)
 * Tests for /health/deep, /metrics, /debug/* endpoints
 */

const { ProxyServer } = require('../lib/proxy-server');
const { Config } = require('../lib/config');

// Mock dependencies
jest.mock('../lib/logger', () => ({
    getLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        child: () => ({
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
            forRequest: () => ({
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
                debug: jest.fn()
            })
        }),
        forRequest: () => ({
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn()
        })
    }),
    generateRequestId: () => 'test-req-id'
}));

describe('Observability Endpoints', () => {
    let server;
    let mockReq;
    let mockRes;
    let responseData;
    let responseHeaders;
    let responseStatusCode;

    beforeEach(() => {
        // Create mock config with test API keys
        const config = new Config({
            apiKeys: ['test-key-1', 'test-key-2'],
            port: 0,
            adminTokens: []
        });

        server = new ProxyServer({ config });

        // Reset response tracking
        responseData = '';
        responseHeaders = {};
        responseStatusCode = 200;

        // Create mock request/response
        mockReq = {
            method: 'GET',
            url: '/health/deep',
            headers: {}
        };

        mockRes = {
            writeHead: jest.fn((code, headers) => {
                responseStatusCode = code;
                responseHeaders = headers;
            }),
            end: jest.fn((data) => {
                responseData = data;
            }),
            headersSent: false
        };
    });

    afterEach(() => {
        if (server) {
            server.destroy?.();
        }
    });

    describe('/health/deep', () => {
        test('should return detailed health status', () => {
            server._handleHealthDeep(mockReq, mockRes);

            // May return 200 or 503 depending on key state
            expect([200, 503]).toContain(responseStatusCode);
            expect(responseHeaders['content-type']).toBe('application/json');

            const data = JSON.parse(responseData);
            expect(data.status).toBeDefined();
            expect(data.checks).toBeDefined();
            expect(data.checks.keys).toBeDefined();
            expect(data.checks.queue).toBeDefined();
            expect(data.checks.memory).toBeDefined();
            expect(data.checks.connections).toBeDefined();
            expect(data.checks.traces).toBeDefined();
        });

        test('should include process info', () => {
            server._handleHealthDeep(mockReq, mockRes);

            const data = JSON.parse(responseData);
            expect(data.process).toBeDefined();
            expect(data.process.pid).toBe(process.pid);
            expect(data.process.nodeVersion).toBe(process.version);
        });

        test('should include key status in response', () => {
            server._handleHealthDeep(mockReq, mockRes);

            const data = JSON.parse(responseData);
            expect(data.checks.keys.status).toBeDefined();
            expect(['healthy', 'unhealthy']).toContain(data.checks.keys.status);
            expect(data.checks.keys.total).toBeDefined();
        });

        test('should include check duration', () => {
            server._handleHealthDeep(mockReq, mockRes);

            const data = JSON.parse(responseData);
            expect(data.checkDuration).toBeDefined();
            expect(typeof data.checkDuration).toBe('number');
        });
    });

    describe('/metrics', () => {
        test('should return Prometheus format', () => {
            mockReq.url = '/metrics';
            server._handleMetrics(mockReq, mockRes);

            expect(responseStatusCode).toBe(200);
            expect(responseHeaders['content-type']).toContain('text/plain');

            // Check for Prometheus format
            expect(responseData).toContain('# HELP');
            expect(responseData).toContain('# TYPE');
        });

        test('should include proxy info metric', () => {
            server._handleMetrics(mockReq, mockRes);

            expect(responseData).toContain('glm_proxy_info');
        });

        test('should include uptime metric', () => {
            server._handleMetrics(mockReq, mockRes);

            expect(responseData).toContain('glm_proxy_uptime_seconds');
        });

        test('should include request metrics', () => {
            server._handleMetrics(mockReq, mockRes);

            expect(responseData).toContain('glm_proxy_requests_total');
            expect(responseData).toContain('glm_proxy_requests_in_flight');
        });

        test('should include key metrics', () => {
            server._handleMetrics(mockReq, mockRes);

            expect(responseData).toContain('glm_proxy_keys_total');
            expect(responseData).toContain('glm_proxy_keys_healthy');
        });

        test('should include error metrics', () => {
            server._handleMetrics(mockReq, mockRes);

            expect(responseData).toContain('glm_proxy_errors_total');
        });
    });

    describe('/debug/state', () => {
        test('should return internal state', () => {
            server._handleDebugState(mockReq, mockRes);

            expect(responseStatusCode).toBe(200);

            const data = JSON.parse(responseData);
            expect(data.timestamp).toBeDefined();
            expect(data.uptime).toBeDefined();
            expect(data.paused).toBeDefined();
            expect(data.connections).toBeDefined();
            expect(data.requests).toBeDefined();
            expect(data.keys).toBeDefined();
            expect(data.traces).toBeDefined();
        });

        test('should include key states array', () => {
            server._handleDebugState(mockReq, mockRes);

            const data = JSON.parse(responseData);
            expect(Array.isArray(data.keys)).toBe(true);
            // Keys array exists (may be empty in test environment)
            if (data.keys.length > 0) {
                expect(data.keys[0].state).toBeDefined();
            }
        });

        test('should include connection health', () => {
            server._handleDebugState(mockReq, mockRes);

            const data = JSON.parse(responseData);
            expect(data.connections.health).toBeDefined();
        });
    });

    describe('/debug/profile', () => {
        test('should return performance profile', () => {
            server._handleDebugProfile(mockReq, mockRes);

            expect(responseStatusCode).toBe(200);

            const data = JSON.parse(responseData);
            expect(data.timestamp).toBeDefined();
            expect(data.process).toBeDefined();
            expect(data.process.memory).toBeDefined();
            expect(data.process.cpu).toBeDefined();
        });

        test('should include memory metrics', () => {
            server._handleDebugProfile(mockReq, mockRes);

            const data = JSON.parse(responseData);
            expect(data.process.memory.heapUsedMB).toBeDefined();
            expect(data.process.memory.heapTotalMB).toBeDefined();
            expect(data.process.memory.rssMB).toBeDefined();
        });

        test('should include key profiles', () => {
            server._handleDebugProfile(mockReq, mockRes);

            const data = JSON.parse(responseData);
            expect(Array.isArray(data.keys)).toBe(true);
        });

        test('should include retry analysis', () => {
            server._handleDebugProfile(mockReq, mockRes);

            const data = JSON.parse(responseData);
            expect(data.retries).toBeDefined();
            expect(data.retries.totalTraces).toBeDefined();
            expect(data.retries.retryRate).toBeDefined();
        });
    });

    describe('/debug/keys', () => {
        test('should return detailed key info', () => {
            server._handleDebugKeys(mockReq, mockRes);

            expect(responseStatusCode).toBe(200);

            const data = JSON.parse(responseData);
            expect(data.timestamp).toBeDefined();
            expect(data.count).toBeDefined();
            expect(Array.isArray(data.keys)).toBe(true);
        });

        test('should include key count', () => {
            server._handleDebugKeys(mockReq, mockRes);

            const data = JSON.parse(responseData);
            expect(typeof data.count).toBe('number');
            expect(data.count).toBeGreaterThanOrEqual(0);
        });
    });

    describe('/debug/errors', () => {
        test('should return error analysis', () => {
            server._handleDebugErrors(mockReq, mockRes);

            expect(responseStatusCode).toBe(200);

            const data = JSON.parse(responseData);
            expect(data.timestamp).toBeDefined();
            expect(data.summary).toBeDefined();
            expect(data.byType).toBeDefined();
        });

        test('should group errors by type', () => {
            server._handleDebugErrors(mockReq, mockRes);

            const data = JSON.parse(responseData);
            expect(typeof data.byType).toBe('object');
        });
    });

    describe('/debug routing', () => {
        test('should route to correct handler', () => {
            const debugStateSpy = jest.spyOn(server, '_handleDebugState');

            server._handleDebug(mockReq, mockRes, '/debug/state');

            expect(debugStateSpy).toHaveBeenCalled();
        });

        test('should return 404 for unknown debug endpoint', () => {
            server._handleDebug(mockReq, mockRes, '/debug/unknown');

            expect(responseStatusCode).toBe(404);
            const data = JSON.parse(responseData);
            expect(data.error).toContain('Unknown debug endpoint');
            expect(data.available).toBeDefined();
        });
    });
});
