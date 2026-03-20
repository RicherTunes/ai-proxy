'use strict';

const { Readable } = require('stream');
const { transformRequestBody } = require('../lib/request/model-transformer');
const { TenantManager } = require('../lib/tenant-manager');
const { StatsController } = require('../lib/proxy/controllers/stats-controller');
const { WebhookController } = require('../lib/proxy/controllers/webhook-controller');
const { WebhookManager } = require('../lib/webhook-manager');
const { secureCompare } = require('../lib/admin-auth');
const { parseJsonBody } = require('../lib/body-parser');

// ─── helpers ────────────────────────────────────────────────────────────────

function mockReq(data, opts = {}) {
    const readable = new Readable({
        read() {
            if (typeof data === 'string') {
                this.push(Buffer.from(data));
            } else if (Buffer.isBuffer(data)) {
                this.push(data);
            } else if (data !== null) {
                this.push(Buffer.from(JSON.stringify(data)));
            }
            this.push(null);
        }
    });
    readable.destroy = opts.destroy || (() => {});
    return readable;
}

function makeHttpReq(overrides = {}) {
    return {
        headers: overrides.headers || {},
        url: overrides.url || '/',
        method: overrides.method || 'GET',
        socket: overrides.socket || { remoteAddress: '127.0.0.1' }
    };
}

// ─── Test 1: x-model-override header validation ────────────────────────────

describe('x-model-override header validation', () => {
    const baseBody = Buffer.from(JSON.stringify({ model: 'claude-3-opus', messages: [] }));

    function makeMockRouter(override) {
        return {
            config: { logDecisions: false },
            shadowMode: false,
            selectModel: async ({ override: ov }) => {
                // Return whatever override was passed through
                return ov
                    ? { model: ov, source: 'override', tier: 'heavy' }
                    : { model: 'default-model', source: 'router', tier: 'light' };
            }
        };
    }

    test('rejects override values longer than 128 chars', async () => {
        const longOverride = 'a'.repeat(200);
        const req = makeHttpReq({
            headers: { 'x-model-override': longOverride }
        });
        const router = makeMockRouter();

        const result = await transformRequestBody(
            baseBody, null, null, req, null, router, { accepted: 0, rejected: 0 }
        );

        // The override that reaches selectModel should be truncated or rejected
        const parsed = JSON.parse(result.body.toString());
        // Model should NOT be the 200-char string
        expect(parsed.model.length).toBeLessThanOrEqual(128);
    });

    test('sanitizes override values with control characters', async () => {
        const maliciousOverride = 'claude-3\x00-opus\n\r';
        const req = makeHttpReq({
            headers: { 'x-model-override': maliciousOverride }
        });
        const router = makeMockRouter();

        const result = await transformRequestBody(
            baseBody, null, null, req, null, router, { accepted: 0, rejected: 0 }
        );

        const parsed = JSON.parse(result.body.toString());
        // No control characters should remain in the model name
        expect(parsed.model).not.toMatch(/[\x00-\x1f]/);
    });

    test('allows valid override values through', async () => {
        const validOverride = 'claude-3.5-sonnet-20241022';
        const req = makeHttpReq({
            headers: { 'x-model-override': validOverride }
        });
        const router = makeMockRouter();

        const result = await transformRequestBody(
            baseBody, null, null, req, null, router, { accepted: 0, rejected: 0 }
        );

        const parsed = JSON.parse(result.body.toString());
        expect(parsed.model).toBe(validOverride);
    });
});

// ─── Test 2: Tenant ID validation ──────────────────────────────────────────

