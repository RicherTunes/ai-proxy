/**
 * Cost Tracking Admin API Tests
 * Tests for /admin/cost-tracking/* endpoints
 */

const { ProxyServer } = require('../lib/proxy-server');
const { Config } = require('../lib/config');
const { generateToken } = require('../lib/admin-auth');

describe('Cost Tracking Admin API', () => {
    let proxyServer;
    let server;
    let port;
    let testToken;

    beforeAll(async () => {
        // Generate test token
        testToken = generateToken();

        // Create a proper Config instance
        const config = new Config({
            port: 0, // Let OS pick port
            host: '127.0.0.1',
            adminAuth: {
                enabled: true,
                tokens: [testToken],
                headerName: 'x-admin-token'
            },
            configDir: require('os').tmpdir(), // Use temp dir to avoid file issues
            costTracking: {
                enabled: true,
                rates: {
                    inputTokenPer1M: 3.00,
                    outputTokenPer1M: 15.00
                },
                budget: {
                    daily: 100,
                    monthly: 3000,
                    alertThresholds: [0.5, 0.8, 0.95, 1.0]
                },
                persistPath: null // Don't persist during tests
            }
        });

        // Create ProxyServer instance
        proxyServer = new ProxyServer({ config });
        await proxyServer.initialize();

        // Create HTTP server
        return new Promise((resolve) => {
            server = proxyServer._createServer();
            server.listen(0, '127.0.0.1', () => {
                port = server.address().port;
                resolve();
            });
        });
    });

    afterAll(async () => {
        if (server) {
            return new Promise((resolve) => {
                server.close(resolve);
            });
        }
    });

    function makeRequest(method, path, body = null) {
        return new Promise((resolve, reject) => {
            const http = require('http');

            const options = {
                hostname: '127.0.0.1',
                port: port,
                path: path,
                method: method,
                headers: {
                    'x-admin-token': testToken,
                    ...(body ? { 'content-type': 'application/json' } : {})
                }
            };

            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    try {
                        res.body = JSON.parse(data);
                        resolve(res);
                    } catch {
                        resolve(res);
                    }
                });
            });

            req.on('error', reject);

            if (body) {
                req.write(JSON.stringify(body));
            }
            req.end();
        });
    }

    describe('GET /admin/cost-tracking/config', () => {
        test('should return current configuration with valid auth', async () => {
            const response = await makeRequest('GET', '/admin/cost-tracking/config');

            expect(response.statusCode).toBe(200);
            expect(response.body).toHaveProperty('rates');
            expect(response.body).toHaveProperty('modelRates');
            expect(response.body).toHaveProperty('budget');
            expect(response.body).toHaveProperty('saveDebounceMs');
            expect(response.body.rates.inputTokenPer1M).toBe(3.00);
            expect(response.body.rates.outputTokenPer1M).toBe(15.00);
            expect(response.body.budget.daily).toBe(100);
            expect(response.body.budget.monthly).toBe(3000);
        });

        test('should require authentication for config endpoint', async () => {
            const http = require('http');
            const response = await new Promise((resolve) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port: port,
                    path: '/admin/cost-tracking/config',
                    method: 'GET'
                }, resolve);
                req.end();
            });

            expect(response.statusCode).toBe(401);
        });
    });

    describe('POST /admin/cost-tracking/config', () => {
        test('should update rates configuration', async () => {
            const updates = {
                rates: {
                    inputTokenPer1M: 5.00,
                    outputTokenPer1M: 20.00
                }
            };

            const response = await makeRequest('POST', '/admin/cost-tracking/config', updates);

            expect(response.statusCode).toBe(200);
            expect(response.body.rates.inputTokenPer1M).toBe(5.00);
            expect(response.body.rates.outputTokenPer1M).toBe(20.00);
        });

        test('should update budget configuration', async () => {
            const updates = {
                budget: {
                    daily: 200,
                    monthly: 5000,
                    alertThresholds: [0.25, 0.5, 0.75, 1.0]
                }
            };

            const response = await makeRequest('POST', '/admin/cost-tracking/config', updates);

            expect(response.statusCode).toBe(200);
            expect(response.body.budget.daily).toBe(200);
            expect(response.body.budget.monthly).toBe(5000);
            expect(response.body.budget.alertThresholds).toEqual([0.25, 0.5, 0.75, 1.0]);
        });

        test('should update model rates', async () => {
            const updates = {
                modelRates: {
                    'claude-sonnet-4-5': {
                        inputTokenPer1M: 4.00,
                        outputTokenPer1M: 18.00
                    }
                }
            };

            const response = await makeRequest('POST', '/admin/cost-tracking/config', updates);

            expect(response.statusCode).toBe(200);
            expect(response.body.modelRates['claude-sonnet-4-5'].inputTokenPer1M).toBe(4.00);
        });

        test('should validate negative rates', async () => {
            const updates = {
                rates: {
                    inputTokenPer1M: -5.00
                }
            };

            const response = await makeRequest('POST', '/admin/cost-tracking/config', updates);

            expect(response.statusCode).toBe(400);
        });

        test('should validate budget thresholds', async () => {
            const updates = {
                budget: {
                    alertThresholds: [0.5, 1.5, 2.0] // Invalid: > 1.0
                }
            };

            const response = await makeRequest('POST', '/admin/cost-tracking/config', updates);

            expect(response.statusCode).toBe(400);
        });

        test('should require authentication for config updates', async () => {
            const http = require('http');
            const response = await new Promise((resolve) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port: port,
                    path: '/admin/cost-tracking/config',
                    method: 'POST',
                    headers: { 'content-type': 'application/json' }
                }, resolve);
                req.write(JSON.stringify({ rates: { inputTokenPer1M: 5.00 } }));
                req.end();
            });

            expect(response.statusCode).toBe(401);
        });
    });

    describe('GET /admin/cost-tracking/metrics', () => {
        test('should return detailed metrics', async () => {
            const response = await makeRequest('GET', '/admin/cost-tracking/metrics');

            expect(response.statusCode).toBe(200);
            expect(response.body).toHaveProperty('metrics');
            expect(response.body).toHaveProperty('summary');
            expect(response.body.metrics).toHaveProperty('recordCount');
            expect(response.body.metrics).toHaveProperty('saveCount');
            expect(response.body.metrics).toHaveProperty('currentKeys');
            expect(response.body.summary.totalKeys).toBeGreaterThanOrEqual(0);
        });

        test('should require authentication for metrics', async () => {
            const http = require('http');
            const response = await new Promise((resolve) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port: port,
                    path: '/admin/cost-tracking/metrics',
                    method: 'GET'
                }, resolve);
                req.end();
            });

            expect(response.statusCode).toBe(401);
        });
    });

    describe('POST /admin/cost-tracking/flush', () => {
        test('should force immediate save', async () => {
            const response = await makeRequest('POST', '/admin/cost-tracking/flush');

            expect(response.statusCode).toBe(200);
            expect(response.body).toHaveProperty('success', true);
            expect(response.body).toHaveProperty('message');
            expect(response.body).toHaveProperty('timestamp');
        });

        test('should require authentication for flush', async () => {
            const http = require('http');
            const response = await new Promise((resolve) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port: port,
                    path: '/admin/cost-tracking/flush',
                    method: 'POST'
                }, resolve);
                req.end();
            });

            expect(response.statusCode).toBe(401);
        });
    });

    describe('POST /admin/cost-tracking/reset', () => {
        test('should reset all cost tracking data', async () => {
            // First add some data
            proxyServer.costTracker.recordUsage('key1', 5000, 2000, 'claude-sonnet-4-5');
            const beforeReset = proxyServer.costTracker.getStats('today');
            expect(beforeReset.requests).toBeGreaterThan(0);

            const response = await makeRequest('POST', '/admin/cost-tracking/reset');

            expect(response.statusCode).toBe(200);
            expect(response.body).toHaveProperty('success', true);
            expect(response.body).toHaveProperty('message');

            // Verify data was reset
            const afterReset = proxyServer.costTracker.getStats('today');
            expect(afterReset.requests).toBe(0);
            expect(afterReset.cost).toBe(0);
        });

        test('should require authentication for reset', async () => {
            const http = require('http');
            const response = await new Promise((resolve) => {
                const req = http.request({
                    hostname: '127.0.0.1',
                    port: port,
                    path: '/admin/cost-tracking/reset',
                    method: 'POST'
                }, resolve);
                req.end();
            });

            expect(response.statusCode).toBe(401);
        });
    });

    describe('COST-09: Audit entries for config mutations', () => {
        beforeAll(() => {
            // Enable audit log for this test group
            proxyServer.config.security = proxyServer.config.security || {};
            proxyServer.config.security.auditLog = { enabled: true };
        });

        test('rates update creates cost_tracking_rates_updated audit entry', async () => {
            const sizeBefore = proxyServer._auditLog.size;

            await makeRequest('POST', '/admin/cost-tracking/config', {
                rates: { inputTokenPer1M: 8.00 }
            });

            const entries = proxyServer._auditLog.toArray();
            const ratesEntries = entries.filter(e => e.event === 'cost_tracking_rates_updated');
            const ratesEntry = ratesEntries[ratesEntries.length - 1];
            expect(ratesEntry).toBeDefined();
            expect(ratesEntry.changes).toHaveProperty('inputTokenPer1M', 8.00);
            expect(ratesEntry.ip).toBeDefined();
            expect(ratesEntry.timestamp).toBeDefined();
            expect(proxyServer._auditLog.size).toBeGreaterThan(sizeBefore);
        });

        test('budget update creates cost_tracking_budget_updated audit entry', async () => {
            await makeRequest('POST', '/admin/cost-tracking/config', {
                budget: { daily: 300, monthly: 9000 }
            });

            const entries = proxyServer._auditLog.toArray();
            const budgetEntries = entries.filter(e => e.event === 'cost_tracking_budget_updated');
            const budgetEntry = budgetEntries[budgetEntries.length - 1];
            expect(budgetEntry).toBeDefined();
            expect(budgetEntry.changes.daily).toBe(300);
            expect(budgetEntry.changes.monthly).toBe(9000);
        });

        test('model rates update creates cost_tracking_model_rates_updated audit entry', async () => {
            const sizeBefore = proxyServer._auditLog.size;

            await makeRequest('POST', '/admin/cost-tracking/config', {
                modelRates: { 'glm-4.7': { inputTokenPer1M: 0.60 } }
            });

            const entries = proxyServer._auditLog.toArray();
            // Find the LATEST model rates entry (after sizeBefore)
            const modelEntries = entries.filter(e => e.event === 'cost_tracking_model_rates_updated');
            const modelEntry = modelEntries[modelEntries.length - 1];
            expect(modelEntry).toBeDefined();
            expect(modelEntry.models).toContain('glm-4.7');
            expect(proxyServer._auditLog.size).toBeGreaterThan(sizeBefore);
        });

        test('saveDebounceMs update creates cost_tracking_config_updated audit entry', async () => {
            await makeRequest('POST', '/admin/cost-tracking/config', {
                saveDebounceMs: 15000
            });

            const entries = proxyServer._auditLog.toArray();
            const configEntries = entries.filter(e => e.event === 'cost_tracking_config_updated');
            const configEntry = configEntries[configEntries.length - 1];
            expect(configEntry).toBeDefined();
            expect(configEntry.changes.saveDebounceMs).toBe(15000);
        });

        test('all 4 cost-tracking audit event types present in audit log', () => {
            const entries = proxyServer._auditLog.toArray();
            const costEvents = entries.filter(e => e.event.startsWith('cost_tracking_'));
            const eventTypes = [...new Set(costEvents.map(e => e.event))];
            expect(eventTypes).toContain('cost_tracking_rates_updated');
            expect(eventTypes).toContain('cost_tracking_budget_updated');
            expect(eventTypes).toContain('cost_tracking_model_rates_updated');
            expect(eventTypes).toContain('cost_tracking_config_updated');
        });
    });
});
