/**
 * SSE pool-status event tests
 *
 * Tests the pool-status named SSE event broadcast on /requests/stream.
 * These events provide live pool status data every 3 seconds when
 * at least one SSE client is connected.
 */

const { ProxyServer } = require('../lib/proxy-server');
const { Config } = require('../lib/config');
const { EventSource } = require('eventsource');
const path = require('path');
const os = require('os');
const fs = require('fs');

/**
 * Helper: wait for one pool-status named SSE event on /requests/stream.
 * Returns parsed JSON data or null on timeout.
 */
function waitForPoolStatus(url, timeoutMs = 5000, tracker = null) {
    return new Promise((resolve) => {
        const es = new EventSource(url);
        if (tracker) tracker.push(es);
        const timer = setTimeout(() => { es.close(); resolve(null); }, timeoutMs);
        es.addEventListener('pool-status', (e) => {
            clearTimeout(timer);
            es.close();
            try { resolve(JSON.parse(e.data)); } catch { resolve(null); }
        });
        es.onerror = () => { clearTimeout(timer); es.close(); resolve(null); };
    });
}

/**
 * Helper: collect N pool-status events.
 */
function collectPoolStatusEvents(url, count, timeoutMs = 10000, tracker = null) {
    return new Promise((resolve) => {
        const events = [];
        const es = new EventSource(url);
        if (tracker) tracker.push(es);
        const timer = setTimeout(() => { es.close(); resolve(events); }, timeoutMs);
        es.addEventListener('pool-status', (e) => {
            try { events.push(JSON.parse(e.data)); } catch { /* skip */ }
            if (events.length >= count) {
                clearTimeout(timer);
                es.close();
                resolve(events);
            }
        });
        es.onerror = () => { clearTimeout(timer); es.close(); resolve(events); };
    });
}