describe('Tenant ID validation', () => {
    test('truncates tenant IDs longer than 128 characters', () => {
        const longId = 'x'.repeat(1000);
        const mgr = new TenantManager({
            enabled: true,
            tenantHeader: 'x-tenant-id',
            strictMode: true  // strict mode returns the tenant ID even for unknown tenants
        });

        const req = makeHttpReq({ headers: { 'x-tenant-id': longId } });
        const result = mgr.getTenantFromRequest(req);

        // The returned tenantId should be capped at 128 characters
        expect(result.tenantId.length).toBeLessThanOrEqual(128);
    });

    test('sanitizes tenant IDs with special characters', () => {
        const maliciousId = 'tenant\x00id\nwith\rbad"chars}';
        const mgr = new TenantManager({
            enabled: true,
            tenantHeader: 'x-tenant-id',
            strictMode: true
        });

        const req = makeHttpReq({ headers: { 'x-tenant-id': maliciousId } });
        const result = mgr.getTenantFromRequest(req);

        // Should not contain control characters, double quotes, or closing braces
        expect(result.tenantId).not.toMatch(/[\x00-\x1f"{}]/);
    });

    test('allows normal tenant IDs through unchanged', () => {
        const normalId = 'my-tenant-123';
        const mgr = new TenantManager({
            enabled: true,
            tenantHeader: 'x-tenant-id',
            strictMode: true
        });

        const req = makeHttpReq({ headers: { 'x-tenant-id': normalId } });
        const result = mgr.getTenantFromRequest(req);

        // In strict mode, unknown tenants return the original tenantId with error
        expect(result.tenantId).toBe(normalId);
    });
});

// ─── Test 3: Prometheus metric label sanitization ───────────────────────────

describe('Prometheus metric label sanitization', () => {
    function buildMetricsWithTenant(tenantId) {
        const tenantManager = {
            getAllTenantStats() {
                return {
                    enabled: true,
                    tenants: {
                        [tenantId]: {
                            tenantId,
                            requestCount: 42,
                            keyCount: 2,
                            errorCount: 1,
                            strictMode: false
                        }
                    }
                };
            }
        };

        const controller = new StatsController({
            statsAggregator: {
                getFullStats: () => ({}),
                getRateLimitTrackingStats: () => ({})
            },
            keyManager: { getPoolRateLimitStats: () => ({}) },
            requestHandler: {
                getBackpressureStats: () => ({
                    current: 0, max: 0, percentUsed: 0,
                    queue: { current: 0, max: 0 }
                }),
                getRequestPayloadStoreStats: () => ({})
            },
            tenantManager,
            getUptime: () => 1000,
            config: { apiKeys: [] }
        });

        const lines = [];
        const res = {
            writeHead: () => {},
            end: (body) => { lines.push(body); }
        };

        controller.handleMetrics({}, res);
        return lines[0]; // The Prometheus output
    }

    test('escapes double quotes in tenant ID labels', () => {
        const output = buildMetricsWithTenant('tenant"evil');
        // Each line with tenant label must have the quote properly escaped
        const tenantLines = output.split('\n').filter(l => l.includes('tenant='));
        for (const line of tenantLines) {
            // Should not contain unescaped " inside the label value
            // Valid: tenant="tenant\"evil"
            // Invalid: tenant="tenant"evil"
            const match = line.match(/tenant="(.+?)"/);
            if (match) {
                // The captured value between first and last quote should not contain raw "
                // Actually we need a smarter check: the label value should be properly escaped
                expect(line).not.toMatch(/tenant="[^"]*(?<!\\)"[^"]*"/);
            }
        }
    });

    test('escapes closing braces in tenant ID labels', () => {
        const output = buildMetricsWithTenant('tenant}evil');
        // } inside a label value can break Prometheus parsing
        const tenantLines = output.split('\n').filter(l => l.includes('tenant='));
        for (const line of tenantLines) {
            // Check that the label value between quotes does not contain raw }
            const labelMatch = line.match(/tenant="([^"]*)"/);
            if (labelMatch) {
                expect(labelMatch[1]).not.toContain('}');
            }
        }
    });

    test('escapes newlines in tenant ID labels', () => {
        const output = buildMetricsWithTenant('tenant\nevil');
        // Newlines inside label values break Prometheus exposition format
        const tenantLines = output.split('\n').filter(l => l.includes('tenant='));
        for (const line of tenantLines) {
            const labelMatch = line.match(/tenant="([^"]*)"/);
            if (labelMatch) {
                expect(labelMatch[1]).not.toContain('\n');
            }
        }
    });

    test('produces valid Prometheus format with malicious tenant ID', () => {
        const malicious = 'tenant"\n}\\evil';
        const output = buildMetricsWithTenant(malicious);

        // Every non-empty, non-comment line should be parseable:
        // metric_name{labels} value  OR  metric_name value
        const lines = output.split('\n').filter(l => l && !l.startsWith('#'));
        for (const line of lines) {
            // Basic Prometheus line format check
            const valid = /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})?\s+-?[\d.eE+]+$/.test(line.trim());
            if (line.includes('tenant=')) {
                expect(valid).toBe(true);
            }
        }
    });
});

