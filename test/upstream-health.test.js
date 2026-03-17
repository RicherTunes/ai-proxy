'use strict';

const { UpstreamHealthMonitor } = require('../lib/upstream-health');

describe('UpstreamHealthMonitor', () => {
    let logger;

    beforeEach(() => {
        logger = {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn()
        };
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('validated failover', () => {
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
                .mockResolvedValueOnce({ state: 'down', reason: 'dns_failed', ips: [] })
                .mockResolvedValueOnce({ state: 'healthy', reason: 'all_ips_ok', ips: ['10.0.0.2'] });

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
                .mockResolvedValue({ state: 'down', reason: 'dns_failed', ips: [] });

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
    });
});
