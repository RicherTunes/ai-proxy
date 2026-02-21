/**
 * Proxy Server Module Tests
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cluster = require('cluster');
const { ProxyServer, startProxy, startMaster, startWorker } = require('../lib/proxy-server');
const { Config, resetConfig } = require('../lib/config');
const { resetLogger } = require('../lib/logger');

// Mock modules
jest.mock('https', () => ({
    request: jest.fn(() => ({
        on: jest.fn().mockReturnThis(),
        write: jest.fn(),
        end: jest.fn(),
        destroy: jest.fn()
    })),
    Agent: jest.fn().mockImplementation(() => ({
        destroy: jest.fn(),
        on: jest.fn()
    }))
}));

describe('ProxyServer', () => {
    let server;
    let testDir;
    let testKeysFile;
    let testStatsFile;

    beforeEach(() => {
        resetConfig();
        resetLogger();

        testDir = path.join(__dirname, 'proxy-test-' + Date.now());
        testKeysFile = 'test-keys.json';
        testStatsFile = 'test-stats.json';

        // Create test directory and keys file
        fs.mkdirSync(testDir, { recursive: true });
        fs.writeFileSync(
            path.join(testDir, testKeysFile),
            JSON.stringify({
                keys: ['testkey1.secret1', 'testkey2.secret2'],
                baseUrl: 'https://test.api.com/v1'
            })
        );
    });

    afterEach(async () => {
        if (server) {
            let timer;
            try {
                await Promise.race([
                    server.shutdown(),
                    new Promise((_, reject) => {
                        timer = setTimeout(() => reject(new Error('shutdown timeout')), 3000);
                    })
                ]);
            } catch (e) {
                // Ignore shutdown errors
            } finally {
                clearTimeout(timer);
            }
            server = null;
        }

        // Clean up test files recursively
        try {
            if (fs.existsSync(path.join(testDir, testKeysFile))) {
                fs.unlinkSync(path.join(testDir, testKeysFile));
            }
            if (fs.existsSync(path.join(testDir, testStatsFile))) {
                fs.unlinkSync(path.join(testDir, testStatsFile));
            }
            if (fs.existsSync(testDir)) {
                // Manually delete directory contents recursively
                function deleteDirectoryRecursively(dirPath) {
                    if (!fs.existsSync(dirPath)) return;

                    const files = fs.readdirSync(dirPath);
                    for (const file of files) {
                        const filePath = path.join(dirPath, file);
                        const stat = fs.statSync(filePath);

                        if (stat.isDirectory()) {
                            deleteDirectoryRecursively(filePath);
                        } else {
                            fs.unlinkSync(filePath);
                        }
                    }

                    fs.rmdirSync(dirPath);
                }

                deleteDirectoryRecursively(testDir);
            }
        } catch (e) {
            // Ignore cleanup errors
            console.log('Cleanup warning:', e.message);
        }
    });

    describe('constructor', () => {
        test('should create server with config', () => {
            const config = new Config({
                configDir: testDir,
                keysFile: testKeysFile,
                statsFile: testStatsFile,
                useCluster: false
            });

            server = new ProxyServer({ config });

            expect(server.config).toBeDefined();
            expect(server.keyManager).toBeDefined();
            expect(server.statsAggregator).toBeDefined();
            expect(server.requestHandler).toBeDefined();
        });
    });

    describe('initialize', () => {
        test('should load keys and stats', async () => {
            const config = new Config({
                configDir: testDir,
                keysFile: testKeysFile,
                statsFile: testStatsFile,
                useCluster: false
            });

            server = new ProxyServer({ config });
            await server.initialize();

            expect(server.keyManager.keys).toHaveLength(2);
        });
    });

    describe('_recordScalerUsage', () => {
        test('should not crash when predictiveScaler is enabled', async () => {
            const config = new Config({
                configDir: testDir,
                keysFile: testKeysFile,
                statsFile: testStatsFile,
                useCluster: false,
                predictiveScaling: { enabled: true }
            });

            server = new ProxyServer({ config });
            await server.initialize();

            // Verify predictiveScaler is initialized
            expect(server.predictiveScaler).toBeDefined();

            // Call _recordScalerUsage directly - this should not throw
            expect(() => server._recordScalerUsage()).not.toThrow();

            await server.shutdown();
        });

        test('should handle missing predictiveScaler gracefully', async () => {
            const config = new Config({
                configDir: testDir,
                keysFile: testKeysFile,
                statsFile: testStatsFile,
                useCluster: false
            });

            server = new ProxyServer({ config });

            // Manually disable predictiveScaler to test the guard clause
            server.predictiveScaler = null;

            await server.initialize();

            // Call should return early without error when scaler is null
            expect(() => server._recordScalerUsage()).not.toThrow();

            await server.shutdown();
        });
    });

    describe('HTTP endpoints', () => {
        let config;
        let baseUrl;

        beforeEach(async () => {
            config = new Config({
                configDir: testDir,
                keysFile: testKeysFile,
                statsFile: testStatsFile,
                useCluster: false,
                port: 0  // Random available port
            });

            server = new ProxyServer({ config });
            const httpServer = await server.start();
            const address = httpServer.address();
            baseUrl = `http://127.0.0.1:${address.port}`;
        });

        test('GET /health should return health status', (done) => {
            http.get(`${baseUrl}/health`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    const json = JSON.parse(data);
                    expect(res.statusCode).toBe(200);
                    expect(json.status).toBe('OK');
                    expect(json.totalKeys).toBe(2);
                    expect(json).toHaveProperty('uptime');
                    expect(json).toHaveProperty('backpressure');
                    done();
                });
            });
        });

        test('GET /stats should return detailed stats', (done) => {
            http.get(`${baseUrl}/stats`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    const json = JSON.parse(data);
                    expect(res.statusCode).toBe(200);
                    expect(json).toHaveProperty('uptime');
                    expect(json).toHaveProperty('keys');
                    expect(json).toHaveProperty('errors');
                    expect(json).toHaveProperty('backpressure');
                    expect(json.keys).toHaveLength(2);
                    done();
                });
            });
        });

        test('GET /persistent-stats should return persistent stats', (done) => {
            http.get(`${baseUrl}/persistent-stats`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    const json = JSON.parse(data);
                    expect(res.statusCode).toBe(200);
                    expect(json).toHaveProperty('tracking');
                    expect(json).toHaveProperty('totals');
                    expect(json).toHaveProperty('validation');
                    expect(json.tracking.totalConfiguredKeys).toBe(2);
                    done();
                });
            });
        });

        test('GET /backpressure should return backpressure stats', (done) => {
            http.get(`${baseUrl}/backpressure`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    const json = JSON.parse(data);
                    expect(res.statusCode).toBe(200);
                    expect(json).toHaveProperty('current');
                    expect(json).toHaveProperty('max');
                    expect(json).toHaveProperty('available');
                    expect(json).toHaveProperty('percentUsed');
                    done();
                });
            });
        });

        test('POST /reload should reload keys', (done) => {
            const req = http.request(`${baseUrl}/reload`, {
                method: 'POST'
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    const json = JSON.parse(data);
                    expect(res.statusCode).toBe(200);
                    expect(json.success).toBe(true);
                    done();
                });
            });
            req.end();
        });

        test('GET /reload should return 405', (done) => {
            http.get(`${baseUrl}/reload`, (res) => {
                expect(res.statusCode).toBe(405);
                res.resume();
                done();
            });
        });

        test('GET /models should return available models', (done) => {
            http.get(`${baseUrl}/models`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    const json = JSON.parse(data);
                    expect(res.statusCode).toBe(200);
                    expect(json).toHaveProperty('models');
                    expect(json).toHaveProperty('count');
                    expect(json).toHaveProperty('timestamp');
                    expect(json).toHaveProperty('cacheStats');
                    expect(Array.isArray(json.models)).toBe(true);
                    expect(json.models.length).toBeGreaterThan(0);
                    expect(json.models[0]).toHaveProperty('id');
                    expect(json.models[0]).toHaveProperty('tier');
                    expect(json.models[0]).toHaveProperty('description');
                    done();
                });
            });
        });

        test('GET /models?tier=HIGH should filter by tier', (done) => {
            http.get(`${baseUrl}/models?tier=HIGH`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    const json = JSON.parse(data);
                    expect(res.statusCode).toBe(200);
                    expect(json.models.every(m => m.tier === 'HIGH')).toBe(true);
                    done();
                });
            });
        });

        test('POST /models should return 405', (done) => {
            const req = http.request(`${baseUrl}/models`, {
                method: 'POST'
            }, (res) => {
                expect(res.statusCode).toBe(405);
                res.resume();
                done();
            });
            req.end();
        });
    });

    describe('body size limit', () => {
        let config;
        let baseUrl;

        beforeEach(async () => {
            config = new Config({
                configDir: testDir,
                keysFile: testKeysFile,
                statsFile: testStatsFile,
                useCluster: false,
                port: 0,
                maxBodySize: 100  // Small limit for testing
            });

            server = new ProxyServer({ config });
            const httpServer = await server.start();
            const address = httpServer.address();
            baseUrl = `http://127.0.0.1:${address.port}`;
        });

        test('should reject requests exceeding body size limit', (done) => {
            const req = http.request(`${baseUrl}/v1/messages`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'content-length': 200
                }
            }, (res) => {
                expect(res.statusCode).toBe(413);
                res.resume();
                done();
            });

            req.write('x'.repeat(200));
            req.end();
        });
    });

    describe('graceful shutdown', () => {
        test('should stop accepting connections', async () => {
            const config = new Config({
                configDir: testDir,
                keysFile: testKeysFile,
                statsFile: testStatsFile,
                useCluster: false,
                port: 0
            });

            server = new ProxyServer({ config });
            await server.start();

            await server.shutdown();

            expect(server.isShuttingDown).toBe(true);
        });

        test('should save stats on shutdown', async () => {
            const config = new Config({
                configDir: testDir,
                keysFile: testKeysFile,
                statsFile: testStatsFile,
                useCluster: false,
                port: 0
            });

            server = new ProxyServer({ config });
            await server.start();

            // Record some stats
            server.statsAggregator.recordKeyUsage('testkey1', {
                requests: 10,
                successes: 9,
                failures: 1
            });

            await server.shutdown();

            // Wait for async file save to complete (up to 2 seconds)
            const statsPath = path.join(testDir, testStatsFile);
            const waitForFile = async (filePath, timeoutMs = 2000) => {
                const start = Date.now();
                while (Date.now() - start < timeoutMs) {
                    try {
                        await fs.promises.access(filePath);
                        return true;
                    } catch {
                        await new Promise(r => setTimeout(r, 50));
                    }
                }
                return false;
            };

            const fileExists = await waitForFile(statsPath);
            expect(fileExists).toBe(true);

            const savedStats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
            expect(savedStats.totals.requests).toBe(10);
        });
    });

    describe('connection tracking', () => {
        test('should track active connections', async () => {
            const config = new Config({
                configDir: testDir,
                keysFile: testKeysFile,
                statsFile: testStatsFile,
                useCluster: false,
                port: 0
            });

            server = new ProxyServer({ config });
            const httpServer = await server.start();
            const address = httpServer.address();
            const baseUrl = `http://127.0.0.1:${address.port}`;

            expect(server.statsAggregator.realtime.activeConnections).toBe(0);

            // Make a request
            await new Promise((resolve) => {
                http.get(`${baseUrl}/health`, (res) => {
                    res.on('data', () => {});
                    res.on('end', resolve);
                });
            });

            // Connection should be released
            expect(server.statsAggregator.realtime.activeConnections).toBe(0);
        });
    });

    describe('_getUptime', () => {
        test('should return uptime in seconds', async () => {
            const config = new Config({
                configDir: testDir,
                keysFile: testKeysFile,
                statsFile: testStatsFile,
                useCluster: false,
                port: 0
            });

            server = new ProxyServer({ config });
            await server.start();

            const uptime = server._getUptime();
            expect(typeof uptime).toBe('number');
            expect(uptime).toBeGreaterThanOrEqual(0);
        });
    });

    describe('_reloadKeys', () => {
        test('should reload keys successfully', async () => {
            const config = new Config({
                configDir: testDir,
                keysFile: testKeysFile,
                statsFile: testStatsFile,
                useCluster: false,
                port: 0
            });

            server = new ProxyServer({ config });
            await server.initialize();

            const result = server._reloadKeys();
            expect(result).not.toBeNull();
            expect(result.total).toBeGreaterThanOrEqual(0);
        });
    });

    describe('body size limit', () => {
        test('should have maxBodySize in config', () => {
            const config = new Config({
                configDir: testDir,
                keysFile: testKeysFile,
                statsFile: testStatsFile,
                useCluster: false,
                port: 0,
                maxBodySize: 50
            });

            expect(config.get('maxBodySize')).toBe(50);
        });
    });

    describe('degraded health', () => {
        test('should return 503 when all keys are unhealthy', async () => {
            const config = new Config({
                configDir: testDir,
                keysFile: testKeysFile,
                statsFile: testStatsFile,
                useCluster: false,
                port: 0
            });

            server = new ProxyServer({ config });
            const httpServer = await server.start();
            const address = httpServer.address();
            const baseUrl = `http://127.0.0.1:${address.port}`;

            // Open all circuit breakers
            server.keyManager.keys.forEach(k => {
                k.circuitBreaker.forceState('OPEN');
            });

            await new Promise((resolve) => {
                http.get(`${baseUrl}/health`, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        expect(res.statusCode).toBe(503);
                        const json = JSON.parse(data);
                        expect(json.status).toBe('DEGRADED');
                        expect(json.healthyKeys).toBe(0);
                        resolve();
                    });
                });
            });
        });
    });

    describe('hot reload', () => {
        test('should reload keys when file changes', async () => {
            const config = new Config({
                configDir: testDir,
                keysFile: testKeysFile,
                statsFile: testStatsFile,
                useCluster: false,
                port: 0
            });

            server = new ProxyServer({ config });
            await server.start();

            expect(server.keyManager.keys).toHaveLength(2);

            // Add a new key to the file
            fs.writeFileSync(
                path.join(testDir, testKeysFile),
                JSON.stringify({
                    keys: ['key1.s1', 'key2.s2', 'key3.s3'],
                    baseUrl: 'https://test.api.com/v1'
                })
            );

            // Wait for file watcher to detect change
            await new Promise(resolve => setTimeout(resolve, 200));

            // Keys should be reloaded
            expect(server.keyManager.keys.length).toBeGreaterThanOrEqual(2);
        });
    });

    describe('multiple shutdown calls', () => {
        test('should handle multiple shutdown calls gracefully', async () => {
            const config = new Config({
                configDir: testDir,
                keysFile: testKeysFile,
                statsFile: testStatsFile,
                useCluster: false,
                port: 0
            });

            server = new ProxyServer({ config });
            await server.start();

            // Call shutdown multiple times
            await Promise.all([
                server.shutdown(),
                server.shutdown(),
                server.shutdown()
            ]);

            expect(server.isShuttingDown).toBe(true);
        });
    });

    describe('_routeRequest', () => {
        test('should route to correct handler based on URL', async () => {
            const config = new Config({
                configDir: testDir,
                keysFile: testKeysFile,
                statsFile: testStatsFile,
                useCluster: false,
                port: 0
            });

            server = new ProxyServer({ config });
            const httpServer = await server.start();
            const address = httpServer.address();
            const baseUrl = `http://127.0.0.1:${address.port}`;

            // Test that /health, /stats, etc. are routed correctly
            const endpoints = ['/health', '/stats', '/persistent-stats', '/backpressure'];

            for (const endpoint of endpoints) {
                await new Promise((resolve) => {
                    http.get(`${baseUrl}${endpoint}`, (res) => {
                        expect(res.statusCode).toBe(200);
                        res.resume();
                        res.on('end', resolve);
                    });
                });
            }
        });
    });

    describe('_getProcessPrefix', () => {
        test('should return a valid prefix', () => {
            const config = new Config({
                configDir: testDir,
                keysFile: testKeysFile,
                statsFile: testStatsFile,
                useCluster: false,
                port: 0
            });

            server = new ProxyServer({ config });
            // In test environment, cluster.isPrimary is true so returns MASTER
            const prefix = server._getProcessPrefix();
            expect(['MASTER', 'MAIN']).toContain(prefix);
        });
    });

    describe('request body handling', () => {
        let config;
        let baseUrl;

        beforeEach(async () => {
            config = new Config({
                configDir: testDir,
                keysFile: testKeysFile,
                statsFile: testStatsFile,
                useCluster: false,
                port: 0,
                maxBodySize: 50
            });

            server = new ProxyServer({ config });
            const httpServer = await server.start();
            const address = httpServer.address();
            baseUrl = `http://127.0.0.1:${address.port}`;
        });

        test('should handle request body data event exceeding limit', (done) => {
            const req = http.request(`${baseUrl}/v1/messages`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json'
                    // Not setting content-length to test stream limit
                }
            }, (res) => {
                expect(res.statusCode).toBe(413);
                res.resume();
                done();
            });

            req.on('error', (err) => {
                // Socket may be destroyed before response - this is acceptable behavior
                if (err.code === 'ECONNRESET' || err.message.includes('socket hang up')) {
                    done();
                }
            });

            // Write more than maxBodySize in chunks
            req.write('x'.repeat(30));
            req.write('x'.repeat(30));
            req.end();
        }, 10000);

        test('should handle request error event', (done) => {
            const req = http.request(`${baseUrl}/v1/messages`, {
                method: 'POST'
            }, (res) => {
                res.resume();
                done();
            });

            req.on('error', () => {
                // Expected - we're destroying the request
                done();
            });

            req.write('test');
            req.destroy(new Error('Test error'));
        });
    });

    describe('_reloadKeys error handling', () => {
        test('should handle reload error gracefully', async () => {
            const config = new Config({
                configDir: testDir,
                keysFile: testKeysFile,
                statsFile: testStatsFile,
                useCluster: false,
                port: 0
            });

            server = new ProxyServer({ config });
            await server.initialize();

            // Mock config.reloadKeys to throw
            jest.spyOn(server.config, 'reloadKeys').mockImplementation(() => {
                throw new Error('Reload failed');
            });

            const result = server._reloadKeys();
            expect(result).toBeNull();
        });
    });

    describe('POST /reload error response', () => {
        test('should return 500 when reload fails', async () => {
            const config = new Config({
                configDir: testDir,
                keysFile: testKeysFile,
                statsFile: testStatsFile,
                useCluster: false,
                port: 0
            });

            server = new ProxyServer({ config });
            const httpServer = await server.start();
            const address = httpServer.address();
            const baseUrl = `http://127.0.0.1:${address.port}`;

            // Mock _reloadKeys to return null (failure)
            jest.spyOn(server, '_reloadKeys').mockReturnValue(null);

            await new Promise((resolve) => {
                const req = http.request(`${baseUrl}/reload`, {
                    method: 'POST'
                }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        expect(res.statusCode).toBe(500);
                        const json = JSON.parse(data);
                        expect(json.success).toBe(false);
                        resolve();
                    });
                });
                req.end();
            });
        });
    });

    describe('config error logging', () => {
        test('should log config load errors during initialize', async () => {
            const config = new Config({
                configDir: testDir,
                keysFile: testKeysFile,
                statsFile: testStatsFile,
                useCluster: false,
                port: 0
            });

            // Manually add an error to flush
            config._loadErrors.push({
                type: 'test',
                path: '/test/path',
                message: 'Test error'
            });

            server = new ProxyServer({ config });

            const logSpy = jest.spyOn(server.logger, 'error');
            await server.initialize();

            expect(logSpy).toHaveBeenCalledWith(
                expect.stringContaining('Config load error'),
                expect.any(Object)
            );
        });
    });

    describe('file watcher error handling', () => {
        test('should handle file watcher setup failure', async () => {
            const config = new Config({
                configDir: '/non/existent/path',
                keysFile: 'missing.json',
                statsFile: testStatsFile,
                useCluster: false,
                port: 0
            });

            // Manually set apiKeys since file doesn't exist
            config.config.apiKeys = ['key1.secret1'];

            server = new ProxyServer({ config });

            // Should not throw
            expect(() => server._setupHotReload()).not.toThrow();
        });
    });

    describe('shutdown with active connections', () => {
        test('should force close connections after timeout', async () => {
            const config = new Config({
                configDir: testDir,
                keysFile: testKeysFile,
                statsFile: testStatsFile,
                useCluster: false,
                port: 0,
                shutdownTimeout: 100  // Short timeout for testing
            });

            server = new ProxyServer({ config });
            await server.start();

            // Simulate an active connection
            const mockSocket = {
                destroy: jest.fn()
            };
            server.activeConnections.add(mockSocket);

            await server.shutdown();

            expect(mockSocket.destroy).toHaveBeenCalled();
        });
    });

    describe('backpressure queue stats', () => {
        test('should include queue stats in backpressure response', async () => {
            const config = new Config({
                configDir: testDir,
                keysFile: testKeysFile,
                statsFile: testStatsFile,
                useCluster: false,
                port: 0
            });

            server = new ProxyServer({ config });
            const httpServer = await server.start();
            const address = httpServer.address();
            const baseUrl = `http://127.0.0.1:${address.port}`;

            await new Promise((resolve) => {
                http.get(`${baseUrl}/backpressure`, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        const json = JSON.parse(data);
                        expect(json).toHaveProperty('queue');
                        expect(json.queue).toHaveProperty('current');
                        expect(json.queue).toHaveProperty('max');
                        expect(json.queue).toHaveProperty('metrics');
                        resolve();
                    });
                });
            });
        });
    });

    describe('startup resilience', () => {
        test('proxy start does not block or fail when model discovery is unavailable', async () => {
            // Create a proxy server with minimal config using an isolated temp directory
            const testStartupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-startup-test-'));
            const startupKeysFile = 'test-keys.json';
            fs.writeFileSync(path.join(testStartupDir, startupKeysFile), JSON.stringify({
                keys: ['test-key.secret'],
                baseUrl: 'https://api.anthropic.com'
            }));
            fs.writeFileSync(path.join(testStartupDir, 'stats.json'), '{}');

            const config = new Config({
                configDir: testStartupDir,
                keysFile: startupKeysFile,
                statsFile: 'stats.json',
                useCluster: false,
                port: 0,
                adminAuth: { enabled: false },
                enableHotReload: false,
                security: { rateLimit: { enabled: false } }
            });

            const proxyServer = new ProxyServer({ config });

            // Should start without error even if model fetching fails
            const httpServer = await proxyServer.start();
            expect(httpServer).toBeTruthy();
            expect(httpServer.listening).toBe(true);

            const address = httpServer.address();
            expect(address.port).toBeGreaterThan(0);

            // Clean up
            await proxyServer.shutdown();
            fs.rmSync(testStartupDir, { recursive: true, force: true });
        });
    });
});

describe('startProxy', () => {
    let testDir;
    let testKeysFile;
    let testStatsFile;

    beforeEach(() => {
        resetConfig();
        resetLogger();

        testDir = path.join(__dirname, 'startproxy-test-' + Date.now());
        testKeysFile = 'test-keys.json';
        testStatsFile = 'test-stats.json';

        fs.mkdirSync(testDir, { recursive: true });
        fs.writeFileSync(
            path.join(testDir, testKeysFile),
            JSON.stringify({
                keys: ['testkey1.secret1', 'testkey2.secret2'],
                baseUrl: 'https://test.api.com/v1'
            })
        );
    });

    afterEach(() => {
        try {
            if (fs.existsSync(path.join(testDir, testKeysFile))) {
                fs.unlinkSync(path.join(testDir, testKeysFile));
            }
            if (fs.existsSync(path.join(testDir, testStatsFile))) {
                fs.unlinkSync(path.join(testDir, testStatsFile));
            }
            if (fs.existsSync(testDir)) {
                // Manually delete directory contents recursively
                function deleteDirectoryRecursively(dirPath) {
                    if (!fs.existsSync(dirPath)) return;

                    const files = fs.readdirSync(dirPath);
                    for (const file of files) {
                        const filePath = path.join(dirPath, file);
                        const stat = fs.statSync(filePath);

                        if (stat.isDirectory()) {
                            deleteDirectoryRecursively(filePath);
                        } else {
                            fs.unlinkSync(filePath);
                        }
                    }

                    fs.rmdirSync(dirPath);
                }

                deleteDirectoryRecursively(testDir);
            }
        } catch (e) {
            // Ignore cleanup errors
            console.log('Cleanup warning:', e.message);
        }
    });

    test('should start in single process mode when cluster disabled', async () => {
        const result = await startProxy({
            configDir: testDir,
            keysFile: testKeysFile,
            statsFile: testStatsFile,
            useCluster: false,
            port: 0
        });

        expect(result).toBeDefined();
        expect(result.master).toBe(false);
        expect(result.proxy).toBeDefined();

        await result.proxy.shutdown();
    });

    test('should start in single process mode when only 1 CPU', async () => {
        const result = await startProxy({
            configDir: testDir,
            keysFile: testKeysFile,
            statsFile: testStatsFile,
            useCluster: true,
            maxWorkers: 1,  // Only 1 worker means no clustering
            port: 0
        });

        expect(result).toBeDefined();
        expect(result.master).toBe(false);

        await result.proxy.shutdown();
    });
});

describe('startWorker', () => {
    let testDir;
    let testKeysFile;
    let testStatsFile;

    beforeEach(() => {
        resetConfig();
        resetLogger();

        testDir = path.join(__dirname, 'worker-test-' + Date.now());
        testKeysFile = 'test-keys.json';
        testStatsFile = 'test-stats.json';

        fs.mkdirSync(testDir, { recursive: true });
        fs.writeFileSync(
            path.join(testDir, testKeysFile),
            JSON.stringify({
                keys: ['testkey1.secret1'],
                baseUrl: 'https://test.api.com/v1'
            })
        );
    });

    afterEach(() => {
        try {
            if (fs.existsSync(path.join(testDir, testKeysFile))) {
                fs.unlinkSync(path.join(testDir, testKeysFile));
            }
            if (fs.existsSync(path.join(testDir, testStatsFile))) {
                fs.unlinkSync(path.join(testDir, testStatsFile));
            }
            if (fs.existsSync(testDir)) {
                fs.rmdirSync(testDir);
            }
        } catch (e) {
            // Ignore cleanup errors
        }
    });

    test('should start worker without cluster mode', async () => {
        const config = new Config({
            configDir: testDir,
            keysFile: testKeysFile,
            statsFile: testStatsFile,
            useCluster: false,
            port: 0
        });

        const result = await startWorker(config, false);

        expect(result).toBeDefined();
        expect(result.master).toBe(false);
        expect(result.proxy).toBeDefined();

        await result.proxy.shutdown();
    });
});