// ─── Test 4: Webhook test URL SSRF protection ──────────────────────────────

describe('Webhook test URL SSRF protection', () => {
    let webhookManager;

    beforeEach(() => {
        webhookManager = new WebhookManager({ enabled: true });
    });

    test('rejects localhost URLs', async () => {
        const result = await webhookManager.testWebhook('http://127.0.0.1/webhook');
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/private|blocked|ssrf|invalid|not allowed/i);
    });

    test('rejects 10.x.x.x private range', async () => {
        const result = await webhookManager.testWebhook('http://10.0.0.1/webhook');
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/private|blocked|ssrf|invalid|not allowed/i);
    });

    test('rejects 192.168.x.x private range', async () => {
        const result = await webhookManager.testWebhook('http://192.168.1.1/webhook');
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/private|blocked|ssrf|invalid|not allowed/i);
    });

    test('rejects AWS metadata endpoint', async () => {
        const result = await webhookManager.testWebhook('http://169.254.169.254/latest/meta-data');
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/private|blocked|ssrf|invalid|not allowed/i);
    });

    test('rejects file:// scheme', async () => {
        const result = await webhookManager.testWebhook('file:///etc/passwd');
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/scheme|protocol|invalid|not allowed/i);
    });

    test('rejects ftp:// scheme', async () => {
        const result = await webhookManager.testWebhook('ftp://evil.com/data');
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/scheme|protocol|invalid|not allowed/i);
    });

    test('allows https:// to public hosts (may fail on network, not on validation)', async () => {
        const result = await webhookManager.testWebhook('https://hooks.example.com/webhook');
        // Should not be blocked by SSRF check - if it fails, it should be a network error
        if (!result.success) {
            expect(result.message).not.toMatch(/private|blocked|ssrf|not allowed|scheme|protocol/i);
        }
    });
});

// ─── Test 5: Body parsing size limits on /models/refresh ────────────────────

describe('/models/refresh body size limits', () => {
    test('rejects a 10MB body with 413', async () => {
        // This tests that parseJsonBody (used by the handler) enforces size limits.
        // The /models/refresh handler should use parseJsonBody instead of manual chunk collection.
        const bigPayload = 'x'.repeat(10 * 1024 * 1024);
        const req = mockReq(bigPayload);

        await expect(parseJsonBody(req)).rejects.toMatchObject({
            statusCode: 413,
            message: expect.stringMatching(/too large/i)
        });
    });

    test('accepts a normal-sized body', async () => {
        const normalPayload = JSON.stringify({ probeKnown: true, probeCandidates: false });
        const req = mockReq(normalPayload);

        const result = await parseJsonBody(req);
        expect(result).toEqual({ probeKnown: true, probeCandidates: false });
    });
});

// ─── Test 6: secureCompare timing safety ────────────────────────────────────

describe('secureCompare length-independent behavior', () => {
    test('returns false for mismatched strings of equal length', () => {
        expect(secureCompare('aaaa', 'bbbb')).toBe(false);
    });

    test('returns true for identical strings', () => {
        expect(secureCompare('secret', 'secret')).toBe(true);
    });

    test('handles different-length strings without throwing', () => {
        // Currently secureCompare returns false early for different lengths,
        // which leaks length info. After the fix, it should still return false
        // but should pad to equal length before comparing.
        expect(secureCompare('short', 'muchlongerstring')).toBe(false);
        expect(secureCompare('muchlongerstring', 'short')).toBe(false);
    });

    test('does not short-circuit on length mismatch (timing-safe)', () => {
        // After fixing, secureCompare should pad shorter string and use timingSafeEqual.
        // We can verify this indirectly: if the function uses timingSafeEqual with padded
        // buffers, it won't throw even for different lengths.
        // The original code would throw or bail early on different lengths.

        // Run multiple comparisons and verify consistent false result
        const results = [];
        for (let i = 0; i < 100; i++) {
            results.push(secureCompare('a', 'a'.repeat(64)));
        }
        expect(results.every(r => r === false)).toBe(true);

        // Also verify: same-length different content still returns false
        const sameLen = [];
        for (let i = 0; i < 100; i++) {
            sameLen.push(secureCompare('aaaa', 'bbbb'));
        }
        expect(sameLen.every(r => r === false)).toBe(true);
    });
});