describe('SSE pool-status events', () => {
    let proxyServer, proxyUrl, testDir;
    let activeEventSources = [];

    beforeAll(async () => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-sse-test-'));
        const keysFile = 'test-keys.json';
        fs.writeFileSync(path.join(testDir, keysFile), JSON.stringify({
            keys: ['test-key.secret'],
            baseUrl: 'https://api.anthropic.com'
        }));
        fs.writeFileSync(path.join(testDir, 'test-stats.json'), '{}');

        const config = new Config({
            configDir: testDir,
            keysFile,
            statsFile: 'test-stats.json',
            useCluster: false,
            port: 0,
            adminAuth: { enabled: false },
            enableHotReload: false,
            security: { rateLimit: { enabled: false } },
            modelRouting: {
                version: '2.0',
                enabled: true,
                tiers: {
                    heavy: { models: ['model-a'], strategy: 'balanced' },
                    light: { models: ['model-b'], strategy: 'quality' }
                }
            }
        });

        proxyServer = new ProxyServer({ config });
        const server = await proxyServer.start();
        proxyUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterEach(async () => {
        // Close ALL EventSource connections created in this test
        for (const es of activeEventSources) {
            if (es.readyState !== EventSource.CLOSED) {
                es.close();
            }
        }
        activeEventSources.length = 0;

        // Drain microtask queue to allow EventSource internal cleanup to complete
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setTimeout(resolve, 0));
    });

    afterAll(async () => {
        await proxyServer.shutdown();
        // Grace period for EventSource internal cleanup timers
        await new Promise(resolve => setTimeout(resolve, 100));
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    test('pool-status event fires within 4 seconds of SSE connect', async () => {
        const event = await waitForPoolStatus(`${proxyUrl}/requests/stream`, 4500, activeEventSources);
        expect(event).not.toBeNull();
        expect(event.type).toBe('pool-status');
    }, 6000);

    test('pool-status event matches schema {seq, ts, schemaVersion, type, pools}', async () => {
        const event = await waitForPoolStatus(`${proxyUrl}/requests/stream`, 5000, activeEventSources);
        expect(event).not.toBeNull();
        expect(typeof event.seq).toBe('number');
        expect(typeof event.ts).toBe('number');
        expect(event.schemaVersion).toBe(1);
        expect(event.type).toBe('pool-status');
        expect(typeof event.pools).toBe('object');
        // Should have the configured tiers
        expect(event.pools).toHaveProperty('heavy');
        expect(event.pools).toHaveProperty('light');
    }, 7000);

    test('pool-status pools contain model entries with required fields', async () => {
        const event = await waitForPoolStatus(`${proxyUrl}/requests/stream`, 5000, activeEventSources);
        expect(event).not.toBeNull();
        const heavyPool = event.pools.heavy;
        expect(Array.isArray(heavyPool)).toBe(true);
        expect(heavyPool.length).toBeGreaterThan(0);

        const entry = heavyPool[0];
        expect(typeof entry.model).toBe('string');
        expect(typeof entry.inFlight).toBe('number');
        expect(typeof entry.maxConcurrency).toBe('number');
        expect(typeof entry.available).toBe('number');
    }, 7000);

    test('pool-status seq increments across events', async () => {
        const events = await collectPoolStatusEvents(`${proxyUrl}/requests/stream`, 2, 10000, activeEventSources);
        expect(events.length).toBeGreaterThanOrEqual(2);
        expect(events[1].seq).toBeGreaterThan(events[0].seq);
    }, 12000);

    test('no pool-status timer when zero SSE clients', async () => {
        // Initially no clients connected (afterAll of previous tests closes them)
        // Give a brief moment for cleanup
        await new Promise(r => setTimeout(r, 500));
        expect(proxyServer._poolStatusInterval).toBeNull();

        // Connect a client - timer should start
        const es = new EventSource(`${proxyUrl}/requests/stream`);
        activeEventSources.push(es);
        await new Promise(r => setTimeout(r, 500));
        expect(proxyServer._poolStatusInterval).not.toBeNull();

        // Disconnect - timer should stop
        es.close();
        await new Promise(r => setTimeout(r, 500));
        expect(proxyServer._poolStatusInterval).toBeNull();
    }, 5000);

    test('pool-status timer starts on first client, stops on last disconnect', async () => {
        // Connect first client
        const es1 = new EventSource(`${proxyUrl}/requests/stream`);
        activeEventSources.push(es1);
        await new Promise(r => setTimeout(r, 500));
        expect(proxyServer._poolStatusInterval).not.toBeNull();

        // Connect second client
        const es2 = new EventSource(`${proxyUrl}/requests/stream`);
        activeEventSources.push(es2);
        await new Promise(r => setTimeout(r, 300));
        expect(proxyServer._poolStatusInterval).not.toBeNull();

        // Disconnect first - timer should still run (one client left)
        es1.close();
        await new Promise(r => setTimeout(r, 500));
        expect(proxyServer._poolStatusInterval).not.toBeNull();

        // Disconnect second - timer should stop
        es2.close();
        await new Promise(r => setTimeout(r, 500));
        expect(proxyServer._poolStatusInterval).toBeNull();
    }, 6000);

    test('existing onmessage listener does NOT receive pool-status events', async () => {
        const onMessageData = [];
        const poolStatusData = [];

        await new Promise((resolve) => {
            const es = new EventSource(`${proxyUrl}/requests/stream`);
            activeEventSources.push(es);

            // onmessage only receives unnamed events (SSE spec)
            es.onmessage = (e) => {
                onMessageData.push(e.data);
            };

            // Named event listener receives pool-status events
            const fallback = setTimeout(() => { es.close(); resolve(); }, 5000);
            es.addEventListener('pool-status', (e) => {
                clearTimeout(fallback);
                try { poolStatusData.push(JSON.parse(e.data)); } catch { /* skip */ }
                es.close();
                resolve();
            });
        });

        // pool-status should have been received via addEventListener
        expect(poolStatusData.length).toBeGreaterThan(0);

        // onmessage should NOT contain any pool-status data
        const poolStatusInOnMessage = onMessageData.filter(d => {
            try { return JSON.parse(d).type === 'pool-status'; } catch { return false; }
        });
        expect(poolStatusInOnMessage.length).toBe(0);
    }, 7000);

    test('pool-status does not fire when modelRouter is null', async () => {
        const savedRouter = proxyServer.modelRouter;
        proxyServer.modelRouter = null;

        try {
            const event = await waitForPoolStatus(`${proxyUrl}/requests/stream`, 4500, activeEventSources);
            // Should NOT receive a pool-status event (or receive null on timeout)
            expect(event).toBeNull();
        } finally {
            proxyServer.modelRouter = savedRouter;
            // Clean up: ensure any SSE clients from this test disconnect
            // and timer stops
            await new Promise(r => setTimeout(r, 500));
        }
    }, 7000);
});

/**
 * SSE request-complete event tests
 *
 * Tests the request-complete named SSE event broadcast on /requests/stream.
 * These events are sent whenever a request completes (successfully or with error).
 */

describe('SSE request-complete Event Tests', () => {
    let proxyServer, proxyUrl, testDir;
    const activeEventSources = [];

    beforeAll(async () => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-sse-request-test-'));
        const keysFile = 'test-keys.json';
        fs.writeFileSync(path.join(testDir, keysFile), JSON.stringify({
            keys: ['test-key.secret'],
            baseUrl: 'https://api.anthropic.com'
        }));
        fs.writeFileSync(path.join(testDir, 'test-stats.json'), '{}');

        const config = new Config({
            configDir: testDir,
            keysFile,
            statsFile: 'test-stats.json',
            useCluster: false,
            port: 0,
            adminAuth: { enabled: false },
            enableHotReload: false,
            security: { rateLimit: { enabled: false } },
            modelRouting: {
                version: '2.0',
                enabled: true,
                tiers: {
                    heavy: { models: ['model-a'], strategy: 'balanced' },
                    light: { models: ['model-b'], strategy: 'quality' }
                }
            }
        });

        proxyServer = new ProxyServer({ config });
        const server = await proxyServer.start();
        proxyUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterEach(() => {
        activeEventSources.forEach(es => es.close());
        activeEventSources.length = 0;
    });

    afterAll(async () => {
        activeEventSources.forEach(es => es.close());
        activeEventSources.length = 0;
        if (proxyServer) {
            await proxyServer.shutdown();
        }
        if (testDir) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    test('should broadcast request-complete event when request completes', async () => {
        const es = new EventSource(`${proxyUrl}/requests/stream`);
        activeEventSources.push(es);

        const eventPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Timeout waiting for request-complete event'));
            }, 5000);

            es.addEventListener('request-complete', (e) => {
                clearTimeout(timeout);
                try {
                    resolve(JSON.parse(e.data));
                } catch (err) {
                    reject(err);
                }
            });
        });

        // Wait for SSE connection to establish
        await new Promise(r => setTimeout(r, 200));

        // Send a request (will error upstream but still broadcasts)
        fetch(`${proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-3-haiku-20240307',
                messages: [{ role: 'user', content: 'hello' }],
                max_tokens: 10
            })
        }).catch(() => {});

        const eventData = await eventPromise;
        expect(eventData).toBeTruthy();
    }, 7000);

    test('request-complete event includes path and timestamp', async () => {
        const es = new EventSource(`${proxyUrl}/requests/stream`);
        activeEventSources.push(es);

        const eventPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Timeout waiting for request-complete event'));
            }, 5000);

            es.addEventListener('request-complete', (e) => {
                clearTimeout(timeout);
                try {
                    resolve(JSON.parse(e.data));
                } catch (err) {
                    reject(err);
                }
            });
        });

        await new Promise(r => setTimeout(r, 200));

        fetch(`${proxyUrl}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-3-haiku-20240307',
                messages: [{ role: 'user', content: 'test' }],
                max_tokens: 10
            })
        }).catch(() => {});

        const eventData = await eventPromise;
        expect(eventData).toHaveProperty('path');
        expect(eventData).toHaveProperty('timestamp');
        expect(eventData.path).toContain('/v1/messages');
    }, 7000);
});
