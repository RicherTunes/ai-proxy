'use strict';

const { UpstreamHealthMonitor } = require('../lib/upstream-health');

/**
 * Tests for _selectFailoverEndpoint sort-criteria tie-breaking
 * and MIN_FAILOVER_AGE_MS anti-flap edge cases.
 *
 * Sort order: state rank (up>degraded>down) -> healthyCount -> avgLatency -> original index
 */
describe('UpstreamHealthMonitor — sort-criteria & anti-flap edges', () => {
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

    // Helper: build a probe result with the given state, healthyCount, and avgLatencyMs
    function mkProbe(state, healthyCount, avgLatencyMs) {
        const reason = state === 'healthy' ? 'all_ips_ok'
            : state === 'degraded' ? 'partial_failure'
            : 'all_ips_failed';
        return {
            state,
            reason,
            ips: [],
            results: [],
            healthyIps: [],
            failedIps: [],
            healthyCount,
            failedCount: 0,
            avgLatencyMs
        };
    }

    // ------------------------------------------------------------------
    // Sort-criteria tests (1-5)
    // ------------------------------------------------------------------
    describe('_selectFailoverEndpoint sort criteria', () => {
        test('1. Sort by state rank — "healthy" preferred over "degraded" over "down"', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                fallbacks: [
                    { host: 'down.example', port: 443, basePath: '/', protocol: 'https:', label: 'Down' },
                    { host: 'degraded.example', port: 443, basePath: '/', protocol: 'https:', label: 'Degraded' },
                    { host: 'healthy.example', port: 443, basePath: '/', protocol: 'https:', label: 'Healthy' }
                ]
            });

            monitor._probeEndpointHealth = jest.fn()
                .mockResolvedValueOnce(mkProbe('down', 0, null))
                .mockResolvedValueOnce(mkProbe('degraded', 1, 50))
                .mockResolvedValueOnce(mkProbe('healthy', 2, 30));

            const result = await monitor._selectFailoverEndpoint();

            expect(result).not.toBeNull();
            expect(result.endpoint.host).toBe('healthy.example');
        });

        test('2. Tie-break by healthyCount — two "healthy" endpoints, higher healthyCount wins', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                fallbacks: [
                    { host: 'fewer-ips.example', port: 443, basePath: '/', protocol: 'https:', label: 'Fewer IPs' },
                    { host: 'more-ips.example', port: 443, basePath: '/', protocol: 'https:', label: 'More IPs' }
                ]
            });

            // Both healthy, but second has more healthy IPs
            monitor._probeEndpointHealth = jest.fn()
                .mockResolvedValueOnce(mkProbe('healthy', 1, 20))
                .mockResolvedValueOnce(mkProbe('healthy', 3, 20));

            const result = await monitor._selectFailoverEndpoint();

            expect(result).not.toBeNull();
            expect(result.endpoint.host).toBe('more-ips.example');
        });

        test('3. Tie-break by avgLatency — equal healthyCount, lower latency wins', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                fallbacks: [
                    { host: 'slow.example', port: 443, basePath: '/', protocol: 'https:', label: 'Slow' },
                    { host: 'fast.example', port: 443, basePath: '/', protocol: 'https:', label: 'Fast' }
                ]
            });

            // Both healthy, same healthyCount, different latency
            monitor._probeEndpointHealth = jest.fn()
                .mockResolvedValueOnce(mkProbe('healthy', 2, 150))
                .mockResolvedValueOnce(mkProbe('healthy', 2, 30));

            const result = await monitor._selectFailoverEndpoint();

            expect(result).not.toBeNull();
            expect(result.endpoint.host).toBe('fast.example');
        });

        test('4. Tie-break by original index — all metrics equal, first-configured endpoint wins', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                fallbacks: [
                    { host: 'first.example', port: 443, basePath: '/', protocol: 'https:', label: 'First' },
                    { host: 'second.example', port: 443, basePath: '/', protocol: 'https:', label: 'Second' },
                    { host: 'third.example', port: 443, basePath: '/', protocol: 'https:', label: 'Third' }
                ]
            });

            // All identical: healthy, 2 IPs, 50ms latency
            monitor._probeEndpointHealth = jest.fn()
                .mockResolvedValueOnce(mkProbe('healthy', 2, 50))
                .mockResolvedValueOnce(mkProbe('healthy', 2, 50))
                .mockResolvedValueOnce(mkProbe('healthy', 2, 50));

            const result = await monitor._selectFailoverEndpoint();

            expect(result).not.toBeNull();
            expect(result.endpoint.host).toBe('first.example');
            expect(result.index).toBe(0);
        });

        test('5. Full 4-criteria sort — mixed criteria, verify correct final ordering', async () => {
            // Setup: 4 fallbacks that exercise every tiebreaker level
            //   [0] degraded, 1 healthy, 40ms  — loses on state rank
            //   [1] healthy,  1 healthy, 20ms  — loses on healthyCount to [2] and [3]
            //   [2] healthy,  3 healthy, 80ms  — ties [3] on state+count, loses on latency
            //   [3] healthy,  3 healthy, 25ms  — WINNER (best state, most healthy, lowest latency)
            const monitor = new UpstreamHealthMonitor({
                logger,
                fallbacks: [
                    { host: 'degraded.example', port: 443, basePath: '/', protocol: 'https:', label: 'Degraded' },
                    { host: 'healthy-1ip.example', port: 443, basePath: '/', protocol: 'https:', label: 'Healthy-1' },
                    { host: 'healthy-3ip-slow.example', port: 443, basePath: '/', protocol: 'https:', label: 'Healthy-3-Slow' },
                    { host: 'healthy-3ip-fast.example', port: 443, basePath: '/', protocol: 'https:', label: 'Healthy-3-Fast' }
                ]
            });

            monitor._probeEndpointHealth = jest.fn()
                .mockResolvedValueOnce(mkProbe('degraded', 1, 40))
                .mockResolvedValueOnce(mkProbe('healthy', 1, 20))
                .mockResolvedValueOnce(mkProbe('healthy', 3, 80))
                .mockResolvedValueOnce(mkProbe('healthy', 3, 25));

            const result = await monitor._selectFailoverEndpoint();

            expect(result).not.toBeNull();
            expect(result.endpoint.host).toBe('healthy-3ip-fast.example');
            expect(result.index).toBe(3);
        });
    });

    // ------------------------------------------------------------------
    // Anti-flap tests (6-9)
    // ------------------------------------------------------------------
    describe('MIN_FAILOVER_AGE_MS anti-flap', () => {
        /**
         * Helper: create a monitor that has already failed over to a fallback.
         * The caller controls `_lastFailoverAt` to test anti-flap timing.
         */
        function buildFailedOverMonitor(lastFailoverAt) {
            const monitor = new UpstreamHealthMonitor({
                logger,
                failThreshold: 1,
                primaryHost: 'primary.example',
                fallbacks: [
                    { host: 'fallback.example', port: 443, basePath: '/v1', protocol: 'https:', label: 'Fallback' }
                ]
            });

            // Simulate: already on a fallback endpoint
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
            monitor.outage = {
                startedAt: Date.now() - 120000,
                detectedAt: Date.now() - 120000,
                affectedIPs: ['10.0.0.1']
            };
            monitor._lastFailoverAt = lastFailoverAt;

            return monitor;
        }

        test('6. Recovery too soon — failover <60s ago, recovery suppressed even though probes succeed', async () => {
            // Failover happened 20 seconds ago — well within the 60s anti-flap window
            const monitor = buildFailedOverMonitor(Date.now() - 20000);

            const restoredListener = jest.fn();
            monitor.on('upstream-restored', restoredListener);

            // Send 10 consecutive successes (far more than the 5 needed for fallback recovery)
            for (let i = 0; i < 10; i++) {
                await monitor._recordProbeResult('healthy', 'all_ips_ok', []);
            }

            // Recovery must be suppressed — still on fallback
            expect(monitor.activeEndpoint.host).toBe('fallback.example');
            expect(monitor.activeEndpoint.isPrimary).toBe(false);
            expect(restoredListener).not.toHaveBeenCalled();
        });

        test('7. Recovery after anti-flap window — failover >60s ago, recovery proceeds', async () => {
            // Failover happened 90 seconds ago — past the 60s window
            const monitor = buildFailedOverMonitor(Date.now() - 90000);

            const restoredListener = jest.fn();
            monitor.on('upstream-restored', restoredListener);

            // 5 consecutive successes (fallback recovery threshold)
            for (let i = 0; i < 5; i++) {
                await monitor._recordProbeResult('healthy', 'all_ips_ok', []);
            }

            // Recovery should succeed — back to primary
            expect(monitor.state).toBe('healthy');
            expect(monitor.activeEndpoint.isPrimary).toBe(true);
            expect(monitor.activeEndpoint.host).toBe('primary.example');
            expect(restoredListener).toHaveBeenCalledTimes(1);
        });

        test('8. Anti-flap with _lastFailoverAt = 0 — first failover, no anti-flap suppression', async () => {
            // _lastFailoverAt = 0 means failoverAge = Date.now() - 0 = huge number => no suppression
            const monitor = buildFailedOverMonitor(0);

            const restoredListener = jest.fn();
            monitor.on('upstream-restored', restoredListener);

            // 5 consecutive successes
            for (let i = 0; i < 5; i++) {
                await monitor._recordProbeResult('healthy', 'all_ips_ok', []);
            }

            // Should recover because failoverAge is enormous (Date.now() - 0)
            expect(monitor.state).toBe('healthy');
            expect(monitor.activeEndpoint.isPrimary).toBe(true);
            expect(restoredListener).toHaveBeenCalledTimes(1);
        });

        test('9. Anti-flap reset on switch — after successful switch, _lastFailoverAt is updated', async () => {
            const monitor = new UpstreamHealthMonitor({
                logger,
                failThreshold: 1,
                primaryHost: 'primary.example',
                fallbacks: [
                    { host: 'backup.example', port: 443, basePath: '/v1', protocol: 'https:', label: 'Backup' }
                ]
            });

            // Mock: primary down, fallback healthy
            monitor._probeEndpointHealth = jest.fn().mockImplementation(async (endpoint) => {
                if (endpoint.host === 'backup.example') {
                    return mkProbe('healthy', 1, 20);
                }
                return mkProbe('down', 0, null);
            });

            expect(monitor._lastFailoverAt).toBeUndefined();

            // Trigger failover (failThreshold = 1, so one "down" is enough)
            const beforeFailover = Date.now();
            await monitor._recordProbeResult('down', 'all_ips_failed', ['10.0.0.1']);

            // _lastFailoverAt should now be set to roughly "now"
            expect(monitor._lastFailoverAt).toBeDefined();
            expect(monitor._lastFailoverAt).toBeGreaterThanOrEqual(beforeFailover);
            expect(monitor._lastFailoverAt).toBeLessThanOrEqual(Date.now());
            expect(monitor.activeEndpoint.host).toBe('backup.example');

            // Advance time past the anti-flap window and trigger a second failover
            // First, go back to primary for the second test
            jest.advanceTimersByTime(120000);
            monitor.activeEndpoint = {
                host: 'primary.example',
                port: 443,
                basePath: '/api/anthropic',
                protocol: 'https:',
                label: 'Primary (z.ai)',
                isPrimary: true
            };
            monitor.state = 'healthy';
            monitor.consecutiveFails = 0;

            const firstFailoverAt = monitor._lastFailoverAt;

            // Trigger a second failover
            await monitor._recordProbeResult('down', 'all_ips_failed', ['10.0.0.1']);

            // _lastFailoverAt must have been updated to a newer timestamp
            expect(monitor._lastFailoverAt).toBeGreaterThan(firstFailoverAt);
            expect(monitor.activeEndpoint.host).toBe('backup.example');
        });
    });
});
