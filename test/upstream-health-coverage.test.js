'use strict';

const { UpstreamHealthMonitor } = require('../lib/upstream-health');
const dns = require('dns').promises;
const net = require('net');

/**
 * Coverage tests for lib/upstream-health.js
 * Targeting uncovered branches on lines 141, 211
 * Focus: degraded probe state through _probe(), partial IP failures, IP health error aggregation
 */
describe('UpstreamHealthMonitor — coverage gaps', () => {
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

    // ------------------------------------------------------------------
    // Coverage: Line 141 - _probe() with degraded state from _probeEndpointHealth
    // This branch is when probe.state === 'degraded' in _probe()'s if/else chain
    // ------------------------------------------------------------------
    describe('_probe() degraded state handling', () => {
        test('_probe() processes degraded state from _probeEndpointHealth and calls _recordProbeResult with failedIps', async () => {
            const monitor = new UpstreamHealthMonitor({ logger });

            // Mock _probeEndpointHealth to return degraded state with partial failures
            monitor._probeEndpointHealth = jest.fn().mockResolvedValue({
                state: 'degraded',
                reason: 'partial_failure',
                ips: ['10.0.0.1', '10.0.0.2'],
                results: [
                    { ip: '10.0.0.1', success: true, latencyMs: 15 },
                    { ip: '10.0.0.2', success: false, latencyMs: 5000, error: 'timeout' }
                ],
                healthyIps: ['10.0.0.1'],
                failedIps: ['10.0.0.2'],
                healthyCount: 1,
                failedCount: 1,
                avgLatencyMs: 15
            });

            // Spy on _recordProbeResult to verify it's called with correct args
            const recordSpy = jest.spyOn(monitor, '_recordProbeResult');

            await monitor._probe();

            // COVERAGE: Line 141 - degraded branch calls _recordProbeResult with 'degraded' and failedIps
            expect(recordSpy).toHaveBeenCalledWith('degraded', 'partial_failure', ['10.0.0.2']);
            expect(monitor.ipHealth.get('10.0.0.1')).toEqual(expect.objectContaining({
                healthy: true,
                latencyMs: 15,
                error: null
            }));
            expect(monitor.ipHealth.get('10.0.0.2')).toEqual(expect.objectContaining({
                healthy: false,
                error: 'timeout'
            }));
        });

        test('_probe() with degraded state emits upstream-health event', async () => {
            const monitor = new UpstreamHealthMonitor({ logger });

            monitor._probeEndpointHealth = jest.fn().mockResolvedValue({
                state: 'degraded',
                reason: 'partial_failure',
                ips: ['10.0.0.1', '10.0.0.2'],
                results: [
                    { ip: '10.0.0.1', success: true, latencyMs: 10 },
                    { ip: '10.0.0.2', success: false, latencyMs: 5000, error: 'ECONNREFUSED' }
                ],
                healthyIps: ['10.0.0.1'],
                failedIps: ['10.0.0.2'],
                healthyCount: 1,
                failedCount: 1,
                avgLatencyMs: 10
            });

            const healthListener = jest.fn();
            monitor.on('upstream-health', healthListener);

            await monitor._probe();

            // Event should be emitted after _recordProbeResult processes degraded state
            expect(healthListener).toHaveBeenCalledWith(expect.objectContaining({
                state: 'degraded'
            }));
        });
    });

    // ------------------------------------------------------------------
    // Coverage: Line 211 - _probeEndpointHealth with partial failures (degraded)
    // Tests the failedIps mapping when healthy.length > 0 but < ips.length
    // ------------------------------------------------------------------
    describe('_probeEndpointHealth partial failure (degraded) branches', () => {
        test('_probeEndpointHealth returns degraded with correct failedIps when some IPs fail', async () => {
            const monitor = new UpstreamHealthMonitor({ logger, primaryHost: 'partial.example' });

            // Mock DNS to return multiple IPs
            jest.spyOn(dns, 'resolve4').mockResolvedValue(['10.0.0.1', '10.0.0.2', '10.0.0.3']);

            // Mock TCP probes: 2 succeed, 1 fails
            jest.spyOn(monitor, '_tcpProbe')
                .mockImplementation(async (ip) => {
                    if (ip === '10.0.0.3') {
                        return { ip, success: false, latencyMs: 5000, error: 'timeout' };
                    }
                    return { ip, success: true, latencyMs: 20 };
                });

            const result = await monitor._probeEndpointHealth({
                host: 'partial.example',
                port: 443,
                basePath: '/v1',
                protocol: 'https:',
                label: 'Partial',
                isPrimary: true
            });

            // COVERAGE: Line 211 - failedIps is populated when partial failures occur
            expect(result.state).toBe('degraded');
            expect(result.reason).toBe('partial_failure');
            expect(result.healthyIps).toEqual(['10.0.0.1', '10.0.0.2']);
            expect(result.failedIps).toEqual(['10.0.0.3']);
            expect(result.healthyCount).toBe(2);
            expect(result.failedCount).toBe(1);
            expect(result.avgLatencyMs).toBe(20); // average of healthy only
        });

        test('_probeEndpointHealth calculates avgLatencyMs correctly with multiple healthy IPs', async () => {
            const monitor = new UpstreamHealthMonitor({ logger, primaryHost: 'multi.example' });

            jest.spyOn(dns, 'resolve4').mockResolvedValue(['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4']);

            // Mock TCP probes with different latencies, last one fails
            jest.spyOn(monitor, '_tcpProbe')
                .mockImplementation(async (ip) => {
                    const latencies = {
                        '10.0.0.1': 10,
                        '10.0.0.2': 20,
                        '10.0.0.3': 30,
                        '10.0.0.4': 5000
                    };
                    const success = ip !== '10.0.0.4';
                    return {
                        ip,
                        success,
                        latencyMs: latencies[ip],
                        error: success ? undefined : 'timeout'
                    };
                });

            const result = await monitor._probeEndpointHealth({
                host: 'multi.example',
                port: 443
            });

            // avgLatencyMs should be (10 + 20 + 30) / 3 = 20
            expect(result.state).toBe('degraded');
            expect(result.avgLatencyMs).toBe(20);
            expect(result.failedIps).toEqual(['10.0.0.4']);
        });
    });

    // ------------------------------------------------------------------
    // Coverage: IP health aggregation with error details
    // Tests the ipHealth.set() branch with error field
    // ------------------------------------------------------------------
    describe('IP health aggregation with error field', () => {
        test('_probe() stores error field in ipHealth for failed probes', async () => {
            const monitor = new UpstreamHealthMonitor({ logger });

            monitor._probeEndpointHealth = jest.fn().mockResolvedValue({
                state: 'down',
                reason: 'all_ips_failed',
                ips: ['10.0.0.1', '10.0.0.2'],
                results: [
                    { ip: '10.0.0.1', success: false, latencyMs: 5000, error: 'ECONNREFUSED' },
                    { ip: '10.0.0.2', success: false, latencyMs: 5000, error: 'ETIMEDOUT' }
                ],
                healthyIps: [],
                failedIps: ['10.0.0.1', '10.0.0.2'],
                healthyCount: 0,
                failedCount: 2,
                avgLatencyMs: null
            });

            await monitor._probe();

            // Both IPs should have their specific error codes stored
            expect(monitor.ipHealth.get('10.0.0.1').error).toBe('ECONNREFUSED');
            expect(monitor.ipHealth.get('10.0.0.2').error).toBe('ETIMEDOUT');
        });

        test('_probe() sets error to null for successful probes', async () => {
            const monitor = new UpstreamHealthMonitor({ logger });

            monitor._probeEndpointHealth = jest.fn().mockResolvedValue({
                state: 'healthy',
                reason: 'all_ips_ok',
                ips: ['10.0.0.1'],
                results: [{ ip: '10.0.0.1', success: true, latencyMs: 15 }],
                healthyIps: ['10.0.0.1'],
                failedIps: [],
                healthyCount: 1,
                failedCount: 0,
                avgLatencyMs: 15
            });

            await monitor._probe();

            // Successful probe should have error: null
            expect(monitor.ipHealth.get('10.0.0.1').error).toBeNull();
        });
    });

    // ------------------------------------------------------------------
    // Coverage: _probeEndpointHealth endpoint health update
    // Tests _updateEndpointHealth is called with correct summary
    // ------------------------------------------------------------------
    describe('_updateEndpointHealth integration', () => {
        test('_probeEndpointHealth updates endpointHealth map with degraded state', async () => {
            const monitor = new UpstreamHealthMonitor({ logger });

            jest.spyOn(dns, 'resolve4').mockResolvedValue(['10.0.0.1', '10.0.0.2']);
            jest.spyOn(monitor, '_tcpProbe')
                .mockImplementation(async (ip) => {
                    if (ip === '10.0.0.1') {
                        return { ip, success: true, latencyMs: 15 };
                    }
                    return { ip, success: false, latencyMs: 5000, error: 'timeout' };
                });

            await monitor._probeEndpointHealth({
                host: 'test.example',
                port: 443,
                basePath: '/api',
                protocol: 'https:',
                label: 'Test Endpoint',
                isPrimary: false
            });

            const endpointKey = 'https://test.example:443/api';
            const health = monitor.endpointHealth.get(endpointKey);

            expect(health).toEqual(expect.objectContaining({
                host: 'test.example',
                label: 'Test Endpoint',
                isPrimary: false,
                state: 'degraded',
                reason: 'partial_failure',
                healthyCount: 1,
                failedCount: 1,
                avgLatencyMs: 15
            }));
            expect(health.lastCheck).toBeGreaterThan(0);
        });

        test('_probeEndpointHealth uses host as label when label not provided', async () => {
            const monitor = new UpstreamHealthMonitor({ logger });

            jest.spyOn(dns, 'resolve4').mockResolvedValue(['10.0.0.1']);
            jest.spyOn(monitor, '_tcpProbe').mockResolvedValue({ ip: '10.0.0.1', success: true, latencyMs: 10 });

            await monitor._probeEndpointHealth({
                host: 'nolabel.example',
                port: 443
            });

            const endpointKey = 'https://nolabel.example:443';
            const health = monitor.endpointHealth.get(endpointKey);

            // When label is not provided, it should default to host
            expect(health.label).toBe('nolabel.example');
        });
    });

    // ------------------------------------------------------------------
    // Coverage: Down state through _probe() with all IPs failed
    // Tests line 143 branch (else clause in _probe's if/else if/else)
    // ------------------------------------------------------------------
    describe('_probe() down state handling', () => {
        test('_probe() processes down state from _probeEndpointHealth with all IPs failed', async () => {
            const monitor = new UpstreamHealthMonitor({ logger, failThreshold: 1, fallbacks: [] });

            monitor._probeEndpointHealth = jest.fn().mockResolvedValue({
                state: 'down',
                reason: 'all_ips_failed',
                ips: ['10.0.0.1', '10.0.0.2'],
                results: [
                    { ip: '10.0.0.1', success: false, latencyMs: 5000, error: 'timeout' },
                    { ip: '10.0.0.2', success: false, latencyMs: 5000, error: 'ECONNREFUSED' }
                ],
                healthyIps: [],
                failedIps: ['10.0.0.1', '10.0.0.2'],
                healthyCount: 0,
                failedCount: 2,
                avgLatencyMs: null
            });

            const recordSpy = jest.spyOn(monitor, '_recordProbeResult');

            await monitor._probe();

            // COVERAGE: Line 143 - down branch calls _recordProbeResult with 'down' and all ips
            expect(recordSpy).toHaveBeenCalledWith('down', 'all_ips_failed', ['10.0.0.1', '10.0.0.2']);
        });
    });

    // ------------------------------------------------------------------
    // Coverage: _probe() exception handling with error logging
    // Tests the catch block error logging
    // ------------------------------------------------------------------
    describe('_probe() exception handling', () => {
        test('_probe() logs error when _probeEndpointHealth throws', async () => {
            const monitor = new UpstreamHealthMonitor({ logger });

            monitor._probeEndpointHealth = jest.fn().mockRejectedValue(new Error('Network unreachable'));

            await monitor._probe();

            expect(logger.error).toHaveBeenCalledWith('Upstream probe error', {
                error: 'Network unreachable'
            });
            expect(monitor.lastProbeResult.state).toBe('down');
            expect(monitor.lastProbeResult.reason).toBe('probe_error');
        });
    });
});
