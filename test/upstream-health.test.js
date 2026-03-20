'use strict';

const { UpstreamHealthMonitor } = require('../lib/upstream-health');
const dns = require('dns').promises;
const net = require('net');

describe('UpstreamHealthMonitor', () => {
    let logger;

    beforeEach(() => {
        jest.useFakeTimers();
        logger = {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        };
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    // ---------------------------------------------------------------
    // Group 1: Lifecycle
    // ---------------------------------------------------------------
    describe('lifecycle', () => {
        test('start() creates a probe interval', () => {
            const monitor = new UpstreamHealthMonitor({ logger, probeIntervalMs: 5000 });
            // Stub _probe to avoid real network I/O
            monitor._probe = jest.fn();

            monitor.start();

            expect(monitor._probeTimer).not.toBeNull();
            // The initial probe is called immediately
            expect(monitor._probe).toHaveBeenCalledTimes(1);

            monitor.stop();
        });

        test('stop() clears the probe interval', () => {
            const monitor = new UpstreamHealthMonitor({ logger, probeIntervalMs: 5000 });
            monitor._probe = jest.fn();

            monitor.start();
            expect(monitor._probeTimer).not.toBeNull();

            monitor.stop();
            expect(monitor._probeTimer).toBeNull();
        });

        test('calling start() twice does not create duplicate intervals', () => {
            const monitor = new UpstreamHealthMonitor({ logger, probeIntervalMs: 5000 });
            monitor._probe = jest.fn();

            monitor.start();
            const firstTimer = monitor._probeTimer;

            monitor.start(); // second call — should be a no-op
            expect(monitor._probeTimer).toBe(firstTimer);
            // Initial probe should only have been called once
            expect(monitor._probe).toHaveBeenCalledTimes(1);

            monitor.stop();
        });

        test('stop() when not started is a no-op', () => {
            const monitor = new UpstreamHealthMonitor({ logger });

            // Should not throw
            expect(() => monitor.stop()).not.toThrow();
            expect(monitor._probeTimer).toBeNull();
        });

        test('periodic probe fires on each interval tick', () => {
            const monitor = new UpstreamHealthMonitor({ logger, probeIntervalMs: 5000 });
            monitor._probe = jest.fn();

            monitor.start();
            expect(monitor._probe).toHaveBeenCalledTimes(1);

            jest.advanceTimersByTime(5000);
            expect(monitor._probe).toHaveBeenCalledTimes(2);

            jest.advanceTimersByTime(5000);
            expect(monitor._probe).toHaveBeenCalledTimes(3);

            monitor.stop();
        });
    });

    // ---------------------------------------------------------------
    // Group 2: Probe mechanics
    // ---------------------------------------------------------------
    describe('probe mechanics', () => {
        test('_probe() sets _probing = true during execution and clears after', async () => {
            const monitor = new UpstreamHealthMonitor({ logger });

            let probingDuringExec = null;
            monitor._probeEndpointHealth = jest.fn().mockImplementation(async () => {
                probingDuringExec = monitor._probing;
                return {
                    state: 'healthy',
                    reason: 'all_ips_ok',
                    ips: ['1.2.3.4'],
                    results: [{ ip: '1.2.3.4', success: true, latencyMs: 10 }],
                    healthyIps: ['1.2.3.4'],
                    failedIps: [],
                    healthyCount: 1,
                    failedCount: 0,
                    avgLatencyMs: 10
                };
            });

            await monitor._probe();

            expect(probingDuringExec).toBe(true);
            expect(monitor._probing).toBe(false);
        });

        test('concurrent probe calls are rejected (guard from commit 00f7a7e)', async () => {
            const monitor = new UpstreamHealthMonitor({ logger });

            let resolveProbe;
            monitor._probeEndpointHealth = jest.fn().mockImplementation(() => {
                return new Promise(resolve => {
                    resolveProbe = resolve;
                });
            });

            // Start first probe (it will hang on the mock)
            const probe1 = monitor._probe();

            // Second call while first is in-flight should return immediately
            const probe2 = monitor._probe();
            await probe2; // resolves immediately because _probing is true

            // Only one call to _probeEndpointHealth — second probe was rejected
            expect(monitor._probeEndpointHealth).toHaveBeenCalledTimes(1);

            // Now let first probe finish
            resolveProbe({
                state: 'healthy',
                reason: 'all_ips_ok',
                ips: ['1.2.3.4'],
                results: [{ ip: '1.2.3.4', success: true, latencyMs: 10 }],
                healthyIps: ['1.2.3.4'],
                failedIps: [],
                healthyCount: 1,
                failedCount: 0,
                avgLatencyMs: 10
            });
            await probe1;

            expect(monitor._probing).toBe(false);
        });

        test('probe success updates endpoint health status', async () => {
            const monitor = new UpstreamHealthMonitor({ logger });
            monitor._probeEndpointHealth = jest.fn().mockResolvedValue({
                state: 'healthy',
                reason: 'all_ips_ok',
                ips: ['1.2.3.4'],
                results: [{ ip: '1.2.3.4', success: true, latencyMs: 15 }],
                healthyIps: ['1.2.3.4'],
                failedIps: [],
                healthyCount: 1,
                failedCount: 0,
                avgLatencyMs: 15
            });

            await monitor._probe();

            expect(monitor.ipHealth.get('1.2.3.4')).toEqual(expect.objectContaining({
                healthy: true,
                latencyMs: 15,
                error: null
            }));
            expect(monitor.lastProbeResult.state).toBe('healthy');
        });

        test('probe failure after threshold triggers failover', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                failThreshold: 2,
                primaryHost: 'primary.example',
                fallbacks: [
                    { host: 'backup.example', port: 443, basePath: '/v1', protocol: 'https:', label: 'Backup' }
                ]
            });

            // Mock: primary probes return down, fallback is healthy
            let probeCallCount = 0;
            monitor._probeEndpointHealth = jest.fn().mockImplementation(async (endpoint) => {
                probeCallCount++;
                if (endpoint.host === 'backup.example') {
                    return {
                        state: 'healthy', reason: 'all_ips_ok', ips: ['10.0.0.2'],
                        results: [{ ip: '10.0.0.2', success: true, latencyMs: 20 }],
                        healthyIps: ['10.0.0.2'], failedIps: [],
                        healthyCount: 1, failedCount: 0, avgLatencyMs: 20
                    };
                }
                return {
                    state: 'down', reason: 'all_ips_failed', ips: ['10.0.0.1'],
                    results: [{ ip: '10.0.0.1', success: false, latencyMs: 5000, error: 'timeout' }],
                    healthyIps: [], failedIps: ['10.0.0.1'],
                    healthyCount: 0, failedCount: 1, avgLatencyMs: null
                };
            });

            const failoverListener = jest.fn();
            monitor.on('upstream-failover', failoverListener);

            // First failure — below threshold, no failover
            await monitor._recordProbeResult('down', 'all_ips_failed', ['10.0.0.1']);
            expect(failoverListener).not.toHaveBeenCalled();
            expect(monitor.state).not.toBe('down');

            // Second failure — meets threshold, triggers failover
            await monitor._recordProbeResult('down', 'all_ips_failed', ['10.0.0.1']);
            expect(monitor.state).toBe('down');
            expect(failoverListener).toHaveBeenCalledTimes(1);
            expect(monitor.activeEndpoint.host).toBe('backup.example');
        });

        test('_probe clears _probing flag even when _probeEndpointHealth throws', async () => {
            const monitor = new UpstreamHealthMonitor({ logger });
            monitor._probeEndpointHealth = jest.fn().mockRejectedValue(new Error('network exploded'));

            await monitor._probe();

            expect(monitor._probing).toBe(false);
            expect(monitor.lastProbeResult.state).toBe('down');
        });
    });

    // ---------------------------------------------------------------
    // Group 3: Health status
    // ---------------------------------------------------------------
    describe('health status', () => {
        test('getStatus() returns expected shape', () => {
            const monitor = new UpstreamHealthMonitor({ logger });
            const status = monitor.getStatus();

            expect(status).toEqual(expect.objectContaining({
                state: expect.any(String),
                activeEndpoint: expect.objectContaining({
                    host: expect.any(String),
                    label: expect.any(String),
                    isPrimary: expect.any(Boolean)
                }),
                lastProbe: null,
                lastProbeResult: null,
                ipHealth: expect.any(Object),
                endpointHealth: expect.any(Object),
                history: expect.any(Array)
            }));
        });

        test('getStatus() reflects current health of each endpoint', async () => {
            const monitor = new UpstreamHealthMonitor({ logger });

            // Simulate some health data
            monitor.ipHealth.set('1.2.3.4', { healthy: true, lastCheck: Date.now(), latencyMs: 12, error: null });
            monitor.ipHealth.set('5.6.7.8', { healthy: false, lastCheck: Date.now(), latencyMs: 5000, error: 'timeout' });
            monitor.state = 'degraded';

            const status = monitor.getStatus();
            expect(status.state).toBe('degraded');
            expect(status.ipHealth['1.2.3.4'].healthy).toBe(true);
            expect(status.ipHealth['5.6.7.8'].healthy).toBe(false);
        });

        test('getStatus() includes outage info when outage is active', () => {
            const monitor = new UpstreamHealthMonitor({ logger });
            const outageStart = Date.now() - 30000;
            monitor.outage = { startedAt: outageStart, detectedAt: outageStart, affectedIPs: ['1.1.1.1'] };

            const status = monitor.getStatus();
            expect(status.outage).not.toBeNull();
            expect(status.outage.startedAt).toBe(outageStart);
            expect(status.outage.durationMs).toBeGreaterThanOrEqual(30000);
            expect(status.outage.affectedIPs).toEqual(['1.1.1.1']);
        });

        test('getStatus() outage is null when no active outage', () => {
            const monitor = new UpstreamHealthMonitor({ logger });
            expect(monitor.getStatus().outage).toBeNull();
        });

        test('getActiveTarget() returns current endpoint config', () => {
            const monitor = new UpstreamHealthMonitor({ logger });
            const target = monitor.getActiveTarget();

            expect(target).toEqual({
                host: 'api.z.ai',
                basePath: '/api/anthropic',
                protocol: 'https:'
            });
        });
    });

    // ---------------------------------------------------------------
    // Group 4: Recovery and anti-flap
    // ---------------------------------------------------------------
    describe('recovery and anti-flap', () => {
        test('recovery requires 2 consecutive successes for primary (from down state)', async () => {
            const monitor = new UpstreamHealthMonitor({ logger, failThreshold: 1, fallbacks: [] });
            // Put monitor into down state on primary (not degraded, because degraded recovers immediately)
            monitor.state = 'down';
            monitor.consecutiveSuccesses = 0;

            // First success — not enough (recoveryThreshold for primary = 2)
            await monitor._recordProbeResult('healthy', 'all_ips_ok', []);
            expect(monitor.state).toBe('down'); // still down, needs 2
            expect(monitor.consecutiveSuccesses).toBe(1);

            // Second success — meets threshold
            await monitor._recordProbeResult('healthy', 'all_ips_ok', []);
            expect(monitor.state).toBe('healthy');
        });

        test('recovery requires 5 consecutive successes for fallback endpoint', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                failThreshold: 1,
                primaryHost: 'primary.example',
                fallbacks: [
                    { host: 'fallback.example', port: 443, basePath: '/v1', protocol: 'https:', label: 'Fallback' }
                ]
            });

            // Simulate failover to a fallback
            monitor.activeEndpoint = {
                host: 'fallback.example',
                port: 443,
                basePath: '/v1',
                protocol: 'https:',
                label: 'Fallback',
                isPrimary: false
            };
            monitor.state = 'down';
            monitor.consecutiveSuccesses = 0;
            // Set _lastFailoverAt far in the past so anti-flap doesn't block
            monitor._lastFailoverAt = Date.now() - 120000;

            // First 4 successes — still not enough
            for (let i = 0; i < 4; i++) {
                await monitor._recordProbeResult('healthy', 'all_ips_ok', []);
            }
            expect(monitor.state).toBe('down'); // still not recovered
            expect(monitor.consecutiveSuccesses).toBe(4);

            // 5th success — meets recoveryThreshold for fallback
            await monitor._recordProbeResult('healthy', 'all_ips_ok', []);
            expect(monitor.state).toBe('healthy');
        });

        test('recovery within 60 seconds of failover is suppressed (anti-flap)', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                failThreshold: 1,
                primaryHost: 'primary.example',
                fallbacks: [
                    { host: 'fallback.example', port: 443, basePath: '/v1', protocol: 'https:', label: 'Fallback' }
                ]
            });

            // Simulate: on a fallback endpoint, failover happened 30 seconds ago
            monitor.activeEndpoint = {
                host: 'fallback.example',
                port: 443,
                basePath: '/v1',
                protocol: 'https:',
                label: 'Fallback',
                isPrimary: false
            };
            monitor.state = 'down';
            monitor.consecutiveSuccesses = 0;
            monitor._lastFailoverAt = Date.now() - 30000; // 30s ago — too recent

            // Give it 5 successes (enough normally)
            for (let i = 0; i < 5; i++) {
                await monitor._recordProbeResult('healthy', 'all_ips_ok', []);
            }

            // Should NOT have recovered back to primary — anti-flap suppresses it
            expect(monitor.activeEndpoint.host).toBe('fallback.example');
        });

        test('recovery after 60 seconds anti-flap window succeeds', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                failThreshold: 1,
                primaryHost: 'primary.example',
                fallbacks: [
                    { host: 'fallback.example', port: 443, basePath: '/v1', protocol: 'https:', label: 'Fallback' }
                ]
            });

            monitor.activeEndpoint = {
                host: 'fallback.example',
                port: 443,
                basePath: '/v1',
                protocol: 'https:',
                label: 'Fallback',
                isPrimary: false
            };
            monitor.state = 'down';
            monitor.outage = { startedAt: Date.now() - 120000, detectedAt: Date.now() - 120000, affectedIPs: ['10.0.0.1'] };
            monitor.consecutiveSuccesses = 0;
            monitor._lastFailoverAt = Date.now() - 90000; // 90s ago — past window

            const recoveredListener = jest.fn();
            monitor.on('upstream-recovered', recoveredListener);

            for (let i = 0; i < 5; i++) {
                await monitor._recordProbeResult('healthy', 'all_ips_ok', []);
            }

            expect(monitor.state).toBe('healthy');
            expect(monitor.activeEndpoint.isPrimary).toBe(true);
            expect(recoveredListener).toHaveBeenCalledTimes(1);
        });

        test('successful recovery emits upstream-recovered event', async () => {
            const monitor = new UpstreamHealthMonitor({ logger, failThreshold: 1 });

            // Put into degraded state with an outage
            monitor.state = 'degraded';
            monitor.outage = { startedAt: Date.now() - 10000, detectedAt: Date.now() - 10000, affectedIPs: ['1.2.3.4'] };
            monitor.consecutiveSuccesses = 0;

            const recoveredListener = jest.fn();
            monitor.on('upstream-recovered', recoveredListener);

            // degraded → healthy only needs the threshold OR prevState === 'degraded'
            // When prevState is 'degraded', recovery is immediate
            await monitor._recordProbeResult('healthy', 'all_ips_ok', []);

            expect(monitor.state).toBe('healthy');
            expect(recoveredListener).toHaveBeenCalledTimes(1);
            expect(recoveredListener).toHaveBeenCalledWith(expect.objectContaining({
                durationMs: expect.any(Number),
                timestamp: expect.any(Number)
            }));
            expect(monitor.outage).toBeNull();
        });

        test('recovery from degraded is immediate (no threshold needed)', async () => {
            const monitor = new UpstreamHealthMonitor({ logger });
            monitor.state = 'degraded';
            monitor.consecutiveSuccesses = 0;

            await monitor._recordProbeResult('healthy', 'all_ips_ok', []);

            expect(monitor.state).toBe('healthy');
        });

        test('recovery switches back to primary via _switchToPrimary', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                primaryHost: 'primary.example',
                fallbacks: []
            });

            monitor.activeEndpoint = {
                host: 'fallback.example',
                label: 'Fallback',
                isPrimary: false
            };
            monitor.state = 'down';
            monitor.outage = { startedAt: Date.now() - 120000, detectedAt: Date.now() - 120000, affectedIPs: [] };
            monitor._lastFailoverAt = Date.now() - 120000;
            monitor.consecutiveSuccesses = 4; // one more needed for fallback threshold=5

            const restoredListener = jest.fn();
            monitor.on('upstream-restored', restoredListener);

            await monitor._recordProbeResult('healthy', 'all_ips_ok', []);

            expect(monitor.activeEndpoint.isPrimary).toBe(true);
            expect(monitor.activeEndpoint.host).toBe('primary.example');
            expect(restoredListener).toHaveBeenCalledWith(expect.objectContaining({
                from: 'Fallback',
                to: 'Primary (z.ai)'
            }));
        });
    });

    // ---------------------------------------------------------------
    // Group 5: Failover selection
    // ---------------------------------------------------------------
    describe('failover selection', () => {
        test('selects the first reachable fallback instead of blindly using the first configured endpoint', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                failThreshold: 1,
                primaryHost: 'primary.example',
                fallbacks: [
                    { host: 'dead.example', port: 443, basePath: '/dead', protocol: 'https:', label: 'Dead fallback' },
                    { host: 'live.example', port: 443, basePath: '/live', protocol: 'https:', label: 'Live fallback' }
                ]
            });

            monitor._probeEndpointHealth = jest.fn()
                .mockResolvedValueOnce({ state: 'down', reason: 'dns_failed', ips: [], results: [], healthyIps: [], failedIps: [], healthyCount: 0, failedCount: 0, avgLatencyMs: null })
                .mockResolvedValueOnce({ state: 'healthy', reason: 'all_ips_ok', ips: ['10.0.0.2'], results: [], healthyIps: ['10.0.0.2'], failedIps: [], healthyCount: 1, failedCount: 0, avgLatencyMs: 20 });

            const failoverListener = jest.fn();
            monitor.on('upstream-failover', failoverListener);

            await monitor._recordProbeResult('down', 'all_ips_failed', ['10.0.0.1']);

            expect(monitor._probeEndpointHealth).toHaveBeenCalledTimes(2);
            expect(monitor.activeEndpoint.host).toBe('live.example');
            expect(failoverListener).toHaveBeenCalledWith(expect.objectContaining({
                host: 'live.example',
                to: 'Live fallback'
            }));
        });

        test('stays on primary when every fallback probe fails', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                failThreshold: 1,
                primaryHost: 'primary.example',
                fallbacks: [
                    { host: 'dead-a.example', port: 443, basePath: '/dead-a', protocol: 'https:', label: 'Dead A' },
                    { host: 'dead-b.example', port: 443, basePath: '/dead-b', protocol: 'https:', label: 'Dead B' }
                ]
            });

            monitor._probeEndpointHealth = jest.fn()
                .mockResolvedValue({ state: 'down', reason: 'dns_failed', ips: [], results: [], healthyIps: [], failedIps: [], healthyCount: 0, failedCount: 0, avgLatencyMs: null });

            const failoverListener = jest.fn();
            monitor.on('upstream-failover', failoverListener);

            await monitor._recordProbeResult('down', 'all_ips_failed', ['10.0.0.1']);

            expect(monitor._probeEndpointHealth).toHaveBeenCalledTimes(2);
            expect(monitor.activeEndpoint.isPrimary).toBe(true);
            expect(failoverListener).not.toHaveBeenCalled();
            expect(logger.error).toHaveBeenCalledWith(
                'Upstream DOWN',
                expect.objectContaining({
                    reason: 'all_ips_failed'
                })
            );
            expect(logger.warn).toHaveBeenCalledWith(
                'Upstream failover skipped: no healthy fallback endpoints available',
                expect.objectContaining({
                    attemptedFallbacks: ['dead-a.example', 'dead-b.example']
                })
            );
        });

        test('when all endpoints are down, reports degraded/down status', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                failThreshold: 1,
                primaryHost: 'primary.example',
                fallbacks: [
                    { host: 'fb.example', port: 443, basePath: '/', protocol: 'https:', label: 'Fallback' }
                ]
            });

            monitor._probeEndpointHealth = jest.fn()
                .mockResolvedValue({ state: 'down', reason: 'dns_failed', ips: [], results: [], healthyIps: [], failedIps: [], healthyCount: 0, failedCount: 0, avgLatencyMs: null });

            const statusListener = jest.fn();
            monitor.on('upstream-status', statusListener);

            await monitor._recordProbeResult('down', 'all_ips_failed', ['10.0.0.1']);

            expect(monitor.state).toBe('down');
            expect(statusListener).toHaveBeenCalledWith(expect.objectContaining({
                state: 'down'
            }));
        });

        test('outage history is capped at 10 entries', async () => {
            const monitor = new UpstreamHealthMonitor({ logger, failThreshold: 1 });

            // Pre-fill history with 10 outages
            for (let i = 0; i < 10; i++) {
                monitor.history.push({ startedAt: i, recoveredAt: i + 1000, durationMs: 1000 });
            }
            expect(monitor.history.length).toBe(10);

            // Simulate recovery which pushes a new outage to history
            monitor.state = 'degraded';
            monitor.outage = { startedAt: Date.now() - 5000, detectedAt: Date.now() - 5000, affectedIPs: [] };
            monitor.consecutiveSuccesses = 0;

            await monitor._recordProbeResult('healthy', 'all_ips_ok', []);

            // History should still be capped at 10
            expect(monitor.history.length).toBe(10);
            // Oldest entry should have been shifted out
            expect(monitor.history[0].startedAt).toBe(1);
        });

        test('selects healthiest fallback when multiple are available', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                failThreshold: 1,
                primaryHost: 'primary.example',
                fallbacks: [
                    { host: 'degraded.example', port: 443, basePath: '/d', protocol: 'https:', label: 'Degraded' },
                    { host: 'healthy.example', port: 443, basePath: '/h', protocol: 'https:', label: 'Healthy' }
                ]
            });

            monitor._probeEndpointHealth = jest.fn()
                .mockResolvedValueOnce({ state: 'degraded', reason: 'partial_failure', ips: ['10.0.0.1', '10.0.0.2'], results: [], healthyIps: ['10.0.0.1'], failedIps: ['10.0.0.2'], healthyCount: 1, failedCount: 1, avgLatencyMs: 50 })
                .mockResolvedValueOnce({ state: 'healthy', reason: 'all_ips_ok', ips: ['10.0.1.1'], results: [], healthyIps: ['10.0.1.1'], failedIps: [], healthyCount: 1, failedCount: 0, avgLatencyMs: 20 });

            await monitor._recordProbeResult('down', 'all_ips_failed', ['10.0.0.1']);

            expect(monitor.activeEndpoint.host).toBe('healthy.example');
        });

        test('_selectFailoverEndpoint returns null when no fallbacks configured', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                fallbacks: []
            });

            const result = await monitor._selectFailoverEndpoint();
            expect(result).toBeNull();
        });
    });

    // ---------------------------------------------------------------
    // Group 6: Edge cases
    // ---------------------------------------------------------------
    describe('edge cases', () => {
        test('constructor with no fallbacks configured defaults to empty array', () => {
            const monitor = new UpstreamHealthMonitor({ logger });
            expect(monitor.fallbacks).toEqual([]);
        });

        test('constructor with empty fallbacks array', () => {
            const monitor = new UpstreamHealthMonitor({ logger, fallbacks: [] });
            expect(monitor.fallbacks).toEqual([]);
        });

        test('constructor with no options uses defaults', () => {
            const monitor = new UpstreamHealthMonitor();
            expect(monitor.primaryHost).toBe('api.z.ai');
            expect(monitor.primaryPort).toBe(443);
            expect(monitor.probeIntervalMs).toBe(15000);
            expect(monitor.probeTimeoutMs).toBe(5000);
            expect(monitor.failThreshold).toBe(2);
            expect(monitor.state).toBe('healthy');
            expect(monitor.activeEndpoint.isPrimary).toBe(true);
        });

        test('DNS resolution failure falls back to IPv6', async () => {
            const monitor = new UpstreamHealthMonitor({ logger, primaryHost: 'ipv6only.example' });

            jest.spyOn(dns, 'resolve4').mockRejectedValue(new Error('ENODATA'));
            jest.spyOn(dns, 'resolve6').mockResolvedValue(['::1']);

            const ips = await monitor._resolveEndpointIps('ipv6only.example');
            expect(ips).toEqual(['::1']);
        });

        test('DNS resolution failure for both IPv4 and IPv6 returns empty', async () => {
            const monitor = new UpstreamHealthMonitor({ logger, primaryHost: 'nonexistent.example' });

            jest.spyOn(dns, 'resolve4').mockRejectedValue(new Error('ENODATA'));
            jest.spyOn(dns, 'resolve6').mockRejectedValue(new Error('ENODATA'));

            const ips = await monitor._resolveEndpointIps('nonexistent.example');
            expect(ips).toEqual([]);
        });

        test('DNS failure results in down state for endpoint', async () => {
            const monitor = new UpstreamHealthMonitor({ logger, primaryHost: 'nxdomain.example' });

            jest.spyOn(dns, 'resolve4').mockRejectedValue(new Error('ENOTFOUND'));
            jest.spyOn(dns, 'resolve6').mockRejectedValue(new Error('ENOTFOUND'));

            const result = await monitor._probeEndpointHealth({
                host: 'nxdomain.example',
                port: 443,
                label: 'NX Domain',
                isPrimary: true
            });

            expect(result.state).toBe('down');
            expect(result.reason).toBe('dns_failed');
            expect(result.ips).toEqual([]);
        });

        test('TCP probe timeout resolves as failure (not rejection)', async () => {
            // Use real timers for socket tests — fake timers interfere with process.nextTick
            jest.useRealTimers();
            const monitor = new UpstreamHealthMonitor({ logger, probeTimeoutMs: 100 });

            const mockSocket = new (require('events').EventEmitter)();
            mockSocket.setTimeout = jest.fn();
            mockSocket.connect = jest.fn().mockImplementation(() => {
                setImmediate(() => mockSocket.emit('timeout'));
            });
            mockSocket.destroy = jest.fn();

            jest.spyOn(net, 'Socket').mockReturnValue(mockSocket);

            const result = await monitor._tcpProbe('1.2.3.4', 443);

            expect(result.success).toBe(false);
            expect(result.error).toBe('timeout');
            expect(result.ip).toBe('1.2.3.4');
            expect(mockSocket.destroy).toHaveBeenCalled();
            jest.useFakeTimers();
        });

        test('TCP probe connection error resolves as failure', async () => {
            jest.useRealTimers();
            const monitor = new UpstreamHealthMonitor({ logger });

            const mockSocket = new (require('events').EventEmitter)();
            mockSocket.setTimeout = jest.fn();
            mockSocket.connect = jest.fn().mockImplementation(() => {
                setImmediate(() => mockSocket.emit('error', { code: 'ECONNREFUSED', message: 'Connection refused' }));
            });
            mockSocket.destroy = jest.fn();

            jest.spyOn(net, 'Socket').mockReturnValue(mockSocket);

            const result = await monitor._tcpProbe('1.2.3.4', 443);

            expect(result.success).toBe(false);
            expect(result.error).toBe('ECONNREFUSED');
            expect(mockSocket.destroy).toHaveBeenCalled();
            jest.useFakeTimers();
        });

        test('TCP probe successful connect resolves with latency', async () => {
            jest.useRealTimers();
            const monitor = new UpstreamHealthMonitor({ logger });

            const mockSocket = new (require('events').EventEmitter)();
            mockSocket.setTimeout = jest.fn();
            mockSocket.connect = jest.fn().mockImplementation(() => {
                setImmediate(() => mockSocket.emit('connect'));
            });
            mockSocket.destroy = jest.fn();

            jest.spyOn(net, 'Socket').mockReturnValue(mockSocket);

            const result = await monitor._tcpProbe('1.2.3.4', 443);

            expect(result.success).toBe(true);
            expect(result.ip).toBe('1.2.3.4');
            expect(result.latencyMs).toBeGreaterThanOrEqual(0);
            expect(mockSocket.destroy).toHaveBeenCalled();
            jest.useFakeTimers();
        });

        test('failover does not trigger when on primary with no fallbacks', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                failThreshold: 1,
                primaryHost: 'primary.example',
                fallbacks: []
            });

            const failoverListener = jest.fn();
            monitor.on('upstream-failover', failoverListener);

            await monitor._recordProbeResult('down', 'all_ips_failed', ['10.0.0.1']);

            expect(monitor.state).toBe('down');
            expect(failoverListener).not.toHaveBeenCalled();
            expect(monitor.activeEndpoint.isPrimary).toBe(true);
        });

        test('degraded state emits upstream-status event', async () => {
            const monitor = new UpstreamHealthMonitor({ logger });
            const statusListener = jest.fn();
            monitor.on('upstream-status', statusListener);

            await monitor._recordProbeResult('degraded', 'partial_failure', ['1.2.3.4']);

            expect(monitor.state).toBe('degraded');
            expect(statusListener).toHaveBeenCalledWith(expect.objectContaining({
                state: 'degraded',
                reason: 'partial_failure',
                affectedIPs: ['1.2.3.4']
            }));
        });

        test('every probe emits upstream-health event for dashboard', async () => {
            const monitor = new UpstreamHealthMonitor({ logger });
            const healthListener = jest.fn();
            monitor.on('upstream-health', healthListener);

            await monitor._recordProbeResult('healthy', 'all_ips_ok', []);
            await monitor._recordProbeResult('degraded', 'partial_failure', ['1.1.1.1']);
            await monitor._recordProbeResult('down', 'all_ips_failed', ['1.1.1.1']);

            expect(healthListener).toHaveBeenCalledTimes(3);
        });

        test('_endpointKey produces consistent keys', () => {
            const monitor = new UpstreamHealthMonitor({ logger });
            const key = monitor._endpointKey({
                protocol: 'https:',
                host: 'example.com',
                port: 443,
                basePath: '/v1'
            });
            expect(key).toBe('https://example.com:443/v1');
        });

        test('_endpointKey uses defaults for missing fields', () => {
            const monitor = new UpstreamHealthMonitor({ logger });
            const key = monitor._endpointKey({ host: 'example.com' });
            expect(key).toBe('https://example.com:443');
        });

        test('outage tracking starts on first down after threshold', async () => {
            const monitor = new UpstreamHealthMonitor({ logger, failThreshold: 1, fallbacks: [] });

            expect(monitor.outage).toBeNull();

            await monitor._recordProbeResult('down', 'all_ips_failed', ['10.0.0.1']);

            expect(monitor.outage).not.toBeNull();
            expect(monitor.outage.startedAt).toBeGreaterThan(0);
            expect(monitor.outage.affectedIPs).toEqual(['10.0.0.1']);
        });

        test('consecutive down probes do not create duplicate outages', async () => {
            const monitor = new UpstreamHealthMonitor({ logger, failThreshold: 1, fallbacks: [] });

            await monitor._recordProbeResult('down', 'all_ips_failed', ['10.0.0.1']);
            const outageStart = monitor.outage.startedAt;

            // Advance time slightly and probe again
            jest.advanceTimersByTime(1000);
            await monitor._recordProbeResult('down', 'all_ips_failed', ['10.0.0.1']);

            // Outage should be the same one, not recreated
            expect(monitor.outage.startedAt).toBe(outageStart);
        });
    });
});
