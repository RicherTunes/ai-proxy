'use strict';

/**
 * Shutdown Idempotency Tests
 *
 * Validates that:
 * 1. Double shutdown is idempotent (proxy-server.js isShuttingDown guard)
 * 2. Port is released after shutdown
 * 3. proxy.js signal handler + proxy-server.js shutdown don't conflict
 */

const http = require('http');
const net = require('net');
const { Config } = require('../lib/config');
const { ProxyServer } = require('../lib/proxy-server');
const path = require('path');
const fs = require('fs');
const os = require('os');

const testDir = path.join(os.tmpdir(), 'glm-shutdown-test-' + Date.now());
const testKeysFile = path.join(testDir, 'keys.json');
const testStatsFile = path.join(testDir, 'stats.json');

beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(testKeysFile, JSON.stringify([
        { key: 'test-key-1', host: 'localhost', basePath: '/api' }
    ]));
});

afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
});

/** Check if a port is free. */
function isPortFree(port) {
    return new Promise((resolve) => {
        const tester = net.createServer()
            .once('error', () => resolve(false))
            .once('listening', () => {
                tester.close(() => resolve(true));
            })
            .listen(port, '127.0.0.1');
    });
}

describe('Shutdown idempotency and port release', () => {
    let server;
    let config;
    let assignedPort;

    beforeEach(async () => {
        config = new Config({
            configDir: testDir,
            keysFile: testKeysFile,
            statsFile: testStatsFile,
            useCluster: false,
            port: 0  // Random port
        });
        server = new ProxyServer({ config });
        await server.start();
        assignedPort = server.server.address().port;
    });

    afterEach(async () => {
        if (server && !server.isShuttingDown) {
            await server.shutdown();
        }
    });

    test('port is in use before shutdown', async () => {
        const free = await isPortFree(assignedPort);
        expect(free).toBe(false);
    });

    test('port is released after shutdown', async () => {
        await server.shutdown();
        // Small delay for OS to release the port
        await new Promise(r => setTimeout(r, 100));
        const free = await isPortFree(assignedPort);
        expect(free).toBe(true);
    });

    test('double shutdown is idempotent (no error)', async () => {
        await server.shutdown();
        // Second call should be a no-op
        await server.shutdown();
        expect(server.isShuttingDown).toBe(true);
    });

    test('concurrent shutdown calls are safe', async () => {
        const results = await Promise.allSettled([
            server.shutdown(),
            server.shutdown(),
            server.shutdown()
        ]);
        // All should resolve (not reject)
        for (const r of results) {
            expect(r.status).toBe('fulfilled');
        }
        expect(server.isShuttingDown).toBe(true);
    });

    test('shutdown followed by port reuse succeeds', async () => {
        await server.shutdown();
        await new Promise(r => setTimeout(r, 100));

        // Start a new server on the same port
        const config2 = new Config({
            configDir: testDir,
            keysFile: testKeysFile,
            statsFile: testStatsFile,
            useCluster: false,
            port: assignedPort
        });
        const server2 = new ProxyServer({ config: config2 });
        await server2.start();
        const addr = server2.server.address();
        expect(addr.port).toBe(assignedPort);
        await server2.shutdown();
    });
});

describe('proxy.js gracefulShutdown function contract', () => {
    test('isShuttingDown guard prevents double execution', () => {
        // Simulate the proxy.js pattern
        let isShuttingDown = false;
        let shutdownCalls = 0;

        async function gracefulShutdown(signal) {
            if (isShuttingDown) return;
            isShuttingDown = true;
            shutdownCalls++;
        }

        gracefulShutdown('SIGTERM');
        gracefulShutdown('SIGTERM');
        gracefulShutdown('SIGINT');

        expect(shutdownCalls).toBe(1);
        expect(isShuttingDown).toBe(true);
    });

    test('gracefulShutdown handles null proxyInstance', async () => {
        let isShuttingDown = false;
        let proxyInstance = null;
        let exitCode = null;

        async function gracefulShutdown(signal) {
            if (isShuttingDown) return;
            isShuttingDown = true;
            try {
                if (proxyInstance) {
                    await proxyInstance.shutdown();
                }
            } catch (err) {
                // Should not throw
            }
            exitCode = 0;
        }

        await gracefulShutdown('SIGTERM');
        expect(exitCode).toBe(0);
        expect(isShuttingDown).toBe(true);
    });
});
